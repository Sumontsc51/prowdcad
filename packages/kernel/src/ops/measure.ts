/**
 * A8 — Measurement & QA.
 *
 * All lengths are measured on the SAME sampled polyline the kernel resolves (`resolveContour`),
 * so measurement, walking and notch placement agree to floating-point precision.
 *
 * Segment convention: a SegRef measures FORWARD in contour order from `from` to `to`
 * (wrapping on closed contours). `reverse:true` measures the other way round (from `from`
 * backwards to `to`). On open contours the direction is implied by the anchor order.
 */
import type { Document } from '../model/doc';
import type { Anchor, Contour, Id, Notch, Piece, SizeId, SizeLine } from '../model/types';
import {
  type ResolvedContour, resolveContour, spanPolyline, totalLength, anchorPositions,
  absoluteToIncremental, incrementalToAbsolute,
} from '../model/contour';
import { type Vec, sub, dist, norm, dot, cross, rotate, angleOf, deg, mul } from '../geom/vec';
import { polylineLength } from '../geom/poly';

// ───────────────────────────── shared helpers ─────────────────────────────

export interface SegRef { pieceId: Id; contourId: Id; from: Id; to: Id; reverse?: boolean }
export type PointRef = { pieceId: Id; anchorId: Id } | Vec;
export type MeasureMode = 'contour' | 'diagonal' | 'x' | 'y';

export const mod = (a: number, m: number) => (m <= 0 ? 0 : ((a % m) + m) % m);

/** Find a contour of a piece by id. `'sew'` is an alias for the sew contour. */
export function findContour(piece: Piece, contourId: Id): Contour {
  if (contourId === 'sew' || contourId === piece.sew.id) return piece.sew;
  const c = piece.internals.find(c => c.id === contourId) ?? (piece.manualCut && piece.manualCut.id === contourId ? piece.manualCut : undefined);
  if (!c) throw new Error(`No contour ${contourId} on piece ${piece.name}`);
  return c;
}

export function anchorIdx(contour: Contour, anchorId: Id): number {
  const i = contour.points.findIndex(a => a.id === anchorId);
  if (i < 0) throw new Error('No anchor ' + anchorId + ' on contour ' + contour.id);
  return i;
}

/** Arc-length position (contour forward order, from pts[0]) of anchor i. */
export const anchorS = (r: ResolvedContour, i: number) => r.cum[r.anchorIndex[i]];

/** Polyline between two anchors (see SegRef convention). */
export function arcPolyline(r: ResolvedContour, ia: number, ib: number, reverse = false): Vec[] {
  if (r.closed) return reverse ? spanPolyline(r, ib, ia).slice().reverse() : spanPolyline(r, ia, ib);
  return ia <= ib ? spanPolyline(r, ia, ib) : spanPolyline(r, ib, ia).slice().reverse();
}

function sizeOrder(doc: Document, piece: Piece): SizeId[] {
  const line = doc.sizeLine(piece);
  const have = new Set(doc.sizesOf(piece));
  return line.sizes.map(s => s.id).filter(id => have.has(id));
}
function sizeName(line: SizeLine, id: SizeId) { return line.sizes.find(s => s.id === id)?.name ?? id; }

interface ResolvedSeg { piece: Piece; contour: Contour; r: ResolvedContour; ia: number; ib: number; poly: Vec[] }
export function resolveSeg(doc: Document, ref: SegRef, sizeId?: SizeId): ResolvedSeg {
  const piece = doc.piece(ref.pieceId);
  const contour = findContour(piece, ref.contourId);
  const r = doc.resolveContour(piece, contour, sizeId);
  const ia = anchorIdx(contour, ref.from), ib = anchorIdx(contour, ref.to);
  return { piece, contour, r, ia, ib, poly: arcPolyline(r, ia, ib, ref.reverse) };
}

function polyValue(poly: Vec[], mode: MeasureMode): number {
  const a = poly[0], b = poly[poly.length - 1];
  switch (mode) {
    case 'contour': return polylineLength(poly);
    case 'diagonal': return dist(a, b);
    case 'x': return Math.abs(b.x - a.x);
    case 'y': return Math.abs(b.y - a.y);
  }
}

