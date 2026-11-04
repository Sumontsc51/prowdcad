/**
 * Size line editor & size tables (A7).
 *
 * All size operations re-express every graded record in the style through ONE visitor
 * (`visitGradedRecords`) so that geometry of every existing size is preserved exactly:
 * anchors (axis1 `grade`, axis2 `grade2`), dart apices, pleat axis ends, drills, texts, artwork,
 * grain ends, and notch distances (`Record<SizeId, number>`, stored as absolute per-size values).
 */
import type { Vec } from '../geom/vec';
import type { Document, ResolvedPiece } from '../model/doc';
import type { Anchor, Contour, GradeInc, Id, Piece, SizeDef, SizeId, SizeLine, SizeTable, Style } from '../model/types';
import { newId } from '../model/factory';
import { anchorPositions, absoluteOffset, resolveContour, withoutZeroSegments, type ResolvedContour } from '../model/contour';
import { computeCutLine } from './seam';
import {
  type GradeRec, type GradedRef, gradedRefs, piecesOfTable, contourWorldOffsets, allContours, isExplicit,
  rotDeg, incFromWorldAbs, gi, deepClone, hasKeys,
} from './grading/util';

// ───────────────────────── lookup helpers ─────────────────────────

export function tableOf(doc: Document, tableId?: Id): SizeTable { return doc.sizeTable(tableId); }
export function lineOf(doc: Document, tableId?: Id, axis: 1 | 2 = 1): SizeLine {
  const t = doc.sizeTable(tableId);
  const l = axis === 1 ? t.axis1 : t.axis2;
  if (!l) throw new Error('Size table ' + t.name + ' has no axis2');
  return l;
}
/** Sizes of a table axis (ordered small → large). */
export function sizesOfTable(doc: Document, tableId?: Id, axis: 1 | 2 = 1): SizeDef[] { return lineOf(doc, tableId, axis).sizes; }
/** Size ids a piece is cut in (piece subset or the whole axis-1 line). */
export function sizesOfPiece(doc: Document, pieceId: Id): SizeId[] { return doc.sizesOf(doc.piece(pieceId)); }
export function sizeNames(line: SizeLine): string[] { return line.sizes.map(s => s.name); }
export function sizeIdByName(line: SizeLine, name: string): SizeId | undefined { return line.sizes.find(s => s.name === name)?.id; }
export function sizeName(line: SizeLine, id: SizeId): string | undefined { return line.sizes.find(s => s.id === id)?.name; }
export function baseIndex(line: SizeLine): number { return line.sizes.findIndex(s => s.id === line.baseSizeId); }
/** Resolve a size reference given as id or name. */
export function sizeRef(line: SizeLine, idOrName: SizeId | string): SizeId {
  if (line.sizes.some(s => s.id === idOrName)) return idOrName;
  const id = sizeIdByName(line, idOrName);
  if (!id) throw new Error('No size ' + idOrName + ' in line ' + line.name);
  return id;
}

// ───────────────────────── the visitor ─────────────────────────

export interface GradedVisit {
  piece: Piece;
  ref: GradedRef;
  /** current record (never undefined; {} when absent) */
  rec: GradeRec;
}

/**
 * Walk every graded Record<SizeId,GradeInc> of every piece (active + archive) using the size table.
 * `fn` returns the replacement record (or undefined to leave as is).
 * Implicit curve points (no explicit grading) are visited only when `includeImplicit`.
 */
export function visitGradedRecords(style: Style, tableId: Id, axis: 1 | 2, fn: (v: GradedVisit) => GradeRec | undefined | void, includeImplicit = false): void {
  for (const piece of piecesOfTable(style, tableId)) {
    for (const ref of gradedRefs(piece, axis)) {
      if (ref.implicit && !includeImplicit) continue;
      const cur = ref.get();
      const r = fn({ piece, ref, rec: cur ?? {} });
      if (r) ref.set(r);
    }
  }
}

