/**
 * Move / Copy Line helpers.
 *
 *  copyLineTo        copy a sew segment or an internal line onto any piece as an internal line (affine map).
 *  lineFollowShape   move or copy a line so that its ends slide along the lines they are attached to
 *                    ("proportional to the body shape": a leg hem moved out follows the leg and gets narrower).
 */
import type { Anchor, Contour, Id, Piece, SizeLine } from '../model/types';
import type { Document } from '../model/doc';
import { Vec, add, sub, mul, dist, norm, dot, len } from '../geom/vec';
import { newId, makeContour } from '../model/factory';
import {
  contourOf, idx, resolveBase, arcS, spanLen, spanPoly, pointAt, closestArc, closedPoly, extractRange, transformAnchor,
  nextGrade, prevGrade, jsonClone, type Xf,
} from '../geom/draft-geom';

/** A line: a run of a contour (from → to, contour direction) or, without from / to, the whole contour. */
export interface LineRef { pieceId: Id; contourId: Id; from?: Id; to?: Id }
/** x' = a·x + c·y + e, y' = b·x + d·y + f */
export interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }

function affineXf(m: Affine): Xf {
  const rot = (Math.atan2(m.b, m.a) * 180) / Math.PI, mirror = m.a * m.d - m.b * m.c < 0;
  return {
    pt: p => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }),
    vec: v => ({ x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y }),
    ang: a => (mirror ? 2 * rot - a : a + rot), mirror,
  };
}
/** Fresh copies of the anchors of a line (new ids, no flags, no seam / corner data). */
function lineAnchors(piece: Piece, line: SizeLine, ref: LineRef): { pts: Anchor[]; closed: boolean } {
  const contour = contourOf(piece, ref.contourId);
  let pts: Anchor[]; let closed = false;
  if (ref.from && ref.to) {
    const ia = idx(contour, ref.from), ib = idx(contour, ref.to);
    if (ia < 0 || ib < 0) throw new Error('Line not found');
    const r = resolveBase(contour, line);
    pts = extractRange(contour, line, arcS(r, ia), arcS(r, ia) + spanLen(r, ia, ib));
  } else { pts = jsonClone(contour.points); closed = contour.closed; }
  for (const a of pts) { a.id = newId('p'); a.flags = {}; delete a.corner; delete a.seamAfter; delete a.hHold; delete a.name; delete a.ruleId; }
  if (!closed && pts.length) { pts[0].kind = 'grade'; pts[pts.length - 1].kind = 'grade'; delete pts[0].hIn; delete pts[pts.length - 1].hOut; }
  return { pts, closed };
}
function pushInternal(piece: Piece, pts: Anchor[], closed: boolean): Id {
  const c: Contour = makeContour(pts, { type: 'internal', closed });
  piece.internals.push(c);
  return c.id;
}

/** Copy a line onto `toPieceId` as an internal line; `m` maps source piece-local to target piece-local coordinates. */
export function copyLineTo(doc: Document, ref: LineRef, toPieceId: Id, m: Affine): Id {
  return doc.transact('Copy line', () => {
    const src = doc.piece(ref.pieceId), dst = doc.piece(toPieceId);
    if (dst.locked) throw new Error('Piece is locked');
    const { pts, closed } = lineAnchors(src, doc.sizeLine(src), ref);
    if (pts.length < 2) throw new Error('Nothing to copy');
    const xf = affineXf(m);
    for (const a of pts) transformAnchor(a, xf);
    // a different size table cannot carry the grading over
    if (src.sizeTableId !== dst.sizeTableId) for (const a of pts) { a.grade = {}; delete a.grade2; }
    return pushInternal(dst, pts, closed);
  });
}

// ───────────────────────── follow the shape ─────────────────────────

