import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, gradePoint, curvePoint, makeContour, rectangleContour } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour } from '../src/model/contour';
import { area, signedArea } from '../src/geom/poly';
import { bbox, sub, dot, perp, norm, type Vec } from '../src/geom/vec';
import {
  computeCutLine, cutLineForSize, setSeam, setSeamWholePiece, setGlobalSeam, deleteSeamSegment, removeSeamPiece, removeSeamAll,
  setCorner, setCornerManual, revertCorner, trimCorner, setLockGrading, updateSeamGrading, reseamPiece, reseamAll, reseamSegment,
  repairSeam, seamToInternal, internalToSeam, setCutModeAuto, cornerPointsForSize, segmentSeams,
} from '../src/ops/seam';

/** proper crossings between non-adjacent edges of a closed polygon */
function selfCrossings(P: Vec[]): number {
  let c = 0; const n = P.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const a = P[i], b = P[(i + 1) % n], p = P[j], q = P[(j + 1) % n];
    const d1 = cross2(sub(b, a), sub(p, a)), d2 = cross2(sub(b, a), sub(q, a)), d3 = cross2(sub(q, p), sub(a, p)), d4 = cross2(sub(q, p), sub(b, p));
    if (d1 * d2 < -1e-12 && d3 * d4 < -1e-12) c++;
  }
  return c;
}
const cross2 = (u: Vec, w: Vec) => u.x * w.y - u.y * w.x;
const segDist = (q: Vec, a: Vec, b: Vec) => { const ab = sub(b, a); if (dot(ab, ab) < 1e-24) return Math.hypot(q.x - a.x, q.y - a.y); const tt = Math.max(0, Math.min(1, dot(sub(q, a), ab) / dot(ab, ab))); return Math.hypot(q.x - a.x - ab.x * tt, q.y - a.y - ab.y * tt); };
/** boundary-to-boundary distance between two non-crossing closed polygons */
const polyDist = (P: Vec[], S: Vec[]) => Math.min(
  ...P.map(q => Math.min(...S.map((a, i) => segDist(q, a, S[(i + 1) % S.length])))),
  ...S.map(q => Math.min(...P.map((a, i) => segDist(q, a, P[(i + 1) % P.length])))));

const close = (a: Vec[], b: Vec[], d = 9) => { expect(a.length).toBe(b.length); a.forEach((p, i) => { expect(p.x).toBeCloseTo(b[i].x, d); expect(p.y).toBeCloseTo(b[i].y, d); }); };

