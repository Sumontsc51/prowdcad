/**
 * Seam and Notch menus: per-segment / piece / global seam, corner gallery, manual seam angle,
 * lock grading, reseam family, seam ⇄ internal, delete / remove / repair seam, cut-corner display;
 * notch grid, corner / cross notches, Add Points for Notches, Global Notch Grading, notch setup;
 * drills (duplicate, multi buttons, slit contour segment), text, artwork, binding generator.
 */
import type { CornerSpec, NotchType, Id, Drill, BindingChainItem, RefPoint, Vec } from '@prowdcad/kernel';
import type { App } from '../app';
import { registerCommand } from '../commands';
import { ops, type AnchorRef } from '../ops-bridge';
import { settings, saveSettings } from '../settings';
import { showDialog, rememberedDialog, popover, alertDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { h } from '../ui/dom';
import { runOrPick, anchorOrPick, internalOrPick, pieceOrPick, Cancelled } from '../selection';
import { hasPiece, hasAnchor, onePiece, selPieces, must, pickPointLocal } from './cmd-util';
import { seamDialog } from '../tools/seam';
import { openNotchGrid } from '../panels/notchgrid';
import { duplicateDrillDialog, notchType } from '../tools/marks';
import { pick } from '../tools/pick';
import { runWorld, screenPath } from '../hitkit';
import { toWorld, toLocal, resolveFor } from '../geometry';
import { pickFiles } from './file';
import { fmt, unitLabel } from '../units-ui';
import { screenMarker } from '../tools/common';

const CORNERS: { spec: CornerSpec | 'manual'; label: string; svg: string }[] = [
  { spec: { type: 'miter' }, label: 'Miter', svg: '<path d="M4 20V4h16" /><path d="M8 20V8h12" stroke-dasharray="2 2"/>' },
  { spec: { type: 'boxed', extend: 'both' }, label: 'Boxed (both)', svg: '<path d="M4 20V4h16"/><path d="M8 20V4M4 8h16" stroke-dasharray="2 2"/>' },
  { spec: { type: 'boxed', extend: 'prev' }, label: 'Boxed (extend prev)', svg: '<path d="M4 20V4h16"/><path d="M8 20V4h4V8h8" stroke-dasharray="2 2"/>' },
  { spec: { type: 'boxed', extend: 'next' }, label: 'Boxed (extend next)', svg: '<path d="M4 20V4h16"/><path d="M8 20v-8H4V8h16" stroke-dasharray="2 2"/>' },
  { spec: { type: 'turnback' }, label: 'Turn-back (hem)', svg: '<path d="M4 20V4h16"/><path d="M8 20V10l-4-4M10 8h10" stroke-dasharray="2 2"/>' },
  { spec: { type: 'angled' }, label: 'Angled (bevel)', svg: '<path d="M4 20V4h16"/><path d="M8 20V12l4-4h8" stroke-dasharray="2 2"/>' },
  { spec: 'manual', label: 'Manual (2 clicks)…', svg: '<path d="M4 20V4h16"/><path d="M8 20V13l6-5h6" stroke-dasharray="2 2"/><circle cx="8" cy="13" r="1.4"/><circle cx="14" cy="8" r="1.4"/>' },
];

async function sewCorner(app: App): Promise<AnchorRef> {
  return anchorOrPick(app, 'Click a sew-line corner (grade point)', { gradeOnly: true, contour: 'sew' });
}

/** Manual Seam Angle: two clicks near the incoming / outgoing cut lines of a corner. */
export async function trimCornerFlow(app: App, ref?: AnchorRef) {
  const c = ref ?? await sewCorner(app);
  const piece = app.doc.piece(c.pieceId);
  const p1 = await pickPointLocal(app, piece, 'Manual seam angle: click the 1st trim point (near one cut line)');
  const p2 = await pickPointLocal(app, piece, 'Manual seam angle: click the 2nd trim point (near the other cut line)', (_ap, a) => {
    const s = app.view.toScreen(toWorld(piece, p1));
    return screenMarker(s, 'circle', '#e67e22', 4) + (a ? `<path d="M${s.x} ${s.y}L${app.view.toScreen(a).x} ${app.view.toScreen(a).y}" stroke="#e67e22" stroke-dasharray="4 3"/>` : '');
  });
  ops.trimCorner(app.doc, c.pieceId, c.anchorId, p1, p2);
  toast('Corner trimmed (manual)', 'ok');
}

export async function cornerGallery(app: App, ref?: AnchorRef, at?: { x: number; y: number }) {
  const c = ref ?? await sewCorner(app);
  const piece = app.doc.piece(c.pieceId);
  const cur = piece.sew.points.find(a => a.id === c.anchorId)?.corner;
  let close = () => {};
  const grid = h('div.corner-gallery');
  for (const it of CORNERS) {
    const on = it.spec === 'manual' ? cur?.type === 'manual' : cur ? cur.type === it.spec.type && (it.spec.type !== 'boxed' || (cur.extend ?? 'both') === it.spec.extend) : it.spec.type === 'miter';
    const b = h('button.cg-item' + (on ? '.on' : ''), { title: it.label });
    b.innerHTML = `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5">${it.svg}</svg>`;
    b.append(h('span', {}, it.label));
    b.onclick = () => {
      close();
      if (it.spec === 'manual') { void trimCornerFlow(app, c).catch(err => { if (!(err instanceof Cancelled)) toast((err as Error).message, 'error'); }); return; }
      try { ops.setCorner(app.doc, c.pieceId, c.anchorId, it.spec.type === 'miter' ? undefined : it.spec); } catch (err) { toast((err as Error).message, 'error'); }
    };
    grid.append(b);
  }
  const revert = h('button.btn.sm', { onclick: () => { close(); ops.revertCorner(app.doc, c.pieceId, c.anchorId); } }, 'Revert to miter');
  const pos = at ?? (() => {
    const q = app.resolveRef(c); const r = q ? resolveFor(app.doc, q.piece, app.sizeOf(q.piece)) : null;
    const w = q && r ? toWorld(q.piece, r.sew.anchorPos[q.index]) : { x: 0, y: 0 };
    const s = app.view.toScreen(w); const box = document.querySelector('#canvas svg.sheet')?.getBoundingClientRect();
    return { x: (box?.left ?? 0) + s.x + 12, y: (box?.top ?? 0) + s.y + 12 };
  })();
  close = popover(pos.x, pos.y, h('div', {}, h('div.pop-title', {}, `Corner — ${piece.name}`), grid, h('div.btnrow', {}, revert)));
}

export function registerSeamNotch(app: App) {
  const tx = (label: string, fn: () => void) => app.doc.transact(label, fn);

  // ───────────── Seam ─────────────
  registerCommand({ id: 'seam.tool', title: 'Seam value tool', menu: 'Seam', group: 0, run: () => app.setTool('seam') });
  registerCommand({ id: 'seam.segment', title: 'Seam of segment / run…', menu: 'Seam', group: 0, hotkey: 'Alt+S', run: async () => {
    const run = await runOrPick(app, 'Click a sew-line segment', 'sew');
    const p = app.doc.piece(run.pieceId);
    const v = await seamDialog(app, `Seam — ${p.name}`, p.sew.points.find(a => a.id === run.from)?.seamAfter ?? p.seamDefault);
    if (v != null) ops.setSeam(app.doc, run.pieceId, run.from, run.to, v);
  } });
  registerCommand({ id: 'seam.piece', title: 'Whole-piece seam…', menu: 'Seam', group: 0, enabled: hasPiece, run: async () => {
    const p = onePiece(app);
    const v = await seamDialog(app, `Seam — whole piece ${p.name}`, p.seamDefault);
    if (v != null) tx('Seam (pieces)', () => selPieces(app).forEach(pc => ops.setSeamWholePiece(app.doc, pc.id, v)));
  } });
  registerCommand({ id: 'seam.global', title: 'Global seam (all pieces)…', menu: 'Seam', group: 0, run: async () => {
    const v = await seamDialog(app, 'Global seam — every piece', 10);
    if (v != null) ops.setGlobalSeam(app.doc, v);
  } });
  registerCommand({ id: 'seam.corner', title: 'Corner type…', menu: 'Seam', group: 1, hotkey: 'Alt+K', run: () => cornerGallery(app) });
  registerCommand({ id: 'seam.trimCorner', title: 'Manual seam angle (trim corner)', menu: 'Seam', group: 1, hotkey: 'Shift+Alt+K', run: () => trimCornerFlow(app) });
  registerCommand({ id: 'seam.revertCorner', title: 'Revert corner', menu: 'Seam', group: 1, run: async () => { const c = await sewCorner(app); ops.revertCorner(app.doc, c.pieceId, c.anchorId); } });
  registerCommand({ id: 'seam.lockGrading', title: 'Lock grading (stamp base corners)', menu: 'Seam', group: 2, enabled: hasPiece, checked: c => !!c.app.primaryPiece()?.lockGrading,
    run: () => { const v = !onePiece(app).lockGrading; tx('Lock grading', () => selPieces(app).forEach(p => ops.setLockGrading(app.doc, p.id, v))); } });
  registerCommand({ id: 'seam.updateGrading', title: 'Update seam grading', noop: 'Update seam grading: nothing to update', menu: 'Seam', group: 2, enabled: hasPiece, run: () => tx('Update seam grading', () => selPieces(app).forEach(p => ops.updateSeamGrading(app.doc, p.id))) });
  registerCommand({ id: 'seam.reseam', title: 'Reseam piece', noop: 'Reseam piece: the seams are already up to date', menu: 'Seam', group: 2, hotkey: 'Ctrl+Alt+S', enabled: hasPiece, run: async () => {
    const p = onePiece(app);
    let discard = false;
    if (p.cutMode === 'manual') { const r = await showDialog({ title: 'Reseam', message: 'This piece has a manual cut line.', okLabel: 'Keep manual', buttons: [{ id: 'auto', label: 'Discard → auto' }] }); if (!r) return; discard = r.__button === 'auto'; }
    const rep = ops.reseamPiece(app.doc, p.id, { discardManual: discard });
    toast(`Reseamed: ${rep.removedCurveSeams} curve seams, ${rep.clampedValues} clamped, ${rep.droppedCorners} corners dropped`, 'ok');
  } });
  registerCommand({ id: 'seam.reseamAll', title: 'Reseam all pieces', menu: 'Seam', group: 2, run: () => { ops.reseamAll(app.doc); toast('All pieces reseamed', 'ok'); } });
  registerCommand({ id: 'seam.reseamSegment', title: 'Reseam segment…', menu: 'Seam', group: 2, run: async () => {
    const run = await runOrPick(app, 'Click a sew-line segment to reseam', 'sew');
    const p = app.doc.piece(run.pieceId);
    const r = await showDialog({ title: 'Reseam segment', fields: [{ kind: 'checkbox', key: 'set', label: 'Also set a new value', value: false }, { kind: 'length', key: 'v', label: 'Seam', value: p.sew.points.find(a => a.id === run.from)?.seamAfter ?? p.seamDefault }] });
    if (r) ops.reseamSegment(app.doc, run.pieceId, run.from, r.set ? r.v as number : undefined);
  } });
  registerCommand({ id: 'seam.repair', title: 'Repair seam parameters', noop: 'Repair seam parameters: nothing to repair', menu: 'Seam', group: 2, run: async () => {
    const rep = ops.repairSeam(app.doc, app.sel.pieces.length === 1 ? app.sel.pieces[0] : undefined);
    await alertDialog('Repair seam parameters', `Curve-point seams removed: ${rep.removedCurveSeams}\nValues clamped: ${rep.clampedValues}\nCorners dropped: ${rep.droppedCorners}`);
  } });
  registerCommand({ id: 'seam.toInternal', title: 'Seam → internal', menu: 'Seam', group: 3, enabled: hasPiece, run: () => { ops.seamToInternal(app.doc, onePiece(app).id); toast('Cut line is now an internal; piece has no seam', 'ok'); } });
  registerCommand({ id: 'seam.fromInternal', title: 'Internal → seam…', menu: 'Seam', group: 3, run: async () => {
    const { piece, contour } = await internalOrPick(app, 'Click the closed internal that surrounds the sew line');
    const r = await showDialog({ title: 'Internal → seam', fields: [{ kind: 'radio', key: 'm', label: 'Cut line', value: 'manual', options: [{ value: 'manual', label: 'Manual (exact internal shape)' }, { value: 'auto', label: 'Auto (inferred per-segment values)' }] }] });
    if (!r) return;
    const vals = ops.internalToSeam(app.doc, piece.id, contour.id, r.m as 'manual' | 'auto');
    toast(`Inferred seams: ${vals.map(v => fmt(v)).join(' / ')} ${unitLabel()}`, 'ok', 5000);
  } });
  registerCommand({ id: 'seam.cutAuto', title: 'Manual cut → auto', menu: 'Seam', group: 3, enabled: c => c.app.primaryPiece()?.cutMode === 'manual', run: () => ops.setCutModeAuto(app.doc, onePiece(app).id) });
  registerCommand({ id: 'seam.deleteSegment', title: 'Delete seam on segment / run', menu: 'Seam', group: 4, run: async () => { const run = await runOrPick(app, 'Click a sew-line segment', 'sew'); ops.deleteSeamSegment(app.doc, run.pieceId, run.from, run.to); } });
  registerCommand({ id: 'seam.removePiece', title: 'Remove seam (piece)', menu: 'Seam', group: 4, enabled: hasPiece, run: () => tx('Remove seam', () => selPieces(app).forEach(p => ops.removeSeamPiece(app.doc, p.id))) });
  registerCommand({ id: 'seam.removeAll', title: 'Remove seam (all pieces)…', menu: 'Seam', group: 4, run: async () => { if (await showDialog({ title: 'Remove all seams', message: 'Every piece becomes cut = sew. Undo restores it.', okLabel: 'Remove' })) ops.removeSeamAll(app.doc); } });
  registerCommand({ id: 'seam.noSeam', title: 'No seam (cut = sew)', menu: 'Seam', group: 4, enabled: hasPiece, checked: c => !!c.app.primaryPiece()?.noSeam,
    run: () => { const v = !onePiece(app).noSeam; tx('No seam', () => selPieces(app).forEach(p => { p.noSeam = v; })); } });
  registerCommand({ id: 'seam.autoReseam', title: 'Auto reseam on edit', menu: 'Seam', group: 5, checked: c => c.app.style.settings.autoReseam, run: () => tx('Auto reseam', () => { app.style.settings.autoReseam = !app.style.settings.autoReseam; }) });
  registerCommand({ id: 'seam.showCut', title: 'Show cut line', menu: 'Seam', group: 5, checked: () => settings.showCut, run: () => { settings.showCut = !settings.showCut; saveSettings(); } });
  registerCommand({ id: 'seam.showCorners', title: 'Show cut-line corner indices', menu: 'Seam', group: 5, checked: () => settings.showCutCorners, run: () => { settings.showCutCorners = !settings.showCutCorners; saveSettings(); } });

  // ───────────── Notch ─────────────
  registerCommand({ id: 'notch.tool', title: 'Notch tool', menu: 'Notch', group: 0, run: () => app.setTool('notch') });
  registerCommand({ id: 'notch.grid', title: 'Notch grid editor', menu: 'Notch', group: 0, hotkey: 'Shift+Alt+N,Ctrl+Shift+N', run: async () => { const p = await pieceOrPick(app, 'Click a piece'); openNotchGrid(app, p.id); } });
  registerCommand({ id: 'notch.atPoint', title: 'Notch on selected point(s)', menu: 'Notch', group: 1, enabled: hasAnchor, run: () => tx('Notch on points', () => {
    for (const r of app.sel.anchors) { const p = app.doc.piece(r.pieceId); ops.addNotch(app.doc, p, { contourId: r.contourId, placement: { kind: 'anchor', anchorId: r.anchorId }, type: notchType }); }
  }) });
  registerCommand({ id: 'notch.corner', title: 'Corner notch…', menu: 'Notch', group: 1, run: async () => {
    const c = await anchorOrPick(app, 'Click a corner (grade point)', { gradeOnly: true });
    const r = await rememberedDialog('notch.corner', { title: 'Corner notch', fields: [
      { kind: 'radio', key: 'dir', label: 'Along', value: 'prev', options: [{ value: 'prev', label: 'Previous segment (continued)' }, { value: 'next', label: 'Next segment (extended back)' }] },
      { kind: 'select', key: 'type', label: 'Type', value: notchType, options: (['slit', 'T', 'V', 'U', 'castle'] as NotchType[]).map(t => ({ value: t, label: t })) },
    ] });
    if (r) ops.addCornerNotch(app.doc, app.doc.piece(c.pieceId), c.anchorId, r.dir as 'prev' | 'next', { contourId: c.contourId, type: r.type as NotchType });
  } });
  registerCommand({ id: 'notch.cross', title: 'Cross notch (from internal end)…', menu: 'Notch', group: 1, run: async () => {
    const res = await must(app, { kind: 'anchor', prompt: 'Click the END point of an internal line', contour: 'internal' }, 'anchor');
    const c = res.hit.contour; const i = res.hit.index;
    if (i !== 0 && i !== c.points.length - 1) throw new Error('Click the first or last point of the internal line');
    const r = await rememberedDialog('notch.cross', { title: 'Cross notch', fields: [
      { kind: 'select', key: 'dir', label: 'Throw direction', value: 'along', options: [{ value: 'along', label: 'Along the line' }, { value: 'perp', label: 'Perpendicular (nearest side)' }, { value: 'perpLeft', label: 'Perpendicular left' }, { value: 'perpRight', label: 'Perpendicular right' }] },
      { kind: 'checkbox', key: 'align', label: 'Rotate notch along the throw', value: false },
      { kind: 'select', key: 'type', label: 'Type', value: notchType, options: (['slit', 'T', 'V', 'U', 'castle'] as NotchType[]).map(t => ({ value: t, label: t })) },
    ] });
    if (!r) return;
    const n = ops.crossNotch(app.doc, res.hit.piece, { internalContourId: c.id, end: i === 0 ? 'start' : 'end', direction: r.dir as 'along', alignToThrow: !!r.align, type: r.type as NotchType });
    if (!n) toast('The throw does not reach the perimeter', 'warn');
  } });
  registerCommand({ id: 'notch.addPoints', title: 'Add points for notches', menu: 'Notch', group: 2, enabled: hasPiece, run: () => { let k = 0; tx('Add points for notches', () => selPieces(app).forEach(p => { k += ops.addPointsForNotches(app.doc, p).length; })); toast(`${k} point(s) added under notches`, 'ok'); } });
  registerCommand({ id: 'notch.global', title: 'Global notch grading…', menu: 'Notch', group: 2, enabled: hasPiece, run: async () => {
    const r = await rememberedDialog('notch.global', { title: 'Global Notch Grading', message: 'Convert floating notches of the selected piece(s) to one rule; base positions are preserved.', fields: [
      { kind: 'select', key: 'rule', label: 'Rule', value: 'proportional', options: [{ value: 'fromPrev', label: 'From previous' }, { value: 'fromNext', label: 'From next' }, { value: 'proportional', label: 'Proportional' }] },
      { kind: 'select', key: 'per', label: 'Per size (prev / next)', value: 'preserve', options: [{ value: 'preserve', label: 'Keep each size\'s position' }, { value: 'constant', label: 'Constant (base distance)' }] },
    ] });
    if (!r) return;
    let k = 0; tx('Global notch grading', () => selPieces(app).forEach(p => { k += ops.globalNotchGrading(app.doc, p, r.rule as 'fromPrev', { perSize: r.per as 'preserve' }); }));
    toast(`${k} notch(es) converted`, 'ok');
  } });
  registerCommand({ id: 'notch.setup', title: 'Notch setup (defaults)…', menu: 'Notch', group: 3, run: async () => {
    const ns = app.style.settings.notchSetup;
    const types: NotchType[] = ['slit', 'T', 'V', 'U', 'castle'];
    const r = await showDialog({ title: 'Notch setup', wide: true, fields: types.flatMap(t => [
      { kind: 'length' as const, key: t + '_d', label: `${t}: depth`, value: ns[t].depth, min: 0.01 },
      { kind: 'length' as const, key: t + '_w', label: `${t}: width`, value: ns[t].width, min: 0 },
      { kind: 'select' as const, key: t + '_m', label: `${t}: mode`, value: ns[t].mode, options: [{ value: 'cut', label: 'cut' }, { value: 'draw', label: 'draw' }] },
    ]) });
    if (r) tx('Notch setup', () => { for (const t of types) app.style.settings.notchSetup[t] = { depth: r[t + '_d'] as number, width: r[t + '_w'] as number, mode: r[t + '_m'] as 'cut' | 'draw' }; });
  } });

  // drills / buttons
  registerCommand({ id: 'drill.tool', title: 'Drill / button tool', menu: 'Notch', group: 4, run: () => app.setTool('drill') });
  registerCommand({ id: 'drill.duplicate', title: 'Duplicate drill with offset…', menu: 'Notch', group: 4, run: async () => {
    const d = await must(app, { kind: 'drill', prompt: 'Click the drill / button to duplicate' }, 'drill');
    await duplicateDrillDialog(app, d.hit.piece, d.hit.drill.id);
  } });
  registerCommand({ id: 'drill.multi', title: 'Multi buttons (between two refs)…', menu: 'Notch', group: 4, run: async () => {
    const refOf = (r: Awaited<ReturnType<typeof must>>): { pieceId: Id; ref: RefPoint } => r.kind === 'drill' ? { pieceId: r.hit.piece.id, ref: { drillId: r.hit.drill.id } } : r.kind === 'anchor' ? { pieceId: r.hit.piece.id, ref: { anchorId: r.hit.anchor.id } } : (() => { throw new Error('Pick a point or drill'); })();
    const a = refOf(await must(app, { kind: 'anchorOrDrill', prompt: 'Multi buttons: click the FIRST reference (point or drill)' }));
    const b = refOf(await must(app, { kind: 'anchorOrDrill', prompt: 'Multi buttons: click the SECOND reference', pieceId: a.pieceId }));
    const r = await rememberedDialog('drill.multi', { title: 'Multi buttons', fields: [
      { kind: 'number', key: 'n', label: 'Count', value: 5, min: 1, max: 200 },
      { kind: 'radio', key: 'ends', label: 'Ends', value: 'inclusive', options: [{ value: 'inclusive', label: 'On the references' }, { value: 'exclusive', label: 'Strictly between (equal gaps)' }] },
      { kind: 'radio', key: 'kind', label: 'Kind', value: 'button', options: [{ value: 'button', label: 'Button' }, { value: 'buttonhole', label: 'Buttonhole' }, { value: 'drill', label: 'Drill' }] },
      { kind: 'length', key: 'dia', label: 'Diameter', value: 12, min: 0.1 },
    ] });
    if (r) ops.multiButtons(app.doc, app.doc.piece(a.pieceId), { from: a.ref, to: b.ref, count: Math.round(r.n as number), ends: r.ends as 'inclusive', kind: r.kind as Drill['kind'], diameter: r.dia as number });
  } });
  registerCommand({ id: 'drill.slit', title: 'Slit contour segment…', menu: 'Notch', group: 4, run: async () => {
    const run = await runOrPick(app, 'Click the segment to distribute along');
    const r = await rememberedDialog('drill.slit', { title: 'Slit contour segment', fields: [
      { kind: 'select', key: 'el', label: 'Element', value: 'button', options: ['slit', 'notch', 'button', 'drill', 'line'].map(v => ({ value: v, label: v })) },
      { kind: 'number', key: 'n', label: 'Count', value: 5, min: 1, max: 500 },
      { kind: 'text', key: '_dist', label: 'Manual distances (optional)', value: '', placeholder: `e.g. 20, 60, 100 (${unitLabel()})` },
      { kind: 'radio', key: 'ends', label: 'Ends', value: 'inclusive', options: [{ value: 'inclusive', label: 'Inclusive' }, { value: 'exclusive', label: 'Exclusive' }] },
      { kind: 'radio', key: 'grading', label: 'Grading', value: 'proportional', options: [{ value: 'proportional', label: 'Proportional' }, { value: 'fixedFromStart', label: 'Fixed from start' }] },
      { kind: 'length', key: 'inset', label: 'Inset from contour', value: 15, min: 0 },
      { kind: 'length', key: 'len', label: 'Slit / line length', value: 20, min: 0 },
      { kind: 'length', key: 'dia', label: 'Diameter', value: 12, min: 0.1 },
      { kind: 'select', key: 'nt', label: 'Notch type', value: notchType, options: (['slit', 'T', 'V', 'U', 'castle'] as NotchType[]).map(t => ({ value: t, label: t })) },
      { kind: 'radio', key: 'mode', label: 'Mode', value: 'cut', options: [{ value: 'cut', label: 'Cut' }, { value: 'draw', label: 'Draw' }] },
    ] });
    if (!r) return;
    const { parseLen } = await import('../units-ui');
    const dist = String(r._dist).split(/[,;\s]+/).filter(Boolean).map(parseLen).filter(Number.isFinite);
    const res = ops.slitContourSegment(app.doc, app.doc.piece(run.pieceId), {
      contourId: run.contourId, fromAnchorId: run.from, toAnchorId: run.to, element: r.el as 'slit', count: Math.round(r.n as number), distances: dist.length ? dist : undefined,
      ends: r.ends as 'inclusive', grading: r.grading as 'proportional', inset: r.inset as number, length: r.len as number, diameter: r.dia as number, notchType: r.nt as NotchType, mode: r.mode as 'cut',
    });
    toast(`${res.notches.length} notches · ${res.drills.length} drills/buttons · ${res.lines.length} lines`, 'ok');
  } });

  // text / artwork
  registerCommand({ id: 'text.tool', title: 'Text tool', menu: 'Notch', group: 5, run: () => app.setTool('text') });
  registerCommand({ id: 'art.place', title: 'Place artwork…', menu: 'Notch', group: 5, run: async () => {
    const [f] = await pickFiles('image/*,.svg', false); if (!f) return;
    const src = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(f); });
    const dims = await new Promise<{ w: number; h: number }>(res => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth || 100, h: im.naturalHeight || 100 }); im.onerror = () => res({ w: 100, h: 100 }); im.src = src; });
    const pc = await must(app, { kind: 'piece', prompt: `Click inside a piece to place ${f.name}` }, 'piece');
    const at = toLocal(pc.piece, pc.w);
    const r = await rememberedDialog('art.place', { title: `Artwork — ${f.name}`, message: `${dims.w} × ${dims.h} px`, fields: [
      { kind: 'number', key: 'dpi', label: 'Source DPI', value: 300, min: 1 },
      { kind: 'number', key: 'sx', label: 'Scale X', value: 100, suffix: '%' },
      { kind: 'number', key: 'sy', label: 'Scale Y', value: 100, suffix: '%' },
      { kind: 'number', key: 'ang', label: 'Angle', value: 0, suffix: '°' },
    ] });
    if (!r) return;
    ops.addArtwork(app.doc, pc.piece, { x: at.x, y: at.y, width: ops.pixelsToMm(dims.w, r.dpi as number), height: ops.pixelsToMm(dims.h, r.dpi as number), src, scaleX: (r.sx as number) / 100, scaleY: (r.sy as number) / 100, angleDeg: r.ang as number, name: f.name });
  } });
  registerCommand({ id: 'art.delete', title: 'Delete artwork of piece', menu: 'Notch', group: 5, enabled: c => !!c.app.primaryPiece()?.artwork.length, run: () => { const p = onePiece(app); tx('Delete artwork', () => p.artwork.slice().forEach(a => ops.deleteArtwork(app.doc, p, a.id))); } });

  // binding
  registerCommand({ id: 'binding', title: 'Binding generator…', menu: 'Notch', group: 6, hotkey: 'Ctrl+Alt+B', run: async () => {
    const chain: BindingChainItem[] = [];
    const draw = (a: App) => chain.map(c => { const p = a.doc.style.pieces.find(x => x.id === c.pieceId); const cc = p && [p.sew, ...p.internals].find(x => x.id === c.contourId); return p && cc ? `<path d="${screenPath(a, runWorld(a, p, cc, c.fromAnchorId, c.toAnchorId))}" fill="none" stroke="#16a085" stroke-width="4" opacity="0.6"/>` : ''; }).join('');
    for (;;) {
      const r = await pick(app, { kind: 'contour', prompt: `Binding chain: click segment ${chain.length + 1} (any piece) · Enter / right-click = done`, allowDone: true, overlay: a => draw(a) });
      if (r === null) return;
      if (r === 'done') break;
      if (r.kind !== 'contour' || !r.hit.from || !r.hit.to) { toast('Click a segment between grade points', 'warn'); continue; }
      chain.push({ pieceId: r.hit.piece.id, contourId: r.hit.contour.id, fromAnchorId: r.hit.from, toAnchorId: r.hit.to });
    }
    if (!chain.length) return;
    const r = await rememberedDialog('binding', { title: `Binding — ${chain.length} segment(s)`, fields: [
      { kind: 'length', key: 'w', label: 'Width (one layer)', value: 30, min: 0.1 },
      { kind: 'number', key: 'bias', label: 'End / grain angle', value: 45, min: 1, max: 90, suffix: '°' },
      { kind: 'checkbox', key: 'fold', label: 'Half fold (double width)', value: false },
      { kind: 'number', key: 'shrink', label: 'Shrinkage', value: 0, suffix: '%' },
      { kind: 'number', key: 'scale', label: 'Length scale', value: 100, suffix: '%' },
      { kind: 'checkbox', key: 'copy', label: 'Copy notches', value: true },
      { kind: 'checkbox', key: 'breaks', label: 'Support notch at breaks', value: true },
      { kind: 'text', key: '_name', label: 'Name', value: 'BINDING' },
    ] });
    if (!r) return;
    const res = ops.generateBinding(app.doc, { chain, width: r.w as number, biasAngleDeg: r.bias as number, halfFold: !!r.fold, shrinkPct: r.shrink as number, scalePct: r.scale as number, copyNotches: !!r.copy, supportNotchAtBreaks: !!r.breaks, name: String(r._name) || 'BINDING' });
    app.sel = { pieces: [res.piece.id], anchors: [] };
    const line = app.sizeLine();
    toast(`Binding: ${line.sizes.map(s => `${s.name} ${fmt(res.lengthBySize[s.id] ?? 0)}`).join(' · ')} ${unitLabel()}`, 'ok', 6000);
  } });
}

export type { Vec };
