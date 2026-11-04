/**
 * Grading (A7): grading table, point editing, clipboard, smart paste, stacking, angle grading,
 * parallel/proportional grading and reverse grading (graded nest from individual pieces).
 *
 * Storage convention (model/contour.ts): inc[size_i] = abs[size_i] − abs[size_{i−1}], abs[base] = 0,
 * in the anchor's LOCAL frame (rotated by `gradeAxisDeg`). Every write here goes through that
 * convention; `view:'absolute'` reads/writes are converted with absoluteToIncremental.
 * All ids accepted as `anchorId` may also be any graded object id (drill/text/artwork id,
 * `<dartId>:apex`, `<pleatId>:start|end`, `grain:a|b`) unless stated otherwise.
 */
import type { Vec } from '../geom/vec';
import { sub, dot, len, norm, angleOf, cross } from '../geom/vec';
import type { Document } from '../model/doc';
import type { Anchor, Contour, GradeInc, Id, Piece, SizeDef, SizeId, SizeLine } from '../model/types';
import { absoluteOffset, resolveContour, anchorPositions, totalLength } from '../model/contour';
import { pointAtLength } from '../geom/poly';
import {
  type GradeRec, type GradedRef, findRef, gradedRefs, refWorldAbs, incFromWorldAbs, absMap, incFromAbs,
  rotDeg, gi, locateAnchor, materializeCurves, allContours, clonePieceFresh, contourWorldOffsets, deepClone,
} from './grading/util';

export type GradeView = 'incremental' | 'absolute';
const Z = (): GradeInc => ({ dx: 0, dy: 0 });

// ───────────────────────── internals ─────────────────────────

function ctx(doc: Document, pieceId: Id) { const piece = doc.piece(pieceId); return { piece, line: doc.sizeLine(piece) }; }

/** Make sure an implicit curve point carries explicit grading before editing it. */
function editable(piece: Piece, line: SizeLine, id: Id): GradedRef {
  let ref = findRef(piece, id);
  if (ref.implicit && ref.contour) {
    materializeCurves(ref.contour, line, 'grade', [ref.contour.points.indexOf(ref.anchor!)]);
    ref = findRef(piece, id);
  }
  return ref;
}

/** Fill every size key (missing → 0) so tables are rectangular. */
function full(rec: GradeRec | undefined, line: SizeLine): GradeRec {
  const out: GradeRec = {}; for (const s of line.sizes) out[s.id] = { ...gi(rec, s.id) }; return out;
}

function writeWorldAbs(ref: GradedRef, line: SizeLine, w: Record<SizeId, Vec>) { ref.set(incFromWorldAbs(w, line, ref.axisDeg)); }

// ───────────────────────── grading table ─────────────────────────

export interface GradingRow {
  id: Id;
  index: number;
  contourId: Id;
  name?: string;
  kind: 'grade' | 'curve';
  ruleId?: string;
  axisDeg?: number;
  /** per size: increment (incremental view) or absolute offset from base (absolute view), LOCAL frame */
  cells: Record<SizeId, GradeInc>;
  /** true when a curve point has no explicit grading (cells show its interpolated values) */
  interpolated?: boolean;
}
export interface GradingTable { view: GradeView; sizes: SizeDef[]; baseSizeId: SizeId; rows: GradingRow[] }

export function gradingTable(doc: Document, pieceId: Id, opt: { view?: GradeView; all?: boolean; internals?: boolean } = {}): GradingTable {
  const { piece, line } = ctx(doc, pieceId);
  const view = opt.view ?? 'incremental';
  const contours = opt.internals ? [piece.sew, ...piece.internals] : [piece.sew];
  const rows: GradingRow[] = [];
  for (const c of contours) {
    const off = c.points.some(a => a.kind === 'curve') ? contourWorldOffsets(c, line) : undefined;
    c.points.forEach((a, index) => {
      if (a.kind !== 'grade' && !opt.all) return;
      let inc: GradeRec; let interpolated = false;
      if (a.kind === 'curve' && Object.keys(a.grade ?? {}).length === 0) {
        interpolated = true;
        const w: Record<SizeId, Vec> = {}; for (const s of line.sizes) w[s.id] = off![s.id][index];
        inc = incFromWorldAbs(w, line, a.gradeAxisDeg);
      } else inc = full(a.grade, line);
      if (inc[line.sizes[0].id]) inc[line.sizes[0].id] = Z();
      const cells = view === 'incremental' ? inc : absMap(inc, line);
      rows.push({ id: a.id, index, contourId: c.id, name: a.name, kind: a.kind, ruleId: a.ruleId, axisDeg: a.gradeAxisDeg, cells, ...(interpolated ? { interpolated } : {}) });
    });
  }
  return { view, sizes: line.sizes.map(s => ({ ...s })), baseSizeId: line.baseSizeId, rows };
}

