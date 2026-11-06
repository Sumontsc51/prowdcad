/**
 * Snapping, in priority order: anchors (all sizes shown) → intersection of two lines → midpoint of a
 * segment (grade point → grade point) → perpendicular foot from the move's start point → guides → grid.
 * Tolerances in screen px. Alt (handled by the tools) turns snapping off for a drag.
 *
 * The line snaps use the document geometry (not the drag preview), so a moving point never snaps to
 * the midpoint of its own moving segments.
 */
import type { Vec } from '@prowdcad/kernel';
import type { App } from '../app';
import { settings } from '../settings';
import { resolveFor, toWorld } from '../geometry';

export type SnapKind = 'anchor' | 'int' | 'mid' | 'perp' | 'guide' | 'grid' | 'none';
export interface SnapResult { p: Vec; kind: SnapKind; label?: string }

/** Last snap result (tools draw its glyph next to the cursor). */
export let lastSnap: SnapResult = { p: { x: 0, y: 0 }, kind: 'none' };
export const SNAP_LABEL: Partial<Record<SnapKind, string>> = { anchor: 'pt', int: 'int', mid: 'mid', perp: 'perp', guide: 'guide' };

interface Line { pts: Vec[]; key: string }

function linesNear(app: App, w: Vec, tol: number): { lines: Line[]; mids: { p: Vec; ids: [string, string] }[] } {
  const lines: Line[] = []; const mids: { p: Vec; ids: [string, string] }[] = [];
  for (const p of app.doc.style.pieces) {
    if (app.hiddenPieces.has(p.id)) continue;
    let r; try { r = resolveFor(app.doc, p, app.sizeOf(p)); } catch { continue; }
    const cs = [p.sew, ...p.internals], rs = [r.sew, ...r.internals];
    cs.forEach((c, ci) => {
      const rc = rs[ci]; if (!rc || rc.pts.length < 2) return;
      const W = rc.pts.map(q => toWorld(p, q));
      const poly = rc.closed ? [...W, W[0]] : W;
      // a cheap bbox reject
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of poly) { if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
      if (w.x < minX - tol || w.x > maxX + tol || w.y < minY - tol || w.y > maxY + tol) return;
      lines.push({ pts: poly, key: `${p.id}:${c.id}` });
      // midpoints of the grade segments (by arc length)
      const g = c.points.map((a, i) => (a.kind === 'grade' ? i : -1)).filter(i => i >= 0 && rc.anchorIndex[i] !== undefined);
      const cum: number[] = [0]; for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
      const tot = cum[cum.length - 1];
      for (let k = 0; k < g.length; k++) {
        if (!c.closed && k === g.length - 1) break;
        const ia = g[k], ib = g[(k + 1) % g.length]; if (ia === ib) continue;
        const sa = cum[rc.anchorIndex[ia]] ?? 0; let sb = cum[rc.anchorIndex[ib]] ?? 0;
        if (sb <= sa && rc.closed) sb += tot;
        let sm = (sa + sb) / 2; if (rc.closed && sm > tot) sm -= tot;
        mids.push({ p: atArc(poly, cum, sm), ids: [c.points[ia].id, c.points[ib].id] });
      }
    });
  }
  return { lines, mids };
}
function atArc(poly: Vec[], cum: number[], s: number): Vec {
  for (let i = 1; i < poly.length; i++) if (cum[i] >= s) { const d = cum[i] - cum[i - 1] || 1; const t = (s - cum[i - 1]) / d; return { x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * t, y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * t }; }
  return poly[poly.length - 1];
}
function segInt(a: Vec, b: Vec, c: Vec, d: Vec): Vec | null {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x); if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den, u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
/** polyline segments (index i → i+1) within tol of w */
function nearSegs(l: Line, w: Vec, tol: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < l.pts.length; i++) {
    const a = l.pts[i], b = l.pts[i + 1];
    if (Math.min(a.x, b.x) - tol > w.x || Math.max(a.x, b.x) + tol < w.x || Math.min(a.y, b.y) - tol > w.y || Math.max(a.y, b.y) + tol < w.y) continue;
    out.push(i);
  }
  return out;
}

export function snapPoint(app: App, w: Vec, opt: { exclude?: Set<string>; tolPx?: number; noGrid?: boolean; from?: Vec } = {}): SnapResult {
  const res = snapCore(app, w, opt);
  lastSnap = res;
  return res;
}

function snapCore(app: App, w: Vec, opt: { exclude?: Set<string>; tolPx?: number; noGrid?: boolean; from?: Vec }): SnapResult {
  const tol = app.view.px(opt.tolPx ?? 8);
  if (settings.snapPoints) {
    let best: Vec | null = null, bd = tol;
    for (const p of app.pieces()) {
      if (app.hiddenPieces.has(p.id)) continue;
      const r = resolveFor(app.doc, p, app.sizeOf(p));
      const cs = [p.sew, ...p.internals], rs = [r.sew, ...r.internals];
      cs.forEach((c, ci) => c.points.forEach((a, ai) => {
        if (opt.exclude?.has(a.id)) return;
        const pos = rs[ci]?.anchorPos[ai]; if (!pos) return;
        const q = toWorld(p, pos);
        const d = Math.hypot(q.x - w.x, q.y - w.y);
        if (d < bd) { bd = d; best = q; }
      }));
    }
    if (best) return { p: best, kind: 'anchor' };
    // line snaps: intersection → midpoint → perpendicular foot
    const { lines, mids } = linesNear(app, w, tol);
    let bi: Vec | null = null, bdi = tol;
    for (let i = 0; i < lines.length; i++) {
      const si = nearSegs(lines[i], w, tol);
      for (let j = i; j < lines.length; j++) {
        const sj = i === j ? si : nearSegs(lines[j], w, tol);
        for (const a of si) for (const b of sj) {
          if (i === j && Math.abs(a - b) < 2) continue; // same line: only non-adjacent segments
          const q = segInt(lines[i].pts[a], lines[i].pts[a + 1], lines[j].pts[b], lines[j].pts[b + 1]); if (!q) continue;
          const d = Math.hypot(q.x - w.x, q.y - w.y); if (d < bdi) { bdi = d; bi = q; }
        }
      }
    }
    if (bi) return { p: bi, kind: 'int', label: 'int' };
    let bm: Vec | null = null, bdm = tol;
    for (const m of mids) {
      if (opt.exclude?.has(m.ids[0]) || opt.exclude?.has(m.ids[1])) continue;
      const d = Math.hypot(m.p.x - w.x, m.p.y - w.y); if (d < bdm) { bdm = d; bm = m.p; }
    }
    if (bm) return { p: bm, kind: 'mid', label: 'mid' };
    if (opt.from) {
      const f = opt.from; let bp: Vec | null = null, bdp = tol;
      for (const l of lines) for (const i of nearSegs(l, w, tol)) {
        const a = l.pts[i], b = l.pts[i + 1]; const dx = b.x - a.x, dy = b.y - a.y; const L2 = dx * dx + dy * dy; if (L2 < 1e-12) continue;
        const t = ((f.x - a.x) * dx + (f.y - a.y) * dy) / L2; if (t < 0 || t > 1) continue;
        const q = { x: a.x + dx * t, y: a.y + dy * t };
        if (Math.hypot(q.x - f.x, q.y - f.y) < 1e-6) continue; // the start already lies on that line
        const d = Math.hypot(q.x - w.x, q.y - w.y); if (d < bdp) { bdp = d; bp = q; }
      }
      if (bp) return { p: bp, kind: 'perp', label: 'perp' };
    }
  }
  let out: Vec = { ...w }, kind: SnapKind = 'none';
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
