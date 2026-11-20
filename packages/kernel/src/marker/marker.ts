/**
 * Marker making: cut plan (order quantities → markers with a size ratio and a ply count), the parts of a
 * marker (every piece of every bundle, turned so its grain runs along the fabric), placements, checks,
 * statistics, the nesting-engine job (sparrow) and marker export (DXF / HPGL).
 *
 * Fabric frame: x runs along the fabric length (marker length), y across the fabric width, both in mm.
 * A placement turns a part's outline by `rot` degrees about its own origin and then moves it by (x, y).
 */
import type { Vec } from '../geom/vec';
import { signedArea, pointInPolygon, distToPolygon, offsetOutward } from '../geom/poly';
import type { Document } from '../model/doc';
import type { Id, SizeId } from '../model/types';
import { resolveNotches } from '../ops/notches';
import { drillPosition } from '../ops/drills';

// ───────────────────────── cut plan ─────────────────────────

export interface CutPlanRow { id: string; name: string; ratio: Record<SizeId, number>; plies: number }
export interface CutPlanOptions { maxPlies: number; maxBundles: number }
/** Annotation of a marker: what is written on every part, which lines of the piece are shown, and the marker border with its facts. */
export interface MarkerAnnot {
  style: boolean; piece: boolean; size: boolean; bundle: boolean; desc: boolean;
  grain: boolean; seam: boolean;
  /** internal lines of the pieces: left out, drawn (pen), or cut */
  internals: 'none' | 'draw' | 'cut';
  border: boolean; bName: boolean; bRatio: boolean; bLength: boolean; bWidth: boolean; bEff: boolean; bPerim: boolean;
  /**
   * What is written on a part, as typed: every line of this text is one printed line, and {style} {piece} {size} {bundle} {no}
   * {desc} {material} are filled in. Absent = built from the switches above.
   */
  partText?: string;
  /** What is written at the marker, as typed: {name} {ratio} {length} {width} {eff} {perim} {style} {material} {plies} {parts}. Absent = built from the switches. */
  markerText?: string;
  /** unit of the lengths written at the marker (absent = mm) */
  unit?: AnnotUnit;
  /** where the marker text goes: above or below the marker at its start, or written upward before its start / after its end (absent = top) */
  place?: AnnotPlace;
  /** text height on the parts and at the marker (mm); absent = 8 and 12 */
  textH?: number; bTextH?: number;
}
export type AnnotUnit = 'mm' | 'cm' | 'm' | 'in' | 'yd';
export type AnnotPlace = 'top' | 'bottom' | 'start' | 'end';
/**
 * Stripe and plaid of the fabric (mm; 0 or absent = none).
 *   stripe — bars across the fabric width that repeat along its length every `stripe`; the first one lies `stripe1` from the marker start.
 *            A match line across the grain of a piece lies on a bar.
 *   plaid  — bars along the fabric length that repeat across its width every `plaid`; the first one lies `plaid1` from the fabric edge.
 *            A match line along the grain of a piece lies on a bar.
 */
export interface FabricMatch { stripe?: number; stripe1?: number; plaid?: number; plaid1?: number }
/**
 * Shade zones of a marker (shading of the fabric from side to centre and along the roll). The major pieces of a bundle (Piece
 * details ▸ Major) must lie within one zone, so that the panels of a garment have the same shade.
 *   rows       — the fabric width is divided into this many equal rows (1 = the whole width)
 *   colBy      — 'length': a zone is `colLength` long; 'bundle': a zone ends where its bundle ends (bundles follow each other)
 *   rowOverlap — the offset of every row line, in % of the row height: how far a piece may reach into the next row
 *   colOverlap — in % of the column length ('length'), or of the (longer) bundle length that may be shared with the next bundle ('bundle')
 */