/** Set one cell. incremental: inc[size] = v. absolute: abs[size] = v (other sizes keep their absolute position). */
export function setGrade(doc: Document, pieceId: Id, anchorId: Id, sizeId: SizeId, v: GradeInc, opt: { view?: GradeView } = {}): void {
  doc.transact('Set grade', () => {
    const { piece, line } = ctx(doc, pieceId);
    const ref = editable(piece, line, anchorId);
    if ((opt.view ?? 'incremental') === 'incremental') {
      if (sizeId === line.sizes[0].id) throw new Error('The first size has no increment');
      ref.set({ ...full(ref.get(), line), [sizeId]: { dx: v.dx, dy: v.dy } });
    } else {
      if (sizeId === line.baseSizeId) throw new Error('Base size absolute offset is always 0');
      const abs = absMap(ref.get(), line); abs[sizeId] = { dx: v.dx, dy: v.dy };
      ref.set(incFromAbs(abs, line));
    }
    if (ref.anchor) delete ref.anchor.ruleId;
  });
}

/** Set a whole row (all sizes) at once. */
export function setGradeRow(doc: Document, pieceId: Id, anchorId: Id, cells: Record<SizeId, GradeInc>, opt: { view?: GradeView } = {}): void {
  doc.transact('Set grade row', () => {
    const { piece, line } = ctx(doc, pieceId);
    const ref = editable(piece, line, anchorId);
    const rec = (opt.view ?? 'incremental') === 'incremental' ? { ...full(ref.get(), line), ...deepClone(cells) } : incFromAbs({ ...absMap(ref.get(), line), ...deepClone(cells) }, line);
    rec[line.sizes[0].id] = Z();
    ref.set(rec);
    if (ref.anchor) delete ref.anchor.ruleId;
  });
}

/** Point tracking: next / previous GRADE anchor id along the contour (wraps on closed contours). */
export function nextGradeAnchor(doc: Document, pieceId: Id, anchorId: Id, dir: 1 | -1 = 1): Id | undefined {
  const { piece } = ctx(doc, pieceId);
  const { contour, index } = locateAnchor(piece, anchorId);
  const n = contour.points.length;
  for (let k = 1; k < n; k++) {
    let j = index + dir * k;
    if (contour.closed) j = ((j % n) + n) % n; else if (j < 0 || j >= n) return undefined;
    if (contour.points[j].kind === 'grade') return contour.points[j].id;
  }
  return undefined;
}
export const prevGradeAnchor = (doc: Document, pieceId: Id, anchorId: Id) => nextGradeAnchor(doc, pieceId, anchorId, -1);

/** Drag the nested size `sizeId` of an anchor to a WORLD position; writes back the increment (other sizes unchanged). */
export function dragGrade(doc: Document, pieceId: Id, anchorId: Id, sizeId: SizeId, newAbsolutePosition: Vec): void {
  doc.transact('Drag grade', () => {
    const { piece, line } = ctx(doc, pieceId);
    if (sizeId === line.baseSizeId) throw new Error('Drag the base size with point edit, not grading');
    const ref = editable(piece, line, anchorId);
    const w = refWorldAbs(ref, line);
    w[sizeId] = { x: newAbsolutePosition.x - ref.pos.x, y: newAbsolutePosition.y - ref.pos.y };
    writeWorldAbs(ref, line, w);
    if (ref.anchor) delete ref.anchor.ruleId;
  });
}

// ───────────────────────── clipboard ─────────────────────────

export interface GradeClipboard {
  /** WORLD-frame increments, one record per copied anchor */
  records: Record<SizeId, GradeInc>[];
  /** size names by id, for pasting across size lines */
  sizeNames: Record<SizeId, string>;
  sizeOrder: SizeId[];
  source: { pieceId: Id; anchorIds: Id[]; basePos: Vec[]; side?: number[] };
}

