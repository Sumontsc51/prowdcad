/**
 * Parametric contour shapers (A5). Applied to the chord between two anchors (from → to, forward) of a
 * contour; they REPLACE the intermediate points with exact Bézier geometry:
 *   arc (by length | radius | depth | through-point), wave, scallop (+zigzag, partial placement),
 * plus generators that create new pieces: circular skirt and ruffle strip.
 *
 * Frame: x along the chord from `from` to `to`, y = OUTWARD normal for a closed (perimeter) contour,
 * left of travel for an open internal. Positive depth bulges outward.
 */
import type { Anchor, Contour, Id, Piece, SizeId, SizeLine } from '../model/types';
import type { Document } from '../model/doc';
import { newId, makePiece, makeContour } from '../model/factory';
import { Vec, add, sub, mul, dist, norm, perp } from '../geom/vec';
import {
  findAnchorIn, idx, between, resolveBase, outwardSign, spanLen, captureNotches, restoreNotches, freeze,
  gradeFromOffsets, sizeIds,
} from '../geom/draft-geom';

// ───────────────────────── local nodes ─────────────────────────

/** A node in chord-local coordinates. hIn/hOut relative. */
interface Node { p: Vec; hIn?: Vec; hOut?: Vec; corner?: boolean }

/**
 * Circular-arc nodes from angle a0 sweeping `sweep` (rad, signed) about c with radius R.
 * ≤ 90° per cubic, and enough cubics that the radial error (≈ 2.7e-4·R·(φ/90°)^6) stays ≤ `tol`.
 */
export function arcNodes(c: Vec, R: number, a0: number, sweep: number, tol = 0.005): Node[] {
  const maxPhi = (Math.PI / 2) * Math.min(1, Math.pow(tol / Math.max(R * 2.7e-4, 1e-12), 1 / 6));
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / maxPhi - 1e-9));
  const k = (4 / 3) * Math.tan(sweep / (4 * n)) * R;
  const out: Node[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    const p = { x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) };
    const t = { x: -Math.sin(a), y: Math.cos(a) };
    out.push({ p, hIn: i > 0 ? mul(t, -k) : undefined, hOut: i < n ? mul(t, k) : undefined });
  }
  return out;
}

/** Circle arc from (0,0) to (C,0) with signed sagitta h (positive = +y). */
function arcBySagitta(C: number, h: number): Node[] {
  if (Math.abs(h) < 1e-9) return [{ p: { x: 0, y: 0 } }, { p: { x: C, y: 0 } }];
  const c = C / 2, R = (c * c + h * h) / (2 * Math.abs(h));
  const sgn = Math.sign(h);
  const cy = h - sgn * R;
  const a0 = Math.atan2(-cy, -c), a1 = Math.atan2(-cy, c);
  // sweep through the apex (c, h): for h>0 clockwise (negative), for h<0 counter-clockwise
  let sweep = a1 - a0;
  if (sgn > 0 && sweep > 0) sweep -= 2 * Math.PI;
  if (sgn < 0 && sweep < 0) sweep += 2 * Math.PI;
  const nodes = arcNodes({ x: c, y: cy }, R, a0, sweep);
  nodes[0].p = { x: 0, y: 0 }; nodes[nodes.length - 1].p = { x: C, y: 0 };
  return nodes;
}

/** Arc length of a circular arc with chord C and sagitta h. */
export function arcLengthFor(C: number, h: number): number {
  if (Math.abs(h) < 1e-12) return C;
  const c = C / 2, R = (c * c + h * h) / (2 * Math.abs(h));
  const half = Math.atan2(c, R - Math.abs(h)); // half the central angle (works past semicircle)
  return 2 * R * half;
}

export type ArcSpec = { depth: number } | { radius: number; major?: boolean; side?: 1 | -1 } | { length: number; side?: 1 | -1 } | { through: Vec };

