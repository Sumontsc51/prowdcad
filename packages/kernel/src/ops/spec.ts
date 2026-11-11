/**
 * Measure Spec — points of measure (POM) that drive the pattern.
 *
 * A spec item is a named measurement tied to geometry: internal line(s) / outline segment(s)
 * summed ('line'), or a straight point-to-point distance ('distance'). It carries a target per
 * size and a movement rule per point: which points move, in which direction, with what share.
 *
 * Applying a spec solves, per size, the one movement t that makes the measurement equal its
 * target; every mover moves by t · share · direction. By default the end of the line moves along
 * the line, so a longer spec lengthens the line at its end by the difference (an offset).
 *
 *  - base size: the base coordinates move; every other size follows (grading is unchanged), and
 *    curve points between moved grade points follow them (same rule as Movement Programs).
 *  - other sizes: only that size's grading changes (absolute per-size edit; sizes stay independent).
 *    The base is solved first, so a spec whose sizes differ by the existing grading needs no
 *    grading change at all.
 */
import type { Document } from '../model/doc';
import type { Contour, Id, MeasureSpecItem, Piece, SizeId, SizeLine, SpecMover, Style } from '../model/types';
import { anchorPositions } from '../model/contour';
import { type Vec, sub, norm } from '../geom/vec';
import { newId } from '../model/factory';
import { measurePart, matchingSize, resolveSeg, solveScalar, type MeasureMode, type MeasurePart } from './measure';
import { carryCurvePoints } from './movement';
import { findRef, refWorldAbs, incFromWorldAbs, materializeCurves, deepClone, allContours } from './grading/util';

export type { MeasureSpecItem, SpecMover };

const items = (doc: Document): MeasureSpecItem[] => (doc.style.measureSpec ??= []);

export function specItem(doc: Document, id: Id): MeasureSpecItem {
  const it = items(doc).find(x => x.id === id || x.name === id);
  if (!it) throw new Error('No spec measurement ' + id);
  return it;
}

/** The size line a spec item's targets are keyed by (the size line of its first piece). */
export function specSizeLine(doc: Document, item: MeasureSpecItem): SizeLine {
  const pid = item.kind === 'distance' ? item.a?.pieceId : item.parts[0]?.ref.pieceId;
  if (!pid) throw new Error(`Spec “${item.name}” has no geometry`);
  return doc.sizeLine(doc.piece(pid));
}

function anchorLocal(doc: Document, p: { pieceId: Id; anchorId: Id }, line: SizeLine, sid: SizeId): Vec | null {
  const piece = doc.piece(p.pieceId);
  const ps = matchingSize(doc, piece, line, sid); if (ps === undefined) return null;
  const hit = doc.findAnchor(piece, p.anchorId); if (!hit) throw new Error('No anchor ' + p.anchorId);
  return anchorPositions(hit.contour.points, doc.sizeLine(piece), ps, hit.contour.closed)[hit.index];
}

function measureItem(doc: Document, item: MeasureSpecItem, line: SizeLine, sid: SizeId): number | null {
  if (item.kind === 'distance') {
    if (!item.a || !item.b) throw new Error(`Spec “${item.name}” needs two points`);
    const a = anchorLocal(doc, item.a, line, sid), b = anchorLocal(doc, item.b, line, sid);
    if (!a || !b) return null;
    const d = sub(b, a);
    return item.mode === 'x' ? Math.abs(d.x) : item.mode === 'y' ? Math.abs(d.y) : Math.hypot(d.x, d.y);
  }
  if (!item.parts.length) throw new Error(`Spec “${item.name}” has no lines`);
  let v = 0;
  for (const p of item.parts) {
    const ps = matchingSize(doc, doc.piece(p.ref.pieceId), line, sid);
    if (ps === undefined) return null;
    v += measurePart(doc, p as MeasurePart, item.mode as MeasureMode, ps);
  }
  return v;
}

/** Current value of a spec item in a size (default: base). null = not cut in that size, or its geometry is gone. */
export function specValue(doc: Document, itemOrId: MeasureSpecItem | Id, sizeId?: SizeId): number | null {
  try {
    const item = typeof itemOrId === 'string' ? specItem(doc, itemOrId) : itemOrId;
    const line = specSizeLine(doc, item);
    return measureItem(doc, item, line, sizeId ?? line.baseSizeId);
  } catch { return null; }
}

