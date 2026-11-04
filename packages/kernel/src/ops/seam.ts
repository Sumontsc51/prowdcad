/**
 * Seam system (A2) — engineered, not decorative.
 *
 * The CUT line is derived from the SEW line (master) + per-segment seam values + per-corner
 * CornerSpec. `computeCutLine(piece, line, sizeId)` is the entry point used by
 * Document.resolvePiece(); `cutLineForSize` additionally returns the cut-polygon index of every
 * sew grade corner.
 *
 * Construction (closed sew contour):
 *   1. Split the sew polyline into grade segments (segment k: gradeIdx[k] → next grade anchor).
 *   2. Offset each segment as an OPEN polyline by its own allowance (positive = outward,
 *      winding-agnostic) → O_k. O_k[0] / O_k[last] are the perpendicular feet at the corners.
 *   3. At each grade corner build the corner geometry (miter / boxed / turnback / angled /
 *      manual) from the two adjacent offsets; with Lock Grading the base-size geometry is
 *      re-stamped in the corner's local frame.
 *   4. Trim each O_k against the corner geometry (concave corners overlap), concatenate,
 *      drop redundant collinear points (never corner points) and remove self-intersection loops.
 *
 * AUTO RESEAM ASSUMPTION: the cut line is never cached in the document. Whatever the value of
 * `style.settings.autoReseam`, resolvePiece() computes it lazily from the current sew line and
 * seam parameters, so the cut line can never go stale. `autoReseam` only controls whether seam
 * commands immediately re-materialise the Lock-Grading snapshot (`corner.lockedPerSize`) and run
 * the parameter self-heal; with it off, call `reseamPiece` / `reseamAll` / `updateSeamGrading`.
 * The snapshot is informational (export / UI); computeCutLine always derives the locked corner
 * live from the base size, which is the source of truth.
 */
import { Vec, add, sub, mul, dot, cross, dist, norm, perp, reflect } from '../geom/vec';
import {
  offsetOutward, offsetPolyline, isCCW, lineIntersect, polylineIntersections, closestPoint,
  removeSelfIntersections, dedupe, pointInPolygon, distToPolygon, polylineLength, pointAtLength,
} from '../geom/poly';
import type { Piece, SizeLine, SizeId, CornerSpec, Contour, Anchor, Id, Style, GradeInc } from '../model/types';
import { resolveContour, spanPolyline, absoluteToIncremental, type ResolvedContour } from '../model/contour';
import { newId } from '../model/factory';
import type { Document } from '../model/doc';

/** Miter length limit (× the larger allowance) beyond which a convex miter falls back to a bevel. */
export const SEAM_MITER_LIMIT = 4;
/** Maximum number of points of a manual corner. */
export const MANUAL_CORNER_MAX_POINTS = 10;

// ───────────────────────────── per-segment values ─────────────────────────────

/** Per-grade-segment seam allowances for a piece (segment k leaves gradeIdx[k]). */
export function segmentSeams(piece: Piece, r: ResolvedContour): number[] {
  const out: number[] = [];
  for (const gi of r.gradeIdx) {
    const v = piece.sew.points[gi].seamAfter;
    out.push(v !== undefined && Number.isFinite(v) ? v : (Number.isFinite(piece.seamDefault) ? piece.seamDefault : 0));
  }
  return out;
}

/** Expand per-grade-segment seam values to per-sample-edge distances. */
export function perEdgeDistances(piece: Piece, r: ResolvedContour): number[] {
  const seg = segmentSeams(piece, r);
  const N = r.pts.length;
  const d = new Array(N).fill(piece.seamDefault);
  const g = r.gradeIdx;
  for (let k = 0; k < g.length; k++) {
    const start = r.anchorIndex[g[k]];
    const end = r.closed ? r.anchorIndex[g[(k + 1) % g.length]] : r.anchorIndex[g[Math.min(k + 1, g.length - 1)]];
    let i = start;
    let guard = 0;
    while (guard++ <= N) { d[i] = seg[k]; i = (i + 1) % N; if (i === end) break; }
  }
  return d;
}

// ───────────────────────────── cut-line construction ─────────────────────────────

export interface CutLineResult {
  /** closed cut polygon (first point not repeated) */
  pts: Vec[];
  /** for each sew grade corner (order of gradeIdx), index into pts of its corner point
   *  (miter point; first point of a multi-point engineered corner) */
  cornerIndex: number[];
  /** for each sew grade corner, [first, last] index into pts of its corner geometry */
  cornerSpan: [number, number][];
}

