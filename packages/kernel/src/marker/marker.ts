/**
 * Marker making: cut plan (order quantities → markers with a size ratio and a ply count), the parts of a
 * marker (every piece of every bundle, turned so its grain runs along the fabric), placements, checks,
 * statistics, the nesting-engine job (sparrow) and marker export (DXF / HPGL).
 *
 * Fabric frame: x runs along the fabric length (marker length), y across the fabric width, both in mm.
 * A placement turns a part's outline by `rot` degrees about its own origin and then moves it by (x, y).
 */
import type { Vec } from '../geom/vec';
import { signedArea, pointInPolygon, distToPolygon } from '../geom/poly';
import type { Document } from '../model/doc';
import type { Id, SizeId } from '../model/types';

// ───────────────────────── cut plan ─────────────────────────

export interface CutPlanRow { id: string; name: string; ratio: Record<SizeId, number>; plies: number }
export interface CutPlanOptions { maxPlies: number; maxBundles: number }
/**
 * Marker direction rule (lay limits):
 *   'bundle' — one bundle, one direction: every part of a bundle faces the same way; with the 180° switch on a bundle may be turned as a whole
 *   'size'   — same size, same direction: all bundles of a size face the same way; sizes may face opposite ways
 *   'all'    — all bundles one direction: every part faces the same way
 *   'piece'  — each part on its own, as far as its piece allows (Order ▸ Rotation)
 */
export type MarkerDirection = 'bundle' | 'size' | 'all' | 'piece';
/** One marker of the cut plan: its ratio and plies, and where its parts are laid. */
export interface MarkerRow extends CutPlanRow {
  placements: Record<string, { x: number; y: number; rot: number }>;
  /** fabric width of this marker (mm); absent = the default width of the marker room */
  width?: number;
  /** married parts: groups of part ids that are picked up, thrown and turned as one */
  marry?: string[][];
}
/** Everything marker making keeps with the style. */
export interface MarkerDoc {
  order: Record<SizeId, number>; maxPlies: number; maxBundles: number;
  /** fabric width (mm), gap between parts (mm), material the markers are for ('' = all pieces), nesting time (s) */
  width: number; gap: number; material: string; nestSeconds: number;
  /** which way the parts may face (absent = 'bundle'), and whether a bundle may be turned 180° (absent = true; only used by 'bundle') */
  direction?: MarkerDirection; rot180?: boolean;
  /** the cut plans of the other materials (the top-level limits and rows are those of `material`), keyed by material */
  others?: Record<string, { maxPlies: number; maxBundles: number; rows: MarkerRow[] }>;
  /** block fuse: pieces cut as a block, their outline replaced by its box grown by this margin (mm), keyed by piece id */
  block?: Record<Id, number>;
  rows: MarkerRow[];
}

const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + (b > 0 ? b : 0), 0);

/**
 * Automatic cut plan: markers (a ratio of bundles per size) and plies that cut the order exactly, using as few
 * spreads as the limits allow. Each step takes the marker that cuts the most garments: for every possible ply
 * height the ratio is "how many times that height fits in what is left of each size", trimmed to the most
 * bundles a marker may hold by taking from the fullest sizes first.
 */
export function autoCutPlan(sizes: SizeId[], order: Record<SizeId, number>, o: CutPlanOptions): CutPlanRow[] {
  const maxPlies = Math.max(1, Math.floor(o.maxPlies)), maxBundles = Math.max(1, Math.floor(o.maxBundles));
  const rem: Record<SizeId, number> = {};
  for (const s of sizes) rem[s] = Math.max(0, Math.floor(order[s] ?? 0));
  const rows: CutPlanRow[] = [];
  for (let guard = 0; guard < 200 && total(rem) > 0; guard++) {
    let best: { p: number; r: Record<SizeId, number>; cut: number } | null = null;
    const top = Math.min(maxPlies, Math.max(...sizes.map(s => rem[s])));
    for (let p = top; p >= 1; p--) {
      const r: Record<SizeId, number> = {};
      let n = 0;
      for (const s of sizes) { r[s] = Math.floor(rem[s] / p); n += r[s]; }
      if (!n) continue;
      while (n > maxBundles) {
        // take one bundle from the size with the most bundles (ties: the one with the least left to cut)
        let pick = sizes[0], bv = -1;
        for (const s of sizes) if (r[s] > bv || (r[s] === bv && rem[s] < rem[pick])) { pick = s; bv = r[s]; }
        r[pick]--; n--;
      }
      if (!best || n * p > best.cut) best = { p, r, cut: n * p };
      if (best.cut >= maxBundles * top) break; // cannot be beaten by a lower spread
    }
    if (!best) break;
    for (const s of sizes) rem[s] -= best.r[s] * best.p;
    rows.push({ id: 'm' + (rows.length + 1), name: 'Marker ' + (rows.length + 1), ratio: best.r, plies: best.p });
  }
  return rows;
}

