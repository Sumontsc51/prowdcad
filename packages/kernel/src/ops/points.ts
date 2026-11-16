/**
 * Point tools (A5): add / move / align / angle / round / cleanup / kind & handle editing.
 *
 * All ops are `(doc, …)` and mutate through `doc.transact`. Geometry is resolved fresh (never via
 * the Document cache) so the ops compose inside an outer transaction.
 *
 * Per-size editing: ops that take `sizeId` edit only that size's GRADING (the absolute offset of the
 * anchor for that size), keeping every other size's absolute position; without `sizeId` (or with the
 * base size) the base coordinates move and the grading is carried along (TUKA/Gerber "all sizes").
 */
import type { Anchor, Contour, Id, Piece, SizeId, SizeLine, GradeInc, NotchType } from '../model/types';
import { makeNotch } from './notches';
import { isLockDriven } from './lock';
import type { Document } from '../model/doc';
import { anchorPositions, absoluteOffset, absoluteToIncremental, incrementalToAbsolute } from '../model/contour';
import { Vec, add, sub, mul, dist, norm, len, dot, cross, rotate, angleOf, perp, lerp } from '../geom/vec';
import { signedArea, pointInPolygon } from '../geom/poly';
import { newId } from '../model/factory';
import { layoutToWorld, layoutToLocal, pieceLayout } from './pieces';
import {
  findAnchorIn, contourOf, idx, nextGrade, prevGrade, between, resolveBase, arcS, spanLen, fwd, wrapArc, lengthOf,
  splitAt, promoteToGrade, freeze, positionsBySize, gradeFromOffsets, sizeIds, maxDev, spanPoly, closestArc,
  floatingPlacement, pointAt, jsonClone, notchBasePos,
} from '../geom/draft-geom';

// ───────────────────────── helpers ─────────────────────────

const isBase = (line: SizeLine, sizeId?: SizeId) => !sizeId || sizeId === line.baseSizeId;

/** Absolute per-size offsets of an anchor (materialising interpolated curve-point grading). */
function absOffsets(contour: Contour, line: SizeLine, i: number): Record<SizeId, Vec> {
  const a = contour.points[i];
  const out: Record<SizeId, Vec> = {};
  if (a.kind === 'curve' && Object.keys(a.grade ?? {}).length === 0) {
    const by = positionsBySize(contour, line);
    for (const s of sizeIds(line)) out[s] = sub(by[s][i], by[line.baseSizeId][i]);
    return out;
  }
  const axis = a.gradeAxisDeg ? (a.gradeAxisDeg * Math.PI) / 180 : 0;
  for (const s of sizeIds(line)) out[s] = rotate(absoluteOffset(a.grade, line, s), axis);
  return out;
}

/** Set the absolute offset of one size, keeping the other sizes' absolute offsets (writes world-axis grading). */
export function setSizeOffset(contour: Contour, line: SizeLine, i: number, sizeId: SizeId, off: Vec): void {
  const cur = absOffsets(contour, line, i);
  cur[sizeId] = off;
  const a = contour.points[i];
  a.grade = gradeFromOffsets(line, cur);
  if (a.kind === 'curve' && Object.keys(a.grade).length === 0) { const z: Record<SizeId, GradeInc> = {}; for (const s of sizeIds(line)) z[s] = { dx: 0, dy: 0 }; a.grade = z; }
  delete a.gradeAxisDeg;
}

/** Current position of anchor i for a size (fresh). */
export function anchorAt(contour: Contour, line: SizeLine, i: number, sizeId?: SizeId): Vec {
  return anchorPositions(contour.points, line, sizeId ?? line.baseSizeId, contour.closed)[i];
}

/** Move anchor i by d in one size (grading) or in all sizes (base). Moves point-connected internal anchors too. */
function moveIndex(piece: Piece, contour: Contour, line: SizeLine, i: number, d: Vec, sizeId?: SizeId, followConnections = true): void {
  const a = contour.points[i];
  if (a.flags.locked) throw new Error(`Anchor ${a.id} is locked`);
  if (contour !== piece.sew && isLockDriven(piece, contour.id, a.id)) throw new Error('This point is locked to the sew line (internal line lock) — unlock the line first (right-click ▸ Unlock)');
  if (isBase(line, sizeId)) {
    // a curve point with interpolated grading keeps its per-size positions relative to base
    a.x += d.x; a.y += d.y;
  } else {
    const off = absOffsets(contour, line, i)[sizeId!];
    setSizeOffset(contour, line, i, sizeId!, add(off, d));
  }
  if (followConnections && contour.id === piece.sew.id) {
    for (const pc of piece.connections ?? []) {
      if (pc.externalAnchorId !== a.id) continue;
      const ic = piece.internals.find(c => c.id === pc.internalContourId);
      if (!ic) continue;
      const j = ic.points.findIndex(p => p.id === pc.internalAnchorId);
      // a point driven by its line's lock is re-placed by the lock (after the edit), not by the connection
      if (j >= 0 && !isLockDriven(piece, ic.id, ic.points[j].id)) moveIndex(piece, ic, line, j, d, sizeId, false);
    }
  }
}

function piecesHas(doc: Document, pieceId: Id): Piece { return doc.piece(pieceId); }

// ───────────────────────── add point ─────────────────────────

export interface AddPointOptions {
  /** distance (mm, base size) from the segment start ('prev') or end ('next'); or `pct` 0..100 of the segment */
  distance?: number;
  from?: 'prev' | 'next';
  pct?: number;
  kind?: 'grade' | 'curve';
  /** grading of the new point: 'auto' = proportional interpolation (default) or 'zero' */
  grading?: 'auto' | 'zero';
  name?: string;
}

/**
 * Add a point on the grade segment that LEAVES `segStartAnchorId` (to the next grade anchor), at a
 * distance from its start/end or at a percentage. Geometry is unchanged. Returns the new anchor id.
 */
export function addPointOnSegment(doc: Document, pieceId: Id, segStartAnchorId: Id, o: AddPointOptions): Id {
  return doc.transact('Add point', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index: ia } = findAnchorIn(piece, segStartAnchorId);
    const r = resolveBase(contour, line);
    let ib = nextGrade(contour, ia);
    if (ib < 0) ib = contour.points.length - 1;
    const sA = arcS(r, ia), L = spanLen(r, ia, ib);
    let s: number;
    if (o.pct !== undefined) s = sA + (o.pct / 100) * L;
    else if ((o.from ?? 'prev') === 'prev') s = sA + (o.distance ?? 0);
    else s = sA + L - (o.distance ?? 0);
    if (s < sA - 1e-9 || s > sA + L + 1e-9) throw new Error('Point lies outside the segment');
    const i = splitAt(contour, line, s, { kind: o.kind ?? 'grade', grading: o.grading, piece, name: o.name });
    return contour.points[i].id;
  });
}

// ───────────────────────── cut point (CLO Add Point / Divide Line) ─────────────────────────

export interface CutPointsSpec {
  /** distances (mm, base size) measured from the segment start ('start') or end ('end') */
  distances?: number[];
  from?: 'start' | 'end';
  /** ratios 0..100 % of the segment length, measured from the start */
  pcts?: number[];
  /** divide the segment into N equal parts (inserts N − 1 points) */
  divide?: number;
}

export interface CutPointsOptions extends CutPointsSpec {
  kind?: 'grade' | 'curve';
  /** grading of the new points: 'auto' = proportional (default) or 'zero' */
  grading?: 'auto' | 'zero';
  /** also add a notch on every new point (true = Notch Setup slit defaults) */
  notch?: boolean | { type?: NotchType; depth?: number; width?: number };
  name?: string;
}

/**
 * Distances from the segment start (base mm) of the points a cut-point spec inserts on a segment of
 * length L, sorted ascending; values outside [0, L] throw. Pure: the UI previews with it.
 */
