/**
 * Measure tool (M) — AccuMark Measure ▸ Line Length, two modes (tool-options strip, Tab):
 *
 * Line (default)
 *   hover          highlights the line under the cursor: one sew / internal segment between two
 *                  consecutive grade points (cut points are grade points). Alt = its CUT line.
 *                  In nested view the outline of every shown size is pickable.
 *   click          adds it to the open group as L1, L2, … (label on the canvas); clicking a picked
 *                  line again removes it; Backspace removes the last one.
 *   Shift+click    extends from the last picked line along the same contour up to the clicked one.
 *   other piece    a click on a different piece (or Ctrl+click anywhere) starts a new group →
 *                  comparison (Σ A, Σ B, B − A, target ease ± tolerance) in the Measure window.
 *   Enter / right-click = OK (kept in the window's list) · Esc = cancel.
 *
 * Distance (the former Measure tool)
 *   click two points: L / dX / dY / angle (+ per-size table when both are points of one piece);
 *   Ctrl-click 3 points = angle; Alt-click a point = per-size position.
 */
import type { Vec, Id, Piece, Contour, ResolvedContour, SizeId } from '@prowdcad/kernel';
import { closestPoint, segmentIndexAt, arcPolyline } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool, type Ptr } from './tool';
import { snapPoint } from '../canvas/snap';
import { fmt, unitLabel } from '../units-ui';
import { snapOutline, screenMarker, fs } from './common';
import { anchorNear, screenPath, segmentIds } from '../hitkit';
import { ops } from '../ops-bridge';
import { floatingWindow, table } from '../ui/window';
import { h, clear } from '../ui/dom';
import { reportError } from '../commands';
import { resolveFor, toWorld, toLocal } from '../geometry';
import { segmentAt, label as svgLabel } from './livekit';
import { closeMeasureWindow, MS, addPart, removePart, removeLast, hasOpen, commitMeasure, cancelMeasure, renderMeasureWindow, groupColor, sameRef, partName, setMeasureHooks } from '../panels/measure-table';
import { settings, saveSettings } from '../settings';
import { toast } from '../ui/toast';

// ───────────────────────── line picking ─────────────────────────

export interface LineHit { piece: Piece; contour: Contour; sizeId: SizeId; from: Id; to: Id; dpx: number }

/** displayed sizes of a piece (active first; nested view adds the other visible sizes) */
function shownSizes(app: App, p: Piece): SizeId[] {
  const a = app.sizeOf(p);
  return app.nested ? [a, ...app.doc.sizesOf(p).filter(s => s !== a && !app.nestedHidden.has(s))] : [a];
}

/** Measure ▸ Line option "Internal lines" (on unless switched off) */
const internalOn = () => settings.toolState?.measure?.internal !== false;

/** the measurable segment under the cursor, any displayed size */
export function lineAt(app: App, w: Vec, tolPx = 9): LineHit | null {
  let best: LineHit | null = null;
  for (const p of app.doc.style.pieces) {
    if (app.hiddenPieces.has(p.id)) continue;
    const l = toLocal(p, w);
    for (const sid of shownSizes(app, p)) {
      let r; try { r = resolveFor(app.doc, p, sid); } catch { continue; }
      const cs = [p.sew, ...p.internals], rs = [r.sew, ...r.internals];
      cs.forEach((c, ci) => {
        const rc = rs[ci]; if (!rc || rc.pts.length < 2) return;
        if (ci > 0 && !internalOn()) return; // "Internal lines" option off: only the outline is measured
        const poly = rc.closed ? [...rc.pts, rc.pts[0]] : rc.pts;
        const cp = closestPoint(poly, l);
        const dpx = cp.d * app.view.scale + (sid === app.sizeOf(p) ? 0 : 0.5); // active size wins ties
        if (dpx > tolPx || (best && dpx >= best.dpx)) return;
        let from: Id | undefined, to: Id | undefined;
        if (c.closed) { const k = rc.gradeIdx.length ? segmentIndexAt(rc, cp.s) : -1; ({ from, to } = segmentIds(c, rc, k)); }
        // an open internal line is measured whole with one click (end to end), however many points it has
        else if (ci > 0 && c.points.length >= 2) { from = c.points[0].id; to = c.points[c.points.length - 1].id; }
        else { const sg = segmentAt(c, rc, cp.s); if (sg) { from = sg.fromId; to = sg.toId; } }
        if (!from || !to) return;
        best = { piece: p, contour: c, sizeId: sid, from, to, dpx };
      });
    }
  }
  return best;
}

