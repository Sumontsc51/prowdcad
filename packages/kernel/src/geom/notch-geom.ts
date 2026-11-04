/**
 * Geometry helpers for notches / drills / binding: arc-length addressing on resolved contours,
 * ray casting against the cut polygon, and notch mark shapes.
 */
import { Vec, add, sub, mul, norm, perp, dot, cross, lerp, len, EPS } from './vec';
import { isCCW } from './poly';
import type { ResolvedContour } from '../model/contour';

/** Polyline over which r.cum is defined (closed: first point repeated at the end). */
export function cumPoly(r: ResolvedContour): Vec[] {
  return r.closed && r.pts.length > 1 ? [...r.pts, r.pts[0]] : r.pts;
}

export function contourLength(r: ResolvedContour): number { return r.cum[r.cum.length - 1] ?? 0; }

/** Arc length (from pts[0]) of anchor i. */
export function anchorS(r: ResolvedContour, i: number): number { return r.cum[r.anchorIndex[i]] ?? 0; }

/** Normalise an arc length: wrap for closed contours, clamp for open ones. */
export function wrapS(r: ResolvedContour, s: number): number {
  const L = contourLength(r);
  if (L <= 0) return 0;
  if (!r.closed) return Math.max(0, Math.min(L, s));
  let w = s % L; if (w < 0) w += L;
  if (L - w < 1e-9) w = 0;
  return w;
}

/** Forward distance from s0 to s1 along the contour (closed: modulo; open: s1 − s0). */
export function forwardDist(r: ResolvedContour, s0: number, s1: number): number {
  if (!r.closed) return s1 - s0;
  const L = contourLength(r);
  let d = (s1 - s0) % L; if (d < 0) d += L;
  if (L - d < 1e-9) d = 0;
  return d;
}

/** Direction of the first non-degenerate polyline edge at/after index i (step +1) or at/before (step −1). */
function edgeDir(poly: Vec[], i: number, step: 1 | -1, closed: boolean): Vec {
  const m = poly.length - 1; // number of edges
  for (let k = 0; k < m; k++) {
    let e = i + k * step;
    if (closed) e = ((e % m) + m) % m; else if (e < 0 || e >= m) break;
    const d = sub(poly[e + 1], poly[e]);
    if (len(d) > 1e-12) return norm(d);
  }
  return { x: 1, y: 0 };
}

export interface ArcPoint { pt: Vec; s: number; tIn: Vec; tOut: Vec; tangent: Vec; atVertex: boolean }

/** Point + incoming/outgoing tangents at arc length s. At a vertex tIn ≠ tOut; tangent = their bisector. */
export function arcPoint(r: ResolvedContour, s: number): ArcPoint {
  const poly = cumPoly(r);
  const cum = r.cum;
  s = wrapS(r, s);
  if (poly.length < 2) return { pt: { ...(poly[0] ?? { x: 0, y: 0 }) }, s, tIn: { x: 1, y: 0 }, tOut: { x: 1, y: 0 }, tangent: { x: 1, y: 0 }, atVertex: true };
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s - 1e-9) i++;
  const segLen = cum[i] - cum[i - 1];
  const t = segLen < EPS ? 0 : Math.max(0, Math.min(1, (s - cum[i - 1]) / segLen));
  const pt = lerp(poly[i - 1], poly[i], t);
  const m = poly.length - 1;
  let tIn = edgeDir(poly, i - 1, -1, r.closed), tOut = tIn, atVertex = false;
  if (Math.abs(cum[i] - s) < 1e-7) {
    // at vertex i: outgoing = edge i (closed wraps)
    atVertex = true;
    if (i < m) tOut = edgeDir(poly, i, 1, r.closed);
    else if (r.closed) tOut = edgeDir(poly, 0, 1, true);
  } else if (Math.abs(s - cum[i - 1]) < 1e-7) {
    atVertex = true;
    tOut = edgeDir(poly, i - 1, 1, r.closed);
    if (i - 1 > 0) tIn = edgeDir(poly, i - 2, -1, r.closed);
    else if (r.closed) tIn = edgeDir(poly, m - 1, -1, true);
    else tIn = tOut;
  }
  const b = add(tIn, tOut);
  const tangent = len(b) < 1e-9 ? tOut : norm(b);
  return { pt, s, tIn, tOut, tangent, atVertex };
}

