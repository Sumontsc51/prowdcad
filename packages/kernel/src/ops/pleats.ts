/**
 * Pleats (A3 live objects, never baked).
 *
 * A pleat is an AXIS (two base points with their own grading, drawn as a dashed 'pleatAxis'
 * internal) plus attributes: type box/knife, depth at the start/end of the axis (variable depth =
 * tapered), fold direction, auto-notches. Workflow (TUKA): Add Pleat Axis first, then set attributes,
 * then open. Add-by-angle and Multi Pleat create axes from a contour position.
 *
 * OPEN (non-destructive): the infinite axis line is crossed with the sew contour; the crossing
 * nearest axisStart (S) and nearest axisEnd (H) are split (grade anchors, geometry unchanged), a
 * moving copy is inserted next to each, and the arc on `moveSide` of the axis (default right of
 * start→end) is translated perpendicular to the axis by the pleat fabric (tapered → rotated so the
 * chord openings at S / H are exactly the start / end amounts). The pleat fabric inserted is
 *   knife: 2 × depth   (one fold under: depth out + depth back)            — TUKA convention
 *   box  : 4 × depth   (two knife pleats facing each other)
 * Box pleats also get a centre-fold anchor (`PleatEdge.mid`) halfway across each opening.
 * Auto notches (source 'pleat', placement 'anchor') sit on the fixed / moving (/ mid) edge anchors of
 * the crossing(s) chosen by `notchAt` (default 'start').
 * CLOSE restores the pre-open snapshot by id and removes the inserted anchors + auto notches; the
 * axis and the depths are kept. Open pleats share the per-piece LIFO spread stack with fullness
 * records (see ops/fullness.ts), so closing a pleat below later spreads unwinds and re-applies them.
 */
import type { Anchor, Contour, Id, Notch, Pleat, PleatType, Piece, SizeLine } from '../model/types';
import type { Document } from '../model/doc';
import { Vec, add, sub, mul, dist, norm, cross, rotate, rad, lerp, dot } from '../geom/vec';
import { newId } from '../model/factory';
import { resolveBase, arcS, idx, nextGrade, spanLen, pointAt, closestArc, fwd, spanPoly } from '../geom/draft-geom';
import {
  type LiveContourPos, liveArcOf, liveRef, liveInward, liveSplit, liveSpreadOnce, liveCapture, liveSnapshotDiff,
  liveRestore, liveRayHit, liveAvgGrade,
} from '../geom/dart-geom';
import { fullnessNextSeq, fullnessUnwindAbove, fullnessRewind } from './fullness';

export interface PleatAttributes {
  type?: PleatType;
  depthStart?: number;
  depthEnd?: number;
  fold?: 'left' | 'right';
  autoNotches?: boolean;
  moveSide?: 'left' | 'right';
  notchAt?: 'start' | 'end' | 'both';
  name?: string;
}

function ctx(doc: Document, pieceId: Id) { const piece = doc.piece(pieceId); return { piece, line: doc.sizeLine(piece) }; }

export function pleatOf(piece: Piece, id: Id): Pleat {
  const p = piece.pleats.find(p => p.id === id);
  if (!p) throw new Error('No pleat ' + id);
  return p;
}

/** Fabric inserted at depth d. */
export const pleatFabric = (type: PleatType, d: number) => (type === 'knife' ? 2 : 4) * d;

function axisContour(a: Vec, b: Vec): Contour {
  return {
    id: newId('c'), type: 'pleatAxis', closed: false, style: 'dashed',
    points: [a, b].map(p => ({ id: newId('p'), x: p.x, y: p.y, kind: 'grade' as const, smooth: false, grade: {}, flags: { pleatEdge: true } })),
  };
}

// ───────────────────────── axis creation ─────────────────────────

function pleatAddAxisRaw(piece: Piece, a: Vec, b: Vec, attrs: PleatAttributes = {}): Pleat {
  if (dist(a, b) < 1e-6) throw new Error('Pleat axis: zero length');
  const ax = axisContour(a, b);
  piece.internals.push(ax);
  const p: Pleat = {
    id: newId('pl'), type: attrs.type ?? 'knife',
    axisStart: { x: a.x, y: a.y, grade: {} }, axisEnd: { x: b.x, y: b.y, grade: {} },
    depthStart: attrs.depthStart ?? 0, depthEnd: attrs.depthEnd ?? attrs.depthStart ?? 0,
    fold: attrs.fold ?? 'right', open: false, autoNotches: attrs.autoNotches ?? true, axisContourId: ax.id,
  };
  if (attrs.moveSide) p.moveSide = attrs.moveSide;
  if (attrs.notchAt) p.notchAt = attrs.notchAt;
  if (attrs.name) p.name = attrs.name;
  piece.pleats.push(p);
  return p;
}

