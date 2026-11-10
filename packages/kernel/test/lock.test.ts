/**
 * Internal lines locked to the sew line (ops/lock.ts): endpoints attached, parallel, rigid follow.
 * Every check runs in every size (S M L XL, base M).
 */
import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, gradePoint, curvePoint, makeContour } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour, spanPolyline, absoluteToIncremental, anchorPositions } from '../src/model/contour';
import { closestPoint, dedupe, polylineLength, pointAtLength } from '../src/geom/poly';
import type { GradeInc, Id, SizeId, SizeLine, Contour } from '../src/model/types';
import { movePoint, addPointsOnSegment, deletePoint, multiMove } from '../src/ops/points';
import { segmentLengthSetTo } from '../src/ops/measure';
import {
  lockInternalEnds, lockInternalParallel, lockInternalFollow, unlockInternal, isLockDriven, setLockMeasure, setLockOffset,
  lockDistance, sewSegmentAt, lockSummary,
} from '../src/ops/lock';
import { shapeArc } from '../src/ops/shapers';
import { saveNative, loadNative } from '../src/io/native';

function grade(line: SizeLine, abs: Record<string, [number, number]>): Record<SizeId, GradeInc> {
  const a: Record<SizeId, GradeInc> = {};
  for (const s of line.sizes) { const v = abs[s.name] ?? [0, 0]; a[s.id] = { dx: v[0], dy: v[1] }; }
  return absoluteToIncremental(a, line);
}

/** Same panel as seam-follow: A(0,0) hem → B(200,0) side → C(200,300) curved top → D(0,300) → A, graded. */
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
  const add = (c: Contour) => { doc.transact('add internal', () => doc.piece(piece.id).internals.push(c)); return c.id; };
  return { doc, line, pid: piece.id, A: A.id, B: B.id, C: C.id, D: D.id, add, sizes: line.sizes.map(s => s.id), size: (n: string) => line.sizes.find(s => s.name === n)!.id };
}
type T = ReturnType<typeof setup>;
const internal = (t: T, id: Id) => t.doc.piece(t.pid).internals.find(c => c.id === id)!;
const ipos = (t: T, cid: Id, sid: SizeId) => { const c = internal(t, cid); return anchorPositions(c.points, t.line, sid, c.closed); };
/** point at distance d along the sew span from → to, in a size */
function onSpan(t: T, from: Id, to: Id, sid: SizeId, f: (L: number) => number) {
  const p = t.doc.piece(t.pid), r = resolveContour(p.sew, t.line, sid);
  const ia = p.sew.points.findIndex(a => a.id === from), ib = p.sew.points.findIndex(a => a.id === to);
  const poly = dedupe(spanPolyline(r, ia, ib)), L = polylineLength(poly);
  return pointAtLength(poly, f(L)).pt;
}
const close = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 1e-6) => { expect(Math.abs(a.x - b.x)).toBeLessThan(tol); expect(Math.abs(a.y - b.y)).toBeLessThan(tol); };

/** line from the hem (x = 60) to the side (y = 120) */
const hemToSide = (t: T) => t.add(makeContour([gradePoint(60, 0), curvePoint(140, 60), gradePoint(200, 120)], { type: 'internal', closed: false }));

