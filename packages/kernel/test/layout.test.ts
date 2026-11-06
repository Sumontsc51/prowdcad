import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, rectangleContour } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { layoutToWorld, layoutToLocal, layoutDirToWorld, layoutDirToLocal, flippedLayout, rotatedLayout, normalizeLayout, transformPieceLayouts, saveLayout, restoreLayout, type PieceLayout } from '../src/index';

const close = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-9) => { expect(a.x).toBeCloseTo(b.x, 9); expect(a.y).toBeCloseTo(b.y, 9); void eps; };

function doc1() {
  const s = makeStyle();
  const p = makePiece('A', rectangleContour(0, 0, 100, 50), s.activeSizeTableId);
  s.pieces.push(p);
  return { doc: new Document(s), id: p.id };
}

describe('piece layout transform (move / rotate / flip)', () => {
  const Ls: PieceLayout[] = [
    { x: 0, y: 0, angleDeg: 0 },
    { x: 12, y: -7, angleDeg: 33 },
    { x: 5, y: 9, angleDeg: 0, flipX: true },
    { x: -3, y: 2, angleDeg: 271, flipY: true },
  ];
  it('toLocal inverts toWorld (points and directions)', () => {
    for (const L of Ls) for (const v of [{ x: 0, y: 0 }, { x: 10, y: 3 }, { x: -4, y: 8 }]) {
      close(layoutToLocal(L, layoutToWorld(L, v)), v);
      close(layoutDirToLocal(L, layoutDirToWorld(L, v)), v);
    }
  });
  it('flipX mirrors the local x axis', () => {
    close(layoutToWorld({ x: 0, y: 0, angleDeg: 0, flipX: true }, { x: 10, y: 3 }), { x: -10, y: 3 });
    close(layoutToWorld({ x: 0, y: 0, angleDeg: 0, flipY: true }, { x: 10, y: 3 }), { x: 10, y: -3 });
  });
  it('flipX + flipY normalises to a 180° rotation', () => {
    const n = normalizeLayout({ x: 1, y: 2, angleDeg: 30, flipX: true, flipY: true });
    expect(n.flipX).toBeUndefined(); expect(n.flipY).toBeUndefined(); expect(n.angleDeg).toBeCloseTo(210, 9);
    for (const v of [{ x: 10, y: 3 }, { x: -2, y: 5 }]) close(layoutToWorld(n, v), layoutToWorld({ x: 1, y: 2, angleDeg: 30, flipX: true, flipY: true }, v));
  });
  it('flipping horizontally mirrors every world point about the vertical line through the pivot', () => {
    for (const L of Ls) {
      const pivot = { x: 17, y: -4 };
      const F = flippedLayout(L, 'h', pivot);
      for (const v of [{ x: 0, y: 0 }, { x: 10, y: 3 }, { x: -4, y: 8 }]) {
        const w = layoutToWorld(L, v), w2 = layoutToWorld(F, v);
        close(w2, { x: 2 * pivot.x - w.x, y: w.y });
      }
      const V = flippedLayout(L, 'v', pivot);
      for (const v of [{ x: 0, y: 0 }, { x: 10, y: 3 }]) { const w = layoutToWorld(L, v); close(layoutToWorld(V, v), { x: w.x, y: 2 * pivot.y - w.y }); }
      // flipping twice is the identity placement
      const FF = flippedLayout(F, 'h', pivot);
      for (const v of [{ x: 3, y: 1 }, { x: -6, y: 2 }]) close(layoutToWorld(FF, v), layoutToWorld(L, v));
    }
  });
  it('rotating about a pivot keeps the pivot fixed', () => {
    const L: PieceLayout = { x: 10, y: 0, angleDeg: 15, flipX: true };
    const pivot = { x: 40, y: 20 };
    const lp = layoutToLocal(L, pivot);
    const R = rotatedLayout(L, 90, pivot);
    close(layoutToWorld(R, lp), pivot);
    expect(R.angleDeg).toBeCloseTo(105, 9); expect(R.flipX).toBe(true);
  });
  it('transformPieceLayouts is one undo step and leaves the authored geometry untouched', () => {
    const { doc, id } = doc1();
    const before = JSON.stringify(doc.piece(id).sew);
    transformPieceLayouts(doc, [id], { dx: 5, dy: 6, flip: 'h', pivot: { x: 50, y: 25 } }, 'Flip piece');
    const L = doc.piece(id).layout!;
    expect(L.flipX).toBe(true);
    expect(JSON.stringify(doc.piece(id).sew)).toBe(before);
    expect(doc.undoLabel()).toBe('Flip piece');
    doc.undo();
    expect(doc.piece(id).layout).toBeUndefined();
  });
  it('locked pieces are refused', () => {
    const { doc, id } = doc1();
    doc.piece(id).locked = true;
    expect(() => transformPieceLayouts(doc, [id], { dx: 1 })).toThrow(/locked/);
  });
  it('save / restore layout keeps flips', () => {
    const { doc, id } = doc1();
    transformPieceLayouts(doc, [id], { flip: 'v', pivot: { x: 0, y: 0 } });
    saveLayout(doc, 'one');
    transformPieceLayouts(doc, [id], { flip: 'v', pivot: { x: 0, y: 0 } });
    expect(doc.piece(id).layout!.flipY).toBeUndefined();
    restoreLayout(doc, 'one');
    expect(doc.piece(id).layout!.flipY).toBe(true);
  });
});
