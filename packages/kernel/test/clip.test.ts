/**
 * Clip Line (ops/clip.ts): internal lines that cross a sew segment or end close to it are clipped
 * to the segment and locked on it. Panel: A(0,0) → B(200,0) → C(200,300) → curved top → D(0,300), graded.
 */
import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, gradePoint, curvePoint, makeContour } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour, absoluteToIncremental, anchorPositions } from '../src/model/contour';
import { closestPoint, polylineLength } from '../src/geom/poly';
import type { GradeInc, Id, SizeId, SizeLine, Contour } from '../src/model/types';
import { movePoint } from '../src/ops/points';
import { clipInternals, clipPlan, sewSpans, clipLineTo, clipToPlan } from '../src/ops/clip';
import { lockInternalParallel, unlockInternal, isLockDriven, lockInternalEnds } from '../src/ops/lock';

function grade(line: SizeLine, abs: Record<string, [number, number]>): Record<SizeId, GradeInc> {
  const a: Record<SizeId, GradeInc> = {};
  for (const s of line.sizes) { const v = abs[s.name] ?? [0, 0]; a[s.id] = { dx: v[0], dy: v[1] }; }
  return absoluteToIncremental(a, line);
}
function setup() {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L', 'XL'], 'M'));
  const line = doc.sizeLine();
  const A = gradePoint(0, 0, { flags: { startPoint: true } });
  const B = gradePoint(200, 0, { grade: grade(line, { S: [-6, 0], L: [6, 0], XL: [12, 0] }) });
  const C = gradePoint(200, 300, { grade: grade(line, { S: [-6, -8], L: [6, 8], XL: [12, 16] }) });
  const c1 = curvePoint(150, 322), c2 = curvePoint(100, 330), c3 = curvePoint(50, 322);
  const D = gradePoint(0, 300, { grade: grade(line, { S: [0, -8], L: [0, 8], XL: [0, 16] }) });
  const piece = makePiece('P', makeContour([A, B, C, c1, c2, c3, D]), doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  const add = (pts: [number, number][], curve = false) => {
    const c = makeContour(pts.map(([x, y], i) => (curve && i > 0 && i < pts.length - 1 ? curvePoint(x, y) : gradePoint(x, y))), { type: 'internal', closed: false });
    doc.transact('add internal', () => doc.piece(piece.id).internals.push(c)); return c.id;
  };
  return { doc, line, pid: piece.id, A: A.id, B: B.id, C: C.id, D: D.id, add, sizes: line.sizes.map(s => s.id) };
}
type T = ReturnType<typeof setup>;
const internal = (t: T, id: Id): Contour => t.doc.piece(t.pid).internals.find(c => c.id === id)!;
const ends = (t: T, id: Id, sid?: SizeId) => { const c = internal(t, id); const p = anchorPositions(c.points, t.line, sid ?? t.line.baseSizeId, false); return [p[0], p[p.length - 1]]; };
const sewDist = (t: T, q: { x: number; y: number }, sid: SizeId) => { const r = resolveContour(t.doc.piece(t.pid).sew, t.line, sid); return closestPoint([...r.pts, r.pts[0]], q).d; };
const len = (t: T, id: Id) => polylineLength(resolveContour(internal(t, id), t.line, t.line.baseSizeId).pts);

describe('Clip Line', () => {
  it('cuts a line that crosses the segment and locks the new end on it', () => {
    const t = setup();
    const id = t.add([[100, 150], [230, 150]]);           // crosses the side B→C at x=200
    const r = clipInternals(t.doc, t.pid, { spans: [{ from: t.B, to: t.C }] });
    expect(r).toMatchObject({ lines: 1, ends: 1, trimmed: 1 });
    const [s, e] = ends(t, id);
    expect(s.x).toBeCloseTo(100, 6); expect(e.x).toBeCloseTo(200, 6); expect(e.y).toBeCloseTo(150, 6);
    const c = internal(t, id);
    expect(c.lock?.kind).toBe('ends');
    expect(isLockDriven(t.doc.piece(t.pid), id, c.points[c.points.length - 1].id)).toBe(true);
    expect(isLockDriven(t.doc.piece(t.pid), id, c.points[0].id)).toBe(false);
    // on the side seam in every size
    for (const sid of t.sizes) expect(sewDist(t, ends(t, id, sid)[1], sid)).toBeLessThan(1e-6);
  });

  it('extends an end that is close to the segment, along the line direction', () => {
    const t = setup();
    const id = t.add([[100, 100], [194, 100]]);           // stops 6 mm short of the side
    const far = t.add([[100, 200], [170, 200]]);          // 30 mm short: not close
    const r = clipInternals(t.doc, t.pid, { spans: [{ from: t.B, to: t.C }] });
    expect(r).toMatchObject({ lines: 1, ends: 1, extended: 1 });
    const e = ends(t, id)[1];
    expect(e.x).toBeCloseTo(200, 6); expect(e.y).toBeCloseTo(100, 6);
    expect(internal(t, id).points.length).toBe(2);
    expect(internal(t, far).lock).toBeUndefined();
    expect(ends(t, far)[1].x).toBeCloseTo(170, 9);
    // tol option widens the reach
    expect(clipInternals(t.doc, t.pid, { spans: [{ from: t.B, to: t.C }], tol: 40, contourIds: [far] }).extended).toBe(1);
    expect(ends(t, far)[1].x).toBeCloseTo(200, 6);
  });

  it('only the clicked segment is used; the other end stays free', () => {
    const t = setup();
    const id = t.add([[-20, 150], [220, 150]]);           // overhangs both sides
    clipInternals(t.doc, t.pid, { spans: [{ from: t.B, to: t.C }] });
    let [s, e] = ends(t, id);
    expect(s.x).toBeCloseTo(-20, 6); expect(e.x).toBeCloseTo(200, 6);
    // whole outline: the other end too
    const r = clipInternals(t.doc, t.pid, { contourIds: [id] });
    [s, e] = ends(t, id);
    expect(s.x).toBeCloseTo(0, 6); expect(e.x).toBeCloseTo(200, 6);
    expect(r.trimmed).toBe(1); expect(r.locked).toBe(1);
    const lock = internal(t, id).lock;
    expect(lock?.kind === 'ends' && lock.ends.length).toBe(2);
  });

  it('the clipped end follows the segment when it moves', () => {
    const t = setup();
    const id = t.add([[100, 150], [230, 150]]);
    clipInternals(t.doc, t.pid, { spans: [{ from: t.B, to: t.C }] });
    movePoint(t.doc, t.pid, t.B, { dx: 20, dy: 0 });
    movePoint(t.doc, t.pid, t.C, { dx: 20, dy: 0 });
    const e = ends(t, id)[1];
    expect(e.x).toBeCloseTo(220, 6); expect(e.y).toBeCloseTo(150, 6);
    for (const sid of t.sizes) expect(sewDist(t, ends(t, id, sid)[1], sid)).toBeLessThan(1e-6);
  });

  it('keeps the shape of a curved line and cuts it on the curved top', () => {
    const t = setup();
    const id = t.add([[60, 200], [90, 280], [120, 360]], true);   // crosses the curved top C→D
    const before = resolveContour(internal(t, id), t.line, t.line.baseSizeId).pts;
    const r = clipInternals(t.doc, t.pid, { spans: [{ from: t.C, to: t.D }] });
    expect(r.trimmed).toBe(1);
    const after = resolveContour(internal(t, id), t.line, t.line.baseSizeId).pts;
    for (const q of after) expect(closestPoint(before, q).d).toBeLessThan(0.06);
    expect(len(t, id)).toBeLessThan(polylineLength(before));
    for (const sid of t.sizes) expect(sewDist(t, ends(t, id, sid)[1], sid)).toBeLessThan(1e-6);
  });

  it('leaves alone: lines running alongside, closed shapes, parallel locks, far lines', () => {
    const t = setup();
    const along = t.add([[194, 50], [194, 250]]);        // 6 mm inside, parallel to the side
    const par = t.add([[190, 60], [190, 240]]);
    lockInternalParallel(t.doc, t.pid, par, { from: t.B, to: t.C });
    const snap = JSON.stringify(t.doc.piece(t.pid).internals);
    expect(clipPlan(t.doc.piece(t.pid), t.line, { spans: [{ from: t.B, to: t.C }] })).toEqual([]);
    expect(clipInternals(t.doc, t.pid, { spans: [{ from: t.B, to: t.C }] }).lines).toBe(0);
    expect(JSON.stringify(t.doc.piece(t.pid).internals)).toBe(snap);
    expect(internal(t, along).lock).toBeUndefined();
  });

  it('an end already on the segment is just locked; unlock frees it; one undo step', () => {
    const t = setup();
    const id = t.add([[100, 150], [200, 150]]);
    const r = clipInternals(t.doc, t.pid, { spans: [{ from: t.B, to: t.C }] });
    expect(r).toMatchObject({ lines: 1, locked: 1, trimmed: 0, extended: 0 });
    unlockInternal(t.doc, t.pid, id);
    expect(internal(t, id).lock).toBeUndefined();
    const id2 = t.add([[100, 80], [240, 80]]);
    clipInternals(t.doc, t.pid, { spans: [{ from: t.B, to: t.C }] });
    expect(ends(t, id2)[1].x).toBeCloseTo(200, 6);
    t.doc.undo();
    expect(ends(t, id2)[1].x).toBeCloseTo(240, 9);
    expect(internal(t, id).lock).toBeUndefined();
  });

  it('sewSpans lists every grade segment of the outline', () => {
    const t = setup();
    expect(sewSpans(t.doc.piece(t.pid))).toEqual([{ from: t.A, to: t.B }, { from: t.B, to: t.C }, { from: t.C, to: t.D }, { from: t.D, to: t.A }]);
  });
});

describe('Clip Line: 1st line to 2nd line, no lock', () => {
  const sewId = (t: T) => t.doc.piece(t.pid).sew.id;

  it('extends the 1st line onto an internal line and does not lock it', () => {
    const t = setup();
    const target = t.add([[150, 50], [150, 250]]);
    const id = t.add([[40, 100], [100, 100]]);
    const p = clipLineTo(t.doc, t.pid, id, { contourId: target }, { near: { x: 95, y: 100 } });
    expect(p).toMatchObject({ end: 'end', how: 'extend' }); expect(p.delta).toBeCloseTo(50, 6);
    const [s, e] = ends(t, id);
    expect(s.x).toBeCloseTo(40, 9); expect(e.x).toBeCloseTo(150, 6); expect(e.y).toBeCloseTo(100, 6);
    expect(internal(t, id).lock).toBeUndefined();
    expect(internal(t, id).points.length).toBe(2);
    expect(JSON.stringify(ends(t, target))).toBe(JSON.stringify([{ x: 150, y: 50 }, { x: 150, y: 250 }]));
  });

  it('cuts the 1st line back to an internal line it crosses (the clicked end changes)', () => {
    const t = setup();
    const target = t.add([[150, 50], [150, 250]]);
    const id = t.add([[40, 100], [180, 100]]);
    const p = clipLineTo(t.doc, t.pid, id, { contourId: target }, { near: { x: 175, y: 100 } });
    expect(p).toMatchObject({ end: 'end', how: 'trim' }); expect(p.delta).toBeCloseTo(-30, 6);
    expect(ends(t, id)[1].x).toBeCloseTo(150, 6); expect(ends(t, id)[0].x).toBeCloseTo(40, 6);
    // clicking the other half removes that half instead
    const id2 = t.add([[40, 200], [180, 200]]);
    clipLineTo(t.doc, t.pid, id2, { contourId: target }, { near: { x: 45, y: 200 } });
    expect(ends(t, id2)[0].x).toBeCloseTo(150, 6); expect(ends(t, id2)[1].x).toBeCloseTo(180, 6);
    expect(internal(t, id2).lock).toBeUndefined();
  });

  it('clips to a sew segment without locking; the lock is a separate step', () => {
    const t = setup();
    const id = t.add([[100, 150], [170, 150]]);
    clipLineTo(t.doc, t.pid, id, { contourId: sewId(t), span: { from: t.B, to: t.C } }, { near: { x: 165, y: 150 } });
    expect(ends(t, id)[1].x).toBeCloseTo(200, 6);
    expect(internal(t, id).lock).toBeUndefined();
    movePoint(t.doc, t.pid, t.B, { dx: 20, dy: 0 }); movePoint(t.doc, t.pid, t.C, { dx: 20, dy: 0 });
    expect(ends(t, id)[1].x).toBeCloseTo(200, 6);            // free: it does not follow
    movePoint(t.doc, t.pid, t.B, { dx: -20, dy: 0 }); movePoint(t.doc, t.pid, t.C, { dx: -20, dy: 0 });
    expect(lockInternalEnds(t.doc, t.pid, id)).toBe(1);
    movePoint(t.doc, t.pid, t.B, { dx: 20, dy: 0 }); movePoint(t.doc, t.pid, t.C, { dx: 20, dy: 0 });
    expect(ends(t, id)[1].x).toBeCloseTo(220, 6);            // locked: it follows
  });

  it('the other end is used when the clicked end cannot reach; a line that cannot reach is refused', () => {
    const t = setup();
    const target = t.add([[150, 50], [150, 250]]);
    const id = t.add([[40, 100], [100, 100]]);
    expect(clipToPlan(t.doc.piece(t.pid), t.line, id, { contourId: target }, { near: { x: 42, y: 100 } })).toMatchObject({ end: 'end', how: 'extend' });
    const par = t.add([[100, 60], [100, 240]]);
    expect(clipToPlan(t.doc.piece(t.pid), t.line, par, { contourId: target })).toBeNull();
    expect(() => clipLineTo(t.doc, t.pid, par, { contourId: target })).toThrow(/does not/);
    expect(() => clipLineTo(t.doc, t.pid, id, { contourId: id })).toThrow();
  });

  it('a curved line keeps its shape when cut; a locked end that is clipped is released; one undo step', () => {
    const t = setup();
    const target = t.add([[20, 240], [180, 240]]);
    const id = t.add([[60, 150], [90, 220], [120, 290]], true);
    const before = resolveContour(internal(t, id), t.line, t.line.baseSizeId).pts;
    clipLineTo(t.doc, t.pid, id, { contourId: target }, { end: 'end' });
    const after = resolveContour(internal(t, id), t.line, t.line.baseSizeId).pts;
    for (const q of after) expect(closestPoint(before, q).d).toBeLessThan(0.06);
    expect(ends(t, id)[1].y).toBeCloseTo(240, 4);
    t.doc.undo();
    expect(ends(t, id)[1].y).toBeCloseTo(290, 9);
    // locked end on the side seam, then clipped back to an internal line: that end is free again
    const lk = t.add([[100, 100], [200, 100]]);
    lockInternalEnds(t.doc, t.pid, lk);
    const bar = t.add([[160, 50], [160, 150]]);
    clipLineTo(t.doc, t.pid, lk, { contourId: bar }, { end: 'end' });
    expect(ends(t, lk)[1].x).toBeCloseTo(160, 6);
    expect(internal(t, lk).lock).toBeUndefined();
  });
});
