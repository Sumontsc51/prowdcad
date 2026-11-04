/**
 * Notches (A6). Live objects: a notch references an anchor id + placement rule and is re-derived
 * on every resolve, so it follows grading and segment edits.
 *
 * Placement kinds (NotchPlacement):
 *  - anchor        : sits on the anchor (moves with it in every size)
 *  - fromPrev      : dist[size] mm forward (contour order) from anchorId
 *  - fromNext      : dist[size] mm backward from anchorId
 *  - proportional  : pct PERCENT (0..100) of the span anchorId → next grade anchor
 *                    (or → notch.spanEndAnchorId when set)
 *
 * All geometry here is resolved fresh (model/contour + ops/seam), never through Document's cache,
 * so the functions are safe to call inside a transaction after mutating the style.
 */
import type { Anchor, Contour, Id, Notch, NotchPlacement, NotchType, Piece, SizeId, SizeLine, GradeInc } from '../model/types';
import type { Document } from '../model/doc';
import { resolveContour, absoluteToIncremental, type ResolvedContour } from '../model/contour';
import { computeCutLine } from './seam';
import { newId, makeAnchor } from '../model/factory';
import { Vec, add, sub, mul, norm, rotate, rad, deg, angleBetween, lerp, dot, len } from '../geom/vec';
import { parseLength } from '../units';
import {
  anchorArcS, wrapS, forwardDist, contourLength, arcPoint, outwardNormal, contourCCW,
  rayHit, rayHitContour, notchShape, closestS,
} from '../geom/notch-geom';

// ───────────────────────── resolution helpers ─────────────────────────

/** Live piece (by id) — guards against stale references after undo. */
export function livePiece(doc: Document, piece: Piece | Id): Piece {
  return doc.piece(typeof piece === 'string' ? piece : piece.id);
}

export function notchContour(piece: Piece, contourId: Id): Contour {
  if (piece.sew.id === contourId) return piece.sew;
  const c = piece.internals.find(c => c.id === contourId);
  if (!c) throw new Error('No contour ' + contourId + ' on piece ' + piece.name);
  return c;
}

/** Uncached contour resolution (safe inside transact). */
export function resolveFresh(doc: Document, piece: Piece, contourId: Id, sizeId?: SizeId): ResolvedContour {
  const line = doc.sizeLine(piece);
  return resolveContour(notchContour(piece, contourId), line, sizeId ?? line.baseSizeId);
}

/** Uncached cut polygon (safe inside transact). */
export function cutFresh(doc: Document, piece: Piece, sizeId?: SizeId): Vec[] {
  const line = doc.sizeLine(piece);
  const sid = sizeId ?? line.baseSizeId;
  return piece.cutMode === 'manual' && piece.manualCut ? resolveContour(piece.manualCut, line, sid).pts : computeCutLine(piece, line, sid);
}

function sizeIds(line: SizeLine): SizeId[] { return line.sizes.map(s => s.id); }

/** Next grade anchor (contour index) after index i; −1 if none (open contour end). */
export function nextGradeIndex(contour: Contour, i: number): number {
  const n = contour.points.length;
  for (let k = 1; k <= n; k++) {
    const j = contour.closed ? (i + k) % n : i + k;
    if (j >= n) return -1;
    if (contour.points[j].kind === 'grade') return j;
  }
  return -1;
}
/** Previous grade anchor at or before index i (inclusive); −1 if none. */
export function prevGradeIndex(contour: Contour, i: number, inclusive = true): number {
  const n = contour.points.length;
  for (let k = inclusive ? 0 : 1; k <= n; k++) {
    const j = contour.closed ? ((i - k) % n + n) % n : i - k;
    if (j < 0) return -1;
    if (contour.points[j].kind === 'grade') return j;
  }
  return -1;
}

/** Forward span length between two arc positions on r; a closed contour with sA == sB means the full loop. */
function spanLen(r: ResolvedContour, sA: number, sB: number, sameAnchor: boolean): number {
  if (!r.closed) return Math.max(0, sB - sA);
  const d = forwardDist(r, sA, sB);
  return d === 0 && sameAnchor ? contourLength(r) : d;
}

