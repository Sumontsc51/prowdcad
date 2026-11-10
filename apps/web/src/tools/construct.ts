/**
 * Construction tools driven by kernel ops:
 *
 * Smooth (Shift+M): click the FIRST then the LAST point of a run (same contour) → live preview of
 *   ops.smoothRun; click intermediate points to keep them (toggle); right-click or Enter commits;
 *   Esc cancels. Max deviation is shown in the status bar.
 *
 * Slash (K): click points across a piece (snaps to points / outline; Shift = H/V/45°), Enter →
 *   dialog (zero / auto grade of the new cut points, seam on the new edges) → ops.slashPiece.
 *
 * Trace (Shift+T): click anchors (straight joins) and/or Alt-click two points of one contour to
 *   take the contour run between them; Enter → ops.traceSegments → new piece.
 */
import type { Vec, Id, SmoothPreview, TraceItem, Piece } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { anchorNear, pieceUnder, runWorld, screenPath } from '../hitkit';
import { ops } from '../ops-bridge';
import { toLocal, toWorld, constrain45, resolveFor } from '../geometry';
import { reportError } from '../commands';
import { rememberedDialog } from '../ui/dialog';
import { fmt, unitLabel } from '../units-ui';
import { fs, screenMarker, snapOutline } from './common';
import { snapPoint } from '../canvas/snap';
import { toast } from '../ui/toast';

// ───────────── Smooth ─────────────

interface SmoothS { pieceId: Id; contourId: Id; from: Id; to?: Id; keep: Set<Id>; preview?: SmoothPreview; err?: string }
let SM: SmoothS | null = null;

function recompute(app: App) {
  if (!SM?.to) return;
  try { SM.preview = ops.smoothRun(app.doc, SM.pieceId, SM.contourId, SM.from, SM.to, [...SM.keep]); SM.err = undefined; app.status(`Smooth: max deviation ${fmt(SM.preview.maxDeviation)} ${unitLabel()} · ${SM.keep.size} kept · right-click/Enter = apply · Esc = cancel`); }
  catch (err) { SM.preview = undefined; SM.err = (err as Error).message; app.status(`Smooth: ${SM.err}`); }
}
function commitSmooth(app: App) {
  if (!SM?.preview) { toast(SM?.err ?? 'Nothing to apply', 'warn'); return; }
  try { SM.preview.commit(); toast('Smoothed', 'ok'); } catch (err) { reportError(err, 'Smooth'); }
  SM = null; app.invalidate();
}

export const smoothTool: Tool = {
  id: 'smooth', title: 'Smooth run', group: 'pen', hotkey: 'Shift+M', icon: ICON.smooth, cursor: 'crosshair',
  activate() { SM = null; },
  deactivate(app) { SM = null; app.invalidate('canvas'); },
  busy: () => !!SM,
  hint: () => !SM ? 'Smooth: click the first point of the run' : !SM.to ? 'Smooth: click the last point of the run' : 'Smooth: click points to keep · right-click / Enter = apply · Esc = cancel',
  down(app, p) {
    const h = anchorNear(app, p.w, SM ? { pieceId: SM.pieceId, contourId: SM.contourId } : {});
    if (!h) return;
    if (!SM) { if (h.piece.locked) { toast('Piece is locked', 'warn'); return; } SM = { pieceId: h.piece.id, contourId: h.contour.id, from: h.anchor.id, keep: new Set() }; app.invalidate('canvas'); return; }
    if (!SM.to) { if (h.anchor.id === SM.from && !h.contour.closed) return; SM.to = h.anchor.id; recompute(app); app.invalidate('canvas'); return; }
    if (h.anchor.id === SM.from || h.anchor.id === SM.to) return;
    if (SM.keep.has(h.anchor.id)) SM.keep.delete(h.anchor.id); else SM.keep.add(h.anchor.id);
    recompute(app); app.invalidate('canvas');
  },
  context(app) { if (SM?.to) { commitSmooth(app); return true; } return !!SM; },
  key(app, e) {
    if (!SM) return false;
    if (e.key === 'Escape') { SM = null; app.status('Smooth cancelled'); app.invalidate('canvas'); return true; }
    if (e.key === 'Enter') { commitSmooth(app); return true; }
    return false;
  },
  overlay(app) {
    if (!SM) return '';
    const pc = app.doc.style.pieces.find(x => x.id === SM!.pieceId); if (!pc) return '';
    const c = [pc.sew, ...pc.internals].find(x => x.id === SM!.contourId); if (!c) return '';
    let s = '';
    if (SM.to) s += `<path d="${screenPath(app, runWorld(app, pc, c, SM.from, SM.to))}" fill="none" stroke="#ff9f1a" stroke-width="4" opacity="0.35"/>`;
    if (SM.preview) s += `<path d="${screenPath(app, SM.preview.polyline.map(q => toWorld(pc, q)))}" fill="none" stroke="#d6309b" stroke-width="2"/>`;
    const r = resolveFor(app.doc, pc, app.doc.baseSize(pc));
    const rc = c === pc.sew ? r.sew : r.internals[pc.internals.indexOf(c)];
    c.points.forEach((a, i) => {
      if (a.id === SM!.from || a.id === SM!.to || SM!.keep.has(a.id)) s += screenMarker(app.view.toScreen(toWorld(pc, rc.anchorPos[i])), 'square', SM!.keep.has(a.id) ? '#2ecc71' : '#ff9f1a', 6);
    });
    return s;
  },
};

