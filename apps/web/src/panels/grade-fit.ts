/**
 * Grade by measurement (Grade ▸ Grade by measurement…, and “Grade to spec…” in the Measure window).
 *
 * Choose a measurement (a Measure ▸ Line group: open or kept), the point(s) that may move (the
 * selection; direction X / Y / angle, a weight per point: −1 = opposite way, 0.5 = half), and the
 * spec per size (ROWS = sizes; paste a spec-chart column from Excel). Preview solves without
 * writing; Apply writes one undo step (kernel gradeByMeasurement: one 1-D solve per size, absolute
 * per-size edits, so sizes stay independent). The table shows now / after / residual per size; the
 * base size is never changed (its residual says how far the base pattern is from the spec).
 */
import type { MeasureMode, Id, GradeFitRow } from '@prowdcad/kernel';
import type { App } from '../app';
import { floatingWindow } from '../ui/window';
import { h, clear } from '../ui/dom';
import { fmt, unitLabel, parseNum } from '../units-ui';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { sizeGrid, keepScroll, type SGCol, type SGState } from './sizegrid';
import { MS, type MGroupUI, partName } from './measure-table';
import { toast } from '../ui/toast';

const FS = {
  group: null as MGroupUI | null,
  mode: 'contour' as MeasureMode,
  movers: [] as { pieceId: Id; anchorId: Id; w: number; label: string }[],
  dir: 'x' as 'x' | 'y' | 'angle',
  angle: 0,
  spec: {} as Record<string, number>,
  specKind: 'value' as 'value' | 'delta',
  factor: 1,
  result: null as { rows: GradeFitRow[]; maxResidual: number; written: boolean } | null,
  scroll: { scrollTop: 0 } as SGState,
};

function moversFromSelection(app: App) {
  FS.movers = app.sel.anchors.map(a => {
    const p = app.doc.style.pieces.find(x => x.id === a.pieceId);
    const c = p && [p.sew, ...p.internals].find(x => x.id === a.contourId);
    const i = c?.points.findIndex(x => x.id === a.anchorId) ?? -1;
    const old = FS.movers.find(m => m.anchorId === a.anchorId);
    return { pieceId: a.pieceId, anchorId: a.anchorId, w: old?.w ?? 1, label: `${p?.name ?? '?'} ${c && c !== p?.sew ? 'int ' : ''}${i + 1}${c?.points[i]?.name ? ' ' + c.points[i].name : ''}` };
  });
}

/** Open with a measurement group (from the Measure window), else the current / last kept one. */
export function openGradeFit(app: App, groups?: MGroupUI[], mode?: MeasureMode) {
  if (groups?.length) { FS.group = JSON.parse(JSON.stringify(groups[0])); FS.mode = mode ?? 'contour'; FS.result = null; }
  else if (!FS.group) {
    const g = MS.groups.find(x => x.parts.length) ?? MS.history[MS.history.length - 1]?.groups[0];
    if (g) { FS.group = JSON.parse(JSON.stringify(g)); FS.mode = MS.mode; }
  }
  if (!FS.movers.length || app.sel.anchors.length) moversFromSelection(app);
  renderGradeFit(app);
}

function dirVec(): { x: number; y: number } {
  if (FS.dir === 'x') return { x: 1, y: 0 };
  if (FS.dir === 'y') return { x: 0, y: 1 };
  const a = FS.angle * Math.PI / 180; return { x: Math.cos(a), y: Math.sin(a) };
}

function solve(app: App, write: boolean) {
  if (!FS.group?.parts.length) throw new Error('Choose a measurement first (Measure tool ▸ click the lines ▸ OK)');
  if (!FS.movers.length) throw new Error('Select the point(s) that may move, then “Use selection”');
  const piece = app.doc.piece(FS.group.parts[0].ref.pieceId);
  const line = app.doc.sizeLine(piece);
  const now = ops.measureGroup(app.doc, FS.group.parts, FS.mode);
  const baseNow = now.find(r => r.sizeId === line.baseSizeId)?.total ?? 0;
  const targets: Record<string, number> = {};
  for (const s of line.sizes) {
    const v = FS.spec[s.id]; if (v === undefined || !Number.isFinite(v)) continue;
    targets[s.id] = FS.specKind === 'value' ? v * FS.factor : (baseNow ?? 0) + v * FS.factor;
  }
  if (!Object.keys(targets).length) throw new Error('Type or paste the spec per size first');
  const d = dirVec();
  FS.result = ops.gradeByMeasurement(app.doc, { parts: FS.group.parts, mode: FS.mode, targets, movers: FS.movers.map(m => ({ pieceId: m.pieceId, anchorId: m.anchorId, dir: { x: d.x * m.w, y: d.y * m.w } })), write });
  const solved = FS.result.rows.filter(r => r.solved).length;
  app.status(`Grade by measurement${write ? '' : ' (preview)'}: ${solved} size(s) solved · max residual ${fmt(FS.result.maxResidual)} ${unitLabel()}`);
  if (write) toast(`Graded ${solved} size(s) · max residual ${fmt(FS.result.maxResidual)} ${unitLabel()}`, 'ok');
}

