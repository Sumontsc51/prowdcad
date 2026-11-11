/**
 * Select tool (V): selection, plus moving whole pieces on the sheet. It never moves points or
 * lines and never reshapes anything (unless the opt-in preference "Allow drag-move in Select" is
 * on: then a drag on a point / handle moves only that).
 *
 *  drag a piece by its inside   move the piece (with the other selected pieces); Shift = straight
 *  Shift / Ctrl / Alt + drag    always a box select, also when it starts inside a piece
 *
 *  click                    replace the selection with the object under the cursor
 *  Shift+click              add          Ctrl+click   toggle
 *  click empty sheet        clear (Esc clears too)
 *  drag (empty sheet / line)  box select: left → right = window (fully inside), right → left = crossing
 *                           (touching). Shift+drag adds, Ctrl+drag toggles. "All" boxes points.
 *  several objects here     Tab cycles through them (status bar lists them)
 *  double-click a piece     select all its points
 *  0 1 2 3 4 5              filter: All · Pieces · Points · Lines · Internals · Marks
 *
 * Selectable: grade / curve points, sew segments (grade point → grade point), internal lines,
 * notches, drills / buttons / texts, darts / pleats / fullness, pieces.
 */
import type { Vec } from '@prowdcad/kernel';
import type { App, SelItem } from '../app';
import { selItemKey } from '../app';
import type { Tool, Ptr } from './tool';
import { ICON } from './tool';
import { settings, saveSettings, type SelFilter } from '../settings';
import { candidatesAt, gatherInBox, itemHighlight, FILTERS, type Cand } from '../selpick';
import { DoubleClick } from '../ui/dom';
import { fs } from './common';
import { toast } from '../ui/toast';
import { ops } from '../ops-bridge';
import { previewWith, commitWith, curveTool, nudgeActive } from './move';
import { constrain45, dirToLocal, toWorld, layoutOf } from '../geometry';
import { snapPoint } from '../canvas/snap';
import { fmt, unitLabel } from '../units-ui';

type Mode = 'replace' | 'add' | 'toggle';
interface Press { w: Vec; s: Vec; cands: Cand[]; mode: Mode; hit: Ptr['hit']; e: MouseEvent }
type Drag =
  | { type: 'marquee'; a: Vec; b: Vec; as: Vec; bs: Vec; mode: Mode }
  | { type: 'point'; item: Extract<SelItem, { k: 'point' }>; startW: Vec; grabW: Vec; sizeId?: string; err: string | null; dl: Vec | null }
  | { type: 'piece'; ids: string[]; startW: Vec; base: Map<string, { x: number; y: number }>; d: Vec }
  | { type: 'handle' };

let press: Press | null = null;
let drag: Drag | null = null;
let hover: Cand | null = null;
let cycle: { s: Vec; cands: Cand[]; idx: number; mode: Mode } | null = null;
const dbl = new DoubleClick();

