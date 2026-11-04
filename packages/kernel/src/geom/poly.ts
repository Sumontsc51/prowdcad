import { Vec, add, sub, mul, dot, cross, dist, norm, perp, len, lerp, EPS, bbox, Box } from './vec';

export type Polyline = Vec[];

/** Open polyline length. */
export function polylineLength(p: Polyline): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]);
  return L;
}
/** Closed polygon perimeter. */
export function perimeter(p: Polyline): number {
  if (p.length < 2) return 0;
  return polylineLength(p) + dist(p[p.length - 1], p[0]);
}
/** Signed area (shoelace). Positive = CCW in a y-up frame. */
export function signedArea(p: Polyline): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) { const q = p[i], r = p[(i + 1) % n]; a += q.x * r.y - r.x * q.y; }
  return a / 2;
}
export const area = (p: Polyline) => Math.abs(signedArea(p));
export const isCCW = (p: Polyline) => signedArea(p) > 0;

/** Cumulative arc-length table. */
export function cumulativeLengths(p: Polyline): number[] {
  const out = [0];
  for (let i = 1; i < p.length; i++) out.push(out[i - 1] + dist(p[i - 1], p[i]));
  return out;
}

/** Point on open polyline at arc-length s (clamped). Also returns segment index + tangent. */
export function pointAtLength(p: Polyline, s: number): { pt: Vec; seg: number; t: number; tangent: Vec } {
  if (p.length === 0) return { pt: { x: 0, y: 0 }, seg: 0, t: 0, tangent: { x: 1, y: 0 } };
  if (p.length === 1) return { pt: { ...p[0] }, seg: 0, t: 0, tangent: { x: 1, y: 0 } };
  const cum = cumulativeLengths(p);
  const total = cum[cum.length - 1];
  s = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const segLen = cum[i] - cum[i - 1];
  const t = segLen < EPS ? 0 : (s - cum[i - 1]) / segLen;
  return { pt: lerp(p[i - 1], p[i], t), seg: i - 1, t, tangent: norm(sub(p[i], p[i - 1])) };
}

/** Closest point on open polyline to q. */
export function closestPoint(p: Polyline, q: Vec): { pt: Vec; seg: number; t: number; d: number; s: number } {
  let best = { pt: { ...p[0] }, seg: 0, t: 0, d: Infinity, s: 0 };
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    const ab = sub(b, a); const l2 = dot(ab, ab);
    let t = l2 < EPS ? 0 : dot(sub(q, a), ab) / l2;
    t = Math.max(0, Math.min(1, t));
    const pt = lerp(a, b, t);
    const d = dist(pt, q);
    if (d < best.d) best = { pt, seg: i - 1, t, d, s: acc + t * Math.sqrt(l2) };
    acc += Math.sqrt(l2);
  }
  return best;
}

/** Sub-polyline between arc lengths s0..s1 (s0<s1) of an open polyline. */
export function slice(p: Polyline, s0: number, s1: number): Polyline {
  const a = pointAtLength(p, s0), b = pointAtLength(p, s1);
  const out: Polyline = [a.pt];
  for (let i = a.seg + 1; i <= b.seg; i++) out.push({ ...p[i] });
  if (!(b.seg === a.seg && b.t === a.t)) out.push(b.pt);
  return dedupe(out);
}

export function dedupe(p: Polyline, eps = 1e-6): Polyline {
  const out: Polyline = [];
  for (const q of p) if (out.length === 0 || dist(out[out.length - 1], q) > eps) out.push(q);
  return out;
}

/** Remove collinear interior points (open or closed). */
export function simplifyCollinear(p: Polyline, tol = 1e-6, closed = false): Polyline {
  if (p.length < 3) return p.slice();
  const out: Polyline = [];
  const n = p.length;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) { out.push(p[i]); continue; }
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
    const ab = sub(b, a), bc = sub(c, b);
    const l = len(ab) * len(bc);
    if (l < EPS || Math.abs(cross(ab, bc)) / l > tol) out.push(b);
  }
  return out;
}

export function reversed(p: Polyline): Polyline { return p.slice().reverse(); }

/** Segment-segment intersection (proper, inclusive of endpoints). Returns params. */
export function segIntersect(a: Vec, b: Vec, c: Vec, d: Vec): { pt: Vec; t: number; u: number } | null {
  const r = sub(b, a), s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null;
  const ac = sub(c, a);
  const t = cross(ac, s) / den;
  const u = cross(ac, r) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { pt: add(a, mul(r, t)), t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) };
}
/** Infinite line (a,dirA) × (b,dirB). */
export function lineIntersect(a: Vec, da: Vec, b: Vec, db: Vec): Vec | null {
  const den = cross(da, db);
  if (Math.abs(den) < EPS) return null;
  const t = cross(sub(b, a), db) / den;
  return add(a, mul(da, t));
}