function distFor(map: Record<SizeId, number>, sizeId: SizeId, baseId: SizeId): number {
  return map[sizeId] ?? map[baseId] ?? 0;
}

/** Arc length of a notch on its contour for a size. */
export function notchArcLength(doc: Document, piece: Piece, notch: Notch, sizeId: SizeId, r?: ResolvedContour): number {
  const contour = notchContour(piece, notch.contourId);
  const line = doc.sizeLine(piece);
  r = r ?? resolveContour(contour, line, sizeId);
  const pl = notch.placement;
  const ia = contour.points.findIndex(a => a.id === pl.anchorId);
  if (ia < 0) throw new Error('Notch ' + notch.id + ': anchor ' + pl.anchorId + ' not on contour');
  const sA = anchorArcS(r, ia);
  switch (pl.kind) {
    case 'anchor': return sA;
    case 'fromPrev': return wrapS(r, sA + distFor(pl.dist, sizeId, line.baseSizeId));
    case 'fromNext': return wrapS(r, sA - distFor(pl.dist, sizeId, line.baseSizeId));
    case 'proportional': {
      let ib = notch.spanEndAnchorId ? contour.points.findIndex(a => a.id === notch.spanEndAnchorId) : nextGradeIndex(contour, ia);
      if (ib < 0) return sA;
      const L = spanLen(r, sA, anchorArcS(r, ib), ib === ia);
      return wrapS(r, sA + (pl.pct / 100) * L);
    }
  }
}

/** Grade-segment index containing arc length s (segment k leaves gradeIdx[k]). −1 if no grade anchors. */
export function segmentIndexAt(r: ResolvedContour, s: number): number {
  const g = r.gradeIdx, G = g.length;
  if (G === 0) return -1;
  if (!r.closed) {
    let k = 0;
    for (let j = 0; j < G; j++) if (anchorArcS(r, g[j]) <= s + 1e-9) k = j;
    return Math.max(0, Math.min(k, G - 2));
  }
  for (let k = 0; k < G; k++) {
    const a = anchorArcS(r, g[k]);
    const seg = spanLen(r, a, anchorArcS(r, g[(k + 1) % G]), G === 1);
    if (forwardDist(r, a, s) < seg - 1e-9) return k;
  }
  return 0;
}

export interface ResolvedNotch {
  notchId: Id;
  /** position on the SEW line (or on the internal line for notches on internal contours) */
  pos: Vec;
  /** outward unit normal at pos */
  normal: Vec;
  /** unit tangent (contour direction; bisector at a vertex) */
  tangent: Vec;
  /** actual outward direction of the mark (normal rotated by angleDeg, or corner direction) */
  direction: Vec;
  /** where the mark meets the CUT line */
  mouth: Vec;
  /** polylines of the notch mark (starting on the cut line, going inward) */
  cutGeometry: Vec[][];
  /** arc length on contour (from pts[0]) */
  s: number;
  /** grade-segment index containing s */
  segmentIndex: number;
  type: NotchType;
  mode: 'draw' | 'cut';
  depth: number;
  width: number;
}

/** Resolve a notch for a size: sew-line position, frame, and cut-line mark geometry. */
export function resolveNotch(doc: Document, piece: Piece, notch: Notch, sizeId?: SizeId): ResolvedNotch {
  piece = livePiece(doc, piece);
  const line = doc.sizeLine(piece);
  const sid = sizeId ?? line.baseSizeId;
  const contour = notchContour(piece, notch.contourId);
  const r = resolveContour(contour, line, sid);
  const s = notchArcLength(doc, piece, notch, sid, r);
  const ap = arcPoint(r, s);
  const ccw = contourCCW(r);
  const normal = outwardNormal(ap.tangent, ccw);
  let direction = rotate(normal, rad(notch.angleDeg ?? 0));
  if (notch.cornerDir && ap.atVertex) {
    // corner notch: continue the previous segment past the corner, or extend the next one backwards
    direction = notch.cornerDir === 'prev' ? ap.tIn : mul(ap.tOut, -1);
  }
  direction = norm(direction);
  let mouth = ap.pt;
  if (contour.id === piece.sew.id && contour.closed) {
    const cut = cutFresh(doc, piece, sid);
    const h = rayHit(ap.pt, direction, cut, true, -1e-7);
    if (h) mouth = h.pt;
  }
  const setup = doc.style.settings.notchSetup[notch.type];
  const depth = notch.depth ?? setup?.depth ?? 5;
  const width = notch.width ?? setup?.width ?? 0;
  const cutGeometry = notchShape(notch.type, mouth, mul(direction, -1), depth, width);
  return {
    notchId: notch.id, pos: ap.pt, normal, tangent: ap.tangent, direction, mouth, cutGeometry,
    s, segmentIndex: segmentIndexAt(r, s), type: notch.type,
    mode: notch.mode ?? setup?.mode ?? 'cut', depth, width,
  };
}

