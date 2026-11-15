/**
 * Edit Grade (E) — the grading tool, after AccuMark Grade ▸ Edit Delta.
 *
 *  click a grade point   it is selected and the Grading table window shows its dX / dY for every size;
 *                        type there, or use Calculate (halve, double, constant) and Smart fill.
 *  Shift+click / drag a box = several points (one column pair each in the table).
 *  The options strip covers the rest of the grading work: pick what a click does —
 *    Copy · Paste · Paste X · Paste Y · Flip X · Flip Y · Clear · Stack —
 *  then click a point (or drag a box over points). After Copy the tool switches to Paste.
 *  Buttons: Nested view · Totals / Steps · Rules… · By measure… · Proportional… · Angle…
 *  Esc = back to Edit Grade, Esc again = Select.
 */
import type { Vec } from '@prowdcad/kernel';
import type { App, SelItem } from '../app';
import { ICON, type Tool, type Ptr } from './tool';
import { anchorNear, type AnchorHit } from '../hitkit';
import { gatherInBox } from '../selpick';
import { runCommand } from '../commands';
import { settings, saveSettings } from '../settings';
import { toolOpt, setToolOpt } from './livekit';
import { fs, screenMarker } from './common';
import { toast } from '../ui/toast';

const T = 'grade';
type GMode = 'edit' | 'copy' | 'paste' | 'pasteX' | 'pasteY' | 'flipX' | 'flipY' | 'zero' | 'stack';
const MODES: { id: GMode; label: string; title: string; cmd?: string }[] = [
  { id: 'edit', label: 'Edit Grade', title: 'Click a grade point: its dX / dY for every size open in the Grading table. Shift+click or drag a box = several points.' },
  { id: 'copy', label: 'Copy', title: 'Click a point (or box several): its grading is copied. The tool then switches to Paste.', cmd: 'grade.copy' },
  { id: 'paste', label: 'Paste', title: 'Click a point (or box several): the copied grading is pasted', cmd: 'grade.paste' },
  { id: 'pasteX', label: 'Paste X', title: 'Paste only the X growth of the copied grading', cmd: 'grade.pasteX' },
  { id: 'pasteY', label: 'Paste Y', title: 'Paste only the Y growth of the copied grading', cmd: 'grade.pasteY' },
  { id: 'flipX', label: 'Flip X', title: 'Click a point: its X growth changes sign', cmd: 'grade.flipX' },
  { id: 'flipY', label: 'Flip Y', title: 'Click a point: its Y growth changes sign', cmd: 'grade.flipY' },
  { id: 'zero', label: 'Clear', title: 'Click a point, or drag a box over points: their grading is removed (zero growth)', cmd: 'grade.zero' },
  { id: 'stack', label: 'Stack', title: 'Click a point: every size of the nest is stacked on it', cmd: 'grade.stackPoint' },
];
const BUTTONS: { id: string; label: string; title: string; cmd: string; on?: (app: App) => boolean }[] = [
  { id: 'nested', label: 'Nested view', title: 'Show every size of the pieces (Alt+N)', cmd: 'grade.nested', on: app => app.nested },
  { id: 'total', label: 'Totals', title: 'On: the table shows the total from the base size. Off: the step into each size.', cmd: 'grade.absolute', on: app => app.gradeAbsolute },
  { id: 'rules', label: 'Rules…', title: 'Grade rule library: apply a rule by number or name, edit rules', cmd: 'grade.rules' },
  { id: 'measure', label: 'By measure…', title: 'Grade by measurement: solve the selected points so a line hits a spec per size', cmd: 'grade.byMeasurement' },
  { id: 'prop', label: 'Proportional…', title: 'Grade the points between two graded points proportionally', cmd: 'grade.proportional' },
  { id: 'angle', label: 'Angle…', title: 'Angle grading: grow along a turned axis', cmd: 'grade.angle' },
];
const gmode = (): GMode => toolOpt(T, 'mode', 'edit') as GMode;

let hover: AnchorHit | null = null;
let box: { a: Vec; b: Vec; as: Vec; bs: Vec } | null = null;
let press: { w: Vec; s: Vec; hit: AnchorHit | null; shift: boolean } | null = null;

const pointAt = (app: App, w: Vec) => anchorNear(app, w, { gradeOnly: true, tolPx: 10 });

/** Run the grading action of the current option on the selected points. */
async function act(app: App) {
  const m = MODES.find(x => x.id === gmode());
  if (!m?.cmd) { app.status(`Edit Grade: ${app.sel.anchors.length} point${app.sel.anchors.length === 1 ? '' : 's'} · their dX / dY per size are in the Grading table`); return; }
  // a grading action works on the points of one piece: several pieces boxed at once are done piece by piece
  const pieces = [...new Set(app.sel.anchors.map(a => a.pieceId))];
  const all = app.sel.anchors.slice();
  for (const pid of pieces) {
    if (pieces.length > 1) { app.clearSelection(); for (const r of all.filter(a => a.pieceId === pid)) app.applySel({ k: 'point', ref: r }, 'add'); }
    await runCommand(m.cmd);
  }
  if (pieces.length > 1) { app.clearSelection(); for (const r of all) app.applySel({ k: 'point', ref: r }, 'add'); }
  if (m.id === 'copy') { setToolOpt(T, 'mode', 'paste'); app.status('Grading copied · now click the point(s) to paste it on (Paste X / Paste Y for one direction)'); }
  app.invalidate();
}

