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
import { h, clear } from '../ui/dom';
import { runOrPick, anchorOrPick, internalOrPick, pieceOrPick, Cancelled } from '../selection';
import { hasPiece, hasAnchor, onePiece, selPieces, must, pickPointLocal } from './cmd-util';
import { seamDialog } from '../tools/seam';
import { openNotchGrid } from '../panels/notchgrid';
import { duplicateDrillDialog, notchType, notchOn, setNotchOn, NOTCH_ON } from '../tools/marks';
import { pick } from '../tools/pick';
import { runWorld, screenPath } from '../hitkit';
import { toWorld, toLocal, resolveFor } from '../geometry';
import { pickFiles } from './file';
import { fmt, unitLabel, parseLen } from '../units-ui';
import { TURNBACK_MAX_FOLDS } from '@prowdcad/kernel';
import { screenMarker } from '../tools/common';

/** The corner types of the corner box. `hint` says what the type is for. */
const CORNERS: { spec: CornerSpec | 'manual'; label: string; hint: string }[] = [
  { spec: { type: 'miter' }, label: 'Miter', hint: 'The two cut lines run on until they meet. The usual corner.' },
  { spec: { type: 'truncated' }, label: 'Mitered at distance', hint: 'The miter, cut off square at a set distance from the sew corner. For sharp points (collar tips, lapels).' },
  { spec: { type: 'angled' }, label: 'Angled (bevel)', hint: 'Straight across from one cut line to the other.' },
  { spec: { type: 'boxed', extend: 'both' }, label: 'Boxed (both)', hint: 'Each allowance runs past the corner and ends square. Pressed-open seams.' },
  { spec: { type: 'boxed', extend: 'prev' }, label: 'Boxed (extend prev)', hint: 'The line before the corner runs straight on, then squares across.' },
  { spec: { type: 'boxed', extend: 'next' }, label: 'Boxed (extend next)', hint: 'The line after the corner is extended back, then squares across.' },
  { spec: { type: 'turnback', extend: 'prev' }, label: 'Turn-back (line before)', hint: 'The line before the corner is a hem that folds back: its end mirrors the seam after the corner.' },
  { spec: { type: 'turnback', extend: 'next' }, label: 'Turn-back (line after)', hint: 'The line after the corner is a hem that folds back: its end mirrors the seam before the corner.' },
  { spec: { type: 'cutout' }, label: 'Cut-out', hint: 'The allowance is cut away square to the sew corner: each seam ends at the corner.' },
  { spec: 'manual', label: 'Manual (2 clicks)…', hint: 'Draw the corner yourself with two clicks near the cut lines.' },
];
const sameCorner = (cur: CornerSpec | undefined, it: CornerSpec | 'manual'): boolean => {
  if (it === 'manual') return cur?.type === 'manual';
  if (!cur) return it.type === 'miter';
  if (cur.type !== it.type) return false;
  if (it.type === 'boxed') return (cur.extend ?? 'both') === it.extend;
  if (it.type === 'turnback') return cur.extend === it.extend || (!cur.extend && it.extend === 'next');
  return true;
};
/** Picture of a corner type, drawn from the real geometry of this corner (its angle and its two allowances). */
function cornerPicture(spec: CornerSpec | undefined, f: { angleDeg: number; dPrev: number; dNext: number }, manual: boolean, px = 62): string {
  const dP = Math.abs(f.dPrev) > 1e-6 ? Math.abs(f.dPrev) : 0, dN = Math.abs(f.dNext) > 1e-6 ? Math.abs(f.dNext) : 0;
  const m = Math.max(dP, dN) || 10;
  let g: { sew: Vec[]; cut: Vec[]; corner: Vec[] };
  try { g = ops.cornerPreview(manual ? { type: 'angled' } : spec, f.angleDeg, dP || (dN ? 0 : m), dN || (dP ? 0 : m)); } catch { return ''; }
  // window around the corner, a little towards the piece; y is up in the drawing
  const R = 1.95 * Math.max(m, spec?.type === 'truncated' && spec.dist ? spec.dist * 0.9 : 0);
  const th = Math.max(25, Math.min(165, f.angleDeg)) * Math.PI / 360;
  const cx = -Math.cos(th) * R * 0.3, cy = Math.sin(th) * R * 0.3;
  const d = (pts: Vec[], closed: boolean) => pts.map((q, i) => `${i ? 'L' : 'M'}${(q.x - cx).toFixed(2)} ${(-(q.y - cy)).toFixed(2)}`).join('') + (closed ? 'Z' : '');
  const sw = R / 30;
  const corner = g.corner.length > 1 ? `<path d="${d(g.corner, false)}" fill="none" stroke="#ff8a1f" stroke-width="${(sw * 2.4).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round"/>`
    : g.corner.length ? `<circle cx="${(g.corner[0].x - cx).toFixed(2)}" cy="${(-(g.corner[0].y - cy)).toFixed(2)}" r="${(sw * 2.2).toFixed(3)}" fill="#ff8a1f"/>` : '';
  const dots = manual ? g.corner.map(q => `<circle cx="${(q.x - cx).toFixed(2)}" cy="${(-(q.y - cy)).toFixed(2)}" r="${(sw * 2.6).toFixed(3)}" fill="#fff" stroke="#ff8a1f" stroke-width="${sw.toFixed(3)}"/>`).join('') : '';
  return `<svg class="cg-pic" viewBox="${-R} ${-R} ${2 * R} ${2 * R}" width="${px}" height="${px}">`
    + `<path d="${d(g.cut, true)}" fill="#f2c94c" fill-opacity="0.55" stroke="none"/>`
    + `<path d="${d(g.sew, true)}" fill="#4ea1ff" fill-opacity="1" stroke="none" class="cg-body"/>`
    + `<path d="${d(g.cut, true)}" fill="none" stroke="currentColor" stroke-width="${sw.toFixed(3)}" stroke-linejoin="round" opacity="0.9"/>`
    + `<path d="${d(g.sew, true)}" fill="none" stroke="#1456b8" stroke-width="${(sw * 1.3).toFixed(3)}" stroke-linejoin="round"/>`
    + corner + dots + '</svg>';
}

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

