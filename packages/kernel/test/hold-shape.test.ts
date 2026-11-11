import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour } from '../src/model/contour';
import { movePoint, holdShapeAcrossGrade } from '../src/ops/points';

/** corner A · curve c1 · smooth grade G · curve c2 · corner B, closed by a straight bottom */
function doc1() {
  const s = makeStyle();
  const pts = [
    gradePoint(0, 0), curvePoint(100, 20), gradePoint(200, 30, { smooth: true }), curvePoint(300, 20), gradePoint(400, 0),
    gradePoint(400, -200), gradePoint(0, -200),
  ];
  const p = makePiece('A', makeContour(pts, { closed: true }), s.activeSizeTableId);
  s.pieces.push(p);
  return { doc: new Document(s), id: p.id, ids: pts.map(a => a.id) };
}
const span = (doc: Document, id: string, from: number, to: number) => {
  const p = doc.piece(id); const rc = resolveContour(p.sew, doc.sizeLine(p), doc.baseSize(p));
  return JSON.stringify(rc.pts.slice(rc.anchorIndex[from], rc.anchorIndex[to] + 1).map(q => [Math.round(q.x * 1e6) / 1e6, Math.round(q.y * 1e6) / 1e6]));
};

describe('Move Point: a smooth grade point works as a split', () => {
  it('without the hold, moving a curve point reshapes the far side of the grade point', () => {
    const { doc, id, ids } = doc1();
    const far = span(doc, id, 0, 2);
    movePoint(doc, id, ids[3], { dx: 0, dy: 40 });
    expect(span(doc, id, 0, 2)).not.toBe(far);
  });
  it('with the hold, the far side keeps its exact shape and the near side changes', () => {
    const { doc, id, ids } = doc1();
    const far = span(doc, id, 0, 2), near = span(doc, id, 2, 4);
    holdShapeAcrossGrade(doc, id, ids[3]);
    expect(span(doc, id, 0, 2)).toBe(far);
    expect(span(doc, id, 2, 4)).toBe(near); // the hold alone changes nothing
    movePoint(doc, id, ids[3], { dx: 0, dy: 40 });
    expect(span(doc, id, 0, 2)).toBe(far);
    expect(span(doc, id, 2, 4)).not.toBe(near);
    const g = doc.piece(id).sew.points[2];
    expect(g.hIn).toBeTruthy(); expect(g.hOut).toBeUndefined();
  });
  it('moving the point on the other side next releases the held side and holds the opposite one', () => {
    const { doc, id, ids } = doc1();
    holdShapeAcrossGrade(doc, id, ids[3]); movePoint(doc, id, ids[3], { dx: 0, dy: 40 });
    const right = span(doc, id, 2, 4);
    holdShapeAcrossGrade(doc, id, ids[1]); movePoint(doc, id, ids[1], { dx: 0, dy: -30 });
    expect(span(doc, id, 2, 4)).toBe(right);
    const g = doc.piece(id).sew.points[2];
    expect(g.hIn).toBeUndefined(); expect(g.hOut).toBeTruthy();
  });
  it('a handle the user edited after the hold is never released', () => {
    const { doc, id, ids } = doc1();
    holdShapeAcrossGrade(doc, id, ids[3]);
    doc.transact('edit', () => { doc.piece(id).sew.points[2].hIn = { x: -50, y: 0 }; });
    holdShapeAcrossGrade(doc, id, ids[1]);
    expect(doc.piece(id).sew.points[2].hIn).toEqual({ x: -50, y: 0 });
  });
  it('moving the grade point itself makes it automatic again', () => {
    const { doc, id, ids } = doc1();
    holdShapeAcrossGrade(doc, id, ids[3]);
    holdShapeAcrossGrade(doc, id, ids[2]);
    const g = doc.piece(id).sew.points[2];
    expect(g.hIn).toBeUndefined(); expect(g.hOut).toBeUndefined(); expect(g.hHold).toBeUndefined();
  });
});
