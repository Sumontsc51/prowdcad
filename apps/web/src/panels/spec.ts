/**
 * Measure Spec window (Measure ▸ Measure spec…): the style's points of measure, laid out like a
 * measurement chart: one row per POM with its Total in the chosen size (Size drop-down); a row
 * expands (▸) to the lines behind it — Piece, Length, Quantity (2 for a half piece; Total =
 * Σ length × quantity). Each row has Apply and Rules; Rules opens the separate rule maker window.
 *
 * (Earlier header, still true for the model:)
 *
 * Each row is a named measurement tied to geometry — internal line(s) / outline segment(s) summed,
 * or a straight point-to-point distance — with a target per size. Changing a target and pressing
 * Apply alters the pattern so the measurement hits it: by default the END of the line moves along
 * the line by the difference. The Rules of a measurement say which points move, in which direction
 * (along the line / X / Y / angle) and with what share (1 = all, 0.5 = half, −1 = the other way).
 *
 * Top: the list (active size: now / target / difference). Below, for the selected row: its rules
 * and the per-size table (ROWS = sizes; paste a spec column from Excel into Target).
 * Everything is stored in the style (style.measureSpec) and every apply is one undo step.
 */
import type { Id, MeasureMode, MeasurePart, MeasureSpecItem, SpecMover, SpecApplyResult } from '@prowdcad/kernel';
import type { App } from '../app';
import { floatingWindow, windowOpen, closeWindow } from '../ui/window';
import { h, clear } from '../ui/dom';
import { fmt, unitLabel } from '../units-ui';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { toast } from '../ui/toast';
import { lengthInput, numberInput, textInput, selectInput } from './widgets';
import { sizeGrid, keepScroll, type SGCol, type SGState } from './sizegrid';
import { MS, type MGroupUI } from './measure-table';
import { registerOverlay } from '../canvas/overlays';
import { screenPath, runWorld } from '../hitkit';
import { toWorld, resolveFor } from '../geometry';
import { buildXlsx, type XSheet, type XCell } from '../ui/xlsx';
import { download } from '../actions/file';
import { settings } from '../settings';

const SS = {
  cur: null as Id | null,
  /** expanded rows (per-piece details) */
  open: new Set<Id>(),
  /** per-size table of the selected row shown */
  allSizes: false,
  /** Rules window: which item, and whether points are added as they are selected */
  rulesFor: null as Id | null,
  /** Rules window: a line of that item (index into its parts), or null = the whole measurement */
  rulesLine: null as number | null,
  autoAdd: false,
  lastSelKey: '',
  /** last preview / apply result per item */
  result: new Map<Id, SpecApplyResult & { written: boolean }>(),
  scroll: { scrollTop: 0 } as SGState,
};
const TOL = 0.05; // mm: "on spec" in the list

export function specWindowOpen() { return windowOpen('mspec'); }

const items = (app: App): MeasureSpecItem[] => app.style.measureSpec ?? [];

function pointLabel(app: App, pieceId: Id, anchorId: Id): string {
  const p = app.style.pieces.find(x => x.id === pieceId); if (!p) return 'missing point';
  for (const c of [p.sew, ...p.internals]) {
    const i = c.points.findIndex(a => a.id === anchorId);
    if (i >= 0) return `${p.name} ${c === p.sew ? '' : 'int '}${c.points[i].name || 'pt ' + (i + 1)}`;
  }
  return `${p.name} · missing point`;
}
function partLabel(app: App, part: MeasurePart): string {
  const p = app.style.pieces.find(x => x.id === part.ref.pieceId); if (!p) return 'missing piece';
  const c = [p.sew, ...p.internals].find(x => x.id === part.ref.contourId); if (!c) return `${p.name} · missing line`;
  const nm = (id: Id) => { const i = c.points.findIndex(a => a.id === id); return i < 0 ? '?' : c.points[i].name || String(i + 1); };
  if (c !== p.sew && part.ref.from === c.points[0]?.id && part.ref.to === c.points[c.points.length - 1]?.id) return `${p.name} internal line ${p.internals.indexOf(c) + 1}`;
  return `${p.name} ${c === p.sew ? (part.cut ? 'cut' : 'outline') : 'internal'} ${nm(part.ref.from)}→${nm(part.ref.to)}`;
}
function describe(app: App, it: MeasureSpecItem): string {
  if (it.kind === 'distance') return it.a && it.b ? `${pointLabel(app, it.a.pieceId, it.a.anchorId)} → ${pointLabel(app, it.b.pieceId, it.b.anchorId)}` : 'two points';
  return it.parts.map(p => partLabel(app, p)).join(' + ');
}
const MODE_LABEL: Record<MeasureMode, string> = { contour: 'Along the line', diagonal: 'Straight', x: 'X only', y: 'Y only' };

// ───────────────────────── creating items ─────────────────────────