/** Walk every notch distance record (fromPrev / fromNext) of pieces using the table. Absolute values per size. */
export function visitNotchDistances(style: Style, tableId: Id, fn: (dist: Record<SizeId, number>, piece: Piece) => Record<SizeId, number> | void): void {
  for (const piece of piecesOfTable(style, tableId)) for (const n of piece.notches) {
    const p = n.placement;
    if (p.kind === 'fromPrev' || p.kind === 'fromNext') { const r = fn(p.dist, piece); if (r) p.dist = r; }
  }
}

/**
 * Snapshot world positions of implicit curve points for every size (axis), run `mutate`, and give
 * explicit grading to any implicit curve point whose interpolated position changed (base moved
 * under it, or a size was inserted that needs an explicit value). Keeps geometry exact.
 */
function preservingImplicit(style: Style, tableId: Id, axis: 1 | 2, mutate: () => void, lineAfter: () => SizeLine, keepSizes: SizeId[]): void {
  const field = axis === 1 ? 'grade' : 'grade2';
  const before = new Map<Contour, { line: SizeLine; pos: Record<SizeId, Vec[]> }>();
  const lineBefore = deepClone(lineAfter());
  for (const piece of piecesOfTable(style, tableId)) for (const c of allContours(piece)) {
    if (!c.points.some(a => !isExplicit(a, field))) continue;
    const off = contourWorldOffsets(c, lineBefore, field);
    const pos: Record<SizeId, Vec[]> = {};
    for (const s of keepSizes) if (off[s]) pos[s] = off[s].map((o, i) => ({ x: c.points[i].x + o.x, y: c.points[i].y + o.y }));
    before.set(c, { line: lineBefore, pos });
  }
  mutate();
  const line = lineAfter();
  for (const [c, b] of before) {
    const off = contourWorldOffsets(c, line, field);
    for (let i = 0; i < c.points.length; i++) {
      const a = c.points[i];
      if (isExplicit(a, field)) continue;
      let changed = false;
      for (const s of keepSizes) {
        const p = b.pos[s]?.[i]; if (!p || !off[s]) continue;
        if (Math.abs(a.x + off[s][i].x - p.x) > 1e-9 || Math.abs(a.y + off[s][i].y - p.y) > 1e-9) { changed = true; break; }
      }
      if (!changed) continue;
      const w: Record<SizeId, Vec> = {};
      for (const s of line.sizes) w[s.id] = b.pos[s.id]?.[i] ? { x: b.pos[s.id][i].x - a.x, y: b.pos[s.id][i].y - a.y } : off[s.id][i];
      a[field] = incFromWorldAbs(w, line, a.gradeAxisDeg);
    }
  }
}

// ───────────────────────── size line editing ─────────────────────────

export interface InsertSizeOptions {
  tableId?: Id;
  axis?: 1 | 2;
  name: string;
  before?: SizeId | string;
  after?: SizeId | string;
  color?: string;
  /** between two sizes: fraction of the neighbour increment given to the new size (default 0.5 = half size) */
  fraction?: number;
  /** at either end of the line: extrapolate the adjacent increment (default false = new size equals its neighbour) */
  extrapolate?: boolean;
}