/** Resolve every notch of a piece for a size. */
export function resolveNotches(doc: Document, piece: Piece, sizeId?: SizeId): ResolvedNotch[] {
  piece = livePiece(doc, piece);
  return piece.notches.map(n => resolveNotch(doc, piece, n, sizeId));
}

// ───────────────────────── creation ─────────────────────────

export interface AddNotchOptions {
  contourId?: Id;
  placement: NotchPlacement;
  type?: NotchType;
  depth?: number;
  width?: number;
  angleDeg?: number;
  cornerDir?: 'prev' | 'next';
  mode?: 'draw' | 'cut';
  source?: Notch['source'];
  spanEndAnchorId?: Id;
  tag?: string;
  name?: string;
}

/** Build a notch object with Notch Setup defaults (does not insert it). */
export function makeNotch(doc: Document, piece: Piece, o: AddNotchOptions): Notch {
  const type = o.type ?? 'slit';
  const setup = doc.style.settings.notchSetup[type];
  const n: Notch = {
    id: newId('n'), contourId: o.contourId ?? piece.sew.id, placement: o.placement, type,
    depth: o.depth ?? setup.depth, width: o.width ?? setup.width, angleDeg: o.angleDeg ?? 0,
    source: o.source ?? 'manual',
  };
  if (o.mode) n.mode = o.mode;
  if (o.cornerDir) n.cornerDir = o.cornerDir;
  if (o.spanEndAnchorId) n.spanEndAnchorId = o.spanEndAnchorId;
  if (o.tag) n.tag = o.tag;
  if (o.name) n.name = o.name;
  return n;
}

export function addNotch(doc: Document, piece: Piece, o: AddNotchOptions): Notch {
  return doc.transact('Add notch', () => {
    const p = livePiece(doc, piece);
    const n = makeNotch(doc, p, o);
    notchContour(p, n.contourId); // validate
    p.notches.push(n);
    return n;
  });
}

/** Corner notch at a grade corner, oriented along the previous or next segment. */
export function addCornerNotch(doc: Document, piece: Piece, anchorId: Id, dir: 'prev' | 'next', o: Partial<AddNotchOptions> = {}): Notch {
  return addNotch(doc, piece, { ...o, placement: { kind: 'anchor', anchorId }, cornerDir: dir });
}

/**
 * Floating placement for a point at arc length s (base size) on a contour, relative to the grade
 * segment that contains it. Per-size distances default to constant (base value) for fromPrev/fromNext.
 */
export function placementAt(doc: Document, piece: Piece, contourId: Id, s: number, kind: 'fromPrev' | 'fromNext' | 'proportional'): NotchPlacement {
  const contour = notchContour(piece, contourId);
  const line = doc.sizeLine(piece);
  const r = resolveContour(contour, line, line.baseSizeId);
  const k = segmentIndexAt(r, s);
  if (k < 0) throw new Error('Contour has no grade anchors');
  const ia = r.gradeIdx[k];
  const ib = nextGradeIndex(contour, ia);
  const sA = anchorArcS(r, ia);
  const constant = (v: number) => { const m: Record<SizeId, number> = {}; for (const id of sizeIds(line)) m[id] = v; return m; };
  if (kind === 'fromPrev' || ib < 0) return { kind: 'fromPrev', anchorId: contour.points[ia].id, dist: constant(forwardDist(r, sA, s)) };
  const sB = anchorArcS(r, ib);
  if (kind === 'fromNext') return { kind: 'fromNext', anchorId: contour.points[ib].id, dist: constant(forwardDist(r, s, sB)) };
  const L = spanLen(r, sA, sB, ib === ia);
  return { kind: 'proportional', anchorId: contour.points[ia].id, pct: L > 0 ? (forwardDist(r, sA, s) / L) * 100 : 0 };
}

