/**
 * Geometric hit-testing used by tools and canvas picks (independent of the SVG hit targets, so
 * it works for unselected pieces and hidden anchors too). All tolerances are screen px.
 */
import {
  closestPoint, resolveContour, segmentIndexAt, arcPolyline,
  type Piece, type Contour, type Vec, type ResolvedContour, type Anchor, type Drill, type Id,
} from '@prowdcad/kernel';
import type { App } from './app';
import type { AnchorRef } from './ops-bridge';
import { resolveFor, toWorld, toLocal, pieceAtWorld, type ShownContour } from './geometry';
import { ops } from './ops-bridge';

export interface AnchorHit { piece: Piece; contour: Contour; index: number; anchor: Anchor; world: Vec; local: Vec; ref: AnchorRef; dpx: number }
export interface ContourHit {
  piece: Piece; contour: Contour; rc: ResolvedContour;
  /** closest point (piece-local / world) on the active-size contour */
  local: Vec; world: Vec;
  /** arc position on the active-size contour, and the equivalent base-size arc position */
  s: number; sBase: number;
  dpx: number;
  /** grade segment index containing s (−1 when the contour has no grade anchors) */
  k: number;
  /** grade segment end anchor ids (undefined for an open contour's tail) */
  from?: Id; to?: Id;
}
export type ContourFilter = 'sew' | 'internal' | 'any';

export interface HitOpts { tolPx?: number; gradeOnly?: boolean; contour?: ContourFilter; pieceId?: Id; contourId?: Id; excludePieceId?: Id }

function contoursOf(p: Piece, f: ContourFilter = 'any'): { c: Contour; ci: number }[] {
  const all = [{ c: p.sew, ci: -1 }, ...p.internals.map((c, ci) => ({ c, ci }))];
  return f === 'sew' ? all.slice(0, 1) : f === 'internal' ? all.slice(1) : all;
}

function visiblePieces(app: App, o: HitOpts): Piece[] {
  return app.doc.style.pieces.filter(p => !app.hiddenPieces.has(p.id) && (!o.pieceId || p.id === o.pieceId) && p.id !== o.excludePieceId);
}

export function anchorNear(app: App, w: Vec, o: HitOpts = {}): AnchorHit | null {
  const tol = o.tolPx ?? 9;
  let best: AnchorHit | null = null;
  for (const p of visiblePieces(app, o)) {
    const r = resolveFor(app.doc, p, app.sizeOf(p));
    for (const { c, ci } of contoursOf(p, o.contour)) {
      if (o.contourId && c.id !== o.contourId) continue;
      const rc = ci < 0 ? r.sew : r.internals[ci]; if (!rc) continue;
      c.points.forEach((a, i) => {
        if (o.gradeOnly && a.kind !== 'grade') return;
        const world = toWorld(p, rc.anchorPos[i]);
        const d = Math.hypot(world.x - w.x, world.y - w.y) * app.view.scale;
        if (d <= tol && (!best || d < best.dpx)) best = { piece: p, contour: c, index: i, anchor: a, world, local: rc.anchorPos[i], ref: { pieceId: p.id, contourId: c.id, anchorId: a.id }, dpx: d };
      });
    }
  }
  return best;
}

/** Grade segment [from, to] anchor ids of segment k. */
export function segmentIds(c: Contour, rc: ResolvedContour, k: number): { from?: Id; to?: Id } {
  const g = rc.gradeIdx; if (k < 0 || !g.length) return {};
  if (!c.closed && k >= g.length - 1) return {};
  const a = g[k], b = c.closed ? g[(k + 1) % g.length] : g[k + 1];
  if (a === undefined || b === undefined || !c.points[a] || !c.points[b]) return {};
  // a live half piece: the stored fold edge is interior once opened (no segment there)
  const fold = (rc as ShownContour).foldAfter;
  if (fold !== undefined && c.closed) { const n = c.points.length; const span = g.length === 1 ? n : (b - a + n) % n; if ((fold - a + n) % n < span) return {}; }
  return { from: c.points[a].id, to: c.points[b].id };
}

