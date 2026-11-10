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