function setup(sizes = ['S', 'M', 'L'], contour = rectangleContour(0, 0, 100, 100)) {
  const doc = new Document(makeStyle('t', sizes, 'M'));
  const line = doc.sizeLine();
  const piece = makePiece('P', contour, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  const ids = piece.sew.points.map(a => a.id);
  return { doc, line, piece: () => doc.piece(piece.id), pid: piece.id, ids, S: line.sizes.map(s => s.id) };
}
const reversedSquare = () => { const c = rectangleContour(0, 0, 100, 100); c.points.reverse(); return c; };

describe('D1 — true offset through computeCutLine on a real Piece', () => {
  for (const [name, mk] of [['CCW', () => rectangleContour(0, 0, 100, 100)], ['CW', reversedSquare]] as const) {
    it(`100 mm square +10 → exactly 120×120 (${name})`, () => {
      const t = setup(['S', 'M', 'L'], mk());
      const cut = computeCutLine(t.piece(), t.line, t.line.baseSizeId);
      expect(cut.length).toBe(4);
      const b = bbox(cut);
      expect(b.minX).toBeCloseTo(-10, 12); expect(b.maxX).toBeCloseTo(110, 12);
      expect(b.minY).toBeCloseTo(-10, 12); expect(b.maxY).toBeCloseTo(110, 12);
      expect(area(cut)).toBeCloseTo(14400, 9);
      const sew = resolveContour(t.piece().sew, t.line, t.line.baseSizeId).pts;
      expect(Math.sign(signedArea(cut))).toBe(Math.sign(signedArea(sew)));
      expect(t.doc.resolvePiece(t.pid).cut).toEqual(cut);
    });
  }
  it('negative seam = inward: −10 → 80×80', () => {
    const t = setup(); setSeamWholePiece(t.doc, t.pid, -10);
    expect(area(computeCutLine(t.piece(), t.line, t.line.baseSizeId))).toBeCloseTo(6400, 9);
  });
});

describe('per-segment seams', () => {
  it('setSeam from→to sets the segments in contour order; whole piece; global; delete', () => {
    const t = setup();
    const [a, b, c, d] = t.ids; // bottom a→b, right b→c, top c→d, left d→a
    setSeam(t.doc, t.pid, b, d, 20); // right + top
    expect(t.piece().sew.points.map(p => p.seamAfter)).toEqual([undefined, 20, 20, undefined]);
    let cut = computeCutLine(t.piece(), t.line, t.line.baseSizeId);
    expect(bbox(cut)).toEqual({ minX: -10, minY: -10, maxX: 120, maxY: 120 });
    setSeam(t.doc, t.pid, d, b, 5); // wraps: left + bottom
    expect(segmentSeams(t.piece(), resolveContour(t.piece().sew, t.line, t.line.baseSizeId))).toEqual([5, 20, 20, 5]);
    expect(area(computeCutLine(t.piece(), t.line, t.line.baseSizeId))).toBeCloseTo(125 * 125, 9);
    deleteSeamSegment(t.doc, t.pid, a, b);
    cut = computeCutLine(t.piece(), t.line, t.line.baseSizeId);
    expect(bbox(cut).minY).toBeCloseTo(0, 12);
    expect(area(cut)).toBeCloseTo(125 * 120, 9);
    setSeamWholePiece(t.doc, t.pid, 15);
    expect(t.piece().sew.points.every(p => p.seamAfter === undefined)).toBe(true);
    expect(area(computeCutLine(t.piece(), t.line, t.line.baseSizeId))).toBeCloseTo(130 * 130, 9);
    // undo of the whole-piece seam restores the segment values
    t.doc.undo();
    expect(t.piece().sew.points.map(p => p.seamAfter)).toEqual([0, 20, 20, 5]);
    expect(() => setSeam(t.doc, t.pid, a, b, NaN)).toThrow();
  });
  it('global seam, remove seam per piece / all', () => {
    const t = setup();
    const p2 = makePiece('Q', rectangleContour(200, 0, 50, 50), t.doc.style.activeSizeTableId);
    t.doc.transact('add', s => s.pieces.push(p2));
    setGlobalSeam(t.doc, 12);
    expect(area(t.doc.resolvePiece(p2.id).cut)).toBeCloseTo(74 * 74, 9);
    expect(area(t.doc.resolvePiece(t.pid).cut)).toBeCloseTo(124 * 124, 9);
    removeSeamPiece(t.doc, p2.id);
    expect(area(t.doc.resolvePiece(p2.id).cut)).toBeCloseTo(2500, 9);
    removeSeamAll(t.doc);
    expect(area(t.doc.resolvePiece(t.pid).cut)).toBeCloseTo(10000, 9);
    setSeamWholePiece(t.doc, t.pid, 10);
    expect(t.piece().noSeam).toBe(false);
  });
  it('curved segment offsets as a true geometric offset (circle-ish arc stays at the allowance)', () => {
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), curvePoint(130, 50), gradePoint(100, 100), gradePoint(0, 100)]);
    const t = setup(['S', 'M', 'L'], c);
    const sew = resolveContour(t.piece().sew, t.line, t.line.baseSizeId).pts;
    const cut = computeCutLine(t.piece(), t.line, t.line.baseSizeId);
    // every cut vertex is ≥ 10 mm from the sew polygon (miter corners further)
    const dmin = Math.min(...cut.map(q => Math.min(...sew.map((_, i) => { const a = sew[i], b = sew[(i + 1) % sew.length]; const ab = sub(b, a); const tt = Math.max(0, Math.min(1, dot(sub(q, a), ab) / dot(ab, ab))); return Math.hypot(q.x - a.x - ab.x * tt, q.y - a.y - ab.y * tt); }))));
    expect(dmin).toBeCloseTo(10, 6);
    expect(bbox(cut).maxX).toBeGreaterThan(130);
  });
});

/** Trapezoid with an acute-ish corner at b=(100,0): right edge leans to (80,100). */
const trap = () => makeContour([gradePoint(0, 0), gradePoint(100, 0), gradePoint(80, 100), gradePoint(0, 100)]);
const K = Math.sqrt(26); // |(20,100)| / 20

