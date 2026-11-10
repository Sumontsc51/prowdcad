/**
 * Internal lines locked to the sew line (AccuMark / CLO "attach"): `Contour.lock` on an internal.
 *
 *  - 'ends'     Endpoints attached: each locked end point stays on its sew span (from → to, forward
 *               along the sew line) at the same fraction of the span ('ratio'), the same distance from
 *               the span start ('start') or from the span end ('end'). Other points of the line keep
 *               their own data.
 *  - 'parallel' The whole internal is the offset of the sew span by `offset` mm (positive = inside),
 *               between two span positions: topstitch, facing and placement lines. Its anchors are
 *               regenerated: grade corners at the ends (and at sharp corners of the offset), smooth
 *               curve points with explicit grading between them, dense enough that the resolved line
 *               is within 0.004 mm of the exact offset of the sampled sew span in every size.
 *  - 'follow'   Rigid follow: the internal translates with one sew anchor, per size (pockets).
 *
 * The lock is a constraint, not a copy: `applyInternalLocks` re-derives the locked geometry from the
 * CURRENT sew line in every size. `Document.transact` runs it after every top-level edit (and the
 * Move-tool preview runs it on its scratch copy), so the stored internal is never stale: whatever
 * moves, grades, splits or re-shapes the sew span, the internal follows in the same undo step.
 *
 * Point connections keep working: an end point that is point-connected (Piece ▸ Connections) is
 * driven by its connection, not by the lock. Anchors driven by a lock cannot be moved on their own
 * (`isLockDriven`; points.moveIndex refuses them): unlock first. A lock whose sew anchors were
 * deleted is dropped (the internal keeps its last position).
 */
import type { Anchor, Contour, ContourLock, Id, LockEnd, LockMeasure, Piece, SizeId, SizeLine, GradeInc, Style } from '../model/types';
import type { Document } from '../model/doc';
import { resolveContour, anchorPositions, absoluteToIncremental, type ResolvedContour } from '../model/contour';
import { newId } from '../model/factory';
import { Vec, sub, add, dist, norm, dot, cross } from '../geom/vec';
import { offsetPolyline, slice as polySlice, polylineLength, pointAtLength, closestPoint, dedupe, pointInPolygon } from '../geom/poly';
import { arcS, spanLen, spanPoly, pointAt, fwd, closestArc, outwardSign, sizeIds, gradeFromOffsets, positionsBySize, maxDev, jsonClone } from '../geom/draft-geom';

/** Max deviation (mm) of a regenerated parallel line from the exact offset, every size. */
export const PARALLEL_LOCK_TOL = 0.004;
/** An end point within this distance (mm, base size) of the sew line can be attached. */
export const LOCK_ATTACH_TOL = 0.5;

// ───────────────────────── span addressing ─────────────────────────

interface Span { r: ResolvedContour; ia: number; ib: number; sA: number; L: number }

function sewSpan(piece: Piece, line: SizeLine, sid: SizeId, from: Id, to: Id, r?: ResolvedContour): Span | null {
  const pts = piece.sew.points;
  const ia = pts.findIndex(a => a.id === from), ib = pts.findIndex(a => a.id === to);
  if (ia < 0 || ib < 0) return null;
  const rr = r ?? resolveContour(piece.sew, line, sid);
  if (!piece.sew.closed && ib < ia) return null;
  return { r: rr, ia, ib, sA: arcS(rr, ia), L: spanLen(rr, ia, ib) };
}

/** Distance from the span start of a kept position. */
export function lockDistance(measure: LockMeasure, value: number, L: number): number {
  const d = measure === 'ratio' ? value * L : measure === 'start' ? value : L - value;
  return Math.max(0, Math.min(L, d));
}
/** Kept value of a distance from the span start. */
export function lockValue(measure: LockMeasure, d: number, L: number): number {
  return measure === 'ratio' ? (L > 0 ? d / L : 0) : measure === 'start' ? d : L - d;
}

