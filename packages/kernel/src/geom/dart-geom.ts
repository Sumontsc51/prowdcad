/**
 * Shared geometry for the live darts / pleats / fullness modules.
 *
 * - Contour positions are id-relative (`ContourPosRef`: arc mm forward from a sew anchor) so they
 *   survive inserts.
 * - A "spread" (slash & spread, pleat opening) splits the sew contour at a slash point S and a hinge
 *   H, inserts a MOVING copy next to the fixed anchor and rigidly moves the arc between the moving
 *   copies (`liveSpreadOnce`). The rigid motion is a translation (parallel spread / equal pleat
 *   depth) or a rotation about a centre on the S–H line chosen so the chord openings at S and H are
 *   exactly openA / openB (`liveSpreadXf`).
 * - Reversibility: before an op `liveCapture` copies every anchor / apex / drill; afterwards
 *   `liveSnapshotDiff` keeps only what changed. `liveRestore` writes those copies back by id and
 *   removes the inserted anchors, which reproduces the pre-op contour exactly (the neighbours whose
 *   handles `splitAt` froze are part of the diff).
 */
import type { Anchor, Contour, ContourPosRef, Id, LiveSnapshot, Piece, SizeId, SizeLine, GradeInc } from '../model/types';
import { anchorPositions } from '../model/contour';
import { Vec, add, sub, mul, dist, norm, cross, perp, rotate } from './vec';
import { pointInPolygon, distToPolygon } from './poly';
import {
  resolveBase, arcS, fwd, pointAt, splitAt, jsonClone, idx, outwardSign, spanPoly, closestArc,
  xfRotate, xfTranslate, transformAnchor, gradeFromOffsets, sizeIds, type Xf,
} from './draft-geom';
import { absoluteOffset } from '../model/contour';
import { newId } from '../model/factory';

/** User-facing contour position: `distance` mm (base size, along the contour, forward) from an anchor. */
export interface LiveContourPos { fromAnchorId: Id; distance: number }

export const liveRef = (p: LiveContourPos): ContourPosRef => ({ fromAnchor: p.fromAnchorId, dist: p.distance });

/** Base arc position of a ref on the (current) contour. */
export function liveArcOf(contour: Contour, line: SizeLine, ref: ContourPosRef): number {
  const r = resolveBase(contour, line);
  return arcS(r, idx(contour, ref.fromAnchor)) + ref.dist;
}

/** Id-relative ref for arc position s: nearest anchor at/before s whose id is not excluded. */
export function liveRefAt(contour: Contour, line: SizeLine, s: number, exclude: Set<Id> = new Set()): ContourPosRef {
  const r = resolveBase(contour, line);
  let best = -1, bd = Infinity;
  for (let i = 0; i < contour.points.length; i++) {
    if (exclude.has(contour.points[i].id)) continue;
    const d = fwd(r, arcS(r, i), s);
    if (d < bd - 1e-12) { bd = d; best = i; }
  }
  if (best < 0) throw new Error('liveRefAt: no anchor');
  return { fromAnchor: contour.points[best].id, dist: bd };
}

/** Inward unit normal of a closed contour at arc s (base). */
export function liveInward(contour: Contour, line: SizeLine, s: number): { pt: Vec; tangent: Vec; inward: Vec } {
  const r = resolveBase(contour, line);
  const p = pointAt(r, s);
  const out = mul(perp(p.tangent), outwardSign(r));
  return { pt: p.pt, tangent: p.tangent, inward: mul(out, -1) };
}

/**
 * Split at s; when a NEW anchor is created and `id` given, it takes that id. Returns the index and
 * whether the anchor was created (false = an existing anchor within 1e-4 mm was reused).
 */
export function liveSplit(piece: Piece, line: SizeLine, s: number, id?: Id): { index: number; created: boolean } {
  const c = piece.sew, n0 = c.points.length;
  const i = splitAt(c, line, s, { kind: 'grade', piece });
  const created = c.points.length > n0;
  if (created && id) c.points[i].id = id;
  return { index: i, created };
}

