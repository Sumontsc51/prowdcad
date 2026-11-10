/**
 * Cut / slash tools (A5): slash a piece along a polyline, along an internal, horizontally/vertically
 * through an anchor, parallel to a segment (waistband strip) or along a guide line.
 *
 * Every cut goes through `slashCore`: the cut path (an open anchor list, possibly curved) is clipped
 * to its first two crossings with the sew line; grade anchors are inserted there (geometry exact);
 * the two halves are assembled from the two perimeter arcs plus the path (forward / reversed).
 * The original piece is archived to `style.pieceArchive`; the halves are named NAME_1 / NAME_2
 * (NAME_1 = the half containing the original start point) and keep the original anchor ids on their
 * perimeter arcs so live references (darts, pleats, notches, connections) stay valid.
 *
 * Live objects straddling the cut: internals are split at the cut path and each part goes to the half
 * containing it; notches are re-placed by position (anchor or floating fromPrev) on whichever half
 * has a contour through them; drills / texts / artwork go by containment; darts / pleats / fullness
 * go to the half that owns all their anchors (dropped and reported when they straddle the cut).
 */
import type { Anchor, Contour, Id, Piece, SizeId, SizeLine } from '../model/types';
import type { Document } from '../model/doc';
import { newId, now } from '../model/factory';
import { Vec, add, sub, mul, dist, norm, perp, lerp, bbox } from '../geom/vec';
import { pointInPolygon, offsetPolyline, signedArea } from '../geom/poly';
import {
  findAnchorIn, idx, resolveBase, arcS, spanLen, lengthOf, closedPoly, closestArc, pointAt, splitAt, extractRange,
  reverseAnchors, jsonClone, crossings, captureNotches, restoreNotches, positionsBySize, gradeFromOffsets, sizeIds,
  centroid, anchorsFromPolyline, outwardSign, spanPoly,
} from '../geom/draft-geom';
import { splitOpenAt, internalLike, internalOf } from './segments';

export interface SlashOptions {
  /** grading of the anchors created by the cut: 'zero' (zero-grade cut) or 'auto' (proportional) */
  gradeMode?: 'zero' | 'auto';
  /** seam allowance on the new cut edges (undefined → piece default) */
  seam?: number;
  /** snap the cut ends to existing sew anchors within this distance (mm). Default 0.01 */
  snap?: number;
}

export interface SlashResult {
  /** [NAME_1, NAME_2] piece ids */
  pieceIds: [Id, Id];
  /** live objects that straddled the cut and were dropped */
  dropped: { darts: Id[]; pleats: Id[]; fullness: Id[]; notches: Id[] };
}

// ───────────────────────── core ─────────────────────────

function openContour(points: Anchor[]): Contour { return { id: newId('c'), type: 'internal', closed: false, points }; }

/** Straight cut path anchors through the given polyline points (grade corners). */
function polylineAnchors(pts: Vec[]): Anchor[] {
  return pts.map(p => ({ id: newId('p'), x: p.x, y: p.y, kind: 'grade', smooth: false, grade: {}, flags: {} }));
}

/** Extend an open anchor path straight at both ends by `e` mm (so ends on the perimeter cross it robustly). */
function extendPath(points: Anchor[], line: SizeLine, e: number): Anchor[] {
  const c = openContour(points.map(a => jsonClone(a)));
  const r = resolveBase(c, line);
  const P = r.pts;
  const t0 = norm(sub(P[0], P[1] ?? P[0])), t1 = norm(sub(P[P.length - 1], P[P.length - 2] ?? P[P.length - 1]));
  const first = c.points[0], last = c.points[c.points.length - 1];
  // freeze the end handles so the extension does not change the path's curved ends
  const h0 = sub(r.handles[0].hOut, r.anchorPos[0]), h1 = sub(r.handles[c.points.length - 1].hIn, r.anchorPos[c.points.length - 1]);
  if (Math.hypot(h0.x, h0.y) > 1e-12) first.hOut = h0;
  if (Math.hypot(h1.x, h1.y) > 1e-12) last.hIn = h1;
  first.smooth = false; last.smooth = false; first.kind = 'grade'; last.kind = 'grade';
  const a: Anchor = { id: newId('p'), ...add(P[0], mul(t0, e)), kind: 'grade', smooth: false, grade: {}, flags: {} };
  const b: Anchor = { id: newId('p'), ...add(P[P.length - 1], mul(t1, e)), kind: 'grade', smooth: false, grade: {}, flags: {} };
  return [a, ...c.points, b];
}