/** Copy the grading of one or more anchors (world frame, implicit curve points resolved). */
export function copyGrading(doc: Document, pieceId: Id, anchorIds: Id | Id[], opt: { axis?: MirrorAxis } = {}): GradeClipboard {
  const { piece, line } = ctx(doc, pieceId);
  const ids = Array.isArray(anchorIds) ? anchorIds : [anchorIds];
  const ax = mirrorAxisOf(piece, opt.axis);
  const records: GradeRec[] = [], basePos: Vec[] = [], side: number[] = [];
  for (const id of ids) {
    const ref = findRef(piece, id);
    const w = refWorldAbs(ref, line);
    records.push(incFromWorldAbs(w, line));
    basePos.push({ x: ref.pos.x, y: ref.pos.y });
    side.push(ax ? sideOf(ax, ref.pos) : 0);
  }
  return {
    records, sizeNames: Object.fromEntries(line.sizes.map(s => [s.id, s.name])), sizeOrder: line.sizes.map(s => s.id),
    source: { pieceId, anchorIds: ids, basePos, side },
  };
}

/** Map a clipboard record to the target line (by id, else by size name). Missing sizes → 0. */
function mapRecord(clip: GradeClipboard, rec: GradeRec, line: SizeLine): GradeRec {
  const out: GradeRec = {};
  const byName: Record<string, SizeId> = {}; for (const [id, n] of Object.entries(clip.sizeNames)) byName[n] = id;
  for (const s of line.sizes) {
    const src = rec[s.id] ? s.id : byName[s.name];
    out[s.id] = src && rec[src] ? { ...rec[src] } : Z();
  }
  out[line.sizes[0].id] = Z();
  return out;
}

export interface PasteOptions {
  /** 'all' (default) | 'x' (X only, keep target Y) | 'y' */
  component?: 'all' | 'x' | 'y';
  flipX?: boolean;
  flipY?: boolean;
}

/** Combine a world-frame increment record into the target ref per component and flips. */
function pasteInto(ref: GradedRef, line: SizeLine, worldInc: GradeRec, o: PasteOptions) {
  const cur = refWorldAbs(ref, line);
  const curInc = incFromWorldAbs(cur, line); // world-frame increments
  const out: GradeRec = {};
  for (const s of line.sizes) {
    let { dx, dy } = gi(worldInc, s.id);
    if (o.flipX) dx = -dx; if (o.flipY) dy = -dy;
    const c = gi(curInc, s.id);
    if (o.component === 'x') dy = c.dy; else if (o.component === 'y') dx = c.dx;
    out[s.id] = { dx, dy };
  }
  // world increments → world absolute → local incremental
  const w: Record<SizeId, Vec> = {};
  for (const s of line.sizes) { const a = absoluteOffset(out, line, s.id); w[s.id] = a; }
  writeWorldAbs(ref, line, w);
  if (ref.anchor) delete ref.anchor.ruleId;
}

/**
 * Paste grading onto targets. One clipboard record → every target; N records → N targets pairwise
 * (extra targets reuse the last record).
 */
export function pasteGrading(doc: Document, pieceId: Id, targetIds: Id | Id[], clip: GradeClipboard, opt: PasteOptions = {}): void {
  doc.transact('Paste grading', () => {
    const { piece, line } = ctx(doc, pieceId);
    const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
    ids.forEach((id, k) => {
      const rec = clip.records[Math.min(k, clip.records.length - 1)];
      pasteInto(editable(piece, line, id), line, mapRecord(clip, rec, line), opt);
    });
  });
}
export const pasteXOnly = (doc: Document, pieceId: Id, targetIds: Id | Id[], clip: GradeClipboard, opt: Omit<PasteOptions, 'component'> = {}) => pasteGrading(doc, pieceId, targetIds, clip, { ...opt, component: 'x' });
export const pasteYOnly = (doc: Document, pieceId: Id, targetIds: Id | Id[], clip: GradeClipboard, opt: Omit<PasteOptions, 'component'> = {}) => pasteGrading(doc, pieceId, targetIds, clip, { ...opt, component: 'y' });

// ───────────────────────── smart paste ─────────────────────────

/** Mirror axis: two points, or a vertical line x=c / horizontal line y=c. */
export type MirrorAxis = { a: Vec; b: Vec } | { x: number } | { y: number };

