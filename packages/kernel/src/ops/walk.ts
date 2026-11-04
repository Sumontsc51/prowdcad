/**
 * A4 — Walk tool: a pure (DOM-free) state machine. A UI drives it with walkStep/walkTo/flipDirection
 * and renders the moving piece with pieceTransform().
 *
 * Model
 * - Each piece walks along its SEW contour, resolved for one size (state.sizeId). Positions are arc
 *   lengths `s` in contour-forward order from the first sampled point (same polyline the kernel uses
 *   for every length), so walk lengths == measure.ts lengths.
 * - direction 'forward' = increasing contour order, 'backward' = decreasing. A negative step walks back.
 * - The moving piece advances `walkRatio ×` the stationary step (ease / gathering walks).
 * - skipDarts: the arc between a dart's legA and legB (forward from legA, the dart opening on the
 *   sew line) is hopped over at zero length, as if the dart were closed.
 *
 * Transform convention (pieceTransform): world = rotate(p − about, rotateRad) + about + translate,
 * where `about` is the moving contact point in the moving piece's own coordinates and
 * translate = stationaryContact − movingContact. The rotation maps the moving piece's walking
 * tangent onto the stationary piece's walking tangent at the contact points (tangents taken on the
 * contour AHEAD of the contact in walking direction, ~1 mm look-ahead, so corners pivot like hands do).
 */
import type { Document } from '../model/doc';
import type { Contour, Id, Notch, NotchType, Piece, SizeId } from '../model/types';
import { type ResolvedContour, resolveContour, totalLength } from '../model/contour';
import { type Vec, sub, norm, angleOf, rotate, add } from '../geom/vec';
import { pointAtLength } from '../geom/poly';
import { newId } from '../model/factory';
import { anchorIdx, anchorS, mod } from './measure';

export type WalkDirection = 'forward' | 'backward';
export interface WalkOptions {
  skipDarts: boolean;
  /** default step for UI arrow keys (mm) */
  step: number;
  supportNotchType: NotchType;
  /** moving advances walkRatio × stationary (default 1) */
  walkRatio: number;
}
export interface StartWalkInput {
  movingPieceId: Id; movingAnchorId: Id;
  stationaryPieceId: Id; stationaryAnchorId: Id;
  sizeId?: SizeId;
  direction: { moving: WalkDirection; stationary: WalkDirection } | WalkDirection;
  options?: Partial<WalkOptions>;
}

export interface WalkSide {
  pieceId: Id;
  contourId: Id;
  /** +1 forward, −1 backward */
  dir: 1 | -1;
  /** current arc position (contour-forward, from pts[0]) */
  s: number;
  /** signed running length walked along this contour (darts skipped excluded) */
  run: number;
  /** arc intervals [a, b] (forward a→b) skipped when skipDarts */
  skips: [number, number][];
  /** resolved sew contour for state.sizeId (not persisted across transactions; refreshed by refreshWalk) */
  r: ResolvedContour;
}
export interface WalkState {
  sizeId: SizeId;
  options: WalkOptions;
  moving: WalkSide;
  stationary: WalkSide;
  /** current transform of the moving piece */
  transform: PieceTransform;
}
export interface PieceTransform { translate: Vec; rotateRad: number; about: Vec }

const DEFAULTS: WalkOptions = { skipDarts: false, step: 1, supportNotchType: 'slit', walkRatio: 1 };

// ───────────── arc helpers ─────────────

function pointAtS(r: ResolvedContour, s: number): Vec {
  const L = totalLength(r);
  const poly = r.closed ? [...r.pts, r.pts[0]] : r.pts;
  return pointAtLength(poly, r.closed ? mod(s, L) : s).pt;
}

function dartSkips(piece: Piece, r: ResolvedContour): [number, number][] {
  const out: [number, number][] = [];
  for (const d of piece.darts) {
    const ia = piece.sew.points.findIndex(a => a.id === d.legA), ib = piece.sew.points.findIndex(a => a.id === d.legB);
    if (ia < 0 || ib < 0) continue;
    let a = anchorS(r, ia), b = anchorS(r, ib);
    if (!r.closed && a > b) [a, b] = [b, a];
    const width = r.closed ? mod(b - a, totalLength(r)) : b - a;
    if (width > 1e-9) out.push([a, b]);
  }
  return out;
}

/**
 * Move from arc position `s` by `w` mm in arc direction sign(w) (±1), hopping skip intervals.
 * Returns the new position and the length actually consumed (≤ |w| on open contours at an end).
 */
