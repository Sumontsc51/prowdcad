/**
 * Extra screen-space overlay layers drawn after render.ts → renderOverlay (registered by feature
 * modules, e.g. the rule badges of grading). Each returns SVG markup in SCREEN coordinates; they
 * are wrapped in a pointer-events:none group so they never steal canvas hits.
 */
import type { App } from '../app';

type Overlay = (app: App) => string;
const layers: { id: string; fn: Overlay }[] = [];

export function registerOverlay(id: string, fn: Overlay) {
  const i = layers.findIndex(l => l.id === id);
  if (i >= 0) layers[i].fn = fn; else layers.push({ id, fn });
}

export function extraOverlays(app: App): string {
  let s = '';
  for (const l of layers) { try { s += l.fn(app); } catch (err) { console.error('overlay ' + l.id, err); } }
  return s ? `<g class="xo" pointer-events="none">${s}</g>` : '';
}