interface CornerCtx {
  /** sew corner position */
  C: Vec;
  /** end of incoming offset (perpendicular foot) / start of outgoing offset */
  A: Vec; B: Vec;
  /** unit directions of the incoming / outgoing edges at the corner */
  tIn: Vec; tOut: Vec;
  dPrev: number; dNext: number;
  prev: Vec[]; next: Vec[];
}

interface CornerInfo { ctx: CornerCtx; raw: Vec[] }

interface Built { r: ResolvedContour; offs: Vec[][]; corners: CornerInfo[] }

const unit = (a: Vec, b: Vec): Vec => norm(sub(b, a));
const toLocal = (v: Vec, t: Vec): Vec => ({ x: dot(v, t), y: dot(v, perp(t)) });
const fromLocal = (q: Vec, t: Vec): Vec => add(mul(t, q.x), mul(perp(t), q.y));

function tangentAtEnd(p: Vec[]): Vec { for (let i = p.length - 1; i > 0; i--) { const t = unit(p[i - 1], p[i]); if (t.x || t.y) return t; } return { x: 0, y: 0 }; }
function tangentAtStart(p: Vec[]): Vec { for (let i = 1; i < p.length; i++) { const t = unit(p[i - 1], p[i]); if (t.x || t.y) return t; } return { x: 0, y: 0 }; }

/** Offset geometry of every grade segment + the raw (untrimmed, unlocked) corner geometry. */
function build(piece: Piece, line: SizeLine, sizeId: SizeId): Built {
  const r = resolveContour(piece.sew, line, sizeId);
  const g = r.gradeIdx;
  const G = g.length;
  const ccw = isCCW(r.pts);
  const sign = ccw ? -1 : 1; // offsetPolyline: + = left of travel; outward = right for CCW
  const seams = segmentSeams(piece, r);
  const offs: Vec[][] = [];
  const sews: Vec[][] = [];
  for (let k = 0; k < G; k++) {
    const sew = dedupe(spanPolyline(r, g[k], g[(k + 1) % G]));
    sews.push(sew);
    if (sew.length < 2) { offs.push([{ ...r.anchorPos[g[k]] }, { ...r.anchorPos[g[k]] }]); continue; }
    offs.push(offsetPolyline(sew, { distances: seams[k] * sign, join: 'miter', closed: false, cleanup: true }));
  }
  const corners: CornerInfo[] = [];
  for (let k = 0; k < G; k++) {
    const kp = (k - 1 + G) % G;
    const prev = offs[kp], next = offs[k];
    let tIn = tangentAtEnd(prev), tOut = tangentAtStart(next);
    if (!tIn.x && !tIn.y) tIn = tangentAtEnd(sews[kp]);
    if (!tOut.x && !tOut.y) tOut = tangentAtStart(sews[k]);
    const ctx: CornerCtx = {
      C: { ...r.anchorPos[g[k]] }, A: prev[prev.length - 1], B: next[0], tIn, tOut,
      dPrev: seams[kp], dNext: seams[k], prev, next,
    };
    corners.push({ ctx, raw: cornerGeometry(piece.sew.points[g[k]].corner, ctx, piece, line, sizeId, g[k]) });
  }
  return { r, offs, corners };
}

function miterCorner(c: CornerCtx): Vec[] {
  // 1) the two offsets already cross near the corner (concave / curved) → that crossing
  const ints = polylineIntersections(c.prev, c.next);
  if (ints.length) {
    const Lp = polylineLength(c.prev);
    let best = ints[0], bs = Infinity;
    for (const it of ints) { const s = (Lp - it.sP) + it.sQ; if (s < bs) { bs = s; best = it; } }
    return [best.pt];
  }
  // 2) extend the end edges
  const M = lineIntersect(c.A, c.tIn, c.B, c.tOut);
  if (!M) return dist(c.A, c.B) < 1e-9 ? [c.A] : [c.A, c.B];
  const convex = dot(sub(M, c.A), c.tIn) > -1e-9 && dot(sub(c.B, M), c.tOut) > -1e-9;
  const lim = SEAM_MITER_LIMIT * Math.max(Math.abs(c.dPrev), Math.abs(c.dNext), 1e-9);
  if (convex && dist(M, c.C) > lim) return [c.A, c.B];
  return [M];
}

