/**
 * Clip Line: internal lines that cross a sew segment, or end close to it, are clipped to that
 * segment and locked on it.
 *
 *  - crosses    the part of the line beyond the segment (outside the piece) is cut off; the new end
 *               point sits on the segment. The rest of the line keeps its exact shape.
 *  - close      an end within `tol` of the segment is extended straight along the line's own direction
 *               until it meets the segment (a line that would miss it is pulled to the nearest point
 *               of the segment, unless it runs alongside the segment: a parallel line is left alone).
 *  - on         an end already on the segment is just locked.
 *
 * Every clipped end is then attached with an 'ends' lock (ops/lock.ts) at its position kept as a
 * ratio of the segment, so it follows the segment when that moves, changes length or grades.
 * Closed internals and lines locked parallel / follow are never touched.
 */
import type { Anchor, Contour, Id, LockEnd, LockMeasure, Piece, SizeLine } from '../model/types';
import type { Document } from '../model/doc';
import { newId } from '../model/factory';
import { isStraightSpan, type ResolvedContour } from '../model/contour';
import { Vec, sub, add, mul, dist, norm, dot } from '../geom/vec';
import { closestPoint, pointInPolygon } from '../geom/poly';
import { resolveBase, spanPoly, lengthOf, pointAt, crossings, extractRange, freeze, captureNotches, restoreNotches } from '../geom/draft-geom';
import { applyInternalLocks, lockableEnds } from './lock';

/** Default "close" distance (mm): an end this near to the segment is extended onto it. */
export const CLIP_TOL = 10;

export interface ClipSpan { from: Id; to: Id }
export interface ClipOptions {
  /** sew segments to clip to (default: every grade segment of the sew line) */
  spans?: ClipSpan[];
  /** only these internal lines (default: every open internal of the piece) */
  contourIds?: Id[];
  /** mm (base size): how close an end must be to be extended onto the segment. Default CLIP_TOL */
  tol?: number;
  /** kept position of the locked end on its segment (default 'ratio') */
  measure?: LockMeasure;
}
/** One end of one internal line that Clip Line would change. `pt` / `tip` are base-size, piece-local. */
export interface ClipEnd {
  contourId: Id; end: 'start' | 'end';
  how: 'trim' | 'extend' | 'lock';
  span: ClipSpan;
  /** where the end will be */
  pt: Vec;
  /** where the end is now */
  tip: Vec;
  /** arc position (base) on the internal where it is cut ('trim') */
  s?: number;
}

/** Every grade segment of the sew line as a span. */
export function sewSpans(piece: Piece): ClipSpan[] {
  const pts = piece.sew.points;
  const g = pts.map((a, i) => (a.kind === 'grade' ? i : -1)).filter(i => i >= 0);
  const out: ClipSpan[] = [];
  for (let k = 0; k < g.length; k++) {
    if (k === g.length - 1) { if (piece.sew.closed && g.length > 1) out.push({ from: pts[g[k]].id, to: pts[g[0]].id }); break; }
    out.push({ from: pts[g[k]].id, to: pts[g[k + 1]].id });
  }
  return out;
}

function clippable(c: Contour, o: ClipOptions): boolean {
  if (o.contourIds && !o.contourIds.includes(c.id)) return false;
  if (c.closed || c.points.length < 2) return false;
  if (c.type !== undefined && c.type !== 'internal') return false;
  return !c.lock || c.lock.kind === 'ends';
}

/** What `clipInternals` would do, without changing anything (hover preview). */
export function clipPlan(piece: Piece, line: SizeLine, o: ClipOptions = {}): ClipEnd[] {
  const tol = o.tol ?? CLIP_TOL;
  const sew: ResolvedContour = resolveBase(piece.sew, line);
  const poly = piece.sew.closed ? sew.pts : null;
  const spans: { span: ClipSpan; S: Vec[] }[] = [];
  for (const sp of o.spans ?? sewSpans(piece)) {
    const ia = piece.sew.points.findIndex(a => a.id === sp.from), ib = piece.sew.points.findIndex(a => a.id === sp.to);
    if (ia < 0 || ib < 0 || (!piece.sew.closed && ib < ia)) continue;
    const S = spanPoly(sew, ia, ib);
    if (S.length >= 2) spans.push({ span: sp, S });
  }
  if (!spans.length) return [];
  const out: ClipEnd[] = [];
  for (const c of piece.internals) {
    if (!clippable(c, o)) continue;
    const r = resolveBase(c, line);
    const P = r.pts, L = lengthOf(r);
    if (P.length < 2 || L < 1e-6) continue;
    // crossings with every span, along the internal
    const X: { s: number; pt: Vec; span: ClipSpan }[] = [];
    for (const sp of spans) for (const x of crossings(P, sp.S)) X.push({ s: x.sPath, pt: x.pt, span: sp.span });
    X.sort((a, b) => a.s - b.s);
    const ends: ['start' | 'end', Vec][] = [['start', P[0]], ['end', P[P.length - 1]]];
    const plans: ClipEnd[] = [];
    for (const [end, tip] of ends) {
      // already on a segment → lock only
      let on: { span: ClipSpan; pt: Vec; d: number } | null = null;
      for (const sp of spans) { const cp = closestPoint(sp.S, tip); if (!on || cp.d < on.d) on = { span: sp.span, pt: cp.pt, d: cp.d }; }
      if (on && on.d <= 0.05) { plans.push({ contourId: c.id, end, how: 'lock', span: on.span, pt: on.pt, tip }); continue; }
      // crosses → cut at the crossing nearest to this end when the line leaves the piece there
      const x = end === 'start' ? X.find(q => q.s > 1e-6) : [...X].reverse().find(q => q.s < L - 1e-6);
      if (x) {
        const tail = end === 'start' ? x.s : L - x.s;
        const step = Math.min(0.5, tail / 2);
        const beyond = pointAt(r, end === 'start' ? x.s - step : x.s + step).pt;
        let cut: boolean;
        if (poly) cut = !pointInPolygon(beyond, poly);
        else { const other = end === 'start' ? L - x.s : x.s; cut = tail < other; }
        if (cut) { plans.push({ contourId: c.id, end, how: 'trim', span: x.span, pt: x.pt, tip, s: x.s }); continue; }
      }
      // close → extend along the line's own direction
      if (!on || on.d > tol) continue;
      let k = end === 'end' ? P.length - 2 : 1;
      while (k > 0 && k < P.length - 1 && dist(P[k], tip) < 1e-9) k += end === 'end' ? -1 : 1;
      const t = norm(sub(tip, P[k]));
      let best: { span: ClipSpan; pt: Vec; d: number } | null = null;
      for (const sp of spans) {
        const hit = crossings([tip, add(tip, mul(t, tol * 4))], sp.S).find(h => h.sPath > 1e-9);
        if (hit && (!best || hit.sPath < best.d)) best = { span: sp.span, pt: hit.pt, d: hit.sPath };
      }
      if (!best) {
        // the line would miss the segment: pull the end to its nearest point, unless it runs alongside
        const dir = norm(sub(on.pt, tip));
        if (dot(dir, t) < 0.5) continue;
        best = on;
      }
      plans.push({ contourId: c.id, end, how: 'extend', span: best.span, pt: best.pt, tip });
    }
    // both ends cut at the same crossing would leave nothing
    if (plans.length === 2 && plans[0].how === 'trim' && plans[1].how === 'trim' && (plans[1].s! - plans[0].s!) < 1e-6) continue;
    out.push(...plans);
  }
  return out;
}

