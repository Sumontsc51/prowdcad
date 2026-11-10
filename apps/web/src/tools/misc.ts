/**
 * Zoom (Z):    click = zoom in, Alt-click = zoom out, drag = zoom to rectangle.
 * Hand (H):    drag to pan.
 * (The Measure tool lives in tools/measure.ts.)
 */
import type { Vec } from '@prowdcad/kernel';
import { ICON, type Tool } from './tool';
import { fs } from './common';

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
