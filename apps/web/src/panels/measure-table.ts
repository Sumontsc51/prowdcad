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
  /** how many groups were finished with right-click / Enter: 0 = picking group A, 1 = picking group B, 2 = comparison shown */
  closed: 0,
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
    if (!g.parts.length) { MS.groups.splice(gi, 1); renameDefault(); MS.cur = Math.min(MS.cur, MS.groups.length - 1); MS.closed = Math.min(MS.closed, MS.groups.length); }
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
  if (!g.parts.length) { MS.groups.splice(MS.groups.indexOf(g), 1); renameDefault(); MS.cur = MS.groups.length - 1; MS.closed = Math.min(MS.closed, MS.groups.length); }
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
  MS.groups = []; MS.cur = -1; MS.editing = null; MS.closed = 0;
  return rec;
}
export function cancelMeasure() { MS.groups = []; MS.cur = -1; MS.editing = null; MS.closed = 0; }
export function reopen(id: string) {
  const r = MS.history.find(x => x.id === id); if (!r) return;
  MS.groups = JSON.parse(JSON.stringify(r.groups)); MS.cur = MS.groups.length - 1; MS.mode = r.mode; MS.ease = r.ease; MS.tol = r.tol; MS.editing = r.id; MS.closed = Math.min(2, MS.groups.length);
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

let hooks: { onOK?: () => void; onCancel?: () => void; gradeToSpec?: (groups: MGroupUI[], mode: MeasureMode) => void; adjust?: () => void; addToSpec?: (group?: MGroupUI, mode?: MeasureMode) => void } = {};
export function measureHooks() { return hooks; }
export function setMeasureHooks(h2: typeof hooks) { hooks = { ...hooks, ...h2 }; }

export function measureWindowOpen() { return windowOpen('mline'); }
let closingByTool = false;
/** Close the result windows without forgetting what they show (the Measure tool reopens them). */
export function closeMeasureWindow() { closingByTool = true; try { closeWindow('mline'); closeWindow('mline2'); } finally { closingByTool = false; } }

/** What the result windows show: the group(s) as they were when finished with right-click (they stay until the next result). */
export const SHOWN: { a: MGroupUI | null; b: MGroupUI | null; mode: MeasureMode } = { a: null, b: null, mode: 'contour' };
/** Canvas / window tag of a group: CH1 = the first set of lines, CH2 = the second. */
export const chartTag = (gi: number) => 'CH' + (gi + 1);
/** Right-click finished group `gi` (0 = first set, 1 = second set): its result window is (re)built from a snapshot. */
export function showResult(gi: number) {
  const g = MS.groups[gi]; if (!g) return;
  const snap = JSON.parse(JSON.stringify(g)) as MGroupUI;
  SHOWN.mode = MS.mode;
  if (gi === 0) { SHOWN.a = snap; SHOWN.b = null; } else SHOWN.b = snap;
}
export function clearResults() { SHOWN.a = null; SHOWN.b = null; }

/**
 * Result table of one finished set of lines, as AccuMark Grade ▸ Measure ▸ Line shows it:
 * Size · L1 · L2 · … · Total · Size Diff; the second set adds Difference (first total − second total)
 * and Overall (how much that difference changes from the previous size).
 */
export function resultTable(app: App, g: MGroupUI, gi: number, first?: MGroupUI | null): MeasureTable {
  const [live] = liveGroups(app, [g]);
  if (!live) return { rows: [], cols: [], pass: [] };
  const piece = app.doc.piece(live.parts[0].ref.pieceId);
  const line = app.doc.sizeLine(piece);
  const fl = first ? liveGroups(app, [first])[0] : undefined;
  const res = ops.compareGroups(app.doc, fl ? [fl.parts, live.parts] : [live.parts], SHOWN.mode, { line });
  const k0 = fl ? 1 : 0;
  const rows: SGRow[] = line.sizes.map(s => ({ id: s.id, name: s.name, base: s.id === line.baseSizeId, active: s.id === app.activeSize }));
  const tot = (r: number, k: number) => res[r]?.totals[k] ?? null;
  const diff = (r: number) => (fl && tot(r, 0) !== null && tot(r, 1) !== null ? tot(r, 0)! - tot(r, 1)! : null);
  const G = String(gi);
  const cols: SGCol[] = live.parts.map((p, k) => ({ key: `p${k}`, head: p.label, title: partName(app, p), attrs: { 'data-g': G, 'data-part': p.label }, get: (r: number) => res[r].parts[k0]?.[k] ?? null }));
  cols.push({ key: 'sum', head: 'Total', title: live.parts.map(p => p.label).join(' + '), attrs: { 'data-g': G, 'data-part': 'sum' }, cls: () => 'sum', get: r => tot(r, k0) });
  cols.push({ key: 'dprev', head: 'Size Diff', title: 'Total minus the total of the previous size', attrs: { 'data-g': G, 'data-part': 'dprev' }, get: r => (r > 0 && tot(r, k0) !== null && tot(r - 1, k0) !== null ? tot(r, k0)! - tot(r - 1, k0)! : null) });
  if (fl) {
    cols.push({ key: 'diff', head: 'Difference', title: `Total of ${chartTag(0)} minus total of ${chartTag(1)}`, attrs: { 'data-g': G, 'data-part': 'diff' }, cls: () => 'diff', get: r => diff(r) });
    cols.push({ key: 'overall', head: 'Overall', title: 'Change of the difference from the previous size', attrs: { 'data-g': G, 'data-part': 'overall' }, get: r => (r > 0 && diff(r) !== null && diff(r - 1) !== null ? diff(r)! - diff(r - 1)! : null) });
  }
  return { rows, cols, pass: rows.map(() => null) };
}

const scrollA: SGState = { scrollTop: 0 }, scrollB: SGState = { scrollTop: 0 };
function resultWindow(app: App, id: 'mline' | 'mline2', g: MGroupUI, gi: number, first: MGroupUI | null) {
  let t: MeasureTable; let err = '';
  try { t = resultTable(app, g, gi, first); } catch (e) { t = { rows: [], cols: [], pass: [] }; err = (e as Error).message; }
  const W = Math.min(640, 150 + t.cols.length * 78);
  const x0 = Math.max(70, Math.min(260, window.innerWidth - 2 * W - 340));
  const win = floatingWindow(id, `Measure Line · ${chartTag(gi)}`, { width: W, x: gi === 0 ? x0 : Math.min(window.innerWidth - W - 20, x0 + (document.querySelector<HTMLElement>('.fwin[data-win="mline"]')?.offsetWidth ?? W) + 14), y: 150, onClose: () => { if (closingByTool) return; if (id === 'mline') { SHOWN.a = null; SHOWN.b = null; closeWindow('mline2'); } else SHOWN.b = null; } });
  win.el.classList.add('mwin');
  win.el.style.width = W + 'px';
  const st = gi === 0 ? scrollA : scrollB;
  keepScroll(win.body, st); clear(win.body); clear(win.foot);
  if (err) win.body.append(h('div.warnline', {}, err));
  else if (!t.rows.length) win.body.append(h('div.empty', {}, 'These lines no longer exist.'));
  else win.body.append(sizeGrid({ rows: t.rows, cols: t.cols, state: st, maxHeight: Math.min(440, window.innerHeight - 300), cls: 'mtab', onRowClick: r => { app.activeSize = t.rows[r].id; app.invalidate(); renderMeasureWindow(app); } }).el);
  win.foot.append(
    h('span.dim', {}, `${g.parts.length} line${g.parts.length === 1 ? '' : 's'} · ${unitLabel()}`),
    h('span.spacer'),
    h('button.btn.sm.primary', { 'data-act': 'tospec', title: 'Keep this set of lines in the style as a point of measure with a target per size (Measure spec)', onclick: () => hooks.addToSpec?.(g, SHOWN.mode) }, 'Add to spec'),
  );
}

/** (Re)render the Measure result windows: one per finished set of lines (none while the first set is still being picked). */
export function renderMeasureWindow(app: App) {
  if (SHOWN.a) resultWindow(app, 'mline', SHOWN.a, 0, null); else closeWindow('mline');
  if (SHOWN.a && SHOWN.b) resultWindow(app, 'mline2', SHOWN.b, 1, SHOWN.a); else closeWindow('mline2');
  void ([] as Id[]); void ({} as SegRef); void fmt; void lengthInput; void textInput; void gridTSV; void copyText; void toast; void reportError; void windowOpen;
}
