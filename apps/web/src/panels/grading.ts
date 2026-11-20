/**
 * Grading table — ROWS = sizes (1…80+, virtualised), COLUMNS = the selected point(s): dX / dY per
 * point (several points = one column pair each; one point = extra read-only columns with the other
 * view of the same grading). No point selected = every grade point of the selected piece.
 *
 * Three views of the same grading:
 *   “Step into this size”   — the step from the neighbouring size toward the base ★ (AccuMark incremental:
 *                             smaller sizes carry their own, usually negative, step). A step edit moves that
 *                             size and every size further from the base.
 *   “Total from base size”  — the offset from the base ★. An edit changes that size only.
 *   “Small → large”         — every size shows the change from the next SMALLER size, running from the
 *                             smallest size up (the smallest size has no entry). The base ★ stays where it is.
 *
 * The cells work like a spreadsheet (sizegrid sheet mode): drag / Ctrl+click / Shift+click to select cells and
 * type one value into all of them; a value can be a calculation; a zero shows as a blank cell; right-click =
 * Double · Half · Multiply by… · Add constant… · Subtract constant…; drag the corner square to fill down;
 * Enter = next size down, arrows move. Only dX / dY entry lives here: copy / paste / flip / rules / stack are
 * in the Grade menu and on the Edit Grade tool.
 * Live nest strip: the point's path through all sizes, redrawn while typing.
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
import { reportError } from '../commands';
import { sizeGrid, keepScroll, sizeRows, type SGCol, type SGState } from './sizegrid';

interface PtCol { id: Id; contourId: Id; label: string; num: number; ruleLabel: string; total: { dx: number[]; dy: number[] } }

type GView = 'step' | 'total' | 'inc';
const GS = {
  scroll: { scrollTop: 0 } as SGState,
  /** rows the focused edit affects */
  aff: new Set<number>(),
  focus: null as { r: number; c: number } | null,
  /** uncommitted typed value (live strip) */
  live: null as { r: number; c: number; v: number } | null,
  pieceKey: '',
};

const VIEW_TIP: Record<GView, string> = {
  step: 'Step into this size: the change from the neighbouring size toward the base ★. Editing a step moves that size AND every size further from the base (AccuMark incremental). The tinted rows show which sizes an edit moves.',
  total: 'Total from base size: the offset from the base ★. Editing a total changes that size only (AccuMark Maintain Growths / absolute).',
  inc: 'Small → large: every size shows the change from the next smaller size, from the smallest size up. The base ★ stays where it is: an entry above the base moves that size and the larger ones, an entry at or below the base moves the smaller ones.',
};
/** Small → large: inc[r] = total[r] − total[r−1]; the smallest size has no entry */
const incOf = (t: number[]): (number | null)[] => t.map((v, r) => (r === 0 ? null : v - t[r - 1]));
/** totals from small → large increments, with the base kept at 0 */
function totalsFromInc(inc: (number | null)[], b: number): number[] {
  const t = new Array<number>(inc.length).fill(0);
  for (let r = b + 1; r < inc.length; r++) t[r] = t[r - 1] + (inc[r] ?? 0);
  for (let r = b - 1; r >= 0; r--) t[r] = t[r + 1] - (inc[r + 1] ?? 0);
  return t;
}
/** sizes an edit of row r moves, per view */
const affected = (n: number, b: number, r: number, view: GView): number[] =>
  view === 'inc' ? (r > b ? Array.from({ length: n - r }, (_, k) => r + k) : Array.from({ length: r }, (_, k) => k)) : ops.affectedSizes(n, b, r, view);

