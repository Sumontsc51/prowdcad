/**
 * Clip Line tool (Shift+I): make one internal line end exactly on another line.
 *
 *  1st click  the internal line to change, near the end that should move.
 *  2nd click  the line to clip to: a line of the outline or another internal line of the same piece.
 *             The 1st line is cut back to it when it crosses it (red in the preview), or extended
 *             straight onto it when it stops short (green). The 2nd line never changes.
 *  Nothing is locked. To lock: Select tool, pick one or several internal lines, right-click ▸
 *  Lock internal to segment… (an end on the outline is then attached to it).
 *  Right-click or Esc = drop the 1st line · Esc again = Select. One undo step per clip.
 */
import type { Vec, Piece, Contour, ClipToPlan, ClipTarget } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool, type Ptr } from './tool';
import { contourNear, runWorld, screenPath, type ContourHit } from '../hitkit';
import { ops } from '../ops-bridge';
import { resolveFor, toWorld } from '../geometry';
import { fmt, unitLabel } from '../units-ui';
import { toast } from '../ui/toast';
import { reportError } from '../commands';
import { label, screenPoly, arcPoly, totalLen } from './livekit';
import { fs, screenMarker } from './common';

const COL = { first: '#7b61ff', target: '#2e86c1', cut: '#e74c3c', ext: '#27ae60' };
interface First { piece: Piece; contour: Contour; near: Vec }
interface Second { hit: ContourHit; target: ClipTarget; plan: ClipToPlan | null }
let F: First | null = null;       // 1st line (picked)
let HF: ContourHit | null = null; // hover while picking the 1st line
let H2: Second | null = null;     // hover while picking the 2nd line

const clippable = (c: Contour) => !c.closed && c.points.length >= 2;
const live = (app: App, f: First): First | null => {
  const piece = app.doc.style.pieces.find(p => p.id === f.piece.id);
  const contour = piece?.internals.find(c => c.id === f.contour.id);
  return piece && contour ? { piece, contour, near: f.near } : null;
};

function firstAt(app: App, w: Vec): ContourHit | null {
  const h = contourNear(app, w, { contour: 'internal' });
  return h && clippable(h.contour) ? h : null;
}

/** The line under the cursor to clip to: outline segment or another internal of the same piece. */
function secondAt(app: App, f: First, w: Vec): Second | null {
  let best: ContourHit | null = contourNear(app, w, { contour: 'sew', pieceId: f.piece.id });
  for (const c of f.piece.internals) {
    if (c.id === f.contour.id) continue;
    const h = contourNear(app, w, { contour: 'internal', pieceId: f.piece.id, contourId: c.id });
    if (h && (!best || h.dpx < best.dpx)) best = h;
  }
  if (!best) return null;
  const isSew = best.contour === f.piece.sew;
  const target: ClipTarget = isSew && best.from && best.to ? { contourId: best.contour.id, span: { from: best.from, to: best.to } } : { contourId: best.contour.id };
  let plan: ClipToPlan | null = null;
  try { plan = ops.clipToPlan(f.piece, app.doc.sizeLine(f.piece), f.contour.id, target, { near: f.near }); } catch { plan = null; }
  return { hit: best, target, plan };
}

function commit(app: App, f: First, s: Second) {
  if (f.piece.locked) { toast(`${f.piece.name} is locked`, 'warn'); return; }
  try {
    const r = ops.clipLineTo(app.doc, f.piece.id, f.contour.id, s.target, { near: f.near });
    app.applySel({ k: 'internal', c: { pieceId: f.piece.id, contourId: f.contour.id } }, 'replace');
    toast(`Clip Line: line ${r.how === 'trim' ? 'cut back' : 'extended'} ${fmt(Math.abs(r.delta))} ${unitLabel()} to the 2nd line · not locked (Select ▸ right-click the line ▸ Lock)`, 'ok');
  } catch (err) { reportError(err, 'Clip Line'); }
}

function reset(app: App) { F = null; HF = null; H2 = null; app.invalidate('canvas', 'status'); }

