/**
 * Shared IO helpers: the intermediate "raw group" representation every importer produces, the
 * Piece builder (point classification, seam inference, notch anchoring), drawing geometry used by
 * every exporter, notch resolution, layout packing and small geometry helpers.
 *
 * Frame: y-UP mm everywhere. Importers convert their file's frame into this; exporters convert out.
 */
import type { Vec, Box } from '../geom/vec';
import { sub, add, mul, dist, norm, dot, cross, len, bbox, rotate, rad, deg, angleBetween } from '../geom/vec';
import { signedArea, area, pointInPolygon, distToPolygon, closestPoint, pointAtLength, polylineLength } from '../geom/poly';
import { resolveContour, spanPolyline, absoluteOffset, type ResolvedContour } from '../model/contour';
import { computeCutLine } from '../ops/seam';
import { makeAnchor, makeContour, makePiece, newId, DEFAULT_NOTCH_SETUP } from '../model/factory';
import type {
  Anchor, Contour, ContourType, GradeInc, Id, Notch, NotchType, Piece, RuleLibrary, SizeId, SizeLine, Style,
} from '../model/types';
import type { Document } from '../model/doc';
import type { Unit } from '../units';

// ───────────────────────── report ─────────────────────────

export interface LayerInfo { role: string; entities: number }

export interface ImportReport {
  pieces: Piece[];
  warnings: string[];
  /** informational notes (what was recognised) */
  notes: string[];
  /** layer name → recognised role + entity count */
  layerMap: Record<string, LayerInfo>;
  unitsDetected: Unit;
  unitsSource: 'option' | 'header' | 'heuristic' | 'default';
  /** true when the importer negated y to reach the kernel's y-up frame (SVG: always; DXF/HPGL: never unless forced) */
  yFlipped: boolean;
  /** size line / table the pieces reference (created from the .rul file or the size attribute) */
  sizeLine: SizeLine;
  sizeTable: { id: Id; name: string; axis1: SizeLine };
  /** grade-rule numbers found on vertices but not resolvable (no .rul or unknown number) */
  unresolvedRules?: number[];
  /** grade-rule library built from the companion .rul file */
  ruleLibrary?: RuleLibrary;
}

// ───────────────────────── raw intermediate ─────────────────────────

export interface RawVertex {
  x: number; y: number;
  /** vertex came from sampling a curve (arc, bulge, spline, Bézier) */
  curve?: boolean;
  /** explicit point-kind marker from the file (AAMA layer 2 = turn, layer 3 = curve) */
  marker?: 'turn' | 'curve';
  /** grade rule number attached to the vertex */
  rule?: number;
  /** resolved incremental grading for the vertex */
  grade?: Record<SizeId, GradeInc>;
}

export interface RawPoly { pts: RawVertex[]; closed: boolean; type?: ContourType; mode?: 'draw' | 'cut'; name?: string }
export type RawNotch =
  | { kind: 'line'; a: Vec; b: Vec; type?: NotchType; gradeA?: Record<SizeId, GradeInc>; gradeB?: Record<SizeId, GradeInc> }
  | { kind: 'point'; p: Vec; type?: NotchType; grade?: Record<SizeId, GradeInc> };
export interface RawText { p: Vec; text: string; h: number; rot: number; grade?: Record<SizeId, GradeInc> }
export interface RawDrill { p: Vec; d: number; grade?: Record<SizeId, GradeInc> }

export interface RawGroup {
  name?: string;
  sew?: RawPoly;
  cut?: RawPoly;
  internals: RawPoly[];
  notches: RawNotch[];
  drills: RawDrill[];
  grain?: { a: Vec; b: Vec; gradeA?: Record<SizeId, GradeInc>; gradeB?: Record<SizeId, GradeInc> };
  texts: RawText[];
  attrs: Record<string, string>;
}

export const emptyGroup = (): RawGroup => ({ internals: [], notches: [], drills: [], texts: [], attrs: {} });

export interface BuildOptions {
  line: SizeLine;
  sizeTableId: Id;
  /** turning angle (deg) at or above which an unmarked vertex is a corner grade point. Default 25° */
  cornerAngleDeg?: number;
  /** max deviation (mm) between the file's cut line and the re-derived offset for seams to be inferred. Default 0.1 */
  seamInferTol?: number;
  /** 'infer' (default): infer per-segment seams, fall back to manual cut; 'manual': always keep the file's cut as manualCut */
  seamMode?: 'infer' | 'manual';
  defaultDrillDiameter?: number;
  notchSetup?: Style['settings']['notchSetup'];
}