/**
 * The sew grade segment nearest to a base point: `from` = its grade start anchor, `to` = the next
 * grade anchor; `along` = arc distance from `from`; `d` = distance from the sew line. A point on a
 * grade anchor (1e-3 mm) reports the segment that LEAVES it (along = 0).
 */
export function sewSegmentAt(piece: Piece, line: SizeLine, q: Vec, sizeId?: SizeId): { from: Id; to: Id; along: number; length: number; d: number } | null {
  const sew = piece.sew;
  const r = resolveContour(sew, line, sizeId ?? line.baseSizeId);
  const g = r.gradeIdx;
  if (g.length < 1 || r.pts.length < 2) return null;
  const cl = closestArc(r, q);
  for (const gi of g) if (dist(r.anchorPos[gi], q) < 1e-3) {
    const k = g.indexOf(gi);
    const nb = sew.closed ? g[(k + 1) % g.length] : g[Math.min(k + 1, g.length - 1)];
    if (!sew.closed && k === g.length - 1) { const pb = g[Math.max(0, k - 1)]; return { from: sew.points[pb].id, to: sew.points[gi].id, along: spanLen(r, pb, gi), length: spanLen(r, pb, gi), d: dist(r.anchorPos[gi], q) }; }
    return { from: sew.points[gi].id, to: sew.points[nb].id, along: 0, length: spanLen(r, gi, nb), d: dist(r.anchorPos[gi], q) };
  }
  for (let k = 0; k < g.length; k++) {
    if (!sew.closed && k === g.length - 1) break;
    const a = g[k], b = sew.closed ? g[(k + 1) % g.length] : g[k + 1];
    const L = spanLen(r, a, b), d = fwd(r, arcS(r, a), cl.s);
    if (d <= L + 1e-9) return { from: sew.points[a].id, to: sew.points[b].id, along: Math.min(d, L), length: L, d: cl.d };
  }
  return null;
}

// ───────────────────────── writing per-size positions ─────────────────────────

const zeroRec = (line: SizeLine): Record<SizeId, GradeInc> => Object.fromEntries(sizeIds(line).map(s => [s, { dx: 0, dy: 0 }]));

/** Write per-size absolute positions onto anchor `a` (base x/y + world-axis grading). Curve anchors get explicit grading. */
function placeAnchor(a: Anchor, line: SizeLine, pos: Record<SizeId, Vec>): void {
  const base = pos[line.baseSizeId];
  const off: Record<SizeId, Vec> = {};
  for (const s of sizeIds(line)) off[s] = sub(pos[s] ?? base, base);
  let g = gradeFromOffsets(line, off);
  if (a.kind === 'curve' && !Object.keys(g).length) g = zeroRec(line);
  a.x = base.x; a.y = base.y; a.grade = g; delete a.gradeAxisDeg;
}

/** Current per-size positions of every anchor of a contour. */
function posBy(c: Contour, line: SizeLine): Record<SizeId, Vec[]> { return positionsBySize(c, line); }
const near = (p: Vec, q: Vec, tol = 1e-9) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;

// ───────────────────────── resolution ─────────────────────────

function connected(piece: Piece, c: Contour, anchorId: Id): boolean {
  return (piece.connections ?? []).some(pc => pc.internalContourId === c.id && pc.internalAnchorId === anchorId);
}