/** What a cut plan cuts against the order: per size and in total (diff > 0 = too many, < 0 = short). */
export function planTotals(sizes: SizeId[], order: Record<SizeId, number>, rows: CutPlanRow[]) {
  const cut: Record<SizeId, number> = {}, diff: Record<SizeId, number> = {};
  for (const s of sizes) { cut[s] = rows.reduce((a, r) => a + Math.max(0, r.ratio[s] ?? 0) * Math.max(0, r.plies), 0); diff[s] = cut[s] - Math.max(0, order[s] ?? 0); }
  return { cut, diff, garments: total(cut), ordered: total(order), plies: rows.reduce((a, r) => a + Math.max(0, r.plies), 0), exact: sizes.every(s => diff[s] === 0) };
}

/**
 * Every material has its own cut plan (limits and markers); the order is shared. Switching the material puts the
 * current plan away under its material and brings out the plan of the new one (an empty plan with the same limits
 * the first time).
 */
export function switchMarkerMaterial(d: MarkerDoc, material: string): void {
  if (material === d.material) return;
  const others = { ...(d.others ?? {}) };
  others[d.material] = { maxPlies: d.maxPlies, maxBundles: d.maxBundles, rows: d.rows };
  const next = others[material] ?? { maxPlies: d.maxPlies, maxBundles: d.maxBundles, rows: [] };
  delete others[material];
  d.material = material; d.maxPlies = next.maxPlies; d.maxBundles = next.maxBundles; d.rows = next.rows;
  d.others = others;
}

// ───────────────────────── parts ─────────────────────────

export interface MarkerPart {
  id: string; pieceId: Id; name: string; sizeId: SizeId; sizeName: string; bundle: number; mirror: boolean;
  /** turns the fabric allows for this part (degrees) */
  angles: number[];
  /** outline (cut line), grain along +x, lower-left of its box at the origin, counter-clockwise */
  poly: Vec[];
  /** grain line in the same frame */
  grain: [Vec, Vec];
  area: number;
  material: string;
  /** block fuse: the piece's own outline inside the block (`poly` is then the block) */
  inner?: Vec[];
}
export interface Placement { x: number; y: number; rot: number }
export type Placements = Record<string, Placement>;

const rotP = (p: Vec, deg: number): Vec => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }; };
export function placedPoly(part: MarkerPart, pl: Placement): Vec[] { return part.poly.map(q => { const r = rotP(q, pl.rot); return { x: r.x + pl.x, y: r.y + pl.y }; }); }
export function placedPoint(pl: Placement, q: Vec): Vec { const r = rotP(q, pl.rot); return { x: r.x + pl.x, y: r.y + pl.y }; }
export function polyBox(pts: Vec[]) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of pts) { if (q.x < x0) x0 = q.x; if (q.y < y0) y0 = q.y; if (q.x > x1) x1 = q.x; if (q.y > y1) y1 = q.y; } return { x0, y0, x1, y1 }; }
/** The placement that puts a part, turned by `rot`, with the lower-left of its box at (x, y). */
export function placeAt(part: MarkerPart, x: number, y: number, rot: number): Placement {
  const b = polyBox(part.poly.map(q => rotP(q, rot)));
  return { x: x - b.x0, y: y - b.y0, rot };
}

/**
 * Every part of a marker with the given ratio (bundles per size): each piece of the style, in each size of the
 * ratio, once per bundle and per quantity; a piece cut as a pair (side L + R) gives a mirrored part as well.
 * `material` keeps only the pieces of that material (empty = all).
 */
