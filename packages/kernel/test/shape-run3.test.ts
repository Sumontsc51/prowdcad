import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, makeContour, gradePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour } from '../src/model/contour';
import { runCurve, shapeRun, segmentCurve } from '../src/ops/points';
import { layoutToWorld, pieceLayout } from '../src/ops/pieces';

/** A and B side by side (hems 0→200→400 on y = 0); C lies over A with its own hem (20,15)→(200,0); D is A again, laid exactly on it */
function setup() {
  const s = makeStyle();
  const mk = (name: string, pts: ReturnType<typeof gradePoint>[], layout?: { x: number; y: number; angleDeg: number }) => { const p = makePiece(name, makeContour(pts, { closed: true }), s.activeSizeTableId); if (layout) p.layout = layout; s.pieces.push(p); return { p, ids: pts.map(q => q.id) }; };
  const A = mk('A', [gradePoint(0, 0), gradePoint(200, 0), gradePoint(200, 300), gradePoint(0, 300)]);
  const B = mk('B', [gradePoint(0, 0), gradePoint(200, 0), gradePoint(200, 300), gradePoint(0, 300)], { x: 200, y: 0, angleDeg: 0 });
  const C = mk('C', [gradePoint(20, 15), gradePoint(200, 0), gradePoint(200, 300), gradePoint(20, 300)]);
  const D = mk('D', [gradePoint(0, 0), gradePoint(200, 0), gradePoint(200, 300), gradePoint(0, 300)]);
  const hem = (x: { p: { id: string; sew: { id: string } }; ids: string[] }) => ({ pieceId: x.p.id, contourId: x.p.sew.id, from: x.ids[0], to: x.ids[1] });
  return { doc: new Document(s), A, B, C, D, hem };
}
const world = (doc: Document, pid: string, aid: string) => {
  const p = doc.piece(pid); const rc = resolveContour(p.sew, doc.sizeLine(p), doc.baseSize(p));
  return layoutToWorld(pieceLayout(p), rc.anchorPos[p.sew.points.findIndex(q => q.id === aid)]);
};

describe('lines laid over a run', () => {
  it('the longest chain is the run, the others are overlays', () => {
    const { doc, A, B, C, D, hem } = setup();
    const rc = runCurve(doc, [hem(C), hem(A), hem(B), hem(D)]);
    expect(rc.parts.length).toBe(2);
    expect(rc.overlays.length).toBe(2);
    expect(Math.abs(rc.p3.x - rc.p0.x)).toBeCloseTo(400);
    const c = rc.overlays.find(o => o.pieceId === C.p.id)!;
    expect([c.na, c.nb].filter(v => v >= 0).length).toBe(1);
    expect(Math.min(c.sa, c.sb)).toBeGreaterThan(0.02); expect(Math.min(c.sa, c.sb)).toBeLessThan(0.1);
    const d = rc.overlays.find(o => o.pieceId === D.p.id || o.pieceId === A.p.id)!;
    expect(d.na >= 0 && d.nb >= 0).toBe(true);
  });
  it('overlays take the one shape: same joint, and the end of its own moves onto the curve', () => {
    const { doc, A, B, C, D, hem } = setup();
    const parts = [hem(A), hem(B), hem(C), hem(D)];
    const rc0 = runCurve(doc, parts);
    const fromA = rc0.p0.x < 1;
    const hA = { x: 100, y: -60 }, hB = { x: -100, y: -60 };
    shapeRun(doc, parts, fromA ? { start: hA, end: hB } : { start: hB, end: hA });
    const jA = world(doc, A.p.id, A.ids[1]), jB = world(doc, B.p.id, B.ids[0]), jC = world(doc, C.p.id, C.ids[1]), jD = world(doc, D.p.id, D.ids[1]);
    for (const j of [jB, jC, jD]) { expect(j.x).toBeCloseTo(jA.x, 6); expect(j.y).toBeCloseTo(jA.y, 6); }
    expect(Math.abs(jA.y + 45)).toBeLessThan(0.5);
    // the wanted curve: (0,0) (100,-60) (300,-60) (400,0)
    const bz = (t: number) => { const u = 1 - t; return { x: 3 * u * u * t * 100 + 3 * u * t * t * 300 + t * t * t * 400, y: -180 * u * t * (u + t) }; };
    const want = Array.from({ length: 4001 }, (_, k) => bz(k / 4000));
    const off = (q: { x: number; y: number }) => Math.min(...want.map(w => Math.hypot(w.x - q.x, w.y - q.y)));
    // C's own end left (20,15) and sits on the curve; all of C's line lies on the curve
    const fC = world(doc, C.p.id, C.ids[0]);
    expect(Math.hypot(fC.x - 20, fC.y - 15)).toBeGreaterThan(5);
    expect(off(fC)).toBeLessThan(0.1);
    const pc = doc.piece(C.p.id), r = resolveContour(pc.sew, doc.sizeLine(pc), doc.baseSize(pc));
    for (const q of r.pts.slice(r.anchorIndex[0], r.anchorIndex[1] + 1)) expect(off(layoutToWorld(pieceLayout(pc), q))).toBeLessThan(0.6);
    const sc = (x: typeof A) => { const p = doc.piece(x.p.id); return segmentCurve(p, doc.sizeLine(p), p.sew.id, x.ids[0], x.ids[1]); };
    const a = sc(A), d = sc(D);
    expect(d.h0.x).toBeCloseTo(a.h0.x, 6); expect(d.h3.y).toBeCloseTo(a.h3.y, 6);
    doc.undo();
    expect(world(doc, C.p.id, C.ids[1]).y).toBeCloseTo(0);
    expect(world(doc, C.p.id, C.ids[0]).y).toBeCloseTo(15);
  });
  it('two lines laid exactly on each other are shaped alike', () => {
    const { doc, A, D, hem } = setup();
    const parts = [hem(A), hem(D)];
    const rc = runCurve(doc, parts);
    expect(rc.parts.length).toBe(1); expect(rc.overlays.length).toBe(1);
    shapeRun(doc, parts, { start: { x: 60, y: -40 } });
    const sc = (x: typeof A) => { const p = doc.piece(x.p.id); return segmentCurve(p, doc.sizeLine(p), p.sew.id, x.ids[0], x.ids[1]); };
    expect(sc(D).h0.y).toBeCloseTo(sc(A).h0.y, 6);
    expect(sc(A).h0.y).not.toBeCloseTo(0, 1);
  });
});
