/**
 * PLT / HPGL import and export.
 *
 * Plotter units: 0.025 mm (40 units per mm) by default; the device profile can change it.
 * HPGL's frame is y-up like the kernel, so coordinates are kept INTACT (yFlipped = false).
 *
 * Import: PU/PD/PA/PR/IN/SP/LB/CI/AA/AR/PE are understood. Closed pen-down runs become contours; a
 * closed run inside another is a sew line (if parallel) or an internal; open runs are internals.
 * Notches are detected as (a) short separate strokes starting on a contour, or (b) "spikes" baked
 * into a contour (out-and-back excursion of ≤ maxNotchDepth), which are removed from the outline.
 */
import type { Vec } from '../geom/vec';
import { dist, sub, add, mul, norm, perp, bbox } from '../geom/vec';
import { area, pointInPolygon, distToPolygon } from '../geom/poly';
import { makeSizeLine, makeSizeTable } from '../model/factory';
import type { Document } from '../model/doc';
import type { Id, Piece, SizeId } from '../model/types';
import {
  type ImportReport, type RawGroup, type RawVertex,
  emptyGroup, buildPiece, sampleArc, hostIndex, nearestIndex, looksLikeSewOf,
  drawPiece, drawingBox, translateDrawing, shelfPack,
} from './common';

export interface PlotterProfile {
  /** plotter units per mm (HP-GL standard 40) */
  unitsPerMm: number;
  /** paper / fabric width in mm (y extent); content is shifted to start at y = 0 within it */
  frameWidth?: number;
  /** how notches are written: 'line' = separate PU/PD stroke; 'spike' = out-and-back inside the cut path; 'none' */
  notchCode?: 'line' | 'spike' | 'none';
  /** pen numbers per role */
  pens?: { cut?: number; sew?: number; internal?: number; notch?: number; grain?: number; text?: number; drill?: number };
  /** label font height in mm (SI command); default 5 */
  textHeight?: number;
  /** write sew lines (default true) */
  sew?: boolean;
  /** decimals in coordinates (default 0 = integers, the common plotter format) */
  decimals?: number;
}

export const DEFAULT_PROFILE: Required<Omit<PlotterProfile, 'frameWidth'>> & { frameWidth?: number } = {
  unitsPerMm: 40, notchCode: 'line', textHeight: 5, sew: true, decimals: 0,
  pens: { cut: 1, sew: 2, internal: 3, notch: 1, grain: 4, text: 5, drill: 6 },
};

// ═════════════════════════════ parser ═════════════════════════════

export interface HpglStroke { pts: Vec[]; pen: number }
export interface HpglLabel { p: Vec; text: string; pen: number; h?: number }

