/**
 * Shared geometry for the drafting & construction toolkit (points / segments / cut / parallel /
 * shapers / pieces / smooth).
 *
 * Core primitive: `splitAt` inserts an anchor at an arc length on a contour WITHOUT changing the
 * contour's base-size geometry. Curved spans are split with de Casteljau; the handles of the two
 * span anchors are frozen to their resolved values (explicit relative handles) so the neighbouring
 * centripetal Catmull-Rom spans are not disturbed by the new neighbour. Everything that cuts,
 * extracts or re-assembles contours is built on top of it.
 */
import type { Anchor, Contour, Piece, SizeLine, SizeId, GradeInc, Id, NotchPlacement } from '../model/types';
import { resolveContour, anchorPositions, absoluteToIncremental, isStraightSpan, type ResolvedContour } from '../model/contour';
import { bezierPoint } from './curve';
import { Vec, add, sub, mul, dist, lerp, dot, cross, norm, len, rotate, reflect, angleOf } from './vec';
import { segIntersect, signedArea } from './poly';
import { newId } from '../model/factory';

export const GEO_EPS = 1e-6;

export function jsonClone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

export class NotImplemented extends Error { constructor(what: string) { super('Not implemented: ' + what); } }

// ───────────────────────── lookup ─────────────────────────

export function pieceContours(piece: Piece): Contour[] { return [piece.sew, ...piece.internals]; }

export function contourOf(piece: Piece, contourId: Id): Contour {
  if (piece.sew.id === contourId) return piece.sew;
  const c = piece.internals.find(c => c.id === contourId) ?? (piece.manualCut?.id === contourId ? piece.manualCut : undefined);
  if (!c) throw new Error(`No contour ${contourId} on piece ${piece.name}`);
  return c;
}

export function findAnchorIn(piece: Piece, anchorId: Id): { contour: Contour; index: number; anchor: Anchor } {
  for (const c of [piece.sew, ...piece.internals, ...(piece.manualCut ? [piece.manualCut] : [])]) {
    const i = c.points.findIndex(a => a.id === anchorId);
    if (i >= 0) return { contour: c, index: i, anchor: c.points[i] };
  }
  throw new Error(`No anchor ${anchorId} on piece ${piece.name}`);
}

export function idx(contour: Contour, anchorId: Id): number {
  const i = contour.points.findIndex(a => a.id === anchorId);
  if (i < 0) throw new Error('No anchor ' + anchorId + ' on contour ' + contour.id);
  return i;
}

export function nextGrade(contour: Contour, i: number): number {
  const n = contour.points.length;
  for (let k = 1; k <= n; k++) {
    const j = contour.closed ? (i + k) % n : i + k;
    if (j >= n) return -1;
    if (contour.points[j].kind === 'grade') return j;
  }
  return -1;
}
export function prevGrade(contour: Contour, i: number, inclusive = true): number {
  const n = contour.points.length;
  for (let k = inclusive ? 0 : 1; k <= n; k++) {
    const j = contour.closed ? (((i - k) % n) + n) % n : i - k;
    if (j < 0) return -1;
    if (contour.points[j].kind === 'grade') return j;
  }
  return -1;
}

/** Anchor indices strictly between a and b going forward (wrapping on closed contours). */
export function between(contour: Contour, a: number, b: number): number[] {
  const n = contour.points.length, out: number[] = [];
  if (!contour.closed) { for (let i = a + 1; i < b; i++) out.push(i); return out; }
  for (let i = (a + 1) % n, g = 0; i !== b && g < n; i = (i + 1) % n, g++) out.push(i);
  return out;
}

// ───────────────────────── resolution / arc-length addressing ─────────────────────────

export function resolveBase(contour: Contour, line: SizeLine, tol = 0.05): ResolvedContour {
  return resolveContour(contour, line, line.baseSizeId, tol);
}
export function closedPoly(r: ResolvedContour): Vec[] { return r.closed && r.pts.length > 1 ? [...r.pts, r.pts[0]] : r.pts; }
export function lengthOf(r: ResolvedContour): number { return r.cum[r.cum.length - 1] ?? 0; }
export function arcS(r: ResolvedContour, i: number): number { return r.cum[r.anchorIndex[i]] ?? 0; }
export function wrapArc(r: ResolvedContour, s: number): number {
  const L = lengthOf(r);
  if (L <= 0) return 0;
  if (!r.closed) return Math.max(0, Math.min(L, s));
  let w = s % L; if (w < 0) w += L; if (L - w < 1e-9) w = 0; return w;
}
/** forward distance s0 → s1 (closed: modulo L) */
export function fwd(r: ResolvedContour, s0: number, s1: number): number {
  if (!r.closed) return s1 - s0;
  const L = lengthOf(r); let d = (s1 - s0) % L; if (d < 0) d += L; if (L - d < 1e-9) d = 0; return d;
}
/** forward length of span from anchor a to anchor b (a===b on closed = full loop) */
export function spanLen(r: ResolvedContour, a: number, b: number): number {
  const d = fwd(r, arcS(r, a), arcS(r, b));
  return d === 0 && a === b && r.closed ? lengthOf(r) : d;
}