// ───────────── Slash ─────────────

let SL: { pieceId: Id | null; pts: Vec[]; hover: Vec | null } | null = null;

/** The visible piece whose outline the world segment a→b crosses (a slash that starts outside a piece). */
function pieceCrossed(app: App, a: Vec, b: Vec): Piece | null {
  const cross = (p: Vec, q: Vec, r: Vec, s: Vec) => {
    const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x); if (Math.abs(d) < 1e-12) return false;
    const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d, u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  for (let k = app.doc.style.pieces.length - 1; k >= 0; k--) {
    const pc = app.doc.style.pieces[k]; if (app.hiddenPieces.has(pc.id)) continue;
    const pts = resolveFor(app.doc, pc, app.sizeOf(pc)).sew.pts.map(q => toWorld(pc, q));
    for (let i = 0; i < pts.length; i++) if (cross(a, b, pts[i], pts[(i + 1) % pts.length])) return pc;
  }
  return null;
}

function slashPoint(app: App, w: Vec, shift: boolean): Vec {
  if (SL && SL.pts.length && shift) return constrain45(SL.pts[SL.pts.length - 1], w);
  const s = snapPoint(app, w, { noGrid: true });
  if (s.kind === 'anchor') return s.p;
  if (SL?.pieceId) { const pc = app.doc.style.pieces.find(x => x.id === SL!.pieceId); if (pc) { const o = snapOutline(app, pc, w, 10); if (o) return o.world; } }
  return s.p;
}

async function commitSlash(app: App) {
  if (!SL || SL.pts.length < 2) { toast('Click at least two points across the piece', 'warn'); return; }
  if (!SL.pieceId) { toast('The slash does not cross a piece: click points across a piece', 'warn'); return; }
  const s = SL; SL = null; app.invalidate('canvas');
  const pc = app.doc.piece(s.pieceId!);
  const r = await rememberedDialog('slash', {
    title: `Slash ${pc.name}`, fields: [
      { kind: 'radio', key: 'grade', label: 'New cut points', value: 'auto', options: [{ value: 'auto', label: 'Auto grade (proportional)' }, { value: 'zero', label: 'Zero grade' }] },
      { kind: 'length', key: 'seam', label: 'Seam on new edges', value: pc.seamDefault, min: 0 },
    ],
  });
  if (!r) return;
  try {
    const ids = ops.slashPiece(app.doc, pc.id, s.pts.map(q => toLocal(pc, q)), { gradeMode: r.grade as 'auto' | 'zero', seam: r.seam as number });
    app.sel = { pieces: [...ids], anchors: [] };
    toast(`Slashed into ${ids.map(id => app.doc.piece(id).name).join(' + ')}`, 'ok');
  } catch (err) { reportError(err, 'Slash'); }
}

export const slashTool: Tool = {
  id: 'slash', title: 'Slash (cut piece)', group: 'cut', hotkey: 'K', icon: ICON.slash, cursor: 'crosshair',
  activate() { SL = null; },
  deactivate(app) { SL = null; app.invalidate('canvas'); },
  busy: () => !!SL,
  hint: () => SL ? `Slash: ${SL.pts.length} pt · click more points · Enter = cut · Backspace = undo point · Esc = cancel` : 'Slash: click the first point (on or outside the outline of a piece)',
  down(app, p) {
    const w = slashPoint(app, p.w, p.e.shiftKey);
    if (!SL) {
      // on, inside or OUTSIDE the outline (AccuMark): outside, the piece is the one the slash crosses next
      const pc = pieceUnder(app, p.w) ?? pieceUnder(app, w);
      if (pc?.locked) { toast('Piece is locked', 'warn'); return; }
      SL = { pieceId: pc?.id ?? null, pts: [w], hover: null };
      if (!pc) app.status('Slash starts outside a piece: click the next point across the piece');
      app.invalidate('canvas'); return;
    }
    if (!SL.pieceId) {
      const pc = pieceCrossed(app, SL.pts[SL.pts.length - 1], w) ?? pieceUnder(app, w);
      if (pc?.locked) { toast('Piece is locked', 'warn'); return; }
      if (pc) SL.pieceId = pc.id;
    }
    SL.pts.push(w); app.invalidate('canvas');
  },
  move(app, p) { if (SL) { SL.hover = slashPoint(app, p.w, p.e.shiftKey); app.invalidate('canvas'); } },
  context(app) { if (SL) { void commitSlash(app); return true; } return false; },
  key(app, e) {
    if (!SL) return false;
    if (e.key === 'Escape') { SL = null; app.invalidate('canvas'); return true; }
    if (e.key === 'Enter') { void commitSlash(app); return true; }
    if (e.key === 'Backspace') { SL.pts.pop(); if (!SL.pts.length) SL = null; app.invalidate('canvas'); return true; }
    return false;
  },
  overlay(app) {
    if (!SL) return '';
    const pts = [...SL.pts, ...(SL.hover ? [SL.hover] : [])];
    return `<path d="${screenPath(app, pts)}" fill="none" stroke="#e74c3c" stroke-width="1.6" stroke-dasharray="6 3"/>` + SL.pts.map(q => screenMarker(app.view.toScreen(q), 'circle', '#e74c3c', 3)).join('');
  },
};

