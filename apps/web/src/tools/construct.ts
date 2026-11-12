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
import { anchorNear, pieceUnder, runWorld, screenPath, contourNear } from '../hitkit';
import { scratchDoc } from './move';
import { ops } from '../ops-bridge';
import { toLocal, toWorld, constrain45, resolveFor, pieceWorldBox } from '../geometry';
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
  id: 'smooth', title: 'Smooth run', group: 'smooth', hotkey: 'Shift+M', icon: ICON.smooth, cursor: 'crosshair',
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

// ───────────── Trace Piece ─────────────
//
// Click the lines that make up the new outline, one after another, clockwise or counter-clockwise. A line is
// the part of an outline or internal line between its nearest breaks: grade points, line ends and the places
// where another line of the piece meets or crosses it. Right-click a picked line (or Enter) creates the piece.
// The source piece and its lines are not changed.

interface TPick { pieceId: Id; contourId: Id; s0: number; s1: number; full: boolean; p0: Vec; p1: Vec; world: Vec[] }
let TR: { picks: TPick[] } | null = null;
let TRH: TPick | null = null;

const cross2 = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
/** Arc positions on `poly` (with cumulative lengths) where the polyline `other` crosses it or ends on it. */
function meetArcs(poly: Vec[], cum: number[], other: Vec[], otherClosed: boolean, tol = 0.5): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], ab = { x: poly[i + 1].x - a.x, y: poly[i + 1].y - a.y }; const l = Math.hypot(ab.x, ab.y); if (l < 1e-9) continue;
    for (let j = 0; j + 1 < other.length; j++) {
      const c = other[j], cd = { x: other[j + 1].x - c.x, y: other[j + 1].y - c.y };
      const den = cross2(ab, cd); if (Math.abs(den) < 1e-12) continue;
      const ac = { x: c.x - a.x, y: c.y - a.y };
      const t = cross2(ac, cd) / den, u = cross2(ac, ab) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push(cum[i] + t * l);
    }
    if (!otherClosed) for (const e of [other[0], other[other.length - 1]]) {
      const t = Math.max(0, Math.min(1, ((e.x - a.x) * ab.x + (e.y - a.y) * ab.y) / (l * l)));
      if (Math.hypot(a.x + ab.x * t - e.x, a.y + ab.y * t - e.y) < tol) out.push(cum[i] + t * l);
    }
  }
  return out;
}
/** The pickable line under the cursor: the stretch of the contour between its two nearest breaks. */
function tracePick(app: App, w: Vec): TPick | string | null {
  const ch = contourNear(app, w, { tolPx: 8 }); if (!ch) return null;
  const pc = ch.piece;
  if (app.sizeOf(pc) !== app.doc.baseSize(pc)) return 'Trace Piece works on the base size: switch to the base size (Ctrl+B)';
  const res = resolveFor(app.doc, pc, app.doc.baseSize(pc));
  const all = [{ c: pc.sew, rc: res.sew }, ...pc.internals.map((c, k) => ({ c, rc: res.internals[k] }))].filter(x => x.rc && x.rc.pts.length > 1);
  const me = all.find(x => x.c.id === ch.contour.id); if (!me) return null;
  const rc = me.rc, closed = rc.closed;
  const poly = closed ? [...rc.pts, rc.pts[0]] : rc.pts;
  const cum = [0]; for (let k = 1; k < poly.length; k++) cum.push(cum[k - 1] + Math.hypot(poly[k].x - poly[k - 1].x, poly[k].y - poly[k - 1].y));
  const L = cum[cum.length - 1]; if (L < 1e-6) return null;
  let br: number[] = closed ? [] : [0, L];
  if (me.c === pc.sew) for (const gi of rc.gradeIdx) br.push(cum[rc.anchorIndex[gi]]);
  for (const o of all) if (o !== me) br.push(...meetArcs(poly, cum, o.rc.closed ? [...o.rc.pts, o.rc.pts[0]] : o.rc.pts, o.rc.closed));
  br = br.map(x => (closed ? ((x % L) + L) % L : Math.max(0, Math.min(L, x)))).sort((x, y) => x - y).filter((x, k, arr) => k === 0 || x - arr[k - 1] > 0.3);
  if (closed && br.length > 1 && br[0] + L - br[br.length - 1] < 0.3) br.pop();
  const s = ch.s;
  let s0: number, s1: number, full = false;
  if (!br.length) { s0 = 0; s1 = L; full = true; }
  else if (closed) {
    const after = br.find(x => x > s) ?? br[0] + L; const before = [...br].reverse().find(x => x <= s) ?? br[br.length - 1] - L;
    s0 = before; s1 = after; if (s1 - s0 >= L - 1e-6) { s0 = br[0]; s1 = br[0] + L; full = true; }
  } else { s0 = [...br].reverse().find(x => x <= s) ?? 0; s1 = br.find(x => x > s) ?? L; }
  const at = (x: number): Vec => { x = closed ? ((x % L) + L) % L : x; let e = 0; while (e < cum.length - 2 && cum[e + 1] < x) e++; const l = cum[e + 1] - cum[e]; const t = l < 1e-12 ? 0 : (x - cum[e]) / l; return { x: poly[e].x + (poly[e + 1].x - poly[e].x) * t, y: poly[e].y + (poly[e + 1].y - poly[e].y) * t }; };
  const pts: Vec[] = [at(s0)];
  for (let lap = 0; lap < 2; lap++) for (let k = 0; k < poly.length - (closed ? 1 : 0); k++) { const x = cum[k] + lap * L; if (x > s0 + 1e-9 && x < s1 - 1e-9) pts.push(poly[k]); }
  pts.push(at(s1));
  return { pieceId: pc.id, contourId: ch.contour.id, s0, s1, full, p0: pts[0], p1: pts[pts.length - 1], world: pts.map(q => toWorld(pc, q)) };
}
const samePick = (a: TPick, b: TPick) => a.pieceId === b.pieceId && a.contourId === b.contourId && Math.abs(a.s0 - b.s0) < 0.01 && Math.abs(a.s1 - b.s1) < 0.01;
const gap = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
/** Order and direction of the picked lines as one outline; the largest gap between neighbours (0 = closed). */
function traceChain(picks: TPick[]): { order: { p: TPick; rev: boolean }[]; maxGap: number } {
  if (picks.length === 1) return { order: [{ p: picks[0], rev: false }], maxGap: picks[0].full ? 0 : gap(picks[0].world[0], picks[0].world[picks[0].world.length - 1]) };
  const ends = (p: TPick, rev: boolean) => rev ? [p.world[p.world.length - 1], p.world[0]] : [p.world[0], p.world[p.world.length - 1]];
  let best: { order: { p: TPick; rev: boolean }[]; maxGap: number; sum: number } | null = null;
  for (const rev0 of [false, true]) {
    const order = [{ p: picks[0], rev: rev0 }]; const left = picks.slice(1); let tail = ends(picks[0], rev0)[1]; let mx = 0, sum = 0;
    while (left.length) {
      let bi = 0, br = false, bd = Infinity;
      left.forEach((q, k) => { for (const r of [false, true]) { const d = gap(tail, ends(q, r)[0]); if (d < bd) { bd = d; bi = k; br = r; } } });
      const q = left.splice(bi, 1)[0]; order.push({ p: q, rev: br }); tail = ends(q, br)[1]; mx = Math.max(mx, bd); sum += bd;
    }
    const close = gap(tail, ends(picks[0], rev0)[0]); mx = Math.max(mx, close); sum += close;
    if (!best || sum < best.sum) best = { order, maxGap: mx, sum };
  }
  return best!;
}