export function contourNear(app: App, w: Vec, o: HitOpts = {}): ContourHit | null {
  const tol = o.tolPx ?? 9;
  let best: ContourHit | null = null;
  for (const p of visiblePieces(app, o)) {
    const sid = app.sizeOf(p);
    const r = resolveFor(app.doc, p, sid);
    const l = toLocal(p, w);
    for (const { c, ci } of contoursOf(p, o.contour)) {
      if (o.contourId && c.id !== o.contourId) continue;
      const rc = ci < 0 ? r.sew : r.internals[ci]; if (!rc || rc.pts.length < 2) continue;
      const poly = rc.closed ? [...rc.pts, rc.pts[0]] : rc.pts;
      const cp = closestPoint(poly, l);
      const dpx = cp.d * app.view.scale;
      if (dpx > tol || (best && dpx >= best.dpx)) continue;
      const k = rc.gradeIdx.length ? segmentIndexAt(rc, cp.s) : -1;
      const ids = segmentIds(c, rc, k);
      best = { piece: p, contour: c, rc, local: cp.pt, world: toWorld(p, cp.pt), s: cp.s, sBase: toBaseArc(app, p, c, rc, cp.s, k), dpx, k, ...ids };
    }
  }
  return best;
}

/** Map an arc position of a size onto the base size by its proportional position within the grade segment. */
function toBaseArc(app: App, p: Piece, c: Contour, rc: ResolvedContour, s: number, k: number): number {
  const line = app.doc.sizeLine(p);
  const sid = app.sizeOf(p);
  if (sid === line.baseSizeId) return s;
  const rb = resolveContour(c, line, line.baseSizeId);
  if (k < 0) { const L = rc.cum[rc.cum.length - 1] || 1; return s / L * (rb.cum[rb.cum.length - 1] ?? 0); }
  const g = rc.gradeIdx, n = g.length;
  const a = g[k], b = c.closed ? g[(k + 1) % n] : g[Math.min(k + 1, n - 1)];
  const arc = (r: ResolvedContour, i: number) => r.cum[r.anchorIndex[i]] ?? 0;
  const tot = (r: ResolvedContour) => r.cum[r.cum.length - 1] ?? 0;
  const span = (r: ResolvedContour) => { let d = arc(r, b) - arc(r, a); if (d <= 0 && r.closed) d += tot(r); return d; };
  let off = s - arc(rc, a); if (off < 0 && rc.closed) off += tot(rc);
  const f = span(rc) > 0 ? off / span(rc) : 0;
  let sb = arc(rb, a) + f * span(rb);
  if (rb.closed && sb >= tot(rb)) sb -= tot(rb);
  return sb;
}

export function pieceUnder(app: App, w: Vec): Piece | null {
  return pieceAtWorld(app.doc, w, app.activeSize, app.hiddenPieces) ?? contourNear(app, w, { contour: 'sew' })?.piece ?? null;
}

export interface DrillHit { piece: Piece; drill: Drill; world: Vec; dpx: number }
export function drillNear(app: App, w: Vec, tolPx = 10): DrillHit | null {
  let best: DrillHit | null = null;
  for (const p of app.doc.style.pieces) {
    if (app.hiddenPieces.has(p.id)) continue;
    for (const d of p.drills) {
      let pos: Vec; try { pos = ops.drillPosition(app.doc, p, d, app.sizeOf(p)); } catch { pos = d; }
      const world = toWorld(p, pos);
      const dpx = Math.hypot(world.x - w.x, world.y - w.y) * app.view.scale - Math.max(0, d.diameter / 2 * app.view.scale);
      if (dpx <= tolPx && (!best || dpx < best.dpx)) best = { piece: p, drill: d, world, dpx };
    }
  }
  return best;
}

