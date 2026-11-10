/**
 * Darts (A3 live objects, never baked).
 *
 * MODEL. A dart is two grade anchors on the SEW contour flagged `dartLeg` (legA = first in contour
 * order, legB) plus an internal apex with its own grading. The sew contour runs straight across the
 * opening legA → legB (the "dart opening"); the legs legA→apex→legB are derived on resolve
 * (`dartSewGeometry`). Width = chord |legB − legA|, depth = |apex − mid(legA, legB)|.
 * "Sew perimeter with darts closed" = sew length − Σ opening arcs (same rule as walk's skipDarts).
 *
 * OPS
 *  - createDart: centre on a sew segment (fromAnchorId + distance, or an existing anchor), legs at
 *    ±width/2 of ARC from the centre (splitAt: base geometry unchanged, grading interpolated), apex
 *    either given (then Fix Dart) or `depth` along the inward bisector of the opening chord.
 *    Apex grading = mean of the two legs' absolute per-size offsets.
 *  - Fix Dart (forced by moveDartApex): both legs slide along the contour by the same arc δ (width
 *    kept) until |legA − apex| = |legB − apex| (bisection).
 *  - transferDart (pivot transfer by percentage): the contour arc between the dart and the target
 *    (the shorter way round) is split at the target and rotated rigidly about the pivot (default the
 *    apex) by pct% of the dart angle, closing the old dart and opening the new one. At 100 % the old
 *    dart is removed (its coincident legs merge); internal objects in the rotated wedge follow.
 *    Rigid rotation ⇒ the closed-dart sew perimeter is conserved exactly. The rotation is done per
 *    size (that size's pivot and dart angle) and stored as explicit grading on the rotated anchors,
 *    so the perimeter is conserved in every graded size too.
 *  - rotateDartAroundCenter: transfer about an offset centre; the new dart re-uses the old apex
 *    ("two darts, one apex") and both are re-equalized.
 *  - closeDart / openDart: zero width (legs and anything between collapse to the opening midpoint),
 *    dashed `dartAxis` internal kept, width remembered; reopen restores the exact leg anchors or a
 *    new width (scaled about the midpoint, then Fix Dart).
 *  - Cutting dart / Cut All, Change Darts (flip fold globally), Copy / Paste, Multi Darts,
 *    removeDart (keepFullness: legs become plain anchors and the opening stays; otherwise the legs
 *    are unsplit / the Insert-Dart fullness is deleted), insertDart (slash & spread + dart).
 *
 * CUT-LINE SHAPE. `dartCutShape(piece, line, sizeId, dartId)` gives the cut-line excursion over the
 * dart: `path` is an open polyline starting on the A-side cut line (offset of the seam entering
 * legA) and ending on the B-side cut line (offset of the seam leaving legB); `polygon` closes it
 * with the sew legs [legA, …path, legB].
 *  - folded dart: the dart intake folded toward `fold` is trimmed flush with that side's cut line
 *    (TUKA/Gerber "dart cap"). In the folded state the intake occupies the wedge (apex, fold-leg,
 *    mirror of the axis); its intersection with the folded cut outline (fold-side cut line, then the
 *    rotated other-side cut line beyond their miter) is unfolded half by reflection across the fold
 *    leg and half by the inverse closing rotation. The peak lies on the dart axis.
 *  - cutting dart: the cut follows the legs into the dart (legs offset into the dart by
 *    `cutSeam`, default 0), path = [A-side cut line ∩ leg A, apex', B-side cut line ∩ leg B].
 * HOW SEAM CONSUMES IT (seam.ts not edited here): in computeCutLine, for each dart with width > 0,
 * take the offset polylines of the segment entering legA and leaving legB, cut them at path[0] and
 * path[last] respectively (both lie on those offset lines), drop the miter/offset of the opening
 * segment legA→legB and splice `path` in between. Notches on the legs/apex can use
 * `dartSewGeometry` for positions.
 */
import type { Anchor, Contour, Dart, GradeInc, Id, Piece, SizeId, SizeLine } from '../model/types';
import type { Document } from '../model/doc';
import { resolveContour, absoluteOffset, anchorPositions, absoluteToIncremental, type ResolvedContour } from '../model/contour';
import { Vec, add, sub, mul, dist, norm, perp, cross, dot, lerp, angleBetween, rotate, reflect } from '../geom/vec';
import { lineIntersect } from '../geom/poly';
import { newId } from '../model/factory';
import {
  resolveBase, arcS, fwd, idx, pointAt, spanPoly, outwardSign, between, prevGrade, nextGrade, spanLen, xfRotate,
  transformAnchor, jsonClone, gradeFromOffsets,
} from '../geom/draft-geom';
import {
  type LiveContourPos, liveRef, liveArcOf, liveSplit, liveUnsplit, liveAvgGrade, liveCopyAnchor, liveTransformRegion,
  liveRayHit, liveInward, liveRefAt,
} from '../geom/dart-geom';
import { fullnessAddRaw, fullnessDeleteRaw, fullnessInsertedIds } from './fullness';

/** Default drill-hole offset back from the apex (mm). TUKA default: ~1/2". */
export const DART_DEFAULT_DRILL = 12;

export interface CreateDartOptions {
  /** dart centre: contour position, or an existing sew anchor */
  at: LiveContourPos | { anchorId: Id };
  width: number;
  /** explicit apex (base coords); Fix Dart is applied unless fix === false */
  apex?: Vec;
  /** apex distance along the inward bisector of the opening chord (used when apex is absent) */
  depth?: number;
  fold?: 'A' | 'B';
  drillOffset?: number;
  name?: string;
  fix?: boolean;
}

