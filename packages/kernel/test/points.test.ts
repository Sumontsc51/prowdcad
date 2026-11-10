import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour } from '../src/model/contour';
import { area, perimeter } from '../src/geom/poly';
import {
  addPointOnSegment, movePoint, moveAlongContour, moveProportional, multiMove, alignPoints, setAngle, cornerAngle,
  roundCorner, addSplineSupportPoints, pointsCleanup, deletePoint, togglePointKind, setSmooth, breakHandle, joinHandle,
  setStartPoint, anchorAt, pinCurvePoints, curvePointFollows,
} from '../src/ops/points';
import { maxDev } from '../src/geom/draft-geom';

function setup(w = 100, h = 50) {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const line = doc.sizeLine();
  const ids = line.sizes.map(s => s.id);
  const c = rectangleContour(0, 0, w, h);
  for (const i of [1, 2]) c.points[i].grade = { [ids[1]]: { dx: 10, dy: 0 }, [ids[2]]: { dx: 10, dy: 0 } };
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, pid: piece.id, ids, line, p: () => doc.piece(piece.id) };
}
const sewArea = (doc: Document, pid: string, size?: string) => area(doc.resolvePiece(pid, size).sew.pts);

describe('add point', () => {
  it('P1 distance from prev / next / percentage, with proportional grading', () => {
    const { doc, pid, ids, p } = setup();
    const a0 = p().sew.points[0].id;
    const id2 = addPointOnSegment(doc, pid, a0, { distance: 20, from: 'next' });
    const id1 = addPointOnSegment(doc, pid, a0, { distance: 30 });
    expect(p().sew.points.length).toBe(6);
    const pt1 = p().sew.points.find(a => a.id === id1)!, pt2 = p().sew.points.find(a => a.id === id2)!;
    expect(pt1.x).toBeCloseTo(30, 9); expect(pt2.x).toBeCloseTo(80, 9);
    // segment 0 is now 0→30; 50% of it is 15
    const id3 = addPointOnSegment(doc, pid, a0, { pct: 50 });
    expect(p().sew.points.find(a => a.id === id3)!.x).toBeCloseTo(15, 9);
    // grading: the bottom edge goes from 0 (no grade) to right corner (+10/size) → point at 80 grades 8 in L
    const L = ids[2];
    const r = doc.resolvePiece(pid, L);
    const i2 = p().sew.points.findIndex(a => a.id === id2);
    expect(r.sew.anchorPos[i2].x).toBeCloseTo(80 + 10 * 0.8, 9);
    expect(sewArea(doc, pid)).toBeCloseTo(5000, 9);
  });
  it('splitting a curve keeps its geometry (de Casteljau)', () => {
    const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), curvePoint(120, 50), curvePoint(100, 100), gradePoint(60, 120), gradePoint(0, 100)]);
    const piece = makePiece('X', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    const before = doc.resolvePiece(piece.id).sew.pts;
    addPointOnSegment(doc, piece.id, c.points[1].id, { pct: 37 });
    addPointOnSegment(doc, piece.id, c.points[1].id, { pct: 80, kind: 'curve' });
    const after = doc.resolvePiece(piece.id).sew.pts;
    expect(maxDev(after, [...before, before[0]])).toBeLessThan(0.02);
    expect(Math.abs(area(after) - area(before))).toBeLessThan(1);
  });
});