/** ordered segments of a contour (grade points, + the ends of an open contour) */
function segmentsOf(c: Contour, rc: ResolvedContour): { from: Id; to: Id }[] {
  const n = c.points.length; const bnd: number[] = [];
  c.points.forEach((a, i) => { if (a.kind === 'grade' || (!c.closed && (i === 0 || i === n - 1))) bnd.push(i); });
  const out: { from: Id; to: Id }[] = [];
  for (let k = 0; k < bnd.length - (c.closed ? 0 : 1); k++) {
    const a = bnd[k], b = bnd[(k + 1) % bnd.length];
    if (c.closed) { const ids = segmentIds(c, rc, rc.gradeIdx.indexOf(a)); if (!ids.from) continue; }
    out.push({ from: c.points[a].id, to: c.points[b].id });
  }
  return out;
}

/** world polyline of a part in a size (sew / internal run, or the cut line) */
export function partWorld(app: App, part: { ref: { pieceId: Id; contourId: Id; from: Id; to: Id; reverse?: boolean }; cut?: boolean }, sizeId?: SizeId): Vec[] {
  const p = app.doc.style.pieces.find(x => x.id === part.ref.pieceId); if (!p) return [];
  const sid = sizeId ?? app.sizeOf(p);
  try {
    if (part.cut) return ops.cutPolyline(app.doc, part.ref, sid).map(q => toWorld(p, q));
    const r = resolveFor(app.doc, p, sid);
    const c = [p.sew, ...p.internals].find(x => x.id === part.ref.contourId); if (!c) return [];
    const rc = c === p.sew ? r.sew : r.internals[p.internals.indexOf(c)]; if (!rc) return [];
    const ia = c.points.findIndex(a => a.id === part.ref.from), ib = c.points.findIndex(a => a.id === part.ref.to);
    if (ia < 0 || ib < 0) return [];
    const poly = ia === ib && rc.closed ? [...rc.pts.slice(rc.anchorIndex[ia]), ...rc.pts.slice(0, rc.anchorIndex[ia] + 1)] : arcPolyline(rc, ia, ib, part.ref.reverse);
    return poly.map(q => toWorld(p, q));
  } catch { return []; }
}

function midOf(pts: Vec[]): { p: Vec; dir: Vec } {
  let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let g = L / 2;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (g <= d && d > 0) { const t = g / d; return { p: { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }, dir: { x: (pts[i].x - pts[i - 1].x) / d, y: (pts[i].y - pts[i - 1].y) / d } }; }
    g -= d;
  }
  return { p: pts[0] ?? { x: 0, y: 0 }, dir: { x: 1, y: 0 } };
}

let hoverHit: LineHit | null = null;
let hoverCut = false;
let mode: 'line' | 'distance' = 'line';