async function commitTrace(app: App) {
  if (!TR || !TR.picks.length) return;
  const picks = TR.picks;
  const { order, maxGap } = traceChain(picks);
  if (picks.length === 1 && !picks[0].full) { toast('Pick the other lines of the outline too, then right-click a picked line', 'warn'); return; }
  const r = await rememberedDialog('trace', {
    title: 'Trace → new piece',
    message: maxGap > 1 ? `The picked lines do not meet everywhere (largest gap ${fmt(maxGap)} ${unitLabel()}): the gaps are closed with straight lines.` : undefined,
    fields: [{ kind: 'text', key: '_name', label: 'Name', value: `TRACE ${app.style.pieces.length + 1}` }],
  });
  if (!r) return;
  try {
    const srcIds = [...new Set(picks.map(p => p.pieceId))];
    const d = scratchDoc(app, srcIds);
    // on the copy: make sure a point exists at both ends of every picked line, then trace the runs
    const anchorAt = (pieceId: Id, contourId: Id, q: Vec): Id => {
      const pc = d.piece(pieceId); const c = [pc.sew, ...pc.internals].find(x => x.id === contourId)!;
      // base coordinates straight from the points (the resolve cache does not know the scratch copy changed)
      const k = c.points.findIndex(a => Math.hypot(a.x - q.x, a.y - q.y) < 0.05);
      return k >= 0 ? c.points[k].id : ops.addPointAt(d, pieceId, contourId, q, 'grade');
    };
    const items: TraceItem[] = [];
    for (const { p, rev } of order) {
      if (p.full) { const pc = d.piece(p.pieceId); const c = [pc.sew, ...pc.internals].find(x => x.id === p.contourId)!; items.push({ pieceId: p.pieceId, contourId: p.contourId, from: c.points[0].id, to: c.points[0].id }); continue; }
      const a = anchorAt(p.pieceId, p.contourId, p.p0), b = anchorAt(p.pieceId, p.contourId, p.p1);
      items.push(rev ? { pieceId: p.pieceId, contourId: p.contourId, from: b, to: a, reverse: true } : { pieceId: p.pieceId, contourId: p.contourId, from: a, to: b });
    }
    const nid = ops.traceSegments(d, items, { name: String(r._name) });
    const np = JSON.parse(JSON.stringify(d.piece(nid))) as Piece;
    // lines that meet on a curve are a hair apart: join points closer than 0.05 mm into one
    { const P = np.sew.points; for (let k = P.length - 1; k >= 0 && P.length > 3; k--) { const a = P[(k - 1 + P.length) % P.length], b = P[k]; if (a !== b && Math.hypot(a.x - b.x, a.y - b.y) < 0.05) { if (b.hOut) a.hOut = b.hOut; else delete a.hOut; if (b.flags?.startPoint) a.flags.startPoint = true; P.splice(k, 1); } } }
    // beside the source piece, same orientation
    const src = app.doc.piece(srcIds[0]); const box = pieceWorldBox(app.doc, src, app.sizeOf(src));
    const L = src.layout ?? { x: 0, y: 0, angleDeg: 0 };
    np.layout = { ...L, x: L.x + (box.maxX - box.minX) + 40 };
    app.doc.transact('Trace piece', st => { st.pieces.push(np); });
    TR = null; TRH = null;
    app.sel = { pieces: [np.id], anchors: [] };
    toast(`Piece “${np.name}” created from ${picks.length} line${picks.length > 1 ? 's' : ''} (placed beside the original)`, 'ok');
  } catch (err) { reportError(err, 'Trace piece'); }
  app.invalidate();
}