export interface SpecRow { sizeId: SizeId; sizeName: string; value: number | null; target: number | null; diff: number | null }
/** Per size: measured now, target, now − target. Empty when the item's geometry no longer exists. */
export function specRows(doc: Document, itemOrId: MeasureSpecItem | Id): SpecRow[] {
  const item = typeof itemOrId === 'string' ? specItem(doc, itemOrId) : itemOrId;
  let line: SizeLine; try { line = specSizeLine(doc, item); } catch { return []; }
  return line.sizes.map(s => {
    let value: number | null = null; try { value = measureItem(doc, item, line, s.id); } catch { value = null; }
    const t = item.targets[s.id]; const target = t !== undefined && Number.isFinite(t) ? t : null;
    return { sizeId: s.id, sizeName: s.name, value, target, diff: value !== null && target !== null ? value - target : null };
  });
}

/** The default rule: the END of the measurement moves along the line (the other end stays). */
export function defaultSpecMovers(item: Pick<MeasureSpecItem, 'kind' | 'parts' | 'a' | 'b'>): SpecMover[] {
  if (item.kind === 'distance') return item.b ? [{ pieceId: item.b.pieceId, anchorId: item.b.anchorId, dir: 'along', share: 1 }] : [];
  const last = item.parts[item.parts.length - 1];
  return last ? [{ pieceId: last.ref.pieceId, anchorId: last.ref.to, dir: 'along', share: 1 }] : [];
}

export interface SpecItemInit {
  name: string;
  kind: 'line' | 'distance';
  parts?: MeasurePart[];
  a?: { pieceId: Id; anchorId: Id }; b?: { pieceId: Id; anchorId: Id };
  mode?: MeasureMode;
  /** targets per size; omitted = the current values (the pattern already meets the new spec) */
  targets?: Record<SizeId, number>;
  movers?: SpecMover[];
}

/** Add a point of measure. Its targets start as the current values unless given. */
export function addSpecItem(doc: Document, init: SpecItemInit): Id {
  const item: MeasureSpecItem = {
    id: newId('pom'), name: init.name.trim() || 'Measurement', kind: init.kind,
    parts: deepClone(init.parts ?? []), a: init.a ? { ...init.a } : undefined, b: init.b ? { ...init.b } : undefined,
    mode: init.mode ?? (init.kind === 'distance' ? 'diagonal' : 'contour'), targets: {}, movers: [],
  };
  const line = specSizeLine(doc, item); // validates the geometry
  if (measureItem(doc, item, line, line.baseSizeId) === null) throw new Error('That geometry cannot be measured in the base size');
  item.movers = deepClone(init.movers ?? defaultSpecMovers(item));
  if (init.targets) item.targets = { ...init.targets };
  else for (const s of line.sizes) { const v = measureItem(doc, item, line, s.id); if (v !== null) item.targets[s.id] = v; }
  return doc.transact('Add spec measurement', () => { items(doc).push(item); return item.id; });
}

export function updateSpecItem(doc: Document, id: Id, patch: Partial<Pick<MeasureSpecItem, 'name' | 'mode' | 'movers' | 'targets'>>): void {
  doc.transact('Edit spec measurement', () => {
    const it = specItem(doc, id);
    if (patch.name !== undefined) it.name = patch.name.trim() || it.name;
    if (patch.mode !== undefined) it.mode = patch.mode;
    if (patch.movers !== undefined) {
      for (const m of patch.movers) findRef(doc.piece(m.pieceId), m.anchorId); // validate
      it.movers = deepClone(patch.movers);
    }
    if (patch.targets !== undefined) it.targets = { ...patch.targets };
  });
}

/** Set (or with null clear) the target of some sizes. */
export function setSpecTargets(doc: Document, id: Id, targets: Record<SizeId, number | null>): void {
  doc.transact('Spec target', () => {
    const it = specItem(doc, id);
    for (const [sid, v] of Object.entries(targets)) { if (v === null || !Number.isFinite(v)) delete it.targets[sid]; else it.targets[sid] = v; }
  });
}

export function removeSpecItem(doc: Document, id: Id): void {
  doc.transact('Remove spec measurement', s => { const it = specItem(doc, id); s.measureSpec = items(doc).filter(x => x !== it); });
}

// ───────────────────────────── apply ─────────────────────────────

export interface SpecApplyRow {
  sizeId: SizeId; sizeName: string;
  target: number | null;
  before: number | null;
  after: number | null;
  /** after − target */
  residual: number | null;
  /** solved movement in mm (each mover moved by t · share along its direction) */
  t: number;
  solved: boolean;
  note?: string;
}
export interface SpecApplyResult { id: Id; name: string; rows: SpecApplyRow[]; maxResidual: number; changed: boolean; error?: string }

