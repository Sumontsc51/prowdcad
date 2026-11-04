import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area, polylineLength } from '../src/geom/poly';
import { shapeArc, shapeWave, shapeScallop, solveScallops, circularSkirt, ruffle, arcLengthFor } from '../src/ops/shapers';

function setup(w = 100, h = 50) {
  const doc = new Document(makeStyle());
  const c = rectangleContour(0, 0, w, h);
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, pid: piece.id, p: () => doc.piece(piece.id) };
}
const A = (doc: Document, id: string) => area(doc.resolvePiece(id).sew.pts);
const segArea = (C: number, h: number) => { const c = C / 2, R = (c * c + h * h) / (2 * h), th = 2 * Math.asin(c / R); return (R * R / 2) * (th - Math.sin(th)); };

describe('arc (SH1)', () => {
  it('by depth: top edge bulges 10 mm outward; area adds the circular segment', () => {
    const { doc, pid, p } = setup();
    const len = shapeArc(doc, pid, p().sew.points[2].id, p().sew.points[3].id, { depth: 10 });
    expect(len).toBeCloseTo(arcLengthFor(100, 10), 2);
    expect(A(doc, pid) - 5000).toBeCloseTo(segArea(100, 10), 0);
    expect(Math.abs(A(doc, pid) - 5000 - segArea(100, 10))).toBeLessThan(0.5);
    const ys = doc.resolvePiece(pid).sew.pts.map(q => q.y);
    expect(Math.max(...ys)).toBeCloseTo(60, 2);
  });
  it('by radius (semicircle r=50 inward), by length, through-point', () => {
    const { doc, pid, p } = setup(100, 100);
    shapeArc(doc, pid, p().sew.points[2].id, p().sew.points[3].id, { radius: 50, side: -1 });
    expect(Math.abs(A(doc, pid) - (10000 - (Math.PI * 2500) / 2))).toBeLessThan(1); // polygon sampling of the resolver
    // the exact Bézier geometry: every sample within 0.01 mm of the circle centred (50,100)
    for (const q of doc.resolvePiece(pid).sew.pts.filter(q => q.y > 50 + 1e-6)) expect(Math.abs(Math.hypot(q.x - 50, q.y - 100) - 50)).toBeLessThan(0.01);
    doc.undo();
    const L = shapeArc(doc, pid, p().sew.points[2].id, p().sew.points[3].id, { length: 120 });
    expect(L).toBeCloseTo(120, 1);
    doc.undo();
    shapeArc(doc, pid, p().sew.points[2].id, p().sew.points[3].id, { through: { x: 50, y: 120 } });
    expect(Math.max(...doc.resolvePiece(pid).sew.pts.map(q => q.y))).toBeCloseTo(120, 2);
  });
});

describe('wave (SH2)', () => {
  it('count 4, depth 5: area preserved (antisymmetric), crests at ±5', () => {
    const { doc, pid, p } = setup(200, 50);
    const ids = shapeWave(doc, pid, p().sew.points[2].id, p().sew.points[3].id, { count: 4, depth: 5 });
    expect(ids.length).toBe(4 * 4 - 1);
    expect(A(doc, pid)).toBeCloseTo(10000, 3);
    const ys = doc.resolvePiece(pid).sew.pts.map(q => q.y);
    expect(Math.max(...ys)).toBeCloseTo(55, 6); expect(Math.min(...ys.filter(y => y > 20))).toBeCloseTo(45, 6);
  });
});

describe('scallop (SH3)', () => {
  it('solves width ⇄ count and partial placement', () => {
    expect(solveScallops(100, { count: 4 })).toMatchObject({ count: 4, width: 25, partialStart: 0, partialEnd: 0, depth: 12.5 });
    expect(solveScallops(100, { width: 30 })).toMatchObject({ count: 3, width: expect.closeTo(33.333333, 5) });
    expect(solveScallops(100, { width: 30, partial: 'end' })).toMatchObject({ count: 3, width: 30, partialStart: 0, partialEnd: expect.closeTo(10, 9) });
    expect(solveScallops(100, { width: 30, partial: 'both' })).toMatchObject({ count: 3, partialStart: expect.closeTo(5, 9), partialEnd: expect.closeTo(5, 9) });
  });
  it('4 semicircular scallops of width 25 on the bottom edge add 4 half discs', () => {
    const { doc, pid, p } = setup();
    const sol = shapeScallop(doc, pid, p().sew.points[0].id, p().sew.points[1].id, { count: 4 });
    expect(sol.width).toBe(25);
    expect(Math.abs(A(doc, pid) - 5000 - 4 * (Math.PI * 12.5 ** 2) / 2)).toBeLessThan(1); // sampled at 0.05 mm chord tolerance
    const ys = doc.resolvePiece(pid).sew.pts.map(q => q.y);
    expect(Math.min(...ys)).toBeCloseTo(-12.5, 3);
  });
  it('zigzag with partial end; shallow scallops with partial both ends keep the chord ends', () => {
    const { doc, pid, p } = setup();
    shapeScallop(doc, pid, p().sew.points[0].id, p().sew.points[1].id, { width: 20, depth: 10, zigzag: true });
    expect(A(doc, pid) - 5000).toBeCloseTo(5 * 100, 9);
    doc.undo();
    shapeScallop(doc, pid, p().sew.points[0].id, p().sew.points[1].id, { width: 30, depth: 5, partial: 'both' });
    const r = doc.resolvePiece(pid).sew;
    expect(r.anchorPos[0]).toEqual({ x: 0, y: 0 });
    expect(A(doc, pid)).toBeGreaterThan(5000);
  });
});

describe('generators (SH4)', () => {
  it('half-circle skirt: waist 600, length 500', () => {
    const doc = new Document(makeStyle());
    const [id] = circularSkirt(doc, { waist: 600, length: 500, sweepDeg: 180 });
    const r = 600 / Math.PI, R = r + 500;
    const rp = doc.resolvePiece(id).sew;
        expect(Math.abs(area(rp.pts) / ((Math.PI / 2) * (R * R - r * r)) - 1)).toBeLessThan(1e-4);
    // inner arc length = waist
    const n = doc.piece(id).sew.points.length;
    const iStart = rp.anchorIndex[n / 2];
    const inner = [...rp.pts.slice(iStart), rp.pts[0]];
    expect(polylineLength(inner)).toBeGreaterThan(R * 2 - 1); // includes the closing side seam
  });
  it('full circle → 2 panels', () => {
    const doc = new Document(makeStyle());
    const ids = circularSkirt(doc, { waist: 700, length: 600, sweepDeg: 360 });
    expect(ids.length).toBe(2);
    expect(doc.piece(ids[0]).name).toBe('CIRCLE_SKIRT_1');
  });
  it('ruffle strip ×2 fullness with section notches', () => {
    const { doc, pid, p } = setup(150, 50);
    const sid = ruffle(doc, pid, p().sew.points[0].id, p().sew.points[1].id, { fullness: 2, width: 60 });
    expect(area(doc.resolvePiece(sid).sew.pts)).toBeCloseTo(300 * 60, 9);
    expect(doc.piece(sid).notches.length).toBe(3);
    expect(p().notches.length).toBe(3);
  });
});
