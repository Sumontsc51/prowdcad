import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { resolveContour } from '../src/model/contour';
import { Document } from '../src/model/doc';
import { copyLineTo, lineFollowShape } from '../src/ops/lines';

/** a tapered leg: hem (bottom) 200 wide, top 300 wide, 600 high. Order: hemL, hemR, topR, topL (CCW). */
function leg() {
  const s = makeStyle();
  const pts = [gradePoint(-100, 0), gradePoint(100, 0), gradePoint(150, 600), gradePoint(-150, 600)];
  const p = makePiece('LEG', makeContour(pts, { closed: true }), s.activeSizeTableId);
  const q = makePiece('OTHER', makeContour([gradePoint(0, 0), gradePoint(300, 0), gradePoint(300, 300), gradePoint(0, 300)], { closed: true }), s.activeSizeTableId);
  s.pieces.push(p, q);
  return { doc: new Document(s), id: p.id, other: q.id, ids: pts.map(a => a.id) };
}
const P = (doc: Document, id: string) => doc.piece(id).sew.points;

describe('lineFollowShape', () => {
  it('a hem moved outward follows the leg and gets narrower', () => {
    const { doc, id, ids } = leg(); const sew = doc.piece(id).sew.id;
    const r = lineFollowShape(doc, { pieceId: id, contourId: sew, from: ids[0], to: ids[1] }, { x: 0, y: -60 });
    const [a, b] = P(doc, id);
    expect(a.y).toBeCloseTo(-60); expect(b.y).toBeCloseTo(-60);
    expect(a.x).toBeCloseTo(-95); expect(b.x).toBeCloseTo(95); // side lines: 50 in 600 → 5 in 60
    expect(r.lengthAfter).toBeCloseTo(190); expect(r.lengthBefore).toBeCloseTo(200);
  });
  it('moved inward it follows the leg and gets wider; one undo step', () => {
    const { doc, id, ids } = leg(); const sew = doc.piece(id).sew.id;
    lineFollowShape(doc, { pieceId: id, contourId: sew, from: ids[0], to: ids[1] }, { x: 0, y: 120 });
    const [a, b] = P(doc, id);
    expect(a.x).toBeCloseTo(-110); expect(b.x).toBeCloseTo(110); expect(a.y).toBeCloseTo(120);
    doc.undo();
    expect(P(doc, id)[0].x).toBe(-100);
  });
  it('copy leaves the hem and adds an internal line between the side lines', () => {
    const { doc, id, ids } = leg(); const sew = doc.piece(id).sew.id;
    const r = lineFollowShape(doc, { pieceId: id, contourId: sew, from: ids[0], to: ids[1] }, { x: 0, y: 300 }, { copy: true });
    const p = doc.piece(id);
    expect(P(doc, id)[0].y).toBe(0);
    expect(p.internals.length).toBe(1);
    const c = p.internals.find(x => x.id === r.contourId)!;
    expect(c.points[0].x).toBeCloseTo(-125); expect(c.points[c.points.length - 1].x).toBeCloseTo(125);
    expect(c.points[0].y).toBeCloseTo(300);
  });
  it('an internal line with its ends on the outline slides along the outline', () => {
    const { doc, id, ids } = leg(); const sew = doc.piece(id).sew.id;
    const r = lineFollowShape(doc, { pieceId: id, contourId: sew, from: ids[0], to: ids[1] }, { x: 0, y: 300 }, { copy: true });
    lineFollowShape(doc, { pieceId: id, contourId: r.contourId! }, { x: 0, y: 120 });
    const c = doc.piece(id).internals[0];
    expect(c.points[0].y).toBeCloseTo(420); expect(c.points[0].x).toBeCloseTo(-135);
  });
});

