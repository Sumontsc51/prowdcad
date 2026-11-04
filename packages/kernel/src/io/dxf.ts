/**
 * DXF / AAMA / ASTM D6673 import and export, plus the companion grade-rule (.rul) file.
 *
 * Frame: DXF is y-up like the kernel, so y is written and read INTACT (no flip) unless `flipY` is asked.
 * Layer convention (AAMA-292 / ASTM D6673) — see docs/FILE-FORMATS.md for the full table:
 *   1 boundary (cut) · 2 turn points · 3 curve points · 4 notches · 6/86 mirror · 7 grain · 8 internal ·
 *   11 internal cut-outs · 13 drill holes · 14 sew line (84 accepted: legacy ProwdCAD ASTM sew layer) ·
 *   15 annotation text · 80 T / 81 castle / 82 V(check) / 83 U notches · 85 grade-rule tables · 87 alternate.
 * Grade-rule numbers: TEXT "# n" placed exactly on a vertex, on the same layer as the entity it grades
 * (layer 1/14/8/7/13/15) — layer 85 rule texts apply to any entity of the piece.
 */
import type { Vec } from '../geom/vec';
import { dist, bbox, add, rotate, rad } from '../geom/vec';
import { area, pointInPolygon } from '../geom/poly';
import { absoluteToIncremental, resolveContour } from '../model/contour';
import { makeSizeLine, makeSizeTable, newId } from '../model/factory';
import type { Document } from '../model/doc';
import type { GradeInc, Id, Piece, RuleLibrary, SizeId, SizeLine } from '../model/types';
import type { Unit } from '../units';
import {
  type ImportReport, type RawGroup, type RawPoly, type RawVertex, type RawNotch, type BuildOptions, type PieceDrawing,
  emptyGroup, buildPiece, sampleArc, bulgePoints, sampleBSpline, chainPolys, rawPts, hostIndex, nearestIndex,
  drawPiece, drawingBox, translateDrawing, shelfPack, fmt,
} from './common';

// ═════════════════════════════ low-level parser ═════════════════════════════

export interface DxfEntity {
  type: string;
  layer: string;
  /** raw group codes in order (for anything not decoded) */
  codes: [number, string][];
}

export interface DxfBlock { name: string; base: Vec; layer: string; entities: DxfEntity[] }
export interface DxfFile { header: Record<string, string[]>; blocks: Record<string, DxfBlock>; entities: DxfEntity[] }

/** Tokenise into (code, value) pairs. Tolerant: trims, skips malformed pairs, accepts \r\n / \n / \r. */
export function parseDXF(text: string): DxfFile {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(c)) { i -= 1; continue; } // resync on a stray line
    pairs.push([c, lines[i + 1].replace(/\s+$/, '')]);
  }
  const file: DxfFile = { header: {}, blocks: {}, entities: [] };
  let section = '';
  let curBlock: DxfBlock | null = null;
  let cur: DxfEntity | null = null;
  let headerVar = '';
  const flush = () => { if (cur) { (curBlock ? curBlock.entities : file.entities).push(cur); cur = null; } };
  let blockHeader = false;
  for (let i = 0; i < pairs.length; i++) {
    const [c, raw] = pairs[i];
    const v = raw.trim();
    if (c === 0) {
      flush();
      blockHeader = false;
      if (v === 'SECTION') { section = pairs[i + 1]?.[0] === 2 ? pairs[i + 1][1].trim() : ''; i++; continue; }
      if (v === 'ENDSEC') { section = ''; continue; }
      if (v === 'EOF') break;
      if (section === 'BLOCKS' && v === 'BLOCK') { curBlock = { name: '', base: { x: 0, y: 0 }, layer: '0', entities: [] }; blockHeader = true; continue; }
      if (section === 'BLOCKS' && v === 'ENDBLK') { if (curBlock) file.blocks[curBlock.name] = curBlock; curBlock = null; continue; }
      if (section === 'ENTITIES' || (section === 'BLOCKS' && curBlock)) cur = { type: v, layer: '0', codes: [] };
      continue;
    }
    if (section === 'HEADER') {
      if (c === 9) { headerVar = v; file.header[headerVar] = []; }
      else if (headerVar) file.header[headerVar].push(v);
      continue;
    }
    if (blockHeader && curBlock) {
      if (c === 2) curBlock.name = raw.trim();
      else if (c === 10) curBlock.base.x = parseFloat(v);
      else if (c === 20) curBlock.base.y = parseFloat(v);
      else if (c === 8) curBlock.layer = v;
      continue;
    }
    if (cur) { if (c === 8) cur.layer = v; cur.codes.push([c, raw]); }
  }
  flush();
  return file;
}

const num = (e: DxfEntity, code: number, def = 0): number => { const g = e.codes.find(q => q[0] === code); return g ? parseFloat(g[1]) : def; };
const str = (e: DxfEntity, code: number, def = ''): string => { const g = e.codes.find(q => q[0] === code); return g ? g[1] : def; };
const nums = (e: DxfEntity, code: number): number[] => e.codes.filter(q => q[0] === code).map(q => parseFloat(q[1]));

// ═════════════════════════════ primitives ═════════════════════════════

type Prim =
  | { k: 'poly'; layer: string; pts: RawVertex[]; closed: boolean }
  | { k: 'point'; layer: string; p: Vec }
  | { k: 'circle'; layer: string; c: Vec; r: number }
  | { k: 'text'; layer: string; p: Vec; text: string; h: number; rot: number }
  | { k: 'attr'; tag: string; value: string };

interface Xform { m: [number, number, number, number, number, number] } // x' = a x + b y + e ; y' = c x + d y + f
const I: Xform = { m: [1, 0, 0, 1, 0, 0] };
const ap = (t: Xform, p: Vec): Vec => ({ x: t.m[0] * p.x + t.m[1] * p.y + t.m[4], y: t.m[2] * p.x + t.m[3] * p.y + t.m[5] });
function compose(outer: Xform, inner: Xform): Xform {
  const [a, b, c, d, e, f] = outer.m, [A, B, C, D, E, F] = inner.m;
  return { m: [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, a * E + b * F + e, c * E + d * F + f] };
}
const xscale = (t: Xform) => Math.sqrt(Math.abs(t.m[0] * t.m[3] - t.m[1] * t.m[2]));
const xrot = (t: Xform) => Math.atan2(t.m[2], t.m[0]) * 180 / Math.PI;

