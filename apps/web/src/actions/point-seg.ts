/**
 * Point and Segment menus (ops/points, ops/segments, ops/measure.segmentLengthSetTo).
 */
import type { SegmentClip, PasteMode, LengthSetMethod, Vec, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { registerCommand } from '../commands';
import { ops } from '../ops-bridge';
import { settings, saveSettings } from '../settings';
import { showDialog, rememberedDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { hasAnchor, hasPiece, onePiece, selPieces, pieceAnchors, must, needs } from './cmd-util';
import { runOrPick, anchorOrPick, internalOrPick, editSize, sizeNameOf } from '../selection';
import { LENGTH_METHODS } from './measure-cmds';
import { fmt, unitLabel } from '../units-ui';
import { resolveFor, toWorld, toLocal, contourById } from '../geometry';
import { runWorld, screenPath } from '../hitkit';
import { fs, screenMarker } from '../tools/common';

let segClip: SegmentClip | null = null;

function eachSel(app: App, label: string, fn: (pieceId: Id, anchorId: Id) => void) {
  app.doc.transact(label, () => { for (const r of app.sel.anchors) { if (app.doc.piece(r.pieceId).locked) continue; fn(r.pieceId, r.anchorId); } });
}

/** Rotate Segment preserving length: pick the run, pick the pivot end, then drag/click the new direction. */
async function rotateSegmentTool(app: App) {
  const run = await runOrPick(app, 'Rotate segment: click the segment');
  const piece = app.doc.piece(run.pieceId);
  const c = contourById(piece, run.contourId)!;
  const r = resolveFor(app.doc, piece, app.doc.baseSize(piece));
  const rc = c === piece.sew ? r.sew : r.internals[piece.internals.indexOf(c)];
  const posOf = (id: Id) => toWorld(piece, rc.anchorPos[c.points.findIndex(a => a.id === id)]);
  const A = posOf(run.from), B = posOf(run.to);
  const pv = await must(app, { kind: 'anchor', prompt: 'Rotate segment: click the PIVOT end (it stays fixed)', pieceId: piece.id, contourId: c.id }, 'anchor');
  const pivot: 'from' | 'to' = pv.hit.anchor.id === run.to ? 'to' : pv.hit.anchor.id === run.from ? 'from' : (() => { throw new Error('Click one of the two ends of the segment'); })();
  const P = pivot === 'from' ? A : B, M = pivot === 'from' ? B : A;
  const a0 = Math.atan2(M.y - P.y, M.x - P.x);
  const poly = runWorld(app, piece, c, run.from, run.to);
  const tgt = await must(app, { kind: 'point', prompt: 'Rotate segment: click the new direction (length is preserved) · Esc cancel', overlay: (a, hov) => {
    if (!hov) return '';
    const d = Math.atan2(hov.y - P.y, hov.x - P.x) - a0;
    const rot = (q: Vec) => ({ x: P.x + (q.x - P.x) * Math.cos(d) - (q.y - P.y) * Math.sin(d), y: P.y + (q.x - P.x) * Math.sin(d) + (q.y - P.y) * Math.cos(d) });
    const sp = a.view.toScreen(P);
    return `<path d="${screenPath(a, poly.map(rot))}" fill="none" stroke="#d6309b" stroke-width="2"/>` + screenMarker(sp, 'square', '#d6309b', 5) +
      `<text x="${fs(sp.x + 10)}" y="${fs(sp.y - 10)}" class="tool-note">${(d * 180 / Math.PI).toFixed(2)}°</text>`;
  } }, 'point');
  let deg = (Math.atan2(tgt.w.y - P.y, tgt.w.x - P.x) - a0) * 180 / Math.PI;
  deg = ((deg + 540) % 360) - 180;
  const rr = await showDialog({ title: 'Rotate segment', fields: [{ kind: 'number', key: 'a', label: 'Angle (CCW)', value: Math.round(deg * 100) / 100, suffix: '°' }] });
  if (rr) ops.rotateSegmentPreservingLength(app.doc, run.pieceId, run.from, run.to, pivot, rr.a as number);
}

export function registerPointSeg(app: App) {
  // ───────────── Point ─────────────
  registerCommand({ id: 'point.toggleSmooth', title: 'Corner ⇄ smooth', menu: 'Point', group: 0, hotkey: 'Alt+C', enabled: hasAnchor, run: () => eachSel(app, 'Corner/smooth', (p, a) => { const q = app.doc.findAnchor(app.doc.piece(p), a)!; ops.setSmooth(app.doc, p, a, !q.anchor.smooth); }) });
  registerCommand({ id: 'point.toggleKind', title: 'Grade ⇄ curve point', menu: 'Point', group: 0, hotkey: 'Alt+G', enabled: hasAnchor, run: () => eachSel(app, 'Point kind', (p, a) => { ops.togglePointKind(app.doc, p, a); }) });
  registerCommand({ id: 'point.breakHandle', title: 'Break handles', menu: 'Point', group: 0, enabled: hasAnchor, run: () => eachSel(app, 'Break handles', (p, a) => ops.breakHandle(app.doc, p, a)) });
  registerCommand({ id: 'point.joinHandle', title: 'Join handles', menu: 'Point', group: 0, enabled: hasAnchor, run: () => eachSel(app, 'Join handles', (p, a) => ops.joinHandle(app.doc, p, a)) });
  registerCommand({ id: 'point.resetHandles', title: 'Reset handles (auto)', menu: 'Point', group: 0, enabled: hasAnchor, run: () => app.doc.transact('Reset handles', () => { for (const r of app.sel.anchors) { const q = app.resolveRef(r); if (q) { const a = app.doc.findAnchor(app.doc.piece(r.pieceId), r.anchorId)!.anchor; delete a.hIn; delete a.hOut; } } }) });
  registerCommand({ id: 'point.lock', title: 'Lock / unlock point', menu: 'Point', group: 0, enabled: hasAnchor, run: () => app.doc.transact('Lock point', () => { for (const r of app.sel.anchors) { const a = app.doc.findAnchor(app.doc.piece(r.pieceId), r.anchorId)!.anchor; a.flags.locked = !a.flags.locked || undefined; } }) });
  // curve points without own grading follow their neighbouring grade points in graded sizes; Pin keeps them
  const curveSel = needs((c: { app: App }) => c.app.sel.anchors.some(r => { const q = c.app.resolveRef(r); return !!q && q.anchor.kind === 'curve'; }), 'a selected curve point');
  const pinSel = (pin: boolean) => {
    const by = new Map<Id, Id[]>();
    for (const r of app.sel.anchors) { if (app.doc.piece(r.pieceId).locked) continue; const l = by.get(r.pieceId) ?? []; l.push(r.anchorId); by.set(r.pieceId, l); }
    let n = 0;
    app.doc.transact(pin ? 'Pin curve points' : 'Unpin curve points', () => { for (const [pid, ids] of by) n += ops.pinCurvePoints(app.doc, pid, ids, pin); });
    app.status(n ? `${n} curve point${n > 1 ? 's' : ''} ${pin ? 'pinned: own grading, they keep their position when a neighbour moves' : 'unpinned: they follow their neighbouring grade points again'}` : `Nothing to ${pin ? 'pin' : 'unpin'} (select curve points${pin ? ' that follow their neighbours' : ' that are pinned'})`);
  };
  registerCommand({ id: 'point.pin', title: 'Pin curve point (keep position)', menu: 'Point', group: 0, enabled: curveSel, run: () => pinSel(true) });
  registerCommand({ id: 'point.unpin', title: 'Unpin curve point (follow neighbours)', menu: 'Point', group: 0, enabled: curveSel, run: () => pinSel(false) });
  registerCommand({ id: 'point.startPoint', title: 'Set as start point (#1)', menu: 'Point', group: 0, enabled: hasAnchor, run: () => { const r = app.sel.anchors[app.sel.anchors.length - 1]; ops.setStartPoint(app.doc, r.pieceId, r.anchorId); } });

  registerCommand({ id: 'point.add', title: 'Add point…', menu: 'Point', group: 1, hotkey: 'Alt+A', run: async () => {
    const run = await runOrPick(app, 'Add point: click the segment');
    const r = await rememberedDialog('point.add', { title: 'Add point', fields: [
      { kind: 'radio', key: 'how', label: 'Position', value: 'prev', options: [{ value: 'prev', label: 'Distance from start' }, { value: 'next', label: 'Distance from end' }, { value: 'pct', label: 'Percent of segment' }] },
      { kind: 'length', key: 'd', label: 'Distance', value: 50, min: 0 },
      { kind: 'number', key: 'pct', label: 'Percent', value: 50, min: 0, max: 100, suffix: '%' },
      { kind: 'radio', key: 'kind', label: 'Kind', value: 'grade', options: [{ value: 'grade', label: 'Grade point' }, { value: 'curve', label: 'Curve point' }] },
      { kind: 'radio', key: 'grading', label: 'Grading', value: 'auto', options: [{ value: 'auto', label: 'Proportional' }, { value: 'zero', label: 'Zero' }] },
      { kind: 'text', key: '_name', label: 'Name', value: '' },
    ] });
    if (!r) return;
    const id = ops.addPointOnSegment(app.doc, run.pieceId, run.from, r.how === 'pct' ? { pct: r.pct as number, kind: r.kind as 'grade', grading: r.grading as 'auto', name: String(r._name) || undefined } : { distance: r.d as number, from: r.how as 'prev' | 'next', kind: r.kind as 'grade', grading: r.grading as 'auto', name: String(r._name) || undefined });
    app.selectAnchor({ pieceId: run.pieceId, contourId: run.contourId, anchorId: id });
  } });
  registerCommand({ id: 'point.insertMid', title: 'Insert point after (mid-span)', menu: 'Point', group: 1, hotkey: 'Alt+I', enabled: hasAnchor, run: () => {
    const pa = app.primaryAnchor()!; const n = pa.contour.points.length;
    if (!pa.contour.closed && pa.index === n - 1) throw new Error('Last point of an open line has no following span');
    const next = pa.contour.points[(pa.index + 1) % n];
    const [id] = ops.addSplineSupportPoints(app.doc, pa.piece.id, pa.anchor.id, next.id, 1);
    if (id) app.selectAnchor({ pieceId: pa.piece.id, contourId: pa.contour.id, anchorId: id });
  } });
  registerCommand({ id: 'point.addAt', title: 'Add point at click', menu: 'Point', group: 1, hotkey: 'Shift+Alt+A', run: async () => {
    const r = await must(app, { kind: 'contour', prompt: 'Click on a line to insert a point (Ctrl = curve point)' }, 'contour');
    const id = ops.addPointAt(app.doc, r.hit.piece.id, r.hit.contour.id, toLocal(r.hit.piece, r.w), r.e.ctrlKey ? 'curve' : 'grade');
    app.selectAnchor({ pieceId: r.hit.piece.id, contourId: r.hit.contour.id, anchorId: id });
  } });
  registerCommand({ id: 'point.moveXY', title: 'Move point XY…', menu: 'Point', group: 2, hotkey: 'Alt+M', run: async () => {
    const ref = await anchorOrPick(app, 'Click the point to move');
    const q = app.resolveRef(ref)!; const sid = editSize(app, q.piece);
    const pos = ops.pointPos(app.doc, ref, sid ?? app.doc.baseSize(q.piece));
    const r = await rememberedDialog('point.moveXY', { title: `Move point${sid ? ` — size ${sizeNameOf(app, sid)} (grading only)` : ''}`, fields: [
      { kind: 'radio', key: 'how', label: 'Mode', value: 'delta', options: [{ value: 'delta', label: 'Delta dX / dY' }, { value: 'abs', label: 'Absolute X / Y' }] },
      { kind: 'length', key: '_dx', label: 'dX / X', value: 0 },
      { kind: 'length', key: '_dy', label: 'dY / Y', value: 0, hint: `Current X ${fmt(pos.x)}  Y ${fmt(pos.y)} ${unitLabel()} (piece frame)` },
    ] });
    if (!r) return;
    const m = r.how === 'abs' ? { x: r._dx as number, y: r._dy as number } : { dx: r._dx as number, dy: r._dy as number };
    app.doc.transact('Move point', () => { for (const a of app.sel.anchors.length ? app.sel.anchors : [ref]) ops.movePoint(app.doc, a.pieceId, a.anchorId, m, { sizeId: sid }); });
  } });
  registerCommand({ id: 'point.moveAlong', title: 'Move along contour…', menu: 'Point', group: 2, run: async () => {
    const ref = await anchorOrPick(app, 'Click the point to slide');
    const r = await rememberedDialog('point.moveAlong', { title: 'Move along contour', fields: [{ kind: 'length', key: 'd', label: 'Distance (+ = contour direction)', value: 10 }] });
    if (r) ops.moveAlongContour(app.doc, ref.pieceId, ref.anchorId, r.d as number);
  } });
  registerCommand({ id: 'point.moveProportional', title: 'Move proportional (blend)…', menu: 'Point', group: 2, run: async () => {
    const ref = await anchorOrPick(app, 'Click the point to move');
    const q = app.resolveRef(ref)!;
    const r = await rememberedDialog('point.moveProp', { title: 'Move proportional', message: 'Curve points between the neighbouring grade points blend with the move.', fields: [{ kind: 'length', key: 'dx', label: 'dX', value: 0 }, { kind: 'length', key: 'dy', label: 'dY', value: 0 }] });
    if (r) ops.moveProportional(app.doc, ref.pieceId, ref.anchorId, { x: r.dx as number, y: r.dy as number }, { sizeId: editSize(app, q.piece) });
  } });
  registerCommand({ id: 'point.multiMove', title: 'Multi move…', menu: 'Point', group: 2, enabled: hasAnchor, run: async () => {
    const r = await rememberedDialog('point.multiMove', { title: `Multi move — ${app.sel.anchors.length} point(s)`, fields: [{ kind: 'length', key: 'dx', label: 'dX', value: 0 }, { kind: 'length', key: 'dy', label: 'dY', value: 0 }] });
    const pc = app.primaryPiece();
    if (r) ops.multiMove(app.doc, app.sel.anchors.map(a => ({ pieceId: a.pieceId, anchorId: a.anchorId })), { x: r.dx as number, y: r.dy as number }, { sizeId: pc ? editSize(app, pc) : undefined });
  } });
  const align = (id: string, title: string, mode: 'H' | 'V' | 'angle', hotkey?: string) => registerCommand({ id, title, menu: 'Point', group: 3, hotkey, enabled: c => c.app.sel.anchors.length > 1, run: async () => {
    const { piece, ids } = pieceAnchors(app);
    let m: 'H' | 'V' | { angleDeg: number } = mode === 'angle' ? { angleDeg: 0 } : mode;
    if (mode === 'angle') { const r = await rememberedDialog('point.alignAngle', { title: 'Align at angle', fields: [{ kind: 'number', key: 'a', label: 'Line angle', value: 45, suffix: '°' }] }); if (!r) return; m = { angleDeg: r.a as number }; }
    ops.alignPoints(app.doc, piece.id, ids, m, { refId: ids[0], sizeId: editSize(app, piece) });
  } });
  align('point.alignH', 'Align horizontally (same Y as first)', 'H', 'Shift+Alt+H');
  align('point.alignV', 'Align vertically (same X as first)', 'V', 'Shift+Alt+V');
  align('point.alignAngle', 'Align at angle…', 'angle');
  registerCommand({ id: 'point.setAngle', title: 'Set corner angle…', menu: 'Point', group: 3, run: async () => {
    const ref = await anchorOrPick(app, 'Click a corner (grade point)', { gradeOnly: true });
    const q = app.resolveRef(ref)!; const sid = editSize(app, q.piece);
    const cur = ops.cornerAngle(app.doc, ref.pieceId, ref.anchorId, sid);
    const r = await showDialog({ title: 'Set angle', message: `Current interior angle ${cur.toFixed(3)}° — the NEXT segment rotates about the point.`, fields: [{ kind: 'number', key: 'a', label: 'Interior angle', value: Math.round(cur * 1000) / 1000, min: 0.01, max: 359.99, suffix: '°' }] });
    if (r) ops.setAngle(app.doc, ref.pieceId, ref.anchorId, r.a as number, { sizeId: sid });
  } });
  registerCommand({ id: 'point.round', title: 'Round corner…', menu: 'Point', group: 3, run: async () => {
    const ref = await anchorOrPick(app, 'Click a corner to round', { gradeOnly: true });
    const r = await rememberedDialog('point.round', { title: 'Round corner', fields: [{ kind: 'length', key: 'r', label: 'Radius', value: settings.roundRadiusMm, min: 0.01 }] });
    if (r) ops.roundCorner(app.doc, ref.pieceId, ref.anchorId, r.r as number);
  } });
  registerCommand({ id: 'point.splineSupport', title: 'Add spline support points…', menu: 'Point', group: 4, run: async () => {
    const run = await runOrPick(app, 'Click the run (or select two points)');
    const r = await rememberedDialog('point.spline', { title: 'Spline support points', fields: [{ kind: 'number', key: 'n', label: 'Count', value: 3, min: 1, max: 100 }] });
    if (r) ops.addSplineSupportPoints(app.doc, run.pieceId, run.from, run.to, Math.round(r.n as number));
  } });
  registerCommand({ id: 'point.cleanup', title: 'Points cleanup…', menu: 'Point', group: 4, enabled: hasPiece, run: async () => {
    const r = await rememberedDialog('point.cleanup', { title: 'Points cleanup', fields: [{ kind: 'length', key: 'tol', label: 'Tolerance', value: 0.05, min: 0.0001 }, { kind: 'checkbox', key: 'grade', label: 'Include grade points', value: false }] });
    if (!r) return;
    let k = 0; app.doc.transact('Points cleanup', () => selPieces(app).forEach(p => { k += ops.pointsCleanup(app.doc, p.id, { tol: r.tol as number, includeGrade: !!r.grade }); }));
    toast(`${k} point(s) removed`, 'ok');
  } });
  registerCommand({ id: 'point.delete', title: 'Delete point(s)', menu: 'Point', group: 5, enabled: hasAnchor, run: () => { const refs = app.sel.anchors.slice(); app.doc.transact('Delete point', () => refs.forEach(r => ops.deletePoint(app.doc, r.pieceId, r.anchorId))); app.sel.anchors = []; } });

  // ───────────── Segment ─────────────
  registerCommand({ id: 'seg.length', title: 'Segment length (set exact)…', menu: 'Segment', group: 0, hotkey: 'Alt+L', run: async () => {
    const run = await runOrPick(app, 'Click the segment to lengthen / shorten');
    const pc = app.doc.piece(run.pieceId); const sid = editSize(app, pc);
    const cur = ops.measureSegment(app.doc, run.pieceId, run.contourId, run.from, run.to, sid);
    const r = await rememberedDialog('seg.length', { title: 'Segment length', message: `Current: ${fmt(cur)} ${unitLabel()}${sid ? ` (size ${sizeNameOf(app, sid)} — grading only)` : ' (all sizes)'}`, fields: [
      { kind: 'length', key: '_L', label: 'New length', value: cur, min: 0.01 },
      { kind: 'select', key: 'm', label: 'Method', value: 'moveEnd', options: LENGTH_METHODS },
    ] });
    if (!r) return;
    const res = ops.segmentLengthSetTo(app.doc, run.pieceId, run.contourId, run.from, run.to, r._L as number, r.m as LengthSetMethod, sid);
    if (!res.converged) toast(`Could not reach the target (best ${fmt(res.length)})`, 'warn'); else app.status(`Segment = ${fmt(res.length)} ${unitLabel()}`);
  } });
  registerCommand({ id: 'seg.copy', title: 'Copy segment', menu: 'Segment', group: 1, hotkey: 'Ctrl+Alt+Shift+C', run: async () => { const run = await runOrPick(app, 'Click the segment to copy'); segClip = ops.copySegment(app.doc, run.pieceId, run.from, run.to); toast(`Segment copied (${fmt(segClip.length)} ${unitLabel()})`, 'ok'); } });
  registerCommand({ id: 'seg.paste', title: 'Paste segment…', menu: 'Segment', group: 1, hotkey: 'Ctrl+Alt+Shift+V', enabled: () => !!segClip, run: async () => {
    const run = await runOrPick(app, 'Click the target segment');
    const r = await rememberedDialog('seg.paste', { title: 'Paste segment', fields: [
      { kind: 'select', key: 'm', label: 'Mode', value: 'proportional-to-external', options: [{ value: 'proportional-to-external', label: 'Proportional (keep depth)' }, { value: 'proportional-to-internal', label: 'Proportional (uniform scale)' }, { value: 'exact', label: 'Exact (moves the end point)' }] },
      { kind: 'checkbox', key: 'flip', label: 'Flip to the other side', value: false },
    ] });
    if (r) ops.pasteSegment(app.doc, run.pieceId, run.from, run.to, segClip!, r.m as PasteMode, { flip: !!r.flip });
  } });
  registerCommand({ id: 'seg.rotate', title: 'Rotate segment (keep length)', menu: 'Segment', group: 1, hotkey: 'Alt+O', run: () => rotateSegmentTool(app) });
  registerCommand({ id: 'seg.swap', title: 'Swap internal ⇄ perimeter', menu: 'Segment', group: 2, run: async () => { const { piece, contour } = await internalOrPick(app, 'Click the internal style line'); ops.swapSegment(app.doc, piece.id, contour.id); } });
  registerCommand({ id: 'seg.divide', title: 'Divide internal at point', menu: 'Segment', group: 2, run: async () => {
    const ref = await anchorOrPick(app, 'Click the point of an internal line to divide at', { contour: 'internal' });
    ops.divideContour(app.doc, ref.pieceId, ref.contourId, ref.anchorId);
  } });
  registerCommand({ id: 'seg.join', title: 'Join two internals', menu: 'Segment', group: 2, run: async () => {
    const a = await must(app, { kind: 'contour', prompt: 'Join: click the first internal line', contour: 'internal' }, 'contour');
    const b = await must(app, { kind: 'contour', prompt: 'Join: click the second internal line (shares an end point)', contour: 'internal', pieceId: a.hit.piece.id }, 'contour');
    ops.joinContours(app.doc, a.hit.piece.id, a.hit.contour.id, b.hit.contour.id);
  } });
  registerCommand({ id: 'seg.dashed', title: 'Contour → dashed / solid', menu: 'Segment', group: 2, run: async () => { const { piece, contour } = await internalOrPick(app); ops.contourToDashedLines(app.doc, piece.id, contour.id, contour.style !== 'dashed'); } });
  registerCommand({ id: 'seg.trim', title: 'Trim at intersections', menu: 'Segment', group: 3, run: async () => {
    const r = await must(app, { kind: 'contour', prompt: 'Trim: click the PART of the internal line to keep', contour: 'internal' }, 'contour');
    ops.trimAtIntersections(app.doc, r.hit.piece.id, r.hit.contour.id, { keep: r.hit.local });
  } });
  registerCommand({ id: 'seg.globalTrim', title: 'Global check & trim internals', menu: 'Segment', group: 3, run: () => { const k = ops.globalCheckAndTrimInternals(app.doc, app.sel.pieces.length ? app.sel.pieces : undefined); toast(`${k} internal(s) trimmed`, 'ok'); } });
  registerCommand({ id: 'seg.globalJoin', title: 'Global join internals', menu: 'Segment', group: 3, run: () => { const k = ops.globalJoinInternals(app.doc, app.sel.pieces.length ? app.sel.pieces : undefined); toast(`${k} join(s)`, 'ok'); } });
  registerCommand({ id: 'seg.extend', title: 'Extend contour / internal…', menu: 'Segment', group: 3, run: async () => {
    const e = await must(app, { kind: 'anchor', prompt: 'Extend: click the END point of an open line' }, 'anchor');
    const c = e.hit.contour; if (c.closed) throw new Error('Closed contours have no ends');
    const end = e.hit.index === 0 ? 'start' : e.hit.index === c.points.length - 1 ? 'end' : null;
    if (!end) throw new Error('Click the first or last point');
    const r = await rememberedDialog('seg.extend', { title: 'Extend', fields: [
      { kind: 'radio', key: 'how', label: 'How', value: 'by', options: [{ value: 'by', label: 'By a distance (− shortens)' }, { value: 'upTo', label: 'Up to a line (click next)' }] },
      { kind: 'length', key: 'by', label: 'Distance', value: 10 },
    ] });
    if (!r) return;
    let how: { by: number } | { upTo: Id } = { by: r.by as number };
    if (r.how === 'upTo') { const t = await must(app, { kind: 'contour', prompt: 'Extend up to: click the target line', pieceId: e.hit.piece.id }, 'contour'); how = { upTo: t.hit.contour.id }; }
    const L = c === e.hit.piece.sew ? ops.extendContour(app.doc, e.hit.piece.id, c.id, end, how) : ops.extendInternal(app.doc, e.hit.piece.id, c.id, end, how);
    app.status(`New length ${fmt(L)} ${unitLabel()}`);
  } });
  registerCommand({ id: 'seg.smooth', title: 'Smooth tool', menu: 'Segment', group: 4, run: () => app.setTool('smooth') });
  void onePiece;
}