function uniqueName(app: App, base: string): string {
  const names = new Set(items(app).map(x => x.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** New point of measure from a Measure ▸ Line group (the open one, else the last kept one). */
export function addSpecFromMeasure(app: App, group?: MGroupUI, mode?: MeasureMode): Id {
  const g = group ?? MS.groups[MS.cur] ?? MS.groups.find(x => x.parts.length) ?? MS.history[MS.history.length - 1]?.groups[0];
  if (!g || !g.parts.length) throw new Error('Measure something first: Measure tool (M), click the line(s), then “Add to spec”');
  const named = /^[A-Z]\d*$/.test(g.name) ? '' : g.name;
  const id = ops.addSpecItem(app.doc, { name: uniqueName(app, named || `POM ${items(app).length + 1}`), kind: 'line', parts: g.parts.map(p => ({ ref: { ...p.ref }, cut: p.cut })), mode: mode ?? MS.mode });
  SS.cur = id; return id;
}

/** New point of measure from the selection: segments / internal lines → a line; exactly two points → a distance. */
export function addSpecFromSelection(app: App): Id {
  const S = app.sel;
  const parts: MeasurePart[] = S.segments.map(g => ({ ref: { pieceId: g.pieceId, contourId: g.contourId, from: g.from, to: g.to } }));
  for (const c of S.internals) {
    const p = app.doc.piece(c.pieceId); const ic = p.internals.find(x => x.id === c.contourId); if (!ic || ic.points.length < 2) continue;
    if (ic.closed) throw new Error('A closed internal shape has no ends to move. Select its segments instead (Select ▸ Lines).');
    parts.push({ ref: { pieceId: c.pieceId, contourId: ic.id, from: ic.points[0].id, to: ic.points[ic.points.length - 1].id } });
  }
  let id: Id;
  if (parts.length) id = ops.addSpecItem(app.doc, { name: uniqueName(app, `POM ${items(app).length + 1}`), kind: 'line', parts });
  else if (S.anchors.length === 2) {
    const [a, b] = S.anchors;
    if (a.pieceId !== b.pieceId) throw new Error('Pick the two points on the same piece');
    id = ops.addSpecItem(app.doc, { name: uniqueName(app, `POM ${items(app).length + 1}`), kind: 'distance', a: { pieceId: a.pieceId, anchorId: a.anchorId }, b: { pieceId: b.pieceId, anchorId: b.anchorId } });
  } else throw new Error('Select what to measure first: outline segment(s) or an internal line (Select ▸ Lines / Internals), or exactly two points for a straight distance');
  SS.cur = id; return id;
}

// ───────────────────────── apply ─────────────────────────

function apply(app: App, ids: Id[] | undefined, write: boolean, sizes?: Id[]) {
  const res = ops.applySpec(app.doc, ids, { write, sizes });
  for (const r of res.items) SS.result.set(r.id, { ...r, written: res.written });
  const rows = res.items.flatMap(r => r.rows.filter(x => x.target !== null && !(sizes && !sizes.includes(x.sizeId))));
  const missed = rows.filter(x => !x.solved).length;
  const errs = res.items.filter(r => r.error);
  const moved = res.items.filter(r => r.changed).length;
  const msg = `${write ? 'Applied' : 'Preview'}: ${moved} measurement(s) ${write ? 'changed the pattern' : 'would change the pattern'}${missed ? ` · ${missed} size value(s) cannot be reached` : ''}${errs.length ? ` · ${errs.length} with missing geometry` : ''}`;
  app.status(msg);
  if (write) toast(res.written ? msg : (missed || errs.length ? msg : 'Already on spec — nothing to change'), missed || errs.length ? 'warn' : 'ok', 3600);
}

// ───────────────────────── Excel export ─────────────────────────

/** mm → the display unit, as a number for the sheet (4 decimals). */
function unitValue(mm: number | null | undefined): number | null {
  if (mm === null || mm === undefined || !Number.isFinite(mm)) return null;
  const v = settings.unit === 'in' ? mm / 25.4 : settings.unit === 'cm' ? mm / 10 : mm;
  return Math.round(v * 1e4) / 1e4;
}

/** The chart as workbook sheets (also used by tests): Totals, Targets, Difference, Lines (+ Line targets when any). */
export function specSheets(app: App): XSheet[] {
  const list = items(app); const line = app.sizeLine(); const u = unitLabel();
  const sizes = line.sizes.map(s => s.name + (s.id === line.baseSizeId ? ' *' : ''));
  const head = (first: string[]) => [...first, ...sizes];
  const widths = (n: number) => [...Array.from({ length: n }, (_, i) => (i === 0 ? 26 : i === 1 && n > 2 ? 34 : 10)), ...sizes.map(() => 11)];
  const per = (rows: { sizeId: Id }[], get: (i: number) => number | null | undefined) => line.sizes.map(s => { const i = rows.findIndex(r => r.sizeId === s.id); return i < 0 ? null : unitValue(get(i)); });
  const totals: XCell[][] = [head([`Measurement (${u})`])], targets: XCell[][] = [head([`Target (${u})`])], diffs: XCell[][] = [head([`Total − target (${u})`])];
  const lines: XCell[][] = [head([`Measurement (${u})`, 'Piece · line', 'Quantity'])];
  const ltargets: XCell[][] = [head([`Line target (${u})`, 'Piece · line'])];
  for (const it of list) {
    const rows = ops.specRows(app.doc, it.id);
    totals.push([it.name, ...per(rows, i => rows[i].value)]);
    targets.push([it.name, ...per(rows, i => rows[i].target)]);
    diffs.push([it.name, ...per(rows, i => rows[i].diff)]);
    const det = line.sizes.map(s => ops.specDetails(app.doc, it.id, s.id));
    (det[0] ?? []).forEach((d, k) => {
      const label = it.kind === 'line' ? partLabel(app, it.parts[d.index]) : describe(app, it);
      lines.push([k === 0 ? it.name : '', label, d.qty, ...det.map(x => unitValue(x[k]?.length))]);
      if (it.kind === 'line' && it.parts[d.index].targets) { const lr = ops.specLineRows(app.doc, it.id, d.index); ltargets.push([it.name, label, ...per(lr, i => lr[i].target)]); }
    });
    lines.push([`${it.name} total`, '', '', ...per(rows, i => rows[i].value)]);
  }
  const out: XSheet[] = [
    { name: 'Totals', rows: totals, widths: widths(1) },
    { name: 'Targets', rows: targets, widths: widths(1) },
    { name: 'Difference', rows: diffs, widths: widths(1) },
    { name: 'Lines', rows: lines, widths: widths(3) },
  ];
  if (ltargets.length > 1) out.push({ name: 'Line targets', rows: ltargets, widths: widths(2) });
  return out;
}

export function exportSpecExcel(app: App) {
  const name = `${app.fileName.replace(/\.prowd\.json$|\.json$|\.prowd$/i, '') || 'style'} - measure spec.xlsx`;
  download(name, new Blob([buildXlsx(specSheets(app)) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  toast(`Exported ${name} — ${items(app).length} measurement(s), ${app.sizeLine().sizes.length} size(s)`, 'ok', 3600);
}

// ───────────────────────── window ─────────────────────────

let pendingRefresh = false;
/** Redraw when the document / active size / unit / selection changes (not while a field of the window is being typed in). */
export function refreshSpecWindow(app: App) {
  if (!specWindowOpen() && !windowOpen('msrules')) return;
  autoAddSelected(app);
  const a = document.activeElement;
  const typing = !!a && !!a.closest?.('.fwin[data-win="mspec"], .fwin[data-win="msrules"]') && (a.tagName === 'INPUT' || a.tagName === 'SELECT');
  if (typing) {
    if (!pendingRefresh) { pendingRefresh = true; a!.addEventListener('blur', () => { pendingRefresh = false; requestAnimationFrame(() => refreshSpecWindow(app)); }, { once: true }); }
    return;
  }
  if (specWindowOpen()) renderSpecWindow(app);
  if (windowOpen('msrules')) renderRulesWindow(app);
}

/** Measure ▸ Measure spec…: the Select tool comes with it (rows and rules are built from the selection). */
export function openSpecWindow(app: App) {
  if (app.tool?.id !== 'select') app.setTool('select');
  renderSpecWindow(app);
}

const MOVE_OPTS: [string, string][] = [['with', 'With the line end'], ['along', 'Along the line'], ['x', 'X only'], ['y', 'Y only'], ['angle', 'Angle']];
const MOVE_SHORT: Record<string, string> = { with: 'with line', along: 'along', x: 'X', y: 'Y', angle: 'angle' };

export function renderSpecWindow(app: App) {
  const W = 640;
  const win = floatingWindow('mspec', 'Measure spec', { width: W, x: Math.max(50, window.innerWidth - W - 320), y: 80, onClose: () => { closeWindow('msrules'); app.invalidate('canvas'); } });
  win.el.classList.add('specwin');
  keepScroll(win.body, SS.scroll); clear(win.body); clear(win.foot);
  const rerender = () => { renderSpecWindow(app); if (windowOpen('msrules')) renderRulesWindow(app); app.invalidate('canvas'); };
  const run = (label: string, fn: () => void) => { try { fn(); } catch (err) { reportError(err, label); } rerender(); };
  const list = items(app);
  if (!list.some(x => x.id === SS.cur)) SS.cur = list[0]?.id ?? null;
  const cur = list.find(x => x.id === SS.cur) ?? null;
  const u = unitLabel();
  const line = app.sizeLine();

  // ── top: size drop-down + add
  const sizeSel = selectInput(app.activeSize, line.sizes.map(s => [s.id, s.name + (s.id === line.baseSizeId ? ' ★' : '')] as [string, string]), v => { app.activeSize = v; app.invalidate(); rerender(); });
  sizeSel.classList.add('sp-size'); sizeSel.title = 'The size the chart shows (★ = base size)';
  const haveMeasure = !!(MS.groups.some(g => g.parts.length) || MS.history.length);
  win.body.append(h('div.sp-bar', {},
    h('span.dim', {}, 'Size'), sizeSel,
    h('span.spacer'),
    h('span.dim', {}, 'Add'),
    h('button.btn.sm', { 'data-act': 'from-sel', title: 'From what is selected: outline segment(s) or an internal line = a line; exactly two points = a straight distance', onclick: () => run('Add to spec', () => { addSpecFromSelection(app); }) }, '+ From selection'),
    h('button.btn.sm' + (haveMeasure ? '' : '.disabled'), { 'data-act': 'from-measure', title: 'From the Measure tool: the open measurement, else the last kept one', onclick: () => run('Add to spec', () => { addSpecFromMeasure(app); }) }, '+ From Measure tool'),
  ));

  // ── the chart
  if (!list.length) {
    win.body.append(h('div.empty', {}, 'No points of measure yet. Select a line (outline segment or internal line) or two points and press “+ From selection”. Then type a target and Apply: the pattern follows the spec.'));
  } else {
    const t = h('table.fw-table.sp-list');
    t.append(h('tr', {}, h('th', {}, ''), h('th', {}, 'Measurement'), h('th', { title: 'Σ length × quantity, in the chosen size' }, `Total (${u})`), h('th', { title: 'Type a new value, then Apply' }, 'Target'), h('th', {}, 'Diff'), h('th', {}, ''), h('th', {}, '')));
    for (const it of list) {
      const rows = ops.specRows(app.doc, it.id);
      const row = rows.find(r => r.sizeId === app.activeSize) ?? rows[0];
      const dead = !rows.length || row?.value === null;
      const isOpen = SS.open.has(it.id);
      const name = textInput(it.name, v => run('Rename', () => ops.updateSpecItem(app.doc, it.id, { name: v })));
      name.classList.add('sp-name');
      const isBase = !!row && row.sizeId === line.baseSizeId;
      const tgt = lengthInput(row?.target ?? NaN, v => run('Spec target', () => {
        if (!row) return;
        // base size: the whole spec shifts by the same amount (the grading between sizes is kept); another size: only that size
        const from = row.target ?? row.value;
        if (isBase && from !== null) ops.setSpecTargets(app.doc, it.id, Object.fromEntries(rows.map(r => [r.sizeId, r.sizeId === row.sizeId ? v : r.target !== null ? r.target + (v - from) : null]).filter(([, x]) => x !== null)));
        else ops.setSpecTargets(app.doc, it.id, { [row.sizeId]: v });
        SS.result.delete(it.id);
      }), { min: 0, blankIfNaN: true, title: isBase ? `Target for the base size ${row?.sizeName ?? ''}. Changing it shifts every size's target by the same amount (grading kept). Then Apply.` : `Target for size ${row?.sizeName ?? ''} only — type a value, then Apply` });
      tgt.classList.add('sp-target'); tgt.dataset.item = it.id;
      const off = row && row.diff !== null && Math.abs(row.diff) > TOL;
      const sizesOff = rows.filter(r => r.diff !== null && Math.abs(r.diff) > TOL).length;
      const nMove = it.movers.filter(m => m.share !== 0).length;
      const tr = h('tr.sp-pom' + (it.id === SS.cur ? '.cur' : ''), { 'data-item': it.id },
        h('td.sp-tw', {}, h('button.mini.sp-exp', { 'data-act': 'expand', title: isOpen ? 'Hide the lines of this measurement' : 'Show the lines of this measurement: piece, length, quantity', onclick: (e: Event) => { e.stopPropagation(); if (isOpen) SS.open.delete(it.id); else SS.open.add(it.id); SS.cur = it.id; rerender(); } }, isOpen ? '▾' : '▸')),
        h('td', {}, name),
        h('td.sp-total', {}, dead ? h('span.warnc', { title: 'The measured line or point no longer exists' }, 'missing') : fmt(row!.value!)),
        h('td', {}, dead ? '' : tgt),
        h('td' + (off ? '.fail' : row?.diff !== null && !dead ? '.pass' : ''), { title: sizesOff ? `${sizesOff} size(s) off spec` : 'Every size with a target is on spec' }, dead || row?.diff == null ? '' : (row.diff > 0 ? '+' : '') + fmt(row.diff) + (sizesOff > (off ? 1 : 0) ? ' *' : '')),
        h('td.sp-acts', {},
          h('button.btn.sm', { 'data-act': 'apply-one', title: 'Alter the pattern so this measurement hits its target in every size that has one (one undo step)', onclick: (e: Event) => { e.stopPropagation(); SS.cur = it.id; run('Apply spec', () => apply(app, [it.id], true)); } }, 'Apply'),
          h('button.btn.sm' + (nMove ? '' : '.warnb'), { 'data-act': 'rules', title: (it.movers.map(m => `${pointLabel(app, m.pieceId, m.anchorId)} · ${MOVE_SHORT[m.dir]}${m.dir === 'angle' ? ' ' + (m.angleDeg ?? 0) + '°' : ''} × ${m.share}`).join('\n') || 'No point is set to move') + '\n\nOpen the rule maker: which points move, and how', onclick: (e: Event) => { e.stopPropagation(); SS.cur = it.id; openRules(app, it.id); rerender(); } }, `Rules (${nMove})`)),
        h('td', {}, h('button.mini', { title: 'Remove from the spec (the pattern is not changed)', onclick: (e: Event) => { e.stopPropagation(); run('Remove', () => { ops.removeSpecItem(app.doc, it.id); SS.result.delete(it.id); SS.open.delete(it.id); if (SS.rulesFor === it.id) closeWindow('msrules'); }); } }, '×')),
      );
      tr.addEventListener('click', e => { if ((e.target as Element).closest('input,button,select')) { if (SS.cur !== it.id) { SS.cur = it.id; app.invalidate('canvas'); } return; } SS.cur = it.id; rerender(); });
      t.append(tr);
      if (isOpen) {
        // the lines behind the total, as in a measurement chart's details: piece · length · quantity —
        // and, per line, its own target, Apply and Rules (a line's target changes that line only)
        const det = ops.specDetails(app.doc, it.id, row?.sizeId);
        const isLine = it.kind === 'line';
        t.append(h('tr.sp-dh', {}, h('td', {}, ''), h('td.dim', {}, 'Piece · line'), h('td.dim', {}, 'Length'), h('td.dim', { title: 'Target length of this line alone (not × quantity). Type a value, then Apply on this line.' }, isLine ? 'Target' : ''), h('td.dim', {}, isLine ? 'Diff' : ''), h('td', {}, ''), h('td.dim', { title: 'How many times the line counts in the total (2 for a half piece)' }, 'Qty')));
        det.forEach(d => {
          const q = numberInput(d.qty, v => run('Quantity', () => { ops.setSpecQty(app.doc, it.id, d.index, v); SS.result.delete(it.id); }), { min: 0.0001, decimals: 3, title: 'How many times this line counts in the total (2 for a half piece)' });
          q.classList.add('sp-qty'); q.dataset.qty = String(d.index);
          const what = isLine ? partLabel(app, it.parts[d.index]) : describe(app, it);
          let cells: (HTMLElement | string)[] = ['', '', ''];
          if (isLine) {
            const lrows = ops.specLineRows(app.doc, it.id, d.index);
            const lrow = lrows.find(r => r.sizeId === (row?.sizeId ?? app.activeSize));
            const lineId = `${it.id}:${d.index}`;
            const lt = lengthInput(lrow?.target ?? NaN, v => run('Line target', () => {
              if (!lrow) return;
              // base size: every size of this line shifts by the same amount (from its target, else from its length); another size: that size only
              const from = lrow.target ?? lrow.value;
              if (isBase && from !== null) ops.setSpecLineTargets(app.doc, it.id, d.index, Object.fromEntries(lrows.map(r => { const b = r.target ?? r.value; return [r.sizeId, r.sizeId === lrow.sizeId ? v : b !== null ? b + (v - from) : null]; }).filter(([, x]) => x !== null)));
              else ops.setSpecLineTargets(app.doc, it.id, d.index, { [lrow.sizeId]: v });
              SS.result.delete(lineId);
            }), { min: 0, blankIfNaN: true, title: `Target for this line alone in size ${lrow?.sizeName ?? ''} (blank = no target of its own). Then Apply on this line.` });
            lt.classList.add('sp-target', 'sp-ltarget'); lt.dataset.line = lineId; lt.placeholder = d.length === null ? '' : fmt(d.length);
            const loff = !!lrow && lrow.diff !== null && Math.abs(lrow.diff) > TOL;
            const lm = (it.parts[d.index].movers ?? ops.defaultSpecMovers({ kind: 'line', parts: [it.parts[d.index]] })).filter(m => m.share !== 0).length;
            cells = [
              h('td', {}, d.length === null ? '' : lt),
              h('td' + (loff ? '.fail' : lrow?.diff != null ? '.pass' : ''), {}, lrow?.diff == null ? '' : (lrow.diff > 0 ? '+' : '') + fmt(lrow.diff)),
              h('td.sp-acts', {},
                h('button.btn.sm' + (lrow?.target == null ? '.disabled' : ''), { 'data-act': 'apply-line', 'data-line': lineId, title: lrow?.target == null ? 'Type a target for this line first' : 'Alter the pattern so this line alone hits its target (every size that has one; one undo step)', onclick: (e: Event) => { e.stopPropagation(); if (lrow?.target == null) return; SS.cur = it.id; run('Apply spec', () => apply(app, [lineId], true)); } }, 'Apply'),
                h('button.btn.sm' + (lm ? '' : '.warnb'), { 'data-act': 'rules-line', 'data-line': lineId, title: 'Rules of this line: which points move when its own target is applied (default: both ends, half each)', onclick: (e: Event) => { e.stopPropagation(); SS.cur = it.id; openRules(app, it.id, d.index); rerender(); } }, `Rules (${lm})`)),
            ];
          }
          t.append(h('tr.sp-det', { 'data-detail': it.id }, h('td', {}, ''), h('td', { title: what }, what), h('td', {}, d.length === null ? h('span.warnc', {}, 'missing') : fmt(d.length)),
            ...(isLine ? (cells as HTMLElement[]) : [h('td', {}, ''), h('td', {}, ''), h('td', {}, '')]),
            h('td', { title: d.length === null ? '' : `counts as ${fmt(d.length * d.qty)}` }, q)));
        });
        const modes: [string, string][] = it.kind === 'distance' ? [['diagonal', 'Straight'], ['x', 'X only'], ['y', 'Y only']] : [['contour', 'Along the line'], ['diagonal', 'Straight (end to end)'], ['x', 'X only'], ['y', 'Y only']];
        const modeSel = selectInput(it.mode, modes, v => run('Measure mode', () => { ops.updateSpecItem(app.doc, it.id, { mode: v as MeasureMode }); SS.result.delete(it.id); }));
        t.append(h('tr.sp-det', {}, h('td', {}, ''), h('td.dim', {}, 'Measured'), h('td', { colspan: 5, style: 'text-align:left' }, modeSel)));
      }
    }
    win.body.append(t);
    if (list.some(it => ops.specRows(app.doc, it.id).filter(r => r.diff !== null && Math.abs(r.diff) > TOL).length > 1)) win.body.append(h('div.dim.sp-note', {}, '* other sizes are off spec too — choose them in Size, or press All sizes'));
  }

  // ── all sizes of the selected row (paste a spec column from Excel)
  if (cur && SS.allSizes) {
    const rows = ops.specRows(app.doc, cur.id);
    win.body.append(h('div.insp-title', {}, `${cur.name} — all sizes`));
    if (rows.length) {
      const res = SS.result.get(cur.id);
      const rowOf = (r: number) => res?.rows.find(x => x.sizeId === rows[r].sizeId);
      const cols: SGCol[] = [
        { key: 'target', head: 'Target', edit: true, attrs: { 'data-col': 'target' }, title: 'Spec value — type or paste a column from Excel', get: r => rows[r].target },
        { key: 'now', head: 'Total', get: r => rows[r].value },
        { key: 'diff', head: 'Diff', title: 'total − target', attrs: { 'data-col': 'diff' }, cls: r => (rows[r].diff === null ? '' : Math.abs(rows[r].diff!) <= TOL ? 'pass' : 'fail'), get: r => rows[r].diff },
        { key: 'after', head: res?.written ? 'Applied' : 'Preview', title: 'The total after the last Preview / Apply', get: r => (res ? rowOf(r)?.after ?? null : null) },
        { key: 'move', head: 'Moved', title: 'How far the points moved (× share) to get there', get: r => (res && rowOf(r)?.solved ? rowOf(r)!.t : null) },
      ];
      win.body.append(sizeGrid({
        rows: rows.map(r => ({ id: r.sizeId, name: r.sizeName, base: r.sizeId === line.baseSizeId, active: r.sizeId === app.activeSize })), cols, state: SS.scroll, maxHeight: Math.min(260, window.innerHeight - 470), cls: 'sptab',
        onCommit: cells => run('Spec target', () => { ops.setSpecTargets(app.doc, cur.id, Object.fromEntries(cells.map(c => [rows[c.r].sizeId, c.v]))); SS.result.delete(cur.id); }),
        onRowClick: r => { app.activeSize = rows[r].sizeId; app.invalidate(); rerender(); },
      }).el);
    } else win.body.append(h('div.warnline', {}, 'The line or point this measurement was tied to no longer exists. Remove it (×) and add it again.'));
  }
  // ── result of the last preview / apply of the selected row
  if (cur) {
    const res = SS.result.get(cur.id);
    const bad = res?.rows.filter(r => r.target !== null && r.note && !r.solved && r.note !== 'no target' && r.note !== 'not applied') ?? [];
    if (res?.error) win.body.append(h('div.warnline', {}, `${cur.name}: ${res.error}`));
    else if (bad.length) win.body.append(h('div.fw-sum.bad', { 'data-spec': 'missed' }, `${cur.name} — ${bad.map(r => r.sizeName).join(', ')}: ${bad[0].note}`));
    else if (res) win.body.append(h('div.fw-sum', { 'data-spec': 'ok' }, res.written ? `${cur.name}: applied — every size with a target is on spec (max residual ${fmt(res.maxResidual)} ${u})` : res.changed ? `${cur.name}: preview only — press Apply to change the pattern` : `${cur.name}: already on spec`));
  }

  win.foot.append(
    h('button.btn.sm' + (cur ? '' : '.disabled') + (SS.allSizes ? '.on' : ''), { 'data-act': 'all-sizes', title: 'Show / hide one line per size for the selected measurement (type targets per size, or paste a column from Excel)', onclick: () => { SS.allSizes = !SS.allSizes; rerender(); } }, SS.allSizes ? '▾ All sizes' : '▸ All sizes'),
    h('button.btn.sm' + (cur ? '' : '.disabled'), { title: 'Set every target of the selected measurement to what the pattern measures now', onclick: () => { if (cur) run('Targets', () => { ops.setSpecTargets(app.doc, cur.id, Object.fromEntries(ops.specRows(app.doc, cur.id).filter(r => r.value !== null).map(r => [r.sizeId, r.value]))); SS.result.delete(cur.id); }); } }, 'Targets = now'),
    h('button.btn.sm' + (list.length ? '' : '.disabled'), { 'data-act': 'excel', title: 'Save the whole chart as an Excel file: totals, targets and differences in every size, and the piece lines with quantity', onclick: () => { if (list.length) run('Excel', () => exportSpecExcel(app)); } }, 'Excel…'),
    h('span.spacer'),
    h('button.btn.sm' + (cur ? '' : '.disabled'), { 'data-act': 'preview', title: 'Solve the selected measurement without changing the pattern', onclick: () => { if (cur) run('Preview', () => apply(app, [cur.id], false)); } }, 'Preview'),
    h('button.btn.sm' + (cur ? '' : '.disabled'), { 'data-act': 'apply-size', title: 'Apply the selected measurement in the chosen size only', onclick: () => { if (cur) run('Apply spec', () => apply(app, [cur.id], true, [app.activeSize])); } }, 'Apply this size'),
    h('button.btn.sm.primary' + (list.length ? '' : '.disabled'), { 'data-act': 'apply-all', title: 'Apply every measurement of the spec, in list order (one undo step)', onclick: () => { if (list.length) run('Apply spec', () => apply(app, undefined, true)); } }, 'Apply all'),
  );
}

// ───────────────────────── Rules window: the rule maker of one measurement ─────────────────────────

/** What the Rules window edits: a whole measurement, or one of its lines (its own rules for its own target). */
interface RuleTarget { item: MeasureSpecItem; line: number | null; name: string; applyId: Id; movers: SpecMover[]; custom: boolean; set(mv: SpecMover[] | null): void; defaults(): SpecMover[] }
function ruleTarget(app: App): RuleTarget | null {
  const item = items(app).find(x => x.id === SS.rulesFor); if (!item) return null;
  const li = SS.rulesLine;
  if (li === null) return { item, line: null, name: item.name, applyId: item.id, movers: item.movers, custom: true, set: mv => ops.updateSpecItem(app.doc, item.id, { movers: mv ?? ops.defaultSpecMovers(item) }), defaults: () => ops.defaultSpecMovers(item) };
  const part = item.parts[li]; if (item.kind !== 'line' || !part) return null;
  const defaults = () => ops.defaultSpecMovers({ kind: 'line', parts: [part] });
  return { item, line: li, name: `${item.name} · ${partLabel(app, part)}`, applyId: `${item.id}:${li}`, movers: part.movers ?? defaults(), custom: !!part.movers, set: mv => ops.setSpecLineMovers(app.doc, item.id, li, mv), defaults };
}

export function openRules(app: App, id: Id, line: number | null = null) {
  SS.rulesFor = id; SS.rulesLine = line; SS.cur = id;
  SS.lastSelKey = app.sel.anchors.map(a => a.anchorId).join(','); // what is selected now is not auto-added: only what gets selected from here on
  renderRulesWindow(app);
}

/** Auto-add (Rules window option): every point the user selects from now on joins the rules, moving with the line end. */
function autoAddSelected(app: App) {
  const key = app.sel.anchors.map(a => a.anchorId).join(',');
  if (key === SS.lastSelKey) return;
  SS.lastSelKey = key;
  if (!SS.autoAdd || !windowOpen('msrules') || !SS.rulesFor) return;
  const it = ruleTarget(app); if (!it) return;
  const add = app.sel.anchors.filter(a => !it.movers.some(m => m.anchorId === a.anchorId));
  if (!add.length) return;
  try {
    it.set([...it.movers, ...add.map(a => ({ pieceId: a.pieceId, anchorId: a.anchorId, dir: 'with' as const, share: 1 }))]);
    SS.result.delete(it.applyId);
    app.status(`Rules of ${it.name}: added ${add.map(a => pointLabel(app, a.pieceId, a.anchorId)).join(', ')} — moves with the line end`);
  } catch (err) { reportError(err, 'Rules'); }
}

export function renderRulesWindow(app: App) {
  const it = ruleTarget(app);
  if (!it) { closeWindow('msrules'); return; }
  const W = 560;
  // under the Measure spec window when there is room, else beside it — never on top of it
  const sr = document.querySelector('.fwin[data-win="mspec"]')?.getBoundingClientRect();
  const below = !!sr && sr.bottom + 250 < window.innerHeight;
  const win = floatingWindow('msrules', `Rules — ${it.name}`, { width: W, x: sr ? (below ? Math.max(40, sr.right - W) : Math.max(40, sr.left - W - 12)) : Math.max(40, window.innerWidth - W - 340), y: sr && below ? sr.bottom + 8 : 80, onClose: () => { SS.rulesFor = null; SS.rulesLine = null; app.invalidate('canvas'); } });
  win.setTitle(`Rules — ${it.name}`);
  win.el.classList.add('specwin', 'ruleswin');
  clear(win.body); clear(win.foot);
  const rerender = () => { renderRulesWindow(app); if (specWindowOpen()) renderSpecWindow(app); app.invalidate('canvas'); };
  const run = (label: string, fn: () => void) => { try { fn(); } catch (err) { reportError(err, label); } rerender(); };
  const setMovers = (mv: SpecMover[] | null) => run('Rules', () => { it.set(mv); SS.result.delete(it.applyId); });

  if (it.line !== null) win.body.append(h('div.sp-help', {}, h('b', {}, 'Rules of one line. '), `Used when this line's own target is applied${it.custom ? '' : ' (showing the default: both ends, half each)'}.`));
  win.body.append(h('div.dim.sp-help', {}, 'When the target changes, these points move to reach it. Select points on the pattern and add them: “With the line end” makes a point ride along with the end of the measured line.'));
  const mt = h('table.fw-table.sp-rules');
  mt.append(h('tr', {}, h('th', {}, 'Point'), h('th', { title: 'With the line end = same direction and distance as the end of the line · Along the line = lengthens / shortens the line at that point' }, 'How it moves'), h('th', { title: 'Degrees from +X, counter-clockwise (How it moves = Angle)' }, 'Angle°'), h('th', { title: '1 = the whole change · 0.5 = half · −1 = the opposite way · 0 = stays' }, 'Share'), h('th', {}, '')));
  it.movers.forEach((m, i) => {
    const dir = selectInput(m.dir, MOVE_OPTS, v => setMovers(it.movers.map((x, k) => (k === i ? { ...x, dir: v as SpecMover['dir'] } : x))));
    dir.dataset.rule = 'dir';
    const ang = numberInput(m.angleDeg ?? 0, v => setMovers(it.movers.map((x, k) => (k === i ? { ...x, angleDeg: v } : x))), { decimals: 2, title: 'Direction angle in degrees' });
    ang.disabled = m.dir !== 'angle';
    const sh = numberInput(m.share, v => setMovers(it.movers.map((x, k) => (k === i ? { ...x, share: v } : x))), { decimals: 3, title: '1 = whole change · 0.5 = half · −1 = opposite way · 0 = stays' });
    sh.dataset.rule = 'share';
    const sel = app.sel.anchors.some(a => a.anchorId === m.anchorId);
    mt.append(h('tr' + (sel ? '.cur' : ''), { 'data-mover': m.anchorId, title: 'Click to select this point on the pattern' , onclick: (e: Event) => { if ((e.target as Element).closest('input,select,button')) return; const p = app.style.pieces.find(x => x.id === m.pieceId); const c = p && [p.sew, ...p.internals].find(x => x.points.some(a => a.id === m.anchorId)); if (p && c) { SS.lastSelKey = m.anchorId; app.selectAnchor({ pieceId: p.id, contourId: c.id, anchorId: m.anchorId }); } } },
      h('td', {}, pointLabel(app, m.pieceId, m.anchorId)), h('td', {}, dir), h('td', {}, ang), h('td', {}, sh),
      h('td', {}, h('button.mini', { title: 'This point no longer moves', onclick: () => setMovers(it.movers.filter((_, k) => k !== i)) }, '×'))));
  });
  win.body.append(it.movers.length ? mt : h('div.warnline', {}, 'No point is set to move, so Apply cannot change this measurement. Select points and press “+ Add selected points”, or “Reset to line ends”.'));

  const nSel = app.sel.anchors.filter(a => !it.movers.some(m => m.anchorId === a.anchorId)).length;
  const auto = h('label.chk', { title: 'While this window is open, every point you select on the pattern is added to the rules straight away' }, h('input', { type: 'checkbox', checked: SS.autoAdd, 'data-act': 'auto-add', onchange: (e: Event) => { SS.autoAdd = (e.target as HTMLInputElement).checked; SS.lastSelKey = app.sel.anchors.map(a => a.anchorId).join(','); rerender(); } }), ' Add points as I select them');
  win.foot.append(
    h('button.btn.sm' + (nSel ? '.primary' : ''), { 'data-act': 'add-movers', title: 'Add the point(s) selected on the pattern: they move together with the line end (change how in the table)', onclick: () => run('Add points', () => {
      if (!app.sel.anchors.length) throw new Error('Select the point(s) on the pattern first (Select tool: click a point, Shift+click for more), then press this again');
      const add = app.sel.anchors.filter(a => !it.movers.some(m => m.anchorId === a.anchorId)).map(a => ({ pieceId: a.pieceId, anchorId: a.anchorId, dir: 'with' as const, share: 1 }));
      if (!add.length) throw new Error('Those points are already in the rules');
      it.set([...it.movers, ...add]); SS.result.delete(it.applyId);
    }) }, nSel ? `+ Add selected points (${nSel})` : '+ Add selected points'),
    auto,
    h('span.spacer'),
    h('button.btn.sm', { 'data-act': 'rules-reset', title: 'Back to the default: both end points of the line, each with share 0.5 (the line grows equally at both ends)', onclick: () => setMovers(it.line === null ? it.defaults() : null) }, 'Reset to line ends'),
    h('button.btn.sm', { 'data-act': 'rules-preview', title: 'Solve with these rules without changing the pattern (result in the Measure spec window)', onclick: () => run('Preview', () => apply(app, [it.applyId], false)) }, 'Preview'),
    h('button.btn.sm.primary', { 'data-act': 'rules-apply', title: 'Apply this measurement with these rules (one undo step)', onclick: () => run('Apply spec', () => apply(app, [it.applyId], true)) }, 'Apply'),
  );
}

// ───────────────────────── canvas overlay: the selected measurement and its moving points ─────────────────────────

registerOverlay('mspec', app => {
  if ((!specWindowOpen() && !windowOpen('msrules')) || !SS.cur) return '';
  let it = items(app).find(x => x.id === SS.cur); if (!it) return '';
  // Rules of one line open: show that line and its moving points
  if (windowOpen('msrules') && SS.rulesFor === it.id && SS.rulesLine !== null && it.kind === 'line' && it.parts[SS.rulesLine]) {
    const part = it.parts[SS.rulesLine];
    it = { ...it, parts: [part], movers: part.movers ?? ops.defaultSpecMovers({ kind: 'line', parts: [part] }) };
  }
  let s = '';
  const pos = (pieceId: Id, anchorId: Id) => {
    const p = app.style.pieces.find(x => x.id === pieceId); if (!p) return null;
    const r = resolveFor(app.doc, p, app.sizeOf(p));
    const cs = [p.sew, ...p.internals], rs = [r.sew, ...r.internals];
    for (let i = 0; i < cs.length; i++) { const k = cs[i].points.findIndex(a => a.id === anchorId); if (k >= 0 && rs[i]) return app.view.toScreen(toWorld(p, rs[i].anchorPos[k])); }
    return null;
  };
  try {
    if (it.kind === 'distance' && it.a && it.b) {
      const a = pos(it.a.pieceId, it.a.anchorId), b = pos(it.b.pieceId, it.b.anchorId);
      if (a && b) s += `<path d="M${a.x} ${a.y}L${b.x} ${b.y}" fill="none" stroke="#12b886" stroke-width="2.5" stroke-dasharray="6 4" opacity=".9"/>`;
    } else for (const part of it.parts) {
      const p = app.style.pieces.find(x => x.id === part.ref.pieceId); const c = p && [p.sew, ...p.internals].find(x => x.id === part.ref.contourId);
      if (p && c) s += `<path d="${screenPath(app, runWorld(app, p, c, part.ref.from, part.ref.to, part.ref.reverse))}" fill="none" stroke="#12b886" stroke-width="4" opacity=".6" stroke-linecap="round"/>`;
    }
    for (const m of it.movers) {
      if (m.share === 0) continue;
      const q = pos(m.pieceId, m.anchorId); if (!q) continue;
      s += `<circle cx="${q.x}" cy="${q.y}" r="7" fill="none" stroke="#f08c00" stroke-width="2"/><circle cx="${q.x}" cy="${q.y}" r="2.2" fill="#f08c00"/>`;
    }
  } catch { /* geometry gone: the window says so */ }
  return s;
});
