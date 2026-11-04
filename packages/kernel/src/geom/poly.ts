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
 *
 * Each edge is shifted by its own distance. Joins:
 *  - corner where the shifted edges cross (concave w.r.t. the offset direction): their intersection.
 *    On a closed polygon, when that would make a shifted edge run backwards (the edge is consumed by
 *    the offset: collapse, narrow slot, curve tighter than the distance) the join goes through the
 *    original vertex instead (Clipper style), so the winding cleanup below sees the true coverage.
 *  - corner where they diverge (convex): miter within `miterLimit`·d; beyond it (and for 'bevel')
 *    a square cap perpendicular to the bisector at distance d from the corner; 'round' = polygon
 *    circumscribed about the radius-d arc. Every join stays ≥ d from the corner.
 *  - antiparallel edges (180° spike / zero-width slit): square cap past the tip.
 * A zero-distance edge is kept in place; zero-length edges are dropped first.
 * Closed + cleanup: the result is the boundary of the region with positive winding (relative to the
 * input orientation) of the raw offset path — an offset that vanishes returns [] (area 0).
 */
export function offsetPolyline(p: Polyline, opt: OffsetOptions): Polyline {
  const closed = opt.closed ?? true;
  const join = opt.join ?? 'miter';
  const miterLimit = opt.miterLimit ?? 4;
  const cleanup = opt.cleanup ?? true;
  const raw = dedupe(p);
  // keep per-segment distances aligned with the deduped edges
  const srcDists: number[] = typeof opt.distances === 'number' ? [] : opt.distances;
  const pts: Polyline = [];
  const dsrc: number[] = [];
  {
    const segN0 = closed ? p.length : p.length - 1;
    const dAt = (i: number) => (typeof opt.distances === 'number' ? opt.distances : (srcDists[Math.min(i, segN0 - 1)] ?? srcDists[srcDists.length - 1] ?? 0));
    for (let i = 0; i < p.length; i++) {
      if (pts.length && dist(pts[pts.length - 1], p[i]) <= 1e-6) { dsrc[dsrc.length - 1] = dAt(i); continue; }
      pts.push(p[i]); dsrc.push(dAt(i));
    }
    void raw;
  }
  if (closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-6) { pts.pop(); dsrc.pop(); }
  const n = pts.length;
  if (n < 2) return pts.slice();
  const segCount = closed ? n : n - 1;
  const dists: number[] = dsrc.slice(0, segCount);
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
  type E = typeof edges[0];

  /** square cap: perpendicular to the outward bisector at distance R from the corner */
  const squareCap = (e0: E, e1: E, corner: Vec): Vec[] => {
    const n0 = mul(perp(e0.d), Math.sign(e0.dist) || 1), n1 = mul(perp(e1.d), Math.sign(e1.dist) || 1);
    let bis = norm(add(n0, n1));
    if (len(bis) < 1e-9) bis = e0.d;
    const R = Math.max(Math.abs(e0.dist), Math.abs(e1.dist));
    const C = add(corner, mul(bis, R));
    const cd = perp(bis);
    let P0 = lineIntersect(e0.a, e0.d, C, cd) ?? e0.b;
    let P1 = lineIntersect(e1.a, e1.d, C, cd) ?? e1.a;
    if (dot(sub(P0, e0.b), e0.d) < 0) P0 = e0.b;
    if (dot(sub(P1, e1.a), e1.d) > 0) P1 = e1.a;
    return dist(P0, P1) < 1e-12 ? [P0] : [P0, P1];
  };
  const roundJoin = (e0: E, e1: E, corner: Vec, turn: number): Vec[] => {
    const R = Math.max(Math.abs(e0.dist), Math.abs(e1.dist), 1e-9);
    const a0 = Math.atan2(e0.b.y - corner.y, e0.b.x - corner.x);
    const a1 = Math.atan2(e1.a.y - corner.y, e1.a.x - corner.x);
    let sweep = a1 - a0; if (turn < 0 && sweep > 0) sweep -= 2 * Math.PI; if (turn > 0 && sweep < 0) sweep += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    const st = sweep / steps;
    // circumscribed polygon: every chord is tangent to the radius-R arc (never closer than R)
    const Rc = R / Math.cos(st / 2);
    const out: Vec[] = [{ x: corner.x + Math.cos(a0) * R, y: corner.y + Math.sin(a0) * R }];
    for (let k = 1; k <= steps; k++) { const a = a0 + st * (k - 0.5); out.push({ x: corner.x + Math.cos(a) * Rc, y: corner.y + Math.sin(a) * Rc }); }
    out.push({ x: corner.x + Math.cos(a1) * R, y: corner.y + Math.sin(a1) * R });
    return out;
  };

  /** join geometry at a corner; `concave` = the shifted edges cross (miter point = their intersection) */
  const joinCorner = (e0: E, e1: E, corner: Vec): { pts: Vec[]; concave: boolean } => {
    const turn = cross(e0.d, e1.d);
    const x = lineIntersect(e0.a, e0.d, e1.a, e1.d);
    if (!x) { // parallel
      if (dot(e0.d, e1.d) < 0 && (Math.abs(e0.dist) > 1e-12 || Math.abs(e1.dist) > 1e-12)) return { pts: squareCap(e0, e1, corner), concave: false }; // 180° spike
      return { pts: dist(e0.b, e1.a) > 1e-9 ? [e0.b, e1.a] : [e0.b], concave: false };
    }
    const dAvg = Math.max(Math.abs(e0.dist), Math.abs(e1.dist), 1e-9);
    const miterLen = dist(x, corner);
    // shifted edges still cross (t0 ≤ 1) → concave w.r.t. the offset direction → the intersection
    const t0 = dot(sub(x, e0.a), e0.d) / Math.max(dist(e0.a, e0.b), 1e-12);
    const concave = t0 <= 1 + 1e-9;
    if (concave) return { pts: [x], concave: true };
    if (join === 'miter' && miterLen <= miterLimit * dAvg) return { pts: [x], concave: false };
    if (join === 'round') return { pts: roundJoin(e0, e1, corner, turn), concave: false };
    return { pts: squareCap(e0, e1, corner), concave: false };
  };

  const out: Polyline = [];
  if (closed) {
    const J = Array.from({ length: segCount }, (_, i) => joinCorner(edges[(i - 1 + segCount) % segCount], edges[i], pts[i]));
    // a shifted edge that would run backwards between its two miter points is consumed: route the
    // joins at both its ends through the original vertex so the winding cleanup can remove it
    const via = new Array(segCount).fill(false);
    if (cleanup) {
      for (let i = 0; i < segCount; i++) {
        const s0 = J[i].pts[J[i].pts.length - 1], s1 = J[(i + 1) % segCount].pts[0];
        const L = dist(edges[i].a, edges[i].b);
        if ((J[i].concave || J[(i + 1) % segCount].concave) && dot(sub(s1, s0), edges[i].d) < -1e-9 * Math.max(1, L)) {
          if (J[i].concave) via[i] = true;
          if (J[(i + 1) % segCount].concave) via[(i + 1) % segCount] = true;
        }
      }
    }
    for (let i = 0; i < segCount; i++) {
      const e0 = edges[(i - 1 + segCount) % segCount], e1 = edges[i];
      if (via[i]) { out.push(e0.b, pts[i], e1.a); continue; }
      out.push(...J[i].pts);
    }
  } else {
    out.push(edges[0].a);
    for (let i = 1; i < segCount; i++) out.push(...joinCorner(edges[i - 1], edges[i], pts[i]).pts);
    out.push(edges[segCount - 1].b);
  }
  const res = dedupe(out);
  if (!cleanup) return res;
  if (closed) {
    const orient = signedArea(pts) >= 0 ? 1 : -1;
    return removeSelfIntersections(res, true, orient);
  }
  return removeSelfIntersections(res, false);
}