/** Signed sagitta for an arc spec over chord C (local frame helpers given for the through-point). */
export function solveArcSagitta(C: number, spec: ArcSpec, toLocal?: (p: Vec) => Vec): number {
  if ('depth' in spec) return spec.depth;
  if ('radius' in spec) {
    const R = spec.radius, c = C / 2;
    if (R < c - 1e-9) throw new Error(`Radius ${R} is smaller than half the chord (${c})`);
    const s = Math.sqrt(Math.max(0, R * R - c * c));
    return (spec.side ?? 1) * (spec.major ? R + s : R - s);
  }
  if ('length' in spec) {
    if (spec.length < C - 1e-9) throw new Error('Arc length shorter than the chord');
    let lo = 0, hi = Math.max(C, spec.length);
    while (arcLengthFor(C, hi) < spec.length) hi *= 2;
    for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (arcLengthFor(C, m) < spec.length) lo = m; else hi = m; }
    return (spec.side ?? 1) * (lo + hi) / 2;
  }
  // through point: circle through (0,0), (C,0), P
  const P = toLocal!(spec.through);
  if (Math.abs(P.y) < 1e-9) return 0;
  const cx = C / 2;
  const cy = (P.x * P.x - 2 * cx * P.x + P.y * P.y) / (2 * P.y);
  const R = Math.hypot(cx, cy);
  return P.y > 0 ? cy + R : cy - R;
}

// ───────────────────────── apply ─────────────────────────

interface Frame { A: Vec; ux: Vec; uy: Vec; C: number; contour: Contour; ia: number; ib: number; piece: Piece; line: SizeLine }

function frameOf(doc: Document, pieceId: Id, from: Id, to: Id, side: 1 | -1 = 1): Frame {
  const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
  const { contour, index: ia } = findAnchorIn(piece, from);
  const ib = idx(contour, to);
  const A = { x: contour.points[ia].x, y: contour.points[ia].y }, B = { x: contour.points[ib].x, y: contour.points[ib].y };
  const C = dist(A, B);
  if (C < 1e-9) throw new Error('Zero-length chord');
  const ux = norm(sub(B, A));
  const left = perp(ux);
  const out = contour.closed ? outwardSign(resolveBase(contour, line)) : 1; // left × out = outward
  return { A, ux, uy: mul(left, out * side), C, contour, ia, ib, piece, line };
}
const toWorld = (f: Frame, p: Vec): Vec => add(f.A, add(mul(f.ux, p.x), mul(f.uy, p.y)));
const vecWorld = (f: Frame, v: Vec): Vec => add(mul(f.ux, v.x), mul(f.uy, v.y));
const toLocalF = (f: Frame) => (p: Vec): Vec => { const d = sub(p, f.A); return { x: d.x * f.ux.x + d.y * f.ux.y, y: d.x * f.uy.x + d.y * f.uy.y }; };

/** Replace the anchors strictly between ia and ib with the given local nodes (first/last node = the ends). */
function applyNodes(f: Frame, nodes: Node[]): Id[] {
  const { contour, line, piece } = f;
  const r = resolveBase(contour, line);
  const n = contour.points.length;
  // freeze the outer neighbours' spans
  const before = contour.closed ? (f.ia - 1 + n) % n : f.ia - 1, after = contour.closed ? (f.ib + 1) % n : f.ib + 1;
  for (const k of [before, after, f.ia, f.ib]) if (k >= 0 && k < n && contour.points[k].smooth) freeze(contour, r, k);
  const fromId = contour.points[f.ia].id;
  const removed = new Set(between(contour, f.ia, f.ib).map(i => contour.points[i].id));
  const caps = captureNotches(piece, line, [contour.id]).filter(c => removed.has(c.notch.placement.anchorId) || c.notch.spanEndAnchorId && removed.has(c.notch.spanEndAnchorId));
  contour.points = contour.points.filter(a => !removed.has(a.id));
  const a0 = contour.points[idx(contour, fromId)];
  const ib = (idx(contour, fromId) + 1) % contour.points.length;
  const a1 = contour.points[ib];
  const first = nodes[0], last = nodes[nodes.length - 1];
  a0.smooth = false; a1.smooth = false;
  if (first.hOut) a0.hOut = vecWorld(f, first.hOut); else delete a0.hOut;
  if (last.hIn) a1.hIn = vecWorld(f, last.hIn); else delete a1.hIn;
  const mids: Anchor[] = nodes.slice(1, -1).map(nd => {
    const p = toWorld(f, nd.p);
    const a: Anchor = { id: newId('p'), x: p.x, y: p.y, kind: nd.corner ? 'grade' : 'curve', smooth: !nd.corner, grade: {}, flags: {} };
    if (nd.hIn) a.hIn = vecWorld(f, nd.hIn);
    if (nd.hOut) a.hOut = vecWorld(f, nd.hOut);
    if (nd.corner) { const sa = a0.seamAfter; if (sa !== undefined) a.seamAfter = sa; }
    return a;
  });
  contour.points.splice(idx(contour, fromId) + 1, 0, ...mids);
  restoreNotches(piece, line, caps, 1e3);
  return mids.map(m => m.id);
}

