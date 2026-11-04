/**
 * Segment & internal-line tools (A5): copy/paste segment, slash-pivot rotate, swap internal ⇄ perimeter,
 * divide/join internals, dashed lines, trimming, global trim/join, extend.
 */
import type { Anchor, Contour, Id, Piece, SizeLine } from '../model/types';
import type { Document } from '../model/doc';
import { newId } from '../model/factory';
import { Vec, add, sub, mul, dist, norm, dot, cross, rotate, len, perp } from '../geom/vec';
import { area, pointInPolygon, slice as polySlice } from '../geom/poly';
import {
  findAnchorIn, contourOf, idx, nextGrade, between, resolveBase, arcS, spanLen, lengthOf, closedPoly, closestArc, pointAt,
  splitAt, extractRange, reverseAnchors, freeze, jsonClone, crossings, captureNotches, restoreNotches, closestSNear,
  sewPolygon, sideOf,
} from '../geom/draft-geom';

// ───────────────────────── shared internal-contour helpers ─────────────────────────

export function internalOf(piece: Piece, id: Id): Contour {
  const c = piece.internals.find(c => c.id === id);
  if (!c) throw new Error('No internal contour ' + id);
  return c;
}

/** Resolved base polyline of a contour (closed contours repeat the first point). */
export function polyOf(c: Contour, line: SizeLine): Vec[] { return closedPoly(resolveBase(c, line)); }

/** Split an open contour at base arc lengths, returning the anchor lists of the pieces (geometry exact). */
export function splitOpenAt(c: Contour, line: SizeLine, cuts: number[]): Anchor[][] {
  const r = resolveBase(c, line), L = lengthOf(r);
  const ss = [0, ...cuts.filter(s => s > 1e-6 && s < L - 1e-6).sort((a, b) => a - b), L];
  const out: Anchor[][] = [];
  for (let k = 0; k + 1 < ss.length; k++) {
    if (ss[k + 1] - ss[k] < 1e-6) continue;
    out.push(extractRange(c, line, ss[k], ss[k + 1]));
  }
  return out;
}

/** Make a new open internal contour like `proto` with the given anchors. */
export function internalLike(proto: Contour, points: Anchor[]): Contour {
  const c: Contour = { ...jsonClone(proto), id: newId('c'), points, closed: false };
  return c;
}

/** Replace internal `old` by `parts`, moving its notches by position. */
function replaceInternal(piece: Piece, line: SizeLine, old: Contour, parts: Contour[]): void {
  const caps = captureNotches(piece, line, [old.id]);
  const at = piece.internals.findIndex(c => c.id === old.id);
  piece.internals.splice(at, 1, ...parts);
  piece.connections = piece.connections.filter(pc => pc.internalContourId !== old.id);
  const lost = restoreNotches(piece, line, caps, 1e-3);
  for (const l of lost) piece.notches = piece.notches.filter(n => n.id !== l.notch.id);
}

// ───────────────────────── copy / paste segment ─────────────────────────

export interface SegmentClip {
  /** anchors in a local frame: start at origin, chord along +x (y = left of travel) */
  anchors: Anchor[];
  chord: number;
  length: number;
}
export type PasteMode = 'proportional-to-external' | 'proportional-to-internal' | 'exact';

/** Copy the run fromAnchor → toAnchor (forward along the contour) into a chord-local clip. */
export function copySegment(doc: Document, pieceId: Id, fromAnchorId: Id, toAnchorId: Id): SegmentClip {
  const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
  const { contour, index: ia } = findAnchorIn(piece, fromAnchorId);
  const ib = idx(contour, toAnchorId);
  const r = resolveBase(contour, line);
  const run = extractRange(contour, line, arcS(r, ia), arcS(r, ia) + spanLen(r, ia, ib));
  const A = r.anchorPos[ia], B = r.anchorPos[ib];
  const chord = dist(A, B);
  if (chord < 1e-9) throw new Error('Segment has zero chord');
  const ang = Math.atan2(B.y - A.y, B.x - A.x);
  for (const a of run) {
    const p = rotate(sub(a, A), -ang); a.x = p.x; a.y = p.y;
    if (a.hIn) a.hIn = rotate(a.hIn, -ang); if (a.hOut) a.hOut = rotate(a.hOut, -ang);
    a.grade = {}; delete a.gradeAxisDeg;
  }
  // endpoints: keep the inner handles (they define the shape); exact endpoint positions
  run[0].x = 0; run[0].y = 0; run[run.length - 1].x = chord; run[run.length - 1].y = 0;
  return { anchors: run, chord, length: spanLen(r, ia, ib) };
}

