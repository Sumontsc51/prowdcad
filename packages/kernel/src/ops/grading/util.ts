/**
 * Shared helpers for the grading module family (grading / sizes / rules / movement).
 * Everything here works in the kernel's incremental convention (see model/contour.ts).
 */
import type { Vec } from '../../geom/vec';
import type { Anchor, Contour, GradeInc, Id, Piece, SizeId, SizeLine, Style } from '../../model/types';
import { absoluteOffset, absoluteToIncremental, anchorPositions, incrementalToAbsolute } from '../../model/contour';
import { newId } from '../../model/factory';

export type GradeRec = Record<SizeId, GradeInc>;

export const rotDeg = (v: Vec, deg?: number): Vec => {
  if (!deg) return { x: v.x, y: v.y };
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};
export const sizeIdsOf = (line: SizeLine): SizeId[] => line.sizes.map(s => s.id);
export const hasKeys = (r: object | undefined): boolean => !!r && Object.keys(r).length > 0;
export const gi = (r: GradeRec | undefined, s: SizeId): GradeInc => r?.[s] ?? { dx: 0, dy: 0 };
export const deepClone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** World-frame absolute offset of a record for a size (angle grading applied). */
export function worldAbs(rec: GradeRec | undefined, line: SizeLine, s: SizeId, axisDeg?: number): Vec {
  return rotDeg(absoluteOffset(rec, line, s), axisDeg);
}

/** Absolute map (local frame) keyed by every size of the line. */
export const absMap = (rec: GradeRec | undefined, line: SizeLine): GradeRec => incrementalToAbsolute(rec ?? {}, line);
export const incFromAbs = (abs: GradeRec, line: SizeLine): GradeRec => absoluteToIncremental(abs, line);

/** Build an incremental record from per-size WORLD absolute offsets (base forced to 0). */
export function incFromWorldAbs(world: Record<SizeId, Vec>, line: SizeLine, axisDeg?: number): GradeRec {
  const abs: GradeRec = {};
  for (const s of line.sizes) {
    const w = s.id === line.baseSizeId ? { x: 0, y: 0 } : world[s.id] ?? { x: 0, y: 0 };
    const l = rotDeg(w, axisDeg ? -axisDeg : undefined);
    abs[s.id] = { dx: l.x, dy: l.y };
  }
  return incFromAbs(abs, line);
}

export function allContours(piece: Piece): Contour[] {
  return [piece.sew, ...piece.internals, ...(piece.manualCut ? [piece.manualCut] : [])];
}

export function locateAnchor(piece: Piece, anchorId: Id): { contour: Contour; index: number; anchor: Anchor } {
  for (const c of allContours(piece)) {
    const i = c.points.findIndex(a => a.id === anchorId);
    if (i >= 0) return { contour: c, index: i, anchor: c.points[i] };
  }
  throw new Error('No anchor ' + anchorId + ' in piece ' + piece.id);
}

/** Does the anchor carry its own grading (grade point, or curve point with explicit grade)? */
export const isExplicit = (a: Anchor, field: 'grade' | 'grade2' = 'grade'): boolean => a.kind === 'grade' || hasKeys(a[field]);

/** Points view with grade2 substituted for grade (to reuse anchorPositions on axis 2). */
export function pointsForField(points: Anchor[], field: 'grade' | 'grade2'): Anchor[] {
  return field === 'grade' ? points : points.map(a => ({ ...a, grade: a.grade2 ?? {} }));
}

/** World offsets (pos_s − base) of every anchor of a contour, for every size of the line. */
export function contourWorldOffsets(contour: Contour, line: SizeLine, field: 'grade' | 'grade2' = 'grade'): Record<SizeId, Vec[]> {
  const pts = pointsForField(contour.points, field);
  const out: Record<SizeId, Vec[]> = {};
  for (const s of line.sizes) {
    const pos = anchorPositions(pts, line, s.id, contour.closed);
    out[s.id] = pos.map((p, i) => ({ x: p.x - contour.points[i].x, y: p.y - contour.points[i].y }));
  }
  return out;
}

/**
 * Give implicit curve points (no explicit grading) an explicit grade record reproducing their
 * current proportional positions exactly. `only` restricts to certain anchor indices.
 */
export function materializeCurves(contour: Contour, line: SizeLine, field: 'grade' | 'grade2' = 'grade', only?: number[]): void {
  const todo = contour.points.map((a, i) => i).filter(i => !isExplicit(contour.points[i], field) && (!only || only.includes(i)));
  if (!todo.length) return;
  const off = contourWorldOffsets(contour, line, field);
  for (const i of todo) {
    const a = contour.points[i];
    const w: Record<SizeId, Vec> = {};
    for (const s of line.sizes) w[s.id] = off[s.id][i];
    a[field] = incFromWorldAbs(w, line, a.gradeAxisDeg);
  }
}

/** A graded entity of a piece: anything owning base coordinates + a Record<SizeId,GradeInc>. */
export interface GradedRef {
  id: Id;
  pieceId: Id;
  kind: 'anchor' | 'dartApex' | 'pleatStart' | 'pleatEnd' | 'drill' | 'text' | 'artwork' | 'grainA' | 'grainB';
  axis: 1 | 2;
  /** base coordinates (mutable object) */
  pos: { x: number; y: number };
  axisDeg?: number;
  anchor?: Anchor;
  contour?: Contour;
  /** curve point without explicit grading: positions are interpolated from neighbours */
  implicit: boolean;
  get(): GradeRec | undefined;
  set(r: GradeRec): void;
}

