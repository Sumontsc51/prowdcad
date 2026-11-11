/**
 * Selection + Move commands: AccuMark-named entries for the Move tools (Point ▸ Modify Points,
 * Segment ▸ Modify Line, Piece ▸ Modify Piece), the selection filter, Select all by filter, and
 * Edit ▸ Preferences (incl. the opt-in "Allow drag-move in Select").
 */
import type { App, SelItem } from '../app';
import { registerCommand } from '../commands';
import { settings, saveSettings, type SelFilter } from '../settings';
import { showDialog } from '../ui/dialog';
import { FILTERS } from '../selpick';
import { setSelFilter } from '../tools/select';
import { flipPieces, type MPMode } from '../tools/move';
import { resolveFor } from '../geometry';
import { segmentIds } from '../hitkit';
import { notchesFor } from '../canvas/render';

export function registerMoveCmds(app: App) {
  // ───── Point ▸ Modify Points (one entry per Move Point mode) ─────
  const mp = (id: string, title: string, mode: MPMode, hotkey?: string) => registerCommand({
    id, title, menu: 'Point/Modify Points', hotkey, checked: () => app.tool?.id === 'movePoint' && settings.movePointMode === mode,
    run: () => { settings.movePointMode = mode; saveSettings(); app.setTool('movePoint'); },
  });
  mp('move.single', 'Move Single Point', 'single');
  mp('move.smooth', 'Move Smooth', 'smooth');
  mp('move.h', 'Move Point Horizontal', 'h');
  mp('move.v', 'Move Point Vertical', 'v');
  mp('move.along', 'Move Point Along Line / Slide', 'along');
  mp('move.group', 'Move Points (group, same delta)', 'group');

  // ───── Segment ▸ Modify Line ─────
  registerCommand({ id: 'move.line', title: 'Move Line', menu: 'Segment/Modify Line', checked: () => app.tool?.id === 'moveLine' && settings.moveLineMode === 'translate', run: () => { settings.moveLineMode = 'translate'; saveSettings(); app.setTool('moveLine'); } });
  registerCommand({ id: 'move.lineParallel', title: 'Move Parallel / Offset', menu: 'Segment/Modify Line', checked: () => app.tool?.id === 'moveLine' && settings.moveLineMode === 'parallel', run: () => { settings.moveLineMode = 'parallel'; saveSettings(); app.setTool('moveLine'); } });
  registerCommand({ id: 'move.curve', title: 'Curve / Handle tool', menu: 'Segment/Modify Line', checked: () => app.tool?.id === 'curve', run: () => app.setTool('curve') });

  // ───── Piece ▸ Modify Piece ─────
  const pm = (id: string, title: string, mode: 'move' | 'rotate' | 'flip') => registerCommand({
    id, title, menu: 'Piece/Modify Piece', checked: () => app.tool?.id === 'movePiece' && settings.pieceToolMode === mode,
    run: () => { settings.pieceToolMode = mode; saveSettings(); app.setTool('movePiece'); },
  });
  pm('move.piece', 'Move Piece', 'move');
  pm('move.pieceRotate', 'Rotate Piece', 'rotate');
  pm('move.pieceFlip', 'Flip Piece (tool)', 'flip');
  const selPieceIds = () => app.sel.pieces.filter(id => !app.hasSubSelection(id) || app.sel.pieces.length === 1);
  registerCommand({ id: 'piece.flipH', title: 'Flip selected left ⇄ right', menu: 'Piece/Modify Piece', group: 1, enabled: () => app.sel.pieces.length > 0, run: () => flipPieces(app, selPieceIds(), 'h') });
  registerCommand({ id: 'piece.flipV', title: 'Flip selected up ⇄ down', menu: 'Piece/Modify Piece', group: 1, enabled: () => app.sel.pieces.length > 0, run: () => flipPieces(app, selPieceIds(), 'v') });

  // ───── Edit: selection ─────
  for (const f of FILTERS) registerCommand({ id: 'sel.filter.' + f.id, title: `${f.label}`, menu: 'Edit/Selection filter', checked: () => settings.selFilter === f.id, run: () => setSelFilter(app, f.id as SelFilter) });
  registerCommand({ id: 'edit.selectDragMove', title: 'Allow dragging points in Select (moves only the point you grab)', menu: 'Edit', group: 4, checked: () => settings.selectDragMove, run: () => { settings.selectDragMove = !settings.selectDragMove; saveSettings(); app.status(`Dragging points in Select ${settings.selectDragMove ? 'ON: a drag on a point or handle moves only that' : 'OFF: Select moves whole pieces only'}`); } });
  registerCommand({ id: 'edit.prefs', title: 'Preferences…', menu: 'Edit', group: 4, run: async () => {
    const r = await showDialog({ title: 'Preferences', fields: [
      { kind: 'checkbox', key: 'dm', label: 'Allow dragging points in Select (moves only the point you grab)', value: settings.selectDragMove, hint: 'Off (default): in Select a drag on a piece moves the whole piece; points and lines move only with the Move tools (G, Shift+G).' },
      { kind: 'number', key: 'pr', label: 'Pick radius', value: settings.pickRadiusPx, min: 4, max: 20, suffix: 'px' },
      { kind: 'length', key: 'nu', label: 'Arrow-key nudge step (Move tools; Shift = ×10)', value: settings.nudgeMm, min: 0.001 },
      { kind: 'checkbox', key: 'al', label: 'Internal line: lock ends drawn on the outline to their segment', value: settings.autoLockInternal, hint: 'On (default): like CLO / AccuMark attach, an end on the outline keeps its proportional position when the segment changes. Right-click the line ▸ Unlock to free it.' },
    ] });
    if (!r) return;
    settings.selectDragMove = !!r.dm; settings.pickRadiusPx = Math.round(r.pr as number); settings.nudgeMm = r.nu as number; settings.autoLockInternal = !!r.al; saveSettings(); app.invalidate();
  } });
}