/** Tokenise HPGL into strokes (plotter units). */
export function parseHPGL(text: string, notes?: Set<string>): { strokes: HpglStroke[]; labels: HpglLabel[] } {
  const strokes: HpglStroke[] = []; const labels: HpglLabel[] = [];
  let cur: Vec = { x: 0, y: 0 }, down = false, rel = false, pen = 1, path: Vec[] | null = null;
  let term = '\x03';
  let charH: number | undefined;
  const end = () => { if (path && path.length > 1) strokes.push({ pts: path, pen }); path = null; };
  const moveTo = (p: Vec) => { cur = p; if (down) { if (!path) path = [{ ...cur }]; else path.push({ ...cur }); } };
  let i = 0; const s = text;
  while (i < s.length) {
    const c = s[i];
    if (!/[A-Za-z]/.test(c)) { i++; continue; }
    if (i + 1 >= s.length || !/[A-Za-z]/.test(s[i + 1])) { i++; continue; }
    const cmd = (c + s[i + 1]).toUpperCase(); i += 2;
    if (cmd === 'LB') {
      let j = s.indexOf(term, i); if (j < 0) j = s.length;
      labels.push({ p: { ...cur }, text: s.slice(i, j), pen, h: charH });
      i = j + 1; continue;
    }
    if (cmd === 'DT') { term = s[i] && s[i] !== ';' ? s[i] : '\x03'; i++; continue; }
    if (cmd === 'PE') { // polyline encoded: decode to strokes
      let j = s.indexOf(';', i); if (j < 0) j = s.length;
      const r = decodePE(s.slice(i, j), cur, down);
      for (const st of r.strokes) { end(); strokes.push({ pts: st, pen }); }
      cur = r.cur; i = j + 1; continue;
    }
    let j = i; while (j < s.length && !/[A-Za-z;]/.test(s[j])) j++;
    const nums = (s.slice(i, j).match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    i = j; if (s[i] === ';') i++;
    const pairs: Vec[] = []; for (let k = 0; k + 1 < nums.length; k += 2) pairs.push({ x: nums[k], y: nums[k + 1] });
    const P = (p: Vec) => (rel ? { x: cur.x + p.x, y: cur.y + p.y } : p);
    switch (cmd) {
      case 'IN': case 'DF': end(); down = false; rel = false; cur = { x: 0, y: 0 }; break;
      case 'PA': rel = false; pairs.forEach(p => moveTo(P(p))); break;
      case 'PR': rel = true; pairs.forEach(p => moveTo(P(p))); break;
      case 'PU': end(); down = false; pairs.forEach(p => moveTo(P(p))); break;
      case 'PD': if (!down) { down = true; path = [{ ...cur }]; } pairs.forEach(p => moveTo(P(p))); break;
      case 'SP': end(); if (down) path = [{ ...cur }]; pen = nums[0] ?? 0; break;
      case 'SI': if (nums.length >= 2) charH = nums[1] * 10; break; // cm → mm
      case 'CI': {
        const r = nums[0] ?? 0; if (r <= 0) break;
        const wasDown = down; end();
        const pts = sampleArc(cur, r, 0, Math.PI * 2, 1);
        strokes.push({ pts, pen }); if (wasDown) path = [{ ...cur }];
        notes?.add('CI circles sampled');
        break;
      }
      case 'AA': case 'AR': {
        if (nums.length < 3) break;
        const c = cmd === 'AA' ? { x: nums[0], y: nums[1] } : { x: cur.x + nums[0], y: cur.y + nums[1] };
        const sweep = nums[2] * Math.PI / 180;
        const r = dist(cur, c), a0 = Math.atan2(cur.y - c.y, cur.x - c.x);
        const pts = sampleArc(c, r, a0, sweep, 1);
        for (const q of pts.slice(1)) moveTo(q);
        notes?.add(cmd + ' arcs sampled');
        break;
      }
      case 'SC': if (nums.length) notes?.add('SC (user scaling) ignored — plotter units assumed'); break;
      case 'IP': case 'LT': case 'PW': case 'PT': case 'VS': case 'FS': case 'SS': case 'CS': case 'DI': case 'DR': case 'RO': case 'PS': case 'NR': case 'BP': case 'PG': break;
      default: notes?.add(cmd + ' ignored');
    }
  }
  end();
  return { strokes, labels };
}

/** HP-GL/2 PE (polyline encoded) base-64 decoder (7-bit, default). */
function decodePE(body: string, start: Vec, _down: boolean): { strokes: Vec[][]; cur: Vec } {
  const strokes: Vec[][] = []; let cur = { ...start }; let up = false; let fract = 0; let path: Vec[] = [{ ...cur }];
  let i = 0; const vals: number[] = []; let abs = false;
  const readNum = (): number | null => {
    let v = 0, mulv = 1;
    while (i < body.length) {
      const ch = body.charCodeAt(i++);
      if (ch >= 63 && ch <= 126) { v += (ch - 63) * mulv; mulv *= 64; }
      else if (ch >= 191 && ch <= 254) { v += (ch - 191) * mulv; break; }
      else if (ch >= 191 - 128 && ch <= 62) { // 5-bit terminator variants not supported → treat 7-bit terminators 191..254 only
        i--; return null;
      }
    }
    return (v & 1 ? -(v >> 1) : v >> 1) / Math.pow(2, fract);
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === '<') { i++; up = true; continue; }
    if (ch === '=') { i++; abs = true; continue; }
    if (ch === '>') { i++; const f = readNum(); fract = f ?? 0; continue; }
    if (ch === ':' || ch === '7') { i++; readNum(); continue; }
    const x = readNum(); if (x === null) { i++; continue; }
    const y = readNum(); if (y === null) break;
    vals.push(x, y);
    const p = abs ? { x, y } : { x: cur.x + x, y: cur.y + y };
    abs = false;
    if (up) { if (path.length > 1) strokes.push(path); path = [{ ...p }]; up = false; }
    else path.push({ ...p });
    cur = p;
  }
  if (path.length > 1) strokes.push(path);
  return { strokes, cur };
}