/** Dart extra (module-owned) bookkeeping kept on the object. */
type DartX = Dart & { insertedLegIds?: Id[] };

function ctx(doc: Document, pieceId: Id) { const piece = doc.piece(pieceId); return { piece, line: doc.sizeLine(piece) }; }

export function dartOf(piece: Piece, id: Id): DartX {
  const d = piece.darts.find(d => d.id === id);
  if (!d) throw new Error('No dart ' + id);
  return d as DartX;
}

const apexVec = (d: Dart): Vec => ({ x: d.apex.x, y: d.apex.y });

function inwardOfChord(r: ResolvedContour, A: Vec, B: Vec, fallbackT: Vec): Vec {
  const t = dist(A, B) > 1e-9 ? norm(sub(B, A)) : fallbackT;
  return mul(perp(t), -outwardSign(r));
}

// ───────────────────────── create ─────────────────────────

function dartCreateRaw(piece: Piece, line: SizeLine, o: CreateDartOptions): DartX {
  if (!(o.width > 0)) throw new Error('Dart width must be > 0');
  const c = piece.sew;
  const sC = 'anchorId' in o.at ? arcS(resolveBase(c, line), idx(c, o.at.anchorId)) : liveArcOf(c, line, liveRef(o.at));
  const r0 = resolveBase(c, line);
  const sA = sC - o.width / 2, sB = sC + o.width / 2;
  const tC = pointAt(r0, sC).tangent;
  const inserted: Id[] = [];
  const b = liveSplit(piece, line, sB); if (b.created) inserted.push(c.points[b.index].id);
  const bId = c.points[b.index].id;
  const a = liveSplit(piece, line, sA); if (a.created) inserted.push(c.points[a.index].id);
  const aId = c.points[a.index].id;
  if (aId === bId) throw new Error('Dart width too small');
  for (const id of [aId, bId]) { const p = c.points[idx(c, id)]; p.flags = { ...p.flags, dartLeg: true }; }
  const r = resolveBase(c, line);
  const A = r.anchorPos[idx(c, aId)], B = r.anchorPos[idx(c, bId)];
  const apex = o.apex ?? add(lerp(A, B, 0.5), mul(inwardOfChord(r, A, B, tC), o.depth ?? 0));
  if (!o.apex && !(o.depth! > 0)) throw new Error('Dart needs an apex or a depth > 0');
  const d: DartX = {
    id: newId('dt'), legA: aId, legB: bId,
    apex: { x: apex.x, y: apex.y, grade: liveAvgGrade(line, [c.points[idx(c, aId)].grade, c.points[idx(c, bId)].grade]) },
    fold: o.fold ?? 'A', drillOffset: o.drillOffset ?? DART_DEFAULT_DRILL, closed: false,
  };
  if (inserted.length) d.insertedLegIds = inserted;
  if (o.name) d.name = o.name;
  piece.darts.push(d);
  if (o.apex && o.fix !== false) dartFixRaw(piece, line, d);
  return d;
}

export function createDart(doc: Document, pieceId: Id, o: CreateDartOptions): Id {
  return doc.transact('Create dart', () => { const { piece, line } = ctx(doc, pieceId); return dartCreateRaw(piece, line, o).id; });
}

export interface CreateDartByLegsOptions {
  /** the two leg positions on the sew line (any order; the dart spans the shorter arc between them) */
  a: LiveContourPos;
  b: LiveContourPos;
  /** explicit apex (base coords): Fix Dart is applied unless fix === false */
  apex?: Vec;
  /** apex on the inward bisector of the opening chord at this depth (when apex is absent) */
  depth?: number;
  fold?: 'A' | 'B';
  drillOffset?: number;
  fix?: boolean;
  name?: string;
}

/** Centre arc position + arc width of the shorter arc between two sew positions. */
export function dartLegSpan(piece: Piece, line: SizeLine, a: LiveContourPos, b: LiveContourPos): { centre: LiveContourPos; width: number } {
  const c = piece.sew, r = resolveBase(c, line), L = r.cum[r.cum.length - 1] ?? 0;
  const sa = liveArcOf(c, line, liveRef(a)), sb = liveArcOf(c, line, liveRef(b));
  let s0 = sa, w = fwd(r, sa, sb);
  if (c.closed && w > L / 2) { s0 = sb; w = L - w; }
  if (!c.closed && w < 0) { s0 = sb; w = -w; }
  if (!(w > 1e-6)) throw new Error('Dart: the two legs coincide');
  let sc = s0 + w / 2; if (c.closed && L > 0) sc = ((sc % L) + L) % L;
  const ref = liveRefAt(c, line, sc);
  return { centre: { fromAnchorId: ref.fromAnchor, distance: ref.dist }, width: w };
}

/** CLO-style dart: click leg A, leg B on the sew line, then the apex (or a depth). One undo step. */
export function createDartByLegs(doc: Document, pieceId: Id, o: CreateDartByLegsOptions): Id {
  return doc.transact('Create dart', () => {
    const { piece, line } = ctx(doc, pieceId);
    const { centre, width } = dartLegSpan(piece, line, o.a, o.b);
    return dartCreateRaw(piece, line, { at: centre, width, apex: o.apex, depth: o.depth, fold: o.fold, drillOffset: o.drillOffset, fix: o.fix, name: o.name }).id;
  });
}