describe('engineered corners', () => {
  it('miter (default) = intersection of the two offset edges', () => {
    const t = setup(['S', 'M', 'L'], trap());
    const r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
    // right edge line offset 10: x = 100 − y/5 + 10·√26/5
    const xm = 100 + 2 + 2 * K;
    close(r.pts, [{ x: -10, y: -10 }, { x: xm, y: -10 }, { x: xm - 24, y: 110 }, { x: -10, y: 110 }]);
    expect(r.cornerIndex).toEqual([0, 1, 2, 3]);
  });
  it('boxed prev / next / both, angled', () => {
    const t = setup(['S', 'M', 'L'], trap());
    const b = t.ids[1];
    const B = { x: 100 + 10 * 100 / (20 * K), y: 10 * 20 / (20 * K) }; // outgoing perpendicular foot
    const A = { x: 100, y: -10 };
    setCorner(t.doc, t.pid, b, { type: 'boxed', extend: 'prev' });
    let r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
    close(r.pts.slice(1, 4), [A, { x: B.x, y: -10 }, B]);
    expect(r.cornerSpan[1]).toEqual([1, 3]);
    expect(r.cornerIndex).toEqual([0, 1, 4, 5]);
    // square: segment (B.x,-10)→B is perpendicular to the incoming edge
    expect(r.pts[2].x).toBeCloseTo(r.pts[3].x, 12);
    setCorner(t.doc, t.pid, b, { type: 'boxed', extend: 'next' });
    r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
    const tOut = norm({ x: -20, y: 100 });
    expect(dot(sub(r.pts[2], r.pts[1]), tOut)).toBeCloseTo(0, 12); // square to the outgoing seam
    expect(Math.abs(dot(sub(r.pts[3], r.pts[2]), perp(tOut)))).toBeCloseTo(0, 12); // on the outgoing cut line
    setCorner(t.doc, t.pid, b, { type: 'boxed', extend: 'both' });
    r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
    // obtuse (101.3°) corner: union of the two squared strips — incoming runs on to x=110 and squares
    // up; the outgoing strip runs back by 10 along its edge and squares off (B7)
    expect(r.pts.length).toBe(8);
    expect(r.cornerSpan[1]).toEqual([1, 5]);
    const tO = norm({ x: -20, y: 100 }), nO = { x: tO.y, y: -tO.x };
    const Q = { x: 100 - 10 * tO.x + 10 * nO.x, y: -10 * tO.y + 10 * nO.y };
    close(r.pts.slice(1, 6), [A, { x: 110, y: -10 }, { x: 110, y: Q.y + (110 - Q.x) * nO.y / nO.x }, Q, B]);
    expect(selfCrossings(r.pts)).toBe(0);
    setCorner(t.doc, t.pid, b, { type: 'angled' });
    r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
    close(r.pts.slice(1, 3), [A, B]);
    expect(r.pts.length).toBe(5);
    expect(area(r.pts)).toBeCloseTo(13150.813326774958, 6);
    revertCorner(t.doc, t.pid, b);
    expect(cutLineForSize(t.piece(), t.line, t.line.baseSizeId).pts.length).toBe(4);
  });
  it('turnback: mirrored side seam folds onto the adjacent cut line (40 mm hem)', () => {
    const t = setup(['S', 'M', 'L'], trap());
    const [a, b] = t.ids;
    setSeam(t.doc, t.pid, a, b, 40);
    setCorner(t.doc, t.pid, b, { type: 'turnback' });
    const r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
    const X = { x: 100 + 2 * K, y: 0 };       // side cut line hits the hem fold (sew) line
    const Y = { x: 100 + 2 * K - 8, y: -40 }; // mirror of the side cut line, down to the hem cut line
    close(r.pts.slice(1, 3), [Y, X]);
    // fold the hem up across y=0: Y lands on the side cut line x = 100 − y/5 + 2√26
    expect(Y.x).toBeCloseTo(100 - 40 / 5 + 2 * K, 12);
    expect(area(r.pts)).toBeCloseTo(16659.705854077838, 6);
  });
  it('manual corner (≤10 pts) and trimCorner (Manual Seam Angle) with revert', () => {
    const t = setup();
    const b = t.ids[1];
    expect(() => setCornerManual(t.doc, t.pid, b, Array.from({ length: 11 }, (_, i) => ({ x: 100 + i, y: -10 })))).toThrow();
    trimCorner(t.doc, t.pid, b, { x: 105, y: -9 }, { x: 111, y: 5 });
    expect(t.piece().sew.points[1].corner).toEqual({ type: 'manual', manualPoints: [{ x: 105, y: -10 }, { x: 110, y: 5 }] });
    const r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
    close(r.pts, [{ x: -10, y: -10 }, { x: 105, y: -10 }, { x: 110, y: 5 }, { x: 110, y: 110 }, { x: -10, y: 110 }]);
    expect(area(r.pts)).toBeCloseTo(14400 - 37.5, 9);
    expect(r.cornerIndex).toEqual([0, 1, 3, 4]);
    // clicks beyond the end of the offset still snap onto the extended seam line
    trimCorner(t.doc, t.pid, b, { x: 112, y: -4 }, { x: 104, y: -12 }); // click order is free
    expect(t.piece().sew.points[1].corner!.manualPoints).toEqual([{ x: 104, y: -10 }, { x: 110, y: -4 }]);
    expect(area(computeCutLine(t.piece(), t.line, t.line.baseSizeId))).toBeCloseTo(14400 - 18, 9);
    revertCorner(t.doc, t.pid, b);
    expect(area(computeCutLine(t.piece(), t.line, t.line.baseSizeId))).toBeCloseTo(14400, 9);
  });
});