function applyEnds(piece: Piece, line: SizeLine, c: Contour, lock: Extract<ContourLock, { kind: 'ends' }>): boolean {
  const n = c.points.length;
  const keep: LockEnd[] = [];
  let changed = false;
  const sizes = sizeIds(line);
  const rs = new Map<SizeId, ResolvedContour>();
  const res = (s: SizeId) => { let r = rs.get(s); if (!r) { r = resolveContour(piece.sew, line, s); rs.set(s, r); } return r; };
  let cur: Record<SizeId, Vec[]> | null = null;
  for (const e of lock.ends) {
    const j = c.points.findIndex(a => a.id === e.anchorId);
    // only an END point of an open line can be attached; its sew span must still exist
    if (j < 0 || c.closed || (j !== 0 && j !== n - 1) || !sewSpan(piece, line, line.baseSizeId, e.from, e.to, res(line.baseSizeId))) { changed = true; continue; }
    keep.push(e);
    if (connected(piece, c, e.anchorId)) continue; // a point connection drives it
    const target: Record<SizeId, Vec> = {};
    for (const s of sizes) {
      const sp = sewSpan(piece, line, s, e.from, e.to, res(s))!;
      target[s] = pointAt(sp.r, sp.sA + lockDistance(e.measure, e.value, sp.L)).pt;
    }
    cur ??= posBy(c, line);
    if (sizes.every(s => near(cur![s][j], target[s]))) continue;
    placeAnchor(c.points[j], line, target);
    cur = null; changed = true;
  }
  if (keep.length !== lock.ends.length) { if (keep.length) lock.ends = keep; else delete c.lock; }
  return changed;
}

function applyFollow(piece: Piece, line: SizeLine, c: Contour, lock: Extract<ContourLock, { kind: 'follow' }>): boolean {
  const k = piece.sew.points.findIndex(a => a.id === lock.anchorId);
  if (k < 0) { delete c.lock; return true; }
  const sizes = sizeIds(line);
  const P: Record<SizeId, Vec> = {};
  for (const s of sizes) P[s] = anchorPositions(piece.sew.points, line, s, piece.sew.closed)[k];
  const delta: Record<SizeId, Vec> = {};
  let any = false;
  for (const s of sizes) {
    const ref = lock.ref?.[s] ?? P[s];
    delta[s] = sub(P[s], ref);
    if (Math.abs(delta[s].x) > 1e-9 || Math.abs(delta[s].y) > 1e-9) any = true;
  }
  if (!any) { if (!lock.ref || sizes.some(s => !lock.ref[s])) { lock.ref = jsonClone(P); return true; } return false; }
  const b = line.baseSizeId;
  const uniform = sizes.every(s => near(delta[s], delta[b], 1e-9));
  if (uniform) {
    for (const a of c.points) { a.x += delta[b].x; a.y += delta[b].y; }
  } else {
    const cur = posBy(c, line);
    c.points.forEach((a, j) => {
      const t: Record<SizeId, Vec> = {};
      for (const s of sizes) t[s] = add(cur[s][j], delta[s]);
      placeAnchor(a, line, t);
    });
  }
  lock.ref = jsonClone(P);
  return true;
}

/** Turn angle (deg) at vertex i of an open polyline. */
function turnAt(P: Vec[], i: number): number {
  const u = norm(sub(P[i], P[i - 1])), w = norm(sub(P[i + 1], P[i]));
  return Math.abs(Math.atan2(cross(u, w), dot(u, w))) * 180 / Math.PI;
}

/** Exact offset polyline of the locked span range, per size (null when the lock cannot resolve). */
export function parallelLockPolylines(piece: Piece, line: SizeLine, lock: Extract<ContourLock, { kind: 'parallel' }>): Record<SizeId, Vec[]> | null {
  const out: Record<SizeId, Vec[]> = {};
  for (const s of sizeIds(line)) {
    const sp = sewSpan(piece, line, s, lock.from, lock.to);
    if (!sp || sp.L < 1e-6) return null;
    let d0 = lockDistance(lock.measure, lock.a, sp.L), d1 = lockDistance(lock.measure, lock.b, sp.L);
    if (d1 < d0) [d0, d1] = [d1, d0];
    if (d1 - d0 < 1e-6) return null;
    const S = dedupe(polySlice(dedupe(spanPoly(sp.r, sp.ia, sp.ib), 1e-9), d0, d1), 1e-9);
    if (S.length < 2) return null;
    const inward = piece.sew.closed ? -outwardSign(sp.r) : 1;
    const O = Math.abs(lock.offset) < 1e-12 ? S : offsetPolyline(S, { distances: inward * lock.offset, closed: false, join: 'miter', cleanup: true });
    if (O.length < 2) return null;
    out[s] = dedupe(O, 1e-9);
  }
  return out;
}