/** Decode entities of one scope into primitives (polylines stitched, curves sampled, INSERTs expanded). */
function primitives(ents: DxfEntity[], file: DxfFile, t: Xform, unsupported: Record<string, number>, depth = 0, tol = 0.01): Prim[] {
  const out: Prim[] = [];
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    const L = e.layer;
    switch (e.type) {
      case 'LINE': out.push({ k: 'poly', layer: L, closed: false, pts: [ap(t, { x: num(e, 10), y: num(e, 20) }), ap(t, { x: num(e, 11), y: num(e, 21) })] }); break;
      case 'POLYLINE': {
        const closed = (num(e, 70) & 1) === 1;
        const verts: { p: Vec; b: number }[] = [];
        let j = i + 1;
        for (; j < ents.length && ents[j].type === 'VERTEX'; j++) {
          const vx = ents[j];
          if ((num(vx, 70) & 16) === 16) continue; // spline frame control point
          verts.push({ p: { x: num(vx, 10), y: num(vx, 20) }, b: num(vx, 42) });
        }
        if (j < ents.length && ents[j].type === 'SEQEND') i = j; else i = j - 1;
        out.push({ k: 'poly', layer: L, closed, pts: withBulges(verts, closed, tol).map(v => ({ ...v, ...ap(t, v) })) });
        break;
      }
      case 'LWPOLYLINE': {
        const closed = (num(e, 70) & 1) === 1;
        const verts: { p: Vec; b: number }[] = [];
        for (const [c, v] of e.codes) {
          if (c === 10) verts.push({ p: { x: parseFloat(v), y: 0 }, b: 0 });
          else if (c === 20 && verts.length) verts[verts.length - 1].p.y = parseFloat(v);
          else if (c === 42 && verts.length) verts[verts.length - 1].b = parseFloat(v);
        }
        out.push({ k: 'poly', layer: L, closed, pts: withBulges(verts, closed, tol).map(v => ({ ...v, ...ap(t, v) })) });
        break;
      }
      case 'ARC': {
        const c = { x: num(e, 10), y: num(e, 20) }, r = num(e, 40);
        let a0 = num(e, 50), a1 = num(e, 51);
        let sweep = a1 - a0; while (sweep <= 0) sweep += 360;
        const pts = sampleArc(c, r, rad(a0), rad(sweep), tol).map((p, k, arr) => ({ ...ap(t, p), curve: k > 0 && k < arr.length - 1 }));
        out.push({ k: 'poly', layer: L, closed: false, pts });
        break;
      }
      case 'CIRCLE': out.push({ k: 'circle', layer: L, c: ap(t, { x: num(e, 10), y: num(e, 20) }), r: num(e, 40) * xscale(t) }); break;
      case 'ELLIPSE': {
        const c = { x: num(e, 10), y: num(e, 20) }, maj = { x: num(e, 11), y: num(e, 21) }, ratio = num(e, 40, 1);
        const p0 = num(e, 41, 0), p1 = num(e, 42, Math.PI * 2);
        let sw = p1 - p0; while (sw <= 0) sw += Math.PI * 2;
        const a = Math.hypot(maj.x, maj.y), rot = Math.atan2(maj.y, maj.x);
        const n = Math.max(16, Math.ceil(sw / (Math.PI * 2) * 128));
        const pts: RawVertex[] = [];
        for (let k = 0; k <= n; k++) {
          const u = p0 + sw * (k / n);
          const q = rotate({ x: a * Math.cos(u), y: a * ratio * Math.sin(u) }, rot);
          pts.push({ ...ap(t, add(c, q)), curve: true });
        }
        const full = Math.abs(sw - Math.PI * 2) < 1e-9;
        if (full) pts.pop();
        out.push({ k: 'poly', layer: L, closed: full, pts });
        break;
      }
      case 'SPLINE': {
        const deg = num(e, 71, 3);
        const knots = nums(e, 40), weights = nums(e, 41);
        const cx = nums(e, 10), cy = nums(e, 20), fx = nums(e, 11), fy = nums(e, 21);
        const ctrl = cx.map((x, k) => ({ x, y: cy[k] ?? 0 }));
        const fit = fx.map((x, k) => ({ x, y: fy[k] ?? 0 }));
        const closed = (num(e, 70) & 1) === 1;
        let pts: Vec[];
        if (ctrl.length >= 2) pts = sampleBSpline(ctrl, deg, knots, weights);
        else if (fit.length >= 2) { pts = fit; unsupported['SPLINE fit-points (used as curve points)'] = (unsupported['SPLINE fit-points (used as curve points)'] ?? 0) + 1; }
        else break;
        const rv = pts.map((p, k) => ({ ...ap(t, p), curve: k > 0 && k < pts.length - 1 }));
        if (closed && rv.length > 2 && dist(rv[0], rv[rv.length - 1]) < 1e-6) rv.pop();
        out.push({ k: 'poly', layer: L, closed, pts: rv });
        break;
      }
      case 'POINT': out.push({ k: 'point', layer: L, p: ap(t, { x: num(e, 10), y: num(e, 20) }) }); break;
      case 'TEXT': case 'MTEXT': case 'ATTRIB': case 'ATTDEF': {
        const useAlign = e.type === 'TEXT' && (num(e, 72) !== 0 || num(e, 73) !== 0) && e.codes.some(q => q[0] === 11);
        const p = useAlign ? { x: num(e, 11), y: num(e, 21) } : { x: num(e, 10), y: num(e, 20) };
        let text = e.type === 'MTEXT' ? e.codes.filter(q => q[0] === 3).map(q => q[1]).join('') + str(e, 1) : str(e, 1);
        if (e.type === 'MTEXT') text = text.replace(/\\P/g, '\n').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '');
        if (e.type === 'ATTRIB' || e.type === 'ATTDEF') {
          const tag = str(e, 2).trim(); const val = e.type === 'ATTDEF' ? str(e, 1) || str(e, 3) : text;
          if (tag) { out.push({ k: 'attr', tag, value: val.trim() }); break; }
        }
        out.push({ k: 'text', layer: L, p: ap(t, p), text, h: num(e, 40, 5) * xscale(t), rot: num(e, 50) + xrot(t) });
        break;
      }
      case 'INSERT': {
        const blk = file.blocks[str(e, 2).trim()];
        if (!blk || depth > 8) { unsupported['INSERT (missing block)'] = (unsupported['INSERT (missing block)'] ?? 0) + 1; break; }
        out.push(...primitives(blk.entities, file, insertXform(e, blk, t), unsupported, depth + 1, tol));
        // attributes that follow the INSERT
        let j = i + 1;
        for (; j < ents.length && ents[j].type === 'ATTRIB'; j++) out.push({ k: 'attr', tag: str(ents[j], 2).trim(), value: str(ents[j], 1).trim() });
        if (j > i + 1) { if (j < ents.length && ents[j].type === 'SEQEND') j++; i = j - 1; }
        break;
      }
      case 'VERTEX': case 'SEQEND': break;
      default: unsupported[e.type] = (unsupported[e.type] ?? 0) + 1;
    }
  }
  return out;
}

function insertXform(e: DxfEntity, blk: DxfBlock, parent: Xform): Xform {
  const sx = num(e, 41, 1), sy = num(e, 42, 1), r = rad(num(e, 50, 0));
  const ix = num(e, 10), iy = num(e, 20);
  const c = Math.cos(r), s = Math.sin(r);
  // p' = ins + R·S·(p − base)
  const local: Xform = { m: [c * sx, -s * sy, s * sx, c * sy, 0, 0] };
  const tb = ap(local, { x: -blk.base.x, y: -blk.base.y });
  local.m[4] = ix + tb.x; local.m[5] = iy + tb.y;
  return compose(parent, local);
}

function withBulges(verts: { p: Vec; b: number }[], closed: boolean, tol: number): RawVertex[] {
  const out: RawVertex[] = [];
  const n = verts.length;
  for (let k = 0; k < n; k++) {
    out.push({ ...verts[k].p });
    const nx = k + 1 < n ? k + 1 : closed ? 0 : -1;
    if (nx >= 0 && verts[k].b) for (const q of bulgePoints(verts[k].p, verts[nx].p, verts[k].b, tol)) out.push({ ...q, curve: true });
  }
  return out;
}

// ═════════════════════════════ layer roles ═════════════════════════════

export type LayerRole =
  | 'boundary' | 'turn' | 'curve' | 'notch' | 'notchT' | 'notchCastle' | 'notchV' | 'notchU' | 'gradeRef' | 'mirror'
  | 'grain' | 'internal' | 'stripe' | 'plaid' | 'cutout' | 'drill' | 'sew' | 'text' | 'rules' | 'alternate' | 'ignore';

