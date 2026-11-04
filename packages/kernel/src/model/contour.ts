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
import type { Anchor, Contour, Dart, GradeInc, Id, Notch, Piece, SizeId, SizeLine } from './types';

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
    // open contour with curve points before the first / after the last grade point: they follow the
    // only bounding grade point rigidly (no walk past the contour ends)
    if (prev < 0 || next < 0) { const g = prev < 0 ? next : prev; const o = sub(pos[g], points[g]); pos[i] = { x: points[i].x + o.x, y: points[i].y + o.y }; continue; }
    const offP = sub(pos[prev], points[prev]), offN = sub(pos[next], points[next]);
    // chord-length proportion between prev and next through the curve points
    let dPrev = 0, dNext = 0;
    { let j = i; let guard = 0; while (j !== prev && guard++ < n) { const pj = closed ? (j - 1 + n) % n : j - 1; if (pj < 0) break; dPrev += dist(points[j], points[pj]); j = pj; } }
    { let j = i; let guard = 0; while (j !== next && guard++ < n) { const nj = closed ? (j + 1) % n : j + 1; if (nj >= n) break; dNext += dist(points[j], points[nj]); j = nj; } }
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

// ───────────────────────── live half pieces ─────────────────────────

/** Suffix of the deterministic ids of the derived (mirrored) half of a live half piece. Never stored. */
export const MIRROR_SUFFIX = '~m';
export const mirroredId = (id: Id): Id => id + MIRROR_SUFFIX;

const reflectPt = (p: Vec, a: Vec, d: Vec): Vec => {
  const L2 = d.x * d.x + d.y * d.y; if (L2 < 1e-24) return { x: p.x, y: p.y };
  const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / L2;
  const fx = a.x + d.x * t, fy = a.y + d.y * t;
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
};
const reflectVec = (v: Vec, d: Vec): Vec => reflectPt(v, { x: 0, y: 0 }, d);

/**
 * Index i of the fold edge P[i] → P[i+1] of a half piece: a straight sew edge (no handles) whose two
 * ends lie on the axis a→b (1e-4 mm). −1 when there is none.
 */
export function findHalfFoldEdge(points: Anchor[], a: Vec, b: Vec): number {
  const n = points.length;
  const d = sub(b, a); const L = Math.hypot(d.x, d.y);
  if (L < 1e-12 || n < 2) return -1;
  const side = (p: Vec) => (d.x * (p.y - a.y) - d.y * (p.x - a.x)) / L;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (Math.abs(side(points[i])) < 1e-4 && Math.abs(side(points[j])) < 1e-4 && !points[i].hOut && !points[j].hIn) return i;
  }
  return -1;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const isZeroGrade = (g: Record<SizeId, GradeInc>) => Object.values(g).every(v => Math.abs(v.dx) < 1e-12 && Math.abs(v.dy) < 1e-12);
const mirrorGradeRec = (g: Record<SizeId, GradeInc> | undefined, d: Vec): Record<SizeId, GradeInc> => {
  const o: Record<SizeId, GradeInc> = {};
  if (g) for (const k of Object.keys(g)) { const v = reflectVec({ x: g[k].dx, y: g[k].dy }, d); o[k] = { dx: v.x, dy: v.y }; }
  return o;
};

/**
 * The full (opened) piece of a live half piece, derived on the fly — never written to the document.
 *
 * The authored half stays the master. The half's interior anchors are reflected across the fold edge
 * E0 → E1 and inserted between E0 and E1 in reverse order, with ids `<id>~m` and `flags.derived = true`.
 * Authored anchors keep their order and ids (indices up to E0 are unchanged). The fold edge itself
 * disappears (it is interior, so it carries no seam).
 * In every size the mirror is taken across THAT size's fold edge (the resolved E0, E1), so a graded
 * fold edge still opens without a gap: mirrored anchors whose plain reflected grading would not land
 * there get explicit per-size grading.
 *
 * Mirrored with it: seam allowances (segment leaving a mirrored anchor = the mirrored segment's
 * allowance), corner specs (boxed / turnback sides swapped), sew-line notches (fromPrev ↔ fromNext,
 * proportional pct → 100 − pct from the other end, angle negated; notches on the fold edge are
 * dropped), internals (except fold / mirror lines and internals that are their own mirror image),
 * darts on the sew line, drills, texts and artwork. Pleats and fullness records are not mirrored.
 * A manual cut cannot be mirrored and falls back to the auto cut line.
 *
 * Returns `piece` itself when it is not a half piece or its fold edge cannot be found.
 */