export interface ShadeSet { rows: number; colBy: 'length' | 'bundle'; colLength: number; rowOverlap: number; colOverlap: number }
/** A match line of a part, in the frame of the part: its code ('M1', 'P1' … 'P15'), middle and direction. */
export interface MatchLine { code: string; mid: Vec; dir: Vec }
/** How a piece is treated in marker making (Piece details). */
export interface PieceDetail {
  /** goes into fuse blocks when the marker is nested */
  block?: boolean;
  /** a major piece (the big panels): shown first among the waiting parts */
  major?: boolean;
  /** turns allowed on the marker; absent = the piece's own setting (Order ▸ Rotation) */
  rotation?: '1way' | '2way' | '4way';
  /** how far the part may be tilted off the grain, either way (degrees) */
  tilt?: number;
}
/** Fuse blocks built by the nester: no block is longer or wider than this; every block has its own margin all round. */
export interface BlockSet { maxLength: number; maxWidth: number; buffer: number; shape: 'rect' | 'contour' }
export const DEFAULT_BLOCKSET: BlockSet = { maxLength: 1000, maxWidth: 600, buffer: 10, shape: 'rect' };
/** A fuse block on a marker: these laid parts are cut out together, inside one outline (their box, or their contour, grown by the margin). They move as one. */
export interface MarkerBlock { ids: string[]; shape: 'rect' | 'contour'; buffer: number; /** built by the nester (replaced at the next nest) */ auto?: boolean }
export const DEFAULT_ANNOT: MarkerAnnot = { style: false, piece: true, size: true, bundle: true, desc: false, grain: true, seam: false, internals: 'draw', border: true, bName: true, bRatio: true, bLength: true, bWidth: true, bEff: true, bPerim: true };

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
  /** fuse blocks of laid parts */
  blocks?: MarkerBlock[];
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
  /** buffer: pieces that keep a clear margin (mm) around their outline, keyed by piece id */
  buffer?: Record<Id, number>;
  /** what is written on the parts and around the marker (plot, DXF and screen); absent = DEFAULT_ANNOT */
  annot?: Partial<MarkerAnnot>;
  /** (old files) pieces that were laid as a block each; read as "goes into fuse blocks" */
  block?: Record<Id, number>;
  /** piece details: block, major, rotation, tilt, keyed by piece id */
  detail?: Record<Id, PieceDetail>;
  /** stripe and plaid of the fabric, for the match lines of the pieces */
  match?: FabricMatch;
  /** shade zones: the major pieces of a bundle are laid within one zone */
  shade?: ShadeSet;
  /** limits and shape of the fuse blocks the nester builds; absent = DEFAULT_BLOCKSET */
  blockSet?: Partial<BlockSet>;
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
  /** buffer: the piece's own cut outline inside `poly` (which is then the outline grown by the buffer) */
  inner?: Vec[];
  /** 'buffer' = room kept around the part ('block' is only used for the stand-in part of a fuse block) */
  hold?: 'block' | 'buffer';
  /** piece details: tilt allowed either way (degrees), major piece, goes into fuse blocks */
  tilt?: number; major?: boolean; fuse?: boolean;
  /** sew line and internal lines of the piece, in the frame of the part; `uses` (same order as `lines`): 'draw', 'cut' or a match code */
  sew?: Vec[]; lines?: Vec[][]; uses?: string[];
  /** match lines (to the fabric, or piece to piece) */
  match?: MatchLine[];
  /** notch marks (each a small polyline from the cut line inward): cut, or drawn */
  notches?: Vec[][]; notchesDrawn?: Vec[][];
  /** drill holes, buttons and buttonholes: place, diameter, cut or drawn */
  drills?: { at: Vec; d: number; cut: boolean }[];
  /** piece description, and the bundle code (size and bundle number) */
  desc?: string; code: string;
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
export function markerParts(doc: Document, ratio: Record<SizeId, number>, o: { material?: string; block?: Record<Id, number>; buffer?: Record<Id, number>; detail?: Record<Id, PieceDetail> } = {}): MarkerPart[] {
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
      const det = o.detail?.[piece.id] ?? {};
      const rot = det.rotation ?? piece.order?.rotation ?? '2way';
      const tilt = Math.max(0, Math.min(15, det.tilt ?? 0)), fuse = det.block ?? !!o.block?.[piece.id];
      const angles = rot === '1way' ? [0] : rot === '2way' ? [0, 180] : [0, 90, 180, 270];
      const qty = Math.max(1, Math.floor(piece.order?.qtyPerBundle ?? 1));
      const pair = piece.order?.side === 'LR';
      for (const mirror of pair ? [false, true] : [false]) {
        // the marker is seen from above with y running down the fabric width: an unmirrored part is turned over in y so that it looks
        // as it does on the pattern sheet (y up there); the other part of a pair is its mirror image
        const fy = mirror ? 1 : -1;
        const T0 = (q: Vec): Vec => { const r = rotP(q, ang); return { x: r.x, y: r.y * fy }; };
        let pts = src.map(T0);
        const b = polyBox(pts);
        let sh = { x: -b.x0, y: -b.y0 };
        // buffer: the outline grown by the margin keeps the room around the part clear; the real outline is kept inside
        const bf = Math.max(0, o.buffer?.[piece.id] ?? 0);
        let inner: Vec[] | undefined, hold: 'buffer' | undefined;
        if (bf > 0) {
          let grown: Vec[] = []; try { grown = offsetOutward(pts, bf, 'miter'); } catch { grown = []; }
          if (grown.length > 2) {
            const gb = polyBox(grown); sh = { x: -gb.x0, y: -gb.y0 };
            inner = pts.map(q => ({ x: q.x + sh.x, y: q.y + sh.y })); hold = 'buffer';
            pts = grown.map(q => ({ x: q.x + sh.x, y: q.y + sh.y }));
          } else pts = pts.map(q => ({ x: q.x + sh.x, y: q.y + sh.y }));
        } else pts = pts.map(q => ({ x: q.x + sh.x, y: q.y + sh.y }));
        if (signedArea(pts) < 0) pts.reverse();
        const T = (q: Vec): Vec => { const r = T0(q); return { x: r.x + sh.x, y: r.y + sh.y }; };
        const grain: [Vec, Vec] = [T(g.a), T(g.b)];
        const sew = rp.cut.length > 2 && rp.sew.pts.length > 2 ? rp.sew.pts.map(T) : undefined;
        const eff = doc.effectivePiece(piece.id, true).internals;
        const kept = rp.internals.map((c, i) => ({ c, use: eff[i]?.match ? eff[i].match! : eff[i]?.mode === 'cut' ? 'cut' : 'draw' })).filter(x => x.c.pts.length > 1);
        const lines = kept.map(x => (x.c.closed ? [...x.c.pts, x.c.pts[0]] : x.c.pts).map(T));
        const uses = kept.map(x => x.use);
        const match: MatchLine[] = [];
        kept.forEach((x, i) => { if (!/^[MP]\d+$/.test(x.use)) return; const l = lines[i], a = l[0], b = l[l.length - 1]; match.push({ code: x.use, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dir: { x: b.x - a.x, y: b.y - a.y } }); });
        // notches and drill holes of the piece in this size. Only a notch mark that starts on the cut line is cut: a mark on the
        // sew line lies inside the piece and is drawn
        const effP = doc.effectivePiece(piece.id, true), notches: Vec[][] = [], notchesDrawn: Vec[][] = [];
        try { for (const rn of resolveNotches(doc, effP, sid)) { const mode = effP.notches.find(q => q.id === rn.notchId)?.mode ?? 'cut'; for (const g of rn.cutGeometry) if (g.length > 1) (mode === 'draw' || distToPolygon(g[0], src) > 0.5 ? notchesDrawn : notches).push(g.map(T)); } } catch { /* a notch that cannot be resolved is left out */ }
        const drills = effP.drills.map(dr => { try { return { at: T(drillPosition(doc, effP, dr, sid)), d: dr.diameter, cut: dr.mode === 'cut' }; } catch { return null; } }).filter((x): x is { at: Vec; d: number; cut: boolean } => !!x);
        const desc = piece.description?.trim() || undefined;
        const area = Math.abs(signedArea(pts));
        for (let bn = 1; bn <= n; bn++) for (let k = 1; k <= qty; k++) {
          out.push({ id: [piece.id, sid, bn, k, mirror ? 'm' : 'n'].join('|'), pieceId: piece.id, name: piece.name, sizeId: sid, sizeName, bundle: bn, mirror, angles, poly: pts, grain, area, material: mat, code: `${sizeName}-${bn}`, ...(inner ? { inner, hold } : {}), ...(sew ? { sew } : {}), ...(lines.length ? { lines } : {}), ...(uses.some(u => u !== 'draw') ? { uses } : {}), ...(match.length ? { match } : {}), ...(notches.length ? { notches } : {}), ...(notchesDrawn.length ? { notchesDrawn } : {}), ...(drills.length ? { drills } : {}), ...(desc ? { desc } : {}), ...(tilt ? { tilt } : {}), ...(det.major ? { major: true } : {}), ...(fuse ? { fuse: true } : {}) });
        }
      }
    }
  }
  return out;
}

// ───────────────────────── direction rule ─────────────────────────