/** Intersection of the infinite line (o, t) with the segment a → b: parameter along a → b in [0, 1], or null. */
function hitSeg(o: Vec, t: Vec, a: Vec, b: Vec): number | null {
  const ab = sub(b, a); const den = t.x * ab.y - t.y * ab.x;
  if (Math.abs(den) < 1e-12) return null;
  const ao = sub(a, o); const u = (t.x * ao.y - t.y * ao.x) / -den;
  return u >= -1e-9 && u <= 1 + 1e-9 ? Math.max(0, Math.min(1, u)) : null;
}
interface RailHit { pt: Vec; /** distance from the line end: along the rail (+) or along its straight extension (−) */ s: number }
/** Where the offset line (o, t) meets a rail that starts at the line end `poly[0]`, or its straight extension beyond that end. */
function railHit(o: Vec, t: Vec, poly: Vec[]): RailHit | null {
  let best: RailHit | null = null;
  let acc = 0;
  for (let k = 0; k + 1 < poly.length; k++) {
    const l = dist(poly[k], poly[k + 1]);
    const u = hitSeg(o, t, poly[k], poly[k + 1]);
    if (u !== null) { best = { pt: add(poly[k], mul(sub(poly[k + 1], poly[k]), u)), s: acc + u * l }; break; }
    acc += l;
  }
  // straight extension beyond the end, along the direction the rail arrives with
  let q = 1; while (q < poly.length - 1 && dist(poly[0], poly[q]) < 1e-6) q++;
  const e = norm(sub(poly[0], poly[q]));
  if (len(e) > 0.5) {
    const den = t.x * e.y - t.y * e.x;
    if (Math.abs(den) > 1e-12) {
      const ao = sub(poly[0], o); const u = (t.x * ao.y - t.y * ao.x) / -den;
      if (u > 1e-9 && (!best || u < best.s)) best = { pt: add(poly[0], mul(e, u)), s: -u };
    }
  }
  return best;
}
/** Nearest point to `end` where the offset line meets the closed outline. */
function outlineHit(o: Vec, t: Vec, outline: Vec[], end: Vec): Vec | null {
  let best: Vec | null = null, bd = Infinity;
  for (let k = 0; k + 1 < outline.length; k++) {
    const u = hitSeg(o, t, outline[k], outline[k + 1]); if (u === null) continue;
    const p = add(outline[k], mul(sub(outline[k + 1], outline[k]), u)); const d = dist(p, end);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

export interface FollowResult { contourId?: Id; a: Vec; b: Vec; lengthBefore: number; lengthAfter: number }

/**
 * Move (or, with `copy`, copy as an internal line) a line by `d` at a right angle to itself while its ends
 * follow the shape: the ends of a sew segment slide along the two neighbouring segments (or their straight
 * extension), the ends of an internal line that sit on the outline slide along the outline. The points of the
 * line keep their proportions between the two new ends. Base size.
 */
export function lineFollowShape(doc: Document, ref: LineRef, d: Vec, o: { copy?: boolean } = {}): FollowResult {
  return doc.transact(o.copy ? 'Copy line (follow shape)' : 'Move line (follow shape)', () => {
    const piece = doc.piece(ref.pieceId), line = doc.sizeLine(piece);
    if (piece.locked) throw new Error('Piece is locked');
    const contour = contourOf(piece, ref.contourId);
    const P = contour.points, n = P.length;
    const r = resolveBase(contour, line);
    const onSew = contour === piece.sew;
    let ia = 0, ib = n - 1;
    if (ref.from && ref.to) { ia = idx(contour, ref.from); ib = idx(contour, ref.to); }
    else if (contour.closed) throw new Error('Follow shape needs an open line or one segment');
    if (ia < 0 || ib < 0 || ia === ib) throw new Error('Line not found');
    const A = r.anchorPos[ia], B = r.anchorPos[ib];
    const t = norm(sub(B, A)); if (len(t) < 0.5) throw new Error('The line has no length');
    const nrm = { x: -t.y, y: t.x };
    const k = dot(d, nrm);
    const O = add(A, mul(nrm, k));
    let hA: RailHit | null = null, hB: RailHit | null = null; let pg = -1, ng = -1;
    let A1: Vec, B1: Vec;
    if (onSew && contour.closed) {
      pg = prevGrade(contour, ia, false); ng = nextGrade(contour, ib);
      if (pg < 0 || ng < 0 || pg === ia || ng === ib) throw new Error('The line has no neighbouring lines to follow');
      hA = railHit(O, t, spanPoly(r, pg, ia).reverse());
      hB = railHit(O, t, spanPoly(r, ib, ng));
      if (!hA || !hB) throw new Error('The line cannot follow the shape that far');
      A1 = hA.pt; B1 = hB.pt;
    } else {
      const r0 = resolveBase(piece.sew, line); const outline = closedPoly(r0);
      const end = (E: Vec): Vec => (closestArc(r0, E).d < 0.5 ? outlineHit(O, t, outline, E) : null) ?? add(E, mul(nrm, k));
      A1 = end(A); B1 = end(B);
    }
    if (dist(A1, B1) < 1e-6 || dot(sub(B1, A1), t) <= 0) throw new Error('The line cannot follow the shape that far');
    // similarity A → A1, B → B1 (complex ratio)
    const u = sub(B, A), v = sub(B1, A1), uu = dot(u, u);
    const re = (v.x * u.x + v.y * u.y) / uu, im = (v.y * u.x - v.x * u.y) / uu;
    const xvec = (q: Vec): Vec => ({ x: re * q.x - im * q.y, y: im * q.x + re * q.y });
    const xpt = (q: Vec): Vec => add(A1, xvec(sub(q, A)));
    const xf: Xf = { pt: xpt, vec: xvec, ang: a => a + (Math.atan2(im, re) * 180) / Math.PI, mirror: false };
    const res: FollowResult = { a: A1, b: B1, lengthBefore: spanLen(r, ia, ib), lengthAfter: 0 };
    const ids: number[] = []; for (let j = ia; ; j = (j + 1) % n) { ids.push(j); if (j === ib) break; }

    if (o.copy) {
      const { pts } = lineAnchors(piece, line, ref.from && ref.to ? ref : { ...ref, from: P[ia].id, to: P[ib].id });
      for (const a of pts) transformAnchor(a, xf);
      res.contourId = pushInternal(piece, pts, false);
      const c = piece.internals[piece.internals.length - 1];
      const rr = resolveBase(c, line); res.lengthAfter = rr.cum[rr.cum.length - 1] ?? 0;
      return res;
    }
    // the neighbouring lines: their curve points keep their proportion along the shortened / extended line
    const moves: { a: Anchor; p: Vec; k: number }[] = [];
    if (hA && hB && pg !== ib && ng !== ia) {
      const L0a = spanLen(r, pg, ia), L1a = L0a - hA.s, sP = arcS(r, pg);
      const eA = norm(sub(A, spanPoly(r, pg, ia).reverse().find(q => dist(q, A) > 1e-6) ?? A));
      for (let j = (pg + 1) % n; j !== ia; j = (j + 1) % n) {
        const s1 = (spanLen(r, pg, j) * L1a) / L0a;
        moves.push({ a: P[j], p: s1 <= L0a ? pointAt(r, sP + s1).pt : add(A, mul(eA, s1 - L0a)), k: L1a / L0a });
      }
      const L0b = spanLen(r, ib, ng), L1b = L0b - hB.s, sN = arcS(r, ng);
      const eB = norm(sub(B, spanPoly(r, ib, ng).find(q => dist(q, B) > 1e-6) ?? B));
      for (let j = (ib + 1) % n; j !== ng; j = (j + 1) % n) {
        const s1 = (spanLen(r, j, ng) * L1b) / L0b;
        moves.push({ a: P[j], p: s1 <= L0b ? pointAt(r, sN - s1).pt : add(B, mul(eB, s1 - L0b)), k: L1b / L0b });
      }
    }
    for (const j of ids) { const a = P[j]; const p = xpt(r.anchorPos[j]); a.x = p.x; a.y = p.y; if (a.hIn) a.hIn = xvec(a.hIn); if (a.hOut) a.hOut = xvec(a.hOut); }
    for (const m of moves) { m.a.x = m.p.x; m.a.y = m.p.y; if (m.a.hIn) m.a.hIn = mul(m.a.hIn, m.k); if (m.a.hOut) m.a.hOut = mul(m.a.hOut, m.k); }
    const rr = resolveBase(contour, line); res.lengthAfter = spanLen(rr, ia, ib);
    return res;
  });
}