// ───────────────────────── arc ─────────────────────────

/** Replace the run from → to with a circular arc. Returns the resulting arc length. */
export function shapeArc(doc: Document, pieceId: Id, from: Id, to: Id, spec: ArcSpec): number {
  return doc.transact('Arc', () => {
    const f = frameOf(doc, pieceId, from, to);
    const h = solveArcSagitta(f.C, spec, toLocalF(f));
    applyNodes(f, arcBySagitta(f.C, h));
    const r = resolveBase(f.contour, f.line);
    return spanLen(r, idx(f.contour, from), idx(f.contour, to));
  });
}

// ───────────────────────── wave ─────────────────────────

export interface WaveSpec {
  /** number of full waves along the chord */
  count: number;
  /** amplitude (mm) */
  depth: number;
  /** crest skew −1..1: crests shift by deviation × ¼ wavelength towards `to` (0 = sine) */
  deviation?: number;
  /** start with a trough instead of a crest */
  invert?: boolean;
}

export function waveNodes(C: number, w: WaveSpec): Node[] {
  if (w.count < 1) throw new Error('Wave count must be ≥ 1');
  const lambda = C / w.count, dev = Math.max(-0.95, Math.min(0.95, w.deviation ?? 0));
  const amp = (w.invert ? -1 : 1) * w.depth;
  // node x positions per wave: 0, crest, ½, trough, 1 (fractions of λ)
  const fr = [0, 0.25 * (1 + dev), 0.5, 0.5 + 0.25 * (1 + dev), 1];
  const ys = [0, amp, 0, -amp, 0];
  const xs: number[] = [], yv: number[] = [];
  for (let k = 0; k < w.count; k++) for (let q = 0; q < 4; q++) { xs.push((k + fr[q]) * lambda); yv.push(ys[q]); }
  xs.push(C); yv.push(0);
  const nodes: Node[] = [];
  for (let i = 0; i < xs.length; i++) {
    const dxP = i > 0 ? xs[i] - xs[i - 1] : 0, dxN = i < xs.length - 1 ? xs[i + 1] - xs[i] : 0;
    // slope: 0 at crests/troughs; at zero crossings the quarter-sine slope amp·(π/2)/Δx averaged
    let slope = 0;
    if (yv[i] === 0) {
      const sgn = (i < xs.length - 1 ? Math.sign(yv[i + 1]) : -Math.sign(yv[i - 1])) || 1;
      const qx = ((dxP || dxN) + (dxN || dxP)) / 2;
      slope = (sgn * Math.abs(amp) * (Math.PI / 2)) / qx;
    }
    const t = { x: 1, y: slope };
    nodes.push({ p: { x: xs[i], y: yv[i] }, hIn: i > 0 ? mul(t, -dxP / 3) : undefined, hOut: i < xs.length - 1 ? mul(t, dxN / 3) : undefined });
  }
  return nodes;
}

export function shapeWave(doc: Document, pieceId: Id, from: Id, to: Id, spec: WaveSpec): Id[] {
  return doc.transact('Wave', () => { const f = frameOf(doc, pieceId, from, to); return applyNodes(f, waveNodes(f.C, spec)); });
}

