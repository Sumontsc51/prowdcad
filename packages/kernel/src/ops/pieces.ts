/**
 * Piece construction & management (A5): trace, build (planar region), join, fold in/out, half pieces,
 * reference block, point connections, lock, layouts, versioning, merge from another style, grain ops.
 */
import type { Anchor, Contour, Id, Piece, SizeId, SizeLine, Style, GradeInc } from '../model/types';
import type { Document } from '../model/doc';
import { newId, makePiece, makeContour, now } from '../model/factory';
import { absoluteOffset, absoluteToIncremental, halfOpenedPiece, findHalfFoldEdge, MIRROR_SUFFIX } from '../model/contour';
import { Vec, add, sub, mul, dist, norm, dot, cross, lerp, angleOf, len } from '../geom/vec';
import { area, signedArea, pointInPolygon, segIntersect } from '../geom/poly';
import {
  findAnchorIn, contourOf, idx, resolveBase, arcS, spanLen, lengthOf, closedPoly, closestArc, splitAt, extractRange,
  reverseAnchors, jsonClone, crossings, captureNotches, restoreNotches, centroid, anchorsFromPolyline, transformPiece,
  transformAnchor, xfRotate, xfTranslate, xfCompose, xfMirror, cloneWithNewIds, sizeIds, sideOf, between,
  type Xf,
} from '../geom/draft-geom';
import { swapSegment } from './segments';
import { recenterGrainOf as recenterGrainRaw } from './cut';

// ───────────────────────── trace ─────────────────────────

export type TraceItem =
  | { pieceId: Id; anchorId: Id }
  | { pieceId: Id; contourId?: Id; from: Id; to: Id; reverse?: boolean };

/**
 * Trace a new piece from a click sequence: single anchors (joined by straight lines) and/or contour
 * runs (`from` → `to` forward, or backward with `reverse`). Geometry is copied exactly (Bézier
 * handles kept); grade points keep their grading. Returns the new piece id.
 */
export function traceSegments(doc: Document, items: TraceItem[], o: { name?: string } = {}): Id {
  return doc.transact('Trace', style => {
    const pts: Anchor[] = [];
    const push = (a: Anchor) => {
      const last = pts[pts.length - 1];
      if (last && dist(last, a) < 1e-6) { if (a.hOut) last.hOut = a.hOut; else delete last.hOut; return; }
      pts.push(a);
    };
    let tableId = style.activeSizeTableId;
    for (const it of items) {
      const piece = doc.piece(it.pieceId), line = doc.sizeLine(piece);
      tableId = piece.sizeTableId;
      if ('anchorId' in it) {
        const { contour, index } = findAnchorIn(piece, it.anchorId);
        const a = jsonClone(contour.points[index]);
        a.id = newId('p'); delete a.hIn; delete a.hOut; a.smooth = false; a.flags = {};
        if (a.kind === 'curve') { a.kind = 'grade'; }
        push(a);
        continue;
      }
      const { contour, index: ia } = findAnchorIn(piece, it.from);
      const ib = idx(contour, it.to);
      const r = resolveBase(contour, line);
      let run: Anchor[];
      if (!it.reverse) run = extractRange(contour, line, arcS(r, ia), arcS(r, ia) + spanLen(r, ia, ib));
      else run = reverseAnchors(extractRange(contour, line, arcS(r, ib), arcS(r, ib) + spanLen(r, ib, ia)), false);
      for (const a of run) { a.flags = {}; delete a.corner; }
      run.forEach(a => push(a));
    }
    if (pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-6) { const l = pts.pop()!; if (l.hIn) pts[0].hIn = l.hIn; }
    if (pts.length < 3) throw new Error('Trace needs at least three points');
    pts[0].flags.startPoint = true;
    const p = makePiece(o.name ?? 'TRACE', makeContour(pts), tableId);
    p.grain = defaultGrain(pts);
    style.pieces.push(p);
    return p.id;
  });
}

function defaultGrain(pts: Vec[]): Piece['grain'] {
  const c = centroid(pts);
  const ys = pts.map(p => p.y);
  const h = (Math.max(...ys) - Math.min(...ys)) * 0.3;
  return { a: { x: c.x, y: c.y - h }, b: { x: c.x, y: c.y + h }, gradeA: {}, gradeB: {}, centered: true };
}

// ───────────────────────── build (planar region) ─────────────────────────