/** Split indices (vertex indices of sharp corners, ends included) when they agree across sizes. */
function features(O: Record<SizeId, Vec[]>, sizes: SizeId[], base: SizeId): Record<SizeId, number[]> {
  const f: Record<SizeId, number[]> = {};
  for (const s of sizes) {
    const P = O[s]; const ix = [0];
    for (let i = 1; i < P.length - 1; i++) if (turnAt(P, i) > 15) ix.push(i);
    ix.push(P.length - 1); f[s] = ix;
  }
  if (sizes.every(s => f[s].length === f[base].length)) return f;
  return Object.fromEntries(sizes.map(s => [s, [0, O[s].length - 1]]));
}

const parallelMemo = new Map<Id, string>();
const fracMemo = new Map<Id, number[][]>();

function applyParallel(piece: Piece, line: SizeLine, c: Contour, lock: Extract<ContourLock, { kind: 'parallel' }>): boolean {
  if (c.closed) { delete c.lock; return true; }
  const key = JSON.stringify([piece.sew.points, piece.sew.closed, lock, line, c.points]);
  if (parallelMemo.get(c.id) === key) return false;
  const O = parallelLockPolylines(piece, line, lock);
  if (!O) { if (!sewSpan(piece, line, line.baseSizeId, lock.from, lock.to)) { delete c.lock; return true; } return false; }
  const sizes = sizeIds(line), b = line.baseSizeId;
  const F = features(O, sizes, b);
  const nPieces = F[b].length - 1;
  // per feature piece: its sub-polyline per size
  const sub_ = (s: SizeId, k: number) => O[s].slice(F[s][k], F[s][k + 1] + 1);
  const straight = (k: number) => sizes.every(s => { const P = sub_(s, k); const A = P[0], B = P[P.length - 1]; const t = norm(sub(B, A)); return P.every(q => Math.abs(cross(t, sub(q, A))) < 1e-7); });
  // interior arc fractions of every feature piece (uniform ≈ 20 mm to start, refined locally)
  // (the refined fractions of the last run are the starting point: a drag preview re-converges in one pass)
  const cached = fracMemo.get(c.id);
  const fr: number[][] = [];
  for (let k = 0; k < nPieces; k++) {
    if (straight(k)) { fr.push([]); continue; }
    const len = polylineLength(sub_(b, k));
    const n0 = Math.max(2, Math.ceil(len / 20));
    const prev = cached && cached.length === nPieces ? cached[k] : null;
    fr.push(prev && prev.length >= n0 - 1 && prev.length < 4 * len ? prev.slice() : Array.from({ length: n0 - 1 }, (_, j) => (j + 1) / n0));
  }
  const build = () => {
    const pos: Record<SizeId, Vec[]> = {}; const kinds: ('end' | 'corner' | 'curve')[] = [];
    for (const s of sizes) {
      const arr: Vec[] = [];
      for (let k = 0; k < nPieces; k++) {
        const P = sub_(s, k), L = polylineLength(P);
        if (k === 0) arr.push({ ...P[0] });
        for (const f of fr[k]) arr.push(pointAtLength(P, L * f).pt);
        arr.push({ ...P[P.length - 1] });
      }
      pos[s] = arr;
    }
    for (let k = 0; k < nPieces; k++) { if (k === 0) kinds.push('end'); for (let j = 0; j < fr[k].length; j++) kinds.push('curve'); kinds.push(k === nPieces - 1 ? 'end' : 'corner'); }
    return { pos, kinds };
  };
  const temp = (pts: Vec[], kinds: string[]): Contour => ({ id: 'tmp', type: 'internal', closed: false, points: pts.map((p, i) => ({ id: 't' + i, x: p.x, y: p.y, kind: kinds[i] === 'curve' ? 'curve' : 'grade', smooth: kinds[i] === 'curve', grade: {}, flags: {} })) });
  let built = build();
  for (let iter = 0; iter < 12; iter++) {
    // spans (piece k, interval j between fractions) whose resolved curve is off the exact offset in some size
    const split = new Map<number, Set<number>>();
    for (const s of sizes) {
      const rr = resolveContour(temp(built.pos[s], built.kinds), line, line.baseSizeId);
      let ai = 0;
      for (let k = 0; k < nPieces; k++) {
        const fs = [0, ...fr[k], 1];
        const P = sub_(s, k), L = polylineLength(P);
        for (let j = 0; j + 1 < fs.length; j++, ai++) {
          if (fs.length === 2) continue;
          const R = rr.pts.slice(rr.anchorIndex[ai], rr.anchorIndex[ai + 1] + 1);
          const Q = polySlice(P, L * fs[j], L * fs[j + 1]);
          const e = Math.max(maxDev(R, Q), maxDev(Q, R));
          if (e > PARALLEL_LOCK_TOL && (fs[j + 1] - fs[j]) * L > 0.2) { const m = split.get(k) ?? new Set(); m.add(j); split.set(k, m); }
        }
      }
    }
    if (!split.size) break;
    for (const [k, js] of split) {
      const fs = [0, ...fr[k], 1];
      for (const j of js) fr[k].push((fs[j] + fs[j + 1]) / 2);
      fr[k].sort((x, y) => x - y);
    }
    built = build();
  }
  fracMemo.set(c.id, fr);
  // compare with what is stored
  const M = built.kinds.length;
  const cur = posBy(c, line);
  const same = c.points.length === M && c.points.every((a, i) => (built.kinds[i] === 'curve') === (a.kind === 'curve') && sizes.every(s => near(cur[s][i], built.pos[s][i], 1e-7)));
  if (!same) {
    const oldIds = c.points.map(a => a.id);
    const first = c.points[0], last = c.points[c.points.length - 1];
    const pts: Anchor[] = built.kinds.map((k, i) => {
      const id = i === 0 ? first?.id : i === M - 1 ? last?.id : oldIds[i] && i < oldIds.length - 1 ? oldIds[i] : undefined;
      const src = i === 0 ? first : i === M - 1 ? last : undefined;
      const a: Anchor = { id: id ?? newId('p'), x: 0, y: 0, kind: k === 'curve' ? 'curve' : 'grade', smooth: k === 'curve', grade: {}, flags: src ? { ...src.flags } : {} };
      if (src?.name) a.name = src.name;
      placeAnchor(a, line, Object.fromEntries(sizes.map(s => [s, built.pos[s][i]])));
      return a;
    });
    // never reuse an id twice (old interior ids beyond the old end)
    const seen = new Set<Id>();
    for (const a of pts) { if (seen.has(a.id)) a.id = newId('p'); seen.add(a.id); }
    c.points = pts;
    piece.notches = piece.notches.filter(nt => nt.contourId !== c.id || pts.some(a => a.id === nt.placement.anchorId));
    piece.connections = piece.connections.filter(pc => pc.internalContourId !== c.id || pts.some(a => a.id === pc.internalAnchorId));
  }
  parallelMemo.set(c.id, JSON.stringify([piece.sew.points, piece.sew.closed, lock, line, c.points]));
  return !same;
}