/** true when the offsets diverge at the corner (outer corner w.r.t. the offset direction) */
function isConvex(c: CornerCtx): boolean {
  if (polylineIntersections(c.prev, c.next).length) return false;
  const M = lineIntersect(c.A, c.tIn, c.B, c.tOut);
  if (!M) return false;
  return dot(sub(M, c.A), c.tIn) > 1e-9 && dot(sub(c.B, M), c.tOut) > 1e-9;
}

function boxedCorner(c: CornerCtx, extend: 'prev' | 'next' | 'both'): Vec[] {
  if (!isConvex(c)) return miterCorner(c);
  if (extend === 'prev') {
    // prev cut line runs straight on until it is level (along tIn) with B, then squares across to B
    const s = dot(sub(c.B, c.A), c.tIn);
    if (s <= 1e-9) return miterCorner(c);
    return [c.A, add(c.A, mul(c.tIn, s)), c.B];
  }
  if (extend === 'next') {
    const s = dot(sub(c.A, c.B), c.tOut);
    if (s >= -1e-9) return miterCorner(c);
    return [c.A, add(c.B, mul(c.tOut, s)), c.B];
  }
  // both: each allowance runs past the corner by the other's width, bridged straight
  const P = add(c.A, mul(c.tIn, Math.abs(c.dNext)));
  const Q = sub(c.B, mul(c.tOut, Math.abs(c.dPrev)));
  return [c.A, P, Q, c.B];
}

function angledCorner(c: CornerCtx): Vec[] {
  if (!isConvex(c)) return miterCorner(c);
  return dist(c.A, c.B) < 1e-9 ? [c.A] : [c.A, c.B];
}

/**
 * Turn-back (mirrored) corner. The hem side is `extend` ('prev' | 'next'); default: the side
 * with the larger allowance (tie → next). The other side's cut line is run to the hem's fold
 * line (= the hem's sew line), then mirrored across it until it meets the hem's cut line, so
 * that when the hem is folded back along the sew line its raw edge lies on the adjacent seam.
 */
function turnbackCorner(c: CornerCtx, side?: 'prev' | 'next' | 'both'): Vec[] {
  const hem: 'prev' | 'next' = side === 'prev' || side === 'next' ? side : (Math.abs(c.dPrev) > Math.abs(c.dNext) ? 'prev' : 'next');
  if (hem === 'next') {
    const X = lineIntersect(c.A, c.tIn, c.C, c.tOut);
    if (!X) return miterCorner(c);
    const dir = sub(reflect(add(X, c.tIn), c.C, c.tOut), X);
    const Y = lineIntersect(X, dir, c.B, c.tOut);
    if (!Y) return miterCorner(c);
    return dist(X, Y) < 1e-9 ? [X] : [X, Y];
  }
  const X = lineIntersect(c.B, c.tOut, c.C, c.tIn);
  if (!X) return miterCorner(c);
  const dir = sub(reflect(add(X, c.tOut), c.C, c.tIn), X);
  const Y = lineIntersect(c.A, c.tIn, X, dir);
  if (!Y) return miterCorner(c);
  return dist(X, Y) < 1e-9 ? [X] : [Y, X];
}

function cornerGeometry(spec: CornerSpec | undefined, c: CornerCtx, piece: Piece, line: SizeLine, sizeId: SizeId, ai: number): Vec[] {
  if (!spec) return miterCorner(c);
  switch (spec.type) {
    case 'boxed': return boxedCorner(c, spec.extend ?? 'both');
    case 'turnback': return turnbackCorner(c, spec.extend);
    case 'angled': return angledCorner(c);
    case 'manual': {
      const mp = spec.manualPoints;
      if (!mp || mp.length === 0) return miterCorner(c);
      // manual points are base-size absolute; other sizes move rigidly with the sew corner
      const a = piece.sew.points[ai];
      const d = sizeId === line.baseSizeId ? { x: 0, y: 0 } : sub(c.C, a);
      return mp.map(p => add(p, d));
    }
    default: return miterCorner(c);
  }
}

function trimStart(p: Vec[], q: Vec): Vec[] {
  if (p.length < 2) return p.slice();
  const cl = closestPoint(p, q);
  if (cl.seg === 0 && cl.t <= 1e-12) return p.slice();
  return [cl.pt, ...p.slice(cl.seg + 1)];
}
function trimEnd(p: Vec[], q: Vec): Vec[] { return trimStart(p.slice().reverse(), q).reverse(); }

/** Locked corner geometry for `sizeId`: base raw corner expressed in the corner's local frame
 *  (origin = sew corner, x = incoming edge direction), re-stamped on this size's corner. */