export function renderGrading(app: App, host: HTMLElement) {
  keepScroll(host, GS.scroll);
  clear(host);
  const piece = app.primaryPiece();
  const line = app.sizeLine();
  const view: GView = app.gradeSmallLarge ? 'inc' : app.gradeAbsolute ? 'total' : 'step';
  const bar = h('div.gr-bar');
  // the view is a drop-down; the one chosen stays the default (first time: Small → large)
  const mode = h('select.gr-view', { title: VIEW_TIP[view] }) as HTMLSelectElement;
  for (const [id, label] of [['inc', 'Small → large (XS-S, S-M …)'], ['step', 'Step into this size (from base)'], ['total', 'Total from base size']] as const) mode.append(h('option', { value: id, 'data-view': id }, label));
  mode.value = view;
  mode.onchange = () => { const v = mode.value as GView; mode.blur(); const ae = document.activeElement as HTMLElement | null; if (ae && host.contains(ae)) ae.blur(); app.setGradeView(v); };
  mode.addEventListener('keydown', e => e.stopPropagation());
  bar.append(mode, h('span.dim', {}, unitLabel()), h('span.dim.gr-tip', { title: 'Drag over cells, Ctrl+click or Shift+click = select several · type a value = it goes into every selected cell · a value can be a calculation (10/4, 5+2.5) · right-click = Double, Half, Multiply by…, Add / Subtract constant… · drag the corner square = fill down · Enter = next size · arrows move' }, 'Select cells · type · right-click = calculate · drag the corner = fill'));
  host.append(bar);
  if (!piece) { host.append(noteEl(app, view, null), h('div.empty', {}, 'Select a piece (or points) to see its grading. Rows = sizes, columns = points.')); return; }
  const live = app.doc.piece(piece.id);
  const key = live.id + '|' + app.sel.anchors.map(a => a.anchorId).join(',') + '|' + view;
  if (key !== GS.pieceKey) { GS.pieceKey = key; GS.aff.clear(); GS.live = null; }

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
  /** re-read the grading after a commit (the grid keeps focus, so the panel is not rebuilt) */
  const reload = () => {
    try {
      const t2 = ops.gradingTable(app.doc, live.id, { view: 'absolute', all: true, internals: true });
      const fresh = build(pts.map(p => t2.rows.find(r => r.id === p.id)).filter(Boolean) as typeof rowsK);
      fresh.forEach(f => { const p = pts.find(q => q.id === f.id); if (p) { p.total = f.total; p.ruleLabel = f.ruleLabel; } });
    } catch { /* */ }
  };
  const readOnly = live.locked;

  /** Small → large shows one row per step between two sizes (XS-S, S-M, …): grid row k is the step into size k + 1 */
  const off = view === 'inc' ? 1 : 0;
  const valOf = (p: PtCol, axis: 'dx' | 'dy', v: GView): (number | null)[] => (v === 'total' ? p.total[axis] : v === 'inc' ? incOf(p.total[axis]) : ops.outwardSteps(p.total[axis], b));
  /** the row of a view that cannot be typed in: the base (step / total), the smallest size (small → large) */
  const fixedRow = view === 'inc' ? 0 : b;
  const cols: SGCol[] = [];
  pts.forEach(p => {
    const grp = p.label + (p.ruleLabel ? ` · rule ${p.ruleLabel}` : '');
    for (const axis of ['dx', 'dy'] as const) {
      const ck = p.id + ':' + axis;
      cols.push({
        key: ck, group: grp, groupTitle: p.ruleLabel ? `Rule ${p.ruleLabel}${p.ruleLabel.endsWith('*') ? ' — locally edited (values differ from the rule)' : ''}` : 'No rule',
        head: axis === 'dx' ? 'dX' : 'dY', edit: !readOnly,
        title: VIEW_TIP[view],
        attrs: { 'data-pt': p.label.split(' (')[0], 'data-axis': axis, 'data-view': view },
        get: r => valOf(p, axis, view)[r + off],
        ro: r => r + off === fixedRow,
        cls: r => (r + off === fixedRow ? 'basecell' : ''),
      });
    }
    if (pts.length === 1) {
      const other: GView = view === 'total' ? 'step' : 'total';
      cols.push(
        { key: p.id + ':ox', group: other === 'total' ? 'Total from base' : 'Step', head: 'dX', get: r => valOf(p, 'dx', other)[r + off], attrs: { 'data-axis': 'o' + 'dx' } },
        { key: p.id + ':oy', group: other === 'total' ? 'Total from base' : 'Step', head: 'dY', get: r => valOf(p, 'dy', other)[r + off], attrs: { 'data-axis': 'o' + 'dy' } },
      );
    }
  });

  const commit = (cells: { r: number; c: number; v: number }[]) => {
    const touched = new Map<PtCol, { dx: number[]; dy: number[] }>();
    for (const { r: gr, c, v } of cells) {
      const r = gr + off;
      const col = cols[c]; const [pid, axis] = col.key.split(':') as [Id, 'dx' | 'dy'];
      const p = pts.find(q => q.id === pid)!; if (!p) continue;
      const t = touched.get(p) ?? { dx: p.total.dx.slice(), dy: p.total.dy.slice() };
      if (r === fixedRow || (axis !== 'dx' && axis !== 'dy')) continue;
      if (view === 'total') t[axis][r] = v;
      else if (view === 'inc') { const inc = incOf(t[axis]); inc[r] = v; t[axis] = totalsFromInc(inc, b); }
      else { const st = ops.outwardSteps(t[axis], b); st[r] = v; t[axis] = ops.totalsFromSteps(st, b); }
      touched.set(p, t);
    }
    if (!touched.size) return;
    writeTotals(app, live.id, [...touched].map(([p, t]) => ({ p, t })), sizes.map(s => s.id), 'Grading table edit');
    reload();
    queueMicrotask(() => drawStrip(strip, app, pts, cols, b, view, sizes.map(s => s.id), live.id));
    if (view !== 'total' && cells.length === 1) {
      const moved = affected(sizes.length, b, cells[0].r + off, view).map(i => sizes[i].name);
      if (moved.length > 1) app.status(`${view === 'inc' ? 'The entry' : 'Step edit'} moved sizes ${moved.join(', ')} · “Total from base size” changes one size`);
    } else if (cells.length > 1) app.status(`${cells.length} cells changed · Ctrl+Z undoes`);
    GS.live = null;
  };

  let note = noteEl(app, view, null);
  const strip = h('div.gr-strip');
  const grid = sizeGrid({
    rows: view === 'inc' ? sizes.slice(1).map((z, k) => ({ id: z.id, name: `${sizes[k].name}-${z.name}`, active: z.id === app.activeSize })) : sizeRows(line, app.activeSize), cols, state: GS.scroll, cls: 'gr', sheet: { blankZero: true },
    onCommit: commit,
    onRowClick: r => { app.activeSize = sizes[r + off].id; app.invalidate(); },
    rowClass: r => (GS.aff.has(r) ? 'aff' : ''),
    onFocus: (r, c) => {
      GS.focus = { r, c };
      GS.aff = new Set(affected(sizes.length, b, r + off, view).map(x => x - off).filter(x => x >= 0));
      for (const tr of grid.table.querySelectorAll('tbody tr[data-r]')) tr.classList.toggle('aff', GS.aff.has(+(tr as HTMLElement).dataset.r!));
      const nn = noteEl(app, view, { r: r + off, sizes: sizes.map(s => s.name), b }, () => { app.setGradeView('total'); GS.scroll.focus = { r: r + off, c }; app.invalidate('panels'); requestAnimationFrame(() => (host.querySelector(`input[data-r="${r + off}"][data-c="${c}"]`) as HTMLInputElement | null)?.focus()); });
      note.replaceWith(nn); note = nn;
    },
    onInput: (r, c, v) => { GS.live = v === null ? null : { r, c, v }; drawStrip(strip, app, pts, cols, b, view, sizes.map(s => s.id), live.id); },
  });
  host.append(note);
  const body = h('div.gr-body', {}, grid.el, strip);
  host.append(body);
  drawStrip(strip, app, pts, cols, b, view, sizes.map(s => s.id), live.id);
}

