import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, makeContour, gradePoint } from '../src/model/factory';
import { setTurnback, turnbackOf, turnbackFoldLines, cutLineForSize, setSeam } from '../src/ops/seam';
import { area } from '../src/geom/poly';

/** A-line panel: hem 0..400 at y = 0, side seams flare (top is 300 wide, 500 up). Seam 10 everywhere. */
function panel() {
  const d = new Document(makeStyle('t', ['M'], 'M'));
  const sew = makeContour([gradePoint(0, 0), gradePoint(400, 0), gradePoint(350, 500), gradePoint(50, 500)]);
  const p = makePiece('SKIRT', sew, d.style.activeSizeTableId, { seamDefault: 10 });
  d.transact('add', s => s.pieces.push(p));
  return { d, p, ids: sew.points.map(a => a.id) };
}
const cut = (d: Document, id: string) => { const p = d.piece(id); return cutLineForSize(p, d.sizeLine(p), d.sizeLine(p).baseSizeId).pts; };
const near = (pts: { x: number; y: number }[], x: number, y: number) => Math.min(...pts.map(q => Math.hypot(q.x - x, q.y - y)));

describe('turn-back hem with several folds', () => {
  it('sets the seam to the sum and makes both end corners turn-back', () => {
    const { d, p, ids } = panel();
    setTurnback(d, p.id, ids[0], ids[1], [30, 10]);
    const q = d.piece(p.id);
    expect(q.sew.points[0].seamAfter).toBe(40);
    expect(q.sew.points[0].corner).toEqual({ type: 'turnback', extend: 'next', folds: [30, 10] });
    expect(q.sew.points[1].corner).toEqual({ type: 'turnback', extend: 'prev', folds: [30, 10] });
    expect(turnbackOf(q, ids[0])).toEqual([30, 10]);
    d.undo(); expect(d.piece(p.id).sew.points[0].corner).toBeUndefined();
  });

  it('the edge mirrors the side seam in fold 1 and runs parallel to it again in fold 2', () => {
    const { d, p, ids } = panel();
    setTurnback(d, p.id, ids[0], ids[1], [30, 10]);
    const pts = cut(d, p.id);
    // right side seam: sew line x = 400 − y/10, cut line 10 outside it. It reaches the hem line (y = 0) at xr.
    const xr = 400 + 10 * Math.hypot(1, 0.1);
    // fold 1 (depth 0…30) mirrors the seam: at depth 30 the edge is where the seam is 30 above the hem
    expect(near(pts, xr, 0)).toBeLessThan(1e-6);
    expect(near(pts, xr - 3, -30)).toBeLessThan(1e-6);
    // fold 2 (30…40) lies on the seam between 30 and 20 above the hem: back out by 1
    expect(near(pts, xr - 2, -40)).toBeLessThan(1e-6);
    // left end is the mirror image
    const xl = -10 * Math.hypot(1, 0.1);
    expect(near(pts, xl, 0)).toBeLessThan(1e-6);
    expect(near(pts, xl + 3, -30)).toBeLessThan(1e-6);
    expect(near(pts, xl + 2, -40)).toBeLessThan(1e-6);
    expect(Math.min(...pts.map(q => q.y))).toBeCloseTo(-40, 6);
  });

  it('three folds, each with its own value, and the fold lines', () => {
    const { d, p, ids } = panel();
    setTurnback(d, p.id, ids[0], ids[1], [25, 25, 8]);
    const q = d.piece(p.id), line = d.sizeLine(q);
    expect(q.sew.points[0].seamAfter).toBe(58);
    const pts = cut(d, p.id);
    const xr = 400 + 10 * Math.hypot(1, 0.1);
    expect(near(pts, xr - 2.5, -25)).toBeLessThan(1e-6);
    expect(near(pts, xr, -50)).toBeLessThan(1e-6);
    expect(near(pts, xr - 0.8, -58)).toBeLessThan(1e-6);
    const fl = turnbackFoldLines(q, line, line.baseSizeId);
    expect(fl.length).toBe(2);
    expect(fl.map(l => Math.round(l[0].y)).sort((a, b) => a - b)).toEqual([-50, -25]);
    for (const l of fl) { expect(l[0].y).toBeCloseTo(l[l.length - 1].y, 6); expect(Math.abs(l[0].x - l[l.length - 1].x)).toBeGreaterThan(395); }
  });

  it('one value is the ordinary turn-back; an empty list removes it; bad values are refused', () => {
    const { d, p, ids } = panel();
    setTurnback(d, p.id, ids[0], ids[1], [40]);
    const one = cut(d, p.id);
    const xr = 400 + 10 * Math.hypot(1, 0.1);
    expect(near(one, xr - 4, -40)).toBeLessThan(1e-6);
    expect(turnbackFoldLines(d.piece(p.id), d.sizeLine(p), d.sizeLine(p).baseSizeId)).toEqual([]);
    setTurnback(d, p.id, ids[0], ids[1], []);
    expect(d.piece(p.id).sew.points[0].corner).toBeUndefined();
    expect(d.piece(p.id).sew.points[0].seamAfter).toBe(40);
    expect(() => setTurnback(d, p.id, ids[0], ids[1], [10, 0])).toThrow();
    expect(() => setTurnback(d, p.id, ids[0], ids[1], [1, 1, 1, 1, 1, 1, 1])).toThrow();
  });

  it('a seam value changed afterwards keeps a valid cut line', () => {
    const { d, p, ids } = panel();
    setTurnback(d, p.id, ids[0], ids[1], [30, 10]);
    const a0 = Math.abs(area(cut(d, p.id)));
    setSeam(d, p.id, ids[0], ids[1], 35); // shorter than the folds: the last fold is cut short
    const pts = cut(d, p.id);
    expect(Math.min(...pts.map(q => q.y))).toBeCloseTo(-35, 6);
    expect(Math.abs(area(pts))).toBeLessThan(a0);
  });
});