describe('D2 — Lock Grading stamps the base engineered corner onto every size', () => {
  /** Trapezoid graded so that the corner b moves AND the outgoing edge changes angle per size. */
  function graded() {
    const t = setup(['S', 'M', 'L', 'XL']);
    const [S, M, L, XL] = t.S;
    const c = trap();
    const g = (dx: number, dy: number) => ({ [M]: { dx, dy }, [L]: { dx, dy }, [XL]: { dx, dy } });
    c.points[1].grade = g(10, 0);   // corner moves +10 x per size
    c.points[2].grade = g(0, 8);    // top-right moves up only → right edge angle changes
    const piece = makePiece('G', c, t.doc.style.activeSizeTableId);
    t.doc.transact('add', s => s.pieces.push(piece));
    void S;
    return { ...t, gid: piece.id, gp: () => t.doc.piece(piece.id), b: piece.sew.points[1].id };
  }
  const rel = (pts: Vec[], C: Vec) => pts.map(p => sub(p, C));

  for (const spec of [{ type: 'angled' }, { type: 'boxed', extend: 'both' }, { type: 'turnback', extend: 'prev' }, { type: 'manual', manualPoints: [{ x: 104, y: -10 }, { x: 112, y: 3 }] }] as const) {
    it(`${spec.type}: identical corner geometry relative to the sew corner on every size`, () => {
      const t = graded();
      setCorner(t.doc, t.gid, t.b, spec as any);
      setLockGrading(t.doc, t.gid, true);
      const base = cornerPointsForSize(t.gp(), t.line, t.line.baseSizeId)[1];
      for (const sid of t.S) {
        const c = cornerPointsForSize(t.gp(), t.line, sid)[1];
        close(rel(c.pts, c.sew), rel(base.pts, base.sew), 9);
        // the stamped corner is what the cut line actually contains
        const r = cutLineForSize(t.gp(), t.line, sid);
        const [i0, i1] = r.cornerSpan[1];
        close([r.pts[i0], r.pts[i1]], [c.pts[0], c.pts[c.pts.length - 1]], 9);
        // and the snapshot was materialised (autoReseam on)
        close(t.gp().sew.points[1].corner!.lockedPerSize![sid], c.pts, 9);
      }
    });
  }
  it('without Lock Grading the angled corner recomputes per size (differs on XL)', () => {
    const t = graded();
    setCorner(t.doc, t.gid, t.b, { type: 'angled' });
    const XL = t.S[3];
    const base = cornerPointsForSize(t.gp(), t.line, t.line.baseSizeId)[1];
    const xl = cornerPointsForSize(t.gp(), t.line, XL)[1];
    const d = sub(sub(xl.pts[1], xl.sew), sub(base.pts[1], base.sew));
    expect(Math.hypot(d.x, d.y)).toBeGreaterThan(0.1);
    expect(t.gp().sew.points[1].corner!.lockedPerSize).toBeUndefined();
    // the XL sew corner is at (120,0): incoming foot is still exactly 10 below
    close([xl.pts[0]], [{ x: 120, y: -10 }]);
  });
  it('lock off clears the snapshot; updateSeamGrading/reseam re-stamp it when autoReseam is off', () => {
    const t = graded();
    t.doc.transact('auto off', s => { s.settings.autoReseam = false; });
    setCorner(t.doc, t.gid, t.b, { type: 'angled' });
    t.doc.transact('lock', s => { s.pieces.find(p => p.id === t.gid)!.lockGrading = true; });
    expect(t.gp().sew.points[1].corner!.lockedPerSize).toBeUndefined();
    // cut line is still lazily correct (locked) without the snapshot
    const base = cornerPointsForSize(t.gp(), t.line, t.line.baseSizeId)[1];
    const XL = t.S[3];
    const r = cutLineForSize(t.gp(), t.line, XL);
    const C = resolveContour(t.gp().sew, t.line, XL).anchorPos[1];
    close([sub(r.pts[r.cornerSpan[1][1]], C)], [sub(base.pts[1], base.sew)], 9);
    updateSeamGrading(t.doc, t.gid);
    expect(Object.keys(t.gp().sew.points[1].corner!.lockedPerSize!).length).toBe(4);
    reseamSegment(t.doc, t.gid, t.b, 12);
    expect(t.gp().sew.points[1].seamAfter).toBe(12);
    expect(Object.keys(t.gp().sew.points[1].corner!.lockedPerSize!).length).toBe(4);
    setLockGrading(t.doc, t.gid, false);
    expect(t.gp().sew.points[1].corner!.lockedPerSize).toBeUndefined();
  });
});