// ═════════════════════════════ import ═════════════════════════════

export interface HPGLImportOptions {
  profile?: Partial<PlotterProfile>;
  /** max spike depth (mm) that counts as a notch. Default 12 */
  maxNotchDepth?: number;
  /** closing tolerance (mm). Default 0.5 */
  closeTol?: number;
  cornerAngleDeg?: number;
}

interface Spike { a: Vec; b: Vec }

/** Detect and remove out-and-back spikes from a closed polygon. Returns cleaned polygon + spikes (base → tip). */
export function extractSpikes(pts: Vec[], maxDepth: number, eps = 0.05): { pts: Vec[]; spikes: Spike[] } {
  let P = pts.slice();
  const spikes: Spike[] = [];
  let changed = true; let guard = 0;
  while (changed && guard++ < 1000) {
    changed = false;
    const n = P.length; if (n < 5) break;
    for (let i = 0; i < n; i++) {
      // pattern A: base, tip, base  (two-point spike)
      const a = P[(i - 1 + n) % n], t = P[i], b = P[(i + 1) % n];
      const d = dist(a, t);
      if (dist(a, b) < eps && d > eps && d <= maxDepth) {
        spikes.push({ a: { ...a }, b: { ...t } });
        const keep = P.filter((_, k) => k !== i && k !== (i + 1) % n);
        P = keep; changed = true; break;
      }
      // pattern B: base, tip, base' where base' ≈ base after tip (written as a, t, a)
    }
  }
  return { pts: P, spikes };
}

