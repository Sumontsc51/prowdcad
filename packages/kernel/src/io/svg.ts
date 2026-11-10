/**
 * SVG import (paths M/L/H/V/C/S/Q/T/A/Z, rect/circle/ellipse/line/polyline/polygon/text, nested
 * transforms, px→mm by DPI or by the root's physical width/height + viewBox) and SVG export
 * (1:1 mm, one <g> per piece with cut/sew/internal/notch/grain/drill/text sub-groups, optional
 * per-size nest). No DOM: a minimal XML tokenizer is included.
 *
 * Frame: SVG is y-DOWN; the kernel is y-UP. Import negates y (report.yFlipped = true); export
 * writes −y so the drawing looks the same in a browser / Illustrator.
 */
import type { Vec } from '../geom/vec';
import { dist, bbox, add, mul, sub, norm, perp } from '../geom/vec';
import { area, pointInPolygon, distToPolygon } from '../geom/poly';
import { makeSizeLine, makeSizeTable } from '../model/factory';
import type { Document } from '../model/doc';
import type { Id, Piece, SizeId } from '../model/types';
import type { Unit } from '../units';
import { isStraightSpan } from '../model/contour';
import {
  type ImportReport, type RawGroup, type RawPoly, type RawVertex, type PieceDrawing,
  emptyGroup, buildPiece, sampleArc, hostIndex, nearestIndex, looksLikeSewOf, rawPts,
  drawPiece, drawingBox, translateDrawing, shelfPack, fmt, SIZE_PALETTE,
} from './common';

// ═════════════════════════════ tiny XML ═════════════════════════════

export interface XmlNode { tag: string; attrs: Record<string, string>; children: XmlNode[]; text: string }

const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  const l = e.toLowerCase();
  if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'quot') return '"'; if (l === 'apos') return "'";
  return String.fromCodePoint(l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
});

export function parseXML(src: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { stack[stack.length - 1].text += decodeEntities(src.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); stack[stack.length - 1].text += src.slice(lt + 9, e < 0 ? src.length : e); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      // skip PI / DOCTYPE (with an optional internal subset)
      let depth = 0, j = lt + 2;
      for (; j < src.length; j++) { const c = src[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; }
      i = j + 1; continue;
    }
    if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt); const name = src.slice(lt + 2, gt).trim();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === name) { stack.length = k; break; }
      i = gt + 1; continue;
    }
    // start tag: scan respecting quotes
    let j = lt + 1, q = '';
    for (; j < src.length; j++) { const c = src[j]; if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    let body = src.slice(lt + 1, j);
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const m = /^([^\s/>]+)/.exec(body);
    const node: XmlNode = { tag: m ? m[1] : '', attrs: {}, children: [], text: '' };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let a: RegExpExecArray | null;
    const rest = body.slice(m ? m[1].length : 0);
    while ((a = re.exec(rest))) node.attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  return root;
}

const localName = (t: string) => t.includes(':') ? t.split(':').pop()! : t;

// ═════════════════════════════ transforms ═════════════════════════════

type M = [number, number, number, number, number, number]; // a b c d e f  (SVG order: x' = a x + c y + e, y' = b x + d y + f)
const IDM: M = [1, 0, 0, 1, 0, 0];
const mm = (A: M, B: M): M => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
const apply = (T: M, p: Vec): Vec => ({ x: T[0] * p.x + T[2] * p.y + T[4], y: T[1] * p.x + T[3] * p.y + T[5] });
const mScale = (T: M) => Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2]));

export function parseTransform(s: string | undefined): M {
  let T: M = IDM;
  if (!s) return T;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = (m[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    let X: M = IDM;
    switch (m[1]) {
      case 'matrix': if (n.length >= 6) X = [n[0], n[1], n[2], n[3], n[4], n[5]]; break;
      case 'translate': X = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]; break;
      case 'scale': X = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const r = (n[0] ?? 0) * Math.PI / 180, c = Math.cos(r), si = Math.sin(r);
        const R: M = [c, si, -si, c, 0, 0];
        X = n.length >= 3 ? mm(mm([1, 0, 0, 1, n[1], n[2]], R), [1, 0, 0, 1, -n[1], -n[2]]) : R; break;
      }
      case 'skewX': X = [1, 0, Math.tan((n[0] ?? 0) * Math.PI / 180), 1, 0, 0]; break;
      case 'skewY': X = [1, Math.tan((n[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0]; break;
    }
    T = mm(T, X);
  }
  return T;
}

// ═════════════════════════════ path sampler ═════════════════════════════

export interface SubPath { pts: RawVertex[]; closed: boolean }

function cubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, tol: number): Vec[] {
  const L = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
  const n = Math.max(4, Math.min(256, Math.ceil(Math.sqrt(L / tol))));
  const out: Vec[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y });
  }
  return out;
}