describe('Repair Seam Parameters / reseam', () => {
  it('removes seamAfter on curve points, clamps NaN, drops invalid corners', () => {
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), curvePoint(120, 50), gradePoint(100, 100), gradePoint(0, 100)]);
    const t = setup(['S', 'M', 'L'], c);
    t.doc.transact('break', s => {
      const p = s.pieces[0];
      p.sew.points[2].seamAfter = 30; p.sew.points[2].corner = { type: 'angled' };
      p.sew.points[0].seamAfter = NaN;
      p.sew.points[1].corner = { type: 'manual', manualPoints: [] };
      p.sew.points[3].corner = { type: 'bogus' as any };
      p.sew.points[4].corner = { type: 'angled', lockedPerSize: { ghost: [{ x: 0, y: 0 }] } };
    });
    const rep = repairSeam(t.doc, t.pid);
    expect(rep).toEqual({ removedCurveSeams: 1, clampedValues: 1, droppedCorners: 3 });
    const pts = t.piece().sew.points;
    expect(pts[2].seamAfter).toBeUndefined(); expect(pts[2].corner).toBeUndefined();
    expect(pts[0].seamAfter).toBeUndefined(); expect(pts[1].corner).toBeUndefined(); expect(pts[3].corner).toBeUndefined();
    expect(pts[4].corner).toEqual({ type: 'angled' });
    expect(reseamPiece(t.doc, t.pid)).toEqual({ removedCurveSeams: 0, clampedValues: 0, droppedCorners: 0 });
  });
  it('reseamAll with discardManual returns manual cut pieces to auto', () => {
    const t = setup();
    t.doc.transact('m', s => { const p = s.pieces[0]; p.cutMode = 'manual'; p.manualCut = rectangleContour(-5, -5, 110, 110); });
    expect(area(t.doc.resolvePiece(t.pid).cut)).toBeCloseTo(12100, 9);
    reseamAll(t.doc, { discardManual: true });
    expect(t.piece().cutMode).toBe('auto');
    expect(area(t.doc.resolvePiece(t.pid).cut)).toBeCloseTo(14400, 9);
  });
});