function lockedCornerPts(base: CornerInfo, here: CornerCtx): Vec[] {
  return base.raw.map(p => add(here.C, fromLocal(toLocal(sub(p, base.ctx.C), base.ctx.tIn), here.tIn)));
}

/** Cut polygon + per-grade-corner indices for one size. */
export function cutLineForSize(piece: Piece, line: SizeLine, sizeId: SizeId): CutLineResult {
  if (piece.cutMode === 'manual' && piece.manualCut) {
    const sew = resolveContour(piece.sew, line, sizeId);
    const pts = resolveContour(piece.manualCut, line, sizeId).pts.slice();
    const ci = sew.gradeIdx.map(gi => nearestIndex(pts, sew.anchorPos[gi]));
    return { pts, cornerIndex: ci, cornerSpan: ci.map(i => [i, i] as [number, number]) };
  }
  const r0 = resolveContour(piece.sew, line, sizeId);
  if (piece.noSeam) {
    const ci = r0.gradeIdx.map(gi => r0.anchorIndex[gi]);
    return { pts: r0.pts.slice(), cornerIndex: ci, cornerSpan: ci.map(i => [i, i] as [number, number]) };
  }
  if (!piece.sew.closed || r0.gradeIdx.length < 2 || r0.pts.length < 3) {
    const pts = offsetOutward(r0.pts, perEdgeDistances(piece, r0), 'miter');
    const ci = r0.gradeIdx.map(gi => nearestIndex(pts, r0.anchorPos[gi]));
    return { pts, cornerIndex: ci, cornerSpan: ci.map(i => [i, i] as [number, number]) };
  }
  const b = build(piece, line, sizeId);
  const G = b.corners.length;
  const g = b.r.gradeIdx;
  // Lock Grading: stamp base-size engineered corners onto this size
  let cornerPts = b.corners.map(c => c.raw);
  if (piece.lockGrading && sizeId !== line.baseSizeId) {
    const base = build(piece, line, line.baseSizeId);
    cornerPts = b.corners.map((c, k) => piece.sew.points[g[k]].corner ? lockedCornerPts(base.corners[k], c.ctx) : c.raw);
  }
  // assemble
  const out: Vec[] = []; const flag: number[] = []; // flag: -1 plain, else corner k
  const push = (p: Vec, f: number) => {
    if (out.length && dist(out[out.length - 1], p) <= 1e-9) { if (f >= 0 && flag[flag.length - 1] < 0) flag[flag.length - 1] = f; return; }
    out.push(p); flag.push(f);
  };
  for (let k = 0; k < G; k++) {
    const cp = cornerPts[k], cn = cornerPts[(k + 1) % G];
    for (const p of cp) push(p, k);
    const seg = trimEnd(trimStart(b.offs[k], cp[cp.length - 1]), cn[0]);
    for (const p of seg) push(p, -1);
  }
  while (out.length > 1 && dist(out[0], out[out.length - 1]) <= 1e-9) { if (flag[0] < 0) flag[0] = flag[flag.length - 1]; out.pop(); flag.pop(); }
  // drop redundant collinear non-corner points
  let pts: Vec[] = [];
  {
    const n = out.length;
    for (let i = 0; i < n; i++) {
      if (flag[i] >= 0 || n < 4) { pts.push(out[i]); continue; }
      const a = out[(i - 1 + n) % n], p = out[i], c = out[(i + 1) % n];
      const u = sub(p, a), w = sub(c, p);
      const l = Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y);
      if (l > 1e-18 && Math.abs(cross(u, w)) / l <= 1e-9 && dot(u, w) > 0) continue;
      pts.push(p);
    }
  }
  pts = removeSelfIntersections(pts, true);
  while (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) <= 1e-9) pts.pop();
  const cornerIndex: number[] = [], cornerSpan: [number, number][] = [];
  for (let k = 0; k < G; k++) {
    const cp = cornerPts[k];
    const i0 = nearestIndex(pts, cp[0]), i1 = nearestIndex(pts, cp[cp.length - 1]);
    cornerIndex.push(i0); cornerSpan.push([i0, i1]);
  }
  return { pts, cornerIndex, cornerSpan };
}

function nearestIndex(pts: Vec[], q: Vec): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i++) { const d = dist(pts[i], q); if (d < bd) { bd = d; bi = i; } }
  return bi;
}