export const traceTool: Tool = {
  id: 'trace', title: 'Trace Piece', group: 'trace', hotkey: 'Shift+T', icon: ICON.trace, cursor: 'crosshair',
  activate() { TR = null; TRH = null; },
  deactivate(app) { TR = null; TRH = null; app.invalidate('canvas'); },
  busy: () => !!TR?.picks.length,
  hint: () => {
    const n = TR?.picks.length ?? 0;
    if (!n) return 'Trace Piece: click the lines of the new outline one after another (clockwise or counter-clockwise; outline and internal lines) · Esc = Select';
    const g = traceChain(TR!.picks).maxGap;
    return `Trace Piece: ${n} line${n > 1 ? 's' : ''} picked · ${g < 1 ? 'outline closed' : `not closed yet (gap ${fmt(g)} ${unitLabel()})`} · click more lines (click a picked line again to drop it) · right-click a picked line or Enter = create the piece · Backspace · Esc`;
  },
  down(app, p) {
    const pk = tracePick(app, p.w);
    if (typeof pk === 'string') { toast(pk, 'warn'); return; }
    if (!pk) { app.status('Trace Piece: click on a line (outline or internal line)'); return; }
    TR ??= { picks: [] };
    const k = TR.picks.findIndex(q => samePick(q, pk));
    if (k >= 0) TR.picks.splice(k, 1); else TR.picks.push(pk);
    if (!TR.picks.length) TR = null;
    app.invalidate('canvas', 'status');
  },
  move(app, p) {
    const pk = tracePick(app, p.w); const h = pk && typeof pk !== 'string' ? pk : null;
    if ((h && !TRH) || (!h && TRH) || (h && TRH && !samePick(h, TRH))) { TRH = h; app.invalidate('canvas'); }
  },
  context(app, p) {
    if (!TR?.picks.length) return false;
    const pk = tracePick(app, p.w);
    if (pk && typeof pk !== 'string' && TR.picks.some(q => samePick(q, pk))) { void commitTrace(app); return true; }
    return false; // elsewhere: the canvas menu
  },
  key(app, e) {
    if (!TR) return false;
    if (e.key === 'Escape') { TR = null; app.invalidate('canvas'); return true; }
    if (e.key === 'Enter') { void commitTrace(app); return true; }
    if (e.key === 'Backspace') { TR.picks.pop(); if (!TR.picks.length) TR = null; app.invalidate('canvas'); return true; }
    return false;
  },
  overlay(app) {
    let s = '';
    if (TRH && !(TR?.picks.some(q => samePick(q, TRH!)))) s += `<path d="${screenPath(app, TRH.world)}" fill="none" stroke="#16a085" stroke-width="3" opacity="0.4"/>`;
    if (!TR) return s;
    TR.picks.forEach((q, k) => {
      s += `<path d="${screenPath(app, q.world)}" fill="none" stroke="#16a085" stroke-width="3" data-trace-pick="1"/>`;
      const m = app.view.toScreen(q.world[Math.floor(q.world.length / 2)]);
      s += `<circle cx="${fs(m.x)}" cy="${fs(m.y)}" r="8" fill="#16a085"/><text x="${fs(m.x)}" y="${fs(m.y + 3.5)}" text-anchor="middle" font-size="10" fill="#fff">${k + 1}</text>`;
    });
    return s;
  },
};