export const clipTool: Tool = {
  id: 'clip', title: 'Clip Line (cut or extend an internal line to another line)', group: 'pen', hotkey: 'Shift+I', icon: ICON.clip, cursor: 'crosshair',
  activate() { F = null; HF = null; H2 = null; },
  deactivate(app) { reset(app); },
  busy: () => !!F,
  hint() {
    if (!F) return 'Clip Line · 1st: click the internal line to change, near the end that should move · Esc = Select';
    if (!H2) return 'Clip Line · 2nd: click the line to clip to (outline line or another internal line) · right-click / Esc = drop the 1st line';
    if (!H2.plan) return 'Clip Line · the 1st line does not cross this line and does not reach it when extended';
    return `Clip Line · click = ${H2.plan.how === 'trim' ? 'cut back' : 'extend'} ${fmt(Math.abs(H2.plan.delta))} ${unitLabel()} · the line is not locked`;
  },
  move(app, p) {
    if (F) { const f = live(app, F); if (!f) { reset(app); return; } F = f; H2 = secondAt(app, f, p.w); }
    else HF = firstAt(app, p.w);
    app.invalidate('canvas', 'status');
  },
  down(app, p: Ptr) {
    if (!F) {
      const h = firstAt(app, p.w);
      if (!h) { app.status('Clip Line: click an open internal line first'); return; }
      if (h.piece.locked) { toast(`${h.piece.name} is locked`, 'warn'); return; }
      F = { piece: h.piece, contour: h.contour, near: h.local }; HF = null; H2 = null;
      app.invalidate('canvas', 'status'); return;
    }
    const f = live(app, F); if (!f) { reset(app); return; }
    const s = secondAt(app, f, p.w);
    if (!s) { app.status('Clip Line: click the line to clip to (an outline line or another internal line of the same piece)'); return; }
    if (!s.plan) { toast('The 1st line does not cross this line and does not reach it when extended', 'warn'); return; }
    commit(app, f, s);
    F = null; H2 = null; HF = null;
    app.invalidate();
  },
  context(app) { if (F) { reset(app); return true; } return false; },
  key(app, e) {
    if (e.key !== 'Escape') return false;
    if (F) reset(app); else app.setTool('select');
    return true;
  },
  overlay(app) {
    const out: string[] = [];
    const line = (piece: Piece, c: Contour, col: string, w = 3, op = 0.6) => {
      const rc = resolveFor(app.doc, piece, app.sizeOf(piece)).internals[piece.internals.indexOf(c)];
      if (rc) out.push(`<path d="${screenPoly(app, piece, rc.pts)}" stroke="${col}" stroke-width="${w}" opacity="${op}" fill="none" stroke-linecap="round"/>`);
      return rc;
    };
    if (!F) {
      if (HF) {
        const rc = line(HF.piece, HF.contour, COL.first);
        if (rc) { const L = totalLen(rc); const e = HF.s <= L / 2 ? rc.pts[0] : rc.pts[rc.pts.length - 1]; out.push(screenMarker(app.view.toScreen(toWorld(HF.piece, e)), 'ring', COL.first, 7)); }
      }
      return out.join('');
    }
    const piece = F.piece;
    const scr = (q: Vec) => app.view.toScreen(toWorld(piece, q));
    const rc = line(piece, F.contour, COL.first, 3.5, 0.7);
    if (rc) { const a = scr(rc.pts[0]); out.push(label({ x: a.x + 8, y: a.y - 8 }, '1st', { col: COL.first })); }
    if (!H2) return out.join('');
    const tc = H2.hit.contour;
    if (tc === piece.sew && H2.target.span) out.push(`<path d="${screenPath(app, runWorld(app, piece, piece.sew, H2.target.span.from, H2.target.span.to))}" stroke="${COL.target}" stroke-width="4" opacity="0.5" fill="none" stroke-linecap="round"/>`);
    else if (tc !== piece.sew) line(piece, tc, COL.target, 4, 0.5);
    const q = H2.plan;
    const hw = H2.hit.world; const hs = app.view.toScreen(hw);
    if (!q) { out.push(label({ x: hs.x + 10, y: hs.y - 10 }, 'does not reach', { col: COL.cut })); return out.join(''); }
    if (rc && app.sizeOf(piece) === app.doc.baseSize(piece)) {
      if (q.how === 'trim' && q.s !== undefined) {
        const L = totalLen(rc);
        const tail = q.end === 'start' ? arcPoly(rc, 0, q.s) : arcPoly(rc, q.s, L - q.s);
        out.push(`<path d="${screenPoly(app, piece, tail)}" stroke="${COL.cut}" stroke-width="3.5" stroke-dasharray="4 3" fill="none"/>`);
      } else {
        const a = scr(q.tip), b = scr(q.pt);
        out.push(`<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="${COL.ext}" stroke-width="3" fill="none"/>`);
      }
      const at = scr(q.pt);
      out.push(screenMarker(at, 'ring', q.how === 'trim' ? COL.cut : COL.ext, 6));
      out.push(label({ x: at.x + 10, y: at.y - 10 }, `${q.how === 'trim' ? '−' : '+'}${fmt(Math.abs(q.delta))} ${unitLabel()}`, { col: q.how === 'trim' ? COL.cut : COL.ext }));
    }
    return out.join('');
  },
};