// ───────────────────────── small geometry ─────────────────────────

/** Sample a circular arc (centre c, radius r, start/end angles rad, ccw sweep sign) with ≤ tol chord error. Includes both endpoints. */
export function sampleArc(c: Vec, r: number, a0: number, sweep: number, tol = 0.01): Vec[] {
  const maxStep = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 4;
  const n = Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-3))));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + sweep * (i / n); out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }); }
  return out;
}

/** DXF bulge arc from p1 to p2 (bulge = tan(θ/4), positive = CCW). Returns interior points only. */
export function bulgePoints(p1: Vec, p2: Vec, bulge: number, tol = 0.01): Vec[] {
  if (Math.abs(bulge) < 1e-12) return [];
  const chord = dist(p1, p2); if (chord < 1e-12) return [];
  const theta = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const u = norm(sub(p2, p1));
  const nrm = { x: -u.y, y: u.x }; // left normal
  const h = r * Math.cos(Math.abs(theta) / 2); // centre distance from chord
  const sgn = bulge > 0 ? 1 : -1;
  // for |θ|<π the centre lies to the left of travel for CCW (bulge>0)
  const c = add(m, mul(nrm, sgn * h * (Math.abs(theta) <= Math.PI ? 1 : -1)));
  const a0 = Math.atan2(p1.y - c.y, p1.x - c.x);
  const pts = sampleArc(c, Math.abs(r), a0, theta, tol);
  return pts.slice(1, -1);
}

/** Uniform/non-uniform rational B-spline sampling (de Boor). */
export function sampleBSpline(ctrl: Vec[], degree: number, knots: number[], weights?: number[], perSpan = 16): Vec[] {
  const n = ctrl.length;
  if (n < 2) return ctrl.slice();
  const p = Math.max(1, Math.min(degree, n - 1));
  let U = knots;
  if (U.length !== n + p + 1) { // clamped uniform fallback
    U = []; for (let i = 0; i <= n + p; i++) U.push(i <= p ? 0 : i >= n ? n - p : i - p);
  }
  const W = weights && weights.length === n ? weights : new Array(n).fill(1);
  const t0 = U[p], t1 = U[n];
  const spans = Math.max(1, n - p);
  const N = spans * perSpan;
  const out: Vec[] = [];
  for (let s = 0; s <= N; s++) {
    let t = t0 + (t1 - t0) * (s / N);
    if (s === N) t = t1 - 1e-12 * Math.max(1, Math.abs(t1));
    let k = p; while (k < n - 1 && U[k + 1] <= t) k++;
    const d: { x: number; y: number; w: number }[] = [];
    for (let j = 0; j <= p; j++) { const q = ctrl[k - p + j], w = W[k - p + j]; d.push({ x: q.x * w, y: q.y * w, w }); }
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const den = U[i + p - r + 1] - U[i];
      const a = den === 0 ? 0 : (t - U[i]) / den;
      d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
    }
    out.push({ x: d[p].x / d[p].w, y: d[p].y / d[p].w });
  }
  return out;
}

/** Turning angle at vertex i (degrees, 0 = straight). */
export function turningAngle(prev: Vec, cur: Vec, next: Vec): number {
  const a = sub(cur, prev), b = sub(next, cur);
  if (len(a) < 1e-12 || len(b) < 1e-12) return 180;
  return Math.abs(deg(angleBetween(a, b)));
}

/** Nearest forward intersection of a ray with a closed polygon (t ≥ 0). */
export function rayPolygon(p: Vec, dir: Vec, poly: Vec[], maxT = 1e6): { pt: Vec; t: number } | null {
  let best: { pt: Vec; t: number } | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const s = sub(b, a); const den = cross(dir, s);
    if (Math.abs(den) < 1e-12) continue;
    const ap = sub(a, p);
    const t = cross(ap, s) / den, u = cross(ap, dir) / den;
    if (t >= -1e-9 && t <= maxT && u >= -1e-9 && u <= 1 + 1e-9 && (!best || t < best.t)) best = { pt: add(p, mul(dir, t)), t };
  }
  return best;
}

