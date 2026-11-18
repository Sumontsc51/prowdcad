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
/** One marker of the cut plan: its ratio and plies, and where its parts are laid. */
export interface MarkerRow extends CutPlanRow { placements: Record<string, { x: number; y: number; rot: number }> }
/** Everything marker making keeps with the style. */
export interface MarkerDoc {
  order: Record<SizeId, number>; maxPlies: number; maxBundles: number;
  /** fabric width (mm), gap between parts (mm), material the markers are for ('' = all pieces), nesting time (s) */
  width: number; gap: number; material: string; nestSeconds: number;
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
export function markerParts(doc: Document, ratio: Record<SizeId, number>, o: { material?: string } = {}): MarkerPart[] {
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
        const grain: [Vec, Vec] = [{ x: gl[0].x - b.x0, y: gl[0].y - b.y0 }, { x: gl[1].x - b.x0, y: gl[1].y - b.y0 }];
        const area = Math.abs(signedArea(pts));
        for (let bn = 1; bn <= n; bn++) for (let k = 1; k <= qty; k++) {
          out.push({ id: [piece.id, sid, bn, k, mirror ? 'm' : 'n'].join('|'), pieceId: piece.id, name: piece.name, sizeId: sid, sizeName, bundle: bn, mirror, angles, poly: pts, grain, area, material: mat });
        }
      }
    }
  }
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
    const key = [p.pieceId, p.sizeId, p.mirror ? 1 : 0].join('|');
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
    poly(pts, 'CUT', true);
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
