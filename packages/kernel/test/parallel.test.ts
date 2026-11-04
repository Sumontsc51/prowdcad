import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area, polylineLength } from '../src/geom/poly';
import { createParallelInternal, extendParallel, parallelGuide, perpendicularGuide } from '../src/ops/parallel';

function setup(w = 100, h = 50) {
  const doc = new Document(makeStyle());
  const c = rectangleContour(0, 0, w, h);
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, pid: piece.id, p: () => doc.piece(piece.id) };
}

describe('parallel internals (L1)', () => {
  it('parallel to the bottom edge 10 mm inside, and the other side', () => {
    const { doc, pid, p } = setup();
    const id = createParallelInternal(doc, pid, { from: p().sew.points[0].id, to: p().sew.points[1].id }, 10);
    const c = p().internals.find(c => c.id === id)!;
    expect(c.points.map(a => [a.x, a.y])).toEqual([[0, 10], [100, 10]]);
    const id2 = createParallelInternal(doc, pid, { from: p().sew.points[0].id, to: p().sew.points[1].id }, 10, -1);
    expect(p().internals.find(c => c.id === id2)!.points[0].y).toBeCloseTo(-10, 9);
  });
  it('extendToContour on a slanted side; distanceAlongContour sub-range', () => {
    const doc = new Document(makeStyle());
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), gradePoint(80, 50), gradePoint(20, 50)]);
    const piece = makePiece('T', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    const id = createParallelInternal(doc, piece.id, { from: c.points[0].id, to: c.points[1].id }, 25, 1, { extendToContour: true });
    const L = polylineLength(doc.resolvePiece(piece.id).internals.find((_, i) => doc.piece(piece.id).internals[i].id === id)!.pts);
    expect(L).toBeCloseTo(80, 9); // at y=25 the trapezoid is 80 wide
    const id2 = createParallelInternal(doc, piece.id, { from: c.points[0].id, to: c.points[1].id }, 5, 1, { distanceAlongContour: [20, 70] });
    const pts = doc.piece(piece.id).internals.find(c => c.id === id2)!.points;
    expect(pts[0].x).toBeCloseTo(20, 9); expect(pts[pts.length - 1].x).toBeCloseTo(70, 9);
  });
  it('parallel to a curved internal stays at constant distance', () => {
    const { doc, pid, p } = setup(200, 200);
    const ic = makeContour([gradePoint(20, 100), curvePoint(100, 140), gradePoint(180, 100)], { type: 'internal', closed: false });
    doc.transact('i', () => p().internals.push(ic));
    const id = createParallelInternal(doc, pid, { internalId: ic.id }, 10, -1);
    const ri = doc.resolvePiece(pid).internals;
    const src = ri[0].pts, par = ri[p().internals.findIndex(c => c.id === id)].pts;
    for (const q of par.slice(2, -2)) {
      let d = Infinity;
      for (let i = 1; i < src.length; i++) { const a = src[i - 1], b = src[i]; const t = Math.max(0, Math.min(1, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2))); d = Math.min(d, Math.hypot(a.x + t * (b.x - a.x) - q.x, a.y + t * (b.y - a.y) - q.y)); }
      expect(Math.abs(d - 10)).toBeLessThan(0.05);
    }
  });
});

describe('extend parallel (L2)', () => {
  it('grow the right side of a rectangle by 15 and shrink the top by 5; multi-piece', () => {
    const { doc, pid, p } = setup();
    const other = makePiece('BACK', rectangleContour(200, 0, 100, 50), doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(other));
    extendParallel(doc, [{ pieceId: pid, from: p().sew.points[1].id, to: p().sew.points[2].id }, { pieceId: other.id, from: other.sew.points[1].id, to: other.sew.points[2].id }], 15);
    expect(area(doc.resolvePiece(pid).sew.pts)).toBeCloseTo(115 * 50, 9);
    expect(area(doc.resolvePiece(other.id).sew.pts)).toBeCloseTo(115 * 50, 9);
    extendParallel(doc, [{ pieceId: pid, from: p().sew.points[2].id, to: p().sew.points[3].id }], -5);
    expect(area(doc.resolvePiece(pid).sew.pts)).toBeCloseTo(115 * 45, 9);
  });
  it('slanted neighbours keep their angle', () => {
    const doc = new Document(makeStyle());
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), gradePoint(80, 50), gradePoint(20, 50)]);
    const piece = makePiece('T', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    extendParallel(doc, [{ pieceId: piece.id, from: c.points[2].id, to: c.points[3].id }], 10);
    const P = doc.piece(piece.id).sew.points;
    expect(P[2].x).toBeCloseTo(76, 9); expect(P[2].y).toBeCloseTo(60, 9);
    expect(P[3].x).toBeCloseTo(24, 9);
  });
});

describe('guides', () => {
  it('parallel and perpendicular guide', () => {
    const { doc, pid, p } = setup();
    const g = parallelGuide(doc, pid, p().sew.points[0].id, p().sew.points[1].id, 20);
    expect(g.a).toEqual({ x: 0, y: 20 }); expect(g.b).toEqual({ x: 100, y: 20 });
    const q = perpendicularGuide(doc, pid, p().sew.id, { x: 30, y: 1 }, 10);
    expect(q.a.x).toBeCloseTo(30, 9); expect(q.b.x).toBeCloseTo(30, 9);
    expect(Math.abs(q.a.y - q.b.y)).toBeCloseTo(20, 9);
  });
});
