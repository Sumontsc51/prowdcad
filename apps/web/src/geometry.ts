/**
 * UI-side geometry helpers: piece layout transforms (local ⇄ world), resolution of preview
 * clones, size colours and hit-testing. Uses only the kernel foundation API.
 */
import {
  resolveContour, computeCutLine, absoluteOffset, absoluteToIncremental, incrementalToAbsolute,
  pointInPolygon, closestPoint, bbox, boxUnion,
  type Document, type Piece, type SizeId, type Vec, type Box, type ResolvedPiece, type Anchor, type SizeLine, type Contour,
} from '@prowdcad/kernel';

export interface Layout { x: number; y: number; angleDeg: number }
export const layoutOf = (p: Piece): Layout => p.layout ?? { x: 0, y: 0, angleDeg: 0 };

export function toWorldL(L: Layout, v: Vec): Vec {
  if (!L.angleDeg) return { x: v.x + L.x, y: v.y + L.y };
  const r = L.angleDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: v.x * c - v.y * s + L.x, y: v.x * s + v.y * c + L.y };
}
export function toLocalL(L: Layout, w: Vec): Vec {
  const x = w.x - L.x, y = w.y - L.y;
  if (!L.angleDeg) return { x, y };
  const r = -L.angleDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: x * c - y * s, y: x * s + y * c };
}
export const toWorld = (p: Piece, v: Vec) => toWorldL(layoutOf(p), v);
export const toLocal = (p: Piece, w: Vec) => toLocalL(layoutOf(p), w);
/** rotate a direction vector local → world (no translation) */
export function dirToWorld(p: Piece, v: Vec): Vec { const L = layoutOf(p); return toWorldL({ x: 0, y: 0, angleDeg: L.angleDeg }, v); }
export function dirToLocal(p: Piece, v: Vec): Vec { const L = layoutOf(p); return toLocalL({ x: 0, y: 0, angleDeg: L.angleDeg }, v); }

/**
 * Resolve a piece for a size. Live pieces use the document cache; preview clones (during drags)
 * are resolved directly with the same foundation functions Document.resolvePiece uses.
 */
export function resolveFor(doc: Document, piece: Piece, sizeId: SizeId): ResolvedPiece {
  if (doc.style.pieces.includes(piece)) return doc.resolvePiece(piece.id, sizeId);
  const line = doc.sizeLine(piece);
  const sew = resolveContour(piece.sew, line, sizeId);
  const cut = piece.cutMode === 'manual' && piece.manualCut ? resolveContour(piece.manualCut, line, sizeId).pts : computeCutLine(piece, line, sizeId);
  const internals = piece.internals.map(c => resolveContour(c, line, sizeId));
  const ga = absoluteOffset(piece.grain.gradeA, line, sizeId), gb = absoluteOffset(piece.grain.gradeB, line, sizeId);
  return { pieceId: piece.id, sizeId, sew, cut, internals, grain: { a: { x: piece.grain.a.x + ga.x, y: piece.grain.a.y + ga.y }, b: { x: piece.grain.b.x + gb.x, y: piece.grain.b.y + gb.y } } };
}

/** Size valid for this piece (falls back to the base size when the piece lacks it). */
export function sizeFor(doc: Document, piece: Piece, sizeId: SizeId): SizeId {
  const sizes = doc.sizesOf(piece);
  return sizes.includes(sizeId) ? sizeId : doc.baseSize(piece);
}

