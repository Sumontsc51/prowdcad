/**
 * Fullness — slash & spread (A3 live object, never baked).
 *
 * `addFullness` slashes the sew contour at a contour position S and spreads it about a pivot:
 *  - pivot on the contour (H): rotate mode with openB = 0 rotates the moving arc about H (single hinge
 *    anchor); openB ≠ 0 opens the hinge too (rotation centre on line S–H so the two chords are exactly
 *    openA / openB); parallel mode translates the moving arc perpendicular to S–H by openA (hinge splits).
 *  - pivot an internal point P: rotation about P by the angle that opens S by openA; the hinge is the
 *    far crossing of the ray S→P with the contour and is split (its signed opening, negative = overlap,
 *    is stored in `hingeOpen`).
 * `side` picks the moving arc: 'forward' = the arc from S forward (contour order) to the hinge.
 * Internal contours, drills, texts, dart apexes and pleat axes inside the moving region move with it.
 *
 * Reversibility: every record keeps a pre-op snapshot of what it moved (`LiveSnapshot`) and the ids it
 * inserted. Fullness records and OPEN pleats form one per-piece LIFO stack (`seq` / `openSeq`):
 * deleting a record (or closing a pleat) that is not on top unwinds the later entries, removes it
 * exactly, then re-applies the later entries from their stored parameters (`op`) re-using their
 * reserved anchor ids (`slotIds`). The pinch-closed contour is bit-identical to the pre-op contour.
 *
 * Multi Fullness: N slashes evenly spaced on one grade segment, paired with N hinge points evenly
 * spaced on a second segment (paired in reverse so slash lines do not cross), widths interpolated
 * linearly first → last. Rotate mode hinges each slash on the contour (openB = 0); parallel mode
 * translates by the width.
 */
import type { Fullness, FullnessOp, Id, Piece, SizeLine, ContourPosRef, Pleat } from '../model/types';
import type { Document } from '../model/doc';
import { Vec, dist } from '../geom/vec';
import { newId } from '../model/factory';
import {
  resolveBase, arcS, idx, nextGrade, spanLen, pointAt, closestSNear, closestArc, fwd,
} from '../geom/draft-geom';
import {
  type LiveContourPos, liveRef, liveArcOf, liveRefAt, liveSplit, liveSpreadOnce, liveCapture, liveSnapshotDiff,
  liveRestore, liveFarHinge,
} from '../geom/dart-geom';
import { pleatOpenRaw, pleatCloseRaw } from './pleats';

export interface AddFullnessOptions {
  slash: LiveContourPos;
  /** hinge on the contour, or an internal pivot point (base coords) */
  pivot: LiveContourPos | Vec;
  /** chord opening at the slash (mm, base size) */
  openA: number;
  /** chord opening at the contour hinge (contour pivot only). Default 0 */
  openB?: number;
  mode?: 'rotate' | 'parallel';
  side?: 'forward' | 'backward';
}

export interface MultiFullnessOptions {
  /** slashes are spread evenly along the grade segment leaving this anchor */
  slashSegment: Id;
  /** hinges evenly along the grade segment leaving this anchor (paired in reverse order) */
  hingeSegment: Id;
  count: number;
  firstWidth: number;
  lastWidth: number;
  mode?: 'rotate' | 'parallel';
  side?: 'forward' | 'backward';
}

const isPos = (p: LiveContourPos | Vec): p is LiveContourPos => typeof (p as LiveContourPos).fromAnchorId === 'string';

function ctx(doc: Document, pieceId: Id) { const piece = doc.piece(pieceId); return { piece, line: doc.sizeLine(piece) }; }

export function fullnessRecord(piece: Piece, id: Id): Fullness {
  const f = (piece.fullness ?? []).find(f => f.id === id);
  if (!f) throw new Error('No fullness record ' + id);
  return f;
}

// ───────────────────────── live stack (fullness + open pleats) ─────────────────────────

export type LiveStackEntry = { kind: 'fullness'; seq: number; rec: Fullness } | { kind: 'pleat'; seq: number; pleat: Pleat };

export function fullnessStack(piece: Piece): LiveStackEntry[] {
  const out: LiveStackEntry[] = [];
  for (const f of piece.fullness ?? []) out.push({ kind: 'fullness', seq: f.seq ?? 0, rec: f });
  for (const p of piece.pleats) if (p.open) out.push({ kind: 'pleat', seq: p.openSeq ?? 0, pleat: p });
  return out.sort((a, b) => a.seq - b.seq);
}
export function fullnessNextSeq(piece: Piece): number { return fullnessStack(piece).reduce((m, e) => Math.max(m, e.seq), 0) + 1; }

