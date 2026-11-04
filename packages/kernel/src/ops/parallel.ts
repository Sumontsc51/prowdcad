/**
 * Parallel tools (A5): parallel internal lines, extend/shrink by moving a segment parallel to itself,
 * and parallel / perpendicular guide construction.
 */
import type { Anchor, Contour, Id, Piece, SizeLine } from '../model/types';
import type { Document } from '../model/doc';
import { newId } from '../model/factory';
import { Vec, add, sub, mul, norm, perp, dot, dist } from '../geom/vec';
import { offsetPolyline } from '../geom/poly';
import {
  findAnchorIn, contourOf, idx, between, resolveBase, arcS, spanLen, lengthOf, spanPoly, closedPoly, crossings,
  anchorsFromPolyline, outwardSign, arcSlice, closestArc, extractRange, lineLineIntersect,
} from '../geom/draft-geom';
import { splitOpenAt } from './segments';

export type SegmentRef = { from: Id; to: Id } | { internalId: Id };

export interface ParallelOptions {
  /** extend both ends straight until they hit the perimeter (or shorten to it) */
  extendToContour?: boolean;
  /** only a sub-range of the reference: [start, end] distances (mm) along it from its start */
  distanceAlongContour?: [number, number];
  name?: string;
  style?: Contour['style'];
}

function refPolyline(piece: Piece, line: SizeLine, ref: SegmentRef): { poly: Vec[]; closedRef: boolean; inward: number } {
  if ('internalId' in ref) {
    const c = contourOf(piece, ref.internalId);
    return { poly: closedPoly(resolveBase(c, line)), closedRef: c.closed, inward: 1 };
  }
  const { contour, index: ia } = findAnchorIn(piece, ref.from);
  const ib = idx(contour, ref.to);
  const r = resolveBase(contour, line);
  return { poly: spanPoly(r, ia, ib), closedRef: false, inward: contour.closed ? -outwardSign(r) : 1 };
}

/**
 * Create an internal line parallel to a perimeter segment or an internal. `side` +1 = towards the
 * piece interior for a perimeter segment (left of travel for an internal), −1 the other side.
 * Returns the new internal id.
 */
export function createParallelInternal(doc: Document, pieceId: Id, ref: SegmentRef, distance: number, side: 1 | -1 = 1, o: ParallelOptions = {}): Id {
  return doc.transact('Parallel line', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    let { poly, closedRef, inward } = refPolyline(piece, line, ref);
    if (o.distanceAlongContour) {
      const [s0, s1] = o.distanceAlongContour;
      const tmp: Contour = { id: 'tmp', type: 'internal', closed: false, points: anchorsFromPolyline(poly, { tol: 1e-4 }) };
      poly = arcSlice(resolveBase(tmp, line), s0, s1);
    }
    const d = distance * side * inward;
    let off = offsetPolyline(closedRef ? poly.slice(0, -1) : poly, { distances: d, closed: closedRef, cleanup: true });
    if (closedRef) off = [...off, off[0]];
    if (o.extendToContour && !closedRef) off = extendToPerimeter(piece, line, off);
    const pts = anchorsFromPolyline(off, { tol: 0.005, closed: closedRef });
    const c: Contour = { id: newId('c'), type: 'internal', closed: closedRef, points: pts, style: o.style ?? 'solid' };
    if (o.name) c.name = o.name;
    piece.internals.push(c);
    return c.id;
  });
}

/** Extend/trim an open polyline straight at both ends to the first perimeter crossing. */
function extendToPerimeter(piece: Piece, line: SizeLine, off: Vec[]): Vec[] {
  const sew = closedPoly(resolveBase(piece.sew, line));
  const R = 1e5;
  const t0 = norm(sub(off[0], off[1])), t1 = norm(sub(off[off.length - 1], off[off.length - 2]));
  const ext = [add(off[0], mul(t0, R)), ...off, add(off[off.length - 1], mul(t1, R))];
  const X = crossings(ext, sew);
  if (X.length < 2) return off;
  // the crossings nearest to the original ends (around the original body)
  const s0 = R, s1 = R + polyLen(off);
  const before = X.filter(x => x.sPath <= s0 + 1e-6), after = X.filter(x => x.sPath >= s1 - 1e-6);
  const inside = X.filter(x => x.sPath > s0 && x.sPath < s1);
  const a = before.length ? before[before.length - 1].sPath : inside[0]?.sPath ?? s0;
  const b = after.length ? after[0].sPath : inside[inside.length - 1]?.sPath ?? s1;
  const tmp: Contour = { id: 'tmp', type: 'internal', closed: false, points: ext.map(p => ({ id: newId('p'), x: p.x, y: p.y, kind: 'grade', smooth: false, grade: {}, flags: {} })) };
  return arcSlice(resolveBase(tmp, line), a, b);
}
function polyLen(p: Vec[]): number { let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return L; }