export const editDeltaTool: Tool = {
  id: 'editDelta', title: 'Edit Grade (grading)', group: 'grade', hotkey: 'E', icon: ICON.grade, cursor: 'crosshair',
  activate(app) {
    hover = null; box = null; press = null;
    if (!settings.panels.grading) { settings.panels.grading = true; saveSettings(); }
    app.invalidate();
  },
  deactivate(app) { hover = null; box = null; press = null; app.invalidate('canvas'); },
  busy: () => !!box,
  modes: () => MODES.map(m => ({ id: m.id, label: m.label, title: m.title })),
  mode: () => gmode(),
  setMode(app, id) { setToolOpt(T, 'mode', id); app.invalidate(); },
  toggles: app => BUTTONS.map(b => ({ id: b.id, label: b.label, title: b.title, on: b.on ? b.on(app) : false })),
  toggle(app, id) { const b = BUTTONS.find(x => x.id === id); if (b) void runCommand(b.cmd).then(() => app.invalidate()); },
  hint(app) {
    const m = MODES.find(x => x.id === gmode())!;
    if (m.id === 'edit') return app.sel.anchors.length ? `Edit Grade · ${app.sel.anchors.length} point${app.sel.anchors.length > 1 ? 's' : ''}: type dX / dY per size in the Grading table · Calculate = halve, double, constant · Shift+click adds a point · Esc = Select` : 'Edit Grade · click a grade point (square) to edit its growth per size · drag a box = several points · the strip above has Copy, Paste, Flip, Clear, Stack and the rule tools';
    return `Grade · ${m.label}: click a grade point, or drag a box over several · Esc = back to Edit Grade`;
  },
  down(app, p: Ptr) { press = { w: p.w, s: p.s, hit: pointAt(app, p.w), shift: (p.e as MouseEvent).shiftKey }; },
  move(app, p: Ptr) {
    if (press && !press.hit && !box && Math.hypot(p.s.x - press.s.x, p.s.y - press.s.y) > 4) box = { a: press.w, b: p.w, as: press.s, bs: p.s };
    if (box) { box.b = p.w; box.bs = p.s; app.invalidate('canvas'); return; }
    const h = pointAt(app, p.w);
    if (h?.anchor.id !== hover?.anchor.id) { hover = h; app.invalidate('canvas'); }
  },
  up(app) {
    const pr = press; press = null;
    if (box) {
      const b = box; box = null;
      const bx = { minX: Math.min(b.a.x, b.b.x), minY: Math.min(b.a.y, b.b.y), maxX: Math.max(b.a.x, b.b.x), maxY: Math.max(b.a.y, b.b.y) };
      const items = gatherInBox(app, bx, true, 'points').filter((it): it is Extract<SelItem, { k: 'point' }> => it.k === 'point')
        .filter(it => { const q = app.resolveRef(it.ref); return !!q && q.anchor.kind === 'grade' && !app.doc.piece(it.ref.pieceId).locked; });
      if (!items.length) { app.status('No grade points in the box'); app.invalidate('canvas'); return; }
      if (!pr?.shift) app.clearSelection();
      for (const it of items) app.applySel(it, 'add');
      void act(app);
      return;
    }
    if (!pr) return;
    if (!pr.hit) { if (!pr.shift) app.clearSelection(); app.status('Click a grade point (square) or drag a box over points'); return; }
    if (pr.hit.piece.locked) { toast(`${pr.hit.piece.name} is locked`, 'warn'); return; }
    app.applySel({ k: 'point', ref: pr.hit.ref }, pr.shift ? 'add' : 'replace');
    void act(app);
  },
  key(app, e) {
    if (e.key !== 'Escape') return false;
    if (box) { box = null; press = null; app.invalidate('canvas'); return true; }
    if (gmode() !== 'edit') { setToolOpt(T, 'mode', 'edit'); app.invalidate(); return true; }
    app.setTool('select'); return true;
  },
  overlay(app) {
    let s = '';
    if (hover && !box) s += screenMarker(app.view.toScreen(hover.world), 'ring', '#e8590c', 9);
    if (box) s += `<rect x="${fs(Math.min(box.as.x, box.bs.x))}" y="${fs(Math.min(box.as.y, box.bs.y))}" width="${fs(Math.abs(box.as.x - box.bs.x))}" height="${fs(Math.abs(box.as.y - box.bs.y))}" fill="rgba(232,89,12,0.08)" stroke="#e8590c" stroke-dasharray="4 3"/>`;
    return s;
  },
};