/** Insert a size before/after an existing one. Returns the new size id. */
export function insertSize(doc: Document, opt: InsertSizeOptions): SizeId {
  return doc.transact('Insert size', style => {
    const axis = opt.axis ?? 1;
    const tableId = doc.sizeTable(opt.tableId).id;
    const line = lineOf(doc, tableId, axis);
    if (line.sizes.some(s => s.name === opt.name)) throw new Error('Size name exists: ' + opt.name);
    let pos: number;
    if (opt.after !== undefined) pos = line.sizes.findIndex(s => s.id === sizeRef(line, opt.after!)) + 1;
    else if (opt.before !== undefined) pos = line.sizes.findIndex(s => s.id === sizeRef(line, opt.before!));
    else pos = line.sizes.length;
    const id = newId('s');
    const n = line.sizes.length;
    const t = opt.fraction ?? 0.5;
    const oldIds = line.sizes.map(s => s.id);
    const keep = [...oldIds];
    const mutate = () => {
      // increments
      visitGradedRecords(style, tableId, axis, ({ rec }) => {
        const out: GradeRec = { ...rec };
        if (pos > 0 && pos < n) {
          const nx = oldIds[pos]; const g = gi(rec, nx);
          out[id] = { dx: g.dx * t, dy: g.dy * t };
          out[nx] = { dx: g.dx * (1 - t), dy: g.dy * (1 - t) };
        } else if (pos >= n) {
          const g = gi(rec, oldIds[n - 1]);
          out[id] = opt.extrapolate && n > 1 ? { dx: g.dx, dy: g.dy } : { dx: 0, dy: 0 };
        } else { // pos === 0: new first size; old first gets the increment from the new one
          const g = gi(rec, oldIds[1]);
          out[id] = { dx: 0, dy: 0 };
          out[oldIds[0]] = opt.extrapolate && n > 1 ? { dx: g.dx, dy: g.dy } : { dx: 0, dy: 0 };
        }
        return out;
      });
      if (axis === 1) visitNotchDistances(style, tableId, d => {
        const out = { ...d };
        const prev = pos > 0 ? d[oldIds[pos - 1]] : undefined, next = pos < n ? d[oldIds[pos]] : undefined;
        if (prev !== undefined && next !== undefined) out[id] = prev + (next - prev) * t;
        else if (prev !== undefined) out[id] = opt.extrapolate && pos >= 2 && d[oldIds[pos - 2]] !== undefined ? 2 * prev - d[oldIds[pos - 2]] : prev;
        else if (next !== undefined) out[id] = opt.extrapolate && n > 1 && d[oldIds[1]] !== undefined ? 2 * next - d[oldIds[1]] : next;
        return out;
      });
      line.sizes.splice(pos, 0, { id, name: opt.name, ...(opt.color ? { color: opt.color } : {}) });
      // piece subsets: include the new size when its neighbours are both included
      if (axis === 1) for (const p of piecesOfTable(style, tableId)) if (p.sizes) {
        const a = pos > 0 ? oldIds[pos - 1] : undefined, b = pos < n ? oldIds[pos] : undefined;
        if ((!a || p.sizes.includes(a)) && (!b || p.sizes.includes(b))) {
          const order = line.sizes.map(s => s.id);
          p.sizes = order.filter(s => s === id || p.sizes!.includes(s));
        }
      }
    };
    preservingImplicit(style, tableId, axis, mutate, () => lineOf(doc, tableId, axis), keep);
    return id;
  });
}

export function appendSize(doc: Document, name: string, opt: Omit<InsertSizeOptions, 'name' | 'before' | 'after'> = {}): SizeId {
  const line = lineOf(doc, opt.tableId, opt.axis ?? 1);
  return insertSize(doc, { ...opt, name, after: line.sizes[line.sizes.length - 1].id });
}

/** Remove a (non-base) size. Neighbouring increments absorb its increment so other sizes keep their geometry. */
export function removeSize(doc: Document, size: SizeId | string, opt: { tableId?: Id; axis?: 1 | 2 } = {}): void {
  doc.transact('Remove size', style => {
    const axis = opt.axis ?? 1;
    const tableId = doc.sizeTable(opt.tableId).id;
    const line = lineOf(doc, tableId, axis);
    const id = sizeRef(line, size);
    if (id === line.baseSizeId) throw new Error('Cannot remove the base size; setBase() first');
    const ids = line.sizes.map(s => s.id);
    const k = ids.indexOf(id);
    const keep = ids.filter(s => s !== id);
    preservingImplicit(style, tableId, axis, () => {
      visitGradedRecords(style, tableId, axis, ({ rec }) => {
        const out: GradeRec = { ...rec };
        const g = gi(rec, id);
        if (k === 0) { if (ids[1]) out[ids[1]] = { dx: 0, dy: 0 }; }
        else if (k < ids.length - 1) { const nx = gi(rec, ids[k + 1]); out[ids[k + 1]] = { dx: nx.dx + g.dx, dy: nx.dy + g.dy }; }
        delete out[id];
        return out;
      });
      if (axis === 1) visitNotchDistances(style, tableId, d => { const o = { ...d }; delete o[id]; return o; });
      line.sizes.splice(k, 1);
      if (axis === 1) for (const p of piecesOfTable(style, tableId)) if (p.sizes) p.sizes = p.sizes.filter(s => s !== id);
    }, () => lineOf(doc, tableId, axis), keep);
  });
}

