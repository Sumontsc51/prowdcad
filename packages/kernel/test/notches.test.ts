import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import type { Piece } from '../src/model/types';
import {
  addNotch, resolveNotch, addCornerNotch, crossNotch, addPointsForNotches, globalNotchGrading,
  setNotchDistance, fillAllNotchDistances, extrapolateNotchIncrement, pasteNotchGrid, notchDistanceGrid,
  notchesOnSegment, addNotchAtPoint, notchArcLength,
} from '../src/ops/notches';

function setup(sizes = ['S', 'M', 'L'], base = 'M') {
  const doc = new Document(makeStyle('t', sizes, base));
  const line = doc.sizeLine();
  const ids = line.sizes.map(s => s.id);
  const c = rectangleContour(0, 0, 200, 100); // CCW, bottom edge = segment 0
  // right edge grades +10 x per size step
  for (const i of [1, 2]) { c.points[i].grade = {}; for (const id of ids) c.points[i].grade[id] = { dx: 10, dy: 0 }; }
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, piece: doc.piece(piece.id) as Piece, ids, line };
}

describe('notch resolution', () => {
  it('slit notch: sew position, outward normal, cut-line mark of depth', () => {
    const { doc, piece } = setup();
    const n = addNotch(doc, piece, { placement: { kind: 'proportional', anchorId: piece.sew.points[0].id, pct: 30 } });
    const r = resolveNotch(doc, piece, n);
    expect(r.pos.x).toBeCloseTo(60, 9); expect(r.pos.y).toBeCloseTo(0, 9);
    expect(r.normal.x).toBeCloseTo(0, 9); expect(r.normal.y).toBeCloseTo(-1, 9);
    expect(r.tangent.x).toBeCloseTo(1, 9);
    expect(r.s).toBeCloseTo(60, 9); expect(r.segmentIndex).toBe(0);
    expect(r.cutGeometry).toHaveLength(1);
    const [a, b] = r.cutGeometry[0];
    expect(a.x).toBeCloseTo(60, 9); expect(a.y).toBeCloseTo(-10, 9); // on cut line (seam 10)
    expect(b.x).toBeCloseTo(60, 9); expect(b.y).toBeCloseTo(-5, 9);  // depth 5 inward
    expect(r.mode).toBe('cut'); expect(r.depth).toBe(5);
  });

  it('D5: proportional notch at 30% stays at 30% after the segment is lengthened by 50 mm', () => {
    const { doc, piece } = setup();
    const n = addNotch(doc, piece, { placement: { kind: 'proportional', anchorId: piece.sew.points[0].id, pct: 30 } });
    doc.transact('lengthen', () => { doc.piece(piece.id).sew.points[1].x += 50; });
    const r = resolveNotch(doc, doc.piece(piece.id), n);
    expect(Math.abs(r.pos.x - 0.30 * 250)).toBeLessThanOrEqual(0.01);
    expect(r.pos.x).toBeCloseTo(75, 9);
    expect(r.pos.y).toBeCloseTo(0, 9);
  });

  it('fromPrev / fromNext per-size distances and anchored notches follow grading', () => {
    const { doc, piece, ids } = setup();
    const [S, M, L] = ids;
    const fp = addNotch(doc, piece, { placement: { kind: 'fromPrev', anchorId: piece.sew.points[0].id, dist: { [S]: 50, [M]: 60, [L]: 70 } } });
    const fn = addNotch(doc, piece, { placement: { kind: 'fromNext', anchorId: piece.sew.points[1].id, dist: { [M]: 20 } } });
    const an = addNotch(doc, piece, { placement: { kind: 'anchor', anchorId: piece.sew.points[2].id } });
    expect(resolveNotch(doc, piece, fp, S).pos.x).toBeCloseTo(50, 9);
    expect(resolveNotch(doc, piece, fp, L).pos.x).toBeCloseTo(70, 9);
    expect(resolveNotch(doc, piece, fn, L).pos.x).toBeCloseTo(190, 9); // corner at 210, 20 back (base value fallback)
    expect(resolveNotch(doc, piece, fn, S).pos.x).toBeCloseTo(170, 9);
    const ra = resolveNotch(doc, piece, an, L);
    expect(ra.pos.x).toBeCloseTo(210, 9); expect(ra.pos.y).toBeCloseTo(100, 9);
    // at a corner the normal is the bisector
    expect(ra.normal.x).toBeCloseTo(Math.SQRT1_2, 9); expect(ra.normal.y).toBeCloseTo(Math.SQRT1_2, 9);
    // fromNext wrapping backwards across the start point
    const w = addNotch(doc, piece, { placement: { kind: 'fromNext', anchorId: piece.sew.points[0].id, dist: { [M]: 30 } } });
    const rw = resolveNotch(doc, piece, w);
    expect(rw.pos.x).toBeCloseTo(0, 9); expect(rw.pos.y).toBeCloseTo(30, 9); expect(rw.segmentIndex).toBe(3);
  });

  it('angle, T / V / U / castle shapes', () => {
    const { doc, piece } = setup();
    const a0 = piece.sew.points[0].id;
    const t = resolveNotch(doc, piece, addNotch(doc, piece, { type: 'T', placement: { kind: 'fromPrev', anchorId: a0, dist: { } }, width: 4 }));
    // dist {} → 0 → at the corner; use a mid-edge one instead
    const T = resolveNotch(doc, piece, addNotch(doc, piece, { type: 'T', width: 4, placement: { kind: 'proportional', anchorId: a0, pct: 50 } }));
    expect(T.cutGeometry).toHaveLength(2);
    const bar = T.cutGeometry[1];
    expect(bar[0].y).toBeCloseTo(-5, 9); expect(Math.abs(bar[0].x - bar[1].x)).toBeCloseTo(4, 9);
    const V = resolveNotch(doc, piece, addNotch(doc, piece, { type: 'V', width: 3, placement: { kind: 'proportional', anchorId: a0, pct: 50 } }));
    expect(V.cutGeometry[0]).toHaveLength(3);
    expect(Math.abs(V.cutGeometry[0][0].x - V.cutGeometry[0][2].x)).toBeCloseTo(3, 9);
    expect(V.cutGeometry[0][1].y).toBeCloseTo(-5, 9); expect(V.cutGeometry[0][1].x).toBeCloseTo(100, 9);
    const C = resolveNotch(doc, piece, addNotch(doc, piece, { type: 'castle', width: 3, placement: { kind: 'proportional', anchorId: a0, pct: 50 } }));
    expect(C.cutGeometry[0]).toHaveLength(4);
    const U = resolveNotch(doc, piece, addNotch(doc, piece, { type: 'U', width: 3, placement: { kind: 'proportional', anchorId: a0, pct: 50 } }));
    const ys = U.cutGeometry[0].map(p => p.y);
    expect(Math.max(...ys)).toBeCloseTo(-5, 9); // deepest point at depth
    // angled 45°
    const A = resolveNotch(doc, piece, addNotch(doc, piece, { angleDeg: 45, placement: { kind: 'proportional', anchorId: a0, pct: 50 } }));
    expect(A.direction.x).toBeCloseTo(Math.SQRT1_2, 9); expect(A.direction.y).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(A.mouth.y).toBeCloseTo(-10, 9); expect(A.mouth.x).toBeCloseTo(110, 9);
    expect(t.pos.x).toBeCloseTo(0, 9);
  });

  it('corner notches along previous / next segment direction', () => {
    const { doc, piece } = setup();
    const id1 = piece.sew.points[1].id; // corner (200,0): prev = bottom edge (+x), next = right edge (+y)
    const prev = resolveNotch(doc, piece, addCornerNotch(doc, piece, id1, 'prev'));
    expect(prev.direction.x).toBeCloseTo(1, 9); expect(prev.direction.y).toBeCloseTo(0, 9);
    expect(prev.mouth.x).toBeCloseTo(210, 9); expect(prev.mouth.y).toBeCloseTo(0, 9);
    expect(prev.cutGeometry[0][1].x).toBeCloseTo(205, 9);
    const next = resolveNotch(doc, piece, addCornerNotch(doc, piece, id1, 'next'));
    expect(next.direction.x).toBeCloseTo(0, 9); expect(next.direction.y).toBeCloseTo(-1, 9);
    expect(next.mouth.x).toBeCloseTo(200, 9); expect(next.mouth.y).toBeCloseTo(-10, 9);
  });

  it('Notch Setup supplies defaults (depth/width/mode)', () => {
    const { doc, piece } = setup();
    doc.transact('setup', s => { s.settings.notchSetup.V = { depth: 7, width: 4, mode: 'draw' }; });
    const n = addNotch(doc, piece, { type: 'V', placement: { kind: 'proportional', anchorId: piece.sew.points[0].id, pct: 10 } });
    expect(n.depth).toBe(7); expect(n.width).toBe(4);
    expect(resolveNotch(doc, piece, n).mode).toBe('draw');
  });
});