describe('Seam ⇄ Internal', () => {
  it('internalToSeam: manual cut + inferred per-segment seams; back to auto reproduces it', () => {
    const t = setup();
    const ic = rectangleContour(-10, -15, 130, 125); ic.type = 'internal'; // x −10..120, y −15..110
    t.doc.transact('i', s => s.pieces[0].internals.push(ic));
    const vals = internalToSeam(t.doc, t.pid, ic.id);
    expect(vals).toEqual([15, 20, 10, 10]);
    expect(t.piece().cutMode).toBe('manual');
    expect(t.piece().internals.length).toBe(0);
    expect(area(t.doc.resolvePiece(t.pid).cut)).toBeCloseTo(130 * 125, 9);
    setCutModeAuto(t.doc, t.pid);
    const cut = t.doc.resolvePiece(t.pid).cut;
    expect(bbox(cut)).toEqual({ minX: -10, minY: -15, maxX: 120, maxY: 110 });
  });
  it('internalToSeam rejects a contour that does not surround the sew line', () => {
    const t = setup();
    const ic = rectangleContour(10, 10, 50, 50); ic.type = 'internal';
    t.doc.transact('i', s => s.pieces[0].internals.push(ic));
    expect(() => internalToSeam(t.doc, t.pid, ic.id)).toThrow(/surround/);
  });
  it('seamToInternal: cut line becomes a graded internal, piece noSeam; round-trips per size', () => {
    const t = setup(['S', 'M', 'L']);
    const [, M, L] = t.S;
    t.doc.transact('g', s => { const p = s.pieces[0]; p.sew.points[1].grade = { [L]: { dx: 10, dy: 0 } }; p.sew.points[2].grade = { [L]: { dx: 10, dy: 10 } }; p.sew.points[3].grade = { [L]: { dx: 0, dy: 10 } }; });
    setSeam(t.doc, t.pid, t.ids[1], t.ids[2], 20);
    const cutL = t.doc.resolvePiece(t.pid, L).cut;
    const cid = seamToInternal(t.doc, t.pid);
    expect(t.piece().noSeam).toBe(true);
    const rp = t.doc.resolvePiece(t.pid, L);
    expect(area(rp.cut)).toBeCloseTo(110 * 110, 9); // cut == sew
    const ic = rp.internals[0];
    close(ic.pts, cutL, 9);
    expect(area(ic.pts)).toBeCloseTo(140 * 130, 9);
    void M;
    // and back: infer the seams from the internal
    expect(internalToSeam(t.doc, t.pid, cid, 'auto')).toEqual([10, 20, 10, 10]);
    expect(t.piece().noSeam).toBe(false);
    expect(area(t.doc.resolvePiece(t.pid, L).cut)).toBeCloseTo(140 * 130, 9);
  });
});

describe('B10 — zero-length grade segments are merged inside the seam build', () => {
  const dupSquare = () => makeContour([gradePoint(0, 0), gradePoint(100, 0), gradePoint(100, 0), gradePoint(100, 100), gradePoint(0, 100)]);
  it('duplicate consecutive grade points: exact 120×120 cut, never touches the sew corner', () => {
    const t = setup(['S', 'M', 'L'], dupSquare());
    const r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId); // computeCutLine directly, no doc-level workaround
    close(r.pts, [{ x: -10, y: -10 }, { x: 110, y: -10 }, { x: 110, y: 110 }, { x: -10, y: 110 }]);
    expect(area(r.pts)).toBeCloseTo(14400, 9); // was 14300 with vertices (100,-10)(100,0)(110,0)
    const sew = resolveContour(t.piece().sew, t.line, t.line.baseSizeId).pts;
    expect(polyDist(r.pts, sew)).toBeCloseTo(10, 9);
    // both duplicates map onto the one merged corner
    expect(r.cornerIndex).toEqual([0, 1, 1, 2, 3]);
    expect(t.doc.resolvePiece(t.pid).cut).toEqual(r.pts);
  });
  it('a corner spec on the dropped duplicate carries over; triplicates; CW', () => {
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), gradePoint(100, 0), gradePoint(100, 0), gradePoint(100, 100), gradePoint(0, 100)]);
    c.points.reverse(); // CW: (0,100) (100,100) (100,0)×3 (0,0)
    const t = setup(['S', 'M', 'L'], c);
    // boxed:'prev' on the FIRST duplicate (its outgoing segment is zero-length)
    setCorner(t.doc, t.pid, t.ids[2], { type: 'boxed', extend: 'prev' });
    setSeam(t.doc, t.pid, t.ids[4], t.ids[5], 20); // bottom edge (100,0)→(0,0) = 20
    const r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
    // right edge (seam 10) runs straight down to the level of the bottom cut line, squares across
    // A (end of the right cut line) and B (start of the bottom cut line) are kept as corner points
    close(r.pts, [{ x: -10, y: 110 }, { x: 110, y: 110 }, { x: 110, y: 0 }, { x: 110, y: -20 }, { x: 100, y: -20 }, { x: -10, y: -20 }]);
    expect(r.cornerIndex).toEqual([0, 1, 2, 2, 2, 5]);
    expect(r.cornerSpan[4]).toEqual([2, 4]);
    expect(area(r.pts)).toBeCloseTo(120 * 130, 9);
  });
  it('duplicates in one size only (graded apart in L): every size is a clean offset', () => {
    const t = setup(['S', 'M', 'L'], dupSquare());
    const L = t.S[2];
    t.doc.transact('g', s => { s.pieces[0].sew.points[2].grade = { [L]: { dx: 0, dy: 20 } }; });
    for (const sid of t.S) {
      const cut = computeCutLine(t.piece(), t.line, sid);
      const sew = resolveContour(t.piece().sew, t.line, sid).pts;
      expect(polyDist(cut, sew)).toBeCloseTo(10, 9);
      expect(area(cut)).toBeCloseTo(14400, 9);
    }
  });
});