describe('L1 — endpoints attached (proportional)', () => {
  it('auto-detects both ends and their segments; ends stay at the same fraction in every size', () => {
    const t = setup(); const cid = hemToSide(t);
    expect(lockInternalEnds(t.doc, t.pid, cid)).toBe(2);
    const c = internal(t, cid);
    expect(c.lock?.kind).toBe('ends');
    const ends = c.lock!.kind === 'ends' ? c.lock!.ends : [];
    expect(ends.map(e => [e.from, e.to])).toEqual([[t.A, t.B], [t.B, t.C]]);
    expect(ends[0].value).toBeCloseTo(0.3, 12); expect(ends[1].value).toBeCloseTo(0.4, 12);
    for (const s of t.sizes) {
      const P = ipos(t, cid, s);
      close(P[0], onSpan(t, t.A, t.B, s, L => 0.3 * L));
      close(P[2], onSpan(t, t.B, t.C, s, L => 0.4 * L));
    }
    // L is graded: the hem is 206 long there, so the end is at 61.8
    expect(ipos(t, cid, t.size('L'))[0].x).toBeCloseTo(61.8, 9);
    expect(lockSummary(t.doc.piece(t.pid), c)).toContain('proportional');
  });
  it('survives moving the segment ends (base and a graded size), setting the segment length and Cut Point insertion', () => {
    const t = setup(); const cid = hemToSide(t);
    lockInternalEnds(t.doc, t.pid, cid);
    const mid0 = internal(t, cid).points[1];
    movePoint(t.doc, t.pid, t.B, { dx: 40, dy: -10 });
    movePoint(t.doc, t.pid, t.B, { dx: 5, dy: 3 }, { sizeId: t.size('XL') });
    segmentLengthSetTo(t.doc, t.pid, t.doc.piece(t.pid).sew.id, t.B, t.C, 330, 'moveEnd');
    addPointsOnSegment(t.doc, t.pid, t.A, { pcts: [10, 80] }); // inside the locked hem span
    const check = () => {
      for (const s of t.sizes) {
        const P = ipos(t, cid, s);
        close(P[0], onSpan(t, t.A, t.B, s, L => 0.3 * L), 1e-6);
        close(P[2], onSpan(t, t.B, t.C, s, L => 0.4 * L), 1e-6);
      }
    };
    check();
    // the middle point of the line is not locked: it kept its data
    expect(internal(t, cid).points[1]).toEqual(mid0);
    // re-shaping the side keeps the end on the new curve
    shapeArc(t.doc, t.pid, t.B, t.C, { depth: 25 });
    check();
    // undo / redo keep the lock consistent
    t.doc.undo(); check(); t.doc.redo(); check();
  });
  it('fixed distance from the start / from the end', () => {
    const t = setup(); const cid = hemToSide(t);
    lockInternalEnds(t.doc, t.pid, cid, { measure: 'start' });
    movePoint(t.doc, t.pid, t.B, { dx: 50, dy: 0 });
    for (const s of t.sizes) { const P = ipos(t, cid, s); expect(P[0].x).toBeCloseTo(60, 9); expect(P[0].y).toBeCloseTo(0, 9); }
    setLockMeasure(t.doc, t.pid, cid, 'end');
    movePoint(t.doc, t.pid, t.A, { dx: -30, dy: 0 });
    // the hem end keeps its distance from B (190 mm in the base after the first move)
    for (const s of t.sizes) close(ipos(t, cid, s)[0], onSpan(t, t.A, t.B, s, L => L - 190), 1e-6);
  });
  it('locked end points refuse an independent move until unlocked; the free middle point moves', () => {
    const t = setup(); const cid = hemToSide(t);
    lockInternalEnds(t.doc, t.pid, cid);
    const c = internal(t, cid);
    expect(isLockDriven(t.doc.piece(t.pid), cid, c.points[0].id)).toBe(true);
    expect(isLockDriven(t.doc.piece(t.pid), cid, c.points[1].id)).toBe(false);
    expect(() => movePoint(t.doc, t.pid, c.points[0].id, { dx: 5, dy: 5 })).toThrow(/locked/);
    expect(() => multiMove(t.doc, c.points.map(a => ({ pieceId: t.pid, anchorId: a.id })), { x: 3, y: 0 })).toThrow(/locked/);
    movePoint(t.doc, t.pid, c.points[1].id, { dx: 5, dy: 5 });
    unlockInternal(t.doc, t.pid, cid);
    expect(internal(t, cid).lock).toBeUndefined();
    movePoint(t.doc, t.pid, c.points[0].id, { dx: 5, dy: 5 });
    expect(internal(t, cid).points[0].x).toBeCloseTo(65, 9);
  });
  it('a point-connected end follows its connection; a lock whose segment point is deleted is dropped', () => {
    const t = setup();
    const cid = t.add(makeContour([gradePoint(200, 0), gradePoint(120, 150)], { type: 'internal', closed: false }));
    const c = internal(t, cid);
    t.doc.transact('connect', () => t.doc.piece(t.pid).connections.push({ internalContourId: cid, internalAnchorId: c.points[0].id, externalAnchorId: t.B }));
    lockInternalEnds(t.doc, t.pid, cid);
    expect(isLockDriven(t.doc.piece(t.pid), cid, c.points[0].id)).toBe(false);
    movePoint(t.doc, t.pid, t.B, { dx: 10, dy: 7 });
    close(ipos(t, cid, t.line.baseSizeId)[0], { x: 210, y: 7 });
    // the hem end is attached A→B; delete A → the span is gone, the lock is dropped, nothing moves
    const u = setup(); const id = hemToSide(u);
    lockInternalEnds(u.doc, u.pid, id, { which: 'start' });
    const before = ipos(u, id, u.line.baseSizeId);
    deletePoint(u.doc, u.pid, u.A);
    expect(internal(u, id).lock).toBeUndefined();
    close(ipos(u, id, u.line.baseSizeId)[0], before[0]);
  });
});