/** Add a floating notch at the contour point closest to `pt` (base size). */
export function addNotchAtPoint(doc: Document, piece: Piece, pt: Vec, kind: 'fromPrev' | 'fromNext' | 'proportional' = 'fromPrev', o: Partial<AddNotchOptions> = {}): Notch {
  const p = livePiece(doc, piece);
  const contourId = o.contourId ?? p.sew.id;
  const r = resolveFresh(doc, p, contourId);
  const { s } = closestS(r, pt);
  return addNotch(doc, p, { ...o, contourId, placement: placementAt(doc, p, contourId, s, kind) });
}

// ───────────────────────── cross notches ─────────────────────────

export interface CrossNotchOptions extends Partial<AddNotchOptions> {
  internalContourId: Id;
  end: 'start' | 'end';
  /** 'along' = continue the line past its end; 'perp' = perpendicular (nearest side) */
  direction: 'along' | 'perp' | 'perpLeft' | 'perpRight';
  /** rotate the notch so it lies along the throw direction (default false = perpendicular to perimeter) */
  alignToThrow?: boolean;
}

/**
 * Cross Notch: throw a ray from an internal line's end point (along its direction or perpendicular
 * to it) to the perimeter, and create a floating (fromPrev) notch there with per-size distances
 * computed from each size's own intersection — so it follows the internal line's grading.
 */
export function crossNotch(doc: Document, piece: Piece, o: CrossNotchOptions): Notch | null {
  const p = livePiece(doc, piece);
  const line = doc.sizeLine(p);
  const ids = doc.sizesOf(p);
  const base = line.baseSizeId;
  let side: 1 | -1 = 1;
  const throwFor = (sid: SizeId, decideSide: boolean) => {
    const ri = resolveFresh(doc, p, o.internalContourId, sid);
    const pts = ri.pts;
    if (pts.length < 2) return null;
    const e = o.end === 'end' ? pts[pts.length - 1] : pts[0];
    const along = o.end === 'end' ? norm(sub(pts[pts.length - 1], pts[pts.length - 2])) : norm(sub(pts[0], pts[1]));
    const rs = resolveFresh(doc, p, p.sew.id, sid);
    if (o.direction === 'along') { const h = rayHitContour(e, along, rs, -1e-7); return h ? { ...h, d: along, rs } : null; }
    const left = { x: -along.y, y: along.x };
    if (o.direction === 'perpLeft') side = 1; else if (o.direction === 'perpRight') side = -1;
    else if (decideSide) {
      const hl = rayHitContour(e, left, rs, -1e-7), hr = rayHitContour(e, mul(left, -1), rs, -1e-7);
      side = !hr || (hl && hl.t <= hr.t) ? 1 : -1;
    }
    const d = mul(left, side);
    const h = rayHitContour(e, d, rs, -1e-7);
    return h ? { ...h, d, rs } : null;
  };
  const hb = throwFor(base, true);
  if (!hb) return null;
  const k = segmentIndexAt(hb.rs, hb.s);
  const ia = hb.rs.gradeIdx[k];
  const anchorId = p.sew.points[ia].id;
  const dist: Record<SizeId, number> = {};
  const baseDist = forwardDist(hb.rs, anchorArcS(hb.rs, ia), hb.s);
  for (const sid of ids) {
    if (sid === base) { dist[sid] = baseDist; continue; }
    const h = throwFor(sid, false);
    dist[sid] = h ? forwardDist(h.rs, anchorArcS(h.rs, ia), h.s) : baseDist;
  }
  let angleDeg = o.angleDeg ?? 0;
  if (o.alignToThrow) {
    const ap = arcPoint(hb.rs, hb.s);
    const nrm = outwardNormal(ap.tangent, contourCCW(hb.rs));
    angleDeg = deg(angleBetween(nrm, dot(hb.d, nrm) >= 0 ? hb.d : mul(hb.d, -1)));
  }
  return addNotch(doc, p, { ...o, contourId: p.sew.id, angleDeg, source: 'cross', placement: { kind: 'fromPrev', anchorId, dist } });
}