export interface SpecApplyOptions {
  /** only these sizes (default: every size that has a target) */
  sizes?: SizeId[];
  /** false = preview: solve and report, write nothing. Default true (one undo step for everything) */
  write?: boolean;
  tol?: number;
}

/** Unit direction (piece frame) a mover takes for +1 of the measurement, in the given size. */
function moverDir(doc: Document, item: MeasureSpecItem, m: SpecMover, line: SizeLine, sid: SizeId): Vec {
  if (m.dir === 'x') return { x: 1, y: 0 };
  if (m.dir === 'y') return { x: 0, y: 1 };
  if (m.dir === 'angle') { const a = (m.angleDeg ?? 0) * Math.PI / 180; return { x: Math.cos(a), y: Math.sin(a) }; }
  const unit = (v: Vec): Vec => (Math.hypot(v.x, v.y) < 1e-12 ? { x: 1, y: 0 } : norm(v));
  if (item.kind === 'distance') {
    const a = anchorLocal(doc, item.a!, line, sid), b = anchorLocal(doc, item.b!, line, sid);
    if (!a || !b) return { x: 1, y: 0 };
    return m.anchorId === item.a!.anchorId ? unit(sub(a, b)) : unit(sub(b, a));
  }
  // an end of one of the measured runs: outward along the run at that end
  let first: Vec | null = null, last: Vec | null = null;
  for (const p of item.parts) {
    const piece = doc.piece(p.ref.pieceId);
    const ps = matchingSize(doc, piece, line, sid); if (ps === undefined) continue;
    const poly = resolveSeg(doc, p.ref, ps).poly; if (poly.length < 2) continue;
    first ??= poly[0]; last = poly[poly.length - 1];
    if (p.ref.pieceId !== m.pieceId) continue;
    if (m.anchorId === p.ref.to) return unit(sub(poly[poly.length - 1], poly[poly.length - 2]));
    if (m.anchorId === p.ref.from) return unit(sub(poly[0], poly[1]));
  }
  // any other point: along the chord of the whole measurement
  return first && last ? unit(sub(last, first)) : { x: 1, y: 0 };
}

