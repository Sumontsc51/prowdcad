/** Snapping: anchors (all sizes shown) → guides → grid. Tolerances in screen px. */
import type { Vec } from '@prowdcad/kernel';
import type { App } from '../app';
import { settings } from '../settings';
import { resolveFor, toWorld } from '../geometry';

export interface SnapResult { p: Vec; kind: 'anchor' | 'guide' | 'grid' | 'none'; label?: string }

export function snapPoint(app: App, w: Vec, opt: { exclude?: Set<string>; tolPx?: number; noGrid?: boolean } = {}): SnapResult {
  const tol = app.view.px(opt.tolPx ?? 8);
  if (settings.snapPoints) {
    let best: Vec | null = null, bd = tol;
    for (const p of app.pieces()) {
      if (app.hiddenPieces.has(p.id)) continue;
      const r = resolveFor(app.doc, p, app.sizeOf(p));
      const cs = [p.sew, ...p.internals], rs = [r.sew, ...r.internals];
      cs.forEach((c, ci) => c.points.forEach((a, ai) => {
        if (opt.exclude?.has(a.id)) return;
        const q = toWorld(p, rs[ci].anchorPos[ai]);
        const d = Math.hypot(q.x - w.x, q.y - w.y);
        if (d < bd) { bd = d; best = q; }
      }));
    }
    if (best) return { p: best, kind: 'anchor' };
  }
  let out: Vec = { ...w }, kind: SnapResult['kind'] = 'none';
  if (settings.snapGuides) {
    for (const g of settings.guides) {
      if (g.axis === 'x' && Math.abs(w.x - g.pos) < tol) { out.x = g.pos; kind = 'guide'; }
      if (g.axis === 'y' && Math.abs(w.y - g.pos) < tol) { out.y = g.pos; kind = 'guide'; }
    }
  }
  if (settings.snapGrid && !opt.noGrid && kind === 'none') {
    const s = settings.gridMm;
    out = { x: Math.round(w.x / s) * s, y: Math.round(w.y / s) * s }; kind = 'grid';
  }
  return { p: out, kind };
}