export function pointAt(r: ResolvedContour, s: number): { pt: Vec; edge: number; f: number; tangent: Vec } {
  const poly = closedPoly(r), cum = r.cum;
  s = wrapArc(r, s);
  if (poly.length < 2) return { pt: { ...(poly[0] ?? { x: 0, y: 0 }) }, edge: 0, f: 0, tangent: { x: 1, y: 0 } };
  let e = 0;
  while (e < cum.length - 2 && cum[e + 1] < s) e++;
  // skip zero-length edges forward
  while (e < cum.length - 2 && cum[e + 1] - cum[e] < 1e-12 && s >= cum[e + 1]) e++;
  const L = cum[e + 1] - cum[e];
  const f = L < 1e-12 ? 0 : Math.max(0, Math.min(1, (s - cum[e]) / L));
  return { pt: lerp(poly[e], poly[e + 1], f), edge: e, f, tangent: norm(sub(poly[e + 1], poly[e])) };
}

export function closestArc(r: ResolvedContour, q: Vec): { s: number; pt: Vec; d: number } {
  const poly = closedPoly(r);
  let best = { s: 0, pt: { ...(poly[0] ?? { x: 0, y: 0 }) }, d: Infinity };
  for (let e = 0; e + 1 < poly.length; e++) {
    const a = poly[e], b = poly[e + 1], ab = sub(b, a), l2 = dot(ab, ab);
    const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(q, a), ab) / l2));
    const pt = lerp(a, b, t), d = dist(pt, q);
    if (d < best.d - 1e-12) best = { s: r.cum[e] + t * Math.sqrt(l2), pt, d };
  }
  return best;
}

/** anchor index whose span contains polyline edge e */
export function spanOf(r: ResolvedContour, e: number): number {
  const n = r.anchorIndex.length, spans = r.closed ? n : n - 1;
  let best = 0;
  for (let i = 0; i < spans; i++) if (r.anchorIndex[i] <= e) best = i;
  return best;
}
export function spanEdgeEnd(r: ResolvedContour, i: number): number {
  const n = r.anchorIndex.length, j = (i + 1) % n;
  return r.closed && j === 0 ? r.pts.length : r.anchorIndex[j];
}

/** Sampled polyline from anchor a forward to anchor b (inclusive). */
export function spanPoly(r: ResolvedContour, a: number, b: number): Vec[] {
  const poly = closedPoly(r);
  const ia = r.anchorIndex[a];
  let ib = r.anchorIndex[b];
  if (r.closed && (ib < ia || (ib === ia && a === b))) ib += r.pts.length;
  const out: Vec[] = [];
  const N = r.pts.length;
  for (let k = ia; k <= ib; k++) out.push({ ...(k <= N ? poly[k] : poly[k - N]) });
  return out;
}

/** Sampled polyline between arc lengths s0 → s1 (forward). */
export function arcSlice(r: ResolvedContour, s0: number, s1: number): Vec[] {
  const poly = closedPoly(r), L = lengthOf(r);
  const d = r.closed ? fwd(r, s0, s1) : s1 - s0;
  const out: Vec[] = [pointAt(r, s0).pt];
  if (d <= 0) return out;
  const start = wrapArc(r, s0);
  // walk vertices
  const N = poly.length - 1;
  for (let lap = 0; lap < 2; lap++) {
    for (let k = 1; k <= N; k++) {
      const sk = r.cum[k] + lap * L;
      if (sk > start + 1e-12 && sk < start + d - 1e-12) out.push({ ...poly[k] });
    }
    if (!r.closed) break;
  }
  out.push(pointAt(r, start + d).pt);
  return out;
}

// ───────────────────────── grading helpers ─────────────────────────

export function sizeIds(line: SizeLine): SizeId[] { return line.sizes.map(s => s.id); }

/** Absolute per-size position of every anchor (no sampling). */
export function positionsBySize(contour: Contour, line: SizeLine): Record<SizeId, Vec[]> {
  const out: Record<SizeId, Vec[]> = {};
  for (const s of sizeIds(line)) out[s] = anchorPositions(contour.points, line, s, contour.closed);
  return out;
}

