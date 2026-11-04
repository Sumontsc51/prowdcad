/**
 * Measure (M): click two points (snaps to anchors/outline) → straight length, dX, dY, angle.
 *              Click a segment (on a sew/internal line, no anchor nearby) with Alt → arc length of that grade segment.
 * Zoom (Z):    click = zoom in, Alt-click = zoom out, drag = zoom to rectangle.
 * Hand (H):    drag to pan.
 */
import { gradeSegment, spanLength, type Vec } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { snapPoint } from '../canvas/snap';
import { resolveFor, toLocal, toWorld, closestOnContour } from '../geometry';
import { fmt, unitLabel } from '../units-ui';
import { snapOutline, screenMarker, fs } from './common';

let A: Vec | null = null;
let B: Vec | null = null;
let hover: Vec | null = null;
let result = '';
let segHighlight: Vec[] | null = null;

function snapAny(app: App, w: Vec): Vec {
  const s = snapPoint(app, w, { noGrid: true });
  if (s.kind === 'anchor') return s.p;
  for (const p of app.pieces()) { const o = snapOutline(app, p, w, 8); if (o) return o.world; }
  return s.p;
}

function describe(a: Vec, b: Vec): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  return `L ${fmt(Math.hypot(dx, dy))} · dX ${fmt(dx)} · dY ${fmt(dy)} ${unitLabel()} · ∠ ${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2)}°`;
}

function measureSegment(app: App, w: Vec): boolean {
  for (const p of app.pieces()) {
    const r = resolveFor(app.doc, p, app.sizeOf(p));
    const l = toLocal(p, w);
    const cs = [r.sew, ...r.internals];
    for (const rc of cs) {
      if (!rc.gradeIdx.length) continue;
      const cp = closestOnContour(rc.pts, rc.closed, l);
      if (cp.d * app.view.scale > 8) continue;
      // find the grade segment containing sample index cp.seg
      const N = rc.pts.length;
      for (let k = 0; k < rc.gradeIdx.length; k++) {
        const [ai, bi] = gradeSegment(rc, k);
        if (!rc.closed && k === rc.gradeIdx.length - 1) break;
        const s = rc.anchorIndex[ai], e = rc.anchorIndex[bi];
        const inSpan = rc.closed ? (s <= e ? cp.seg >= s && cp.seg < e : cp.seg >= s || cp.seg < e) || (s === e) : cp.seg >= s && cp.seg < e;
        if (!inSpan) continue;
        const L = spanLength(rc, ai, bi);
        const pts: Vec[] = []; let i = s, g = 0; do { pts.push(toWorld(p, rc.pts[i])); i = (i + 1) % N; } while (i !== (e + 1) % N && g++ < N + 1);
        segHighlight = pts;
        result = `${p.name} · segment ${k + 1}: ${fmt(L)} ${unitLabel()} (along contour) · chord ${fmt(Math.hypot(rc.anchorPos[bi].x - rc.anchorPos[ai].x, rc.anchorPos[bi].y - rc.anchorPos[ai].y))}`;
        app.status(result);
        return true;
      }
    }
  }
  return false;
}

export const measureTool: Tool = {
  id: 'measure', title: 'Measure', group: 'measure', hotkey: 'M', icon: ICON.measure, cursor: 'crosshair',
  activate() { A = B = hover = null; segHighlight = null; result = ''; },
  deactivate(app) { A = B = hover = null; segHighlight = null; app.invalidate('canvas'); },
  busy: () => !!A && !B,
  hint: () => result || 'Measure: click two points · Alt-click a line = segment length · Esc clear',
  down(app, p) {
    if (p.e.altKey) { A = B = null; if (!measureSegment(app, p.w)) app.status('No segment under cursor'); app.invalidate('canvas'); return; }
    segHighlight = null;
    const q = snapAny(app, p.w);
    if (!A || B) { A = q; B = null; result = ''; }
    else { B = q; result = describe(A, B); app.status(result); }
    app.invalidate('canvas');
  },
  move(app, p) {
    hover = snapAny(app, p.w);
    if (A && !B) app.status(describe(A, hover));
    app.invalidate('canvas');
  },
  key(app, e) { if (e.key === 'Escape' && (A || segHighlight)) { A = B = null; segHighlight = null; result = ''; app.invalidate(); return true; } return false; },
  overlay(app) {
    let s = '';
    if (segHighlight) s += `<path d="M${segHighlight.map(q => { const v = app.view.toScreen(q); return `${fs(v.x)} ${fs(v.y)}`; }).join('L')}" fill="none" stroke="#ff9f1a" stroke-width="3" opacity="0.8"/>`;
    if (hover) s += screenMarker(app.view.toScreen(hover), 'cross', '#ff9f1a', 6);
    if (A) {
      const a = app.view.toScreen(A), b = app.view.toScreen(B ?? hover ?? A);
      s += `<line x1="${fs(a.x)}" y1="${fs(a.y)}" x2="${fs(b.x)}" y2="${fs(b.y)}" stroke="#ff9f1a" stroke-width="1.4"/>` + screenMarker(a, 'circle', '#ff9f1a', 3) + screenMarker(b, 'circle', '#ff9f1a', 3);
      const L = Math.hypot((B ?? hover ?? A).x - A.x, (B ?? hover ?? A).y - A.y);
      s += `<text x="${fs((a.x + b.x) / 2 + 6)}" y="${fs((a.y + b.y) / 2 - 6)}" class="tool-note">${fmt(L)} ${unitLabel()}</text>`;
    }
    return s;
  },
};

let zr: { a: Vec; b: Vec } | null = null;
export const zoomTool: Tool = {
  id: 'zoom', title: 'Zoom', group: 'view', hotkey: 'Z', icon: ICON.zoom, cursor: 'zoom-in',
  deactivate() { zr = null; },
  hint: () => 'Zoom: click = in · Alt-click = out · drag = zoom to box',
  down(_app, p) { zr = { a: p.s, b: p.s }; },
  move(app, p) { if (zr) { zr.b = p.s; app.invalidate('canvas'); } },
  up(app, p) {
    const z = zr; zr = null; if (!z) return;
    const w = Math.abs(z.b.x - z.a.x), h = Math.abs(z.b.y - z.a.y);
    if (w < 5 && h < 5) app.view.zoomAt(p.s, p.e.altKey ? 1 / 1.6 : 1.6);
    else {
      const a = app.view.toWorld(z.a), b = app.view.toWorld(z.b);
      app.view.fit({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }, 0);
    }
    app.invalidate('canvas', 'status');
  },
  overlay() { if (!zr) return ''; return `<rect x="${fs(Math.min(zr.a.x, zr.b.x))}" y="${fs(Math.min(zr.a.y, zr.b.y))}" width="${fs(Math.abs(zr.a.x - zr.b.x))}" height="${fs(Math.abs(zr.a.y - zr.b.y))}" fill="none" stroke="#4ea1ff" stroke-dasharray="4 3"/>`; },
};

/** Hand: panning itself is implemented by the canvas controller when this tool is active. */
export const handTool: Tool = {
  id: 'hand', title: 'Hand (pan)', group: 'view', hotkey: 'H', icon: ICON.hand, cursor: 'grab',
  hint: () => 'Hand: drag to pan · Space+drag pans from any tool · middle-drag pans',
};
