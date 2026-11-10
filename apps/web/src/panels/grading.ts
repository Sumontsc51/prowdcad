/**
 * Grading table — ROWS = sizes (1…80+, virtualised), COLUMNS = the selected point(s): dX / dY per
 * point (several points = one column pair each; one point = extra read-only columns X / Y position,
 * the other view, and its rule). No point selected = every grade point of the selected piece.
 *
 * Two plain-language views (Gerber-style, docs/GERBER-GRADING-RESEARCH.md):
 *   “Step into this size”  (Incremental) — the step from the neighbouring size toward the base
 *                          (AccuMark convention: smaller sizes carry their own, usually negative,
 *                          step). Editing a step moves that size and every size further from the
 *                          base: those rows are tinted while the cell has focus.
 *   “Total from base size” (Cumulative)  — the offset from the base ★. Editing changes that size only.
 * “Edit this size only” switches a ripple edit to the total view for the focused cell.
 *
 * Smart fill: type a few rows (they get a dot), pick Equal steps / Interpolate / Repeat step /
 * Split by break, press Fill (kernel smartFill). Size breaks: click the ◆ gutter of a row.
 * Live nest strip: the point's path through all sizes, redrawn while typing.
 * Edits keep a point's rule link (badge turns amber “edited” when its values differ from the rule).
 *
 * Point Tracking (Alt+T): ←/→ previous/next grade point (selection follows, canvas centres on
 * it), ↑/↓ the active size.
 */