/**
 * Grow (+) or shrink (−) a piece by moving a sew segment parallel to itself by `amount` mm along its
 * outward normal (straight segments: the chord normal; curved runs move rigidly by the chord normal).
 * The neighbouring segments are lengthened/shortened along their own direction so their angles stay
 * (TUKA "Extend/Shrink parallel"). Multi-piece: pass several targets.
 */
export function extendParallel(doc: Document, targets: { pieceId: Id; from: Id; to: Id }[], amount: number): void {
  doc.transact('Extend parallel', () => {
    for (const t of targets) {
      const piece = doc.piece(t.pieceId), line = doc.sizeLine(piece);
      const sew = piece.sew;
      const r = resolveBase(sew, line);
      const ia = idx(sew, t.from), ib = idx(sew, t.to);
      const A = r.anchorPos[ia], B = r.anchorPos[ib];
      const chordDir = norm(sub(B, A));
      const out = mul(perp(chordDir), outwardSign(r)); // left normal × sign → outward
      const move = mul(out, amount);
      const n = sew.points.length;
      const prev = (ia - 1 + n) % n, next = (ib + 1) % n;
      // neighbouring segment directions (towards the segment ends)
      const dPrev = norm(sub(A, r.anchorPos[prev])), dNext = norm(sub(B, r.anchorPos[next]));
      const slide = (P: Vec, d: Vec): Vec => {
        const target = lineLineIntersect(P, d, add(A, move), chordDir);
        return target ? sub(target, P) : move;
      };
      const mA = slide(A, dPrev), mB = slide(B, dNext);
      const run = [ia, ...between(sew, ia, ib), ib];
      const sA = arcS(r, ia), L = spanLen(r, ia, ib);
      for (const k of run) {
        const u = k === ia ? 0 : k === ib ? 1 : L > 0 ? (arcS(r, k) - sA + (arcS(r, k) < sA ? lengthOf(r) : 0)) / L : 0;
        const d = add(mul(mA, 1 - u), mul(mB, u));
        sew.points[k].x += d.x; sew.points[k].y += d.y;
      }
    }
  });
}

// ───────────────────────── guides ─────────────────────────

export interface Guide { a: Vec; b: Vec }

/** Guide parallel to the chord of a segment at a signed offset (left of travel positive). */
export function parallelGuide(doc: Document, pieceId: Id, from: Id, to: Id, offset: number): Guide {
  const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
  const { contour, index: ia } = findAnchorIn(piece, from);
  const r = resolveBase(contour, line);
  const A = r.anchorPos[ia], B = r.anchorPos[idx(contour, to)];
  const nrm = perp(norm(sub(B, A)));
  return { a: add(A, mul(nrm, offset)), b: add(B, mul(nrm, offset)) };
}

/** Guide perpendicular to a contour at the point closest to `at` (or at an anchor), of given length each side. */
export function perpendicularGuide(doc: Document, pieceId: Id, contourId: Id, at: Vec | Id, halfLength = 100): Guide {
  const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
  const c = contourOf(piece, contourId);
  const r = resolveBase(c, line);
  const s = typeof at === 'string' ? arcS(r, idx(c, at)) : closestArc(r, at).s;
  const poly = closedPoly(r);
  // tangent from a small symmetric window
  const L = lengthOf(r), h = Math.min(0.5, L / 4);
  const pA = sampleAt(r, s - h), pB = sampleAt(r, s + h), P = sampleAt(r, s);
  void poly;
  const nrm = perp(norm(sub(pB, pA)));
  return { a: add(P, mul(nrm, -halfLength)), b: add(P, mul(nrm, halfLength)) };
}
function sampleAt(r: ReturnType<typeof resolveBase>, s: number): Vec {
  const L = lengthOf(r);
  if (!r.closed) s = Math.max(0, Math.min(L, s));
  return arcSlice(r, s, s)[0];
}

/** Guide through a point at an angle (degrees) — convenience for guide-based cuts. */
export function angleGuide(p: Vec, angleDeg: number, length = 100): Guide {
  const d = { x: Math.cos((angleDeg * Math.PI) / 180), y: Math.sin((angleDeg * Math.PI) / 180) };
  return { a: p, b: add(p, mul(d, length)) };
}