/**
 * Re-apply every internal-line lock of a piece from its current sew line (all sizes). Mutates the
 * piece; returns true when anything changed. Called by `Document.transact` after each edit.
 */
export function applyInternalLocks(piece: Piece, line: SizeLine): boolean {
  let changed = false;
  if (!piece.sew || piece.sew.points.length < 2) return false;
  for (const c of piece.internals) {
    const lock = c.lock; if (!lock) continue;
    try {
      if (lock.kind === 'ends') changed = applyEnds(piece, line, c, lock) || changed;
      else if (lock.kind === 'parallel') changed = applyParallel(piece, line, c, lock) || changed;
      else if (lock.kind === 'follow') changed = applyFollow(piece, line, c, lock) || changed;
      else { delete (c as Contour).lock; changed = true; }
    } catch { /* a lock that cannot resolve leaves the line where it is */ }
  }
  return changed;
}

/** Re-apply the locks of every piece of a style (pieces without locks cost nothing). */
export function applyStyleLocks(style: Style, lineOf: (p: Piece) => SizeLine): void {
  for (const p of style.pieces) if (p.internals.some(c => c.lock)) applyInternalLocks(p, lineOf(p));
}

/** True when the lock of the internal drives this anchor (it cannot be moved on its own). */
export function isLockDriven(piece: Piece, contourId: Id, anchorId: Id): boolean {
  const c = piece.internals.find(q => q.id === contourId);
  const lock = c?.lock; if (!c || !lock) return false;
  if (lock.kind === 'parallel') return c.points.some(a => a.id === anchorId);
  if (lock.kind === 'ends') return lock.ends.some(e => e.anchorId === anchorId) && !connected(piece, c, anchorId);
  return false;
}