/** Every anchor id inserted by a live spread (excluded when building id-relative refs). */
export function fullnessInsertedIds(piece: Piece): Set<Id> {
  const s = new Set<Id>();
  for (const f of piece.fullness ?? []) for (const id of [...(f.insertedIds ?? []), ...(f.slotIds ?? [])]) s.add(id);
  for (const p of piece.pleats) for (const id of [...(p.insertedIds ?? []), ...(p.slotIds ?? [])]) s.add(id);
  return s;
}

/** Undo (raw) every stack entry above `seq`, newest first. Returns them oldest first for `fullnessRewind`. */
export function fullnessUnwindAbove(piece: Piece, seq: number): LiveStackEntry[] {
  const above = fullnessStack(piece).filter(e => e.seq > seq);
  for (let k = above.length - 1; k >= 0; k--) {
    const e = above[k];
    if (e.kind === 'fullness') fullnessUnapplyRaw(piece, e.rec); else pleatCloseRaw(piece, e.pleat, true);
  }
  return above;
}
export function fullnessRewind(piece: Piece, line: SizeLine, entries: LiveStackEntry[]): void {
  for (const e of entries) {
    if (e.kind === 'fullness') fullnessApplyRaw(piece, line, e.rec);
    else pleatOpenRaw(piece, line, e.pleat, e.seq);
  }
}

// ───────────────────────── raw apply / unapply ─────────────────────────

export function fullnessUnapplyRaw(piece: Piece, rec: Fullness): void {
  liveRestore(piece, rec.snapshot, rec.insertedIds ?? []);
  rec.snapshot = undefined;
  rec.insertedIds = [];
}

interface OneSpread { S: Vec; pivot: { H: Vec } | { P: Vec }; openA: number; openB: number; parallel: boolean; single: boolean; slots: Id[] }

function spreadOne(piece: Piece, line: SizeLine, o: OneSpread, side: 'forward' | 'backward', created: Id[]) {
  const c = piece.sew;
  let H: Vec;
  if ('P' in o.pivot) H = liveFarHinge(c, line, o.S, o.pivot.P).pt; else H = o.pivot.H;
  const sS = closestArc(resolveBase(c, line), o.S).s;
  const a = liveSplit(piece, line, sS, o.slots[0]);
  if (a.created) created.push(c.points[a.index].id);
  const sId = c.points[a.index].id;
  const r1 = resolveBase(c, line);
  const sH = closestSNear(r1, H, closestArc(r1, H).s);
  const b = liveSplit(piece, line, sH, o.slots[2]);
  if (b.created) created.push(c.points[b.index].id);
  const hId = c.points[b.index].id;
  if (hId === sId) throw new Error('Fullness: slash and hinge coincide');
  const res = liveSpreadOnce(piece, line, {
    sId, hId, openA: o.openA, openB: 'P' in o.pivot ? 0 : o.openB, parallel: o.parallel, side,
    pivot: 'P' in o.pivot && !o.parallel ? o.pivot.P : undefined, single: o.single,
    slotS: o.slots[1], slotH: o.slots[3], created,
  });
  return { sId, hId, ...res };
}