export function markerParts(doc: Document, ratio: Record<SizeId, number>, o: { material?: string; block?: Record<Id, number> } = {}): MarkerPart[] {
  const out: MarkerPart[] = [];
  for (const piece of doc.style.pieces) {
    const mat = piece.order?.material ?? '';
    if (o.material && mat !== o.material) continue;
    const line = doc.sizeLine(piece);
    for (const sid of doc.sizesOf(piece)) {
      const n = Math.max(0, Math.floor(ratio[sid] ?? 0)); if (!n) continue;
      let rp; try { rp = doc.resolvePiece(piece.id, sid, { output: true }); } catch { continue; }
      const src = rp.cut.length > 2 ? rp.cut : rp.sew.pts; if (src.length < 3) continue;
      const g = rp.grain, ang = -Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x) * 180 / Math.PI;
      const sizeName = line.sizes.find(s => s.id === sid)?.name ?? sid;
      const rot = piece.order?.rotation ?? '2way';
      const angles = rot === '1way' ? [0] : rot === '2way' ? [0, 180] : [0, 90, 180, 270];
      const qty = Math.max(1, Math.floor(piece.order?.qtyPerBundle ?? 1));
      const pair = piece.order?.side === 'LR';
      for (const mirror of pair ? [false, true] : [false]) {
        let pts = src.map(q => rotP(q, ang)), gl = [rotP(g.a, ang), rotP(g.b, ang)];
        if (mirror) { pts = pts.map(q => ({ x: q.x, y: -q.y })); gl = gl.map(q => ({ x: q.x, y: -q.y })); }
        const b = polyBox(pts);
        pts = pts.map(q => ({ x: q.x - b.x0, y: q.y - b.y0 }));
        if (signedArea(pts) < 0) pts.reverse();
        let grain: [Vec, Vec] = [{ x: gl[0].x - b.x0, y: gl[0].y - b.y0 }, { x: gl[1].x - b.x0, y: gl[1].y - b.y0 }];
        // block fuse: the part is laid as a block (its box grown by the margin); the outline is kept for the drawing
        const bm = Math.max(0, o.block?.[piece.id] ?? 0);
        let inner: Vec[] | undefined;
        if (bm > 0) {
          const w = b.x1 - b.x0 + 2 * bm, hh = b.y1 - b.y0 + 2 * bm;
          inner = pts.map(q => ({ x: q.x + bm, y: q.y + bm }));
          grain = [{ x: grain[0].x + bm, y: grain[0].y + bm }, { x: grain[1].x + bm, y: grain[1].y + bm }];
          pts = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: hh }, { x: 0, y: hh }];
        }
        const area = Math.abs(signedArea(pts));
        for (let bn = 1; bn <= n; bn++) for (let k = 1; k <= qty; k++) {
          out.push({ id: [piece.id, sid, bn, k, mirror ? 'm' : 'n'].join('|'), pieceId: piece.id, name: piece.name, sizeId: sid, sizeName, bundle: bn, mirror, angles, poly: pts, grain, area, material: mat, ...(inner ? { inner } : {}) });
        }
      }
    }
  }
  return out;
}

// ───────────────────────── direction rule ─────────────────────────

/** The group of parts that must face the same way under a rule ('' = the part is on its own). */
export function directionGroup(p: MarkerPart, rule: MarkerDirection): string {
  return rule === 'all' ? '*' : rule === 'size' ? p.sizeId : rule === 'bundle' ? p.sizeId + '|' + p.bundle : '';
}
/** May the parts of a group be turned 180° together? Only when every piece in it allows 180° and the rule does. */
export function groupMayTurn(parts: MarkerPart[], group: string, rule: MarkerDirection, rot180: boolean): boolean {
  if (rule === 'all' || rule === 'piece' || (rule === 'bundle' && !rot180)) return false;
  return parts.filter(p => directionGroup(p, rule) === group).every(p => p.angles.includes(180));
}
/**
 * The parts as the nester may lay them under a rule: every group gets one fixed direction. Groups that may
 * turn alternate 0° / 180° in their order (bundle after bundle, or size after size), which lets them interlock;
 * the others stay at 0°. Under 'piece' the parts keep their own allowed turns.
 */
export function directedParts(parts: MarkerPart[], rule: MarkerDirection, rot180: boolean): MarkerPart[] {
  if (rule === 'piece') return parts;
  const order: string[] = [];
  for (const p of parts) { const g = directionGroup(p, rule); if (!order.includes(g)) order.push(g); }
  const ang = new Map<string, number>();
  let k = 0;
  for (const g of order) ang.set(g, groupMayTurn(parts, g, rule, rot180) ? (k++ % 2 ? 180 : 0) : 0);
  return parts.map(p => ({ ...p, angles: [ang.get(directionGroup(p, rule)) ?? 0] }));
}
/**
 * Placements made to obey a rule: in every group the direction of its first laid part counts (0° when the group
 * may not turn); parts laid the other way are taken off the marker. Returns the placements and how many were taken off.
 */
