import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, rectangleContour } from '../src/model/factory';
import { addNotch, resolveNotch, setCornerNotches, cornerNotchSide, placementAt } from '../src/ops/notches';
import { drawPiece } from '../src/io/common';

function block() {
  const d = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const p = makePiece('B', rectangleContour(0, 0, 400, 600), d.style.activeSizeTableId, { seamDefault: 10 });
  d.transact('add', s => s.pieces.push(p));
  return { d, p };
}
const ends = (g: { x: number; y: number }[][]) => g.map(pl => pl[0]);

describe('notch on the cut line, the sew line, or both', () => {
  it('cut (default) starts on the cut line; sew starts on the sew line; both makes two marks', () => {
    const { d, p } = block();
    const pl = placementAt(d, d.piece(p.id), p.sew.id, 200, 'fromPrev'); // middle of the bottom edge (y = 0)
    const nc = addNotch(d, d.piece(p.id), { placement: pl });
    const ns = addNotch(d, d.piece(p.id), { placement: pl, on: 'sew' });
    const nb = addNotch(d, d.piece(p.id), { placement: pl, on: 'both' });
    const q = d.piece(p.id);
    expect(nc.on).toBeUndefined();
    const rc = resolveNotch(d, q, nc), rs = resolveNotch(d, q, ns), rb = resolveNotch(d, q, nb);
    expect(rc.pos.y).toBeCloseTo(0, 6);
    expect(ends(rc.cutGeometry)[0].y).toBeCloseTo(-10, 6);
    expect(ends(rs.cutGeometry)[0].y).toBeCloseTo(0, 6); expect(rs.mouth.y).toBeCloseTo(0, 6);
    expect(rs.cutGeometry[0][1].y).toBeGreaterThan(0); // the mark runs into the piece
    expect(rb.cutGeometry.length).toBe(2);
    expect(ends(rb.cutGeometry).map(e => Math.round(e.y)).sort((a, b) => a - b)).toEqual([-10, 0]);
    // exports: one mark, one mark on the sew line, two marks
    const dn = drawPiece(d, q).notches;
    expect(dn.length).toBe(4);
    expect(dn.map(n => Math.round(n.a.y)).sort((a, b) => a - b)).toEqual([-10, -10, 0, 0]);
  });
  it('a piece without seam has one mark whatever the setting', () => {
    const { d, p } = block();
    d.transact('ns', s => { s.pieces[0].noSeam = true; });
    const n = addNotch(d, d.piece(p.id), { placement: placementAt(d, d.piece(p.id), p.sew.id, 200, 'fromPrev'), on: 'both' });
    expect(resolveNotch(d, d.piece(p.id), n).cutGeometry.length).toBe(1);
  });
});

describe('corner notches: one side, other side, both, none', () => {
  it('sets, replaces and removes them in one step', () => {
    const { d, p } = block();
    const corner = p.sew.points[1].id; // (400, 0)
    expect(cornerNotchSide(d.piece(p.id), corner)).toBe('none');
    const both = setCornerNotches(d, d.piece(p.id), corner, 'both');
    expect(both.map(n => n.cornerDir)).toEqual(['prev', 'next']);
    expect(cornerNotchSide(d.piece(p.id), corner)).toBe('both');
    const q = d.piece(p.id);
    const r = both.map(n => resolveNotch(d, q, n));
    // previous line (the bottom edge) continued hits the right cut line; next line (right edge) extended back hits the bottom cut line
    const mouths = r.map(x => [Math.round(x.mouth.x), Math.round(x.mouth.y)].join());
    expect(mouths.sort()).toEqual(['400,-10', '410,0']);
    setCornerNotches(d, d.piece(p.id), corner, 'next');
    expect(cornerNotchSide(d.piece(p.id), corner)).toBe('next');
    expect(d.piece(p.id).notches.length).toBe(1);
    setCornerNotches(d, d.piece(p.id), corner, 'none');
    expect(d.piece(p.id).notches.length).toBe(0);
    d.undo(); expect(d.piece(p.id).notches.length).toBe(1);
  });
  it('leaves other notches alone', () => {
    const { d, p } = block();
    addNotch(d, d.piece(p.id), { placement: placementAt(d, d.piece(p.id), p.sew.id, 200, 'fromPrev') });
    setCornerNotches(d, d.piece(p.id), p.sew.points[2].id, 'prev');
    setCornerNotches(d, d.piece(p.id), p.sew.points[2].id, 'none');
    expect(d.piece(p.id).notches.length).toBe(1);
  });
});
