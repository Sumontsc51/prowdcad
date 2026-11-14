/**
 * Clip Line tool (Shift+I): clip internal lines to a segment of the outline and lock them on it.
 *
 *  hover a segment of the outline → every internal line that crosses it, or ends close to it, lights
 *                     up with a preview: red = the part that is cut off, green = the extension, ring =
 *                     where the end will sit.
 *  click the segment → those lines are clipped to it and the clipped ends are locked on the segment
 *                     (they follow it when it moves, changes length or grades).
 *  click an internal line → only that line is clipped, to every segment of the outline it crosses or
 *                     ends close to.
 *  right-click        → set the "close" distance (how near an end must be to be pulled onto the line).
 *  Esc = Select. One undo step per click. Unlock a line again with right-click ▸ Unlock (Select tool).
 */
import type { Vec, Piece, Contour, ClipEnd, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool, type Ptr } from './tool';
import { contourNear, runWorld, screenPath } from '../hitkit';
import { ops } from '../ops-bridge';
import { resolveFor, toWorld } from '../geometry';
import { fmt, unitLabel } from '../units-ui';
import { toast } from '../ui/toast';
import { reportError } from '../commands';
import { showDialog } from '../ui/dialog';
import { toolOpt, setToolOpt, label, screenPoly, arcPoly, totalLen } from './livekit';
import { fs, screenMarker } from './common';

const T = 'clip';
const COL = { seg: '#7b61ff', line: '#7b61ff', cut: '#e74c3c', ext: '#27ae60' };
interface Hov { piece: Piece; span?: { from: Id; to: Id }; contour?: Contour; plan: ClipEnd[] }
let H: Hov | null = null;

const tolMm = () => toolOpt(T, 'tol', 10);

function hoverAt(app: App, w: Vec): Hov | null {
  const h = contourNear(app, w, { contour: 'any' });
  if (!h) return null;
  const piece = h.piece, line = app.doc.sizeLine(piece);
  try {
    if (h.contour === piece.sew) {
      if (!h.from || !h.to) return null;
      const span = { from: h.from, to: h.to };
      return { piece, span, plan: ops.clipPlan(piece, line, { spans: [span], tol: tolMm() }) };
    }
    return { piece, contour: h.contour, plan: ops.clipPlan(piece, line, { contourIds: [h.contour.id], tol: tolMm() }) };
  } catch { return null; }
}

function commit(app: App, v: Hov) {
  if (v.piece.locked) { toast(`${v.piece.name} is locked`, 'warn'); return; }
  if (!v.plan.length) {
    toast(v.span ? `No internal line crosses this line or ends within ${fmt(tolMm())} ${unitLabel()} of it` : `This line does not cross the outline or end within ${fmt(tolMm())} ${unitLabel()} of it`, 'warn');
    return;
  }
  try {
    const r = ops.clipInternals(app.doc, v.piece.id, v.span ? { spans: [v.span], tol: tolMm() } : { contourIds: [v.contour!.id], tol: tolMm() });
    const parts = [r.trimmed ? `${r.trimmed} cut` : '', r.extended ? `${r.extended} extended` : '', r.locked ? `${r.locked} already on the line` : ''].filter(Boolean).join(' · ');
    toast(`Clip Line: ${r.lines} line${r.lines > 1 ? 's' : ''} clipped (${parts}) · 🔒 ${r.ends} end${r.ends > 1 ? 's' : ''} locked to the line`, 'ok');
  } catch (err) { reportError(err, 'Clip Line'); }
}

async function setDistance(app: App) {
  const r = await showDialog({
    title: 'Clip Line — close distance',
    fields: [{ kind: 'length', key: 'tol', label: 'Close distance', value: tolMm(), min: 0, hint: 'An internal line that ends within this distance of the clicked line is extended onto it. Lines that cross it are always cut.' }],
  });
  if (!r) return;
  setToolOpt(T, 'tol', Math.max(0, r.tol as number));
  H = null;
  app.invalidate();
}

export const clipTool: Tool = {
  id: 'clip', title: 'Clip Line (clip internal lines to a line and lock them)', group: 'clip', hotkey: 'Shift+I', icon: ICON.clip, cursor: 'crosshair',
  activate() { H = null; },
  deactivate(app) { H = null; app.invalidate('canvas'); },
  hint() {
    const d = `close distance ${fmt(tolMm())} ${unitLabel()}`;
    if (!H) return `Clip Line · click a line of the outline: internal lines that cross it or end close to it are clipped and locked to it · click an internal line = only that line · right-click = ${d} · Esc = Select`;
    const n = new Set(H.plan.map(p => p.contourId)).size;
    if (!n) return `Clip Line · nothing to clip here (${d}) · right-click = change the distance`;
    return `Clip Line · ${n} line${n > 1 ? 's' : ''} will be clipped and locked · click = clip · right-click = ${d}`;
  },
  move(app, p) { H = hoverAt(app, p.w); app.invalidate('canvas', 'status'); },
  down(app, p: Ptr) {
    const v = hoverAt(app, p.w);
    if (!v) { app.status('Clip Line: click a line of the outline, or an internal line'); return; }
    commit(app, v);
    H = hoverAt(app, p.w);
    app.invalidate();
  },
  context(app) { void setDistance(app); return true; },
  key(app, e) { if (e.key === 'Escape') { app.setTool('select'); return true; } return false; },
  overlay(app) {
    const v = H; if (!v) return '';
    const out: string[] = [];
    const piece = v.piece;
    const sid = app.sizeOf(piece);
    const rp = resolveFor(app.doc, piece, sid);
    const scr = (q: Vec) => app.view.toScreen(toWorld(piece, q));
    if (v.span) out.push(`<path d="${screenPath(app, runWorld(app, piece, piece.sew, v.span.from, v.span.to))}" stroke="${COL.seg}" stroke-width="4" opacity="0.45" fill="none" stroke-linecap="round"/>`);
    const base = sid === app.doc.baseSize(piece);
    const ids = [...new Set(v.plan.map(q => q.contourId))];
    for (const id of ids) {
      const ci = piece.internals.findIndex(c => c.id === id);
      const rc = rp.internals[ci]; if (!rc) continue;
      out.push(`<path d="${screenPoly(app, piece, rc.pts)}" stroke="${COL.line}" stroke-width="3" opacity="0.6" fill="none" stroke-linecap="round"/>`);
      if (!base) continue;
      for (const q of v.plan) {
        if (q.contourId !== id) continue;
        if (q.how === 'trim' && q.s !== undefined) {
          const L = totalLen(rc);
          const tail = q.end === 'start' ? arcPoly(rc, 0, q.s) : arcPoly(rc, q.s, L - q.s);
          out.push(`<path d="${screenPoly(app, piece, tail)}" stroke="${COL.cut}" stroke-width="3.5" stroke-dasharray="4 3" fill="none"/>`);
        } else if (q.how === 'extend') {
          const a = scr(q.tip), b = scr(q.pt);
          out.push(`<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="${COL.ext}" stroke-width="3" fill="none"/>`);
        }
        out.push(screenMarker(scr(q.pt), 'ring', q.how === 'trim' ? COL.cut : q.how === 'extend' ? COL.ext : COL.seg, 6));
      }
    }
    if (v.span || v.contour) {
      const at = v.plan[0] ? scr(v.plan[0].pt) : null;
      if (at) out.push(label({ x: at.x + 10, y: at.y - 10 }, `clip + lock · ${ids.length} line${ids.length > 1 ? 's' : ''}`, { col: COL.seg }));
    }
    return out.join('');
  },
};