/**
 * Remove anchor i, merging its two spans back into one (inverse of de Casteljau when the anchor was
 * produced by `splitAt`: t = |hIn| / (|hIn| + |hOut|)). Straight spans: plain removal.
 */
export function liveUnsplit(contour: Contour, i: number): void {
  const n = contour.points.length;
  const m = contour.points[i];
  const p = contour.points[(i - 1 + n) % n], q = contour.points[(i + 1) % n];
  if (m.hIn && m.hOut) {
    const a = Math.hypot(m.hIn.x, m.hIn.y), b = Math.hypot(m.hOut.x, m.hOut.y);
    if (a + b > 1e-12) {
      const t = a / (a + b);
      if (p.hOut && t > 1e-9) p.hOut = mul(p.hOut, 1 / t);
      if (q.hIn && 1 - t > 1e-9) q.hIn = mul(q.hIn, 1 / (1 - t));
    }
  }
  contour.points.splice(i, 1);
}

/** Absolute per-size offset average of several anchors → incremental grading. */
export function liveAvgGrade(line: SizeLine, grades: (Record<SizeId, GradeInc> | undefined)[]): Record<SizeId, GradeInc> {
  const off: Record<SizeId, Vec> = {};
  for (const s of sizeIds(line)) {
    let x = 0, y = 0;
    for (const g of grades) { const o = absoluteOffset(g, line, s); x += o.x; y += o.y; }
    off[s] = { x: x / grades.length, y: y / grades.length };
  }
  return gradeFromOffsets(line, off);
}

/** Absolute per-size offsets of the sew anchors (materialised, incl. interpolated curve points). */
export function liveAnchorOffsets(contour: Contour, line: SizeLine, i: number): Record<SizeId, Vec> {
  const base = anchorPositions(contour.points, line, line.baseSizeId, contour.closed)[i];
  const out: Record<SizeId, Vec> = {};
  for (const s of sizeIds(line)) out[s] = sub(anchorPositions(contour.points, line, s, contour.closed)[i], base);
  return out;
}

// ───────────────────────── spread transform ─────────────────────────

export interface LiveSpreadXf { xf: Xf; hingeOpen: number; centre?: Vec; angle?: number; shift?: Vec }

/**
 * Rigid motion that opens the slash S by chord `openA` and the hinge H by chord `openB`, moving
 * toward the side of the line S→H where `sidePt` lies. `parallel` (or openA == openB) → translation
 * perpendicular to S→H by openA. Otherwise rotation about C on line SH with
 * |C−S| : |C−H| = openA : openB (C = `pivot` when given). Negative opening = overlap.
 */
export function liveSpreadXf(S: Vec, H: Vec, openA: number, openB: number, sidePt: Vec, parallel: boolean, pivot?: Vec): LiveSpreadXf {
  const u = norm(sub(H, S));
  const sideSign = Math.sign(cross(u, sub(sidePt, S))) || 1;
  if (parallel || Math.abs(openA - openB) < 1e-12) {
    const d = mul(perp(u), sideSign * openA);
    return { xf: xfTranslate(d), hingeOpen: openA, shift: d };
  }
  const C = pivot ?? add(S, mul(sub(H, S), openA / (openA - openB)));
  const useS = Math.abs(openA) >= Math.abs(openB);
  const Q = useS ? S : H, o = useS ? openA : openB;
  const R = dist(Q, C);
  if (R < 1e-12) throw new Error('Spread: degenerate rotation centre');
  let phi = 2 * Math.asin(Math.min(1, Math.abs(o) / (2 * R)));
  const test = rotate(Q, phi, C);
  const s = Math.sign(cross(u, sub(test, S)));
  if (s !== sideSign * Math.sign(o)) phi = -phi;
  const xf = xfRotate(C, phi);
  const Hm = xf.pt(H);
  const hingeOpen = dist(H, Hm) * (Math.sign(cross(u, sub(Hm, S))) === sideSign ? 1 : -1);
  return { xf, hingeOpen, centre: C, angle: phi };
}

// ───────────────────────── region transform ─────────────────────────