export function importHPGL(text: string, opt: HPGLImportOptions = {}): ImportReport {
  const prof = { ...DEFAULT_PROFILE, ...(opt.profile ?? {}), pens: { ...DEFAULT_PROFILE.pens, ...(opt.profile?.pens ?? {}) } };
  const notesSet = new Set<string>([`HPGL scale: ${prof.unitsPerMm} plotter units per mm`]);
  const warnings: string[] = [];
  const { strokes, labels } = parseHPGL(text, notesSet);
  const k = 1 / prof.unitsPerMm;
  const closeTol = opt.closeTol ?? 0.5;
  const maxNotch = opt.maxNotchDepth ?? 12;
  const S = strokes.map(s => ({ pen: s.pen, pts: s.pts.map(p => ({ x: p.x * k, y: p.y * k })) }));
  const closed: { pen: number; pts: Vec[] }[] = [], open: { pen: number; pts: Vec[] }[] = [];
  for (const s of S) {
    const f = s.pts[0], l = s.pts[s.pts.length - 1];
    if (s.pts.length >= 4 && dist(f, l) <= closeTol) closed.push({ pen: s.pen, pts: s.pts.slice(0, -1) });
    else open.push(s);
  }
  // spikes inside closed runs
  const spikeNotches: Spike[] = [];
  for (const c of closed) { const r = extractSpikes(c.pts, maxNotch); if (r.spikes.length) { c.pts = r.pts; spikeNotches.push(...r.spikes); } }
  closed.sort((a, b) => area(b.pts) - area(a.pts));
  const outers: typeof closed = [], inners: typeof closed = [];
  for (const c of closed) (outers.some(o => c.pts.every(p => pointInPolygon(p, o.pts))) ? inners : outers).push(c);
  const hosts = outers.filter(o => area(o.pts) >= 4);
  if (hosts.length < outers.length) warnings.push(`${outers.length - hosts.length} tiny closed path(s) (< 4 mm²) skipped`);
  const polys = hosts.map(h => h.pts);
  const groups: RawGroup[] = hosts.map(h => { const g = emptyGroup(); g.cut = { pts: h.pts.map(v => ({ ...v }) as RawVertex), closed: true }; return g; });
  for (const c of inners) {
    const hi = hostIndex(c.pts[0], polys, 0); if (hi < 0) continue;
    const g = groups[hi];
    if (!g.sew && (c.pen === prof.pens.sew || looksLikeSewOf(c.pts, polys[hi]))) g.sew = { pts: c.pts.map(v => ({ ...v })), closed: true };
    else g.internals.push({ pts: c.pts.map(v => ({ ...v })), closed: true, type: 'internal' });
  }
  for (const sp of spikeNotches) { const hi = nearestIndex(sp.a, polys, 1); if (hi >= 0) groups[hi].notches.push({ kind: 'line', a: sp.a, b: sp.b }); }
  // drill crosses (two crossing 2-point strokes on the drill pen sharing a midpoint) → drills
  const drillPen = open.filter(o => o.pen === prof.pens.drill && o.pts.length === 2);
  const used = new Set<typeof open[number]>();
  for (let i = 0; i < drillPen.length; i++) for (let j = i + 1; j < drillPen.length; j++) {
    const A = drillPen[i], B = drillPen[j]; if (used.has(A) || used.has(B)) continue;
    const ma = { x: (A.pts[0].x + A.pts[1].x) / 2, y: (A.pts[0].y + A.pts[1].y) / 2 }, mb = { x: (B.pts[0].x + B.pts[1].x) / 2, y: (B.pts[0].y + B.pts[1].y) / 2 };
    if (dist(ma, mb) > 0.05) continue;
    const hi = hostIndex(ma, polys, 50); if (hi < 0) continue;
    used.add(A); used.add(B);
    const r = dist(A.pts[0], A.pts[1]) / 2;
    groups[hi].drills.push({ p: ma, d: r > 1.0001 ? 2 * r : 0 });
  }
  // grain arrowheads (3-point strokes on the grain pen whose tip is a grain-line end) are decoration
  const grainLines = open.filter(o => o.pen === prof.pens.grain && o.pts.length === 2);
  for (const o of open) if (o.pen === prof.pens.grain && o.pts.length === 3 && grainLines.some(g => dist(g.pts[0], o.pts[1]) < 0.05 || dist(g.pts[1], o.pts[1]) < 0.05)) used.add(o);
  for (const o of open) {
    if (used.has(o)) continue;
    const a = o.pts[0], b = o.pts[o.pts.length - 1];
    let L = 0; for (let q = 1; q < o.pts.length; q++) L += dist(o.pts[q - 1], o.pts[q]);
    if (o.pts.length === 2 && L <= maxNotch) {
      const h = nearestIndex(a, polys, 1e9), h2 = nearestIndex(b, polys, 1e9);
      const hh = h >= 0 ? h : h2;
      if (hh >= 0 && Math.min(distToPolygon(a, polys[hh]), distToPolygon(b, polys[hh])) < 0.5) { groups[hh].notches.push({ kind: 'line', a, b }); continue; }
    }
    const mid = o.pts.length === 2 ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : o.pts[Math.floor(o.pts.length / 2)];
    const hi = hostIndex(mid, polys, 50); if (hi < 0) { warnings.push('open stroke outside every piece ignored'); continue; }
    if (o.pen === prof.pens.grain && o.pts.length === 2 && !groups[hi].grain) groups[hi].grain = { a, b };
    else groups[hi].internals.push({ pts: o.pts.map(v => ({ ...v })), closed: false, type: 'internal' });
  }
  for (const lb of labels) {
    const p = { x: lb.p.x * k, y: lb.p.y * k };
    const hi = hostIndex(p, polys, 1e9); if (hi < 0) continue;
    const m = /^\s*piece\s*name\s*:\s*(.+)$/i.exec(lb.text);
    if (m) groups[hi].attrs['piece name'] = m[1].trim();
    else groups[hi].texts.push({ p, text: lb.text, h: lb.h ?? prof.textHeight, rot: 0 });
  }
  if (spikeNotches.length) notesSet.add(`${spikeNotches.length} notch spike(s) removed from outlines`);
  const line = makeSizeLine(['BASE'], 'BASE');
  const table = makeSizeTable(line, 'Imported');
  const notes = [...notesSet];
  const pieces: Piece[] = [];
  groups.forEach((g, i) => { const p = buildPiece(g, { line, sizeTableId: table.id, cornerAngleDeg: opt.cornerAngleDeg }, warnings, notes, i); if (p) pieces.push(p); });
  if (!pieces.length) warnings.push('no closed PD runs found — nothing imported');
  const layerMap: ImportReport['layerMap'] = {};
  for (const s of S) { const key = 'pen ' + s.pen; layerMap[key] = { role: s.pen === prof.pens.sew ? 'sew' : s.pen === prof.pens.grain ? 'grain' : 'stroke', entities: (layerMap[key]?.entities ?? 0) + 1 }; }
  return { pieces, warnings, notes, layerMap, unitsDetected: 'mm', unitsSource: opt.profile?.unitsPerMm ? 'option' : 'default', yFlipped: false, sizeLine: line, sizeTable: table };
}

