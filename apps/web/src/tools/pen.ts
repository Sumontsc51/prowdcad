/**
 * Pen (P): draws a NEW boundary piece (sew line).
 *   click            grade corner
 *   click-drag       smooth point with mirrored handles (Alt while dragging = break: only hOut moves)
 *   Ctrl+click       curve (intermediate) point
 *   Shift            H / V / 45° from the previous point
 *   click start pt   close → creates the Piece (makePiece)
 *   Enter            close & create (≥3 pts) · Backspace removes last point · Esc cancels
 *   right-click      exact next point (length + angle / dX dY)
 */
import { makeAnchor, makeContour, makePiece, type Anchor, type Vec } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { constrain45 } from '../geometry';
import { snapPoint } from '../canvas/snap';
import { draftScreenPath, dropPhantoms, screenMarker, fs } from './common';
import { toast } from '../ui/toast';
import { showDialog } from '../ui/dialog';
import { fmt, unitLabel, parseLen, parseNum } from '../units-ui';

interface Draft { pts: Anchor[]; hover: Vec | null; drag: { a: Anchor; start: Vec; moved: boolean } | null }
let D: Draft | null = null;

function resolveClick(app: App, w: Vec, shift: boolean): Vec {
  if (D && D.pts.length && shift) return constrain45(D.pts[D.pts.length - 1], w);
  return snapPoint(app, w).p;
}

async function commit(app: App) {
  if (!D) return;
  const pts = dropPhantoms(app, D.pts, true);
  if (pts.length < 3) { toast('A piece needs at least 3 points', 'warn'); return; }
  pts[0].flags.startPoint = true;
  // first and last point must be grade points so segments are well defined
  if (pts.every(p => p.kind !== 'grade')) { pts[0].kind = 'grade'; }
  const n = app.style.pieces.length + 1;
  const r = await showDialog({ title: 'New piece', fields: [{ kind: 'text', key: 'name', label: 'Name', value: `PIECE ${n}` }, { kind: 'length', key: 'seam', label: 'Seam allowance', value: 10, min: 0 }] });
  if (!r) return;
  const piece = makePiece(String(r.name).trim() || `PIECE ${n}`, makeContour(pts, { type: 'perimeter', closed: true }), app.doc.sizeTable().id, { seamDefault: r.seam as number });
  // grain: vertical through the bbox centre
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, y0 = Math.min(...ys), y1 = Math.max(...ys);
  piece.grain = { a: { x: cx, y: y0 + (y1 - y0) * 0.2 }, b: { x: cx, y: y0 + (y1 - y0) * 0.8 }, gradeA: {}, gradeB: {}, centered: true };
  app.doc.transact('Pen: new piece', s => { s.pieces.push(piece); });
  D = null;
  app.sel = { pieces: [piece.id], anchors: [] };
  toast(`Piece “${piece.name}” created (${pts.length} points)`, 'ok');
  app.invalidate();
}

async function exactNext(app: App) {
  if (!D || !D.pts.length) return;
  const last = D.pts[D.pts.length - 1];
  const r = await showDialog({
    title: 'Next point — exact',
    fields: [
      { kind: 'select', key: 'mode', label: 'Mode', value: 'la', options: [{ value: 'la', label: 'Length + angle' }, { value: 'xy', label: 'dX + dY' }] },
      { kind: 'length', key: 'a', label: 'Length / dX', value: 0 },
      { kind: 'text', key: 'b', label: 'Angle° / dY', value: '0', hint: 'Length mode: angle in degrees (0 = right, 90 = up). dX/dY mode: dY in the display unit (+ = up).' },
      { kind: 'checkbox', key: 'curve', label: 'Curve point', value: false },
    ],
    validate: v => Number.isFinite(v.mode === 'la' ? parseNum(String(v.b)) : parseLen(String(v.b))) ? null : 'Angle / dY: invalid number',
  });
  if (!r || !D) return;
  let x: number, y: number;
  if (r.mode === 'la') { const L = r.a as number, ang = parseNum(String(r.b)) * Math.PI / 180; x = last.x + L * Math.cos(ang); y = last.y + L * Math.sin(ang); }
  else { x = last.x + (r.a as number); y = last.y + parseLen(String(r.b)); }
  D.pts.push(r.curve ? makeAnchor(x, y, { kind: 'curve', smooth: true }) : makeAnchor(x, y));
  app.invalidate('canvas');
}