/** Add Pleat Axis (closed pleat, depth 0 unless given). Returns the pleat id. */
export function addPleatAxis(doc: Document, pieceId: Id, a: Vec, b: Vec, attrs: PleatAttributes = {}): Id {
  return doc.transact('Add pleat axis', () => pleatAddAxisRaw(ctx(doc, pieceId).piece, a, b, attrs).id);
}

/** Axis from a contour position at `angleDeg` to the contour tangent (90 = perpendicular, inward), to the opposite contour. */
function pleatAxisByAngle(piece: Piece, line: SizeLine, at: LiveContourPos, angleDeg: number): [Vec, Vec] {
  const s = liveArcOf(piece.sew, line, liveRef(at));
  const { pt, tangent, inward } = liveInward(piece.sew, line, s);
  // rotate the tangent toward the inside
  const sgn = cross(tangent, inward) > 0 ? 1 : -1;
  const dir = rotate(tangent, sgn * rad(angleDeg));
  const far = liveRayHit(piece.sew, line, pt, dir, 1e-3);
  if (!far) throw new Error('Pleat by angle: axis does not reach the contour');
  return [pt, far];
}

export function addPleatByAngle(doc: Document, pieceId: Id, at: LiveContourPos, angleDeg: number, attrs: PleatAttributes = {}): Id {
  return doc.transact('Add pleat by angle', () => {
    const { piece, line } = ctx(doc, pieceId);
    const [a, b] = pleatAxisByAngle(piece, line, at, angleDeg);
    return pleatAddAxisRaw(piece, a, b, attrs).id;
  });
}

/** N pleat axes evenly spaced (L·k/(N+1)) on the grade segment leaving `segStart`, perpendicular inward. Opened when depth > 0 and `open` ≠ false. */
export function addMultiPleat(doc: Document, pieceId: Id, segStart: Id, count: number, attrs: PleatAttributes & { open?: boolean } = {}): Id[] {
  return doc.transact('Multi pleat', () => {
    const { piece, line } = ctx(doc, pieceId);
    const c = piece.sew;
    const r = resolveBase(c, line);
    const ia = idx(c, segStart); let ib = nextGrade(c, ia); if (ib < 0) ib = ia;
    const sA = arcS(r, ia), L = spanLen(r, ia, ib);
    const axes: [Vec, Vec][] = [];
    for (let k = 1; k <= count; k++) axes.push(pleatAxisByAngle(piece, line, { fromAnchorId: segStart, distance: (L * k) / (count + 1) }, 90));
    void sA;
    const ids = axes.map(([a, b]) => pleatAddAxisRaw(piece, a, b, attrs).id);
    if ((attrs.open ?? true) && ((attrs.depthStart ?? 0) > 0 || (attrs.depthEnd ?? 0) > 0)) for (const id of ids) pleatOpenRaw(piece, line, pleatOf(piece, id), fullnessNextSeq(piece));
    return ids;
  });
}

export interface PleatSetOptions extends PleatAttributes {
  /** number of pleats (≥ 1) */
  count: number;
  /** interval layout: spacing between neighbouring pleat lines, perpendicular to the first line (mm) */
  interval?: number;
  /** interval layout: side of the first line (start → end) the further pleats go. Default 'right'. */
  side?: 'left' | 'right';
  /** between-lines layout: the LAST pleat line; the pleats are spread evenly from the first line to it (ends interpolated) */
  last?: [Vec, Vec];
  /** open the pleats now (when depth > 0). Default true. */
  open?: boolean;
}

/**
 * Pleat lines of a pleat set (pure; the UI previews with it). Interval layout: the first line plus
 * copies shifted k × interval toward `side`. Between-lines layout: count lines with ends
 * interpolated linearly from the first to the last line (count = 1 → the first line).
 */
