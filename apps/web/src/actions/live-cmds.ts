/**
 * Dart menu: darts, pleats (Dart ▸ Pleat) and fullness (Dart ▸ Fullness) — the live-object
 * kernel modules ops/darts, ops/pleats, ops/fullness. Interactive flows use canvas picks; the
 * selected live object (app.liveSel, set by clicking a dart leg / pleat axis / slash line) is used
 * when there is one, otherwise the command asks for a pick.
 */
import type { Id, Vec, Piece, DartClip, PleatAttributes } from '@prowdcad/kernel';
import type { App } from '../app';
import { registerCommand, reportError } from '../commands';
import { ops, type LiveContourPos } from '../ops-bridge';
import { rememberedDialog, showDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { must } from './cmd-util';
import { runOrPick, Cancelled } from '../selection';
import { contourPos, liveExists, selectLive, type LiveKind, type LiveRef } from '../live';
import { toLocal, toWorld, resolveFor } from '../geometry';
import { contourNear } from '../hitkit';
import { fs, screenMarker } from '../tools/common';
import { pick } from '../tools/pick';
import { fmt, unitLabel } from '../units-ui';

let dartClip: DartClip | null = null;
export const hasDartClip = () => !!dartClip;

function unlocked(app: App, pieceId: Id): Piece {
  const p = app.doc.piece(pieceId);
  if (p.locked) throw new Error(`${p.name} is locked`);
  return p;
}

/** The selected live object of `kind`, or a canvas pick of one. */
export async function liveOrPick(app: App, kind: LiveKind, prompt: string): Promise<LiveRef> {
  const s = app.currentLive();
  if (s && s.kind === kind && liveExists(app, s)) return s;
  const r = await must(app, { kind: 'live', liveKind: kind, prompt }, 'live');
  selectLive(app, r.hit.ref);
  return r.hit.ref;
}

/** Pick a position on a sew line → kernel contour position. */
async function pickSewPos(app: App, prompt: string, pieceId?: Id): Promise<{ piece: Piece; pos: LiveContourPos; w: Vec }> {
  const r = await must(app, { kind: 'contour', contour: 'sew', prompt, pieceId }, 'contour');
  return { piece: r.hit.piece, pos: contourPos(app, r.hit), w: r.hit.world };
}

const marker = (app: App, w: Vec, col = '#d6309b') => screenMarker(app.view.toScreen(w), 'ring', col, 6);

// ───────────────────────── darts ─────────────────────────

/** Create-dart dialog + apex (depth or a clicked point) → createDart. `at` is a contour position or a sew anchor. */
export async function createDartFlow(app: App, pieceId: Id, at: LiveContourPos | { anchorId: Id }, atWorld: Vec): Promise<Id | null> {
  unlocked(app, pieceId);
  const r = await rememberedDialog('dart.create', { title: 'Create dart', fields: [
    { kind: 'length', key: 'w', label: 'Width (opening)', value: 20, min: 0.01 },
    { kind: 'radio', key: 'apex', label: 'Apex', value: 'depth', options: [{ value: 'depth', label: 'By depth (on the bisector)' }, { value: 'click', label: 'Click a point' }] },
    { kind: 'length', key: 'd', label: 'Depth', value: 100, min: 0.01 },
    { kind: 'radio', key: 'fold', label: 'Fold toward', value: 'A', options: [{ value: 'A', label: 'Leg A' }, { value: 'B', label: 'Leg B' }] },
    { kind: 'length', key: 'drill', label: 'Drill offset from apex', value: 12, min: 0 },
  ] });
  if (!r) return null;
  let apex: Vec | undefined;
  if (r.apex === 'click') {
    const piece = app.doc.piece(pieceId);
    const p = await must(app, { kind: 'point', prompt: 'Dart: click the apex', overlay: (a, hov) => hov ? `<path d="M${fs(a.view.toScreen(atWorld).x)} ${fs(a.view.toScreen(atWorld).y)}L${fs(a.view.toScreen(hov).x)} ${fs(a.view.toScreen(hov).y)}" stroke="#d6309b" stroke-dasharray="4 3"/>` + marker(a, atWorld) : marker(a, atWorld) }, 'point');
    apex = toLocal(piece, p.w);
  }
  const id = ops.addDart(app.doc, { pieceId, at, width: r.w as number, depth: apex ? undefined : r.d as number, apex, fold: r.fold as 'A' | 'B', drillOffset: r.drill as number });
  selectLive(app, { kind: 'dart', pieceId, id });
  app.status(`Dart created · width ${fmt(r.w as number)} ${unitLabel()}`);
  return id;
}

/** Pivot transfer: pick dart → click the target on the contour → pct (default 100) + optional pivot click. */
export async function transferFlow(app: App) {
  const d = await liveOrPick(app, 'dart', 'Pivot transfer: click the dart to move');
  unlocked(app, d.pieceId);
  const t = await pickSewPos(app, 'Pivot transfer: click the TARGET position on the sew line', d.pieceId);
  const r = await rememberedDialog('dart.transfer', { title: 'Pivot transfer', fields: [
    { kind: 'number', key: 'pct', label: 'Amount transferred', value: 100, min: 0.0001, max: 100, suffix: '%' },
    { kind: 'checkbox', key: 'pivot', label: 'Click a pivot point (default: the apex)', value: false },
  ] });
  if (!r) return;
  let pivot: Vec | undefined;
  if (r.pivot) pivot = toLocal(t.piece, (await must(app, { kind: 'point', prompt: 'Pivot transfer: click the pivot', overlay: a => marker(a, t.w) }, 'point')).w);
  const id = ops.rotateDart(app.doc, { pieceId: d.pieceId, dartId: d.id, target: t.pos, pct: r.pct as number, pivot });
  selectLive(app, { kind: 'dart', pieceId: d.pieceId, id });
  app.status(`Dart transferred ${r.pct}%`);
}

/**
 * Rotate Around offset Center: pick the dart, click the target position (or click a second dart:
 * its opening midpoint is not a valid target, so the target is taken just beyond its leg B), click
 * the centre → pct (default 50). The new dart shares the old apex; both are re-equalized.
 */
async function rotateCenterFlow(app: App) {
  const d = await liveOrPick(app, 'dart', 'Rotate around centre: click the dart');
  unlocked(app, d.pieceId);
  const t = await pickSewPos(app, 'Rotate around centre: click the target position on the sew line', d.pieceId);
  const c = await must(app, { kind: 'point', prompt: 'Rotate around centre: click the offset centre', overlay: a => marker(a, t.w) }, 'point');
  const r = await rememberedDialog('dart.rotateCenter', { title: 'Rotate around offset centre', fields: [
    { kind: 'number', key: 'pct', label: 'Amount moved to the target', value: 50, min: 0.0001, max: 100, suffix: '%' },
  ] });
  if (!r) return;
  const id = ops.rotateDart(app.doc, { pieceId: d.pieceId, dartId: d.id, target: t.pos, center: toLocal(t.piece, c.w), pct: r.pct as number });
  selectLive(app, { kind: 'dart', pieceId: d.pieceId, id });
}

async function pasteDartFlow(app: App) {
  if (!dartClip) throw new Error('Copy a dart first (Dart ▸ Copy dart)');
  const t = await pickSewPos(app, 'Paste dart: click the centre position on a sew line (any piece)');
  unlocked(app, t.piece.id);
  const id = ops.pasteDart(app.doc, t.piece.id, dartClip, t.pos);
  selectLive(app, { kind: 'dart', pieceId: t.piece.id, id });
}

export function copyDartOf(app: App, ref: LiveRef) {
  dartClip = ops.copyDart(app.doc, ref.pieceId, ref.id);
  toast(`Dart copied (width ${fmt(dartClip.width)} ${unitLabel()})`, 'ok');
}

export async function removeDartFlow(app: App, ref: LiveRef, keepFullness?: boolean) {
  unlocked(app, ref.pieceId);
  let keep = keepFullness;
  if (keep === undefined) {
    const r = await showDialog({ title: 'Remove dart', fields: [{ kind: 'radio', key: 'm', label: 'Contour', value: 'restore', options: [{ value: 'restore', label: 'Restore (unsplit the legs / delete the Insert-Dart spread)' }, { value: 'keep', label: 'Keep fullness (the opening stays in the contour)' }] }] });
    if (!r) return;
    keep = r.m === 'keep';
  }
  ops.removeDart(app.doc, ref.pieceId, ref.id, { keepFullness: keep });
  app.liveSel = null;
}

async function insertDartFlow(app: App) {
  const s = await pickSewPos(app, 'Insert dart: click the SLASH point on the sew line');
  unlocked(app, s.piece.id);
  const h = await pick(app, { kind: 'contour', contour: 'sew', pieceId: s.piece.id, allowDone: true, prompt: 'Insert dart: click the PIVOT (hinge) on the sew line · Enter = automatic (opposite side)', overlay: a => marker(a, s.w) });
  if (h === null) throw new Cancelled();
  const hinge = h !== 'done' && h.kind === 'contour' ? contourPos(app, h.hit) : undefined;
  const r = await rememberedDialog('dart.insert', { title: 'Insert dart (slash & spread)', fields: [
    { kind: 'length', key: 'w', label: 'Width (spread)', value: 20, min: 0.01 },
    { kind: 'length', key: 'd', label: 'Depth', value: 100, min: 0.01 },
    { kind: 'radio', key: 'side', label: 'Moving side', value: 'forward', options: [{ value: 'forward', label: 'Forward (contour order)' }, { value: 'backward', label: 'Backward' }] },
    { kind: 'radio', key: 'fold', label: 'Fold toward', value: 'A', options: [{ value: 'A', label: 'Leg A' }, { value: 'B', label: 'Leg B' }] },
  ] });
  if (!r) return;
  const res = ops.insertDart(app.doc, s.piece.id, { at: s.pos, hinge, width: r.w as number, depth: r.d as number, side: r.side as 'forward', fold: r.fold as 'A' });
  selectLive(app, { kind: 'dart', pieceId: s.piece.id, id: res.dartId });
}

async function multiDartsFlow(app: App) {
  const run = await runOrPick(app, 'Multi darts: click the sew segment', 'sew');
  unlocked(app, run.pieceId);
  const r = await rememberedDialog('dart.multi', { title: 'Multi darts', fields: [
    { kind: 'number', key: 'n', label: 'Number of darts', value: 2, min: 1, max: 50 },
    { kind: 'length', key: 'w', label: 'Width (each)', value: 15, min: 0.01 },
    { kind: 'length', key: 'd', label: 'Depth', value: 80, min: 0.01 },
    { kind: 'radio', key: 'fold', label: 'Fold toward', value: 'A', options: [{ value: 'A', label: 'Leg A' }, { value: 'B', label: 'Leg B' }] },
  ] });
  if (!r) return;
  const ids = ops.createMultiDarts(app.doc, run.pieceId, run.from, { count: Math.round(r.n as number), width: r.w as number, depth: r.d as number, fold: r.fold as 'A' });
  toast(`${ids.length} darts created`, 'ok');
}

// ───────────────────────── pleats ─────────────────────────

export function pleatFields(a: PleatAttributes & { open?: boolean } = {}) {
  return [
    { kind: 'radio' as const, key: 'type', label: 'Type', value: a.type ?? 'knife', options: [{ value: 'knife', label: 'Knife (2 × depth)' }, { value: 'box', label: 'Box (4 × depth)' }] },
    { kind: 'length' as const, key: 'ds', label: 'Depth at start', value: a.depthStart ?? 20, min: 0 },
    { kind: 'length' as const, key: 'de', label: 'Depth at end', value: a.depthEnd ?? a.depthStart ?? 20, min: 0 },
    { kind: 'radio' as const, key: 'fold', label: 'Fold', value: a.fold ?? 'right', options: [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }] },
    { kind: 'checkbox' as const, key: 'notches', label: 'Auto notches', value: a.autoNotches ?? true },
    { kind: 'checkbox' as const, key: 'open', label: 'Open now', value: a.open ?? true },
  ];
}
export function pleatAttrsOf(r: Record<string, unknown>): PleatAttributes {
  return { type: r.type as 'box' | 'knife', depthStart: r.ds as number, depthEnd: r.de as number, fold: r.fold as 'left' | 'right', autoNotches: !!r.notches };
}