// ───────────────────────── scallop ─────────────────────────

export type ScallopPlacement = 'none' | 'start' | 'end' | 'both';
export interface ScallopSpec {
  /** give count OR width; the other is solved */
  count?: number;
  width?: number;
  /** scallop depth (sagitta); default width/2 (semicircles) */
  depth?: number;
  /** where a partial scallop goes when width does not divide the chord: 'none' = stretch to fit */
  partial?: ScallopPlacement;
  zigzag?: boolean;
}
export interface ScallopSolution { count: number; width: number; partialStart: number; partialEnd: number; depth: number }

/**
 * Solve scallop layout over chord C.
 *  - count given → width = C / count (no partials).
 *  - width given, partial 'none' → count = max(1, round(C / width)), width = C / count.
 *  - width given, partial start|end|both → count = floor(C / width) full scallops; the remainder is a
 *    partial scallop at the start, the end, or split equally between both ends.
 */
export function solveScallops(C: number, s: ScallopSpec): ScallopSolution {
  let count: number, width: number, ps = 0, pe = 0;
  if (s.count !== undefined) { count = Math.max(1, Math.round(s.count)); width = C / count; }
  else if (s.width !== undefined) {
    const placement = s.partial ?? 'none';
    if (placement === 'none') { count = Math.max(1, Math.round(C / s.width)); width = C / count; }
    else {
      width = s.width; count = Math.floor(C / width + 1e-9);
      const rem = C - count * width;
      if (rem > 1e-9) { if (placement === 'start') ps = rem; else if (placement === 'end') pe = rem; else { ps = rem / 2; pe = rem / 2; } }
    }
  } else throw new Error('Scallop needs a count or a width');
  return { count, width, partialStart: ps, partialEnd: pe, depth: s.depth ?? width / 2 };
}

/** One full scallop (or zigzag tooth) on [x0, x0+w], clipped to [xa, xb]. Returns nodes (first may be raised: a connector is added). */
function scallopNodes(x0: number, w: number, d: number, zig: boolean, xa: number, xb: number): Node[] {
  if (zig) {
    const pts = [{ x: x0, y: 0 }, { x: x0 + w / 2, y: d }, { x: x0 + w, y: 0 }];
    const yAt = (x: number) => (x <= x0 + w / 2 ? (d * (x - x0)) / (w / 2) : (d * (x0 + w - x)) / (w / 2));
    const out: Node[] = [{ p: { x: xa, y: yAt(xa) }, corner: true }];
    if (pts[1].x > xa + 1e-9 && pts[1].x < xb - 1e-9) out.push({ p: pts[1], corner: true });
    out.push({ p: { x: xb, y: yAt(xb) }, corner: true });
    return out;
  }
  if (d > w / 2 + 1e-9 && (xa > x0 + 1e-9 || xb < x0 + w - 1e-9)) throw new Error('Partial scallops need depth ≤ width/2');
  const c = w / 2, R = (c * c + d * d) / (2 * d), cx = x0 + c, cy = d - R;
  const ang = (x: number) => { const y = cy + Math.sqrt(Math.max(0, R * R - (x - cx) ** 2)); return Math.atan2(y - cy, x - cx); };
  let a0: number, a1: number;
  if (xa <= x0 + 1e-9 && xb >= x0 + w - 1e-9) { a0 = Math.atan2(-cy, -c); a1 = Math.atan2(-cy, c); }
  else { a0 = ang(xa); a1 = ang(xb); }
  let sweep = a1 - a0; if (sweep > 0) sweep -= 2 * Math.PI;
  const nodes = arcNodes({ x: cx, y: cy }, R, a0, sweep);
  nodes[0].corner = true; nodes[nodes.length - 1].corner = true;
  return nodes;
}

