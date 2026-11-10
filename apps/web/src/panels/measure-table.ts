/**
 * Measure window (AccuMark Measure ▸ Line Length, docked at the right edge): the lines picked with
 * the Measure tool, summed per size — ROWS = all sizes, COLUMNS = L1, L2, …, Σ, Δ from the
 * previous size. Several groups (a click on another piece, or Ctrl+click) = a comparison:
 * Σ A, Σ B, … and B − A (or A − B), with a target ease ± tolerance colouring each size row
 * pass / fail. OK (Enter / right-click) keeps the measurement in the history (reopen, rename, copy
 * as TSV for Excel, Grade to spec…); Esc cancels.
 *
 * State lives here (module) so the tool, the window and Grade by measurement share it.
 */
import type { SegRef, MeasureMode, MeasurePart, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { floatingWindow, windowOpen, closeWindow } from '../ui/window';
import { h, clear } from '../ui/dom';
import { fmt, unitLabel } from '../units-ui';
import { ops } from '../ops-bridge';
import { lengthInput, textInput } from './widgets';
import { sizeGrid, keepScroll, gridTSV, copyText, type SGCol, type SGRow, type SGState } from './sizegrid';
import { toast } from '../ui/toast';
import { reportError } from '../commands';

export interface MPartUI extends MeasurePart { label: string }
export interface MGroupUI { id: string; name: string; parts: MPartUI[] }
export interface MRecord { id: string; name: string; groups: MGroupUI[]; mode: MeasureMode; ease: number; tol: number | null; at: string }

export const GROUP_COLORS = ['#e8590c', '#1c7ed6', '#2b8a3e', '#ae3ec9', '#c92a2a', '#5f3dc4'];
export const MS = {
  groups: [] as MGroupUI[],
  cur: -1,
  mode: 'contour' as MeasureMode,
  history: [] as MRecord[],
  /** target ease (B − A) and tolerance; tol null = no pass / fail */
  ease: 0,
  tol: null as number | null,
  diff: 'BA' as 'BA' | 'AB',
  showParts: true,
  /** the record being edited after Reopen (OK updates it instead of adding) */
  editing: null as string | null,
  scroll: { scrollTop: 0 } as SGState,
};
let seq = 0;
const letter = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');

export const sameRef = (a: MeasurePart, b: MeasurePart) => a.ref.pieceId === b.ref.pieceId && a.ref.contourId === b.ref.contourId && a.ref.from === b.ref.from && a.ref.to === b.ref.to && !!a.cut === !!b.cut;
export function groupColor(i: number) { return GROUP_COLORS[i % GROUP_COLORS.length]; }
export function relabel(g: MGroupUI) { g.parts.forEach((p, k) => { p.label = 'L' + (k + 1); }); }

/** add a part to group `gi` (new group when gi < 0); returns the group index */
export function addPart(part: MeasurePart, gi: number): number {
  if (gi < 0 || !MS.groups[gi]) { MS.groups.push({ id: 'g' + (++seq), name: letter(MS.groups.length), parts: [] }); gi = MS.groups.length - 1; }
  const g = MS.groups[gi];
  g.parts.push({ ...part, label: 'L' + (g.parts.length + 1) });
  MS.cur = gi;
  return gi;
}
/** remove a picked part wherever it is; returns true when found */
export function removePart(part: MeasurePart): boolean {
  for (let gi = 0; gi < MS.groups.length; gi++) {
    const g = MS.groups[gi]; const k = g.parts.findIndex(p => sameRef(p, part));
    if (k < 0) continue;
    g.parts.splice(k, 1); relabel(g);
    if (!g.parts.length) { MS.groups.splice(gi, 1); renameDefault(); MS.cur = Math.min(MS.cur, MS.groups.length - 1); }
    else MS.cur = gi;
    return true;
  }
  return false;
}
function renameDefault() { MS.groups.forEach((g, i) => { if (/^[A-Z]\d*$/.test(g.name)) g.name = letter(i); }); }
export function removeLast(): boolean {
  const g = MS.groups[MS.cur] ?? MS.groups[MS.groups.length - 1];
  if (!g) return false;
  g.parts.pop();
  if (!g.parts.length) { MS.groups.splice(MS.groups.indexOf(g), 1); renameDefault(); MS.cur = MS.groups.length - 1; }
  return true;
}
export function hasOpen() { return MS.groups.some(g => g.parts.length); }

/** OK: keep the open measurement in the history (or update the reopened one). */
export function commitMeasure(): MRecord | null {
  if (!hasOpen()) return null;
  const groups = JSON.parse(JSON.stringify(MS.groups)) as MGroupUI[];
  const name = groups.length > 1 ? groups.map(g => g.name).join(' vs ') : groups[0].name;
  let rec = MS.editing ? MS.history.find(r => r.id === MS.editing) : undefined;
  if (rec) Object.assign(rec, { groups, mode: MS.mode, ease: MS.ease, tol: MS.tol });
  else { rec = { id: 'm' + (++seq), name: /^[A-Z]\d*( vs [A-Z]\d*)*$/.test(name) ? `Measure ${MS.history.length + 1}` + (groups.length > 1 ? ` (${name})` : '') : name, groups, mode: MS.mode, ease: MS.ease, tol: MS.tol, at: new Date().toISOString() }; MS.history.push(rec); }
  MS.groups = []; MS.cur = -1; MS.editing = null;
  return rec;
}
export function cancelMeasure() { MS.groups = []; MS.cur = -1; MS.editing = null; }
export function reopen(id: string) {
  const r = MS.history.find(x => x.id === id); if (!r) return;
  MS.groups = JSON.parse(JSON.stringify(r.groups)); MS.cur = MS.groups.length - 1; MS.mode = r.mode; MS.ease = r.ease; MS.tol = r.tol; MS.editing = r.id;
}

export function partName(app: App, p: MeasurePart): string {
  const pc = app.doc.style.pieces.find(x => x.id === p.ref.pieceId); if (!pc) return '?';
  const c = [pc.sew, ...pc.internals].find(x => x.id === p.ref.contourId);
  const ia = c?.points.findIndex(a => a.id === p.ref.from) ?? -1, ib = c?.points.findIndex(a => a.id === p.ref.to) ?? -1;
  const nm = (i: number) => (c?.points[i]?.name ? c.points[i].name : String(i + 1));
  return `${pc.name} ${c === pc.sew ? (p.cut ? 'cut' : 'sew') : 'int'} ${nm(ia)}→${nm(ib)}`;
}

/** parts that still exist (pieces / anchors may have been deleted) */
function liveGroups(app: App, groups: MGroupUI[]): MGroupUI[] {
  return groups.map(g => ({ ...g, parts: g.parts.filter(p => { const pc = app.doc.style.pieces.find(x => x.id === p.ref.pieceId); const c = pc && [pc.sew, ...pc.internals].find(x => x.id === p.ref.contourId); return !!c && c.points.some(a => a.id === p.ref.from) && c.points.some(a => a.id === p.ref.to); }) })).filter(g => g.parts.length);
}

export interface MeasureTable { rows: SGRow[]; cols: SGCol[]; pass: (boolean | null)[] }
/** Rows (all sizes) and columns for a set of groups. */
export function measureTable(app: App, groupsIn: MGroupUI[], mode: MeasureMode, o: { ease: number; tol: number | null; diff: 'BA' | 'AB'; showParts: boolean }): MeasureTable {
  const groups = liveGroups(app, groupsIn);
  if (!groups.length) return { rows: [], cols: [], pass: [] };
  const piece = app.doc.piece(groups[0].parts[0].ref.pieceId);
  const line = app.doc.sizeLine(piece);
  const res = ops.compareGroups(app.doc, groups.map(g => g.parts), mode, { line });
  const rows: SGRow[] = line.sizes.map(s => ({ id: s.id, name: s.name, base: s.id === line.baseSizeId, active: s.id === app.activeSize }));
  const cols: SGCol[] = [];
  const many = groups.length > 1;
  groups.forEach((g, gi) => {
    const gname = many ? `${g.name}` : (g.name.length > 2 ? g.name : 'Lines');
    if (!many || o.showParts) g.parts.forEach((p, k) => cols.push({ key: `${g.id}:${p.label}`, group: gname, head: (many ? g.name + '·' : '') + p.label, title: partName(app, p), attrs: { 'data-g': String(gi), 'data-part': p.label }, get: r => res[r].parts[gi]?.[k] ?? null }));
    cols.push({ key: `${g.id}:sum`, group: gname, head: many ? `Σ ${g.name}` : 'Σ', title: g.parts.map(p => p.label).join(' + '), attrs: { 'data-g': String(gi), 'data-part': 'sum' }, cls: () => 'sum', get: r => res[r].totals[gi] });
  });
  let pass: (boolean | null)[] = rows.map(() => null);
  if (many) {
    const sign = o.diff === 'BA' ? 1 : -1;
    for (let gi = 1; gi < groups.length; gi++) {
      const lab = o.diff === 'BA' ? `${groups[gi].name} − ${groups[0].name}` : `${groups[0].name} − ${groups[gi].name}`;
      cols.push({ key: `diff:${gi}`, group: 'Difference', head: lab, attrs: { 'data-part': 'diff', 'data-g': String(gi) }, cls: r => (pass[r] === null ? 'diff' : pass[r] ? 'diff pass' : 'diff fail'), get: r => { const d = res[r].diff[gi]; return d === null ? null : sign * d; } });
    }
    if (o.tol !== null) {
      pass = res.map(row => { const d = row.diff[1]; return d === null ? null : Math.abs(sign * d - o.ease) <= (o.tol ?? 0) + 1e-9; });
      cols.push({ key: 'pass', group: 'Difference', head: 'Check', attrs: { 'data-part': 'check' }, cls: r => (pass[r] === null ? '' : pass[r] ? 'pass' : 'fail'), get: () => null, text: r => (pass[r] === null ? '—' : pass[r] ? '✓' : '✗') });
    }
  } else {
    cols.push({ key: 'dprev', group: gname0(groups[0]), head: 'Δ prev', title: 'Σ minus Σ of the previous size', attrs: { 'data-part': 'dprev' }, get: r => (r > 0 && res[r].totals[0] !== null && res[r - 1].totals[0] !== null ? res[r].totals[0]! - res[r - 1].totals[0]! : null) });
  }
  return { rows, cols, pass };
}
const gname0 = (g: MGroupUI) => (g.name.length > 2 ? g.name : 'Lines');

/** the TSV of the open measurement (or a history record) */
export function measureTSV(app: App, rec?: MRecord): string {
  const t = measureTable(app, rec ? rec.groups : MS.groups, rec ? rec.mode : MS.mode, { ease: rec?.ease ?? MS.ease, tol: rec ? rec.tol : MS.tol, diff: MS.diff, showParts: true });
  return gridTSV(t.rows, t.cols);
}

let hooks: { onOK?: () => void; onCancel?: () => void; gradeToSpec?: (groups: MGroupUI[], mode: MeasureMode) => void } = {};
export function setMeasureHooks(h2: typeof hooks) { hooks = { ...hooks, ...h2 }; }

export function measureWindowOpen() { return windowOpen('mline'); }
export function closeMeasureWindow() { closeWindow('mline'); }

/** (Re)render the docked Measure window. */
export function renderMeasureWindow(app: App) {
  const W = 540;
  const win = floatingWindow('mline', 'Measure — lines per size', { width: W, x: Math.max(60, window.innerWidth - W - 310), y: 74 });
  win.el.classList.add('mwin');
  keepScroll(win.body, MS.scroll); clear(win.body); clear(win.foot);
  const run = (label: string, fn: () => void) => { try { fn(); } catch (err) { reportError(err, label); } };
  const rerender = () => { renderMeasureWindow(app); app.invalidate('canvas'); };

  // controls
  const mode = h('select.m-mode', { title: 'What each line contributes' }) as HTMLSelectElement;
  for (const [v, l] of [['contour', 'Along the line (length)'], ['diagonal', 'Straight distance'], ['x', 'dX only'], ['y', 'dY only']]) mode.append(h('option', { value: v }, l));
  mode.value = MS.mode; mode.onchange = () => { MS.mode = mode.value as MeasureMode; rerender(); };
  mode.addEventListener('keydown', e => e.stopPropagation());
  const ctl = h('div.m-ctl', {}, h('span.dim', {}, 'Measure'), mode);
  win.body.append(ctl);

  // group chips
  const chips = h('div.m-groups');
  MS.groups.forEach((g, gi) => {
    const nm = textInput(g.name, v => { g.name = v.trim() || g.name; rerender(); }, 'name');
    nm.classList.add('m-gname'); nm.setAttribute('data-g', String(gi));
    chips.append(h('div.m-chip' + (gi === MS.cur ? '.on' : ''), { style: `--gc:${groupColor(gi)}`, title: g.parts.map(p => `${p.label}: ${partName(app, p)}`).join('\n'), onclick: (e: Event) => { if ((e.target as Element).closest('input,button')) return; MS.cur = gi; rerender(); } },
      h('span.m-dot'), nm, h('span.dim', {}, `${g.parts.length} line${g.parts.length === 1 ? '' : 's'}`),
      h('button.mini', { title: 'Remove this group', onclick: () => { MS.groups.splice(gi, 1); renameDefault(); MS.cur = MS.groups.length - 1; rerender(); } }, '×')));
  });
  if (MS.groups.length) win.body.append(chips);

  if (MS.groups.length > 1) {
    const dir = h('div.seg.m-dir');
    for (const [v, l] of [['BA', `${MS.groups[1].name} − ${MS.groups[0].name}`], ['AB', `${MS.groups[0].name} − ${MS.groups[1].name}`]] as const) dir.append(h('button' + (MS.diff === v ? '.on' : ''), { 'data-diff': v, onclick: () => { MS.diff = v; rerender(); } }, l));
    const ease = lengthInput(MS.ease, v => { MS.ease = v; if (MS.tol === null) MS.tol = 1; rerender(); }, { title: 'Target ease: the wanted difference (e.g. sleeve cap − armhole)' });
    ease.classList.add('m-ease');
    const tol = lengthInput(MS.tol ?? NaN, v => { MS.tol = Math.abs(v); rerender(); }, { min: 0, title: 'Tolerance ±: rows within target ± tolerance pass (green), others fail (red)' });
    tol.classList.add('m-tol');
    win.body.append(h('div.m-ctl', {},
      h('span.dim', {}, 'Difference'), dir,
      h('label.chk', {}, h('input', { type: 'checkbox', checked: MS.showParts, onchange: (e: Event) => { MS.showParts = (e.target as HTMLInputElement).checked; rerender(); } }), ' parts'),
      h('span.dim', {}, 'Target ease'), ease, h('span.dim', {}, '±'), tol, h('span.dim', {}, unitLabel()),
      MS.tol !== null ? h('button.mini', { title: 'No pass / fail check', onclick: () => { MS.tol = null; rerender(); } }, '×') : null));
  }

  if (!hasOpen()) {
    win.body.append(h('div.empty', {}, 'Click lines on the canvas (Measure tool, M). Each click adds L1, L2, … and the window sums them per size. Click a line on another piece (or Ctrl+click) to start a comparison. Enter / right-click = OK, Esc = cancel.'));
  } else {
    let t: MeasureTable;
    try { t = measureTable(app, MS.groups, MS.mode, MS); } catch (err) { win.body.append(h('div.warnline', {}, (err as Error).message)); t = { rows: [], cols: [], pass: [] }; }
    if (t.rows.length) {
      const grid = sizeGrid({ rows: t.rows, cols: t.cols, state: MS.scroll, maxHeight: Math.min(440, window.innerHeight - 330), cls: 'mtab', onRowClick: r => { app.activeSize = t.rows[r].id; app.invalidate(); renderMeasureWindow(app); } });
      win.body.append(grid.el);
      const failing = t.pass.filter(p => p === false).length;
      if (MS.groups.length > 1 && MS.tol !== null) win.body.append(h('div.fw-sum' + (failing ? '.bad' : ''), { 'data-check': failing ? 'fail' : 'pass' }, failing ? `${failing} size(s) outside ${fmt(MS.ease)} ± ${fmt(MS.tol)} ${unitLabel()}` : `All sizes within ${fmt(MS.ease)} ± ${fmt(MS.tol)} ${unitLabel()}`));
      const g = MS.groups[MS.cur] ?? MS.groups[0];
      win.body.append(h('div.dim.m-formula', {}, `${g.name}: ${g.parts.map(p => p.label).join(' + ')} = Σ · ${MS.mode === 'contour' ? 'along the line' : MS.mode === 'diagonal' ? 'straight' : MS.mode === 'x' ? 'dX' : 'dY'} · ${unitLabel()}`));
    }
  }
  // history
  if (MS.history.length) {
    const hist = h('div.m-hist', {}, h('div.insp-title', {}, `Kept measurements (${MS.history.length})`));
    for (const rec of MS.history) {
      const nm = textInput(rec.name, v => { rec.name = v.trim() || rec.name; rerender(); });
      nm.classList.add('m-hname');
      hist.append(h('div.m-hrow' + (MS.editing === rec.id ? '.on' : ''), { 'data-rec': rec.id }, nm,
        h('span.dim', {}, `${rec.groups.length > 1 ? rec.groups.length + ' groups' : rec.groups[0]?.parts.length + ' lines'}`),
        h('button.btn.sm', { title: 'Reopen: show it again and add / remove lines', onclick: () => { reopen(rec.id); app.setTool('measure'); rerender(); } }, 'Reopen'),
        h('button.btn.sm', { title: 'Copy as TSV (Excel): rows = sizes', onclick: () => void copyText(measureTSV(app, rec)).then(ok => toast(ok ? 'Copied (TSV, rows = sizes)' : 'Copy refused by the browser', ok ? 'ok' : 'warn')) }, 'Copy'),
        h('button.btn.sm', { title: 'Grade to spec: solve points so this measurement hits a spec per size', onclick: () => hooks.gradeToSpec?.(rec.groups, rec.mode) }, 'Grade to spec…'),
        h('button.mini', { title: 'Delete', onclick: () => { MS.history.splice(MS.history.indexOf(rec), 1); rerender(); } }, '×')));
    }
    win.body.append(hist);
  }
  win.foot.append(
    h('button.btn.sm' + (hasOpen() ? '' : '.disabled'), { 'data-act': 'copy', title: 'Copy the table as TSV (Excel): rows = sizes', onclick: () => run('Copy', () => { if (!hasOpen()) return; void copyText(measureTSV(app)).then(ok => toast(ok ? 'Copied (TSV, rows = sizes)' : 'Copy refused by the browser', ok ? 'ok' : 'warn')); }) }, 'Copy TSV'),
    h('button.btn.sm' + (hasOpen() ? '' : '.disabled'), { 'data-act': 'spec', title: 'Grade the selected points so this measurement hits a spec per size', onclick: () => { if (hasOpen()) hooks.gradeToSpec?.(liveGroups(app, MS.groups), MS.mode); } }, 'Grade to spec…'),
    h('span.spacer'),
    h('button.btn.sm', { 'data-act': 'cancel', title: 'Cancel (Esc)', onclick: () => { cancelMeasure(); hooks.onCancel?.(); rerender(); } }, 'Cancel'),
    h('button.btn.sm.primary' + (hasOpen() ? '' : '.disabled'), { 'data-act': 'ok', title: 'OK (Enter / right-click): keep it in the list below', onclick: () => { const r = commitMeasure(); if (r) toast(`Kept “${r.name}”`, 'ok'); hooks.onOK?.(); rerender(); } }, 'OK'),
  );
  void ([] as Id[]); void ({} as SegRef);
}
