import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour } from '../src/model/contour';
import { segmentCurve, shapeSegment } from '../src/ops/points';

function doc1() {
  const s = makeStyle();
  const pts = [
    gradePoint(0, 0), curvePoint(100, 20), gradePoint(200, 30, { smooth: true }), curvePoint(290, 25), curvePoint(360, 12), gradePoint(400, 0),
    gradePoint(400, -200), gradePoint(0, -200),
  ];
  const p = makePiece('A', makeContour(pts, { closed: true }), s.activeSizeTableId);
  s.pieces.push(p);
  return { doc: new Document(s), id: p.id, ids: pts.map(a => a.id) };
}
const span = (doc: Document, id: string, a: string, b: string) => {
  const p = doc.piece(id); const rc = resolveContour(p.sew, doc.sizeLine(p), doc.baseSize(p));
  const i = p.sew.points.findIndex(q => q.id === a), j = p.sew.points.findIndex(q => q.id === b);
  return JSON.stringify(rc.pts.slice(rc.anchorIndex[i], rc.anchorIndex[j] + 1).map(q => [Math.round(q.x * 1e6) / 1e6, Math.round(q.y * 1e6) / 1e6]));
};

describe('one curve per line', () => {
  it('an armhole with two curve points fits within 1.5 mm', () => {
    const st = makeStyle();
    const pts = [gradePoint(0, 0), gradePoint(260, 0), gradePoint(260, 465), curvePoint(222, 545), curvePoint(205, 618), gradePoint(200, 680), gradePoint(0, 700)];
    const p = makePiece('F', makeContour(pts, { closed: true }), st.activeSizeTableId); st.pieces.push(p);
    const doc = new Document(st);
    const sc = segmentCurve(p, doc.sizeLine(p), p.sew.id, pts[2].id, pts[5].id);
    expect(sc.dev).toBeLessThan(1.5);
  });
  it('fits one curve close to a line with points in between', () => {
    const { doc, id, ids } = doc1(); const p = doc.piece(id);
    const sc = segmentCurve(p, doc.sizeLine(p), p.sew.id, ids[2], ids[5]);
    expect(sc.between).toBe(2);
    expect(sc.dev).toBeLessThan(1.5);
  });
  it('shaping replaces the points in between, keeps both far sides and is one undo step', () => {
    const { doc, id, ids } = doc1(); const p = doc.piece(id);
    const left = span(doc, id, ids[0], ids[2]), right = span(doc, id, ids[5], ids[6]);
    const n0 = p.sew.points.length;
    const merged = shapeSegment(doc, id, p.sew.id, ids[2], ids[5], { start: { x: 60, y: 40 } });
    expect(merged).toBe(2);
    expect(doc.piece(id).sew.points.length).toBe(n0 - 2);
    expect(span(doc, id, ids[0], ids[2])).toBe(left);
    expect(span(doc, id, ids[5], ids[6])).toBe(right);
    expect(doc.piece(id).sew.points.find(a => a.id === ids[2])!.hOut).toEqual({ x: 60, y: 40 });
    doc.undo();
    expect(doc.piece(id).sew.points.length).toBe(n0);
  });
  it('a straight line gets handles a third along the chord and stays straight until one is moved', () => {
    const { doc, id, ids } = doc1(); const p = doc.piece(id);
    const sc = segmentCurve(p, doc.sizeLine(p), p.sew.id, ids[5], ids[6]);
    expect(sc.between).toBe(0);
    expect(sc.h0.x).toBeCloseTo(400); expect(sc.h0.y).toBeCloseTo(-200 / 3);
    expect(sc.length).toBeCloseTo(200);
    shapeSegment(doc, id, p.sew.id, ids[5], ids[6]);
    const q = doc.piece(id); expect(segmentCurve(q, doc.sizeLine(q), q.sew.id, ids[5], ids[6]).length).toBeCloseTo(200, 3);
  });
});