export function cutPointDistances(L: number, o: CutPointsSpec): number[] {
  let d: number[];
  if (o.divide !== undefined) {
    const n = Math.round(o.divide);
    if (!(n >= 2)) throw new Error('Divide: at least 2 parts');
    d = Array.from({ length: n - 1 }, (_, k) => (L * (k + 1)) / n);
  } else if (o.pcts) d = o.pcts.map(p => (p / 100) * L);
  else d = (o.distances ?? []).map(x => ((o.from ?? 'start') === 'start' ? x : L - x));
  for (const x of d) if (!(x >= -1e-9 && x <= L + 1e-9)) throw new Error(`Point lies outside the segment (0 … ${Math.round(L * 1000) / 1000} mm)`);
  return d.map(x => Math.max(0, Math.min(L, x))).sort((a, b) => a - b);
}

/**
 * Cut Point: insert one or more points on the grade segment that LEAVES `segStartAnchorId` (sew or
 * internal contour), at distances from either end, at ratios, or dividing it into N equal parts.
 * The contour shape is unchanged (geometry-preserving split); new points grade proportionally
 * ('auto', default) or not at all ('zero'). Optional notch on each point. One undo step.
 * Returns the new anchor ids in segment order (an existing anchor at the position is reused).
 */
export function addPointsOnSegment(doc: Document, pieceId: Id, segStartAnchorId: Id, o: CutPointsOptions): Id[] {
  return doc.transact('Cut point', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    if (piece.locked) throw new Error('Piece is locked');
    const { contour, index: ia } = findAnchorIn(piece, segStartAnchorId);
    const r = resolveBase(contour, line);
    let ib = nextGrade(contour, ia);
    if (ib < 0) ib = contour.points.length - 1;
    const sA = arcS(r, ia), L = spanLen(r, ia, ib);
    const ds = cutPointDistances(L, o);
    if (!ds.length) throw new Error('No point to add');
    const ids: Id[] = [];
    // geometry-preserving splits: the base arc positions stay valid after each insertion
    for (const d of ds) {
      const i = splitAt(contour, line, sA + d, { kind: o.kind ?? 'grade', grading: o.grading, piece, name: ds.length === 1 ? o.name : undefined });
      const id = contour.points[i].id;
      if (!ids.includes(id)) ids.push(id);
    }
    if (o.notch) {
      const nt = typeof o.notch === 'object' ? o.notch : {};
      for (const id of ids) {
        if (piece.notches.some(n => n.contourId === contour.id && n.placement.kind === 'anchor' && n.placement.anchorId === id)) continue;
        piece.notches.push(makeNotch(doc, piece, { contourId: contour.id, placement: { kind: 'anchor', anchorId: id }, type: nt.type, depth: nt.depth, width: nt.width }));
      }
    }
    return ids;
  });
}

/** Add a point at the contour position closest to `pt` (base). */
export function addPointAt(doc: Document, pieceId: Id, contourId: Id, pt: Vec, kind: 'grade' | 'curve' = 'grade'): Id {
  return doc.transact('Add point', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const contour = contourOf(piece, contourId);
    const s = closestArc(resolveBase(contour, line), pt).s;
    return contour.points[splitAt(contour, line, s, { kind, piece })].id;
  });
}

// ───────────────────────── move ─────────────────────────

/**
 * Make the smooth grade points next to `anchorId` work as a split before that point is moved: the handle on
 * their far side is written out (so the line beyond the grade point keeps its exact shape), the near side stays
 * automatic and follows the move. A side that an earlier call wrote and nobody edited since is released first.
 */
export function holdShapeAcrossGrade(doc: Document, pieceId: Id, anchorId: Id): void {
  doc.transact('Hold shape', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index } = findAnchorIn(piece, anchorId);
    const P = contour.points, n = P.length;
    if (n < 3) return;
    const at = (j: number) => contour.closed ? ((j % n) + n) % n : j < 0 || j >= n ? -1 : j;
    const same = (a?: Vec, b?: Vec) => !!a && !!b && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
    const release = (a: Anchor, side: 'hIn' | 'hOut') => {
      if (!a.hHold?.[side]) return;
      if (same(a[side], a.hHold[side])) delete a[side];
      delete a.hHold[side]; if (!a.hHold.hIn && !a.hHold.hOut) delete a.hHold;
    };
    // the moved point itself becomes automatic again on both sides
    release(P[index], 'hIn'); release(P[index], 'hOut');
    for (const d of [-1, 1] as const) { const j = at(index + d); if (j >= 0 && j !== index) release(P[j], d < 0 ? 'hOut' : 'hIn'); }
    const rc = resolveBase(contour, line);
    for (const d of [-1, 1] as const) {
      const j = at(index + d); if (j < 0 || j === index) continue;
      const a = P[j]; if (a.kind !== 'grade' || !a.smooth) continue;
      const far = d < 0 ? 'hIn' : 'hOut';
      const beyond = at(j + d); if (beyond < 0 || beyond === index || a[far]) continue;
      const hv = sub(rc.handles[j][far], rc.anchorPos[j]);
      a[far] = { ...hv }; (a.hHold ??= {})[far] = { ...hv };
    }
  });
}

export type PointMoveSpec = { dx: number; dy: number } | { x: number; y: number };

/**
 * Move Point XY dialog. `{dx,dy}` = delta, `{x,y}` = absolute target (in the edited size).
 * `sizeId` (non-base) edits only that size's grading; otherwise the base point moves in all sizes.
 */
export function movePoint(doc: Document, pieceId: Id, anchorId: Id, m: PointMoveSpec, o: { sizeId?: SizeId } = {}): void {
  doc.transact('Move point', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    if (piece.locked) throw new Error('Piece is locked');
    const { contour, index } = findAnchorIn(piece, anchorId);
    const cur = anchorAt(contour, line, index, o.sizeId);
    const d = 'dx' in m ? { x: m.dx, y: m.dy } : sub({ x: m.x, y: m.y }, cur);
    moveIndex(piece, contour, line, index, d, o.sizeId);
  });
}

/**
 * Slide an anchor along its contour by an arc distance (positive = contour direction). The contour
 * shape is kept (the anchor is re-inserted on the existing curve, then the old position removed).
 * The anchor keeps its id, flags, name, seam and corner attributes.
 */
export function moveAlongContour(doc: Document, pieceId: Id, anchorId: Id, distance: number): void {
  doc.transact('Move along contour', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index } = findAnchorIn(piece, anchorId);
    const r = resolveBase(contour, line);
    const s0 = arcS(r, index);
    let s = s0 + distance;
    if (!contour.closed) { if (s < 0 || s > lengthOf(r)) throw new Error('Beyond contour end'); }
    s = wrapArc(r, s);
    const old = jsonClone(contour.points[index]);
    const ni = splitAt(contour, line, s, { kind: old.kind, piece, snap: 1e-6 });
    const fresh = contour.points[ni];
    if (fresh.id === old.id) return;
    contour.points.splice(idx(contour, old.id), 1);
    fresh.id = old.id; fresh.flags = { ...old.flags };
    if (old.name) fresh.name = old.name;
    if (old.seamAfter !== undefined) fresh.seamAfter = old.seamAfter; else delete fresh.seamAfter;
    if (old.corner) fresh.corner = old.corner;
    if (old.ruleId) fresh.ruleId = old.ruleId;
  });
}

/**
 * Proportional (blend) move: the anchor moves by `d`; the anchors between it and the fixed ends move
 * by a share proportional to their arc distance from the fixed end. Fixed ends default to the
 * neighbouring grade anchors (the curve points of the run blend); pass explicit ends to blend over
 * a longer run (grade points in between then blend too).
 */
