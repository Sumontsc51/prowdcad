/**
 * Measure Spec window (Measure ▸ Measure spec…): the style's points of measure.
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
import { floatingWindow, windowOpen } from '../ui/window';
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

const SS = {
  cur: null as Id | null,
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

// ───────────────────────── window ─────────────────────────

let pendingRefresh = false;
/** Redraw when the document / active size / unit changes (not while a field of the window is being typed in). */
export function refreshSpecWindow(app: App) {
  if (!specWindowOpen()) return;
  const el = document.querySelector('.fwin[data-win="mspec"]');
  const a = document.activeElement;
  if (el && a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) {
    if (!pendingRefresh) { pendingRefresh = true; a.addEventListener('blur', () => { pendingRefresh = false; requestAnimationFrame(() => refreshSpecWindow(app)); }, { once: true }); }
    return;
  }
  renderSpecWindow(app);
}

export function openSpecWindow(app: App) { renderSpecWindow(app); }

export function renderSpecWindow(app: App) {
  const W = 700;
  const win = floatingWindow('mspec', 'Measure spec — points of measure', { width: W, x: Math.max(50, window.innerWidth - W - 320), y: 80, onClose: () => app.invalidate('canvas') });
  win.el.classList.add('specwin');
  keepScroll(win.body, SS.scroll); clear(win.body); clear(win.foot);
  const rerender = () => { renderSpecWindow(app); app.invalidate('canvas'); };
  const run = (label: string, fn: () => void) => { try { fn(); } catch (err) { reportError(err, label); } rerender(); };
  const list = items(app);
  if (!list.some(x => x.id === SS.cur)) SS.cur = list[0]?.id ?? null;
  const cur = list.find(x => x.id === SS.cur) ?? null;
  const u = unitLabel();

  // ── toolbar
  const haveMeasure = !!(MS.groups.some(g => g.parts.length) || MS.history.length);
  win.body.append(h('div.sp-bar', {},
    h('span.dim', {}, 'Add:'),
    h('button.btn.sm', { 'data-act': 'from-sel', title: 'From what is selected: outline segment(s) or an internal line = a line; exactly two points = a straight distance', onclick: () => run('Add to spec', () => { addSpecFromSelection(app); }) }, '+ From selection'),
    h('button.btn.sm' + (haveMeasure ? '' : '.disabled'), { 'data-act': 'from-measure', title: 'From the Measure tool: the open measurement, else the last kept one', onclick: () => run('Add to spec', () => { addSpecFromMeasure(app); }) }, '+ From Measure tool'),
    h('button.btn.sm', { title: 'Switch to the Measure tool to click the lines, then press “Add to spec” in the Measure window', onclick: () => { app.setTool('measure'); app.status('Click the line(s) to measure, then “Add to spec” in the Measure window'); } }, 'Pick lines…'),
  ));

  // ── list
  if (!list.length) {
    win.body.append(h('div.empty', {}, 'No points of measure yet. Select a line (outline segment or internal line) or two points and press “+ From selection”, or measure with the Measure tool and press “Add to spec”. Then type a target and Apply: the pattern follows the spec.'));
  } else {
    const t = h('table.fw-table.sp-list');
    t.append(h('tr', {}, h('th', {}, 'Measurement'), h('th', {}, 'Type'), h('th', {}, `Now (${u})`), h('th', { title: `Target of the active size — type a new value, then Apply` }, 'Target'), h('th', {}, 'Diff'), h('th', {}, 'Moves'), h('th', {}, '')));
    for (const it of list) {
      const rows = ops.specRows(app.doc, it.id);
      const row = rows.find(r => r.sizeId === app.activeSize) ?? rows[0];
      const dead = !rows.length || row?.value === null;
      const name = textInput(it.name, v => run('Rename', () => ops.updateSpecItem(app.doc, it.id, { name: v })));
      name.classList.add('sp-name');
      const isBase = !!row && row.sizeId === app.doc.sizeLine(app.style.pieces.find(x => x.id === (it.kind === 'distance' ? it.a?.pieceId : it.parts[0]?.ref.pieceId)) ?? app.style.pieces[0]).baseSizeId;
      const tgt = lengthInput(row?.target ?? NaN, v => run('Spec target', () => {
        if (!row) return;
        // base size: the whole spec shifts by the same amount (the grading between sizes is kept);
        // another size: only that size. The per-size table below always edits single cells.
        const from = row.target ?? row.value;
        if (isBase && from !== null) ops.setSpecTargets(app.doc, it.id, Object.fromEntries(rows.map(r => [r.sizeId, r.sizeId === row.sizeId ? v : r.target !== null ? r.target + (v - from) : null]).filter(([, t]) => t !== null)));
        else ops.setSpecTargets(app.doc, it.id, { [row.sizeId]: v });
        SS.result.delete(it.id);
      }), { min: 0, blankIfNaN: true, title: isBase ? `Target for the base size ${row?.sizeName ?? ''}. Changing it shifts every size's target by the same amount (grading kept). Then Apply.` : `Target for size ${row?.sizeName ?? ''} only — type a value, then Apply` });
      tgt.classList.add('sp-target'); tgt.dataset.item = it.id;
      const off = row && row.diff !== null && Math.abs(row.diff) > TOL;
      const sizesOff = rows.filter(r => r.diff !== null && Math.abs(r.diff) > TOL).length;
      const tr = h('tr' + (it.id === SS.cur ? '.cur' : ''), { 'data-item': it.id },
        h('td', {}, name),
        h('td.dim', { title: describe(app, it) }, it.kind === 'distance' ? 'Distance' : it.parts.length > 1 ? `${it.parts.length} lines` : 'Line'),
        h('td', {}, dead ? h('span.warnc', { title: 'The measured line or point no longer exists' }, 'missing') : fmt(row!.value!)),
        h('td', {}, dead ? '' : tgt),
        h('td' + (off ? '.fail' : row?.diff !== null && !dead ? '.pass' : ''), { title: sizesOff ? `${sizesOff} size(s) off spec` : 'Every size with a target is on spec' }, dead || row?.diff == null ? '' : (row.diff > 0 ? '+' : '') + fmt(row.diff) + (sizesOff > (off ? 1 : 0) ? ' *' : '')),
        h('td.dim', { title: it.movers.map(m => `${pointLabel(app, m.pieceId, m.anchorId)} · ${m.dir}${m.dir === 'angle' ? ' ' + (m.angleDeg ?? 0) + '°' : ''} × ${m.share}`).join('\n') || 'No point is set to move' }, it.movers.filter(m => m.share !== 0).length ? `${it.movers.filter(m => m.share !== 0).length} pt` : h('span.warnc', {}, 'none')),
        h('td', {},
          h('button.btn.sm', { 'data-act': 'apply-one', title: 'Alter the pattern so this measurement hits its targets (all sizes with a target)', onclick: (e: Event) => { e.stopPropagation(); SS.cur = it.id; run('Apply spec', () => apply(app, [it.id], true)); } }, 'Apply'),
          h('button.mini', { title: 'Remove from the spec (the pattern is not changed)', onclick: (e: Event) => { e.stopPropagation(); run('Remove', () => { ops.removeSpecItem(app.doc, it.id); SS.result.delete(it.id); }); } }, '×')),
      );
      tr.addEventListener('click', e => { if ((e.target as Element).closest('input,button')) { if (SS.cur !== it.id) { SS.cur = it.id; app.invalidate('canvas'); } return; } SS.cur = it.id; rerender(); });
      t.append(tr);
    }
    win.body.append(t);
    if (list.some(it => ops.specRows(app.doc, it.id).filter(r => r.diff !== null && Math.abs(r.diff) > TOL).length > 1)) win.body.append(h('div.dim.sp-note', {}, '* other sizes are off spec too — select the row to see every size'));
  }

  // ── detail of the selected item
  if (cur) {
    const rows = ops.specRows(app.doc, cur.id);
    win.body.append(h('div.insp-title', {}, cur.name));
    const modes: [string, string][] = cur.kind === 'distance' ? [['diagonal', 'Straight'], ['x', 'X only'], ['y', 'Y only']] : [['contour', 'Along the line'], ['diagonal', 'Straight (end to end)'], ['x', 'X only'], ['y', 'Y only']];
    const modeSel = selectInput(cur.mode, modes, v => run('Measure mode', () => { ops.updateSpecItem(app.doc, cur.id, { mode: v as MeasureMode }); SS.result.delete(cur.id); }));
    win.body.append(h('div.sp-row', {}, h('span.dim', {}, 'Measures'), h('span.sp-geo', { title: describe(app, cur) }, describe(app, cur)), h('span.dim', {}, 'as'), modeSel));

    // rules
    const mt = h('table.fw-table.sp-rules');
    mt.append(h('tr', {}, h('th', {}, 'Point that moves'), h('th', { title: 'Along the line = lengthens / shortens the measured line at that point' }, 'Direction'), h('th', { title: 'Degrees from +X, counter-clockwise (Direction = Angle)' }, 'Angle°'), h('th', { title: '1 = takes the whole change · 0.5 = half · −1 = the opposite way · 0 = stays' }, 'Share'), h('th', {}, '')));
    const setMovers = (mv: SpecMover[]) => run('Rules', () => { ops.updateSpecItem(app.doc, cur.id, { movers: mv }); SS.result.delete(cur.id); });
    cur.movers.forEach((m, i) => {
      const dir = selectInput(m.dir, [['along', 'Along the line'], ['x', 'X only'], ['y', 'Y only'], ['angle', 'Angle']], v => setMovers(cur.movers.map((x, k) => (k === i ? { ...x, dir: v as SpecMover['dir'] } : x))));
      dir.dataset.rule = 'dir';
      const ang = numberInput(m.angleDeg ?? 0, v => setMovers(cur.movers.map((x, k) => (k === i ? { ...x, angleDeg: v } : x))), { decimals: 2, title: 'Direction angle in degrees' });
      ang.disabled = m.dir !== 'angle';
      const sh = numberInput(m.share, v => setMovers(cur.movers.map((x, k) => (k === i ? { ...x, share: v } : x))), { decimals: 3, title: '1 = whole change · 0.5 = half · −1 = opposite way · 0 = stays' });
      sh.dataset.rule = 'share';
      mt.append(h('tr', {}, h('td', {}, pointLabel(app, m.pieceId, m.anchorId)), h('td', {}, dir), h('td', {}, ang), h('td', {}, sh),
        h('td', {}, h('button.mini', { title: 'This point no longer moves', onclick: () => setMovers(cur.movers.filter((_, k) => k !== i)) }, '×'))));
    });
    win.body.append(h('div.sp-row', {}, h('span.dim', {}, `Rules — which points move to reach the target (${cur.movers.length})`), h('span.spacer'),
      h('button.btn.sm', { 'data-act': 'add-movers', title: 'Add the selected point(s) as moving points (select them with the Select tool first)', onclick: () => run('Add points', () => {
        if (!app.sel.anchors.length) throw new Error('Select the point(s) that should move first (Select tool), then press this again');
        const add = app.sel.anchors.filter(a => !cur.movers.some(m => m.anchorId === a.anchorId)).map(a => ({ pieceId: a.pieceId, anchorId: a.anchorId, dir: 'along' as const, share: 1 }));
        if (!add.length) throw new Error('Those points are already in the rules');
        ops.updateSpecItem(app.doc, cur.id, { movers: [...cur.movers, ...add] }); SS.result.delete(cur.id);
      }) }, '+ Selected points'),
      h('button.btn.sm', { title: 'Back to the default: only the end of the line moves, along the line', onclick: () => setMovers(ops.defaultSpecMovers(cur)) }, 'Reset to line end')));
    win.body.append(cur.movers.length ? mt : h('div.warnline', {}, 'No point is set to move, so Apply cannot change this measurement. Press “Reset to line end”, or select points and “+ Selected points”.'));

    // per-size table
    if (rows.length) {
      const res = SS.result.get(cur.id);
      const rowOf = (r: number) => res?.rows.find(x => x.sizeId === rows[r].sizeId);
      const line = app.sizeLine();
      const cols: SGCol[] = [
        { key: 'target', head: 'Target', edit: true, attrs: { 'data-col': 'target' }, title: 'Spec value — type or paste a column from Excel', get: r => rows[r].target },
        { key: 'now', head: 'Now', get: r => rows[r].value },
        { key: 'diff', head: 'Diff', title: 'now − target', attrs: { 'data-col': 'diff' }, cls: r => (rows[r].diff === null ? '' : Math.abs(rows[r].diff!) <= TOL ? 'pass' : 'fail'), get: r => rows[r].diff },
        { key: 'after', head: res?.written ? 'Applied' : 'Preview', title: 'The measurement after the last Preview / Apply', get: r => (res ? rowOf(r)?.after ?? null : null) },
        { key: 'move', head: 'Moved', title: 'How far the points moved (× share) to get there', get: r => (res && rowOf(r)?.solved ? rowOf(r)!.t : null) },
      ];
      const grid = sizeGrid({
        rows: rows.map(r => ({ id: r.sizeId, name: r.sizeName, base: r.sizeId === line.baseSizeId, active: r.sizeId === app.activeSize })), cols, state: SS.scroll, maxHeight: Math.min(300, window.innerHeight - 470), cls: 'sptab',
        onCommit: cells => run('Spec target', () => { ops.setSpecTargets(app.doc, cur.id, Object.fromEntries(cells.map(c => [rows[c.r].sizeId, c.v]))); SS.result.delete(cur.id); }),
        onRowClick: r => { app.activeSize = rows[r].sizeId; app.invalidate(); rerender(); },
      });
      win.body.append(grid.el);
      const bad = res?.rows.filter(r => r.target !== null && r.note && !r.solved && r.note !== 'no target' && r.note !== 'not applied') ?? [];
      if (res?.error) win.body.append(h('div.warnline', {}, res.error));
      else if (bad.length) win.body.append(h('div.fw-sum.bad', { 'data-spec': 'missed' }, `${bad.map(r => r.sizeName).join(', ')}: ${bad[0].note}`));
      else if (res) win.body.append(h('div.fw-sum', { 'data-spec': 'ok' }, res.written ? `Applied — every size with a target is on spec (max residual ${fmt(res.maxResidual)} ${u})` : res.changed ? 'Preview only — press Apply to change the pattern' : 'Already on spec'));
    } else win.body.append(h('div.warnline', {}, 'The line or point this measurement was tied to no longer exists. Remove it (×) and add it again.'));

    win.foot.append(
      h('button.btn.sm', { title: 'Set every target to what the pattern measures now (the spec then describes the pattern as it is)', onclick: () => run('Targets', () => { ops.setSpecTargets(app.doc, cur.id, Object.fromEntries(rows.filter(r => r.value !== null).map(r => [r.sizeId, r.value]))); SS.result.delete(cur.id); }) }, 'Targets = now'),
      h('span.spacer'),
      h('button.btn.sm', { 'data-act': 'preview', title: 'Solve without changing the pattern', onclick: () => run('Preview', () => apply(app, [cur.id], false)) }, 'Preview'),
      h('button.btn.sm', { 'data-act': 'apply-size', title: `Apply only the active size (${rows.find(r => r.sizeId === app.activeSize)?.sizeName ?? ''})`, onclick: () => run('Apply spec', () => apply(app, [cur.id], true, [app.activeSize])) }, 'Apply active size'),
      h('button.btn.sm.primary', { 'data-act': 'apply', title: 'Alter the pattern so this measurement hits its target in every size (one undo step)', onclick: () => run('Apply spec', () => apply(app, [cur.id], true)) }, 'Apply'),
    );
  }
  if (list.length > 1) win.foot.append(h('button.btn.sm', { 'data-act': 'apply-all', title: 'Apply every measurement of the spec, in list order (one undo step)', onclick: () => run('Apply spec', () => apply(app, undefined, true)) }, 'Apply all'));
}

// ───────────────────────── canvas overlay: the selected measurement and its moving points ─────────────────────────

registerOverlay('mspec', app => {
  if (!specWindowOpen() || !SS.cur) return '';
  const it = items(app).find(x => x.id === SS.cur); if (!it) return '';
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
