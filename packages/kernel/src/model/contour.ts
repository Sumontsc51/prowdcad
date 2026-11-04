/**
 * Contour resolution: Anchor[] (base coords + incremental grading) → sampled polyline for a size.
 *
 * Curve rule: every span between consecutive anchors is a cubic Bézier. Default handles come
 * from the centripetal Catmull-Rom (α=0.5) through the run of consecutive SMOOTH anchors; a
 * non-smooth anchor with no handle is a corner (handle = point itself ⇒ straight span). Explicit
 * hIn/hOut override the CR default. This gives one uniform sampler for straight, CR and Bézier.
 */
import { Vec, add, sub, dist } from '../geom/vec';
import { sampleBezier, catmullRomToBezierHandles } from '../geom/curve';
import { cumulativeLengths, dedupe } from '../geom/poly';
import type { Anchor, Contour, GradeInc, SizeId, SizeLine } from './types';

export interface ResolvedContour {
  /** sampled polyline (closed contours: first point NOT repeated at end) */
  pts: Vec[];
  /** index into pts of each anchor (same order as contour.points) */
  anchorIndex: number[];
  /** anchor positions for this size, same order as contour.points */
  anchorPos: Vec[];
  /** absolute handle positions for this size (after CR defaults + explicit overrides) */
  handles: { hIn: Vec; hOut: Vec }[];
  /** cumulative length table over pts (closed: includes closing edge at the end) */
  cum: number[];
  closed: boolean;
  /** indices (into contour.points) of grade anchors, in order */
  gradeIdx: number[];
}

/** Absolute grading offset of an anchor for a size (sum of increments from base). */
export function absoluteOffset(grade: Record<SizeId, GradeInc> | undefined, line: SizeLine, sizeId: SizeId): Vec {
  if (!grade) return { x: 0, y: 0 };
  const ids = line.sizes.map(s => s.id);
  const bi = ids.indexOf(line.baseSizeId), si = ids.indexOf(sizeId);
  if (bi < 0 || si < 0 || bi === si) return { x: 0, y: 0 };
  let dx = 0, dy = 0;
  if (si > bi) for (let k = bi + 1; k <= si; k++) { const g = grade[ids[k]]; if (g) { dx += g.dx; dy += g.dy; } }
  else for (let k = si + 1; k <= bi; k++) { const g = grade[ids[k]]; if (g) { dx -= g.dx; dy -= g.dy; } }
  return { x: dx, y: dy };
}

/**
 * Incremental convention (uniform for every size, including base):
 *   inc[size_i] = abs[size_i] − abs[size_{i−1}]   (i ≥ 1), inc[size_0] = 0, abs[base] = 0.
 * absoluteOffset() telescopes these in either direction from the base.
 */
export function absoluteToIncremental(abs: Record<SizeId, GradeInc>, line: SizeLine): Record<SizeId, GradeInc> {
  const ids = line.sizes.map(s => s.id);
  const A = (i: number): GradeInc => (ids[i] === line.baseSizeId ? { dx: 0, dy: 0 } : abs[ids[i]] ?? { dx: 0, dy: 0 });
  const out: Record<SizeId, GradeInc> = {};
  for (let i = 0; i < ids.length; i++) {
    if (i === 0) { out[ids[i]] = { dx: 0, dy: 0 }; continue; }
    const a = A(i), p = A(i - 1);
    out[ids[i]] = { dx: a.dx - p.dx, dy: a.dy - p.dy };
  }
  return out;
}

export function incrementalToAbsolute(inc: Record<SizeId, GradeInc>, line: SizeLine): Record<SizeId, GradeInc> {
  const out: Record<SizeId, GradeInc> = {};
  for (const s of line.sizes) { const o = absoluteOffset(inc, line, s.id); out[s.id] = { dx: o.x, dy: o.y }; }
  return out;
}

/** Rotate an increment by the anchor's grade axis (angle grading). */
function applyAxis(off: Vec, axisDeg: number | undefined): Vec {
  if (!axisDeg) return off;
  const r = axisDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: off.x * c - off.y * s, y: off.x * s + off.y * c };
}