/** forward slice of a closed polygon (no repeated end) between arc params u0 → u1 */
function closedSlice(Q: Vec[], u0: number, u1: number): Vec[] {
  const P = [...Q, Q[0]];
  const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + dist(P[i - 1], P[i]));
  const L = cum[cum.length - 1];
  const at = (s: number) => { s = ((s % L) + L) % L; let e = 0; while (e < cum.length - 2 && cum[e + 1] < s) e++; const l = cum[e + 1] - cum[e]; return lerp(P[e], P[e + 1], l < 1e-12 ? 0 : (s - cum[e]) / l); };
  let d = u1 - u0; if (d < 0) d += L;
  const out = [at(u0)];
  for (let lap = 0; lap < 2; lap++) for (let k = 1; k < P.length; k++) { const s = cum[k] + lap * L; if (s > u0 + 1e-9 && s < u0 + d - 1e-9) out.push(P[k]); }
  out.push(at(u0 + d));
  return out;
}
function openSlice(P: Vec[], s0: number, s1: number): Vec[] {
  const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + dist(P[i - 1], P[i]));
  const at = (s: number) => { let e = 0; while (e < cum.length - 2 && cum[e + 1] < s) e++; const l = cum[e + 1] - cum[e]; return lerp(P[e], P[e + 1], l < 1e-12 ? 0 : (s - cum[e]) / l); };
  const out = [at(s0)];
  for (let k = 1; k < P.length - 1; k++) if (cum[k] > s0 + 1e-9 && cum[k] < s1 - 1e-9) out.push(P[k]);
  out.push(at(s1));
  return out;
}
function dedupeClosed(p: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const q of p) if (!out.length || dist(out[out.length - 1], q) > 1e-7) out.push(q);
  if (out.length > 1 && dist(out[0], out[out.length - 1]) < 1e-7) out.pop();
  return out;
}

/**
 * Region containing `seed` of the planar subdivision formed by the piece perimeter and its internal
 * lines (base size), by repeated polygon slicing: every internal sub-path that crosses the current
 * region boundary twice with its middle inside the region splits it; the side holding the seed is kept.
 */