export function moveProportional(doc: Document, pieceId: Id, anchorId: Id, d: Vec, o: { fixedPrevId?: Id; fixedNextId?: Id; sizeId?: SizeId } = {}): void {
  doc.transact('Move proportional', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index: im } = findAnchorIn(piece, anchorId);
    const r = resolveBase(contour, line);
    const ip = o.fixedPrevId ? idx(contour, o.fixedPrevId) : prevGrade(contour, im, false);
    const inx = o.fixedNextId ? idx(contour, o.fixedNextId) : nextGrade(contour, im);
    const moves: [number, Vec][] = [[im, d]];
    if (ip >= 0) {
      const L = fwd(r, arcS(r, ip), arcS(r, im));
      for (const k of between(contour, ip, im)) moves.push([k, mul(d, L > 0 ? fwd(r, arcS(r, ip), arcS(r, k)) / L : 0)]);
    }
    if (inx >= 0) {
      const L = fwd(r, arcS(r, im), arcS(r, inx));
      for (const k of between(contour, im, inx)) moves.push([k, mul(d, L > 0 ? fwd(r, arcS(r, k), arcS(r, inx)) / L : 0)]);
    }
    // moving the base of a curve point with implicit grading is fine; for a size edit materialise first
    for (const [k, v] of moves) moveIndex(piece, contour, line, k, v, o.sizeId);
  });
}

/** Move a set of anchors (possibly on several pieces) in parallel by the same vector. */
export function multiMove(doc: Document, targets: { pieceId: Id; anchorId: Id }[], d: Vec, o: { sizeId?: SizeId } = {}): void {
  doc.transact('Multi move', () => {
    for (const t of targets) {
      const piece = piecesHas(doc, t.pieceId), line = doc.sizeLine(piece);
      const { contour, index } = findAnchorIn(piece, t.anchorId);
      moveIndex(piece, contour, line, index, d, o.sizeId);
    }
  });
}

/**
 * Align anchors to the reference (first id, or `refId`): 'H' = same y, 'V' = same x,
 * `{angleDeg}` = project onto the line through the reference at that angle.
 */
export function alignPoints(doc: Document, pieceId: Id, anchorIds: Id[], mode: 'H' | 'V' | { angleDeg: number }, o: { refId?: Id; sizeId?: SizeId } = {}): void {
  doc.transact('Align points', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const refId = o.refId ?? anchorIds[0];
    const ref = findAnchorIn(piece, refId);
    const R = anchorAt(ref.contour, line, ref.index, o.sizeId);
    const dir = mode === 'H' ? { x: 1, y: 0 } : mode === 'V' ? { x: 0, y: 1 } : { x: Math.cos((mode.angleDeg * Math.PI) / 180), y: Math.sin((mode.angleDeg * Math.PI) / 180) };
    for (const id of anchorIds) {
      if (id === refId) continue;
      const { contour, index } = findAnchorIn(piece, id);
      const P = anchorAt(contour, line, index, o.sizeId);
      const target = add(R, mul(dir, dot(sub(P, R), dir)));
      moveIndex(piece, contour, line, index, sub(target, P), o.sizeId);
    }
  });
}

// ───────────────────────── angle ─────────────────────────

/** Interior angle (degrees, 0..360) at a grade anchor between the chords to its neighbouring grade anchors. */
export function cornerAngle(doc: Document, pieceId: Id, anchorId: Id, sizeId?: SizeId): number {
  const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
  const { contour, index } = findAnchorIn(piece, anchorId);
  const pos = anchorPositions(contour.points, line, sizeId ?? line.baseSizeId, contour.closed);
  const { u, w } = cornerDirs(contour, pos, index);
  const ccw = contour.closed ? signedArea(pos) > 0 : true;
  return ccwAngle(ccw ? w : u, ccw ? u : w);
}
function ccwAngle(from: Vec, to: Vec): number {
  let a = (Math.atan2(cross(from, to), dot(from, to)) * 180) / Math.PI;
  if (a < 0) a += 360; return a;
}
/** u = direction to the previous neighbour anchor, w = direction to the next neighbour anchor */
function cornerDirs(contour: Contour, pos: Vec[], i: number): { u: Vec; w: Vec; ip: number; inx: number } {
  const n = pos.length;
  const ip = contour.closed ? (i - 1 + n) % n : i - 1;
  const inx = contour.closed ? (i + 1) % n : i + 1;
  if (ip < 0 || inx >= n) throw new Error('Anchor has no neighbour on both sides');
  return { u: norm(sub(pos[ip], pos[i])), w: norm(sub(pos[inx], pos[i])), ip, inx };
}

/**
 * Force the interior corner angle at a grade anchor by rotating the NEXT segment (all anchors up to
 * and including the next grade anchor) about the point. `sizeId` (non-base) edits only that size's
 * grading. Returns the rotation applied (degrees, CCW).
 */
export function setAngle(doc: Document, pieceId: Id, anchorId: Id, angleDeg: number, o: { sizeId?: SizeId } = {}): number {
  return doc.transact('Set angle', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index } = findAnchorIn(piece, anchorId);
    const sid = o.sizeId ?? line.baseSizeId;
    const pos = anchorPositions(contour.points, line, sid, contour.closed);
    const { u, w } = cornerDirs(contour, pos, index);
    const ccw = contour.closed ? signedArea(pos) > 0 : true;
    const cur = ccw ? ccwAngle(w, u) : ccwAngle(u, w);
    // CCW polygon: interior = ccw angle w→u; increasing it means rotating w clockwise
    const rotDeg = ccw ? cur - angleDeg : angleDeg - cur;
    const rad = (rotDeg * Math.PI) / 180;
    const P = pos[index];
    const ng = nextGrade(contour, index);
    const run = [...between(contour, index, ng < 0 ? contour.points.length - 1 : ng), ...(ng >= 0 ? [ng] : [])];
    for (const k of run) {
      const target = rotate(pos[k], rad, P);
      moveIndex(piece, contour, line, k, sub(target, pos[k]), o.sizeId, true);
      const a = contour.points[k];
      if (isBase(line, o.sizeId)) { if (a.hIn) a.hIn = rotate(a.hIn, rad); if (a.hOut) a.hOut = rotate(a.hOut, rad); }
    }
    const a = contour.points[index];
    if (isBase(line, o.sizeId) && a.hOut) a.hOut = rotate(a.hOut, rad);
    return rotDeg;
  });
}

// ───────────────────────── round corner ─────────────────────────

/**
 * Radius fillet: replace a corner by two grade points (tangent points) joined by a circular arc
 * (one cubic per ≤ 90° of sweep, extra curve point when the sweep exceeds 90°; error < 0.003·r).
 * The adjacent spans must be straight near the corner and long enough for the tangent length.
 * Returns the ids of the two tangent anchors.
 */