/** N equal darts, centres at L·k/(N+1) along the grade segment leaving `segStart`. */
export function createMultiDarts(doc: Document, pieceId: Id, segStart: Id, o: { count: number; width: number; depth: number; fold?: 'A' | 'B'; drillOffset?: number }): Id[] {
  return doc.transact('Multi darts', () => {
    const { piece, line } = ctx(doc, pieceId);
    const c = piece.sew, r = resolveBase(c, line);
    const ia = idx(c, segStart); let ib = nextGrade(c, ia); if (ib < 0) ib = ia;
    const L = spanLen(r, ia, ib);
    const ids: Id[] = [];
    for (let k = 1; k <= o.count; k++) ids.push(dartCreateRaw(piece, line, { at: { fromAnchorId: segStart, distance: (L * k) / (o.count + 1) }, width: o.width, depth: o.depth, fold: o.fold, drillOffset: o.drillOffset }).id);
    return ids;
  });
}

// ───────────────────────── fix / apex ─────────────────────────

/** Leg re-equalization: slide both legs by the same arc (width kept) until the legs are equal. Returns the shift δ. */
function dartFixRaw(piece: Piece, line: SizeLine, d: Dart): number {
  if (d.closed) return 0;
  const c = piece.sew, n = c.points.length;
  const r = resolveBase(c, line);
  const iA = idx(c, d.legA), iB = idx(c, d.legB);
  const sA = arcS(r, iA), sB = sA + fwd(r, sA, arcS(r, iB));
  const P = apexVec(d);
  const lo = -fwd(r, arcS(r, (iA - 1 + n) % n), sA) + 1e-6;
  const hi = fwd(r, sB, arcS(r, (iB + 1) % n)) - 1e-6;
  const f = (x: number) => dist(pointAt(r, sA + x).pt, P) - dist(pointAt(r, sB + x).pt, P);
  let delta: number;
  if (Math.abs(f(0)) < 1e-10) delta = 0;
  else {
    let a = lo, b = hi, fa = f(a), fb = f(b);
    if (fa * fb > 0) delta = Math.abs(fa) < Math.abs(fb) ? a : b;
    else {
      for (let k = 0; k < 200 && b - a > 1e-12; k++) { const m = (a + b) / 2, fm = f(m); if (fa * fm <= 0) { b = m; fb = fm; } else { a = m; fa = fm; } }
      delta = (a + b) / 2;
    }
  }
  if (Math.abs(delta) > 0) {
    const pA = pointAt(r, sA + delta).pt, pB = pointAt(r, sB + delta).pt;
    c.points[iA].x = pA.x; c.points[iA].y = pA.y;
    c.points[iB].x = pB.x; c.points[iB].y = pB.y;
  }
  return delta;
}

export function fixDart(doc: Document, pieceId: Id, dartId: Id): number {
  return doc.transact('Fix dart', () => { const { piece, line } = ctx(doc, pieceId); return dartFixRaw(piece, line, dartOf(piece, dartId)); });
}

/**
 * Move the apex. Base size (default): the apex moves in every size (grading kept) and Fix Dart is
 * forced unless `fix === false`. `sizeId` (non-base): only that size's apex grading changes (absolute
 * position `to` in that size; the base and the other sizes keep their positions; no Fix Dart).
 */
export function moveDartApex(doc: Document, pieceId: Id, dartId: Id, to: Vec, o: { sizeId?: SizeId; fix?: boolean } = {}): void {
  doc.transact('Move dart apex', () => {
    const { piece, line } = ctx(doc, pieceId);
    const d = dartOf(piece, dartId);
    if (o.sizeId && o.sizeId !== line.baseSizeId) {
      const off: Record<SizeId, Vec> = {};
      for (const sz of line.sizes) off[sz.id] = absoluteOffset(d.apex.grade, line, sz.id);
      off[o.sizeId] = { x: to.x - d.apex.x, y: to.y - d.apex.y };
      d.apex.grade = gradeFromOffsets(line, off);
      return;
    }
    d.apex.x = to.x; d.apex.y = to.y;
    if (d.closed && d.axisContourId) { const ax = piece.internals.find(c => c.id === d.axisContourId); if (ax) { ax.points[1].x = to.x; ax.points[1].y = to.y; } }
    if (o.fix !== false) dartFixRaw(piece, line, d);
  });
}

export function setDartDepth(doc: Document, pieceId: Id, dartId: Id, depth: number): void {
  doc.transact('Dart depth', () => {
    const { piece, line } = ctx(doc, pieceId);
    const d = dartOf(piece, dartId), r = resolveBase(piece.sew, line);
    const A = r.anchorPos[idx(piece.sew, d.legA)], B = r.anchorPos[idx(piece.sew, d.legB)], M = lerp(A, B, 0.5);
    const u = dist(apexVec(d), M) > 1e-9 ? norm(sub(apexVec(d), M)) : inwardOfChord(r, A, B, { x: 1, y: 0 });
    const P = add(M, mul(u, depth)); d.apex.x = P.x; d.apex.y = P.y;
  });
}

export function setDartFold(doc: Document, pieceId: Id, dartId: Id, fold: 'A' | 'B'): void {
  doc.transact('Dart fold', () => { dartOf(ctx(doc, pieceId).piece, dartId).fold = fold; });
}
export function setDartDrillOffset(doc: Document, pieceId: Id, dartId: Id, mm: number): void {
  doc.transact('Dart drill', () => { dartOf(ctx(doc, pieceId).piece, dartId).drillOffset = mm; });
}

/** Change Darts: flip the fold direction of every dart (of the given pieces, default all). Returns the count. */
export function changeDarts(doc: Document, pieceIds?: Id[]): number {
  return doc.transact('Change darts', s => {
    let k = 0;
    for (const p of s.pieces) if (!pieceIds || pieceIds.includes(p.id)) for (const d of p.darts) { d.fold = d.fold === 'A' ? 'B' : 'A'; k++; }
    return k;
  });
}