export const AAMA_LAYERS: Record<string, LayerRole> = {
  '1': 'boundary', '2': 'turn', '3': 'curve', '4': 'notch', '5': 'gradeRef', '6': 'mirror', '7': 'grain', '8': 'internal',
  '9': 'stripe', '10': 'plaid', '11': 'cutout', '13': 'drill', '14': 'sew', '15': 'text',
  '80': 'notchT', '81': 'notchCastle', '82': 'notchV', '83': 'notchU', '84': 'sew', '85': 'rules', '86': 'mirror', '87': 'alternate',
};

function roleOf(layer: string, map: Record<string, LayerRole>): LayerRole | undefined {
  if (map[layer]) return map[layer];
  const m = /(\d+)$/.exec(layer.trim());
  return m ? map[String(parseInt(m[1], 10))] : undefined;
}

const NOTCH_ROLE_TYPE = { notch: 'slit', notchT: 'T', notchCastle: 'castle', notchV: 'V', notchU: 'U' } as const;

// ═════════════════════════════ .rul grade-rule file ═════════════════════════════

export interface RuleTable {
  name: string;
  units: Unit;
  sizes: string[];
  sampleSize: string;
  /** rule number → per-size incremental deltas (size-list order, file units converted to mm) */
  rules: Map<number, { dx: number; dy: number }[]>;
}

/** Parse an AAMA / ASTM D6673 `.rul` file (DELTA rules). Tolerant of wrapping and separators. */
export function parseRUL(text: string): RuleTable {
  const t: RuleTable = { name: '', units: 'mm', sizes: [], sampleSize: '', rules: new Map() };
  const lines = text.split(/\r\n|\r|\n/);
  let cur: number | null = null; let buf: number[] = [];
  let mul = 1;
  const flushRule = () => {
    if (cur === null) return;
    const v: { dx: number; dy: number }[] = [];
    for (let k = 0; k + 1 < buf.length; k += 2) v.push({ dx: buf[k] * mul, dy: buf[k + 1] * mul });
    t.rules.set(cur, v); cur = null; buf = [];
  };
  let sizesExpected = 0; let readingSizes = false;
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^UNITS\s*:\s*(\w+)/i.exec(line))) { const u = m[1].toUpperCase(); t.units = u.startsWith('ENG') || u.startsWith('IN') ? 'in' : 'mm'; mul = t.units === 'in' ? 25.4 : 1; readingSizes = false; continue; }
    if ((m = /^GRADE\s*RULE\s*TABLE\s*:\s*(.*)$/i.exec(line))) { t.name = m[1].trim(); readingSizes = false; continue; }
    if ((m = /^NUMBER\s*OF\s*SIZES\s*:\s*(\d+)/i.exec(line))) { sizesExpected = parseInt(m[1], 10); readingSizes = false; continue; }
    if ((m = /^SIZE\s*LIST\s*:\s*(.*)$/i.exec(line))) { t.sizes = m[1].split(/[\s,]+/).filter(Boolean); readingSizes = sizesExpected > t.sizes.length; continue; }
    if ((m = /^SAMPLE\s*SIZE\s*:\s*(.*)$/i.exec(line))) { t.sampleSize = m[1].trim(); readingSizes = false; continue; }
    if ((m = /^RULE\s*:\s*(?:DELTA\s*)?(\d+)/i.exec(line))) { flushRule(); cur = parseInt(m[1], 10); readingSizes = false; continue; }
    if (/^END\b/i.test(line)) { flushRule(); break; }
    if (readingSizes) { t.sizes.push(...line.split(/[\s,]+/).filter(Boolean)); readingSizes = sizesExpected > t.sizes.length; continue; }
    if (cur !== null) { const ns = line.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g); if (ns) buf.push(...ns.map(Number)); }
  }
  flushRule();
  if (!t.sampleSize) t.sampleSize = t.sizes[Math.floor(t.sizes.length / 2)] ?? '';
  return t;
}

export function ruleTableSizeLine(t: RuleTable): SizeLine {
  return makeSizeLine(t.sizes, t.sampleSize, { name: t.name || 'Sizes' });
}

function ruleInc(t: RuleTable, line: SizeLine, n: number): Record<SizeId, GradeInc> | undefined {
  const r = t.rules.get(n); if (!r) return undefined;
  const g: Record<SizeId, GradeInc> = {};
  line.sizes.forEach((s, k) => { const v = r[k] ?? { dx: 0, dy: 0 }; g[s.id] = { dx: v.dx, dy: v.dy }; });
  return g;
}

export interface RulExportOptions { units?: 'mm' | 'in'; name?: string; flavor?: 'aama' | 'astm'; precision?: number }

/** Serialise rules (rule number → incremental grade by size id) for a size line. */
export function writeRUL(rules: Map<number, Record<SizeId, GradeInc>>, line: SizeLine, opt: RulExportOptions = {}): string {
  const k = opt.units === 'in' ? 1 / 25.4 : 1;
  const prec = opt.precision ?? (opt.units === 'in' ? 8 : 4);
  const names = line.sizes.map(s => s.name.replace(/\s+/g, '_'));
  const base = line.sizes.find(s => s.id === line.baseSizeId)!;
  const L: string[] = [];
  L.push(opt.flavor === 'aama' ? 'AAMA-VERSION: 1.0' : 'ASTM/D6673/RUL', 'CREATION SOFTWARE: ProwdCAD 2',
    `UNITS: ${opt.units === 'in' ? 'ENGLISH' : 'METRIC'}`, `GRADE RULE TABLE: ${opt.name ?? line.name}`,
    `NUMBER OF SIZES: ${names.length}`, `SIZE LIST: ${names.join(' ')}`, `SAMPLE SIZE: ${base.name.replace(/\s+/g, '_')}`);
  for (const n of [...rules.keys()].sort((a, b) => a - b)) {
    const g = rules.get(n)!;
    L.push(`RULE: DELTA ${n}`);
    L.push(line.sizes.map(s => { const v = g[s.id] ?? { dx: 0, dy: 0 }; return `${(v.dx * k).toFixed(prec)},${(v.dy * k).toFixed(prec)}`; }).join(','));
  }
  L.push('END');
  return L.join('\r\n') + '\r\n';
}

// ═════════════════════════════ import ═════════════════════════════

export interface DXFImportOptions {
  /** companion .rul file content */
  rul?: string;
  /** force input units (else $INSUNITS / UNITS text / heuristic) */
  units?: Unit;
  /** negate y on import (files from y-down systems) */
  flipY?: boolean;
  /** layer name → role overrides (merged over the AAMA/ASTM table) */
  layerMap?: Record<string, LayerRole>;
  /** see BuildOptions */
  seamMode?: 'infer' | 'manual';
  cornerAngleDeg?: number;
  /** merge blocks of the same piece name with different Size attributes into one graded piece (default true) */
  mergeSizes?: boolean;
  /** base size name when merging nested sizes (else the .rul SAMPLE SIZE, else the middle size) */
  baseSize?: string;
  /** distance (mm) within which a rule text / turn marker snaps to a vertex. Default 0.01 */
  snapTol?: number;
}

interface Scope { prims: Prim[]; attrs: Record<string, string>; blockName?: string }

const ATTR_RE = /^\s*(piece\s*name|size|quantity|category|material|rule\s*table|style\s*name|sample\s*size|units|annotation|fabric)\s*[:=]\s*(.*)$/i;
const RULE_RE = /^\s*#\s*(\d+)\s*$/;