export function renameSize(doc: Document, size: SizeId | string, newName: string, opt: { tableId?: Id; axis?: 1 | 2 } = {}): void {
  doc.transact('Rename size', () => {
    const line = lineOf(doc, opt.tableId, opt.axis ?? 1);
    const id = sizeRef(line, size);
    if (line.sizes.some(s => s.name === newName && s.id !== id)) throw new Error('Size name exists: ' + newName);
    line.sizes.find(s => s.id === id)!.name = newName;
  });
}

/**
 * Change the base size. Increments (differences between consecutive sizes) are base-independent,
 * so only the base coordinates move: every graded entity's base position becomes its position in
 * the new base size. Implicit curve points get explicit grading only when their interpolation
 * would otherwise drift. Geometry of every size is unchanged.
 */
export function setBase(doc: Document, size: SizeId | string, opt: { tableId?: Id; axis?: 1 | 2 } = {}): void {
  doc.transact('Set base size', style => {
    const axis = opt.axis ?? 1;
    const tableId = doc.sizeTable(opt.tableId).id;
    const line = lineOf(doc, tableId, axis);
    const nb = sizeRef(line, size);
    if (nb === line.baseSizeId) return;
    const field = axis === 1 ? 'grade' : 'grade2';
    preservingImplicit(style, tableId, axis, () => {
      for (const piece of piecesOfTable(style, tableId)) {
        // implicit curve points: move base coords to their interpolated new-base position
        const curveShift = new Map<Anchor, Vec>();
        for (const c of allContours(piece)) {
          if (!c.points.some(a => !isExplicit(a, field))) continue;
          const pos = anchorPositions(axis === 1 ? c.points : c.points.map(a => ({ ...a, grade: a.grade2 ?? {} })), line, nb, c.closed);
          c.points.forEach((a, i) => { if (!isExplicit(a, field)) curveShift.set(a, { x: pos[i].x - a.x, y: pos[i].y - a.y }); });
        }
        for (const ref of gradedRefs(piece, axis)) {
          const sh = ref.implicit ? curveShift.get(ref.anchor!)! : rotDeg(absoluteOffset(ref.get(), line, nb), ref.axisDeg);
          ref.pos.x += sh.x; ref.pos.y += sh.y;
          // first-size increment is unused by the convention; keep records tidy
        }
        // explicit handles are relative ⇒ unchanged
      }
      line.baseSizeId = nb;
    }, () => lineOf(doc, tableId, axis), line.sizes.map(s => s.id));
  });
}

// ───────────────────────── tables ─────────────────────────

export function createSizeTable(doc: Document, name: string, sizeNamesArr: string[], baseName: string, axis2?: { names: string[]; base: string; name?: string }): Id {
  return doc.transact('New size table', style => {
    const mk = (names: string[], base: string, nm: string): SizeLine => {
      const sizes = names.map(n => ({ id: newId('s'), name: n }));
      const b = sizes.find(s => s.name === base); if (!b) throw new Error('No base ' + base);
      return { id: newId('sl'), name: nm, sizes, baseSizeId: b.id };
    };
    const t: SizeTable = { id: newId('st'), name, axis1: mk(sizeNamesArr, baseName, name) };
    if (axis2) t.axis2 = mk(axis2.names, axis2.base, axis2.name ?? name + ' axis2');
    style.sizeTables.push(t);
    return t.id;
  });
}