/**
 * Winding-agnostic outward offset of a closed polygon: positive = grow, negative = shrink.
 * Per-segment distances allowed. Output keeps the input winding. A shrink that consumes the whole
 * polygon returns [] (area 0).
 */
export function offsetOutward(poly: Polyline, distances: number[] | number, join: JoinType = 'miter', miterLimit = 4): Polyline {
  const ccw = isCCW(poly);
  // left-of-travel is inside for CCW → outward = negative
  const sign = ccw ? -1 : 1;
  const d = typeof distances === 'number' ? distances * sign : distances.map(x => x * sign);
  return offsetPolyline(poly, { distances: d, join, miterLimit, closed: true, cleanup: true });
}

/**
 * Clean up a self-intersecting path.
 *
 * Closed: the boundary of the region whose winding number w.r.t. the path has the sign of
 * `orientation` (default: the sign of the path's signed area), i.e. the positive-fill union used
 * for polygon offsets. Crossings AND collinear overlaps are handled (overlapping antiparallel
 * edges cancel). Holes are dropped and of several disjoint pieces the largest is returned; the
 * result keeps the requested orientation and starts at the first surviving input vertex. Returns
 * [] when nothing has positive winding. A simple path with the requested orientation is returned
 * unchanged.
 *
 * Open: removes loops between crossings (keeps the longer-area loop with the original orientation).
 */
export function removeSelfIntersections(p: Polyline, closed: boolean, orientation?: 1 | -1): Polyline {
  if (!closed) return removeLoopsOpen(p);
  const pts = dedupe(p, 1e-9);
  while (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) <= 1e-9) pts.pop();
  if (pts.length < 3) return orientation === undefined ? pts : [];
  const orient = orientation ?? (signedArea(pts) >= 0 ? 1 : -1);
  return windingCleanup(pts, orient);
}

