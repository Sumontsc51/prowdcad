/**
 * ProwdCAD Design workspace — entry point.
 * Builds the layout, mounts canvas / palette / menus / panels / status bar, registers commands,
 * routes keyboard input (tool → point tracking → command registry) and starts auto-backup.
 *
 * Kernel ops are wired into the ops bridge by wireKernel() (kernel-wiring.ts) before anything runs.
 */
import './styles.css';
import { makePiece, makeStyle, rectangleContour } from '@prowdcad/kernel';
import { App } from './app';
import { Canvas } from './canvas/canvas';
import { TOOLS } from './tools/index';
import { mountPalette } from './ui/palette';
import { mountMenubar, openContextMenu, closeContextMenu } from './ui/menu';
import { mountStatusbar } from './ui/statusbar';
import { mountDocks } from './panels/dock';
import { trackingKey } from './panels/grading';
import { registerAll } from './actions/register';
import { setCommandContext, commandForEvent, runCommand, onCommandsChanged } from './commands';
import { startAutoBackup, offerRecovery } from './actions/file';
import { isTyping } from './ui/dom';
import { dialogOpen } from './ui/dialog';
import { selectTool } from './tools/select';
import { wireKernel } from './kernel-wiring';
import { cornerGallery } from './actions/seam-notch';
import { downloadSink } from './actions/file';
import { selectLive } from './live';
import { ops } from './ops-bridge';
import { settings } from './settings';
import { toWorld, toLocal, resolveFor } from './geometry';
import { mountToolOptions } from './ui/toolopts';
import { candidatesAt } from './selpick';

wireKernel();

const root = document.getElementById('app')!;
root.innerHTML = `
  <header id="menubar"></header>
  <div id="toolopts"></div>
  <div id="main">
    <nav id="palette"></nav>
    <div id="center">
      <div id="canvas"></div>
      <div id="bottom-dock"></div>
    </div>
    <aside id="right-dock"></aside>
  </div>
  <footer id="statusbar"></footer>`;

const app = new App();
app.tools = TOOLS;
app.tool = selectTool;
app.groupTool = Object.fromEntries(TOOLS.map(t => [t.group, TOOLS.find(x => x.group === t.group)!.id]));
setCommandContext({ app });

const canvas = new Canvas(app, document.getElementById('canvas')!);
(app as App & { zoomFit?: () => void }).zoomFit = () => canvas.zoomFit();
// Scripting / automation hook (training videos, e2e tests, console use)
(window as unknown as { prowdcad: unknown }).prowdcad = { app, canvas, ops, settings, runCommand, geometry: { toWorld, toLocal, resolveFor } };

const renderPalette = mountPalette(app, document.getElementById('palette')!);
renderPalette();
let renderMenus = () => {};
const rebuildUi = () => { renderPalette(); renderMenus(); app.invalidate(); };
registerAll(app, canvas, rebuildUi);
renderMenus = mountMenubar(app, document.getElementById('menubar')!);
onCommandsChanged(() => { renderMenus(); });
mountStatusbar(app, document.getElementById('statusbar')!);
mountToolOptions(app, document.getElementById('toolopts')!);
mountDocks(app, document.getElementById('right-dock')!, document.getElementById('bottom-dock')!, ids => canvas.zoomFit(ids));

// palette reflects the active tool
const origSetTool = app.setTool.bind(app);
app.setTool = (id: string) => { origSetTool(id); renderPalette(); };