export function gradedRefs(piece: Piece, axis: 1 | 2): GradedRef[] {
  const out: GradedRef[] = [];
  const f = axis === 1 ? 'grade' : 'grade2';
  const objRef = (id: Id, kind: GradedRef['kind'], o: { x: number; y: number; grade: GradeRec; grade2?: GradeRec }): GradedRef => ({
    id, pieceId: piece.id, kind, axis, pos: o, implicit: false,
    get: () => (axis === 1 ? o.grade : o.grade2),
    set: r => { if (axis === 1) o.grade = r; else o.grade2 = r; },
  });
  for (const c of allContours(piece)) for (const a of c.points) {
    out.push({
      id: a.id, pieceId: piece.id, kind: 'anchor', axis, pos: a, axisDeg: a.gradeAxisDeg, anchor: a, contour: c,
      implicit: !isExplicit(a, f),
      get: () => a[f], set: r => { a[f] = r; },
    });
  }
  for (const d of piece.darts) out.push(objRef(d.id + ':apex', 'dartApex', d.apex));
  for (const p of piece.pleats) { out.push(objRef(p.id + ':start', 'pleatStart', p.axisStart)); out.push(objRef(p.id + ':end', 'pleatEnd', p.axisEnd)); }
  for (const d of piece.drills) out.push(objRef(d.id, 'drill', d));
  for (const t of piece.texts) out.push(objRef(t.id, 'text', t));
  for (const a of piece.artwork) out.push(objRef(a.id, 'artwork', a));
  const g = piece.grain;
  out.push({ id: 'grain:a', pieceId: piece.id, kind: 'grainA', axis, pos: g.a, implicit: false,
    get: () => (axis === 1 ? g.gradeA : g.gradeA2), set: r => { if (axis === 1) g.gradeA = r; else g.gradeA2 = r; } });
  out.push({ id: 'grain:b', pieceId: piece.id, kind: 'grainB', axis, pos: g.b, implicit: false,
    get: () => (axis === 1 ? g.gradeB : g.gradeB2), set: r => { if (axis === 1) g.gradeB = r; else g.gradeB2 = r; } });
  return out;
}

export function findRef(piece: Piece, id: Id, axis: 1 | 2 = 1): GradedRef {
  const r = gradedRefs(piece, axis).find(r => r.id === id);
  if (!r) throw new Error('No graded entity ' + id);
  return r;
}

/** World absolute offsets of a ref for every size (implicit curve points resolved by interpolation). */
export function refWorldAbs(ref: GradedRef, line: SizeLine): Record<SizeId, Vec> {
  const out: Record<SizeId, Vec> = {};
  if (ref.implicit && ref.contour) {
    const off = contourWorldOffsets(ref.contour, line, ref.axis === 1 ? 'grade' : 'grade2');
    const i = ref.contour.points.indexOf(ref.anchor!);
    for (const s of line.sizes) out[s.id] = off[s.id][i];
    return out;
  }
  for (const s of line.sizes) out[s.id] = worldAbs(ref.get(), line, s.id, ref.axisDeg);
  return out;
}

/** Fresh-id deep copy of a piece (anchor/contour/object ids renewed, references remapped). */
export function clonePieceFresh(piece: Piece): { piece: Piece; idMap: Record<Id, Id> } {
  const p: Piece = deepClone(piece);
  const idMap: Record<Id, Id> = {};
  const re = (old: Id, prefix: string) => (idMap[old] = idMap[old] ?? newId(prefix));
  p.id = re(piece.id, 'pc');
  for (const c of allContours(p)) { c.id = re(c.id, 'c'); for (const a of c.points) a.id = re(a.id, 'p'); }
  for (const d of p.darts) { d.id = re(d.id, 'd'); d.legA = idMap[d.legA] ?? d.legA; d.legB = idMap[d.legB] ?? d.legB; }
  for (const pl of p.pleats) pl.id = re(pl.id, 'pl');
  for (const n of p.notches) { n.id = re(n.id, 'n'); n.contourId = idMap[n.contourId] ?? n.contourId; n.placement.anchorId = idMap[n.placement.anchorId] ?? n.placement.anchorId; }
  for (const d of p.drills) d.id = re(d.id, 'dr');
  for (const t of p.texts) t.id = re(t.id, 't');
  for (const a of p.artwork) a.id = re(a.id, 'aw');
  for (const k of p.connections) {
    k.internalContourId = idMap[k.internalContourId] ?? k.internalContourId;
    k.internalAnchorId = idMap[k.internalAnchorId] ?? k.internalAnchorId;
    k.externalAnchorId = idMap[k.externalAnchorId] ?? k.externalAnchorId;
  }
  return { piece: p, idMap };
}

export function piecesOfTable(style: Style, tableId: Id, includeArchive = true): Piece[] {
  const all = includeArchive ? [...style.pieces, ...style.pieceArchive] : style.pieces;
  return all.filter(p => p.sizeTableId === tableId);
}