export function regionAt(doc: Document, pieceId: Id, seed: Vec, o: { internalIds?: Id[] } = {}): Vec[] {
  const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
  let Q = dedupeClosed(resolveBase(piece.sew, line).pts);
  if (!pointInPolygon(seed, Q)) throw new Error('Seed point is outside the piece');
  const lines = piece.internals.filter(c => c.points.length >= 2 && (!o.internalIds || o.internalIds.includes(c.id))).map(c => closedPoly(resolveBase(c, line)));
  let changed = true, guard = 0;
  while (changed && guard++ < 500) {
    changed = false;
    for (const P of lines) {
      const X = crossings(P, [...Q, Q[0]]);
      for (let k = 0; k + 1 < X.length; k++) {
        const a = X[k], b = X[k + 1];
        if (b.sPath - a.sPath < 1e-6) continue;
        const path = openSlice(P, a.sPath, b.sPath);
        const mid = openSlice(P, a.sPath, (a.sPath + b.sPath) / 2);
        if (!pointInPolygon(mid[mid.length - 1], Q)) continue;
        const h1 = dedupeClosed([...closedSlice(Q, a.sPoly, b.sPoly), ...path.slice().reverse()]);
        const h2 = dedupeClosed([...closedSlice(Q, b.sPoly, a.sPoly), ...path]);
        if (area(h1) < 1e-6 || area(h2) < 1e-6) continue;
        Q = pointInPolygon(seed, h1) ? h1 : h2;
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  return Q;
}

/**
 * Build a new piece from the region (bounded by internals and the perimeter) that contains `seed`.
 * Anchors that coincide with original sew/internal grade anchors take their grading. Returns the id.
 */
export function buildPiece(doc: Document, pieceId: Id, seed: Vec, o: { name?: string; internalIds?: Id[] } = {}): Id {
  const poly = regionAt(doc, pieceId, seed, o);
  return doc.transact('Build piece', style => {
    const piece = doc.piece(pieceId);
    const pts = anchorsFromPolyline(poly, { closed: true, tol: 0.005 });
    const srcAnchors = [piece.sew, ...piece.internals].flatMap(c => c.points.filter(a => a.kind === 'grade'));
    for (const a of pts) {
      const m = srcAnchors.find(s => dist(s, a) < 1e-4);
      if (m) { a.grade = jsonClone(m.grade); if (m.gradeAxisDeg) a.gradeAxisDeg = m.gradeAxisDeg; a.kind = 'grade'; }
    }
    if (signedArea(poly) < 0) pts.reverse();
    pts[0].flags.startPoint = true;
    const p = makePiece(o.name ?? `${piece.name}_BUILD`, makeContour(pts), piece.sizeTableId);
    p.seamDefault = piece.seamDefault;
    p.grain = defaultGrain(pts);
    style.pieces.push(p);
    return p.id;
  });
}

// ───────────────────────── join ─────────────────────────

export interface JoinOptions {
  /** unequal lengths: which end coincides ('first' = B.to on A.from, 'last' = B.from on A.to) */
  anchor?: 'first' | 'last';
  /** only move B so the segments line up (no merge) */
  alignOnly?: boolean;
  /** keep the joined seam as a dashed internal line (default true) */
  keepSeamLine?: boolean;
  tol?: number;
}

/**
 * Join piece B to piece A along a segment (A: aFrom → aTo, B: bFrom → bTo, both forward on their
 * sew lines). B is rotated/translated so its segment lies on A's (sewing orientation: B.to ↔ A.from,
 * B.from ↔ A.to), then merged into A (B archived). Returns A's id (or B's id when alignOnly).
 */
export function joinPieces(doc: Document, aId: Id, segA: { from: Id; to: Id }, bId: Id, segB: { from: Id; to: Id }, o: JoinOptions = {}): Id {
  return doc.transact('Join pieces', style => {
    const A = doc.piece(aId), B = doc.piece(bId), line = doc.sizeLine(A);
    const tol = o.tol ?? 0.01;
    if (signedArea(resolveBase(A.sew, line).pts) * signedArea(resolveBase(B.sew, line).pts) < 0) {
      B.sew.points = reverseAnchors(B.sew.points, true);
    }
    const pa = (id: Id) => { const p = A.sew.points[idx(A.sew, id)]; return { x: p.x, y: p.y }; };
    const pb = (id: Id) => { const p = B.sew.points[idx(B.sew, id)]; return { x: p.x, y: p.y }; };
    const A0 = pa(segA.from), A1 = pa(segA.to), B0 = pb(segB.from), B1 = pb(segB.to);
    // B's chord B1→B0 must align with A0→A1
    const rot = angleOf(sub(A1, A0)) - angleOf(sub(B0, B1));
    const pivot = (o.anchor ?? 'first') === 'first' ? B1 : B0;
    const target = (o.anchor ?? 'first') === 'first' ? A0 : A1;
    const xf: Xf = xfCompose(xfRotate(pivot, rot), xfTranslate(sub(target, pivot)));
    transformPiece(B, xf);
    if (o.alignOnly) return B.id;
    // merge
    const rA = resolveBase(A.sew, line), rB = resolveBase(B.sew, line);
    const ia0 = idx(A.sew, segA.from), ia1 = idx(A.sew, segA.to), ib0 = idx(B.sew, segB.from), ib1 = idx(B.sew, segB.to);
    const restA = extractRange(A.sew, line, arcS(rA, ia1), arcS(rA, ia1) + spanLen(rA, ia1, ia0), { keepIds: true }); // A.to → A.from
    const restB = extractRange(B.sew, line, arcS(rB, ib1), arcS(rB, ib1) + spanLen(rB, ib1, ib0), { keepIds: true }); // B.to → B.from
    const seamLine = extractRange(A.sew, line, arcS(rA, ia0), arcS(rA, ia0) + spanLen(rA, ia0, ia1));
    const capsA = captureNotches(A, line), capsB = captureNotches(B, line);
    // seam of A's last edge (A.from → B side) continues with B's seams
    const pts: Anchor[] = [...restA];
    const endA = pts[pts.length - 1];
    const bFirst = restB[0], bLast = restB[restB.length - 1];
    if (dist(bFirst, endA) <= tol) { if (bFirst.hOut) endA.hOut = bFirst.hOut; endA.seamAfter = bFirst.seamAfter; if (endA.seamAfter === undefined) delete endA.seamAfter; restB.shift(); }
    const startA = pts[0];
    if (dist(bLast, startA) <= tol) { if (bLast.hIn) startA.hIn = bLast.hIn; restB.pop(); }
    const ids = new Set(pts.map(a => a.id));
    for (const a of restB) { if (ids.has(a.id)) a.id = newId('p'); delete a.flags.startPoint; pts.push(a); }
    // keep A's start point if it survived
    const sp = A.sew.points.find(a => a.flags.startPoint)?.id;
    for (const a of pts) delete a.flags.startPoint;
    const si = pts.findIndex(a => a.id === sp);
    const rot0 = si > 0 ? [...pts.slice(si), ...pts.slice(0, si)] : pts;
    rot0[0].flags.startPoint = true;
    A.sew.points = rot0;
    // move B's content into A
    A.internals.push(...B.internals);
    if (o.keepSeamLine ?? true) A.internals.push({ id: newId('c'), type: 'internal', closed: false, points: seamLine, style: 'dashed', name: 'JOIN' });
    A.drills.push(...B.drills); A.texts.push(...B.texts); A.artwork.push(...B.artwork);
    A.darts.push(...B.darts); A.pleats.push(...B.pleats);
    if (B.fullness?.length) A.fullness = [...(A.fullness ?? []), ...B.fullness];
    A.connections.push(...B.connections.filter(c => A.sew.points.some(a => a.id === c.externalAnchorId)));
    A.notches = A.notches.filter(n => !capsA.some(c => c.notch.id === n.id));
    restoreNotches(A, line, [...capsA, ...capsB], 1e-3);
    style.pieceArchive.push(jsonClone(doc.piece(bId)));
    style.pieces = style.pieces.filter(p => p.id !== bId);
    if (A.grain.centered) recenterGrainRaw(A, line);
    return A.id;
  });
}

// ───────────────────────── fold in / out ─────────────────────────

export interface FoldLine { a: Vec; b: Vec }

/**
 * Fold In: the part of the piece beyond the fold line (side not containing `keep`, default: the
 * smaller part) is folded behind it — removed from the perimeter and stored as a dashed internal
 * (mirrored onto the kept side). The fold line becomes a 'fold' contour and the new perimeter edge
 * along it gets seam 0. Returns the internal id of the folded part.
 */
export function foldIn(doc: Document, pieceId: Id, fold: FoldLine, o: { keep?: Vec; seam?: number } = {}): Id {
  return doc.transact('Fold in', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const sew = piece.sew;
    const r0 = resolveBase(sew, line);
    const d = norm(sub(fold.b, fold.a));
    const far = 1e5;
    const X = crossings([sub(fold.a, mul(d, far)), add(fold.a, mul(d, far))], closedPoly(r0));
    if (X.length < 2) throw new Error('Fold line must cross the piece');
    const caps = captureNotches(piece, line, [sew.id]);
    const i0 = splitAt(sew, line, closestArc(r0, X[0].pt).s, { kind: 'grade', piece });
    const id0 = sew.points[i0].id;
    const i1 = splitAt(sew, line, closestArc(resolveBase(sew, line), X[X.length - 1].pt).s, { kind: 'grade', piece });
    const id1 = sew.points[i1].id;
    const r = resolveBase(sew, line);
    const ia = idx(sew, id0), ib = idx(sew, id1);
    const runF = extractRange(sew, line, arcS(r, ia), arcS(r, ia) + spanLen(r, ia, ib), { keepIds: true }); // id0 → id1
    const runB = extractRange(sew, line, arcS(r, ib), arcS(r, ib) + spanLen(r, ib, ia), { keepIds: true }); // id1 → id0
    const areaOf = (run: Anchor[]) => area(resolveBase({ ...sew, points: run }, line).pts);
    let keepF: boolean;
    if (o.keep) keepF = pointInPolygon(o.keep, resolveBase({ ...sew, points: runF }, line).pts);
    else keepF = areaOf(runF) >= areaOf(runB);
    const kept = keepF ? runF : runB, gone = keepF ? runB : runF;
    const last = kept[kept.length - 1];
    last.seamAfter = o.seam ?? 0;
    delete last.hOut; delete kept[0].hIn;
    sew.points = kept;
    if (!sew.points.some(a => a.flags.startPoint)) sew.points[0].flags.startPoint = true;
    const A = { x: kept[0].x, y: kept[0].y }, B = { x: last.x, y: last.y };
    const xf = xfMirror(A, B);
    const folded = gone.map(a => { const c = jsonClone(a); transformAnchor(c, xf); c.id = newId('p'); c.flags = {}; delete c.seamAfter; delete c.corner; return c; });
    const ic: Contour = { id: newId('c'), type: 'internal', closed: false, points: folded, style: 'dashed', name: 'FOLD_IN' };
    piece.internals.push(ic);
    piece.internals.push({ id: newId('c'), type: 'fold', closed: false, points: [mkPt(A), mkPt(B)], name: 'FOLD' });
    // notches of the folded part follow it (mirrored)
    for (const c of caps) c.pos = pointInPolygon(c.pos, resolveBase(sew, line).pts) || closestArc(resolveBase(sew, line), c.pos).d < 1e-3 ? c.pos : xf.pt(c.pos);
    piece.notches = piece.notches.filter(n => !caps.some(c => c.notch.id === n.id));
    restoreNotches(piece, line, caps, 1e-3);
    return ic.id;
  });
}
function mkPt(p: Vec): Anchor { return { id: newId('p'), x: p.x, y: p.y, kind: 'grade', smooth: false, grade: {}, flags: {} }; }

/**
 * Fold Out: mirror an internal (whose ends lie on the perimeter) across the line through its ends
 * and make it perimeter, replacing the perimeter run between its ends. Returns the symmetry
 * deviation (see `symmetryCheck`) measured BEFORE the operation — 0 when the folded part coincides
 * with the kept outline, i.e. the piece is symmetric about the fold.
 */
export function foldOut(doc: Document, pieceId: Id, internalId: Id, o: { checkOnly?: boolean } = {}): number {
  return doc.transact('Fold out', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const ic = contourOf(piece, internalId);
    const n = ic.points.length;
    const A = { x: ic.points[0].x, y: ic.points[0].y }, B = { x: ic.points[n - 1].x, y: ic.points[n - 1].y };
    const xf = xfMirror(A, B);
    const dev = symmetryDeviation(piece, line, ic);
    if (o.checkOnly) return dev;
    for (const a of ic.points) transformAnchor(a, xf);
    const oldId = swapSegment(doc, pieceId, internalId);
    // the old fold edge (straight) is dropped; a 'fold' contour on that line is dropped too
    const p2 = doc.piece(pieceId);
    p2.internals = p2.internals.filter(c => c.id !== oldId && !(c.type === 'fold' && c.points.every(a => Math.abs(sideOf(a, A, B)) < 1e-6)));
    return dev;
  });
}

/**
 * Symmetry check of a folded-in internal (its ends on the fold line): the maximum distance (mm) of
 * the internal from the kept perimeter. 0 ⇒ the folded part lies exactly on the kept outline, so the
 * piece is symmetric about the fold.
 */
export function symmetryCheck(doc: Document, pieceId: Id, internalId: Id): number {
  const piece = doc.piece(pieceId);
  return symmetryDeviation(piece, doc.sizeLine(piece), contourOf(piece, internalId));
}
function symmetryDeviation(piece: Piece, line: SizeLine, ic: Contour): number {
  const sewR = resolveBase(piece.sew, line);
  const P = closedPoly(resolveBase(ic, line));
  let dev = 0;
  for (let i = 0; i < P.length; i++) {
    dev = Math.max(dev, closestArc(sewR, P[i]).d);
    if (i + 1 < P.length) { const k = Math.ceil(dist(P[i], P[i + 1]) / 0.5); for (let j = 1; j < k; j++) dev = Math.max(dev, closestArc(sewR, lerp(P[i], P[i + 1], j / k)).d); }
  }
  return dev;
}

// ───────────────────────── half pieces ─────────────────────────

/**
 * Declare the piece a LIVE half piece mirrored about the axis a→b. With `trim`, the part beyond the
 * axis (the side not containing `keep`, default the smaller side) is cut away first. The axis must
 * coincide with a straight sew edge (after trimming).
 *
 * The authored half stays the editable data. `Document.resolvePiece` resolves it as the full piece
 * mirrored across the fold edge (`halfOpenedPiece`): the fold edge becomes interior (no seam), and
 * sew, cut, internals, notches, darts, drills and texts are mirrored. With `openAtOutput: false` the
 * half is displayed as authored and only exporters open it.
 *
 * The sew contour is rotated so the fold edge is its closing edge (last anchor → first anchor): the
 * opened contour then keeps every authored anchor at its index, followed by the mirrored ones.
 */
export function setHalf(doc: Document, pieceId: Id, axis: { a: Vec; b: Vec }, o: { openAtOutput?: boolean; trim?: boolean; keep?: Vec } = {}): void {
  doc.transact('Set half', () => {
    if (o.trim) {
      const fid = foldIn(doc, pieceId, axis, { keep: o.keep, seam: 0 });
      const p = doc.piece(pieceId);
      p.internals = p.internals.filter(c => c.id !== fid && !(c.type === 'fold' && c.name === 'FOLD'));
    }
    const piece = doc.piece(pieceId);
    const i = findFoldEdge(piece, axis);
    const P = piece.sew.points;
    piece.sew.points = [...P.slice(i + 1), ...P.slice(0, i + 1)];
    piece.half = { a: { ...axis.a }, b: { ...axis.b }, openAtOutput: o.openAtOutput ?? true };
  });
}

function findFoldEdge(piece: Piece, axis: { a: Vec; b: Vec }): number {
  const i = findHalfFoldEdge(piece.sew.points, axis.a, axis.b);
  if (i < 0) throw new Error('Half axis does not lie on a straight sew edge');
  return i;
}

/**
 * Open a half piece for good: the live mirror (`halfOpenedPiece`) is materialised into the piece's own
 * data with fresh ids, and the half spec is removed. Same geometry as the live half in every size.
 */
export function openHalf(doc: Document, pieceId: Id): void {
  doc.transact('Open half', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    if (!piece.half) throw new Error('Piece is not a half piece');
    findFoldEdge(piece, piece.half);
    const open = halfOpenedPiece(piece, line);
    // fresh ids for every derived object
    const ids = new Map<string, string>();
    const fresh = (id: string) => { let v = ids.get(id); if (!v) { v = newId(id.startsWith('c') ? 'c' : id.startsWith('n') ? 'n' : id.startsWith('d') ? 'd' : id.startsWith('t') ? 't' : 'p'); ids.set(id, v); } return v; };
    const rewrite = (o: unknown): unknown => {
      if (typeof o === 'string') return o.endsWith(MIRROR_SUFFIX) ? fresh(o) : o;
      if (Array.isArray(o)) return o.map(rewrite);
      if (o && typeof o === 'object') { const r: Record<string, unknown> = {}; for (const [k, v] of Object.entries(o as Record<string, unknown>)) r[k] = rewrite(v); return r; }
      return o;
    };
    const full = rewrite(jsonClone(open)) as Piece;
    for (const c of [full.sew, ...full.internals]) for (const a of c.points) delete a.flags.derived;
    piece.sew = full.sew;
    piece.internals = full.internals.filter(c => c.type !== 'mirror');
    piece.notches = full.notches.filter(nn => nn.contourId === piece.sew.id || piece.internals.some(c => c.id === nn.contourId));
    piece.darts = full.darts; piece.drills = full.drills; piece.texts = full.texts; piece.artwork = full.artwork;
    piece.cutMode = full.cutMode; if (!full.manualCut) delete piece.manualCut;
    delete piece.half;
    if (piece.grain.centered) recenterGrainRaw(piece, line);
  });
}