/** SVG elliptical arc (endpoint parameterisation, F.6.5) → points after p0, ending exactly at p. */
export function svgArc(p0: Vec, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p: Vec, tol: number): Vec[] {
  if (dist(p0, p) < 1e-12) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 1e-12 || ry < 1e-12) return [{ ...p }];
  const phi = phiDeg * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (p0.x - p.x) / 2, dy = (p0.y - p.y) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den)); if (large === sweep) co = -co;
  const cx1 = co * (rx * y1) / ry, cy1 = co * -(ry * x1) / rx;
  const cx = cp * cx1 - sp * cy1 + (p0.x + p.x) / 2, cy = sp * cx1 + cp * cy1 + (p0.y + p.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  const r = Math.max(rx, ry);
  const step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 4;
  const n = Math.max(2, Math.ceil(Math.abs(dt) / step));
  const out: Vec[] = [];
  for (let i = 1; i <= n; i++) {
    if (i === n) { out.push({ ...p }); break; }
    const t = t1 + dt * (i / n);
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push({ x: cp * ex - sp * ey + cx, y: sp * ex + cp * ey + cy });
  }
  return out;
}

/** Sample an SVG path `d` into sub-paths (local coordinates). Curve-sampled vertices are flagged `curve`. */
export function samplePath(d: string, tol = 0.05, notes?: Set<string>): SubPath[] {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const subs: SubPath[] = [];
  let pts: RawVertex[] | null = null;
  let cur: Vec = { x: 0, y: 0 }, start: Vec = { x: 0, y: 0 };
  let cmd = '', i = 0;
  let prevC: Vec | null = null, prevQ: Vec | null = null;
  const isCmd = (t: string) => /^[A-Za-z]$/.test(t);
  const n = () => { const v = parseFloat(toks[i++]); return Number.isNaN(v) ? 0 : v; };
  const flag = () => { // arc flags may be glued: "a10 10 0 1050 50"
    const t = toks[i];
    if (t === '0' || t === '1') { i++; return t === '1'; }
    if (/^[01]/.test(t)) { toks[i] = t.slice(1); return t[0] === '1'; }
    i++; return parseFloat(t) !== 0;
  };
  const ensure = () => { if (!pts) pts = [{ ...cur }]; };
  const finish = (closed: boolean) => { if (pts && pts.length > 1) subs.push({ pts, closed }); pts = null; };
  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase(); const C = cmd.toUpperCase();
    const P = (x: number, y: number): Vec => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    if (C === 'Z') { if (pts) { if (dist(pts[pts.length - 1], start) < 1e-9 && pts.length > 2) pts.pop(); finish(true); } cur = { ...start }; prevC = prevQ = null; cmd = ''; continue; }
    if (i >= toks.length || isCmd(toks[i])) { continue; }
    switch (C) {
      case 'M': { finish(false); const p = P(n(), n()); cur = p; start = { ...p }; pts = [{ ...p }]; cmd = rel ? 'l' : 'L'; prevC = prevQ = null; break; }
      case 'L': { ensure(); const p = P(n(), n()); pts!.push({ ...p }); cur = p; prevC = prevQ = null; break; }
      case 'H': { ensure(); const x = n(); const p = rel ? { x: cur.x + x, y: cur.y } : { x, y: cur.y }; pts!.push({ ...p }); cur = p; prevC = prevQ = null; break; }
      case 'V': { ensure(); const y = n(); const p = rel ? { x: cur.x, y: cur.y + y } : { x: cur.x, y }; pts!.push({ ...p }); cur = p; prevC = prevQ = null; break; }
      case 'C': case 'S': {
        ensure();
        const c1: Vec = C === 'C' ? P(n(), n()) : prevC ? { x: 2 * cur.x - prevC.x, y: 2 * cur.y - prevC.y } : { ...cur };
        const c2 = P(n(), n()), e = P(n(), n());
        const s = cubic(cur, c1, c2, e, tol);
        s.forEach((q, k) => pts!.push({ ...q, curve: k < s.length - 1 }));
        cur = e; prevC = c2; prevQ = null; break;
      }
      case 'Q': case 'T': {
        ensure();
        const c: Vec = C === 'Q' ? P(n(), n()) : prevQ ? { x: 2 * cur.x - prevQ.x, y: 2 * cur.y - prevQ.y } : { ...cur };
        const e = P(n(), n());
        const c1 = { x: cur.x + (2 / 3) * (c.x - cur.x), y: cur.y + (2 / 3) * (c.y - cur.y) }, c2 = { x: e.x + (2 / 3) * (c.x - e.x), y: e.y + (2 / 3) * (c.y - e.y) };
        const s = cubic(cur, c1, c2, e, tol);
        s.forEach((q, k) => pts!.push({ ...q, curve: k < s.length - 1 }));
        cur = e; prevQ = c; prevC = null; break;
      }
      case 'A': {
        ensure();
        const rx = n(), ry = n(), ph = n(), la = flag(), sw = flag(); const e = P(n(), n());
        const s = svgArc(cur, rx, ry, ph, la, sw, e, tol);
        s.forEach((q, k) => pts!.push({ ...q, curve: k < s.length - 1 }));
        cur = e; prevC = prevQ = null; break;
      }
      default: i++;
    }
  }
  finish(false);
  notes?.add('paths sampled (curves at ' + tol + ' mm chord tolerance)');
  return subs;
}