export function roundCorner(doc: Document, pieceId: Id, anchorId: Id, radius: number): [Id, Id] {
  return doc.transact('Round corner', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index } = findAnchorIn(piece, anchorId);
    if (radius <= 0) throw new Error('Radius must be positive');
    const r = resolveBase(contour, line);
    const P = r.anchorPos[index];
    const n = contour.points.length;
    const ip = contour.closed ? (index - 1 + n) % n : index - 1, inx = contour.closed ? (index + 1) % n : index + 1;
    if (ip < 0 || inx >= n) throw new Error('Cannot round an open-contour end');
    // tangent directions at the corner from the sampled polyline
    const before = spanPoly(r, ip, index), after = spanPoly(r, index, inx);
    const u = norm(sub(before[before.length - 2], P)), w = norm(sub(after[1], P));
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(u, w)))); // corner opening angle
    if (theta < 1e-6 || Math.PI - theta < 1e-6) throw new Error('No corner to round');
    const t = radius / Math.tan(theta / 2);
    const sP = arcS(r, index);
    if (t > spanLen(r, ip, index) + 1e-9 || t > spanLen(r, index, inx) + 1e-9) throw new Error('Radius too large for the adjacent segments');
    const corner = jsonClone(contour.points[index]);
    // insert tangent points (geometry-preserving, auto grading) – after first, before second
    const i2 = splitAt(contour, line, sP + t, { kind: 'grade', piece });
    const id2 = contour.points[i2].id;
    const r2 = resolveBase(contour, line);
    const i1 = splitAt(contour, line, arcS(r2, idx(contour, corner.id)) - t, { kind: 'grade', piece });
    const id1 = contour.points[i1].id;
    const T1 = contour.points[i1], T2 = contour.points[idx(contour, id2)];
    // arc geometry
    const sweep = Math.PI - theta;
    const bis = norm(add(u, w));
    const C = add(P, mul(bis, radius / Math.sin(theta / 2)));
    const pieces = sweep > Math.PI / 2 + 1e-9 ? 2 : 1;
    const k = (4 / 3) * Math.tan(sweep / (4 * pieces)) * radius;
    T1.hOut = mul(u, -k); T1.smooth = false; delete T1.hIn;
    T2.hIn = mul(w, -k); T2.smooth = false; delete T2.hOut;
    T1.seamAfter = corner.seamAfter; T2.seamAfter = corner.seamAfter;
    const ci = idx(contour, corner.id);
    const repl: Anchor[] = [];
    if (pieces === 2) {
      const M = add(C, mul(bis, -radius));
      const tang = norm(sub(T2, T1));
      repl.push({ id: newId('p'), x: M.x, y: M.y, kind: 'curve', smooth: true, hIn: mul(tang, -k), hOut: mul(tang, k), grade: {}, flags: {} });
    }
    contour.points.splice(ci, 1, ...repl);
    // re-anchor live references to the removed corner
    for (const nt of piece.notches) {
      if (nt.contourId !== contour.id) continue;
      if (nt.placement.anchorId === corner.id) nt.placement = { ...nt.placement, anchorId: nt.placement.kind === 'fromNext' ? id2 : id1 } as typeof nt.placement;
      if (nt.spanEndAnchorId === corner.id) nt.spanEndAnchorId = id2;
    }
    piece.connections = piece.connections.filter(c => c.externalAnchorId !== corner.id);
    if (corner.flags.startPoint) T1.flags.startPoint = true;
    return [id1, id2];
  });
}

// ───────────────────────── spline support / cleanup ─────────────────────────

/** Insert `count` curve points evenly (by arc length) between two anchors of a contour. Returns their ids. */
export function addSplineSupportPoints(doc: Document, pieceId: Id, fromAnchorId: Id, toAnchorId: Id, count: number): Id[] {
  return doc.transact('Add spline support points', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index: ia } = findAnchorIn(piece, fromAnchorId);
    const r = resolveBase(contour, line);
    const ib = idx(contour, toAnchorId);
    const sA = arcS(r, ia), L = spanLen(r, ia, ib);
    const targets: Vec[] = [];
    for (let k = 1; k <= count; k++) targets.push(pointAt(r, sA + (L * k) / (count + 1)).pt);
    const ids: Id[] = [];
    for (const q of targets) {
      const rr = resolveBase(contour, line);
      const i = splitAt(contour, line, closestArc(rr, q).s, { kind: 'curve', piece });
      ids.push(contour.points[i].id);
    }
    return ids;
  });
}

function referencedIds(piece: Piece): Set<Id> {
  const s = new Set<Id>();
  for (const n of piece.notches) { s.add(n.placement.anchorId); if (n.spanEndAnchorId) s.add(n.spanEndAnchorId); }
  for (const d of piece.darts) { s.add(d.legA); s.add(d.legB); }
  for (const p of piece.pleats) for (const e of p.edges ?? []) { s.add(e.fixed); s.add(e.moving); if (e.mid) s.add(e.mid); }
  for (const c of piece.connections) { s.add(c.externalAnchorId); s.add(c.internalAnchorId); }
  for (const f of piece.fullness ?? []) { for (const id of f.slashAnchorIds) s.add(id); for (const id of f.insertedIds ?? []) s.add(id); if ('anchorId' in f.pivot) s.add(f.pivot.anchorId); }
  return s;
}

/**
 * Strip redundant points (typically from imports): removes non-protected anchors whose removal keeps
 * the contour within `tol` (default 0.05 mm) of its ORIGINAL geometry. Protected: grade points
 * (unless `includeGrade`), start point, notch/dart/pleat/connection anchors, flagged anchors.
 * Returns the number of points removed.
 */
export function pointsCleanup(doc: Document, pieceId: Id, o: { contourId?: Id; tol?: number; includeGrade?: boolean } = {}): number {
  return doc.transact('Points cleanup', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const tol = o.tol ?? 0.05;
    const refs = referencedIds(piece);
    const contours = o.contourId ? [contourOf(piece, o.contourId)] : [piece.sew, ...piece.internals];
    let removed = 0;
    for (const contour of contours) {
      const orig = resolveBase(contour, line);
      const origPos = new Map<Id, number>();
      contour.points.forEach((a, i) => origPos.set(a.id, i));
      const origPts = orig;
      const protectedA = (a: Anchor, i: number) =>
        (a.kind === 'grade' && !o.includeGrade) || a.flags.startPoint || a.flags.dartLeg || a.flags.pleatEdge || a.flags.notchAnchor || a.flags.locked || a.flags.derived || refs.has(a.id) ||
        (!contour.closed && (i === 0 || i === contour.points.length - 1));
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < contour.points.length; i++) {
          const a = contour.points[i];
          if (protectedA(a, i)) continue;
          if (contour.points.length <= (contour.closed ? 3 : 2)) break;
          const n = contour.points.length;
          // window of anchors whose spans can change (CR depends on two neighbours each side)
          const w0 = contour.closed ? (i - 2 + n) % n : Math.max(0, i - 2);
          const w1 = contour.closed ? (i + 2) % n : Math.min(n - 1, i + 2);
          const idA = contour.points[w0].id, idB = contour.points[w1].id;
          const saved = contour.points.splice(i, 1)[0];
          const promoted = saved.kind === 'grade';
          const rNew = resolveBase(contour, line);
          const nA = idx(contour, idA), nB = idx(contour, idB);
          const newPoly = spanPoly(rNew, nA, nB);
          const oA = origPos.get(idA)!, oB = origPos.get(idB)!;
          const oldPoly = spanPoly(origPts, oA, oB);
          const dev = Math.max(maxDev(newPoly, oldPoly), maxDev(oldPoly, newPoly));
          if (dev <= tol && !(promoted && saved.seamAfter !== undefined && saved.seamAfter !== prevSeam(contour, i))) { removed++; changed = true; i--; }
          else contour.points.splice(i, 0, saved);
        }
      }
    }
    return removed;
  });
}
function prevSeam(contour: Contour, i: number): number | undefined {
  const pg = prevGrade(contour, (i - 1 + contour.points.length) % contour.points.length, true);
  return pg >= 0 ? contour.points[pg].seamAfter : undefined;
}

// ───────────────────────── delete / kind / handles / start ─────────────────────────

/** Delete an anchor. Live objects anchored on it are re-anchored (notches) or the op is refused (darts/pleats). */
export function deletePoint(doc: Document, pieceId: Id, anchorId: Id): void {
  doc.transact('Delete point', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index } = findAnchorIn(piece, anchorId);
    const a = contour.points[index];
    if (a.flags.dartLeg || a.flags.pleatEdge || piece.darts.some(d => d.legA === anchorId || d.legB === anchorId)) throw new Error('Point belongs to a dart/pleat — delete the live object first');
    if (contour.points.length <= (contour.closed ? 3 : 2)) throw new Error('Contour would become degenerate');
    // positions of notches referencing the anchor, before deletion
    const r = resolveBase(contour, line);
    const affected = piece.notches.filter(n => n.contourId === contour.id && (n.placement.anchorId === anchorId || n.spanEndAnchorId === anchorId));
    const notchPos = new Map<Id, Vec>();
    for (const n of affected) notchPos.set(n.id, notchBasePos(r, contour, n, line));
    contour.points.splice(index, 1);
    if (a.flags.startPoint && contour.closed) contour.points[index % contour.points.length].flags.startPoint = true;
    for (const n of affected) {
      delete n.spanEndAnchorId;
      const rr = resolveBase(contour, line);
      const q = closestArc(rr, notchPos.get(n.id)!).pt;
      n.placement = floatingPlacement(contour, line, q);
    }
    piece.connections = piece.connections.filter(c => c.externalAnchorId !== anchorId && c.internalAnchorId !== anchorId);
  });
}