export function importDXF(text: string, opt: DXFImportOptions = {}): ImportReport {
  const warnings: string[] = [], notes: string[] = [];
  const file = parseDXF(text);
  const unsupported: Record<string, number> = {};
  const map = { ...AAMA_LAYERS, ...(opt.layerMap ?? {}) };

  // ── scopes: each INSERT of a block containing a boundary/sew = one piece scope; the rest is flat
  const scopes: Scope[] = [];
  const flatEnts: DxfEntity[] = [];
  const isPieceBlock = (b: DxfBlock | undefined) => !!b && b.entities.some(e => { const r = roleOf(e.layer, map); return r === 'boundary' || r === 'sew'; });
  for (let i = 0; i < file.entities.length; i++) {
    const e = file.entities[i];
    if (e.type === 'INSERT' && isPieceBlock(file.blocks[str(e, 2).trim()])) {
      const blk = file.blocks[str(e, 2).trim()];
      const prims = primitives(blk.entities, file, insertXform(e, blk, I), unsupported);
      let j = i + 1;
      for (; j < file.entities.length && file.entities[j].type === 'ATTRIB'; j++) prims.push({ k: 'attr', tag: str(file.entities[j], 2).trim(), value: str(file.entities[j], 1).trim() });
      if (j > i + 1) { if (j < file.entities.length && file.entities[j].type === 'SEQEND') j++; i = j - 1; }
      scopes.push({ prims, attrs: {}, blockName: blk.name });
    } else flatEnts.push(e);
  }
  const flatPrims = primitives(flatEnts, file, I, unsupported);

  // ── units
  let unitsDetected: Unit = 'mm'; let unitsSource: ImportReport['unitsSource'] = 'default';
  const allPrims = [...flatPrims, ...scopes.flatMap(s => s.prims)];
  const ins = file.header['$INSUNITS']?.[0];
  if (opt.units) { unitsDetected = opt.units; unitsSource = 'option'; }
  else if (ins && ['1', '4', '5'].includes(ins.trim())) { unitsDetected = ins.trim() === '1' ? 'in' : ins.trim() === '5' ? 'cm' : 'mm'; unitsSource = 'header'; }
  else {
    const ut = allPrims.find(p => (p.k === 'text' && /^\s*units\s*[:=]/i.test(p.text)) || (p.k === 'attr' && /^units$/i.test(p.tag)));
    const uv = ut ? (ut.k === 'text' ? ut.text.split(/[:=]/)[1] : ut.k === 'attr' ? ut.value : '').trim().toUpperCase() : '';
    if (uv) { unitsDetected = uv.startsWith('ENG') || uv.startsWith('IN') ? 'in' : 'mm'; unitsSource = 'header'; }
    else if (file.header['$MEASUREMENT']?.[0]?.trim() === '0') { unitsDetected = 'in'; unitsSource = 'header'; }
    else {
      const pts = allPrims.flatMap(p => (p.k === 'poly' ? p.pts : []));
      if (pts.length) {
        const b = bbox(pts); const ext = Math.max(b.maxX - b.minX, b.maxY - b.minY);
        if (ext > 0 && ext < 100) { unitsDetected = 'in'; unitsSource = 'heuristic'; warnings.push(`no units in file; extent ${ext.toFixed(2)} < 100 → assumed inches`); }
        else unitsSource = 'heuristic';
      }
    }
  }
  const k = unitsDetected === 'in' ? 25.4 : unitsDetected === 'cm' ? 10 : 1;
  const fy = opt.flipY ? -1 : 1;
  const conv = (p: Vec): Vec => ({ x: p.x * k, y: p.y * k * fy });
  const convPrim = (p: Prim): Prim => {
    switch (p.k) {
      case 'poly': return { ...p, pts: p.pts.map(v => ({ ...v, ...conv(v) })) };
      case 'point': return { ...p, p: conv(p.p) };
      case 'circle': return { ...p, c: conv(p.c), r: p.r * k };
      case 'text': return { ...p, p: conv(p.p), h: p.h * k, rot: p.rot * fy };
      default: return p;
    }
  };
  for (const s of scopes) s.prims = s.prims.map(convPrim);
  let flat = flatPrims.map(convPrim);

  // ── rule table
  let table: RuleTable | undefined;
  if (opt.rul) { table = parseRUL(opt.rul); notes.push(`grade rule table "${table.name}" — ${table.sizes.length} sizes, ${table.rules.size} rules, sample ${table.sampleSize}`); }

  // ── layer map for the report
  const layerMap: ImportReport['layerMap'] = {};
  const countLayer = (l: string) => { const r = roleOf(l, map) ?? 'unknown'; layerMap[l] = { role: r, entities: (layerMap[l]?.entities ?? 0) + 1 }; };
  for (const p of allPrims) if (p.k !== 'attr') countLayer(p.layer);

  // ── flat entities: split into scopes by boundary containment
  if (flat.some(p => p.k !== 'attr')) {
    const polys = flat.filter((p): p is Extract<Prim, { k: 'poly' }> => p.k === 'poly');
    const others = flat.filter(p => p.k !== 'poly');
    // chain open pieces of the same layer (LINE/ARC outlines)
    const byLayer = new Map<string, RawPoly[]>();
    for (const p of polys) { const a = byLayer.get(p.layer) ?? []; a.push({ pts: p.pts, closed: p.closed }); byLayer.set(p.layer, a); }
    const chained: Extract<Prim, { k: 'poly' }>[] = [];
    for (const [layer, list] of byLayer) {
      const role = roleOf(layer, map);
      const c = role === 'boundary' || role === 'sew' ? chainPolys(list, 0.05 * k) : list;
      for (const q of c) chained.push({ k: 'poly', layer, pts: q.pts, closed: q.closed });
    }
    // circles on boundary/sew layers become closed polys
    const isB = (p: Prim) => p.k === 'poly' && p.closed && roleOf(p.layer, map) === 'boundary';
    const isS = (p: Prim) => p.k === 'poly' && p.closed && roleOf(p.layer, map) === 'sew';
    let outlines = chained.filter(isB);
    const outlinePolys = outlines.map(p => rawPts({ pts: (p as any).pts, closed: true }));
    // outlines inside another outline = internal cut-outs
    const keep: number[] = [];
    outlinePolys.forEach((poly, i) => {
      const parent = outlinePolys.findIndex((o, j) => j !== i && area(o) > area(poly) && poly.every(q => pointInPolygon(q, o)));
      if (parent < 0) keep.push(i);
    });
    const hostPolys = keep.length ? keep.map(i => outlinePolys[i]) : chained.filter(isS).map(p => rawPts({ pts: (p as any).pts, closed: true }));
    const hostSource = keep.length ? keep.map(i => outlines[i]) : chained.filter(isS);
    const flatScopes: Scope[] = hostSource.map(h => ({ prims: [h], attrs: {} }));
    const rest = [...chained.filter(p => !hostSource.includes(p)), ...others];
    const unassigned: Prim[] = [];
    for (const p of rest) {
      if (p.k === 'attr') { unassigned.push(p); continue; }
      const q = repPoint(p);
      const role = roleOf(p.layer, map);
      const hi = role === 'notch' || role?.startsWith('notch') || p.k === 'point' ? nearestIndex(q, hostPolys, 1e9) : hostIndex(q, hostPolys, 50 * k);
      if (hi < 0) unassigned.push(p); else flatScopes[hi].prims.push(p);
    }
    const unText = unassigned.filter(p => p.k !== 'attr' && !(p.k === 'text' && ATTR_RE.test(p.text)));
    if (unText.length) warnings.push(`${unText.length} entit${unText.length === 1 ? 'y' : 'ies'} outside every piece — ignored`);
    // file-level attrs
    const fileAttrs: Record<string, string> = {};
    for (const p of unassigned) collectAttr(p, fileAttrs);
    for (const s of flatScopes) Object.assign(s.attrs, fileAttrs);
    scopes.push(...flatScopes);
    flat = [];
  }

  // ── size line
  const groups: { g: RawGroup; size?: string }[] = [];
  const unresolved = new Set<number>();
  let line: SizeLine;
  const sizeNames = new Set<string>();
  for (const s of scopes) {
    for (const p of s.prims) collectAttr(p, s.attrs);
    if (s.attrs['size']) sizeNames.add(s.attrs['size']);
  }
  if (table && table.sizes.length) line = ruleTableSizeLine(table);
  else if (sizeNames.size > 1) {
    const names = [...sizeNames];
    const sample = opt.baseSize ?? scopes.map(sc => sc.attrs['sample size']).find(Boolean);
    line = makeSizeLine(names, sample && names.includes(sample) ? sample : names[Math.floor(names.length / 2)]);
  } else {
    const nm = [...sizeNames][0] ?? 'BASE';
    line = makeSizeLine([nm], nm);
  }
  const sizeTable = makeSizeTable(line, table?.name || 'Imported');

  // ── scopes → raw groups
  const tol = opt.snapTol ?? 0.01;
  for (const s of scopes) {
    const g = scopeToGroup(s, map, tol, table, line, unresolved, warnings, k);
    if (g) groups.push({ g, size: s.attrs['size'] });
  }

  // ── build pieces
  const bopt: BuildOptions = { line, sizeTableId: sizeTable.id, seamMode: opt.seamMode, cornerAngleDeg: opt.cornerAngleDeg };
  let pieces: Piece[] = [];
  const doMerge = (opt.mergeSizes ?? true) && sizeNames.size > 1 && !table;
  if (doMerge) {
    const byName = new Map<string, { g: RawGroup; size?: string }[]>();
    for (const x of groups) { const n = x.g.attrs['piece name'] ?? x.g.name ?? ''; const a = byName.get(n) ?? []; a.push(x); byName.set(n, a); }
    let idx = 0;
    for (const [, list] of byName) {
      const merged = mergeNested(list, bopt, line, warnings, notes, idx++);
      if (merged) pieces.push(merged);
    }
    notes.push(`nested sizes merged into graded pieces (${line.sizes.map(s => s.name).join(', ')}; base ${line.sizes.find(s => s.id === line.baseSizeId)!.name})`);
  } else {
    groups.forEach((x, i) => { const p = buildPiece(x.g, bopt, warnings, notes, i); if (p) pieces.push(p); });
  }
  if (!pieces.length) warnings.push('no piece boundaries (layer 1 / 14) found — nothing imported');
  for (const [t, n] of Object.entries(unsupported)) warnings.push(`unsupported entity ${t} ×${n} skipped`);
  for (const [l, info] of Object.entries(layerMap)) if (info.role === 'unknown') warnings.push(`unknown layer "${l}" (${info.entities} entities) ignored`);
  if (unresolved.size) warnings.push(`grade rules not found in the rule table: ${[...unresolved].sort((a, b) => a - b).join(', ')}`);
  else if (!table && groups.some(x => x.g.attrs['__rules'])) warnings.push('vertices carry grade rule numbers but no .rul file was supplied — grading not applied');
  notes.unshift(`units ${unitsDetected} (${unitsSource}); y ${opt.flipY ? 'flipped' : 'intact'}`);

  let ruleLibrary: RuleLibrary | undefined;
  if (table) ruleLibrary = { id: newId('rl'), name: table.name || 'Imported rules', sizeLine: line, rules: [...table.rules.keys()].map(n => ({ id: newId('r'), number: n, name: String(n), inc: ruleInc(table!, line, n)!, sizeLineId: line.id })) };

  return { pieces, warnings, notes, layerMap, unitsDetected, unitsSource, yFlipped: !!opt.flipY, sizeLine: line, sizeTable, unresolvedRules: [...unresolved], ruleLibrary };
}