export function obeyDirection(parts: MarkerPart[], pl: Placements, rule: MarkerDirection, rot180: boolean): { placements: Placements; removed: number } {
  if (rule === 'piece') return { placements: pl, removed: 0 };
  const dir = new Map<string, number>(), out: Placements = {};
  let removed = 0;
  for (const p of parts) {
    const q = pl[p.id]; if (!q) continue;
    const g = directionGroup(p, rule);
    if (!dir.has(g)) dir.set(g, groupMayTurn(parts, g, rule, rot180) && q.rot === 180 ? 180 : 0);
    if (q.rot === dir.get(g)) out[p.id] = q; else removed++;
  }
  return { placements: out, removed };
}

// ───────────────────────── throwing a part ─────────────────────────

/**
 * Throw parts along a direction: they travel from where they are until they touch another part or an edge of
 * the fabric, and stop there. Parts that start on top of something first travel until they are free. A part
 * thrown along the fabric stops at the end of the marker. Returns the new placements of `ids`, or null when
 * there is no free place on the way.
 */
export function throwParts(parts: MarkerPart[], pl: Placements, width: number, ids: string[], dir: Vec, o: { tol?: number; gap?: number } = {}): Placements | null {
  const L = Math.hypot(dir.x, dir.y); if (L < 1e-9) return null;
  const d = { x: dir.x / L, y: dir.y / L }, tol = o.tol ?? 0.05, gap = Math.max(0, o.gap ?? 0);
  const set = new Set(ids);
  const still = parts.filter(p => pl[p.id] && !set.has(p.id)).map(p => { const poly = placedPoly(p, pl[p.id]); return { poly, box: polyBox(poly), smp: null as Vec[] | null }; });
  const movers = parts.filter(p => pl[p.id] && set.has(p.id)).map(p => { const poly = placedPoly(p, pl[p.id]); return { id: p.id, poly, box: polyBox(poly), smp: samples(poly, 8) }; });
  if (!movers.length) return null;
  const end = still.reduce((a, s) => Math.max(a, s.box.x1), 0);
  const reach = gap + tol;
  const deep = (pts: Vec[], poly: Vec[], dx: number, dy: number) => pts.some(q => { const v = { x: q.x + dx, y: q.y + dy }; return pointInPolygon(v, poly) ? distToPolygon(v, poly) > tol : gap > 0 && distToPolygon(v, poly) < gap - tol; });
  const fits = (t: number, cap = true): boolean => {
    const dx = d.x * t, dy = d.y * t;
    for (const m of movers) {
      const b = { x0: m.box.x0 + dx, y0: m.box.y0 + dy, x1: m.box.x1 + dx, y1: m.box.y1 + dy };
      if (b.y0 < -tol || b.y1 > width + tol || b.x0 < -tol) return false;
      if (cap && d.x > 0.05 && t > 0 && b.x0 > end + tol) return false; // along the fabric: not past the end of the marker
      for (const s of still) {
        if (b.x1 < s.box.x0 - reach + tol * 2 || s.box.x1 < b.x0 - reach + tol * 2 || b.y1 < s.box.y0 - reach + tol * 2 || s.box.y1 < b.y0 - reach + tol * 2) continue;
        s.smp ??= samples(s.poly, 8);
        if (deep(m.smp, s.poly, dx, dy) || deep(s.smp, m.poly, -dx, -dy)) return false;
      }
    }
    return true;
  };
  const far = 3 * (width + end) + 4000;
  let t = 0;
  if (!fits(0, false)) { for (t = 5; t <= far && !fits(t, false); t += 5); if (t > far) return null; }
  for (const step of [40, 8, 1.6, 0.3, 0.05]) while (t + step <= far && fits(t + step)) t += step;
  const out: Placements = {};
  for (const m of movers) out[m.id] = { ...pl[m.id], x: pl[m.id].x + d.x * t, y: pl[m.id].y + d.y * t };
  return out;
}

// ───────────────────────── checks and statistics ─────────────────────────

export interface MarkerStats { parts: number; placed: number; length: number; usedArea: number; efficiency: number; totalArea: number }
export function markerStats(parts: MarkerPart[], pl: Placements, width: number): MarkerStats {
  let length = 0, used = 0, placed = 0, all = 0;
  for (const p of parts) {
    all += p.area;
    const q = pl[p.id]; if (!q) continue;
    placed++; used += p.area;
    const b = polyBox(placedPoly(p, q)); if (b.x1 > length) length = b.x1;
  }
  return { parts: parts.length, placed, length, usedArea: used, totalArea: all, efficiency: length > 0 && width > 0 ? used / (length * width) : 0 };
}