/**
 * Slash a piece with an open path (anchors, base coords). Uses the first two crossings of the
 * path with the sew line. `excludeInternalId` is removed (cut along an internal).
 */
export function slashCore(doc: Document, pieceId: Id, pathPoints: Anchor[], o: SlashOptions = {}, excludeInternalId?: Id): SlashResult {
  return doc.transact('Slash piece', style => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    if (piece.locked) throw new Error('Piece is locked');
    const gradeMode = o.gradeMode ?? 'auto';
    const snap = o.snap ?? 0.01;
    const work: Piece = jsonClone(piece);
    const sew = work.sew;
    // captured before topology changes
    const notchCaps = captureNotches(work, line);
    // ── path crossing with the sew line
    const path = openContour(extendPath(pathPoints, line, 1));
    const pr = resolveBase(path, line);
    const X = crossings(closedPoly(pr), closedPoly(resolveBase(sew, line)));
    if (X.length < 2) throw new Error('Cut line must cross the piece boundary twice');
    const x0 = X[0], x1 = X.find(x => x.sPath > x0.sPath + 1e-6 && dist(x.pt, x0.pt) > 1e-6);
    if (!x1) throw new Error('Cut line must cross the piece boundary twice');
    // ── insert the two sew anchors
    const r0 = resolveBase(sew, line);
    const i0 = splitAt(sew, line, closestArc(r0, x0.pt).s, { kind: 'grade', grading: gradeMode, piece: work, snap });
    const id0 = sew.points[i0].id;
    const i1 = splitAt(sew, line, closestArc(resolveBase(sew, line), x1.pt).s, { kind: 'grade', grading: gradeMode, piece: work, snap });
    const id1 = sew.points[i1].id;
    if (id0 === id1) throw new Error('Cut line ends coincide');
    for (const id of [id0, id1]) { const a = sew.points[idx(sew, id)]; if (gradeMode === 'zero' && !piece.sew.points.some(p => p.id === id)) { a.grade = {}; a.flags.zeroGrade = true; } }
    // ── cut path between the two crossings
    const cutPts = extractRange(path, line, x0.sPath, x1.sPath);
    const E0 = { x: sew.points[idx(sew, id0)].x, y: sew.points[idx(sew, id0)].y }, E1 = { x: sew.points[idx(sew, id1)].x, y: sew.points[idx(sew, id1)].y };
    cutPts[0].x = E0.x; cutPts[0].y = E0.y; cutPts[cutPts.length - 1].x = E1.x; cutPts[cutPts.length - 1].y = E1.y;
    // grading of path interior anchors
    const by = positionsBySize(sew, line), base = line.baseSizeId;
    const j0 = idx(sew, id0), j1 = idx(sew, id1);
    const cr = resolveBase(openContour(cutPts), line);
    const cl = lengthOf(cr);
    for (let k = 1; k < cutPts.length - 1; k++) {
      const a = cutPts[k];
      a.flags = {};
      if (gradeMode === 'zero') { if (a.kind === 'grade') { a.grade = {}; a.flags.zeroGrade = true; } else a.grade = Object.fromEntries(sizeIds(line).map(s => [s, { dx: 0, dy: 0 }])); continue; }
      if (a.kind !== 'grade' || Object.keys(a.grade ?? {}).length > 0) continue;
      const u = cl > 0 ? arcS(cr, k) / cl : 0;
      const off: Record<SizeId, Vec> = {};
      for (const s of sizeIds(line)) off[s] = lerp(sub(by[s][j0], by[base][j0]), sub(by[s][j1], by[base][j1]), u);
      a.grade = gradeFromOffsets(line, off);
    }
    const inner = cutPts.slice(1, -1).map(a => { const c = jsonClone(a); c.id = newId('p'); delete c.seamAfter; delete c.corner; return c; });
    const hFrom0 = cutPts[0].hOut, hInto1 = cutPts[cutPts.length - 1].hIn;
    // ── perimeter arcs
    const r = resolveBase(sew, line);
    const runA = extractRange(sew, line, arcS(r, j0), arcS(r, j0) + spanLen(r, j0, j1), { keepIds: true }); // E0 → E1
    const runB = extractRange(sew, line, arcS(r, j1), arcS(r, j1) + spanLen(r, j1, j0), { keepIds: true }); // E1 → E0
    const setSeam = (a: Anchor) => { if (o.seam !== undefined) a.seamAfter = o.seam; else delete a.seamAfter; };
    // half A: E0 → … → E1, then path reversed E1 → E0
    const innerRev = reverseAnchors(inner, false).map(a => ({ ...a, id: newId('p') }));
    const A = [...runA, ...innerRev];
    { const e1 = A[runA.length - 1], e0 = A[0];
      if (hInto1) e1.hOut = jsonClone(hInto1); if (hFrom0) e0.hIn = jsonClone(hFrom0);
      setSeam(e1); for (const a of innerRev) if (a.kind === 'grade') setSeam(a); }
    // half B: E1 → … → E0, then path E0 → E1 (E0/E1 copies get fresh ids)
    const innerB = inner.map(a => ({ ...jsonClone(a), id: newId('p') }));
    const B = [...runB, ...innerB];
    { const e1 = B[0], e0 = B[runB.length - 1];
      e1.id = newId('p'); e0.id = newId('p');
      if (hInto1) e1.hIn = jsonClone(hInto1); if (hFrom0) e0.hOut = jsonClone(hFrom0);
      setSeam(e0); for (const a of innerB) if (a.kind === 'grade') setSeam(a); }
    for (const a of [...A, ...B]) delete a.flags.startPoint;
    // ── build halves
    const startId = piece.sew.points.find(a => a.flags.startPoint)?.id ?? piece.sew.points[0].id;
    const halves = [A, B].map(pts => {
      const h: Piece = jsonClone(work);
      h.id = newId('pc');
      h.sew = { ...jsonClone(work.sew), id: newId('c'), points: pts };
      const si = pts.findIndex(a => a.id === startId);
      if (si > 0) h.sew.points = [...pts.slice(si), ...pts.slice(0, si)];
      h.sew.points[0].flags.startPoint = true;
      h.createdAt = now(); h.updatedAt = now();
      h.version = 0;
      delete h.reference;
      return h;
    });
    const hasStart = (h: Piece) => h.sew.points.some(a => a.id === startId);
    if (!hasStart(halves[0]) && hasStart(halves[1])) halves.reverse();
    // ── distribute live objects
    const polys = halves.map(h => resolveBase(h.sew, line).pts);
    const which = (p: Vec) => (pointInPolygon(p, polys[0]) ? 0 : pointInPolygon(p, polys[1]) ? 1 : (closestArc(resolveBase(halves[0].sew, line), p).d <= closestArc(resolveBase(halves[1].sew, line), p).d ? 0 : 1));
    const cutPoly = closedPoly(cr);
    const dropped: SlashResult['dropped'] = { darts: [], pleats: [], fullness: [], notches: [] };
    for (const h of halves) { h.internals = []; h.notches = []; h.drills = []; h.texts = []; h.artwork = []; h.darts = []; h.pleats = []; h.fullness = work.fullness ? [] : undefined; h.connections = []; }
    for (const c of work.internals) {
      if (c.id === excludeInternalId) continue;
      if (c.closed || c.points.length < 2) {
        const pr2 = resolveBase(c, line);
        halves[which(centroid(pr2.pts))].internals.push(jsonClone(c));
        continue;
      }
      const ss = crossings(closedPoly(resolveBase(c, line)), cutPoly).map(x => x.sPath);
      const parts = ss.length ? splitOpenAt(c, line, ss) : [c.points.map(a => jsonClone(a))];
      for (const p of parts) {
        const nc = ss.length ? internalLike(c, p) : jsonClone(c);
        const rr = resolveBase(nc, line);
        halves[which(pointAt(rr, lengthOf(rr) / 2).pt)].internals.push(nc);
      }
    }
    for (const d of work.drills) halves[which(d)].drills.push(jsonClone(d));
    for (const t of work.texts) halves[which(t)].texts.push(jsonClone(t));
    for (const a of work.artwork) halves[which(a)].artwork.push(jsonClone(a));
    const owner = (ids: Id[]) => { for (let k = 0; k < 2; k++) if (ids.every(id => halves[k].sew.points.some(a => a.id === id) || halves[k].internals.some(c => c.points.some(a => a.id === id)))) return k; return -1; };
    for (const d of work.darts) { const k = owner([d.legA, d.legB]); if (k < 0) dropped.darts.push(d.id); else halves[k].darts.push(jsonClone(d)); }
    for (const p of work.pleats) {
      const ids = (p.edges ?? []).flatMap(e => [e.fixed, e.moving, ...(e.mid ? [e.mid] : [])]);
      const k = ids.length ? owner(ids) : which(lerp(p.axisStart, p.axisEnd, 0.5));
      if (k < 0) dropped.pleats.push(p.id); else halves[k].pleats.push(jsonClone(p));
    }
    for (const f of work.fullness ?? []) {
      const ids = [...f.slashAnchorIds, ...(f.insertedIds ?? []), ...('anchorId' in f.pivot ? [f.pivot.anchorId] : [])];
      const k = owner(ids);
      if (k < 0) dropped.fullness.push(f.id); else halves[k].fullness!.push(jsonClone(f));
    }
    // live-object helper contours (dart / pleat axes) follow their objects
    for (let k = 0; k < 2; k++) {
      const h = halves[k];
      const axisIds = new Set([...h.darts.map(d => d.axisContourId), ...h.pleats.map(p => p.axisContourId)].filter(Boolean) as Id[]);
      const otherAxis = new Set([...halves[1 - k].darts.map(d => d.axisContourId), ...halves[1 - k].pleats.map(p => p.axisContourId)].filter(Boolean) as Id[]);
      h.internals = h.internals.filter(c => !otherAxis.has(c.id) || axisIds.has(c.id));
    }
    let rest = notchCaps.filter(c => c.contourId !== excludeInternalId || true);
    rest = restoreNotches(halves[0], line, rest, 1e-3);
    rest = restoreNotches(halves[1], line, rest, 1e-3);
    dropped.notches = rest.map(c => c.notch.id);
    for (const h of halves) {
      const has = (cid: Id, aid: Id) => h.internals.some(c => c.id === cid && c.points.some(a => a.id === aid));
      h.connections = work.connections.filter(pc => has(pc.internalContourId, pc.internalAnchorId) && h.sew.points.some(a => a.id === pc.externalAnchorId)).map(jsonClone);
      if (work.grain.centered) recenterGrainOf(h, line);
      if (h.half && !(onSew(h, line, h.half.a) && onSew(h, line, h.half.b))) delete h.half;
    }
    halves[0].name = `${piece.name}_1`; halves[1].name = `${piece.name}_2`;
    // ── commit
    const at = style.pieces.findIndex(p => p.id === piece.id);
    style.pieceArchive.push(jsonClone(piece));
    style.pieces.splice(at, 1, halves[0], halves[1]);
    return { pieceIds: [halves[0].id, halves[1].id], dropped };
  });
}