/** Intersection of the infinite line (p + u·t) with an open polyline: the hit with the smallest |t|. */
export function linePolyline(p: Vec, u: Vec, poly: Vec[]): { pt: Vec; t: number } | null {
  let best: { pt: Vec; t: number } | null = null;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const s = sub(b, a); const den = cross(u, s);
    if (Math.abs(den) < 1e-12) continue;
    const ap = sub(a, p);
    const t = cross(ap, s) / den, w = cross(ap, u) / den;
    if (w >= -1e-9 && w <= 1 + 1e-9 && (!best || Math.abs(t) < Math.abs(best.t))) best = { pt: add(p, mul(u, t)), t };
  }
  return best;
}

export const ring = (pts: Vec[]): Vec[] => (pts.length ? [...pts, pts[0]] : pts);

/** Point + tangent at arc length s along a polyline (closed → wraps). At an exact vertex of a closed contour the tangent is the bisector. */
export function frameAt(pts: Vec[], closed: boolean, s: number): { p: Vec; t: Vec; s: number } {
  const P = closed ? ring(pts) : pts;
  const total = polylineLength(P);
  if (closed && total > 0) s = ((s % total) + total) % total;
  else s = Math.max(0, Math.min(total, s));
  const r = pointAtLength(P, s);
  // vertex detection
  let acc = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const L = dist(P[i], P[i + 1]);
    if (Math.abs(acc - s) < 1e-9 && L > 0) {
      const prevIdx = i === 0 ? (closed ? P.length - 2 : -1) : i - 1;
      if (prevIdx >= 0) {
        const tin = norm(sub(P[i], P[prevIdx === i ? 0 : prevIdx])), tout = norm(sub(P[i + 1], P[i]));
        const b = norm(add(tin, tout));
        return { p: { ...P[i] }, t: len(b) > 1e-9 ? b : tout, s };
      }
      return { p: { ...P[i] }, t: norm(sub(P[i + 1], P[i])), s };
    }
    acc += L;
  }
  return { p: r.pt, t: r.tangent, s };
}

/** Outward normal for a closed contour of the given winding (right of travel for CCW). */
export const outwardNormal = (t: Vec, ccw: boolean): Vec => (ccw ? { x: t.y, y: -t.x } : { x: -t.y, y: t.x });

// ───────────────────────── notches ─────────────────────────

export function notchDist(dist: Record<SizeId, number>, line: SizeLine, sizeId: SizeId): number {
  if (dist[sizeId] !== undefined) return dist[sizeId];
  if (dist[line.baseSizeId] !== undefined) return dist[line.baseSizeId];
  const v = Object.values(dist); return v.length ? v[0] : 0;
}

export function contourById(piece: Piece, id: Id): Contour | undefined {
  if (piece.sew.id === id) return piece.sew;
  if (piece.manualCut && piece.manualCut.id === id) return piece.manualCut;
  return piece.internals.find(c => c.id === id);
}

/**
 * Resolve a notch for a size: the point on its contour, the unit tangent and the outward normal.
 * fromPrev: `dist` mm forward (contour order) from the anchor; fromNext: backward; proportional:
 * `pct` (0..100) of the grade segment that starts at the anchor.
 */
export function resolveNotch(piece: Piece, notch: Notch, line: SizeLine, sizeId: SizeId, r?: ResolvedContour): { p: Vec; t: Vec; nOut: Vec; s: number } | null {
  const c = contourById(piece, notch.contourId);
  if (!c) return null;
  const rc = r ?? resolveContour(c, line, sizeId);
  const ai = c.points.findIndex(a => a.id === notch.placement.anchorId);
  if (ai < 0) return null;
  const s0 = rc.cum[rc.anchorIndex[ai]];
  let s = s0;
  const pl = notch.placement;
  if (pl.kind === 'fromPrev') s = s0 + notchDist(pl.dist, line, sizeId);
  else if (pl.kind === 'fromNext') s = s0 - notchDist(pl.dist, line, sizeId);
  else if (pl.kind === 'proportional') {
    const gi = rc.gradeIdx;
    const k = gi.indexOf(ai);
    let segLen = 0;
    if (k >= 0) {
      const nb = rc.closed ? gi[(k + 1) % gi.length] : gi[Math.min(k + 1, gi.length - 1)];
      const poly = spanPolyline(rc, ai, nb); segLen = polylineLength(poly);
    }
    s = s0 + (pl.pct / 100) * segLen;
  }
  const f = frameAt(rc.pts, rc.closed, s);
  const ccw = signedArea(rc.pts) > 0;
  const nOut = rc.closed ? outwardNormal(f.t, ccw) : { x: f.t.y, y: -f.t.x };
  return { p: f.p, t: f.t, nOut, s: f.s };
}