/** Apply a record's `op` (fresh or after a LIFO unwind). Fills geometry fields + snapshot. */
export function fullnessApplyRaw(piece: Piece, line: SizeLine, rec: Fullness): void {
  const op = rec.op;
  if (!op) throw new Error('Fullness record has no op');
  const c = piece.sew;
  const pre = liveCapture(piece);
  const created: Id[] = [];
  const at = (ref: ContourPosRef): Vec => pointAt(resolveBase(c, line), liveArcOf(c, line, ref)).pt;
  if (op.kind === 'single') {
    const slots = rec.slotIds ?? (rec.slotIds = [newId('p'), newId('p'), newId('p'), newId('p')]);
    const S = at(op.slash);
    const pv = 'fromAnchor' in op.pivot ? { H: at(op.pivot) } : { P: { x: op.pivot.x, y: op.pivot.y } };
    const parallel = op.mode === 'parallel';
    const single = !parallel && 'H' in pv && Math.abs(op.openB) < 1e-12;
    const r = spreadOne(piece, line, { S, pivot: pv, openA: op.openA, openB: op.openB, parallel, single, slots }, op.side, created);
    rec.slashAnchorIds = [r.sId, r.smId];
    rec.hingeIds = [r.hId, r.hmId];
    rec.pivot = 'H' in pv ? { anchorId: r.hId } : { x: pv.P.x, y: pv.P.y };
    rec.amounts = { openA: op.openA, openB: 'H' in pv ? (parallel ? op.openA : op.openB) : r.spread.hingeOpen };
    rec.hingeOpen = 'P' in pv ? r.spread.hingeOpen : undefined;
    if (rec.hingeOpen === undefined) delete rec.hingeOpen;
  } else {
    const N = op.slashes.length;
    const slots = rec.slotIds ?? (rec.slotIds = Array.from({ length: 4 * N }, () => newId('p')));
    const S = op.slashes.map(at), H = op.hinges.map(at);
    const parallel = op.mode === 'parallel';
    // split every slash / hinge on the pre-op contour first (refs stay valid), then spread by id
    const split = (q: Vec, slot: Id): Id => {
      const r = resolveBase(c, line);
      const sp = liveSplit(piece, line, closestSNear(r, q, closestArc(r, q).s), slot);
      if (sp.created) created.push(c.points[sp.index].id);
      return c.points[sp.index].id;
    };
    const sIds = S.map((q, i) => split(q, slots[4 * i]));
    const hIds = H.map((q, i) => split(q, slots[4 * i + 2]));
    const order = Array.from({ length: N }, (_, i) => i);
    if (op.side === 'forward') order.reverse();
    const pairs: { s: Id[]; h: Id[] }[] = new Array(N);
    for (const i of order) {
      if (sIds[i] === hIds[i]) throw new Error('Fullness: slash and hinge coincide');
      const res = liveSpreadOnce(piece, line, {
        sId: sIds[i], hId: hIds[i], openA: op.widths[i], openB: parallel ? op.widths[i] : 0, parallel, side: op.side,
        single: !parallel, slotS: slots[4 * i + 1], slotH: slots[4 * i + 3], created,
      });
      pairs[i] = { s: [sIds[i], res.smId], h: [hIds[i], res.hmId] };
    }
    rec.slashAnchorIds = pairs.flatMap(p => p.s);
    rec.hingeIds = pairs.flatMap(p => p.h);
    rec.pivot = { anchorId: pairs[0].h[0] };
    rec.perSlash = op.widths.map(w => ({ openA: w, openB: parallel ? w : 0 }));
    rec.amounts = { openA: op.widths[0], openB: parallel ? op.widths[0] : 0 };
  }
  rec.mode = op.mode;
  rec.insertedIds = created;
  rec.snapshot = liveSnapshotDiff(piece, pre);
}

// ───────────────────────── public ops ─────────────────────────

/** Raw single slash & spread on a piece (no transaction). Used by Insert Dart. */
export function fullnessAddRaw(piece: Piece, line: SizeLine, o: AddFullnessOptions): Fullness {
  if (!Number.isFinite(o.openA)) throw new Error('Fullness: openA required');
  const c = piece.sew;
  const ex = fullnessInsertedIds(piece);
  const toRef = (p: LiveContourPos): ContourPosRef => liveRefAt(c, line, liveArcOf(c, line, liveRef(p)), ex);
  const op: FullnessOp = {
    kind: 'single', slash: toRef(o.slash),
    pivot: isPos(o.pivot) ? toRef(o.pivot) : { x: o.pivot.x, y: o.pivot.y },
    openA: o.openA, openB: o.openB ?? 0, mode: o.mode ?? 'rotate', side: o.side ?? 'forward',
  };
  const rec: Fullness = { id: newId('fu'), slashAnchorIds: [], pivot: { anchorId: '' }, amounts: { openA: o.openA, openB: o.openB ?? 0 }, op, seq: fullnessNextSeq(piece) };
  fullnessApplyRaw(piece, line, rec);
  (piece.fullness ??= []).push(rec);
  return rec;
}

/** Slash & spread. Returns the Fullness record id. */
export function addFullness(doc: Document, pieceId: Id, o: AddFullnessOptions): Id {
  return doc.transact('Add fullness', () => { const { piece, line } = ctx(doc, pieceId); return fullnessAddRaw(piece, line, o).id; });
}