/** Axis from two clicks (world) → dialog → addPleat. */
export async function pleatFromAxis(app: App, piece: Piece, a: Vec, b: Vec, withDialog = true) {
  unlocked(app, piece.id);
  const A = toLocal(piece, a), B = toLocal(piece, b);
  if (!withDialog) {
    const id = ops.addPleatAxis(app.doc, piece.id, A, B);
    selectLive(app, { kind: 'pleat', pieceId: piece.id, id });
    toast('Pleat axis added — set its attributes in the Inspector, then Open', 'ok');
    return;
  }
  const r = await rememberedDialog('pleat.create', { title: 'Pleat', fields: pleatFields() });
  if (!r) return;
  const id = ops.addPleat(app.doc, { pieceId: piece.id, start: A, end: B, attrs: pleatAttrsOf(r), open: !!r.open });
  selectLive(app, { kind: 'pleat', pieceId: piece.id, id });
}

async function pleatAxisFlow(app: App, withDialog: boolean) {
  const a = await must(app, { kind: 'point', prompt: 'Pleat axis: click the START point (snaps)' }, 'point');
  const b = await must(app, { kind: 'point', prompt: 'Pleat axis: click the END point', overlay: (ap, hov) => hov ? `<path d="M${fs(ap.view.toScreen(a.w).x)} ${fs(ap.view.toScreen(a.w).y)}L${fs(ap.view.toScreen(hov).x)} ${fs(ap.view.toScreen(hov).y)}" stroke="#2e86c1" stroke-dasharray="8 3 2 3"/>` : '' }, 'point');
  const pc = contourNear(app, a.w, { contour: 'sew', tolPx: 12 })?.piece ?? contourNear(app, b.w, { contour: 'sew', tolPx: 12 })?.piece ?? app.primaryPiece();
  if (!pc) throw new Error('The axis must start or end on a piece');
  await pleatFromAxis(app, app.doc.piece(pc.id), a.w, b.w, withDialog);
}

