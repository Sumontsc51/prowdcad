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
    expect(r.pts.length).toBe(7);
    close([r.pts[2]], [{ x: 110, y: -10 }]); // incoming seam runs on by the outgoing allowance
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
