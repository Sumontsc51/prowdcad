import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour } from '../src/model/contour';
import { runCurve, shapeRun } from '../src/ops/points';
import { layoutToWorld, pieceLayout } from '../src/ops/pieces';

/** two panels side by side: A's hem runs (0,0)→(200,0), B is laid to its right and turned, its hem continues to (400,0) */
function two(turnB = 0) {
  const s = makeStyle();
  const a = [gradePoint(0, 0), curvePoint(100, 6), gradePoint(200, 0), gradePoint(200, 300), gradePoint(0, 300)];
  const b = [gradePoint(0, 0), gradePoint(200, 0), gradePoint(200, 300), gradePoint(0, 300)];
  const A = makePiece('A', makeContour(a, { closed: true }), s.activeSizeTableId);
  const B = makePiece('B', makeContour(b, { closed: true }), s.activeSizeTableId);
  if (turnB === 180) B.layout = { x: 400, y: 0, angleDeg: 180 }; else B.layout = { x: 200, y: 0, angleDeg: 0 };
  s.pieces.push(A, B);
  return { doc: new Document(s), A, B, a: a.map(p => p.id), b: b.map(p => p.id) };
}
const world = (doc: Document, pid: string, aid: string) => {
  const p = doc.piece(pid); const rc = resolveContour(p.sew, doc.sizeLine(p), doc.baseSize(p));
  return layoutToWorld(pieceLayout(p), rc.anchorPos[p.sew.points.findIndex(q => q.id === aid)]);
};

describe('a run of lines as one curve', () => {
  it('chains two lines of two pieces whatever the pick order', () => {
    const { doc, A, B, a, b } = two();
    const rc = runCurve(doc, [{ pieceId: B.id, contourId: B.sew.id, from: b[0], to: b[1] }, { pieceId: A.id, contourId: A.sew.id, from: a[0], to: a[2] }]);
    expect(rc.parts.length).toBe(2);
    const ends = [rc.p0.x, rc.p3.x].sort((x, y) => x - y);
    expect(ends[0]).toBeCloseTo(0); expect(ends[1]).toBeCloseTo(400);
    expect(rc.joints[0].x).toBeCloseTo(200);
    expect(rc.parts[0].share).toBeGreaterThan(0.45); expect(rc.parts[0].share).toBeLessThan(0.55);
  });
  it('refuses lines that do not meet', () => {
    const { doc, A, B, a, b } = two();
    doc.piece(B.id).layout = { x: 260, y: 0, angleDeg: 0 };
    expect(() => runCurve(doc, [{ pieceId: A.id, contourId: A.sew.id, from: a[0], to: a[2] }, { pieceId: B.id, contourId: B.sew.id, from: b[0], to: b[1] }])).toThrow(/do not meet/);
  });
  it('shapes both lines as one curve: ends stay, the joint moves on both pieces alike, curve points go', () => {
    for (const turn of [0, 180]) {
      const { doc, A, B, a, b } = two(turn);
      // with B turned 180° its edge on the sheet from (400,0) to (200,0) is its own line b[0] → b[1]
      const parts = [{ pieceId: A.id, contourId: A.sew.id, from: a[0], to: a[2] }, { pieceId: B.id, contourId: B.sew.id, from: b[0], to: b[1] }];
      const rc0 = runCurve(doc, parts);
      const startAtA = rc0.p0.x < 1;
      const hA = { x: 100, y: -60 }, hB = { x: -100, y: -60 };
      shapeRun(doc, parts, startAtA ? { start: hA, end: hB } : { start: hB, end: hA });
      expect(doc.piece(A.id).sew.points.length).toBe(4);
      const e0 = world(doc, A.id, a[0]), jA = world(doc, A.id, a[2]);
      const bJoint = turn === 180 ? b[1] : b[0], bEnd = turn === 180 ? b[0] : b[1];
      const jB = world(doc, B.id, bJoint), e1 = world(doc, B.id, bEnd);
      expect(e0.x).toBeCloseTo(0); expect(e0.y).toBeCloseTo(0);
      expect(e1.x).toBeCloseTo(400); expect(e1.y).toBeCloseTo(0);
      expect(jA.x).toBeCloseTo(jB.x, 6); expect(jA.y).toBeCloseTo(jB.y, 6);
      // symmetric handles: the joint lands near the middle of the curve, B(0.5) = (200, -45)
      expect(Math.abs(jA.x - 200)).toBeLessThan(1); expect(Math.abs(jA.y + 45)).toBeLessThan(0.5);
      const rc = runCurve(doc, parts);
      expect(rc.dev).toBeLessThan(0.05);
      const s = startAtA ? rc.h0 : rc.h3;
      expect(s.x - 0).toBeCloseTo(100, 0); expect(s.y).toBeCloseTo(-60, 0);
      doc.undo();
      expect(doc.piece(A.id).sew.points.length).toBe(5);
    }
  });
});
