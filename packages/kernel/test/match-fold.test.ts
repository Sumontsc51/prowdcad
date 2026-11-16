import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, makeContour, gradePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour } from '../src/model/contour';
import { matchLines, shapeSegment, segmentCurve, runCurve } from '../src/ops/points';
import { layoutToWorld, pieceLayout, setFold, clearFold, foldMirror, onFoldedPart } from '../src/ops/pieces';

function setup() {
  const s = makeStyle();
  const mk = (name: string, pts: ReturnType<typeof gradePoint>[]) => { const p = makePiece(name, makeContour(pts, { closed: true }), s.activeSizeTableId); s.pieces.push(p); return { p, ids: pts.map(q => q.id) }; };
  // A: hem 0→300, curved by a handle later. B: laid on A, hem 0→220 straight, a little off
  const A = mk('A', [gradePoint(0, 0), gradePoint(300, 0), gradePoint(300, 300), gradePoint(0, 300)]);
  const B = mk('B', [gradePoint(0, 4), gradePoint(220, 4), gradePoint(220, 300), gradePoint(0, 300)]);
  const hem = (x: typeof A) => ({ pieceId: x.p.id, contourId: x.p.sew.id, from: x.ids[0], to: x.ids[1] });
  const doc = new Document(s);
  shapeSegment(doc, A.p.id, A.p.sew.id, A.ids[0], A.ids[1], { start: { x: 100, y: -50 }, end: { x: -100, y: -20 } });
  return { doc, A, B, hem };
}
const linePts = (doc: Document, pid: string, i: number, j: number) => { const p = doc.piece(pid); const r = resolveContour(p.sew, doc.sizeLine(p), doc.baseSize(p)); return r.pts.slice(r.anchorIndex[i], r.anchorIndex[j] + 1).map(q => layoutToWorld(pieceLayout(p), q)); };
const plen = (q: { x: number; y: number }[]) => { let L = 0; for (let k = 1; k < q.length; k++) L += Math.hypot(q[k].x - q[k - 1].x, q[k].y - q[k - 1].y); return L; };
const off = (q: { x: number; y: number }, poly: { x: number; y: number }[]) => { let d = Infinity; for (let e = 0; e + 1 < poly.length; e++) { const a = poly[e], b = poly[e + 1], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy, u = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / l2)) : 0; d = Math.min(d, Math.hypot(q.x - a.x - u * vx, q.y - a.y - u * vy)); } return d; };

describe('Match Line', () => {
  it('the second line takes the shape of the first and keeps its own length', () => {
    const { doc, A, B, hem } = setup();
    const a0 = linePts(doc, A.p.id, 0, 1), b0 = linePts(doc, B.p.id, 0, 1);
    const res = matchLines(doc, [hem(A)], [hem(B)]);
    const a1 = linePts(doc, A.p.id, 0, 1), b1 = linePts(doc, B.p.id, 0, 1);
    expect(JSON.stringify(a1)).toBe(JSON.stringify(a0)); // the master is untouched
    expect(Math.abs(plen(b1) - plen(b0))).toBeLessThan(0.05); // same length
    expect(res.targetLength).toBeCloseTo(220, 3);
    for (const q of b1) expect(off(q, a0)).toBeLessThan(0.3); // on the master's shape
    expect(b1[0].x).toBeCloseTo(0, 1); // it starts at the end that lay on the master
    doc.undo();
    expect(JSON.stringify(linePts(doc, B.p.id, 0, 1))).toBe(JSON.stringify(b0));
  });
  it('a longer second line goes on straight past the end of the first', () => {
    const { doc, A, B, hem } = setup();
    matchLines(doc, [hem(B)], [hem(A)]); // master = B (220, straight at y = 4), target = A (longer)
    const a1 = linePts(doc, A.p.id, 0, 1);
    for (const q of a1) expect(Math.abs(q.y - 4)).toBeLessThan(0.05);
    expect(plen(a1)).toBeGreaterThan(300);
  });
});

describe('Fold view', () => {
  it('folds the smaller part, mirrors points, and unfolds', () => {
    const { doc, A } = setup();
    setFold(doc, A.p.id, { x: 200, y: -100 }, { x: 200, y: 400 });
    const p = doc.piece(A.p.id);
    expect(p.fold).toBeTruthy();
    expect(onFoldedPart(p, { x: 250, y: 100 })).toBe(true);
    expect(onFoldedPart(p, { x: 100, y: 100 })).toBe(false);
    const m = foldMirror(p.fold!, { x: 300, y: 300 }); expect(m.x).toBeCloseTo(100); expect(m.y).toBeCloseTo(300);
    expect(() => setFold(doc, A.p.id, { x: 900, y: 0 }, { x: 900, y: 10 })).toThrow(/does not cross/);
    clearFold(doc, A.p.id); expect(doc.piece(A.p.id).fold).toBeUndefined();
    doc.undo(); expect(doc.piece(A.p.id).fold).toBeTruthy();
  });
  it('a line on the folded part is taken where the fold shows it', () => {
    const { doc, A } = setup();
    // fold the right third over: the right edge x = 300 (ids 1 → 2) then lies on x = 100
    setFold(doc, A.p.id, { x: 200, y: -100 }, { x: 200, y: 400 });
    const s = doc.style, T = makePiece('T', makeContour([gradePoint(100, 0), gradePoint(100, 300), gradePoint(40, 300), gradePoint(40, 0)], { closed: true }), s.activeSizeTableId);
    doc.transact('add', () => { s.pieces.push(T); });
    const edge = { pieceId: A.p.id, contourId: A.p.sew.id, from: A.ids[1], to: A.ids[2] };
    const tEdge = { pieceId: T.id, contourId: T.sew.id, from: T.sew.points[0].id, to: T.sew.points[1].id };
    const rc = runCurve(doc, [edge, tEdge]); // they lie exactly on each other
    expect(rc.parts.length).toBe(1); expect(rc.overlays.length).toBe(1);
    expect(rc.p0.x).toBeCloseTo(100); expect(rc.p3.x).toBeCloseTo(100);
    // match the folded edge to a bent line of T: on the real piece it bends the other way (mirrored)
    shapeSegment(doc, T.id, T.sew.id, tEdge.from, tEdge.to, { start: { x: -30, y: 100 }, end: { x: -30, y: -100 } });
    matchLines(doc, [tEdge], [edge]);
    const pa = doc.piece(A.p.id), sc = segmentCurve(pa, doc.sizeLine(pa), pa.sew.id, A.ids[1], A.ids[2]);
    expect(sc.h0.x).toBeGreaterThan(300 + 20);
    expect(sc.p0.x).toBeCloseTo(300, 1);
  });
});