/** Add (or replace) the second axis of a Size Variation table (e.g. inseam). Existing grade2 records are cleared. */
export function setAxis2(doc: Document, names: string[], baseName: string, opt: { tableId?: Id; name?: string } = {}): SizeLine {
  return doc.transact('Set axis 2', style => {
    const t = doc.sizeTable(opt.tableId);
    const sizes = names.map(n => ({ id: newId('s'), name: n }));
    const b = sizes.find(s => s.name === baseName); if (!b) throw new Error('No base ' + baseName);
    t.axis2 = { id: newId('sl'), name: opt.name ?? 'Axis 2', sizes, baseSizeId: b.id };
    for (const p of piecesOfTable(style, t.id)) for (const r of gradedRefs(p, 2)) if (hasKeys(r.get())) r.set({});
    return t.axis2;
  });
}

export function switchActiveTable(doc: Document, tableId: Id): void {
  doc.transact('Switch size table', style => {
    if (!style.sizeTables.some(t => t.id === tableId)) throw new Error('No size table ' + tableId);
    style.activeSizeTableId = tableId;
  });
}

/** Enumerate combined (axis1 × axis2) sizes — only on request; never stored unless combineTables() is used. */
export function combinedSizes(doc: Document, tableId?: Id): { size1: SizeId; size2: SizeId; name: string }[] {
  const t = doc.sizeTable(tableId);
  if (!t.axis2) return t.axis1.sizes.map(s => ({ size1: s.id, size2: '', name: s.name }));
  const out: { size1: SizeId; size2: SizeId; name: string }[] = [];
  for (const a of t.axis1.sizes) for (const b of t.axis2.sizes) out.push({ size1: a.id, size2: b.id, name: `${a.name}/${b.name}` });
  return out;
}

/** World offset of a graded ref for a combined size: abs1(size1) + abs2(size2). */
function combinedOffsetsForContour(c: Contour, t: SizeTable, s1: SizeId, s2: SizeId | undefined): Vec[] {
  const p1 = anchorPositions(c.points, t.axis1, s1, c.closed);
  const p2 = t.axis2 && s2 ? anchorPositions(c.points.map(a => ({ ...a, grade: a.grade2 ?? {} })), t.axis2, s2, c.closed) : c.points.map(a => ({ x: a.x, y: a.y }));
  return c.points.map((a, i) => ({ x: p1[i].x - a.x + p2[i].x - a.x, y: p1[i].y - a.y + p2[i].y - a.y }));
}

export interface CombinedResolution extends ResolvedPiece {
  size2?: SizeId;
}

/**
 * Resolve a piece for a combined (axis1, axis2) size: position = base + abs1 + abs2
 * (both via the kernel's absoluteOffset / anchorPositions, angle grading applied to each axis).
 */