export interface ClipResult { lines: number; ends: number; trimmed: number; extended: number; locked: number }

/**
 * Clip the internal lines of a piece to its sew segment(s) and lock the clipped ends on them.
 * One undo step. Returns what was done (ends = end points now locked).
 */
export function clipInternals(doc: Document, pieceId: Id, o: ClipOptions = {}): ClipResult {
  return doc.transact('Clip line', () => {
    const piece = doc.piece(pieceId), line = doc.sizeLine(piece);
    if (piece.locked) throw new Error('Piece is locked');
    const plan = clipPlan(piece, line, o);
    const res: ClipResult = { lines: 0, ends: 0, trimmed: 0, extended: 0, locked: 0 };
    const ids = [...new Set(plan.map(p => p.contourId))];
    for (const cid of ids) {
      const c = piece.internals.find(q => q.id === cid)!;
      const mine = plan.filter(p => p.contourId === cid);
      const ps = mine.find(p => p.end === 'start'), pe = mine.find(p => p.end === 'end');
      // 1) cut off the parts beyond the segment (shape of the rest unchanged)
      if (ps?.how === 'trim' || pe?.how === 'trim') {
        const L = lengthOf(resolveBase(c, line));
        const s0 = ps?.how === 'trim' ? ps.s! : 0, s1 = pe?.how === 'trim' ? pe.s! : L;
        const caps = captureNotches(piece, line, [c.id]);
        c.points = extractRange(c, line, s0, s1, { keepIds: true });
        piece.connections = (piece.connections ?? []).filter(pc => pc.internalContourId !== c.id || c.points.some(a => a.id === pc.internalAnchorId));
        restoreNotches(piece, line, caps, 1e-3);
      }
      // 2) extend the close ends onto the segment
      for (const p of mine) {
        if (p.how !== 'extend') continue;
        const r = resolveBase(c, line);
        const n = c.points.length;
        const ia = p.end === 'end' ? n - 1 : 0, ib = p.end === 'end' ? n - 2 : 1;
        const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
        const straight = isStraightSpan(r.anchorPos[lo], r.handles[lo].hOut, r.handles[hi].hIn, r.anchorPos[hi]);
        const a = c.points[ia];
        if (straight && !a.hIn && !a.hOut) { a.x = p.pt.x; a.y = p.pt.y; }
        else {
          freeze(c, r, ia);
          a.kind = 'grade'; a.smooth = false;
          if (p.end === 'end') delete a.hOut; else delete a.hIn;
          const na: Anchor = { id: newId('p'), x: p.pt.x, y: p.pt.y, kind: 'grade', smooth: false, grade: {}, flags: {} };
          if (p.end === 'end') c.points.push(na); else c.points.unshift(na);
        }
      }
      // 3) lock every clipped end on its segment
      const n = c.points.length;
      c.points[0].kind = 'grade'; c.points[n - 1].kind = 'grade';
      const ends: LockEnd[] = [];
      for (const p of mine) ends.push(...lockableEnds(piece, line, c, { which: p.end, span: p.span, tol: 0.2, measure: o.measure }));
      if (!ends.length) continue;
      const prev = c.lock?.kind === 'ends' ? c.lock.ends.filter(e => !ends.some(x => x.anchorId === e.anchorId) && c.points.some(a => a.id === e.anchorId)) : [];
      c.lock = { kind: 'ends', ends: [...prev, ...ends] };
      res.lines++; res.ends += ends.length;
      for (const p of mine) { if (p.how === 'trim') res.trimmed++; else if (p.how === 'extend') res.extended++; else res.locked++; }
    }
    if (res.lines) applyInternalLocks(piece, line);
    return res;
  });
}