function axisPts(ax: MirrorAxis): { a: Vec; b: Vec } {
  if ('x' in ax) return { a: { x: ax.x, y: 0 }, b: { x: ax.x, y: 1 } };
  if ('y' in ax) return { a: { x: 0, y: ax.y }, b: { x: 1, y: ax.y } };
  return ax;
}
/** Explicit axis → piece half/mirror axis → mirror/fold internal line → grain line. */
export function mirrorAxisOf(piece: Piece, explicit?: MirrorAxis): { a: Vec; b: Vec } | undefined {
  if (explicit) return axisPts(explicit);
  if (piece.half) return { a: piece.half.a, b: piece.half.b };
  const m = piece.internals.find(c => (c.type === 'mirror' || c.type === 'fold') && c.points.length >= 2);
  if (m) return { a: { x: m.points[0].x, y: m.points[0].y }, b: { x: m.points[m.points.length - 1].x, y: m.points[m.points.length - 1].y } };
  const g = piece.grain;
  if (len(sub(g.b, g.a)) > 1e-9) return { a: g.a, b: g.b };
  return undefined;
}
function sideOf(ax: { a: Vec; b: Vec }, p: Vec): number {
  const c = cross(sub(ax.b, ax.a), sub(p, ax.a));
  return Math.abs(c) < 1e-9 ? 0 : Math.sign(c);
}

export interface SmartPasteOptions {
  axis?: MirrorAxis;
  /** which component flips when the target is on the opposite side. Default: 'x' for a mostly-vertical axis, 'y' for a mostly-horizontal one */
  flip?: 'x' | 'y';
  component?: 'all' | 'x' | 'y';
}

/**
 * Smart Paste: like pasteGrading, but when a target lies on the opposite side of the mirror axis
 * from the copied source point, the X increment is negated (Y for a horizontal axis).
 * Returns per-target whether a flip was applied.
 */
export function smartPaste(doc: Document, pieceId: Id, targetIds: Id | Id[], clip: GradeClipboard, opt: SmartPasteOptions = {}): boolean[] {
  return doc.transact('Smart paste grading', () => {
    const { piece, line } = ctx(doc, pieceId);
    const ax = mirrorAxisOf(piece, opt.axis);
    if (!ax) throw new Error('Smart paste needs a mirror axis (grain, half axis, mirror line or explicit)');
    const d = sub(ax.b, ax.a);
    const flip = opt.flip ?? (Math.abs(d.y) >= Math.abs(d.x) ? 'x' : 'y');
    const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
    return ids.map((id, k) => {
      const ri = Math.min(k, clip.records.length - 1);
      const ref = editable(piece, line, id);
      // source side relative to THIS piece's axis when copied from the same piece; else the stored side
      const srcSide = clip.source.pieceId === pieceId ? sideOf(ax, clip.source.basePos[ri]) : (clip.source.side?.[ri] ?? 1);
      const tgtSide = sideOf(ax, ref.pos);
      const opposite = srcSide !== 0 && tgtSide !== 0 && srcSide !== tgtSide;
      pasteInto(ref, line, mapRecord(clip, clip.records[ri], line), {
        component: opt.component, flipX: opposite && flip === 'x', flipY: opposite && flip === 'y',
      });
      return opposite;
    });
  });
}

/** Anchors of a contour run from→to inclusive (forward, wraps on closed contours). */
export function anchorRun(doc: Document, pieceId: Id, fromId: Id, toId: Id): Id[] {
  const { piece } = ctx(doc, pieceId);
  const f = locateAnchor(piece, fromId), t = locateAnchor(piece, toId);
  if (f.contour !== t.contour) throw new Error('Run endpoints are on different contours');
  const n = f.contour.points.length, out: Id[] = [];
  for (let k = 0; k < n; k++) {
    const j = f.contour.closed ? (f.index + k) % n : f.index + k;
    if (j >= n) break;
    out.push(f.contour.points[j].id);
    if (j === t.index) break;
  }
  return out;
}

/** Paste Grading Around: average of all clipboard records (per size) applied to every anchor of a run/selection. */
export function pasteGradingAround(doc: Document, pieceId: Id, targets: Id[] | { from: Id; to: Id }, clip: GradeClipboard, opt: PasteOptions = {}): void {
  doc.transact('Paste grading around', () => {
    const { piece, line } = ctx(doc, pieceId);
    const ids = Array.isArray(targets) ? targets : anchorRun(doc, pieceId, targets.from, targets.to);
    const mapped = clip.records.map(r => mapRecord(clip, r, line));
    const avg: GradeRec = {};
    for (const s of line.sizes) {
      let dx = 0, dy = 0; for (const r of mapped) { dx += r[s.id].dx; dy += r[s.id].dy; }
      avg[s.id] = { dx: dx / mapped.length, dy: dy / mapped.length };
    }
    for (const id of ids) pasteInto(editable(piece, line, id), line, avg, opt);
  });
}

// ───────────────────────── row operations ─────────────────────────