/** Remove the half spec: the live mirror disappears and the piece is the authored half again. */
export function deleteHalf(doc: Document, pieceId: Id): void { doc.transact('Delete half', () => { delete doc.piece(pieceId).half; }); }

// ───────────────────────── reference block ─────────────────────────

export function snapshotReference(doc: Document, pieceId: Id, note?: string): void {
  doc.transact('Reference block', () => {
    const p = doc.piece(pieceId);
    p.reference = { timestamp: now(), sew: jsonClone(p.sew), internals: jsonClone(p.internals), ...(note ? { note } : {}) };
  });
}
/** Restore the sew line and internals from the reference block (live objects referencing missing anchors are kept only if valid). */
export function restoreReference(doc: Document, pieceId: Id): void {
  doc.transact('Restore reference', () => {
    const p = doc.piece(pieceId);
    if (!p.reference) throw new Error('No reference block');
    p.sew = jsonClone(p.reference.sew); p.internals = jsonClone(p.reference.internals);
    const has = (id: Id) => [p.sew, ...p.internals].some(c => c.points.some(a => a.id === id));
    p.notches = p.notches.filter(n => has(n.placement.anchorId));
    p.connections = p.connections.filter(c => has(c.externalAnchorId) && has(c.internalAnchorId));
  });
}
/** Overlay geometry of the reference block for a size. */
export function showReference(doc: Document, pieceId: Id, sizeId?: SizeId): { sew: Vec[]; internals: Vec[][] } | null {
  const p = doc.piece(pieceId); if (!p.reference) return null;
  const line = doc.sizeLine(p); const sid = sizeId ?? line.baseSizeId;
  const res = (c: Contour) => closedPoly(doc.resolveContour(p, c, sid));
  return { sew: res(p.reference.sew), internals: p.reference.internals.map(res) };
}
export function clearReference(doc: Document, pieceId: Id): void { doc.transact('Clear reference', () => { delete doc.piece(pieceId).reference; }); }