/** Human-readable summary of a lock (Inspector / status bar). */
export function lockSummary(piece: Piece, c: Contour): string {
  const L = c.lock; if (!L) return 'not locked';
  const pn = (id: Id) => { const i = piece.sew.points.findIndex(a => a.id === id); return i < 0 ? '?' : String(i + 1); };
  const how = (m: LockMeasure) => (m === 'ratio' ? 'proportional' : m === 'start' ? 'distance from start' : 'distance from end');
  if (L.kind === 'ends') return `end point${L.ends.length > 1 ? 's' : ''} on segment${L.ends.length > 1 ? 's' : ''} ${L.ends.map(e => `${pn(e.from)}→${pn(e.to)}`).join(', ')} (${how(L.ends[0].measure)})`;
  if (L.kind === 'parallel') return `parallel to segment ${pn(L.from)}→${pn(L.to)} at ${Math.round(L.offset * 100) / 100} mm (${how(L.measure)})`;
  return `follows sew point ${pn(L.anchorId)}`;
}

// ───────────────────────── commands ─────────────────────────

function internal(piece: Piece, contourId: Id): Contour {
  const c = piece.internals.find(q => q.id === contourId);
  if (!c) throw new Error('No internal line ' + contourId);
  return c;
}
function checkSpan(piece: Piece, line: SizeLine, from: Id, to: Id) {
  if (!sewSpan(piece, line, line.baseSizeId, from, to)) throw new Error('The segment must run between two points of the sew line');
}

export interface LockEndsOptions {
  measure?: LockMeasure;
  /** attach only these ends (default: every end within `tol` of the sew line) */
  which?: 'both' | 'start' | 'end';
  /** attach to this sew span instead of the segment under each end */
  span?: { from: Id; to: Id };
  /** mm (default LOCK_ATTACH_TOL) */
  tol?: number;
  /** detect the ends on this size's sew line (a line drawn while a graded size is shown); default base */
  sizeId?: SizeId;
}