/** Points along an outline: its corners and points every `step` mm in between. */
function samples(pts: Vec[], step: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]; const L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  }
  // and a few points well inside, so that a part lying exactly on top of another (no outline point inside the other) is found too
  let cx = 0, cy = 0; for (const q of pts) { cx += q.x; cy += q.y; } cx /= pts.length; cy /= pts.length;
  const stride = Math.max(1, Math.floor(pts.length / 8));
  for (const q of [{ x: cx, y: cy }, ...pts.filter((_, i) => i % stride === 0).map(v => ({ x: (v.x + cx) / 2, y: (v.y + cy) / 2 }))]) if (pointInPolygon(q, pts) && distToPolygon(q, pts) > 1.5) out.push(q);
  return out;
}
/**
 * Parts that are not laid correctly: they overlap another part by more than `tol` mm, or they reach outside
 * the fabric (y < 0, y > width, x < 0). Returns their ids.
 */
export function markerProblems(parts: MarkerPart[], pl: Placements, width: number, tol = 0.6): Set<string> {
  const bad = new Set<string>();
  const P = parts.filter(p => pl[p.id]).map(p => { const poly = placedPoly(p, pl[p.id]); return { id: p.id, poly, box: polyBox(poly), smp: null as Vec[] | null }; });
  for (const a of P) if (a.box.y0 < -tol || a.box.y1 > width + tol || a.box.x0 < -tol) bad.add(a.id);
  const deep = (pts: Vec[], poly: Vec[]) => pts.some(q => pointInPolygon(q, poly) && distToPolygon(q, poly) > tol);
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], b = P[j];
    if (a.box.x1 < b.box.x0 + tol || b.box.x1 < a.box.x0 + tol || a.box.y1 < b.box.y0 + tol || b.box.y1 < a.box.y0 + tol) continue;
    a.smp ??= samples(a.poly, 8); b.smp ??= samples(b.poly, 8);
    if (deep(a.smp, b.poly) || deep(b.smp, a.poly)) { bad.add(a.id); bad.add(b.id); }
  }
  return bad;
}

// ───────────────────────── nesting engine job (sparrow) ─────────────────────────

/** Ramer–Douglas–Peucker on a closed outline. */
export function simplifyClosed(pts: Vec[], tol: number): Vec[] {
  if (pts.length < 8 || tol <= 0) return pts;
  // split at the two points furthest apart so both halves are open runs
  let i0 = 0, i1 = 0, bd = -1;
  for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y); if (d > bd) { bd = d; i1 = i; } }
  const run = (a: number, b: number): Vec[] => { const out: Vec[] = []; for (let i = a; ; i = (i + 1) % pts.length) { out.push(pts[i]); if (i === b) break; } return out; };
  const rdp = (p: Vec[]): Vec[] => {
    if (p.length < 3) return p;
    const a = p[0], b = p[p.length - 1], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    let mi = 0, md = 0;
    for (let i = 1; i < p.length - 1; i++) { const d = Math.abs(dx * (p[i].y - a.y) - dy * (p[i].x - a.x)) / L; if (d > md) { md = d; mi = i; } }
    if (md <= tol) return [a, b];
    return [...rdp(p.slice(0, mi + 1)).slice(0, -1), ...rdp(p.slice(mi))];
  };
  const A = rdp(run(i0, i1)), B = rdp(run(i1, i0));
  const out = [...A.slice(0, -1), ...B.slice(0, -1)];
  return out.length >= 3 ? out : pts;
}

export interface NestJob { json: string; groups: string[][]; gap: number }
/**
 * The job for the nesting engine: identical parts (same piece, size and mirror) become one item with a demand.
 * Only `ids` are nested when given. The fabric width is the strip height of the engine.
 */