// ───────────────────────── piece builder ─────────────────────────

/** Convert raw vertices into anchors (dedupes closing duplicate, classifies kinds). */
export function toAnchors(raw: RawVertex[], closed: boolean, cornerAngleDeg = 25): Anchor[] {
  let pts = raw.filter((v, i) => i === 0 || dist(v, raw[i - 1]) > 1e-7);
  if (closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-6) {
    const last = pts.pop()!;
    // keep metadata of the duplicate if the first vertex lacks it
    if (!pts[0].marker && last.marker) pts[0] = { ...pts[0], marker: last.marker };
    if (pts[0].rule === undefined && last.rule !== undefined) pts[0] = { ...pts[0], rule: last.rule, grade: last.grade };
  }
  const n = pts.length;
  const hasMarkers = pts.some(v => v.marker);
  const out: Anchor[] = [];
  for (let i = 0; i < n; i++) {
    const v = pts[i];
    const endpoint = !closed && (i === 0 || i === n - 1);
    const ang = endpoint || n < 3 ? 180 : turningAngle(pts[(i - 1 + n) % n], v, pts[(i + 1) % n]);
    const sharp = ang >= cornerAngleDeg;
    let kind: 'grade' | 'curve';
    if (v.marker === 'turn') kind = 'grade';
    else if (v.marker === 'curve') kind = 'curve';
    else if (endpoint) kind = 'grade';
    else if (hasMarkers) kind = 'curve';
    else if (v.rule !== undefined && !v.curve) kind = 'grade';
    else kind = sharp ? 'grade' : 'curve';
    // A vertex is smooth only when it sits inside a curve: not sharp, and its two adjacent edges are of
    // comparable length (a sampled curve is evenly spaced; a long straight edge meeting a curve is not) —
    // otherwise Catmull-Rom would bow the straight edge.
    let smooth = false;
    if (!endpoint && !sharp && n >= 3) {
      const l0 = dist(pts[(i - 1 + n) % n], v), l1 = dist(v, pts[(i + 1) % n]);
      const ratio = Math.max(l0, l1) / Math.max(Math.min(l0, l1), 1e-12);
      const neighCurve = (j: number) => pts[j].marker === 'curve' || (!pts[j].marker && !!pts[j].curve);
      smooth = v.marker === 'curve' || v.curve ? ratio < 4 : ratio < 4 && (hasMarkers ? neighCurve((i - 1 + n) % n) && neighCurve((i + 1) % n) : true);
    }
    const a = makeAnchor(v.x, v.y, { kind, smooth });
    if (v.grade) a.grade = v.grade;
    if (v.rule !== undefined) a.ruleId = String(v.rule);
    out.push(a);
  }
  if (out.length && !out.some(a => a.kind === 'grade')) { out[0].kind = 'grade'; }
  if (out.length) out[0].flags.startPoint = true;
  return out;
}

export function rawToContour(p: RawPoly, type: ContourType, cornerAngleDeg?: number): Contour {
  const c = makeContour(toAnchors(p.pts, p.closed, cornerAngleDeg), { type, closed: p.closed });
  if (p.mode) c.mode = p.mode;
  if (p.name) c.name = p.name;
  return c;
}

function maxDeviation(a: Vec[], b: Vec[]): number {
  let m = 0;
  for (const q of a) m = Math.max(m, distToPolygon(q, b));
  for (const q of b) m = Math.max(m, distToPolygon(q, a));
  return m;
}

/** Infer per-grade-segment seam allowances from a sew contour and a cut polygon. Returns deviation (mm). */
export function inferSeams(piece: Piece, cut: Vec[], line: SizeLine): number {
  const r = resolveContour(piece.sew, line, line.baseSizeId);
  const g = r.gradeIdx;
  const vals: number[] = [];
  for (let k = 0; k < g.length; k++) {
    const a = g[k], b = r.closed ? g[(k + 1) % g.length] : g[Math.min(k + 1, g.length - 1)];
    const poly = spanPolyline(r, a, b);
    const L = polylineLength(poly);
    const mid = pointAtLength(poly, L / 2).pt;
    vals.push(Math.round(distToPolygon(mid, cut) * 100) / 100);
  }
  // most common value = piece default
  const counts = new Map<number, number>();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  let def = vals[0] ?? 0, best = -1;
  for (const [v, c] of counts) if (c > best) { best = c; def = v; }
  piece.seamDefault = def;
  for (let k = 0; k < g.length; k++) {
    const an = piece.sew.points[g[k]];
    if (vals[k] !== def) an.seamAfter = vals[k]; else delete an.seamAfter;
  }
  const derived = computeCutLine(piece, line, line.baseSizeId);
  return maxDeviation(cut, derived);
}