import type { SizeId, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { fmt, unitLabel } from '../units-ui';
import { resolveFor, toWorld, sizeColor } from '../geometry';
import { ops } from '../ops-bridge';
import { getCommand, isEnabled, runCommand, effectiveHotkey, reportError } from '../commands';
import { sizeGrid, keepScroll, sizeRows, type SGCol, type SGState } from './sizegrid';
import { toast } from '../ui/toast';
import type { FillMethod } from '@prowdcad/kernel';

interface PtCol { id: Id; contourId: Id; label: string; num: number; ruleLabel: string; total: { dx: number[]; dy: number[] } }

const GS = {
  scroll: { scrollTop: 0 } as SGState,
  /** typed anchors since the last Fill: colKey → (row → value in the view it was typed in) */
  typed: new Map<string, Map<number, number>>(),
  typedView: 'step' as 'step' | 'total',
  /** rows the focused edit affects */
  aff: new Set<number>(),
  focus: null as { r: number; c: number } | null,
  /** uncommitted typed value (live strip) */
  live: null as { r: number; c: number; v: number } | null,
  method: 'linear' as FillMethod,
  pieceKey: '',
};

const VIEW_TIP = {
  step: 'Step into this size: the change from the neighbouring size toward the base ★. Editing a step moves that size AND every size further from the base (AccuMark incremental). The tinted rows show which sizes an edit moves.',
  total: 'Total from base size: the offset from the base ★. Editing a total changes that size only (AccuMark Maintain Growths / absolute).',
};

export function renderGrading(app: App, host: HTMLElement) {
  keepScroll(host, GS.scroll);
  clear(host);
  const piece = app.primaryPiece();
  const line = app.sizeLine();
  const view: 'step' | 'total' = app.gradeAbsolute ? 'total' : 'step';
  const bar = h('div.gr-bar');
  const mode = h('div.seg');
  for (const [abs, label, sub] of [[false, 'Step into this size', 'Incremental'], [true, 'Total from base size', 'Cumulative']] as const) {
    mode.append(h('button' + (app.gradeAbsolute === abs ? '.on' : ''), { title: abs ? VIEW_TIP.total : VIEW_TIP.step, 'data-view': abs ? 'total' : 'step', onclick: () => { app.gradeAbsolute = abs; GS.typed.clear(); app.invalidate('panels'); } }, label, h('span.seg-sub', {}, ' · ' + sub)));
  }
  const track = h('button.btn.sm' + (app.pointTracking ? '.on' : ''), { title: 'Point Tracking: ←/→ previous/next grade point, ↑/↓ size (Alt+T)', onclick: () => { app.pointTracking = !app.pointTracking; app.invalidate('panels'); } }, app.pointTracking ? '◉ Tracking' : '○ Tracking');
  bar.append(mode, track, h('span.dim', {}, unitLabel()));
  const tools = h('div.gr-tools');
  for (const [id, label, tip] of TOOLBAR) {
    if (id === '|') { tools.append(h('span.gr-sep')); continue; }
    const c = getCommand(id); if (!c) continue;
    tools.append(h('button.btn.sm' + (isEnabled(c) ? '' : '.disabled'), { title: `${tip}${effectiveHotkey(id) ? ` (${effectiveHotkey(id).split(',')[0]})` : ''}`, 'data-cmd': id, onclick: () => void runCommand(id) }, label));
  }
  bar.append(tools);
  host.append(bar);
  if (!piece) { host.append(noteEl(app, view, null), h('div.empty', {}, 'Select a piece (or points) to see its grading. Rows = sizes, columns = points.')); return; }
  const live = app.doc.piece(piece.id);
  const key = live.id + '|' + app.sel.anchors.map(a => a.anchorId).join(',') + '|' + view;
  if (key !== GS.pieceKey) { GS.pieceKey = key; GS.typed.clear(); GS.aff.clear(); GS.live = null; }

  // ── columns: selected points of this piece, else all its grade points ──
  let table;
  try { table = ops.gradingTable(app.doc, live.id, { view: 'absolute', all: true, internals: true }); } catch (err) { reportError(err, 'Grading table'); return; }
  const selIds = app.sel.anchors.filter(a => a.pieceId === live.id).map(a => a.anchorId);
  const rowsK = selIds.length ? selIds.map(id => table.rows.find(r => r.id === id)).filter(Boolean) as typeof table.rows : table.rows.filter(r => r.kind === 'grade' && r.contourId === live.sew.id);
  if (!rowsK.length) { host.append(noteEl(app, view, null), h('div.empty', {}, 'No grade points.')); return; }
  const sizes = line.sizes;
  const b = sizes.findIndex(s => s.id === line.baseSizeId);
  const build = (rk: typeof rowsK): PtCol[] => rk.map(r => {
    let rl = ''; try { rl = ops.ruleName(app.doc, live.id, r.id); } catch { /* */ }
    const contour = r.contourId === live.sew.id ? live.sew : live.internals.find(c => c.id === r.contourId)!;
    return {
      id: r.id, contourId: r.contourId, num: r.index + 1, ruleLabel: rl,
      label: `${contour === live.sew ? '' : 'int '}${r.index + 1}${r.name ? ' ' + r.name : ''}${r.interpolated ? ' (follows)' : ''}`,
      total: { dx: sizes.map(s => r.cells[s.id]?.dx ?? 0), dy: sizes.map(s => r.cells[s.id]?.dy ?? 0) },
    };
  });
  const pts: PtCol[] = build(rowsK);
  const posOf = (id: Id) => sizes.map(s => { try { return ops.gradedPosition(app.doc, live.id, id, s.id); } catch { return { x: NaN, y: NaN }; } });
  const posCache = new Map<Id, { x: number; y: number }[]>();
  /** re-read the grading after a commit (the grid keeps focus, so the panel is not rebuilt) */
  const reload = () => {
    try {
      const t2 = ops.gradingTable(app.doc, live.id, { view: 'absolute', all: true, internals: true });
      const fresh = build(pts.map(p => t2.rows.find(r => r.id === p.id)).filter(Boolean) as typeof rowsK);
      fresh.forEach(f => { const p = pts.find(q => q.id === f.id); if (p) { p.total = f.total; p.ruleLabel = f.ruleLabel; } });
      posCache.clear();
    } catch { /* */ }
  };
  const breaks = (() => { try { return ops.sizeBreaks(app.doc, line.id); } catch { return []; } })();
  const brkIdx = breaks.map(id => sizes.findIndex(s => s.id === id)).filter(i => i >= 0);
  const readOnly = live.locked;

  const valOf = (p: PtCol, axis: 'dx' | 'dy', v: 'step' | 'total') => (v === 'total' ? p.total[axis] : ops.outwardSteps(p.total[axis], b));
  const cols: SGCol[] = [];
  pts.forEach(p => {
    const grp = p.label + (p.ruleLabel ? ` · rule ${p.ruleLabel}` : '');
    for (const axis of ['dx', 'dy'] as const) {
      const ck = p.id + ':' + axis;
      cols.push({
        key: ck, group: grp, groupTitle: p.ruleLabel ? `Rule ${p.ruleLabel}${p.ruleLabel.endsWith('*') ? ' — locally edited (values differ from the rule)' : ''}` : 'No rule',
        head: axis === 'dx' ? 'dX' : 'dY', edit: !readOnly,
        title: view === 'step' ? VIEW_TIP.step : VIEW_TIP.total,
        attrs: { 'data-pt': p.label.split(' (')[0], 'data-axis': axis, 'data-view': view },
        get: r => valOf(p, axis, view)[r],
        ro: r => r === b,
        cls: r => [GS.typed.get(ck)?.has(r) ? 'typed' : '', r === b ? 'basecell' : ''].join(' ').trim(),
      });
    }
    if (pts.length === 1) {
      const other = view === 'step' ? 'total' : 'step';
      const pos = () => { let v = posCache.get(p.id); if (!v) posCache.set(p.id, v = posOf(p.id)); return v; };
      cols.push(
        { key: p.id + ':x', group: 'Position', head: 'X', get: r => pos()[r].x, attrs: { 'data-axis': 'x' } },
        { key: p.id + ':y', group: 'Position', head: 'Y', get: r => pos()[r].y, attrs: { 'data-axis': 'y' } },
        { key: p.id + ':ox', group: other === 'total' ? 'Total from base' : 'Step', head: 'dX', get: r => valOf(p, 'dx', other)[r], attrs: { 'data-axis': 'o' + 'dx' } },
        { key: p.id + ':oy', group: other === 'total' ? 'Total from base' : 'Step', head: 'dY', get: r => valOf(p, 'dy', other)[r], attrs: { 'data-axis': 'o' + 'dy' } },
      );
    }
  });
  const editCols = cols.map((c, i) => ({ c, i })).filter(x => x.c.edit);

  const commit = (cells: { r: number; c: number; v: number }[]) => {
    const touched = new Map<PtCol, { dx: number[]; dy: number[] }>();
    for (const { r, c, v } of cells) {
      const col = cols[c]; const [pid, axis] = col.key.split(':') as [Id, 'dx' | 'dy'];
      const p = pts.find(q => q.id === pid)!; if (!p || r === b) continue;
      const t = touched.get(p) ?? { dx: p.total.dx.slice(), dy: p.total.dy.slice() };
      if (view === 'total') t[axis][r] = v;
      else { const st = ops.outwardSteps(t[axis], b); st[r] = v; t[axis] = ops.totalsFromSteps(st, b); }
      touched.set(p, t);
      let m = GS.typed.get(col.key); if (!m) GS.typed.set(col.key, m = new Map());
      m.set(r, v); GS.typedView = view;
    }
    if (!touched.size) return;
    writeTotals(app, live.id, [...touched].map(([p, t]) => ({ p, t })), sizes.map(s => s.id), 'Grading table edit');
    reload();
    queueMicrotask(() => drawStrip(strip, app, pts, cols, b, view, sizes.map(s => s.id), live.id));
    if (view === 'step' && cells.length === 1) {
      const moved = ops.affectedSizes(sizes.length, b, cells[0].r, 'step').map(i => sizes[i].name);
      if (moved.length > 1) app.status(`Step edit moved sizes ${moved.join(', ')} · “Total from base size” (or Edit this size only) changes one size`);
    }
    GS.live = null;
  };

  const note = noteEl(app, view, null);
  const strip = h('div.gr-strip');
  const grid = sizeGrid({
    rows: sizeRows(line, app.activeSize, breaks), cols, state: GS.scroll, cls: 'gr',
    onCommit: commit,
    onRowClick: r => { app.activeSize = sizes[r].id; app.invalidate(); },
    rowClass: r => (GS.aff.has(r) ? 'aff' : ''),
    rowExtra: r => h('button.sg-brk' + (brkIdx.includes(r) ? '.on' : ''), {
      title: brkIdx.includes(r) ? 'Size break (click to remove) — Split by break fills between breaks' : 'Make this a size break (AccuMark Edit Size Breaks)',
      onclick: (e: Event) => { e.stopPropagation(); if (r === b) { toast('The base size is always a break', 'info'); return; } const s = new Set(breaks); if (s.has(sizes[r].id)) s.delete(sizes[r].id); else s.add(sizes[r].id); try { ops.setSizeBreaks(app.doc, line.id, sizes.filter(x => s.has(x.id)).map(x => x.id)); } catch (err) { reportError(err, 'Size breaks'); } },
    }, '◆'),
    onFocus: (r, c) => {
      GS.focus = { r, c };
      GS.aff = new Set(ops.affectedSizes(sizes.length, b, r, view));
      for (const tr of grid.table.querySelectorAll('tbody tr[data-r]')) tr.classList.toggle('aff', GS.aff.has(+(tr as HTMLElement).dataset.r!));
      note.replaceWith(noteEl(app, view, { r, sizes: sizes.map(s => s.name), b }, () => { app.gradeAbsolute = true; GS.scroll.focus = { r, c }; app.invalidate('panels'); requestAnimationFrame(() => (host.querySelector(`input[data-r="${r}"][data-c="${c}"]`) as HTMLInputElement | null)?.focus()); }));
    },
    onInput: (r, c, v) => { GS.live = v === null ? null : { r, c, v }; drawStrip(strip, app, pts, cols, b, view, sizes.map(s => s.id), live.id); },
  });
  host.append(note);
  // smart fill + breaks bar
  const fill = h('div.gr-fill');
  const msel = h('select.gr-method', { title: 'How Fill completes the rows you did not type' }) as HTMLSelectElement;
  for (const [v, l] of [['linear', 'Equal steps'], ['interpolate', 'Interpolate'], ['repeat', 'Repeat step'], ['breaks', 'Split by break']] as const) msel.append(h('option', { value: v }, l));
  msel.value = GS.method; msel.onchange = () => { GS.method = msel.value as FillMethod; };
  msel.addEventListener('keydown', e => e.stopPropagation());
  const nTyped = [...GS.typed.values()].reduce((n, m) => n + m.size, 0);
  fill.append(h('span.dim', {}, 'Smart fill:'), msel,
    h('button.btn.sm.primary' + (nTyped ? '' : '.disabled'), { 'data-act': 'fill', title: 'Fill the other sizes from the rows you typed (dots). Equal steps · Interpolate between typed rows · Repeat a typed step outward · Split the change at each size break evenly', onclick: () => doFill(app, live.id, pts, cols, b, view, sizes.map(s => s.id), brkIdx) }, `Fill${nTyped ? ` (${nTyped} typed)` : ''}`),
    h('button.btn.sm', { title: 'Forget the typed-row marks', onclick: () => { GS.typed.clear(); app.invalidate('panels'); } }, 'Clear marks'),
    h('span.dim', {}, breaks.length ? `Breaks: ${breaks.map(id => sizes.find(s => s.id === id)?.name).join(' ')}` : 'Breaks: click ◆ next to a size'),
  );
  host.append(fill);
  const body = h('div.gr-body', {}, grid.el, strip);
  host.append(body);
  drawStrip(strip, app, pts, cols, b, view, sizes.map(s => s.id), live.id);
}

/** the plain-language line above the table; with a focused cell it names the sizes that edit moves */
function noteEl(app: App, view: 'step' | 'total', f: { r: number; sizes: string[]; b: number } | null, onlyThis?: () => void): HTMLElement {
  if (!f || f.r === f.b) {
    return h('div.gr-note' + (view === 'step' ? '.warn' : ''), { title: view === 'step' ? VIEW_TIP.step : VIEW_TIP.total }, view === 'step'
      ? 'Step view: a step edit also moves every size further from the base (XL follows L). Use “Total from base size” to change one size.'
      : 'Total view: offsets from the base size ★ — editing a size changes that size only.');
  }
  const moved = ops.affectedSizes(f.sizes.length, f.b, f.r, view).map(i => f.sizes[i]);
  const el = h('div.gr-note' + (moved.length > 1 ? '.warn' : ''), {},
    moved.length > 1 ? `Editing ${f.sizes[f.r]}'s step moves ${moved.join(', ')} (${moved.length} sizes, tinted). ` : `Editing ${f.sizes[f.r]} changes ${f.sizes[f.r]} only. `);
  if (moved.length > 1 && onlyThis) el.append(h('button.btn.sm', { 'data-act': 'only', title: 'Switch to Total from base size for this cell: the edit changes this size only', onmousedown: (e: Event) => e.preventDefault(), onclick: onlyThis }, `Edit ${f.sizes[f.r]} only`));
  return el;
}

/** Write per-point totals (local frame, every size) as one undo step; rule links are kept (badge shows “edited”). */
function writeTotals(app: App, pieceId: Id, list: { p: PtCol; t: { dx: number[]; dy: number[] } }[], sizeIds: SizeId[], label: string) {
  try {
    app.doc.transact(label, () => {
      for (const { p, t } of list) {
        const piece = app.doc.piece(pieceId);
        const a = [piece.sew, ...piece.internals].flatMap(c => c.points).find(x => x.id === p.id);
        const rule = a?.ruleId;
        const cells: Record<SizeId, { dx: number; dy: number }> = {};
        sizeIds.forEach((s, i) => { cells[s] = { dx: t.dx[i], dy: t.dy[i] }; });
        ops.setGradeRow(app.doc, pieceId, p.id, cells, { view: 'absolute' });
        if (rule && a) a.ruleId = rule;
      }
    });
  } catch (err) { reportError(err, 'Grade'); }
}

function doFill(app: App, pieceId: Id, pts: PtCol[], cols: SGCol[], b: number, view: 'step' | 'total', sizeIds: SizeId[], brk: number[]) {
  const list: { p: PtCol; t: { dx: number[]; dy: number[] } }[] = [];
  for (const p of pts) {
    const t = { dx: p.total.dx.slice(), dy: p.total.dy.slice() };
    let any = false;
    for (const axis of ['dx', 'dy'] as const) {
      const m = GS.typed.get(p.id + ':' + axis); if (!m?.size) continue;
      any = true;
      const res = ops.smartFill(t[axis], b, [...m].map(([i, v]) => ({ i, v })), GS.typedView, GS.method, brk);
      t[axis] = res.totals;
    }
    if (any) list.push({ p, t });
  }
  void cols; void view;
  if (!list.length) { toast('Type values in a few size rows first (they get a dot), then press Fill', 'warn'); return; }
  writeTotals(app, pieceId, list, sizeIds, 'Smart fill (' + GS.method + ')');
  app.status(`Smart fill: ${GS.method === 'linear' ? 'equal steps' : GS.method === 'breaks' ? 'split by break' : GS.method} · ${list.length} point(s)`);
  GS.typed.clear();
}

/** Live nest strip of the grading table: maps the live cell to its point / axis. */
function drawStrip(el: HTMLElement, app: App, pts: PtCol[], cols: SGCol[], b: number, view: 'step' | 'total', sizeIds: SizeId[], pieceId: Id) {
  let live: LiveCell | null = null;
  if (GS.live) {
    const [pid, axis] = cols[GS.live.c].key.split(':');
    const k = pts.findIndex(p => p.id === pid);
    if (k >= 0 && (axis === 'dx' || axis === 'dy')) live = { k, axis, r: GS.live.r, v: GS.live.v, view };
  }
  drawNestStrip(el, app.sizeLine(), pts, b, app.activeSize, live);
  void sizeIds; void pieceId;
}

export interface LiveCell { k: number; axis: 'dx' | 'dy'; r: number; v: number; view: 'step' | 'total' }
/**
 * Nest preview strip: the path of each series (a point or a rule) through all sizes — offsets from
 * the base (base = white ring, active size filled), with an uncommitted typed value applied live.
 */
export function drawNestStrip(el: HTMLElement, line: { sizes: { id: SizeId; name: string }[]; baseSizeId: SizeId; id: string; name: string }, series: { total: { dx: number[]; dy: number[] } }[], b: number, activeId: SizeId, live: LiveCell | null) {
  const W = 150, H = 150, pad = 14;
  const sizeIds = line.sizes.map(s => s.id);
  const paths = series.slice(0, 6).map((p, k) => {
    const t = { dx: p.total.dx.slice(), dy: p.total.dy.slice() };
    if (live && live.k === k) {
      if (live.view === 'total') t[live.axis][live.r] = live.v;
      else { const st = ops.outwardSteps(t[live.axis], b); st[live.r] = live.v; t[live.axis] = ops.totalsFromSteps(st, b); }
    }
    return sizeIds.map((_, i) => ({ x: t.dx[i], y: t.dy[i] }));
  });
  let m = 1; for (const q of paths) for (const v of q) m = Math.max(m, Math.abs(v.x), Math.abs(v.y));
  const k = (Math.min(W, H) / 2 - pad) / m;
  const X = (v: number) => (W / 2 + v * k).toFixed(1), Y = (v: number) => (H / 2 - v * k).toFixed(1);
  let s = `<line x1="${W / 2}" y1="4" x2="${W / 2}" y2="${H - 4}" class="ax"/><line x1="4" y1="${H / 2}" x2="${W - 4}" y2="${H / 2}" class="ax"/>`;
  const ai = sizeIds.indexOf(activeId);
  for (const q of paths) {
    s += `<path d="${q.map((v, i) => `${i ? 'L' : 'M'}${X(v.x)} ${Y(v.y)}`).join('')}" class="path"/>`;
    q.forEach((v, i) => {
      const col = i === b ? '#ffffff' : sizeColor(line as Parameters<typeof sizeColor>[0], sizeIds[i]);
      s += `<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${i === b ? 3.6 : i === ai ? 3.2 : 2}" fill="${i === ai ? col : 'none'}" stroke="${col}" stroke-width="1.2"><title>${line.sizes[i].name}: ${fmt(v.x)}, ${fmt(v.y)}</title></circle>`;
    });
  }
  el.innerHTML = `<div class="gr-strip-h">Nest preview${live ? ' · live' : ''}</div><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-n="${sizeIds.length}" data-live="${live ? 1 : 0}">${s}</svg><div class="dim">± ${fmt(m)} ${unitLabel()} · ${series.length > 6 ? 'first 6' : series.length + ' path(s)'}</div>`;
}

const TOOLBAR: [string, string, string][] = [
  ['grade.copy', 'Copy', 'Copy grade of selected points'], ['grade.paste', 'Paste', 'Paste grade'], ['grade.pasteX', 'X', 'Paste X only'], ['grade.pasteY', 'Y', 'Paste Y only'],
  ['grade.smartPaste', 'Smart', 'Smart paste (flips X across the mirror axis)'], ['grade.pasteAround', 'Around', 'Paste around a run'], ['|', '', ''],
  ['grade.flipX', '⇋X', 'Flip X'], ['grade.flipY', '⇅Y', 'Flip Y'], ['grade.equalX', '=X', 'Equal X'], ['grade.equalY', '=Y', 'Equal Y'],
  ['grade.deleteX', '∅X', 'Delete X'], ['grade.deleteY', '∅Y', 'Delete Y'], ['grade.zero', '∅', 'Delete all grading'], ['|', '', ''],
  ['grade.stackPoint', 'Stack', 'Stack nest at a point'], ['grade.stackLine', 'Stack line', 'Stack along line'], ['grade.angle', '∠', 'Angle grading (auto-aim)'],
  ['grade.parallel', '∥', 'Grade parallel'], ['grade.proportional', 'Prop', 'Grade proportionally'], ['|', '', ''],
  ['grade.rules', 'Rules', 'Grade rules window (rule table, library chips)'], ['grade.byMeasurement', 'By measure', 'Grade by measurement: solve the selected points to hit a spec'], ['grade.badges', '#', 'Rule badges on the canvas'], ['grade.movement', 'MTM', 'Movement programs'],
];

/** Point-tracking key handling; returns true when consumed. */
export function trackingKey(app: App, e: KeyboardEvent, centreOn: (x: number, y: number) => void): boolean {
  if (!app.pointTracking || e.ctrlKey || e.metaKey || e.altKey) return false;
  const line = app.sizeLine();
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const ids = line.sizes.map(s => s.id);
    const i = ids.indexOf(app.activeSize);
    const j = Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    app.activeSize = ids[j]; app.status(`Size ${line.sizes[j].name}`); app.invalidate();
    return true;
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
  const piece = app.primaryPiece(); if (!piece) return false;
  const g = piece.sew.points.filter(a => a.kind === 'grade');
  if (!g.length) return false;
  const cur = app.primaryAnchor();
  let k = cur && cur.contour === piece.sew ? g.findIndex(a => a.id === cur.anchor.id) : -1;
  k = k < 0 ? 0 : (k + (e.key === 'ArrowRight' ? 1 : -1) + g.length) % g.length;
  app.selectAnchor({ pieceId: piece.id, contourId: piece.sew.id, anchorId: g[k].id });
  const r = resolveFor(app.doc, piece, app.sizeOf(piece));
  const idx = piece.sew.points.indexOf(g[k]);
  const w = toWorld(piece, r.sew.anchorPos[idx]);
  centreOn(w.x, w.y);
  app.status(`Point ${idx + 1}${g[k].name ? ' · ' + g[k].name : ''}`);
  return true;
}