function repPoint(p: Prim): Vec {
  switch (p.k) {
    case 'poly': { if (p.pts.length === 2) return { x: (p.pts[0].x + p.pts[1].x) / 2, y: (p.pts[0].y + p.pts[1].y) / 2 }; return p.pts[Math.floor(p.pts.length / 2)]; }
    case 'point': return p.p;
    case 'circle': return p.c;
    case 'text': return p.p;
    default: return { x: 0, y: 0 };
  }
}

function collectAttr(p: Prim, attrs: Record<string, string>) {
  if (p.k === 'attr') { attrs[p.tag.toLowerCase().replace(/[_\s]+/g, ' ').trim()] = p.value; return; }
  if (p.k === 'text') { const m = ATTR_RE.exec(p.text); if (m) attrs[m[1].toLowerCase().replace(/\s+/g, ' ')] = m[2].trim(); }
}

function scopeToGroup(s: Scope, map: Record<string, LayerRole>, tol: number, table: RuleTable | undefined, line: SizeLine,
  unresolved: Set<number>, warnings: string[], k: number): RawGroup | null {
  const g = emptyGroup();
  g.attrs = { ...s.attrs };
  g.name = s.attrs['piece name'] ?? s.blockName;
  const polys = s.prims.filter((p): p is Extract<Prim, { k: 'poly' }> => p.k === 'poly');
  // chain outline fragments inside the block too
  const chainedBy = (role: LayerRole) => {
    const ps = polys.filter(p => roleOf(p.layer, map) === role);
    return chainPolys(ps.map(p => ({ pts: p.pts, closed: p.closed, name: p.layer })), 0.05 * k).map(q => ({ ...q, layer: q.name! }));
  };
  const bnd = chainedBy('boundary'), sew = chainedBy('sew');
  const closedB = bnd.filter(p => p.closed).sort((a, b) => area(rawPts(b)) - area(rawPts(a)));
  const closedS = sew.filter(p => p.closed).sort((a, b) => area(rawPts(b)) - area(rawPts(a)));
  const cut = closedB[0], sw = closedS[0];
  if (!cut && !sw) return null;
  // marker + rule snapping
  const allPolys: { layer: string; pts: RawVertex[] }[] = [...bnd, ...sew, ...polys.filter(p => { const r = roleOf(p.layer, map); return r !== 'boundary' && r !== 'sew'; })];
  const markers = s.prims.filter((p): p is Extract<Prim, { k: 'point' }> => p.k === 'point' && (roleOf(p.layer, map) === 'turn' || roleOf(p.layer, map) === 'curve'));
  for (const m of markers) {
    const kind = roleOf(m.layer, map) === 'turn' ? 'turn' : 'curve';
    for (const pl of [cut, sw]) if (pl) for (const v of pl.pts) if (dist(v, m.p) <= tol) v.marker = kind;
  }
  const ruleTexts = s.prims.filter((p): p is Extract<Prim, { k: 'text' }> => p.k === 'text' && RULE_RE.test(p.text));
  const ruleAt: { p: Vec; layer: string; n: number }[] = ruleTexts.map(t => ({ p: t.p, layer: t.layer, n: parseInt(RULE_RE.exec(t.text)![1], 10) }));
  const gradeFor = (n: number) => {
    if (!table) { g.attrs['__rules'] = '1'; return undefined; }
    const r = ruleInc(table, line, n); if (!r) unresolved.add(n); return r;
  };
  for (const pl of allPolys) for (const v of pl.pts) {
    for (const r of ruleAt) if ((r.layer === pl.layer || roleOf(r.layer, map) === 'rules') && dist(v, r.p) <= tol) { v.rule = r.n; v.grade = gradeFor(r.n); }
  }
  const ruleNear = (p: Vec, layer: string) => { const r = ruleAt.find(r => (r.layer === layer || roleOf(r.layer, map) === 'rules') && dist(r.p, p) <= tol); return r ? gradeFor(r.n) : undefined; };

  if (sw) { g.sew = { pts: sw.pts, closed: true }; if (cut) g.cut = { pts: cut.pts, closed: true }; }
  else g.cut = { pts: cut.pts, closed: true };
  for (const extra of [...closedB.slice(1)]) g.internals.push({ pts: extra.pts, closed: true, type: 'internal', mode: 'cut' });
  for (const extra of bnd.filter(p => !p.closed)) warnings.push(`${g.name ?? 'piece'}: open boundary fragment on layer ${extra.layer} kept as internal`), g.internals.push({ pts: extra.pts, closed: false, type: 'internal' });
  for (const extra of closedS.slice(1)) g.internals.push({ pts: extra.pts, closed: true, type: 'seamline' });

  for (const p of s.prims) {
    if (p.k === 'attr') continue;
    const role = roleOf(p.layer, map);
    if (!role || role === 'boundary' || role === 'sew' || role === 'turn' || role === 'curve' || role === 'ignore') continue;
    if (p.k === 'text' && (RULE_RE.test(p.text) || ATTR_RE.test(p.text))) continue;
    if (role in NOTCH_ROLE_TYPE) {
      const type = NOTCH_ROLE_TYPE[role as keyof typeof NOTCH_ROLE_TYPE];
      if (p.k === 'poly' && p.pts.length >= 2) g.notches.push({ kind: 'line', a: p.pts[0], b: p.pts[p.pts.length - 1], type } as RawNotch);
      else if (p.k === 'point') g.notches.push({ kind: 'point', p: p.p, type });
      continue;
    }
    switch (role) {
      case 'grain':
        if (p.k === 'poly' && p.pts.length >= 2) {
          const a = p.pts[0], b = p.pts[p.pts.length - 1];
          if (g.grain) warnings.push(`${g.name ?? 'piece'}: more than one grain line — first kept`);
          else g.grain = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, gradeA: a.grade, gradeB: b.grade };
        }
        break;
      case 'drill':
        if (p.k === 'point') { if (!g.drills.some(d => dist(d.p, p.p) < 1e-6)) g.drills.push({ p: p.p, d: 0, grade: ruleNear(p.p, p.layer) }); }
        else if (p.k === 'circle') {
          const ex = g.drills.find(d => dist(d.p, p.c) < 1e-6);
          if (ex) ex.d = p.r * 2; else g.drills.push({ p: p.c, d: p.r * 2, grade: ruleNear(p.c, p.layer) });
        }
        break;
      case 'text':
        if (p.k === 'text' && p.text.trim()) g.texts.push({ p: p.p, text: p.text, h: p.h, rot: p.rot, grade: ruleNear(p.p, p.layer) });
        break;
      case 'internal': case 'cutout': case 'mirror': case 'alternate': case 'gradeRef': case 'stripe': case 'plaid':
        if (p.k === 'poly' && p.pts.length >= 2) {
          const type = role === 'mirror' ? 'mirror' : role === 'gradeRef' || role === 'stripe' || role === 'plaid' || role === 'alternate' ? 'guide' : 'internal';
          g.internals.push({ pts: p.pts, closed: p.closed, type, mode: role === 'cutout' ? 'cut' : undefined, name: role === 'internal' ? undefined : role });
        } else if (p.k === 'circle') {
          g.internals.push({ pts: sampleArc(p.c, p.r, 0, Math.PI * 2).slice(0, -1).map(q => ({ ...q, curve: true })), closed: true, type: 'internal', mode: role === 'cutout' ? 'cut' : undefined });
        }
        break;
      default: break;
    }
  }
  return g;
}