/** distance of every resolved internal point (away from the ends) to the sew span polyline */
function parallelErr(t: T, cid: Id, from: Id, to: Id, offset: number) {
  let worst = 0;
  for (const s of t.sizes) {
    const p = t.doc.piece(t.pid), r = resolveContour(p.sew, t.line, s);
    const ia = p.sew.points.findIndex(a => a.id === from), ib = p.sew.points.findIndex(a => a.id === to);
    const span = dedupe(spanPolyline(r, ia, ib));
    const rc = resolveContour(internal(t, cid), t.line, s);
    for (const q of rc.pts) worst = Math.max(worst, Math.abs(closestPoint(span, q).d - offset));
  }
  return worst;
}

describe('L2 — parallel to a segment', () => {
  it('topstitch 20 mm inside the curved top: exact offset (0.01 mm) in every size, after moves and grading edits', () => {
    const t = setup();
    const cid = t.add(makeContour([gradePoint(195, 270), gradePoint(5, 270)], { type: 'internal', closed: false }));
    lockInternalParallel(t.doc, t.pid, cid, { from: t.C, to: t.D }, { offset: 20, a: 0, b: 1 });
    const c = internal(t, cid);
    expect(c.points.length).toBeGreaterThan(3);
    expect(c.points[0].kind).toBe('grade'); expect(c.points[c.points.length - 1].kind).toBe('grade');
    expect(parallelErr(t, cid, t.C, t.D, 20)).toBeLessThan(0.01);
    // ends: the offsets of the span ends (C and D) in every size
    for (const s of t.sizes) {
      const P = ipos(t, cid, s);
      const C = onSpan(t, t.C, t.D, s, () => 0), D = onSpan(t, t.C, t.D, s, L => L);
      expect(Math.hypot(P[0].x - C.x, P[0].y - C.y)).toBeCloseTo(20, 6);
      expect(Math.hypot(P[P.length - 1].x - D.x, P[P.length - 1].y - D.y)).toBeCloseTo(20, 6);
    }
    movePoint(t.doc, t.pid, t.C, { dx: 10, dy: 25 });
    movePoint(t.doc, t.pid, t.D, { dx: 0, dy: -6 }, { sizeId: t.size('XL') });
    expect(parallelErr(t, cid, t.C, t.D, 20)).toBeLessThan(0.01);
    setLockOffset(t.doc, t.pid, cid, 12.5);
    expect(parallelErr(t, cid, t.C, t.D, 12.5)).toBeLessThan(0.01);
    // its points are all lock-driven
    expect(internal(t, cid).points.every(a => isLockDriven(t.doc.piece(t.pid), cid, a.id))).toBe(true);
  });
  it('a part of a straight hem (10 % … 90 %, proportional) follows length changes; Cut Point inside keeps it', () => {
    const t = setup();
    const cid = t.add(makeContour([gradePoint(20, 25), gradePoint(180, 25)], { type: 'internal', closed: false }));
    lockInternalParallel(t.doc, t.pid, cid, { from: t.A, to: t.B });
    const L0 = internal(t, cid).lock!;
    expect(L0.kind === 'parallel' && [L0.offset, L0.a, L0.b]).toEqual([25, 0.1, 0.9]);
    expect(internal(t, cid).points.length).toBe(2);
    movePoint(t.doc, t.pid, t.B, { dx: 100, dy: 0 });
    addPointsOnSegment(t.doc, t.pid, t.A, { pcts: [50] });
    for (const s of t.sizes) {
      const P = ipos(t, cid, s);
      const hem = 300 + (s === t.size('S') ? -6 : s === t.size('L') ? 6 : s === t.size('XL') ? 12 : 0);
      close(P[0], { x: 0.1 * hem, y: 25 }, 1e-6); close(P[1], { x: 0.9 * hem, y: 25 }, 1e-6);
    }
    expect(parallelErr(t, cid, t.A, t.B, 25)).toBeLessThan(0.01);
  });
});