// ───────────────────────── add points for notches ─────────────────────────

/**
 * Add Points for Notches: convert floating notches to anchored ones by inserting a grade anchor at
 * each notch position (base size), graded per size so it stays where the notch was in every size.
 * Base-size geometry is preserved exactly (Bézier split for curved spans); the neighbouring anchors'
 * handles are frozen to their base values and curve points of the split segment get explicit grading
 * equal to their current interpolated offsets, so other anchors do not move in any size.
 * Returns the ids of the anchors used.
 */
export function addPointsForNotches(doc: Document, piece: Piece, notchIds?: Id[]): Id[] {
  return doc.transact('Add points for notches', () => {
    const p = livePiece(doc, piece);
    const line = doc.sizeLine(p);
    const ids = sizeIds(line);
    const base = line.baseSizeId;
    const out: Id[] = [];
    const targets = p.notches.filter(n => n.placement.kind !== 'anchor' && (!notchIds || notchIds.includes(n.id)));
    for (const notch of targets) {
      const contour = notchContour(p, notch.contourId);
      // per-size notch positions BEFORE insertion
      const posBy: Record<SizeId, Vec> = {};
      const anchorPosBy: Record<SizeId, Vec[]> = {};
      for (const sid of ids) {
        const r = resolveContour(contour, line, sid);
        posBy[sid] = arcPoint(r, notchArcLength(doc, p, notch, sid, r)).pt;
        anchorPosBy[sid] = r.anchorPos;
      }
      const r = resolveContour(contour, line, base);
      const s = notchArcLength(doc, p, notch, base, r);
      const n = contour.points.length;
      // existing anchor at the spot?
      const hitIdx = contour.points.findIndex((_, i) => Math.abs(forwardDist(r, anchorArcS(r, i), s)) < 1e-6 || Math.abs(forwardDist(r, s, anchorArcS(r, i))) < 1e-6);
      if (hitIdx >= 0) {
        const a = contour.points[hitIdx];
        if (a.kind !== 'grade') {
          freezeCurveGrading(contour, line, anchorPosBy, hitIdx);
          a.kind = 'grade';
        }
        a.flags.notchAnchor = true;
        notch.placement = { kind: 'anchor', anchorId: a.id };
        out.push(a.id);
        continue;
      }
      // span i → j containing s
      let i = -1;
      const spans = contour.closed ? n : n - 1;
      for (let q = 0; q < spans; q++) {
        const j = (q + 1) % n;
        const sa = anchorArcS(r, q);
        const L = contour.closed ? forwardDist(r, sa, anchorArcS(r, j)) || contourLength(r) : anchorArcS(r, j) - sa;
        const d = contour.closed ? forwardDist(r, sa, s) : s - sa;
        if (d >= 0 && d < L) { i = q; break; }
      }
      if (i < 0) continue;
      const j = (i + 1) % n;
      // pin proportional notches on this contour to their current span end before topology changes
      for (const other of p.notches) {
        if (other.contourId !== contour.id || other.placement.kind !== 'proportional' || other.spanEndAnchorId || other === notch) continue;
        const oa = contour.points.findIndex(a => a.id === other.placement.anchorId);
        const ob = oa >= 0 ? nextGradeIndex(contour, oa) : -1;
        if (ob >= 0) other.spanEndAnchorId = contour.points[ob].id;
      }
      // local Bézier parameter of s inside span i
      const ia = r.anchorIndex[i];
      let ib = r.anchorIndex[j];
      if (ib <= ia) ib = r.pts.length;
      const nS = ib - ia;
      let k = ia;
      while (k < ib - 1 && r.cum[k + 1] < s - 1e-12) k++;
      const segL = r.cum[k + 1] - r.cum[k];
      const f = segL > 1e-12 ? Math.max(0, Math.min(1, (s - r.cum[k]) / segL)) : 0;
      const t = (k - ia + f) / nS;
      const p0 = r.anchorPos[i], p3 = r.anchorPos[j];
      const p1 = r.handles[i].hOut, p2 = r.handles[j].hIn;
      const straight = nS === 1;
      // freeze neighbour handles + curve grading of the split grade segment
      for (const q of [i, j]) {
        const A = contour.points[q];
        A.hIn = sub(r.handles[q].hIn, r.anchorPos[q]);
        A.hOut = sub(r.handles[q].hOut, r.anchorPos[q]);
      }
      freezeCurveGrading(contour, line, anchorPosBy, i);
      const absG: Record<SizeId, GradeInc> = {};
      for (const sid of ids) absG[sid] = { dx: posBy[sid].x - posBy[base].x, dy: posBy[sid].y - posBy[base].y };
      const pg = prevGradeIndex(contour, i);
      let anchor: Anchor;
      if (straight) {
        const m = lerp(p0, p3, t);
        anchor = makeAnchor(m.x, m.y, { kind: 'grade', smooth: false });
      } else {
        const q0 = lerp(p0, p1, t), q1 = lerp(p1, p2, t), q2 = lerp(p2, p3, t);
        const r0 = lerp(q0, q1, t), r1 = lerp(q1, q2, t), m = lerp(r0, r1, t);
        contour.points[i].hOut = sub(q0, p0);
        contour.points[j].hIn = sub(q2, p3);
        anchor = makeAnchor(m.x, m.y, { kind: 'grade', smooth: true, hIn: sub(r0, m), hOut: sub(r1, m) });
      }
      anchor.grade = absoluteToIncremental(absG, line);
      anchor.flags = { notchAnchor: true };
      if (pg >= 0 && contour.points[pg].seamAfter !== undefined) anchor.seamAfter = contour.points[pg].seamAfter;
      contour.points.splice(i + 1, 0, anchor);
      notch.placement = { kind: 'anchor', anchorId: anchor.id };
      out.push(anchor.id);
    }
    return out;
  });
}