// ───────────── context menu (when the tool doesn't use right-click) ─────────────
canvas.onContext = p => {
  const h = p.hit;
  let sub: ReturnType<typeof candidatesAt>[number] | undefined;
  const e = p.e as MouseEvent;
  if (h.kind === 'anchor' && h.pieceId) {
    if (!app.isAnchorSelected({ anchorId: h.anchorId! })) app.selectAnchor({ pieceId: h.pieceId, contourId: h.contourId!, anchorId: h.anchorId! });
    const isSewGrade = (() => { const q = app.resolveRef({ pieceId: h.pieceId!, contourId: h.contourId!, anchorId: h.anchorId! }); return !!q && q.contour === q.piece.sew && q.anchor.kind === 'grade'; })();
    openContextMenu(e.clientX, e.clientY, ['point.toggleSmooth', 'point.toggleKind', 'point.breakHandle', 'point.joinHandle', 'point.lock', 'point.startPoint', '-', 'move.single', 'move.smooth', 'move.group', 'point.moveXY', 'point.moveAlong', 'move.curve', 'point.setAngle', 'point.round', '-', 'seam.segment', 'seam.trimCorner', 'notch.atPoint', 'notch.corner', 'dart.add', '-', 'grade.copy', 'grade.paste', 'grade.smartPaste', 'grade.zero', '-', 'point.delete'],
      isSewGrade ? [{ label: 'Corner type…', run: () => void cornerGallery(app, { pieceId: h.pieceId!, contourId: h.contourId!, anchorId: h.anchorId! }, { x: e.clientX, y: e.clientY }) }] : []);
  } else if (h.kind === 'live' && h.pieceId && h.liveKind && h.liveId) {
    selectLive(app, { kind: h.liveKind, pieceId: h.pieceId, id: h.liveId });
    const ids = h.liveKind === 'dart'
      ? ['dart.toggle', 'dart.reopenWidth', 'dart.fix', 'dart.cutting', '-', 'dart.transfer', 'dart.rotateCenter', '-', 'dart.copy', 'dart.paste', 'dart.remove', '-', 'dart.change']
      : h.liveKind === 'pleat' ? ['pleat.open', 'pleat.close', 'pleat.openAll', 'pleat.closeAll', '-', 'pleat.delete'] : ['fullness.delete'];
    openContextMenu(e.clientX, e.clientY, ids);
  } else if ((sub = candidatesAt(app, p.w, 'all', { kinds: ['segment', 'internal', 'notch', 'mark'] })[0]) && h.kind !== 'handle') {
    // segment / internal line / notch / drill / text: select it (keep a multi-selection that contains it)
    if (!app.isSelected(sub.item)) app.applySel(sub.item, 'replace');
    const k = sub.item.k;
    openContextMenu(e.clientX, e.clientY, k === 'segment'
      ? ['move.line', 'move.lineParallel', 'move.curve', '-', 'seg.length', 'seg.rotate', 'point.add', 'point.splineSupport', '-', 'seam.segment', 'seg.copy', 'seg.paste', '-', 'grade.pasteAround']
      : k === 'internal' ? ['move.line', 'move.lineParallel', 'move.curve', '-', 'seg.swap', 'seg.dashed', 'seg.trim', '-', 'edit.delete']
        : ['edit.delete']);
  } else if (h.kind === 'piece' && h.pieceId) {
    if (!app.sel.pieces.includes(h.pieceId)) app.selectPiece(h.pieceId);
    openContextMenu(e.clientX, e.clientY, ['move.piece', 'move.pieceRotate', 'piece.flipH', 'piece.flipV', '-', 'piece.rename', 'piece.lock', 'edit.duplicate', 'piece.saveAsNew', '-', 'piece.rotate90', 'piece.rotate', 'piece.grain', 'piece.rotateToGrain', '-', 'seam.piece', 'seam.reseam', 'seam.lockGrading', 'seam.noSeam', '-', 'piece.scale', 'notch.grid', 'measure.piece', 'view.fitSel', '-', 'piece.delete']);
  } else {
    openContextMenu(e.clientX, e.clientY, ['view.fit', 'view.zoom100', '-', 'view.grid', 'view.rulers', 'grade.nested', '-', 'edit.selectAll', 'edit.deselect', 'edit.prefs', '-', 'file.new']);
  }
};

// ───────────── keyboard ─────────────
window.addEventListener('keydown', e => {
  if (dialogOpen()) return;
  if (e.code === 'Space' && !isTyping()) {
    if (!app.space) { app.space = true; app.invalidate('canvas'); }
    e.preventDefault(); return;
  }
  if (isTyping()) return;
  if (e.key === 'Escape') closeContextMenu();
  // 1) active tool (drafts: Enter / Esc / Backspace)
  if (app.tool?.key?.(app, e)) { e.preventDefault(); return; }
  // 2) grading point tracking (arrow keys)
  if (trackingKey(app, e, (x, y) => { app.view.cx = x; app.view.cy = y; app.invalidate('canvas'); })) { e.preventDefault(); return; }
  // 3) command registry (menus + user hotkey map)
  const cmd = commandForEvent(e);
  if (cmd) { e.preventDefault(); void runCommand(cmd.id); return; }
  // browser zoom / save etc. are suppressed for chords we own only
});
window.addEventListener('keyup', e => { if (e.code === 'Space') { app.space = false; app.invalidate('canvas'); } });
window.addEventListener('blur', () => { if (app.space) { app.space = false; app.invalidate('canvas'); } });
document.addEventListener('contextmenu', e => { if ((e.target as Element).closest?.('#app')) e.preventDefault(); });

// ───────────── start ─────────────
async function start() {
  const restored = await offerRecovery(app);
  if (!restored) {
    // bootstrap: one rectangle block so the sheet is never empty on first run
    const style = makeStyle();
    const p = makePiece('BLOCK', rectangleContour(0, 0, 400, 600), style.activeSizeTableId);
    p.grain = { a: { x: 200, y: 120 }, b: { x: 200, y: 480 }, gradeA: {}, gradeB: {}, centered: true };
    style.pieces.push(p);
    app.doc.load(style);
  }
  app.markSaved();
  if (restored) app.savedRev = -1;
  startAutoBackup(app);
  canvas.resize();
  requestAnimationFrame(() => canvas.zoomFit());
}
void start();

// expose for debugging / integrator console access
(window as unknown as { prowd: unknown }).prowd = { app, canvas, downloadSink };