/** Cut line (closed polygon) for a size — the provider used by Document.resolvePiece(). */
export function computeCutLine(piece: Piece, line: SizeLine, sizeId: SizeId): Vec[] {
  return cutLineForSize(piece, line, sizeId).pts;
}

/** Corner geometry (cut-line points of the corner) for every grade corner of a size, after lock stamping. */
export function cornerPointsForSize(piece: Piece, line: SizeLine, sizeId: SizeId): { anchorId: Id; sew: Vec; pts: Vec[] }[] {
  const b = build(piece, line, sizeId);
  const g = b.r.gradeIdx;
  const base = piece.lockGrading && sizeId !== line.baseSizeId ? build(piece, line, line.baseSizeId) : null;
  return b.corners.map((c, k) => ({
    anchorId: piece.sew.points[g[k]].id, sew: c.ctx.C,
    pts: base && piece.sew.points[g[k]].corner ? lockedCornerPts(base.corners[k], c.ctx) : c.raw,
  }));
}

// ───────────────────────────── commands ─────────────────────────────

function findPiece(s: Style, id: Id): Piece { const p = s.pieces.find(p => p.id === id); if (!p) throw new Error('No piece ' + id); return p; }
function gradeIndexOf(piece: Piece, anchorId: Id): number {
  const i = piece.sew.points.findIndex(a => a.id === anchorId);
  if (i < 0) throw new Error('No sew anchor ' + anchorId);
  if (piece.sew.points[i].kind !== 'grade') throw new Error('Anchor ' + anchorId + ' is not a grade point');
  return i;
}
function checkValue(v: number) { if (!Number.isFinite(v)) throw new Error('Seam value must be finite'); }
function afterSeamEdit(doc: Document, piece: Piece) {
  if (doc.style.settings.autoReseam) { repairPiece(piece, doc.sizeLine(piece)); stampLocks(piece, doc.sizeLine(piece)); }
}

/** Grade anchors from `fromAnchorId` (inclusive) to `toAnchorId` (exclusive) in contour order; from===to → all. */
function segmentRange(piece: Piece, fromAnchorId: Id, toAnchorId: Id): Anchor[] {
  const pts = piece.sew.points;
  const gi = pts.map((a, i) => (a.kind === 'grade' ? i : -1)).filter(i => i >= 0);
  const f = gi.indexOf(gradeIndexOf(piece, fromAnchorId)), t = gi.indexOf(gradeIndexOf(piece, toAnchorId));
  const out: Anchor[] = [];
  let k = f;
  do { out.push(pts[gi[k]]); k = (k + 1) % gi.length; } while (k !== t && out.length < gi.length);
  return out;
}

/** Set the seam of every grade segment from `fromAnchorId` to `toAnchorId` (contour order). Positive = outward. */
export function setSeam(doc: Document, pieceId: Id, fromAnchorId: Id, toAnchorId: Id, value: number): void {
  checkValue(value);
  doc.transact('Set seam', s => {
    const p = findPiece(s, pieceId);
    for (const a of segmentRange(p, fromAnchorId, toAnchorId)) a.seamAfter = value;
    p.noSeam = false;
    afterSeamEdit(doc, p);
  });
}

/** Whole-piece seam: sets the default and clears every per-segment override. */
export function setSeamWholePiece(doc: Document, pieceId: Id, value: number): void {
  checkValue(value);
  doc.transact('Set seam (piece)', s => {
    const p = findPiece(s, pieceId);
    p.seamDefault = value; p.noSeam = false;
    for (const a of p.sew.points) delete a.seamAfter;
    afterSeamEdit(doc, p);
  });
}

/** Global Seam: whole-piece seam on every piece of the style. */
export function setGlobalSeam(doc: Document, value: number): void {
  checkValue(value);
  doc.transact('Global seam', s => { for (const p of s.pieces) setSeamWholePiece(doc, p.id, value); });
}

/** Delete seam on a range of segments (sets them to 0). */
export function deleteSeamSegment(doc: Document, pieceId: Id, fromAnchorId: Id, toAnchorId: Id): void {
  setSeam(doc, pieceId, fromAnchorId, toAnchorId, 0);
}

/** Remove seam from a piece: cut == sew (noSeam), overrides/corners/manual cut cleared. */
export function removeSeamPiece(doc: Document, pieceId: Id): void {
  doc.transact('Remove seam', s => {
    const p = findPiece(s, pieceId);
    p.noSeam = true; p.cutMode = 'auto'; delete p.manualCut;
    for (const a of p.sew.points) { delete a.seamAfter; delete a.corner; }
  });
}
export function removeSeamAll(doc: Document): void {
  doc.transact('Remove seam (all)', s => { for (const p of s.pieces) removeSeamPiece(doc, p.id); });
}