function advance(r: ResolvedContour, skips: [number, number][], s: number, w: number): { s: number; consumed: number } {
  const L = totalLength(r);
  const sg = w >= 0 ? 1 : -1;
  let rem = Math.abs(w), cur = s, consumed = 0;
  for (let guard = 0; guard < 1000 && rem > 0; guard++) {
    // nearest skip entry ahead (distance along walking direction)
    let best = Infinity, exit = cur;
    for (const [a, b] of skips) {
      const entry = sg > 0 ? a : b, ex = sg > 0 ? b : a;
      let d: number;
      if (r.closed) { d = sg > 0 ? mod(entry - cur, L) : mod(cur - entry, L); if (d > L - 1e-9) d = 0; }
      else { d = sg > 0 ? entry - cur : cur - entry; if (d < -1e-9) continue; d = Math.max(0, d); }
      if (d < best) { best = d; exit = ex; }
    }
    if (best < rem) { rem -= best; consumed += best; cur = exit; continue; }
    if (r.closed) { cur = mod(cur + sg * rem, L); consumed += rem; }
    else { const c = Math.max(0, Math.min(L, cur + sg * rem)); consumed += Math.abs(c - cur); cur = c; }
    rem = 0;
  }
  return { s: cur, consumed: sg * consumed };
}

/** Unit walking tangent at s (look-ahead `h` mm along walking direction; look-back at an open end). */
function tangentAt(side: WalkSide, h = 1): Vec {
  const p = pointAtS(side.r, side.s);
  const ahead = advance(side.r, side.skips, side.s, side.dir * h);
  if (Math.abs(ahead.consumed) > 1e-9) return norm(sub(pointAtS(side.r, ahead.s), p));
  const back = advance(side.r, side.skips, side.s, -side.dir * h);
  return norm(sub(p, pointAtS(side.r, back.s)));
}

function computeTransform(st: WalkState): PieceTransform {
  const pm = pointAtS(st.moving.r, st.moving.s), ps = pointAtS(st.stationary.r, st.stationary.s);
  const tm = tangentAt(st.moving), ts = tangentAt(st.stationary);
  let rot = angleOf(ts) - angleOf(tm);
  rot = Math.atan2(Math.sin(rot), Math.cos(rot));
  return { translate: sub(ps, pm), rotateRad: rot, about: pm };
}

function makeSide(doc: Document, pieceId: Id, anchorId: Id, sizeId: SizeId, dir: WalkDirection, skipDarts: boolean): WalkSide {
  const piece = doc.piece(pieceId);
  const r = doc.resolveContour(piece, piece.sew, sizeId);
  const i = anchorIdx(piece.sew, anchorId);
  return { pieceId, contourId: piece.sew.id, dir: dir === 'forward' ? 1 : -1, s: anchorS(r, i), run: 0, skips: skipDarts ? dartSkips(piece, r) : [], r };
}

// ───────────── public API ─────────────

export function startWalk(doc: Document, input: StartWalkInput): WalkState {
  const options: WalkOptions = { ...DEFAULTS, ...(input.options ?? {}) };
  const stat = doc.piece(input.stationaryPieceId);
  const sizeId = input.sizeId ?? doc.baseSize(stat);
  const dirs = typeof input.direction === 'string' ? { moving: input.direction, stationary: input.direction } : input.direction;
  const st: WalkState = {
    sizeId, options,
    moving: makeSide(doc, input.movingPieceId, input.movingAnchorId, sizeId, dirs.moving, options.skipDarts),
    stationary: makeSide(doc, input.stationaryPieceId, input.stationaryAnchorId, sizeId, dirs.stationary, options.skipDarts),
    transform: { translate: { x: 0, y: 0 }, rotateRad: 0, about: { x: 0, y: 0 } },
  };
  st.transform = computeTransform(st);
  return st;
}

/** Re-resolve both contours after the document changed (positions are kept as arc lengths). */
export function refreshWalk(doc: Document, state: WalkState): WalkState {
  const re = (side: WalkSide): WalkSide => {
    const piece = doc.piece(side.pieceId);
    const r = doc.resolveContour(piece, piece.sew, state.sizeId);
    return { ...side, r, skips: state.options.skipDarts ? dartSkips(piece, r) : [] };
  };
  const st = { ...state, moving: re(state.moving), stationary: re(state.stationary) };
  st.transform = computeTransform(st);
  return st;
}

/** Advance by delta mm on the stationary contour (negative = walk back); moving advances delta × walkRatio. */
export function walkStep(state: WalkState, deltaStationaryMm: number = state.options.step): WalkState {
  const step = (side: WalkSide, d: number): WalkSide => {
    if (d === 0) return side;
    const a = advance(side.r, side.skips, side.s, side.dir * d);
    return { ...side, s: a.s, run: side.run + side.dir * a.consumed };
  };
  const st: WalkState = {
    ...state,
    stationary: step(state.stationary, deltaStationaryMm),
    moving: step(state.moving, deltaStationaryMm * state.options.walkRatio),
  };
  st.transform = computeTransform(st);
  return st;
}

/** Walk until the stationary running length equals `distance`. */
export function walkTo(state: WalkState, distance: number): WalkState {
  return walkStep(state, distance - state.stationary.run);
}

/** Reverse the walking direction of one or both pieces mid-walk (running lengths keep counting). */
export function flipDirection(state: WalkState, which: 'moving' | 'stationary' | 'both' = 'moving'): WalkState {
  const flip = (s: WalkSide): WalkSide => ({ ...s, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 });
  const st: WalkState = {
    ...state,
    moving: which !== 'stationary' ? flip(state.moving) : state.moving,
    stationary: which !== 'moving' ? flip(state.stationary) : state.stationary,
  };
  st.transform = computeTransform(st);
  return st;
}