function pickLine(app: App, p: Ptr) {
  const hit = lineAt(app, p.w);
  if (!hit) { app.status(internalOn() ? 'No line under the cursor · click an outline segment or an internal line' : 'No outline under the cursor · internal lines are off (switch “Internal lines” on above to measure them)'); return; }
  const cut = p.e.altKey !== !!settings.toolState?.measure?.cut;
  if (cut && hit.contour !== hit.piece.sew) { toast('The cut line exists only for sew lines; measuring the internal line', 'warn'); }
  const part = { ref: { pieceId: hit.piece.id, contourId: hit.contour.id, from: hit.from, to: hit.to }, cut: cut && hit.contour === hit.piece.sew ? true : undefined };
  // click again on a picked line = remove it
  if (!p.e.shiftKey && removePart(part)) { afterChange(app, `Removed ${partName(app, part)}`); return; }
  // which group: Ctrl = new; same piece as the current group → it; else the last group on that piece; else new
  let gi = MS.cur;
  const pieceOf = (g: number) => MS.groups[g]?.parts[0]?.ref.pieceId;
  if (p.e.ctrlKey || p.e.metaKey) gi = -1;
  else if (gi >= 0 && pieceOf(gi) !== hit.piece.id) {
    let k = -1; for (let j = MS.groups.length - 1; j >= 0; j--) if (pieceOf(j) === hit.piece.id) { k = j; break; }
    gi = k;
  }
  if (p.e.shiftKey && gi >= 0 && MS.groups[gi]) {
    // extend: every segment from the last picked one of this contour up to the clicked one
    const g = MS.groups[gi]; const last = [...g.parts].reverse().find(q => q.ref.contourId === hit.contour.id && !!q.cut === !!part.cut);
    if (last) {
      const r = resolveFor(app.doc, hit.piece, app.sizeOf(hit.piece));
      const rc = hit.contour === hit.piece.sew ? r.sew : r.internals[hit.piece.internals.indexOf(hit.contour)];
      const segs = segmentsOf(hit.contour, rc);
      const n = segs.length;
      const iLast = segs.findIndex(s => s.from === last.ref.from && s.to === last.ref.to), iHit = segs.findIndex(s => s.from === hit.from && s.to === hit.to);
      if (iLast >= 0 && iHit >= 0 && iLast !== iHit) {
        const fwd = hit.contour.closed ? (iHit - iLast + n) % n : iHit - iLast;
        const bwd = hit.contour.closed ? (iLast - iHit + n) % n : iLast - iHit;
        const useFwd = fwd > 0 && (bwd <= 0 || fwd <= bwd);
        const steps = useFwd ? fwd : bwd;
        let added = 0;
        for (let k = 1; k <= steps; k++) {
          const s = segs[((useFwd ? iLast + k : iLast - k) % n + n) % n];
          const q = { ref: { pieceId: hit.piece.id, contourId: hit.contour.id, from: s.from, to: s.to }, cut: part.cut };
          if (g.parts.some(x => sameRef(x, q))) continue;
          addPart(q, gi); added++;
        }
        afterChange(app, `Extended by ${added} line(s)`); return;
      }
    }
  }
  const ngi = addPart(part, gi);
  const g = MS.groups[ngi];
  afterChange(app, `${MS.groups.length > 1 ? g.name + '·' : ''}${g.parts[g.parts.length - 1].label} = ${partName(app, part)}${MS.groups.length > 1 && gi < 0 ? ' · new group (comparison)' : ''}`);
}

function afterChange(app: App, msg: string) {
  renderMeasureWindow(app);
  // the running total of the current group, active size
  try {
    const g = MS.groups[MS.cur];
    if (g) {
      const rows = ops.measureGroup(app.doc, g.parts, MS.mode);
      const row = rows.find(r => r.sizeId === app.activeSize) ?? rows.find(r => r.total !== null);
      if (row) msg += ` · ${g.name}: ${g.parts.map(p => p.label).join(' + ')} = ${row.total === null ? '—' : fmt(row.total)} ${unitLabel()} (${row.sizeName})`;
    }
  } catch { /* */ }
  app.status(msg);
  app.invalidate('canvas');
}

function okMeasure(app: App) {
  const r = commitMeasure();
  if (r) { toast(`Kept “${r.name}” (Measure window)`, 'ok'); app.status(`Measure OK · kept “${r.name}”`); }
  renderMeasureWindow(app); app.invalidate('canvas');
}

// ───────────────────────── distance mode (the former Measure tool) ─────────────────────────

