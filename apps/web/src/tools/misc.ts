/**
 * Measure (M):
 *   click two points           straight distance / dX / dY / angle (snaps to points & outlines).
 *                               When both are points of ONE piece: per-size table (ops.measureXY).
 *   Alt-click a line            grade-segment length along the contour + per-size table with chord dX/dY
 *                               (ops.measureAcrossSizes); Shift+Alt-click adds the next segment to the run.
 *   Ctrl-click three points     angle at the 2nd point (ops.measureAngle when on one piece).
 *   Alt-click a point           per-size position / dX dY from base (ops.measureAcrossSizes on the point).
 * Zoom (Z):    click = zoom in, Alt-click = zoom out, drag = zoom to rectangle.
 * Hand (H):    drag to pan.
 */
import type { Vec, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { snapPoint } from '../canvas/snap';
import { fmt, unitLabel } from '../units-ui';
import { snapOutline, screenMarker, fs } from './common';
import { anchorNear, contourNear, runWorld, screenPath } from '../hitkit';
import { ops } from '../ops-bridge';
import { floatingWindow, table } from '../ui/window';
import { h, clear } from '../ui/dom';
import { reportError } from '../commands';

interface MPt { w: Vec; ref?: { pieceId: Id; anchorId: Id } }
let pts: MPt[] = [];
let angleMode = false;
let hover: Vec | null = null;
let result = '';
let segHighlight: Vec[] | null = null;

function snapAny(app: App, w: Vec): MPt {
  const a = anchorNear(app, w, { tolPx: 8 });
  if (a) return { w: a.world, ref: { pieceId: a.piece.id, anchorId: a.anchor.id } };
  const s = snapPoint(app, w, { noGrid: true });
  if (s.kind === 'anchor') return { w: s.p };
  for (const p of app.pieces()) { const o = snapOutline(app, p, w, 8); if (o) return { w: o.world }; }
  return { w: s.p };
}

function describe(a: Vec, b: Vec): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  return `L ${fmt(Math.hypot(dx, dy))} · dX ${fmt(dx)} · dY ${fmt(dy)} ${unitLabel()} · ∠ ${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2)}°`;
}

function showTable(app: App, title: string, head: string[], rows: (string | number)[][], summary: string) {
  const win = floatingWindow('measure', title, { width: 460 });
  win.setTitle(title);
  clear(win.body); clear(win.foot);
  win.body.append(h('div.fw-sum', {}, summary), table(head, rows));
  win.foot.append(h('span.dim', {}, `Values in ${unitLabel()} · active size highlighted in the canvas`));
}

function measureTwo(app: App, a: MPt, b: MPt) {
  result = describe(a.w, b.w);
  app.status(result);
  if (a.ref && b.ref && a.ref.pieceId === b.ref.pieceId) {
    const pc = app.doc.piece(a.ref.pieceId); const line = app.doc.sizeLine(pc);
    const rows = app.doc.sizesOf(pc).map(sid => { const m = ops.measureXY(app.doc, a.ref!, b.ref!, sid); return [line.sizes.find(s => s.id === sid)?.name ?? sid, fmt(m.distance), fmt(m.dx), fmt(m.dy), m.angleDeg.toFixed(2) + '°']; });
    showTable(app, `Measure — ${pc.name}`, ['Size', 'Straight', 'dX', 'dY', 'Angle'], rows, result);
  }
}

function measureAngle3(app: App, [a, v, b]: MPt[]) {
  const ang = (p: Vec, q: Vec) => Math.atan2(q.y - p.y, q.x - p.x);
  let d = (ang(v.w, b.w) - ang(v.w, a.w)) * 180 / Math.PI; d = ((d + 540) % 360) - 180;
  result = `Angle ${Math.abs(d).toFixed(2)}° (signed ${d.toFixed(2)}°)`;
  app.status(result);
  if (a.ref && v.ref && b.ref && a.ref.pieceId === v.ref.pieceId && b.ref.pieceId === v.ref.pieceId) {
    const pc = app.doc.piece(v.ref.pieceId); const line = app.doc.sizeLine(pc);
    const rows = app.doc.sizesOf(pc).map(sid => { const m = ops.measureAngle(app.doc, v.ref!, a.ref!, b.ref!, sid); return [line.sizes.find(s => s.id === sid)?.name ?? sid, m.deg.toFixed(3) + '°', m.signedDeg.toFixed(3) + '°']; });
    showTable(app, `Angle — ${pc.name}`, ['Size', 'Angle', 'Signed'], rows, result);
  }
}