describe('acute corners on the cut line (audit B11, grade-corner miter)', () => {
  it('5° spike, seam 10: square cap at 10 mm past the tip; the whole cut stays ≥ 10 mm', () => {
    const h = 200 * Math.tan(5 * Math.PI / 180) / 2;
    const tip = { x: 300, y: 50 + h };
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), gradePoint(100, 50), gradePoint(tip.x, tip.y), gradePoint(100, 50 + 2 * h), gradePoint(100, 100), gradePoint(0, 100)]);
    for (const rev of [false, true]) {
      const cc = JSON.parse(JSON.stringify(c)); if (rev) cc.points.reverse();
      const t = setup(['S', 'M', 'L'], cc);
      const r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
      const sew = resolveContour(t.piece().sew, t.line, t.line.baseSizeId).pts;
      expect(polyDist(r.pts, sew)).toBeCloseTo(10, 9); // was 0.436 (bevel A→B)
      // cap: x = 310 (10 mm along the bisector), between the two offset lines
      const a = Math.atan(h / 200); // half-angle of the spike
      const yLo = tip.y + 10 * Math.tan(a) - 10 / Math.cos(a);
      const k = r.cornerSpan[3];
      const cap = r.pts.slice(Math.min(...k), Math.max(...k) + 1).sort((p, q) => p.y - q.y);
      close(cap, [{ x: 310, y: yLo }, { x: 310, y: 2 * tip.y - yLo }]);
      expect(Math.max(...r.pts.map(q => q.x))).toBeCloseTo(310, 9);
      expect(selfCrossings(r.pts)).toBe(0);
    }
  });
  it('within the miter limit the corner is still the plain miter (trapezoid unchanged)', () => {
    const t = setup(['S', 'M', 'L'], trap());
    expect(cutLineForSize(t.piece(), t.line, t.line.baseSizeId).pts.length).toBe(4);
  });
});

