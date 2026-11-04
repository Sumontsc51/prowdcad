/**
 * All built-in commands. Menus, hotkeys and context menus come from here. Commands backed by
 * kernel ops that have not landed yet call ops-bridge placeholders (→ "not wired yet" toast).
 */
import { registerCommand, type CommandCtx, hotkeyMap, allCommands, normalizeChord } from '../commands';
import type { App } from '../app';
import type { Canvas } from '../canvas/canvas';
import { settings, saveSettings } from '../settings';
import { newStyle, openFile, saveFile, exportAs, importFile } from './file';
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
  const hasAnchor = (c: CommandCtx) => c.app.sel.anchors.length > 0;
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
  registerCommand({ id: 'file.import', title: 'Import (DXF/SVG/PLT)…', menu: 'File', group: 2, run: () => importFile(app) });
  for (const [fmtId, label] of [['dxf', 'DXF (AAMA/ASTM)'], ['svg', 'SVG'], ['pdf', 'PDF (tiled)'], ['plt', 'PLT (HPGL)']] as const) {
    registerCommand({ id: 'file.export.' + fmtId, title: label + '…', menu: 'File/Export', run: () => exportAs(app, fmtId) });
  }
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
  registerCommand({ id: 'edit.delete', title: 'Delete', menu: 'Edit', group: 1, hotkey: 'Delete,Backspace', enabled: c => hasPiece(c) || hasAnchor(c), run: () => deleteSelection(app) });
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
  registerCommand({ id: 'edit.selectAll', title: 'Select all pieces', menu: 'Edit', group: 2, hotkey: 'Ctrl+A', run: () => { app.sel = { pieces: app.style.pieces.map(p => p.id), anchors: [] }; } });
  registerCommand({ id: 'edit.selectAllPoints', title: 'Select all points of piece', menu: 'Edit', group: 2, hotkey: 'Ctrl+Shift+A', enabled: hasPiece, run: () => {
    const p = onePiece();
    app.sel = { pieces: [p.id], anchors: [p.sew, ...p.internals].flatMap(c => c.points.map(a => ({ pieceId: p.id, contourId: c.id, anchorId: a.id }))) };
  } });
  registerCommand({ id: 'edit.deselect', title: 'Deselect', menu: 'Edit', group: 2, hotkey: 'Escape', run: () => { app.sel = { pieces: [], anchors: [] }; } });
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
  registerCommand({ id: 'edit.toolbar', title: 'Customize toolbar…', menu: 'Edit', group: 4, run: () => customizeToolbar(app, rebuildUi) });

  // ───────────── Piece ─────────────
  registerCommand({ id: 'piece.rename', title: 'Rename…', menu: 'Piece', group: 0, enabled: hasPiece, run: async () => {
    const p = onePiece();
    const r = await showDialog({ title: 'Rename piece', fields: [{ kind: 'text', key: 'n', label: 'Name', value: p.name }] });
    if (r && String(r.n).trim()) tx('Rename piece', () => { p.name = String(r.n).trim(); });
  } });
  registerCommand({ id: 'piece.lock', title: 'Lock / unlock', menu: 'Piece', group: 0, hotkey: 'Ctrl+L', enabled: hasPiece, checked: c => !!c.app.primaryPiece()?.locked,
    run: () => { const v = !onePiece().locked; tx('Lock piece', () => selPieces().forEach(p => { p.locked = v; })); } });
  registerCommand({ id: 'piece.rotate', title: 'Rotate…', menu: 'Piece', group: 1, enabled: hasPiece, run: async () => {
    const r = await showDialog({ title: 'Rotate piece', fields: [{ kind: 'number', key: 'a', label: 'Angle (° CCW)', value: 90, suffix: '°' }] });
    if (r) tx('Rotate piece', () => selPieces().forEach(p => { const L = layoutOf(p); p.layout = { ...L, angleDeg: ((L.angleDeg + (r.a as number)) % 360 + 360) % 360 }; }));
  } });
  registerCommand({ id: 'piece.rotate90', title: 'Rotate 90° CCW', menu: 'Piece', group: 1, hotkey: 'Alt+R', enabled: hasPiece,
    run: () => tx('Rotate piece', () => selPieces().forEach(p => { const L = layoutOf(p); p.layout = { ...L, angleDeg: (L.angleDeg + 90) % 360 }; })) });
  registerCommand({ id: 'piece.resetLayout', title: 'Reset position', menu: 'Piece', group: 1, enabled: hasPiece, run: () => tx('Reset position', () => selPieces().forEach(p => { delete p.layout; })) });
  registerCommand({ id: 'piece.mirror', title: 'Mirror piece…', menu: 'Piece', group: 2, enabled: hasPiece, run: () => {
    const p = onePiece(); const r = resolveFor(app.doc, p, app.baseSize());
    const xs = r.sew.pts.map(q => q.x); const x0 = (Math.min(...xs) + Math.max(...xs)) / 2;
    ops.mirrorPiece(app.doc, { pieceId: p.id, axis: [{ x: x0, y: 0 }, { x: x0, y: 1 }] });
  } });
  registerCommand({ id: 'piece.combine', title: 'Combine pieces', menu: 'Piece', group: 2, enabled: c => c.app.sel.pieces.length > 1, run: () => { ops.combinePieces(app.doc, app.sel.pieces.slice()); } });
  registerCommand({ id: 'piece.cut', title: 'Cut piece along internal line', menu: 'Piece', group: 2, enabled: hasPiece, run: () => {
    const p = onePiece(); const ic = p.internals[p.internals.length - 1];
    if (!ic) throw new Error('Draw an internal line across the piece first');
    const r = resolveFor(app.doc, p, app.baseSize());
    ops.cutPiece(app.doc, { pieceId: p.id, line: r.internals[p.internals.length - 1].pts });
  } });
  registerCommand({ id: 'piece.scale', title: 'Scale / shrinkage…', menu: 'Piece', group: 2, enabled: hasPiece, run: async () => {
    const r = await showDialog({ title: 'Scale piece', fields: [{ kind: 'number', key: 'sx', label: 'Scale X %', value: 100, suffix: '%' }, { kind: 'number', key: 'sy', label: 'Scale Y %', value: 100, suffix: '%' }] });
    if (r) ops.scalePiece(app.doc, { pieceId: onePiece().id, sx: (r.sx as number) / 100, sy: (r.sy as number) / 100 });
  } });
  registerCommand({ id: 'piece.shaper', title: 'Shapers…', menu: 'Piece', group: 2, enabled: hasPiece, run: () => ops.shaper(app.doc, { pieceId: onePiece().id, kind: 'default' }) });
  registerCommand({ id: 'piece.grain', title: 'Grain line…', menu: 'Piece', group: 3, enabled: hasPiece, run: async () => {
    const p = onePiece();
    const ang = Math.atan2(p.grain.b.y - p.grain.a.y, p.grain.b.x - p.grain.a.x) * 180 / Math.PI;
    const r = await showDialog({ title: 'Grain line', fields: [{ kind: 'number', key: 'a', label: 'Angle (°, 90 = vertical)', value: Math.round(ang * 100) / 100, suffix: '°' }] });
    if (!r) return;
    tx('Grain line', () => {
      const res = resolveFor(app.doc, p, app.baseSize());
      const xs = res.sew.pts.map(q => q.x), ys = res.sew.pts.map(q => q.y);
      const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
      const L = Math.hypot(p.grain.b.x - p.grain.a.x, p.grain.b.y - p.grain.a.y) / 2 || 50;
      const a = (r.a as number) * Math.PI / 180;
      p.grain.a = { x: c.x - Math.cos(a) * L, y: c.y - Math.sin(a) * L }; p.grain.b = { x: c.x + Math.cos(a) * L, y: c.y + Math.sin(a) * L };
    });
  } });
  registerCommand({ id: 'piece.delete', title: 'Delete piece', menu: 'Piece', group: 4, enabled: hasPiece, run: async () => {
    if (!(await confirmDialog('Delete piece', `Delete ${app.sel.pieces.length} piece(s)?`, 'Delete'))) return;
    const ids = new Set(app.sel.pieces);
    tx('Delete piece', () => { app.style.pieces = app.style.pieces.filter(p => !ids.has(p.id)); });
  } });

  // ───────────── Point ─────────────
  registerCommand({ id: 'point.toggleSmooth', title: 'Corner ⇄ smooth', menu: 'Point', group: 0, hotkey: 'Alt+C', enabled: hasAnchor, run: () => tx('Corner/smooth', () => eachAnchor(app, a => { if (a.smooth) { a.smooth = false; delete a.hIn; delete a.hOut; } else a.smooth = true; })) });
  registerCommand({ id: 'point.toggleKind', title: 'Grade ⇄ curve point', menu: 'Point', group: 0, hotkey: 'Alt+G', enabled: hasAnchor, run: () => tx('Point kind', () => eachAnchor(app, a => { a.kind = a.kind === 'grade' ? 'curve' : 'grade'; })) });
  registerCommand({ id: 'point.resetHandles', title: 'Reset handles (auto)', menu: 'Point', group: 0, enabled: hasAnchor, run: () => tx('Reset handles', () => eachAnchor(app, a => { delete a.hIn; delete a.hOut; })) });
  registerCommand({ id: 'point.lock', title: 'Lock / unlock point', menu: 'Point', group: 0, enabled: hasAnchor, run: () => tx('Lock point', () => eachAnchor(app, a => { a.flags.locked = !a.flags.locked || undefined; })) });
  registerCommand({ id: 'point.insertMid', title: 'Insert point after (mid-span)', menu: 'Point', group: 1, hotkey: 'Alt+I', enabled: hasAnchor, run: () => {
    const pa = app.primaryAnchor()!; const n = pa.contour.points.length;
    if (!pa.contour.closed && pa.index === n - 1) throw new Error('Last point of an open line has no following span');
    const res = app.doc.resolveContour(pa.piece, pa.contour);
    const j = (pa.index + 1) % n;
    const m = bezierPoint(res.anchorPos[pa.index], res.handles[pa.index].hOut, res.handles[j].hIn, res.anchorPos[j], 0.5);
    const na = makeAnchor(m.x, m.y, { kind: 'curve', smooth: true });
    tx('Insert point', () => { const c = contourById(app.doc.piece(pa.piece.id), pa.contour.id)!; c.points.splice(pa.index + 1, 0, na); });
    app.selectAnchor({ pieceId: pa.piece.id, contourId: pa.contour.id, anchorId: na.id });
  } });
  registerCommand({ id: 'point.atDistance', title: 'Point at distance…', menu: 'Point', group: 1, enabled: hasAnchor, run: async () => {
    const r = await showDialog({ title: 'Point at distance', fields: [{ kind: 'length', key: 'd', label: 'Distance along segment', value: 50, min: 0 }, { kind: 'checkbox', key: 'end', label: 'Measure from segment end', value: false }] });
    if (r) ops.pointAtDistance(app.doc, segRef(), r.d as number, !!r.end);
  } });
  registerCommand({ id: 'point.evenly', title: 'Add points evenly…', menu: 'Point', group: 1, enabled: hasAnchor, run: async () => {
    const r = await showDialog({ title: 'Add points evenly', fields: [{ kind: 'number', key: 'n', label: 'Number of points', value: 3, min: 1, max: 200 }] });
    if (r) ops.addPointsEvenly(app.doc, segRef(), Math.round(r.n as number));
  } });
  registerCommand({ id: 'point.alignX', title: 'Align points (same X)', menu: 'Point', group: 2, enabled: c => c.app.sel.anchors.length > 1, run: () => ops.alignPoints(app.doc, app.sel.anchors, 'x') });
  registerCommand({ id: 'point.alignY', title: 'Align points (same Y)', menu: 'Point', group: 2, enabled: c => c.app.sel.anchors.length > 1, run: () => ops.alignPoints(app.doc, app.sel.anchors, 'y') });
  registerCommand({ id: 'point.notchType', title: 'Notch type…', menu: 'Point', group: 3, run: async () => {
    const r = await showDialog({ title: 'Notch tool', fields: [
      { kind: 'select', key: 't', label: 'Type', value: notchType, options: (['slit', 'T', 'V', 'U', 'castle'] as NotchType[]).map(t => ({ value: t, label: t })) },
      { kind: 'length', key: 'dd', label: 'Drill diameter', value: drillDiameter, min: 0.1 },
    ] });
    if (r) { setNotchType(r.t as NotchType); setDrillDiameter(r.dd as number); }
  } });
  registerCommand({ id: 'point.notchHere', title: 'Notch at selected point', menu: 'Point', group: 3, enabled: hasAnchor, run: () => { for (const a of app.sel.anchors) ops.addNotchAtAnchor(app.doc, a, notchType); } });

  // ───────────── Segment ─────────────
  registerCommand({ id: 'seg.length', title: 'Segment length…', menu: 'Segment', group: 0, enabled: hasAnchor, run: async () => {
    const s = segRef(); const pa = app.primaryAnchor()!;
    const res = app.doc.resolveContour(pa.piece, pa.contour, app.sizeOf(pa.piece));
    const k = res.gradeIdx.indexOf(pa.index);
    const [a, b] = gradeSegment(res, k);
    const cur = spanLength(res, a, b);
    const r = await showDialog({ title: 'Segment length', message: `Current: ${fmt(cur)} ${unitLabel()}`, fields: [
      { kind: 'length', key: 'L', label: 'New length', value: cur, min: 0.01 },
      { kind: 'select', key: 'm', label: 'Method', value: '2-D', options: [['1-H', '1-Horizontal'], ['2-H', '2-Horizontal'], ['1-V', '1-Vertical'], ['2-V', '2-Vertical'], ['1-D', '1-Diagonal'], ['2-D', '2-Diagonal']].map(([value, label]) => ({ value, label })) },
    ] });
    if (r) ops.setSegmentLength(app.doc, s, r.L as number, String(r.m));
  } });
  registerCommand({ id: 'seg.smooth', title: 'Smooth segment', menu: 'Segment', group: 0, enabled: hasAnchor, run: () => ops.smoothSegment(app.doc, segRef()) });
  registerCommand({ id: 'seg.parallel', title: 'Parallel line…', menu: 'Segment', group: 1, enabled: hasAnchor, run: async () => {
    const r = await showDialog({ title: 'Parallel line', fields: [{ kind: 'length', key: 'd', label: 'Distance', value: 10 }] });
    if (r) ops.parallelLine(app.doc, segRef(), r.d as number);
  } });
  registerCommand({ id: 'seg.binding', title: 'Binding / facing…', menu: 'Segment', group: 1, enabled: hasAnchor, run: async () => {
    const r = await showDialog({ title: 'Binding', fields: [{ kind: 'length', key: 'w', label: 'Width', value: 30, min: 0.1 }] });
    if (r) ops.addBinding(app.doc, segRef(), r.w as number);
  } });
  registerCommand({ id: 'seg.walk', title: 'Walk pieces…', menu: 'Segment', group: 2, enabled: c => c.app.sel.anchors.length >= 2, run: () => {
    const [a, b] = app.sel.anchors;
    ops.walkPieces(app.doc, { a: { pieceId: a.pieceId, contourId: a.contourId, startAnchorId: a.anchorId }, b: { pieceId: b.pieceId, contourId: b.contourId, startAnchorId: b.anchorId } });
  } });

  // ───────────── Seam ─────────────
  registerCommand({ id: 'seam.segment', title: 'Seam allowance of segment…', menu: 'Seam', group: 0, hotkey: 'Alt+S', enabled: hasAnchor, run: async () => {
    const refs = app.sel.anchors.filter(r => { const q = app.resolveRef(r); return q && q.contour === q.piece.sew && q.anchor.kind === 'grade'; });
    if (!refs.length) throw new Error('Select sew-line grade point(s) — the segment leaving each point gets the value');
    const first = app.resolveRef(refs[0])!;
    const r = await showDialog({ title: 'Seam allowance', message: `${refs.length} segment(s)`, fields: [{ kind: 'length', key: 'v', label: 'Seam', value: first.anchor.seamAfter ?? first.piece.seamDefault, min: 0 }] });
    if (r) tx('Seam allowance', () => { for (const ref of refs) { const q = app.resolveRef(ref)!; q.anchor.seamAfter = r.v as number; } });
  } });
  registerCommand({ id: 'seam.piece', title: 'Piece default seam…', menu: 'Seam', group: 0, enabled: hasPiece, run: async () => {
    const p = onePiece();
    const r = await showDialog({ title: 'Piece seam', fields: [{ kind: 'length', key: 'v', label: 'Default seam', value: p.seamDefault, min: 0 }, { kind: 'checkbox', key: 'clr', label: 'Clear per-segment overrides', value: false }] });
    if (r) tx('Piece seam', () => selPieces().forEach(pc => { pc.seamDefault = r.v as number; if (r.clr) pc.sew.points.forEach(a => { delete a.seamAfter; }); }));
  } });
  registerCommand({ id: 'seam.global', title: 'Global seam (all pieces)…', menu: 'Seam', group: 0, run: async () => {
    const r = await showDialog({ title: 'Global seam', fields: [{ kind: 'length', key: 'v', label: 'Seam for every piece', value: 10, min: 0 }] });
    if (r) tx('Global seam', () => app.style.pieces.forEach(pc => { pc.seamDefault = r.v as number; pc.sew.points.forEach(a => { delete a.seamAfter; }); }));
  } });
  registerCommand({ id: 'seam.noSeam', title: 'No seam (cut = sew)', menu: 'Seam', group: 1, enabled: hasPiece, checked: c => !!c.app.primaryPiece()?.noSeam,
    run: () => { const v = !onePiece().noSeam; tx('No seam', () => selPieces().forEach(p => { p.noSeam = v; })); } });
  for (const [t, label] of [['miter', 'Miter'], ['boxed', 'Boxed (square)'], ['turnback', 'Turn-back (hem)'], ['angled', 'Angled (bevel)']] as const) {
    registerCommand({ id: 'seam.corner.' + t, title: label, menu: 'Seam/Corner', enabled: hasAnchor, run: () => { for (const a of app.sel.anchors) ops.setCornerType(app.doc, a, t); } });
  }
  registerCommand({ id: 'seam.swap', title: 'Swap sew ⇄ cut', menu: 'Seam', group: 2, enabled: hasPiece, run: () => ops.swapSewCut(app.doc, onePiece().id) });
  registerCommand({ id: 'seam.showCut', title: 'Show cut line', menu: 'Seam', group: 3, checked: () => settings.showCut, run: () => { settings.showCut = !settings.showCut; saveSettings(); } });

  // ───────────── Dart ─────────────
  registerCommand({ id: 'dart.add', title: 'Add dart at point…', menu: 'Dart', group: 0, enabled: hasAnchor, run: async () => {
    const pa = app.primaryAnchor()!;
    const r = await showDialog({ title: 'Add dart', fields: [{ kind: 'length', key: 'w', label: 'Width', value: 20, min: 0.1 }, { kind: 'length', key: 'l', label: 'Length', value: 100, min: 0.1 }] });
    if (!r) return;
    const res = app.doc.resolveContour(pa.piece, pa.contour);
    const at = res.anchorPos[pa.index];
    const xs = res.pts.map(q => q.x), ys = res.pts.map(q => q.y);
    const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    const d = Math.hypot(c.x - at.x, c.y - at.y) || 1;
    const apex = { x: at.x + (c.x - at.x) / d * (r.l as number), y: at.y + (c.y - at.y) / d * (r.l as number) };
    ops.addDart(app.doc, { pieceId: pa.piece.id, at, apex, width: r.w as number });
  } });
  registerCommand({ id: 'dart.rotate', title: 'Rotate dart', menu: 'Dart', group: 0, enabled: hasPiece, run: () => { const p = onePiece(); const d = p.darts[0]; if (!d) throw new Error('Piece has no dart'); ops.rotateDart(app.doc, { pieceId: p.id, dartId: d.id, target: d.apex }); } });
  registerCommand({ id: 'dart.toggle', title: 'Open / close dart', menu: 'Dart', group: 0, enabled: hasPiece, run: () => { const p = onePiece(); const d = p.darts[0]; if (!d) throw new Error('Piece has no dart'); ops.toggleDartClosed(app.doc, { pieceId: p.id, dartId: d.id }); } });
  registerCommand({ id: 'dart.pleat', title: 'Add pleat…', menu: 'Dart', group: 1, enabled: c => c.app.sel.anchors.length >= 2, run: async () => {
    const [a, b] = app.sel.anchors.map(r => app.resolveRef(r)!);
    const r = await showDialog({ title: 'Add pleat', fields: [{ kind: 'length', key: 'd', label: 'Depth', value: 30, min: 0.1 }, { kind: 'select', key: 't', label: 'Type', value: 'knife', options: [{ value: 'knife', label: 'Knife' }, { value: 'box', label: 'Box' }] }] });
    if (r) ops.addPleat(app.doc, { pieceId: a.piece.id, start: a.anchor, end: b.anchor, depth: r.d as number, type: r.t as 'knife' | 'box' });
  } });
  registerCommand({ id: 'dart.fullness', title: 'Add fullness…', menu: 'Dart', group: 1, enabled: hasPiece, run: async () => {
    const p = onePiece(); const ic = p.internals[p.internals.length - 1]; if (!ic) throw new Error('Draw an internal slash line first');
    const r = await showDialog({ title: 'Add fullness', fields: [{ kind: 'length', key: 'a', label: 'Amount', value: 20 }] });
    if (r) ops.addFullness(app.doc, { pieceId: p.id, line: ic.points.map(q => ({ x: q.x, y: q.y })), amount: r.a as number });
  } });

  // ───────────── Grade ─────────────
  let gradeClip: Record<SizeId, GradeInc> | null = null;
  registerCommand({ id: 'grade.table', title: 'Grading table', menu: 'Grade', group: 0, hotkey: 'Ctrl+G', checked: () => settings.panels.grading, run: () => { settings.panels.grading = !settings.panels.grading; saveSettings(); } });
  registerCommand({ id: 'grade.nested', title: 'Nested view (all sizes)', menu: 'Grade', group: 0, hotkey: 'Alt+N', checked: c => c.app.nested, run: () => { app.nested = !app.nested; } });
  registerCommand({ id: 'grade.absolute', title: 'Show absolute values', menu: 'Grade', group: 0, checked: c => c.app.gradeAbsolute, run: () => { app.gradeAbsolute = !app.gradeAbsolute; } });
  registerCommand({ id: 'grade.tracking', title: 'Point tracking (arrow keys)', menu: 'Grade', group: 0, hotkey: 'Alt+T', checked: c => c.app.pointTracking, run: () => { app.pointTracking = !app.pointTracking; app.status(app.pointTracking ? 'Point tracking ON: ←/→ point, ↑/↓ size' : 'Point tracking OFF'); } });
  registerCommand({ id: 'grade.prevSize', title: 'Previous size', menu: 'Grade', group: 1, hotkey: 'Ctrl+[', run: () => stepSize(app, -1) });
  registerCommand({ id: 'grade.nextSize', title: 'Next size', menu: 'Grade', group: 1, hotkey: 'Ctrl+]', run: () => stepSize(app, 1) });
  registerCommand({ id: 'grade.baseSize', title: 'Go to base size', menu: 'Grade', group: 1, hotkey: 'Ctrl+B', run: () => { app.activeSize = app.baseSize(); } });
  registerCommand({ id: 'grade.copy', title: 'Copy grade', menu: 'Grade', group: 2, hotkey: 'Ctrl+Alt+C', enabled: hasAnchor, run: () => { gradeClip = deepClone(app.primaryAnchor()!.anchor.grade ?? {}); app.status('Grade copied'); } });
  registerCommand({ id: 'grade.paste', title: 'Paste grade', menu: 'Grade', group: 2, hotkey: 'Ctrl+Alt+V', enabled: c => hasAnchor(c) && !!gradeClip, run: () => tx('Paste grade', () => eachAnchor(app, a => { a.grade = deepClone(gradeClip!); })) });
  registerCommand({ id: 'grade.pasteX', title: 'Paste grade — X only', menu: 'Grade', group: 2, enabled: c => hasAnchor(c) && !!gradeClip, run: () => tx('Paste grade X', () => eachAnchor(app, a => { a.grade = mixGrade(app, a.grade, gradeClip!, 'x'); })) });
  registerCommand({ id: 'grade.pasteY', title: 'Paste grade — Y only', menu: 'Grade', group: 2, enabled: c => hasAnchor(c) && !!gradeClip, run: () => tx('Paste grade Y', () => eachAnchor(app, a => { a.grade = mixGrade(app, a.grade, gradeClip!, 'y'); })) });
  registerCommand({ id: 'grade.mirrorX', title: 'Flip grade X', menu: 'Grade', group: 2, enabled: hasAnchor, run: () => tx('Flip grade X', () => eachAnchor(app, a => { for (const k in a.grade) a.grade[k] = { dx: -a.grade[k].dx, dy: a.grade[k].dy }; })) });
  registerCommand({ id: 'grade.mirrorY', title: 'Flip grade Y', menu: 'Grade', group: 2, enabled: hasAnchor, run: () => tx('Flip grade Y', () => eachAnchor(app, a => { for (const k in a.grade) a.grade[k] = { dx: a.grade[k].dx, dy: -a.grade[k].dy }; })) });
  registerCommand({ id: 'grade.zero', title: 'Zero grade', menu: 'Grade', group: 2, enabled: hasAnchor, run: () => tx('Zero grade', () => eachAnchor(app, a => { a.grade = {}; })) });
  registerCommand({ id: 'grade.rule', title: 'Apply rule…', menu: 'Grade', group: 3, enabled: hasAnchor, run: async () => {
    const rules = app.style.ruleLibraries.flatMap(l => l.rules);
    if (!rules.length) throw new Error('No rule library in this style');
    const r = await showDialog({ title: 'Apply rule', fields: [{ kind: 'select', key: 'r', label: 'Rule', value: rules[0].id, options: rules.map(x => ({ value: x.id, label: `${x.number} ${x.name}` })) }] });
    if (r) ops.applyRule(app.doc, app.sel.anchors, String(r.r));
  } });
  registerCommand({ id: 'grade.movement', title: 'Run movement program…', menu: 'Grade', group: 3, run: async () => {
    const mp = app.style.movementPrograms;
    if (!mp.length) throw new Error('No movement programs in this style');
    const r = await showDialog({ title: 'Movement program', fields: [{ kind: 'select', key: 'p', label: 'Program', value: mp[0].id, options: mp.map(x => ({ value: x.id, label: x.name })) }, { kind: 'length', key: 'd', label: 'Change', value: 10 }] });
    if (r) ops.runMovement(app.doc, String(r.p), r.d as number);
  } });

  // ───────────── Measure ─────────────
  registerCommand({ id: 'measure.tool', title: 'Measure tool', menu: 'Measure', group: 0, run: () => app.setTool('measure') });
  registerCommand({ id: 'measure.piece', title: 'Piece info', menu: 'Measure', group: 0, hotkey: 'Ctrl+I', enabled: hasPiece, run: async () => {
    const p = onePiece();
    const line = app.sizeLine();
    const rows = app.doc.sizesOf(p).map(sid => { const r = resolveFor(app.doc, p, sid); return `${line.sizes.find(s => s.id === sid)?.name}: sew ${fmt(totalLength(r.sew))}, cut ${fmt(perimeter(r.cut))} ${unitLabel()} · area ${(area(r.cut) / 1e4).toFixed(2)} dm²`; });
    await alertDialog(`${p.name}`, rows.join('\n'));
  } });
  registerCommand({ id: 'measure.compare', title: 'Compare lengths', menu: 'Measure', group: 1, enabled: c => c.app.sel.anchors.length >= 2, run: () => {
    const segs = app.sel.anchors.map(a => ({ pieceId: a.pieceId, contourId: a.contourId, startAnchorId: a.anchorId }));
    const res = ops.compareLengths(app.doc, segs.slice(0, 1), segs.slice(1));
    void alertDialog('Compare lengths', Object.entries(res).map(([s, v]) => `${app.sizeLine().sizes.find(x => x.id === s)?.name}: ${fmt(v)} ${unitLabel()}`).join('\n'));
  } });
  registerCommand({ id: 'measure.chart', title: 'Measurement chart', menu: 'Measure', group: 1, run: () => {
    const rows = ops.measurementChart(app.doc);
    void alertDialog('Measurement chart', rows.map(r => `${r.name}: ${Object.values(r.values).map(v => fmt(v)).join(' / ')}`).join('\n') || 'No measurements');
  } });

  // ───────────── View ─────────────
  registerCommand({ id: 'view.fit', title: 'Zoom to fit', menu: 'View', group: 0, hotkey: 'Ctrl+0,F', run: () => canvas.zoomFit() });
  registerCommand({ id: 'view.fitSel', title: 'Zoom to selection', menu: 'View', group: 0, hotkey: 'Shift+F', enabled: hasPiece, run: () => canvas.zoomFit(app.sel.pieces) });
  registerCommand({ id: 'view.zoomIn', title: 'Zoom in', menu: 'View', group: 0, hotkey: 'Ctrl+=,Ctrl++,+,=', run: () => canvas.zoomBy(1.25) });
  registerCommand({ id: 'view.zoomOut', title: 'Zoom out', menu: 'View', group: 0, hotkey: 'Ctrl+-,-', run: () => canvas.zoomBy(0.8) });
  registerCommand({ id: 'view.zoom100', title: 'Actual size (100%)', menu: 'View', group: 0, hotkey: 'Ctrl+1', run: () => canvas.zoom100() });
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
  registerCommand({ id: 'help.ops', title: 'Kernel ops status', menu: 'Help', run: () => alertDialog('Kernel ops (ops-bridge)', opStatus().map(o => `${o.state.padEnd(9)} ${o.name}  (${o.module})`).join('\n')) });
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
  for (const d of p.darts) { d.id = newId('dt'); d.legA = m(d.legA); d.legB = m(d.legB); }
  for (const pl of p.pleats) pl.id = newId('pl');
  for (const n of p.notches) { n.id = newId('n'); n.contourId = m(n.contourId); n.placement = { ...n.placement, anchorId: m(n.placement.anchorId) } as typeof n.placement; }
  for (const d of p.drills) d.id = newId('d');
  for (const t of p.texts) t.id = newId('t');
  for (const a of p.artwork) a.id = newId('aw');
  p.connections = p.connections.map(c => ({ internalContourId: m(c.internalContourId), internalAnchorId: m(c.internalAnchorId), externalAnchorId: m(c.externalAnchorId) }));
  p.createdAt = p.updatedAt = new Date().toISOString();
  return p;
}