export function pleatSetAxes(first: [Vec, Vec], o: Pick<PleatSetOptions, 'count' | 'interval' | 'side' | 'last'>): [Vec, Vec][] {
  const n = Math.round(o.count);
  if (!(n >= 1)) throw new Error('Pleats: count must be ≥ 1');
  if (dist(first[0], first[1]) < 1e-6) throw new Error('Pleat line: zero length');
  if (o.last) {
    if (n === 1) return [[{ ...first[0] }, { ...first[1] }]];
    return Array.from({ length: n }, (_, k) => [lerp(first[0], o.last![0], k / (n - 1)), lerp(first[1], o.last![1], k / (n - 1))] as [Vec, Vec]);
  }
  const u = norm(sub(first[1], first[0]));
  const right: Vec = { x: u.y, y: -u.x };
  const nrm = (o.side ?? 'right') === 'right' ? right : mul(right, -1);
  const iv = o.interval ?? 0;
  if (n > 1 && !(iv > 0)) throw new Error('Pleats: interval must be > 0');
  return Array.from({ length: n }, (_, k) => [add(first[0], mul(nrm, k * iv)), add(first[1], mul(nrm, k * iv))] as [Vec, Vec]);
}

/**
 * Pleats tool (CLO Pleats): N pleats from a first pleat line, by interval or spread evenly up to a
 * last line. Each pleat is a live pleat object (axis + attributes, auto notches); the far side moves
 * (moveSide = the side the set grows toward, so the openings stack). Opened when depth > 0 unless
 * open === false. One undo step. Returns the pleat ids in line order.
 */
export function addPleatSet(doc: Document, pieceId: Id, first: [Vec, Vec], o: PleatSetOptions): Id[] {
  return doc.transact('Pleats', () => {
    const { piece, line } = ctx(doc, pieceId);
    if (piece.locked) throw new Error('Piece is locked');
    const axes = pleatSetAxes(first, o);
    // the side the set grows toward (between-lines: the side of the last line)
    let side = o.side ?? 'right';
    if (o.last && !o.side) {
      const m = lerp(o.last[0], o.last[1], 0.5);
      side = cross(sub(first[1], first[0]), sub(m, first[0])) < 0 ? 'right' : 'left';
    }
    const attrs: PleatAttributes = { ...o, moveSide: o.moveSide ?? side };
    const ids = axes.map(([a, b]) => pleatAddAxisRaw(piece, a, b, attrs).id);
    if ((o.open ?? true) && ((o.depthStart ?? 0) > 0 || (o.depthEnd ?? o.depthStart ?? 0) > 0)) for (const id of ids) pleatOpenRaw(piece, line, pleatOf(piece, id), fullnessNextSeq(piece));
    return ids;
  });
}

/** Set attributes (re-opens an open pleat with the new values). */
export function setPleatAttributes(doc: Document, pieceId: Id, pleatId: Id, attrs: PleatAttributes): void {
  doc.transact('Pleat attributes', () => {
    const { piece, line } = ctx(doc, pieceId);
    const p = pleatOf(piece, pleatId);
    const wasOpen = p.open;
    if (wasOpen) pleatCloseStacked(piece, line, p);
    if (attrs.type) p.type = attrs.type;
    if (attrs.depthStart !== undefined) {
      // a uniform pleat stays uniform when only the start depth is edited
      if (attrs.depthEnd === undefined && p.depthEnd === p.depthStart) p.depthEnd = attrs.depthStart;
      p.depthStart = attrs.depthStart;
    }
    if (attrs.depthEnd !== undefined) p.depthEnd = attrs.depthEnd;
    if (attrs.fold) p.fold = attrs.fold;
    if (attrs.autoNotches !== undefined) p.autoNotches = attrs.autoNotches;
    if (attrs.moveSide) p.moveSide = attrs.moveSide;
    if (attrs.notchAt) p.notchAt = attrs.notchAt;
    if (attrs.name !== undefined) p.name = attrs.name;
    if (wasOpen) pleatOpenRaw(piece, line, p, fullnessNextSeq(piece));
  });
}

// ───────────────────────── open / close core ─────────────────────────