/** Position of a single anchor for a size. Curve points are graded proportionally between neighbouring grade points. */
export function anchorPositions(points: Anchor[], line: SizeLine, sizeId: SizeId, closed: boolean): Vec[] {
  const n = points.length;
  const pos: Vec[] = new Array(n);
  const isBase = sizeId === line.baseSizeId;
  // grade points first
  for (let i = 0; i < n; i++) {
    const a = points[i];
    if (a.kind === 'grade' || isBase) {
      const off = isBase ? { x: 0, y: 0 } : applyAxis(absoluteOffset(a.grade, line, sizeId), a.gradeAxisDeg);
      pos[i] = { x: a.x + off.x, y: a.y + off.y };
    }
  }
  if (isBase) return pos;
  // curve points: proportional interpolation of the offsets of the bounding grade points, by base-size chord distance
  for (let i = 0; i < n; i++) {
    if (points[i].kind !== 'curve') continue;
    // if a curve point carries explicit grading, honour it
    if (points[i].grade && Object.keys(points[i].grade).length > 0) {
      const off = applyAxis(absoluteOffset(points[i].grade, line, sizeId), points[i].gradeAxisDeg);
      pos[i] = { x: points[i].x + off.x, y: points[i].y + off.y };
      continue;
    }
    let prev = -1, next = -1;
    for (let k = 1; k <= n; k++) { const j = closed ? (i - k + n) % n : i - k; if (j < 0) break; if (points[j].kind === 'grade') { prev = j; break; } }
    for (let k = 1; k <= n; k++) { const j = closed ? (i + k) % n : i + k; if (j >= n) break; if (points[j].kind === 'grade') { next = j; break; } }
    if (prev < 0 && next < 0) { pos[i] = { x: points[i].x, y: points[i].y }; continue; }
    if (prev < 0) prev = next; if (next < 0) next = prev;
    const offP = sub(pos[prev], points[prev]), offN = sub(pos[next], points[next]);
    // chord-length proportion between prev and next through the curve points
    let dPrev = 0, dNext = 0;
    { let j = i; let guard = 0; while (j !== prev && guard++ < n) { const pj = closed ? (j - 1 + n) % n : j - 1; dPrev += dist(points[j], points[pj]); j = pj; } }
    { let j = i; let guard = 0; while (j !== next && guard++ < n) { const nj = closed ? (j + 1) % n : j + 1; dNext += dist(points[j], points[nj]); j = nj; } }
    const tot = dPrev + dNext;
    const t = tot < 1e-9 ? 0.5 : dPrev / tot;
    pos[i] = { x: points[i].x + offP.x * (1 - t) + offN.x * t, y: points[i].y + offP.y * (1 - t) + offN.y * t };
  }
  return pos;
}

/**
 * Compute absolute handle positions for every anchor for the given positions.
 * Runs of smooth anchors (bounded by corners) get CR default handles; explicit handles override.
 */
export function resolveHandles(points: Anchor[], pos: Vec[], closed: boolean): { hIn: Vec; hOut: Vec }[] {
  const n = points.length;
  const H: { hIn: Vec; hOut: Vec }[] = pos.map(p => ({ hIn: { ...p }, hOut: { ...p } }));
  if (n < 2) return H;
  const isCorner = (i: number) => !points[i].smooth;
  // find runs: sequences [corner, smooth..., corner] (or whole loop if no corner)
  const corners: number[] = [];
  for (let i = 0; i < n; i++) if (isCorner(i)) corners.push(i);
  const runs: number[][] = [];
  if (corners.length === 0) {
    // fully smooth loop/open spline
    if (closed) runs.push([...Array.from({ length: n }, (_, i) => i), 0, 1]); // wrap with two extra for continuity
    else runs.push(Array.from({ length: n }, (_, i) => i));
  } else if (closed) {
    for (let c = 0; c < corners.length; c++) {
      const s = corners[c], e = corners[(c + 1) % corners.length];
      const run = [s]; let j = s;
      do { j = (j + 1) % n; run.push(j); } while (j !== e);
      runs.push(run);
    }
  } else {
    let start = 0;
    for (const c of corners) { if (c > start) runs.push(Array.from({ length: c - start + 1 }, (_, k) => start + k)); start = c; }
    if (start < n - 1) runs.push(Array.from({ length: n - start }, (_, k) => start + k));
    if (corners[0] > 0) runs.unshift(Array.from({ length: corners[0] + 1 }, (_, k) => k));
  }
  for (const run of runs) {
    if (run.length < 3) continue; // two corners → straight span, handles stay on the points
    const rp = run.map(i => pos[i]);
    const closedLoop = corners.length === 0 && closed;
    let hh: { hIn: Vec; hOut: Vec }[];
    if (closedLoop) {
      // periodic CR: pad with wrap neighbours
      const m = n;
      const padded = [pos[(m - 1)], ...pos, pos[0], pos[1]];
      const ph = catmullRomToBezierHandles(padded);
      hh = []; for (let i = 0; i < m; i++) hh.push(ph[i + 1]);
      for (let i = 0; i < m; i++) { H[i].hIn = hh[i].hIn; H[i].hOut = hh[i].hOut; }
      continue;
    }
    hh = catmullRomToBezierHandles(rp);
    for (let k = 0; k < run.length; k++) {
      const i = run[k];
      if (k > 0) H[i].hIn = hh[k].hIn;
      if (k < run.length - 1) H[i].hOut = hh[k].hOut;
    }
  }
  // corners: endpoints of straight-vs-curved spans. A corner adjacent to another corner → straight (hOut=self).
  // CR through a two-point run yields handles on the chord ⇒ straight automatically.
  // explicit overrides
  for (let i = 0; i < n; i++) {
    const a = points[i];
    if (a.hIn) H[i].hIn = add(pos[i], a.hIn);
    if (a.hOut) H[i].hOut = add(pos[i], a.hOut);
    if (!a.smooth && !a.hIn && !a.hOut) { /* corner without handles keeps CR chord handles from runs (straight if run is 2 pts) */ }
  }
  return H;
}