/** World polyline of a run from → to (forward) on a contour, for the active size. */
export function runWorld(app: App, piece: Piece, contour: Contour, fromId: Id, toId: Id, reverse = false): Vec[] {
  const ci = contour === piece.sew ? -1 : piece.internals.indexOf(contour);
  const r = resolveFor(app.doc, piece, app.sizeOf(piece));
  const rc = ci < 0 ? r.sew : r.internals[ci]; if (!rc) return [];
  const ia = contour.points.findIndex(a => a.id === fromId), ib = contour.points.findIndex(a => a.id === toId);
  if (ia < 0 || ib < 0) return [];
  let poly: Vec[];
  if (ia === ib && rc.closed) poly = [...rc.pts.slice(rc.anchorIndex[ia]), ...rc.pts.slice(0, rc.anchorIndex[ia] + 1)];
  else poly = arcPolyline(rc, ia, ib, reverse);
  return poly.map(q => toWorld(piece, q));
}

/** Screen-space path for a world polyline. */
export function screenPath(app: App, pts: Vec[], closed = false): string {
  if (!pts.length) return '';
  const f = (n: number) => (Math.round(n * 10) / 10).toString();
  let d = '';
  pts.forEach((q, i) => { const s = app.view.toScreen(q); d += `${i ? 'L' : 'M'}${f(s.x)} ${f(s.y)}`; });
  return closed ? d + 'Z' : d;
}

/** Nested view: the size whose outline is under the cursor (nearest within tolPx), with its name. */
export function nestSizeAt(app: App, w: Vec, tolPx = 6): { piece: Piece; sizeId: string; name: string } | null {
  if (!app.nested) return null;
  let best: { piece: Piece; sizeId: string; name: string; d: number } | null = null;
  for (const p of app.doc.style.pieces) {
    if (app.hiddenPieces.has(p.id)) continue;
    const l = toLocal(p, w); const line = app.doc.sizeLine(p);
    for (const sid of app.doc.sizesOf(p)) {
      if (app.nestedHidden.has(sid)) continue;
      let r; try { r = resolveFor(app.doc, p, sid); } catch { continue; }
      const rc = r.sew; if (rc.pts.length < 2) continue;
      const d = closestPoint(rc.closed ? [...rc.pts, rc.pts[0]] : rc.pts, l).d * app.view.scale;
      if (d <= tolPx && (!best || d < best.d)) best = { piece: p, sizeId: sid, name: line.sizes.find(z => z.id === sid)?.name ?? sid, d };
    }
  }
  return best;
}

/** True when the picked line (its middle) is on the folded-over part of a folded piece. */
export function lineFolded(app: App, piece: Piece, contourId: Id, from: Id | undefined, to: Id | undefined): boolean {
  if (!piece.fold) return false;
  const c = piece.sew.id === contourId ? piece.sew : piece.internals.find(x => x.id === contourId); if (!c) return false;
  const r = resolveFor(app.doc, piece, app.doc.baseSize(piece)); const rc = c === piece.sew ? r.sew : r.internals[piece.internals.indexOf(c)]; if (!rc) return false;
  const i = from ? c.points.findIndex(q => q.id === from) : 0, j = to ? c.points.findIndex(q => q.id === to) : c.points.length - 1;
  if (i < 0 || j < 0) return false;
  let a = rc.anchorIndex[i], b = rc.anchorIndex[j]; if (b <= a) b += rc.pts.length;
  return ops.onFoldedPart(piece, rc.pts[((a + b) >> 1) % rc.pts.length]);
}
/**
 * The line under the cursor, also where a fold shows it: a line of the folded-over part of a folded piece is
 * picked on its mirrored (dashed) drawing first, then the lines where they really are.
 */