let segRun: { pieceId: Id; contourId: Id; from: Id; to: Id } | null = null;
function measureSegment(app: App, w: Vec, extend: boolean): boolean {
  const pt = anchorNear(app, w, { tolPx: 7 });
  if (pt && !extend) {
    const rows = ops.measureAcrossSizes(app.doc, { pieceId: pt.piece.id, anchorId: pt.anchor.id });
    showTable(app, `Point — ${pt.piece.name}`, ['Size', 'X', 'Y', 'dX (vs base)', 'dY (vs base)'], rows.map(r => [r.sizeName, fmt(r.x ?? 0), fmt(r.y ?? 0), fmt(r.dX), fmt(r.dY)]), `Point ${pt.index + 1}${pt.anchor.name ? ' · ' + pt.anchor.name : ''}`);
    segHighlight = null; return true;
  }
  const hit = contourNear(app, w, { tolPx: 8 });
  if (!hit || !hit.from || !hit.to) return false;
  if (extend && segRun && segRun.pieceId === hit.piece.id && segRun.contourId === hit.contour.id && segRun.to === hit.from) segRun = { ...segRun, to: hit.to };
  else segRun = { pieceId: hit.piece.id, contourId: hit.contour.id, from: hit.from, to: hit.to };
  const ref = segRun;
  const rows = ops.measureAcrossSizes(app.doc, ref, 'contour');
  const act = rows.find(r => r.sizeId === app.sizeOf(hit.piece)) ?? rows[0];
  segHighlight = runWorld(app, hit.piece, hit.contour, ref.from, ref.to);
  result = `${hit.piece.name} · run length ${fmt(act?.value ?? 0)} ${unitLabel()} · chord dX ${fmt(act?.dX ?? 0)} dY ${fmt(act?.dY ?? 0)}`;
  app.status(result);
  showTable(app, `Segment — ${hit.piece.name}`, ['Size', 'Length', 'vs base', 'Inc', 'Chord dX', 'Chord dY'], rows.map(r => [r.sizeName, fmt(r.value), fmt(r.vsBase), fmt(r.inc), fmt(r.dX), fmt(r.dY)]), result + ' · Shift+Alt-click the next segment to extend');
  return true;
}

export const measureTool: Tool = {
  id: 'measure', title: 'Measure', group: 'measure', hotkey: 'M', icon: ICON.measure, cursor: 'crosshair',
  activate() { pts = []; hover = null; segHighlight = null; result = ''; },
  deactivate(app) { pts = []; hover = null; segHighlight = null; app.invalidate('canvas'); },
  busy: () => pts.length > 0 && pts.length < (angleMode ? 3 : 2),
  hint: () => result || 'Measure: click two points · Ctrl-click 3 points = angle · Alt-click a line = segment (Shift+Alt extends) · Alt-click a point = per-size position · Esc clear',
  down(app, p) {
    try {
      if (p.e.altKey) { pts = []; if (!measureSegment(app, p.w, p.e.shiftKey)) app.status('No segment under cursor'); app.invalidate('canvas'); return; }
      segHighlight = null;
      const q = snapAny(app, p.w);
      const want = p.e.ctrlKey || p.e.metaKey ? 3 : 2;
      if (!pts.length || pts.length >= (angleMode ? 3 : 2)) { pts = [q]; angleMode = want === 3; result = ''; }
      else {
        pts.push(q);
        if (!angleMode && pts.length === 2) measureTwo(app, pts[0], pts[1]);
        if (angleMode && pts.length === 3) measureAngle3(app, pts);
      }
    } catch (err) { reportError(err, 'Measure'); }
    app.invalidate('canvas');
  },
  move(app, p) {
    hover = snapAny(app, p.w).w;
    if (pts.length === 1 && !angleMode) app.status(describe(pts[0].w, hover));
    app.invalidate('canvas');
  },
  key(app, e) { if (e.key === 'Escape' && (pts.length || segHighlight)) { pts = []; segHighlight = null; segRun = null; result = ''; app.invalidate(); return true; } return false; },
  overlay(app) {
    let s = '';
    if (segHighlight) s += `<path d="${screenPath(app, segHighlight)}" fill="none" stroke="#ff9f1a" stroke-width="3" opacity="0.8"/>`;
    if (hover) s += screenMarker(app.view.toScreen(hover), 'cross', '#ff9f1a', 6);
    const done = pts.length >= (angleMode ? 3 : 2);
    const chain = [...pts.map(q => q.w), ...(!done && hover && pts.length ? [hover] : [])];
    if (chain.length > 1) s += `<path d="${screenPath(app, chain)}" fill="none" stroke="#ff9f1a" stroke-width="1.4"/>`;
    for (const q of pts) s += screenMarker(app.view.toScreen(q.w), 'circle', '#ff9f1a', 3);
    if (!angleMode && chain.length === 2) {
      const a = app.view.toScreen(chain[0]), b = app.view.toScreen(chain[1]);
      s += `<text x="${fs((a.x + b.x) / 2 + 6)}" y="${fs((a.y + b.y) / 2 - 6)}" class="tool-note">${fmt(Math.hypot(chain[1].x - chain[0].x, chain[1].y - chain[0].y))} ${unitLabel()}</text>`;
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
