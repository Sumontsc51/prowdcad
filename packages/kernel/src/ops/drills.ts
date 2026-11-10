/**
 * Drills / buttons / buttonholes (A6): placement, duplicate-with-offset, multi-buttons between two
 * graded references, and distribution of slits / notches / buttons / lines along a contour segment.
 *
 * Grading of every generated element is stored as incremental per-size offsets (axis1) computed from
 * each size's own reference geometry, so generated elements track the pattern in all sizes.
 */
import type { Drill, GradeInc, Id, Notch, NotchType, Piece, SizeId, SizeLine, Contour } from '../model/types';
import type { Document } from '../model/doc';
import { absoluteOffset, absoluteToIncremental, resolveContour } from '../model/contour';
import { newId, makeAnchor, makeContour } from '../model/factory';
import { Vec, add, mul, lerp } from '../geom/vec';
import { anchorArcS, arcPoint, forwardDist, contourLength, outwardNormal, contourCCW } from '../geom/notch-geom';
import { livePiece, notchContour, makeNotch } from './notches';

type GradeMap = Record<SizeId, GradeInc>;
const cloneGrade = (g: GradeMap | undefined): GradeMap => JSON.parse(JSON.stringify(g ?? {}));

/** Drill centre for a size. */
export function drillPosition(doc: Document, piece: Piece, drill: Drill, sizeId?: SizeId): Vec {
  const line = doc.sizeLine(livePiece(doc, piece));
  const o = absoluteOffset(drill.grade, line, sizeId ?? line.baseSizeId);
  return { x: drill.x + o.x, y: drill.y + o.y };
}

export interface AddDrillOptions {
  x: number; y: number;
  diameter?: number;
  kind?: Drill['kind'];
  mode?: Drill['mode'];
  grade?: GradeMap;
  name?: string;
}

const DEFAULT_DIAMETER: Record<Drill['kind'], number> = { drill: 3, button: 15, buttonhole: 18 };

export function makeDrill(o: AddDrillOptions): Drill {
  const kind = o.kind ?? 'drill';
  const d: Drill = {
    id: newId('d'), x: o.x, y: o.y, grade: cloneGrade(o.grade), diameter: o.diameter ?? DEFAULT_DIAMETER[kind], kind,
    mode: o.mode ?? (kind === 'drill' ? 'cut' : 'draw'),
  };
  if (o.name) d.name = o.name;
  return d;
}

export function addDrill(doc: Document, piece: Piece, o: AddDrillOptions): Drill {
  return doc.transact('Add drill', () => { const d = makeDrill(o); livePiece(doc, piece).drills.push(d); return d; });
}

function findDrill(p: Piece, id: Id): Drill {
  const d = p.drills.find(d => d.id === id); if (!d) throw new Error('No drill ' + id); return d;
}

export function updateDrill(doc: Document, piece: Piece, drillId: Id, patch: Partial<Pick<Drill, 'x' | 'y' | 'diameter' | 'kind' | 'mode' | 'name'>>): Drill {
  return doc.transact('Edit drill', () => Object.assign(findDrill(livePiece(doc, piece), drillId), patch));
}

export function moveDrill(doc: Document, piece: Piece, drillId: Id, dx: number, dy: number): Drill {
  return doc.transact('Move drill', () => { const d = findDrill(livePiece(doc, piece), drillId); d.x += dx; d.y += dy; return d; });
}

export function deleteDrill(doc: Document, piece: Piece, drillId: Id): void {
  doc.transact('Delete drill', () => { const p = livePiece(doc, piece); p.drills = p.drills.filter(d => d.id !== drillId); });
}

/** n copies of a drill at cumulative offsets (k·dx, k·dy), k = 1..n, graded identically to the source. */
export function duplicateWithOffset(doc: Document, piece: Piece, drillId: Id, n: number, dx: number, dy: number): Drill[] {
  return doc.transact('Duplicate drill', () => {
    const p = livePiece(doc, piece);
    const src = findDrill(p, drillId);
    const out: Drill[] = [];
    for (let k = 1; k <= n; k++) {
      const c: Drill = { ...JSON.parse(JSON.stringify(src)), id: newId('d'), x: src.x + k * dx, y: src.y + k * dy };
      p.drills.push(c); out.push(c);
    }
    return out;
  });
}