async function pleatByAngleFlow(app: App) {
  const s = await pickSewPos(app, 'Pleat by angle: click the start position on the sew line');
  unlocked(app, s.piece.id);
  const r = await rememberedDialog('pleat.angle', { title: 'Add pleat by angle', fields: [{ kind: 'number', key: 'ang', label: 'Angle to the contour', value: 90, min: 1, max: 179, suffix: '°' }, ...pleatFields()] });
  if (!r) return;
  const id = app.doc.transact('Add pleat by angle', () => {
    const id = ops.addPleatByAngle(app.doc, s.piece.id, s.pos, r.ang as number, pleatAttrsOf(r));
    if (r.open && ((r.ds as number) > 0 || (r.de as number) > 0)) ops.openPleat(app.doc, s.piece.id, id);
    return id;
  });
  selectLive(app, { kind: 'pleat', pieceId: s.piece.id, id });
}

async function multiPleatFlow(app: App) {
  const run = await runOrPick(app, 'Multi pleat: click the sew segment', 'sew');
  unlocked(app, run.pieceId);
  const r = await rememberedDialog('pleat.multi', { title: 'Multi pleat', fields: [{ kind: 'number', key: 'n', label: 'Number of pleats', value: 3, min: 1, max: 50 }, ...pleatFields()] });
  if (!r) return;
  const ids = ops.addMultiPleat(app.doc, run.pieceId, run.from, Math.round(r.n as number), { ...pleatAttrsOf(r), open: !!r.open });
  toast(`${ids.length} pleats added`, 'ok');
}