describe('move', () => {
  it('P2 movePoint delta / absolute, base vs per-size grading', () => {
    const { doc, pid, ids, p, line } = setup();
    const a2 = p().sew.points[2].id;
    movePoint(doc, pid, a2, { dx: 0, dy: 10 });
    expect(p().sew.points[2].y).toBe(60);
    movePoint(doc, pid, a2, { x: 100, y: 50 });
    expect(p().sew.points[2].y).toBe(50);
    // L only: move +5 in y
    movePoint(doc, pid, a2, { dx: 0, dy: 5 }, { sizeId: ids[2] });
    expect(anchorAt(p().sew, line, 2, ids[2])).toEqual({ x: 110, y: 55 });
    expect(anchorAt(p().sew, line, 2, ids[0]).x).toBeCloseTo(90, 9);
    expect(anchorAt(p().sew, line, 2, ids[0]).y).toBeCloseTo(50, 9);
    expect(anchorAt(p().sew, line, 2)).toEqual({ x: 100, y: 50 });
  });
  it('moveAlongContour keeps shape and id', () => {
    const { doc, pid, p } = setup();
    const id = addPointOnSegment(doc, pid, p().sew.points[0].id, { distance: 30, name: 'N' });
    moveAlongContour(doc, pid, id, 25);
    const a = p().sew.points.find(x => x.id === id)!;
    expect(a.x).toBeCloseTo(55, 9); expect(a.y).toBeCloseTo(0, 9); expect(a.name).toBe('N');
    expect(p().sew.points.length).toBe(5);
    expect(sewArea(doc, pid)).toBeCloseTo(5000, 9);
  });
  it('moveProportional blends curve points of the run', () => {
    const doc = new Document(makeStyle());
    const c = makeContour([gradePoint(0, 0), curvePoint(25, 0), curvePoint(50, 0), curvePoint(75, 0), gradePoint(100, 0), gradePoint(100, 50), gradePoint(0, 50)]);
    const piece = makePiece('X', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    moveProportional(doc, piece.id, c.points[2].id, { x: 0, y: -20 });
    const P = doc.piece(piece.id).sew.points;
    expect(P[2].y).toBeCloseTo(-20, 9); expect(P[1].y).toBeCloseTo(-10, 9); expect(P[3].y).toBeCloseTo(-10, 9);
    expect(P[0].y).toBe(0); expect(P[4].y).toBe(0);
  });
  it('multiMove moves anchors across pieces; alignPoints H / V / angle', () => {
    const { doc, pid, p } = setup();
    const other = makePiece('BACK', rectangleContour(200, 0, 50, 50), doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(other));
    multiMove(doc, [{ pieceId: pid, anchorId: p().sew.points[2].id }, { pieceId: other.id, anchorId: other.sew.points[2].id }], { x: 3, y: 4 });
    expect(p().sew.points[2]).toMatchObject({ x: 103, y: 54 });
    expect(doc.piece(other.id).sew.points[2]).toMatchObject({ x: 253, y: 54 });
    alignPoints(doc, pid, [p().sew.points[3].id, p().sew.points[2].id], 'H');
    expect(p().sew.points[2].y).toBe(50);
    alignPoints(doc, pid, [p().sew.points[1].id, p().sew.points[2].id], 'V');
    expect(p().sew.points[2].x).toBe(100);
    movePoint(doc, pid, p().sew.points[2].id, { x: 130, y: 10 });
    alignPoints(doc, pid, [p().sew.points[0].id, p().sew.points[2].id], { angleDeg: 45 });
    expect(p().sew.points[2].x).toBeCloseTo(70, 9); expect(p().sew.points[2].y).toBeCloseTo(70, 9);
  });
});

describe('angle', () => {
  it('P3 setAngle rotates the next segment about the point', () => {
    const { doc, pid, p } = setup();
    const a1 = p().sew.points[1].id;
    expect(cornerAngle(doc, pid, a1)).toBeCloseTo(90, 9);
    setAngle(doc, pid, a1, 120);
    expect(cornerAngle(doc, pid, a1)).toBeCloseTo(120, 9);
    const P2 = p().sew.points[2];
    // right edge (length 50) tilted 30° outward
    expect(P2.x).toBeCloseTo(100 + 50 * Math.sin(Math.PI / 6), 9);
    expect(P2.y).toBeCloseTo(50 * Math.cos(Math.PI / 6), 9);
  });
  it('setAngle per size edits only that size', () => {
    const { doc, pid, p, ids } = setup();
    const a1 = p().sew.points[1].id;
    setAngle(doc, pid, a1, 100, { sizeId: ids[2] });
    expect(cornerAngle(doc, pid, a1, ids[2])).toBeCloseTo(100, 9);
    expect(cornerAngle(doc, pid, a1)).toBeCloseTo(90, 9);
    expect(cornerAngle(doc, pid, a1, ids[0])).toBeCloseTo(90, 9);
  });
});

describe('round corner', () => {
  it('P4 r=10 removes (1−π/4)·100 mm² and keeps 0.05 mm arc accuracy', () => {
    const { doc, pid, p } = setup();
    const before = sewArea(doc, pid);
    const [t1, t2] = roundCorner(doc, pid, p().sew.points[2].id, 10);
    const after = sewArea(doc, pid);
    expect(Math.abs(before - after - (1 - Math.PI / 4) * 100)).toBeLessThan(0.1);
    const P = p().sew.points;
    expect(P.length).toBe(5);
    expect(P.find(a => a.id === t1)).toMatchObject({ x: 100, y: 40, kind: 'grade' });
    const T2 = P.find(a => a.id === t2)!; expect(T2.x).toBeCloseTo(90, 9); expect(T2.y).toBeCloseTo(50, 9);
    // every sample of the fillet lies within 0.05 mm of the true circle centred (90,40)
    const pts = doc.resolvePiece(pid).sew.pts.filter(q => q.x > 90 && q.y > 40);
    for (const q of pts) expect(Math.abs(Math.hypot(q.x - 90, q.y - 40) - 10)).toBeLessThan(0.05);
  });
  it('obtuse sweep (>90°) uses an extra curve point', () => {
    const doc = new Document(makeStyle());
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), gradePoint(0, 100)]); // 45° at (100,0)
    const piece = makePiece('T', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    roundCorner(doc, piece.id, c.points[1].id, 5);
    expect(doc.piece(piece.id).sew.points.length).toBe(5);
  });
});

