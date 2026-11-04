/**
 * A8 — Scale & Shrink.
 *
 * Axes: X = across grain, Y = along grain (the grain line direction). With the default vertical grain
 * these are world X / Y. The scale centre is the centre of the base-size sew-line bounding box measured
 * in that grain frame.
 *
 * Input forms
 *  - {xPct, yPct}: percent growth (f = 1 + pct/100), or with proportionalTo100 a SHRINKAGE percent
 *    (f = 100 / (100 − pct)) so the piece is spec after washing: 10 % → +11.111…%.
 *  - {xAbs, yAbs}: target base-size width / height (mm) in the grain frame.
 *  - {xInc, yInc}: mm added to base-size width / height.
 * Missing axis ⇒ factor 1.
 *
 * scaleGrading 'nest': geometry of every size scales (grade increments scale too).
 * scaleGrading 'base': only base coordinates scale; grade increments are kept as-is.
 * scaleSeam: seam allowances scale by the exact perpendicular stretch of each segment's normal
 *   (d' = d / |M⁻ᵀ n|; = fy for a horizontal seam, fx for a vertical one).
 * Notch fromPrev/fromNext distances are rescaled per size by (new segment length / old segment length)
 * so notches keep their proportional position on the scaled seam.
 */
import type { Document } from '../model/doc';
import type { Anchor, Contour, GradeInc, Id, Piece, SizeId, SizeLine } from '../model/types';
import { type ResolvedContour, resolveContour, totalLength } from '../model/contour';
import { type Vec, sub, norm, len, rotate } from '../geom/vec';
import { mod, anchorS } from './measure';

export type ScaleInput = { xPct?: number; yPct?: number } | { xAbs?: number; yAbs?: number } | { xInc?: number; yInc?: number };
export interface ScaleOptions {
  scaleGrading: 'nest' | 'base';
  scaleSeam: boolean;
  stampDescription: boolean;
  proportionalTo100: boolean;
}
export interface ScaleResult { fx: number; fy: number; about: Vec; grainAngleRad: number }

const DEFAULT_OPTS: ScaleOptions = { scaleGrading: 'nest', scaleSeam: false, stampDescription: false, proportionalTo100: false };

/** Growth factor from a percent. proportionalTo100: shrinkage compensation 100/(100−pct). */
export function pctToFactor(pct: number, proportionalTo100: boolean): number {
  if (!proportionalTo100) return 1 + pct / 100;
  if (pct >= 100) throw new Error('Shrinkage must be < 100 %');
  return 100 / (100 - pct);
}

type Mat = [number, number, number, number]; // [a b; c d] · (x, y)
const apply = (m: Mat, v: Vec): Vec => ({ x: m[0] * v.x + m[1] * v.y, y: m[2] * v.x + m[3] * v.y });

function grainFrame(piece: Piece): { ang: number } {
  const g = norm(sub(piece.grain.b, piece.grain.a));
  // local Y = grain direction ⇒ rotation from world Y to grain
  const ang = len(g) < 1e-12 ? 0 : Math.atan2(g.y, g.x) - Math.PI / 2;
  return { ang };
}

/** Width/height and centre of the base sew line in the grain frame. */
function grainBox(doc: Document, piece: Piece, ang: number): { w: number; h: number; centre: Vec } {
  const r = doc.resolveContour(piece, piece.sew);
  const loc = r.pts.map(p => rotate(p, -ang));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of loc) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return { w: maxX - minX, h: maxY - minY, centre: rotate({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, ang) };
}

function segLenAt(r: ResolvedContour, idx: number, forward: boolean): number {
  const g = r.gradeIdx, L = totalLength(r);
  const k = g.indexOf(idx);
  if (k < 0 || g.length === 0) return L;
  const other = forward ? (r.closed ? g[(k + 1) % g.length] : g[Math.min(k + 1, g.length - 1)])
    : (r.closed ? g[mod(k - 1, g.length)] : g[Math.max(k - 1, 0)]);
  const d = forward ? anchorS(r, other) - anchorS(r, idx) : anchorS(r, idx) - anchorS(r, other);
  const v = r.closed ? mod(d, L) : Math.abs(d);
  return r.closed && v < 1e-9 ? L : v;
}