function eachRow(doc: Document, pieceId: Id, ids: Id | Id[], label: string, fn: (rec: GradeRec, line: SizeLine) => GradeRec) {
  doc.transact(label, () => {
    const { piece, line } = ctx(doc, pieceId);
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      const ref = editable(piece, line, id);
      const r = fn(full(ref.get(), line), line);
      r[line.sizes[0].id] = Z();
      ref.set(r);
      if (ref.anchor) delete ref.anchor.ruleId;
    }
  });
}
const mapInc = (rec: GradeRec, f: (g: GradeInc) => GradeInc): GradeRec => Object.fromEntries(Object.entries(rec).map(([k, g]) => [k, f(g)]));

export const flipX = (doc: Document, pieceId: Id, ids: Id | Id[]) => eachRow(doc, pieceId, ids, 'Flip X', r => mapInc(r, g => ({ dx: -g.dx, dy: g.dy })));
export const flipY = (doc: Document, pieceId: Id, ids: Id | Id[]) => eachRow(doc, pieceId, ids, 'Flip Y', r => mapInc(r, g => ({ dx: g.dx, dy: -g.dy })));
export const deleteX = (doc: Document, pieceId: Id, ids: Id | Id[]) => eachRow(doc, pieceId, ids, 'Delete X grading', r => mapInc(r, g => ({ dx: 0, dy: g.dy })));
export const deleteY = (doc: Document, pieceId: Id, ids: Id | Id[]) => eachRow(doc, pieceId, ids, 'Delete Y grading', r => mapInc(r, g => ({ dx: g.dx, dy: 0 })));
export const deleteAll = (doc: Document, pieceId: Id, ids: Id | Id[]) => eachRow(doc, pieceId, ids, 'Delete grading', r => mapInc(r, () => Z()));

function equalComp(rec: GradeRec, line: SizeLine, c: 'dx' | 'dy'): GradeRec {
  const ids = line.sizes.map(s => s.id).slice(1);
  const first = ids.map(s => rec[s][c]).find(v => Math.abs(v) > 1e-12) ?? 0;
  const out = { ...rec }; for (const s of ids) out[s] = { ...rec[s], [c]: first };
  return out;
}
/** Equal X: propagate the first non-zero X increment (size-line order) to every size. */
export const equalX = (doc: Document, pieceId: Id, ids: Id | Id[]) => eachRow(doc, pieceId, ids, 'Equal X', (r, l) => equalComp(r, l, 'dx'));
export const equalY = (doc: Document, pieceId: Id, ids: Id | Id[]) => eachRow(doc, pieceId, ids, 'Equal Y', (r, l) => equalComp(r, l, 'dy'));

// ───────────────────────── stacking ─────────────────────────

/** Apply a per-size world transform of OFFSETS to every explicitly graded entity of a piece. */
function transformAll(piece: Piece, line: SizeLine, fn: (ref: GradedRef, w: Record<SizeId, Vec>) => Record<SizeId, Vec>) {
  for (const ref of gradedRefs(piece, 1)) {
    if (ref.implicit) continue;
    writeWorldAbs(ref, line, fn(ref, refWorldAbs(ref, line)));
  }
}

/**
 * Stack Point: re-zero the nest at an anchor — subtract that anchor's absolute (world) offsets
 * from every graded entity so the chosen point coincides in all sizes. Implicit curve points
 * follow automatically (interpolation weights sum to 1).
 */
export function stackPoint(doc: Document, pieceId: Id, anchorId: Id): void {
  doc.transact('Stack point', () => {
    const { piece, line } = ctx(doc, pieceId);
    const shift = refWorldAbs(findRef(piece, anchorId), line);
    transformAll(piece, line, (_r, w) => {
      const o: Record<SizeId, Vec> = {};
      for (const s of line.sizes) o[s.id] = { x: w[s.id].x - shift[s.id].x, y: w[s.id].y - shift[s.id].y };
      return o;
    });
  });
}

/**
 * Stack Along Line: translate each size so anchor A stacks on its base position, then rotate the
 * size about A so the direction A→B equals the base direction. Implicit curve points are made
 * explicit first (rotation is not preserved by chord-proportional interpolation).
 */