export function renderGradeFit(app: App) {
  const win = floatingWindow('gradefit', 'Grade by measurement', { width: 620, x: Math.max(40, window.innerWidth - 620 - 330), y: 96 });
  win.el.classList.add('gfwin');
  keepScroll(win.body, FS.scroll); clear(win.body); clear(win.foot);
  const run = (label: string, fn: () => void) => { try { fn(); } catch (err) { reportError(err, label); } renderGradeFit(app); };
  // measurement chooser
  const choices: { key: string; label: string; g: MGroupUI; mode: MeasureMode }[] = [];
  MS.groups.forEach((g, i) => { if (g.parts.length) choices.push({ key: 'open' + i, label: `Open: ${g.name} (${g.parts.map(p => p.label).join('+')})`, g, mode: MS.mode }); });
  MS.history.forEach(r => r.groups.forEach((g, i) => choices.push({ key: r.id + ':' + i, label: `${r.name}${r.groups.length > 1 ? ' · ' + g.name : ''} (${g.parts.length} lines)`, g, mode: r.mode })));
  const sel = h('select.gf-meas') as HTMLSelectElement;
  sel.append(h('option', { value: '' }, FS.group ? `Current: ${FS.group.name} (${FS.group.parts.length} lines)` : '— none — (use the Measure tool, M)'));
  for (const c of choices) sel.append(h('option', { value: c.key }, c.label));
  sel.onchange = () => { const c = choices.find(x => x.key === sel.value); if (c) { FS.group = JSON.parse(JSON.stringify(c.g)); FS.mode = c.mode; FS.result = null; } renderGradeFit(app); };
  sel.addEventListener('keydown', e => e.stopPropagation());
  win.body.append(h('div.m-ctl', {}, h('span.dim', {}, '1 · Measurement'), sel));
  if (FS.group) win.body.append(h('div.dim.m-formula', {}, `${FS.group.parts.map(p => `${p.label} ${partName(app, p)}`).join(' + ')} · ${FS.mode === 'contour' ? 'length' : FS.mode}`));
  // movers
  const mv = h('div.gf-movers');
  const dsel = h('select.gf-dir') as HTMLSelectElement;
  for (const [v, l] of [['x', 'X (across)'], ['y', 'Y (along)'], ['angle', 'Angle…']]) dsel.append(h('option', { value: v }, l));
  dsel.value = FS.dir; dsel.onchange = () => { FS.dir = dsel.value as 'x'; FS.result = null; renderGradeFit(app); };
  dsel.addEventListener('keydown', e => e.stopPropagation());
  const ang = h('input.num.gf-ang', { type: 'text', value: String(FS.angle), title: 'Direction angle (degrees from +X, counter-clockwise)' }) as HTMLInputElement;
  ang.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ang.blur(); });
  ang.addEventListener('change', () => { const v = parseNum(ang.value); if (Number.isFinite(v)) { FS.angle = v; FS.result = null; } });
  mv.append(h('span.dim', {}, `2 · Points that move (${FS.movers.length})`), h('button.btn.sm', { 'data-act': 'usesel', title: 'Take the selected points', onclick: () => run('Use selection', () => { moversFromSelection(app); FS.result = null; }) }, 'Use selection'), h('span.dim', {}, 'direction'), dsel, ...(FS.dir === 'angle' ? [ang] : []));
  win.body.append(mv);
  if (FS.movers.length) {
    const list = h('div.gf-list');
    FS.movers.forEach(m => {
      const wi = h('input.num.gf-w', { type: 'text', value: String(m.w), title: 'Weight: 1 = moves by t, −1 = the opposite way, 0.5 = half as much' }) as HTMLInputElement;
      wi.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') wi.blur(); });
      wi.addEventListener('change', () => { const v = parseNum(wi.value); if (Number.isFinite(v)) { m.w = v; FS.result = null; } });
      list.append(h('span.gf-pt', {}, m.label, ' ×', wi));
    });
    win.body.append(list);
  }
  // spec
  const kind = h('select.gf-kind') as HTMLSelectElement;
  for (const [v, l] of [['value', 'Spec = the measurement'], ['delta', 'Spec = change from the base size']]) kind.append(h('option', { value: v }, l));
  kind.value = FS.specKind; kind.onchange = () => { FS.specKind = kind.value as 'value'; FS.result = null; renderGradeFit(app); };
  kind.addEventListener('keydown', e => e.stopPropagation());
  const fac = h('input.num.gf-fac', { type: 'text', value: String(FS.factor), title: 'Factor applied to the spec: 0.5 when the pattern is half of the body measurement (half chest), 0.25 for a quarter' }) as HTMLInputElement;
  fac.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') fac.blur(); });
  fac.addEventListener('change', () => { const v = parseNum(fac.value); if (Number.isFinite(v) && v > 0) { FS.factor = v; FS.result = null; renderGradeFit(app); } });
  win.body.append(h('div.m-ctl', {}, h('span.dim', {}, '3 · Spec per size'), kind, h('span.dim', {}, '× factor'), fac, h('span.dim', {}, `(${unitLabel()}; paste an Excel column into the Spec cells)`)));
  if (FS.group?.parts.length) {
    let now: ReturnType<typeof ops.measureGroup> = [];
    try { now = ops.measureGroup(app.doc, FS.group.parts, FS.mode); } catch (err) { win.body.append(h('div.warnline', {}, (err as Error).message)); }
    const piece = app.doc.style.pieces.find(p => p.id === FS.group!.parts[0].ref.pieceId);
    if (piece && now.length) {
      const line = app.doc.sizeLine(piece);
      const res = FS.result?.rows;
      const rowOf = (r: number) => res?.find(x => x.sizeId === line.sizes[r].id);
      const cols: SGCol[] = [
        { key: 'spec', head: 'Spec', edit: true, attrs: { 'data-col': 'spec' }, get: r => FS.spec[line.sizes[r].id] ?? null },
        { key: 'target', head: 'Target', title: 'Spec × factor (as a measurement)', get: r => { const v = FS.spec[line.sizes[r].id]; if (v === undefined) return null; const bn = now.find(x => x.sizeId === line.baseSizeId)?.total ?? 0; return FS.specKind === 'value' ? v * FS.factor : bn + v * FS.factor; } },
        { key: 'now', head: 'Now', get: r => now[r]?.total ?? null },
        { key: 'after', head: FS.result?.written ? 'After' : 'Preview', get: r => rowOf(r)?.after ?? null },
        { key: 'res', head: 'Residual', title: 'after − target', attrs: { 'data-col': 'res' }, cls: r => { const x = rowOf(r); return !x || x.residual === null ? '' : Math.abs(x.residual) < 0.01 ? 'pass' : x.sizeId === line.baseSizeId ? 'warnc' : 'fail'; }, get: r => rowOf(r)?.residual ?? null },
        { key: 't', head: 'Move', title: 'Solved movement of the points (mm along the direction × weight)', get: r => (rowOf(r)?.solved ? rowOf(r)!.t : null) },
      ];
      const grid = sizeGrid({
        rows: line.sizes.map(s => ({ id: s.id, name: s.name, base: s.id === line.baseSizeId, active: s.id === app.activeSize })), cols, state: FS.scroll, maxHeight: Math.min(360, window.innerHeight - 380), cls: 'gftab',
        onCommit: cells => { for (const c of cells) FS.spec[line.sizes[c.r].id] = c.v; FS.result = null; renderGradeFit(app); },
      });
      win.body.append(grid.el);
      if (FS.result) {
        const bad = FS.result.rows.filter(r => r.target !== null && r.sizeId !== line.baseSizeId && (!r.solved || Math.abs(r.residual ?? 0) >= 0.01));
        const baseRow = FS.result.rows.find(r => r.sizeId === line.baseSizeId);
        win.body.append(h('div.fw-sum' + (bad.length ? '.bad' : ''), { 'data-fit': bad.length ? 'residual' : 'ok' }, bad.length ? `${bad.length} size(s) not hit: ${bad.map(r => r.sizeName).join(', ')} (curves / limits — see Residual)` : `Every graded size hits its spec (max residual ${fmt(FS.result.maxResidual)} ${unitLabel()})${FS.result.written ? ' · written (Ctrl+Z undoes)' : ' · preview, nothing written'}`),
          ...(baseRow && baseRow.residual !== null && Math.abs(baseRow.residual) >= 0.01 ? [h('div.dim', {}, `Base size ${baseRow.sizeName}: measures ${fmt(baseRow.before ?? 0)}, spec ${fmt(baseRow.target ?? 0)} — grading never changes the base; adjust the base pattern.`)] : []));
      }
    }
  }
  win.foot.append(
    h('button.btn.sm', { onclick: () => { FS.spec = {}; FS.result = null; renderGradeFit(app); } }, 'Clear spec'),
    h('span.spacer'),
    h('button.btn.sm', { 'data-act': 'preview', title: 'Solve without writing', onclick: () => run('Preview', () => solve(app, false)) }, 'Preview'),
    h('button.btn.sm.primary', { 'data-act': 'apply', title: 'Solve and write the grading (one undo step)', onclick: () => run('Grade by measurement', () => solve(app, true)) }, 'Apply'),
  );
}

export const gradeFitState = FS;