// ═════════════════════════════ import ═════════════════════════════

export interface SVGImportOptions {
  /** pixels per inch for unit-less / px coordinates (default 96, CSS). Ignored when the root carries mm/cm/in width + viewBox. */
  dpi?: number;
  /** force: user units are mm (1 unit = 1 mm) */
  unitsAreMm?: boolean;
  /** curve sampling chord tolerance (mm, default 0.02) */
  tol?: number;
  /** open paths shorter than this that touch a boundary become notches (mm, default 15) */
  maxNotchLength?: number;
  cornerAngleDeg?: number;
}

const LEN_UNITS: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, q: 0.25 };
function parseLen(s: string | undefined, pxmm: number): { mm: number; unit: string } | null {
  if (!s) return null;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]); const u = m[2].toLowerCase();
  if (u === '%') return null;
  if (!u || u === 'px') return { mm: v * pxmm, unit: 'px' };
  return LEN_UNITS[u] !== undefined ? { mm: v * LEN_UNITS[u], unit: u } : null;
}

type Role = 'cut' | 'sew' | 'internal' | 'notch' | 'grain' | 'drill' | 'text' | 'mirror' | 'label' | undefined;
const ROLE_WORDS: [RegExp, Role][] = [
  [/\b(cut|boundary|outline|perimeter)\b/i, 'cut'], [/\b(sew|seam|stitch)/i, 'sew'], [/\bnotch/i, 'notch'],
  [/\bgrain/i, 'grain'], [/\b(drill|hole)/i, 'drill'], [/\b(text|label|annotation)/i, 'text'], [/\bmirror|fold\b/i, 'mirror'],
  [/\b(internal|inner|marking|line)s?\b/i, 'internal'],
];
function roleFromNode(n: XmlNode): Role {
  const r = n.attrs['data-role'];
  if (r) return r as Role;
  const s = [n.attrs['class'], n.attrs['id'], n.attrs['inkscape:label']].filter(Boolean).join(' ');
  if (!s) return undefined;
  for (const [re, role] of ROLE_WORDS) if (re.test(s)) return role;
  return undefined;
}

interface Shape { role: Role; pts: RawVertex[]; closed: boolean; pieceKey?: string; text?: string; h?: number; rot?: number; circle?: { c: Vec; r: number } }