export function halfOpenedPiece(piece: Piece, line: SizeLine): Piece {
  const h = piece.half;
  if (!h || !piece.sew.closed || piece.sew.points.length < 3) return piece;
  const i0 = findHalfFoldEdge(piece.sew.points, h.a, h.b);
  if (i0 < 0) return piece;
  const p: Piece = clone(piece);
  delete p.half;
  const n = p.sew.points.length;
  const P = [...p.sew.points.slice(i0 + 1), ...p.sew.points.slice(0, i0 + 1)]; // E1 … E0
  const E1 = P[0], E0 = P[n - 1];
  const sizes = line.sizes.map(s => s.id);
  const base = { a: { x: E0.x, y: E0.y }, d: sub(E1, E0) };
  const axisOf = new Map<SizeId, { a: Vec; d: Vec }>();
  const halfPos = new Map<SizeId, Vec[]>();
  for (const s of sizes) {
    const pos = anchorPositions(P, line, s, true);
    halfPos.set(s, pos);
    axisOf.set(s, { a: pos[n - 1], d: sub(pos[0], pos[n - 1]) });
  }
  const shared = new Set([E0.id, E1.id]);
  const mid = (id: Id) => (shared.has(id) ? id : mirroredId(id));
  const swapSide = (e?: 'prev' | 'next' | 'both') => (e === 'prev' ? 'next' : e === 'next' ? 'prev' : e);

  // previous grade anchor (cyclic, in the half)
  const prevGrade = (k: number): Anchor | undefined => { for (let q = 1; q <= n; q++) { const a = P[(k - q + n) % n]; if (a.kind === 'grade') return a; } return undefined; };
  const mirrorAnchor = (q: Anchor, k: number): Anchor => {
    const m: Anchor = clone(q);
    m.id = mirroredId(q.id);
    const r = reflectPt(q, base.a, base.d); m.x = r.x; m.y = r.y;
    delete m.hIn; delete m.hOut;
    if (q.hOut) m.hIn = reflectVec(q.hOut, base.d);
    if (q.hIn) m.hOut = reflectVec(q.hIn, base.d);
    m.grade = mirrorGradeRec(q.grade, base.d);
    if (q.grade2) m.grade2 = mirrorGradeRec(q.grade2, base.d);
    if (q.gradeAxisDeg) m.gradeAxisDeg = -q.gradeAxisDeg;
    delete m.seamAfter;
    if (q.kind === 'grade') { const pg = prevGrade(k); if (pg?.seamAfter !== undefined) m.seamAfter = pg.seamAfter; }
    if (m.corner) {
      if (m.corner.extend) m.corner.extend = swapSide(m.corner.extend);
      if (m.corner.manualPoints) m.corner.manualPoints = m.corner.manualPoints.map(v => reflectPt(v, base.a, base.d));
      delete m.corner.lockedPerSize;
    }
    m.flags = { ...q.flags, derived: true }; delete m.flags.startPoint;
    return m;
  };
  const mirrored: Anchor[] = [];
  for (let k = n - 2; k >= 1; k--) mirrored.push(mirrorAnchor(P[k], k));
  // E0 now continues into the mirrored half: its outgoing segment mirrors its incoming one
  const e0 = P[n - 1], e1 = P[0];
  const pg0 = prevGrade(n - 1);
  if (e0.kind === 'grade') { if (pg0?.seamAfter !== undefined) e0.seamAfter = pg0.seamAfter; else delete e0.seamAfter; }
  if (e0.hIn) e0.hOut = reflectVec(e0.hIn, base.d);
  if (e1.hOut) e1.hIn = reflectVec(e1.hOut, base.d);
  const F = [...P, ...mirrored];

  // exact per-size targets: authored anchors stay put, mirrored ones reflect across that size's fold edge
  const target = (s: SizeId, j: number): Vec => {
    const hp = halfPos.get(s)!;
    if (j < n) return hp[j];
    const ax = axisOf.get(s)!;
    return reflectPt(hp[n - 1 - (j - n + 1)], ax.a, ax.d);
  };
  const materialise = (j: number) => {
    const abs: Record<SizeId, GradeInc> = {};
    for (const s of sizes) { const t = target(s, j); abs[s] = { dx: t.x - F[j].x, dy: t.y - F[j].y }; }
    F[j].grade = absoluteToIncremental(abs, line); delete F[j].gradeAxisDeg;
  };
  for (const pass of ['grade', 'curve'] as const) {
    const bad = new Set<number>();
    for (const s of sizes) {
      if (s === line.baseSizeId) continue;
      const pos = anchorPositions(F, line, s, true);
      F.forEach((a, j) => { if (a.kind === pass && Math.hypot(pos[j].x - target(s, j).x, pos[j].y - target(s, j).y) > 1e-9) bad.add(j); });
    }
    for (const j of bad) materialise(j);
  }
  // back to authored order: authored anchors keep their indices up to E0, the mirrored run follows E0
  const start = F.findIndex(a => a.id === piece.sew.points[0].id);
  p.sew.points = [...F.slice(start), ...F.slice(0, start)];

  // exact per-size mirror of a graded free point
  const mirrorObj = <T extends { x: number; y: number; grade: Record<SizeId, GradeInc> }>(o: T): T => {
    const m: T = clone(o);
    const r = reflectPt(o, base.a, base.d); m.x = r.x; m.y = r.y;
    const abs: Record<SizeId, GradeInc> = {};
    for (const s of sizes) {
      const off = absoluteOffset(o.grade, line, s), ax = axisOf.get(s)!;
      const t = reflectPt({ x: o.x + off.x, y: o.y + off.y }, ax.a, ax.d);
      abs[s] = { dx: t.x - r.x, dy: t.y - r.y };
    }
    const g = absoluteToIncremental(abs, line);
    m.grade = isZeroGrade(g) ? {} : g;
    const g2 = (o as { grade2?: Record<SizeId, GradeInc> }).grade2;
    if (g2) (m as { grade2?: Record<SizeId, GradeInc> }).grade2 = mirrorGradeRec(g2, base.d);
    return m;
  };
  const offAxis = (o: Vec) => dist(reflectPt(o, base.a, base.d), o) > 1e-6;

  // internals
  const extra: Contour[] = [];
  for (const c of p.internals) {
    if (c.type === 'fold' || c.type === 'mirror' || c.points.length === 0) continue;
    const m: Contour = clone(c);
    m.id = mirroredId(c.id);
    m.points = c.points.map(q => {
      const a: Anchor = clone(q);
      a.id = mirroredId(q.id);
      const r = reflectPt(q, base.a, base.d); a.x = r.x; a.y = r.y;
      if (q.hIn) a.hIn = reflectVec(q.hIn, base.d);
      if (q.hOut) a.hOut = reflectVec(q.hOut, base.d);
      a.flags = { ...q.flags, derived: true };
      return a;
    });
    // exact per-size grading of every mirrored internal anchor (positions of the original, reflected per size)
    const origPos = new Map(sizes.map(s => [s, anchorPositions(c.points, line, s, c.closed)]));
    m.points.forEach((a, j) => {
      const abs: Record<SizeId, GradeInc> = {};
      for (const s of sizes) { const ax = axisOf.get(s)!; const t = reflectPt(origPos.get(s)![j], ax.a, ax.d); abs[s] = { dx: t.x - a.x, dy: t.y - a.y }; }
      // explicit grading (zeros included for curve points, so they are never re-interpolated)
      const g = absoluteToIncremental(abs, line);
      a.grade = a.kind === 'grade' && isZeroGrade(g) ? {} : g; delete a.gradeAxisDeg;
    });
    if (!c.closed && m.points.length > 1) {
      m.points.reverse();
      for (const a of m.points) { const hi = a.hIn, ho = a.hOut; delete a.hIn; delete a.hOut; if (ho) a.hIn = ho; if (hi) a.hOut = hi; }
    }
    const self = c.points.length === m.points.length && (m.points.every((a, j) => dist(a, c.points[j]) < 1e-6) || m.points.every((a, j) => dist(a, c.points[c.points.length - 1 - j]) < 1e-6));
    if (!self) extra.push(m);
  }
  const reversedInternal = new Set(extra.filter(c => !c.closed).map(c => c.id));
  p.internals.push(...extra);
  const extraIds = new Set(extra.map(c => c.id));

  // notches
  const nextGrade = (id: Id): Id | undefined => {
    const k = P.findIndex(a => a.id === id); if (k < 0) return undefined;
    for (let q = 1; q <= n; q++) { const a = P[(k + q) % n]; if (a.kind === 'grade') return a.id; }
    return undefined;
  };
  const notches: Notch[] = [];
  for (const nt of p.notches) {
    const pl = nt.placement;
    if (nt.contourId === p.sew.id) {
      // on the fold edge → interior after opening
      const onFold = (pl.kind === 'fromPrev' && pl.anchorId === E0.id) || (pl.kind === 'fromNext' && pl.anchorId === E1.id)
        || (pl.kind === 'proportional' && pl.anchorId === E0.id && (nt.spanEndAnchorId ?? nextGrade(E0.id)) === E1.id);
      if (onFold) continue;
      notches.push(nt);
      const m: Notch = clone(nt);
      m.id = mirroredId(nt.id); m.angleDeg = -nt.angleDeg;
      if (nt.cornerDir) m.cornerDir = nt.cornerDir === 'prev' ? 'next' : 'prev';
      if (pl.kind === 'anchor') { if (shared.has(pl.anchorId)) continue; m.placement = { kind: 'anchor', anchorId: mid(pl.anchorId) }; }
      else if (pl.kind === 'fromPrev') m.placement = { kind: 'fromNext', anchorId: mid(pl.anchorId), dist: { ...pl.dist } };
      else if (pl.kind === 'fromNext') m.placement = { kind: 'fromPrev', anchorId: mid(pl.anchorId), dist: { ...pl.dist } };
      else {
        const end = nt.spanEndAnchorId ?? nextGrade(pl.anchorId); if (!end) continue;
        m.placement = { kind: 'proportional', anchorId: mid(end), pct: 100 - pl.pct };
        if (nt.spanEndAnchorId) m.spanEndAnchorId = mid(pl.anchorId); else delete m.spanEndAnchorId;
      }
      notches.push(m);
    } else {
      notches.push(nt);
      const cid = mirroredId(nt.contourId);
      if (!extraIds.has(cid)) continue;
      const m: Notch = clone(nt);
      m.id = mirroredId(nt.id); m.contourId = cid; m.angleDeg = -nt.angleDeg;
      if (reversedInternal.has(cid)) {
        if (pl.kind === 'fromPrev') m.placement = { kind: 'fromNext', anchorId: mirroredId(pl.anchorId), dist: { ...pl.dist } };
        else if (pl.kind === 'fromNext') m.placement = { kind: 'fromPrev', anchorId: mirroredId(pl.anchorId), dist: { ...pl.dist } };
        else if (pl.kind === 'anchor') m.placement = { kind: 'anchor', anchorId: mirroredId(pl.anchorId) };
        else continue; // proportional on a reversed open internal: not mirrored
      } else {
        m.placement = { ...clone(pl), anchorId: mirroredId(pl.anchorId) } as Notch['placement'];
        if (nt.spanEndAnchorId) m.spanEndAnchorId = mirroredId(nt.spanEndAnchorId);
      }
      notches.push(m);
    }
  }
  p.notches = notches;

  // darts on the sew line
  const darts: Dart[] = [];
  for (const d of p.darts) {
    darts.push(d);
    if (!P.some(a => a.id === d.legA) || !P.some(a => a.id === d.legB)) continue;
    const m: Dart = clone(d);
    m.id = mirroredId(d.id); m.legA = mid(d.legB); m.legB = mid(d.legA); m.fold = d.fold === 'A' ? 'B' : 'A';
    m.apex = mirrorObj(d.apex as { x: number; y: number; grade: Record<SizeId, GradeInc> }) as Dart['apex'];
    delete m.closedLegs;
    if (d.axisContourId) { if (extraIds.has(mirroredId(d.axisContourId))) m.axisContourId = mirroredId(d.axisContourId); else delete m.axisContourId; }
    darts.push(m);
  }
  p.darts = darts;
  p.drills = [...p.drills, ...p.drills.filter(offAxis).map(d => ({ ...mirrorObj(d), id: mirroredId(d.id) }))];
  p.texts = [...p.texts, ...p.texts.filter(offAxis).map(t => ({ ...mirrorObj(t), id: mirroredId(t.id) }))];
  p.artwork = [...p.artwork, ...p.artwork.filter(offAxis).map(a => ({ ...mirrorObj(a), id: mirroredId(a.id), scaleX: -a.scaleX }))];
  if (p.cutMode === 'manual') { p.cutMode = 'auto'; delete p.manualCut; }
  return p;
}