export function scallopLocalNodes(C: number, sol: ScallopSolution, zig = false): Node[] {
  const d = sol.depth, w = sol.width;
  const seq: Node[][] = [];
  if (sol.partialStart > 1e-9) seq.push(scallopNodes(sol.partialStart - w, w, d, zig, 0, sol.partialStart));
  for (let k = 0; k < sol.count; k++) { const x0 = sol.partialStart + k * w; seq.push(scallopNodes(x0, w, d, zig, x0, x0 + w)); }
  if (sol.partialEnd > 1e-9) { const x0 = C - sol.partialEnd; seq.push(scallopNodes(x0, w, d, zig, x0, C)); }
  const out: Node[] = [];
  for (const s of seq) {
    if (out.length) {
      const last = out[out.length - 1];
      if (dist(last.p, s[0].p) < 1e-9) { last.hOut = s[0].hOut; last.corner = true; s.shift(); }
    }
    out.push(...s);
  }
  // connectors from the chord ends to raised partial ends
  if (Math.abs(out[0].p.y) > 1e-9) out.unshift({ p: { x: 0, y: 0 }, corner: true });
  if (Math.abs(out[out.length - 1].p.y) > 1e-9) out.push({ p: { x: C, y: 0 }, corner: true });
  out[0].p = { x: 0, y: 0 }; out[out.length - 1].p = { x: C, y: 0 };
  return out;
}

/** Scallop (or zigzag) the run from → to. Returns the solved layout. */
export function shapeScallop(doc: Document, pieceId: Id, from: Id, to: Id, spec: ScallopSpec): ScallopSolution {
  return doc.transact('Scallop', () => {
    const f = frameOf(doc, pieceId, from, to);
    const sol = solveScallops(f.C, spec);
    applyNodes(f, scallopLocalNodes(f.C, sol, spec.zigzag));
    return sol;
  });
}

// ───────────────────────── generators ─────────────────────────

export interface CircularSkirtSpec {
  /** waist (inner arc) length in mm for the whole skirt (base size) */
  waist: number;
  /** skirt length (radial) */
  length: number;
  /** total sweep in degrees (360 = full circle, 180 = half circle …) */
  sweepDeg: number;
  /** number of panels (default: 1 up to 180°, else ceil(sweep/180)) */
  panels?: number;
  name?: string;
  /** optional per-size waist lengths (absolute); other sizes are graded radially */
  waistBySize?: Record<SizeId, number>;
  at?: Vec;
}

/**
 * Circular skirt generator: inner radius r = waist / θ, outer = r + length. Each panel is an annular
 * sector centred on the −y axis (waist up). Returns the new piece ids.
 */