/** Incremental grading from absolute per-size offsets. */
export function gradeFromOffsets(line: SizeLine, off: Record<SizeId, Vec>): Record<SizeId, GradeInc> {
  const abs: Record<SizeId, GradeInc> = {};
  for (const s of sizeIds(line)) abs[s] = { dx: off[s]?.x ?? 0, dy: off[s]?.y ?? 0 };
  const inc = absoluteToIncremental(abs, line);
  // drop all-zero records to keep "no grading" compact
  if (Object.values(inc).every(g => Math.abs(g.dx) < 1e-12 && Math.abs(g.dy) < 1e-12)) return {};
  return inc;
}

/** Make anchor i a grade point, materialising its current per-size position as explicit grading. */
export function promoteToGrade(contour: Contour, line: SizeLine, i: number): void {
  const a = contour.points[i];
  if (a.kind === 'grade') return;
  const by = positionsBySize(contour, line);
  const base = by[line.baseSizeId][i];
  const off: Record<SizeId, Vec> = {};
  for (const s of sizeIds(line)) off[s] = sub(by[s][i], base);
  a.grade = gradeFromOffsets(line, off);
  delete a.gradeAxisDeg;
  const pg = prevGrade(contour, i, false);
  a.kind = 'grade';
  if (a.seamAfter === undefined && pg >= 0) { const sa = contour.points[pg].seamAfter; if (sa !== undefined) a.seamAfter = sa; }
}

/** Write the resolved (base) handles of anchor i as explicit relative handles. */
export function freeze(contour: Contour, r: ResolvedContour, i: number): void {
  const a = contour.points[i], p = r.anchorPos[i];
  a.hIn = sub(r.handles[i].hIn, p);
  a.hOut = sub(r.handles[i].hOut, p);
}

/** Pin proportional notches on a contour to their current span end before a grade anchor is inserted. */
export function pinProportionalNotches(piece: Piece, contour: Contour): void {
  for (const n of piece.notches ?? []) {
    if (n.contourId !== contour.id || n.placement.kind !== 'proportional' || n.spanEndAnchorId) continue;
    const ia = contour.points.findIndex(a => a.id === n.placement.anchorId);
    if (ia < 0) continue;
    const ib = nextGrade(contour, ia);
    if (ib >= 0) n.spanEndAnchorId = contour.points[ib].id;
  }
}

// ───────────────────────── split / extract ─────────────────────────

export interface SplitOpts {
  kind?: 'grade' | 'curve';
  /** 'auto' = interpolate the per-size offset of the two span anchors by arc fraction; 'zero' = no grading */
  grading?: 'auto' | 'zero';
  /** piece owning the contour (pins proportional notches) */
  piece?: Piece;
  /** snap to an existing anchor within this arc distance (mm) */
  snap?: number;
  name?: string;
}

/**
 * Insert an anchor at base arc length s, preserving base geometry. Returns the anchor index
 * (an existing anchor within `snap` is reused; promoted to grade if a grade anchor was asked for).
 */
export function splitAt(contour: Contour, line: SizeLine, s: number, opt: SplitOpts = {}): number {
  const n = contour.points.length;
  const kind = opt.kind ?? 'grade';
  const snap = opt.snap ?? 1e-4;
  const r = resolveBase(contour, line);
  const L = lengthOf(r);
  s = contour.closed ? wrapArc(r, s) : Math.max(0, Math.min(L, s));
  for (let i = 0; i < n; i++) {
    const si = arcS(r, i);
    const d = contour.closed ? Math.min(fwd(r, si, s), fwd(r, s, si)) : Math.abs(si - s);
    if (d <= snap) { if (kind === 'grade' && contour.points[i].kind !== 'grade') promoteToGrade(contour, line, i); return i; }
  }
  const loc = pointAt(r, s);
  const i = spanOf(r, loc.edge), j = (i + 1) % n;
  const e0 = r.anchorIndex[i], e1 = spanEdgeEnd(r, i);
  const t = Math.max(0, Math.min(1, (loc.edge - e0 + loc.f) / Math.max(1, e1 - e0)));
  const P0 = r.anchorPos[i], P3 = r.anchorPos[j], P1 = r.handles[i].hOut, P2 = r.handles[j].hIn;
  const sI = arcS(r, i), spanL = spanLen(r, i, j);
  const u = spanL > 0 ? Math.max(0, Math.min(1, fwd(r, sI, s) / spanL)) : 0;
  if (opt.piece && kind === 'grade') pinProportionalNotches(opt.piece, contour);
  const ai = contour.points[i], aj = contour.points[j];
  let m: Anchor;
  if (isStraightSpan(P0, P1, P2, P3)) {
    const pos = lerp(P0, P3, u);
    if (ai.smooth || ai.hIn || ai.hOut) freeze(contour, r, i);
    if (aj.smooth || aj.hIn || aj.hOut) freeze(contour, r, j);
    m = { id: newId('p'), x: pos.x, y: pos.y, kind, smooth: false, grade: {}, flags: {} };
  } else {
    const P01 = lerp(P0, P1, t), P12 = lerp(P1, P2, t), P23 = lerp(P2, P3, t);
    const P012 = lerp(P01, P12, t), P123 = lerp(P12, P23, t), M = lerp(P012, P123, t);
    freeze(contour, r, i); freeze(contour, r, j);
    ai.hOut = sub(P01, P0); aj.hIn = sub(P23, P3);
    m = { id: newId('p'), x: M.x, y: M.y, kind, smooth: true, hIn: sub(P012, M), hOut: sub(P123, M), grade: {}, flags: {} };
  }
  if (opt.name) m.name = opt.name;
  if ((opt.grading ?? 'auto') === 'zero') {
    if (kind === 'grade') m.flags.zeroGrade = true;
    else { const g: Record<SizeId, GradeInc> = {}; for (const sid of sizeIds(line)) g[sid] = { dx: 0, dy: 0 }; m.grade = g; }
  } else if (kind === 'grade') {
    const by = positionsBySize(contour, line), b = line.baseSizeId;
    const off: Record<SizeId, Vec> = {};
    for (const sid of sizeIds(line)) off[sid] = lerp(sub(by[sid][i], by[b][i]), sub(by[sid][j], by[b][j]), u);
    m.grade = gradeFromOffsets(line, off);
  }
  if (kind === 'grade') {
    const pg = prevGrade(contour, i, true);
    const sa = pg >= 0 ? contour.points[pg].seamAfter : undefined;
    if (sa !== undefined) m.seamAfter = sa;
  }
  contour.points.splice(i + 1, 0, m);
  return i + 1;
}

