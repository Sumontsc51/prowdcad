import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, rectangleContour, newId } from '../src/model/factory';
import type { Contour, Piece } from '../src/model/types';
import { scalePiece, pctToFactor } from '../src/ops/scale';
import { bbox, boxW, boxH } from '../src/geom/vec';
import { area } from '../src/geom/poly';

function setup() {
  const doc = new Document(makeStyle('s', ['S', 'M', 'L'], 'M'));
  const [S, M, L] = doc.sizeLine().sizes.map(s => s.id);
  return { doc, S, M, L };
}
function add(doc: Document, c: Contour): Piece {
  const p = makePiece('A', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(p));
  return p;
}
const sewBox = (doc: Document, id: string, size?: string) => bbox(doc.resolvePiece(id, size).sew.pts);

describe('scale & shrink (A8)', () => {
  it('D8: 10% shrink (proportional to 100) → +11.111% growth; 100 mm → 111.111 mm; ×0.9 = 100', () => {
    expect(pctToFactor(10, true)).toBeCloseTo(1.111111111111, 12);
    expect(pctToFactor(10, true) - 1).toBeCloseTo(0.111111111111, 12);
    const { doc } = setup();
    const p = add(doc, rectangleContour(0, 0, 100, 60));
    const res = scalePiece(doc, p.id, { xPct: 10, yPct: 10 }, { proportionalTo100: true });
    expect(res.fx).toBeCloseTo(100 / 90, 14);
    const b = sewBox(doc, p.id);
    expect(boxW(b)).toBeCloseTo(111.111111, 6);
    expect(Number(boxW(b).toFixed(3))).toBe(111.111);
    expect(boxW(b) * 0.9).toBeCloseTo(100, 10);
    expect(boxH(b) * 0.9).toBeCloseTo(60, 10);
    // centre preserved
    expect((b.minX + b.maxX) / 2).toBeCloseTo(50, 10);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(30, 10);
  });

  it('plain percent, absolute and increment inputs', () => {
    const { doc } = setup();
    const p = add(doc, rectangleContour(0, 0, 100, 60));
    scalePiece(doc, p.id, { xPct: 10, yPct: -5 });
    expect(boxW(sewBox(doc, p.id))).toBeCloseTo(110, 10);
    expect(boxH(sewBox(doc, p.id))).toBeCloseTo(57, 10);
    scalePiece(doc, p.id, { xAbs: 200 });
    expect(boxW(sewBox(doc, p.id))).toBeCloseTo(200, 10);
    expect(boxH(sewBox(doc, p.id))).toBeCloseTo(57, 10);
    scalePiece(doc, p.id, { xInc: -20, yInc: 3 });
    expect(boxW(sewBox(doc, p.id))).toBeCloseTo(180, 10);
    expect(boxH(sewBox(doc, p.id))).toBeCloseTo(60, 10);
  });

  it('scaleGrading nest vs base', () => {
    const mk = (mode: 'nest' | 'base') => {
      const { doc, L } = setup();
      const c = rectangleContour(0, 0, 100, 60);
      for (const i of [1, 2]) c.points[i].grade = { [L]: { dx: 10, dy: 0 } };
      const p = add(doc, c);
      scalePiece(doc, p.id, { xPct: 50 }, { scaleGrading: mode });
      return boxW(sewBox(doc, p.id, L));
    };
    expect(mk('nest')).toBeCloseTo(165, 10); // (100+10)·1.5
    expect(mk('base')).toBeCloseTo(160, 10); // 100·1.5 + 10
  });

  it('scaleSeam scales allowances by perpendicular stretch; stampDescription; notches rescale', () => {
    const { doc, M } = setup();
    const c = rectangleContour(0, 0, 100, 60);
    const p = add(doc, c);
    doc.transact('n', () => doc.piece(p.id).notches.push({ id: newId('n'), contourId: c.id, placement: { kind: 'fromPrev', anchorId: c.points[0].id, dist: { [M]: 25 } }, type: 'slit', depth: 5, width: 0, angleDeg: 0 }));
    scalePiece(doc, p.id, { xPct: 100, yPct: 50 }, { scaleSeam: true, stampDescription: true });
    const pc = doc.piece(p.id);
    // bottom edge (horizontal): seam × fy; right edge (vertical): seam × fx
    expect(pc.sew.points[0].seamAfter).toBeCloseTo(15, 12);
    expect(pc.sew.points[1].seamAfter).toBeCloseTo(20, 12);
    expect(area(doc.resolvePiece(p.id).cut)).toBeCloseTo((200 + 40) * (90 + 30), 6);
    expect(pc.description).toBe('SCALE X+100.000% Y+50.000%');
    const n = pc.notches[0];
    if (n.placement.kind !== 'fromPrev') throw new Error();
    expect(n.placement.dist[M]).toBeCloseTo(50, 9);
  });

  it('rotated grain: scales across/along grain', () => {
    const { doc } = setup();
    const p = add(doc, rectangleContour(0, 0, 100, 60));
    doc.transact('g', () => { const pc = doc.piece(p.id); pc.grain.a = { x: 0, y: 0 }; pc.grain.b = { x: 100, y: 0 }; }); // grain along world X
    scalePiece(doc, p.id, { xPct: 0, yPct: 20 }); // +20% along grain = world X
    const b = sewBox(doc, p.id);
    expect(boxW(b)).toBeCloseTo(120, 9);
    expect(boxH(b)).toBeCloseTo(60, 9);
  });
});