/**
 * Paste a clip between two anchors of a contour (forward run from → to), replacing its intermediate
 * points. Modes:
 *  - 'exact': the copied shape is placed rigidly at `from`, aligned to the target chord direction; the
 *    `to` anchor moves to the clip's end (all sizes).
 *  - 'proportional-to-external': the shape is stretched along the chord to fit the target chord; its
 *    perpendicular deviation keeps its absolute mm depth.
 *  - 'proportional-to-internal': uniform scale (deviation scales with the chord ratio).
 * `flip` mirrors the shape to the other side of the chord.
 */
export function pasteSegment(doc: Document, pieceId: Id, fromAnchorId: Id, toAnchorId: Id, clip: SegmentClip, mode: PasteMode = 'proportional-to-external', o: { flip?: boolean } = {}): Id[] {
  return doc.transact('Paste segment', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const { contour, index: ia } = findAnchorIn(piece, fromAnchorId);
    let ib = idx(contour, toAnchorId);
    const A = { x: contour.points[ia].x, y: contour.points[ia].y };
    let B = { x: contour.points[ib].x, y: contour.points[ib].y };
    const tChord = dist(A, B);
    const dir = tChord > 1e-9 ? norm(sub(B, A)) : { x: 1, y: 0 };
    const sx = mode === 'exact' ? 1 : tChord / clip.chord;
    const sy = (mode === 'proportional-to-internal' ? sx : 1) * (o.flip ? -1 : 1);
    const map = (v: Vec): Vec => { const q = { x: v.x * sx, y: v.y * sy }; return { x: dir.x * q.x - dir.y * q.y, y: dir.y * q.x + dir.x * q.y }; };
    if (mode === 'exact') {
      B = add(A, map({ x: clip.chord, y: 0 }));
      contour.points[ib].x = B.x; contour.points[ib].y = B.y;
    }
    // freeze neighbours beyond the run so their spans are unaffected
    const r = resolveBase(contour, line);
    const n = contour.points.length;
    const before = contour.closed ? (ia - 1 + n) % n : ia - 1, after = contour.closed ? (ib + 1) % n : ib + 1;
    for (const k of [before, after]) if (k >= 0 && k < n && (contour.points[k].smooth || contour.points[k].hIn || contour.points[k].hOut) && k !== ia && k !== ib) freeze(contour, r, k);
    const fa = contour.points[ia], fb = contour.points[ib];
    if (fa.smooth && !fa.hIn) freeze(contour, r, ia);
    if (fb.smooth && !fb.hOut) freeze(contour, r, ib);
    const src = clip.anchors;
    if (src[0].hOut) fa.hOut = map(src[0].hOut); else delete fa.hOut;
    if (src[src.length - 1].hIn) fb.hIn = map(src[src.length - 1].hIn!); else delete fb.hIn;
    if (!src[0].hOut && fa.smooth) fa.smooth = false;
    if (!src[src.length - 1].hIn && fb.smooth) fb.smooth = false;
    const mids = src.slice(1, -1).map(a => {
      const c = jsonClone(a); c.id = newId('p');
      const p = add(A, map(a)); c.x = p.x; c.y = p.y;
      if (c.hIn) c.hIn = map(c.hIn); if (c.hOut) c.hOut = map(c.hOut);
      if (o.flip && c.hIn && c.hOut) { /* mirrored handles stay consistent (map is linear) */ }
      c.flags = {}; c.grade = {};
      return c;
    });
    // remove old intermediates, insert new
    const old = new Set(between(contour, ia, ib).map(i => contour.points[i].id));
    const caps = captureNotches(piece, line, [contour.id]).filter(c => old.has(c.notch.placement.anchorId));
    contour.points = contour.points.filter(a => !old.has(a.id));
    const at = idx(contour, fromAnchorId);
    contour.points.splice(at + 1, 0, ...mids);
    ib = idx(contour, toAnchorId);
    restoreNotches(piece, line, caps, 50);
    return mids.map(m => m.id);
  });
}

// ───────────────────────── rotate segment (slash-pivot) ─────────────────────────

/**
 * Rotate the run from → to about one of its ends (the other end and the intermediates move);
 * the run's arc length is preserved exactly (rigid rotation). `angleDeg` CCW.
 */