/** Merge nested-size groups of one piece into a single graded piece (vertex correspondence by index). */
function mergeNested(list: { g: RawGroup; size?: string }[], bopt: BuildOptions, line: SizeLine, warnings: string[], notes: string[], idx: number): Piece | null {
  const baseName = line.sizes.find(s => s.id === line.baseSizeId)!.name;
  const baseEntry = list.find(x => x.size === baseName) ?? list[0];
  const base = buildPiece(baseEntry.g, bopt, warnings, notes, idx);
  if (!base) return null;
  const bs = baseEntry.size ? line.sizes.find(s => s.name === baseEntry.size) : undefined;
  if (bs && bs.id !== line.baseSizeId) warnings.push(`${base.name}: base size ${baseName} missing — using ${bs.name} geometry as base`);
  const abs: Record<SizeId, Piece> = {};
  for (const x of list) {
    if (x === baseEntry) continue;
    const s = line.sizes.find(z => z.name === x.size); if (!s) continue;
    const p = buildPiece(x.g, bopt, [], [], idx); if (p) abs[s.id] = p;
  }
  const absGrade = (getBase: () => Vec, getSize: (p: Piece) => Vec | undefined): Record<SizeId, GradeInc> => {
    const a: Record<SizeId, GradeInc> = {}; const b0 = getBase();
    for (const [sid, p] of Object.entries(abs)) { const q = getSize(p); if (q) a[sid] = { dx: q.x - b0.x, dy: q.y - b0.y }; }
    return absoluteToIncremental(a, line);
  };
  const contours = (p: Piece) => [p.sew, ...p.internals, ...(p.manualCut ? [p.manualCut] : [])];
  const bc = contours(base);
  // correspondence: every vertex by index when counts match; else grade points by grade index (curve
  // points then follow the kernel's proportional rule); else the size cannot be graded
  const gradeOnly = new Set<string>();
  for (const [sid, p] of Object.entries(abs)) {
    const pc = contours(p);
    const ok = pc.length === bc.length && pc.every((c, i) => c.closed === bc[i].closed);
    const gcount = (c: { points: { kind: string }[] }) => c.points.filter(a => a.kind === 'grade').length;
    if (ok && pc.every((c, i) => c.points.length === bc[i].points.length)) continue;
    if (ok && pc.every((c, i) => gcount(c) === gcount(bc[i]))) { gradeOnly.add(sid); continue; }
    warnings.push(`${base.name}: size ${line.sizes.find(s => s.id === sid)!.name} has a different point structure — not graded`); delete abs[sid];
  }
  if (gradeOnly.size) notes.push(`${base.name}: curve point counts differ between sizes — grade points matched, curve points graded proportionally`);
  const gradeOnlyAll = gradeOnly.size > 0;
  bc.forEach((c, ci) => {
    const gIdx = c.points.map((a, i) => (a.kind === 'grade' ? i : -1)).filter(i => i >= 0);
    c.points.forEach((a, ai) => {
      if (gradeOnlyAll) {
        if (a.kind !== 'grade') { a.grade = {}; return; }
        const k = gIdx.indexOf(ai);
        a.grade = absGrade(() => a, p => { const pc = contours(p)[ci]; const gi = pc.points.filter(x => x.kind === 'grade'); return gi[k]; });
      } else a.grade = absGrade(() => a, p => contours(p)[ci].points[ai]);
    });
  });
  base.grain.gradeA = absGrade(() => base.grain.a, p => p.grain.a);
  base.grain.gradeB = absGrade(() => base.grain.b, p => p.grain.b);
  base.drills.forEach((d, i) => { d.grade = absGrade(() => d, p => p.drills[i]); });
  base.texts.forEach((t, i) => { t.grade = absGrade(() => t, p => p.texts[i]); });
  base.notches.forEach((n, i) => {
    if (n.placement.kind !== 'fromPrev') return;
    for (const [sid, p] of Object.entries(abs)) { const o = p.notches[i]; if (o && o.placement.kind === 'fromPrev') n.placement.dist[sid] = o.placement.dist[sid]; }
  });
  return base;
}

