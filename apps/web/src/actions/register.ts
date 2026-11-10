/**
 * All built-in commands. Menus, hotkeys and context menus come from here. Commands backed by
 * kernel ops that have not landed yet call ops-bridge placeholders (→ "not wired yet" toast).
 */
import { registerCommand, type CommandCtx, hotkeyMap, allCommands, normalizeChord, getCommand } from '../commands';
import type { App } from '../app';
import type { Canvas } from '../canvas/canvas';
import { settings, saveSettings } from '../settings';
import { newStyle, openFile, saveFile, importFile, exportDXF, exportSVGFile, exportPDFFile, exportPLT, exportStandalone, attachPreview, mergeFromFile } from './file';
import { registerSeamNotch } from './seam-notch';
import { registerMeasure } from './measure-cmds';
import { registerPointSeg } from './point-seg';
import { registerLockCmds } from './lock-cmds';
import { registerCutPiece } from './cut-piece';
import { registerGrade } from './grade-cmds';
import { registerLive, deleteLive } from './live-cmds';
import { registerMoveCmds, selectAllByFilter } from './move-cmds';
import { needs } from './cmd-util';
import { ops, opStatus, type SegmentRef, type AnchorRef } from '../ops-bridge';
import { showDialog, alertDialog, confirmDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { nudge } from '../tools/select';
import { setNotchType, notchType, setDrillDiameter, drillDiameter } from '../tools/marks';
import { contourById, layoutOf, deepClone, resolveFor, pieceWorldBox } from '../geometry';
import { newId, makeAnchor, incrementalToAbsolute, absoluteToIncremental, bezierPoint, spanLength, gradeSegment, totalLength, area, perimeter, type NotchType, type Piece, type GradeInc, type SizeId, type Anchor } from '@prowdcad/kernel';
import { fmt, unitLabel } from '../units-ui';

export function registerAll(app: App, canvas: Canvas, rebuildUi: () => void) {
  const hasPiece = (c: CommandCtx) => c.app.sel.pieces.length > 0;
  const hasAnchor = needs((c: CommandCtx) => c.app.sel.anchors.length > 0, 'a selected point');
  const tx = (label: string, fn: () => void) => app.doc.transact(label, fn);
  const selPieces = () => app.sel.pieces.map(id => app.doc.piece(id));
  const segRef = (): SegmentRef => {
    const a = app.primaryAnchor();
    if (!a) throw new Error('Select a grade point: the segment starts there');
    if (a.anchor.kind !== 'grade') throw new Error('Select a GRADE point (segment start)');
    return { pieceId: a.piece.id, contourId: a.contour.id, startAnchorId: a.anchor.id };
  };
  const onePiece = (): Piece => { const p = app.primaryPiece(); if (!p) throw new Error('Select a piece'); return app.doc.piece(p.id); };

  // ───────────── tools (hotkeys) ─────────────
  for (const t of app.tools) registerCommand({ id: 'tool.' + t.id, title: `Tool: ${t.title}`, hotkey: t.hotkey, run: () => app.setTool(t.id) });

  // ───────────── File ─────────────
  registerCommand({ id: 'file.new', title: 'New…', menu: 'File', group: 0, hotkey: 'Ctrl+Alt+N', run: () => newStyle(app) });
  registerCommand({ id: 'file.open', title: 'Open…', menu: 'File', group: 0, hotkey: 'Ctrl+O', run: () => openFile(app) });
  registerCommand({ id: 'file.save', title: 'Save', menu: 'File', group: 1, hotkey: 'Ctrl+S', run: () => saveFile(app, false) });
  registerCommand({ id: 'file.saveAs', title: 'Save As…', menu: 'File', group: 1, hotkey: 'Ctrl+Shift+S', run: () => saveFile(app, true) });
  registerCommand({ id: 'file.import', title: 'Import (DXF + RUL / SVG / PLT)…', menu: 'File', group: 2, hotkey: 'Ctrl+Alt+I,Ctrl+Shift+I', run: () => importFile(app) });
  registerCommand({ id: 'file.merge', title: 'Merge from another style…', menu: 'File', group: 2, run: () => mergeFromFile(app) });
  registerCommand({ id: 'file.export.dxf', title: 'DXF (AAMA / ASTM) + RUL…', menu: 'File/Export', hotkey: 'Ctrl+Shift+E', run: () => exportDXF(app) });
  registerCommand({ id: 'file.export.svg', title: 'SVG…', menu: 'File/Export', run: () => exportSVGFile(app) });
  registerCommand({ id: 'file.export.pdf', title: 'PDF (tiled 1:1)…', menu: 'File/Export', hotkey: 'Ctrl+P', run: () => exportPDFFile(app) });
  registerCommand({ id: 'file.export.plt', title: 'PLT (HPGL)…', menu: 'File/Export', run: () => exportPLT(app) });
  registerCommand({ id: 'file.export.standalone', title: 'Size as standalone style…', menu: 'File/Export', run: () => exportStandalone(app) });
  registerCommand({ id: 'file.preview', title: 'Attach preview thumbnail', menu: 'File', group: 3, run: () => attachPreview(app) });
  registerCommand({ id: 'file.styleInfo', title: 'Style properties…', menu: 'File', group: 3, run: async () => {
    const s = app.style;
    const r = await showDialog({ title: 'Style properties', fields: [
      { kind: 'text', key: 'name', label: 'Style name', value: s.name },
      { kind: 'text', key: 'customer', label: 'Customer', value: s.meta.customer ?? '' },
      { kind: 'text', key: 'season', label: 'Season', value: s.meta.season ?? '' },
      { kind: 'textarea', key: 'notes', label: 'Special instructions', value: s.meta.specialInstructions ?? '', rows: 4 },
    ] });
    if (r) tx('Style properties', () => { s.name = String(r.name).trim() || s.name; s.meta.customer = String(r.customer) || undefined; s.meta.season = String(r.season) || undefined; s.meta.specialInstructions = String(r.notes) || undefined; });
  } });

  // ───────────── Edit ─────────────
  registerCommand({ id: 'edit.undo', title: 'Undo', menu: 'Edit', group: 0, hotkey: 'Ctrl+Z', enabled: c => c.app.doc.canUndo(),
    hint: undefined, run: () => { const l = app.doc.undoLabel(); if (app.doc.undo()) app.status(`Undo: ${l}`); } });
  registerCommand({ id: 'edit.redo', title: 'Redo', menu: 'Edit', group: 0, hotkey: 'Ctrl+Y,Ctrl+Shift+Z', enabled: c => c.app.doc.canRedo(),
    run: () => { const l = app.doc.redoLabel(); if (app.doc.redo()) app.status(`Redo: ${l}`); } });
  registerCommand({ id: 'edit.delete', title: 'Delete', menu: 'Edit', group: 1, hotkey: 'Delete,Backspace', enabled: c => hasPiece(c) || hasAnchor(c) || !!c.app.currentLive() || c.app.hasSubSelection(), run: () => deleteSelection(app) });
  registerCommand({ id: 'edit.duplicate', title: 'Duplicate piece', menu: 'Edit', group: 1, hotkey: 'Ctrl+D', enabled: hasPiece, run: () => {
    const ids: string[] = [];
    tx('Duplicate piece', () => {
      for (const p of selPieces()) {
        const c = remapIds(deepClone(p));
        c.name = p.name + ' COPY';
        const L = layoutOf(p); const b = pieceWorldBox(app.doc, p, app.sizeOf(p));
        c.layout = { x: L.x + (b.maxX - b.minX) + 30, y: L.y, angleDeg: L.angleDeg };
        app.style.pieces.push(c); ids.push(c.id);
      }
    });
    app.sel = { pieces: ids, anchors: [] };
  } });
  registerCommand({ id: 'edit.selectAll', title: 'Select all (current filter; All = pieces)', menu: 'Edit', group: 2, hotkey: 'Ctrl+A', run: () => selectAllByFilter(app) });
  registerCommand({ id: 'edit.selectAllPoints', title: 'Select all points of piece', menu: 'Edit', group: 2, hotkey: 'Ctrl+Shift+A', enabled: hasPiece, run: () => {
    const p = onePiece();
    app.sel = { pieces: [p.id], anchors: [p.sew, ...p.internals].flatMap(c => c.points.map(a => ({ pieceId: p.id, contourId: c.id, anchorId: a.id }))) };
  } });
  registerCommand({ id: 'edit.deselect', title: 'Deselect all', menu: 'Edit', group: 2, hotkey: 'Escape', run: () => { app.clearSelection(); } });
  // arrow keys nudge only while a Move tool is active (acting on the selection); Select never moves geometry
  const nudgeCmd = (id: string, title: string, key: string, dx: number, dy: number, mult: number) =>
    registerCommand({ id, title, hotkey: key, run: () => nudge(app, dx * settings.nudgeMm * mult, dy * settings.nudgeMm * mult) });
  nudgeCmd('edit.nudgeL', 'Nudge left', 'ArrowLeft', -1, 0, 1); nudgeCmd('edit.nudgeR', 'Nudge right', 'ArrowRight', 1, 0, 1);
  nudgeCmd('edit.nudgeU', 'Nudge up', 'ArrowUp', 0, 1, 1); nudgeCmd('edit.nudgeD', 'Nudge down', 'ArrowDown', 0, -1, 1);
  nudgeCmd('edit.nudgeL10', 'Nudge left ×10', 'Shift+ArrowLeft', -1, 0, 10); nudgeCmd('edit.nudgeR10', 'Nudge right ×10', 'Shift+ArrowRight', 1, 0, 10);
  nudgeCmd('edit.nudgeU10', 'Nudge up ×10', 'Shift+ArrowUp', 0, 1, 10); nudgeCmd('edit.nudgeD10', 'Nudge down ×10', 'Shift+ArrowDown', 0, -1, 10);
  registerCommand({ id: 'edit.nudgeStep', title: 'Nudge step…', menu: 'Edit', group: 3, run: async () => {
    const r = await showDialog({ title: 'Nudge step', fields: [{ kind: 'length', key: 'v', label: 'Arrow-key step (Shift = ×10)', value: settings.nudgeMm, min: 0.001 }] });
    if (r) { settings.nudgeMm = r.v as number; saveSettings(); }
  } });
  registerCommand({ id: 'edit.hotkeys', title: 'Keyboard shortcuts…', menu: 'Edit', group: 4, run: () => editHotkeys(rebuildUi) });
  registerCommand({ id: 'edit.keysAccuMark', title: 'AccuMark keys', menu: 'Edit/Keyboard preset', checked: () => currentKeyPreset() === 'accumark', run: () => applyKeyPreset('accumark', rebuildUi) });
  registerCommand({ id: 'edit.keysDefault', title: 'ProwdCAD (default)', menu: 'Edit/Keyboard preset', checked: () => currentKeyPreset() === 'prowdcad', run: () => applyKeyPreset('prowdcad', rebuildUi) });
  registerCommand({ id: 'edit.toolbar', title: 'Customize toolbar…', menu: 'Edit', group: 4, run: () => customizeToolbar(app, rebuildUi) });

  registerSeamNotch(app);
  registerMeasure(app);
  registerPointSeg(app);
  registerLockCmds(app);
  registerMoveCmds(app);
  registerCutPiece(app);
  registerGrade(app);

  // ───────────── Dart (darts / pleats / fullness) ─────────────
  registerLive(app);

  // ───────────── View ─────────────
  registerCommand({ id: 'view.fit', title: 'Zoom to fit', menu: 'View', group: 0, hotkey: 'Ctrl+0,F', run: () => canvas.zoomFit() });
  registerCommand({ id: 'view.fitSel', title: 'Zoom to selection', menu: 'View', group: 0, hotkey: 'Shift+F', enabled: hasPiece, run: () => canvas.zoomFit(app.sel.pieces) });
  registerCommand({ id: 'view.zoomIn', title: 'Zoom in', menu: 'View', group: 0, hotkey: 'Ctrl+=,Ctrl++,+,=', run: () => canvas.zoomBy(1.25) });
  registerCommand({ id: 'view.zoomOut', title: 'Zoom out', menu: 'View', group: 0, hotkey: 'Ctrl+-,-', run: () => canvas.zoomBy(0.8) });
  registerCommand({ id: 'view.zoom100', title: 'Actual size (100%)', menu: 'View', group: 0, hotkey: 'Ctrl+Alt+0,Ctrl+1', run: () => canvas.zoom100() });
  const toggle = (id: string, title: string, key: keyof typeof settings, hotkey?: string, after?: () => void) =>
    registerCommand({ id, title, menu: 'View', group: 1, hotkey, checked: () => !!settings[key], run: () => { (settings as unknown as Record<string, boolean>)[key] = !settings[key]; saveSettings(); after?.(); } });
  toggle('view.grid', 'Grid', 'showGrid', "Ctrl+'");
  toggle('view.rulers', 'Rulers', 'showRulers', 'Ctrl+Alt+R', () => canvas.applyRulerVisibility());
  toggle('view.cut', 'Cut line', 'showCut');
  toggle('view.anchors', 'Points on unselected pieces', 'showAllAnchors');
  registerCommand({ id: 'view.snapPoints', title: 'Snap to points', menu: 'View/Snap', checked: () => settings.snapPoints, run: () => { settings.snapPoints = !settings.snapPoints; saveSettings(); } });
  registerCommand({ id: 'view.snapGuides', title: 'Snap to guides', menu: 'View/Snap', checked: () => settings.snapGuides, run: () => { settings.snapGuides = !settings.snapGuides; saveSettings(); } });
  registerCommand({ id: 'view.snapGrid', title: 'Snap to grid', menu: 'View/Snap', hotkey: 'Ctrl+Shift+\'', checked: () => settings.snapGrid, run: () => { settings.snapGrid = !settings.snapGrid; saveSettings(); } });
  registerCommand({ id: 'view.gridSize', title: 'Grid size…', menu: 'View/Snap', run: async () => {
    const r = await showDialog({ title: 'Grid', fields: [{ kind: 'length', key: 'g', label: 'Snap grid spacing', value: settings.gridMm, min: 0.01 }] });
    if (r) { settings.gridMm = r.g as number; saveSettings(); }
  } });
  registerCommand({ id: 'view.clearGuides', title: 'Clear guides', menu: 'View', group: 2, run: () => { settings.guides = []; saveSettings(); } });
  registerCommand({ id: 'view.addGuide', title: 'Add guide…', menu: 'View', group: 2, run: async () => {
    const r = await showDialog({ title: 'Add guide', fields: [{ kind: 'select', key: 'a', label: 'Orientation', value: 'x', options: [{ value: 'x', label: 'Vertical (at X)' }, { value: 'y', label: 'Horizontal (at Y)' }] }, { kind: 'length', key: 'p', label: 'Position', value: 0 }] });
    if (r) { settings.guides.push({ axis: r.a as 'x' | 'y', pos: r.p as number }); saveSettings(); }
  } });
  for (const [k, title, hk] of [['pieces', 'Pieces panel', 'Ctrl+Alt+1'], ['sizes', 'Sizes panel', 'Ctrl+Alt+2'], ['inspector', 'Inspector', 'Ctrl+Alt+3']] as const) {
    registerCommand({ id: 'view.panel.' + k, title, menu: 'View', group: 3, hotkey: hk, checked: () => settings.panels[k], run: () => { settings.panels[k] = !settings.panels[k]; saveSettings(); } });
  }
  for (const [u, den, title] of [['mm', 0, 'mm'], ['cm', 0, 'cm'], ['in', 0, 'inch (decimal)'], ['in', 8, 'inch 1/8'], ['in', 16, 'inch 1/16'], ['in', 32, 'inch 1/32']] as const) {
    registerCommand({ id: `view.unit.${u}${den || ''}`, title, menu: 'View/Units', checked: () => settings.unit === u && (u !== 'in' || settings.fracDen === den), run: () => app.setUnit(u, u === 'in' ? den : undefined) });
  }

  // ───────────── Help ─────────────
  registerCommand({ id: 'help.keys', title: 'Shortcuts', menu: 'Help', hotkey: 'F1', run: () => alertDialog('Keyboard shortcuts', allCommands().filter(c => hotkeyMap()[c.id]).map(c => `${hotkeyMap()[c.id].padEnd(22)} ${c.title}`).join('\n')) });
  registerCommand({ id: 'help.ops', title: 'Kernel ops status', menu: 'Help', run: () => alertDialog('Kernel ops (ops-bridge)', (() => { const st = opStatus(); const stub = st.filter(o => o.state === 'stub'); return `${st.length - stub.length} wired · ${stub.length} placeholder(s)\n\nPlaceholders:\n${stub.map(o => `  ${o.name}  (${o.module})`).join('\n') || '  none'}\n\nWired:\n${st.filter(o => o.state === 'wired').map(o => `  ${o.name}  (${o.module})`).join('\n')}`; })()) });
  registerCommand({ id: 'help.about', title: 'About ProwdCAD', menu: 'Help', run: () => alertDialog('ProwdCAD', 'ProwdCAD 2 — Design workspace (Vite + TypeScript, SVG).\nInternal units mm, y-up. Undo history: 200 steps. Auto-backup every 30 s.') });
}

// ───────────── helpers ─────────────

function eachAnchor(app: App, fn: (a: Anchor) => void) {
  for (const ref of app.sel.anchors) {
    const q = app.resolveRef(ref); if (!q || app.doc.piece(ref.pieceId).locked) continue;
    fn(q.anchor);
  }
}

function stepSize(app: App, d: number) {
  const ids = app.sizeLine().sizes.map(s => s.id);
  const i = ids.indexOf(app.activeSize);
  app.activeSize = ids[Math.max(0, Math.min(ids.length - 1, i + d))];
  app.status(`Size ${app.sizeLine().sizes.find(s => s.id === app.activeSize)?.name}`);
}

function mixGrade(app: App, cur: Record<SizeId, GradeInc>, src: Record<SizeId, GradeInc>, axis: 'x' | 'y'): Record<SizeId, GradeInc> {
  const line = app.sizeLine();
  const a = incrementalToAbsolute(cur ?? {}, line), b = incrementalToAbsolute(src, line);
  for (const s of line.sizes) { const x = a[s.id], y = b[s.id]; a[s.id] = axis === 'x' ? { dx: y.dx, dy: x.dy } : { dx: x.dx, dy: y.dy }; }
  return absoluteToIncremental(a, line);
}

/** Fresh ids for a duplicated piece (anchors, contours, live objects) with references remapped. */
function remapIds(p: Piece): Piece {
  const map = new Map<string, string>();
  const re = (old: string, prefix: string) => { const n = newId(prefix); map.set(old, n); return n; };
  p.id = re(p.id, 'pc');
  for (const c of [p.sew, ...p.internals, ...(p.manualCut ? [p.manualCut] : [])]) { c.id = re(c.id, 'c'); for (const a of c.points) a.id = re(a.id, 'p'); }
  const m = (id: string) => map.get(id) ?? id;
  // live objects: every anchor / contour id they reference is remapped (deep string replace over the record)
  const remapDeep = <T,>(o: T): T => JSON.parse(JSON.stringify(o), (_k, v) => (typeof v === 'string' && map.has(v) ? map.get(v) : v)) as T;
  const liveIds = new Map<string, string>();
  for (const d of p.darts) liveIds.set(d.id, newId('dt'));
  for (const pl of p.pleats) liveIds.set(pl.id, newId('pl'));
  for (const f of p.fullness ?? []) liveIds.set(f.id, newId('fu'));
  for (const id of [...(p.fullness ?? []).flatMap(f => f.slotIds ?? []), ...p.pleats.flatMap(pl => pl.slotIds ?? [])]) if (!map.has(id)) map.set(id, newId('p'));
  for (const [o, n] of liveIds) map.set(o, n);
  p.darts = remapDeep(p.darts);
  p.pleats = remapDeep(p.pleats);
  if (p.fullness) p.fullness = remapDeep(p.fullness);
  // pleat auto-notch ids are `${pleatId}:n<k>`
  for (const n of p.notches) if (n.source === 'pleat') { const [pl, k] = n.id.split(':'); if (liveIds.has(pl)) map.set(n.id, `${liveIds.get(pl)}:${k}`); }
  for (const pl of p.pleats) if (pl.notchIds) pl.notchIds = pl.notchIds.map(m);
  for (const n of p.notches) { n.id = n.source === 'pleat' && map.has(n.id) ? map.get(n.id)! : newId('n'); n.contourId = m(n.contourId); n.placement = { ...n.placement, anchorId: m(n.placement.anchorId) } as typeof n.placement; }
  for (const d of p.drills) d.id = newId('d');
  for (const t of p.texts) t.id = newId('t');
  for (const a of p.artwork) a.id = newId('aw');
  p.connections = p.connections.map(c => ({ internalContourId: m(c.internalContourId), internalAnchorId: m(c.internalAnchorId), externalAnchorId: m(c.externalAnchorId) }));
  p.createdAt = p.updatedAt = new Date().toISOString();
  return p;
}

/** Delete selected anchors (keeping contours valid) or else the selected pieces. */
async function deleteSelection(app: App) {
  { const l = app.currentLive(); if (l) { await deleteLive(app, l); return; } }
  if (app.sel.anchors.length) {
    const refs = app.sel.anchors.slice();
    let blocked = 0;
    app.doc.transact('Delete point', () => {
      for (const ref of refs) {
        const pc = app.doc.piece(ref.pieceId); if (pc.locked) { blocked++; continue; }
        const c = contourById(pc, ref.contourId); if (!c) continue;
        const i = c.points.findIndex(a => a.id === ref.anchorId); if (i < 0) continue;
        const a = c.points[i];
        if (a.flags.dartLeg || a.flags.pleatEdge) { blocked++; continue; }
        if (c === pc.sew) {
          if (c.points.length <= 3) { blocked++; continue; }
          c.points.splice(i, 1);
          pc.notches = pc.notches.filter(n => n.placement.anchorId !== a.id);
          if (a.flags.startPoint && c.points.length) c.points[0].flags.startPoint = true;
          if (!c.points.some(q => q.kind === 'grade')) c.points[0].kind = 'grade';
        } else {
          c.points.splice(i, 1);
          if (c.points.length < (c.closed ? 3 : 2)) pc.internals = pc.internals.filter(x => x !== c);
        }
        pc.connections = pc.connections.filter(x => x.internalAnchorId !== a.id && x.externalAnchorId !== a.id);
      }
    });
    app.sel.anchors = [];
    if (blocked) toast(`${blocked} point(s) kept (locked, live-object or minimum point count)`, 'warn');
    return;
  }
  const s = app.sel;
  if (s.notches.length || s.marks.length || s.internals.length) {
    const notches = s.notches.slice(), marks = s.marks.slice(), internals = s.internals.slice();
    app.doc.transact('Delete', () => {
      for (const n of notches) { const pc = app.doc.style.pieces.find(p => p.id === n.pieceId); if (pc && !pc.locked) pc.notches = pc.notches.filter(x => x.id !== n.notchId); }
      for (const m of marks) { const pc = app.doc.style.pieces.find(p => p.id === m.pieceId); if (!pc || pc.locked) continue; if (m.kind === 'drill') ops.deleteDrill(app.doc, pc, m.id); else ops.deleteText(app.doc, pc, m.id); }
      for (const c of internals) { const pc = app.doc.style.pieces.find(p => p.id === c.pieceId); if (pc && !pc.locked) { pc.internals = pc.internals.filter(x => x.id !== c.contourId); pc.connections = pc.connections.filter(x => x.internalContourId !== c.contourId); } }
    });
    app.status(`Deleted ${notches.length + marks.length + internals.length} object(s)`);
    return;
  }
  if (s.segments.length) { toast('A segment cannot be deleted on its own: select its points (or the piece) to delete', 'warn'); return; }
  if (!app.sel.pieces.length) return;
  if (!(await confirmDialog('Delete', `Delete ${app.sel.pieces.length} piece(s)?`, 'Delete'))) return;
  const ids = new Set(app.sel.pieces);
  app.doc.transact('Delete piece', s => { s.pieces = s.pieces.filter(p => !ids.has(p.id)); });
  app.sel = { pieces: [], anchors: [] };
}

/**
 * "AccuMark keys" preset (docs/UX-RESEARCH.md §1.5): the Gerber AccuMark function keys on top of the
 * ProwdCAD defaults. Keys AccuMark uses for something else move out of the way (Alt+S Seam →
 * Shift+Alt+S, Ctrl+D Duplicate → Ctrl+Shift+D). Alt+F4 / Ctrl+F4 / F11 cannot be captured by a page.
 */
export const ACCUMARK_KEYS: Record<string, string> = {
  'move.single': 'Alt+F12', 'move.smooth': 'Alt+F11', 'move.group': 'Alt+F2', 'point.alignH': 'Shift+Alt+H,Alt+F3', 'point.delete': 'Alt+F1',
  'move.line': 'Ctrl+F2', 'move.lineParallel': 'Ctrl+F11', 'seg.divide': 'Ctrl+F10', 'seg.swap': 'Alt+S', 'seam.segment': 'Shift+Alt+S',
  'move.piece': 'Shift+F2', 'move.pieceFlip': 'Shift+F9', 'move.pieceRotate': 'Shift+F10', 'tool.walk': 'W,Shift+W',
  'edit.selectAll': 'Ctrl+A', 'edit.deselect': 'Escape,Ctrl+D', 'edit.duplicate': 'Ctrl+Shift+D',
};
export const KEY_PRESETS: { id: string; label: string; map: Record<string, string> }[] = [
  { id: 'prowdcad', label: 'ProwdCAD (default)', map: {} },
  { id: 'accumark', label: 'AccuMark keys (Alt+F12 Move Single Point, Shift+F2 Move Piece, …)', map: ACCUMARK_KEYS },
];
/** Which preset the current overrides equal ('' = customised). */
export function currentKeyPreset(): string {
  const cur = JSON.stringify(Object.entries(settings.hotkeys).sort());
  for (const p of KEY_PRESETS) if (JSON.stringify(Object.entries(p.map).filter(([id]) => getCommand(id)).sort()) === cur) return p.id;
  return '';
}
export function applyKeyPreset(id: string, rebuildUi: () => void) {
  const p = KEY_PRESETS.find(x => x.id === id); if (!p) return;
  settings.hotkeys = Object.fromEntries(Object.entries(p.map).filter(([cid]) => getCommand(cid)));
  saveSettings(); rebuildUi();
  toast(`Keyboard preset: ${p.label.split(' (')[0]}`, 'ok');
}

async function editHotkeys(rebuildUi: () => void) {
  const json = JSON.stringify(hotkeyMap(), null, 2);
  const cur = currentKeyPreset();
  const r = await showDialog({
    title: 'Keyboard shortcuts', wide: true,
    message: 'Pick a preset, or edit the JSON map  command-id → chord. Several chords: "Ctrl+Y,Ctrl+Shift+Z". Empty string = unbound. Modifiers: Ctrl (= Cmd), Alt, Shift.',
    fields: [
      { kind: 'select', key: 'preset', label: 'Preset', value: cur || 'custom', options: [...KEY_PRESETS.map(p => ({ value: p.id, label: p.label })), ...(cur ? [] : [{ value: 'custom', label: 'Custom (your edits below)' }])],
        hint: 'Choosing a preset replaces your custom keys when you press OK. AccuMark keys: Alt+F12 Move Single Point · Alt+F11 Move Smooth · Alt+F2 Move Points · Alt+F3 Align · Alt+F1 Delete point · Ctrl+F2 Move Line · Ctrl+F11 Move Parallel · Ctrl+F10 Split · Alt+S Swap line · Shift+F2 Move Piece · Shift+F9 Flip · Shift+F10 Rotate · Shift+W Walk · Ctrl+D Clear selection.' },
      { kind: 'textarea', key: 'j', label: '', value: json, rows: 20, mono: true },
    ],
    buttons: [{ id: 'reset', label: 'Reset to defaults', danger: true }],
    validate: v => { try { const o = JSON.parse(String(v.j)); return typeof o === 'object' && o && !Array.isArray(o) ? null : 'Must be a JSON object'; } catch (e) { return 'Invalid JSON: ' + (e as Error).message; } },
  });
  if (!r) return;
  if (r.__button === 'reset') { settings.hotkeys = {}; saveSettings(); rebuildUi(); toast('Shortcuts reset', 'ok'); return; }
  if (r.preset !== 'custom' && r.preset !== cur) { applyKeyPreset(String(r.preset), rebuildUi); return; }
  const o = JSON.parse(String(r.j)) as Record<string, string>;
  const out: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  for (const c of allCommands()) defaults[c.id] = c.hotkey ?? '';
  for (const [id, chord] of Object.entries(o)) {
    if (!(id in defaults)) continue;
    const norm = String(chord).split(',').map(s => s.trim()).filter(Boolean).join(',');
    const defNorm = defaults[id].split(',').map(s => normalizeChord(s)).join(',');
    if (norm.split(',').map(s => normalizeChord(s)).join(',') !== defNorm) out[id] = norm;
  }
  settings.hotkeys = out; saveSettings(); rebuildUi();
  toast('Shortcuts saved', 'ok');
}

async function customizeToolbar(app: App, rebuildUi: () => void) {
  const r = await showDialog({
    title: 'Customize toolbar', message: 'Choose which tools appear in the palette. Hidden tools stay reachable via their shortcut.',
    fields: app.tools.map(t => ({ kind: 'checkbox' as const, key: t.id, label: `${t.title}${t.hotkey ? ` (${t.hotkey})` : ''}`, value: !settings.hiddenTools.includes(t.id) })),
    buttons: [{ id: 'all', label: 'Show all' }],
  });
  if (!r) return;
  const hidden = r.__button === 'all' ? [] : app.tools.filter(t => !r[t.id]).map(t => t.id);
  if (hidden.length === app.tools.length) { toast('At least one tool must stay visible', 'warn'); return; }
  settings.hiddenTools = hidden; saveSettings(); rebuildUi();
}

export type { AnchorRef };