/** Give curve points in the grade segment around index i explicit grading equal to their current offsets. */
function freezeCurveGrading(contour: Contour, line: SizeLine, anchorPosBy: Record<SizeId, Vec[]>, i: number) {
  const n = contour.points.length;
  const pg = prevGradeIndex(contour, i);
  const start = pg >= 0 ? pg : 0;
  const base = line.baseSizeId;
  for (let k = 1; k <= n; k++) {
    const q = contour.closed ? (start + k) % n : start + k;
    if (q >= n || q === start) break;
    const a = contour.points[q];
    if (a.kind === 'grade') break;
    if (Object.keys(a.grade ?? {}).length > 0) continue;
    const absG: Record<SizeId, GradeInc> = {};
    for (const s of line.sizes) {
      const P = anchorPosBy[s.id][q], B = anchorPosBy[base][q];
      absG[s.id] = { dx: P.x - B.x, dy: P.y - B.y };
    }
    a.grade = absoluteToIncremental(absG, line);
    a.gradeAxisDeg = undefined;
  }
}

// ───────────────────────── global notch grading ─────────────────────────

export interface GlobalNotchGradingOptions {
  notchIds?: Id[];
  contourId?: Id;
  /** fromPrev/fromNext only: 'constant' = base distance in all sizes (default); 'preserve' = keep each size's current position */
  perSize?: 'constant' | 'preserve';
}

/**
 * Global Notch Grading: convert floating notches to the given placement rule, relative to the grade
 * segment containing the notch (base size), preserving the base-size position exactly.
 * Anchored notches are left untouched. Returns the number of notches converted.
 */