function removeLoopsOpen(p: Polyline): Polyline {
  if (p.length < 4) return p;
  let pts = p.slice();
  let guard = 0;
  while (guard++ < 200) {
    const n = pts.length;
    let found: { i: number; j: number; pt: Vec } | null = null;
    const segs = n - 1;
    outer: for (let i = 0; i < segs; i++) {
      for (let j = i + 2; j < segs; j++) {
        const r = segIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1]);
        if (r && r.t > 1e-9 && r.t < 1 - 1e-9 && r.u > 1e-9 && r.u < 1 - 1e-9) { found = { i, j, pt: r.pt }; break outer; }
      }
    }
    if (!found) break;
    const { i, j, pt } = found;
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

/** Winding number of q w.r.t. the closed path P (non-zero rule; + = CCW). */
export function windingNumber(q: Vec, P: Polyline): number {
  let w = 0;
  const n = P.length;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    if (a.y <= q.y) { if (b.y > q.y && (b.x - a.x) * (q.y - a.y) - (q.x - a.x) * (b.y - a.y) > 0) w++; }
    else if (b.y <= q.y && (b.x - a.x) * (q.y - a.y) - (q.x - a.x) * (b.y - a.y) < 0) w--;
  }
  return w;
}

function windingCleanup(P: Polyline, orient: 1 | -1): Polyline {
  const n = P.length;
  // ── split parameters per edge (crossings + collinear overlaps), bbox sweep
  const splits: number[][] = Array.from({ length: n }, () => [0, 1]);
  const eb = Array.from({ length: n }, (_, i) => { const a = P[i], b = P[(i + 1) % n]; return { i, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }; });
  const order = eb.slice().sort((u, v) => u.minX - v.minX);
  let any = false;
  const TOL = 1e-9;
  for (let oi = 0; oi < order.length; oi++) {
    const A = order[oi];
    for (let oj = oi + 1; oj < order.length && order[oj].minX <= A.maxX + TOL; oj++) {
      const B = order[oj];
      if (B.minY > A.maxY + TOL || B.maxY < A.minY - TOL) continue;
      const i = A.i, j = B.i;
      const adj = (j === (i + 1) % n) || (i === (j + 1) % n);
      const a = P[i], b = P[(i + 1) % n], c = P[j], d = P[(j + 1) % n];
      const r = sub(b, a), s = sub(d, c);
      const lr = len(r), ls = len(s);
      if (lr < 1e-12 || ls < 1e-12) continue;
      const den = cross(r, s);
      if (Math.abs(den) <= 1e-12 * lr * ls) {
        // parallel: collinear overlap?
        if (Math.abs(cross(r, sub(c, a))) / lr > TOL) continue;
        const proj = (q: Vec, o: Vec, v: Vec, l2: number) => dot(sub(q, o), v) / l2;
        const lr2 = lr * lr, ls2 = ls * ls;
        let hit = false;
        for (const q of [c, d]) { const t = proj(q, a, r, lr2); if (t > 1e-12 && t < 1 - 1e-12) { splits[i].push(t); hit = true; } }
        for (const q of [a, b]) { const t = proj(q, c, s, ls2); if (t > 1e-12 && t < 1 - 1e-12) { splits[j].push(t); hit = true; } }
        // overlapping (not just touching end to end)
        const t0 = proj(c, a, r, lr2), t1 = proj(d, a, r, lr2);
        if (hit || (Math.max(t0, t1) > 1e-12 && Math.min(t0, t1) < 1 - 1e-12)) any = true;
        continue;
      }
      const ac = sub(c, a);
      const t = cross(ac, s) / den, u = cross(ac, r) / den;
      if (t < -1e-12 || t > 1 + 1e-12 || u < -1e-12 || u > 1 + 1e-12) continue;
      const tIn = t > 1e-12 && t < 1 - 1e-12, uIn = u > 1e-12 && u < 1 - 1e-12;
      if (adj && !tIn && !uIn) continue; // shared vertex
      if (tIn) splits[i].push(t);
      if (uIn) splits[j].push(u);
      if (tIn || uIn || !adj) any = true;
    }
  }
  if (!any) return signedArea(P) * orient > 0 ? P.slice() : [];

  // ── vertices (merged within 1e-7) and sub-edges
  const verts: Vec[] = [];
  const isInput: boolean[] = [];
  const grid = new Map<string, number[]>();
  const CELL = 1e-6, MERGE = 1e-7;
  const vid = (q: Vec, input: boolean): number => {
    const gx = Math.floor(q.x / CELL), gy = Math.floor(q.y / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const l = grid.get(`${gx + dx},${gy + dy}`); if (!l) continue;
      for (const k of l) if (dist(verts[k], q) <= MERGE) { if (input) isInput[k] = true; return k; }
    }
    const k = verts.length; verts.push({ x: q.x, y: q.y }); isInput.push(input);
    const key = `${gx},${gy}`; const l = grid.get(key); if (l) l.push(k); else grid.set(key, [k]);
    return k;
  };
  const inputIds = P.map(q => vid(q, true));
  const sub_: { u: number; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const ts = [...new Set(splits[i])].sort((x, y) => x - y);
    let prev = inputIds[i];
    for (let k = 1; k < ts.length; k++) {
      const id = k === ts.length - 1 ? inputIds[(i + 1) % n] : vid(lerp(a, b, ts[k]), false);
      if (id !== prev) sub_.push({ u: prev, v: id });
      prev = id;
    }
  }
  // ── keep boundary edges (positive winding on exactly one side), oriented inside-left (orient=1)
  const inside = (w: number) => w * orient > 0;
  const kept = new Map<string, { u: number; v: number }>();
  for (const e of sub_) {
    const a = verts[e.u], b = verts[e.v];
    const L = dist(a, b); if (L < 1e-12) continue;
    const m = lerp(a, b, 0.5), nl = perp(norm(sub(b, a)));
    const delta = Math.min(1e-6, L * 1e-3);
    const wl = inside(windingNumber(add(m, mul(nl, delta)), P)), wr = inside(windingNumber(sub(m, mul(nl, delta)), P));
    if (wl === wr) continue;
    // orientation of the output: inside on the left for orient=+1 (CCW), on the right for −1 (CW)
    const fwd = orient > 0 ? wl : wr;
    const de = fwd ? { u: e.u, v: e.v } : { u: e.v, v: e.u };
    kept.set(`${de.u}>${de.v}`, de);
  }
  if (!kept.size) return [];
  // ── link into loops: at each vertex take the outgoing edge with the largest left turn (orient=+1)
  const outE = new Map<number, { u: number; v: number }[]>();
  for (const e of kept.values()) { const l = outE.get(e.u); if (l) l.push(e); else outE.set(e.u, [e]); }
  const used = new Set<string>();
  const loops: number[][] = [];
  for (const e0 of kept.values()) {
    const k0 = `${e0.u}>${e0.v}`;
    if (used.has(k0)) continue;
    const loop: number[] = [e0.u];
    let cur = e0; used.add(k0);
    let guard = 0;
    while (guard++ < kept.size + 2) {
      if (cur.v === e0.u) break;
      loop.push(cur.v);
      const cands = (outE.get(cur.v) ?? []).filter(x => !used.has(`${x.u}>${x.v}`));
      if (!cands.length) break;
      const din = norm(sub(verts[cur.v], verts[cur.u]));
      let best = cands[0], bestA = -Infinity;
      for (const c of cands) {
        const dout = norm(sub(verts[c.v], verts[c.u]));
        const ang = Math.atan2(cross(din, dout), dot(din, dout)) * orient;
        const a = ang <= -Math.PI + 1e-12 ? -Math.PI : ang;
        if (a > bestA) { bestA = a; best = c; }
      }
      used.add(`${best.u}>${best.v}`); cur = best;
    }
    if (loop.length >= 3 && cur.v === e0.u) loops.push(loop);
  }
  let bestLoop: number[] | null = null, bestArea = 0;
  for (const l of loops) {
    const a = signedArea(l.map(i => verts[i])) * orient;
    if (a > bestArea + 1e-12) { bestArea = a; bestLoop = l; }
  }
  if (!bestLoop || bestArea < 1e-12) return [];
  // drop split points that are straight-through (never input vertices)
  let ids = bestLoop;
  for (let pass = 0; pass < 2; pass++) {
    const m = ids.length; if (m < 4) break;
    const keep: number[] = [];
    for (let k = 0; k < m; k++) {
      const id = ids[k];
      if (isInput[id]) { keep.push(id); continue; }
      const a = verts[ids[(k - 1 + m) % m]], b = verts[id], c = verts[ids[(k + 1) % m]];
      const u = sub(b, a), w = sub(c, b), l = len(u) * len(w);
      if (l > 1e-18 && Math.abs(cross(u, w)) / l <= 1e-9 && dot(u, w) > 0) continue;
      keep.push(id);
    }
    ids = keep;
  }
  // start at the first surviving input vertex (stable start point)
  const pos = new Map(ids.map((id, k) => [id, k]));
  let start = 0;
  for (const id of inputIds) { const k = pos.get(id); if (k !== undefined) { start = k; break; } }
  ids = [...ids.slice(start), ...ids.slice(0, start)];
  return ids.map(i => ({ ...verts[i] }));
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