describe('cross notches', () => {
  it('throws from internal line end along / perpendicular to the perimeter, graded per size', () => {
    const { doc, piece, ids } = setup();
    const [S, M, L] = ids;
    const internal = makeContour([gradePoint(50, 50), gradePoint(150, 50, { grade: { [M]: { dx: 5, dy: 0 }, [L]: { dx: 5, dy: 0 } } })], { type: 'internal', closed: false });
    doc.transact('int', () => { doc.piece(piece.id).internals.push(internal); });
    const p = doc.piece(piece.id);
    const along = crossNotch(doc, p, { internalContourId: internal.id, end: 'end', direction: 'along' })!;
    expect(resolveNotch(doc, p, along).pos.x).toBeCloseTo(200, 9);
    expect(resolveNotch(doc, p, along).pos.y).toBeCloseTo(50, 9);
    expect(resolveNotch(doc, p, along, L).pos.x).toBeCloseTo(210, 9);
    expect(along.source).toBe('cross');
    const perp = crossNotch(doc, p, { internalContourId: internal.id, end: 'end', direction: 'perp' })!;
    // nearest side: both 50 mm → left (+y) chosen → top edge at x=150 (base), 155 in L, 145 in S
    const rp = resolveNotch(doc, p, perp);
    expect(rp.pos.x).toBeCloseTo(150, 9); expect(rp.pos.y).toBeCloseTo(100, 9);
    expect(resolveNotch(doc, p, perp, L).pos.x).toBeCloseTo(155, 9);
    expect(resolveNotch(doc, p, perp, S).pos.x).toBeCloseTo(145, 9);
    const right = crossNotch(doc, p, { internalContourId: internal.id, end: 'start', direction: 'perpRight' })!;
    // start (50,50), direction start→out = −x, right of −x is +y → top edge at x=50
    expect(resolveNotch(doc, p, right).pos.x).toBeCloseTo(50, 9);
    expect(resolveNotch(doc, p, right).pos.y).toBeCloseTo(100, 9);
  });
});