/** the plain-language line above the table; with a focused cell it names the sizes that edit moves */
function noteEl(app: App, view: GView, f: { r: number; sizes: string[]; b: number } | null, onlyThis?: () => void): HTMLElement {
  void app;
  if (!f || f.r === (view === 'inc' ? 0 : f.b)) {
    return h('div.gr-note' + (view === 'total' ? '' : '.warn'), { title: VIEW_TIP[view] }, view === 'step'
      ? 'Step view: a step edit also moves every size further from the base (XL follows L). Use “Total from base size” to change one size.'
      : view === 'inc' ? 'Small → large: each row is the step from one size to the next (XS-S, S-M, …). The base size stays; an entry also moves the sizes beyond it.'
        : 'Total view: offsets from the base size ★ — editing a size changes that size only.');
  }
  const moved = affected(f.sizes.length, f.b, f.r, view).map(i => f.sizes[i]);
  const el = h('div.gr-note' + (moved.length > 1 ? '.warn' : ''), {},
    moved.length > 1 ? `Editing ${view === 'inc' ? `${f.sizes[f.r - 1]}-${f.sizes[f.r]}` : `${f.sizes[f.r]}'s step`} moves ${moved.join(', ')} (${moved.length} sizes, tinted). ` : `Editing ${f.sizes[f.r]} changes ${moved[0] ?? f.sizes[f.r]} only. `);
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

/** Live nest strip of the grading table: maps the live cell to its point / axis. */
function drawStrip(el: HTMLElement, app: App, pts: PtCol[], cols: SGCol[], b: number, view: GView, sizeIds: SizeId[], pieceId: Id) {
  let live: LiveCell | null = null;
  if (GS.live && view !== 'inc') {
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