export function stackAlongLine(doc: Document, pieceId: Id, anchorAId: Id, anchorBId: Id): void {
  doc.transact('Stack along line', () => {
    const { piece, line } = ctx(doc, pieceId);
    for (const c of allContours(piece)) materializeCurves(c, line);
    const A = findRef(piece, anchorAId), B = findRef(piece, anchorBId);
    const wA = refWorldAbs(A, line), wB = refWorldAbs(B, line);
    const A0 = { x: A.pos.x, y: A.pos.y }, B0 = { x: B.pos.x, y: B.pos.y };
    const base = angleOf(sub(B0, A0));
    const rotBy: Record<SizeId, number> = {};
    for (const s of line.sizes) {
      const As = { x: A0.x + wA[s.id].x, y: A0.y + wA[s.id].y }, Bs = { x: B0.x + wB[s.id].x, y: B0.y + wB[s.id].y };
      rotBy[s.id] = base - angleOf(sub(Bs, As));
    }
    transformAll(piece, line, (ref, w) => {
      const o: Record<SizeId, Vec> = {};
      for (const s of line.sizes) {
        if (s.id === line.baseSizeId) { o[s.id] = { x: 0, y: 0 }; continue; }
        const p = { x: ref.pos.x + w[s.id].x - A0.x - wA[s.id].x, y: ref.pos.y + w[s.id].y - A0.y - wA[s.id].y };
        const c = Math.cos(rotBy[s.id]), sn = Math.sin(rotBy[s.id]);
        const q = { x: A0.x + p.x * c - p.y * sn, y: A0.y + p.x * sn + p.y * c };
        o[s.id] = { x: q.x - ref.pos.x, y: q.y - ref.pos.y };
      }
      return o;
    });
  });
}

// ───────────────────────── angle grading ─────────────────────────

/**
 * Angle grading: set `gradeAxisDeg` on anchors. `deg` sets an explicit axis; `aim:'next'|'prev'`
 * aims the local X axis from the anchor toward the next/previous grade anchor (base size).
 * `preserve` (default true) re-expresses increments so world geometry is unchanged; false keeps
 * the stored numbers (they are then read along the new axis).
 */
export function angleGrading(doc: Document, pieceId: Id, anchorIds: Id | Id[], opt: { deg?: number; aim?: 'next' | 'prev'; preserve?: boolean }): number[] {
  return doc.transact('Angle grading', () => {
    const { piece, line } = ctx(doc, pieceId);
    const out: number[] = [];
    for (const id of Array.isArray(anchorIds) ? anchorIds : [anchorIds]) {
      const ref = editable(piece, line, id);
      if (!ref.anchor) throw new Error('Angle grading applies to contour anchors');
      let deg = opt.deg ?? 0;
      if (opt.aim) {
        const nid = nextGradeAnchor(doc, pieceId, id, opt.aim === 'next' ? 1 : -1);
        if (!nid) throw new Error('No ' + opt.aim + ' grade anchor');
        const n = locateAnchor(piece, nid).anchor;
        deg = angleOf(sub(n, ref.anchor)) * 180 / Math.PI;
      }
      const w = refWorldAbs(ref, line);
      ref.anchor.gradeAxisDeg = deg === 0 ? undefined : deg;
      if (opt.preserve !== false) ref.anchor.grade = incFromWorldAbs(w, line, ref.anchor.gradeAxisDeg);
      out.push(deg);
    }
    return out;
  });
}

// ───────────────────────── parallel / proportional ─────────────────────────

export interface GradeParallelOptions {
  /** true (default): the `to` anchor is adjusted; false: the `from` anchor */
  adjustLast?: boolean;
  /** move the adjusted point only in X (keeps its graded Y) */
  xOnly?: boolean;
  /** move only in Y */
  yOnly?: boolean;
  /** keep each size's own segment length (segment rotates to be parallel); default projects orthogonally */
  preserveLength?: boolean;
}

/** Grade Parallel: make segment from→to parallel to its base direction in every size. */
export function gradeParallel(doc: Document, pieceId: Id, fromAnchorId: Id, toAnchorId: Id, opt: GradeParallelOptions = {}): void {
  doc.transact('Grade parallel', () => {
    const { piece, line } = ctx(doc, pieceId);
    const adjLast = opt.adjustLast !== false;
    const F = editable(piece, line, adjLast ? fromAnchorId : toAnchorId);
    const M = editable(piece, line, adjLast ? toAnchorId : fromAnchorId);
    const u = norm(sub(M.pos, F.pos));
    if (len(u) < 1e-12) throw new Error('Degenerate segment');
    const wF = refWorldAbs(F, line), wM = refWorldAbs(M, line);
    const out: Record<SizeId, Vec> = {};
    for (const s of line.sizes) {
      const Fs = { x: F.pos.x + wF[s.id].x, y: F.pos.y + wF[s.id].y };
      const Ms = { x: M.pos.x + wM[s.id].x, y: M.pos.y + wM[s.id].y };
      let P: Vec;
      if (s.id === line.baseSizeId) P = { x: M.pos.x, y: M.pos.y };
      else if (opt.xOnly) {
        if (Math.abs(u.y) < 1e-12) throw new Error('X-only parallel impossible on a horizontal segment');
        P = { x: Fs.x + u.x * (Ms.y - Fs.y) / u.y, y: Ms.y };
      } else if (opt.yOnly) {
        if (Math.abs(u.x) < 1e-12) throw new Error('Y-only parallel impossible on a vertical segment');
        P = { x: Ms.x, y: Fs.y + u.y * (Ms.x - Fs.x) / u.x };
      } else {
        const t = opt.preserveLength ? len(sub(Ms, Fs)) : dot(sub(Ms, Fs), u);
        P = { x: Fs.x + u.x * t, y: Fs.y + u.y * t };
      }
      out[s.id] = { x: P.x - M.pos.x, y: P.y - M.pos.y };
    }
    writeWorldAbs(M, line, out);
    if (M.anchor) delete M.anchor.ruleId;
  });
}

