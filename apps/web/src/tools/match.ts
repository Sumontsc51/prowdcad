/**
 * Match Line (J) — one set of lines takes the shape of another; every line keeps its own length.
 *
 *  Lay one piece on the other (or fold a piece) so the lines lie on each other, then:
 *  click the 1st line (Shift+click = more lines that follow it end to end)     → the shape to copy (green)
 *  click the 2nd line (Shift+click = more)                                     → the lines to change (blue), previewed live
 *  Enter or right-click                                                        → apply (one undo step)
 *  The 2nd lines start at their end that lies on the 1st, follow its shape for their own length, and their corner
 *  points move onto it. The 1st lines never change. Esc = step back.
 */
import type { App, SegSel } from '../app';
import { ICON, type Tool, type Ptr } from './tool';
import { ops } from '../ops-bridge';
import { lineNear, linePolyWorld } from '../hitkit';
import { previewWith, commitWith } from './move';
import { fs } from './common';
import { fmt, unitLabel } from '../units-ui';
import { toast } from '../ui/toast';

type Res = ReturnType<typeof ops.matchLines>;
const MT: { master: SegSel[]; target: SegSel[]; err: string; res: Res | null } = { master: [], target: [], err: '', res: null };
const same = (a: SegSel, b: SegSel) => a.pieceId === b.pieceId && a.contourId === b.contourId && a.from === b.from && a.to === b.to;
const tolOf = (app: App) => Math.max(3, app.view.px(10));
const ids = (l: SegSel[]) => [...new Set(l.map(g => g.pieceId))];
function prune(app: App) {
  const ok = (g: SegSel) => { const p = app.doc.style.pieces.find(x => x.id === g.pieceId); const c = p && (p.sew.id === g.contourId ? p.sew : p.internals.find(x => x.id === g.contourId)); return !!c && c.points.some(q => q.id === g.from) && c.points.some(q => q.id === g.to); };
  MT.master = MT.master.filter(ok); MT.target = MT.target.filter(ok);
}
function refresh(app: App) {
  prune(app); MT.err = ''; MT.res = null;
  if (!MT.master.length || !MT.target.length) { app.cancelPreview(); app.invalidate(); return; }
  const tol = tolOf(app);
  const err = previewWith(app, ids(MT.target), d => { MT.res = ops.matchLines(d, MT.master, MT.target, { tol }); });
  if (err) { MT.err = err; MT.res = null; }
  app.invalidate();
}
function apply(app: App) {
  if (!MT.master.length || !MT.target.length) { app.status('Match Line: pick the 1st line, then the 2nd'); return; }
  for (const id of ids(MT.target)) {
    const pc = app.doc.piece(id);
    if (pc.locked) { toast(`${pc.name} is locked`, 'warn'); return; }
    if (app.sizeOf(pc) !== app.doc.baseSize(pc)) { toast('Match Line works on the base size: switch to it (Ctrl+B)', 'warn'); return; }
  }
  const tol = tolOf(app); let res: Res | null = null;
  const master = MT.master, target = MT.target;
  if (!commitWith(app, ids(target), 'Match line', d => { res = ops.matchLines(d, master, target, { tol }); })) { refresh(app); return; }
  const r = res as Res | null;
  MT.target = []; MT.res = null; MT.err = '';
  app.status(r ? `Matched · ${target.length} line${target.length > 1 ? 's' : ''} now ${fmt(r.newLength)} ${unitLabel()} (was ${fmt(r.targetLength)}) on the shape of the 1st (${fmt(r.masterLength)})${r.dev > 0.3 ? ` · shape within ${fmt(r.dev)}` : ''} · click another 2nd line, or Esc` : 'Matched');
  app.invalidate();
}

export const matchTool: Tool = {
  id: 'match', title: 'Match Line', group: 'modify', hotkey: 'J', icon: ICON.match, cursor: 'crosshair',
  activate(app) { MT.master = []; MT.target = []; MT.err = ''; MT.res = null; app.invalidate(); },
  deactivate(app) { MT.master = []; MT.target = []; MT.err = ''; MT.res = null; app.cancelPreview(); app.invalidate('canvas'); },
  busy: () => MT.target.length > 0,
  hint(app) {
    prune(app);
    if (!MT.master.length) return 'Match Line · click the 1st line: the shape to copy (lay the pieces on each other first, or fold the piece) · Esc = Select';
    if (!MT.target.length) return `Match Line · 1st: ${MT.master.length} line${MT.master.length > 1 ? 's' : ''} (Shift+click = more) · now click the 2nd line: it takes that shape and keeps its own length · Esc = start again`;
    if (MT.err) return `Match Line · ⚠ ${MT.err} · Esc = pick the 2nd line again`;
    const r = MT.res;
    return `Match Line · 2nd: ${MT.target.length} line${MT.target.length > 1 ? 's' : ''}${r ? ` · length stays ${fmt(r.targetLength)} ${unitLabel()} (1st is ${fmt(r.masterLength)})${r.dev > 0.3 ? ` · shape within ${fmt(r.dev)}` : ''}` : ''} · Enter or right-click = apply · Shift+click = more lines · Esc = back`;
  },
  down(app, p: Ptr) {
    const e = p.e as MouseEvent;
    const ch = lineNear(app, p.w, { tolPx: 8 });
    if (!ch) { app.status('Click a line'); return; }
    const pts = ch.contour.points;
    const from = ch.from ?? pts[0].id, to = ch.to ?? pts[pts.length - 1].id;
    if (from === to) { app.status('This line has one grade point only: add a point (Cut Point) to split it into lines'); return; }
    const g: SegSel = { pieceId: ch.piece.id, contourId: ch.contour.id, from, to };
    app.sel = { pieces: [], anchors: [] }; app.liveSel = null;
    const toggle = (l: SegSel[]) => { const k = l.findIndex(x => same(x, g)); if (k >= 0) l.splice(k, 1); else l.push(g); };
    if (!MT.master.length) MT.master = [g];
    else if (e.shiftKey && !MT.target.length) toggle(MT.master);
    else if (MT.master.some(x => same(x, g))) { app.status('That line is the 1st line: click the line that should take its shape'); return; }
    else if (e.shiftKey) toggle(MT.target);
    else MT.target = [g];
    refresh(app);
  },
  context(app) { if (MT.target.length) { apply(app); return true; } return MT.master.length > 0; },
  key(app, e) {
    if (e.key === 'Enter') { apply(app); return true; }
    if (e.key !== 'Escape') return false;
    if (MT.target.length) { MT.target = []; refresh(app); return true; }
    if (MT.master.length) { MT.master = []; refresh(app); return true; }
    app.setTool('select'); return true;
  },
  overlay(app) {
    const path = (g: SegSel, col: string, w: number, dash = '') => {
      const q = linePolyWorld(app, g).map(v => app.view.toScreen(v)); if (q.length < 2) return '';
      return `<path d="M${q.map(v => `${fs(v.x)} ${fs(v.y)}`).join('L')}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
    };
    let s = '';
    for (const g of MT.master) s += path(g, '#2f9e44', 3.2).replace('/>', ' data-match="1st"/>');
    for (const g of MT.target) s += path(g, MT.err ? '#e03131' : '#3b7cff', 2.4, MT.err ? ' stroke-dasharray="6 4"' : '').replace('/>', ' data-match="2nd"/>');
    return s;
  },
};