function xfObj(o: { x: number; y: number; grade?: Record<SizeId, GradeInc>; grade2?: Record<SizeId, GradeInc> }, xf: Xf) {
  const p = xf.pt(o); o.x = p.x; o.y = p.y;
  for (const g of [o.grade, o.grade2]) if (g) for (const k of Object.keys(g)) { const v = xf.vec({ x: g[k].dx, y: g[k].dy }); g[k] = { dx: v.x, dy: v.y }; }
}

/**
 * Apply xf to the internal objects lying in region `poly` (base coords): internal contours (all
 * anchors in/on the region and their mean strictly inside), drills, texts, dart apexes, pleat axes
 * (axis midpoint inside). Sew anchors are moved by the caller.
 */
export function liveTransformRegion(piece: Piece, poly: Vec[], xf: Xf, skip: { contourIds?: Set<Id>; dartIds?: Set<Id>; pleatIds?: Set<Id> } = {}): void {
  const inR = (p: Vec) => pointInPolygon(p, poly) || distToPolygon(p, poly) < 1e-6;
  const inside = (p: Vec) => pointInPolygon(p, poly) && distToPolygon(p, poly) > 1e-6;
  for (const c of piece.internals) {
    if (skip.contourIds?.has(c.id) || c.points.length === 0) continue;
    if (!c.points.every(inR)) continue;
    const m = { x: c.points.reduce((a, p) => a + p.x, 0) / c.points.length, y: c.points.reduce((a, p) => a + p.y, 0) / c.points.length };
    if (!inside(m) && !c.points.some(inside)) continue;
    for (const a of c.points) transformAnchor(a, xf);
  }
  for (const d of piece.drills) if (inR(d)) xfObj(d, xf);
  for (const t of piece.texts) if (inR(t)) { xfObj(t, xf); t.angleDeg = xf.ang(t.angleDeg); }
  for (const d of piece.darts) if (!skip.dartIds?.has(d.id) && inR(d.apex)) xfObj(d.apex, xf);
  for (const p of piece.pleats) {
    if (skip.pleatIds?.has(p.id)) continue;
    const m = { x: (p.axisStart.x + p.axisEnd.x) / 2, y: (p.axisStart.y + p.axisEnd.y) / 2 };
    if (inside(m)) { xfObj(p.axisStart, xf); xfObj(p.axisEnd, xf); }
  }
}

// ───────────────────────── snapshot / restore ─────────────────────────

export interface LivePre { anchors: Map<Id, string>; apexes: Map<string, string>; drills: Map<string, string> }

export function liveCapture(piece: Piece): LivePre {
  const anchors = new Map<Id, string>();
  for (const c of [piece.sew, ...piece.internals]) for (const a of c.points) anchors.set(a.id, JSON.stringify(a));
  const apexes = new Map<string, string>();
  for (const d of piece.darts) apexes.set(d.id, JSON.stringify(d.apex));
  for (const p of piece.pleats) { apexes.set('pleatStart:' + p.id, JSON.stringify(p.axisStart)); apexes.set('pleatEnd:' + p.id, JSON.stringify(p.axisEnd)); }
  const drills = new Map<string, string>();
  for (const d of piece.drills) drills.set(d.id, JSON.stringify(d));
  for (const t of piece.texts) drills.set('text:' + t.id, JSON.stringify(t));
  return { anchors, apexes, drills };
}

/** Pre-op copies of everything that changed since `pre`. */
export function liveSnapshotDiff(piece: Piece, pre: LivePre): LiveSnapshot {
  const now = liveCapture(piece);
  const snap: LiveSnapshot = { anchors: [], apexes: [], drills: [] };
  for (const [id, js] of pre.anchors) if (now.anchors.get(id) !== js) snap.anchors.push(JSON.parse(js));
  for (const [id, js] of pre.apexes) if (now.apexes.get(id) !== js) snap.apexes.push({ dartId: id, apex: JSON.parse(js) });
  for (const [id, js] of pre.drills) if (now.drills.get(id) !== js) {
    const o = JSON.parse(js);
    snap.drills.push(id.startsWith('text:') ? { ...o, id } : o);
  }
  return snap;
}