/** Value of a segment reference for a size in the given mode. */
export function measureRef(doc: Document, ref: SegRef, mode: MeasureMode = 'contour', sizeId?: SizeId): number {
  return polyValue(resolveSeg(doc, ref, sizeId).poly, mode);
}

// ───────────────────────────── basic measures ─────────────────────────────

/** Length along a contour between two anchors (forward, or backward when reverse). */
export function measureSegment(doc: Document, pieceId: Id, contourId: Id, fromAnchorId: Id, toAnchorId: Id, sizeId?: SizeId, reverse = false): number {
  return measureRef(doc, { pieceId, contourId, from: fromAnchorId, to: toAnchorId, reverse }, 'contour', sizeId);
}

/** Resolved world position of a point reference for a size. */
export function pointPos(doc: Document, ref: PointRef, sizeId?: SizeId): Vec {
  if (!('anchorId' in ref)) return { x: ref.x, y: ref.y };
  const piece = doc.piece(ref.pieceId);
  const hit = doc.findAnchor(piece, ref.anchorId);
  if (!hit) throw new Error('No anchor ' + ref.anchorId);
  const line = doc.sizeLine(piece);
  return anchorPositions(hit.contour.points, line, sizeId ?? line.baseSizeId, hit.contour.closed)[hit.index];
}

export interface XYMeasure { dx: number; dy: number; distance: number; angleDeg: number }
/** Straight measure a→b: dX, dY, distance and direction angle (degrees from +X, CCW, y-up). */
export function measureXY(doc: Document, a: PointRef, b: PointRef, sizeId?: SizeId): XYMeasure {
  const pa = pointPos(doc, a, sizeId), pb = pointPos(doc, b, sizeId);
  const d = sub(pb, pa);
  return { dx: d.x, dy: d.y, distance: Math.hypot(d.x, d.y), angleDeg: deg(angleOf(d)) };
}
export const measureDistance = (doc: Document, a: PointRef, b: PointRef, sizeId?: SizeId) => measureXY(doc, a, b, sizeId).distance;

/** Angle at vertex `v` between rays v→a and v→b: unsigned in [0,180] and signed (CCW positive). */
export function measureAngle(doc: Document, v: PointRef, a: PointRef, b: PointRef, sizeId?: SizeId): { deg: number; signedDeg: number } {
  const pv = pointPos(doc, v, sizeId);
  const u = sub(pointPos(doc, a, sizeId), pv), w = sub(pointPos(doc, b, sizeId), pv);
  const s = deg(Math.atan2(cross(u, w), dot(u, w)));
  return { deg: Math.abs(s), signedDeg: s };
}

/** Angle between two segments (a1→a2) and (b1→b2): unsigned [0,180], signed, and acute line angle [0,90]. */
export function measureSegmentsAngle(doc: Document, a1: PointRef, a2: PointRef, b1: PointRef, b2: PointRef, sizeId?: SizeId): { deg: number; signedDeg: number; lineDeg: number } {
  const u = sub(pointPos(doc, a2, sizeId), pointPos(doc, a1, sizeId));
  const w = sub(pointPos(doc, b2, sizeId), pointPos(doc, b1, sizeId));
  const s = deg(Math.atan2(cross(u, w), dot(u, w)));
  const a = Math.abs(s);
  return { deg: a, signedDeg: s, lineDeg: a > 90 ? 180 - a : a };
}

export interface AcrossSizesRow {
  sizeId: SizeId; sizeName: string;
  /** segment: length (per mode). point: distance from the base-size position */
  value: number;
  /** value − value(base) */
  vsBase: number;
  /** value − value(previous size) (0 for the first size) */
  inc: number;
  /** segment: chord dX/dY (from→to). point: offset from base position */
  dX: number; dY: number;
  /** point only: resolved position */
  x?: number; y?: number;
}

/**
 * Per-size values across the nest. For a segment ref: length per size + chord dX/dY.
 * For a point ref ({pieceId, anchorId}): per-size position and dX/dY from the base size.
 */