export function globalNotchGrading(doc: Document, piece: Piece, rule: 'fromPrev' | 'fromNext' | 'proportional', o: GlobalNotchGradingOptions = {}): number {
  return doc.transact('Global notch grading', () => {
    const p = livePiece(doc, piece);
    const line = doc.sizeLine(p);
    const base = line.baseSizeId;
    let count = 0;
    for (const notch of p.notches) {
      if (notch.placement.kind === 'anchor') continue;
      if (o.notchIds && !o.notchIds.includes(notch.id)) continue;
      if (o.contourId && notch.contourId !== o.contourId) continue;
      const contour = notchContour(p, notch.contourId);
      const rs: Record<SizeId, ResolvedContour> = {};
      const ss: Record<SizeId, number> = {};
      for (const s of line.sizes) { rs[s.id] = resolveContour(contour, line, s.id); ss[s.id] = notchArcLength(doc, p, notch, s.id, rs[s.id]); }
      const pl = placementAt(doc, p, contour.id, ss[base], rule);
      if (o.perSize === 'preserve' && (pl.kind === 'fromPrev' || pl.kind === 'fromNext')) {
        const ai = contour.points.findIndex(a => a.id === pl.anchorId);
        for (const s of line.sizes) {
          const r = rs[s.id], sA = anchorArcS(r, ai);
          pl.dist[s.id] = pl.kind === 'fromPrev' ? forwardDist(r, sA, ss[s.id]) : forwardDist(r, ss[s.id], sA);
        }
      }
      notch.placement = pl;
      delete notch.spanEndAnchorId;
      count++;
    }
    return count;
  });
}

// ───────────────────────── per-size distance grid ─────────────────────────

function gridNotch(p: Piece, notchId: Id): Notch & { placement: { kind: 'fromPrev' | 'fromNext'; anchorId: Id; dist: Record<SizeId, number> } } {
  const n = p.notches.find(n => n.id === notchId);
  if (!n) throw new Error('No notch ' + notchId);
  if (n.placement.kind !== 'fromPrev' && n.placement.kind !== 'fromNext') throw new Error('Notch ' + notchId + ' has no per-size distances (placement ' + n.placement.kind + ')');
  return n as any;
}

/** Per-size distance grid of a fromPrev/fromNext notch, in size-line order (missing sizes → base value). */
export function notchDistanceGrid(doc: Document, piece: Piece, notchId: Id): { sizeId: SizeId; name: string; value: number }[] {
  const p = livePiece(doc, piece);
  const n = gridNotch(p, notchId);
  const line = doc.sizeLine(p);
  return line.sizes.map(s => ({ sizeId: s.id, name: s.name, value: distFor(n.placement.dist, s.id, line.baseSizeId) }));
}

export function setNotchDistance(doc: Document, piece: Piece, notchId: Id, sizeId: SizeId, val: number): void {
  doc.transact('Set notch distance', () => { gridNotch(livePiece(doc, piece), notchId).placement.dist[sizeId] = val; });
}

export function fillAllNotchDistances(doc: Document, piece: Piece, notchId: Id, val: number): void {
  doc.transact('Fill notch distances', () => {
    const p = livePiece(doc, piece);
    const n = gridNotch(p, notchId);
    for (const s of doc.sizeLine(p).sizes) n.placement.dist[s.id] = val;
  });
}

/** Given two sizes' values, extend their per-size-step increment linearly to every size. */
export function extrapolateNotchIncrement(doc: Document, piece: Piece, notchId: Id, sizeA: SizeId, sizeB: SizeId): void {
  doc.transact('Extrapolate notch increment', () => {
    const p = livePiece(doc, piece);
    const n = gridNotch(p, notchId);
    const line = doc.sizeLine(p);
    const ids = sizeIds(line);
    const iA = ids.indexOf(sizeA), iB = ids.indexOf(sizeB);
    if (iA < 0 || iB < 0 || iA === iB) throw new Error('extrapolateIncrement needs two distinct sizes');
    const vA = distFor(n.placement.dist, sizeA, line.baseSizeId), vB = distFor(n.placement.dist, sizeB, line.baseSizeId);
    const inc = (vB - vA) / (iB - iA);
    ids.forEach((id, i) => { n.placement.dist[id] = vA + (i - iA) * inc; });
  });
}

/**
 * Paste a TSV block (Excel copy) into notch distance grids. Rows = notches (in `notchIds` order),
 * columns = sizes in size-line order. An optional header row of size names maps columns to sizes.
 * A single notch also accepts one column of values (one size per row). Values are in style.units
 * (fractions accepted). Empty / unparsable cells are skipped. Returns the number of cells applied.
 */