describe('cleanup, delete, kinds, handles, start', () => {
  it('pointsCleanup strips collinear imported points, keeps grade/start/notch anchors', () => {
    const { doc, pid, p } = setup();
    doc.transact('import junk', () => {
      const c = p().sew;
      const extra = [10, 20, 30, 40, 60, 70].map(x => curvePoint(x, 0, { smooth: false }));
      c.points.splice(1, 0, ...extra);
    });
    const keep = addPointOnSegment(doc, pid, p().sew.points[0].id, { distance: 50, kind: 'curve' });
    doc.transact('notch', () => p().notches.push({ id: 'n1', contourId: p().sew.id, placement: { kind: 'anchor', anchorId: keep }, type: 'slit', depth: 5, width: 0, angleDeg: 0 }));
    const removed = pointsCleanup(doc, pid);
    expect(removed).toBe(6);
    expect(p().sew.points.length).toBe(5);
    expect(sewArea(doc, pid)).toBeCloseTo(5000, 9);
  });
  it('pointsCleanup removes redundant points on a curve within 0.05 mm', () => {
    const doc = new Document(makeStyle());
    const pts = [gradePoint(0, 0)];
    for (let k = 1; k < 160; k++) { const a = (k / 160) * Math.PI; pts.push(curvePoint(50 - 50 * Math.cos(a), 50 * Math.sin(a))); }
    pts.push(gradePoint(100, 0));
    const c = makeContour(pts);
    const piece = makePiece('A', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    const before = doc.resolvePiece(piece.id).sew.pts;
    const n = pointsCleanup(doc, piece.id, { tol: 0.05 });
    expect(n).toBeGreaterThan(100);
    const after = doc.resolvePiece(piece.id).sew.pts;
    expect(maxDev(after, [...before, before[0]])).toBeLessThan(0.05 + 0.05);
  });
  it('deletePoint re-anchors notches as floating', () => {
    const { doc, pid, p } = setup();
    const id = addPointOnSegment(doc, pid, p().sew.points[0].id, { distance: 40 });
    doc.transact('notch', () => p().notches.push({ id: 'n1', contourId: p().sew.id, placement: { kind: 'anchor', anchorId: id }, type: 'slit', depth: 5, width: 0, angleDeg: 0 }));
    deletePoint(doc, pid, id);
    expect(p().sew.points.length).toBe(4);
    const pl = p().notches[0].placement;
    expect(pl.kind).toBe('fromPrev');
    if (pl.kind === 'fromPrev') expect(Object.values(pl.dist)[0]).toBeCloseTo(40, 9);
  });
  it('toggle kind, smooth, break/join handle, setStartPoint', () => {
    const { doc, pid, p } = setup();
    const id = addPointOnSegment(doc, pid, p().sew.points[0].id, { distance: 40 });
    expect(togglePointKind(doc, pid, id)).toBe('curve');
    expect(togglePointKind(doc, pid, id)).toBe('grade');
    setSmooth(doc, pid, id, true);
    expect(p().sew.points[1].smooth).toBe(true);
    breakHandle(doc, pid, id);
    expect(p().sew.points[1].smooth).toBe(false);
    expect(p().sew.points[1].hOut).toBeDefined();
    joinHandle(doc, pid, id);
    expect(p().sew.points[1].smooth).toBe(true);
    const a2 = p().sew.points[3].id;
    setStartPoint(doc, pid, a2);
    expect(p().sew.points[0].id).toBe(a2);
    expect(p().sew.points.filter(a => a.flags.startPoint).length).toBe(1);
    expect(sewArea(doc, pid)).toBeCloseTo(5000, 9);
  });
  it('addSplineSupportPoints inserts evenly spaced curve points', () => {
    const { doc, pid, p } = setup();
    const ids = addSplineSupportPoints(doc, pid, p().sew.points[0].id, p().sew.points[1].id, 3);
    expect(ids.length).toBe(3);
    expect(p().sew.points.slice(1, 4).map(a => a.x)).toEqual([25, 50, 75].map(x => expect.closeTo(x, 9)));
    expect(perimeter(doc.resolvePiece(pid).sew.pts)).toBeCloseTo(300, 9);
  });
});

void resolveContour;

describe('pin curve points (keep position)', () => {
  function curveSetup() {
    const doc = new Document(makeStyle('t', ['S', 'M', 'L', 'XL'], 'M'));
    const ids = doc.sizeLine().sizes.map(s => s.id);
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), curvePoint(120, 50), curvePoint(110, 100), gradePoint(80, 150), gradePoint(0, 150)]);
    // the two grade points around the curve grade differently, so the curve points interpolate
    c.points[1].grade = { [ids[1]]: { dx: 10, dy: 0 }, [ids[2]]: { dx: 10, dy: 0 }, [ids[3]]: { dx: 10, dy: 0 } };
    c.points[4].grade = { [ids[1]]: { dx: 4, dy: 8 }, [ids[2]]: { dx: 4, dy: 8 }, [ids[3]]: { dx: 4, dy: 8 } };
    const piece = makePiece('X', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    return { doc, pid: piece.id, ids, p: () => doc.piece(piece.id) };
  }
  const posAll = (doc: Document, pid: string, ids: string[], i: number) => ids.map(s => doc.resolvePiece(pid, s).sew.anchorPos[i]);

  it('an unpinned curve point follows a moved neighbour in graded sizes; a pinned one keeps every size', () => {
    const { doc, pid, ids, p } = curveSetup();
    const cp = p().sew.points[2].id, g = p().sew.points[1].id;
    expect(curvePointFollows(p(), cp)).toBe(true);
    // unpinned: moving the neighbouring grade point in the base shifts the curve point's L / XL position
    const before = posAll(doc, pid, ids, 2);
    movePoint(doc, pid, g, { dx: 30, dy: 0 });
    const moved = posAll(doc, pid, ids, 2);
    expect(Math.hypot(moved[3].x - before[3].x, moved[3].y - before[3].y)).toBeGreaterThan(1e-6);
    doc.undo();
    // pinned: per-size positions are materialised exactly, and nothing moves any more
    expect(pinCurvePoints(doc, pid, [cp, g], true)).toBe(1); // the grade point is ignored
    expect(curvePointFollows(p(), cp)).toBe(false);
    const pinned = posAll(doc, pid, ids, 2);
    pinned.forEach((q, k) => { expect(q.x).toBeCloseTo(before[k].x, 9); expect(q.y).toBeCloseTo(before[k].y, 9); });
    movePoint(doc, pid, g, { dx: 30, dy: 0 });
    movePoint(doc, pid, g, { dx: 7, dy: -4 }, { sizeId: ids[2] });
    const after = posAll(doc, pid, ids, 2);
    after.forEach((q, k) => { expect(q.x).toBeCloseTo(before[k].x, 9); expect(q.y).toBeCloseTo(before[k].y, 9); });
  });
  it('one undo step; unpin restores following; an ungraded piece pins with explicit zeros', () => {
    const { doc, pid, ids, p } = curveSetup();
    const cp = p().sew.points[3].id;
    const r0 = doc.revision();
    pinCurvePoints(doc, pid, [cp]);
    expect(doc.revision() - r0).toBe(1);
    expect(pinCurvePoints(doc, pid, [cp], true)).toBe(0); // already pinned
    expect(pinCurvePoints(doc, pid, [cp], false)).toBe(1);
    expect(curvePointFollows(p(), cp)).toBe(true);
    // ungraded piece: the pin is an explicit all-zero record (still pinned)
    const d2 = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), curvePoint(120, 50), gradePoint(80, 150)]);
    const pc = makePiece('Y', c, d2.style.activeSizeTableId);
    d2.transact('add', s => s.pieces.push(pc));
    pinCurvePoints(d2, pc.id, [c.points[2].id]);
    const a = d2.piece(pc.id).sew.points[2];
    expect(Object.keys(a.grade).length).toBe(3);
    expect(curvePointFollows(d2.piece(pc.id), a.id)).toBe(false);
    void ids;
  });
});