/** All intersections between two polylines (open). */
export function polylineIntersections(p: Polyline, q: Polyline): { pt: Vec; segP: number; tP: number; sP: number; segQ: number; tQ: number; sQ: number }[] {
  const out = [];
  const cp = cumulativeLengths(p), cq = cumulativeLengths(q);
  for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) {
    const r = segIntersect(p[i - 1], p[i], q[j - 1], q[j]);
    if (r) out.push({ pt: r.pt, segP: i - 1, tP: r.t, sP: cp[i - 1] + r.t * (cp[i] - cp[i - 1]), segQ: j - 1, tQ: r.u, sQ: cq[j - 1] + r.u * (cq[j] - cq[j - 1]) });
  }
  return out;
}

/** Point-in-polygon (even-odd). */
export function pointInPolygon(pt: Vec, poly: Polyline): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from point to polygon boundary (closed). */
export function distToPolygon(pt: Vec, poly: Polyline): number {
  const cl = closestPoint([...poly, poly[0]], pt);
  return cl.d;
}

export function boundsOf(p: Polyline): Box { return bbox(p); }

/** Translate / transform helpers. */
export const translate = (p: Polyline, d: Vec): Polyline => p.map(q => add(q, d));
export function rotatePoly(p: Polyline, radAngle: number, about: Vec): Polyline {
  const c = Math.cos(radAngle), s = Math.sin(radAngle);
  return p.map(q => { const dx = q.x - about.x, dy = q.y - about.y; return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c }; });
}
export const mirrorX = (p: Polyline, x0 = 0): Polyline => p.map(q => ({ x: 2 * x0 - q.x, y: q.y }));
export const mirrorY = (p: Polyline, y0 = 0): Polyline => p.map(q => ({ x: q.x, y: 2 * y0 - q.y }));

// ───────────────────────────────── OFFSET ─────────────────────────────────

export type JoinType = 'miter' | 'bevel' | 'round';

export interface OffsetOptions {
  /** per-segment distance (positive = outward for the polygon's winding handled by caller). length = n (closed) or n-1 (open). */
  distances: number[] | number;
  join?: JoinType;
  miterLimit?: number; // ratio of miter length to distance, default 4
  closed?: boolean;
  /** remove self-intersection loops produced by inward offset at concave corners */
  cleanup?: boolean;
}

/**
 * Variable-distance polygon/polyline offset.
 * Positive distance offsets to the LEFT of travel direction (x→y CCW convention: for a CCW
 * polygon, "left" is INSIDE; for CW, left is OUTSIDE). Use `offsetOutward` for winding-agnostic use.
 * Each edge is shifted by its own distance; corners are joined by miter (intersection of the two
 * shifted edge lines), falling back to bevel beyond miterLimit. A zero-distance edge is kept in place.
 */