/** Outward normal for a tangent (closed: winding-aware; open: right-hand side of travel). */
export function outwardNormal(tangent: Vec, ccw: boolean): Vec {
  return ccw ? { x: tangent.y, y: -tangent.x } : perp(tangent);
}

export function contourCCW(r: ResolvedContour): boolean { return r.closed ? isCCW(r.pts) : true; }

/** Closest arc length on the contour to q. */
export function closestS(r: ResolvedContour, q: Vec): { s: number; pt: Vec; d: number } {
  const poly = cumPoly(r);
  let best = { s: 0, pt: { ...poly[0] }, d: Infinity };
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], ab = sub(b, a), l2 = dot(ab, ab);
    let t = l2 < EPS ? 0 : dot(sub(q, a), ab) / l2; t = Math.max(0, Math.min(1, t));
    const p = lerp(a, b, t), d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.d) best = { s: r.cum[i - 1] + t * (r.cum[i] - r.cum[i - 1]), pt: p, d };
  }
  best.s = wrapS(r, best.s);
  return best;
}

/** Nearest hit of the ray p + t·d (t ≥ tMin) with a closed polygon or open polyline. */
export function rayHit(p: Vec, d: Vec, poly: Vec[], closed = true, tMin = -1e-7): { pt: Vec; t: number; edge: number; u: number } | null {
  let best: { pt: Vec; t: number; edge: number; u: number } | null = null;
  const n = poly.length, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const s = sub(b, a);
    const den = cross(d, s);
    if (Math.abs(den) < 1e-12) continue;
    const ap = sub(a, p);
    const t = cross(ap, s) / den, u = cross(ap, d) / den;
    if (u < -1e-9 || u > 1 + 1e-9 || t < tMin) continue;
    if (!best || t < best.t) best = { pt: add(p, mul(d, t)), t, edge: i, u: Math.max(0, Math.min(1, u)) };
  }
  return best;
}

/** Same as rayHit but against a resolved contour, returning the arc length of the hit. */
export function rayHitContour(p: Vec, d: Vec, r: ResolvedContour, tMin = 1e-7): { pt: Vec; t: number; s: number } | null {
  const poly = cumPoly(r);
  const h = rayHit(p, d, poly, false, tMin);
  if (!h) return null;
  return { pt: h.pt, t: h.t, s: wrapS(r, r.cum[h.edge] + h.u * (r.cum[h.edge + 1] - r.cum[h.edge])) };
}

/**
 * Notch mark polylines. c = point on the cut line, u = unit direction INTO the piece,
 * w = perp(u). Slit: line of `depth`. T: slit + crossbar of `width` at the bottom.
 * V: mouth `width` on the cut line, apex at depth. U: parallel sides + semicircular bottom.
 * Castle: rectangular slot width × depth.
 */
export function notchShape(type: 'slit' | 'T' | 'V' | 'U' | 'castle', c: Vec, u: Vec, depth: number, width: number): Vec[][] {
  const w = perp(u), hw = width / 2;
  const P = (a: number, b: number): Vec => ({ x: c.x + u.x * a + w.x * b, y: c.y + u.y * a + w.y * b });
  switch (type) {
    case 'slit': return [[P(0, 0), P(depth, 0)]];
    case 'T': return [[P(0, 0), P(depth, 0)], [P(depth, -hw), P(depth, hw)]];
    case 'V': return [[P(0, -hw), P(depth, 0), P(0, hw)]];
    case 'castle': return [[P(0, -hw), P(depth, -hw), P(depth, hw), P(0, hw)]];
    case 'U': {
      const r = Math.min(hw, depth);
      const straight = depth - r;
      const out: Vec[] = [P(0, -hw)];
      if (straight > 1e-9) out.push(P(straight, -hw));
      const N = 12;
      for (let k = 1; k < N; k++) {
        const a = Math.PI * (k / N); // from −w side round the bottom to +w side
        out.push(P(straight + r * Math.sin(a), -hw * Math.cos(a)));
      }
      if (straight > 1e-9) out.push(P(straight, hw));
      out.push(P(0, hw));
      return [out];
    }
  }
}