describe('B7 — boxed:both at non-right corners', () => {
  const s3 = Math.sqrt(3);
  /** corner C=(100,0), incoming along +x (seam 15), outgoing at interior angle θ (seam 10) */
  function wedge(theta: number) {
    const th = theta * Math.PI / 180, tOut = { x: -Math.cos(th), y: Math.sin(th) };
    const D = { x: 100 + 100 * tOut.x, y: 100 * tOut.y };
    const t = setup(['S', 'M', 'L'], makeContour([gradePoint(0, 0), gradePoint(100, 0), gradePoint(D.x, D.y), gradePoint(0, D.y)]));
    setSeam(t.doc, t.pid, t.ids[0], t.ids[1], 15);
    setCorner(t.doc, t.pid, t.ids[1], { type: 'boxed', extend: 'both' });
    return t;
  }
  const expected: Record<number, Vec[]> = {
    // acute: incoming squares up at x=110, steps out along the outgoing strip's squared end
    60: [{ x: 100, y: -15 }, { x: 110, y: -15 }, { x: 110, y: -20 / s3 }, { x: 107.5 + 5 * s3, y: 5 - 7.5 * s3 }, { x: 100 + 5 * s3, y: 5 }],
    90: [{ x: 100, y: -15 }, { x: 110, y: -15 }, { x: 110, y: 0 }],
    // obtuse: the outgoing strip's squared end stands proud of the incoming cut line
    120: [{ x: 70 + 15 * s3, y: -15 }, { x: 92.5 + 5 * s3, y: -5 - 7.5 * s3 }, { x: 100 + 5 / s3, y: -15 }, { x: 110, y: -15 }, { x: 110, y: 10 * s3 - 20 }],
  };
  for (const th of [60, 90, 120]) {
    it(`${th}°: exact corner, no self-crossing, every corner point kept on the cut line`, () => {
      const t = wedge(th);
      const cp = cornerPointsForSize(t.piece(), t.line, t.line.baseSizeId)[1].pts;
      close(cp, expected[th]);
      const r = cutLineForSize(t.piece(), t.line, t.line.baseSizeId);
      expect(selfCrossings(r.pts)).toBe(0);
      const [i0, i1] = r.cornerSpan[1];
      close(r.pts.slice(i0, i1 + 1), expected[th]);
      // squared: incoming extension ends perpendicular to the incoming edge, ≥ every allowance
      const sew = resolveContour(t.piece().sew, t.line, t.line.baseSizeId).pts;
      expect(polyDist(r.pts, sew)).toBeCloseTo(10, 9);
    });
  }
  it('audit D2c pentagon, 6 sizes, Lock Grading: no self-crossing, identical stamped corner on every size', () => {
    const doc = new Document(makeStyle('t', ['XS', 'S', 'M', 'L', 'XL', '2XL'], 'L'));
    const line = doc.sizeLine(); const ids = line.sizes.map(s => s.id);
    const g = (dx: number, dy: number) => Object.fromEntries(ids.map(i => [i, { dx, dy }]));
    const c = makeContour([gradePoint(0, 0), gradePoint(240, -20, { grade: g(7, -3) }), gradePoint(260, 150, { grade: g(4, 9) }), gradePoint(120, 260, { grade: g(0, 6) }), gradePoint(-10, 180)]);
    const p = makePiece('P', c, doc.style.activeSizeTableId); doc.transact('a', s => s.pieces.push(p));
    setSeam(doc, p.id, c.points[1].id, c.points[2].id, 15);
    setCorner(doc, p.id, c.points[2].id, { type: 'boxed', extend: 'both' });
    const base = cornerPointsForSize(doc.piece(p.id), line, line.baseSizeId)[2];
    // contains the audit's former self-intersection point as a proper (concave) corner vertex
    expect(base.pts.length).toBe(5);
    const lineDist = (q: Vec, a: Vec, b: Vec) => Math.abs(cross2(norm(sub(b, a)), sub(q, a)));
    const [P1, P2, P3] = [{ x: 240, y: -20 }, { x: 260, y: 150 }, { x: 120, y: 260 }];
    // the audit's former self-crossing (275.195, 150.779) is now a proper concave vertex on BOTH cut lines
    expect(lineDist(base.pts[2], P1, P2)).toBeCloseTo(15, 9);
    expect(lineDist(base.pts[2], P2, P3)).toBeCloseTo(10, 9);
    close([base.pts[2]], [{ x: 275.195, y: 150.779 }], 3);
    // squared ends: incoming runs on 10 mm (outgoing width) past the corner, outgoing runs back 15 mm
    const tIn = norm(sub(P2, P1)), tOut = norm(sub(P3, P2));
    expect(dot(sub(base.pts[3], P2), tIn)).toBeCloseTo(10, 9);
    expect(lineDist(base.pts[3], P1, P2)).toBeCloseTo(15, 9);
    expect(dot(sub(base.pts[1], P2), tOut)).toBeCloseTo(-15, 9);
    expect(lineDist(base.pts[1], P2, P3)).toBeCloseTo(10, 9);
    setLockGrading(doc, p.id, true);
    // corner-local frame: origin = sew corner, x = incoming edge direction (rotates per size here)
    const loc = (sid: string, pts: Vec[]) => {
      const sp = resolveContour(doc.piece(p.id).sew, line, sid).anchorPos;
      const t = norm(sub(sp[2], sp[1]));
      return pts.map(q => { const v = sub(q, sp[2]); return { x: dot(v, t), y: dot(v, perp(t)) }; });
    };
    const baseLoc = loc(line.baseSizeId, base.pts);
    for (const sid of ids) {
      const cp = cornerPointsForSize(doc.piece(p.id), line, sid)[2];
      close(loc(sid, cp.pts), baseLoc, 9);
      const r = cutLineForSize(doc.piece(p.id), line, sid);
      expect(selfCrossings(r.pts)).toBe(0);
      const [i0, i1] = r.cornerSpan[2];
      expect(i1 - i0 + 1).toBe(5); // was 4,4,4,3,4,4 across sizes
      close(r.pts.slice(i0, i1 + 1), cp.pts, 9); // every stamped point is on the real cut line
    }
  });
});