/** Assign a corner spec to a sew grade corner (undefined → default miter). */
export function setCorner(doc: Document, pieceId: Id, anchorId: Id, spec: CornerSpec | undefined): void {
  if (spec?.type === 'manual') validateManual(spec.manualPoints);
  doc.transact('Seam corner', s => {
    const p = findPiece(s, pieceId);
    const a = p.sew.points[gradeIndexOf(p, anchorId)];
    if (spec) a.corner = JSON.parse(JSON.stringify(spec)); else delete a.corner;
    afterSeamEdit(doc, p);
  });
}
function validateManual(pts: Vec[] | undefined) {
  if (!pts || pts.length < 1) throw new Error('Manual corner needs at least 1 point');
  if (pts.length > MANUAL_CORNER_MAX_POINTS) throw new Error(`Manual corner allows at most ${MANUAL_CORNER_MAX_POINTS} points`);
  for (const q of pts) if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) throw new Error('Manual corner point is not finite');
}
/** User-drafted corner: polyline (≤10 pts, base-size coords) from the incoming cut line to the outgoing cut line. */
export function setCornerManual(doc: Document, pieceId: Id, anchorId: Id, pts: Vec[]): void {
  setCorner(doc, pieceId, anchorId, { type: 'manual', manualPoints: pts.map(q => ({ x: q.x, y: q.y })) });
}
/** Revert a corner to the default miter. */
export function revertCorner(doc: Document, pieceId: Id, anchorId: Id): void { setCorner(doc, pieceId, anchorId, undefined); }

/**
 * Manual Seam Angle: trim a corner with two clicks (base-size coords). Each click is snapped to the
 * nearer of the two adjacent cut lines (incoming / outgoing seam); result is a manual corner.
 */
export function trimCorner(doc: Document, pieceId: Id, anchorId: Id, p1: Vec, p2: Vec): void {
  const piece = doc.piece(pieceId);
  const line = doc.sizeLine(piece);
  const gi = gradeIndexOf(piece, anchorId);
  const b = build(piece, line, line.baseSizeId);
  const k = b.r.gradeIdx.indexOf(gi);
  const c = b.corners[k].ctx;
  // extend each offset straight past the corner so a click beyond its end still snaps
  const prevX = [...c.prev, add(c.A, mul(c.tIn, 1e4))];
  const nextX = [sub(c.B, mul(c.tOut, 1e4)), ...c.next];
  const a1 = closestPoint(prevX, p1), b2 = closestPoint(nextX, p2);
  const a2 = closestPoint(prevX, p2), b1 = closestPoint(nextX, p1);
  const pts = a1.d + b2.d <= a2.d + b1.d ? [a1.pt, b2.pt] : [a2.pt, b1.pt];
  setCornerManual(doc, pieceId, anchorId, pts);
}

/** Lock Grading on/off; re-materialises the per-size corner snapshot. */
export function setLockGrading(doc: Document, pieceId: Id, on: boolean): void {
  doc.transact('Lock grading', s => { const p = findPiece(s, pieceId); p.lockGrading = on; stampLocks(p, doc.sizeLine(p)); });
}

/** Materialise corner.lockedPerSize (absolute per-size corner points) when lockGrading, else clear it. */
function stampLocks(piece: Piece, line: SizeLine) {
  for (const a of piece.sew.points) if (a.corner) delete a.corner.lockedPerSize;
  if (!piece.lockGrading || piece.noSeam || !piece.sew.closed) return;
  const sizes = piece.sizes ?? line.sizes.map(s => s.id);
  for (const sid of sizes) {
    for (const c of cornerPointsForSize(piece, line, sid)) {
      const a = piece.sew.points.find(q => q.id === c.anchorId)!;
      if (!a.corner) continue;
      (a.corner.lockedPerSize ??= {})[sid] = c.pts.map(q => ({ x: q.x, y: q.y }));
    }
  }
}

/** Update Seam Grading: re-stamp (lock on) or clear (lock off) the per-size corner snapshot. */
export function updateSeamGrading(doc: Document, pieceId: Id): void {
  doc.transact('Update seam grading', s => { const p = findPiece(s, pieceId); stampLocks(p, doc.sizeLine(p)); });
}