/** Toggle grade ⇄ curve. grade→curve drops grading/seam/corner (point follows its neighbours); curve→grade materialises its current grading. */
export function togglePointKind(doc: Document, pieceId: Id, anchorId: Id): 'grade' | 'curve' {
  return doc.transact('Toggle point kind', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index } = findAnchorIn(piece, anchorId);
    const a = contour.points[index];
    if (a.kind === 'curve') { promoteToGrade(contour, line, index); return 'grade'; }
    if (a.flags.dartLeg || a.flags.pleatEdge || a.flags.startPoint) throw new Error('This grade point cannot become a curve point');
    a.kind = 'curve'; a.grade = {}; delete a.seamAfter; delete a.corner; delete a.ruleId; delete a.gradeAxisDeg;
    return 'curve';
  });
}

/**
 * True when anchor `anchorId` is a curve point WITHOUT its own grading: in graded sizes it is placed
 * proportionally between its neighbouring grade points, so it visibly "follows" them when they move.
 */
export function curvePointFollows(piece: Piece, anchorId: Id): boolean {
  const { anchor: a } = findAnchorIn(piece, anchorId);
  return a.kind === 'curve' && Object.keys(a.grade ?? {}).length === 0;
}

/**
 * Pin (keep position) / unpin curve points.
 *
 * pin = true: each curve point that follows its neighbours gets explicit grading equal to its current
 * per-size position (zeros included), so a later move of a neighbouring grade point (base or any size)
 * no longer moves it in any size. Its base position never changed anyway.
 * pin = false: the explicit grading is dropped and the point follows its neighbours again.
 * Grade points are ignored. Returns the number of points changed (one undo step).
 */
export function pinCurvePoints(doc: Document, pieceId: Id, anchorIds: Id[], pin = true): number {
  return doc.transact(pin ? 'Pin curve points' : 'Unpin curve points', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    let n = 0;
    for (const id of anchorIds) {
      const { contour, index } = findAnchorIn(piece, id);
      const a = contour.points[index];
      if (a.kind !== 'curve') continue;
      const follows = Object.keys(a.grade ?? {}).length === 0;
      if (pin && follows) {
        const by = positionsBySize(contour, line);
        const z: Record<SizeId, GradeInc> = {};
        const off: Record<SizeId, Vec> = {};
        for (const s of sizeIds(line)) off[s] = sub(by[s][index], by[line.baseSizeId][index]);
        const g = gradeFromOffsets(line, off);
        if (Object.keys(g).length) a.grade = g;
        else { for (const s of sizeIds(line)) z[s] = { dx: 0, dy: 0 }; a.grade = z; }
        delete a.gradeAxisDeg;
        n++;
      } else if (!pin && !follows) { a.grade = {}; delete a.gradeAxisDeg; n++; }
    }
    return n;
  });
}

/** Smooth (tangent-continuous) vs corner. Turning smooth on aligns explicit handles (keeps their lengths). */
export function setSmooth(doc: Document, pieceId: Id, anchorId: Id, smooth: boolean): void {
  doc.transact('Set smooth', () => {
    const piece = piecesHas(doc, pieceId);
    const { anchor: a } = findAnchorIn(piece, anchorId);
    a.smooth = smooth;
    if (smooth && a.hIn && a.hOut) alignHandles(a);
  });
}
function alignHandles(a: Anchor) {
  const li = len(a.hIn!), lo = len(a.hOut!);
  const dir = norm(sub(a.hOut!, a.hIn!));
  if (len(dir) < 1e-12) return;
  a.hIn = mul(dir, -li); a.hOut = mul(dir, lo);
}

/** "V": make both handles explicit & independent (corner), frozen at their current resolved shape. */
export function breakHandle(doc: Document, pieceId: Id, anchorId: Id): void {
  doc.transact('Break handle', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index } = findAnchorIn(piece, anchorId);
    const r = resolveBase(contour, line);
    const n = contour.points.length;
    // freeze the neighbours too so changing this point's smoothness does not alter their spans
    for (const k of [index, contour.closed ? (index - 1 + n) % n : index - 1, contour.closed ? (index + 1) % n : index + 1]) if (k >= 0 && k < n) freeze(contour, r, k);
    contour.points[index].smooth = false;
  });
}
/** Re-join handles: smooth, collinear handles (keeping lengths). */
export function joinHandle(doc: Document, pieceId: Id, anchorId: Id): void {
  doc.transact('Join handle', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    const { contour, index } = findAnchorIn(piece, anchorId);
    const a = contour.points[index];
    if (!a.hIn || !a.hOut) freeze(contour, resolveBase(contour, line), index);
    a.smooth = true; alignHandles(a);
  });
}

// ───────────────────────── one curve per line (two handles) ─────────────────────────