/**
 * Grade Proportionally: interpolate the absolute offsets of points between two graded anchors by
 * their proportional position t ∈ [0,1]. `by:'arc'` uses base arc length along the shared contour,
 * `'chord'` the projection onto from→to; default 'arc' when all lie on one contour, else 'chord'.
 * Accepts any graded entity id (e.g. buttons/drills down a CF).
 */
export function gradeProportionally(doc: Document, pieceId: Id, ids: Id[], fromAnchorId: Id, toAnchorId: Id, opt: { by?: 'arc' | 'chord' } = {}): number[] {
  return doc.transact('Grade proportionally', () => {
    const { piece, line } = ctx(doc, pieceId);
    const F = findRef(piece, fromAnchorId), T = findRef(piece, toAnchorId);
    const wF = refWorldAbs(F, line), wT = refWorldAbs(T, line);
    const refs = ids.map(id => editable(piece, line, id));
    const sameContour = !!F.contour && F.contour === T.contour && refs.every(r => r.contour === F.contour);
    const by = opt.by ?? (sameContour ? 'arc' : 'chord');
    let ts: number[];
    if (by === 'arc') {
      if (!sameContour) throw new Error('arc mode requires all points on one contour');
      const c = F.contour!;
      const r = resolveContour(c, line, line.baseSizeId);
      const iF = c.points.indexOf(F.anchor!), iT = c.points.indexOf(T.anchor!);
      const total = totalLength(r);
      const at = (i: number) => r.cum[r.anchorIndex[i]];
      const fwd = (i: number) => { let d = at(i) - at(iF); if (c.closed && d < 0) d += total; return d; };
      const L = fwd(iT);
      ts = refs.map(rf => L < 1e-12 ? 0 : fwd(c.points.indexOf(rf.anchor!)) / L);
    } else {
      const d = sub(T.pos, F.pos), L2 = dot(d, d);
      ts = refs.map(rf => L2 < 1e-12 ? 0 : dot(sub(rf.pos, F.pos), d) / L2);
    }
    refs.forEach((rf, k) => {
      const t = Math.max(0, Math.min(1, ts[k]));
      const w: Record<SizeId, Vec> = {};
      for (const s of line.sizes) w[s.id] = { x: wF[s.id].x * (1 - t) + wT[s.id].x * t, y: wF[s.id].y * (1 - t) + wT[s.id].y * t };
      writeWorldAbs(rf, line, w);
      if (rf.anchor) delete rf.anchor.ruleId;
    });
    return ts;
  });
}

// ───────────────────────── reverse grading ─────────────────────────

export interface GradedNestOptions {
  /** index (into pieceIds) of the base-size piece; default = index of the size line's base */
  baseIndex?: number;
  /** sizes the pieces represent, same order (default: the size line of the base piece's table) */
  sizeIds?: SizeId[];
  name?: string;
  /** add the new piece to the style (default true) */
  add?: boolean;
}

/**
 * Graded Nest (reverse grading): build one graded piece from individually drafted sizes
 * (pieceIds ordered smallest → largest). Anchors are matched by index when every sew contour has
 * the same anchor count, otherwise by proportional arc-length position from anchor #0.
 * Internals / drills / texts are matched by index when counts agree. Returns the new piece.
 */