export function offsetPolyline(p: Polyline, opt: OffsetOptions): Polyline {
  const closed = opt.closed ?? true;
  const join = opt.join ?? 'miter';
  const miterLimit = opt.miterLimit ?? 4;
  const pts = dedupe(p);
  if (closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
  const n = pts.length;
  if (n < 2) return pts.slice();
  const segCount = closed ? n : n - 1;
  const dists: number[] = typeof opt.distances === 'number'
    ? new Array(segCount).fill(opt.distances)
    : opt.distances.slice(0, segCount);
  while (dists.length < segCount) dists.push(dists[dists.length - 1] ?? 0);

  // shifted edges
  const edges: { a: Vec; b: Vec; d: Vec; dist: number }[] = [];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = norm(sub(b, a));
    const nrm = perp(d); // left normal
    const off = mul(nrm, dists[i]);
    edges.push({ a: add(a, off), b: add(b, off), d, dist: dists[i] });
  }

  const out: Polyline = [];
  const joinCorner = (e0: typeof edges[0], e1: typeof edges[0], corner: Vec) => {
    const turn = cross(e0.d, e1.d);
    const x = lineIntersect(e0.a, e0.d, e1.a, e1.d);
    if (!x) { // parallel
      out.push(e0.b);
      if (dist(e0.b, e1.a) > 1e-9) out.push(e1.a);
      return;
    }
    const dAvg = Math.max(Math.abs(e0.dist), Math.abs(e1.dist), 1e-9);
    const miterLen = dist(x, corner);
    // If the shifted edges still cross each other (t0 ≤ 1) the corner is concave w.r.t. the
    // offset direction → the intersection is the only correct join. Otherwise they diverge
    // (convex) → miter if inside the limit, else bevel/round.
    const t0 = dot(sub(x, e0.a), e0.d) / Math.max(dist(e0.a, e0.b), 1e-12);
    const concave = t0 <= 1 + 1e-9;
    if (concave || (join === 'miter' && miterLen <= miterLimit * dAvg)) { out.push(x); return; }
    if (join === 'round') {
      const a0 = Math.atan2(e0.b.y - corner.y, e0.b.x - corner.x);
      let a1 = Math.atan2(e1.a.y - corner.y, e1.a.x - corner.x);
      let sweep = a1 - a0; if (turn < 0 && sweep > 0) sweep -= 2 * Math.PI; if (turn > 0 && sweep < 0) sweep += 2 * Math.PI;
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
      for (let k = 0; k <= steps; k++) { const a = a0 + sweep * (k / steps); out.push({ x: corner.x + Math.cos(a) * dAvg, y: corner.y + Math.sin(a) * dAvg }); }
      return;
    }
    out.push(e0.b); out.push(e1.a); // bevel
  };

  if (closed) {
    for (let i = 0; i < segCount; i++) {
      const e0 = edges[(i - 1 + segCount) % segCount], e1 = edges[i];
      joinCorner(e0, e1, pts[i]);
    }
  } else {
    out.push(edges[0].a);
    for (let i = 1; i < segCount; i++) joinCorner(edges[i - 1], edges[i], pts[i]);
    out.push(edges[segCount - 1].b);
  }
  const res = dedupe(out);
  return (opt.cleanup ?? true) ? removeSelfIntersections(res, closed) : res;
}

/**
 * Winding-agnostic outward offset of a closed polygon: positive = grow, negative = shrink.
 * Per-segment distances allowed. Output keeps the input winding.
 */
export function offsetOutward(poly: Polyline, distances: number[] | number, join: JoinType = 'miter', miterLimit = 4): Polyline {
  const ccw = isCCW(poly);
  // left-of-travel is inside for CCW → outward = negative
  const sign = ccw ? -1 : 1;
  const d = typeof distances === 'number' ? distances * sign : distances.map(x => x * sign);
  return offsetPolyline(poly, { distances: d, join, miterLimit, closed: true, cleanup: true });
}

/**
 * Remove self-intersection loops (inverted loops produced by inward offsets). Keeps the
 * largest-area loop that preserves the original orientation. Robust enough for seam
 * allowances; not a general polygon clipper.
 */
export function removeSelfIntersections(p: Polyline, closed: boolean): Polyline {
  if (p.length < 4) return p;
  let pts = p.slice();
  let guard = 0;
  while (guard++ < 200) {
    const n = pts.length;
    let found: { i: number; j: number; pt: Vec } | null = null;
    const segs = closed ? n : n - 1;
    outer: for (let i = 0; i < segs; i++) {
      for (let j = i + 2; j < segs; j++) {
        if (closed && i === 0 && j === segs - 1) continue;
        const r = segIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]);
        if (r && r.t > 1e-9 && r.t < 1 - 1e-9 && r.u > 1e-9 && r.u < 1 - 1e-9) { found = { i, j, pt: r.pt }; break outer; }
      }
    }
    if (!found) break;
    const { i, j, pt } = found;
    // two candidate loops: A = pts[i+1..j] + X ; B = X + pts[j+1..] + pts[..i]
    const loopA: Polyline = [pt, ...pts.slice(i + 1, j + 1)];
    const loopB: Polyline = [pt, ...pts.slice(j + 1), ...pts.slice(0, i + 1)];
    const orig = signedArea(p) >= 0;
    const sa = signedArea(loopA), sb = signedArea(loopB);
    const aOk = (sa >= 0) === orig, bOk = (sb >= 0) === orig;
    if (aOk && !bOk) pts = loopA;
    else if (bOk && !aOk) pts = loopB;
    else pts = Math.abs(sa) >= Math.abs(sb) ? loopA : loopB;
    pts = dedupe(pts);
    if (pts.length < 3) break;
  }
  return pts;
}

/** Convex hull (Andrew). */
export function convexHull(points: Vec[]): Polyline {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Vec[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(p, lower[lower.length - 2])) <= 0) lower.pop(); lower.push(p); }
  const upper: Vec[] = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(p, upper[upper.length - 2])) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Do two closed polygons overlap (edge intersection or containment)? */
export function polygonsOverlap(a: Polyline, b: Polyline): boolean {
  const ba = bbox(a), bb = bbox(b);
  if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxY < bb.minY || bb.maxY < ba.minY) return false;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    if (segIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}