/** A line between two points seen as ONE cubic curve: the two handles that control it (absolute, base, piece-local). */
export interface SegmentCurve {
  from: Id; to: Id; p0: Vec; p3: Vec; h0: Vec; h3: Vec;
  /** points in between that the curve replaces (0 = the line already is one curve) */
  between: number;
  /** largest distance between the present shape and the single curve */
  dev: number;
  length: number;
}
const bez = (p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec => {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
};
const bezPoly = (p0: Vec, p1: Vec, p2: Vec, p3: Vec, n = 48): Vec[] => Array.from({ length: n + 1 }, (_, k) => bez(p0, p1, p2, p3, k / n));
const polyLen = (q: Vec[]) => { let L = 0; for (let k = 1; k < q.length; k++) L += dist(q[k - 1], q[k]); return L; };
/**
 * Least-squares cubic through a polyline with fixed end points (Schneider, with re-parameterisation).
 * `free` = the end tangents are free too (closest shape); otherwise they keep the directions t0 / t3.
 */
function fitCubic(q: Vec[], t0: Vec, t3: Vec, free: boolean): { h0: Vec; h3: Vec } {
  const p0 = q[0], p3 = q[q.length - 1];
  const chord = dist(p0, p3);
  const u: number[] = [0]; for (let k = 1; k < q.length; k++) u.push(u[k - 1] + dist(q[k - 1], q[k]));
  const L = u[u.length - 1] || 1; for (let k = 0; k < u.length; k++) u[k] /= L;
  const lo = chord * 1e-3, hi = Math.max(chord, L) * 2;
  const solve = (): { h0: Vec; h3: Vec } | null => {
    if (free) {
      let s11 = 0, s12 = 0, s22 = 0; const r1 = { x: 0, y: 0 }, r2 = { x: 0, y: 0 };
      for (let k = 0; k < q.length; k++) {
        const t = u[k], m = 1 - t, b0 = m * m * m, b1 = 3 * m * m * t, b2 = 3 * m * t * t, b3 = t * t * t;
        const tmp = sub(q[k], add(mul(p0, b0), mul(p3, b3)));
        s11 += b1 * b1; s12 += b1 * b2; s22 += b2 * b2; r1.x += b1 * tmp.x; r1.y += b1 * tmp.y; r2.x += b2 * tmp.x; r2.y += b2 * tmp.y;
      }
      const det = s11 * s22 - s12 * s12; if (Math.abs(det) < 1e-12) return null;
      const h0 = { x: (r1.x * s22 - r2.x * s12) / det, y: (r1.y * s22 - r2.y * s12) / det }, h3 = { x: (s11 * r2.x - s12 * r1.x) / det, y: (s11 * r2.y - s12 * r1.y) / det };
      if (dist(h0, p0) > hi || dist(h3, p3) > hi) return null;
      return { h0, h3 };
    }
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let k = 0; k < q.length; k++) {
      const t = u[k], m = 1 - t, b0 = m * m * m, b1 = 3 * m * m * t, b2 = 3 * m * t * t, b3 = t * t * t;
      const a1 = mul(t0, b1), a2 = mul(t3, b2);
      const tmp = sub(q[k], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
      c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2); x0 += dot(a1, tmp); x1 += dot(a2, tmp);
    }
    const det = c00 * c11 - c01 * c01; if (Math.abs(det) < 1e-12) return null;
    const al = (x0 * c11 - x1 * c01) / det, ar = (c00 * x1 - c01 * x0) / det;
    if (!(al > lo) || !(ar > lo) || al > hi || ar > hi) return null;
    return { h0: add(p0, mul(t0, al)), h3: add(p3, mul(t3, ar)) };
  };
  let best = solve() ?? { h0: add(p0, mul(t0, L / 3)), h3: add(p3, mul(t3, L / 3)) };
  for (let it = 0; it < 10; it++) {
    // Newton step of every sample's parameter towards its closest point on the current curve
    const { h0, h3 } = best;
    for (let k = 1; k < q.length - 1; k++) {
      const t = u[k], m = 1 - t;
      const b = bez(p0, h0, h3, p3, t);
      const d1 = add(add(mul(sub(h0, p0), 3 * m * m), mul(sub(h3, h0), 6 * m * t)), mul(sub(p3, h3), 3 * t * t));
      const d2 = add(mul(add(sub(h3, mul(h0, 2)), p0), 6 * m), mul(add(sub(p3, mul(h3, 2)), h0), 6 * t));
      const e = sub(b, q[k]); const den = dot(d1, d1) + dot(e, d2);
      if (Math.abs(den) > 1e-12) u[k] = Math.max(0, Math.min(1, t - dot(e, d1) / den));
    }
    const nx = solve(); if (!nx) break; best = nx;
  }
  return best;
}
function segIdx(contour: Contour, fromId: Id, toId: Id): { i: number; j: number; mid: number[] } {
  const n = contour.points.length, i = idx(contour, fromId), j = idx(contour, toId);
  if (i < 0 || j < 0 || i === j) throw new Error('Pick a line between two points');
  if (!contour.closed && j < i) throw new Error('Pick the line in its own direction');
  const mid: number[] = [];
  for (let k = (i + 1) % n; k !== j; k = (k + 1) % n) mid.push(k);
  return { i, j, mid };
}
/** The two handles that control the line from → to as one curve (fitted when the line has points in between). */
export function segmentCurve(piece: Piece, line: SizeLine, contourId: Id, fromId: Id, toId: Id): SegmentCurve {
  const contour = contourOf(piece, contourId);
  const { i, j, mid } = segIdx(contour, fromId, toId);
  const r = resolveBase(contour, line);
  const p0 = r.anchorPos[i], p3 = r.anchorPos[j];
  const q = spanPoly(r, i, j);
  let h0 = r.handles[i].hOut, h3 = r.handles[j].hIn;
  if (mid.length) {
    const dirOr = (h: Vec, p: Vec, fb: Vec) => { const v = sub(h, p); return len(v) > 1e-6 ? norm(v) : norm(fb); };
    const t0 = dirOr(h0, p0, sub(q[Math.min(1, q.length - 1)], p0)), t3 = dirOr(h3, p3, sub(q[Math.max(0, q.length - 2)], p3));
    // keep the end directions when that is close enough; otherwise the closest single curve
    const devOf = (f: { h0: Vec; h3: Vec }) => { const cv = bezPoly(p0, f.h0, f.h3, p3); return Math.max(maxDev(cv, q), maxDev(q, cv)); };
    const kept = fitCubic(q, t0, t3, false); const dk = devOf(kept);
    let pick = kept;
    if (dk > 0.2) { const fr = fitCubic(q, t0, t3, true); if (devOf(fr) < dk * 0.7) pick = fr; }
    ({ h0, h3 } = pick);
  }
  // a straight line: handles a third along the chord, so there is something to grab
  if (dist(h0, p0) < 1e-6) h0 = lerp(p0, p3, 1 / 3);
  if (dist(h3, p3) < 1e-6) h3 = lerp(p3, p0, 1 / 3);
  const cv = bezPoly(p0, h0, h3, p3);
  return { from: fromId, to: toId, p0: { ...p0 }, p3: { ...p3 }, h0, h3, between: mid.length, dev: mid.length ? Math.max(maxDev(cv, q), maxDev(q, cv)) : 0, length: polyLen(mid.length ? cv : q) };
}
/**
 * Shape the line from → to with two handles (relative to their points). Points in between are replaced by one
 * curve of the same shape first; the lines beyond both end points keep their shape (handles are per side).
 * Returns the number of points that were replaced.
 */
export function shapeSegment(doc: Document, pieceId: Id, contourId: Id, fromId: Id, toId: Id, h: { start?: Vec; end?: Vec } = {}): number {
  return doc.transact('Shape line', () => {
    const piece = piecesHas(doc, pieceId), line = doc.sizeLine(piece);
    if (piece.locked) throw new Error('Piece is locked');
    const contour = contourOf(piece, contourId);
    const { i, j, mid } = segIdx(contour, fromId, toId);
    const n = contour.points.length;
    for (const k of mid) {
      const a = contour.points[k];
      if (a.kind === 'grade') throw new Error('Pick a line between two neighbouring grade points');
      if (a.flags.dartLeg || a.flags.pleatEdge || a.flags.locked || a.flags.derived) throw new Error('This line has dart, pleat or locked points on it: it cannot become one curve');
    }
    const cur = segmentCurve(piece, line, contourId, fromId, toId);
    const r = resolveBase(contour, line);
    const A = contour.points[i], B = contour.points[j];
    // the far sides keep their present shape
    const hasPrev = contour.closed || i > 0, hasNext = contour.closed || j < n - 1;
    if (hasPrev && A.smooth && !A.hIn) A.hIn = sub(r.handles[i].hIn, r.anchorPos[i]);
    if (hasNext && B.smooth && !B.hOut) B.hOut = sub(r.handles[j].hOut, r.anchorPos[j]);
    delete A.hHold; delete B.hHold;
    for (const id of mid.map(k => contour.points[k].id)) deletePoint(doc, pieceId, id);
    A.hOut = h.start ? { ...h.start } : sub(cur.h0, cur.p0);
    B.hIn = h.end ? { ...h.end } : sub(cur.h3, cur.p3);
    return mid.length;
  });
}

// ───────────────────────── a run of lines as ONE curve (also across pieces) ─────────────────────────

/** One line of a run: from → to in its contour's own direction. */
export interface RunPart { pieceId: Id; contourId: Id; from: Id; to: Id }
/**
 * Several lines that meet end to end on the sheet (lines of one piece or of pieces laid against each other),
 * seen as ONE cubic curve. Everything is in sheet (world) coordinates, base size.
 */
export interface RunCurve {
  /** the lines in run order; rev = the line runs against its contour direction; share = where it ends, as a share of the run length (0–1) */
  parts: (RunPart & { rev: boolean; share: number })[];
  p0: Vec; h0: Vec; h3: Vec; p3: Vec;
  /** where the lines meet now (one per joint) */
  joints: Vec[];
  /** largest distance between two ends that are taken as meeting */
  gap: number;
  /** largest distance between the present shape and the single curve */
  dev: number;
  length: number;
  /**
   * Lines that lie over the run instead of continuing it (pieces laid on top of each other): they take the shape of
   * the curve, and their end points move onto it.
   * na / nb = the joint of the run that the line's from / to end sits on (0 = start of the run … parts.length = its end; −1 = an end of its own);
   * sa / sb = where the from / to end lies along the run, as a share of the run length (0–1).
   */
  overlays: (RunPart & { na: number; nb: number; sa: number; sb: number })[];
}
interface RunItem { part: RunPart; piece: Piece; poly: Vec[]; hs: Vec; he: Vec; len: number; rev: boolean }
/** nearest place on a polyline: distance to it and the length along the polyline up to it */
function polyNearest(p: Vec, poly: Vec[]): { d: number; s: number } {
  let d = Infinity, at = 0, run = 0;
  for (let e = 0; e + 1 < poly.length; e++) {
    const a = poly[e], st = sub(poly[e + 1], a), l2 = dot(st, st), l = Math.sqrt(l2);
    const u = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), st) / l2));
    const dd = dist(p, add(a, mul(st, u)));
    if (dd < d) { d = dd; at = run + u * l; }
    run += l;
  }
  return { d, s: at };
}
interface RunOverlay { item: RunItem; na: number; nb: number }
/**
 * Order the picked lines. Ends closer than `tol` are one joint. The run is the longest chain of lines through
 * the joints; every other picked line must touch the run and is an overlay (a line of a piece laid on top).
 */