// ───────────────────────── point connections ─────────────────────────

/**
 * Global check: for every internal anchor touching the perimeter (within tol) ensure a sew grade anchor
 * there and connect them; add anchors (grade points) on both internals at internal × internal
 * crossings. Returns counts.
 */
export function globalCheckConnections(doc: Document, pieceId: Id, tol = 0.05): { connections: number; anchorsAdded: number } {
  return doc.transact('Point connections', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    let connections = 0, anchorsAdded = 0;
    // internal × internal crossings
    const ints = piece.internals.filter(c => c.points.length >= 2);
    for (let i = 0; i < ints.length; i++) for (let j = i + 1; j < ints.length; j++) {
      const X = crossings(closedPoly(resolveBase(ints[i], line)), closedPoly(resolveBase(ints[j], line)));
      for (const x of X) for (const c of [ints[i], ints[j]]) {
        const before = c.points.length;
        splitAt(c, line, closestArc(resolveBase(c, line), x.pt).s, { kind: 'grade', piece, snap: tol });
        anchorsAdded += c.points.length - before;
      }
    }
    // internal anchors on the sew line
    for (const c of piece.internals) {
      for (const a of c.points) {
        const r = resolveBase(piece.sew, line);
        const cl = closestArc(r, a);
        if (cl.d > tol) continue;
        const before = piece.sew.points.length;
        const si = splitAt(piece.sew, line, cl.s, { kind: 'grade', piece, snap: tol });
        anchorsAdded += piece.sew.points.length - before;
        const ext = piece.sew.points[si];
        a.x = ext.x; a.y = ext.y;
        if (!piece.connections.some(pc => pc.internalAnchorId === a.id && pc.externalAnchorId === ext.id)) {
          piece.connections.push({ internalContourId: c.id, internalAnchorId: a.id, externalAnchorId: ext.id });
          connections++;
        }
      }
    }
    return { connections, anchorsAdded };
  });
}
export function globalClearConnections(doc: Document, pieceId?: Id): number {
  return doc.transact('Clear connections', style => {
    let n = 0;
    for (const p of style.pieces) if (!pieceId || p.id === pieceId) { n += p.connections.length; p.connections = []; }
    return n;
  });
}