// ───────────────────────── fullness ─────────────────────────

/** Slash point (contour pos) + pivot (contour pos or interior point, local) → dialog → addFullness. */
export async function fullnessDialogApply(app: App, piece: Piece, slash: LiveContourPos, pivot: LiveContourPos | Vec) {
  unlocked(app, piece.id);
  const onContour = 'fromAnchorId' in pivot;
  const r = await rememberedDialog('fullness.add', { title: 'Add fullness (slash & spread)', fields: [
    { kind: 'length', key: 'a', label: 'Opening at the slash', value: 30 },
    { kind: 'length', key: 'b', label: onContour ? 'Opening at the pivot (0 = hinge)' : 'Opening at the pivot (contour pivot only)', value: 0 },
    { kind: 'radio', key: 'mode', label: 'Mode', value: 'rotate', options: [{ value: 'rotate', label: 'Rotate' }, { value: 'parallel', label: 'Parallel (translate)' }] },
    { kind: 'radio', key: 'side', label: 'Moving side', value: 'forward', options: [{ value: 'forward', label: 'Forward (contour order)' }, { value: 'backward', label: 'Backward' }] },
  ] });
  if (!r) return;
  const id = ops.addFullness(app.doc, piece.id, { slash, pivot, openA: r.a as number, openB: onContour ? r.b as number : 0, mode: r.mode as 'rotate', side: r.side as 'forward' });
  selectLive(app, { kind: 'fullness', pieceId: piece.id, id });
}

