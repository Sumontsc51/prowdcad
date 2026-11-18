import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, makeContour, gradePoint, rectangleContour } from '../src/model/factory';
import { setCorner, cutLineForSize, cornerPointsForSize, cornerFacts, cornerPreview, setSeam } from '../src/ops/seam';
import { area } from '../src/geom/poly';

const near = (pts: { x: number; y: number }[], x: number, y: number) => Math.min(...pts.map(q => Math.hypot(q.x - x, q.y - y)));
function spike() { // a 30° point at (300, 0)
  const d = new Document(makeStyle('t', ['M'], 'M'));
  const y = 300 * Math.tan(15 * Math.PI / 180);
  const p = makePiece('S', makeContour([gradePoint(0, -y), gradePoint(300, 0), gradePoint(0, y)]), d.style.activeSizeTableId, { seamDefault: 10 });
  d.transact('add', s => s.pieces.push(p));
  return { d, p, tip: p.sew.points[1].id };
}
const cutOf = (d: Document, id: string) => { const p = d.piece(id), l = d.sizeLine(p); return cutLineForSize(p, l, l.baseSizeId).pts; };
const cornerOf = (d: Document, id: string, a: string) => { const p = d.piece(id), l = d.sizeLine(p); return cornerPointsForSize(p, l, l.baseSizeId).find(c => c.anchorId === a)!.pts; };

describe('mitered at a distance (truncated)', () => {
  it('cuts the miter off square at the distance from the sew corner', () => {
    const { d, p, tip } = spike();
    setCorner(d, p.id, tip, { type: 'truncated', dist: 25 });
    const c = cornerOf(d, p.id, tip);
    expect(c.length).toBe(2);
    for (const q of c) expect(q.x).toBeCloseTo(325, 6);       // square to the axis of the point
    expect(c[0].y).toBeCloseTo(-c[1].y, 6);
    expect(Math.max(...cutOf(d, p.id).map(q => q.x))).toBeCloseTo(325, 6);
  });
  it('is the plain miter when the miter point is nearer than the distance; default distance = the larger allowance', () => {
    const { d, p, tip } = spike();
    setCorner(d, p.id, tip, { type: 'truncated', dist: 60 }); // miter point is 10 / sin 15° = 38.6 out
    expect(cornerOf(d, p.id, tip).length).toBe(1);
    expect(Math.max(...cutOf(d, p.id).map(q => q.x))).toBeCloseTo(300 + 10 / Math.sin(15 * Math.PI / 180), 6);
    setCorner(d, p.id, tip, { type: 'truncated' });
    expect(Math.max(...cutOf(d, p.id).map(q => q.x))).toBeCloseTo(310, 6);
  });
});

describe('cut-out corner', () => {
  it('runs the cut line to the sew corner and removes the corner square', () => {
    const d = new Document(makeStyle('t', ['M'], 'M'));
    const p = makePiece('B', rectangleContour(0, 0, 400, 600), d.style.activeSizeTableId, { seamDefault: 10 });
    d.transact('add', s => s.pieces.push(p));
    const a0 = Math.abs(area(cutOf(d, p.id)));
    const cid = p.sew.points[1].id; // (400, 0)
    setCorner(d, p.id, cid, { type: 'cutout' });
    const c = cornerOf(d, p.id, cid);
    expect(c.map(q => [Math.round(q.x), Math.round(q.y)].join())).toEqual(['400,-10', '400,0', '410,0']);
    expect(a0 - Math.abs(area(cutOf(d, p.id)))).toBeCloseTo(100, 6);
  });
});

describe('corner facts and corner pictures', () => {
  it('reports the inside angle, the allowances and the neighbours', () => {
    const { d, p, tip } = spike();
    setSeam(d, p.id, tip, p.sew.points[2].id, 20);
    const q = d.piece(p.id), l = d.sizeLine(q);
    const f = cornerFacts(q, l, l.baseSizeId, tip);
    expect(f.angleDeg).toBeCloseTo(30, 6); expect(f.convex).toBe(true);
    expect([f.dPrev, f.dNext]).toEqual([10, 20]);
    expect([f.prevId, f.nextId]).toEqual([p.sew.points[0].id, p.sew.points[2].id]);
  });
  it('an inside (reflex) corner is not convex', () => {
    const d = new Document(makeStyle('t', ['M'], 'M'));
    const p = makePiece('L', makeContour([gradePoint(0, 0), gradePoint(200, 0), gradePoint(200, 100), gradePoint(100, 100), gradePoint(100, 200), gradePoint(0, 200)]), d.style.activeSizeTableId, { seamDefault: 10 });
    d.transact('add', s => s.pieces.push(p));
    const l = d.sizeLine(p);
    const f = cornerFacts(d.piece(p.id), l, l.baseSizeId, p.sew.points[3].id);
    expect(f.convex).toBe(false); expect(f.angleDeg).toBeCloseTo(270, 6);
    expect(cornerFacts(d.piece(p.id), l, l.baseSizeId, p.sew.points[1].id).angleDeg).toBeCloseTo(90, 6);
  });
  it('draws every corner type for a 90° corner', () => {
    const m = cornerPreview(undefined, 90, 10, 20);
    expect(m.sew[1]).toEqual({ x: 0, y: 0 });
    expect(near(m.corner, 20, -10)).toBeLessThan(1e-6); // miter point: 20 past the corner, 10 below the line before it
    expect(cornerPreview({ type: 'cutout' }, 90, 10, 20).corner.length).toBe(3);
    expect(cornerPreview({ type: 'angled' }, 90, 10, 20).corner.length).toBe(2);
    expect(cornerPreview({ type: 'boxed', extend: 'both' }, 90, 10, 20).corner.length).toBeGreaterThan(0);
    const tb = cornerPreview({ type: 'turnback', extend: 'next', folds: [12, 8] }, 70, 10, 20).corner;
    expect(tb.length).toBe(3);
    for (const t of ['miter', 'boxed', 'turnback', 'angled', 'truncated', 'cutout'] as const) expect(cornerPreview({ type: t }, 60, 10, 10).cut.length).toBeGreaterThanOrEqual(3);
  });
});
