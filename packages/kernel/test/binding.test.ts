import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area } from '../src/geom/poly';
import { generateBinding } from '../src/ops/binding';
import { addNotch, resolveNotch } from '../src/ops/notches';

function setup() {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const ids = doc.sizeLine().sizes.map(s => s.id);
  const mk = (name: string, w: number, h: number, gx: number) => {
    const c = rectangleContour(0, 0, w, h);
    for (const i of [1, 2]) for (const id of ids) c.points[i].grade[id] = { dx: gx, dy: 0 };
    const p = makePiece(name, c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(p));
    return doc.piece(p.id);
  };
  // FRONT neck: bottom edge 200 (+10/step); BACK neck: bottom edge 150 (+5/step)
  const front = mk('FRONT', 200, 100, 10), back = mk('BACK', 150, 80, 5);
  return { doc, ids, front, back };
}

describe('binding generator', () => {
  it('builds a 45° strip of chained length, graded per size, with copied and break notches', () => {
    const { doc, ids, front, back } = setup();
    const [S, M, L] = ids;
    const F = front.sew.points, B = back.sew.points;
    addNotch(doc, front, { placement: { kind: 'proportional', anchorId: F[0].id, pct: 50 } });
    addNotch(doc, back, { placement: { kind: 'fromPrev', anchorId: B[0].id, dist: { [S]: 30, [M]: 30, [L]: 30 } } });
    const res = generateBinding(doc, {
      chain: [
        { pieceId: front.id, contourId: front.sew.id, fromAnchorId: F[0].id, toAnchorId: F[1].id },
        { pieceId: back.id, contourId: back.sew.id, fromAnchorId: B[0].id, toAnchorId: B[1].id },
      ],
      width: 30, name: 'NECK BIND',
    });
    expect(res.chainLengthBySize[M]).toBeCloseTo(350, 9);
    expect(res.chainLengthBySize[L]).toBeCloseTo(365, 9);
    expect(res.chainLengthBySize[S]).toBeCloseTo(335, 9);
    expect(res.breaks).toEqual([200]);
    const p = res.piece;
    expect(p.name).toBe('NECK BIND'); expect(p.noSeam).toBe(true);
    const rM = doc.resolvePiece(p.id, M), rL = doc.resolvePiece(p.id, L);
    expect(rM.sew.anchorPos.map(q => [q.x, q.y].map(v => +v.toFixed(9)))).toEqual([[0, 0], [350, 0], [380, 30], [30, 30]]);
    expect(rL.sew.anchorPos[1].x).toBeCloseTo(365, 9); expect(rL.sew.anchorPos[2].x).toBeCloseTo(395, 9);
    expect(area(rM.cut)).toBeCloseTo(350 * 30, 6); // parallelogram
    // end-cut angle 45°
    const e = rM.sew.anchorPos; expect(Math.atan2(e[2].y - e[1].y, e[2].x - e[1].x) * 180 / Math.PI).toBeCloseTo(45, 9);
    // notches: front 50% (100 / 105 in L), back 30 → 230 / 240 in L, break at 200 / 210
    const xs = (sid: string) => p.notches.map(n => resolveNotch(doc, p, n, sid).pos.x).sort((a, b) => a - b);
    expect(xs(M).map(v => +v.toFixed(9))).toEqual([100, 200, 230]);
    expect(xs(L).map(v => +v.toFixed(9))).toEqual([105, 210, 240]);
    expect(p.notches.filter(n => n.tag === 'binding-break')).toHaveLength(1);
    expect(p.notches.filter(n => n.tag === 'binding-copy')).toHaveLength(2);
    // notches point into the strip from the bottom edge
    expect(resolveNotch(doc, p, p.notches[0]).normal.y).toBeCloseTo(-1, 9);
  });

  it('half-fold doubles width with a fold line; shrink & scale; square ends at 90°', () => {
    const { doc, ids, front } = setup();
    const [, M, L] = ids;
    const F = front.sew.points;
    addNotch(doc, front, { placement: { kind: 'proportional', anchorId: F[0].id, pct: 25 } });
    const res = generateBinding(doc, {
      chain: [{ pieceId: front.id, contourId: front.sew.id, fromAnchorId: F[0].id, toAnchorId: F[1].id }],
      width: 20, halfFold: true, biasAngleDeg: 90, shrinkPct: 2, scalePct: 95, supportNotchAtBreaks: true,
    });
    const f = 1.02 * 0.95;
    expect(res.lengthBySize[M]).toBeCloseTo(200 * f, 9);
    expect(res.lengthBySize[L]).toBeCloseTo(210 * f, 9);
    expect(res.stripWidth).toBeCloseTo(40 * 1.02, 9);
    const p = res.piece;
    const rM = doc.resolvePiece(p.id, M);
    expect(rM.sew.anchorPos[2].x).toBeCloseTo(200 * f, 9); // square end
    expect(rM.sew.anchorPos[2].y).toBeCloseTo(40.8, 9);
    const fold = p.internals.find(c => c.type === 'fold')!;
    expect(fold).toBeTruthy();
    expect(doc.resolvePiece(p.id, L).internals[0].anchorPos[1].x).toBeCloseTo(210 * f, 9);
    expect(doc.resolvePiece(p.id, L).internals[0].anchorPos[1].y).toBeCloseTo(20.4, 9);
    // notch copied to both raw edges at 25% × scale; no break notch (single span)
    expect(p.notches).toHaveLength(2);
    const pos = p.notches.map(n => resolveNotch(doc, p, n, L).pos);
    expect(pos[0].x).toBeCloseTo(52.5 * f, 9); expect(pos[0].y).toBeCloseTo(0, 9);
    expect(pos[1].x).toBeCloseTo(52.5 * f, 9); expect(pos[1].y).toBeCloseTo(40.8, 9);
  });

  it('45° half-fold: mirrored notch sits at the same x on the opposite raw edge', () => {
    const { doc, ids, front } = setup();
    const [, M, L] = ids;
    const F = front.sew.points;
    addNotch(doc, front, { placement: { kind: 'proportional', anchorId: F[0].id, pct: 50 } });
    const res = generateBinding(doc, {
      chain: [{ pieceId: front.id, contourId: front.sew.id, fromAnchorId: F[0].id, toAnchorId: F[1].id }],
      width: 15, halfFold: true,
    });
    const p = res.piece;
    expect(res.stripWidth).toBe(30);
    const posM = p.notches.map(n => resolveNotch(doc, p, n, M).pos);
    expect(posM[0].x).toBeCloseTo(100, 9); expect(posM[0].y).toBeCloseTo(0, 9);
    expect(posM[1].x).toBeCloseTo(100, 9); expect(posM[1].y).toBeCloseTo(30, 9);
    const posL = p.notches.map(n => resolveNotch(doc, p, n, L).pos);
    expect(posL[1].x).toBeCloseTo(105, 9);
    expect(resolveNotch(doc, p, p.notches[1], M).normal.y).toBeCloseTo(1, 9);
  });

  it('copyNotches:false and supportNotchAtBreaks:false produce a bare strip', () => {
    const { doc, front, back } = setup();
    addNotch(doc, front, { placement: { kind: 'proportional', anchorId: front.sew.points[0].id, pct: 50 } });
    const res = generateBinding(doc, {
      chain: [
        { pieceId: front.id, contourId: front.sew.id, fromAnchorId: front.sew.points[0].id, toAnchorId: front.sew.points[1].id },
        { pieceId: back.id, contourId: back.sew.id, fromAnchorId: back.sew.points[1].id, toAnchorId: back.sew.points[2].id },
      ],
      width: 25, copyNotches: false, supportNotchAtBreaks: false,
    });
    expect(res.piece.notches).toHaveLength(0);
    expect(res.chainLengthBySize[doc.sizeLine().baseSizeId]).toBeCloseTo(280, 9);
    expect(doc.style.pieces).toHaveLength(3);
    expect(doc.undo()).toBe(true);
    expect(doc.style.pieces).toHaveLength(2);
  });
});