export function importSVG(text: string, opt: SVGImportOptions = {}): ImportReport {
  const warnings: string[] = [], notesSet = new Set<string>();
  const tol = opt.tol ?? 0.02;
  const root = parseXML(text);
  const svg = findFirst(root, 'svg');
  if (!svg) {
    const line = makeSizeLine(['BASE'], 'BASE');
    return { pieces: [], warnings: ['no <svg> root element'], notes: [], layerMap: {}, unitsDetected: 'mm', unitsSource: 'default', yFlipped: true, sizeLine: line, sizeTable: makeSizeTable(line) };
  }
  // units: root width/height in physical units + viewBox ⇒ exact; else px at dpi
  const dpi = opt.dpi ?? 96;
  const pxmm = 25.4 / dpi;
  let rootT: M = [pxmm, 0, 0, pxmm, 0, 0];
  let unitsSource: ImportReport['unitsSource'] = opt.dpi ? 'option' : 'default';
  const vb = svg.attrs['viewBox']?.trim().split(/[\s,]+/).map(Number);
  const W = parseLen(svg.attrs['width'], pxmm), H = parseLen(svg.attrs['height'], pxmm);
  if (opt.unitsAreMm) { rootT = [1, 0, 0, 1, 0, 0]; unitsSource = 'option'; notesSet.add('1 user unit = 1 mm (forced)'); }
  else if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0 && W && H) {
    const sx = W.mm / vb[2], sy = H.mm / vb[3];
    rootT = [sx, 0, 0, sy, 0, 0]; // scale only: CAD coordinates are kept, the viewBox origin is a viewport concern
    if (W.unit !== 'px') unitsSource = 'header';
    notesSet.add(`viewBox scale ${fmt(sx, 6)} mm/unit (width ${svg.attrs['width']})`);
    if (Math.abs(sx - sy) > 1e-9) warnings.push('non-uniform viewBox scaling (preserveAspectRatio ignored)');
  } else if (vb && vb.length === 4 && W && W.unit !== 'px' && vb[2] > 0) {
    const s = W.mm / vb[2]; rootT = [s, 0, 0, s, 0, 0]; unitsSource = 'header';
  } else notesSet.add(`user units treated as px at ${dpi} dpi (${fmt(pxmm, 6)} mm/px)`);
  // y-flip into the kernel frame
  const flip: M = [1, 0, 0, -1, 0, 0];
  const base = mm(flip, rootT);

  const shapes: Shape[] = [];
  let pieceCounter = 0;
  const walk = (n: XmlNode, T: M, role: Role, pieceKey: string | undefined) => {
    const tag = localName(n.tag);
    if (tag === 'defs' || tag === 'clipPath' || tag === 'mask' || tag === 'symbol' || tag === 'marker' || tag === 'style' || tag === 'metadata' || tag === 'title' || tag === 'desc') return;
    if (n.attrs['display'] === 'none') return;
    const M2 = mm(T, parseTransform(n.attrs['transform']));
    const r = roleFromNode(n) ?? role;
    if (r === 'label') return; // ProwdCAD piece-name labels are regenerated, not imported
    let pk = pieceKey;
    if (tag === 'g' && (n.attrs['data-piece'] || /\bpiece\b/i.test(n.attrs['class'] ?? ''))) pk = `${n.attrs['data-piece'] ?? 'p' + pieceCounter++}|${n.attrs['data-name'] ?? n.attrs['id'] ?? ''}`;
    const X = (p: Vec): RawVertex => apply(M2, p);
    const A = (k: string) => parseFloat(n.attrs[k] ?? '0') || 0;
    const add = (subs: SubPath[]) => { for (const s of subs) shapes.push({ role: r, pts: s.pts.map(v => ({ ...v, ...X(v) })), closed: s.closed, pieceKey: pk }); };
    switch (tag) {
      case 'path': add(samplePath(n.attrs['d'] ?? '', tol / Math.max(mScale(M2), 1e-9), notesSet)); break;
      case 'rect': {
        const x = A('x'), y = A('y'), w = A('width'), h = A('height');
        if (w > 0 && h > 0) {
          const rx = Math.min(parseFloat(n.attrs['rx'] ?? n.attrs['ry'] ?? '0') || 0, w / 2), ry = Math.min(parseFloat(n.attrs['ry'] ?? n.attrs['rx'] ?? '0') || 0, h / 2);
          if (rx > 0 && ry > 0) add(samplePath(`M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`, tol));
          else add([{ pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true }]);
        }
        break;
      }
      case 'circle': case 'ellipse': {
        const cx = A('cx'), cy = A('cy');
        const rx = tag === 'circle' ? A('r') : A('rx'), ry = tag === 'circle' ? A('r') : A('ry');
        if (rx > 0 && ry > 0) {
          const s = mScale(M2);
          if (r === 'drill') { shapes.push({ role: r, pts: [X({ x: cx, y: cy })], closed: false, pieceKey: pk, circle: { c: X({ x: cx, y: cy }), r: rx * s } }); break; }
          const pts = sampleArc({ x: 0, y: 0 }, 1, 0, Math.PI * 2, tol / Math.max(rx, ry) / Math.max(s, 1e-9)).slice(0, -1).map(q => ({ ...X({ x: cx + q.x * rx, y: cy + q.y * ry }), curve: true }));
          shapes.push({ role: r, pts, closed: true, pieceKey: pk, circle: rx === ry ? { c: X({ x: cx, y: cy }), r: rx * s } : undefined });
        }
        break;
      }
      case 'line': add([{ pts: [{ x: A('x1'), y: A('y1') }, { x: A('x2'), y: A('y2') }], closed: false }]); break;
      case 'polyline': case 'polygon': {
        const ns = (n.attrs['points'] ?? '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
        const pts: Vec[] = []; for (let k = 0; k + 1 < ns.length; k += 2) pts.push({ x: ns[k], y: ns[k + 1] });
        if (pts.length >= 2) add([{ pts, closed: tag === 'polygon' }]);
        break;
      }
      case 'text': {
        const txt = collectText(n).trim();
        if (txt) {
          const p = X({ x: A('x'), y: A('y') });
          const fs = parseLen(n.attrs['font-size'] ?? /font-size\s*:\s*([^;]+)/.exec(n.attrs['style'] ?? '')?.[1], 1)?.mm ?? 5;
          const rot = -Math.atan2(M2[1], M2[0]) * 180 / Math.PI;
          shapes.push({ role: r ?? 'text', pts: [p], closed: false, pieceKey: pk, text: txt, h: fs * mScale(M2), rot: Math.abs(rot) < 1e-9 ? 0 : rot });
        }
        return;
      }
      case 'use': warnings.push('<use> elements are not expanded'); break;
      case 'image': warnings.push('<image> ignored'); break;
    }
    for (const c of n.children) walk(c, M2, r, pk);
  };
  walk(svg, base, undefined, undefined);
  if (/transform=/.test(text)) notesSet.add('element transforms applied');

  // ── group into pieces
  const byKey = new Map<string, Shape[]>();
  const loose: Shape[] = [];
  for (const s of shapes) { if (s.pieceKey) { const a = byKey.get(s.pieceKey) ?? []; a.push(s); byKey.set(s.pieceKey, a); } else loose.push(s); }
  const groups: RawGroup[] = [];
  for (const [key, list] of byKey) { const g = shapesToGroup(list, opt, warnings); if (g) { g.name = key.split('|')[1] || g.name; groups.push(g); } }
  if (loose.length) groups.push(...looseToGroups(loose, opt, warnings));

  const line = makeSizeLine(['BASE'], 'BASE');
  const table = makeSizeTable(line, 'Imported');
  const notes: string[] = [...notesSet];
  const pieces: Piece[] = [];
  groups.forEach((g, i) => { const p = buildPiece(g, { line, sizeTableId: table.id, cornerAngleDeg: opt.cornerAngleDeg }, warnings, notes, i); if (p) pieces.push(p); });
  if (!pieces.length) warnings.push('no closed outlines found — nothing imported');
  const layerMap: ImportReport['layerMap'] = {};
  for (const s of shapes) { const k = s.role ?? (s.closed ? 'closed' : 'open'); layerMap[k] = { role: s.role ?? (s.closed ? 'boundary' : 'internal'), entities: (layerMap[k]?.entities ?? 0) + 1 }; }
  const unitsDetected: Unit = 'mm';
  return { pieces, warnings, notes, layerMap, unitsDetected, unitsSource, yFlipped: true, sizeLine: line, sizeTable: table };
}