// ───────────────────────── lock / layouts ─────────────────────────

export function lockPiece(doc: Document, pieceId: Id, locked = true): void { doc.transact(locked ? 'Lock piece' : 'Unlock piece', () => { doc.piece(pieceId).locked = locked; }); }

export function saveLayout(doc: Document, name: string): void {
  doc.transact('Save layout', style => {
    const rec: Record<Id, { x: number; y: number; angleDeg: number }> = {};
    for (const p of style.pieces) rec[p.id] = { ...(p.layout ?? { x: 0, y: 0, angleDeg: 0 }) };
    style.layouts[name] = rec;
  });
}
export function restoreLayout(doc: Document, name: string): number {
  return doc.transact('Restore layout', style => {
    const rec = style.layouts[name]; if (!rec) throw new Error('No layout ' + name);
    let n = 0;
    for (const p of style.pieces) if (rec[p.id]) { p.layout = { ...rec[p.id] }; n++; }
    return n;
  });
}

// ───────────────────────── versioning ─────────────────────────

function baseName(name: string): string { return name.replace(/_\d+$/, ''); }
function nextSuffix(style: Style, base: string): number {
  let max = 0;
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_(\\d+)$');
  for (const p of [...style.pieces, ...style.pieceArchive]) { const m = p.name.match(re); if (m) max = Math.max(max, +m[1]); }
  return max + 1;
}