export function pasteNotchGrid(doc: Document, piece: Piece, notchIds: Id | Id[], tsv: string): number {
  const ids = Array.isArray(notchIds) ? notchIds : [notchIds];
  return doc.transact('Paste notch grid', () => {
    const p = livePiece(doc, piece);
    const line = doc.sizeLine(p);
    const unit = doc.style.units;
    let rows = tsv.replace(/\r/g, '').split('\n').filter(l => l.trim().length > 0).map(l => l.split(/\t|;/).map(c => c.trim()));
    let cols: (SizeId | null)[] = line.sizes.map(s => s.id);
    const byName = new Map(line.sizes.map(s => [s.name.toLowerCase(), s.id] as const));
    if (rows.length && rows[0].some(c => byName.has(c.toLowerCase()))) {
      cols = rows[0].map(c => byName.get(c.toLowerCase()) ?? null);
      rows = rows.slice(1);
    }
    if (ids.length === 1 && rows.length > 1 && rows.every(r => r.length === 1)) rows = [rows.map(r => r[0])];
    let applied = 0;
    rows.forEach((row, ri) => {
      if (ri >= ids.length) return;
      const n = gridNotch(p, ids[ri]);
      row.forEach((cell, ci) => {
        const sid = cols[ci];
        if (!sid || cell === '') return;
        const v = parseLength(cell, unit);
        if (Number.isNaN(v)) return;
        n.placement.dist[sid] = v; applied++;
      });
    });
    return applied;
  });
}

/** Spec-named grid helpers (namespaced to avoid export collisions). */
export const notchGrid = {
  get: notchDistanceGrid,
  setNotchDistance,
  fillAll: fillAllNotchDistances,
  extrapolateIncrement: extrapolateNotchIncrement,
  pasteGrid: pasteNotchGrid,
};

// ───────────────────────── queries ─────────────────────────

export interface NotchOnSegment {
  notch: Notch;
  /** running distance from fromAnchor along the span (mm) */
  dist: number;
  /** arc length on contour */
  s: number;
  pos: Vec;
}

/**
 * Notches lying on the forward span fromAnchorId → toAnchorId of a contour (inclusive ends), with
 * running distances from the start, sorted by distance. A closed contour with from == to = full loop.
 */
export function notchesOnSegment(doc: Document, piece: Piece, contourId: Id, fromAnchorId: Id, toAnchorId: Id, sizeId?: SizeId): NotchOnSegment[] {
  const p = livePiece(doc, piece);
  const line = doc.sizeLine(p);
  const sid = sizeId ?? line.baseSizeId;
  const contour = notchContour(p, contourId);
  const r = resolveContour(contour, line, sid);
  const ia = doc.anchorIndex(contour, fromAnchorId), ib = doc.anchorIndex(contour, toAnchorId);
  const sA = anchorArcS(r, ia);
  const L = spanLen(r, sA, anchorArcS(r, ib), ia === ib);
  const out: NotchOnSegment[] = [];
  for (const n of p.notches) {
    if (n.contourId !== contourId) continue;
    const s = notchArcLength(doc, p, n, sid, r);
    let d = r.closed ? forwardDist(r, sA, s) : s - sA;
    if (r.closed && ia === ib && d === 0 && L > 0) { out.push({ notch: n, dist: 0, s, pos: arcPoint(r, s).pt }); continue; }
    if (d < -1e-6 || d > L + 1e-6) continue;
    d = Math.max(0, Math.min(L, d));
    out.push({ notch: n, dist: d, s, pos: arcPoint(r, s).pt });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

/** Span length fromAnchor → toAnchor (forward) for a size. */
export function segmentLength(doc: Document, piece: Piece, contourId: Id, fromAnchorId: Id, toAnchorId: Id, sizeId?: SizeId): number {
  const p = livePiece(doc, piece);
  const contour = notchContour(p, contourId);
  const r = resolveContour(contour, doc.sizeLine(p), sizeId ?? doc.baseSize(p));
  const ia = doc.anchorIndex(contour, fromAnchorId), ib = doc.anchorIndex(contour, toAnchorId);
  return spanLen(r, anchorArcS(r, ia), anchorArcS(r, ib), ia === ib);
}