export function defaultGrain(poly: Vec[]): { a: Vec; b: Vec } {
  const b = bbox(poly);
  const cx = (b.minX + b.maxX) / 2, h = b.maxY - b.minY;
  return { a: { x: cx, y: b.minY + h * 0.25 }, b: { x: cx, y: b.minY + h * 0.75 } };
}

/**
 * Place a notch given in the file as a line (or point) on the piece's sew contour.
 * Returns null if it cannot be anchored.
 */
export function anchorNotch(piece: Piece, raw: RawNotch, line: SizeLine, cutPoly: Vec[], setup: Style['settings']['notchSetup']): Notch | null {
  const r = resolveContour(piece.sew, line, line.baseSizeId);
  const R = ring(r.pts);
  let onSew: Vec; let depth: number; let u: Vec | null = null;
  if (raw.kind === 'line') {
    const da = distToPolygon(raw.a, cutPoly), db = distToPolygon(raw.b, cutPoly);
    const outer = da <= db ? raw.a : raw.b, inner = da <= db ? raw.b : raw.a;
    depth = dist(outer, inner);
    u = norm(sub(inner, outer));
    const hit = depth > 1e-9 ? linePolyline(outer, u, R) : null;
    onSew = hit && Math.abs(hit.t) < 100 ? hit.pt : closestPoint(R, outer).pt;
  } else {
    onSew = closestPoint(R, raw.p).pt; depth = setup.slit.depth;
  }
  const cl = closestPoint(R, onSew);
  const total = r.cum[r.cum.length - 1];
  const s = cl.s;
  // previous grade anchor in contour order
  const gs = r.gradeIdx.map(i => ({ i, s: r.cum[r.anchorIndex[i]] }));
  if (!gs.length) return null;
  let prev = gs[gs.length - 1], d = s - prev.s + (s < prev.s ? total : 0);
  for (const g of gs) if (g.s <= s + 1e-9) { prev = g; d = s - g.s; }
  if (d < 0) d += total;
  const type: NotchType = raw.type ?? 'slit';
  let angleDeg = 0;
  if (u) {
    const f = frameAt(r.pts, true, s);
    const nIn = mul(outwardNormal(f.t, signedArea(r.pts) > 0), -1);
    angleDeg = Math.round(deg(angleBetween(nIn, u)) * 1e6) / 1e6;
    if (Math.abs(angleDeg) < 1e-4) angleDeg = 0;
  }
  const anchor = piece.sew.points[prev.i];
  // Graded notch (flat DXF + RUL): the file carries a grade rule on one notch endpoint. Per size, move
  // that endpoint by its rule, project it onto that size's sew line and add the change of its arc
  // distance from the anchor to the base distance (so the base placement method is kept exactly).
  const perSize: Record<SizeId, number> = Object.fromEntries(line.sizes.map(z => [z.id, d]));
  const gp = raw.kind === 'line' ? (raw.gradeA ? { p: raw.a, g: raw.gradeA } : raw.gradeB ? { p: raw.b, g: raw.gradeB } : undefined)
    : raw.grade ? { p: raw.p, g: raw.grade } : undefined;
  let graded = false;
  if (gp && line.sizes.length > 1) {
    const arcFromAnchor = (rc: ResolvedContour, q: Vec) => {
      const T = rc.cum[rc.cum.length - 1];
      const RR = ring(rc.pts);
      // same construction as the base placement: along the notch direction from the outer end
      const h = u ? linePolyline(q, u, RR) : null;
      const on = h && Math.abs(h.t) < 100 ? h.pt : q;
      const v = closestPoint(RR, on).s - rc.cum[rc.anchorIndex[prev.i]];
      const m = ((v % T) + T) % T;
      return T - m < 1e-7 ? 0 : m;
    };
    // graded endpoint is the outer one when it is on the cut line, else the file's other end
    const dBase = arcFromAnchor(r, gp.p);
    for (const z of line.sizes) {
      if (z.id === line.baseSizeId) continue;
      const rz = resolveContour(piece.sew, line, z.id);
      const q = add(gp.p, absoluteOffset(gp.g, line, z.id));
      perSize[z.id] = Math.max(0, d + arcFromAnchor(rz, q) - dBase);
      if (Math.abs(perSize[z.id] - d) > 1e-6) graded = true;
    }
  }
  const n: Notch = {
    id: newId('n'), contourId: piece.sew.id, type,
    placement: d < 1e-4 && !graded ? { kind: 'anchor', anchorId: anchor.id } : { kind: 'fromPrev', anchorId: anchor.id, dist: Object.fromEntries(line.sizes.map(z => [z.id, Math.round(perSize[z.id] * 1e6) / 1e6])) },
    depth: Math.round(depth * 1e6) / 1e6, width: setup[type]?.width ?? 0, angleDeg, mode: setup[type]?.mode ?? 'cut', source: 'manual',
  };
  anchor.flags.notchAnchor = true;
  return n;
}