describe('lineFollowShape keeps the neighbouring lines', () => {
  /** hem between two CURVED side lines */
  function curved() {
    const s = makeStyle();
    const pts = [gradePoint(-100, 0), gradePoint(100, 0), curvePoint(140, 200), curvePoint(130, 420), gradePoint(150, 600), gradePoint(-150, 600), curvePoint(-130, 420), curvePoint(-140, 200)];
    const p = makePiece('LEG', makeContour(pts, { closed: true }), s.activeSizeTableId); s.pieces.push(p);
    return { doc: new Document(s), id: p.id, ids: pts.map(a => a.id) };
  }
  const side = (doc: Document, id: string, from: string, to: string) => {
    const p = doc.piece(id); const rc = resolveContour(p.sew, doc.sizeLine(p), doc.baseSize(p));
    const i = p.sew.points.findIndex(a => a.id === from), j = p.sew.points.findIndex(a => a.id === to);
    const n = rc.pts.length; const out = []; for (let k = rc.anchorIndex[i]; ; k = (k + 1) % n) { out.push(rc.pts[k]); if (k === rc.anchorIndex[j]) break; }
    return out;
  };
  /** largest distance from the points of `a` to the polyline `b` */
  const dev = (a: { x: number; y: number }[], b: { x: number; y: number }[]) => Math.max(...a.map(p => Math.min(...b.slice(1).map((q, k) => { const o = b[k], d = { x: q.x - o.x, y: q.y - o.y }, l2 = d.x * d.x + d.y * d.y; const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - o.x) * d.x + (p.y - o.y) * d.y) / l2)); return Math.hypot(o.x + d.x * t - p.x, o.y + d.y * t - p.y); }))));
  it('inward: the side lines are cut, what is left of them has exactly the old shape, no point of theirs moved', () => {
    const { doc, id, ids } = curved(); const sew = doc.piece(id).sew.id;
    const before = side(doc, id, ids[1], ids[4]);
    const pos = (k: number) => { const a = doc.piece(id).sew.points.find(q => q.id === ids[k])!; return [a.x, a.y]; };
    const c2 = pos(2), c3 = pos(3);
    lineFollowShape(doc, { pieceId: id, contourId: sew, from: ids[0], to: ids[1] }, { x: 0, y: 100 });
    expect(pos(2)).toEqual(c2); expect(pos(3)).toEqual(c3);
    expect(doc.piece(id).sew.points.find(q => q.id === ids[1])!.y).toBeCloseTo(100, 3);
    expect(dev(side(doc, id, ids[1], ids[4]), before)).toBeLessThan(0.06);
  });
  it('inward past a curve point: that point goes, the rest keeps the old shape', () => {
    const { doc, id, ids } = curved(); const sew = doc.piece(id).sew.id;
    const before = side(doc, id, ids[1], ids[4]);
    lineFollowShape(doc, { pieceId: id, contourId: sew, from: ids[0], to: ids[1] }, { x: 0, y: 300 });
    expect(doc.piece(id).sew.points.some(q => q.id === ids[2])).toBe(false);
    expect(dev(side(doc, id, ids[1], ids[4]), before)).toBeLessThan(0.06);
  });
  it('outward: the old side line stays exactly, a straight piece continues it', () => {
    const { doc, id, ids } = curved(); const sew = doc.piece(id).sew.id;
    const before = side(doc, id, ids[1], ids[4]);
    lineFollowShape(doc, { pieceId: id, contourId: sew, from: ids[0], to: ids[1] }, { x: 0, y: -80 });
    expect(doc.piece(id).sew.points.find(q => q.id === ids[1])!.y).toBeCloseTo(-80, 3);
    expect(dev(before, side(doc, id, ids[1], ids[4]))).toBeLessThan(0.06);
  });
});

describe('copyLineTo', () => {
  it('copies a sew segment onto another piece as an internal line', () => {
    const { doc, id, other, ids } = leg(); const sew = doc.piece(id).sew.id;
    const cid = copyLineTo(doc, { pieceId: id, contourId: sew, from: ids[0], to: ids[1] }, other, { a: 1, b: 0, c: 0, d: 1, e: 150, f: 100 });
    const c = doc.piece(other).internals.find(x => x.id === cid)!;
    expect(c.closed).toBe(false);
    expect(c.points[0].x).toBeCloseTo(50); expect(c.points[0].y).toBeCloseTo(100);
    expect(c.points[c.points.length - 1].x).toBeCloseTo(250);
    expect(doc.piece(id).sew.points.length).toBe(4);
  });
});
