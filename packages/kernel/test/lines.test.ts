import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, makeContour, gradePoint } from '../src/model/factory';
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