// ───────────────────────── transfer ─────────────────────────

export interface TransferDartOptions {
  target: LiveContourPos;
  /** rotation centre (default: the apex) */
  pivot?: Vec;
  /** 0..100 (default 100) */
  pct?: number;
}

function dartTransferRaw(piece: Piece, line: SizeLine, d: DartX, o: TransferDartOptions): { newDartId: Id; oldRemoved: boolean } {
  if (d.closed) throw new Error('Cannot transfer a closed dart');
  const pct = o.pct ?? 100;
  if (!(pct > 0 && pct <= 100)) throw new Error('Transfer pct must be in (0, 100]');
  const f = pct / 100;
  const c = piece.sew;
  const r = resolveBase(c, line);
  const iA = idx(c, d.legA), iB = idx(c, d.legB);
  const sA = arcS(r, iA), sB = arcS(r, iB);
  const sT = liveArcOf(c, line, liveRef(o.target));
  if (fwd(r, sA, sT) <= fwd(r, sA, sB) + 1e-9) throw new Error('Transfer target lies inside the dart opening');
  const forward = fwd(r, sB, sT) <= fwd(r, sT, sA);
  const P = o.pivot ?? apexVec(d);
  const A = r.anchorPos[iA], B = r.anchorPos[iB];
  const theta = (forward ? angleBetween(sub(B, P), sub(A, P)) : angleBetween(sub(A, P), sub(B, P))) * f;
  // split target and insert the moving copy
  const t = liveSplit(piece, line, sT);
  const tId = c.points[t.index].id;
  const T = c.points[t.index];
  const tm = liveCopyAnchor(T, newId('p'));
  if (forward) { delete tm.hOut; delete T.hIn; c.points.splice(t.index, 0, tm); }
  else { delete tm.hIn; delete T.hOut; c.points.splice(t.index + 1, 0, tm); }
  T.smooth = false;
  const r1 = resolveBase(c, line);
  const a0 = forward ? idx(c, d.legB) : idx(c, tm.id), a1 = forward ? idx(c, tm.id) : idx(c, d.legA);
  const region = [...spanPoly(r1, a0, a1), P];
  const xf = xfRotate(P, theta);
  const n = c.points.length;
  // Per-size transfer (B8): in every size the wedge rotates rigidly about THAT size's pivot by THAT
  // size's dart angle (× pct), so the old dart closes exactly and the closed perimeter is conserved
  // in every size, not just the base. Computed from the pre-rotation per-size positions and written
  // back as explicit grading of the rotated anchors (curve points included).
  const regionIdx: number[] = [];
  for (let k = a0, g = 0; g < n; k = (k + 1) % n, g++) { regionIdx.push(k); if (k === a1) break; }
  const perSize = new Map<SizeId, Vec[]>();
  const pivotAbs: Record<SizeId, GradeInc> = {};
  for (const sz of line.sizes) {
    if (sz.id === line.baseSizeId) continue;
    const pos = anchorPositions(c.points, line, sz.id, c.closed);
    const As = pos[idx(c, d.legA)], Bs = pos[idx(c, d.legB)];
    // graded legs need not be equal (apex grading = mean of the leg offsets); pivot on the point of
    // the legs' perpendicular bisector nearest the graded apex, so the rotation maps leg B exactly
    // onto leg A (= the apex itself whenever the legs are equal, e.g. the base size)
    let Ps = o.pivot ?? apexFor(d, line, sz.id);
    if (!o.pivot && dist(As, Bs) > 1e-9) { const M = lerp(As, Bs, 0.5), u = perp(norm(sub(Bs, As))); Ps = add(M, mul(u, dot(sub(Ps, M), u))); }
    pivotAbs[sz.id] = { dx: Ps.x - P.x, dy: Ps.y - P.y };
    const th = (forward ? angleBetween(sub(Bs, Ps), sub(As, Ps)) : angleBetween(sub(As, Ps), sub(Bs, Ps))) * f;
    perSize.set(sz.id, regionIdx.map(k => rotate(pos[k], th, Ps)));
  }
  for (const k of regionIdx) transformAnchor(c.points[k], xf);
  regionIdx.forEach((k, j) => {
    const a = c.points[k];
    const abs: Record<SizeId, GradeInc> = {};
    for (const [sid, tgt] of perSize) abs[sid] = { dx: tgt[j].x - a.x, dy: tgt[j].y - a.y };
    a.grade = absoluteToIncremental(abs, line);
    delete a.gradeAxisDeg;
  });
  liveTransformRegion(piece, region, xf, { dartIds: new Set([d.id]), contourIds: new Set(d.axisContourId ? [d.axisContourId] : []) });
  // new dart
  const legA = forward ? tm.id : tId, legB = forward ? tId : tm.id;
  for (const id of [legA, legB]) { const p = c.points[idx(c, id)]; p.flags = { ...p.flags, dartLeg: true }; }
  const samePivot = dist(P, apexVec(d)) < 1e-9;
  const nd: DartX = {
    id: newId('dt'), legA, legB,
    apex: { x: P.x, y: P.y, grade: samePivot ? absoluteToIncremental(pivotAbs, line) : liveAvgGrade(line, [c.points[idx(c, legA)].grade, c.points[idx(c, legB)].grade]) },
    fold: d.fold, drillOffset: d.drillOffset, closed: false,
  };
  if (samePivot && d.apex.grade2) nd.apex.grade2 = jsonClone(d.apex.grade2);
  if (d.cutting) { nd.cutting = true; if (d.cutSeam !== undefined) nd.cutSeam = d.cutSeam; }
  piece.darts.push(nd);
  // old dart fully closed → merge its legs and drop it
  let oldRemoved = false;
  if (f >= 1 - 1e-12) {
    const r2 = resolveBase(c, line);
    const jA = idx(c, d.legA), jB = idx(c, d.legB);
    if (dist(r2.anchorPos[jA], r2.anchorPos[jB]) < 1e-6) {
      const keep = forward ? d.legA : d.legB, drop = forward ? d.legB : d.legA;
      const dropA = c.points[idx(c, drop)];
      const rm = new Set([drop, ...between(c, jA, jB).map(i => c.points[i].id)]);
      c.points = c.points.filter(p => !rm.has(p.id));
      const kp = c.points[idx(c, keep)];
      kp.flags = { ...kp.flags }; delete kp.flags.dartLeg;
      if (forward) { if (dropA.hOut) kp.hOut = dropA.hOut; else delete kp.hOut; }
      else { if (dropA.hIn) kp.hIn = dropA.hIn; else delete kp.hIn; }
      piece.darts = piece.darts.filter(x => x.id !== d.id);
      if (d.axisContourId) piece.internals = piece.internals.filter(x => x.id !== d.axisContourId);
      piece.notches = piece.notches.filter(nn => !rm.has(nn.placement.anchorId));
      oldRemoved = true;
    }
  }
  return { newDartId: nd.id, oldRemoved };
}