/** The way a part faces: its turn without the tilt (0, 90, 180 or 270). */
export function facing(rot: number): number { return ((Math.round(rot / 90) * 90) % 360 + 360) % 360; }
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
    if (!dir.has(g)) dir.set(g, groupMayTurn(parts, g, rule, rot180) && facing(q.rot) === 180 ? 180 : 0);
    if (facing(q.rot) === dir.get(g)) out[p.id] = q; else removed++;
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
export function throwParts(parts: MarkerPart[], pl: Placements, width: number, ids: string[], dir: Vec, o: { tol?: number; gap?: number; blocks?: MarkerBlock[] } = {}): Placements | null {
  if (o.blocks?.length) {
    // a fuse block travels and stops as one shape: its outline
    const v = blockView(parts, pl, o.blocks), vid = new Set(ids.map(id => v.of.get(id) ?? id));
    const res = throwParts(v.parts, v.pl, width, [...vid], dir, { tol: o.tol, gap: o.gap });
    if (!res) return null;
    const out: Placements = {};
    for (const id of vid) {
      const m = v.members.get(id);
      if (!m) { out[id] = res[id]; continue; }
      for (const q of m) out[q] = { ...pl[q], x: pl[q].x + res[id].x - v.pl[id].x, y: pl[q].y + res[id].y - v.pl[id].y };
    }
    return out;
  }
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
export function markerStats(parts: MarkerPart[], pl: Placements, width: number, blocks?: MarkerBlock[]): MarkerStats {
  let length = 0, used = 0, placed = 0, all = 0;
  for (const b of blocks ?? []) { const o = blockOutline(parts, pl, b); if (o) length = Math.max(length, polyBox(o).x1); }
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
export function markerProblems(parts: MarkerPart[], pl: Placements, width: number, tol = 0.6, blocks?: MarkerBlock[]): Set<string> {
  if (blocks?.length) {
    // a block is checked as one shape against the rest; its own parts are checked against each other
    const v = blockView(parts, pl, blocks), out = new Set<string>();
    for (const id of markerProblems(v.parts, v.pl, width, tol)) { const m = v.members.get(id); if (m) m.forEach(q => out.add(q)); else out.add(id); }
    for (const m of v.members.values()) { const set = new Set(m), sub: Placements = {}; for (const q of m) sub[q] = pl[q]; for (const id of markerProblems(parts.filter(p => set.has(p.id)), sub, Infinity, tol)) out.add(id); }
    return out;
  }
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

// ───────────────────────── fuse blocks ─────────────────────────

const hullOf = (pts: Vec[]): Vec[] => {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y); if (p.length < 3) return p;
  const cr = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Vec[] = [], up: Vec[] = [];
  for (const q of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
};
/**
 * The contour around shapes, `buffer` mm away from them: the shapes are drawn on a fine grid, grown by the buffer, holes are filled
 * and the outer edge is followed. Shapes too far apart to give one outline get their common hull instead.
 */
export function contourAround(polys: Vec[][], buffer: number, reach = 2): Vec[] {
  const all = polys.flat(), bb = polyBox(all);
  const hull = (): Vec[] => { const hq = hullOf(all); let g: Vec[] = []; try { g = offsetOutward(signedArea(hq) < 0 ? hq.reverse() : hq, Math.max(buffer, 1), 'miter'); } catch { g = []; } return g.length > 2 ? g : [{ x: bb.x0 - buffer, y: bb.y0 - buffer }, { x: bb.x1 + buffer, y: bb.y0 - buffer }, { x: bb.x1 + buffer, y: bb.y1 + buffer }, { x: bb.x0 - buffer, y: bb.y1 + buffer }]; };
  const span = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) + 2 * buffer;
  // without a buffer (married parts laid as one shape) the grid is finer and the outline is kept two cells outside, so that it never cuts into a part
  const tight = buffer <= 0, cell = tight ? Math.max(0.75, Math.sqrt((bb.x1 - bb.x0 + 8) * (bb.y1 - bb.y0 + 8) / 300000)) : Math.max(1, Math.min(5, span / 360)), pad = buffer + (reach + 2) * cell;
  const x0 = bb.x0 - pad, y0 = bb.y0 - pad, nx = Math.ceil((bb.x1 - bb.x0 + 2 * pad) / cell) + 1, ny = Math.ceil((bb.y1 - bb.y0 + 2 * pad) / cell) + 1;
  if (nx * ny > 400000) return hull();
  const g = new Uint8Array(nx * ny), at = (i: number, j: number) => j * nx + i;
  const ci = (x: number) => Math.max(0, Math.min(nx - 1, Math.floor((x - x0) / cell))), cj = (y: number) => Math.max(0, Math.min(ny - 1, Math.floor((y - y0) / cell)));
  for (const poly of polys) {
    for (let j = 0; j < ny; j++) {
      const y = y0 + (j + 0.5) * cell, xs: number[] = [];
      for (let k = 0; k < poly.length; k++) { const a = poly[k], b = poly[(k + 1) % poly.length]; if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x)); }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let i = ci(xs[k]); i <= ci(xs[k + 1]); i++) g[at(i, j)] = 1;
    }
    for (let k = 0; k < poly.length; k++) { // the outline itself, so that thin places are not lost
      const a = poly[k], b = poly[(k + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell * 0.5)));
      for (let t = 0; t <= n; t++) g[at(ci(a.x + (b.x - a.x) * t / n), cj(a.y + (b.y - a.y) * t / n))] = 1;
    }
  }
  // grow by the buffer (and one cell, so that the outline is never nearer than the buffer)
  const rr = tight ? reach : Math.ceil((buffer + cell) / cell), d = new Uint8Array(g);
  {
    const disk: [number, number][] = []; for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) if (di * di + dj * dj <= rr * rr) disk.push([di, dj]);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!g[at(i, j)]) continue;
      if (i > 0 && i < nx - 1 && j > 0 && j < ny - 1 && g[at(i - 1, j)] && g[at(i + 1, j)] && g[at(i, j - 1)] && g[at(i, j + 1)]) continue;
      for (const [di, dj] of disk) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < nx && b < ny) d[at(a, b)] = 1; }
    }
  }
  // outside = what can be reached from the border; everything else is the block (holes filled)
  const out = new Uint8Array(nx * ny), st: number[] = [];
  const seed = (i: number, j: number) => { const k = at(i, j); if (!d[k] && !out[k]) { out[k] = 1; st.push(k); } };
  for (let i = 0; i < nx; i++) { seed(i, 0); seed(i, ny - 1); } for (let j = 0; j < ny; j++) { seed(0, j); seed(nx - 1, j); }
  while (st.length) { const k = st.pop()!, i = k % nx, j = (k - i) / nx; if (i > 0) seed(i - 1, j); if (i < nx - 1) seed(i + 1, j); if (j > 0) seed(i, j - 1); if (j < ny - 1) seed(i, j + 1); }
  const inn = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && !out[at(i, j)];
  // cells that touch only by a corner would make the outline cross itself: fill the corner in
  for (let again = true, guard = 0; again && guard < 8; guard++) { again = false; for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = inn(i, j), b = inn(i + 1, j), c = inn(i, j + 1), e = inn(i + 1, j + 1); if ((a && e && !b && !c) || (b && c && !a && !e)) { out[at(i, j)] = out[at(i + 1, j)] = out[at(i, j + 1)] = out[at(i + 1, j + 1)] = 0; again = true; } } }
  // one piece? (4-connected)
  let first = -1, count = 0; for (let k = 0; k < out.length; k++) if (!out[k]) { count++; if (first < 0) first = k; }
  if (first < 0) return hull();
  const seen = new Uint8Array(nx * ny); let reached = 0; st.push(first); seen[first] = 1;
  while (st.length) { const k = st.pop()!, i = k % nx, j = (k - i) / nx; reached++; for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) if (inn(a, b) && !seen[at(a, b)]) { seen[at(a, b)] = 1; st.push(at(a, b)); } }
  if (reached !== count) return tight && reach < 40 ? contourAround(polys, buffer, reach * 2) : hull(); // parts a little apart: reach further before giving up
  // follow the edge: every side between the block and the outside is one step, the block on its left
  const next = new Map<number, number>(), vk = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!inn(i, j)) continue;
    if (!inn(i, j - 1)) next.set(vk(i, j), vk(i + 1, j));
    if (!inn(i + 1, j)) next.set(vk(i + 1, j), vk(i + 1, j + 1));
    if (!inn(i, j + 1)) next.set(vk(i + 1, j + 1), vk(i, j + 1));
    if (!inn(i - 1, j)) next.set(vk(i, j + 1), vk(i, j));
  }
  const start = next.keys().next().value as number, loop: Vec[] = [];
  for (let k = start, n = 0; n <= next.size; n++) { const i = k % (nx + 1), j = (k - i) / (nx + 1); loop.push({ x: x0 + i * cell, y: y0 + j * cell }); k = next.get(k)!; if (k === start || k === undefined) break; }
  if (loop.length < 4) return hull();
  const pts = simplifyClosed(loop, cell * 0.8);
  if (signedArea(pts) < 0) pts.reverse();
  return pts.length > 2 ? pts : hull();
}