// ═════════════════════════════ export ═════════════════════════════

export interface HPGLExportOptions {
  pieceIds?: Id[];
  sizes?: SizeId[];
  profile?: Partial<PlotterProfile>;
  layout?: 'none' | 'pack';
  /** text labels: piece name + size (default true) */
  labels?: boolean;
}

export function exportHPGL(doc: Document, opt: HPGLExportOptions = {}): string {
  const prof = { ...DEFAULT_PROFILE, ...(opt.profile ?? {}), pens: { ...DEFAULT_PROFILE.pens, ...(opt.profile?.pens ?? {}) } };
  const U = prof.unitsPerMm;
  const dec = prof.decimals;
  const pieces = (opt.pieceIds ?? doc.style.pieces.map(p => p.id)).map(id => doc.piece(id));
  const per = pieces.map(p => ({ piece: p, ds: (opt.sizes ?? [doc.baseSize(p)]).filter(s => doc.sizesOf(p).includes(s)).map(s => drawPiece(doc, p, s)) })).filter(x => x.ds.length);
  const layout = opt.layout ?? (prof.frameWidth || per.length > 1 ? 'pack' : 'none');
  if (layout === 'pack') {
    // along the plotter x (length); rows across the frame width in y
    const boxes = per.map(x => { const bs = x.ds.map(drawingBox); return { minX: Math.min(...bs.map(b => b.minX)), minY: Math.min(...bs.map(b => b.minY)), maxX: Math.max(...bs.map(b => b.maxX)), maxY: Math.max(...bs.map(b => b.maxY)) }; });
    const offs = shelfPack(boxes.map(b => ({ minX: b.minY, minY: b.minX, maxX: b.maxY, maxY: b.maxX })), prof.frameWidth ?? 1500);
    // shelfPack works on transposed boxes: offset.x moves along y, offset.y along x (negative → flip to positive)
    per.forEach((x, i) => { x.ds = x.ds.map(d => translateDrawing(d, { x: -offs[i].y, y: offs[i].x })); });
  }
  const all = per.flatMap(x => x.ds.flatMap(d => [...d.cut, ...d.sew]));
  const bb = all.length ? bbox(all) : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const origin = layout === 'pack' || prof.frameWidth ? { x: bb.minX, y: bb.minY } : { x: 0, y: 0 };
  if (prof.frameWidth && bb.maxY - bb.minY > prof.frameWidth + 1e-6) throw new Error(`content height ${(bb.maxY - bb.minY).toFixed(2)} mm exceeds plotter frame width ${prof.frameWidth} mm`);
  const q = (v: number) => { const r = dec ? Number(v.toFixed(dec)) : Math.round(v); return Object.is(r, -0) ? 0 : r; };
  const X = (p: Vec) => `${q((p.x - origin.x) * U)},${q((p.y - origin.y) * U)}`;
  const L: string[] = ['IN;', 'DF;'];
  let curPen = -1;
  const pen = (n: number) => { if (n !== curPen) { L.push(`SP${n};`); curPen = n; } };
  const path = (pts: Vec[], closed: boolean) => { if (pts.length < 2) return; L.push(`PU${X(pts[0])};`, `PD${[...pts.slice(1), ...(closed ? [pts[0]] : [])].map(X).join(',')};`); };
  for (const { piece, ds } of per) {
    for (const d of ds) {
      pen(prof.pens.cut!);
      if (prof.notchCode === 'spike' && d.notches.length) {
        // write the cut path with out-and-back spikes at each notch
        const ins = d.notches.map(n => { let bi = 0, bd = Infinity; for (let i = 0; i < d.cut.length; i++) { const a = d.cut[i], b = d.cut[(i + 1) % d.cut.length]; const dd = segDist(n.a, a, b); if (dd < bd) { bd = dd; bi = i; } } return { i: bi, n }; });
        const out: Vec[] = [];
        for (let i = 0; i < d.cut.length; i++) {
          out.push(d.cut[i]);
          const here = ins.filter(x => x.i === i).sort((u, v) => dist(d.cut[i], u.n.a) - dist(d.cut[i], v.n.a));
          for (const h of here) out.push(h.n.a, h.n.b, h.n.a);
        }
        path(out, true);
      } else path(d.cut, true);
      if (prof.notchCode === 'line') { pen(prof.pens.notch!); for (const n of d.notches) path([n.a, n.b], false); }
      if (d.hasSeam && prof.sew) { pen(prof.pens.sew!); path(d.sew, true); }
      pen(prof.pens.internal!);
      for (const ic of d.internals) path(ic.pts, ic.closed);
      pen(prof.pens.grain!);
      path([d.grain.a, d.grain.b], false);
      { const u = norm(sub(d.grain.b, d.grain.a)), w = perp(u), ah = 6; for (const [tip, dir] of [[d.grain.b, u], [d.grain.a, mul(u, -1)]] as [Vec, Vec][]) path([add(add(tip, mul(dir, -ah)), mul(w, ah / 2.5)), tip, add(add(tip, mul(dir, -ah)), mul(w, -ah / 2.5))], false); }
      if (d.drills.length) { pen(prof.pens.drill!); for (const dr of d.drills) { const r = Math.max(dr.d / 2, 1); path([add(dr.p, { x: -r, y: 0 }), add(dr.p, { x: r, y: 0 })], false); path([add(dr.p, { x: 0, y: -r }), add(dr.p, { x: 0, y: r })], false); } }
      if (opt.labels ?? true) {
        pen(prof.pens.text!);
        L.push(`SI${(prof.textHeight * 0.06).toFixed(3)},${(prof.textHeight * 0.1).toFixed(3)};`);
        const b = bbox(d.sew);
        L.push(`PU${X({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 })};`, `LBPiece Name: ${piece.name}\x03`);
        for (const t of d.texts) L.push(`PU${X(t.p)};`, `LB${t.text.replace(/[\x03;]/g, ' ')}\x03`);
      }
    }
  }
  L.push('PU;', 'SP0;', 'IN;');
  return L.join('\n') + '\n';
}

function segDist(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a); const l2 = ab.x * ab.x + ab.y * ab.y;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2));
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}