export function setWalkRatio(state: WalkState, ratio: number): WalkState {
  return { ...state, options: { ...state.options, walkRatio: ratio } };
}

export interface WalkReport {
  stationary: number;
  moving: number;
  /** moving − stationary */
  delta: number;
  stationaryPoint: Vec;
  movingPoint: Vec;
}
export function walkReport(state: WalkState): WalkReport {
  return {
    stationary: state.stationary.run, moving: state.moving.run, delta: state.moving.run - state.stationary.run,
    stationaryPoint: pointAtS(state.stationary.r, state.stationary.s),
    movingPoint: pointAtS(state.moving.r, state.moving.s),
  };
}

export function pieceTransform(state: WalkState): PieceTransform { return state.transform; }

/** Apply a walk transform to a point of the moving piece. */
export function applyTransform(t: PieceTransform, p: Vec): Vec {
  return add(rotate(p, t.rotateRad, t.about), t.translate);
}

/**
 * Locate the arc position s on contour (resolved per size) as (preceding grade anchor, distance).
 * "Preceding" is in contour-forward order, matching the fromPrev placement semantics.
 */
function locateFromPrev(contour: Contour, r: ResolvedContour, s: number): { anchor: number; d: number; segLen: number } {
  const L = totalLength(r);
  const g = r.gradeIdx;
  if (g.length === 0) throw new Error('Contour has no grade anchors');
  let best = -1, bd = Infinity;
  for (const gi of g) {
    let d = r.closed ? mod(s - anchorS(r, gi), L) : s - anchorS(r, gi);
    if (r.closed && d > L - 1e-7) d = 0;
    if (d >= -1e-9 && d < bd) { bd = d; best = gi; }
  }
  if (best < 0) { best = g[0]; bd = 0; }
  const k = g.indexOf(best);
  const nxt = r.closed ? g[(k + 1) % g.length] : g[Math.min(k + 1, g.length - 1)];
  let segLen = r.closed ? mod(anchorS(r, nxt) - anchorS(r, best), L) : anchorS(r, nxt) - anchorS(r, best);
  if (r.closed && segLen < 1e-9) segLen = L;
  return { anchor: best, d: Math.max(0, bd), segLen };
}

function lengthOfGradeSegment(contour: Contour, r: ResolvedContour, anchor: number): number {
  const L = totalLength(r), g = r.gradeIdx, k = g.indexOf(anchor);
  const nxt = r.closed ? g[(k + 1) % g.length] : g[Math.min(k + 1, g.length - 1)];
  let segLen = r.closed ? mod(anchorS(r, nxt) - anchorS(r, anchor), L) : anchorS(r, nxt) - anchorS(r, anchor);
  if (r.closed && segLen < 1e-9) segLen = L;
  return segLen;
}

/**
 * Drop walk-support notches at the current contact point(s).
 * Active size: exact fromPrev distance. Other sizes: ASSUMPTION — same proportional position along
 * the grade segment (d_size = d_active × segLen_size / segLen_active), so pieces whose matching seams
 * grade by the same amount keep matching notches in the graded nest.
 * Returns the created notch ids (stationary / moving).
 */
export function dropNotch(doc: Document, state: WalkState, which: 'both' | 'stationary' | 'moving' = 'both'): { stationary?: Id; moving?: Id } {
  const out: { stationary?: Id; moving?: Id } = {};
  const sides: ['stationary' | 'moving', WalkSide][] = [];
  if (which !== 'moving') sides.push(['stationary', state.stationary]);
  if (which !== 'stationary') sides.push(['moving', state.moving]);
  const setup = doc.style.settings.notchSetup[state.options.supportNotchType];
  // compute before mutating
  const plans = sides.map(([key, side]) => {
    const piece = doc.piece(side.pieceId);
    const line = doc.sizeLine(piece);
    const loc = locateFromPrev(piece.sew, side.r, side.s);
    const t = loc.segLen > 1e-12 ? loc.d / loc.segLen : 0;
    const dist: Record<SizeId, number> = {};
    for (const sz of doc.sizesOf(piece)) {
      if (sz === state.sizeId) { dist[sz] = loc.d; continue; }
      const rs = resolveContour(piece.sew, line, sz);
      dist[sz] = t * lengthOfGradeSegment(piece.sew, rs, loc.anchor);
    }
    const notch: Notch = {
      id: newId('n'), contourId: piece.sew.id,
      placement: { kind: 'fromPrev', anchorId: piece.sew.points[loc.anchor].id, dist },
      type: state.options.supportNotchType, depth: setup?.depth ?? 5, width: setup?.width ?? 0,
      angleDeg: 0, mode: setup?.mode, source: 'walk',
    };
    return { key, pieceId: side.pieceId, notch };
  });
  doc.transact('Walk: drop notch', () => {
    for (const p of plans) { doc.piece(p.pieceId).notches.push(p.notch); out[p.key] = p.notch.id; }
  });
  return out;
}