const outlineCache = new Map<string, Vec[]>();
/** The outline of a fuse block where its parts lie now (null when none of them is laid). */
export function blockOutline(parts: MarkerPart[], pl: Placements, b: MarkerBlock): Vec[] | null {
  const set = new Set(b.ids), mem = parts.filter(p => set.has(p.id) && pl[p.id]); if (!mem.length) return null;
  const o = pl[mem[0].id], m = Math.max(0, b.buffer);
  if (b.shape === 'rect') {
    const bb = polyBox(mem.flatMap(p => cutOutline(p).map(q => placedPoint(pl[p.id], q))));
    return [{ x: bb.x0 - m, y: bb.y0 - m }, { x: bb.x1 + m, y: bb.y0 - m }, { x: bb.x1 + m, y: bb.y1 + m }, { x: bb.x0 - m, y: bb.y1 + m }];
  }
  // the contour is worked out once for a block and moved with it
  const key = [m, ...mem.map(p => [p.id, p.area.toFixed(1), pl[p.id].rot, (pl[p.id].x - o.x).toFixed(2), (pl[p.id].y - o.y).toFixed(2)].join(':'))].join('|');
  let loc = outlineCache.get(key);
  if (!loc) {
    loc = contourAround(mem.map(p => cutOutline(p).map(q => { const v = placedPoint(pl[p.id], q); return { x: v.x - o.x, y: v.y - o.y }; })), m);
    if (outlineCache.size > 300) outlineCache.clear();
    outlineCache.set(key, loc);
  }
  return loc.map(q => ({ x: q.x + o.x, y: q.y + o.y }));
}
/**
 * A fuse block as one stand-in part: its outline with the lower-left of its box at the origin, where that origin lies now (`at`),
 * and where its parts lie inside it (`local`). Laying the stand-in at a place lays the parts: local + that place.
 */
export function blockPart(id: string, parts: MarkerPart[], pl: Placements, b: MarkerBlock): { part: MarkerPart; at: Placement; local: Placements; ids: string[] } | null {
  const o = blockOutline(parts, pl, b); if (!o) return null;
  const set = new Set(b.ids), mem = parts.filter(p => set.has(p.id) && pl[p.id]), bb = polyBox(o);
  const poly = o.map(q => ({ x: q.x - bb.x0, y: q.y - bb.y0 })); if (signedArea(poly) < 0) poly.reverse();
  const local: Placements = {}; for (const p of mem) local[p.id] = { x: pl[p.id].x - bb.x0, y: pl[p.id].y - bb.y0, rot: pl[p.id].rot };
  const f = mem[0];
  const part: MarkerPart = { id, pieceId: id, name: 'Block', sizeId: f.sizeId, sizeName: f.sizeName, bundle: f.bundle, mirror: false, angles: [0], poly, grain: [{ x: 0, y: 0 }, { x: 1, y: 0 }], area: mem.reduce((a, p) => a + p.area, 0), material: f.material, hold: 'block', code: '' };
  return { part, at: { x: bb.x0, y: bb.y0, rot: 0 }, local, ids: mem.map(p => p.id) };
}
/** The marker with every fuse block replaced by its stand-in part (for throwing and checking). */
function blockView(parts: MarkerPart[], pl: Placements, blocks: MarkerBlock[]) {
  const of = new Map<string, string>(), members = new Map<string, string[]>(), vp: MarkerPart[] = [], vpl: Placements = { ...pl };
  blocks.forEach((b, k) => {
    const bp = blockPart('#b' + k, parts, pl, { ...b, ids: b.ids.filter(id => !of.has(id)) }); if (!bp) return;
    vp.push(bp.part); vpl[bp.part.id] = bp.at; members.set(bp.part.id, bp.ids);
    for (const id of bp.ids) { of.set(id, bp.part.id); delete vpl[id]; }
  });
  for (const p of parts) if (!of.has(p.id)) vp.push(p);
  return { parts: vp, pl: vpl, of, members };
}
/** Share parts out over `k` blocks, the biggest first, each to the block with the least in it so far. */
export function blockBins(parts: MarkerPart[], k: number): MarkerPart[][] {
  const bins: MarkerPart[][] = Array.from({ length: Math.max(1, Math.min(k, parts.length || 1)) }, () => []), load = bins.map(() => 0);
  for (const p of [...parts].sort((a, b) => b.area - a.area)) { let i = 0; for (let j = 1; j < bins.length; j++) if (load[j] < load[i]) i = j; bins[i].push(p); load[i] += p.area; }
  return bins.filter(b => b.length);
}
/** The room inside a fuse block for its parts (the limits less the margin on both sides), and the least number of blocks the parts need by area. */
export function blockRoom(set: BlockSet, fabricWidth: number, parts: MarkerPart[] = []) {
  const m = Math.max(0, set.buffer) + 1.5;
  const length = Math.max(1, set.maxLength - 2 * m), width = Math.max(1, Math.min(set.maxWidth, fabricWidth) - 2 * m);
  const area = parts.reduce((a, p) => a + p.area, 0);
  const tooBig = parts.find(p => p.angles.every(a => { const b = polyBox(p.poly.map(q => rotP(q, a))); return b.x1 - b.x0 > length || b.y1 - b.y0 > width; }));
  return { length, width, least: Math.max(1, Math.ceil(area / (length * width * 0.92))), tooBig };
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
    const t = p.tilt ?? 0, norm = (a: number) => +((((a % 360) + 360) % 360).toFixed(2));
    const angles = t > 0 ? [...new Set(p.angles.flatMap(a => [a, a + t / 2, a - t / 2, a + t, a - t].map(norm)))] : p.angles;
    const key = [p.pieceId, p.sizeId, p.mirror ? 1 : 0, angles.join(',')].join('|');
    let gi = byKey.get(key);
    if (gi === undefined) {
      gi = groups.length; byKey.set(key, gi); groups.push([]);
      const pts = simplifyClosed(p.poly, o.tol ?? 0.3).map(q => [+q.x.toFixed(3), +q.y.toFixed(3)]);
      items.push({ id: gi, demand: 0, orientation: { rotation: { mode: 'discrete', angles } }, shape: { type: 'simple_polygon', data: pts } });
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
    out[id] = { x: pi.transformation.translation[0], y: pi.transformation.translation[1], rot: +((((pi.transformation.rotation % 360) + 360) % 360).toFixed(2)) % 360 };
  }
  return { placements: out, length: s.strip_width };
}

// ───────────────────────── export ─────────────────────────

/** The outline that is cut for a part: its own outline (without the buffer around it). */
export function cutOutline(p: MarkerPart): Vec[] { return p.hold === 'buffer' && p.inner ? p.inner : p.poly; }
/** A small circle as a closed outline (drill holes). */
const circle = (c: Vec, r: number): Vec[] => Array.from({ length: 16 }, (_, i) => ({ x: c.x + Math.max(r, 0.5) * Math.cos(i * Math.PI / 8), y: c.y + Math.max(r, 0.5) * Math.sin(i * Math.PI / 8) }));
/** Total length cut on the marker: the cut outlines of every laid part, and the outlines of the fuse blocks (mm). */
export function markerPerimeter(parts: MarkerPart[], pl: Placements, blocks?: MarkerBlock[]): number {
  let L = 0;
  const add = (o: Vec[]) => { for (let i = 0; i < o.length; i++) { const a = o[i], b = o[(i + 1) % o.length]; L += Math.hypot(b.x - a.x, b.y - a.y); } };
  for (const p of parts) if (pl[p.id]) add(cutOutline(p));
  for (const b of blocks ?? []) { const o = blockOutline(parts, pl, b); if (o) add(o); }
  return L;
}
/** The text of a part as it is typed in the settings (built from the switches when nothing was typed). */
export function partTemplate(a: MarkerAnnot): string {
  return a.partText ?? [[a.style ? '{style}' : '', a.piece ? '{piece}' : '', a.size ? '{size}' : '', a.bundle ? '{bundle}' : ''].filter(Boolean).join(' '), a.desc ? '{desc}' : ''].filter(Boolean).join('\n');
}
/** The text at the marker as it is typed in the settings (built from the switches when nothing was typed). */
export function markerTemplate(a: MarkerAnnot): string {
  return a.markerText ?? [a.bName ? '{name}' : '', a.bRatio ? '{ratio}' : '', a.bLength ? 'L {length}' : '', a.bWidth ? 'W {width}' : '', a.bEff ? 'EFF {eff}' : '', a.bPerim ? 'PERIM {perim}' : ''].filter(Boolean).join('   ');
}
const fill = (tpl: string, v: Record<string, string>): string[] =>
  tpl.split(/\r?\n/).map(l => l.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k] : m)).replace(/[ \t]{4,}/g, '   ').trim()).filter(Boolean);