export function resolveCombined(doc: Document, pieceId: Id, size1: SizeId, size2?: SizeId): CombinedResolution {
  const piece = doc.piece(pieceId);
  const t = doc.sizeTable(piece.sizeTableId);
  if (!t.axis2 || !size2) return { ...doc.resolvePiece(pieceId, size1), size2 };
  const flat: Piece = deepClone(piece);
  const shift = (c: Contour) => {
    const off = combinedOffsetsForContour(c, t, size1, size2);
    c.points.forEach((a, i) => { a.x += off[i].x; a.y += off[i].y; a.grade = {}; delete a.grade2; a.gradeAxisDeg = undefined; });
  };
  for (const c of allContours(flat)) shift(c);
  const line = t.axis1;
  const go = (g1: GradeRec | undefined, g2: GradeRec | undefined): Vec => {
    const a = absoluteOffset(g1, t.axis1, size1), b = absoluteOffset(g2, t.axis2!, size2);
    return { x: a.x + b.x, y: a.y + b.y };
  };
  const sew = resolveContour(flat.sew, line, line.baseSizeId);
  const cut = flat.cutMode === 'manual' && flat.manualCut ? resolveContour(flat.manualCut, line, line.baseSizeId).pts : computeCutLine(withoutZeroSegments(flat, line, line.baseSizeId), line, line.baseSizeId);
  const internals: ResolvedContour[] = flat.internals.map(c => resolveContour(c, line, line.baseSizeId));
  const ga = go(piece.grain.gradeA, piece.grain.gradeA2), gb = go(piece.grain.gradeB, piece.grain.gradeB2);
  return {
    pieceId, sizeId: size1, size2, sew, cut, internals,
    grain: { a: { x: piece.grain.a.x + ga.x, y: piece.grain.a.y + ga.y }, b: { x: piece.grain.b.x + gb.x, y: piece.grain.b.y + gb.y } },
  };
}

/**
 * One-way flattening of a two-axis table into a single-axis table of combined sizes
 * ("W30/L32"), axis1-major order. Pieces are re-pointed to the new table and their grade2 is
 * folded into grade. DISCOURAGED: per-axis editing is lost. Returns the new table id.
 */
export function combineTables(doc: Document, tableId?: Id, opt: { name?: string } = {}): Id {
  return doc.transact('Combine size tables', style => {
    const t = doc.sizeTable(tableId);
    if (!t.axis2) throw new Error('Table has no second axis');
    const pairs: Record<SizeId, [SizeId, SizeId]> = {};
    const sizes: SizeDef[] = [];
    let baseId = '';
    for (const a of t.axis1.sizes) for (const b of t.axis2.sizes) {
      const id = newId('s'); pairs[id] = [a.id, b.id];
      sizes.push({ id, name: `${a.name}/${b.name}` });
      if (a.id === t.axis1.baseSizeId && b.id === t.axis2.baseSizeId) baseId = id;
    }
    const line: SizeLine = { id: newId('sl'), name: opt.name ?? `${t.name} combined`, sizes, baseSizeId: baseId };
    const nt: SizeTable = { id: newId('st'), name: opt.name ?? `${t.name} (combined)`, axis1: line, combinedFrom: t.id, discouraged: true, combinedPairs: pairs };
    for (const piece of piecesOfTable(style, t.id)) {
      const r1 = gradedRefs(piece, 1), r2 = gradedRefs(piece, 2);
      const newRecs: (GradeRec | undefined)[] = r1.map((ref, k) => {
        if (ref.implicit && !hasKeys(r2[k].get())) return undefined; // stays implicit: interpolation is linear ⇒ sums stay exact
        const w: Record<SizeId, Vec> = {};
        const r2k = r2[k];
        const o1 = ref.implicit && ref.contour ? contourWorldOffsets(ref.contour, t.axis1, 'grade') : undefined;
        const o2 = r2k.implicit && r2k.contour ? contourWorldOffsets(r2k.contour, t.axis2!, 'grade2') : undefined;
        const idx = ref.contour ? ref.contour.points.indexOf(ref.anchor!) : -1;
        for (const s of sizes) {
          const [s1, s2] = pairs[s.id];
          const a = o1 ? o1[s1][idx] : rotDeg(absoluteOffset(ref.get(), t.axis1, s1), ref.axisDeg);
          const b = o2 ? o2[s2][idx] : rotDeg(absoluteOffset(r2k.get(), t.axis2!, s2), ref.axisDeg);
          w[s.id] = { x: a.x + b.x, y: a.y + b.y };
        }
        return incFromWorldAbs(w, line, ref.axisDeg);
      });
      r1.forEach((ref, k) => { const r = newRecs[k]; if (r) ref.set(r); r2[k].set(undefined as unknown as GradeRec); });
      // clean undefined grade2 keys
      for (const c of allContours(piece)) for (const a of c.points) if (a.grade2 === undefined) delete a.grade2;
      for (const o of [...piece.drills, ...piece.texts, ...piece.artwork, ...piece.darts.map(d => d.apex), ...piece.pleats.flatMap(p => [p.axisStart, p.axisEnd])]) if (o.grade2 === undefined) delete o.grade2;
      if (piece.grain.gradeA2 === undefined) delete piece.grain.gradeA2;
      if (piece.grain.gradeB2 === undefined) delete piece.grain.gradeB2;
      for (const n of piece.notches) {
        const p = n.placement;
        if (p.kind === 'fromPrev' || p.kind === 'fromNext') { const d: Record<SizeId, number> = {}; for (const s of sizes) { const v = p.dist[pairs[s.id][0]]; if (v !== undefined) d[s.id] = v; } p.dist = d; }
      }
      if (piece.sizes) piece.sizes = sizes.filter(s => piece.sizes!.includes(pairs[s.id][0])).map(s => s.id);
      piece.sizeTableId = nt.id;
    }
    style.sizeTables.push(nt);
    if (style.activeSizeTableId === t.id) style.activeSizeTableId = nt.id;
    return nt.id;
  });
}