export const penTool: Tool = {
  id: 'pen', title: 'Pen — new piece', group: 'pen', hotkey: 'P', icon: ICON.pen, cursor: 'crosshair',
  deactivate(app) { D = null; app.invalidate('canvas'); },
  busy: () => !!D,
  hint: () => D ? `Pen: ${D.pts.length} pts · click start to close · Enter close · Backspace undo pt · Esc cancel · right-click exact` : 'Pen: click = corner, drag = smooth, Ctrl = curve point, Shift = H/V/45°',

  down(app, p) {
    const e = p.e as PointerEvent;
    const w = resolveClick(app, p.w, e.shiftKey);
    if (!D) D = { pts: [], hover: null, drag: null };
    // close on start point
    if (D.pts.length >= 3) {
      const s0 = app.view.toScreen(D.pts[0]);
      if (Math.hypot(s0.x - p.s.x, s0.y - p.s.y) <= 9) { void commit(app); return; }
    }
    const curve = e.ctrlKey || e.metaKey;
    const a = curve ? makeAnchor(w.x, w.y, { kind: 'curve', smooth: true }) : makeAnchor(w.x, w.y);
    D.pts.push(a);
    D.drag = { a, start: p.w, moved: false };
    app.invalidate('canvas');
  },
  move(app, p) {
    if (!D) return;
    const e = p.e as PointerEvent;
    if (D.drag && (e.buttons & 1)) {
      const dd = D.drag;
      if (!dd.moved && Math.hypot(p.w.x - dd.start.x, p.w.y - dd.start.y) * app.view.scale < 4) return;
      dd.moved = true;
      let h = { x: p.w.x - dd.a.x, y: p.w.y - dd.a.y };
      if (e.shiftKey) { const c = constrain45(dd.a, p.w); h = { x: c.x - dd.a.x, y: c.y - dd.a.y }; }
      dd.a.smooth = true;
      dd.a.hOut = h;
      if (!e.altKey) dd.a.hIn = { x: -h.x, y: -h.y };
      app.status(`Handle ${fmt(Math.hypot(h.x, h.y))} ${unitLabel()}`);
    } else {
      D.hover = resolveClick(app, p.w, e.shiftKey);
      const last = D.pts[D.pts.length - 1];
      if (last) { const L = Math.hypot(D.hover.x - last.x, D.hover.y - last.y), ang = Math.atan2(D.hover.y - last.y, D.hover.x - last.x) * 180 / Math.PI; app.status(`L ${fmt(L)} ${unitLabel()} · ${ang.toFixed(1)}°`); }
    }
    app.invalidate('canvas');
  },
  up(_app) { if (D) D.drag = null; },
  context(app) { if (D && D.pts.length) { void exactNext(app); return true; } return false; },
  key(app, e) {
    if (!D) return false;
    if (e.key === 'Escape') { D = null; app.status('Pen cancelled'); app.invalidate('canvas'); return true; }
    if (e.key === 'Enter') { void commit(app); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { D.pts.pop(); if (!D.pts.length) D = null; app.invalidate('canvas'); return true; }
    return false;
  },
  overlay(app) {
    if (!D || !D.pts.length) return '';
    const pts = D.hover && !D.drag ? [...D.pts, makeAnchor(D.hover.x, D.hover.y, { id: 'hover' })] : D.pts;
    let s = `<path d="${draftScreenPath(app, pts, false)}" fill="none" stroke="#4ea1ff" stroke-width="1.6"/>`;
    for (const a of D.pts) {
      const sp = app.view.toScreen(a);
      s += screenMarker(sp, a.kind === 'grade' ? 'square' : 'circle', '#4ea1ff', 3.5);
      if (a.hIn || a.hOut) for (const h of [a.hIn, a.hOut]) if (h) { const hp = app.view.toScreen({ x: a.x + h.x, y: a.y + h.y }); s += `<line x1="${fs(sp.x)}" y1="${fs(sp.y)}" x2="${fs(hp.x)}" y2="${fs(hp.y)}" stroke="#d6309b"/><circle cx="${fs(hp.x)}" cy="${fs(hp.y)}" r="3" fill="#d6309b"/>`; }
    }
    if (D.pts.length >= 3) s += screenMarker(app.view.toScreen(D.pts[0]), 'ring', '#e67e22', 9);
    return s;
  },
};