export function rotateSegmentPreservingLength(doc: Document, pieceId: Id, fromAnchorId: Id, toAnchorId: Id, pivot: 'from' | 'to', angleDeg: number): void {
  doc.transact('Rotate segment', () => {
    const piece = doc.piece(pieceId);
    const { contour, index: ia } = findAnchorIn(piece, fromAnchorId);
    const ib = idx(contour, toAnchorId);
    const P = pivot === 'from' ? contour.points[ia] : contour.points[ib];
    const rad = (angleDeg * Math.PI) / 180;
    const ids = [...between(contour, ia, ib), pivot === 'from' ? ib : ia];
    for (const k of ids) {
      const a = contour.points[k];
      const q = rotate(a, rad, P); a.x = q.x; a.y = q.y;
      // handles inside the run rotate with it; the outward handle of the moving end too (keeps the joint shape)
      if (a.hIn) a.hIn = rotate(a.hIn, rad); if (a.hOut) a.hOut = rotate(a.hOut, rad);
    }
    const pa = pivot === 'from' ? contour.points[ia] : contour.points[ib];
    if (pivot === 'from' && pa.hOut) pa.hOut = rotate(pa.hOut, rad);
    if (pivot === 'to' && pa.hIn) pa.hIn = rotate(pa.hIn, rad);
  });
}

// ───────────────────────── swap segment ─────────────────────────

/**
 * Swap an internal style line with the perimeter run between its two endpoints: the internal becomes
 * perimeter and the old perimeter run becomes an internal. The endpoints must lie on the sew line
 * (within `tol`); anchors are inserted there if needed. Of the two perimeter arcs, the one replaced is
 * `replace` ('forward' = sew order from the internal's first point, 'backward') or, by default, the
 * one whose replacement keeps the larger area. Returns the id of the new internal (old perimeter).
 */
export function swapSegment(doc: Document, pieceId: Id, internalId: Id, o: { tol?: number; replace?: 'forward' | 'backward' } = {}): Id {
  return doc.transact('Swap segment', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const tol = o.tol ?? 0.5;
    const ic = internalOf(piece, internalId);
    if (ic.closed) throw new Error('Swap needs an open internal');
    const ir = resolveBase(ic, line);
    const P0 = ir.anchorPos[0], P1 = ir.anchorPos[ic.points.length - 1];
    const sew = piece.sew;
    const r0 = resolveBase(sew, line);
    const c0 = closestArc(r0, P0), c1 = closestArc(r0, P1);
    if (c0.d > tol || c1.d > tol) throw new Error('Internal endpoints are not on the perimeter');
    const caps = captureNotches(piece, line);
    const i0 = splitAt(sew, line, c0.s, { kind: 'grade', piece, snap: tol });
    const id0 = sew.points[i0].id;
    const r1 = resolveBase(sew, line);
    const i1 = splitAt(sew, line, closestArc(r1, P1).s, { kind: 'grade', piece, snap: tol });
    const id1 = sew.points[i1].id;
    const ia = idx(sew, id0), ib = idx(sew, id1);
    const r = resolveBase(sew, line);
    // freeze the two endpoints so the remaining perimeter keeps its shape
    freeze(sew, r, ia); freeze(sew, r, ib);
    const fwdRun = [ia, ...between(sew, ia, ib), ib];    // ia → ib
    const bwdRun = [ib, ...between(sew, ib, ia), ia];    // ib → ia
    const inner = ic.points.slice(1, -1).map(a => ({ ...jsonClone(a), grade: { ...a.grade } }));
    const innerFirst = ic.points[0], innerLast = ic.points[ic.points.length - 1];
    // candidate A: replace forward arc (ia→ib) by the internal (forward direction P0→P1)
    const build = (replaceFwd: boolean): Anchor[] => {
      const keep = replaceFwd ? bwdRun : fwdRun; // kept arc, from its start to its end
      const pts = keep.map(i => jsonClone(sew.points[i]));
      // kept arc goes ib→ia (replaceFwd) then internal ia→ib (P0→P1) ; else ia→ib then internal reversed ib→ia
      let mids = inner.map(a => jsonClone(a));
      let hStart = innerFirst.hOut, hEnd = innerLast.hIn;
      if (!replaceFwd) { mids = reverseAnchors(mids, false); [hStart, hEnd] = [innerLast.hIn, innerFirst.hOut]; }
      const last = pts[pts.length - 1], first = pts[0];
      if (hStart) last.hOut = hStart; else delete last.hOut;
      if (hEnd) first.hIn = hEnd; else delete first.hIn;
      last.smooth = false; first.smooth = false;
      for (const m of mids) { m.id = newId('p'); m.flags = {}; }
      // closed contour: kept arc then internal mids (closing edge goes back to kept start)
      return [...pts, ...mids];
    };
    const areaOf = (pts: Anchor[]) => area(resolveBase({ ...sew, points: pts }, line).pts);
    const cand = { f: build(true), b: build(false) };
    const replaceFwd = o.replace ? o.replace === 'forward' : areaOf(cand.f) >= areaOf(cand.b);
    const replacedRun = replaceFwd ? fwdRun : bwdRun;
    const oldArc = extractRange(sew, line, arcS(r, replacedRun[0]), arcS(r, replacedRun[0]) + spanLen(r, replacedRun[0], replacedRun[replacedRun.length - 1]));
    const newPts = replaceFwd ? cand.f : cand.b;
    // seam: the new perimeter segment leaving the internal's start inherits the seam of the replaced arc's start
    const seamOfReplaced = sew.points[replacedRun[0]].seamAfter;
    sew.points = newPts;
    const endKept = sew.points[(replaceFwd ? bwdRun : fwdRun).length - 1];
    if (seamOfReplaced !== undefined) endKept.seamAfter = seamOfReplaced; else delete endKept.seamAfter;
    // keep start point flag on the sew
    if (!sew.points.some(a => a.flags.startPoint)) sew.points[0].flags.startPoint = true;
    for (const a of oldArc) { a.flags = { ...a.flags, startPoint: undefined }; delete a.flags.startPoint; delete a.seamAfter; delete a.corner; }
    const newInternal: Contour = { id: newId('c'), type: 'internal', closed: false, points: oldArc, style: ic.style ?? 'solid' };
    piece.internals = piece.internals.filter(c => c.id !== ic.id);
    piece.internals.push(newInternal);
    piece.connections = piece.connections.filter(pc => pc.internalContourId !== ic.id && sew.points.some(a => a.id === pc.externalAnchorId));
    for (const c of caps) piece.notches = piece.notches.filter(n => n.id !== c.notch.id);
    restoreNotches(piece, line, caps, 1e-3, () => piece.sew.id);
    return newInternal.id;
  });
}