describe('L3 — rigid follow of a sew point (pocket)', () => {
  it('a closed pocket translates with C in the base and per size', () => {
    const t = setup();
    const cid = t.add(makeContour([gradePoint(140, 200), gradePoint(180, 200), gradePoint(180, 250), gradePoint(140, 250)], { type: 'internal', closed: true }));
    lockInternalFollow(t.doc, t.pid, cid, t.C);
    const C = (s: SizeId) => anchorPositions(t.doc.piece(t.pid).sew.points, t.line, s, true)[2];
    const before = Object.fromEntries(t.sizes.map(s => [s, ipos(t, cid, s)]));
    const c0 = Object.fromEntries(t.sizes.map(s => [s, C(s)]));
    // the pocket was not graded; locking does not move it
    for (const s of t.sizes) before[s].forEach((q, j) => close(q, ipos(t, cid, t.line.baseSizeId)[j]));
    movePoint(t.doc, t.pid, t.C, { dx: -15, dy: 10 });
    movePoint(t.doc, t.pid, t.C, { dx: 4, dy: 6 }, { sizeId: t.size('XL') });
    for (const s of t.sizes) {
      const d = { x: C(s).x - c0[s].x, y: C(s).y - c0[s].y };
      ipos(t, cid, s).forEach((q, j) => close(q, { x: before[s][j].x + d.x, y: before[s][j].y + d.y }, 1e-9));
    }
    // the line itself can still be moved as a whole (repositions it relative to C)
    multiMove(t.doc, internal(t, cid).points.map(a => ({ pieceId: t.pid, anchorId: a.id })), { x: -10, y: 0 });
    expect(ipos(t, cid, t.line.baseSizeId)[0].x).toBeCloseTo(140 - 15 - 10, 9);
    movePoint(t.doc, t.pid, t.C, { dx: 5, dy: 0 });
    expect(ipos(t, cid, t.line.baseSizeId)[0].x).toBeCloseTo(140 - 15 - 10 + 5, 9);
  });
});

describe('L4 — persistence', () => {
  it('a lock survives save / load and is re-applied on load', () => {
    const t = setup(); const cid = hemToSide(t);
    lockInternalEnds(t.doc, t.pid, cid);
    const json = saveNative(t.doc);
    const res = loadNative(json);
    const d2 = new Document(); d2.load(res.style);
    const c2 = d2.piece(t.pid).internals.find(c => c.id === cid)!;
    expect(c2.lock).toEqual(internal(t, cid).lock);
    expect(c2.points).toEqual(internal(t, cid).points);
  });
});

describe('helpers', () => {
  it('lockDistance / sewSegmentAt', () => {
    expect(lockDistance('ratio', 0.25, 200)).toBe(50);
    expect(lockDistance('start', 30, 200)).toBe(30);
    expect(lockDistance('end', 30, 200)).toBe(170);
    expect(lockDistance('start', 300, 200)).toBe(200);
    const t = setup();
    const g = sewSegmentAt(t.doc.piece(t.pid), t.line, { x: 200, y: 0 })!;
    expect([g.from, g.to, g.along]).toEqual([t.B, t.C, 0]);
    const h = sewSegmentAt(t.doc.piece(t.pid), t.line, { x: 50, y: 0.2 })!;
    expect([h.from, h.to]).toEqual([t.A, t.B]); expect(h.along).toBeCloseTo(50, 9); expect(h.d).toBeCloseTo(0.2, 9);
  });
});