function runChain(doc: Document, parts: RunPart[], tol: number): { items: RunItem[]; overlays: RunOverlay[]; gap: number } {
  const seen = new Set<string>();
  const uniq = parts.filter(p => { const k = `${p.pieceId}/${p.contourId}/${p.from}/${p.to}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (uniq.length < 2) throw new Error('Pick two or more lines');
  if (uniq.length > 14) throw new Error('Too many lines for one curve: pick 14 at most');
  const all: RunItem[] = uniq.map(part => {
    const piece = piecesHas(doc, part.pieceId), L = pieceLayout(piece), line = doc.sizeLine(piece);
    const contour = contourOf(piece, part.contourId);
    const { i, j } = segIdx(contour, part.from, part.to);
    const r = resolveBase(contour, line);
    const poly = spanPoly(r, i, j).map(q => layoutToWorld(L, q));
    return { part, piece, poly, hs: layoutToWorld(L, r.handles[i].hOut), he: layoutToWorld(L, r.handles[j].hIn), len: polyLen(poly), rev: false };
  });
  const n = all.length;
  // joints: ends 2k (from) and 2k+1 (to), merged when they are within tol
  const ends: Vec[] = all.flatMap(it => [it.poly[0], it.poly[it.poly.length - 1]]);
  const par = ends.map((_, k) => k);
  const find = (k: number): number => (par[k] === k ? k : (par[k] = find(par[k])));
  let gap = 0;
  for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length; b++) {
    if ((a >> 1) === (b >> 1)) continue;
    const d = dist(ends[a], ends[b]); if (d <= tol) { par[find(a)] = find(b); gap = Math.max(gap, d); }
  }
  const node = (k: number, end: 0 | 1) => find(2 * k + end);
  for (let k = 0; k < n; k++) if (node(k, 0) === node(k, 1)) throw new Error('A picked line is shorter than the joining distance: zoom in and pick again');
  // the longest chain (by length) through the joints
  let best: { k: number; rev: boolean }[] = [], bestLen = -1;
  const used = new Array<boolean>(n).fill(false);
  // direction in which a line leaves one of its ends (towards its other end)
  const away = (k: number, end: 0 | 1) => { const pl = all[k].poly; return norm(end === 0 ? sub(pl[pl.length - 1], pl[0]) : sub(pl[0], pl[pl.length - 1])); };
  const walk = (at: number, path: { k: number; rev: boolean }[], visited: Set<number>, L: number) => {
    if (L > bestLen + 1e-9) { bestLen = L; best = [...path]; }
    const prev = path[path.length - 1];
    for (let k = 0; k < n; k++) {
      if (used[k]) continue;
      for (const rev of [false, true]) {
        const a = node(k, rev ? 1 : 0), b = node(k, rev ? 0 : 1);
        if (a !== at || visited.has(b)) continue;
        // a run goes on through a joint; two lines that leave it the same way lie on each other (within 45°), they do not chain
        if (prev && dot(away(prev.k, prev.rev ? 0 : 1), away(k, rev ? 1 : 0)) > Math.SQRT1_2) continue;
        used[k] = true; visited.add(b); path.push({ k, rev });
        walk(b, path, visited, L + all[k].len);
        path.pop(); visited.delete(b); used[k] = false;
      }
    }
  };
  for (const start of new Set(ends.map((_, k) => find(k)))) walk(start, [], new Set([start]), 0);
  // a fixed direction for the same pick: the run starts at the end of the line that was picked first
  const firstPicked = Math.min(...best.map(x => x.k));
  if (best.findIndex(x => x.k === firstPicked) > (best.length - 1) / 2) best = best.reverse().map(x => ({ k: x.k, rev: !x.rev }));
  const items = best.map(x => { all[x.k].rev = x.rev; return all[x.k]; });
  const chainNodes = [node(best[0].k, best[0].rev ? 1 : 0), ...best.map(x => node(x.k, x.rev ? 0 : 1))];
  const inChain = new Set(best.map(x => x.k));
  const overlays: RunOverlay[] = [];
  for (let k = 0; k < n; k++) {
    if (inChain.has(k)) continue;
    const it = all[k];
    const na = chainNodes.indexOf(node(k, 0)), nb = chainNodes.indexOf(node(k, 1));
    if (na >= 0 && nb >= 0 && items.length >= 2 && Math.min(na, nb) === 0 && Math.max(na, nb) === items.length) throw new Error('The lines close a loop: leave one line out, so the run has two ends');
    overlays.push({ item: it, na, nb });
  }
  return { items, overlays, gap };
}
/** The run of lines as one curve: the two handles (at the two ends of the run) that control all of it. */
export function runCurve(doc: Document, parts: RunPart[], o: { tol?: number } = {}): RunCurve {
  const { items, overlays, gap } = runChain(doc, parts, o.tol ?? 5);
  const q: Vec[] = [], joints: Vec[] = [];
  let total = 0; for (const it of items) total += it.len;
  let acc = 0;
  const out = items.map((it, k) => {
    const poly = it.rev ? [...it.poly].reverse() : it.poly;
    if (k > 0) joints.push(lerp(q[q.length - 1], poly[0], 0.5));
    for (const v of poly) if (!q.length || dist(q[q.length - 1], v) > 1e-9) q.push(v);
    acc += it.len;
    return { ...it.part, rev: it.rev, share: total > 0 ? acc / total : (k + 1) / items.length };
  });
  const p0 = q[0], p3 = q[q.length - 1];
  const qLen = polyLen(q), limit = Math.max(o.tol ?? 5, qLen * 0.12);
  const first = items[0], last = items[items.length - 1];
  const dirOr = (h: Vec, p: Vec, fb: Vec) => { const v = sub(h, p); return len(v) > 1e-6 ? norm(v) : norm(fb); };
  const t0 = dirOr(first.rev ? first.he : first.hs, p0, sub(q[Math.min(1, q.length - 1)], p0));
  const t3 = dirOr(last.rev ? last.hs : last.he, p3, sub(q[Math.max(0, q.length - 2)], p3));
  const devOf = (f: { h0: Vec; h3: Vec }) => { const cv = bezPoly(p0, f.h0, f.h3, p3, 96); return Math.max(maxDev(cv, q), maxDev(q, cv)); };
  let pick = fitCubic(q, t0, t3, false); let dk = devOf(pick);
  if (dk > 0.2) {
    // a run that was shaped as one curve before: each line is a piece of that curve, and at every joint the two
    // handle lengths are in the ratio of the two parameter spans. That gives every span, and the curve back.
    const S = (it: RunItem) => (it.rev ? { p: it.poly[it.poly.length - 1], h: it.he } : { p: it.poly[0], h: it.hs });
    const E = (it: RunItem) => (it.rev ? { p: it.poly[0], h: it.hs } : { p: it.poly[it.poly.length - 1], h: it.he });
    const span = [1]; let ok = true;
    for (let k = 0; k + 1 < items.length && ok; k++) {
      const e = E(items[k]), n = S(items[k + 1]); const li = dist(e.h, e.p), lo = dist(n.h, n.p);
      if (li < 1e-6 || lo < 1e-6) ok = false; else span.push(span[k] * lo / li);
    }
    const sum = span.reduce((a, b) => a + b, 0);
    const hs = S(first).h, he = E(last).h;
    if (ok && dist(hs, p0) > 1e-6 && dist(he, p3) > 1e-6) {
      const cand = { h0: add(p0, mul(sub(hs, p0), sum / span[0])), h3: add(p3, mul(sub(he, p3), sum / span[span.length - 1])) };
      const dc = devOf(cand); if (dc < dk * 0.7) { pick = cand; dk = dc; }
    }
  }
  if (dk > 0.2) { const fr = fitCubic(q, t0, t3, true); if (devOf(fr) < dk * 0.7) pick = fr; }
  let { h0, h3 } = pick;
  if (dist(h0, p0) < 1e-6) h0 = lerp(p0, p3, 1 / 3);
  if (dist(h3, p3) < 1e-6) h3 = lerp(p3, p0, 1 / 3);
  const cv = bezPoly(p0, h0, h3, p3, 96);
  return { parts: out, p0: { ...p0 }, p3: { ...p3 }, h0, h3, joints, gap, dev: Math.max(maxDev(cv, q), maxDev(q, cv)), length: polyLen(cv),
    overlays: overlays.map(ov => {
      // where each end lies along the run: a joint, or the nearest place on the run for an end of its own
      const ends = [ov.item.poly[0], ov.item.poly[ov.item.poly.length - 1]];
      const [sa, sb] = [ov.na, ov.nb].map((nd, e) => {
        if (nd >= 0) return nd === 0 ? 0 : out[nd - 1].share;
        const pr = polyNearest(ends[e], q);
        if (pr.d > limit) throw new Error(`The lines do not meet or lie on each other (a line ends ${Math.round(pr.d * 10) / 10} away): lay the pieces so the lines touch`);
        return total > 0 ? pr.s / qLen : 0;
      });
      if (Math.abs(sa - sb) < 1e-4) throw new Error('A picked line does not lie along the other lines: leave it out');
      return { ...ov.item.part, na: ov.na, nb: ov.nb, sa, sb };
    }) };
}
/** Where the joints of a run land on the curve p0 h0 h3 p3: each line keeps its share of the run length. */
export function runJointParams(p0: Vec, h0: Vec, h3: Vec, p3: Vec, shares: number[]): number[] {
  const N = 600, cum = [0]; let prev = p0;
  for (let k = 1; k <= N; k++) { const v = bez(p0, h0, h3, p3, k / N); cum.push(cum[k - 1] + dist(prev, v)); prev = v; }
  const L = cum[N];
  return shares.map(f => {
    if (f <= 0 || L <= 0) return 0; if (f >= 1) return 1;
    const want = f * L; let k = 1; while (k < N && cum[k] < want) k++;
    const d = cum[k] - cum[k - 1];
    return (k - 1 + (d > 0 ? (want - cum[k - 1]) / d : 0)) / N;
  });
}
/**
 * Shape a run of lines as ONE curve with a handle at each end of the run (handles are sheet vectors, relative to
 * the end points). The two ends of the run stay; the points where the lines meet move onto the curve (each line
 * keeps its share of the run length), on both pieces alike, so the pieces still match there. Lines laid over the
 * run get that same shape: their end points move onto the curve too. Curve points inside a line are replaced.
 */
export function shapeRun(doc: Document, parts: RunPart[], h: { start?: Vec; end?: Vec } = {}, o: { tol?: number } = {}): void {
  doc.transact('Shape lines', () => {
    const tol = o.tol ?? 5;
    const rc = runCurve(doc, parts, { tol });
    for (const pt of rc.parts) if (piecesHas(doc, pt.pieceId).locked) throw new Error('Piece is locked');
    const P0 = rc.p0, P3 = rc.p3, H0 = h.start ? add(P0, h.start) : rc.h0, H3 = h.end ? add(P3, h.end) : rc.h3;
    const ts = [0, ...runJointParams(P0, H0, H3, P3, rc.parts.map(x => x.share))]; ts[ts.length - 1] = 1;
    // blossom of the cubic: the control points of the piece between two parameters
    const bl = (u: number, v: number, w: number): Vec => {
      const a = lerp(P0, H0, u), b = lerp(H0, H3, u), c = lerp(H3, P3, u);
      return lerp(lerp(a, b, v), lerp(b, c, v), w);
    };
    const local = (pid: Id, w: Vec) => layoutToLocal(pieceLayout(piecesHas(doc, pid)), w);
    // 1 · the joints move onto the curve (the same sheet point for both lines that meet there)
    const moved = new Set<string>();
    const moveTo = (pt: RunPart, anchorId: Id, w: Vec) => {
      const k = pt.pieceId + '/' + anchorId; if (moved.has(k)) return; moved.add(k);
      const l = local(pt.pieceId, w);
      movePoint(doc, pt.pieceId, anchorId, { x: l.x, y: l.y });
    };
    for (let k = 0; k + 1 < rc.parts.length; k++) {
      const w = bez(P0, H0, H3, P3, ts[k + 1]);
      const a = rc.parts[k], b = rc.parts[k + 1];
      moveTo(a, a.rev ? a.from : a.to, w);
      moveTo(b, b.rev ? b.to : b.from, w);
    }
    // lines laid over the run: both end points go onto the curve (a joint goes with the joint)
    const ovT = rc.overlays.map(ov => runJointParams(P0, H0, H3, P3, [ov.sa, ov.sb]));
    rc.overlays.forEach((ov, k) => {
      if (piecesHas(doc, ov.pieceId).locked) throw new Error('Piece is locked');
      moveTo(ov, ov.from, ov.na >= 0 ? bez(P0, H0, H3, P3, ts[ov.na]) : bez(P0, H0, H3, P3, ovT[k][0]));
      moveTo(ov, ov.to, ov.nb >= 0 ? bez(P0, H0, H3, P3, ts[ov.nb]) : bez(P0, H0, H3, P3, ovT[k][1]));
    });
    // 2 · every line takes its piece of the curve
    const piece4 = (ta: number, tb: number) => [bl(ta, ta, ta), bl(ta, ta, tb), bl(ta, tb, tb), bl(tb, tb, tb)] as const;
    const put = (pt: RunPart, f: Vec, hf: Vec, ht: Vec, t: Vec) => {
      const lf = local(pt.pieceId, f), lt = local(pt.pieceId, t);
      shapeSegment(doc, pt.pieceId, pt.contourId, pt.from, pt.to, { start: sub(local(pt.pieceId, hf), lf), end: sub(local(pt.pieceId, ht), lt) });
    };
    rc.parts.forEach((pt, k) => {
      const [a, c1, c2, b] = piece4(ts[k], ts[k + 1]);
      if (pt.rev) put(pt, b, c2, c1, a); else put(pt, a, c1, c2, b);
    });
    // 3 · the lines laid over the run take the same shape: their own piece of the curve
    rc.overlays.forEach((ov, k) => {
      const [a, c1, c2, b] = piece4(ov.na >= 0 ? ts[ov.na] : ovT[k][0], ov.nb >= 0 ? ts[ov.nb] : ovT[k][1]);
      put(ov, a, c1, c2, b);
    });
  });
}

/** Rotate the points array of the sew contour so the anchor is index 0 (point #1); moves the startPoint flag. */
export function setStartPoint(doc: Document, pieceId: Id, anchorId: Id): void {
  doc.transact('Set start point', () => {
    const piece = piecesHas(doc, pieceId);
    const c = piece.sew;
    const i = idx(c, anchorId);
    if (!c.closed) throw new Error('Start point needs a closed contour');
    c.points = [...c.points.slice(i), ...c.points.slice(0, i)];
    for (const a of c.points) delete a.flags.startPoint;
    c.points[0].flags.startPoint = true;
  });
}