function findFirst(n: XmlNode, tag: string): XmlNode | undefined {
  if (localName(n.tag) === tag) return n;
  for (const c of n.children) { const f = findFirst(c, tag); if (f) return f; }
  return undefined;
}
function collectText(n: XmlNode): string { return n.text + n.children.map(collectText).join(''); }

/** Shapes known to belong to one piece (exported groups). */
function shapesToGroup(list: Shape[], opt: SVGImportOptions, warnings: string[]): RawGroup | null {
  const g = emptyGroup();
  const closedOf = (role: Role) => list.filter(s => s.role === role && s.closed).sort((a, b) => area(b.pts) - area(a.pts));
  const cut = closedOf('cut')[0], sew = closedOf('sew')[0];
  const fallback = cut || sew ? undefined : list.filter(s => s.closed && !s.role).sort((a, b) => area(b.pts) - area(a.pts))[0];
  if (!cut && !sew && !fallback) return null;
  if (sew) { g.sew = { pts: sew.pts, closed: true }; if (cut) g.cut = { pts: cut.pts, closed: true }; }
  else g.cut = { pts: (cut ?? fallback)!.pts, closed: true };
  for (const s of list) {
    if (s === cut || s === sew || s === fallback) continue;
    switch (s.role) {
      case 'notch': if (s.pts.length >= 2) g.notches.push({ kind: 'line', a: s.pts[0], b: s.pts[s.pts.length - 1] }); break;
      case 'grain': if (s.pts.length >= 2 && !g.grain) g.grain = { a: s.pts[0], b: s.pts[s.pts.length - 1] }; break;
      case 'drill': g.drills.push({ p: s.circle?.c ?? s.pts[0], d: (s.circle?.r ?? 0) * 2 }); break;
      case 'text': if (s.text) g.texts.push({ p: s.pts[0], text: s.text, h: s.h ?? 5, rot: s.rot ?? 0 }); break;
      case 'mirror': g.internals.push({ pts: s.pts, closed: s.closed, type: 'mirror' }); break;
      case 'cut': case 'sew': g.internals.push({ pts: s.pts, closed: s.closed, type: s.role === 'sew' ? 'seamline' : 'internal', mode: s.role === 'cut' ? 'cut' : undefined }); break;
      default:
        if (s.text) g.texts.push({ p: s.pts[0], text: s.text, h: s.h ?? 5, rot: s.rot ?? 0 });
        else if (s.pts.length >= 2) g.internals.push({ pts: s.pts, closed: s.closed, type: 'internal' });
    }
  }
  void opt; void warnings;
  return g;
}

