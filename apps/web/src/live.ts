/**
 * Live objects (darts / pleats / fullness) on the UI side: per-size display geometry, hit-testing,
 * contour-position conversion and the live-object selection.
 *
 * Geometry comes from the kernel: darts from `dartSewGeometry` (legs, apex, drill, axis), pleats
 * from the graded axis ends + the open-state edge anchors, fullness from the slash / hinge anchors
 * of each record. Everything is piece-local; callers transform with toWorld.
 */
import { absoluteOffset, closestPoint, type Piece, type SizeId, type Vec, type Id, type Pleat, type PleatType, type Fullness } from '@prowdcad/kernel';
import type { App } from './app';
import { ops, type LiveContourPos } from './ops-bridge';
import { resolveFor, toWorld, toLocal } from './geometry';
import type { ContourHit } from './hitkit';

export type LiveKind = 'dart' | 'pleat' | 'fullness';
export interface LiveRef { kind: LiveKind; pieceId: Id; id: Id }

export interface DartShape {
  kind: 'dart'; id: Id; closed: boolean; cutting: boolean;
  legA: Vec[]; legB: Vec[]; apex: Vec; mid: Vec; drill: Vec; width: number; depth: number; fold: 'A' | 'B';
}
export interface PleatShape {
  kind: 'pleat'; id: Id; open: boolean; type: PleatType;
  axis: [Vec, Vec];
  /** open: fixed edge (start → end crossing), moving edge, fold lines and the inserted-fabric polygon */
  fixed?: [Vec, Vec]; moving?: [Vec, Vec]; folds: Vec[][]; shade?: Vec[];
  /** closed: short fold-direction ticks at the axis ends (length = depth) */
  ticks: Vec[][];
  /** fold-direction arrows [from, to] (piece-local): knife = toward the fold side; box = away from the centre; inverted = toward the centre */
  arrows: [Vec, Vec][];
}
export interface FullnessShape { kind: 'fullness'; id: Id; slashes: Vec[][]; wedges: Vec[][] }
export type LiveShape = DartShape | PleatShape | FullnessShape;

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const nrm = (a: Vec): Vec => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };

function gradedPt(p: { x: number; y: number; grade: Pleat['axisStart']['grade'] }, line: ReturnType<App['sizeLine']>, sid: SizeId): Vec {
  const o = absoluteOffset(p.grade, line, sid);
  return { x: p.x + o.x, y: p.y + o.y };
}

/** Display geometry of every live object of a piece for one size (piece-local). */
export function liveShapes(app: App, piece: Piece, sid: SizeId): LiveShape[] {
  const out: LiveShape[] = [];
  const line = app.doc.sizeLine(piece);
  if (!piece.darts.length && !piece.pleats.length && !(piece.fullness ?? []).length) return out;
  let r; try { r = resolveFor(app.doc, piece, sid); } catch { return out; }
  const at = (id: Id): Vec | null => { const i = piece.sew.points.findIndex(a => a.id === id); return i >= 0 ? r.sew.anchorPos[i] : null; };
  if (piece.darts.length) {
    let g: ReturnType<typeof ops.dartSewGeometry> = [];
    try { g = ops.dartSewGeometry(piece, line, sid); } catch { /* ignore */ }
    for (const d of g) {
      const dm = piece.darts.find(x => x.id === d.dartId);
      out.push({ kind: 'dart', id: d.dartId, closed: d.closed, cutting: !!dm?.cutting, legA: d.legA, legB: d.legB, apex: d.apex, mid: d.mid, drill: d.drill, width: d.width, depth: d.depth, fold: d.fold });
    }
  }
  for (const p of piece.pleats) {
    const A = gradedPt(p.axisStart, line, sid), B = gradedPt(p.axisEnd, line, sid);
    const sh: PleatShape = { kind: 'pleat', id: p.id, open: p.open, type: p.type, axis: [A, B], folds: [], ticks: [], arrows: [] };
    if (p.open && p.edges?.length === 2) {
      const f0 = at(p.edges[0].fixed), m0 = at(p.edges[0].moving), f1 = at(p.edges[1].fixed), m1 = at(p.edges[1].moving);
      if (f0 && m0 && f1 && m1) {
        sh.fixed = [f0, f1]; sh.moving = [m0, m1]; sh.shade = [f0, m0, m1, f1];
        // knife: one fold at the middle of the inserted fabric (depth out + depth back); box: folds at ¼ and ¾, centre at ½
        const ts = p.type === 'knife' ? [0.5] : [0.25, 0.5, 0.75];
        for (const t of ts) sh.folds.push([lerp(f0, m0, t), lerp(f1, m1, t)]);
        // arrows across the inserted fabric near the start crossing
        const c0 = lerp(lerp(f0, m0, 0.5), lerp(f1, m1, 0.5), 0.12), half = mul(sub(m0, f0), 0.5);
        const L = Math.hypot(half.x, half.y);
        if (L > 1e-6) {
          const v = mul(half, 1 / L), k = Math.max(4, Math.min(25, L * 0.9));
          const side = p.fold === 'left' ? 1 : -1;
          const fwdDir = (() => { const ax = nrm(sub(B, A)); return { x: -ax.y * side, y: ax.x * side }; })();
          if (p.type === 'knife') sh.arrows.push([sub(c0, mul(fwdDir, k / 2)), add(c0, mul(fwdDir, k / 2))]);
          else if (p.type === 'box') sh.arrows.push([c0, add(c0, mul(v, k))], [c0, sub(c0, mul(v, k))]);
          else sh.arrows.push([add(c0, mul(v, k)), c0], [sub(c0, mul(v, k)), c0]);
        }
      }
    } else {
      // fold direction ticks: perpendicular to the axis, toward the fold side, length = depth
      const u = nrm(sub(B, A)), left = { x: -u.y, y: u.x };
      const side = p.fold === 'left' ? left : mul(left, -1);
      if (p.depthStart > 0) sh.ticks.push([A, add(A, mul(side, p.depthStart))]);
      if (p.depthEnd > 0) sh.ticks.push([B, add(B, mul(side, p.depthEnd))]);
      const c0 = lerp(A, B, 0.15), k = Math.max(6, Math.min(25, Math.max(p.depthStart, p.depthEnd) * 1.2));
      if (p.type === 'knife') sh.arrows.push([c0, add(c0, mul(side, k))]);
      else if (p.type === 'box') sh.arrows.push([c0, add(c0, mul(left, k))], [c0, sub(c0, mul(left, k))]);
      else sh.arrows.push([add(c0, mul(left, k)), c0], [sub(c0, mul(left, k)), c0]);
    }
    out.push(sh);
  }
  for (const f of piece.fullness ?? []) out.push(fullnessShape(f, at));
  return out;
}