/** Ends that `lockInternalEnds` would attach (base size), without changing anything. */
export function lockableEnds(piece: Piece, line: SizeLine, c: Contour, o: LockEndsOptions = {}): LockEnd[] {
  if (c.closed || c.points.length < 2) return [];
  const tol = o.tol ?? LOCK_ATTACH_TOL;
  const sid = o.sizeId ?? line.baseSizeId;
  const r = resolveContour(c, line, sid);
  const out: LockEnd[] = [];
  const ends: [number, 'start' | 'end'][] = [[0, 'start'], [c.points.length - 1, 'end']];
  for (const [j, w] of ends) {
    if (o.which && o.which !== 'both' && o.which !== w) continue;
    const q = r.anchorPos[j];
    let from: Id, to: Id, along: number, L: number;
    if (o.span) {
      const sp = sewSpan(piece, line, sid, o.span.from, o.span.to); if (!sp) continue;
      const S = spanPoly(sp.r, sp.ia, sp.ib);
      const cp = closestPoint(S, q); if (cp.d > tol) continue;
      ({ from, to } = o.span); along = Math.min(cp.s, sp.L); L = sp.L;
    } else {
      const g = sewSegmentAt(piece, line, q, sid); if (!g || g.d > tol) continue;
      ({ from, to, along } = g); L = g.length;
    }
    const measure = o.measure ?? 'ratio';
    out.push({ anchorId: c.points[j].id, from, to, measure, value: lockValue(measure, along, L) });
  }
  return out;
}

/**
 * Lock the end points of an open internal line to the sew line (Endpoints attached). Every end within
 * `tol` of the sew line is attached to the segment it lies on (or to `span`), at its current position
 * kept as `measure`. Ends that are already locked are re-attached. Returns the number of ends locked.
 */
export function lockInternalEnds(doc: Document, pieceId: Id, contourId: Id, o: LockEndsOptions = {}): number {
  return doc.transact('Lock internal to segment', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    if (piece.locked) throw new Error('Piece is locked');
    const c = internal(piece, contourId);
    if (c.closed) throw new Error('Endpoints lock needs an open internal line (use Follow point for a closed shape)');
    if (o.span) checkSpan(piece, line, o.span.from, o.span.to);
    const ends = lockableEnds(piece, line, c, o);
    if (!ends.length) throw new Error('No end point of the line lies on the sew line (within ' + (o.tol ?? LOCK_ATTACH_TOL) + ' mm)');
    const prev = c.lock?.kind === 'ends' ? c.lock.ends.filter(e => !ends.some(x => x.anchorId === e.anchorId)) : [];
    c.lock = { kind: 'ends', ends: [...prev, ...ends] };
    applyInternalLocks(piece, line);
    return ends.length;
  });
}

export interface LockParallelOptions {
  /** mm, positive = inside the piece. Default: the line's current (median) distance from the span */
  offset?: number;
  measure?: LockMeasure;
  /** span positions of the two ends, as `measure` values. Default: projections of the line's end points */
  a?: number; b?: number;
}

/** Lock an open internal line parallel to the sew span from → to (it is regenerated as the exact offset). */
export function lockInternalParallel(doc: Document, pieceId: Id, contourId: Id, span: { from: Id; to: Id }, o: LockParallelOptions = {}): void {
  doc.transact('Lock internal parallel', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    if (piece.locked) throw new Error('Piece is locked');
    const c = internal(piece, contourId);
    if (c.closed) throw new Error('Parallel lock needs an open internal line');
    checkSpan(piece, line, span.from, span.to);
    const sp = sewSpan(piece, line, line.baseSizeId, span.from, span.to)!;
    const S = spanPoly(sp.r, sp.ia, sp.ib);
    const ir = resolveContour(c, line, line.baseSizeId);
    const sewPoly = sp.r.pts;
    const measure = o.measure ?? 'ratio';
    let offset = o.offset;
    if (offset === undefined) {
      const ds = ir.pts.map(q => { const cp = closestPoint(S, q); return (piece.sew.closed && !pointInPolygon(q, sewPoly) ? -1 : 1) * cp.d; }).sort((x, y) => x - y);
      offset = ds[Math.floor(ds.length / 2)] ?? 0;
    }
    let a = o.a, b = o.b;
    if (a === undefined || b === undefined) {
      const s0 = closestPoint(S, ir.anchorPos[0]).s, s1 = closestPoint(S, ir.anchorPos[c.points.length - 1]).s;
      const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
      a ??= lockValue(measure, hi - lo < 1e-6 ? 0 : lo, sp.L); b ??= lockValue(measure, hi - lo < 1e-6 ? sp.L : hi, sp.L);
    }
    c.lock = { kind: 'parallel', from: span.from, to: span.to, offset, measure, a, b };
    parallelMemo.delete(c.id);
    applyInternalLocks(piece, line);
  });
}