/** A length written in the unit of the annotation. */
export function annotLength(mm: number, unit: AnnotUnit = 'mm'): string {
  return unit === 'cm' ? `${(mm / 10).toFixed(1)} cm` : unit === 'm' ? `${(mm / 1000).toFixed(3)} m` : unit === 'in' ? `${(mm / 25.4).toFixed(2)} in` : unit === 'yd' ? `${(mm / 914.4).toFixed(3)} yd` : `${mm.toFixed(0)} mm`;
}
/**
 * What happens to an internal line of a part on the marker: a line set to Cut is cut; a match line is drawn; a plain (Draw) line
 * follows the annotation setting (drawn, cut, or left out — null).
 */
export function lineWay(p: MarkerPart, i: number, a: MarkerAnnot): 'draw' | 'cut' | 'match' | null {
  const u = p.uses?.[i] ?? 'draw';
  if (u === 'cut') return 'cut';
  if (u !== 'draw') return a.internals === 'none' ? null : 'match';
  return a.internals === 'none' ? null : a.internals;
}
/** The lines written on a part, by the annotation settings. */
export function partLabel(p: MarkerPart, a: MarkerAnnot, styleName = ''): string[] {
  return fill(partTemplate(a), { style: styleName, piece: p.name + (p.mirror ? ' (M)' : ''), size: p.sizeName, bundle: p.code, no: String(p.bundle), desc: p.desc ?? '', material: p.material });
}
export interface MarkerOut { annot?: Partial<MarkerAnnot>; name?: string; ratio?: string; styleName?: string; blocks?: MarkerBlock[]; plies?: number; material?: string }
/** The lines written at the marker, by the annotation settings. */
export function borderLines(parts: MarkerPart[], pl: Placements, width: number, a: MarkerAnnot, o: MarkerOut = {}): string[] {
  const st = markerStats(parts, pl, width, o.blocks), u = a.unit ?? 'mm', per = markerPerimeter(parts, pl, o.blocks);
  // an empty name or ratio leaves no gap behind
  return fill(markerTemplate(a), { name: o.name ?? '', ratio: o.ratio ?? '', length: annotLength(st.length, u), width: annotLength(width, u), eff: `${(st.efficiency * 100).toFixed(2)}%`,
    perim: u === 'in' || u === 'yd' ? `${(per / 914.4).toFixed(2)} yd` : `${(per / 1000).toFixed(2)} m`, style: o.styleName ?? '', material: o.material ?? '', plies: o.plies != null ? String(o.plies) : '', parts: `${st.placed}/${st.parts}` });
}
/** The facts written at the marker border as one line. */
export function borderText(parts: MarkerPart[], pl: Placements, width: number, a: MarkerAnnot, o: MarkerOut = {}): string { return borderLines(parts, pl, width, a, o).join('   '); }
/**
 * Where the lines of the marker text go (marker frame, y running down the width): the start of every line, and `up` when the text is
 * written upward (before the start or after the end of the marker) instead of along it.
 */
export function borderLayout(a: MarkerAnnot, n: number, length: number, width: number): { at: Vec[]; up: boolean; h: number } {
  const h = a.bTextH ?? 12, lh = h * 1.4, place = a.place ?? 'top', at: Vec[] = [];
  for (let i = 0; i < n; i++) at.push(place === 'bottom' ? { x: 0, y: width + 4 + h + i * lh } : place === 'start' ? { x: -4 - (n - 1 - i) * lh, y: width } : place === 'end' ? { x: length + 4 + h + i * lh, y: width } : { x: 0, y: -4 - (n - 1 - i) * lh });
  return { at, up: place === 'start' || place === 'end', h };
}

/**
 * Marker as DXF (R12, mm, y up as on a plotter). Layers: FABRIC (border), CUT (outlines to cut), BLOCK (fuse blocks), SEAM (sew
 * lines), INTERNAL / INTCUT (internal lines drawn / cut), GRAIN, TEXT. What is written follows the annotation settings.
 */
export function markerDXF(parts: MarkerPart[], pl: Placements, width: number, name = 'MARKER', o: MarkerOut = {}): string {
  const a = { ...DEFAULT_ANNOT, ...(o.annot ?? {}) }, st = markerStats(parts, pl, width, o.blocks);
  const Y = (v: Vec): Vec => ({ x: v.x, y: width - v.y });
  const L: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES'];
  const poly = (pts: Vec[], layer: string, closed: boolean) => {
    L.push(0, 'POLYLINE', 8, layer, 66, 1, 70, closed ? 1 : 0);
    for (const q of pts.map(Y)) L.push(0, 'VERTEX', 8, layer, 10, q.x.toFixed(3), 20, q.y.toFixed(3));
    L.push(0, 'SEQEND');
  };
  const text = (at: Vec, hgt: number, t: string, up = false) => { const q = Y(at); L.push(0, 'TEXT', 8, 'TEXT', 10, q.x.toFixed(3), 20, q.y.toFixed(3), 40, hgt, 1, t, ...(up ? [50, 90] : [])); };
  if (a.border) poly([{ x: 0, y: 0 }, { x: st.length, y: 0 }, { x: st.length, y: width }, { x: 0, y: width }], 'FABRIC', true);
  for (const b of o.blocks ?? []) { const bo = blockOutline(parts, pl, b); if (bo) poly(bo, 'BLOCK', true); }
  const th = a.textH ?? 8;
  for (const p of parts) {
    const q = pl[p.id]; if (!q) continue;
    const at = (v: Vec) => placedPoint(q, v), b = polyBox(placedPoly(p, q));
    poly(cutOutline(p).map(at), 'CUT', true);
    if (a.seam && p.sew) poly(p.sew.map(at), 'SEAM', true);
    (p.lines ?? []).forEach((ln, i) => { const w = lineWay(p, i, a); if (w) poly(ln.map(at), w === 'cut' ? 'INTCUT' : w === 'match' ? 'MATCH' : 'INTERNAL', false); });
    for (const n of p.notches ?? []) poly(n.map(at), 'NOTCH', false);
    for (const n of p.notchesDrawn ?? []) poly(n.map(at), 'NOTCHDRAW', false);
    for (const dr of p.drills ?? []) poly(circle(at(dr.at), dr.d / 2), dr.cut ? 'DRILL' : 'DRILLDRAW', true);
    if (a.grain) poly([at(p.grain[0]), at(p.grain[1])], 'GRAIN', false);
    partLabel(p, a, o.styleName).forEach((t, i) => text({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 + i * th * 1.4 }, th, t));
  }
  if (a.border) {
    const bl = borderLines(parts, pl, width, a, { ...o, name: o.name ?? name }), lay = borderLayout(a, bl.length, st.length, width);
    bl.forEach((t, i) => text(lay.at[i], lay.h, t, lay.up));
  }
  L.push(0, 'ENDSEC', 0, 'EOF');
  return L.join('\n') + '\n';
}
/**
 * Marker as a plot file (HPGL / .plt, 40 units per mm, y up). Pen 1 cuts: the outline of every laid part, the fuse blocks, and the
 * internal lines when they are set to cut. Pen 2 draws: seam lines, drawn internal lines, grain lines, the text on the parts, the
 * marker border and its text, as far as the annotation settings ask for them. Text below or before the marker moves the whole
 * plot up or along, so that nothing has a negative place.
 */