// ───────────── Trace ─────────────

let TR: { items: TraceItem[]; pending: { pieceId: Id; contourId: Id; anchorId: Id } | null; hover: Vec | null } | null = null;

function traceWorld(app: App): Vec[] {
  if (!TR) return [];
  const out: Vec[] = [];
  for (const it of TR.items) {
    const pc = app.doc.style.pieces.find(x => x.id === it.pieceId); if (!pc) continue;
    if ('anchorId' in it) { const f = app.doc.findAnchor(pc, it.anchorId); if (f) { const r = resolveFor(app.doc, pc, app.sizeOf(pc)); const rc = f.contour === pc.sew ? r.sew : r.internals[pc.internals.indexOf(f.contour)]; out.push(toWorld(pc, rc.anchorPos[f.index])); } }
    else { const c = [pc.sew, ...pc.internals].find(x => x.id === (it.contourId ?? pc.sew.id)); if (c) out.push(...runWorld(app, pc, c, it.from, it.to, it.reverse)); }
  }
  return out;
}

async function commitTrace(app: App) {
  if (!TR || TR.items.length < 2) { toast('Trace needs at least 2 items (3 points or a run + a point)', 'warn'); return; }
  const items = TR.items; TR = null; app.invalidate('canvas');
  const r = await rememberedDialog('trace', { title: 'Trace → new piece', fields: [{ kind: 'text', key: '_name', label: 'Name', value: `TRACE ${app.style.pieces.length + 1}` }] });
  if (!r) return;
  try { const id = ops.traceSegments(app.doc, items, { name: String(r._name) }); app.sel = { pieces: [id], anchors: [] }; toast('Traced piece created', 'ok'); }
  catch (err) { reportError(err, 'Trace'); }
}

export const traceTool: Tool = {
  id: 'trace', title: 'Trace segments', group: 'cut', hotkey: 'Shift+T', icon: ICON.trace, cursor: 'crosshair',
  activate() { TR = null; },
  deactivate(app) { TR = null; app.invalidate('canvas'); },
  busy: () => !!TR,
  hint: () => TR?.pending ? 'Trace: Alt-click the END of the contour run (same contour; Shift+Alt = backwards)' : `Trace: click points (straight) · Alt-click two points of a contour = take the run · Enter = create${TR ? ` (${TR.items.length} items)` : ''} · Backspace · Esc`,
  down(app, p) {
    const h = anchorNear(app, p.w);
    if (!h) return;
    TR ??= { items: [], pending: null, hover: null };
    if (TR.pending) {
      if (h.piece.id !== TR.pending.pieceId || h.contour.id !== TR.pending.contourId) { toast('The run end must be on the same contour', 'warn'); return; }
      TR.items.push({ pieceId: h.piece.id, contourId: h.contour.id, from: TR.pending.anchorId, to: h.anchor.id, reverse: p.e.shiftKey || undefined });
      TR.pending = null;
    } else if (p.e.altKey) TR.pending = { pieceId: h.piece.id, contourId: h.contour.id, anchorId: h.anchor.id };
    else TR.items.push({ pieceId: h.piece.id, anchorId: h.anchor.id });
    app.invalidate('canvas');
  },
  move(app, p) { if (TR) { TR.hover = p.w; app.invalidate('canvas'); } },
  context(app) { if (TR) { void commitTrace(app); return true; } return false; },
  key(app, e) {
    if (!TR) return false;
    if (e.key === 'Escape') { TR = null; app.invalidate('canvas'); return true; }
    if (e.key === 'Enter') { void commitTrace(app); return true; }
    if (e.key === 'Backspace') { if (TR.pending) TR.pending = null; else TR.items.pop(); app.invalidate('canvas'); return true; }
    return false;
  },
  overlay(app) {
    if (!TR) return '';
    const pts = traceWorld(app);
    let s = `<path d="${screenPath(app, pts)}" fill="none" stroke="#16a085" stroke-width="2.2"/>`;
    if (TR.pending) { const pc = app.doc.style.pieces.find(x => x.id === TR!.pending!.pieceId); const f = pc && app.doc.findAnchor(pc, TR.pending.anchorId); if (pc && f) { const r = resolveFor(app.doc, pc, app.sizeOf(pc)); const rc = f.contour === pc.sew ? r.sew : r.internals[pc.internals.indexOf(f.contour)]; s += screenMarker(app.view.toScreen(toWorld(pc, rc.anchorPos[f.index])), 'square', '#16a085', 6); } }
    return s + `<text x="12" y="20" class="tool-note">${fs(TR.items.length)} item(s)</text>`;
  },
};