/** Write a snapshot back (by id) and remove the inserted anchors. */
export function liveRestore(piece: Piece, snap: LiveSnapshot | undefined, insertedIds: Id[] = []): void {
  const contours = [piece.sew, ...piece.internals];
  if (snap) {
    for (const a of snap.anchors) for (const c of contours) { const i = c.points.findIndex(p => p.id === a.id); if (i >= 0) { c.points[i] = jsonClone(a); break; } }
    for (const e of snap.apexes) {
      if (e.dartId.startsWith('pleatStart:')) { const p = piece.pleats.find(p => 'pleatStart:' + p.id === e.dartId); if (p) p.axisStart = jsonClone(e.apex); }
      else if (e.dartId.startsWith('pleatEnd:')) { const p = piece.pleats.find(p => 'pleatEnd:' + p.id === e.dartId); if (p) p.axisEnd = jsonClone(e.apex); }
      else { const d = piece.darts.find(d => d.id === e.dartId); if (d) d.apex = jsonClone(e.apex); }
    }
    for (const d of snap.drills) {
      const id = (d as { id: string }).id;
      if (id.startsWith('text:')) { const k = piece.texts.findIndex(t => 'text:' + t.id === id); if (k >= 0) { const o = jsonClone(d) as unknown as Piece['texts'][number]; o.id = id.slice(5); piece.texts[k] = o; } }
      else { const k = piece.drills.findIndex(x => x.id === id); if (k >= 0) piece.drills[k] = jsonClone(d) as Piece['drills'][number]; }
    }
  }
  const rm = new Set(insertedIds);
  for (const c of contours) c.points = c.points.filter(p => !rm.has(p.id));
}

// ───────────────────────── one spread ─────────────────────────

/** A copy of a sew anchor (fresh/given id) to be inserted next to it as the moving side. */
export function liveCopyAnchor(a: Anchor, id: Id): Anchor {
  const m = jsonClone(a);
  m.id = id; m.kind = 'grade'; m.smooth = false;
  m.flags = { ...m.flags }; delete m.flags.startPoint; delete m.flags.notchAnchor;
  delete m.name;
  return m;
}

export interface LiveSpreadOpts {
  /** fixed slash / hinge anchor ids (already on the sew contour) */
  sId: Id; hId: Id;
  openA: number; openB: number;
  parallel: boolean;
  /** forward: the arc S → H (contour order) moves; backward: the arc H → S moves */
  side: 'forward' | 'backward';
  /** internal pivot (rotation centre) */
  pivot?: Vec;
  /** hinge stays a single anchor (rotation about H, openB = 0) */
  single: boolean;
  slotS?: Id; slotH?: Id;
  created: Id[];
  skip?: { contourIds?: Set<Id>; dartIds?: Set<Id>; pleatIds?: Set<Id> };
}

/**
 * Insert the moving copies at S (and H unless `single`) and rigidly move the arc between them.
 * Returns the moving anchor ids (hmId = hId when single) and the transform used.
 */