/** Reseam a piece: self-heal parameters and re-stamp locked corners. `discardManual` drops a manual cut (back to auto). */
export function reseamPiece(doc: Document, pieceId: Id, opts: { discardManual?: boolean } = {}): RepairReport {
  return doc.transact('Reseam', s => {
    const p = findPiece(s, pieceId);
    if (opts.discardManual && p.cutMode === 'manual') { p.cutMode = 'auto'; delete p.manualCut; }
    const rep = repairPiece(p, doc.sizeLine(p));
    stampLocks(p, doc.sizeLine(p));
    return rep;
  });
}
export function reseamAll(doc: Document, opts: { discardManual?: boolean } = {}): void {
  doc.transact('Reseam all', s => { for (const p of s.pieces) reseamPiece(doc, p.id, opts); });
}
/** Reseam one segment: optionally set its value, drop the per-size snapshot of its two end corners and re-stamp. */
export function reseamSegment(doc: Document, pieceId: Id, fromAnchorId: Id, value?: number): void {
  if (value !== undefined) checkValue(value);
  doc.transact('Reseam segment', s => {
    const p = findPiece(s, pieceId);
    const pts = p.sew.points;
    const gi = pts.map((a, i) => (a.kind === 'grade' ? i : -1)).filter(i => i >= 0);
    const k = gi.indexOf(gradeIndexOf(p, fromAnchorId));
    const a = pts[gi[k]], b = pts[gi[(k + 1) % gi.length]];
    if (value !== undefined) a.seamAfter = value;
    for (const q of [a, b]) if (q.corner) delete q.corner.lockedPerSize;
    stampLocks(p, doc.sizeLine(p));
  });
}

// ───────────────────────────── repair ─────────────────────────────

export interface RepairReport { removedCurveSeams: number; clampedValues: number; droppedCorners: number }

function repairPiece(p: Piece, line: SizeLine): RepairReport {
  const rep: RepairReport = { removedCurveSeams: 0, clampedValues: 0, droppedCorners: 0 };
  if (!Number.isFinite(p.seamDefault)) { p.seamDefault = 0; rep.clampedValues++; }
  const sizeIds = new Set(line.sizes.map(s => s.id));
  for (const a of p.sew.points) {
    if (a.kind !== 'grade') {
      if (a.seamAfter !== undefined) { delete a.seamAfter; rep.removedCurveSeams++; }
      if (a.corner) { delete a.corner; rep.droppedCorners++; }
      continue;
    }
    if (a.seamAfter !== undefined && !Number.isFinite(a.seamAfter)) { delete a.seamAfter; rep.clampedValues++; }
    const c = a.corner;
    if (!c) continue;
    const okType = ['miter', 'boxed', 'turnback', 'angled', 'manual'].includes(c.type);
    const badManual = c.type === 'manual' && (!c.manualPoints || c.manualPoints.length < 1 || c.manualPoints.length > MANUAL_CORNER_MAX_POINTS
      || c.manualPoints.some(q => !Number.isFinite(q?.x) || !Number.isFinite(q?.y)));
    if (!okType || badManual) { delete a.corner; rep.droppedCorners++; continue; }
    if (c.lockedPerSize) for (const k of Object.keys(c.lockedPerSize)) if (!sizeIds.has(k)) delete c.lockedPerSize[k];
  }
  // drop the redundant piece-level corner snapshot entries if lock is off
  if (!p.lockGrading) for (const a of p.sew.points) if (a.corner) delete a.corner.lockedPerSize;
  return rep;
}

/** Repair Seam Parameters on one piece (or every piece when pieceId is omitted). */
export function repairSeam(doc: Document, pieceId?: Id): RepairReport {
  return doc.transact('Repair seam parameters', s => {
    const tot: RepairReport = { removedCurveSeams: 0, clampedValues: 0, droppedCorners: 0 };
    for (const p of s.pieces) {
      if (pieceId && p.id !== pieceId) continue;
      const r = repairPiece(p, doc.sizeLine(p));
      tot.removedCurveSeams += r.removedCurveSeams; tot.clampedValues += r.clampedValues; tot.droppedCorners += r.droppedCorners;
    }
    return tot;
  });
}

// ───────────────────────────── seam ⇄ internal ─────────────────────────────

/**
 * Seam → Internal: the cut line becomes a closed internal contour (cut-corner vertices are graded
 * grade points carrying the per-size cut-corner movement; other vertices are straight curve
 * points interpolated between them), and the piece becomes noSeam. Returns the new contour id.
 */
