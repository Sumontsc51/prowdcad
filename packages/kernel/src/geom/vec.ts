export interface Vec { x: number; y: number }

export const EPS = 1e-9;

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const neg = (a: Vec): Vec => ({ x: -a.x, y: -a.y });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const len2 = (a: Vec): number => a.x * a.x + a.y * a.y;
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: Vec, b: Vec): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const eq = (a: Vec, b: Vec, eps = 1e-6): boolean => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a: Vec, b: Vec): Vec => lerp(a, b, 0.5);
export const clone = (a: Vec): Vec => ({ x: a.x, y: a.y });

export function norm(a: Vec): Vec {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}
/** perpendicular (rotate +90° CCW in a y-up frame) */
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
export const angleOf = (a: Vec): number => Math.atan2(a.y, a.x);
export const fromAngle = (rad: number, l = 1): Vec => ({ x: Math.cos(rad) * l, y: Math.sin(rad) * l });
export function rotate(a: Vec, rad: number, about: Vec = { x: 0, y: 0 }): Vec {
  const c = Math.cos(rad), s = Math.sin(rad);
  const dx = a.x - about.x, dy = a.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
}
export const deg = (rad: number) => rad * 180 / Math.PI;
export const rad = (d: number) => d * Math.PI / 180;

/** signed angle from a to b, in (-π, π] */
export function angleBetween(a: Vec, b: Vec): number { return Math.atan2(cross(a, b), dot(a, b)); }

/** reflect point p across line through a with direction d */
export function reflect(p: Vec, a: Vec, d: Vec): Vec {
  const n = norm(d);
  const ap = sub(p, a);
  const proj = mul(n, dot(ap, n));
  const perpPart = sub(ap, proj);
  return add(a, sub(proj, perpPart));
}

/** Round to a fixed number of decimals (used for export / comparisons) */
export const round = (x: number, d = 6): number => { const f = 10 ** d; return Math.round(x * f) / f; };

export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export function bbox(pts: Vec[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return { minX, minY, maxX, maxY };
}
export const boxW = (b: Box) => b.maxX - b.minX;
export const boxH = (b: Box) => b.maxY - b.minY;
export const boxCenter = (b: Box): Vec => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
export function boxUnion(a: Box, b: Box): Box {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}