/** Lock an internal (open or closed) to follow a sew anchor rigidly, per size. */
export function lockInternalFollow(doc: Document, pieceId: Id, contourId: Id, anchorId: Id): void {
  doc.transact('Lock internal to point', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    if (piece.locked) throw new Error('Piece is locked');
    const c = internal(piece, contourId);
    const k = piece.sew.points.findIndex(a => a.id === anchorId);
    if (k < 0) throw new Error('Pick a point of the sew line');
    const ref: Record<SizeId, Vec> = {};
    for (const s of sizeIds(line)) ref[s] = anchorPositions(piece.sew.points, line, s, piece.sew.closed)[k];
    c.lock = { kind: 'follow', anchorId, ref: jsonClone(ref) };
  });
}

/** Remove the lock of an internal line (it keeps its current geometry). */
export function unlockInternal(doc: Document, pieceId: Id, contourId: Id): void {
  doc.transact('Unlock internal', () => {
    const c = internal(doc.piece(pieceId), contourId);
    delete c.lock; parallelMemo.delete(c.id);
  });
}

/** Change the kept measure ('ratio' / 'start' / 'end') of a lock without moving the line. */
export function setLockMeasure(doc: Document, pieceId: Id, contourId: Id, measure: LockMeasure): void {
  doc.transact('Lock measure', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const c = internal(piece, contourId);
    const L0 = c.lock; if (!L0 || L0.kind === 'follow') return;
    const conv = (from: Id, to: Id, m: LockMeasure, v: number) => { const sp = sewSpan(piece, line, line.baseSizeId, from, to); if (!sp) return v; return lockValue(measure, lockDistance(m, v, sp.L), sp.L); };
    if (L0.kind === 'ends') L0.ends = L0.ends.map(e => ({ ...e, value: conv(e.from, e.to, e.measure, e.value), measure }));
    else { L0.a = conv(L0.from, L0.to, L0.measure, L0.a); L0.b = conv(L0.from, L0.to, L0.measure, L0.b); L0.measure = measure; }
  });
}

/** Set the offset (mm, + inside) of a parallel lock. */
export function setLockOffset(doc: Document, pieceId: Id, contourId: Id, offset: number): void {
  if (!Number.isFinite(offset)) throw new Error('Offset must be a number');
  doc.transact('Parallel offset', () => {
    const c = internal(doc.piece(pieceId), contourId);
    if (c.lock?.kind !== 'parallel') throw new Error('The line is not locked parallel');
    c.lock.offset = offset;
  });
}

/** Set the span range (as the lock's measure values) of a parallel lock. */
export function setLockRange(doc: Document, pieceId: Id, contourId: Id, a: number, b: number): void {
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Range must be numbers');
  doc.transact('Parallel range', () => {
    const c = internal(doc.piece(pieceId), contourId);
    if (c.lock?.kind !== 'parallel') throw new Error('The line is not locked parallel');
    c.lock.a = a; c.lock.b = b;
  });
}

/** Span length (mm, base size) of a lock's segment, for UI conversions; NaN when it no longer exists. */
export function lockSpanLength(piece: Piece, line: SizeLine, from: Id, to: Id, sizeId?: SizeId): number {
  const sp = sewSpan(piece, line, sizeId ?? line.baseSizeId, from, to);
  return sp ? sp.L : NaN;
}