/** Pivot transfer. Returns the id of the new dart (the old one is removed at 100 %). */
export function transferDart(doc: Document, pieceId: Id, dartId: Id, o: TransferDartOptions): Id {
  return doc.transact('Transfer dart', () => { const { piece, line } = ctx(doc, pieceId); return dartTransferRaw(piece, line, dartOf(piece, dartId), o).newDartId; });
}

/** Rotate Around offset Center: transfer pct% about `center`; the new dart shares the old apex; both legs re-equalized. */
export function rotateDartAroundCenter(doc: Document, pieceId: Id, dartId: Id, o: { target: LiveContourPos; center: Vec; pct?: number }): Id {
  return doc.transact('Rotate dart around center', () => {
    const { piece, line } = ctx(doc, pieceId);
    const d = dartOf(piece, dartId);
    const apex = jsonClone(d.apex);
    const res = dartTransferRaw(piece, line, d, { target: o.target, pivot: o.center, pct: o.pct ?? 50 });
    const nd = dartOf(piece, res.newDartId);
    nd.apex = apex;
    dartFixRaw(piece, line, nd);
    if (!res.oldRemoved) dartFixRaw(piece, line, d);
    return nd.id;
  });
}

// ───────────────────────── close / open ─────────────────────────

function dartCloseRaw(piece: Piece, line: SizeLine, d: DartX): void {
  if (d.closed) return;
  const c = piece.sew;
  const iA = idx(c, d.legA), iB = idx(c, d.legB);
  const ids = [iA, ...between(c, iA, iB), iB];
  d.closedLegs = ids.map(i => jsonClone(c.points[i]));
  const r = resolveBase(c, line);
  const A = r.anchorPos[iA], B = r.anchorPos[iB], M = lerp(A, B, 0.5);
  d.rememberedWidth = dist(A, B);
  const g = liveAvgGrade(line, [c.points[iA].grade, c.points[iB].grade]);
  for (const i of ids) {
    const p = c.points[i];
    p.x = M.x; p.y = M.y; p.grade = jsonClone(g); delete p.gradeAxisDeg;
    if (i === iA) delete p.hOut; else if (i === iB) delete p.hIn; else { delete p.hIn; delete p.hOut; }
  }
  const ax: Contour = {
    id: newId('c'), type: 'dartAxis', closed: false, style: 'dashed',
    points: [M, apexVec(d)].map(q => ({ id: newId('p'), x: q.x, y: q.y, kind: 'grade' as const, smooth: false, grade: {}, flags: { dartLeg: true } })),
  };
  piece.internals.push(ax);
  d.axisContourId = ax.id;
  d.closed = true;
}

function dartOpenRaw(piece: Piece, line: SizeLine, d: DartX, width?: number): void {
  if (!d.closed) return;
  const c = piece.sew;
  for (const a of d.closedLegs ?? []) { const i = c.points.findIndex(p => p.id === a.id); if (i >= 0) c.points[i] = jsonClone(a); }
  if (d.axisContourId) piece.internals = piece.internals.filter(x => x.id !== d.axisContourId);
  delete d.axisContourId;
  d.closed = false;
  const rw = d.rememberedWidth ?? 0;
  if (width !== undefined && Math.abs(width - rw) > 1e-9) {
    if (!(width > 0)) throw new Error('Dart width must be > 0');
    const iA = idx(c, d.legA), iB = idx(c, d.legB);
    const M = lerp(c.points[iA], c.points[iB], 0.5);
    const k = rw > 1e-12 ? width / rw : 1;
    for (const i of [iA, ...between(c, iA, iB), iB]) { const p = c.points[i]; const q = add(M, mul(sub(p, M), k)); p.x = q.x; p.y = q.y; }
    dartFixRaw(piece, line, d);
  }
  delete d.closedLegs;
}

