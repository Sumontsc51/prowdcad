/**
 * Grade menu: clipboard (copy / paste / X-only / Y-only / Smart / Around), flips, equal, delete,
 * stack point / along line, angle grading (auto-aim), grade parallel / proportionally, graded nest,
 * rule library & movement program windows, size housekeeping, axis-2 variation setup.
 * The same commands back the grading-table toolbar.
 */
import type { GradeClipboard, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { registerCommand, type CommandCtx } from '../commands';
import { ops } from '../ops-bridge';
import { settings, saveSettings } from '../settings';
import { showDialog, rememberedDialog, confirmDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { hasAnchor, pieceAnchors, must } from './cmd-util';
import { runOrPick, anchorOrPick, sizeNameOf } from '../selection';
import { openRuleLibrary } from '../panels/rules';
import { openGradeFit } from '../panels/grade-fit';
import { openMovement } from '../panels/movement';
import { pick } from '../tools/pick';

export const gradeClip: { clip: GradeClipboard | null } = { clip: null };
const hasClip = (c: CommandCtx) => hasAnchor(c) && !!gradeClip.clip;

function selIds(app: App): { pieceId: Id; ids: Id[] } {
  const { piece, ids } = pieceAnchors(app);
  return { pieceId: piece.id, ids };
}

export function registerGrade(app: App) {
  const tx = (label: string, fn: () => void) => app.doc.transact(label, fn);
  const stepSize = (d: number) => {
    const ids = app.sizeLine().sizes.map(s => s.id);
    const i = ids.indexOf(app.activeSize);
    app.activeSize = ids[Math.max(0, Math.min(ids.length - 1, i + d))];
    app.status(`Size ${sizeNameOf(app, app.activeSize)}`);
  };
  registerCommand({ id: 'grade.table', title: 'Grading table', menu: 'Grade', group: 0, hotkey: 'Ctrl+G', checked: () => settings.panels.grading, run: () => { settings.panels.grading = !settings.panels.grading; saveSettings(); } });
  registerCommand({ id: 'grade.nested', title: 'Nested view (all sizes)', menu: 'Grade', group: 0, hotkey: 'Alt+N', checked: c => c.app.nested, run: () => { app.nested = !app.nested; } });
  registerCommand({ id: 'grade.absolute', title: 'Show absolute values', menu: 'Grade', group: 0, checked: c => c.app.gradeAbsolute, run: () => { app.gradeAbsolute = !app.gradeAbsolute; } });
  registerCommand({ id: 'grade.tracking', title: 'Point tracking (arrow keys)', menu: 'Grade', group: 0, hotkey: 'Alt+T', checked: c => c.app.pointTracking, run: () => { app.pointTracking = !app.pointTracking; app.status(app.pointTracking ? 'Point tracking ON: ←/→ point, ↑/↓ size' : 'Point tracking OFF'); } });
  registerCommand({ id: 'grade.ruleNames', title: 'Show rule names', menu: 'Grade', group: 0, checked: () => settings.showRuleNames, run: () => { settings.showRuleNames = !settings.showRuleNames; saveSettings(); } });
  registerCommand({ id: 'grade.badges', title: 'Rule badges on grade points', menu: 'Grade', group: 0, hotkey: 'Shift+Alt+B', checked: () => settings.ruleBadges, run: () => { settings.ruleBadges = !settings.ruleBadges; saveSettings(); app.status(settings.ruleBadges ? 'Rule badges ON: blue = rule · amber * = edited · green g = own grading · grey 0 = ungraded · select points and type a rule number to apply it' : 'Rule badges OFF'); app.invalidate(); } });
  registerCommand({ id: 'grade.prevSize', title: 'Previous size', menu: 'Grade', group: 1, hotkey: 'Ctrl+[', run: () => stepSize(-1) });
  registerCommand({ id: 'grade.nextSize', title: 'Next size', menu: 'Grade', group: 1, hotkey: 'Ctrl+]', run: () => stepSize(1) });
  registerCommand({ id: 'grade.baseSize', title: 'Go to base size', menu: 'Grade', group: 1, hotkey: 'Ctrl+B', run: () => { app.activeSize = app.baseSize(); } });

  // clipboard
  registerCommand({ id: 'grade.copy', title: 'Copy grade', menu: 'Grade/Clipboard', hotkey: 'Ctrl+Alt+C', enabled: hasAnchor, run: () => { const s = selIds(app); gradeClip.clip = ops.copyGrading(app.doc, s.pieceId, s.ids); app.status(`Grade copied (${s.ids.length} point${s.ids.length > 1 ? 's' : ''})`); } });
  registerCommand({ id: 'grade.paste', title: 'Paste grade', menu: 'Grade/Clipboard', hotkey: 'Ctrl+Alt+V', enabled: hasClip, run: () => { const s = selIds(app); ops.pasteGrading(app.doc, s.pieceId, s.ids, gradeClip.clip!); } });
  registerCommand({ id: 'grade.pasteX', title: 'Paste X only', menu: 'Grade/Clipboard', hotkey: 'Ctrl+Alt+X', enabled: hasClip, run: () => { const s = selIds(app); ops.pasteGrading(app.doc, s.pieceId, s.ids, gradeClip.clip!, { component: 'x' }); } });
  registerCommand({ id: 'grade.pasteY', title: 'Paste Y only', menu: 'Grade/Clipboard', hotkey: 'Ctrl+Alt+Y', enabled: hasClip, run: () => { const s = selIds(app); ops.pasteGrading(app.doc, s.pieceId, s.ids, gradeClip.clip!, { component: 'y' }); } });
  registerCommand({ id: 'grade.pasteFlipX', title: 'Paste flipped X', menu: 'Grade/Clipboard', enabled: hasClip, run: () => { const s = selIds(app); ops.pasteGrading(app.doc, s.pieceId, s.ids, gradeClip.clip!, { flipX: true }); } });
  registerCommand({ id: 'grade.pasteFlipY', title: 'Paste flipped Y', menu: 'Grade/Clipboard', enabled: hasClip, run: () => { const s = selIds(app); ops.pasteGrading(app.doc, s.pieceId, s.ids, gradeClip.clip!, { flipY: true }); } });
  registerCommand({ id: 'grade.smartPaste', title: 'Smart paste (mirror-aware)', menu: 'Grade/Clipboard', hotkey: 'Ctrl+Alt+M', enabled: hasClip, run: () => {
    const s = selIds(app); const f = ops.smartPaste(app.doc, s.pieceId, s.ids, gradeClip.clip!);
    app.status(`Smart paste: ${f.filter(Boolean).length} of ${f.length} flipped`);
  } });
  registerCommand({ id: 'grade.pasteAround', title: 'Paste around (run / selection)…', menu: 'Grade/Clipboard', enabled: c => !!gradeClip.clip, run: async () => {
    if (app.sel.anchors.length > 2) { const s = selIds(app); ops.pasteGradingAround(app.doc, s.pieceId, s.ids, gradeClip.clip!); return; }
    const run = await runOrPick(app, 'Paste around: click the run (or select its two end points)');
    ops.pasteGradingAround(app.doc, run.pieceId, { from: run.from, to: run.to }, gradeClip.clip!);
  } });
  // edits
  const each = (id: string, title: string, fn: 'flipX' | 'flipY' | 'equalX' | 'equalY' | 'deleteX' | 'deleteY' | 'deleteAll', hotkey?: string) =>
    registerCommand({ id, title, menu: 'Grade/Edit', hotkey, enabled: hasAnchor, run: () => { const s = selIds(app); ops[fn](app.doc, s.pieceId, s.ids); } });
  each('grade.flipX', 'Flip X', 'flipX'); each('grade.flipY', 'Flip Y', 'flipY');
  each('grade.equalX', 'Equal X', 'equalX'); each('grade.equalY', 'Equal Y', 'equalY');
  each('grade.deleteX', 'Delete X', 'deleteX'); each('grade.deleteY', 'Delete Y', 'deleteY'); each('grade.zero', 'Delete all (zero grade)', 'deleteAll');
  registerCommand({ id: 'grade.stackPoint', title: 'Stack nest at point', menu: 'Grade/Edit', run: async () => { const r = await anchorOrPick(app, 'Stack point: click the point to stack all sizes on'); ops.stackPoint(app.doc, r.pieceId, r.anchorId); } });
  registerCommand({ id: 'grade.stackLine', title: 'Stack along line…', menu: 'Grade/Edit', run: async () => {
    const a = await must(app, { kind: 'anchor', prompt: 'Stack along line: click point A (stacks)' }, 'anchor');
    const b = await must(app, { kind: 'anchor', prompt: 'Stack along line: click point B (direction)', pieceId: a.hit.piece.id }, 'anchor');
    ops.stackAlongLine(app.doc, a.hit.piece.id, a.hit.anchor.id, b.hit.anchor.id);
  } });
  registerCommand({ id: 'grade.angle', title: 'Angle grading…', menu: 'Grade/Edit', enabled: hasAnchor, run: async () => {
    const s = selIds(app);
    const r = await rememberedDialog('grade.angle', { title: 'Angle grading', fields: [
      { kind: 'radio', key: 'how', label: 'Grade axis', value: 'next', options: [{ value: 'next', label: 'Auto-aim at next grade point' }, { value: 'prev', label: 'Auto-aim at previous grade point' }, { value: 'deg', label: 'Explicit angle' }, { value: 'reset', label: 'Reset (world axes)' }] },
      { kind: 'number', key: 'deg', label: 'Angle', value: 0, suffix: '°' },
      { kind: 'checkbox', key: 'keep', label: 'Preserve geometry (re-express increments)', value: true },
    ] });
    if (!r) return;
    const out = ops.angleGrading(app.doc, s.pieceId, s.ids, r.how === 'deg' ? { deg: r.deg as number, preserve: !!r.keep } : r.how === 'reset' ? { deg: 0, preserve: !!r.keep } : { aim: r.how as 'next' | 'prev', preserve: !!r.keep });
    app.status(`Grade axis ${out.map(d => d.toFixed(2) + '°').join(', ')}`);
  } });
  registerCommand({ id: 'grade.parallel', title: 'Grade parallel…', noop: 'Grade parallel: nothing to change (the run already grades parallel)', menu: 'Grade/Edit', run: async () => {
    const run = await runOrPick(app, 'Grade parallel: click the segment');
    const r = await rememberedDialog('grade.parallel', { title: 'Grade parallel', fields: [
      { kind: 'radio', key: 'adj', label: 'Adjust', value: 'last', options: [{ value: 'last', label: 'End point' }, { value: 'first', label: 'Start point' }] },
      { kind: 'radio', key: 'axis', label: 'Move', value: 'both', options: [{ value: 'both', label: 'X and Y' }, { value: 'x', label: 'X only' }, { value: 'y', label: 'Y only' }] },
      { kind: 'checkbox', key: 'len', label: 'Preserve each size\'s length (rotate)', value: false },
    ] });
    if (r) ops.gradeParallel(app.doc, run.pieceId, run.from, run.to, { adjustLast: r.adj === 'last', xOnly: r.axis === 'x', yOnly: r.axis === 'y', preserveLength: !!r.len });
  } });
  registerCommand({ id: 'grade.proportional', title: 'Grade proportionally…', menu: 'Grade/Edit', run: async () => {
    const a = await must(app, { kind: 'anchor', prompt: 'Grade proportionally: click the FIRST graded reference point' }, 'anchor');
    const b = await must(app, { kind: 'anchor', prompt: 'Click the LAST graded reference point', pieceId: a.hit.piece.id }, 'anchor');
    let ids = app.sel.anchors.filter(x => x.pieceId === a.hit.piece.id && x.anchorId !== a.hit.anchor.id && x.anchorId !== b.hit.anchor.id).map(x => x.anchorId);
    if (!ids.length && a.hit.contour === b.hit.contour) {
      const run = ops.anchorRun(app.doc, a.hit.piece.id, a.hit.anchor.id, b.hit.anchor.id);
      ids = run.slice(1, -1);
    }
    for (;;) {
      if (ids.length) break;
      const r = await pick(app, { kind: 'anchorOrDrill', prompt: 'Click points / drills to grade between the references · Enter = apply', pieceId: a.hit.piece.id, allowDone: true });
      if (!r) return; if (r === 'done') break;
      if (r.kind === 'anchor') ids.push(r.hit.anchor.id); else if (r.kind === 'drill') ids.push(r.hit.drill.id);
    }
    const r = await rememberedDialog('grade.prop', { title: `Grade ${ids.length} item(s) proportionally`, fields: [{ kind: 'radio', key: 'by', label: 'By', value: 'auto', options: [{ value: 'auto', label: 'Auto' }, { value: 'arc', label: 'Arc length' }, { value: 'chord', label: 'Chord projection' }] }] });
    if (r) ops.gradeProportionally(app.doc, a.hit.piece.id, ids, a.hit.anchor.id, b.hit.anchor.id, r.by === 'auto' ? {} : { by: r.by as 'arc' | 'chord' });
  } });
  // rules / movement / nest
  registerCommand({ id: 'grade.rules', title: 'Grade rules (rule library)…', menu: 'Grade', group: 3, hotkey: 'Shift+Alt+R,Ctrl+Shift+R', run: () => openRuleLibrary(app) });
  registerCommand({ id: 'grade.applyRule', title: 'Apply rule (number / name)…', menu: 'Grade', group: 3, hotkey: 'Ctrl+R', enabled: hasAnchor, run: async () => {
    const r = await rememberedDialog('grade.applyRule', { title: 'Apply rule', fields: [{ kind: 'text', key: 'r', label: 'Rule number or name', value: '' }] });
    if (!r || !String(r.r).trim()) return;
    const s = selIds(app); const v = String(r.r).trim();
    ops.applyRule(app.doc, s.pieceId, s.ids, /^\d+$/.test(v) ? Number(v) : v);
  } });
  registerCommand({ id: 'grade.detachRule', title: 'Detach rule', menu: 'Grade', group: 3, enabled: hasAnchor, run: () => { const s = selIds(app); ops.detachRule(app.doc, s.pieceId, s.ids); } });
  registerCommand({ id: 'grade.byMeasurement', title: 'Grade by measurement…', menu: 'Grade', group: 3, run: () => openGradeFit(app) });
  registerCommand({ id: 'grade.movement', title: 'Movement programs…', menu: 'Grade', group: 3, run: () => openMovement(app) });
  registerCommand({ id: 'grade.nest', title: 'Graded nest from pieces…', menu: 'Grade', group: 4, enabled: c => c.app.sel.pieces.length > 1, run: async () => {
    const ids = app.sel.pieces.slice();
    const line = app.sizeLine();
    const r = await showDialog({ title: 'Graded nest (reverse grading)', message: `Pieces in selection order (smallest → largest):\n${ids.map((id, i) => `${i + 1}. ${app.doc.piece(id).name}`).join('\n')}`, fields: [
      ...ids.map((id, i) => ({ kind: 'select' as const, key: 's' + i, label: app.doc.piece(id).name, value: line.sizes[Math.min(i, line.sizes.length - 1)].id, options: line.sizes.map(s => ({ value: s.id, label: s.name })) })),
      { kind: 'text', key: 'name', label: 'New piece name', value: nestName(app.doc.piece(ids[0]).name, line.sizes.map(s => s.name)) },
    ] });
    if (!r) return;
    const sizeIds = ids.map((_, i) => String(r['s' + i]));
    const baseIdx = sizeIds.indexOf(line.baseSizeId);
    const p = ops.gradedNest(app.doc, ids, { sizeIds, baseIndex: baseIdx >= 0 ? baseIdx : undefined, name: String(r.name) });
    app.sel = { pieces: [p.id], anchors: [] }; app.nested = true;
  } });
  // sizes housekeeping
  registerCommand({ id: 'size.deleteUngraded', title: 'Delete ungraded sizes', menu: 'Grade/Sizes', run: async () => {
    const list = ops.ungradedSizes(app.doc);
    if (!list.length) { toast('No ungraded sizes', 'ok'); return; }
    if (await confirmDialog('Delete ungraded sizes', `Remove ${list.map(id => sizeNameOf(app, id)).join(', ')}?`, 'Delete')) ops.deleteUngradedSizes(app.doc);
  } });
  registerCommand({ id: 'size.deleteInvisible', title: 'Delete invisible sizes', menu: 'Grade/Sizes', run: async () => {
    const list = ops.invisibleSizes(app.doc);
    if (!list.length) { toast('No invisible sizes', 'ok'); return; }
    if (await confirmDialog('Delete invisible sizes', `Remove ${list.map(id => sizeNameOf(app, id)).join(', ')} (cut in no piece)?`, 'Delete')) ops.deleteInvisibleSizes(app.doc);
  } });
  registerCommand({ id: 'size.axis2', title: 'Variation table (axis 2)…', menu: 'Grade/Sizes', run: async () => {
    const t = app.doc.sizeTable();
    const r = await showDialog({ title: 'Size variation — second axis', message: t.axis2 ? `Current: ${t.axis2.name} — ${t.axis2.sizes.map(s => s.name).join(' ')}. Replacing clears axis-2 grading.` : 'e.g. inseam lengths 30, 32, 34 for a waist × inseam table.', fields: [
      { kind: 'text', key: 'name', label: 'Axis name', value: t.axis2?.name ?? 'Length' },
      { kind: 'text', key: 'sizes', label: 'Sizes (comma separated)', value: t.axis2?.sizes.map(s => s.name).join(', ') ?? '30, 32, 34' },
      { kind: 'text', key: 'base', label: 'Base', value: t.axis2 ? t.axis2.sizes.find(s => s.id === t.axis2!.baseSizeId)?.name ?? '' : '32' },
    ] });
    if (!r) return;
    const names = String(r.sizes).split(',').map(s => s.trim()).filter(Boolean);
    if (!names.includes(String(r.base).trim())) throw new Error('Base must be one of the sizes');
    ops.setAxis2(app.doc, names, String(r.base).trim(), { name: String(r.name) });
    toast(`Axis 2: ${names.join(' ')}`, 'ok');
  } });
}

/**
 * Default name of a graded nest: the first piece's name without a trailing size suffix
 * ("FRONT_S" / "FRONT S" / "FRONT_2" → "FRONT"), plus " NEST". A single-word name is kept whole.
 */
export function nestName(name: string, sizeNames: string[]): string {
  const m = name.match(/^(.*\S)[_ \-]([A-Za-z0-9]+)$/);
  const sizes = new Set(sizeNames.map(s => s.toUpperCase()));
  const base = m && (sizes.has(m[2].toUpperCase()) || /^\d+$/.test(m[2]) || /^copy$/i.test(m[2])) ? m[1] : name;
  return `${base.trim() || name} NEST`;
}