/** Remap the grading keys of imported pieces onto a target size line (by size name) and add them to a document. */
export function addImportToDocument(doc: Document, report: ImportReport): Piece[] {
  return doc.transact('Import', s => {
    let table = s.sizeTables.find(t => t.axis1.sizes.length === report.sizeLine.sizes.length && t.axis1.sizes.every((z, i) => z.name === report.sizeLine.sizes[i].name));
    if (!table) { table = JSON.parse(JSON.stringify(report.sizeTable)); s.sizeTables.push(table!); }
    const idMap = new Map(report.sizeLine.sizes.map((z, i) => [z.id, table!.axis1.sizes[i].id]));
    const remap = <T>(r: Record<SizeId, T>) => Object.fromEntries(Object.entries(r).map(([k2, v]) => [idMap.get(k2) ?? k2, v]));
    const out: Piece[] = JSON.parse(JSON.stringify(report.pieces));
    for (const p of out) {
      p.sizeTableId = table!.id;
      for (const c of [p.sew, ...p.internals, ...(p.manualCut ? [p.manualCut] : [])]) for (const a of c.points) a.grade = remap(a.grade);
      p.grain.gradeA = remap(p.grain.gradeA); p.grain.gradeB = remap(p.grain.gradeB);
      for (const d of p.drills) d.grade = remap(d.grade);
      for (const t of p.texts) t.grade = remap(t.grade);
      for (const n of p.notches) if (n.placement.kind === 'fromPrev' || n.placement.kind === 'fromNext') n.placement.dist = remap(n.placement.dist);
      s.pieces.push(p);
    }
    return out;
  });
}

// ═════════════════════════════ export ═════════════════════════════

export interface DXFExportOptions {
  flavor?: 'aama' | 'astm';
  units?: 'mm' | 'in';
  pieceIds?: Id[];
  /** nested graded export: one BLOCK per size (ASTM structure; grading carried by geometry, no .rul) */
  nested?: boolean;
  /** sizes for the nested export (default: all piece sizes) */
  sizes?: SizeId[];
  /** 'none' (default) keeps drafting coordinates; 'pack' lays pieces out left→right so flat AAMA files never overlap */
  layout?: 'none' | 'pack';
  packWidth?: number;
  /** write layer 2/3 turn/curve point markers (default true) */
  pointMarkers?: boolean;
  /** decimals in the file (default mm 6, in 8) */
  precision?: number;
  /** grade-rule table name */
  ruleTableName?: string;
  styleName?: string;
}

export interface DXFExportResult {
  dxf: string;
  /** companion .rul file (present when any exported geometry is graded and nested=false) */
  rul?: string;
  /** rule number → incremental grade, by size id */
  rules: Map<number, Record<SizeId, GradeInc>>;
}

class DxfWriter {
  L: string[] = [];
  constructor(private k: number, private prec: number) {}
  n(v: number) { return fmt(v * this.k, this.prec); }
  g(code: number, v: string | number) { this.L.push(String(code), String(v)); }
  poly(pts: Vec[], layer: string, closed: boolean) {
    this.g(0, 'POLYLINE'); this.g(8, layer); this.g(66, 1); this.g(10, 0); this.g(20, 0); this.g(30, 0); this.g(70, closed ? 1 : 0);
    for (const p of pts) { this.g(0, 'VERTEX'); this.g(8, layer); this.g(10, this.n(p.x)); this.g(20, this.n(p.y)); this.g(30, 0); }
    this.g(0, 'SEQEND'); this.g(8, layer);
  }
  line(a: Vec, b: Vec, layer: string) { this.g(0, 'LINE'); this.g(8, layer); this.g(10, this.n(a.x)); this.g(20, this.n(a.y)); this.g(30, 0); this.g(11, this.n(b.x)); this.g(21, this.n(b.y)); this.g(31, 0); }
  point(p: Vec, layer: string) { this.g(0, 'POINT'); this.g(8, layer); this.g(10, this.n(p.x)); this.g(20, this.n(p.y)); this.g(30, 0); }
  circle(p: Vec, r: number, layer: string) { this.g(0, 'CIRCLE'); this.g(8, layer); this.g(10, this.n(p.x)); this.g(20, this.n(p.y)); this.g(30, 0); this.g(40, this.n(r)); }
  text(p: Vec, h: number, s: string, layer: string, rot = 0) {
    this.g(0, 'TEXT'); this.g(8, layer); this.g(10, this.n(p.x)); this.g(20, this.n(p.y)); this.g(30, 0); this.g(40, this.n(h)); this.g(1, s.replace(/[\r\n]+/g, ' '));
    if (rot) this.g(50, fmt(rot, 6));
  }
}

/** Assigns rule numbers to distinct increments. Rule 1 = zero rule. */
class RuleBook {
  rules = new Map<number, Record<SizeId, GradeInc>>();
  private keys = new Map<string, number>();
  constructor(private line: SizeLine) { this.add(Object.fromEntries(line.sizes.map(s => [s.id, { dx: 0, dy: 0 }]))); }
  add(g: Record<SizeId, GradeInc>): number {
    const full = Object.fromEntries(this.line.sizes.map(s => [s.id, { dx: g[s.id]?.dx ?? 0, dy: g[s.id]?.dy ?? 0 }]));
    const key = this.line.sizes.map(s => `${full[s.id].dx.toFixed(6)},${full[s.id].dy.toFixed(6)}`).join(';');
    const hit = this.keys.get(key); if (hit) return hit;
    const n = this.rules.size + 1; this.rules.set(n, full); this.keys.set(key, n); return n;
  }
  graded() { return this.rules.size > 1; }
}

const isGraded = (g: Record<SizeId, GradeInc> | undefined) => !!g && Object.values(g).some(v => Math.abs(v.dx) > 1e-12 || Math.abs(v.dy) > 1e-12);