export function seamToInternal(doc: Document, pieceId: Id): Id {
  const piece = doc.piece(pieceId);
  const line = doc.sizeLine(piece);
  const base = cutLineForSize(piece, line, line.baseSizeId);
  const cornerSet = new Map<number, number>(); base.cornerIndex.forEach((ci, k) => { if (!cornerSet.has(ci)) cornerSet.set(ci, k); });
  const sizes = piece.sizes ?? line.sizes.map(s => s.id);
  const perSize = new Map<SizeId, CutLineResult>(); for (const sid of sizes) perSize.set(sid, cutLineForSize(piece, line, sid));
  const pts: Anchor[] = base.pts.map((q, i) => {
    const k = cornerSet.get(i);
    const grade: Record<SizeId, GradeInc> = {};
    if (k !== undefined) {
      const abs: Record<SizeId, GradeInc> = {};
      for (const sid of sizes) { const r = perSize.get(sid)!; const p = r.pts[r.cornerIndex[k]] ?? q; abs[sid] = { dx: p.x - q.x, dy: p.y - q.y }; }
      Object.assign(grade, absoluteToIncremental(abs, line));
    }
    return { id: newId('p'), x: q.x, y: q.y, kind: k !== undefined ? 'grade' : 'curve', smooth: false, grade, flags: {} };
  });
  if (pts.length && !pts.some(a => a.kind === 'grade')) pts[0].kind = 'grade';
  const contour: Contour = { id: newId('c'), type: 'internal', closed: true, points: pts, name: 'SEAM', mode: 'cut' };
  doc.transact('Seam to internal', s => {
    const p = findPiece(s, pieceId);
    p.internals.push(contour);
    p.noSeam = true; p.cutMode = 'auto'; delete p.manualCut;
  });
  return contour.id;
}

/**
 * Internal → Seam: a closed internal contour that surrounds the sew line becomes the cut line.
 * mode 'manual' (default): cutMode = 'manual', manualCut = that contour. Per-segment seam values
 * are always inferred (median distance from the internal to points at 25/50/75 % of each sew
 * segment, 0.01 mm) so the piece can go back to 'auto'; mode 'auto' does that immediately.
 */
export function internalToSeam(doc: Document, pieceId: Id, internalId: Id, mode: 'manual' | 'auto' = 'manual'): number[] {
  const piece = doc.piece(pieceId);
  const line = doc.sizeLine(piece);
  const c = piece.internals.find(q => q.id === internalId);
  if (!c) throw new Error('No internal ' + internalId);
  if (!c.closed) throw new Error('Internal contour must be closed');
  const ic = resolveContour(c, line, line.baseSizeId).pts;
  const sew = resolveContour(piece.sew, line, line.baseSizeId);
  if (!sew.pts.every(q => pointInPolygon(q, ic) || distToPolygon(q, ic) < 1e-6)) throw new Error('Internal contour does not surround the sew line');
  const g = sew.gradeIdx;
  const vals: number[] = [];
  for (let k = 0; k < g.length; k++) {
    const poly = dedupe(spanPolyline(sew, g[k], g[(k + 1) % g.length]));
    const L = polylineLength(poly);
    const ds = [0.25, 0.5, 0.75].map(f => distToPolygon(pointAtLength(poly, L * f).pt, ic)).sort((a, b) => a - b);
    vals.push(Math.round(ds[1] * 100) / 100);
  }
  doc.transact('Internal to seam', s => {
    const p = findPiece(s, pieceId);
    const idx = p.internals.findIndex(q => q.id === internalId);
    const [ct] = p.internals.splice(idx, 1);
    const sp = p.sew.points.filter(a => a.kind === 'grade');
    sp.forEach((a, k) => { a.seamAfter = vals[k]; });
    p.noSeam = false;
    if (mode === 'manual') { p.cutMode = 'manual'; p.manualCut = { ...ct, type: 'perimeter', name: ct.name ?? 'CUT' }; }
    else { p.cutMode = 'auto'; delete p.manualCut; }
    afterSeamEdit(doc, p);
  });
  return vals;
}

/** Switch a manual-cut piece back to the auto cut line (seam values kept / previously inferred). */
export function setCutModeAuto(doc: Document, pieceId: Id): void {
  doc.transact('Auto cut line', s => { const p = findPiece(s, pieceId); p.cutMode = 'auto'; delete p.manualCut; afterSeamEdit(doc, p); });
}