/**
 * Anchors of the contour from base arc s0 forward to s1, geometry-exact (endpoints become grade
 * corners; their outer handles are dropped). The source contour is NOT modified.
 */
export function extractRange(contour: Contour, line: SizeLine, s0: number, s1: number, opt: { keepIds?: boolean; grading?: 'auto' | 'zero' } = {}): Anchor[] {
  const c = jsonClone(contour);
  const r0 = resolveBase(c, line);
  const p1 = pointAt(r0, s1).pt;
  const full = c.closed && Math.abs(fwd(r0, s0, s1)) < 1e-9 && Math.abs(s0 - s1) > 1e-9;
  let i0 = splitAt(c, line, s0, { kind: 'grade', grading: opt.grading });
  const id0 = c.points[i0].id;
  let i1: number;
  if (full) i1 = i0;
  else {
    const r1 = resolveBase(c, line);
    const near = closestSNear(r1, p1, s1);
    i1 = splitAt(c, line, near, { kind: 'grade', grading: opt.grading });
  }
  i0 = idx(c, id0);
  const r2 = resolveBase(c, line);
  freeze(c, r2, i0); freeze(c, r2, i1);
  const ids = [i0, ...between(c, i0, i1), i1];
  if (!c.closed && i1 < i0) throw new Error('extractRange: s1 before s0 on open contour');
  const out = ids.map(i => jsonClone(c.points[i]));
  const first = out[0], last = out[out.length - 1];
  delete first.hIn; first.smooth = false;
  delete last.hOut; last.smooth = false;
  if (!opt.keepIds) for (const a of out) a.id = newId('p');
  return out;
}

/** closest arc position to q, preferring the candidate nearest to sHint when several are equally close */
export function closestSNear(r: ResolvedContour, q: Vec, sHint: number): number {
  const poly = closedPoly(r);
  let best = { s: sHint, d: Infinity, h: Infinity };
  for (let e = 0; e + 1 < poly.length; e++) {
    const a = poly[e], b = poly[e + 1], ab = sub(b, a), l2 = dot(ab, ab);
    const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(q, a), ab) / l2));
    const d = dist(lerp(a, b, t), q), s = r.cum[e] + t * Math.sqrt(l2);
    const h = Math.abs(s - sHint);
    if (d < best.d - 1e-7 || (Math.abs(d - best.d) <= 1e-7 && h < best.h)) best = { s, d, h };
  }
  return best.s;
}

/** Reverse an anchor list (contour direction), swapping handles and moving seamAfter onto the new segment starts. */
export function reverseAnchors(points: Anchor[], closed: boolean): Anchor[] {
  const n = points.length;
  const seam = new Map<Id, number | undefined>();
  const gi = points.map((a, i) => (a.kind === 'grade' ? i : -1)).filter(i => i >= 0);
  for (let k = 0; k < gi.length; k++) {
    const prev = k > 0 ? gi[k - 1] : closed ? gi[gi.length - 1] : -1;
    seam.set(points[gi[k]].id, prev >= 0 ? points[prev].seamAfter : undefined);
  }
  const out: Anchor[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const a = jsonClone(points[i]);
    const hIn = a.hOut, hOut = a.hIn;
    delete a.hIn; delete a.hOut;
    if (hIn) a.hIn = hIn; if (hOut) a.hOut = hOut;
    if (a.kind === 'grade') { const s = seam.get(a.id); if (s === undefined) delete a.seamAfter; else a.seamAfter = s; }
    out.push(a);
  }
  return out;
}