/** Unstructured SVG: closed outlines = pieces (sew lines detected as parallel inner outlines), open = internals / notches. */
function looseToGroups(list: Shape[], opt: SVGImportOptions, warnings: string[]): RawGroup[] {
  const maxNotch = opt.maxNotchLength ?? 15;
  const closed = list.filter(s => s.closed && s.pts.length >= 3 && (!s.role || s.role === 'cut' || s.role === 'sew')).sort((a, b) => area(b.pts) - area(a.pts));
  const outers: Shape[] = [], inners: Shape[] = [];
  for (const s of closed) (outers.some(o => s.pts.every(p => pointInPolygon(p, o.pts))) ? inners : outers).push(s);
  const tiny = outers.filter(o => area(o.pts) < 4);
  if (tiny.length) warnings.push(`${tiny.length} tiny closed path(s) (< 4 mm²) skipped`);
  const hosts = outers.filter(o => area(o.pts) >= 4);
  const polys = hosts.map(h => rawPts(h));
  const groups = hosts.map(h => { const g = emptyGroup(); g.cut = { pts: h.pts, closed: true }; return g; });
  for (const s of inners) {
    const hi = hostIndex(s.pts[0], polys, 0); if (hi < 0) continue;
    const g = groups[hi];
    if (!g.sew && (s.role === 'sew' || looksLikeSewOf(rawPts(s), polys[hi]))) { g.sew = { pts: s.pts, closed: true }; continue; }
    if (s.circle && s.circle.r <= 5) { g.drills.push({ p: s.circle.c, d: s.circle.r * 2 }); continue; }
    g.internals.push({ pts: s.pts, closed: true, type: 'internal' });
  }
  for (const s of list) {
    if (closed.includes(s)) continue;
    if (s.text) { const hi = hostIndex(s.pts[0], polys, 1e9); if (hi >= 0) groups[hi].texts.push({ p: s.pts[0], text: s.text, h: s.h ?? 5, rot: s.rot ?? 0 }); continue; }
    if (s.circle && s.role === 'drill') { const hi = hostIndex(s.circle.c, polys, 50); if (hi >= 0) groups[hi].drills.push({ p: s.circle.c, d: s.circle.r * 2 }); continue; }
    if (s.pts.length < 2) continue;
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    let L = 0; for (let k = 1; k < s.pts.length; k++) L += dist(s.pts[k - 1], s.pts[k]);
    if (s.role === 'notch' || (s.pts.length === 2 && L <= maxNotch)) {
      const hi = nearestIndex(a, polys, 1e9), hb = nearestIndex(b, polys, 1e9);
      const h = hi >= 0 ? hi : hb;
      if (h >= 0 && Math.min(distToPolygon(a, polys[h]), distToPolygon(b, polys[h])) < 0.5) { groups[h].notches.push({ kind: 'line', a, b }); continue; }
    }
    const mid = s.pts[Math.floor(s.pts.length / 2)];
    const hi = hostIndex(s.pts.length === 2 ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : mid, polys, 50);
    if (hi < 0) continue;
    if (s.role === 'grain' && !groups[hi].grain) groups[hi].grain = { a, b };
    else groups[hi].internals.push({ pts: s.pts, closed: false, type: s.role === 'mirror' ? 'mirror' : 'internal' });
  }
  return groups;
}