const modeOf = (e: MouseEvent | KeyboardEvent): Mode => (e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace');
const filterLabel = () => FILTERS.find(f => f.id === settings.selFilter)?.label ?? 'All';

export function setSelFilter(app: App, f: SelFilter) {
  settings.selFilter = f; saveSettings(); hover = null;
  app.status(`Selection filter: ${filterLabel()}`); app.invalidate();
}

function describe(app: App): string {
  const s = app.sel; const parts: string[] = [];
  const n = (k: number, one: string, many = one + 's') => { if (k) parts.push(`${k} ${k === 1 ? one : many}`); };
  n(s.anchors.length, 'point'); n(s.segments.length, 'segment'); n(s.internals.length, 'internal line'); n(s.notches.length, 'notch', 'notches'); n(s.marks.length, 'mark');
  if (app.currentLive()) parts.push(app.currentLive()!.kind);
  if (!parts.length && s.pieces.length) n(s.pieces.length, 'piece');
  return parts.join(', ');
}

function clickSelect(app: App, pr: Press) {
  const { cands, mode } = pr;
  // double-click a piece interior = select all of its points
  const top = cands[0];
  if (top?.item.k === 'piece' && dbl.hit(pr.s.x, pr.s.y, 'pc:' + top.item.pieceId)) {
    const p = app.doc.piece(top.item.pieceId);
    app.sel = { pieces: [p.id], anchors: [p.sew, ...p.internals].flatMap(c => c.points.map(a => ({ pieceId: p.id, contourId: c.id, anchorId: a.id }))), primary: 'point' };
    app.liveSel = null; app.invalidate();
    app.status(`${app.sel.anchors.length} points of ${p.name} selected`);
    return;
  }
  if (!top) {
    cycle = null;
    if (mode === 'replace') { app.clearSelection(); app.status(''); }
    return;
  }
  app.applySel(top.item, mode);
  cycle = cands.length > 1 ? { s: pr.s, cands, idx: 0, mode } : null;
  app.status(cands.length > 1 ? `${cands.length} objects here: ${top.label} · Tab = next (${cands.slice(1, 4).map(c => c.label).join(' · ')}${cands.length > 4 ? ' …' : ''})` : top.label);
}

export const selectTool: Tool = {
  id: 'select', title: 'Select', group: 'select', hotkey: 'V', icon: ICON.select, cursor: 'default',
  deactivate(app) { if (drag && drag.type !== 'marquee') app.cancelPreview(); drag = null; press = null; hover = null; },
  busy: () => !!drag,
  modes: () => FILTERS.map(f => ({ id: f.id, label: f.label, title: f.title })),
  mode: () => settings.selFilter ?? 'all',
  setMode(app, id) { setSelFilter(app, id as SelFilter); },
  badge: () => settings.selectDragMove ? { text: 'Point drag ON (a drag on a point moves only that point)', amber: true } : null,
  hint(app) {
    if (drag?.type === 'marquee') return drag.bs.x < drag.as.x ? 'Select · Crossing select (touching) · release to select' : 'Select · Window select (fully inside) · release to select';
    const d = describe(app);
    const f = filterLabel();
    if (!d) return `Select · [${f}] · Click to select · Shift add · Ctrl toggle · drag a piece = move it · drag elsewhere (or Alt+drag) = box (→ window, ← crossing) · 0–5 filter · G Move Point · Shift+G Move Line`;
    return `Select · [${f}] · ${d} selected · drag a piece = move it · G Move Point · Shift+G Move Line · right-click = menu · Esc clear`;
  },

  down(app, p) {
    const e = p.e as MouseEvent;
    hover = null;
    // opt-in: drag a handle in Select (moves only that handle)
    if (settings.selectDragMove && p.hit.kind === 'handle') { drag = { type: 'handle' }; curveTool.down!(app, p); return; }
    press = { w: p.w, s: p.s, cands: candidatesAt(app, p.w), mode: modeOf(e), hit: p.hit, e };
  },

  move(app, p) {
    const e = p.e as MouseEvent;
    if (drag?.type === 'handle') { curveTool.move!(app, p); return; }
    if (drag?.type === 'marquee') { drag.b = p.w; drag.bs = p.s; app.invalidate('canvas', 'status'); return; }
    if (drag?.type === 'point') {
      let target = { x: drag.grabW.x + p.w.x - drag.startW.x, y: drag.grabW.y + p.w.y - drag.startW.y };
      if (e.shiftKey) target = constrain45(drag.grabW, target);
      else if (!e.altKey) target = snapPoint(app, target, { exclude: new Set([drag.item.ref.anchorId]) }).p;
      const dW = { x: target.x - drag.grabW.x, y: target.y - drag.grabW.y };
      const r = drag.item.ref; const sid = drag.sizeId;
      const pc = app.doc.piece(r.pieceId); const dl = dirToLocal(pc, dW);
      drag.dl = dl;
      drag.err = previewWith(app, [r.pieceId], d => ops.movePoint(d, r.pieceId, r.anchorId, { dx: dl.x, dy: dl.y }, { sizeId: sid }));
      app.status(`Move point (only this one) dX ${fmt(dl.x)} dY ${fmt(dl.y)} ${unitLabel()}${drag.err ? ' · ⚠ ' + drag.err : ''}`);
      return;
    }
    if (drag?.type === 'piece') {
      const d = { x: p.w.x - drag.startW.x, y: p.w.y - drag.startW.y };
      const dd = e.shiftKey ? constrain45({ x: 0, y: 0 }, d) : d;
      drag.d = dd;
      for (const id of drag.ids) { const b = drag.base.get(id)!; const pc = app.beginPreview(id); pc.layout = { ...layoutOf(pc), x: b.x + dd.x, y: b.y + dd.y }; }
      app.status(`Move ${drag.ids.length > 1 ? drag.ids.length + ' pieces' : 'piece'} ΔX ${fmt(dd.x)} ΔY ${fmt(dd.y)} ${unitLabel()} · Shift = straight · Esc = cancel`); app.invalidate('canvas'); return;
    }
    if (press) {
      if (Math.hypot(p.s.x - press.s.x, p.s.y - press.s.y) < 3) return;
      const top = press.cands[0];
      // Dragging a piece by its inside moves the piece (its position on the sheet only: the shape, points and
      // lines never change). Shift / Ctrl / Alt + drag is always a box select, also when it starts inside a piece.
      const pe = press.e;
      const pieceDrag = top?.item.k === 'piece' && !pe.shiftKey && !pe.ctrlKey && !pe.metaKey && !pe.altKey;
      if (top && (pieceDrag || (settings.selectDragMove && top.item.k === 'point'))) {
        if (top.item.k === 'point') {
          const r = top.item.ref; const pc = app.doc.piece(r.pieceId);
          if (pc.locked) { toast(`${pc.name} is locked (Ctrl+L to unlock)`, 'warn'); press = null; return; }
          const hs = press.hit.kind === 'anchor' && press.hit.anchorId === r.anchorId ? press.hit.sizeId : undefined;
          const s = hs ?? app.sizeOf(pc); const sid = s === app.doc.baseSize(pc) ? undefined : s;
          app.applySel(top.item, 'replace');
          const pos = ops.pointPos(app.doc, r, sid ?? app.doc.baseSize(pc));
          drag = { type: 'point', item: top.item, startW: press.w, grabW: toWorld(pc, pos), sizeId: sid, err: null, dl: null };
        } else if (top.item.k === 'piece') {
          const pc = app.doc.piece(top.item.pieceId);
          // a piece that is part of a pieces-only selection takes the other selected pieces along
          const together = app.sel.pieces.includes(pc.id) && !app.hasSubSelection() && app.sel.pieces.length > 1;
          const ids = together ? app.sel.pieces.slice() : [pc.id];
          const locked = ids.map(id => app.doc.piece(id)).find(x => x.locked);
          if (locked) { toast(`${locked.name} is locked (Ctrl+L to unlock)`, 'warn'); press = null; return; }
          if (!together) app.applySel(top.item, 'replace');
          drag = { type: 'piece', ids, startW: press.w, base: new Map(ids.map(id => { const L = layoutOf(app.doc.piece(id)); return [id, { x: L.x, y: L.y }]; })), d: { x: 0, y: 0 } };
        }
        press = null; selectTool.move!(app, p); return;
      }
      // anything else: a box select (Select never moves points or lines)
      drag = { type: 'marquee', a: press.w, b: p.w, as: press.s, bs: p.s, mode: press.mode };
      press = null; app.invalidate('canvas', 'status'); return;
    }
    // hover pre-highlight of what a click would take
    const c = candidatesAt(app, p.w)[0] ?? null;
    const k = c ? selItemKey(c.item) : '', o = hover ? selItemKey(hover.item) : '';
    if (k !== o) { hover = c; app.invalidate('canvas'); }
  },

  up(app, p) {
    const d = drag; drag = null;
    if (d?.type === 'handle') { curveTool.up!(app, p); return; }
    if (d?.type === 'point') {
      const dl = d.dl; const r = d.item.ref;
      if (!dl || d.err) { app.cancelPreview(); return; }
      commitWith(app, [r.pieceId], 'Move point', doc => ops.movePoint(doc, r.pieceId, r.anchorId, { dx: dl.x, dy: dl.y }, { sizeId: d.sizeId }));
      return;
    }
    if (d?.type === 'piece') {
      app.preview.clear();
      if (d.d.x || d.d.y) { ops.transformPieceLayouts(app.doc, d.ids, { dx: d.d.x, dy: d.d.y }, d.ids.length > 1 ? 'Move pieces' : 'Move piece'); app.status(`Moved ${d.ids.length > 1 ? d.ids.length + ' pieces' : 'piece'} ΔX ${fmt(d.d.x)} ΔY ${fmt(d.d.y)} ${unitLabel()}`); }
      app.invalidate(); return;
    }
    if (d?.type === 'marquee') {
      const box = { minX: Math.min(d.a.x, d.b.x), maxX: Math.max(d.a.x, d.b.x), minY: Math.min(d.a.y, d.b.y), maxY: Math.max(d.a.y, d.b.y) };
      const crossing = d.bs.x < d.as.x;
      const items = gatherInBox(app, box, crossing);
      if (d.mode === 'replace') { app.sel = { pieces: [], anchors: [] }; app.liveSel = null; }
      for (const it of items) app.applySel(it, d.mode === 'toggle' ? 'toggle' : 'add');
      app.status(`${crossing ? 'Crossing' : 'Window'} select: ${items.length} ${filterLabel() === 'All' ? 'point(s)' : 'object(s)'} · ${describe(app) || 'nothing'} selected`);
      app.invalidate(); return;
    }
    const pr = press; press = null;
    if (pr) clickSelect(app, pr);
  },

  key(app, e) {
    if (e.key === 'Escape' && (drag || press)) {
      if (drag && drag.type !== 'marquee') app.cancelPreview();
      drag = null; press = null; app.invalidate(); return true;
    }
    if (e.key === 'Tab' && cycle && !e.ctrlKey && !e.altKey) {
      const c = cycle;
      const cur = c.cands[c.idx];
      c.idx = (c.idx + (e.shiftKey ? c.cands.length - 1 : 1)) % c.cands.length;
      const next = c.cands[c.idx];
      if (c.mode === 'replace') app.applySel(next.item, 'replace');
      else { app.applySel(cur.item, 'remove'); app.applySel(next.item, 'add'); }
      app.status(`${c.idx + 1}/${c.cands.length}: ${next.label} · Tab = next`);
      return true;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && /^Digit[0-5]$/.test(e.code)) {
      const f = FILTERS.find(x => x.key === e.code.slice(5)); if (f) { setSelFilter(app, f.id); return true; }
    }
    return false;
  },

  overlay(app) {
    let out = '';
    if (hover && !drag && !press && !app.isSelected(hover.item)) out += itemHighlight(app, hover.item, 0.5);
    if (drag?.type === 'marquee') {
      const a = app.view.toScreen(drag.a), b = app.view.toScreen(drag.b);
      const crossing = drag.bs.x < drag.as.x;
      out += `<rect x="${fs(Math.min(a.x, b.x))}" y="${fs(Math.min(a.y, b.y))}" width="${fs(Math.abs(a.x - b.x))}" height="${fs(Math.abs(a.y - b.y))}" fill="${crossing ? 'rgba(46,204,113,0.08)' : 'rgba(78,161,255,0.08)'}" stroke="${crossing ? '#27ae60' : '#4ea1ff'}"${crossing ? ' stroke-dasharray="5 3"' : ''}/>`;
    }
    return out;
  },
};

/** Arrow-key nudge: only Move tools move geometry (Select never does). */
export function nudge(app: App, dx: number, dy: number) { nudgeActive(app, dx, dy); }