export function markerHPGL(parts: MarkerPart[], pl: Placements, width = 0, o: MarkerOut = {}): string {
  const a = { ...DEFAULT_ANNOT, ...(o.annot ?? {}) };
  const st = markerStats(parts, pl, width || 1, o.blocks);
  const H = width || parts.reduce((m, p) => { const q = pl[p.id]; return q ? Math.max(m, polyBox(placedPoly(p, q)).y1) : m; }, 0);
  const bl = a.border && width ? borderLines(parts, pl, width, a, o) : [], lay = borderLayout(a, bl.length, st.length, width);
  const ox = bl.length ? Math.max(0, -Math.min(...lay.at.map(v => v.x)) + (lay.up ? lay.h : 0)) : 0, oy = bl.length ? Math.max(0, Math.max(...lay.at.map(v => v.y)) - H + 2) : 0;
  const u = (v: number) => Math.round(v * 40), Y = (v: Vec): Vec => ({ x: v.x + ox, y: H - v.y + oy });
  const path = (pts: Vec[], closed: boolean) => { const q = pts.map(Y); return [`PU${u(q[0].x)},${u(q[0].y)};`, 'PD' + [...q.slice(1), ...(closed ? [q[0]] : [])].map(v => `${u(v.x)},${u(v.y)}`).join(',') + ';']; };
  const label = (at: Vec, mm: number, t: string, up = false) => { const q = Y(at); return [`PU${u(q.x)},${u(q.y)};`, up ? 'DI0,1;' : 'DI1,0;', `SI${(mm * 0.07).toFixed(3)},${(mm * 0.1).toFixed(3)};`, `LB${t.replace(/[\x00-\x1f;]/g, ' ')}\x03`]; };
  const cut: string[] = [], draw: string[] = [];
  for (const b of o.blocks ?? []) { const bo = blockOutline(parts, pl, b); if (bo) cut.push(...path(bo, true)); }
  const th = a.textH ?? 6;
  for (const p of parts) {
    const q = pl[p.id]; if (!q) continue;
    const at = (v: Vec) => placedPoint(q, v), b = polyBox(placedPoly(p, q));
    cut.push(...path(cutOutline(p).map(at), true));
    (p.lines ?? []).forEach((ln, i) => { const w = lineWay(p, i, a); if (w) (w === 'cut' ? cut : draw).push(...path(ln.map(at), false)); });
    if (a.seam && p.sew) draw.push(...path(p.sew.map(at), true));
    for (const n of p.notches ?? []) cut.push(...path(n.map(at), false));
    for (const n of p.notchesDrawn ?? []) draw.push(...path(n.map(at), false));
    for (const dr of p.drills ?? []) (dr.cut ? cut : draw).push(...path(circle(at(dr.at), dr.d / 2), true));
    if (a.grain) draw.push(...path([at(p.grain[0]), at(p.grain[1])], false));
    partLabel(p, a, o.styleName).forEach((t, i) => draw.push(...label({ x: b.x0 + (b.x1 - b.x0) * 0.25, y: (b.y0 + b.y1) / 2 + th + i * th * 1.5 }, th, t)));
  }
  if (a.border && width) {
    draw.push(...path([{ x: 0, y: 0 }, { x: st.length, y: 0 }, { x: st.length, y: width }, { x: 0, y: width }], true));
    bl.forEach((t, i) => draw.push(...label(lay.at[i], a.bTextH ?? 9, t, lay.up)));
  }
  return ['IN;', 'SP1;', ...cut, ...(draw.length ? ['SP2;', ...draw] : []), 'PU0,0;', 'SP0;'].join('\n') + '\n';
}

// ───────────────────────── stripe and plaid matching ─────────────────────────

/** Where the match lines of a laid part lie: 'x' = the line runs across the width and has a place along the fabric (stripe), 'y' = along the length (plaid). */
export function matchAt(p: MarkerPart, pl: Placement): { code: string; axis: 'x' | 'y'; v: number }[] {
  return (p.match ?? []).map(m => { const d = rotP(m.dir, pl.rot), q = placedPoint(pl, m.mid), axis = Math.abs(d.y) >= Math.abs(d.x) ? 'x' as const : 'y' as const; return { code: m.code, axis, v: axis === 'x' ? q.x : q.y }; });
}
const repeatOf = (f: FabricMatch, axis: 'x' | 'y') => (axis === 'x' ? { d: Math.max(0, f.stripe ?? 0), first: f.stripe1 ?? 0 } : { d: Math.max(0, f.plaid ?? 0), first: f.plaid1 ?? 0 });
/** Is any repeat set, and does any part have a match line? */
export function matchActive(parts: MarkerPart[], f: FabricMatch | undefined): boolean { return !!f && ((f.stripe ?? 0) > 0 || (f.plaid ?? 0) > 0) && parts.some(p => p.match?.length); }
/**
 * How far every laid part with a match line is from its match (the shift that would put it right; 0 0 = matched).
 * M lines go onto the bars of the fabric. P lines of the same code in a bundle go onto the same place of the repeat: the first
 * laid part of the bundle that carries the code is where the others follow (after its own M match).
 * `way` (optional): only shift this way along each axis (+1 / −1) instead of to the nearest place — used after a throw, to step
 * back along the path. `only`: work out these parts only (the others count as they lie).
 */