describe('add points for notches', () => {
  it('converts floating → anchored, inserting a graded anchor that stays put in every size', () => {
    const { doc, piece, ids } = setup();
    const [S, M, L] = ids;
    const n = addNotch(doc, piece, { placement: { kind: 'fromPrev', anchorId: piece.sew.points[0].id, dist: { [S]: 50, [M]: 60, [L]: 75 } } });
    const before = ids.map(id => resolveNotch(doc, piece, n, id).pos);
    const created = addPointsForNotches(doc, piece);
    const p = doc.piece(piece.id);
    expect(created).toHaveLength(1);
    expect(p.sew.points).toHaveLength(5);
    const nn = p.notches[0];
    expect(nn.placement).toEqual({ kind: 'anchor', anchorId: created[0] });
    const a = p.sew.points[1];
    expect(a.id).toBe(created[0]); expect(a.kind).toBe('grade'); expect(a.flags.notchAnchor).toBe(true);
    expect(a.x).toBeCloseTo(60, 9); expect(a.y).toBeCloseTo(0, 9);
    ids.forEach((id, k) => {
      const r = resolveNotch(doc, p, nn, id).pos;
      expect(r.x).toBeCloseTo(before[k].x, 9); expect(r.y).toBeCloseTo(before[k].y, 9);
    });
    // the rest of the contour is unchanged
    expect(doc.resolvePiece(p.id, L).sew.anchorPos[2].x).toBeCloseTo(210, 9);
  });

  it('splits a curved span without changing base geometry', () => {
    const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), curvePoint(120, 50), gradePoint(100, 100), gradePoint(0, 100)]);
    const piece = makePiece('P', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    const n = addNotch(doc, piece, { placement: { kind: 'proportional', anchorId: c.points[1].id, pct: 25 } });
    const before = resolveNotch(doc, piece, n).pos;
    const L0 = doc.resolvePiece(piece.id).sew.cum.at(-1)!;
    addPointsForNotches(doc, piece);
    const p = doc.piece(piece.id);
    const after = resolveNotch(doc, p, p.notches[0]).pos;
    // new anchor sits on the exact Bézier; the old floating notch sat on the sampled chord (≤0.01 mm apart)
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.01);
    expect(p.sew.points).toHaveLength(6);
    expect(p.sew.points[2].kind).toBe('grade');
    expect(doc.resolvePiece(p.id).sew.cum.at(-1)!).toBeCloseTo(L0, 1);
  });
});