function onSew(p: Piece, line: SizeLine, q: Vec): boolean { return closestArc(resolveBase(p.sew, line), q).d < 1e-3; }

/** Translate the grain line so its midpoint sits on the piece centroid (direction & length kept). */
export function recenterGrainOf(p: Piece, line: SizeLine): void {
  const c = centroid(resolveBase(p.sew, line).pts);
  const m = lerp(p.grain.a, p.grain.b, 0.5), d = sub(c, m);
  p.grain.a = add(p.grain.a, d); p.grain.b = add(p.grain.b, d);
}

// ───────────────────────── public cuts ─────────────────────────

/**
 * Slash along a polyline from perimeter to perimeter (it may start/end slightly outside; the first
 * two boundary crossings are used). Returns the two new piece ids ([NAME_1, NAME_2]).
 */
export function slashPiece(doc: Document, pieceId: Id, cutPoints: Vec[], o: SlashOptions = {}): [Id, Id] {
  if (cutPoints.length < 2) throw new Error('Cut needs at least two points');
  return slashCore(doc, pieceId, polylineAnchors(cutPoints), o).pieceIds;
}

/** Cut along an internal line (its ends on — or crossing — the perimeter; curves kept exactly). The internal is consumed. */
export function cutAlongInternal(doc: Document, pieceId: Id, internalContourId: Id, o: SlashOptions = {}): [Id, Id] {
  const piece = doc.piece(pieceId);
  const c = internalOf(piece, internalContourId);
  if (c.closed) throw new Error('Cut along a closed internal is not a slash (use buildPiece)');
  return slashCore(doc, pieceId, c.points.map(a => jsonClone(a)), o, c.id).pieceIds;
}