/** Save Active As New: copy the piece (fresh ids) as NAME_# (next free suffix). Returns the new id. */
export function saveActiveAsNew(doc: Document, pieceId: Id): Id {
  return doc.transact('Save as new', style => {
    const p = doc.piece(pieceId);
    const { value } = cloneWithNewIds(p, old => (old === p.id ? 'pc' : old.startsWith('c') ? 'c' : old.startsWith('n') ? 'n' : 'p'));
    const base = baseName(p.name);
    value.name = `${base}_${nextSuffix(style, base)}`;
    value.version = (p.version ?? 0) + 1;
    value.createdAt = now(); value.updatedAt = now();
    style.pieces.splice(style.pieces.indexOf(p) + 1, 0, value);
    return value.id;
  });
}

/**
 * Replace Old: `replacementId` (a piece of the style) takes the old piece's slot and name; the old
 * piece is archived. Returns the replacement id.
 */
export function replaceOld(doc: Document, oldId: Id, replacementId: Id): Id {
  return doc.transact('Replace old', style => {
    const old = doc.piece(oldId), rep = doc.piece(replacementId);
    style.pieceArchive.push(jsonClone(old));
    rep.name = old.name;
    rep.version = Math.max(old.version ?? 0, rep.version ?? 0) + 1;
    style.pieces = style.pieces.filter(p => p.id !== rep.id);
    style.pieces.splice(style.pieces.findIndex(p => p.id === oldId), 1, rep);
    return rep.id;
  });
}

// ───────────────────────── merge from another style ─────────────────────────

/**
 * Copy pieces from another style. `sizeMapping` maps the other style's size ids → this style's size ids;
 * grading is converted through absolute offsets (unmapped sizes are dropped; unmapped sizes of this
 * style get the nearest mapped neighbour's offset … i.e. zero increment). Name clashes get _# suffixes.
 */