interface MPt { w: Vec; ref?: { pieceId: Id; anchorId: Id } }
let pts: MPt[] = [];
let angleMode = false;
let hover: Vec | null = null;
let result = '';

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
function showTable(title: string, head: string[], rows: (string | number)[][], summary: string) {
  const win = floatingWindow('measure', title, { width: 460 });
  win.setTitle(title);
  clear(win.body); clear(win.foot);
  win.body.append(h('div.fw-sum', {}, summary), table(head, rows));
  win.foot.append(h('span.dim', {}, `Values in ${unitLabel()} · rows = sizes`));
}
function measureTwo(app: App, a: MPt, b: MPt) {
  result = describe(a.w, b.w);
  app.status(result);
  if (a.ref && b.ref && a.ref.pieceId === b.ref.pieceId) {
    const pc = app.doc.piece(a.ref.pieceId); const line = app.doc.sizeLine(pc);
    const rows = app.doc.sizesOf(pc).map(sid => { const m = ops.measureXY(app.doc, a.ref!, b.ref!, sid); return [line.sizes.find(s => s.id === sid)?.name ?? sid, fmt(m.distance), fmt(m.dx), fmt(m.dy), m.angleDeg.toFixed(2) + '°']; });
    showTable(`Measure — ${pc.name}`, ['Size', 'Straight', 'dX', 'dY', 'Angle'], rows, result);
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
    showTable(`Angle — ${pc.name}`, ['Size', 'Angle', 'Signed'], rows, result);
  }
}
function pointAcross(app: App, w: Vec): boolean {
  const pt = anchorNear(app, w, { tolPx: 7 });
  if (!pt) return false;
  const rows = ops.measureAcrossSizes(app.doc, { pieceId: pt.piece.id, anchorId: pt.anchor.id });
  showTable(`Point — ${pt.piece.name}`, ['Size', 'X', 'Y', 'dX (vs base)', 'dY (vs base)'], rows.map(r => [r.sizeName, fmt(r.x ?? 0), fmt(r.y ?? 0), fmt(r.dX), fmt(r.dY)]), `Point ${pt.index + 1}${pt.anchor.name ? ' · ' + pt.anchor.name : ''}`);
  return true;
}

// ───────────────────────── the tool ─────────────────────────