function longLine(piece: Piece, line: SizeLine, P: Vec, dir: Vec): Vec[] {
  const b = bbox(resolveBase(piece.sew, line).pts);
  const R = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) + dist(P, { x: b.minX, y: b.minY }) + 10;
  const d = norm(dir);
  return [sub(P, mul(d, R)), add(P, mul(d, R))];
}

/** Horizontal ('H') or vertical ('V') cut through an anchor, offset by `offset` mm (V: +x, H: +y). */
export function cutHV(doc: Document, pieceId: Id, anchorId: Id, dir: 'H' | 'V', offset = 0, o: SlashOptions = {}): [Id, Id] {
  const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
  const { anchor } = findAnchorIn(piece, anchorId);
  const P = dir === 'V' ? { x: anchor.x + offset, y: anchor.y } : { x: anchor.x, y: anchor.y + offset };
  return slashPiece(doc, pieceId, longLine(piece, line, P, dir === 'V' ? { x: 0, y: 1 } : { x: 1, y: 0 }), o);
}

/** Cut along an infinite guide line through a and b. */
export function cutByGuideline(doc: Document, pieceId: Id, guide: { a: Vec; b: Vec }, o: SlashOptions = {}): [Id, Id] {
  const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
  return slashPiece(doc, pieceId, longLine(piece, line, guide.a, sub(guide.b, guide.a)), o);
}