/** Build a kernel Piece from a raw group. Pushes warnings / notes. */
export function buildPiece(g: RawGroup, opt: BuildOptions, warnings: string[], notes: string[], index: number): Piece | null {
  const line = opt.line;
  const setup = opt.notchSetup ?? DEFAULT_NOTCH_SETUP;
  const sewRaw = g.sew ?? g.cut;
  if (!sewRaw || sewRaw.pts.length < 3) { warnings.push(`piece ${index + 1}: no closed boundary — skipped`); return null; }
  const sew = rawToContour({ ...sewRaw, closed: true }, 'perimeter', opt.cornerAngleDeg);
  const name = g.attrs['piece name'] ?? g.name ?? `Piece ${index + 1}`;
  const piece = makePiece(name, sew, opt.sizeTableId);
  const sewPts = resolveContour(sew, line, line.baseSizeId).pts;
  let cutPoly = sewPts;
  if (!g.sew) {
    piece.noSeam = true; piece.seamDefault = 0;
    notes.push(`${name}: boundary only (no sew line) → sew = boundary, noSeam`);
  } else if (!g.cut) {
    piece.noSeam = true; piece.seamDefault = 0;
    warnings.push(`${name}: sew line without a boundary — cut = sew (noSeam)`);
  } else {
    const cutC = rawToContour({ ...g.cut, closed: true }, 'perimeter', opt.cornerAngleDeg);
    cutPoly = resolveContour(cutC, line, line.baseSizeId).pts;
    const dev = (opt.seamMode ?? 'infer') === 'infer' ? inferSeams(piece, cutPoly, line) : Infinity;
    const allZero = piece.seamDefault === 0 && piece.sew.points.every(a => a.seamAfter === undefined || a.seamAfter === 0);
    if (allZero && dev <= (opt.seamInferTol ?? 0.1)) { piece.noSeam = true; notes.push(`${name}: sew = boundary → noSeam`); }
    else if (dev <= (opt.seamInferTol ?? 0.1)) {
      notes.push(`${name}: seam allowances inferred from boundary (default ${piece.seamDefault} mm, max deviation ${dev.toFixed(3)} mm)`);
    } else {
      piece.cutMode = 'manual'; piece.manualCut = cutC;
      if (dev !== Infinity) warnings.push(`${name}: seams could not be inferred (deviation ${dev.toFixed(3)} mm) — boundary kept as manual cut`);
      else notes.push(`${name}: boundary kept as manual cut`);
    }
  }
  for (const ip of g.internals) {
    if (ip.pts.length < 2) continue;
    piece.internals.push(rawToContour(ip, ip.type ?? 'internal', opt.cornerAngleDeg));
  }
  for (const rn of g.notches) {
    const n = anchorNotch(piece, rn, line, cutPoly, setup);
    if (n) piece.notches.push(n); else warnings.push(`${name}: notch could not be anchored`);
  }
  for (const d of g.drills) {
    piece.drills.push({ id: newId('d'), x: d.p.x, y: d.p.y, grade: d.grade ?? {}, diameter: d.d || (opt.defaultDrillDiameter ?? 4), kind: 'drill', mode: 'draw' });
  }
  for (const t of g.texts) {
    piece.texts.push({ id: newId('t'), x: t.p.x, y: t.p.y, grade: t.grade ?? {}, text: t.text, size: t.h || 5, angleDeg: t.rot || 0 });
  }
  if (g.grain) piece.grain = { a: { ...g.grain.a }, b: { ...g.grain.b }, gradeA: g.grain.gradeA ?? {}, gradeB: g.grain.gradeB ?? {}, centered: false };
  else { const dg = defaultGrain(sewPts); piece.grain = { a: dg.a, b: dg.b, gradeA: {}, gradeB: {}, centered: true }; }
  const q = parseInt(g.attrs['quantity'] ?? '', 10);
  if (q > 0) piece.order.qtyPerBundle = q;
  if (g.attrs['material']) piece.order.material = g.attrs['material'];
  if (g.attrs['category']) piece.description = g.attrs['category'];
  return piece;
}