export function closeDart(doc: Document, pieceId: Id, dartId: Id): void {
  doc.transact('Close dart', () => { const { piece, line } = ctx(doc, pieceId); dartCloseRaw(piece, line, dartOf(piece, dartId)); });
}
/** Reopen; `width` undefined → exact restore of the remembered width. */
export function openDart(doc: Document, pieceId: Id, dartId: Id, width?: number): void {
  doc.transact('Open dart', () => { const { piece, line } = ctx(doc, pieceId); dartOpenRaw(piece, line, dartOf(piece, dartId), width); });
}
export function closeAllDarts(doc: Document, pieceId: Id): void {
  doc.transact('Close darts', () => { const { piece, line } = ctx(doc, pieceId); for (const d of piece.darts) dartCloseRaw(piece, line, d); });
}
export function openAllDarts(doc: Document, pieceId: Id): void {
  doc.transact('Open darts', () => { const { piece, line } = ctx(doc, pieceId); for (const d of piece.darts) dartOpenRaw(piece, line, d); });
}

// ───────────────────────── cutting ─────────────────────────

export function setDartCutting(doc: Document, pieceId: Id, dartId: Id, on: boolean, cutSeam?: number): void {
  doc.transact('Cutting dart', () => {
    const d = dartOf(ctx(doc, pieceId).piece, dartId);
    d.cutting = on;
    if (cutSeam !== undefined) d.cutSeam = cutSeam;
  });
}
/** Cut All: make every dart of the piece (or all pieces) a cutting dart (or back). */
export function cutAllDarts(doc: Document, pieceId?: Id, on = true): number {
  return doc.transact('Cut all darts', s => {
    let k = 0;
    for (const p of s.pieces) if (!pieceId || p.id === pieceId) for (const d of p.darts) { d.cutting = on; k++; }
    return k;
  });
}

// ───────────────────────── copy / paste ─────────────────────────

export interface DartClip {
  width: number;
  /** apex in the opening frame: along the chord (A→B) and along the inward bisector */
  apexAlong: number; apexIn: number;
  fold: 'A' | 'B'; drillOffset: number; cutting?: boolean; cutSeam?: number;
}

export function copyDart(doc: Document, pieceId: Id, dartId: Id): DartClip {
  const { piece, line } = ctx(doc, pieceId);
  const d = dartOf(piece, dartId), r = resolveBase(piece.sew, line);
  const A = r.anchorPos[idx(piece.sew, d.legA)], B = r.anchorPos[idx(piece.sew, d.legB)], M = lerp(A, B, 0.5);
  const t = norm(sub(B, A)), inw = inwardOfChord(r, A, B, t);
  const v = sub(apexVec(d), M);
  const clip: DartClip = { width: d.closed ? d.rememberedWidth ?? 0 : dist(A, B), apexAlong: dot(v, t), apexIn: dot(v, inw), fold: d.fold, drillOffset: d.drillOffset };
  if (d.cutting) clip.cutting = true;
  if (d.cutSeam !== undefined) clip.cutSeam = d.cutSeam;
  return clip;
}

/** Paste a copied dart centred at `at` on (another) piece. */
export function pasteDart(doc: Document, pieceId: Id, clip: DartClip, at: LiveContourPos): Id {
  return doc.transact('Paste dart', () => {
    const { piece, line } = ctx(doc, pieceId);
    const d = dartCreateRaw(piece, line, { at, width: clip.width, depth: Math.max(clip.apexIn, 1e-6), fold: clip.fold, drillOffset: clip.drillOffset });
    if (Math.abs(clip.apexAlong) > 1e-12) {
      const r = resolveBase(piece.sew, line);
      const A = r.anchorPos[idx(piece.sew, d.legA)], B = r.anchorPos[idx(piece.sew, d.legB)];
      const t = norm(sub(B, A)), P = add(add(lerp(A, B, 0.5), mul(t, clip.apexAlong)), mul(inwardOfChord(r, A, B, t), clip.apexIn));
      d.apex.x = P.x; d.apex.y = P.y;
      dartFixRaw(piece, line, d);
    }
    if (clip.cutting) d.cutting = true;
    if (clip.cutSeam !== undefined) d.cutSeam = clip.cutSeam;
    return d.id;
  });
}

// ───────────────────────── remove / insert ─────────────────────────

/**
 * Remove a dart. keepFullness: the opening stays in the contour (legs become plain anchors).
 * Otherwise an Insert-Dart dart deletes its fullness (exact restore) and a dart created on a
 * segment has its inserted leg anchors unsplit (contour restored).
 */
export function removeDart(doc: Document, pieceId: Id, dartId: Id, o: { keepFullness?: boolean } = {}): void {
  doc.transact('Remove dart', () => {
    const { piece, line } = ctx(doc, pieceId);
    const d = dartOf(piece, dartId);
    if (!o.keepFullness && d.sourceFullnessId && (piece.fullness ?? []).some(f => f.id === d.sourceFullnessId)) { fullnessDeleteRaw(piece, line, d.sourceFullnessId); return; }
    if (d.closed) dartOpenRaw(piece, line, d);
    const c = piece.sew;
    for (const id of [d.legA, d.legB]) { const p = c.points.find(q => q.id === id); if (p) { p.flags = { ...p.flags }; delete p.flags.dartLeg; } }
    if (!o.keepFullness && d.insertedLegIds?.length) {
      for (const id of d.insertedLegIds) {
        const i = c.points.findIndex(p => p.id === id);
        if (i >= 0 && !piece.notches.some(n => n.placement.anchorId === id)) liveUnsplit(c, i);
      }
    }
    piece.darts = piece.darts.filter(x => x.id !== d.id);
    if (d.axisContourId) piece.internals = piece.internals.filter(x => x.id !== d.axisContourId);
  });
}

export interface InsertDartOptions {
  at: LiveContourPos;
  width: number;
  depth: number;
  /** hinge of the spread on the contour (default: where the inward normal at `at` meets the contour again) */
  hinge?: LiveContourPos;
  side?: 'forward' | 'backward';
  fold?: 'A' | 'B';
}