function applyOne(doc: Document, scratch: Document, item: MeasureSpecItem, opt: SpecApplyOptions): SpecApplyResult {
  const res: SpecApplyResult = { id: item.id, name: item.name, rows: [], maxResidual: 0, changed: false };
  const line = specSizeLine(scratch, item);
  const tol = opt.tol ?? 1e-6;
  const movers = item.movers.filter(m => m.share !== 0);
  const order = [line.baseSizeId, ...line.sizes.map(s => s.id).filter(id => id !== line.baseSizeId)];
  const rowOf = new Map<SizeId, SpecApplyRow>();
  for (const sid of order) {
    const sName = line.sizes.find(s => s.id === sid)?.name ?? sid;
    const t0 = item.targets[sid]; const target = t0 !== undefined && Number.isFinite(t0) ? t0 : null;
    let before: number | null = null; try { before = measureItem(doc, item, line, sid); } catch { before = null; }
    const row: SpecApplyRow = { sizeId: sid, sizeName: sName, target, before, after: before, residual: target !== null && before !== null ? before - target : null, t: 0, solved: false };
    rowOf.set(sid, row);
    if (target === null) { row.note = 'no target'; continue; }
    if (opt.sizes && !opt.sizes.includes(sid)) { row.note = 'not applied'; continue; }
    const cur = measureItem(scratch, item, line, sid);
    if (cur === null) { row.note = 'size not cut'; continue; }
    if (Math.abs(cur - target) <= tol) { row.after = cur; row.residual = cur - target; row.solved = true; continue; }
    if (!movers.length) { row.note = 'no point is set to move (Rules)'; row.after = cur; row.residual = cur - target; continue; }
    const dirs = movers.map(m => moverDir(scratch, item, m, line, sid));
    let f: (t: number) => number;
    if (sid === line.baseSizeId) {
      // base: move the base coordinates; curve points between moved grade points follow
      const pieces = [...new Set(movers.map(m => m.pieceId))].map(id => scratch.piece(id));
      const old = new Map<Contour, Vec[]>();
      for (const p of pieces) for (const c of allContours(p)) old.set(c, c.points.map(a => ({ x: a.x, y: a.y })));
      const refs = movers.map(m => findRef(scratch.piece(m.pieceId), m.anchorId));
      const pos0 = refs.map(r => ({ x: r.pos.x, y: r.pos.y }));
      const explicit = new Set(movers.map(m => m.anchorId));
      f = t => {
        for (const [c, pts] of old) c.points.forEach((a, i) => { a.x = pts[i].x; a.y = pts[i].y; });
        refs.forEach((r, i) => { r.pos.x = pos0[i].x + t * movers[i].share * dirs[i].x; r.pos.y = pos0[i].y + t * movers[i].share * dirs[i].y; });
        carryCurvePoints(old, explicit);
        return measureItem(scratch, item, line, sid) ?? NaN;
      };
    } else {
      // another size: absolute edit of that size's grading only
      const ms = movers.map(m => {
        const piece = scratch.piece(m.pieceId); const pl = scratch.sizeLine(piece);
        let ref = findRef(piece, m.anchorId);
        if (ref.implicit && ref.contour) { materializeCurves(ref.contour, pl, 'grade', [ref.contour.points.indexOf(ref.anchor!)]); ref = findRef(piece, m.anchorId); }
        return { piece, pl, ref, w0: refWorldAbs(ref, pl), ps: matchingSize(scratch, piece, line, sid) };
      });
      if (ms.every(x => x.ps === undefined || x.ps === x.pl.baseSizeId)) { row.note = 'the moving points have no grading in this size'; row.after = cur; row.residual = cur - target; continue; }
      f = t => {
        ms.forEach((x, i) => {
          if (x.ps === undefined || x.ps === x.pl.baseSizeId) return;
          const w = refWorldAbs(x.ref, x.pl);
          w[x.ps] = { x: x.w0[x.ps].x + t * movers[i].share * dirs[i].x, y: x.w0[x.ps].y + t * movers[i].share * dirs[i].y };
          x.ref.set(incFromWorldAbs(w, x.pl, x.ref.axisDeg));
          if (x.ref.anchor && t !== 0) delete x.ref.anchor.ruleId; // locally edited: no longer follows its rule
        });
        return measureItem(scratch, item, line, sid) ?? NaN;
      };
    }
    const sol = solveScalar(f, target, target - cur, tol);
    const t = sol.converged ? sol.t : 0;
    const after = f(t);
    row.t = t; row.after = after; row.residual = after - target; row.solved = sol.converged;
    if (!sol.converged) row.note = 'cannot be reached by moving these points this way (left unchanged)';
    else if (Math.abs(t) > 0) res.changed = true;
  }
  res.rows = line.sizes.map(s => rowOf.get(s.id)!);
  res.maxResidual = res.rows.reduce((m, r) => (r.solved && r.residual !== null ? Math.max(m, Math.abs(r.residual)) : m), 0);
  return res;
}

/**
 * Apply spec measurements (all, or the given ids) in list order: later ones see the earlier ones'
 * changes. One undo step. `write:false` previews. An item whose geometry is gone reports `error`
 * and is skipped; the others still apply.
 */
export function applySpec(doc: Document, ids?: Id[], opt: SpecApplyOptions = {}): { items: SpecApplyResult[]; written: boolean } {
  const list = ids ? ids.map(id => specItem(doc, id)) : items(doc).slice();
  const Doc = doc.constructor as new (s: Style) => Document;
  const scratch = new Doc(deepClone(doc.style));
  const out: SpecApplyResult[] = [];
  const touched = new Set<Id>();
  for (const it of list) {
    const sIt = (scratch.style.measureSpec ?? []).find(x => x.id === it.id)!;
    const keep = JSON.stringify(scratch.style.pieces);
    try {
      const r = applyOne(doc, scratch, sIt, opt);
      out.push(r);
      if (r.changed) for (const m of sIt.movers) touched.add(m.pieceId);
    } catch (err) {
      scratch.style.pieces = JSON.parse(keep) as Piece[]; // a failed item leaves no half-moved points behind
      out.push({ id: it.id, name: it.name, rows: [], maxResidual: 0, changed: false, error: (err as Error).message });
    }
  }
  let written = false;
  if (opt.write !== false && touched.size) {
    doc.transact(list.length === 1 ? `Apply spec: ${list[0].name}` : 'Apply measure spec', s => {
      s.pieces = s.pieces.map(p => { if (!touched.has(p.id)) return p; const n = scratch.style.pieces.find(x => x.id === p.id); if (!n) return p; n.updatedAt = new Date().toISOString(); return deepClone(n); });
    });
    written = true;
  }
  return { items: out, written };
}