/** Fresh base sew polygon. */
export function sewPolygon(piece: Piece, line: SizeLine, sizeId?: SizeId): Vec[] {
  return resolveContour(piece.sew, line, sizeId ?? line.baseSizeId).pts;
}

export function centroid(poly: Vec[]): Vec {
  const A = signedArea(poly);
  if (Math.abs(A) < 1e-12) { let x = 0, y = 0; for (const p of poly) { x += p.x; y += p.y; } return { x: x / poly.length, y: y / poly.length }; }
  let cx = 0, cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; const c = p.x * q.y - q.x * p.y; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c; }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

/** max distance from any point of a to polyline b */
export function maxDev(a: Vec[], b: Vec[]): number {
  let m = 0;
  for (const p of a) {
    let d = Infinity;
    for (let e = 0; e + 1 < b.length; e++) {
      const s = b[e], t = b[e + 1], st = sub(t, s), l2 = dot(st, st);
      const u = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(p, s), st) / l2));
      d = Math.min(d, dist(lerp(s, t, u), p));
    }
    if (b.length === 1) d = dist(p, b[0]);
    m = Math.max(m, d);
  }
  return m;
}

/** Ramer–Douglas–Peucker; returns indices kept. */
export function rdpIndices(p: Vec[], tol: number): number[] {
  if (p.length <= 2) return p.map((_, i) => i);
  const keep = new Array(p.length).fill(false); keep[0] = keep[p.length - 1] = true;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(p[i], p[a], p[b]);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = true; stack.push([a, best], [best, b]); }
  }
  return keep.map((k, i) => (k ? i : -1)).filter(i => i >= 0);
}
export function distToSeg(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a), l2 = dot(ab, ab);
  const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(lerp(a, b, t), p);
}

/** All crossings of an open path with a closed/open polyline. */
export function crossings(path: Vec[], poly: Vec[]): { pt: Vec; sPath: number; sPoly: number }[] {
  const out: { pt: Vec; sPath: number; sPoly: number }[] = [];
  let accP = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const lp = dist(path[i], path[i + 1]);
    let accQ = 0;
    for (let j = 0; j + 1 < poly.length; j++) {
      const lq = dist(poly[j], poly[j + 1]);
      const x = segIntersect(path[i], path[i + 1], poly[j], poly[j + 1]);
      if (x) out.push({ pt: x.pt, sPath: accP + x.t * lp, sPoly: accQ + x.u * lq });
      accQ += lq;
    }
    accP += lp;
  }
  out.sort((a, b) => a.sPath - b.sPath);
  const ded: typeof out = [];
  for (const c of out) if (!ded.length || dist(ded[ded.length - 1].pt, c.pt) > 1e-6) ded.push(c);
  return ded;
}

// ───────────────────────── transforms ─────────────────────────

export interface Xf { pt(p: Vec): Vec; vec(v: Vec): Vec; ang(deg: number): number; mirror: boolean }
export const xfTranslate = (d: Vec): Xf => ({ pt: p => add(p, d), vec: v => ({ ...v }), ang: a => a, mirror: false });
export function xfRotate(about: Vec, rad: number): Xf {
  return { pt: p => rotate(p, rad, about), vec: v => rotate(v, rad), ang: a => a + (rad * 180) / Math.PI, mirror: false };
}
export function xfMirror(a: Vec, b: Vec): Xf {
  const d = sub(b, a), th = (angleOf(d) * 180) / Math.PI;
  return { pt: p => reflect(p, a, d), vec: v => reflect(v, { x: 0, y: 0 }, d), ang: x => 2 * th - x, mirror: true };
}
export function xfCompose(first: Xf, then: Xf): Xf {
  return { pt: p => then.pt(first.pt(p)), vec: v => then.vec(first.vec(v)), ang: a => then.ang(first.ang(a)), mirror: first.mirror !== then.mirror };
}

function xfGrade(g: Record<SizeId, GradeInc> | undefined, xf: Xf): void {
  if (!g) return;
  for (const k of Object.keys(g)) { const v = xf.vec({ x: g[k].dx, y: g[k].dy }); g[k] = { dx: v.x, dy: v.y }; }
}