export function circularSkirt(doc: Document, spec: CircularSkirtSpec): Id[] {
  return doc.transact('Circular skirt', style => {
    const theta = (spec.sweepDeg * Math.PI) / 180;
    if (theta <= 0 || theta > 2 * Math.PI + 1e-9) throw new Error('Sweep must be in (0, 360]');
    const panels = spec.panels ?? (spec.sweepDeg <= 180 ? 1 : Math.ceil(spec.sweepDeg / 180));
    const phi = theta / panels;
    if (phi >= 2 * Math.PI - 1e-9) throw new Error('A single panel cannot span 360° — use 2 or more panels');
    const r = spec.waist / theta, R = r + spec.length;
    const tableId = style.activeSizeTableId;
    const line = doc.sizeTable(tableId).axis1;
    const ids: Id[] = [];
    for (let k = 0; k < panels; k++) {
      const a0 = -Math.PI / 2 - phi / 2, a1 = a0 + phi;
      const outer = arcNodes({ x: 0, y: 0 }, R, a0, phi);
      const inner = arcNodes({ x: 0, y: 0 }, r, a1, -phi);
      const mk = (nd: Node, kind: 'grade' | 'curve', radius: number): Anchor => {
        const a: Anchor = { id: newId('p'), x: nd.p.x, y: nd.p.y, kind, smooth: kind === 'curve', grade: {}, flags: {} };
        if (nd.hIn) a.hIn = nd.hIn; if (nd.hOut) a.hOut = nd.hOut;
        if (spec.waistBySize) {
          const off: Record<SizeId, Vec> = {};
          const ang = Math.atan2(nd.p.y, nd.p.x);
          for (const s of sizeIds(line)) {
            const ws = spec.waistBySize[s] ?? spec.waist;
            const rs = ws / theta, rad = radius === r ? rs : rs + spec.length;
            off[s] = sub({ x: rad * Math.cos(ang), y: rad * Math.sin(ang) }, nd.p);
          }
          a.grade = gradeFromOffsets(line, off);
        }
        return a;
      };
      const pts: Anchor[] = [
        ...outer.map((nd, i) => mk(nd, i === 0 || i === outer.length - 1 ? 'grade' : 'curve', R)),
        ...inner.map((nd, i) => mk(nd, i === 0 || i === inner.length - 1 ? 'grade' : 'curve', r)),
      ];
      for (const a of pts) if (a.kind === 'grade') a.smooth = false;
      pts[0].flags.startPoint = true;
      if (spec.at) for (const a of pts) { a.x += spec.at.x; a.y += spec.at.y; }
      const name = (spec.name ?? 'CIRCLE_SKIRT') + (panels > 1 ? `_${k + 1}` : '');
      const p = makePiece(name, makeContour(pts), tableId);
      p.grain = { a: { x: (spec.at?.x ?? 0), y: (spec.at?.y ?? 0) - r - spec.length * 0.2 }, b: { x: (spec.at?.x ?? 0), y: (spec.at?.y ?? 0) - R + spec.length * 0.2 }, gradeA: {}, gradeB: {}, centered: false };
      style.pieces.push(p);
      ids.push(p.id);
    }
    return ids;
  });
}

export interface RuffleSpec {
  /** gathering ratio: strip length = segment length × fullness (e.g. 1.5, 2) */
  fullness: number;
  /** strip width (mm) */
  width: number;
  /** add matching quarter/section notches (count of sections, default 4) */
  sections?: number;
  name?: string;
  at?: Vec;
}

/**
 * Ruffle: a gathered strip generated from a segment's length (segment from → to on a piece).
 * New rectangular piece (length = L × fullness), with section notches on the gathered edge and
 * matching proportional notches on the source segment. Returns the strip piece id.
 */
export function ruffle(doc: Document, pieceId: Id, from: Id, to: Id, spec: RuffleSpec): Id {
  return doc.transact('Ruffle', style => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const { contour, index: ia } = findAnchorIn(piece, from);
    const L = spanLen(resolveBase(contour, line), ia, idx(contour, to));
    const len = L * spec.fullness;
    const at = spec.at ?? { x: 0, y: 0 };
    const pts = [[0, 0], [len, 0], [len, spec.width], [0, spec.width]].map(([x, y], i) => ({ id: newId('p'), x: at.x + x, y: at.y + y, kind: 'grade' as const, smooth: false, grade: {}, flags: i === 0 ? { startPoint: true } : {} }));
    const strip = makePiece(spec.name ?? `${piece.name}_RUFFLE`, makeContour(pts), piece.sizeTableId);
    strip.grain = { a: { x: at.x + len / 2, y: at.y + spec.width * 0.2 }, b: { x: at.x + len / 2, y: at.y + spec.width * 0.8 }, gradeA: {}, gradeB: {}, centered: true };
    const sections = spec.sections ?? 4;
    const notch = (contourId: Id, anchorId: Id, pct: number, spanEnd?: Id) => ({ id: newId('n'), contourId, placement: { kind: 'proportional' as const, anchorId, pct }, type: 'slit' as const, depth: style.settings.notchSetup.slit.depth, width: 0, angleDeg: 0, source: 'manual' as const, ...(spanEnd ? { spanEndAnchorId: spanEnd } : {}) });
    for (let k = 1; k < sections; k++) {
      strip.notches.push(notch(strip.sew.id, pts[0].id, (100 * k) / sections));
      piece.notches.push(notch(contour.id, from, (100 * k) / sections, to));
    }
    style.pieces.push(strip);
    return strip.id;
  });
}