/** Reference point: an anchor (any contour of the piece), an existing drill, or a coordinate (optionally graded). */
export type RefPoint = { anchorId: Id } | { drillId: Id } | { x: number; y: number; grade?: GradeMap };

/** Position of a reference for a size. */
export function refPosition(doc: Document, piece: Piece, ref: RefPoint, sizeId: SizeId): Vec {
  const p = livePiece(doc, piece);
  const line = doc.sizeLine(p);
  if ('anchorId' in ref) {
    const f = doc.findAnchor(p, ref.anchorId);
    if (!f) throw new Error('No anchor ' + ref.anchorId);
    return resolveContour(f.contour, line, sizeId).anchorPos[f.index];
  }
  if ('drillId' in ref) return drillPosition(doc, p, findDrill(p, ref.drillId), sizeId);
  const o = absoluteOffset(ref.grade, line, sizeId);
  return { x: ref.x + o.x, y: ref.y + o.y };
}

/** Build base coords + incremental grading from a per-size position function. */
export function gradedFromPositions(line: SizeLine, posOf: (sizeId: SizeId) => Vec): { x: number; y: number; grade: GradeMap } {
  const base = posOf(line.baseSizeId);
  const abs: GradeMap = {};
  for (const s of line.sizes) { const q = posOf(s.id); abs[s.id] = { dx: q.x - base.x, dy: q.y - base.y }; }
  return { x: base.x, y: base.y, grade: absoluteToIncremental(abs, line) };
}

export interface MultiButtonOptions {
  from: RefPoint;
  to: RefPoint;
  count: number;
  /** inclusive: first/last element on the references; exclusive: count elements strictly between them (equal gaps) */
  ends?: 'inclusive' | 'exclusive';
  diameter?: number;
  kind?: Drill['kind'];
  mode?: Drill['mode'];
  name?: string;
}

/** Parameters t∈[0,1] of `count` evenly distributed elements. */
export function distributionParams(count: number, ends: 'inclusive' | 'exclusive'): number[] {
  if (count <= 0) return [];
  if (ends === 'inclusive') return count === 1 ? [0.5] : Array.from({ length: count }, (_, i) => i / (count - 1));
  return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1));
}

/** Multi Buttons: N elements distributed on the straight line between two references, graded by interpolating the references' grading. */
export function multiButtons(doc: Document, piece: Piece, o: MultiButtonOptions): Drill[] {
  return doc.transact('Multi buttons', () => {
    const p = livePiece(doc, piece);
    const line = doc.sizeLine(p);
    const posA: Record<SizeId, Vec> = {}, posB: Record<SizeId, Vec> = {};
    for (const s of line.sizes) { posA[s.id] = refPosition(doc, p, o.from, s.id); posB[s.id] = refPosition(doc, p, o.to, s.id); }
    const out: Drill[] = [];
    distributionParams(o.count, o.ends ?? 'inclusive').forEach((t, i) => {
      const g = gradedFromPositions(line, sid => lerp(posA[sid], posB[sid], t));
      const d = makeDrill({ x: g.x, y: g.y, grade: g.grade, diameter: o.diameter, kind: o.kind ?? 'button', mode: o.mode, name: o.name ? `${o.name}${i + 1}` : undefined });
      p.drills.push(d); out.push(d);
    });
    return out;
  });
}

// ───────────────────────── slit contour segment ─────────────────────────

export interface SlitSegmentOptions {
  contourId?: Id;
  fromAnchorId: Id;
  toAnchorId: Id;
  element: 'slit' | 'notch' | 'button' | 'drill' | 'line';
  /** equal spacing: number of elements */
  count?: number;
  ends?: 'inclusive' | 'exclusive';
  /** manual: base-size distances from the segment start (mm); overrides count */
  distances?: number[];
  /** proportional: positions keep their fraction of the segment in every size; fixedFromStart: same mm from start in every size */
  grading?: 'proportional' | 'fixedFromStart';
  /** buttons/drills/slits/lines: distance inward from the contour (mm, along −outward normal) */
  inset?: number;
  /** slit/line length (mm), measured inward from the inset point */
  length?: number;
  diameter?: number;
  notchType?: NotchType;
  mode?: 'draw' | 'cut';
}

