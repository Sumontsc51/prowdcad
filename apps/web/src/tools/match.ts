/**
 * Match Line (J) — one set of lines takes the shape of another; every line keeps its own length.
 *
 *  Lay one piece on the other (or fold a piece) so the lines lie on each other, then two steps:
 *  STEP 1 · click the 1st line(s): the shape to copy (green). Click a line again to take it out.
 *           Right-click ▸ OK (top of the menu), or Enter, or the OK button in the options strip.
 *  STEP 2 · click the 2nd line(s): the lines to change (blue), previewed live.
 *           Right-click ▸ OK, or Enter, or the OK button = apply (one undo step).
 *  The 2nd lines start at their end that lies on the 1st, follow its shape for their own length, and their corner
 *  points move onto it. The 1st lines never change. After applying, the 1st lines stay: pick the next 2nd line,
 *  or right-click ▸ Start again. Esc = one step back.
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
const MT: { step: 1 | 2; master: SegSel[]; target: SegSel[]; err: string; res: Res | null } = { step: 1, master: [], target: [], err: '', res: null };
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
/** OK of the current step: step 1 → on to the 2nd lines; step 2 → apply. */
function ok(app: App) {
  prune(app);
  if (MT.step === 1) {
    if (!MT.master.length) { toast('Match Line: click the 1st line first', 'warn'); return; }
    MT.step = 2; MT.target = [];
    app.status(`1st: ${MT.master.length} line${MT.master.length > 1 ? 's' : ''} ✓ · step 2: click the line(s) that should take that shape, then right-click ▸ OK`);
    refresh(app); return;
  }
  if (!MT.target.length) { toast('Match Line: click the 2nd line first', 'warn'); return; }
  apply(app);
}
function restart(app: App) { MT.step = 1; MT.master = []; MT.target = []; refresh(app); app.status('Match Line · step 1: click the 1st line(s)'); }
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
  app.status(r ? `Matched · ${target.length} line${target.length > 1 ? 's' : ''} now ${fmt(r.newLength)} ${unitLabel()} (was ${fmt(r.targetLength)}) on the shape of the 1st (${fmt(r.masterLength)})${r.dev > 0.3 ? ` · shape within ${fmt(r.dev)}` : ''} · the 1st line stays: click the next 2nd line, or right-click ▸ Start again` : 'Matched');
  app.invalidate();
}

export const matchTool: Tool = {
  id: 'match', title: 'Match Line', group: 'modify', hotkey: 'J', icon: ICON.match, cursor: 'crosshair',
  activate(app) { MT.step = 1; MT.master = []; MT.target = []; MT.err = ''; MT.res = null; app.invalidate(); },
  deactivate(app) { MT.step = 1; MT.master = []; MT.target = []; MT.err = ''; MT.res = null; app.cancelPreview(); app.invalidate('canvas'); },
  busy: () => MT.target.length > 0,
  // the two steps, shown in the options strip (click a step to go to it)
  modes: () => [
    { id: '1', label: `1 · First line${MT.master.length ? ` (${MT.master.length})` : ''}`, title: 'Step 1: click the line(s) whose shape is copied, then OK' },
    { id: '2', label: `2 · Second line${MT.target.length ? ` (${MT.target.length})` : ''}`, title: 'Step 2: click the line(s) that take that shape and keep their length, then OK' },
  ],
  mode: () => String(MT.step),
  setMode(app, id) { if (id === '2') { if (MT.step === 1) ok(app); } else { MT.step = 1; MT.target = []; refresh(app); } },
  toggles: () => [
    { id: 'ok', label: MT.step === 1 ? 'OK ✓ 1st line done' : 'OK ✓ match', title: 'The same as right-click ▸ OK, or Enter', on: false },
    { id: 'restart', label: 'Start again', title: 'Forget both selections and pick a new 1st line', on: false },
  ],
  toggle(app, id) { if (id === 'ok') ok(app); else restart(app); },
  // right-click: OK on top of the menu, above “Select tool”
  menu: app => [
    { label: MT.step === 1 ? `OK  ·  1st line done${MT.master.length ? ` (${MT.master.length})` : ''} → pick the 2nd` : `OK  ·  match the 2nd line${MT.target.length > 1 ? 's' : ''} to the 1st`, run: () => ok(app) },
    ...(MT.step === 2 || MT.master.length ? [{ label: 'Start again (new 1st line)', run: () => restart(app) }] : []),
  ],
  hint(app) {
    prune(app);
    if (MT.step === 1) return MT.master.length
      ? `Match Line · STEP 1 · ${MT.master.length} line${MT.master.length > 1 ? 's' : ''} picked (green) · click more lines, or a picked line to take it out · right-click ▸ OK (or Enter) when the 1st selection is complete · Esc = clear`
      : 'Match Line · STEP 1 · click the 1st line: the shape to copy (lay the pieces on each other first, or fold the piece) · then right-click ▸ OK · Esc = Select';
    if (!MT.target.length) return `Match Line · STEP 2 · 1st: ${MT.master.length} line${MT.master.length > 1 ? 's' : ''} ✓ · now click the 2nd line(s): they take that shape and keep their own length · then right-click ▸ OK · Esc = back to step 1`;
    if (MT.err) return `Match Line · STEP 2 · ⚠ ${MT.err} · click the line again to take it out · Esc = back to step 1`;
    const r = MT.res;
    return `Match Line · STEP 2 · ${MT.target.length} line${MT.target.length > 1 ? 's' : ''} picked (blue, previewed)${r ? ` · length stays ${fmt(r.targetLength)} ${unitLabel()} (1st is ${fmt(r.masterLength)})${r.dev > 0.3 ? ` · shape within ${fmt(r.dev)}` : ''}` : ''} · right-click ▸ OK (or Enter) = apply · Esc = back to step 1`;
  },
  down(app, p: Ptr) {
    const ch = lineNear(app, p.w, { tolPx: 8 });
    if (!ch) { app.status('Click a line'); return; }
    const pts = ch.contour.points;
    const from = ch.from ?? pts[0].id, to = ch.to ?? pts[pts.length - 1].id;
    if (from === to) { app.status('This line has one grade point only: add a point (Cut Point) to split it into lines'); return; }
    const g: SegSel = { pieceId: ch.piece.id, contourId: ch.contour.id, from, to };
    app.sel = { pieces: [], anchors: [] }; app.liveSel = null;
    // every click adds the line to the selection of the current step; a picked line clicked again is taken out
    const toggle = (l: SegSel[]) => { const k = l.findIndex(x => same(x, g)); if (k >= 0) l.splice(k, 1); else l.push(g); };
    if (MT.step === 1) toggle(MT.master);
    else if (MT.master.some(x => same(x, g))) { app.status('That line is a 1st line: click the line that should take its shape'); return; }
    else toggle(MT.target);
    refresh(app);
  },
  // right-click opens the menu, with OK on top
  context() { return false; },
  key(app, e) {
    if (e.key === 'Enter') { ok(app); return true; }
    if (e.key !== 'Escape') return false;
    if (MT.step === 2) { MT.step = 1; MT.target = []; refresh(app); app.status('Match Line · back to step 1'); return true; }
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