// ───────────────────────── divide / join / dashed ─────────────────────────

/** Split an internal contour at one of its anchors. Open → two contours; closed → opened at the anchor. */
export function divideContour(doc: Document, pieceId: Id, internalId: Id, anchorId: Id): Id[] {
  return doc.transact('Divide contour', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const c = internalOf(piece, internalId);
    const i = idx(c, anchorId);
    const r = resolveBase(c, line);
    if (c.closed) {
      const s = arcS(r, i);
      const pts = extractRange(c, line, s, s + lengthOf(r), { keepIds: true });
      pts[pts.length - 1].id = newId('p');
      const nc = internalLike(c, pts);
      replaceInternal(piece, line, c, [nc]);
      return [nc.id];
    }
    if (i === 0 || i === c.points.length - 1) throw new Error('Cannot divide at an end point');
    const parts = splitOpenAt(c, line, [arcS(r, i)]).map(p => internalLike(c, p));
    replaceInternal(piece, line, c, parts);
    return parts.map(p => p.id);
  });
}

/** Join two open internals sharing an endpoint (within tol). The shared point becomes a grade corner. */
export function joinContours(doc: Document, pieceId: Id, idA: Id, idB: Id, tol = 0.5): Id {
  return doc.transact('Join contours', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const a = internalOf(piece, idA), b = internalOf(piece, idB);
    const joined = joinAnchorLists(a.points, b.points, tol);
    if (!joined) throw new Error('Contours do not share an end point');
    const caps = captureNotches(piece, line, [a.id, b.id]);
    const nc = internalLike(a, joined.points);
    nc.closed = joined.closed;
    const at = piece.internals.findIndex(c => c.id === a.id);
    piece.internals.splice(at, 1, nc);
    piece.internals = piece.internals.filter(c => c.id !== b.id);
    piece.connections = piece.connections.filter(pc => pc.internalContourId !== a.id && pc.internalContourId !== b.id);
    restoreNotches(piece, line, caps, 1e-2);
    return nc.id;
  });
}