export function lineNear(app: App, w: Vec, o: HitOpts = {}): ContourHit | null {
  let best: ContourHit | null = null;
  for (const p of app.pieces()) {
    if (!p.fold || app.hiddenPieces.has(p.id) || (o.pieceId && o.pieceId !== p.id)) continue;
    const wm = toWorld(p, ops.foldMirror(p.fold, toLocal(p, w)));
    const h = contourNear(app, wm, { ...o, pieceId: p.id });
    if (h && lineFolded(app, p, h.contour.id, h.from, h.to) && (!best || h.dpx < best.dpx)) best = h;
  }
  return best ?? contourNear(app, w, o);
}
/** A piece-local point of a line → the sheet, where a fold shows it. */
export function lineWorld(piece: Piece, folded: boolean, q: Vec): Vec { return toWorld(piece, folded && piece.fold ? ops.foldMirror(piece.fold, q) : q); }

/** The picked line as a polyline on the sheet (base size), where a fold shows it; from the live preview when there is one. */
export function linePolyWorld(app: App, g: { pieceId: Id; contourId: Id; from: Id; to: Id }): Vec[] {
  const dp = app.doc.style.pieces.find(p => p.id === g.pieceId); if (!dp) return [];
  const pc = app.preview.get(g.pieceId) ?? dp;
  const c = pc.sew.id === g.contourId ? pc.sew : pc.internals.find(x => x.id === g.contourId); if (!c) return [];
  let r; try { r = resolveFor(app.doc, pc, app.doc.baseSize(dp)); } catch { return []; }
  const rc = c === pc.sew ? r.sew : r.internals[pc.internals.indexOf(c)]; if (!rc) return [];
  const i = c.points.findIndex(q => q.id === g.from), j = c.points.findIndex(q => q.id === g.to); if (i < 0 || j < 0) return [];
  const a = rc.anchorIndex[i]; let b = rc.anchorIndex[j]; const n = rc.pts.length;
  if (b <= a) { if (!rc.closed) return []; b += n; }
  const folded = lineFolded(app, dp, g.contourId, g.from, g.to);
  const out: Vec[] = [];
  for (let k = a; k <= b; k++) out.push(lineWorld(pc, folded, rc.pts[k % n]));
  return out;
}

// ───────────── working on the folded-over side of a folded piece ─────────────
/** A sheet point seen through the fold of a piece: where the folded-over drawing shows it ⇄ where it really is. */
export function foldWorld(piece: Piece, w: Vec): Vec { return piece.fold ? toWorld(piece, ops.foldMirror(piece.fold, toLocal(piece, w))) : w; }
/** True when this point of the piece (piece-local) is on its folded-over part. */
export function pointFolded(piece: Piece, local: Vec): boolean { return !!piece.fold && ops.onFoldedPart(piece, local); }
/**
 * The folded piece whose folded-over drawing is under the cursor: one of its points (the hit target) or one
 * of its lines within a few px. The tools then get the pointer mapped through the fold, so they work on the
 * real point / line while the user works on the drawing where the fold shows it.
 */
export function foldCtxAt(app: App, w: Vec, hit: { kind: string; pieceId?: string; contourId?: string; anchorId?: string }): string | null {
  if ((hit.kind === 'anchor' || hit.kind === 'handle') && hit.pieceId) {
    const p = app.piece(hit.pieceId); if (!p?.fold) return null;
    const c = p.sew.id === hit.contourId ? p.sew : p.internals.find(x => x.id === hit.contourId); const i = c ? c.points.findIndex(a => a.id === hit.anchorId) : -1;
    if (!c || i < 0) return null;
    const r = resolveFor(app.doc, p, app.sizeOf(p)); const rc = c === p.sew ? r.sew : r.internals[p.internals.indexOf(c)];
    return rc && pointFolded(p, rc.anchorPos[i]) ? p.id : null;
  }
  let best: { id: string; d: number } | null = null;
  for (const p of app.pieces()) {
    if (!p.fold || app.hiddenPieces.has(p.id) || p.locked) continue;
    const h = contourNear(app, foldWorld(p, w), { pieceId: p.id, tolPx: 7 });
    if (h && pointFolded(p, h.local) && (!best || h.dpx < best.d)) best = { id: p.id, d: h.dpx };
  }
  return best ? best.id : null;
}