export const SIZE_PALETTE = ['#d62728', '#ff7f0e', '#2ca02c', '#1f77b4', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f', '#393b79', '#637939'];
export function sizeColor(line: SizeLine, sizeId: SizeId): string {
  const i = line.sizes.findIndex(s => s.id === sizeId);
  const def = line.sizes[i];
  if (def?.color) return def.color;
  if (sizeId === line.baseSizeId) return '#111111';
  return SIZE_PALETTE[(i < 0 ? 0 : i) % SIZE_PALETTE.length];
}

/** World-space bbox of a piece's cut line for a size. */
export function pieceWorldBox(doc: Document, piece: Piece, sizeId: SizeId): Box {
  const r = resolveFor(doc, piece, sizeId);
  const pts = (r.cut.length ? r.cut : r.sew.pts).map(p => toWorld(piece, p));
  return bbox(pts.length ? pts : [{ x: 0, y: 0 }]);
}
export function allPiecesBox(doc: Document, sizeId: SizeId, ids?: string[]): Box | null {
  let b: Box | null = null;
  for (const p of doc.style.pieces) {
    if (ids && !ids.includes(p.id)) continue;
    const pb = pieceWorldBox(doc, p, sizeFor(doc, p, sizeId));
    if (!Number.isFinite(pb.minX)) continue;
    b = b ? boxUnion(b, pb) : pb;
  }
  return b;
}

/** Topmost piece whose cut (or sew) polygon contains the world point. */
export function pieceAtWorld(doc: Document, w: Vec, sizeId: SizeId, hidden?: Set<string>): Piece | null {
  const ps = doc.style.pieces;
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    if (hidden?.has(p.id)) continue;
    const r = resolveFor(doc, p, sizeFor(doc, p, sizeId));
    const l = toLocal(p, w);
    if (pointInPolygon(l, r.cut.length > 2 ? r.cut : r.sew.pts) || pointInPolygon(l, r.sew.pts)) return p;
  }
  return null;
}

/** Closest point on a resolved contour polyline (local coords) incl. closing edge. */
export function closestOnContour(pts: Vec[], closed: boolean, q: Vec) {
  return closestPoint(closed && pts.length > 1 ? [...pts, pts[0]] : pts, q);
}

/** Every contour of a piece (sew first). */
export function contoursOf(p: Piece): Contour[] { return [p.sew, ...p.internals]; }
export function contourById(p: Piece, id: string): Contour | undefined {
  if (p.sew.id === id) return p.sew;
  return p.internals.find(c => c.id === id) ?? (p.manualCut?.id === id ? p.manualCut : undefined);
}

/** Set the ABSOLUTE grade offset of an anchor for one size (local frame), keeping the incremental convention. */
export function setAbsGrade(anc: Anchor | { grade: Anchor['grade']; gradeAxisDeg?: number }, line: SizeLine, sizeId: SizeId, d: Vec) {
  let v = d;
  const ax = (anc as Anchor).gradeAxisDeg;
  if (ax) { const r = -ax * Math.PI / 180; v = { x: d.x * Math.cos(r) - d.y * Math.sin(r), y: d.x * Math.sin(r) + d.y * Math.cos(r) }; }
  const abs = incrementalToAbsolute(anc.grade ?? {}, line);
  abs[sizeId] = { dx: v.x, dy: v.y };
  anc.grade = absoluteToIncremental(abs, line);
}

/** Set one axis of the stored (grade-axis frame) absolute offset of an anchor for one size. */
export function setAbsGradeRaw(anc: { grade: Anchor['grade'] }, line: SizeLine, sizeId: SizeId, axis: 'x' | 'y', v: number) {
  const abs = incrementalToAbsolute(anc.grade ?? {}, line);
  const cur = abs[sizeId] ?? { dx: 0, dy: 0 };
  abs[sizeId] = axis === 'x' ? { dx: v, dy: cur.dy } : { dx: cur.dx, dy: v };
  anc.grade = absoluteToIncremental(abs, line);
}

/** Constrain `to` relative to `from` to H / V / 45° steps. */
export function constrain45(from: Vec, to: Vec): Vec {
  const dx = to.x - from.x, dy = to.y - from.y;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const l = Math.hypot(dx, dy);
  // project (keeps the cursor's distance along the snapped direction)
  const ux = Math.cos(a), uy = Math.sin(a);
  const t = Math.abs(ux) > 1e-9 && Math.abs(uy) > 1e-9 ? l : dx * ux + dy * uy;
  return { x: from.x + ux * t, y: from.y + uy * t };
}

/** Outward unit normal of a resolved closed contour at sample index i (winding-agnostic). */
export function outwardNormal(pts: Vec[], i: number, ccw: boolean): Vec {
  const n = pts.length;
  const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
  let tx = b.x - a.x, ty = b.y - a.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
  return ccw ? { x: ty, y: -tx } : { x: -ty, y: tx };
}

export function deepClone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