/** Insert Dart = slash & spread (rotate about the hinge, opening = width) + a dart on the opening. */
export function insertDart(doc: Document, pieceId: Id, o: InsertDartOptions): { dartId: Id; fullnessId: Id } {
  return doc.transact('Insert dart', () => {
    const { piece, line } = ctx(doc, pieceId);
    const c = piece.sew;
    let hinge = o.hinge;
    if (!hinge) {
      const s = liveArcOf(c, line, liveRef(o.at));
      const { pt, inward } = liveInward(c, line, s);
      const far = liveRayHit(c, line, pt, inward, 1e-3);
      if (!far) throw new Error('Insert dart: no hinge found');
      const r = resolveBase(c, line);
      const ref = liveRefAt(c, line, closestArcS(r, far), fullnessInsertedIds(piece));
      hinge = { fromAnchorId: ref.fromAnchor, distance: ref.dist };
    }
    const rec = fullnessAddRaw(piece, line, { slash: o.at, pivot: hinge, openA: o.width, openB: 0, mode: 'rotate', side: o.side ?? 'forward' });
    const [s0, s1] = rec.slashAnchorIds;
    const i0 = idx(c, s0), i1 = idx(c, s1);
    const n = c.points.length;
    const [legA, legB] = (i0 + 1) % n === i1 ? [s0, s1] : [s1, s0];
    for (const id of [legA, legB]) { const p = c.points[idx(c, id)]; p.flags = { ...p.flags, dartLeg: true }; }
    const r = resolveBase(c, line);
    const A = r.anchorPos[idx(c, legA)], B = r.anchorPos[idx(c, legB)];
    const P = add(lerp(A, B, 0.5), mul(inwardOfChord(r, A, B, { x: 1, y: 0 }), o.depth));
    const d: DartX = {
      id: newId('dt'), legA, legB, apex: { x: P.x, y: P.y, grade: liveAvgGrade(line, [c.points[idx(c, legA)].grade, c.points[idx(c, legB)].grade]) },
      fold: o.fold ?? 'A', drillOffset: DART_DEFAULT_DRILL, closed: false, sourceFullnessId: rec.id,
    };
    piece.darts.push(d);
    rec.dartId = d.id;
    return { dartId: d.id, fullnessId: rec.id };
  });
}

function closestArcS(r: ResolvedContour, q: Vec): number {
  const poly = [...r.pts, r.pts[0]];
  let best = { s: 0, d: Infinity };
  for (let e = 0; e + 1 < poly.length; e++) {
    const a = poly[e], b = poly[e + 1], ab = sub(b, a), l2 = dot(ab, ab);
    const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(q, a), ab) / l2));
    const dd = dist(lerp(a, b, t), q);
    if (dd < best.d) best = { s: r.cum[e] + t * Math.sqrt(l2), d: dd };
  }
  return best.s;
}

// ───────────────────────── resolved geometry ─────────────────────────

export interface DartSewGeometry {
  dartId: Id;
  /** leg polylines from the contour point to the apex */
  legA: Vec[]; legB: Vec[];
  apex: Vec;
  /** opening midpoint on the contour */
  mid: Vec;
  drill: Vec;
  width: number;
  depth: number;
  legLengthA: number; legLengthB: number;
  fold: 'A' | 'B';
  closed: boolean;
}

function apexFor(d: Dart, line: SizeLine, sizeId: SizeId): Vec {
  const o = absoluteOffset(d.apex.grade, line, sizeId);
  return { x: d.apex.x + o.x, y: d.apex.y + o.y };
}

/** Per dart: leg polylines + apex (+ drill) for the size. */
export function dartSewGeometry(piece: Piece, line: SizeLine, sizeId: SizeId): DartSewGeometry[] {
  const r = resolveContour(piece.sew, line, sizeId);
  const out: DartSewGeometry[] = [];
  for (const d of piece.darts) {
    const iA = piece.sew.points.findIndex(p => p.id === d.legA), iB = piece.sew.points.findIndex(p => p.id === d.legB);
    if (iA < 0 || iB < 0) continue;
    const A = r.anchorPos[iA], B = r.anchorPos[iB], P = apexFor(d, line, sizeId), M = lerp(A, B, 0.5);
    const u = dist(M, P) > 1e-12 ? norm(sub(M, P)) : { x: 0, y: 0 };
    out.push({
      dartId: d.id, legA: [{ ...A }, { ...P }], legB: [{ ...B }, { ...P }], apex: P, mid: M,
      drill: add(P, mul(u, d.drillOffset)), width: dist(A, B), depth: dist(M, P),
      legLengthA: dist(A, P), legLengthB: dist(B, P), fold: d.fold, closed: d.closed,
    });
  }
  return out;
}

export function dartInfo(doc: Document, pieceId: Id, dartId: Id, sizeId?: SizeId): DartSewGeometry {
  const { piece, line } = ctx(doc, pieceId);
  const g = dartSewGeometry(piece, line, sizeId ?? line.baseSizeId).find(x => x.dartId === dartId);
  if (!g) throw new Error('No dart ' + dartId);
  return g;
}

/** Sew perimeter with every open dart closed (opening arcs legA → legB removed). */
export function dartClosedPerimeter(piece: Piece, line: SizeLine, sizeId?: SizeId): number {
  const r = resolveContour(piece.sew, line, sizeId ?? line.baseSizeId);
  let L = r.cum[r.cum.length - 1] ?? 0;
  for (const d of piece.darts) {
    const iA = piece.sew.points.findIndex(p => p.id === d.legA), iB = piece.sew.points.findIndex(p => p.id === d.legB);
    if (iA < 0 || iB < 0) continue;
    L -= fwd(r, arcS(r, iA), arcS(r, iB));
  }
  return L;
}