export function nestJob(parts: MarkerPart[], width: number, o: { gap?: number; ids?: Set<string>; tol?: number; name?: string } = {}): NestJob {
  const groups: string[][] = [], byKey = new Map<string, number>(), items: unknown[] = [];
  for (const p of parts) {
    if (o.ids && !o.ids.has(p.id)) continue;
    const key = [p.pieceId, p.sizeId, p.mirror ? 1 : 0, p.angles.join(',')].join('|');
    let gi = byKey.get(key);
    if (gi === undefined) {
      gi = groups.length; byKey.set(key, gi); groups.push([]);
      const pts = simplifyClosed(p.poly, o.tol ?? 0.3).map(q => [+q.x.toFixed(3), +q.y.toFixed(3)]);
      items.push({ id: gi, demand: 0, orientation: { rotation: { mode: 'discrete', angles: p.angles } }, shape: { type: 'simple_polygon', data: pts } });
    }
    groups[gi].push(p.id); (items[gi] as { demand: number }).demand++;
  }
  return { json: JSON.stringify({ name: o.name ?? 'marker', items, strip_height: width }), groups, gap: Math.max(0, o.gap ?? 0) };
}
/** The engine's answer → placements of the parts of the job, and the marker length. */
export function nestResult(sol: string | { strip_width: number; layout: { placed_items: { item_id: number; transformation: { rotation: number; translation: [number, number] } }[] } }, job: NestJob): { placements: Placements; length: number } {
  const s = typeof sol === 'string' ? JSON.parse(sol) : sol;
  const used = job.groups.map(() => 0), out: Placements = {};
  for (const pi of s.layout.placed_items) {
    const g = job.groups[pi.item_id]; if (!g) continue;
    const id = g[used[pi.item_id]++]; if (!id) continue;
    out[id] = { x: pi.transformation.translation[0], y: pi.transformation.translation[1], rot: ((Math.round(pi.transformation.rotation) % 360) + 360) % 360 };
  }
  return { placements: out, length: s.strip_width };
}

// ───────────────────────── export ─────────────────────────

/** Marker as DXF (R12, mm): fabric outline on layer FABRIC, every part as a closed polyline on CUT, its name and size on TEXT, grain on GRAIN. */
export function markerDXF(parts: MarkerPart[], pl: Placements, width: number, name = 'MARKER'): string {
  const st = markerStats(parts, pl, width);
  const L: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES'];
  const poly = (pts: Vec[], layer: string, closed: boolean) => {
    L.push(0, 'POLYLINE', 8, layer, 66, 1, 70, closed ? 1 : 0);
    for (const q of pts) L.push(0, 'VERTEX', 8, layer, 10, q.x.toFixed(3), 20, q.y.toFixed(3));
    L.push(0, 'SEQEND');
  };
  poly([{ x: 0, y: 0 }, { x: st.length, y: 0 }, { x: st.length, y: width }, { x: 0, y: width }], 'FABRIC', true);
  for (const p of parts) {
    const q = pl[p.id]; if (!q) continue;
    const pts = placedPoly(p, q), b = polyBox(pts);
    poly(pts, p.inner ? 'BLOCK' : 'CUT', true);
    if (p.inner) poly(p.inner.map(v => placedPoint(q, v)), 'CUT', true);
    poly([placedPoint(q, p.grain[0]), placedPoint(q, p.grain[1])], 'GRAIN', false);
    L.push(0, 'TEXT', 8, 'TEXT', 10, ((b.x0 + b.x1) / 2).toFixed(3), 20, ((b.y0 + b.y1) / 2).toFixed(3), 40, 8, 1, `${p.name} ${p.sizeName}${p.mirror ? ' (M)' : ''}`);
  }
  L.push(0, 'TEXT', 8, 'TEXT', 10, 0, 20, (width + 12).toFixed(3), 40, 12, 1, `${name}  W ${width.toFixed(0)} mm  L ${st.length.toFixed(0)} mm  EFF ${(st.efficiency * 100).toFixed(2)}%`);
  L.push(0, 'ENDSEC', 0, 'EOF');
  return L.join('\n') + '\n';
}
/** Marker as HPGL / PLT (40 units per mm): every placed part as one closed pen path. */
export function markerHPGL(parts: MarkerPart[], pl: Placements): string {
  const u = (v: number) => Math.round(v * 40);
  const out = ['IN;', 'SP1;'];
  for (const p of parts) {
    const q = pl[p.id]; if (!q) continue;
    const pts = placedPoly(p, q);
    out.push(`PU${u(pts[0].x)},${u(pts[0].y)};`, 'PD' + [...pts.slice(1), pts[0]].map(v => `${u(v.x)},${u(v.y)}`).join(',') + ';');
  }
  out.push('PU0,0;', 'SP0;');
  return out.join('\n') + '\n';
}
