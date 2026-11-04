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
import type { Anchor, Contour, Id, Piece, SizeId, SizeLine, GradeInc } from '../model/types';
import type { Document } from '../model/doc';
import { anchorPositions, absoluteOffset, absoluteToIncremental, incrementalToAbsolute } from '../model/contour';
import { Vec, add, sub, mul, dist, norm, len, dot, cross, rotate, angleOf, perp, lerp } from '../geom/vec';
import { signedArea, pointInPolygon } from '../geom/poly';
import { newId } from '../model/factory';
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
      if (j >= 0) moveIndex(piece, ic, line, j, d, sizeId, false);
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