function joinAnchorLists(A: Anchor[], B: Anchor[], tol: number): { points: Anchor[]; closed: boolean } | null {
  const e = (p: Anchor[], end: boolean) => (end ? p[p.length - 1] : p[0]);
  const tries: [Anchor[], Anchor[]][] = [
    [A, B], [A, reverseAnchors(B, false)], [reverseAnchors(A, false), B], [reverseAnchors(A, false), reverseAnchors(B, false)],
  ];
  for (const [x, y] of tries) {
    if (dist(e(x, true), e(y, false)) <= tol) {
      const xs = x.map(p => jsonClone(p)), ys = y.map(p => jsonClone(p));
      const j = xs[xs.length - 1], k = ys[0];
      j.kind = 'grade'; j.smooth = false;
      if (k.hOut) j.hOut = k.hOut; else delete j.hOut;
      const pts = [...xs, ...ys.slice(1)];
      const closed = dist(pts[0], pts[pts.length - 1]) <= tol && pts.length > 3;
      if (closed) { const last = pts.pop()!; if (last.hIn) pts[0].hIn = last.hIn; }
      return { points: pts, closed };
    }
  }
  return null;
}

/** Turn a contour (internal) into a dashed line; `false` restores solid. */
export function contourToDashedLines(doc: Document, pieceId: Id, contourId: Id, dashed = true): void {
  doc.transact('Dashed line', () => {
    const piece = doc.piece(pieceId);
    const c = contourOf(piece, contourId);
    if (c.id === piece.sew.id) {
      // perimeter: add a dashed internal copy (the perimeter itself stays the cutting boundary)
      piece.internals.push({ ...jsonClone(c), id: newId('c'), type: 'internal', style: 'dashed', mode: 'draw', points: c.points.map(a => ({ ...jsonClone(a), id: newId('p'), flags: {} })) });
      return;
    }
    c.style = dashed ? 'dashed' : 'solid';
  });
}

// ───────────────────────── trimming ─────────────────────────

/** Arc positions (on internal c) where it crosses the perimeter and/or other internals. */
function crossParams(piece: Piece, line: SizeLine, c: Contour, against: 'all' | 'perimeter' | Id[]): number[] {
  const P = polyOf(c, line);
  const targets: Contour[] = against === 'perimeter' ? [piece.sew]
    : against === 'all' ? [piece.sew, ...piece.internals.filter(x => x.id !== c.id)]
    : [piece.sew, ...piece.internals].filter(x => against.includes(x.id) && x.id !== c.id);
  const ss: number[] = [];
  for (const t of targets) for (const x of crossings(P, polyOf(t, line))) ss.push(x.sPath);
  ss.sort((a, b) => a - b);
  return ss.filter((s, i) => i === 0 || s - ss[i - 1] > 1e-6);
}

/**
 * Trim an internal at its crossings with other internals and/or the perimeter.
 * With `keep` (a point near the part to keep), only the part between the crossings nearest to it
 * remains. Without it, the overhanging end parts lying outside the perimeter are removed.
 * Returns the id(s) of the remaining contour(s).
 */
export function trimAtIntersections(doc: Document, pieceId: Id, internalId: Id, o: { keep?: Vec; against?: 'all' | 'perimeter' | Id[] } = {}): Id[] {
  return doc.transact('Trim', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const c = internalOf(piece, internalId);
    if (c.closed) throw new Error('Trim needs an open internal');
    const ss = crossParams(piece, line, c, o.against ?? (o.keep ? 'all' : 'perimeter'));
    if (!ss.length) return [c.id];
    const parts = splitOpenAt(c, line, ss);
    let kept: Anchor[][];
    if (o.keep) {
      let best = 0, bd = Infinity;
      parts.forEach((p, i) => { const d = closestArc(resolveBase(internalLike(c, p), line), o.keep!).d; if (d < bd) { bd = d; best = i; } });
      kept = [parts[best]];
    } else {
      const sp = sewPolygon(piece, line);
      kept = parts.filter((p, i) => {
        if (i !== 0 && i !== parts.length - 1) return true;
        const r = resolveBase(internalLike(c, p), line);
        return pointInPolygon(pointAt(r, lengthOf(r) / 2).pt, sp);
      });
    }
    const out = kept.map(p => internalLike(c, p));
    replaceInternal(piece, line, c, out);
    return out.map(x => x.id);
  });
}