/**
 * Cut a strip parallel to a sew segment (from → to, forward), `distance` mm inside the piece
 * (e.g. a waistband or facing). The parallel follows curves (offset of the sampled run) and is extended
 * straight at both ends to the perimeter. Returns [stripId, restId].
 */
export function cutParallel(doc: Document, pieceId: Id, segment: { from: Id; to: Id }, distance: number, o: SlashOptions = {}): [Id, Id] {
  const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
  const sew = piece.sew;
  const r = resolveBase(sew, line);
  const ia = idx(sew, segment.from), ib = idx(sew, segment.to);
  const run = spanPoly(r, ia, ib);
  const inward = -outwardSign(r); // multiply the LEFT normal: inside
  const off = offsetPolyline(run, { distances: inward * distance, closed: false, cleanup: true });
  const b = bbox(r.pts);
  const R = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) + 10;
  const t0 = norm(sub(off[0], off[1])), t1 = norm(sub(off[off.length - 1], off[off.length - 2]));
  const pathPts = [add(off[0], mul(t0, R)), ...off, add(off[off.length - 1], mul(t1, R))];
  const anchors = anchorsFromPolyline(pathPts, { tol: 0.005 });
  const midSeg = pointAt(r, arcS(r, ia) + spanLen(r, ia, ib) / 2).pt;
  const res = slashCore(doc, pieceId, anchors, o).pieceIds;
  const inA = closestArc(resolveBase(doc.piece(res[0]).sew, line), midSeg).d < 1e-3;
  return inA ? res : [res[1], res[0]];
}