export function liveSpreadOnce(piece: Piece, line: SizeLine, o: LiveSpreadOpts): { smId: Id; hmId: Id; spread: LiveSpreadXf } {
  const c = piece.sew;
  const r = resolveBase(c, line);
  const iS = idx(c, o.sId), iH = idx(c, o.hId);
  const S = r.anchorPos[iS], H = r.anchorPos[iH];
  // moving arc (base) and a point on it for the side test
  const [a0, a1] = o.side === 'forward' ? [iS, iH] : [iH, iS];
  const arc = spanPoly(r, a0, a1);
  const sMid = arcS(r, a0) + fwd(r, arcS(r, a0), arcS(r, a1)) / 2;
  const sidePt = pointAt(r, sMid).pt;
  const region = o.pivot ? [...arc, o.pivot] : arc;
  const spread = liveSpreadXf(S, H, o.openA, o.openB, sidePt, o.parallel, o.pivot);
  // insert the copies
  const smId = o.slotS ?? newId('p');
  const sm = liveCopyAnchor(c.points[iS], smId);
  const sf = c.points[iS];
  if (o.side === 'forward') { sm.hIn = undefined; delete sm.hIn; delete sf.hOut; c.points.splice(iS + 1, 0, sm); }
  else { delete sm.hOut; delete sf.hIn; c.points.splice(iS, 0, sm); }
  sf.smooth = false;
  o.created.push(smId);
  let hmId = o.hId;
  if (!o.single) {
    const jH = idx(c, o.hId);
    hmId = o.slotH ?? newId('p');
    const hf = c.points[jH];
    const hm = liveCopyAnchor(hf, hmId);
    if (o.side === 'forward') { delete hm.hOut; delete hf.hIn; c.points.splice(jH, 0, hm); }
    else { delete hm.hIn; delete hf.hOut; c.points.splice(jH + 1, 0, hm); }
    hf.smooth = false;
    o.created.push(hmId);
  }
  // moving anchors: from the first moving anchor forward to the last
  const n = c.points.length;
  let first: number, last: number;
  if (o.side === 'forward') { first = idx(c, smId); last = o.single ? (idx(c, o.hId) - 1 + n) % n : idx(c, hmId); }
  else { first = o.single ? (idx(c, o.hId) + 1) % n : idx(c, hmId); last = idx(c, smId); }
  for (let k = first, g = 0; g < n; k = (k + 1) % n, g++) {
    transformAnchor(c.points[k], spread.xf);
    if (k === last) break;
  }
  if (o.single) {
    const h = c.points[idx(c, o.hId)];
    if (o.side === 'forward' && h.hIn) h.hIn = spread.xf.vec(h.hIn);
    if (o.side === 'backward' && h.hOut) h.hOut = spread.xf.vec(h.hOut);
    h.smooth = false;
  }
  liveTransformRegion(piece, region, spread.xf, o.skip);
  return { smId, hmId, spread };
}

/** Far contour crossing of the ray S → P beyond P (internal pivot hinge). */
export function liveFarHinge(contour: Contour, line: SizeLine, S: Vec, P: Vec): { pt: Vec; s: number } {
  const r = resolveBase(contour, line);
  const u = norm(sub(P, S));
  const dSP = dist(S, P);
  const poly = r.closed ? [...r.pts, r.pts[0]] : r.pts;
  let best: { pt: Vec; t: number } | null = null;
  for (let e = 0; e + 1 < poly.length; e++) {
    const a = poly[e], b = poly[e + 1], ab = sub(b, a);
    const den = cross(u, ab);
    if (Math.abs(den) < 1e-12) continue;
    const t = cross(sub(a, S), ab) / den, w = cross(sub(a, S), u) / den;
    if (w < -1e-9 || w > 1 + 1e-9 || t <= dSP + 1e-9) continue;
    if (!best || t < best.t) best = { pt: add(S, mul(u, t)), t };
  }
  if (!best) throw new Error('Spread: the slash through the pivot does not reach the contour');
  return { pt: best.pt, s: closestArc(r, best.pt).s };
}

/** Ray from p along dir: first crossing with the closed contour beyond `minT`. */
export function liveRayHit(contour: Contour, line: SizeLine, p: Vec, dir: Vec, minT = 1e-6): Vec | null {
  const r = resolveBase(contour, line);
  const u = norm(dir);
  const poly = r.closed ? [...r.pts, r.pts[0]] : r.pts;
  let bt = Infinity;
  for (let e = 0; e + 1 < poly.length; e++) {
    const a = poly[e], b = poly[e + 1], ab = sub(b, a);
    const den = cross(u, ab);
    if (Math.abs(den) < 1e-12) continue;
    const t = cross(sub(a, p), ab) / den, w = cross(sub(a, p), u) / den;
    if (w < -1e-9 || w > 1 + 1e-9 || t <= minT) continue;
    if (t < bt) bt = t;
  }
  return Number.isFinite(bt) ? add(p, mul(u, bt)) : null;
}