export function gradedNest(doc: Document, pieceIds: Id[], opt: GradedNestOptions = {}): Piece {
  return doc.transact('Graded nest', style => {
    const pieces = pieceIds.map(id => doc.piece(id));
    const line0 = doc.sizeLine(pieces[0]);
    const sizeIds = opt.sizeIds ?? line0.sizes.map(s => s.id);
    if (sizeIds.length !== pieces.length) throw new Error(`Need ${sizeIds.length} pieces (one per size), got ${pieces.length}`);
    const bi = opt.baseIndex ?? sizeIds.indexOf(line0.baseSizeId);
    if (sizeIds[bi] !== line0.baseSizeId) throw new Error('baseIndex must correspond to the base size of the size line');
    const line: SizeLine = { ...line0, sizes: line0.sizes.filter(s => sizeIds.includes(s.id)) };
    // each piece resolved in its own base size (individually drafted pieces are ungraded)
    const posOf = (p: Piece, c: Contour) => anchorPositions(c.points, doc.sizeLine(p), doc.sizeLine(p).baseSizeId, c.closed);
    const basePiece = pieces[bi];
    const { piece: out } = clonePieceFresh(basePiece);
    out.name = opt.name ?? basePiece.name + ' NEST';
    out.sizes = line.sizes.length === line0.sizes.length ? undefined : sizeIds.slice();
    out.sizeTableId = basePiece.sizeTableId;

    const contourPairs = (sel: (p: Piece) => Contour[]) => {
      const lists = pieces.map(sel);
      const n = lists[bi].length;
      return lists.every(l => l.length === n) ? lists : undefined;
    };
    const assign = (targets: Anchor[], perSize: Vec[][]) => {
      const basePos = perSize[bi];
      targets.forEach((a, k) => {
        const w: Record<SizeId, Vec> = {};
        sizeIds.forEach((s, i) => { w[s] = { x: perSize[i][k].x - basePos[k].x, y: perSize[i][k].y - basePos[k].y }; });
        a.x = basePos[k].x; a.y = basePos[k].y;
        a.grade = incFromWorldAbs(w, line, a.gradeAxisDeg);
        delete a.ruleId;
      });
    };
    const matchContour = (target: Contour, sources: { piece: Piece; contour: Contour }[]) => {
      const counts = sources.map(s => s.contour.points.length);
      if (counts.every(c => c === counts[bi])) {
        assign(target.points, sources.map(s => posOf(s.piece, s.contour)));
        return;
      }
      // proportional matching along contour from anchor #0
      const bs = sources[bi];
      const rb = resolveContour(bs.contour, doc.sizeLine(bs.piece), doc.sizeLine(bs.piece).baseSizeId);
      const Lb = totalLength(rb);
      const frac = target.points.map((_, k) => Lb < 1e-12 ? 0 : rb.cum[rb.anchorIndex[k]] / Lb);
      const perSize = sources.map((s, i) => {
        if (i === bi) return posOf(s.piece, s.contour);
        const r = resolveContour(s.contour, doc.sizeLine(s.piece), doc.sizeLine(s.piece).baseSizeId);
        const poly = r.closed ? [...r.pts, r.pts[0]] : r.pts;
        const L = totalLength(r);
        return frac.map(f => pointAtLength(poly, f * L).pt);
      });
      assign(target.points, perSize);
    };
    matchContour(out.sew, pieces.map(p => ({ piece: p, contour: p.sew })));
    const ints = contourPairs(p => p.internals);
    if (ints) out.internals.forEach((c, k) => matchContour(c, pieces.map((p, i) => ({ piece: p, contour: ints[i][k] }))));
    const objs = <T extends { x: number; y: number; grade: GradeRec }>(sel: (p: Piece) => T[]) => {
      const lists = pieces.map(sel); const tgt = sel(out);
      if (!lists.every(l => l.length === tgt.length)) return;
      tgt.forEach((o, k) => {
        const w: Record<SizeId, Vec> = {};
        sizeIds.forEach((s, i) => { w[s] = { x: lists[i][k].x - lists[bi][k].x, y: lists[i][k].y - lists[bi][k].y }; });
        o.grade = incFromWorldAbs(w, line);
      });
    };
    objs(p => p.drills); objs(p => p.texts); objs(p => p.artwork);
    if (opt.add !== false) style.pieces.push(out);
    return out;
  });
}
export const reverseGrading = gradedNest;

/** World position of a graded entity in a size (convenience for UIs and tests). */
export function gradedPosition(doc: Document, pieceId: Id, id: Id, sizeId: SizeId): Vec {
  const { piece, line } = ctx(doc, pieceId);
  const ref = findRef(piece, id);
  const w = refWorldAbs(ref, line)[sizeId] ?? { x: 0, y: 0 };
  return { x: ref.pos.x + w.x, y: ref.pos.y + w.y };
}

export { rotDeg };
