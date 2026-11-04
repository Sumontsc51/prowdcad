import { Vec, add, sub, mul, dist, lerp } from './vec';

/** Cubic Bézier point. */
export function bezierPoint(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

export function bezierTangent(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  return {
    x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  };
}

/** Sample a cubic Bézier into n+1 points (adaptive-ish: n chosen by chord length / flatness). */
export function sampleBezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, tol = 0.05): Vec[] {
  const approxLen = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
  const n = Math.max(4, Math.min(256, Math.ceil(Math.sqrt(approxLen / tol))));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) out.push(bezierPoint(p0, p1, p2, p3, i / n));
  return out;
}

/**
 * Centripetal Catmull–Rom (α = 0.5) through points. Never uniform CR.
 * Returns a polyline starting at pts[0] and ending at pts[last]. End tangents are
 * handled by mirroring the neighbour (natural-ish end condition).
 */
export function sampleCatmullRom(pts: Vec[], tol = 0.05, alpha = 0.5): Vec[] {
  if (pts.length < 2) return pts.map(p => ({ ...p }));
  if (pts.length === 2) return [{ ...pts[0] }, { ...pts[1] }];
  const P: Vec[] = [sub(mul(pts[0], 2), pts[1]), ...pts, sub(mul(pts[pts.length - 1], 2), pts[pts.length - 2])];
  const out: Vec[] = [{ ...pts[0] }];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const seg = crSegment(p0, p1, p2, p3, alpha, tol);
    for (let k = 1; k < seg.length; k++) out.push(seg[k]);
  }
  return out;
}

function crSegment(p0: Vec, p1: Vec, p2: Vec, p3: Vec, alpha: number, tol: number): Vec[] {
  const t0 = 0;
  const t1 = t0 + Math.pow(Math.max(dist(p0, p1), 1e-9), alpha);
  const t2 = t1 + Math.pow(Math.max(dist(p1, p2), 1e-9), alpha);
  const t3 = t2 + Math.pow(Math.max(dist(p2, p3), 1e-9), alpha);
  const chord = dist(p1, p2);
  const n = Math.max(3, Math.min(128, Math.ceil(Math.sqrt(chord / tol))));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t1 + (t2 - t1) * (i / n);
    const A1 = lerp2(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
    const A2 = lerp2(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
    const A3 = lerp2(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
    const B1 = lerp2(A1, A2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
    const B2 = lerp2(A2, A3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
    const C = lerp2(B1, B2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
    out.push(C);
  }
  out[0] = { ...p1 }; out[out.length - 1] = { ...p2 };
  return out;
}
function lerp2(a: Vec, b: Vec, wa: number, wb: number): Vec { return { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb }; }

/**
 * Convert a centripetal CR spline through pts into equivalent cubic Bézier handles
 * (for export to SVG/DXF splines and for "break handle" editing).
 * Returns, for each interior/exterior point, {hIn, hOut} as absolute positions.
 */
export function catmullRomToBezierHandles(pts: Vec[], alpha = 0.5): { hIn: Vec; hOut: Vec }[] {
  const n = pts.length;
  const res: { hIn: Vec; hOut: Vec }[] = pts.map(p => ({ hIn: { ...p }, hOut: { ...p } }));
  if (n < 2) return res;
  const P: Vec[] = [sub(mul(pts[0], 2), pts[1]), ...pts, sub(mul(pts[n - 1], 2), pts[n - 2])];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const d1 = Math.pow(Math.max(dist(p0, p1), 1e-9), alpha);
    const d2 = Math.pow(Math.max(dist(p1, p2), 1e-9), alpha);
    const d3 = Math.pow(Math.max(dist(p2, p3), 1e-9), alpha);
    // standard centripetal CR → Bézier conversion
    const b1 = {
      x: (d1 * d1 * p2.x - d2 * d2 * p0.x + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.x) / (3 * d1 * (d1 + d2)),
      y: (d1 * d1 * p2.y - d2 * d2 * p0.y + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1.y) / (3 * d1 * (d1 + d2)),
    };
    const b2 = {
      x: (d3 * d3 * p1.x - d2 * d2 * p3.x + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.x) / (3 * d3 * (d3 + d2)),
      y: (d3 * d3 * p1.y - d2 * d2 * p3.y + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2.y) / (3 * d3 * (d3 + d2)),
    };
    res[i - 1].hOut = b1;
    res[i].hIn = b2;
  }
  return res;
}

export { add };