/** N slashes with widths interpolated first → last. Returns the record id. */
export function addMultiFullness(doc: Document, pieceId: Id, o: MultiFullnessOptions): Id {
  return doc.transact('Multi fullness', () => {
    const { piece, line } = ctx(doc, pieceId);
    const c = piece.sew, N = Math.round(o.count);
    if (!(N >= 1)) throw new Error('Multi fullness: count ≥ 1');
    const r = resolveBase(c, line);
    const ex = fullnessInsertedIds(piece);
    const along = (segStart: Id): number[] => {
      const ia = idx(c, segStart); let ib = nextGrade(c, ia); if (ib < 0) ib = ia;
      const sA = arcS(r, ia), L = spanLen(r, ia, ib);
      return Array.from({ length: N }, (_, k) => sA + (L * (k + 1)) / (N + 1));
    };
    const slashes = along(o.slashSegment).map(s => liveRefAt(c, line, s, ex));
    const hinges = along(o.hingeSegment).reverse().map(s => liveRefAt(c, line, s, ex));
    const widths = Array.from({ length: N }, (_, i) => (N === 1 ? o.firstWidth : o.firstWidth + ((o.lastWidth - o.firstWidth) * i) / (N - 1)));
    const op: FullnessOp = { kind: 'multi', slashes, hinges, widths, mode: o.mode ?? 'rotate', side: o.side ?? 'forward' };
    const rec: Fullness = { id: newId('fu'), slashAnchorIds: [], pivot: { anchorId: '' }, amounts: { openA: widths[0], openB: 0 }, op, seq: fullnessNextSeq(piece) };
    fullnessApplyRaw(piece, line, rec);
    (piece.fullness ??= []).push(rec);
    return rec.id;
  });
}

export interface FullnessBetweenOptions {
  /** first slash line: slash point (spread edge) and hinge point, both on the sew line */
  firstSlash: LiveContourPos; firstHinge: LiveContourPos;
  /** last slash line (count > 1): the slashes are spread evenly from the first to the last line */
  lastSlash?: LiveContourPos; lastHinge?: LiveContourPos;
  count: number;
  /** opening at the first / last slash (interpolated linearly in between); lastWidth defaults to firstWidth */
  firstWidth: number; lastWidth?: number;
  mode?: 'rotate' | 'parallel';
  side?: 'forward' | 'backward';
}

/** Arc positions of N points spread evenly over the shorter arc s0 → s1 (inclusive), in s0 → s1 order. */
function evenArcs(L: number, closed: boolean, s0: number, s1: number, n: number): number[] {
  let d = s1 - s0;
  if (closed && L > 0) { d = ((d % L) + L) % L; if (d > L / 2) d -= L; }
  return Array.from({ length: n }, (_, k) => { let s = s0 + (n === 1 ? 0 : (d * k) / (n - 1)); if (closed && L > 0) s = ((s % L) + L) % L; return s; });
}

/** Slash and hinge positions (base arc) of a fullness-between spec, before sorting. Pure. */
export function fullnessBetweenArcs(piece: Piece, line: SizeLine, o: FullnessBetweenOptions): { slashes: number[]; hinges: number[]; widths: number[] } {
  const c = piece.sew, r = resolveBase(c, line), L = r.cum[r.cum.length - 1] ?? 0;
  const N = Math.round(o.count);
  if (!(N >= 1)) throw new Error('Slash & spread: count ≥ 1');
  const a = (p: LiveContourPos) => liveArcOf(c, line, liveRef(p));
  const s0 = a(o.firstSlash), h0 = a(o.firstHinge);
  if (N > 1 && (!o.lastSlash || !o.lastHinge)) throw new Error('Slash & spread: click the last slash line too');
  const s1 = N > 1 ? a(o.lastSlash!) : s0, h1 = N > 1 ? a(o.lastHinge!) : h0;
  const w1 = o.lastWidth ?? o.firstWidth;
  return {
    slashes: evenArcs(L, c.closed, s0, s1, N), hinges: evenArcs(L, c.closed, h0, h1, N),
    widths: Array.from({ length: N }, (_, i) => (N === 1 ? o.firstWidth : o.firstWidth + ((w1 - o.firstWidth) * i) / (N - 1))),
  };
}

/**
 * Slash & Spread between two slash lines (CLO Slash and Spread / Fullness): N slash lines evenly from
 * the first (slash point → hinge) to the last line, openings interpolated first → last; rotate
 * (hinged on the sew line) or parallel. One live fullness record (exact delete). Returns its id.
 */