describe('global notch grading', () => {
  it('converts between placement kinds preserving base position', () => {
    const { doc, piece, ids } = setup();
    const [S, M, L] = ids;
    const n = addNotch(doc, piece, { placement: { kind: 'fromPrev', anchorId: piece.sew.points[0].id, dist: { [S]: 60, [M]: 60, [L]: 60 } } });
    expect(globalNotchGrading(doc, piece, 'proportional')).toBe(1);
    let p = doc.piece(piece.id);
    expect(p.notches[0].placement.kind).toBe('proportional');
    expect((p.notches[0].placement as any).pct).toBeCloseTo(30, 9);
    expect(resolveNotch(doc, p, p.notches[0], M).pos.x).toBeCloseTo(60, 9);
    expect(resolveNotch(doc, p, p.notches[0], L).pos.x).toBeCloseTo(63, 9); // 30% of 210
    globalNotchGrading(doc, p, 'fromNext');
    p = doc.piece(piece.id);
    const pl = p.notches[0].placement as any;
    expect(pl.kind).toBe('fromNext'); expect(pl.anchorId).toBe(p.sew.points[1].id);
    expect(pl.dist[S]).toBeCloseTo(140, 9); expect(pl.dist[L]).toBeCloseTo(140, 9);
    expect(resolveNotch(doc, p, p.notches[0], L).pos.x).toBeCloseTo(70, 9);
    globalNotchGrading(doc, p, 'fromPrev', { perSize: 'preserve' });
    p = doc.piece(piece.id);
    const pl2 = p.notches[0].placement as any;
    expect(pl2.dist[M]).toBeCloseTo(60, 9); expect(pl2.dist[L]).toBeCloseTo(70, 9); expect(pl2.dist[S]).toBeCloseTo(50, 9);
    expect(n.id).toBe(p.notches[0].id);
  });
});

describe('distance grid editing', () => {
  it('set / fill / extrapolate / paste', () => {
    const { doc, piece, ids } = setup(['XS', 'S', 'M', 'L', 'XL'], 'M');
    const [XS, S, M, L, XL] = ids;
    const n = addNotch(doc, piece, { placement: { kind: 'fromPrev', anchorId: piece.sew.points[0].id, dist: { [M]: 60 } } });
    fillAllNotchDistances(doc, piece, n.id, 40);
    expect(notchDistanceGrid(doc, piece, n.id).map(r => r.value)).toEqual([40, 40, 40, 40, 40]);
    setNotchDistance(doc, piece, n.id, M, 60);
    setNotchDistance(doc, piece, n.id, L, 63.5);
    extrapolateNotchIncrement(doc, piece, n.id, M, L);
    const g = notchDistanceGrid(doc, piece, n.id).map(r => r.value);
    expect(g[0]).toBeCloseTo(53, 9); expect(g[1]).toBeCloseTo(56.5, 9); expect(g[2]).toBeCloseTo(60, 9); expect(g[3]).toBeCloseTo(63.5, 9); expect(g[4]).toBeCloseTo(67, 9);
    expect(pasteNotchGrid(doc, piece, n.id, '10\t20\t30\t40\t50\r\n')).toBe(5);
    expect(notchDistanceGrid(doc, piece, n.id).map(r => r.value)).toEqual([10, 20, 30, 40, 50]);
    expect(pasteNotchGrid(doc, piece, n.id, 'L\tXS\n99\t1 1/2')).toBe(2);
    const p = doc.piece(piece.id);
    expect((p.notches[0].placement as any).dist[L]).toBe(99);
    expect((p.notches[0].placement as any).dist[XS]).toBe(1.5);
    expect(pasteNotchGrid(doc, piece, n.id, '1\n2\n3\n4\n5')).toBe(5); // single column
    expect(notchDistanceGrid(doc, piece, n.id).map(r => r.value)).toEqual([1, 2, 3, 4, 5]);
    expect(resolveNotch(doc, doc.piece(piece.id), doc.piece(piece.id).notches[0], XL).pos.x).toBeCloseTo(5, 9);
    expect(S).toBeTruthy();
  });
});

describe('notchesOnSegment', () => {
  it('lists notches with running distances, per size', () => {
    const { doc, piece, ids } = setup();
    const [, , L] = ids;
    const P = piece.sew.points;
    addNotch(doc, piece, { placement: { kind: 'proportional', anchorId: P[0].id, pct: 50 } });
    addNotch(doc, piece, { placement: { kind: 'anchor', anchorId: P[1].id } });
    addNotch(doc, piece, { placement: { kind: 'proportional', anchorId: P[1].id, pct: 50 } });
    addNotchAtPoint(doc, piece, { x: 0, y: 40 }, 'fromNext');
    const seg = notchesOnSegment(doc, piece, piece.sew.id, P[0].id, P[2].id);
    expect(seg.map(x => x.dist)).toEqual([100, 200, 250]);
    const segL = notchesOnSegment(doc, piece, piece.sew.id, P[0].id, P[2].id, L);
    expect(segL.map(x => x.dist)).toEqual([105, 210, 260]);
    // wrapping span P3 → P1 crosses the start point
    const wrap = notchesOnSegment(doc, piece, piece.sew.id, P[3].id, P[1].id);
    expect(wrap.map(x => Math.round(x.dist * 1e6) / 1e6)).toEqual([60, 200, 300]);
    const full = notchesOnSegment(doc, piece, piece.sew.id, P[0].id, P[0].id);
    expect(full).toHaveLength(4);
    expect(notchArcLength(doc, piece, full[3].notch, ids[1])).toBeCloseTo(560, 9);
  });
});