export const measureTool: Tool = {
  id: 'measure', title: 'Measure', group: 'measure', hotkey: 'M', icon: ICON.measure, cursor: 'crosshair',
  activate(app) {
    pts = []; hover = null; result = ''; hoverHit = null;
    mode = (settings.toolState?.measure?.mode as 'line' | 'distance') ?? 'line';
    if (mode === 'line') renderMeasureWindow(app);
    setMeasureHooks({ onOK: () => app.invalidate('canvas'), onCancel: () => app.invalidate('canvas') });
  },
  // leaving the Measure tool closes its window (it reopens with the tool; open and kept measurements are not lost)
  deactivate(app) { pts = []; hover = null; hoverHit = null; closeMeasureWindow(); app.invalidate('canvas'); },
  busy: () => (mode === 'line' ? hasOpen() : pts.length > 0 && pts.length < (angleMode ? 3 : 2)),
  modes: () => [
    { id: 'line', label: 'Line', title: 'Measure Line (AccuMark Line Length): click lines, they add up per size; another piece = comparison' },
    { id: 'distance', label: 'Distance', title: 'Point to point: L / dX / dY / angle; Ctrl = 3-point angle; Alt-click a point = per-size position' },
  ],
  mode: () => mode,
  setMode(app, id) { mode = id as 'line' | 'distance'; (settings.toolState ??= {}).measure = { ...(settings.toolState.measure ?? {}), mode }; saveSettings(); pts = []; hoverHit = null; if (mode === 'line') renderMeasureWindow(app); app.invalidate(); },
  toggles: () => (mode === 'line' ? [
    { id: 'internal', label: 'Internal lines', title: 'On: internal lines can be measured too — one click takes the whole line, end to end. Off: only the outline is picked', on: internalOn() },
    { id: 'cut', label: 'Cut line', title: 'Measure the cut line instead of the sew line (Alt inverts per click)', on: !!settings.toolState?.measure?.cut },
  ] : []),
  toggle(app, id) {
    if (id === 'internal') { (settings.toolState ??= {}).measure = { ...(settings.toolState.measure ?? {}), internal: !internalOn() }; saveSettings(); hoverHit = null; app.status(internalOn() ? 'Internal lines can be measured (one click = the whole line)' : 'Only the outline is measured'); app.invalidate(); }
    if (id === 'cut') { (settings.toolState ??= {}).measure = { ...(settings.toolState.measure ?? {}), cut: !settings.toolState?.measure?.cut }; saveSettings(); app.invalidate(); } },
  hint: () => {
    if (mode === 'distance') return result || 'Measure ▸ Distance: click two points · Ctrl-click 3 points = angle · Alt-click a point = per-size position · Tab = Line mode';
    const g = MS.groups[MS.cur];
    if (!hasOpen()) return 'Measure ▸ Line: click an outline segment or an internal line · Shift+click = extend the run · Alt = cut line · another piece / Ctrl = compare · Tab = Distance';
    return `Measure ▸ Line: ${g ? g.name + ' = ' + g.parts.map(p => p.label).join(' + ') : ''} · click to add / click again to remove · Backspace = last off · Ctrl / another piece = new group · Enter / right-click = OK · Esc = cancel`;
  },
  down(app, p) {
    try {
      if (mode === 'line') { if ((p.e as MouseEvent).button === 0) pickLine(app, p); return; }
      if (p.e.altKey) { pts = []; if (!pointAcross(app, p.w)) app.status('No point under cursor'); app.invalidate('canvas'); return; }
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
    if (mode === 'line') {
      hoverHit = lineAt(app, p.w); hoverCut = p.e.altKey !== !!settings.toolState?.measure?.cut;
      app.invalidate('canvas'); return;
    }
    hover = snapAny(app, p.w).w;
    if (pts.length === 1 && !angleMode) app.status(describe(pts[0].w, hover));
    app.invalidate('canvas');
  },
  context(app) {
    if (mode !== 'line') return false;
    okMeasure(app); return true;
  },
  key(app, e) {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { this.setMode!(app, mode === 'line' ? 'distance' : 'line'); return true; }
    if (mode === 'line') {
      if (e.key === 'Enter') { if (!hasOpen()) return false; okMeasure(app); return true; }
      if (e.key === 'Escape') { if (!hasOpen()) return false; cancelMeasure(); renderMeasureWindow(app); app.status('Measure cancelled'); app.invalidate('canvas'); return true; }
      if (e.key === 'Backspace') { if (!removeLast()) return false; afterChange(app, 'Removed the last line'); return true; }
      if (e.key === 'Alt') { hoverCut = !settings.toolState?.measure?.cut; app.invalidate('canvas'); return false; }
      return false;
    }
    if (e.key === 'Escape' && pts.length) { pts = []; result = ''; app.invalidate(); return true; }
    return false;
  },
  overlay(app) {
    let s = '';
    if (mode === 'line') {
      // picked lines with labels
      MS.groups.forEach((g, gi) => {
        const col = groupColor(gi);
        for (const part of g.parts) {
          const wpts = partWorld(app, part);
          if (wpts.length < 2) continue;
          s += `<path d="${screenPath(app, wpts)}" fill="none" stroke="${col}" stroke-width="${gi === MS.cur ? 4 : 3}" opacity="0.75"${part.cut ? ' stroke-dasharray="7 3"' : ''} stroke-linecap="round"/>`;
          const m = midOf(wpts); const sp = app.view.toScreen(m.p);
          const nrm = { x: -m.dir.y, y: m.dir.x }; // world normal
          const off = { x: sp.x + nrm.x * 14, y: sp.y - nrm.y * 14 };
          const txt = (MS.groups.length > 1 ? g.name + '·' : '') + part.label + (part.cut ? '✂' : '');
          s += `<rect x="${fs(off.x - 4 - txt.length * 3.4)}" y="${fs(off.y - 9)}" width="${fs(txt.length * 6.8 + 8)}" height="14" rx="3" fill="${col}" opacity="0.92"/>` +
            `<text x="${fs(off.x)}" y="${fs(off.y + 2)}" class="m-label" text-anchor="middle">${txt}</text>`;
        }
      });
      if (hoverHit) {
        const part = { ref: { pieceId: hoverHit.piece.id, contourId: hoverHit.contour.id, from: hoverHit.from, to: hoverHit.to }, cut: hoverCut && hoverHit.contour === hoverHit.piece.sew };
        const wpts = partWorld(app, part, hoverHit.sizeId);
        if (wpts.length > 1) {
          const picked = MS.groups.some(g => g.parts.some(q => sameRef(q, part)));
          s += `<path d="${screenPath(app, wpts)}" fill="none" stroke="${picked ? '#c92a2a' : '#ff9f1a'}" stroke-width="6" opacity="0.45" stroke-linecap="round"/>`;
          let len = 0; try { len = ops.measurePart(app.doc, part, MS.mode, hoverHit.sizeId); } catch { /* */ }
          const m = midOf(wpts); const sp = app.view.toScreen(m.p);
          s += svgLabel({ x: sp.x + 10, y: sp.y - 10 }, `${picked ? 'click = remove · ' : ''}${fmt(len)} ${unitLabel()}${part.cut ? ' (cut)' : ''}`, { col: '#8a4b00' });
        }
      }
      return s;
    }
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