/** Delete selected anchors (keeping contours valid) or else the selected pieces. */
async function deleteSelection(app: App) {
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
  if (!app.sel.pieces.length) return;
  if (!(await confirmDialog('Delete', `Delete ${app.sel.pieces.length} piece(s)?`, 'Delete'))) return;
  const ids = new Set(app.sel.pieces);
  app.doc.transact('Delete piece', s => { s.pieces = s.pieces.filter(p => !ids.has(p.id)); });
  app.sel = { pieces: [], anchors: [] };
}

async function editHotkeys(rebuildUi: () => void) {
  const json = JSON.stringify(hotkeyMap(), null, 2);
  const r = await showDialog({
    title: 'Keyboard shortcuts', wide: true,
    message: 'Edit the JSON map  command-id → chord. Several chords: "Ctrl+Y,Ctrl+Shift+Z". Empty string = unbound. Modifiers: Ctrl (= Cmd), Alt, Shift.',
    fields: [{ kind: 'textarea', key: 'j', label: '', value: json, rows: 22, mono: true }],
    buttons: [{ id: 'reset', label: 'Reset to defaults', danger: true }],
    validate: v => { try { const o = JSON.parse(String(v.j)); return typeof o === 'object' && o && !Array.isArray(o) ? null : 'Must be a JSON object'; } catch (e) { return 'Invalid JSON: ' + (e as Error).message; } },
  });
  if (!r) return;
  if (r.__button === 'reset') { settings.hotkeys = {}; saveSettings(); rebuildUi(); toast('Shortcuts reset', 'ok'); return; }
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