async function addFullnessFlow(app: App) {
  const s = await pickSewPos(app, 'Fullness: click the SLASH point on the sew line');
  const pv = await must(app, { kind: 'point', prompt: 'Fullness: click the PIVOT (on the sew line = hinge, inside = rotation centre)', overlay: a => marker(a, s.w) }, 'point');
  const h = contourNear(app, pv.w, { contour: 'sew', pieceId: s.piece.id });
  await fullnessDialogApply(app, s.piece, s.pos, h ? contourPos(app, h) : toLocal(s.piece, pv.w));
}

async function multiFullnessFlow(app: App) {
  const a = await runOrPick(app, 'Multi fullness: click the SLASH segment (e.g. the hem)', 'sew');
  unlocked(app, a.pieceId);
  const b = await must(app, { kind: 'contour', contour: 'sew', pieceId: a.pieceId, prompt: 'Multi fullness: click the HINGE segment (e.g. the waist)' }, 'contour');
  if (!b.hit.from) throw new Error('That part of the line has no grade segment');
  const r = await rememberedDialog('fullness.multi', { title: 'Multi fullness', fields: [
    { kind: 'number', key: 'n', label: 'Number of slashes', value: 4, min: 1, max: 60 },
    { kind: 'length', key: 'w0', label: 'First width', value: 20 },
    { kind: 'length', key: 'w1', label: 'Last width', value: 20 },
    { kind: 'radio', key: 'mode', label: 'Mode', value: 'rotate', options: [{ value: 'rotate', label: 'Rotate (hinged)' }, { value: 'parallel', label: 'Parallel' }] },
    { kind: 'radio', key: 'side', label: 'Moving side', value: 'forward', options: [{ value: 'forward', label: 'Forward' }, { value: 'backward', label: 'Backward' }] },
  ] });
  if (!r) return;
  const id = ops.addMultiFullness(app.doc, a.pieceId, { slashSegment: a.from, hingeSegment: b.hit.from, count: Math.round(r.n as number), firstWidth: r.w0 as number, lastWidth: r.w1 as number, mode: r.mode as 'rotate', side: r.side as 'forward' });
  selectLive(app, { kind: 'fullness', pieceId: a.pieceId, id });
}

/** Delete key on a selected live object. */
export async function deleteLive(app: App, ref: LiveRef) {
  unlocked(app, ref.pieceId);
  if (ref.kind === 'dart') return removeDartFlow(app, ref);
  if (ref.kind === 'pleat') ops.deletePleat(app.doc, ref.pieceId, ref.id);
  else ops.deleteFullness(app.doc, ref.pieceId, ref.id);
  app.liveSel = null;
}

// ───────────────────────── registration ─────────────────────────