/** Smallest-area closed polygon among `polys` that contains q; else nearest within maxDist. */
export function hostIndex(q: Vec, polys: Vec[][], maxDist = 50): number {
  let best = -1, bestA = Infinity;
  for (let i = 0; i < polys.length; i++) {
    if (pointInPolygon(q, polys[i])) { const a = area(polys[i]); if (a < bestA) { bestA = a; best = i; } }
  }
  if (best >= 0) return best;
  let bd = maxDist;
  for (let i = 0; i < polys.length; i++) { const d = distToPolygon(q, polys[i]); if (d < bd) { bd = d; best = i; } }
  return best;
}

export function nearestIndex(q: Vec, polys: Vec[][], maxDist = 50): number {
  let best = -1, bd = maxDist;
  for (let i = 0; i < polys.length; i++) { const d = distToPolygon(q, polys[i]); if (d < bd) { bd = d; best = i; } }
  return best;
}

/** Is closed polygon `inner` a sew line of `outer` (parallel-ish, fully inside, similar area)? */
export function looksLikeSewOf(inner: Vec[], outer: Vec[], maxSeam = 40): boolean {
  if (!inner.every(p => pointInPolygon(p, outer) || distToPolygon(p, outer) < 1e-6)) return false;
  const ai = area(inner), ao = area(outer);
  if (ao <= 0 || ai / ao < 0.6) return false;
  let mx = 0; for (const p of inner) mx = Math.max(mx, distToPolygon(p, outer));
  let mn = Infinity; for (const p of inner) mn = Math.min(mn, distToPolygon(p, outer));
  return mx <= maxSeam && mn > 0.2;
}

/** Chain open polylines whose endpoints meet (within tol) into longer runs; closes loops. */
export function chainPolys(polys: RawPoly[], tol = 0.05): RawPoly[] {
  const closed = polys.filter(p => p.closed);
  const open = polys.filter(p => !p.closed && p.pts.length >= 2).map(p => ({ ...p, pts: p.pts.slice() }));
  const out: RawPoly[] = [...closed];
  while (open.length) {
    const cur = open.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const o = open[i];
        const cs = cur.pts[0], ce = cur.pts[cur.pts.length - 1], os = o.pts[0], oe = o.pts[o.pts.length - 1];
        if (dist(ce, os) <= tol) cur.pts.push(...o.pts.slice(1));
        else if (dist(ce, oe) <= tol) cur.pts.push(...o.pts.slice(0, -1).reverse());
        else if (dist(cs, oe) <= tol) cur.pts.unshift(...o.pts.slice(0, -1));
        else if (dist(cs, os) <= tol) cur.pts.unshift(...o.pts.slice(1).reverse());
        else continue;
        open.splice(i, 1); grew = true; break;
      }
    }
    if (cur.pts.length > 3 && dist(cur.pts[0], cur.pts[cur.pts.length - 1]) <= tol) { cur.pts.pop(); cur.closed = true; }
    out.push(cur);
  }
  return out;
}

export const rawPts = (p: RawPoly): Vec[] => p.pts.map(v => ({ x: v.x, y: v.y }));

// ───────────────────────── drawing geometry for exporters ─────────────────────────

export interface DrawnNotch { a: Vec; b: Vec; p: Vec; type: NotchType; notch: Notch }
export interface PieceDrawing {
  pieceId: Id; name: string; sizeId: SizeId; sizeName: string;
  cut: Vec[]; sew: Vec[]; hasSeam: boolean;
  sewResolved: ResolvedContour;
  internals: { pts: Vec[]; closed: boolean; type: ContourType; resolved: ResolvedContour; contour: Contour }[];
  notches: DrawnNotch[];
  drills: { p: Vec; d: number }[];
  grain: { a: Vec; b: Vec };
  texts: { p: Vec; text: string; size: number; angleDeg: number }[];
}