export function transformAnchor(a: Anchor, xf: Xf): void {
  const p = xf.pt(a); a.x = p.x; a.y = p.y;
  if (a.hIn) a.hIn = xf.vec(a.hIn);
  if (a.hOut) a.hOut = xf.vec(a.hOut);
  if (a.gradeAxisDeg && xf.mirror) a.gradeAxisDeg = -a.gradeAxisDeg;
  // (rotations commute with the grade-axis rotation; mirrors anti-commute → negate the axis)
  xfGrade(a.grade, xf);
  if (a.corner?.manualPoints) a.corner.manualPoints = a.corner.manualPoints.map(xf.pt);
  if (a.corner?.lockedPerSize) for (const k of Object.keys(a.corner.lockedPerSize)) a.corner.lockedPerSize[k] = a.corner.lockedPerSize[k].map(xf.pt);
}
export function transformContour(c: Contour, xf: Xf): void { for (const a of c.points) transformAnchor(a, xf); }

function xfObj(o: { x: number; y: number; grade?: Record<SizeId, GradeInc>; grade2?: Record<SizeId, GradeInc> }, xf: Xf) {
  const p = xf.pt(o); o.x = p.x; o.y = p.y; xfGrade(o.grade, xf); xfGrade(o.grade2, xf);
}

/** Rigidly transform every geometric element of a piece in place (base coords, handles, grading vectors). */
export function transformPiece(piece: Piece, xf: Xf): void {
  transformContour(piece.sew, xf);
  for (const c of piece.internals) transformContour(c, xf);
  if (piece.manualCut) transformContour(piece.manualCut, xf);
  for (const d of piece.darts) xfObj(d.apex, xf);
  for (const p of piece.pleats) { xfObj(p.axisStart, xf); xfObj(p.axisEnd, xf); xfAnySnap(p, xf); }
  for (const d of piece.drills) xfObj(d, xf);
  for (const t of piece.texts) { xfObj(t, xf); t.angleDeg = xf.ang(t.angleDeg); }
  for (const a of piece.artwork) { xfObj(a, xf); a.angleDeg = xf.ang(a.angleDeg); if (xf.mirror) a.scaleX = -a.scaleX; }
  for (const n of piece.notches) if (xf.mirror) n.angleDeg = -n.angleDeg;
  piece.grain.a = xf.pt(piece.grain.a); piece.grain.b = xf.pt(piece.grain.b);
  xfGrade(piece.grain.gradeA, xf); xfGrade(piece.grain.gradeB, xf);
  if (piece.half) { piece.half.a = xf.pt(piece.half.a); piece.half.b = xf.pt(piece.half.b); }
  for (const f of piece.fullness ?? []) { if ('x' in f.pivot) { const p = xf.pt(f.pivot); f.pivot = { x: p.x, y: p.y }; } xfAnySnap(f, xf); }
  if (piece.reference) { transformContour(piece.reference.sew, xf); for (const c of piece.reference.internals) transformContour(c, xf); }
}
/** live objects may carry a pre-transform snapshot (shape owned by other modules): transform any found */
function xfAnySnap(o: object, xf: Xf) {
  const snap = (o as { snapshot?: unknown }).snapshot as Parameters<typeof xfSnap>[0] | undefined;
  if (snap && typeof snap === 'object') xfSnap({ anchors: snap.anchors ?? [], apexes: snap.apexes ?? [], drills: snap.drills ?? [] }, xf);
}
function xfSnap(s: { anchors: Anchor[]; apexes: { apex: { x: number; y: number; grade: Record<SizeId, GradeInc> } }[]; drills: { x: number; y: number; grade: Record<SizeId, GradeInc> }[] }, xf: Xf) {
  for (const a of s.anchors) transformAnchor(a, xf);
  for (const a of s.apexes) xfObj(a.apex, xf);
  for (const d of s.drills) xfObj(d, xf);
}

/**
 * Deep-jsonClone a value and give every object carrying an `id` a fresh id, rewriting every string
 * reference to those ids anywhere in the structure (notch anchors, dart legs, connections …).
 */
export function cloneWithNewIds<T>(x: T, prefixOf: (oldId: string) => string = () => 'o'): { value: T; map: Map<string, string> } {
  const map = new Map<string, string>();
  const collect = (o: unknown) => {
    if (Array.isArray(o)) { o.forEach(collect); return; }
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      if (typeof rec.id === 'string' && !map.has(rec.id)) map.set(rec.id, newId(prefixOf(rec.id)));
      for (const v of Object.values(rec)) collect(v);
    }
  };
  collect(x);
  const rewrite = (o: unknown): unknown => {
    if (typeof o === 'string') return map.get(o) ?? o;
    if (Array.isArray(o)) return o.map(rewrite);
    if (o && typeof o === 'object') { const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(o as Record<string, unknown>)) out[k] = rewrite(v); return out; }
    return o;
  };
  return { value: rewrite(jsonClone(x)) as T, map };
}

