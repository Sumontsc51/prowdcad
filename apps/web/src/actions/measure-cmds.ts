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
import { renderMeasureWindow, setMeasureHooks } from '../panels/measure-table';
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
  setMeasureHooks({ gradeToSpec: (groups, mode) => openGradeFit(app, groups, mode) });
  registerCommand({ id: 'measure.tool', title: 'Measure tool', menu: 'Measure', group: 0, hint: 'M', run: () => app.setTool('measure') });
  // no menu entry: Measure tool already opens Line mode with the per-size window; kept for its shortcut and the command finder
  registerCommand({ id: 'measure.line', title: 'Measure line (sum per size)…', hotkey: 'Shift+Alt+L', run: () => {
    (settings.toolState ??= {}).measure = { ...(settings.toolState.measure ?? {}), mode: 'line' }; saveSettings();
    app.setTool('measure'); renderMeasureWindow(app);
  } });
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