// ═════════════════════════════ export ═════════════════════════════

export interface SVGExportOptions {
  pieceIds?: Id[];
  /** sizes to draw; more than one ⇒ per-size nest (cut lines of every size overlaid, coloured) */
  sizes?: SizeId[];
  /** 'none' keeps drafting coordinates; 'pack' lays pieces out (default 'pack' when > 1 piece) */
  layout?: 'none' | 'pack';
  packWidth?: number;
  margin?: number;
  /** stroke width in mm (default 0.3) */
  stroke?: number;
  precision?: number;
  /** write sew/internal lines as Bézier C commands from the anchor handles (default true) */
  curves?: boolean;
  /** draw piece name / size labels (default true) */
  labels?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function exportSVG(doc: Document, opt: SVGExportOptions = {}): string {
  const pieces = (opt.pieceIds ?? doc.style.pieces.map(p => p.id)).map(id => doc.piece(id));
  const prec = opt.precision ?? 4;
  const F = (v: number) => fmt(v, prec);
  const P = (p: Vec) => `${F(p.x)},${F(-p.y)}`;
  const sw = opt.stroke ?? 0.3;
  const curves = opt.curves ?? true;
  const margin = opt.margin ?? 10;
  // drawings per piece per size
  const per = pieces.map(p => {
    const sizes = opt.sizes ?? [doc.baseSize(p)];
    return { piece: p, ds: sizes.filter(s => doc.sizesOf(p).includes(s)).map(s => drawPiece(doc, p, s)) };
  }).filter(x => x.ds.length);
  const layout = opt.layout ?? (per.length > 1 ? 'pack' : 'none');
  if (layout === 'pack') {
    const boxes = per.map(x => { const bs = x.ds.map(drawingBox); return { minX: Math.min(...bs.map(b => b.minX)), minY: Math.min(...bs.map(b => b.minY)), maxX: Math.max(...bs.map(b => b.maxX)), maxY: Math.max(...bs.map(b => b.maxY)) }; });
    const offs = shelfPack(boxes, opt.packWidth ?? 1500);
    per.forEach((x, i) => { x.ds = x.ds.map(d => translateDrawing(d, offs[i])); });
  }
  const all = per.flatMap(x => x.ds.flatMap(d => [...d.cut, ...d.sew, d.grain.a, d.grain.b, ...d.texts.map(t => t.p)]));
  const bb = all.length ? bbox(all) : { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const vx = bb.minX - margin, vy = -bb.maxY - margin, vw = bb.maxX - bb.minX + 2 * margin, vh = bb.maxY - bb.minY + 2 * margin;
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${F(vw)}mm" height="${F(vh)}mm" viewBox="${F(vx)} ${F(vy)} ${F(vw)} ${F(vh)}" data-generator="ProwdCAD 2" data-units="mm">`);
  out.push(`<style>.cut{fill:none;stroke:#000;stroke-width:${F(sw)}}.sew{fill:none;stroke:#e07000;stroke-width:${F(sw * 0.8)};stroke-dasharray:${F(sw * 8)} ${F(sw * 4)}}.internal{fill:none;stroke:#0040c0;stroke-width:${F(sw * 0.8)}}.notch{fill:none;stroke:#c00000;stroke-width:${F(sw)}}.grain{fill:none;stroke:#008000;stroke-width:${F(sw)}}.drill{fill:none;stroke:#000;stroke-width:${F(sw * 0.8)}}.text{font-family:Helvetica,Arial,sans-serif;fill:#000}</style>`);
  const polyD = (pts: Vec[], closed: boolean) => 'M' + pts.map(P).join('L') + (closed ? 'Z' : '');
  const contourD = (d: PieceDrawing['sewResolved'], closed: boolean) => {
    if (!curves) return polyD(d.pts, closed);
    const n = d.anchorPos.length;
    let s = 'M' + P(d.anchorPos[0]);
    const spans = closed ? n : n - 1;
    for (let i = 0; i < spans; i++) {
      const j = (i + 1) % n;
      const p0 = d.anchorPos[i], p1 = d.handles[i].hOut, p2 = d.handles[j].hIn, p3 = d.anchorPos[j];
      s += isStraightSpan(p0, p1, p2, p3) ? 'L' + P(p3) : 'C' + P(p1) + ' ' + P(p2) + ' ' + P(p3);
    }
    return s + (closed ? 'Z' : '');
  };
  const nested = (opt.sizes?.length ?? 1) > 1;
  for (const { piece, ds } of per) {
    out.push(`<g class="piece" id="${esc(piece.id)}" data-piece="${esc(piece.id)}" data-name="${esc(piece.name)}">`);
    ds.forEach((d, si) => {
      const color = nested ? (doc.sizeLine(piece).sizes.find(s => s.id === d.sizeId)?.color ?? SIZE_PALETTE[si % SIZE_PALETTE.length]) : undefined;
      const sty = color ? ` style="stroke:${color}"` : '';
      const isBase = d.sizeId === doc.baseSize(piece) || ds.length === 1;
      out.push(`<g class="size" data-size="${esc(d.sizeName)}"${nested ? ` id="${esc(piece.id + '-' + d.sizeName)}"` : ''}>`);
      out.push(`<g class="cut" data-role="cut"><path class="cut" d="${polyD(d.cut, true)}"${sty}/></g>`);
      if (d.hasSeam && (isBase || !nested)) out.push(`<g class="sew" data-role="sew"><path class="sew" d="${contourD(d.sewResolved, true)}"/></g>`);
      if (isBase || !nested) {
        if (d.internals.length) out.push(`<g class="internal" data-role="internal">${d.internals.map(i => `<path class="internal" d="${contourD(i.resolved, i.closed)}"${i.type === 'mirror' ? ' data-role="mirror"' : ''}/>`).join('')}</g>`);
        if (d.notches.length) out.push(`<g class="notch" data-role="notch">${d.notches.map(n => `<path class="notch" d="M${P(n.a)}L${P(n.b)}" data-type="${n.type}"/>`).join('')}</g>`);
        const ga = d.grain.a, gb = d.grain.b, u = norm(sub(gb, ga)), w = perp(u), ah = 6;
        const head = (tip: Vec, dir: Vec) => `M${P(add(add(tip, mul(dir, -ah)), mul(w, ah / 2.5)))}L${P(tip)}L${P(add(add(tip, mul(dir, -ah)), mul(w, -ah / 2.5)))}`;
        out.push(`<g class="grain" data-role="grain"><path class="grain" d="M${P(ga)}L${P(gb)}"/><path class="grain" d="${head(gb, u)}${head(ga, mul(u, -1))}" data-arrow="1"/></g>`);
        if (d.drills.length) out.push(`<g class="drill" data-role="drill">${d.drills.map(x => `<circle class="drill" cx="${F(x.p.x)}" cy="${F(-x.p.y)}" r="${F(Math.max(x.d / 2, 0.5))}"/>`).join('')}</g>`);
        const labels = (opt.labels ?? true) ? [`<text class="label" x="${F((bbox(d.sew).minX + bbox(d.sew).maxX) / 2)}" y="${F(-(bbox(d.sew).minY + bbox(d.sew).maxY) / 2)}" font-size="8" text-anchor="middle">${esc(piece.name)}${nested ? '' : ' — ' + esc(d.sizeName)}</text>`] : [];
        const texts = d.texts.map(t => `<text class="text" x="${F(t.p.x)}" y="${F(-t.p.y)}" font-size="${F(t.size)}"${t.angleDeg ? ` transform="rotate(${F(-t.angleDeg)} ${F(t.p.x)} ${F(-t.p.y)})"` : ''}>${esc(t.text)}</text>`);
        out.push(`<g class="text" data-role="text">${texts.join('')}</g>`);
        if (labels.length) out.push(`<g class="label" data-role="label">${labels.join('')}</g>`);
      }
      out.push('</g>');
    });
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}