export function scalePiece(doc: Document, pieceId: Id, input: ScaleInput, opts: Partial<ScaleOptions> = {}): ScaleResult {
  const o: ScaleOptions = { ...DEFAULT_OPTS, ...opts };
  const piece0 = doc.piece(pieceId);
  const { ang } = grainFrame(piece0);
  const box = grainBox(doc, piece0, ang);
  let fx = 1, fy = 1;
  const inp = input as Record<string, number | undefined>;
  if ('xPct' in inp || 'yPct' in inp) { fx = pctToFactor(inp.xPct ?? 0, o.proportionalTo100); fy = pctToFactor(inp.yPct ?? 0, o.proportionalTo100); }
  else if ('xAbs' in inp || 'yAbs' in inp) { if (inp.xAbs !== undefined) fx = inp.xAbs / box.w; if (inp.yAbs !== undefined) fy = inp.yAbs / box.h; }
  else if ('xInc' in inp || 'yInc' in inp) { fx = (box.w + (inp.xInc ?? 0)) / box.w; fy = (box.h + (inp.yInc ?? 0)) / box.h; }
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx <= 0 || fy <= 0) throw new Error('Invalid scale factors');

  // M = R · diag(fx, fy) · R⁻¹
  const c = Math.cos(ang), s = Math.sin(ang);
  const M: Mat = [
    c * c * fx + s * s * fy, c * s * (fy - fx),
    c * s * (fy - fx), s * s * fx + c * c * fy,
  ];
  const det = M[0] * M[3] - M[1] * M[2];
  const MinvT: Mat = [M[3] / det, -M[2] / det, -M[1] / det, M[0] / det];
  const about = box.centre;
  const P = (p: Vec): Vec => { const d = apply(M, sub(p, about)); return { x: about.x + d.x, y: about.y + d.y }; };
  const line = doc.sizeLine(piece0);
  const sizes = doc.sizesOf(piece0);

  // old per-size segment lengths for notch rescaling
  const contours = (pc: Piece): Contour[] => [pc.sew, ...pc.internals];
  const resolveAll = (pc: Piece) => {
    const m = new Map<Id, Map<SizeId, ResolvedContour>>();
    for (const ct of contours(pc)) { const mm = new Map<SizeId, ResolvedContour>(); for (const sz of sizes) mm.set(sz, resolveContour(ct, line, sz)); m.set(ct.id, mm); }
    return m;
  };
  const before = resolveAll(piece0);

  const gradeMap = (g: Record<SizeId, GradeInc> | undefined, axisDeg?: number): Record<SizeId, GradeInc> => {
    const out: Record<SizeId, GradeInc> = {};
    if (!g) return out;
    for (const k of Object.keys(g)) {
      let v: Vec = { x: g[k].dx, y: g[k].dy };
      if (axisDeg) v = rotate(v, axisDeg * Math.PI / 180);
      v = apply(M, v);
      if (axisDeg) v = rotate(v, -axisDeg * Math.PI / 180);
      out[k] = { dx: v.x, dy: v.y };
    }
    return out;
  };
  const nest = o.scaleGrading === 'nest';
  const scaleAnchor = (a: Anchor) => {
    const p = P(a); a.x = p.x; a.y = p.y;
    if (a.hIn) a.hIn = apply(M, a.hIn);
    if (a.hOut) a.hOut = apply(M, a.hOut);
    if (nest) a.grade = gradeMap(a.grade, a.gradeAxisDeg);
    if (a.corner?.manualPoints) a.corner.manualPoints = a.corner.manualPoints.map(P);
    if (a.corner?.lockedPerSize) for (const k of Object.keys(a.corner.lockedPerSize)) a.corner.lockedPerSize[k] = a.corner.lockedPerSize[k].map(P);
  };
  const scaleXY = (e: { x: number; y: number; grade: Record<SizeId, GradeInc> }) => { const p = P(e); e.x = p.x; e.y = p.y; if (nest) e.grade = gradeMap(e.grade); };

  doc.transact('Scale piece', () => {
    const pc = doc.piece(pieceId);
    if (o.scaleSeam) {
      // seam: per grade segment, from base-size chord direction
      const r = resolveContour(pc.sew, line, line.baseSizeId);
      const g = r.gradeIdx;
      g.forEach((gi, k) => {
        const nxt = r.closed ? g[(k + 1) % g.length] : g[Math.min(k + 1, g.length - 1)];
        const d = norm(sub(r.anchorPos[nxt], r.anchorPos[gi]));
        const n = { x: -d.y, y: d.x };
        const f = len(n) < 1e-12 ? Math.sqrt(fx * fy) : 1 / len(apply(MinvT, n));
        const a = pc.sew.points[gi];
        a.seamAfter = (a.seamAfter ?? pc.seamDefault) * f;
      });
    }
    for (const ct of contours(pc)) ct.points.forEach(scaleAnchor);
    if (pc.manualCut) pc.manualCut.points.forEach(scaleAnchor);
    for (const d of pc.darts) scaleXY(d.apex);
    for (const pl of pc.pleats) { scaleXY(pl.axisStart); scaleXY(pl.axisEnd); }
    for (const d of pc.drills) scaleXY(d);
    for (const t of pc.texts) scaleXY(t);
    for (const a of pc.artwork) { scaleXY(a); a.scaleX *= fx; a.scaleY *= fy; }
    pc.grain.a = P(pc.grain.a); pc.grain.b = P(pc.grain.b);
    if (nest) { pc.grain.gradeA = gradeMap(pc.grain.gradeA); pc.grain.gradeB = gradeMap(pc.grain.gradeB); }
    if (pc.half) { pc.half.a = P(pc.half.a); pc.half.b = P(pc.half.b); }
    // notch distances
    const after = resolveAll(pc);
    for (const nt of pc.notches) {
      const pl = nt.placement;
      if (pl.kind !== 'fromPrev' && pl.kind !== 'fromNext') continue;
      const ct = contours(pc).find(x => x.id === nt.contourId); if (!ct) continue;
      const idx = ct.points.findIndex(a => a.id === pl.anchorId); if (idx < 0) continue;
      for (const sz of Object.keys(pl.dist)) {
        const rb = before.get(ct.id)?.get(sz), ra = after.get(ct.id)?.get(sz);
        if (!rb || !ra) continue;
        const lb = segLenAt(rb, idx, pl.kind === 'fromPrev'), la = segLenAt(ra, idx, pl.kind === 'fromPrev');
        if (lb > 1e-12) pl.dist[sz] = pl.dist[sz] * la / lb;
      }
    }
    if (o.stampDescription) {
      const pct = (f: number) => `${f >= 1 ? '+' : ''}${((f - 1) * 100).toFixed(3)}%`;
      const stamp = `SCALE X${pct(fx)} Y${pct(fy)}`;
      pc.description = pc.description ? `${pc.description} | ${stamp}` : stamp;
    }
  });
  return { fx, fy, about, grainAngleRad: ang };
}