/** Axis line crossings with the sew contour nearest axisStart / axisEnd (base arc positions). */
function pleatCrossings(piece: Piece, line: SizeLine, p: Pleat): { sS: number; sH: number; S: Vec; H: Vec } {
  const r = resolveBase(piece.sew, line);
  const A: Vec = { x: p.axisStart.x, y: p.axisStart.y }, B: Vec = { x: p.axisEnd.x, y: p.axisEnd.y };
  const u = norm(sub(B, A));
  const poly = [...r.pts, r.pts[0]];
  const hits: { t: number; pt: Vec }[] = [];
  for (let e = 0; e + 1 < poly.length; e++) {
    const a = poly[e], b = poly[e + 1], ab = sub(b, a);
    const den = cross(u, ab);
    if (Math.abs(den) < 1e-12) continue;
    const t = cross(sub(a, A), ab) / den, w = cross(sub(a, A), u) / den;
    if (w < -1e-9 || w > 1 + 1e-9) continue;
    const pt = add(A, mul(u, t));
    if (!hits.some(h => dist(h.pt, pt) < 1e-6)) hits.push({ t, pt });
  }
  if (hits.length < 2) throw new Error('Pleat axis must cross the sew line twice');
  const L = dist(A, B);
  const near = (t0: number) => hits.reduce((b, h) => (Math.abs(h.t - t0) < Math.abs(b.t - t0) ? h : b));
  const hs = near(0);
  const he = hits.filter(h => h !== hs).reduce((b, h) => (Math.abs(h.t - L) < Math.abs(b.t - L) ? h : b));
  return { S: hs.pt, H: he.pt, sS: closestArc(r, hs.pt).s, sH: closestArc(r, he.pt).s };
}

/** Raw open (no transaction, no stack unwinding — caller guarantees this is the top of the stack). */
export function pleatOpenRaw(piece: Piece, line: SizeLine, p: Pleat, seq: number): void {
  if (p.open) return;
  const fabS = pleatFabric(p.type, p.depthStart), fabE = pleatFabric(p.type, p.depthEnd);
  if (fabS <= 0 && fabE <= 0) throw new Error('Pleat depth must be > 0 to open');
  const c = piece.sew;
  const slots = p.slotIds ?? (p.slotIds = Array.from({ length: 6 }, () => newId('p')));
  const pre = liveCapture(piece);
  const created: Id[] = [];
  const x = pleatCrossings(piece, line, p);
  const a = liveSplit(piece, line, x.sS, slots[0]); if (a.created) created.push(c.points[a.index].id);
  const sId = c.points[a.index].id;
  const r1 = resolveBase(c, line);
  const b = liveSplit(piece, line, closestArc(r1, x.H).s, slots[2]); if (b.created) created.push(c.points[b.index].id);
  const hId = c.points[b.index].id;
  // which contour arc is on the move side?
  const r2 = resolveBase(c, line);
  const iS = idx(c, sId), iH = idx(c, hId);
  const sMid = arcS(r2, iS) + fwd(r2, arcS(r2, iS), arcS(r2, iH)) / 2;
  const mp = pointAt(r2, sMid).pt;
  const A: Vec = { x: p.axisStart.x, y: p.axisStart.y }, B: Vec = { x: p.axisEnd.x, y: p.axisEnd.y };
  const fwdIsRight = cross(sub(B, A), sub(mp, A)) < 0;
  const wantRight = (p.moveSide ?? 'right') === 'right';
  const side = fwdIsRight === wantRight ? 'forward' : 'backward';
  // openings measured along the S→H line's normal; S is the start crossing
  const res = liveSpreadOnce(piece, line, {
    sId, hId, openA: fabS, openB: fabE, parallel: Math.abs(fabS - fabE) < 1e-12, side, single: false,
    slotS: slots[1], slotH: slots[3], created,
    skip: { contourIds: new Set(p.axisContourId ? [p.axisContourId] : []), pleatIds: new Set([p.id]) },
  });
  const edges = [{ fixed: sId, moving: res.smId } as { fixed: Id; moving: Id; mid?: Id }, { fixed: hId, moving: res.hmId } as { fixed: Id; moving: Id; mid?: Id }];
  if (p.type !== 'knife') {
    edges.forEach((e, k) => {
      const i = idx(c, e.fixed), j = idx(c, e.moving);
      const fa = c.points[i], ma = c.points[j];
      const mid = lerp(fa, ma, 0.5);
      const first = (j === (i + 1) % c.points.length) ? fa : ma; // anchor before the opening in contour order
      const m: Anchor = { id: slots[4 + k], x: mid.x, y: mid.y, kind: 'grade', smooth: false, grade: liveAvgGrade(line, [fa.grade, ma.grade]), flags: { pleatEdge: true } };
      if (first.seamAfter !== undefined) m.seamAfter = first.seamAfter;
      const at = Math.abs(i - j) === 1 ? Math.max(i, j) : c.points.length;
      c.points.splice(at, 0, m);
      created.push(m.id);
      e.mid = m.id;
    });
  }
  for (const e of edges) for (const id of [e.fixed, e.moving]) { const q = c.points[idx(c, id)]; q.flags = { ...q.flags, pleatEdge: true }; }
  p.edges = edges;
  p.insertedIds = created;
  // auto notches
  p.notchIds = [];
  if (p.autoNotches) {
    const which = p.notchAt ?? 'start';
    const sel = which === 'both' ? edges : which === 'start' ? [edges[0]] : [edges[1]];
    const setup = { depth: 5, width: 0, type: 'slit' as const };
    let k = 0;
    const old = new Set(piece.notches.map(n => n.id));
    for (const e of sel) for (const aid of [e.fixed, e.mid, e.moving].filter(Boolean) as Id[]) {
      const nid = `${p.id}:n${k++}`;
      if (old.has(nid)) continue;
      const n: Notch = { id: nid, contourId: c.id, placement: { kind: 'anchor', anchorId: aid }, type: setup.type, depth: setup.depth, width: setup.width, angleDeg: 0, source: 'pleat' };
      piece.notches.push(n);
      p.notchIds.push(nid);
    }
  }
  p.snapshot = liveSnapshotDiff(piece, pre);
  p.open = true;
  p.openSeq = seq;
}