export function matchShifts(parts: MarkerPart[], pl: Placements, f: FabricMatch | undefined, o: { way?: { x?: number; y?: number }; only?: Set<string> } = {}): Map<string, Vec> {
  const out = new Map<string, Vec>(); if (!f) return out;
  const need = (v: number, target: number, d: number, way = 0) => { let r = (((target - v) % d) + d) % d; if (r < 1e-7 || d - r < 1e-7) r = 0; return way > 0 ? r : way < 0 ? (r ? r - d : 0) : r > d / 2 ? r - d : r; };
  const laid = parts.filter(p => pl[p.id] && p.match?.length).map(p => ({ p, m: matchAt(p, pl[p.id]) }));
  const done = new Set<string>(); // part|axis settled
  for (const { p, m } of laid) for (const axis of ['x', 'y'] as const) {
    const rp = repeatOf(f, axis); if (!rp.d) continue;
    const l = m.find(x => x.axis === axis && x.code[0] === 'M'); if (!l) continue;
    done.add(p.id + axis);
    if (o.only && !o.only.has(p.id)) continue;
    const s = out.get(p.id) ?? { x: 0, y: 0 }; s[axis] = need(l.v, rp.first, rp.d, o.way?.[axis]); out.set(p.id, s);
  }
  const lead = new Map<string, number>(); // code|axis|bundle → where the first part's line lies (after its own shift)
  for (const { p, m } of laid) for (const axis of ['x', 'y'] as const) {
    const rp = repeatOf(f, axis); if (!rp.d) continue;
    for (const l of m) {
      if (l.axis !== axis || l.code[0] !== 'P') continue;
      const key = [l.code, axis, p.sizeId, p.bundle].join('|');
      if (!lead.has(key)) { lead.set(key, l.v + (out.get(p.id)?.[axis] ?? 0)); if (!out.has(p.id)) out.set(p.id, { x: 0, y: 0 }); done.add(p.id + axis); continue; } // the first part leads: it is not moved for a P line
      if (done.has(p.id + axis)) continue; // already bound on this axis (an M line, or another P line)
      done.add(p.id + axis);
      if (o.only && !o.only.has(p.id)) continue;
      const s = out.get(p.id) ?? { x: 0, y: 0 }; s[axis] = need(l.v, lead.get(key)!, rp.d, o.way?.[axis]); out.set(p.id, s);
    }
  }
  return out;
}
/** Laid parts that are off their match by more than `tol` mm. */
export function markerMismatch(parts: MarkerPart[], pl: Placements, f: FabricMatch | undefined, tol = 1): Set<string> {
  const bad = new Set<string>();
  for (const [id, s] of matchShifts(parts, pl, f)) if (Math.abs(s.x) > tol || Math.abs(s.y) > tol) bad.add(id);
  return bad;
}
/** A shape swept by `sx` along x and `sy` along y (every row and column filled): the room a part needs to be slid that far. */
export function sweepPoly(poly: Vec[], sx: number, sy: number): Vec[] {
  const along = (pts: Vec[], s: number): Vec[] => {
    const b = polyBox(pts), ys = new Set<number>(pts.map(q => q.y));
    for (let y = b.y0; y < b.y1; y += 3) ys.add(y);
    const rows = [...ys].sort((p, q) => p - q), L: Vec[] = [], R: Vec[] = [];
    for (const y of rows) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], c = pts[(i + 1) % pts.length];
        if (y < Math.min(a.y, c.y) - 1e-9 || y > Math.max(a.y, c.y) + 1e-9) continue;
        for (const x of Math.abs(c.y - a.y) < 1e-9 ? [a.x, c.x] : [a.x + (y - a.y) / (c.y - a.y) * (c.x - a.x)]) { if (x < lo) lo = x; if (x > hi) hi = x; }
      }
      if (lo <= hi) { L.push({ x: lo, y }); R.push({ x: hi + s, y }); }
    }
    return [...R, ...L.reverse()];
  };
  const sw = (q: Vec): Vec => ({ x: q.y, y: q.x });
  let p = poly;
  if (sx > 0) p = along(p, sx);
  if (sy > 0) p = along(p.map(sw), sy).map(sw);
  p = p.filter((q, i) => { const n = p[(i + 1) % p.length]; return Math.hypot(q.x - n.x, q.y - n.y) > 1e-6; });
  if (signedArea(p) < 0) p.reverse();
  return p;
}
/**
 * Nesting with match lines: which parts need room to be slid onto their match afterwards, and how much (a whole repeat). A part
 * with an M line needs it; of the parts of a bundle that share a P code, all but the first do. Only `free` parts are planned
 * (not the parts of blocks or married groups).
 */
export function matchPlan(parts: MarkerPart[], f: FabricMatch | undefined, free?: Set<string>): Map<string, { sx: number; sy: number }> {
  const out = new Map<string, { sx: number; sy: number }>(); if (!f) return out;
  const lead = new Set<string>();
  for (const p of parts) {
    if (!p.match?.length) continue;
    const m = matchAt(p, { x: 0, y: 0, rot: 0 }), mine = { sx: 0, sy: 0 };
    for (const axis of ['x', 'y'] as const) {
      const d = repeatOf(f, axis).d; if (!d) continue;
      let bound = m.some(l => l.axis === axis && l.code[0] === 'M');
      for (const l of m) { if (l.axis !== axis || l.code[0] !== 'P') continue; const key = [l.code, axis, p.sizeId, p.bundle].join('|'); if (lead.has(key)) bound = true; else lead.add(key); }
      if (bound) mine[axis === 'x' ? 'sx' : 'sy'] = d;
    }
    if ((mine.sx || mine.sy) && (!free || free.has(p.id))) out.set(p.id, mine);
  }
  return out;
}
/** The part as the nester lays it when it must be slid onto its match afterwards: its outline swept by the repeat; it keeps its direction (0° / 180°). */
export function sweptPart(p: MarkerPart, sw: { sx: number; sy: number }): MarkerPart {
  const angles = p.angles.filter(a => a % 180 === 0);
  const { tilt: _t, ...rest } = p; void _t;
  return { ...rest, pieceId: `${p.pieceId}~${sw.sx}~${sw.sy}`, poly: sweepPoly(p.poly, sw.sx, sw.sy), angles: angles.length ? angles : [0] };
}
/**
 * After nesting with swept parts: every planned part is slid inside its room onto its match (M lines first, then the P lines after
 * the first part of their bundle). Returns the placements with those parts moved.
 */
export function settleMatch(parts: MarkerPart[], pl: Placements, f: FabricMatch | undefined, plan: Map<string, { sx: number; sy: number }>): Placements {
  const out: Placements = { ...pl }; if (!f || !plan.size) return out;
  // a part laid at 0° slides forward in its room, one laid at 180° backward
  const settle = (ids: Set<string>) => {
    for (const id of ids) {
      const p = parts.find(q => q.id === id), q = out[id]; if (!p || !q) continue;
      const sign = facing(q.rot) === 180 ? -1 : 1, sw = plan.get(id)!;
      const s = matchShifts(parts, out, f, { way: { x: sign, y: sign }, only: new Set([id]) }).get(id); if (!s) continue;
      out[id] = { ...q, x: q.x + (sw.sx ? s.x : 0), y: q.y + (sw.sy ? s.y : 0) };
    }
  };
  const ids = [...plan.keys()].filter(id => out[id]);
  settle(new Set(ids.filter(id => parts.find(p => p.id === id)?.match?.some(m => m.code[0] === 'M'))));
  settle(new Set(ids));
  return out;
}

// ───────────────────────── shade zones ─────────────────────────

/** Where the major parts of every bundle lie: their box, and the row they belong to (the row that holds their middle). */
export function shadeBundles(parts: MarkerPart[], pl: Placements, width: number, sh: ShadeSet): { key: string; ids: string[]; box: { x0: number; y0: number; x1: number; y1: number }; row: number }[] {
  const rows = Math.max(1, Math.floor(sh.rows)), h = width / rows, by = new Map<string, { ids: string[]; pts: Vec[] }>();
  for (const p of parts) {
    if (!p.major || !pl[p.id]) continue;
    const key = p.sizeId + '|' + p.bundle, g = by.get(key) ?? { ids: [], pts: [] };
    g.ids.push(p.id); g.pts.push(...cutOutline(p).map(q => placedPoint(pl[p.id], q))); by.set(key, g);
  }
  return [...by].map(([key, g]) => { const box = polyBox(g.pts); return { key, ids: g.ids, box, row: Math.max(0, Math.min(rows - 1, Math.floor((box.y0 + box.y1) / 2 / h))) }; });
}
/**
 * Major parts that break the shade zones: a bundle whose major parts do not lie within one row (plus the row overlap), are spread
 * over more than one column length (plus the overlap), or — columns by bundle end — share more of their length with another
 * bundle of the row than the overlap allows. Returns the ids of the major parts of those bundles.
 */