export function exportDXF(doc: Document, opt: DXFExportOptions = {}): DXFExportResult {
  const flavor = opt.flavor ?? 'astm';
  const k = opt.units === 'in' ? 1 / 25.4 : 1;
  const prec = opt.precision ?? (opt.units === 'in' ? 8 : 6);
  const pieces = (opt.pieceIds ?? doc.style.pieces.map(p => p.id)).map(id => doc.piece(id));
  const markers = opt.pointMarkers ?? true;
  const line = doc.sizeLine(pieces[0]);
  const book = new RuleBook(line);

  // drawings: [piece][size]
  interface Item { piece: Piece; d: PieceDrawing; sizeName: string; graded: boolean }
  const items: Item[] = [];
  for (const p of pieces) {
    const sizes = opt.nested ? (opt.sizes ?? doc.sizesOf(p)) : [doc.baseSize(p)];
    for (const sid of sizes) items.push({ piece: p, d: drawPiece(doc, p, sid), sizeName: doc.sizeLine(p).sizes.find(s => s.id === sid)?.name ?? sid, graded: !opt.nested });
  }
  if (opt.layout === 'pack') {
    const perPiece = new Map<Id, Item[]>();
    for (const it of items) { const a = perPiece.get(it.piece.id) ?? []; a.push(it); perPiece.set(it.piece.id, a); }
    const groups = [...perPiece.values()];
    const boxes = groups.map(gr => { const bs = gr.map(x => drawingBox(x.d)); return { minX: Math.min(...bs.map(b => b.minX)), minY: Math.min(...bs.map(b => b.minY)), maxX: Math.max(...bs.map(b => b.maxX)), maxY: Math.max(...bs.map(b => b.maxY)) }; });
    const offs = shelfPack(boxes, opt.packWidth ?? 1500);
    groups.forEach((gr, i) => gr.forEach(it => { it.d = translateDrawing(it.d, offs[i]); }));
  }

  const W = new DxfWriter(k, prec);
  W.g(999, `ProwdCAD 2 — ${flavor.toUpperCase()} DXF — units ${opt.units ?? 'mm'} — 1:1, y-up`);
  W.g(0, 'SECTION'); W.g(2, 'HEADER');
  W.g(9, '$ACADVER'); W.g(1, 'AC1009');
  W.g(9, '$INSUNITS'); W.g(70, opt.units === 'in' ? 1 : 4);
  W.g(9, '$MEASUREMENT'); W.g(70, opt.units === 'in' ? 0 : 1);
  W.g(0, 'ENDSEC');

  const pieceBody = (it: Item) => {
    const { piece, d } = it;
    const sewLayer = d.hasSeam ? '14' : '1';
    const ruleText = (p: Vec, g: Record<SizeId, GradeInc> | undefined, layer: string) => {
      if (!it.graded || !isGraded(g)) return;
      W.text(p, 1, `# ${book.add(g!)}`, layer);
    };
    // attributes
    const attrs: [string, string][] = [['Piece Name', piece.name], ['Size', it.sizeName], ['Quantity', String(piece.order.qtyPerBundle)]];
    if (piece.order.material) attrs.push(['Material', piece.order.material]);
    if (piece.description) attrs.push(['Category', piece.description]);
    if (it.graded) attrs.push(['Rule Table', opt.ruleTableName ?? line.name]);
    if (opt.nested) attrs.push(['Sample Size', line.sizes.find(z => z.id === line.baseSizeId)!.name]);
    // ASTM D6673 piece attributes as "Key: value" TEXT on layer 1, stacked from the sew-line bbox centre
    const bb = bbox(d.sew); const c0 = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 + 3 * attrs.length };
    attrs.forEach(([kk, v], i) => W.text({ x: c0.x, y: c0.y - i * 6 }, 3, `${kk}: ${v}`, '1'));
    // boundary + sew
    W.poly(d.cut, '1', true);
    if (d.hasSeam) W.poly(d.sew, '14', true);
    // vertex markers + rules on the sew line (master)
    const r = d.sewResolved;
    const anchorAt = new Map<number, number>(); r.anchorIndex.forEach((pi, ai) => anchorAt.set(pi, ai));
    r.pts.forEach((p, i) => {
      const ai = anchorAt.get(i);
      const a = ai !== undefined ? piece.sew.points[ai] : undefined;
      if (markers) W.point(p, a && a.kind === 'grade' ? '2' : '3');
      if (a) ruleText(p, a.grade, sewLayer);
    });
    // manual cut grading
    if (d.hasSeam && piece.cutMode === 'manual' && piece.manualCut && it.graded) {
      const rc = resolveContour(piece.manualCut, line, d.sizeId);
      rc.anchorIndex.forEach((pi, ai) => ruleText(rc.pts[pi], piece.manualCut!.points[ai].grade, '1'));
    }
    // internals
    d.internals.forEach(ic => {
      const layer = ic.type === 'mirror' ? '6' : ic.contour.mode === 'cut' && ic.closed ? '11' : '8';
      if (ic.pts.length === 2 && !ic.closed) W.line(ic.pts[0], ic.pts[1], layer); else W.poly(ic.pts, layer, ic.closed);
      ic.resolved.anchorIndex.forEach((pi, ai) => ruleText(ic.pts[pi], ic.contour.points[ai].grade, layer));
    });
    if (piece.half) W.line(piece.half.a, piece.half.b, '6');
    // notches
    for (const n of d.notches) {
      const layer = n.type === 'slit' ? '4' : n.type === 'T' ? '80' : n.type === 'castle' ? '81' : n.type === 'V' ? '82' : '83';
      W.line(n.a, n.b, layer);
    }
    // grain
    W.line(d.grain.a, d.grain.b, '7');
    ruleText(d.grain.a, piece.grain.gradeA, '7'); ruleText(d.grain.b, piece.grain.gradeB, '7');
    // drills
    d.drills.forEach((dr, i) => { W.point(dr.p, '13'); if (dr.d > 0) W.circle(dr.p, dr.d / 2, '13'); ruleText(dr.p, piece.drills[i].grade, '13'); });
    // texts
    d.texts.forEach((t, i) => { W.text(t.p, t.size, t.text, '15', t.angleDeg); ruleText(t.p, piece.texts[i].grade, '15'); });
  };

  const blockName = (it: Item, i: number) => `${it.piece.name}${opt.nested ? '_' + it.sizeName : ''}`.replace(/[<>/\\":;?*|=,]/g, '_') + (items.findIndex(x => x !== it && `${x.piece.name}${opt.nested ? '_' + x.sizeName : ''}` === `${it.piece.name}${opt.nested ? '_' + it.sizeName : ''}`) >= 0 ? `_${i}` : '');
  const useBlocks = flavor === 'astm' || opt.nested;
  if (useBlocks) {
    W.g(0, 'SECTION'); W.g(2, 'BLOCKS');
    items.forEach((it, i) => {
      W.g(0, 'BLOCK'); W.g(8, '1'); W.g(2, blockName(it, i)); W.g(70, 0); W.g(10, 0); W.g(20, 0); W.g(30, 0); W.g(3, blockName(it, i));
      pieceBody(it);
      W.g(0, 'ENDBLK'); W.g(8, '1');
    });
    W.g(0, 'ENDSEC');
    W.g(0, 'SECTION'); W.g(2, 'ENTITIES');
    items.forEach((it, i) => { W.g(0, 'INSERT'); W.g(8, '1'); W.g(2, blockName(it, i)); W.g(10, 0); W.g(20, 0); W.g(30, 0); });
    W.g(0, 'ENDSEC');
  } else {
    W.g(0, 'SECTION'); W.g(2, 'ENTITIES');
    W.text({ x: 0, y: 0 }, 3, `Units: ${opt.units === 'in' ? 'ENGLISH' : 'METRIC'}`, '15');
    if (opt.styleName ?? doc.style.name) W.text({ x: 0, y: -6 }, 3, `Style Name: ${opt.styleName ?? doc.style.name}`, '15');
    items.forEach(it => pieceBody(it));
    W.g(0, 'ENDSEC');
  }
  W.g(0, 'EOF');
  const dxf = W.L.join('\r\n') + '\r\n';
  const rul = !opt.nested && book.graded() ? writeRUL(book.rules, line, { units: opt.units, name: opt.ruleTableName ?? line.name, flavor }) : undefined;
  return { dxf, rul, rules: book.rules };
}