export function measureAcrossSizes(doc: Document, q: SegRef | { pieceId: Id; anchorId: Id }, mode: MeasureMode = 'contour'): AcrossSizesRow[] {
  const piece = doc.piece(q.pieceId);
  const line = doc.sizeLine(piece);
  const sizes = sizeOrder(doc, piece);
  const rows: AcrossSizesRow[] = [];
  if ('anchorId' in q) {
    const base = pointPos(doc, q, line.baseSizeId);
    for (const s of sizes) {
      const p = pointPos(doc, q, s);
      rows.push({ sizeId: s, sizeName: sizeName(line, s), value: dist(p, base), vsBase: dist(p, base), inc: 0, dX: p.x - base.x, dY: p.y - base.y, x: p.x, y: p.y });
    }
  } else {
    const baseV = measureRef(doc, q, mode, line.baseSizeId);
    for (const s of sizes) {
      const { poly } = resolveSeg(doc, q, s);
      const v = polyValue(poly, mode);
      const a = poly[0], b = poly[poly.length - 1];
      rows.push({ sizeId: s, sizeName: sizeName(line, s), value: v, vsBase: v - baseV, inc: 0, dX: b.x - a.x, dY: b.y - a.y });
    }
  }
  for (let i = 1; i < rows.length; i++) rows[i].inc = rows[i].value - rows[i - 1].value;
  return rows;
}

// ───────────────────────────── compare lengths ─────────────────────────────

export interface CompareLengthsInput { plus: SegRef[]; minus: SegRef[]; mode?: MeasureMode }
export interface CompareLengthsRow { sizeId: SizeId; sizeName: string; plus: number; minus: number; diff: number; plusParts: number[]; minusParts: number[] }

/** Compare Length calculator: Σplus − Σminus per size (e.g. sleeve cap − (front + back armhole) = ease). */
export function compareLengths(doc: Document, input: CompareLengthsInput): { mode: MeasureMode; sizes: CompareLengthsRow[] } {
  const mode = input.mode ?? 'contour';
  const first = input.plus[0] ?? input.minus[0];
  if (!first) return { mode, sizes: [] };
  const piece = doc.piece(first.pieceId);
  const line = doc.sizeLine(piece);
  const rows = sizeOrder(doc, piece).map(s => {
    const plusParts = input.plus.map(r => measureRef(doc, r, mode, s));
    const minusParts = input.minus.map(r => measureRef(doc, r, mode, s));
    const plus = plusParts.reduce((a, b) => a + b, 0), minus = minusParts.reduce((a, b) => a + b, 0);
    return { sizeId: s, sizeName: sizeName(line, s), plus, minus, diff: plus - minus, plusParts, minusParts };
  });
  return { mode, sizes: rows };
}

// ───────────────────────────── notches & walking check ─────────────────────────────

/**
 * Arc position (contour forward order from pts[0]) of a notch for a size, or undefined if the
 * notch's anchor is not on this contour. Missing per-size distances fall back to the base size.
 * ASSUMPTION: `proportional.pct` is a percentage (0–100) of the grade segment that starts at the anchor.
 */
export function notchArcS(contour: Contour, r: ResolvedContour, notch: Notch, sizeId: SizeId, baseSizeId: SizeId): number | undefined {
  const pl = notch.placement;
  const idx = contour.points.findIndex(a => a.id === pl.anchorId);
  if (idx < 0) return undefined;
  const L = totalLength(r);
  const sA = anchorS(r, idx);
  let s: number;
  switch (pl.kind) {
    case 'anchor': s = sA; break;
    case 'fromPrev': s = sA + (pl.dist[sizeId] ?? pl.dist[baseSizeId] ?? 0); break;
    case 'fromNext': s = sA - (pl.dist[sizeId] ?? pl.dist[baseSizeId] ?? 0); break;
    case 'proportional': {
      const g = r.gradeIdx; const k = g.indexOf(idx);
      let segLen = 0;
      if (k >= 0 && g.length > 0) {
        const nxt = r.closed ? g[(k + 1) % g.length] : g[Math.min(k + 1, g.length - 1)];
        segLen = r.closed ? (nxt === idx ? L : mod(anchorS(r, nxt) - sA, L)) : anchorS(r, nxt) - sA;
      }
      s = sA + (pl.pct / 100) * segLen; break;
    }
  }
  return r.closed ? mod(s, L) : Math.max(0, Math.min(L, s));
}