/** Clip every open internal to the perimeter (parts outside are removed). Returns the number of internals changed. */
export function globalCheckAndTrimInternals(doc: Document, pieceIds?: Id[]): number {
  return doc.transact('Global trim internals', () => {
    let changed = 0;
    for (const piece of doc.style.pieces) {
      if (pieceIds && !pieceIds.includes(piece.id)) continue;
      const line = doc.sizeLine(piece);
      const sp = sewPolygon(piece, line);
      for (const c of piece.internals.slice()) {
        if (c.closed || c.type !== 'internal' || c.points.length < 2) continue;
        const ss = crossParams(piece, line, c, 'perimeter');
        const parts = splitOpenAt(c, line, ss);
        const inside = parts.filter(p => { const r = resolveBase(internalLike(c, p), line); return pointInPolygon(pointAt(r, lengthOf(r) / 2).pt, sp) || insideOrOn(pointAt(r, lengthOf(r) / 2).pt, sp); });
        if (!ss.length && inside.length === 1) continue;
        if (inside.length === parts.length && parts.length === 1) continue;
        replaceInternal(piece, line, c, inside.map(p => internalLike(c, p)));
        changed++;
      }
    }
    return changed;
  });
}
function insideOrOn(p: Vec, poly: Vec[]): boolean {
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; if (Math.abs(sideOf(p, a, b)) < 1e-6 && dot(sub(p, a), sub(p, b)) <= 0) return true; }
  return false;
}

/** Repeatedly join open internals whose endpoints meet (within tol). Returns the number of joins. */
export function globalJoinInternals(doc: Document, pieceIds?: Id[], tol = 0.5): number {
  return doc.transact('Global join internals', () => {
    let joins = 0;
    for (const piece of doc.style.pieces) {
      if (pieceIds && !pieceIds.includes(piece.id)) continue;
      let again = true;
      while (again) {
        again = false;
        const open = piece.internals.filter(c => !c.closed && c.type === 'internal' && c.points.length >= 2);
        outer: for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
          if (joinAnchorLists(open[i].points, open[j].points, tol)) { joinContours(doc, piece.id, open[i].id, open[j].id, tol); joins++; again = true; break outer; }
        }
      }
    }
    return joins;
  });
}

// ───────────────────────── extend ─────────────────────────

/**
 * Extend (or shorten, negative `by`) an open contour at one end. Extension is straight along the end
 * tangent; `upTo` extends until the first hit with that contour. Returns the new length.
 */
export function extendContour(doc: Document, pieceId: Id, contourId: Id, end: 'start' | 'end', how: { by: number } | { upTo: Id }): number {
  return doc.transact('Extend contour', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    const c = contourOf(piece, contourId);
    if (c.closed) throw new Error('Extend needs an open contour');
    const r = resolveBase(c, line);
    const P = r.pts;
    const tip = end === 'end' ? P[P.length - 1] : P[0];
    let k = end === 'end' ? P.length - 2 : 1;
    while (k > 0 && k < P.length - 1 && dist(P[k], tip) < 1e-9) k += end === 'end' ? -1 : 1;
    const t = norm(sub(tip, P[k]));
    let by: number;
    if ('by' in how) by = how.by;
    else {
      const target = contourOf(piece, how.upTo);
      const T = polyOf(target, line);
      const far = add(tip, mul(t, 1e5));
      const hits = crossings([tip, far], T).filter(h => h.sPath > 1e-6);
      if (!hits.length) throw new Error('Extension does not reach the target contour');
      by = hits[0].sPath;
    }
    if (by >= 0) {
      if (by < 1e-9) return lengthOf(r);
      const q = add(tip, mul(t, by));
      const ia = end === 'end' ? c.points.length - 1 : 0;
      freeze(c, r, ia);
      const a = c.points[ia];
      a.kind = 'grade'; a.smooth = false;
      if (end === 'end') delete a.hOut; else delete a.hIn;
      const na: Anchor = { id: newId('p'), x: q.x, y: q.y, kind: 'grade', smooth: false, grade: {}, flags: {} };
      if (end === 'end') c.points.push(na); else c.points.unshift(na);
    } else {
      const L = lengthOf(r);
      if (-by >= L) throw new Error('Cannot shorten by the whole length');
      const caps = captureNotches(piece, line, [c.id]);
      c.points = end === 'end' ? extractRange(c, line, 0, L + by, { keepIds: true }) : extractRange(c, line, -by, L, { keepIds: true });
      restoreNotches(piece, line, caps, 1e-3);
    }
    return lengthOf(resolveBase(c, line));
  });
}

/** Extend an internal line (by value or up to a contour). */
export function extendInternal(doc: Document, pieceId: Id, internalId: Id, end: 'start' | 'end', how: { by: number } | { upTo: Id }): number {
  const piece = doc.piece(pieceId);
  internalOf(piece, internalId);
  return extendContour(doc, pieceId, internalId, end, how);
}