export function addFullnessBetween(doc: Document, pieceId: Id, o: FullnessBetweenOptions): Id {
  return doc.transact('Slash & spread', () => {
    const { piece, line } = ctx(doc, pieceId);
    if (piece.locked) throw new Error('Piece is locked');
    const c = piece.sew, r = resolveBase(c, line);
    const g = fullnessBetweenArcs(piece, line, o);
    // order the pairs ascending in contour order (as Multi Fullness expects): the slashes run over the
    // shorter arc first → last, forward or backward
    const N = g.slashes.length, L = r.cum[r.cum.length - 1] ?? 0;
    const forwardRun = N < 2 || fwd(r, g.slashes[0], g.slashes[N - 1]) <= L / 2;
    const ord = Array.from({ length: N }, (_, i) => (forwardRun ? i : N - 1 - i));
    const ex = fullnessInsertedIds(piece);
    const ref = (s: number) => liveRefAt(c, line, s, ex);
    const op: FullnessOp = {
      kind: 'multi', slashes: ord.map(i => ref(g.slashes[i])), hinges: ord.map(i => ref(g.hinges[i])), widths: ord.map(i => g.widths[i]),
      mode: o.mode ?? 'rotate', side: o.side ?? 'forward',
    };
    const rec: Fullness = { id: newId('fu'), slashAnchorIds: [], pivot: { anchorId: '' }, amounts: { openA: op.widths[0], openB: 0 }, op, seq: fullnessNextSeq(piece) };
    fullnessApplyRaw(piece, line, rec);
    (piece.fullness ??= []).push(rec);
    return rec.id;
  });
}

/** Raw delete (pinch closed, exact restore) with LIFO unwind / re-apply of later spreads. */
export function fullnessDeleteRaw(piece: Piece, line: SizeLine, id: Id): void {
  const rec = fullnessRecord(piece, id);
  const later = fullnessUnwindAbove(piece, rec.seq ?? 0);
  fullnessUnapplyRaw(piece, rec);
  piece.fullness = (piece.fullness ?? []).filter(f => f.id !== id);
  if (rec.dartId) {
    const d = piece.darts.find(d => d.id === rec.dartId);
    if (d) {
      piece.darts = piece.darts.filter(x => x.id !== d.id);
      if (d.axisContourId) piece.internals = piece.internals.filter(c => c.id !== d.axisContourId);
    }
  }
  fullnessRewind(piece, line, later);
}

/**
 * Edit the openings of a live slash & spread in place (one undo step): later spreads are unwound,
 * the record is pinched closed (exact), its stored parameters changed and re-applied with the same
 * anchor ids, then the later spreads are re-applied. `widths` = one opening per slash (multi);
 * `openA` / `openB` = slash / hinge opening (single).
 */
export function setFullnessOpenings(doc: Document, pieceId: Id, id: Id, o: { widths?: number[]; openA?: number; openB?: number }): void {
  doc.transact('Edit fullness', () => {
    const { piece, line } = ctx(doc, pieceId);
    const rec = fullnessRecord(piece, id);
    const op = rec.op;
    if (!op) throw new Error('This fullness record cannot be edited');
    const later = fullnessUnwindAbove(piece, rec.seq ?? 0);
    fullnessUnapplyRaw(piece, rec);
    if (op.kind === 'multi') {
      if (o.widths) { if (o.widths.length !== op.widths.length) throw new Error(`Give ${op.widths.length} openings`); op.widths = o.widths.slice(); }
    } else {
      if (o.openA !== undefined) op.openA = o.openA;
      if (o.openB !== undefined) op.openB = o.openB;
      if (o.widths?.length) op.openA = o.widths[0];
    }
    fullnessApplyRaw(piece, line, rec);
    fullnessRewind(piece, line, later);
  });
}

export function deleteFullness(doc: Document, pieceId: Id, id: Id): void {
  doc.transact('Delete fullness', () => { const { piece, line } = ctx(doc, pieceId); fullnessDeleteRaw(piece, line, id); });
}

/** Opening (chord, base) at each slash of a record: |fixed − moving|. */
export function fullnessOpenings(doc: Document, pieceId: Id, id: Id): number[] {
  const { piece, line } = ctx(doc, pieceId);
  const rec = fullnessRecord(piece, id);
  const r = resolveBase(piece.sew, line);
  const P = (a: Id) => r.anchorPos[idx(piece.sew, a)];
  const out: number[] = [];
  for (let k = 0; k + 1 < rec.slashAnchorIds.length; k += 2) out.push(dist(P(rec.slashAnchorIds[k]), P(rec.slashAnchorIds[k + 1])));
  return out;
}