/** Notches of a piece lying on a segment, as distance from the segment start (in segment direction). */
export function notchesOnSegment(doc: Document, ref: SegRef, sizeId?: SizeId): { notchId: Id; pos: number }[] {
  const seg = resolveSeg(doc, ref, sizeId);
  const line = doc.sizeLine(seg.piece);
  const sid = sizeId ?? line.baseSizeId;
  const L = totalLength(seg.r), segLen = polylineLength(seg.poly);
  const sFrom = anchorS(seg.r, seg.ia);
  const out: { notchId: Id; pos: number }[] = [];
  for (const n of seg.piece.notches) {
    if (n.contourId !== seg.contour.id) continue;
    const s = notchArcS(seg.contour, seg.r, n, sid, line.baseSizeId);
    if (s === undefined) continue;
    let rel: number;
    if (seg.r.closed) {
      rel = ref.reverse ? mod(sFrom - s, L) : mod(s - sFrom, L);
      if (rel > L - 1e-6) rel = 0;
    } else rel = seg.ia <= seg.ib ? s - sFrom : sFrom - s;
    if (rel >= -1e-6 && rel <= segLen + 1e-6) out.push({ notchId: n.id, pos: Math.max(0, rel) });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

export interface WalkingPair {
  a: SegRef; b: SegRef;
  /** pass when |(lenA − lenB) − targetEase| ≤ easeTolerance */
  easeTolerance: number;
  /** expected ease a − b (default 0) */
  targetEase?: number;
  /** max distance between matching notches (mm, default 0.5) */
  notchTolerance?: number;
}
export interface WalkingCheckRow {
  sizeId: SizeId; sizeName: string;
  lengthA: number; lengthB: number;
  /** lengthA − lengthB */
  delta: number;
  pass: boolean;
  notchesA: { notchId: Id; pos: number }[];
  notchesB: { notchId: Id; pos: number }[];
  /** notches on A with no counterpart on B within notchTolerance (and vice versa) */
  unmatchedA: { notchId: Id; pos: number }[];
  unmatchedB: { notchId: Id; pos: number }[];
}

/**
 * Walking check: per pair and size, seam lengths, Δ, pass/fail, and notch mismatch report.
 * Notches are matched by distance from each segment's start (one-to-one, nearest first).
 */
export function walkingCheck(doc: Document, pairs: WalkingPair[]): { pairs: { pass: boolean; sizes: WalkingCheckRow[] }[]; pass: boolean } {
  const out = pairs.map(pair => {
    const piece = doc.piece(pair.a.pieceId);
    const line = doc.sizeLine(piece);
    const tol = pair.notchTolerance ?? 0.5;
    const sizes = sizeOrder(doc, piece).map(s => {
      const lengthA = measureRef(doc, pair.a, 'contour', s), lengthB = measureRef(doc, pair.b, 'contour', s);
      const delta = lengthA - lengthB;
      const notchesA = notchesOnSegment(doc, pair.a, s), notchesB = notchesOnSegment(doc, pair.b, s);
      const usedB = new Set<number>();
      const unmatchedA: { notchId: Id; pos: number }[] = [];
      for (const na of notchesA) {
        let best = -1, bd = Infinity;
        notchesB.forEach((nb, j) => { if (usedB.has(j)) return; const d = Math.abs(nb.pos - na.pos); if (d < bd) { bd = d; best = j; } });
        if (best >= 0 && bd <= tol + 1e-9) usedB.add(best); else unmatchedA.push(na);
      }
      const unmatchedB = notchesB.filter((_, j) => !usedB.has(j));
      const pass = Math.abs(delta - (pair.targetEase ?? 0)) <= pair.easeTolerance + 1e-9 && unmatchedA.length === 0 && unmatchedB.length === 0;
      return { sizeId: s, sizeName: sizeName(line, s), lengthA, lengthB, delta, pass, notchesA, notchesB, unmatchedA, unmatchedB };
    });
    return { pass: sizes.every(r => r.pass), sizes };
  });
  return { pairs: out, pass: out.every(p => p.pass) };
}

// ───────────────────────────── segment length set to ─────────────────────────────

export type LengthSetMethod = 'curveBlend' | 'halfH' | 'halfV' | 'halfDiag' | 'moveEnd';
export interface LengthSetResult { converged: boolean; length: number; param: number; iterations: number }

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** Turn an implicitly (proportionally) graded curve point into explicit grading that reproduces its current positions. */
function materializeGrade(contour: Contour, i: number, line: SizeLine) {
  const a = contour.points[i];
  if (a.kind === 'grade' || Object.keys(a.grade ?? {}).length > 0) return;
  const abs: Record<SizeId, { dx: number; dy: number }> = {};
  for (const s of line.sizes) {
    const p = anchorPositions(contour.points, line, s.id, contour.closed)[i];
    abs[s.id] = { dx: p.x - a.x, dy: p.y - a.y };
  }
  a.gradeAxisDeg = undefined;
  a.grade = absoluteToIncremental(abs, line);
}

/** Move anchor by a world delta for ONE size: base coordinates for the base size, else that size's absolute grading only. */
function shiftAnchor(a: Anchor, line: SizeLine, sizeId: SizeId, d: Vec) {
  if (sizeId === line.baseSizeId) { a.x += d.x; a.y += d.y; return; }
  const local = a.gradeAxisDeg ? rotate(d, -a.gradeAxisDeg * Math.PI / 180) : d;
  const abs = incrementalToAbsolute(a.grade ?? {}, line);
  const cur = abs[sizeId] ?? { dx: 0, dy: 0 };
  abs[sizeId] = { dx: cur.dx + local.x, dy: cur.dy + local.y };
  a.grade = absoluteToIncremental(abs, line);
}

/** Anchor indices strictly between ia and ib following the SegRef direction. */
function interiorIdx(contour: Contour, ia: number, ib: number, reverse: boolean): number[] {
  const n = contour.points.length, out: number[] = [];
  if (!contour.closed) { const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia]; for (let i = lo + 1; i < hi; i++) out.push(i); return out; }
  const step = reverse ? -1 : 1;
  for (let i = mod(ia + step, n), g = 0; i !== ib && g < n; i = mod(i + step, n), g++) out.push(i);
  return out;
}

/** Bracket-then-bisect on g(t) = f(t) − target, with g(0) ≠ 0. */
function solve(f: (t: number) => number, target: number, guess: number, tol = 1e-6): { t: number; value: number; converged: boolean; iterations: number } {
  const g = (t: number) => f(t) - target;
  const g0 = g(0);
  let iterations = 1;
  if (Math.abs(g0) <= tol) return { t: 0, value: f(0), converged: true, iterations };
  const pref = Math.sign(guess) || 1;
  let step = Math.max(Math.abs(guess), 1e-3), hi = NaN, ghi = NaN;
  outer: for (let k = 0; k < 80; k++) {
    for (const sg of [pref, -pref]) {
      const t = sg * step, gv = g(t); iterations++;
      if (Math.abs(gv) <= tol) return { t, value: gv + target, converged: true, iterations };
      if (Math.sign(gv) !== Math.sign(g0)) { hi = t; ghi = gv; break outer; }
    }
    step *= 1.6;
  }
  if (Number.isNaN(hi)) return { t: 0, value: f(0), converged: false, iterations };
  let lo = 0, glo = g0;
  for (let k = 0; k < 200; k++) {
    const m = (lo + hi) / 2, gm = g(m); iterations++;
    if (Math.abs(gm) <= tol || Math.abs(hi - lo) < 1e-12) return { t: m, value: gm + target, converged: Math.abs(gm) <= 1e-3, iterations };
    if (Math.sign(gm) === Math.sign(glo)) { lo = m; glo = gm; } else { hi = m; ghi = gm; }
  }
  void ghi;
  const m = (lo + hi) / 2;
  return { t: m, value: f(m), converged: Math.abs(g(m)) <= 1e-3, iterations };
}

/**
 * Extend / shorten a segment to an exact length (±0.01 mm; the solver targets 1e-6 mm).
 * - moveEnd: end anchor moves along the segment's end tangent.
 * - halfH / halfV / halfDiag: end anchor moves horizontally / vertically / at 45° (sign follows the end tangent).
 * - curveBlend: anchors strictly between the ends (and, at base size, explicit handles) have their
 *   offset from the chord scaled by k = 1 + t; ends stay fixed.
 * With a non-base `sizeId` only that size's absolute grading changes (other sizes untouched).
 * Nothing is written when the solver cannot reach the target.
 */
export function segmentLengthSetTo(doc: Document, pieceId: Id, contourId: Id, fromAnchorId: Id, toAnchorId: Id, target: number, method: LengthSetMethod, sizeId?: SizeId, reverse = false): LengthSetResult {
  const piece = doc.piece(pieceId);
  const line = doc.sizeLine(piece);
  const sid = sizeId ?? line.baseSizeId;
  const isBase = sid === line.baseSizeId;
  const src = findContour(piece, contourId);
  const ia = anchorIdx(src, fromAnchorId), ib = anchorIdx(src, toAnchorId);
  const measure = (c: Contour) => polylineLength(arcPolyline(resolveContour(c, line, sid), ia, ib, reverse));
  const prepared = clone(src);
  const interior = interiorIdx(prepared, ia, ib, reverse);
  if (!isBase) { materializeGrade(prepared, ib, line); if (method === 'curveBlend') for (const i of interior) materializeGrade(prepared, i, line); }

  const r0 = resolveContour(prepared, line, sid);
  const poly0 = arcPolyline(r0, ia, ib, reverse);
  const L0 = polylineLength(poly0);
  const end = poly0[poly0.length - 1];
  let k = poly0.length - 2; while (k > 0 && dist(poly0[k], end) < 1e-9) k--;
  const tEnd = norm(sub(end, poly0[Math.max(k, 0)]));
  const sx = Math.sign(tEnd.x) || 1, sy = Math.sign(tEnd.y) || 1;
  const chordA = r0.anchorPos[ia], chordU = norm(sub(r0.anchorPos[ib], chordA));

  const apply = (c: Contour, t: number) => {
    const P = c.points;
    switch (method) {
      case 'moveEnd': shiftAnchor(P[ib], line, sid, mul(tEnd, t)); break;
      case 'halfH': shiftAnchor(P[ib], line, sid, { x: sx * t, y: 0 }); break;
      case 'halfV': shiftAnchor(P[ib], line, sid, { x: 0, y: sy * t }); break;
      case 'halfDiag': shiftAnchor(P[ib], line, sid, { x: sx * t / Math.SQRT2, y: sy * t / Math.SQRT2 }); break;
      case 'curveBlend': {
        const kf = 1 + t;
        for (const i of interior) {
          const p = r0.anchorPos[i];
          const rel = sub(p, chordA);
          const along = dot(rel, chordU);
          const perpV = sub(rel, mul(chordU, along));
          shiftAnchor(P[i], line, sid, mul(perpV, kf - 1));
        }
        if (isBase) {
          const scaleH = (h: Vec | undefined) => { if (!h) return h; const a = dot(h, chordU); const pp = sub(h, mul(chordU, a)); return { x: chordU.x * a + pp.x * kf, y: chordU.y * a + pp.y * kf }; };
          const outEnd = reverse ? 'hIn' : 'hOut', inEnd = reverse ? 'hOut' : 'hIn';
          P[ia][outEnd] = scaleH(P[ia][outEnd]); P[ib][inEnd] = scaleH(P[ib][inEnd]);
          for (const i of interior) { P[i].hIn = scaleH(P[i].hIn); P[i].hOut = scaleH(P[i].hOut); }
        }
        break;
      }
    }
  };
  const f = (t: number) => { const c = clone(prepared); apply(c, t); return measure(c); };
  const guess = method === 'curveBlend' ? 0.25 * (Math.sign(target - L0) || 1) : target - L0;
  const res = solve(f, target, guess);
  if (!res.converged) return { converged: false, length: L0, param: 0, iterations: res.iterations };
  const final = clone(prepared); apply(final, res.t);
  doc.transact('Segment length set to', () => { findContour(doc.piece(pieceId), contourId).points = final.points; });
  const length = measure(findContour(doc.piece(pieceId), contourId));
  return { converged: Math.abs(length - target) <= 0.01, length, param: res.t, iterations: res.iterations };
}