// ───────────────────────── misc vector helpers ─────────────────────────

/** Outward-normal sign for a closed contour: outward = right of travel for CCW (returns −1 to multiply the LEFT normal). */
export function outwardSign(r: ResolvedContour): number { return signedArea(r.pts) > 0 ? -1 : 1; }

export function lineLineIntersect(a: Vec, da: Vec, b: Vec, db: Vec): Vec | null {
  const den = cross(da, db);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(b, a), db) / den;
  return add(a, mul(da, t));
}

export { len, norm, sub, add, mul, dist, lerp, dot, cross, bezierPoint };

/** Floating placement (fromPrev, constant distance) for a base point on a contour. */
export function floatingPlacement(contour: Contour, line: SizeLine, pos: Vec): NotchPlacement {
  const r = resolveBase(contour, line);
  const s = closestArc(r, pos).s;
  let best = -1, bs = -Infinity;
  for (const g of r.gradeIdx) { const sg = arcS(r, g); if (sg <= s + 1e-9 && sg > bs) { bs = sg; best = g; } }
  if (best < 0) { // closed contour: the last grade anchor wraps around
    if (r.gradeIdx.length === 0) return { kind: 'anchor', anchorId: contour.points[0].id };
    best = r.gradeIdx[r.gradeIdx.length - 1]; bs = arcS(r, best);
  }
  const d = fwd(r, bs, s);
  const dist: Record<SizeId, number> = {}; for (const id of sizeIds(line)) dist[id] = d;
  return d < 1e-9 ? { kind: 'anchor', anchorId: contour.points[best].id } : { kind: 'fromPrev', anchorId: contour.points[best].id, dist };
}

/** Base-size position of a notch on its contour (own evaluator, mirrors ops/notches placement semantics). */
export function notchBasePos(r: ResolvedContour, contour: Contour, n: Piece['notches'][number], line: SizeLine): Vec {
  const pl = n.placement;
  const ia = idx(contour, pl.anchorId);
  const sA = arcS(r, ia);
  let s = sA;
  if (pl.kind === 'fromPrev') s = sA + (pl.dist[line.baseSizeId] ?? Object.values(pl.dist)[0] ?? 0);
  else if (pl.kind === 'fromNext') s = sA - (pl.dist[line.baseSizeId] ?? Object.values(pl.dist)[0] ?? 0);
  else if (pl.kind === 'proportional') {
    const ib = n.spanEndAnchorId ? idx(contour, n.spanEndAnchorId) : nextGrade(contour, ia);
    if (ib >= 0) s = sA + (pl.pct / 100) * spanLen(r, ia, ib);
  }
  return pointAt(r, s).pt;
}

// ───────────────────────── polyline → anchors ─────────────────────────

/**
 * Convert a sampled polyline into anchors: RDP simplification (tol), vertices turning more than
 * `cornerDeg` become grade corners, others smooth curve points (centripetal CR reproduces them).
 * The two ends are grade corners. Purely straight input yields corners only.
 */
export function anchorsFromPolyline(pts: Vec[], o: { tol?: number; cornerDeg?: number; closed?: boolean } = {}): Anchor[] {
  const tol = o.tol ?? 0.01, cornerDeg = o.cornerDeg ?? 20;
  const P = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-9);
  if (o.closed && P.length > 1 && dist(P[0], P[P.length - 1]) < 1e-9) P.pop();
  const keep = o.closed ? rdpClosed(P, tol) : rdpIndices(P, tol);
  const K = keep.map(i => P[i]);
  const n = K.length;
  const turn = (i: number): number => {
    const a = K[(i - 1 + n) % n], b = K[i], c = K[(i + 1) % n];
    const u = norm(sub(b, a)), w = norm(sub(c, b));
    return (Math.acos(Math.max(-1, Math.min(1, dot(u, w)))) * 180) / Math.PI;
  };
  // a vertex between two long straight edges is a corner even at small turns
  const out: Anchor[] = K.map((p, i) => {
    const end = !o.closed && (i === 0 || i === n - 1);
    const corner = end || turn(i) > cornerDeg || isStraightNeighbourhood(K, i, o.closed ?? false, tol);
    return { id: newId('p'), x: p.x, y: p.y, kind: corner ? 'grade' : 'curve', smooth: !corner, grade: {}, flags: {} };
  });
  // curve runs that are entirely straight: drop smoothness (all corners) – already handled by RDP
  return out;
}
function isStraightNeighbourhood(K: Vec[], i: number, closed: boolean, tol: number): boolean {
  // both adjacent RDP edges are long relative to tol and there is a measurable turn → treat as corner
  const n = K.length;
  if (!closed && (i === 0 || i === n - 1)) return true;
  const a = K[(i - 1 + n) % n], b = K[i], c = K[(i + 1) % n];
  const l1 = dist(a, b), l2 = dist(b, c);
  const t = Math.abs(cross(norm(sub(b, a)), norm(sub(c, b))));
  return l1 > 20 && l2 > 20 && t > 1e-3 && tol >= 0;
}
function rdpClosed(P: Vec[], tol: number): number[] {
  if (P.length <= 3) return P.map((_, i) => i);
  // split at the farthest point from P[0]
  let far = 0, fd = -1;
  for (let i = 1; i < P.length; i++) { const d = dist(P[i], P[0]); if (d > fd) { fd = d; far = i; } }
  const a = rdpIndices(P.slice(0, far + 1), tol);
  const b = rdpIndices([...P.slice(far), P[0]], tol).map(i => i + far);
  const out = [...a, ...b.slice(1, -1)];
  return Array.from(new Set(out)).sort((x, y) => x - y);
}