export function registerLive(app: App) {
  const M = 'Dart', MP = 'Dart/Pleat', MF = 'Dart/Fullness';
  const dart = (p: string) => liveOrPick(app, 'dart', p);
  const selKind = (k: LiveKind) => () => app.liveSel?.kind === k;
  const cmd = registerCommand;

  // create
  cmd({ id: 'dart.add', title: 'Add dart at point…', menu: M, group: 0, enabled: () => app.sel.anchors.length > 0, run: async () => {
    const pa = app.primaryAnchor()!;
    if (pa.contour !== pa.piece.sew) throw new Error('Select a point on the sew line');
    const r = resolveFor(app.doc, pa.piece, app.sizeOf(pa.piece)).sew;
    await createDartFlow(app, pa.piece.id, { anchorId: pa.anchor.id }, toWorld(pa.piece, r.anchorPos[pa.index]));
  } });
  cmd({ id: 'dart.multi', title: 'Multi darts…', menu: M, group: 0, run: () => multiDartsFlow(app) });
  cmd({ id: 'dart.insert', title: 'Insert dart (slash & spread)…', menu: M, group: 0, run: () => insertDartFlow(app) });
  // edit
  cmd({ id: 'dart.toggle', title: 'Close / reopen dart', menu: M, group: 1, hotkey: 'Ctrl+Alt+D', run: async () => {
    const d = await dart('Click the dart to close / reopen');
    unlocked(app, d.pieceId);
    ops.toggleDartClosed(app.doc, { pieceId: d.pieceId, dartId: d.id });
    const closed = app.doc.piece(d.pieceId).darts.find(x => x.id === d.id)?.closed;
    app.status(closed ? 'Dart closed' : 'Dart reopened');
  } });
  cmd({ id: 'dart.reopenWidth', title: 'Reopen dart at width…', menu: M, group: 1, run: async () => {
    const d = await dart('Click the closed dart');
    const dm = app.doc.piece(d.pieceId).darts.find(x => x.id === d.id)!;
    if (!dm.closed) throw new Error('The dart is open (close it first)');
    const r = await showDialog({ title: 'Reopen dart', fields: [{ kind: 'length', key: 'w', label: 'Width', value: dm.rememberedWidth ?? 20, min: 0.01 }] });
    if (r) ops.toggleDartClosed(app.doc, { pieceId: d.pieceId, dartId: d.id, width: r.w as number });
  } });
  cmd({ id: 'dart.fix', title: 'Fix dart (equal legs)', noop: 'Fix dart: nothing to fix (the legs are already equal)', menu: M, group: 1, run: async () => { const d = await dart('Click the dart to fix'); unlocked(app, d.pieceId); const k = ops.fixDart(app.doc, d.pieceId, d.id); app.status(`Fix dart: legs slid ${fmt(k)} ${unitLabel()}`); } });
  cmd({ id: 'dart.cutting', title: 'Cutting dart on / off', menu: M, group: 1, run: async () => {
    const d = await dart('Click the dart');
    const dm = app.doc.piece(d.pieceId).darts.find(x => x.id === d.id)!;
    ops.setDartCutting(app.doc, d.pieceId, d.id, !dm.cutting);
  } });
  cmd({ id: 'dart.change', title: 'Change darts (flip fold, all)', menu: M, group: 1, run: () => { const n = ops.changeDarts(app.doc); toast(`${n} dart fold(s) flipped`, 'ok'); } });
  cmd({ id: 'dart.closeAll', title: 'Close all darts of piece', menu: M, group: 1, enabled: () => !!app.primaryPiece()?.darts.length, run: () => ops.closeAllDarts(app.doc, unlocked(app, app.primaryPiece()!.id).id) });
  cmd({ id: 'dart.openAll', title: 'Reopen all darts of piece', menu: M, group: 1, enabled: () => !!app.primaryPiece()?.darts.length, run: () => ops.openAllDarts(app.doc, unlocked(app, app.primaryPiece()!.id).id) });
  cmd({ id: 'dart.cutAll', title: 'Cut all darts', menu: M, group: 1, run: async () => {
    const p = app.primaryPiece();
    const r = await showDialog({ title: 'Cut all darts', fields: [
      { kind: 'radio', key: 'scope', label: 'Pieces', value: p ? 'piece' : 'all', options: [...(p ? [{ value: 'piece', label: `This piece (${p.name})` }] : []), { value: 'all', label: 'All pieces' }] },
      { kind: 'radio', key: 'on', label: 'Darts', value: 'on', options: [{ value: 'on', label: 'Cutting (cut out)' }, { value: 'off', label: 'Folded (cap)' }] },
    ] });
    if (!r) return;
    const n = ops.cutAllDarts(app.doc, r.scope === 'piece' ? p!.id : undefined, r.on === 'on');
    toast(`${n} dart(s) updated`, 'ok');
  } });
  // move
  cmd({ id: 'dart.transfer', title: 'Pivot transfer…', menu: M, group: 2, hotkey: 'Shift+Alt+T', run: () => transferFlow(app) });
  cmd({ id: 'dart.rotateCenter', title: 'Rotate around offset centre…', menu: M, group: 2, run: () => rotateCenterFlow(app) });
  cmd({ id: 'dart.copy', title: 'Copy dart', menu: M, group: 3, run: async () => copyDartOf(app, await dart('Click the dart to copy')) });
  cmd({ id: 'dart.paste', title: 'Paste dart…', menu: M, group: 3, enabled: hasDartClip, run: () => pasteDartFlow(app) });
  cmd({ id: 'dart.remove', title: 'Remove dart…', menu: M, group: 3, run: async () => removeDartFlow(app, await dart('Click the dart to remove')) });

  // pleats
  cmd({ id: 'pleat.axis', title: 'Add pleat axis (attributes later)', menu: MP, group: 0, run: () => pleatAxisFlow(app, false) });
  cmd({ id: 'pleat.add', title: 'Add pleat…', menu: MP, group: 0, run: () => pleatAxisFlow(app, true) });
  cmd({ id: 'pleat.byAngle', title: 'Add pleat by angle…', menu: MP, group: 0, run: () => pleatByAngleFlow(app) });
  cmd({ id: 'pleat.multi', title: 'Multi pleat…', menu: MP, group: 0, run: () => multiPleatFlow(app) });
  cmd({ id: 'pleat.open', title: 'Open selected pleat', menu: MP, group: 1, run: async () => { const p = await liveOrPick(app, 'pleat', 'Click the pleat to open'); unlocked(app, p.pieceId); ops.openPleat(app.doc, p.pieceId, p.id); } });
  cmd({ id: 'pleat.close', title: 'Close selected pleat', menu: MP, group: 1, run: async () => { const p = await liveOrPick(app, 'pleat', 'Click the pleat to close'); unlocked(app, p.pieceId); ops.closePleat(app.doc, p.pieceId, p.id); } });
  cmd({ id: 'pleat.openAll', title: 'Open all pleats of piece', menu: MP, group: 1, enabled: () => !!app.primaryPiece()?.pleats.length, run: () => ops.openPleats(app.doc, unlocked(app, app.primaryPiece()!.id).id) });
  cmd({ id: 'pleat.closeAll', title: 'Close all pleats of piece', menu: MP, group: 1, enabled: () => !!app.primaryPiece()?.pleats.length, run: () => ops.closePleats(app.doc, unlocked(app, app.primaryPiece()!.id).id) });
  cmd({ id: 'pleat.delete', title: 'Delete pleat', menu: MP, group: 2, run: async () => { const p = await liveOrPick(app, 'pleat', 'Click the pleat to delete'); await deleteLive(app, p); } });

  // fullness
  cmd({ id: 'fullness.add', title: 'Add fullness…', menu: MF, group: 0, run: () => addFullnessFlow(app) });
  cmd({ id: 'fullness.multi', title: 'Multi fullness…', menu: MF, group: 0, run: () => multiFullnessFlow(app) });
  cmd({ id: 'fullness.delete', title: 'Delete fullness (exact restore)', menu: MF, group: 1, run: async () => { const f = await liveOrPick(app, 'fullness', 'Click a slash line of the fullness to delete'); await deleteLive(app, f); } });

  void selKind;
}