// ───────────────────────── cleanup ─────────────────────────

/** Non-base sizes in which no graded entity (incl. notch distances) differs from the previous size. */
export function ungradedSizes(doc: Document, opt: { tableId?: Id; axis?: 1 | 2; tol?: number } = {}): SizeId[] {
  const axis = opt.axis ?? 1, tol = opt.tol ?? 1e-9;
  const t = doc.sizeTable(opt.tableId);
  const line = lineOf(doc, t.id, axis);
  const ids = line.sizes.map(s => s.id);
  const graded = new Set<SizeId>();
  visitGradedRecords(doc.style, t.id, axis, ({ rec }) => {
    for (let i = 1; i < ids.length; i++) { const g = rec[ids[i]]; if (g && (Math.abs(g.dx) > tol || Math.abs(g.dy) > tol)) graded.add(ids[i]); }
  });
  if (axis === 1) visitNotchDistances(doc.style, t.id, d => {
    for (let i = 1; i < ids.length; i++) { const a = d[ids[i - 1]], b = d[ids[i]]; if (a !== undefined && b !== undefined && Math.abs(a - b) > tol) graded.add(ids[i]); }
  });
  // the first size is "graded" when the second size has an increment (it differs from its neighbour)
  if (ids.length > 1 && graded.has(ids[1])) graded.add(ids[0]);
  return ids.filter(s => s !== line.baseSizeId && !graded.has(s));
}

/** Delete Ungraded sizes: removes every non-base size with no non-zero increment anywhere. Returns removed ids. */
export function deleteUngradedSizes(doc: Document, opt: { tableId?: Id; axis?: 1 | 2 } = {}): SizeId[] {
  return doc.transact('Delete ungraded sizes', () => {
    const ids = ungradedSizes(doc, opt);
    for (const s of ids) removeSize(doc, s, opt);
    return ids;
  });
}

/** Sizes not cut in any piece of the table (every piece has a subset that excludes them). */
export function invisibleSizes(doc: Document, opt: { tableId?: Id } = {}): SizeId[] {
  const t = doc.sizeTable(opt.tableId);
  const pieces = piecesOfTable(doc.style, t.id, false);
  if (!pieces.length) return [];
  return t.axis1.sizes.map(s => s.id).filter(s => s !== t.axis1.baseSizeId && pieces.every(p => p.sizes && !p.sizes.includes(s)));
}

export function deleteInvisibleSizes(doc: Document, opt: { tableId?: Id } = {}): SizeId[] {
  return doc.transact('Delete invisible sizes', () => {
    const ids = invisibleSizes(doc, opt);
    for (const s of ids) removeSize(doc, s, { tableId: opt.tableId });
    return ids;
  });
}

export type { GradeInc };