/**
 * B10 workaround (the proper fix belongs in ops/seam.ts::build, which gives a zero-length grade
 * segment its un-offset sew point as "offset" so the cut line touches the sew corner): for the cut
 * line only, drop a sew grade anchor that coincides (1e-6 mm, in this size) with the next grade anchor
 * when only straight geometry lies between them. The surviving anchor keeps its own seam and corner
 * (a corner spec on the dropped one is moved over when the survivor has none). Anchors that live
 * objects reference (dart legs, pleat edges, notch anchors) are kept. Returns `piece` when nothing
 * is dropped.
 */
export function withoutZeroSegments(piece: Piece, line: SizeLine, sid: SizeId): Piece {
  const P = piece.sew.points;
  if (!piece.sew.closed || P.length < 4 || piece.noSeam) return piece;
  const pos = anchorPositions(P, line, sid, true);
  const n = P.length;
  const protect = new Set<string>();
  for (const d of piece.darts ?? []) { protect.add(d.legA); protect.add(d.legB); }
  for (const pl of piece.pleats ?? []) for (const e of pl.edges ?? []) { protect.add(e.fixed); protect.add(e.moving); if (e.mid) protect.add(e.mid); }
  for (const nt of piece.notches ?? []) if (nt.contourId === piece.sew.id) protect.add(nt.placement.anchorId);
  const drop = new Set<number>();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (P[i].kind !== 'grade' || P[j].kind !== 'grade' || drop.has(j)) continue;
    if (Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y) > 1e-6) continue;
    if (protect.has(P[i].id) || P[i].hOut || P[j].hIn) continue;
    if (n - drop.size - 1 < 3) break;
    drop.add(i);
  }
  if (!drop.size) return piece;
  const q: Piece = { ...piece, sew: { ...piece.sew, points: [] } };
  const pts: Anchor[] = [];
  for (let i = 0; i < n; i++) {
    if (drop.has(i)) continue;
    let a = P[i];
    const prev = (i - 1 + n) % n;
    if (drop.has(prev) && P[prev].corner && !a.corner) a = { ...a, corner: P[prev].corner };
    pts.push(a);
  }
  q.sew.points = pts;
  return q;
}