function fullnessShape(f: Fullness, at: (id: Id) => Vec | null): FullnessShape {
  const sh: FullnessShape = { kind: 'fullness', id: f.id, slashes: [], wedges: [] };
  const pivot = 'x' in f.pivot ? { x: f.pivot.x, y: f.pivot.y } : null;
  for (let k = 0; k + 1 < f.slashAnchorIds.length; k += 2) {
    const s0 = at(f.slashAnchorIds[k]), s1 = at(f.slashAnchorIds[k + 1]);
    const h0 = f.hingeIds ? at(f.hingeIds[k]) : null, h1 = f.hingeIds ? at(f.hingeIds[k + 1]) : null;
    if (!s0 || !s1) continue;
    if (pivot) {
      sh.slashes.push([s0, pivot], [s1, pivot]);
      if (h0) sh.slashes.push([pivot, h0]);
      if (h1 && h0 && Math.hypot(h1.x - h0.x, h1.y - h0.y) > 1e-6) sh.slashes.push([pivot, h1]);
      sh.wedges.push([s0, s1, pivot]);
    } else if (h0 && h1) {
      sh.slashes.push([s0, h0], [s1, h1]);
      sh.wedges.push([s0, s1, h1, h0]);
    }
  }
  return sh;
}

/** Polylines that make an object selectable (piece-local). */
export function hitLines(s: LiveShape): Vec[][] {
  switch (s.kind) {
    case 'dart': return s.closed ? [[s.mid, s.apex]] : [s.legA, s.legB, [s.mid, s.apex]];
    case 'pleat': return [s.axis, ...(s.fixed ? [s.fixed] : []), ...(s.moving ? [s.moving] : []), ...s.folds];
    case 'fullness': return s.slashes;
  }
}

export interface LiveHit { ref: LiveRef; piece: Piece; dpx: number; world: Vec }

/** Nearest live object (active size of each visible piece) within tolPx. */
export function liveNear(app: App, w: Vec, o: { kind?: LiveKind; pieceId?: Id; tolPx?: number } = {}): LiveHit | null {
  const tol = o.tolPx ?? 8;
  let best: LiveHit | null = null;
  for (const p of app.doc.style.pieces) {
    if (app.hiddenPieces.has(p.id) || (o.pieceId && p.id !== o.pieceId)) continue;
    const l = toLocal(p, w);
    for (const s of liveShapes(app, p, app.sizeOf(p))) {
      if (o.kind && s.kind !== o.kind) continue;
      for (const pl of hitLines(s)) {
        if (pl.length < 2) continue;
        const cp = closestPoint(pl, l);
        const dpx = cp.d * app.view.scale;
        if (dpx <= tol && (!best || dpx < best.dpx)) best = { ref: { kind: s.kind, pieceId: p.id, id: s.id }, piece: p, dpx, world: toWorld(p, cp.pt) };
      }
    }
  }
  return best;
}

/** Contour hit (sew) → kernel contour position: base-size arc distance forward from the segment's start grade anchor. */
export function contourPos(app: App, h: ContourHit): LiveContourPos {
  const p = h.piece;
  const rb = resolveFor(app.doc, p, app.doc.baseSize(p)).sew;
  const from = h.from ?? p.sew.points.find(a => a.kind === 'grade')?.id ?? p.sew.points[0].id;
  const i = p.sew.points.findIndex(a => a.id === from);
  const s0 = rb.cum[rb.anchorIndex[i]] ?? 0;
  const L = rb.cum[rb.cum.length - 1] ?? 0;
  let d = h.sBase - s0; if (d < 0) d += L; if (L > 0 && d >= L) d -= L;
  return { fromAnchorId: from, distance: d };
}

export function liveExists(app: App, r: LiveRef): boolean {
  const p = app.doc.style.pieces.find(x => x.id === r.pieceId); if (!p) return false;
  return r.kind === 'dart' ? p.darts.some(d => d.id === r.id) : r.kind === 'pleat' ? p.pleats.some(d => d.id === r.id) : (p.fullness ?? []).some(d => d.id === r.id);
}

/** Make `r` the selected live object (its piece becomes the selected piece). */
export function selectLive(app: App, r: LiveRef | null) {
  app.liveSel = r;
  if (r) app.sel = { pieces: [r.pieceId], anchors: [] };
  app.invalidate();
}