export function resolveContour(contour: Contour, line: SizeLine, sizeId: SizeId, tol = 0.05): ResolvedContour {
  const points = contour.points;
  const closed = contour.closed;
  const n = points.length;
  const anchorPos = anchorPositions(points, line, sizeId, closed);
  const handles = resolveHandles(points, anchorPos, closed);
  const pts: Vec[] = [];
  const anchorIndex: number[] = new Array(n);
  const spans = closed ? n : n - 1;
  for (let i = 0; i < Math.max(spans, 0); i++) {
    const j = (i + 1) % n;
    anchorIndex[i] = pts.length;
    const p0 = anchorPos[i], p3 = anchorPos[j];
    const p1 = handles[i].hOut, p2 = handles[j].hIn;
    const straight = isStraightSpan(p0, p1, p2, p3);
    if (straight) pts.push({ ...p0 });
    else { const s = sampleBezier(p0, p1, p2, p3, tol); for (let k = 0; k < s.length - 1; k++) pts.push(s[k]); }
  }
  if (!closed) { anchorIndex[n - 1] = pts.length; if (n > 0) pts.push({ ...anchorPos[n - 1] }); }
  if (n === 1) { anchorIndex[0] = 0; pts.push({ ...anchorPos[0] }); }
  const clean = pts; // keep indices valid: no dedupe
  const cum = cumulativeLengths(closed && clean.length > 1 ? [...clean, clean[0]] : clean);
  const gradeIdx: number[] = [];
  for (let i = 0; i < n; i++) if (points[i].kind === 'grade') gradeIdx.push(i);
  return { pts: clean, anchorIndex, anchorPos, handles, cum, closed, gradeIdx };
}

/** A span is straight when both handles lie on the chord (within 1e-7 mm) and between the endpoints. */
export function isStraightSpan(p0: Vec, p1: Vec, p2: Vec, p3: Vec): boolean {
  const d = sub(p3, p0); const L = Math.hypot(d.x, d.y);
  if (L < 1e-12) return true;
  const ux = d.x / L, uy = d.y / L;
  for (const h of [p1, p2]) {
    const hx = h.x - p0.x, hy = h.y - p0.y;
    const crossv = hx * uy - hy * ux; const t = (hx * ux + hy * uy) / L;
    if (Math.abs(crossv) > 1e-7 || t < -1e-9 || t > 1 + 1e-9) return false;
  }
  return true;
}

/** Polyline of the span between anchor indices a..b (inclusive, forward in contour order, wraps on closed). */
export function spanPolyline(r: ResolvedContour, a: number, b: number): Vec[] {
  const ia = r.anchorIndex[a], ib = r.anchorIndex[b];
  const N = r.pts.length;
  const out: Vec[] = [];
  if (!r.closed) { for (let k = ia; k <= ib; k++) out.push(r.pts[k]); return out; }
  let k = ia; let guard = 0;
  while (guard++ <= N) { out.push(r.pts[k]); if (k === ib) break; k = (k + 1) % N; }
  if (a === b) { for (let q = 1; q < N; q++) out.push(r.pts[(ia + q) % N]); out.push(r.pts[ia]); }
  return out;
}

/** Arc length between two anchors along the contour (forward). */
export function spanLength(r: ResolvedContour, a: number, b: number): number {
  const poly = spanPolyline(r, a, b);
  let L = 0; for (let i = 1; i < poly.length; i++) L += dist(poly[i - 1], poly[i]);
  return L;
}

/** Segment k of a contour = from grade anchor gradeIdx[k] to the next grade anchor. Returns [anchorIdxStart, anchorIdxEnd]. */
export function gradeSegment(r: ResolvedContour, k: number): [number, number] {
  const g = r.gradeIdx;
  const a = g[k];
  const b = r.closed ? g[(k + 1) % g.length] : g[Math.min(k + 1, g.length - 1)];
  return [a, b];
}

export function totalLength(r: ResolvedContour): number { return r.cum[r.cum.length - 1] ?? 0; }

/** Closed polygon of the resolved contour (deduped; for area/offset/nesting). */
export function polygonOf(r: ResolvedContour): Vec[] { return dedupe(r.pts); }