/** Ctrl+A-style select all of the current filter's kind (all pieces for All / Pieces). */
export function selectAllByFilter(app: App) {
  const f = settings.selFilter;
  const items: SelItem[] = [];
  for (const p of app.doc.style.pieces) {
    if (app.hiddenPieces.has(p.id)) continue;
    const r = resolveFor(app.doc, p, app.sizeOf(p));
    if (f === 'all' || f === 'pieces') items.push({ k: 'piece', pieceId: p.id });
    if (f === 'points') for (const c of [p.sew, ...p.internals]) for (const a of c.points) items.push({ k: 'point', ref: { pieceId: p.id, contourId: c.id, anchorId: a.id } });
    if (f === 'lines') for (let k = 0; k < r.sew.gradeIdx.length; k++) { const ids = segmentIds(p.sew, r.sew, k); if (ids.from && ids.to) items.push({ k: 'segment', seg: { pieceId: p.id, contourId: p.sew.id, from: ids.from, to: ids.to } }); }
    if (f === 'internals') for (const c of p.internals) if (c.type !== 'dartAxis' && c.type !== 'pleatAxis') items.push({ k: 'internal', c: { pieceId: p.id, contourId: c.id } });
    if (f === 'marks') {
      for (const n of notchesFor(app, p, app.sizeOf(p))) items.push({ k: 'notch', n: { pieceId: p.id, notchId: n.notchId } });
      for (const d of p.drills) items.push({ k: 'mark', m: { pieceId: p.id, kind: 'drill', id: d.id } });
      for (const t of p.texts) items.push({ k: 'mark', m: { pieceId: p.id, kind: 'text', id: t.id } });
    }
  }
  app.clearSelection();
  for (const it of items) app.applySel(it, 'add');
  app.status(`${items.length} selected (${FILTERS.find(x => x.id === f)?.label})`);
}