// ───────────────────────── notch capture / restore ─────────────────────────

export interface CapturedNotch { notch: Piece['notches'][number]; pos: Vec; contourId: Id }

/** Capture base positions of every notch on the given contours (or all) of a piece. */
export function captureNotches(piece: Piece, line: SizeLine, contourIds?: Id[]): CapturedNotch[] {
  const out: CapturedNotch[] = [];
  for (const n of piece.notches) {
    if (contourIds && !contourIds.includes(n.contourId)) continue;
    const c = [piece.sew, ...piece.internals].find(c => c.id === n.contourId);
    if (!c || !c.points.some(a => a.id === n.placement.anchorId)) continue;
    out.push({ notch: jsonClone(n), pos: notchBasePos(resolveBase(c, line), c, n, line), contourId: n.contourId });
  }
  return out;
}

/**
 * Re-place captured notches onto `piece` (same id kept): nearest of its contours within tol;
 * an anchor at the position → 'anchor' placement, else floating fromPrev. A notch whose original
 * contour still exists unchanged around its anchor is left as is. Returns notches that found no home.
 */
export function restoreNotches(piece: Piece, line: SizeLine, caps: CapturedNotch[], tol = 1e-3, preferContour?: (c: CapturedNotch) => Id | undefined): CapturedNotch[] {
  const homeless: CapturedNotch[] = [];
  for (const cap of caps) {
    piece.notches = piece.notches.filter(n => n.id !== cap.notch.id);
    const cands = [piece.sew, ...piece.internals];
    let best: { c: Contour; d: number; s: number } | null = null;
    const pref = preferContour?.(cap);
    for (const c of cands) {
      if (c.points.length < 2) continue;
      const r = resolveBase(c, line);
      const cl = closestArc(r, cap.pos);
      const bonus = c.id === pref ? -1e-9 : 0;
      if (cl.d <= tol && (!best || cl.d + bonus < best.d)) best = { c, d: cl.d + bonus, s: cl.s };
    }
    if (!best) { homeless.push(cap); continue; }
    const n = jsonClone(cap.notch);
    n.contourId = best.c.id;
    // keep the original placement when still valid on this contour and it evaluates to the same spot
    const keepOk = best.c.points.some(a => a.id === n.placement.anchorId) && (!n.spanEndAnchorId || best.c.points.some(a => a.id === n.spanEndAnchorId));
    if (keepOk && dist(notchBasePos(resolveBase(best.c, line), best.c, n, line), cap.pos) < tol) { piece.notches.push(n); continue; }
    delete n.spanEndAnchorId;
    const r = resolveBase(best.c, line);
    const ai = best.c.points.findIndex((_, i) => dist(r.anchorPos[i], cap.pos) < tol);
    n.placement = ai >= 0 ? { kind: 'anchor', anchorId: best.c.points[ai].id } : floatingPlacement(best.c, line, cap.pos);
    piece.notches.push(n);
  }
  return homeless;
}

// ───────────────────────── mirror helpers ─────────────────────────

/** Mirror copies (fresh ids) of anchors across the line a→b, in reversed order (so the run direction is reversed). */
export function mirroredReversed(points: Anchor[], a: Vec, b: Vec): Anchor[] {
  const xf = xfMirror(a, b);
  const rev = reverseAnchors(points, false);
  for (const p of rev) { transformAnchor(p, xf); p.id = newId('p'); p.flags = { ...p.flags, startPoint: undefined }; delete p.flags.startPoint; }
  return rev;
}

/** Signed distance of p from the line a→b (left positive). */
export function sideOf(p: Vec, a: Vec, b: Vec): number { const d = norm(sub(b, a)); return cross(d, sub(p, a)); }