export interface SlitSegmentResult { notches: Notch[]; drills: Drill[]; lines: Contour[] }

/**
 * Distribute elements along the forward span fromAnchor → toAnchor. Notches become live floating
 * notches (proportional with spanEndAnchorId = toAnchor, or fromPrev with constant distance), so they
 * self-relocate when the segment changes; buttons/drills/slit lines are graded from each size's span.
 */
export function slitContourSegment(doc: Document, piece: Piece, o: SlitSegmentOptions): SlitSegmentResult {
  return doc.transact('Slit contour segment', () => {
    const p = livePiece(doc, piece);
    const line = doc.sizeLine(p);
    const contour = notchContour(p, o.contourId ?? p.sew.id);
    const ia = doc.anchorIndex(contour, o.fromAnchorId), ib = doc.anchorIndex(contour, o.toAnchorId);
    const grading = o.grading ?? 'proportional';
    const R: Record<SizeId, ReturnType<typeof resolveContour>> = {};
    const span: Record<SizeId, { s0: number; L: number }> = {};
    for (const s of line.sizes) {
      const r = resolveContour(contour, line, s.id);
      const s0 = anchorArcS(r, ia);
      let L = r.closed ? forwardDist(r, s0, anchorArcS(r, ib)) : anchorArcS(r, ib) - s0;
      if (r.closed && ia === ib) L = contourLength(r);
      R[s.id] = r; span[s.id] = { s0, L };
    }
    const Lb = span[line.baseSizeId].L;
    const baseD = o.distances ? o.distances.slice() : distributionParams(o.count ?? 0, o.ends ?? 'inclusive').map(t => t * Lb);
    const distIn = (d: number, sid: SizeId) => grading === 'proportional' ? (Lb > 0 ? (d / Lb) * span[sid].L : 0) : d;
    const frame = (d: number, sid: SizeId) => {
      const r = R[sid];
      const ap = arcPoint(r, span[sid].s0 + distIn(d, sid));
      return { pt: ap.pt, inward: mul(outwardNormal(ap.tangent, contourCCW(r)), -1) };
    };
    const res: SlitSegmentResult = { notches: [], drills: [], lines: [] };
    const inset = o.inset ?? 0;
    for (const d of baseD) {
      if (o.element === 'notch') {
        const placement = grading === 'proportional'
          ? { kind: 'proportional' as const, anchorId: o.fromAnchorId, pct: Lb > 0 ? (d / Lb) * 100 : 0 }
          : { kind: 'fromPrev' as const, anchorId: o.fromAnchorId, dist: Object.fromEntries(line.sizes.map(s => [s.id, d])) };
        const n = makeNotch(doc, p, { contourId: contour.id, placement, type: o.notchType ?? 'slit', mode: o.mode, source: 'slit',
          spanEndAnchorId: grading === 'proportional' ? o.toAnchorId : undefined });
        p.notches.push(n); res.notches.push(n);
      } else if (o.element === 'button' || o.element === 'drill') {
        const g = gradedFromPositions(line, sid => { const f = frame(d, sid); return add(f.pt, mul(f.inward, inset)); });
        const dr = makeDrill({ x: g.x, y: g.y, grade: g.grade, kind: o.element === 'button' ? 'button' : 'drill', diameter: o.diameter, mode: o.mode });
        p.drills.push(dr); res.drills.push(dr);
      } else {
        const Ls = o.length ?? 10;
        const a = gradedFromPositions(line, sid => { const f = frame(d, sid); return add(f.pt, mul(f.inward, inset)); });
        const b = gradedFromPositions(line, sid => { const f = frame(d, sid); return add(f.pt, mul(f.inward, inset + Ls)); });
        const c = makeContour([
          makeAnchor(a.x, a.y, { grade: a.grade }), makeAnchor(b.x, b.y, { grade: b.grade }),
        ], { type: 'internal', closed: false, mode: o.mode ?? (o.element === 'slit' ? 'cut' : 'draw'), name: o.element === 'slit' ? 'SLIT' : undefined });
        p.internals.push(c); res.lines.push(c);
      }
    }
    return res;
  });
}