/** corner notch sides: the previous line continued past the corner, the next line extended back, both, none */
const CORNER_SIDES = [{ value: 'none', label: 'None' }, { value: 'prev', label: 'One side (line before, continued)' }, { value: 'next', label: 'Other side (line after, extended back)' }, { value: 'both', label: 'Both sides' }];

/**
 * The corner box: the corner types as pictures of THIS corner (its real angle and allowances), the two seam
 * values, the distance of a mitered-at-distance corner and the notches on the corner. It stays open while you
 * try things; every change is one undo step. With several corners selected, the type is set on all of them.
 */
export async function cornerGallery(app: App, ref?: AnchorRef, at?: { x: number; y: number }) {
  const c = ref ?? await sewCorner(app);
  const pieceId = c.pieceId;
  // every selected grade corner of the sew line of this piece takes the change, when the clicked one is among them
  const targets = (): Id[] => {
    const p = app.doc.piece(pieceId);
    const sel = app.sel.anchors.filter(a => a.pieceId === pieceId && a.contourId === p.sew.id && p.sew.points.find(q => q.id === a.anchorId)?.kind === 'grade').map(a => a.anchorId);
    return sel.includes(c.anchorId) && sel.length > 1 ? sel : [c.anchorId];
  };
  const body = h('div.cornerbox');
  let close = () => {};
  const safe = (fn: () => void) => { try { fn(); } catch (err) { toast((err as Error).message, 'error'); } app.invalidate(); draw(); };
  const lenInput = (value: number, title: string, onSet: (v: number) => void, attrs: Record<string, string> = {}) => {
    const el = h('input.cb-num', { type: 'text', value: fmt(value), title, spellcheck: 'false', ...attrs }) as HTMLInputElement;
    const commit = () => { let v: number; try { v = parseLen(el.value); } catch { el.value = fmt(value); return; } if (!Number.isFinite(v) || v < 0) { el.value = fmt(value); return; } if (Math.abs(v - value) > 1e-9) onSet(v); };
    el.addEventListener('change', commit);
    el.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    return el;
  };
  function draw() {
    const piece = app.doc.piece(pieceId), line = app.doc.sizeLine(piece);
    if (!piece.sew.points.some(a => a.id === c.anchorId)) { close(); return; }
    let f: ReturnType<typeof ops.cornerFacts>;
    try { f = ops.cornerFacts(piece, line, line.baseSizeId, c.anchorId); } catch (err) { clear(body); body.append(h('div.cb-note', {}, (err as Error).message)); return; }
    const cur = piece.sew.points.find(a => a.id === c.anchorId)?.corner;
    const ids = targets();
    clear(body);
    body.append(h('div.pop-title', {}, `Corner — ${piece.name}${ids.length > 1 ? ` · ${ids.length} corners` : ''}`,
      h('span.cb-angle', { title: 'Inside angle of the corner on the base size' }, `${f.angleDeg.toFixed(1)}°`)));
    // the two seam values that meet here
    body.append(h('div.cb-row', {},
      h('label', {}, 'Seam before', lenInput(f.dPrev, 'Seam allowance of the line before the corner', v => safe(() => ops.setSeam(app.doc, pieceId, f.prevId, c.anchorId, v)), { 'data-cb': 'before' })),
      h('label', {}, 'Seam after', lenInput(f.dNext, 'Seam allowance of the line after the corner', v => safe(() => ops.setSeam(app.doc, pieceId, c.anchorId, f.nextId, v)), { 'data-cb': 'after' })),
      h('span.cb-unit', {}, unitLabel())));
    if (!f.convex) body.append(h('div.cb-note', {}, 'This is an inside corner: the two cut lines cross, so every type gives the same corner here.'));
    else if (Math.abs(f.dPrev) < 1e-9 && Math.abs(f.dNext) < 1e-9) body.append(h('div.cb-note', {}, 'Both lines have no seam allowance here: give them a value to see the corner types.'));
    const grid = h('div.corner-gallery');
    for (const it of CORNERS) {
      const on = sameCorner(cur, it.spec);
      const spec: CornerSpec | undefined = it.spec === 'manual' ? undefined : it.spec.type === 'miter' ? undefined
        : { ...it.spec, ...(it.spec.type === 'truncated' && cur?.type === 'truncated' && cur.dist ? { dist: cur.dist } : {}), ...(it.spec.type === 'turnback' && cur?.type === 'turnback' && on && cur.folds ? { folds: cur.folds } : {}) };
      const b = h('button.cg-item' + (on ? '.on' : ''), { title: `${it.label}\n${it.hint}`, 'data-corner': it.spec === 'manual' ? 'manual' : it.spec.type + (it.spec.extend ? '-' + it.spec.extend : '') });
      b.innerHTML = cornerPicture(spec, f, it.spec === 'manual');
      b.append(h('span', {}, it.label));
      b.onclick = () => {
        if (it.spec === 'manual') { close(); void trimCornerFlow(app, c).catch(err => { if (!(err instanceof Cancelled)) toast((err as Error).message, 'error'); }); return; }
        safe(() => app.doc.transact('Seam corner', () => { for (const id of targets()) ops.setCorner(app.doc, pieceId, id, spec); }));
        app.status(`Corner: ${it.label}${ids.length > 1 ? ` on ${ids.length} corners` : ''} · ${it.hint}`);
      };
      grid.append(b);
    }
    body.append(grid);
    // mitered at distance: its distance
    if (cur?.type === 'truncated') {
      const dflt = Math.max(Math.abs(f.dPrev), Math.abs(f.dNext));
      body.append(h('div.cb-row', {}, h('label', {}, 'Mitered distance', lenInput(cur.dist ?? dflt, 'How far from the sew corner the miter is cut off',
        v => safe(() => app.doc.transact('Mitered distance', () => { for (const id of targets()) { const q = app.doc.piece(pieceId).sew.points.find(a => a.id === id)?.corner; if (q?.type === 'truncated') ops.setCorner(app.doc, pieceId, id, { ...q, dist: v > 0 ? v : undefined }); } })), { 'data-cb': 'dist' })),
        h('span.cb-unit', {}, `${unitLabel()} from the sew corner`)));
    }
    if (cur?.type === 'turnback' && (cur.folds?.length ?? 0) > 1) body.append(h('div.cb-note', {}, `Turn-back with ${cur.folds!.length} folds: ${cur.folds!.map(w => fmt(w)).join(' + ')} ${unitLabel()} (Seam ▸ Turn-back hem changes them)`));
    // notch on the corner: one side, the other side, both or none (kept with any corner type)
    const side = ops.cornerNotchSide(piece, c.anchorId);
    const nrow = h('div.cg-notch', {}, h('span.cg-notch-t', {}, 'Notch on the corner'));
    for (const it of [{ v: 'none', l: 'None' }, { v: 'prev', l: 'One side' }, { v: 'next', l: 'Other side' }, { v: 'both', l: 'Both sides' }] as const) {
      nrow.append(h('button.btn.sm' + (side === it.v ? '.on' : ''), { 'data-corner-notch': it.v, title: CORNER_SIDES.find(o => o.value === it.v)!.label, onclick: () => {
        safe(() => app.doc.transact(it.v === 'none' ? 'Remove corner notch' : 'Corner notch', () => { for (const id of targets()) ops.setCornerNotches(app.doc, app.doc.piece(pieceId), id, it.v, { contourId: piece.sew.id, type: notchType, on: notchOn }); }));
        app.status(it.v === 'none' ? 'Corner notch removed' : `Corner notch: ${it.l.toLowerCase()}`);
      } }, it.l));
    }
    body.append(nrow);
    body.append(h('div.btnrow', {},
      h('button.btn.sm', { 'data-cb': 'revert', title: 'Back to the plain miter', onclick: () => safe(() => app.doc.transact('Revert corner', () => { for (const id of targets()) ops.revertCorner(app.doc, pieceId, id); })) }, 'Revert to miter'),
      h('button.btn.sm.primary', { 'data-cb': 'close', onclick: () => close() }, 'Done')));
    // the box may have grown: keep it on the screen
    const el = body.parentElement;
    if (el) { const r = el.getBoundingClientRect(); if (r.bottom > window.innerHeight - 4) el.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px'; if (r.right > window.innerWidth - 4) el.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px'; }
  }
  draw();
  const pos = at ?? (() => {
    const q = app.resolveRef(c); const r = q ? resolveFor(app.doc, q.piece, app.sizeOf(q.piece)) : null;
    const w = q && r ? toWorld(q.piece, r.sew.anchorPos[q.index]) : { x: 0, y: 0 };
    const s = app.view.toScreen(w); const box = document.querySelector('#canvas svg.sheet')?.getBoundingClientRect();
    return { x: (box?.left ?? 0) + s.x + 16, y: (box?.top ?? 0) + s.y + 16 };
  })();
  close = popover(pos.x, pos.y, body);
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
  // Turn-back hem: the allowance of a line is made of folds, each with its own value; the edge mirrors the adjacent seams at every fold
  registerCommand({ id: 'seam.turnback', title: 'Turn-back hem (folds)…', menu: 'Seam', group: 0, run: async () => {
    const run = await runOrPick(app, 'Turn-back: click the hem line (a sew-line segment)', 'sew');
    const p = app.doc.piece(run.pieceId);
    const cur = ops.turnbackOf(p, run.from);
    const seam = p.sew.points.find(a => a.id === run.from)?.seamAfter ?? p.seamDefault;
    const parse = (t: string): number[] => String(t).split(/[,;+]/).map(x => x.trim()).filter(Boolean).map(x => parseLen(x));
    const r = await showDialog({
      title: `Turn-back hem — ${p.name}`,
      message: `Type the width of every fold, from the sew line outwards, separated by commas (${unitLabel()}).\nOne value = a single turn-back. Two or more = a hem turned in several times, each fold with its own value.\nThe seam allowance of the line becomes their sum, and the ends mirror the seams next to it at every fold.\nLeave it empty to remove the turn-back.`,
      fields: [{ kind: 'text', key: 'folds', label: 'Fold values', value: (cur.length ? cur : seam > 0 ? [seam] : []).map(w => fmt(w)).join(', '), placeholder: 'e.g. 30, 10' }],
      validate: v => {
        let w: number[]; try { w = parse(String(v.folds)); } catch { return 'Type numbers separated by commas, e.g. 30, 10'; }
        if (w.some(x => !Number.isFinite(x) || x <= 0)) return 'Every value must be a number above 0';
        if (w.length > TURNBACK_MAX_FOLDS) return `At most ${TURNBACK_MAX_FOLDS} folds`;
        return null;
      },
    });
    if (!r) return;
    const w = parse(String(r.folds));
    ops.setTurnback(app.doc, run.pieceId, run.from, run.to, w);
    app.status(w.length ? `Turn-back: ${w.length} fold${w.length > 1 ? 's' : ''} (${w.map(x => fmt(x)).join(' + ')}) = ${fmt(w.reduce((a, b) => a + b, 0))} ${unitLabel()} seam` : 'Turn-back removed (the seam value stays)');
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
    const cur = ops.cornerNotchSide(app.doc.piece(c.pieceId), c.anchorId);
    const r = await rememberedDialog('notch.corner', { title: 'Corner notch', fields: [
      { kind: 'radio', key: 'dir', label: 'Side', value: cur === 'none' ? 'prev' : cur, options: CORNER_SIDES.filter(o => o.value !== 'none') },
      { kind: 'select', key: 'type', label: 'Type', value: notchType, options: (['slit', 'T', 'V', 'U', 'castle'] as NotchType[]).map(t => ({ value: t, label: t })) },
      { kind: 'radio', key: 'on', label: 'Mark on', value: notchOn, options: NOTCH_ON },
    ] });
    if (r) { setNotchOn(r.on as typeof notchOn); ops.setCornerNotches(app.doc, app.doc.piece(c.pieceId), c.anchorId, r.dir as 'prev' | 'next' | 'both', { contourId: c.contourId, type: r.type as NotchType, on: notchOn }); }
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