export interface DartCutShape {
  dartId: Id;
  kind: 'fold' | 'cutting';
  /** open path from the A-side cut line over/into the dart to the B-side cut line */
  path: Vec[];
  /** closed excursion polygon [legA, …path, legB] */
  polygon: Vec[];
}

function seamOf(piece: Piece, anchor: Anchor | undefined): number {
  if (piece.noSeam) return 0;
  const v = anchor?.seamAfter;
  return v !== undefined && Number.isFinite(v) ? v : piece.seamDefault;
}

/** Cut-line excursion of one dart for a size (see file header). */
export function dartCutShape(piece: Piece, line: SizeLine, sizeId: SizeId, dartId: Id): DartCutShape {
  const d = dartOf(piece, dartId);
  const c = piece.sew;
  const r = resolveContour(c, line, sizeId);
  const iA = idx(c, d.legA), iB = idx(c, d.legB);
  const A = r.anchorPos[iA], B = r.anchorPos[iB], p = apexFor(d, line, sizeId);
  const N = r.pts.length, os = outwardSign(r);
  // tangents: entering legA, leaving legB
  let k = r.anchorIndex[iA], prev = r.pts[(k - 1 + N) % N];
  for (let g = 0; g < N && dist(prev, A) < 1e-9; g++) { k = (k - 1 + N) % N; prev = r.pts[(k - 1 + N) % N]; }
  const tIn = norm(sub(A, prev));
  k = r.anchorIndex[iB]; let next = r.pts[(k + 1) % N];
  for (let g = 0; g < N && dist(next, B) < 1e-9; g++) { k = (k + 1) % N; next = r.pts[(k + 1) % N]; }
  const tOut = norm(sub(next, B));
  const pg = prevGrade(c, iA, false);
  const sAside = seamOf(piece, pg >= 0 ? c.points[pg] : undefined), sBside = seamOf(piece, c.points[iB]);
  const LA = { pt: add(A, mul(perp(tIn), os * sAside)), dir: tIn, away: mul(tIn, -1) };
  const LB = { pt: add(B, mul(perp(tOut), os * sBside)), dir: tOut, away: tOut };
  const rayLine = (dir: Vec, L: { pt: Vec; dir: Vec }) => lineIntersect(p, dir, L.pt, L.dir);
  if (d.cutting) {
    const cs = d.cutSeam ?? 0;
    const M = lerp(A, B, 0.5);
    const off = (Q: Vec) => { const u = norm(sub(Q, p)); const nrm = perp(u); const sg = Math.sign(dot(nrm, sub(M, Q))) || 1; return { pt: add(p, mul(nrm, sg * cs)), dir: u }; };
    const la = off(A), lb = off(B);
    const apx = cs > 0 ? lineIntersect(la.pt, la.dir, lb.pt, lb.dir) ?? p : p;
    const qa = lineIntersect(la.pt, la.dir, LA.pt, LA.dir) ?? A, qb = lineIntersect(lb.pt, lb.dir, LB.pt, LB.dir) ?? B;
    const path = [qa, apx, qb];
    return { dartId, kind: 'cutting', path, polygon: [{ ...A }, ...path, { ...B }] };
  }
  const foldA = d.fold === 'A';
  const F = foldA ? A : B, O = foldA ? B : A;
  const LF = foldA ? LA : LB, LO = foldA ? LB : LA;
  const ang = angleBetween(sub(O, p), sub(F, p));
  const Rp = (q: Vec) => rotate(q, ang, p), Rinv = (q: Vec) => rotate(q, -ang, p);
  const RLO = { pt: Rp(LO.pt), dir: rotate(LO.dir, ang) };
  const X = lineIntersect(LF.pt, LF.dir, RLO.pt, RLO.dir);
  const hit = (dir: Vec): Vec => {
    const h1 = rayLine(dir, LF);
    if (h1 && (!X || dot(sub(h1, X), LF.away) >= -1e-12)) return h1;
    return rayLine(dir, RLO) ?? h1 ?? F;
  };
  const m = lerp(F, O, 0.5);
  const mPrime = reflect(m, p, sub(F, p));
  const QF = hit(sub(F, p)), Qm = hit(sub(mPrime, p));
  const w = cross(sub(F, p), sub(mPrime, p));
  const xIn = !!X && Math.sign(cross(sub(F, p), sub(X, p))) === Math.sign(w) && Math.sign(cross(sub(X, p), sub(mPrime, p))) === Math.sign(w) && dist(X, p) > dist(F, p);
  const refl = (q: Vec) => reflect(q, p, sub(F, p));
  const peak = refl(Qm);
  const fromF = [QF, ...(xIn ? [refl(X!)] : []), peak, ...(xIn ? [Rinv(X!)] : []), Rinv(QF)];
  // asymmetric closing: make the path start / end exactly on each side's own cut line
  const eF = rayLine(sub(F, p), LF), eO = rayLine(sub(O, p), LO);
  if (eF && dist(eF, fromF[0]) > 1e-9) fromF.unshift(eF);
  if (eO && dist(eO, fromF[fromF.length - 1]) > 1e-9) fromF.push(eO);
  const ded = fromF.filter((q, i) => i === 0 || dist(q, fromF[i - 1]) > 1e-9);
  const path = foldA ? ded : ded.slice().reverse();
  return { dartId, kind: 'fold', path, polygon: [{ ...A }, ...path, { ...B }] };
}