export function mergeFromStyle(doc: Document, other: Style, pieceIds: Id[], sizeMapping: Record<SizeId, SizeId>): Id[] {
  return doc.transact('Merge from style', style => {
    const table = doc.sizeTable();
    const ours = table.axis1;
    const out: Id[] = [];
    for (const pid of pieceIds) {
      const src = other.pieces.find(p => p.id === pid);
      if (!src) throw new Error('No piece ' + pid + ' in source style');
      const srcTable = other.sizeTables.find(t => t.id === src.sizeTableId) ?? other.sizeTables[0];
      const theirs = srcTable.axis1;
      const { value } = cloneWithNewIds(src, old => (old === src.id ? 'pc' : 'o'));
      const conv = (g: Record<SizeId, GradeInc> | undefined): Record<SizeId, GradeInc> => {
        if (!g) return {};
        const abs: Record<SizeId, GradeInc> = {};
        for (const s of theirs.sizes) {
          const to = sizeMapping[s.id]; if (!to) continue;
          const o = absoluteOffset(g, theirs, s.id);
          abs[to] = { dx: o.x, dy: o.y };
        }
        // re-base: our base size may map from a non-base size of theirs
        const b = abs[ours.baseSizeId] ?? { dx: 0, dy: 0 };
        for (const k of Object.keys(abs)) abs[k] = { dx: abs[k].dx - b.dx, dy: abs[k].dy - b.dy };
        // fill unmapped sizes by holding the previous size's offset (zero increment)
        let prev: GradeInc = { dx: 0, dy: 0 };
        const baseIdx = ours.sizes.findIndex(s => s.id === ours.baseSizeId);
        for (let i = baseIdx; i < ours.sizes.length; i++) { const id = ours.sizes[i].id; if (abs[id]) prev = abs[id]; else abs[id] = prev; }
        prev = { dx: 0, dy: 0 };
        for (let i = baseIdx; i >= 0; i--) { const id = ours.sizes[i].id; if (abs[id]) prev = abs[id]; else abs[id] = prev; }
        const inc = absoluteToIncremental(abs, ours);
        return Object.values(inc).every(v => v.dx === 0 && v.dy === 0) ? {} : inc;
      };
      // base geometry shift when our base maps from a non-base size of theirs
      const walk = (o: unknown, base?: Record<SizeId, GradeInc>) => {
        if (Array.isArray(o)) { o.forEach(x => walk(x)); return; }
        if (!o || typeof o !== 'object') return;
        const rec = o as Record<string, unknown>;
        for (const key of ['grade', 'grade2', 'gradeA', 'gradeB']) {
          if (rec[key] && typeof rec[key] === 'object') {
            const g = rec[key] as Record<SizeId, GradeInc>;
            // shift base coordinates to our base size
            const ourBaseFrom = Object.keys(sizeMapping).find(k => sizeMapping[k] === ours.baseSizeId);
            if (ourBaseFrom && key === 'grade' && typeof rec.x === 'number' && typeof rec.y === 'number') {
              const o2 = absoluteOffset(g, theirs, ourBaseFrom); rec.x = (rec.x as number) + o2.x; rec.y = (rec.y as number) + o2.y;
            }
            rec[key] = conv(g);
          }
        }
        if (rec.dist && typeof rec.dist === 'object' && !Array.isArray(rec.dist)) {
          const d = rec.dist as Record<SizeId, number>, nd: Record<SizeId, number> = {};
          for (const [k, v] of Object.entries(d)) if (sizeMapping[k]) nd[sizeMapping[k]] = v;
          rec.dist = nd;
        }
        for (const [k, v] of Object.entries(rec)) if (!['grade', 'grade2', 'gradeA', 'gradeB', 'dist'].includes(k)) walk(v, base);
      };
      walk(value);
      value.sizeTableId = table.id;
      if (value.sizes) value.sizes = value.sizes.map(s => sizeMapping[s]).filter(Boolean);
      if (style.pieces.some(p => p.name === value.name)) value.name = `${baseName(value.name)}_${nextSuffix(style, baseName(value.name))}`;
      style.pieces.push(value);
      out.push(value.id);
    }
    return out;
  });
}

// ───────────────────────── grain ─────────────────────────

/** Fix the grain to the piece centre (centered=true) and recenter it now. */
export function recenterGrain(doc: Document, pieceId: Id): void {
  doc.transact('Recenter grain', () => { const p = doc.piece(pieceId); p.grain.centered = true; recenterGrainRaw(p, doc.sizeLine(p)); });
}
/** Make the grain parallel to the chord of a segment (keeps grain length and midpoint). */
export function grainParallelToSegment(doc: Document, pieceId: Id, from: Id, to: Id): void {
  doc.transact('Grain parallel', () => {
    const p = doc.piece(pieceId);
    const { contour, anchor: A } = findAnchorIn(p, from);
    const B = contour.points[idx(contour, to)];
    const d = norm(sub(B, A));
    const m = lerp(p.grain.a, p.grain.b, 0.5), L = dist(p.grain.a, p.grain.b) / 2;
    // keep the grain's current sense (no 180° flip)
    const cur = norm(sub(p.grain.b, p.grain.a));
    const dd = dot(cur, d) < 0 ? mul(d, -1) : d;
    p.grain.a = sub(m, mul(dd, L)); p.grain.b = add(m, mul(dd, L));
  });
}
/**
 * Rotate the whole piece (about its centroid) so the grain points along `target`
 * ('vertical' = +y, 'horizontal' = +x, or degrees). Returns the applied rotation in degrees.
 */
export function rotatePieceToGrain(doc: Document, pieceId: Id, target: 'vertical' | 'horizontal' | number = 'vertical'): number {
  return doc.transact('Rotate to grain', () => {
    const p = doc.piece(pieceId), line = doc.sizeLine(p);
    const want = target === 'vertical' ? 90 : target === 'horizontal' ? 0 : target;
    const cur = (angleOf(sub(p.grain.b, p.grain.a)) * 180) / Math.PI;
    let rot = want - cur;
    while (rot > 180) rot -= 360; while (rot <= -180) rot += 360;
    if (Math.abs(rot) < 1e-12) return 0;
    const c = centroid(resolveBase(p.sew, line).pts);
    transformPiece(p, xfRotate(c, (rot * Math.PI) / 180));
    return rot;
  });
}