export function shadeProblems(parts: MarkerPart[], pl: Placements, width: number, sh: ShadeSet | undefined, tol = 1): Set<string> {
  const bad = new Set<string>(); if (!sh || !(sh.rows >= 1)) return bad;
  const rows = Math.max(1, Math.floor(sh.rows)), h = width / rows, ro = Math.max(0, sh.rowOverlap) / 100 * h, co = Math.max(0, sh.colOverlap) / 100;
  const B = shadeBundles(parts, pl, width, sh), flag = (b: { ids: string[] }) => b.ids.forEach(id => bad.add(id));
  for (const b of B) {
    if (b.box.y0 < b.row * h - ro - tol || b.box.y1 > (b.row + 1) * h + ro + tol) flag(b);
    if (sh.colBy === 'length' && sh.colLength > 0 && b.box.x1 - b.box.x0 > sh.colLength * (1 + 2 * co) + tol) flag(b);
  }
  if (sh.colBy === 'bundle') for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
    const a = B[i], b = B[j]; if (a.row !== b.row) continue;
    const share = Math.min(a.box.x1, b.box.x1) - Math.max(a.box.x0, b.box.x0);
    if (share > co * Math.max(a.box.x1 - a.box.x0, b.box.x1 - b.box.x0) + tol) { flag(a); flag(b); }
  }
  return bad;
}
/**
 * One shape around laid parts for the nester: at every place along the length it reaches from the lowest to the highest part
 * (exact at the outline, nothing is cut off). With a `spine` the stretch from spine.x0 to spine.x1 reaches from spine.y0 to spine.y1,
 * so that no other shape of that height can lie beside it there.
 */
export function columnHull(polys: Vec[][], spine?: { x0: number; x1: number; y0: number; y1: number }): Vec[] {
  const all = polys.flat(), b = polyBox(all), xs = new Set<number>(all.map(q => q.x));
  for (let x = b.x0; x < b.x1; x += 3) xs.add(x);
  if (spine) { xs.add(spine.x0); xs.add(spine.x1); }
  const cols = [...xs].filter(x => x >= b.x0 - 1e-9 && x <= b.x1 + 1e-9).sort((p, q) => p - q), lo: Vec[] = [], hi: Vec[] = [];
  let last = (b.y0 + b.y1) / 2;
  for (const x of cols) {
    let l = Infinity, u = -Infinity;
    for (const pts of polys) for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      if (x < Math.min(a.x, c.x) - 1e-9 || x > Math.max(a.x, c.x) + 1e-9) continue;
      for (const y of Math.abs(c.x - a.x) < 1e-9 ? [a.y, c.y] : [a.y + (x - a.x) / (c.x - a.x) * (c.y - a.y)]) { if (y < l) l = y; if (y > u) u = y; }
    }
    if (l > u) { l = last - 0.5; u = last + 0.5; } // a gap between the parts: a thin bridge keeps the shape in one piece
    if (spine && x >= spine.x0 - 1e-9 && x <= spine.x1 + 1e-9) { l = Math.min(l, spine.y0); u = Math.max(u, spine.y1); }
    last = (l + u) / 2; lo.push({ x, y: l }); hi.push({ x, y: u });
  }
  let out = [...lo, ...hi.reverse()];
  out = out.filter((q, i) => { const n = out[(i + 1) % out.length]; return Math.hypot(q.x - n.x, q.y - n.y) > 1e-6; });
  if (signedArea(out) < 0) out.reverse();
  return out;
}

/**
 * Lay parts into the room that fixed shapes leave on the fabric, as far towards the start as they go (then towards the first
 * edge): the fabric is a grid of small cells, every shape takes the cells it touches (plus the gap), and each part goes to the
 * first place where all its cells are free. The biggest parts go first. Nothing overlaps, because shapes never share a cell.
 */
export function fillAround(fixed: Vec[][], items: MarkerPart[], width: number, o: { gap?: number; cell?: number } = {}): Placements {
  const out: Placements = {}; if (!items.length) return out;
  const gap = Math.max(0, o.gap ?? 0);
  const fx = fixed.length ? Math.max(...fixed.map(q => polyBox(q).x1)) : 0;
  const room = fx + items.reduce((a, p) => { const b = polyBox(p.poly); return a + Math.max(b.x1 - b.x0, b.y1 - b.y0) + gap; }, 0) + 50;
  const c = o.cell ?? Math.max(3, Math.sqrt(room * width / 500000)), nx = Math.ceil(room / c) + 2, ny = Math.floor(width / c + 1e-9);
  if (ny < 1) return out;
  const g = Math.ceil(gap / c - 1e-9);
  const occ = new Uint8Array(nx * ny), pre = new Int32Array((nx + 1) * ny);
  /** the cells a shape touches, row by row: [first, last] (null = none) */
  const rows = (poly: Vec[], y0: number, n: number): ([number, number] | null)[] => {
    const res: ([number, number] | null)[] = [];
    for (let k = 0; k < n; k++) {
      const lo = y0 + k * c, hi = lo + c; let a = Infinity, b = -Infinity;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        if (Math.max(p.y, q.y) < lo || Math.min(p.y, q.y) > hi) continue;
        for (const v of [p, q]) if (v.y >= lo && v.y <= hi) { if (v.x < a) a = v.x; if (v.x > b) b = v.x; }
        if (Math.abs(q.y - p.y) > 1e-12) for (const yy of [lo, hi]) { const t = (yy - p.y) / (q.y - p.y); if (t >= 0 && t <= 1) { const x = p.x + t * (q.x - p.x); if (x < a) a = x; if (x > b) b = x; } }
      }
      res.push(a <= b ? [Math.floor(a / c + 1e-7), Math.max(Math.floor(a / c + 1e-7), Math.ceil(b / c - 1e-7) - 1)] : null);
    }
    return res;
  };
  const mark = (rs: ([number, number] | null)[], i0: number, j0: number) => {
    for (let k = 0; k < rs.length; k++) { const r = rs[k]; if (!r) continue; for (let j = Math.max(0, j0 + k - g); j <= Math.min(ny - 1, j0 + k + g); j++) for (let i = Math.max(0, i0 + r[0] - g); i <= Math.min(nx - 1, i0 + r[1] + g); i++) occ[j * nx + i] = 1; }
    for (let j = Math.max(0, j0 - g); j <= Math.min(ny - 1, j0 + rs.length - 1 + g); j++) { let acc = 0; const b0 = j * (nx + 1); pre[b0] = 0; for (let i = 0; i < nx; i++) { acc += occ[j * nx + i]; pre[b0 + i + 1] = acc; } }
  };
  for (const q of fixed) mark(rows(q, 0, ny), 0, 0);
  const hint = new Map<string, number>();
  for (const p of [...items].sort((a, b) => b.area - a.area)) {
    let best: { i: number; j: number; rot: number; rs: ([number, number] | null)[] } | null = null;
    for (const rot of p.angles) {
      const base = placeAt(p, 0, 0, rot), poly = placedPoly(p, base), bb = polyBox(poly), n = Math.ceil((bb.y1 - 1e-7) / c), w = Math.ceil((bb.x1 - 1e-7) / c);
      if (n > ny || n < 1) continue;
      const rs = rows(poly, 0, n), key = [p.pieceId, p.sizeId, p.mirror ? 1 : 0, rot].join('|');
      const order = [0, n - 1, n >> 1, ...Array.from({ length: n }, (_, k) => k)];
      let found = -1, fj = 0;
      for (let i = hint.get(key) ?? 0; i + w <= nx && found < 0 && (!best || i < best.i); i++) for (let j = 0; j + n <= ny; j++) {
        let ok = true;
        for (const k of order) { const r = rs[k]; if (!r) continue; const b0 = (j + k) * (nx + 1); if (pre[b0 + i + r[1] + 1] - pre[b0 + i + r[0]] > 0) { ok = false; break; } }
        if (ok) { found = i; fj = j; break; }
      }
      if (found >= 0) { hint.set(key, found); if (!best || found < best.i) best = { i: found, j: fj, rot, rs }; }
    }
    if (!best) continue;
    out[p.id] = placeAt(p, best.i * c, best.j * c, best.rot);
    mark(best.rs, best.i, best.j);
  }
  return out;
}