/** Notch drawing segment: starts on the cut line (ray along the outward normal from the sew point), runs `depth` inward. */
export function notchSegment(piece: Piece, notch: Notch, line: SizeLine, sizeId: SizeId, cut: Vec[], r?: ResolvedContour): DrawnNotch | null {
  const f = resolveNotch(piece, notch, line, sizeId, notch.contourId === piece.sew.id ? r : undefined);
  if (!f) return null;
  let a = f.p;
  const onSewPerimeter = notch.contourId === piece.sew.id;
  if (onSewPerimeter && !piece.noSeam) {
    const hit = rayPolygon(f.p, f.nOut, cut, 200);
    if (hit) a = hit.pt;
  }
  const dirIn = rotate(mul(f.nOut, -1), rad(notch.angleDeg));
  return { a, b: add(a, mul(dirIn, notch.depth)), p: f.p, type: notch.type, notch };
}

export function drawPiece(doc: Document, piece: Piece, sizeId?: SizeId): PieceDrawing {
  const line = doc.sizeLine(piece);
  const sid = sizeId ?? line.baseSizeId;
  const rp = doc.resolvePiece(piece.id, sid);
  const off = (g: Record<SizeId, GradeInc> | undefined, p: Vec) => add(p, absoluteOffset(g, line, sid));
  const notches: DrawnNotch[] = [];
  for (const n of piece.notches) { const s = notchSegment(piece, n, line, sid, rp.cut, rp.sew); if (s) notches.push(s); }
  return {
    pieceId: piece.id, name: piece.name, sizeId: sid, sizeName: line.sizes.find(s => s.id === sid)?.name ?? sid,
    cut: rp.cut, sew: rp.sew.pts, hasSeam: !piece.noSeam, sewResolved: rp.sew,
    internals: piece.internals.map((c, i) => ({ pts: rp.internals[i].pts, closed: c.closed, type: c.type, resolved: rp.internals[i], contour: c })),
    notches,
    drills: piece.drills.map(d => ({ p: off(d.grade, d), d: d.diameter })),
    grain: rp.grain,
    texts: piece.texts.map(t => ({ p: off(t.grade, t), text: t.text, size: t.size, angleDeg: t.angleDeg })),
  };
}

export function drawingBox(d: PieceDrawing): Box {
  return bbox([...d.cut, ...d.sew, ...d.internals.flatMap(i => i.pts), d.grain.a, d.grain.b]);
}

export function translateDrawing(d: PieceDrawing, o: Vec): PieceDrawing {
  const T = (p: Vec) => ({ x: p.x + o.x, y: p.y + o.y });
  return {
    ...d, cut: d.cut.map(T), sew: d.sew.map(T),
    internals: d.internals.map(i => ({ ...i, pts: i.pts.map(T) })),
    notches: d.notches.map(n => ({ ...n, a: T(n.a), b: T(n.b), p: T(n.p) })),
    drills: d.drills.map(x => ({ ...x, p: T(x.p) })),
    grain: { a: T(d.grain.a), b: T(d.grain.b) },
    texts: d.texts.map(t => ({ ...t, p: T(t.p) })),
  };
}

/**
 * Shelf packing. Rows run left→right up to `limit` (mm) and stack downward from y = 0.
 * Returns, per box, the translation that moves it into place.
 */
export function shelfPack(boxes: Box[], limit: number, gap = 20): Vec[] {
  const out: Vec[] = [];
  let x = 0, top = 0, rowH = 0;
  for (const b of boxes) {
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    if (x > 0 && x + w > limit) { top -= rowH + gap; x = 0; rowH = 0; }
    out.push({ x: x - b.minX, y: top - b.maxY });
    x += w + gap; rowH = Math.max(rowH, h);
  }
  return out;
}

export const SIZE_PALETTE = ['#000000', '#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#8c564b', '#e377c2', '#17becf', '#7f7f7f'];

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16) / 255 || 0, parseInt(v.slice(2, 4), 16) / 255 || 0, parseInt(v.slice(4, 6), 16) / 255 || 0];
}

/** Number formatting for text formats: fixed decimals, trailing zeros trimmed, no "-0". */
export function fmt(n: number, d = 6): string {
  let s = n.toFixed(d);
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}

export { dot };
