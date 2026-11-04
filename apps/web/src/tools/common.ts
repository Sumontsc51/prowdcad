/** Shared tool helpers: draft-curve preview, outline snapping, screen-space SVG snippets. */
import { resolveContour, makeContour, type Anchor, type Vec, type Piece } from '@prowdcad/kernel';
import type { App } from '../app';
import { resolveFor, toWorld, toLocal, closestOnContour } from '../geometry';

export const fs = (n: number) => (Math.round(n * 10) / 10).toString();

/** Screen-space polyline of an anchor list (kernel curve rules), anchors given in `frame` coords. */
export function draftScreenPath(app: App, anchors: Anchor[], closed: boolean, frame?: Piece): string {
  if (anchors.length < 1) return '';
  const line = app.sizeLine();
  const c = makeContour(anchors, { closed, type: 'internal' });
  const r = resolveContour(c, line, line.baseSizeId);
  const pts = r.pts.map(p => app.view.toScreen(frame ? toWorld(frame, p) : p));
  if (!pts.length) return '';
  let d = `M${fs(pts[0].x)} ${fs(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += `L${fs(pts[i].x)} ${fs(pts[i].y)}`;
  return closed ? d + 'Z' : d;
}

export function screenMarker(s: Vec, kind: 'square' | 'circle' | 'ring' | 'cross', color = '#4ea1ff', size = 4): string {
  switch (kind) {
    case 'square': return `<rect x="${fs(s.x - size)}" y="${fs(s.y - size)}" width="${size * 2}" height="${size * 2}" fill="#fff" stroke="${color}" stroke-width="1.4"/>`;
    case 'circle': return `<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="${size}" fill="#fff" stroke="${color}" stroke-width="1.4"/>`;
    case 'ring': return `<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="${size}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
    case 'cross': return `<path d="M${fs(s.x - size)} ${fs(s.y)}H${fs(s.x + size)}M${fs(s.x)} ${fs(s.y - size)}V${fs(s.y + size)}" stroke="${color}" stroke-width="1.2"/>`;
  }
}

/** Snap to a piece's sew outline (active size) within tolPx; returns world + local point. */
export function snapOutline(app: App, piece: Piece, w: Vec, tolPx = 10): { world: Vec; local: Vec; d: number } | null {
  const r = resolveFor(app.doc, piece, app.sizeOf(piece));
  const l = toLocal(piece, w);
  const cp = closestOnContour(r.sew.pts, r.sew.closed, l);
  const world = toWorld(piece, cp.pt);
  const dpx = Math.hypot(world.x - w.x, world.y - w.y) * app.view.scale;
  return dpx <= tolPx ? { world, local: cp.pt, d: dpx } : null;
}

/** Snap to the anchors of one piece (active size) within tolPx. */
export function snapPieceAnchor(app: App, piece: Piece, w: Vec, tolPx = 8, extra: Vec[] = []): { world: Vec; local: Vec } | null {
  const r = resolveFor(app.doc, piece, app.sizeOf(piece));
  let best: Vec | null = null, bd = tolPx / app.view.scale;
  const cand = [...r.sew.anchorPos, ...r.internals.flatMap(i => i.anchorPos), ...extra];
  for (const q of cand) {
    const qw = toWorld(piece, q);
    const d = Math.hypot(qw.x - w.x, qw.y - w.y);
    if (d < bd) { bd = d; best = qw; }
  }
  return best ? { world: best, local: toLocal(piece, best) } : null;
}

/** Drop consecutive points closer than minPx (screen) — removes double-click / close-click phantoms. */
export function dropPhantoms(app: App, pts: Anchor[], closed: boolean, minPx = 6, frame?: Piece): Anchor[] {
  const tol = minPx / app.view.scale;
  const w = (a: Anchor) => (frame ? toWorld(frame, a) : a);
  const out: Anchor[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(w(p).x - w(last).x, w(p).y - w(last).y) < tol) {
      // keep the richer of the two (handles / curve)
      if ((p.hIn || p.hOut) && !(last.hIn || last.hOut)) out[out.length - 1] = { ...p, id: last.id };
      continue;
    }
    out.push(p);
  }
  if (closed) while (out.length > 2 && Math.hypot(w(out[0]).x - w(out[out.length - 1]).x, w(out[0]).y - w(out[out.length - 1]).y) < tol) out.pop();
  return out;
}

/** Reflect an anchor (position + relative handles) across the line through a with direction d. */
export function reflectAnchor(a: Anchor, p0: Vec, d: Vec, newIdFn: () => string): Anchor {
  const l = Math.hypot(d.x, d.y) || 1; const ux = d.x / l, uy = d.y / l;
  const refP = (p: Vec): Vec => { const vx = p.x - p0.x, vy = p.y - p0.y; const t = vx * ux + vy * uy; return { x: p0.x + 2 * t * ux - vx, y: p0.y + 2 * t * uy - vy }; };
  const refV = (v: Vec): Vec => { const t = v.x * ux + v.y * uy; return { x: 2 * t * ux - v.x, y: 2 * t * uy - v.y }; };
  const q = refP(a);
  return { ...a, id: newIdFn(), x: q.x, y: q.y, hIn: a.hIn ? refV(a.hIn) : undefined, hOut: a.hOut ? refV(a.hOut) : undefined, grade: {}, flags: {} };
}