export function pleatCloseRaw(piece: Piece, p: Pleat, keepSeq = false): void {
  if (!p.open) return;
  liveRestore(piece, p.snapshot, p.insertedIds ?? []);
  const nids = new Set(p.notchIds ?? []);
  piece.notches = piece.notches.filter(n => !nids.has(n.id));
  p.notchIds = [];
  p.snapshot = undefined;
  p.insertedIds = [];
  p.edges = undefined;
  p.open = false;
  if (!keepSeq) delete p.openSeq;
}

function pleatCloseStacked(piece: Piece, line: SizeLine, p: Pleat): void {
  if (!p.open) return;
  const later = fullnessUnwindAbove(piece, p.openSeq ?? 0);
  pleatCloseRaw(piece, p);
  fullnessRewind(piece, line, later);
}

// ───────────────────────── public open / close ─────────────────────────

export function openPleats(doc: Document, pieceId: Id, pleatIds?: Id[]): void {
  doc.transact('Open pleats', () => {
    const { piece, line } = ctx(doc, pieceId);
    for (const p of piece.pleats) if ((!pleatIds || pleatIds.includes(p.id)) && !p.open) pleatOpenRaw(piece, line, p, fullnessNextSeq(piece));
  });
}
export function closePleats(doc: Document, pieceId: Id, pleatIds?: Id[]): void {
  doc.transact('Close pleats', () => {
    const { piece, line } = ctx(doc, pieceId);
    const sel = piece.pleats.filter(p => p.open && (!pleatIds || pleatIds.includes(p.id))).sort((a, b) => (b.openSeq ?? 0) - (a.openSeq ?? 0));
    for (const p of sel) pleatCloseStacked(piece, line, p);
  });
}
export const openPleat = (doc: Document, pieceId: Id, id: Id) => openPleats(doc, pieceId, [id]);
export const closePleat = (doc: Document, pieceId: Id, id: Id) => closePleats(doc, pieceId, [id]);

/** Delete a pleat (closing it first) together with its axis contour. */
export function deletePleat(doc: Document, pieceId: Id, id: Id): void {
  doc.transact('Delete pleat', () => {
    const { piece, line } = ctx(doc, pieceId);
    const p = pleatOf(piece, id);
    pleatCloseStacked(piece, line, p);
    piece.pleats = piece.pleats.filter(x => x.id !== id);
    if (p.axisContourId) piece.internals = piece.internals.filter(c => c.id !== p.axisContourId);
  });
}

/** Chord openings (base) at the start / end crossings of an open pleat. */
export function pleatOpenings(doc: Document, pieceId: Id, id: Id): { start: number; end: number } {
  const { piece, line } = ctx(doc, pieceId);
  const p = pleatOf(piece, id);
  if (!p.open || !p.edges) return { start: 0, end: 0 };
  const r = resolveBase(piece.sew, line);
  const P = (a: Id) => r.anchorPos[idx(piece.sew, a)];
  return { start: dist(P(p.edges[0].fixed), P(p.edges[0].moving)), end: dist(P(p.edges[1].fixed), P(p.edges[1].moving)) };
}

void dot; void spanPoly;
