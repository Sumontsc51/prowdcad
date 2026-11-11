/**
 * Measure menu: Measure tool, Walking Check report, Scale & Shrink, piece info.
 * (Compare Length and Segment length per size were removed: the Measure tool's Line mode sums and compares
 * groups per size with a target ease; Segment ▸ Segment length sets an exact length.)
 */
import type { SegRef, MeasureMode, LengthSetMethod, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { registerCommand } from '../commands';
import { ops } from '../ops-bridge';
import { showDialog, rememberedDialog, alertDialog } from '../ui/dialog';
import { floatingWindow, table } from '../ui/window';
import { h, clear } from '../ui/dom';
import { toast } from '../ui/toast';
import { pick } from '../tools/pick';
import { runWorld, screenPath } from '../hitkit';
import { fmt, unitLabel } from '../units-ui';
import { hasPiece, onePiece, selPieces } from './cmd-util';
import { resolveFor } from '../geometry';
import { totalLength, perimeter, area } from '@prowdcad/kernel';
import { reportError } from '../commands';
import { Cancelled, runOrPick } from '../selection';
import { renderMeasureWindow, setMeasureHooks, MS, partName } from '../panels/measure-table';
import { openSpecWindow, addSpecFromMeasure } from '../panels/spec';
import { openGradeFit } from '../panels/grade-fit';
import { settings, saveSettings } from '../settings';

export const LENGTH_METHODS: { value: LengthSetMethod; label: string }[] = [
  { value: 'moveEnd', label: 'Move end along its tangent' },
  { value: 'halfH', label: 'Move end horizontally' },
  { value: 'halfV', label: 'Move end vertically' },
  { value: 'halfDiag', label: 'Move end at 45°' },
  { value: 'curveBlend', label: 'Blend curve (ends fixed)' },
];

function segLabel(app: App, r: SegRef): string {
  const p = app.doc.style.pieces.find(x => x.id === r.pieceId); if (!p) return '?';
  const c = [p.sew, ...p.internals].find(x => x.id === r.contourId);
  const ia = c?.points.findIndex(a => a.id === r.from) ?? -1, ib = c?.points.findIndex(a => a.id === r.to) ?? -1;
  return `${p.name} ${c === p.sew ? 'sew' : 'int'} ${ia + 1}→${ib + 1}${r.reverse ? ' (rev)' : ''}`;
}

/**
 * Measure window ▸ Adjust segment…: change the pattern from an open measurement. Pick one of the
 * measured lines and make it an exact length, or (with two groups) make the difference between the
 * groups — the ease — a value. All sizes or the active size only; one undo step.
 */
async function adjustSegment(app: App) {
  const all = MS.groups.flatMap((g, gi) => g.parts.filter(p => !p.cut).map(p => ({ g, gi, p })));
  if (!all.length) throw new Error('Measure a line first (cut lines cannot be adjusted — pick the sew line)');
  const two = MS.groups.filter(g => g.parts.length).length >= 2;
  const total = (gi: number, sid: string) => ops.measureGroup(app.doc, MS.groups[gi].parts, 'contour').find(r => r.sizeId === sid)?.total ?? null;
  const diffAt = (sid: string) => { const a = total(0, sid), b = total(1, sid); return a === null || b === null ? null : MS.diff === 'BA' ? b - a : a - b; };
  const actName = app.sizeLine().sizes.find(s => s.id === app.activeSize)?.name ?? '';
  const dNow = two ? diffAt(app.activeSize) : null;
  const diffLabel = MS.diff === 'BA' ? `${MS.groups[1]?.name} − ${MS.groups[0]?.name}` : `${MS.groups[0]?.name} − ${MS.groups[1]?.name}`;
  const first = all[0];
  const r = await showDialog({ title: 'Adjust segment', message: two && dNow !== null ? `Size ${actName}: ${diffLabel} = ${fmt(dNow)} ${unitLabel()}` : `Size ${actName}: ${first.p.label} = ${fmt(ops.measureRef(app.doc, first.p.ref, 'contour', app.activeSize))} ${unitLabel()}`, fields: [
    { kind: 'select', key: 'seg', label: 'Line to change', value: '0', options: all.map((x, i) => ({ value: String(i), label: `${MS.groups.length > 1 ? x.g.name + ' · ' : ''}${x.p.label} ${partName(app, x.p)}` })) },
    { kind: 'radio', key: 'how', label: 'Target', value: two ? 'diff' : 'len', options: [...(two ? [{ value: 'diff', label: `Make ${diffLabel} equal to…` }] : []), { value: 'len', label: 'Make this line exactly…' }] },
    { kind: 'length', key: 'v', label: 'Value', value: two ? MS.ease : ops.measureRef(app.doc, first.p.ref, 'contour', app.activeSize) },
    { kind: 'select', key: 'm', label: 'How', value: 'moveEnd', options: LENGTH_METHODS },
    { kind: 'checkbox', key: 'one', label: `Active size only (${actName})`, value: app.activeSize !== app.baseSize() },
  ] });
  if (!r) return;
  const x = all[Number(r.seg)];
  const sizeId = r.one ? app.activeSize : undefined;
  const sid = sizeId ?? app.baseSize();
  const cur = ops.measureRef(app.doc, x.p.ref, 'contour', sid);
  let target = r.v as number;
  if (r.how === 'diff') {
    const d = diffAt(sid); if (d === null) throw new Error('The two groups cannot both be measured in that size');
    // the chosen line belongs to the group that adds to the difference (+) or subtracts from it (−)
    const sign = (x.gi === 1) === (MS.diff === 'BA') ? 1 : -1;
    if (x.gi > 1) throw new Error('Pick a line of the first two groups to set their difference');
    target = cur + sign * ((r.v as number) - d);
  }
  if (!(target > 0)) throw new Error(`That would make the line ${fmt(target)} ${unitLabel()} long`);
  const out = ops.segmentLengthSetTo(app.doc, x.p.ref.pieceId, x.p.ref.contourId, x.p.ref.from, x.p.ref.to, target, r.m as LengthSetMethod, sizeId, x.p.ref.reverse);
  if (!out.converged) toast(`Could not reach ${fmt(target)} (best ${fmt(out.length)})`, 'warn'); else toast(`${x.p.label} = ${fmt(out.length)} ${unitLabel()}`, 'ok');
  renderMeasureWindow(app);
}

async function walkingCheckFlow(app: App) {
  const pairs: { a: SegRef; b: SegRef }[] = [];
  const pickSeg = async (prompt: string): Promise<SegRef | 'done' | null> => {
    const r = await pick(app, { kind: 'contour', prompt, allowDone: true });
    if (!r || r === 'done') return r;
    if (r.kind !== 'contour' || !r.hit.from || !r.hit.to) return pickSeg(prompt);
    return { pieceId: r.hit.piece.id, contourId: r.hit.contour.id, from: r.hit.from, to: r.hit.to, reverse: r.e.shiftKey || undefined };
  };
  for (;;) {
    const a = await pickSeg(`Walking check pair ${pairs.length + 1}: click seam A (Shift = reverse) · Enter = run`);
    if (a === null) return; if (a === 'done') break;
    const b = await pickSeg(`Pair ${pairs.length + 1}: click the matching seam B (Shift = reverse)`);
    if (!b || b === 'done') return;
    pairs.push({ a, b });
  }
  if (!pairs.length) return;
  const r = await rememberedDialog('walkcheck', { title: 'Walking check', fields: [
    { kind: 'length', key: 'ease', label: 'Expected ease (A − B)', value: 0 },
    { kind: 'length', key: 'tol', label: 'Ease tolerance', value: 1, min: 0 },
    { kind: 'length', key: 'ntol', label: 'Notch tolerance', value: 0.5, min: 0 },
  ] });
  if (!r) return;
  const res = ops.walkingCheck(app.doc, pairs.map(p => ({ ...p, targetEase: r.ease as number, easeTolerance: r.tol as number, notchTolerance: r.ntol as number })));
  const win = floatingWindow('walkcheck', `Walking check — ${res.pass ? 'PASS' : 'FAIL'}`, { width: 600 });
  clear(win.body); clear(win.foot);
  res.pairs.forEach((p, i) => {
    win.body.append(h('div.fw-sum' + (p.pass ? '' : '.bad'), {}, `Pair ${i + 1}: ${segLabel(app, pairs[i].a)}  ⇄  ${segLabel(app, pairs[i].b)} — ${p.pass ? 'PASS' : 'FAIL'}`));
    win.body.append(table(['Size', 'A', 'B', 'Δ', 'Pass', 'Notches A/B', 'Unmatched'], p.sizes.map(s => [s.sizeName, fmt(s.lengthA), fmt(s.lengthB), fmt(s.delta), s.pass ? '✓' : '✗', `${s.notchesA.length}/${s.notchesB.length}`, [...s.unmatchedA.map(n => 'A@' + fmt(n.pos)), ...s.unmatchedB.map(n => 'B@' + fmt(n.pos))].join(' ') || '—'])));
  });
  win.foot.append(h('span.dim', {}, `Lengths in ${unitLabel()}`));
}

async function scaleDialog(app: App) {
  const ps = selPieces(app); if (!ps.length) throw new Error('Select piece(s)');
  const r = await rememberedDialog('scale', { title: `Scale & shrink — ${ps.length} piece(s)`, message: 'X = across grain, Y = along grain.', fields: [
    { kind: 'select', key: 'mode', label: 'Input', value: 'pct', options: [{ value: 'pct', label: 'Percent growth' }, { value: 'shrink', label: 'Shrinkage % (proportional to 100)' }, { value: 'abs', label: 'Target width / height' }, { value: 'inc', label: 'Add to width / height' }] },
    { kind: 'text', key: '_x', label: 'X (across grain)', value: '0', hint: '% for percent / shrinkage modes, length for target / add (fractions accepted). Blank = unchanged.' },
    { kind: 'text', key: '_y', label: 'Y (along grain)', value: '0' },
    { kind: 'radio', key: 'grading', label: 'Scale grading', value: 'nest', options: [{ value: 'nest', label: 'Whole nest' }, { value: 'base', label: 'Base only (keep increments)' }] },
    { kind: 'checkbox', key: 'seam', label: 'Scale seam allowances', value: false },
    { kind: 'checkbox', key: 'stamp', label: 'Stamp description (e.g. "SHRINK X 3% Y 5%")', value: true },
  ] });
  if (!r) return;
  const { parseLen, parseNum } = await import('../units-ui');
  const isLen = r.mode === 'abs' || r.mode === 'inc';
  const val = (s: unknown) => { const t = String(s).trim(); if (!t) return undefined; const v = isLen ? parseLen(t) : parseNum(t); if (!Number.isFinite(v)) throw new Error(`“${t}” is not valid`); return v; };
  const x = val(r._x), y = val(r._y);
  const input = r.mode === 'abs' ? { xAbs: x, yAbs: y } : r.mode === 'inc' ? { xInc: x, yInc: y } : { xPct: x, yPct: y };
  app.doc.transact('Scale', () => {
    for (const p of ps) {
      const res = ops.scalePiece(app.doc, p.id, input, { scaleGrading: r.grading as 'nest' | 'base', scaleSeam: !!r.seam, stampDescription: !!r.stamp, proportionalTo100: r.mode === 'shrink' });
      app.status(`Scaled fx ${res.fx.toFixed(5)} fy ${res.fy.toFixed(5)}`);
    }
  });
}

export function registerMeasure(app: App) {
  setMeasureHooks({
    gradeToSpec: (groups, mode) => openGradeFit(app, groups, mode),
    adjust: () => void adjustSegment(app).catch(err => reportError(err, 'Adjust segment')),
    addToSpec: () => { try { addSpecFromMeasure(app); openSpecWindow(app); toast('Added to the Measure spec — type a target and Apply', 'ok'); } catch (err) { reportError(err, 'Add to spec'); } },
  });
  registerCommand({ id: 'measure.tool', title: 'Measure tool', menu: 'Measure', group: 0, hint: 'M', run: () => app.setTool('measure') });
  // no menu entry: Measure tool already opens Line mode with the per-size window; kept for its shortcut and the command finder
  registerCommand({ id: 'measure.line', title: 'Measure line (sum per size)…', hotkey: 'Shift+Alt+L', run: () => {
    (settings.toolState ??= {}).measure = { ...(settings.toolState.measure ?? {}), mode: 'line' }; saveSettings();
    app.setTool('measure'); renderMeasureWindow(app);
  } });
  registerCommand({ id: 'measure.spec', title: 'Measure spec…', menu: 'Measure', group: 0, hotkey: 'Ctrl+Shift+M', hint: 'Points of measure with targets: the pattern follows the spec', run: () => openSpecWindow(app) });
  registerCommand({ id: 'measure.walk', title: 'Walk tool', menu: 'Measure', group: 0, run: () => app.setTool('walk') });
  registerCommand({ id: 'measure.piece', title: 'Piece info', menu: 'Measure', group: 0, hotkey: 'Ctrl+I', enabled: hasPiece, run: async () => {
    const p = onePiece(app);
    const line = app.sizeLine();
    const rows = app.doc.sizesOf(p).map(sid => { const r = resolveFor(app.doc, p, sid); return [line.sizes.find(s => s.id === sid)?.name ?? sid, fmt(totalLength(r.sew)), fmt(perimeter(r.cut)), (area(r.cut) / 1e4).toFixed(3)]; });
    const win = floatingWindow('pieceinfo', `${p.name} — all sizes`, { width: 420 });
    clear(win.body); win.body.append(table(['Size', `Sew (${unitLabel()})`, `Cut (${unitLabel()})`, 'Area dm²'], rows));
  } });
  registerCommand({ id: 'measure.walkCheck', title: 'Walking check…', menu: 'Measure', group: 1, run: () => walkingCheckFlow(app) });
  registerCommand({ id: 'piece.scale', title: 'Scale & shrink…', menu: 'Piece', group: 2, enabled: hasPiece, run: () => scaleDialog(app) });
  registerCommand({ id: 'measure.notchReport', title: 'Notches on segment…', menu: 'Measure', group: 1, run: async () => {
    const run = await runOrPick(app, 'Click a segment');
    const ns = ops.notchesOnSegment(app.doc, { pieceId: run.pieceId, contourId: run.contourId, from: run.from, to: run.to }, app.activeSize);
    await alertDialog('Notches on segment', ns.map((n, i) => `${i + 1}. ${fmt(n.pos)} ${unitLabel()}`).join('\n') || 'No notches');
  } });
  void Cancelled;
}

export type { Id };
