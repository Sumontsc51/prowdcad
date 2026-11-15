/**
 * View switches and small helpers that came out of the AccuMark "Tip of the Day" review:
 *   View ▸ Line labels · Point types · Hide annotations · Piece info on the piece · Show previous shape ·
 *          Only this piece (isolate)
 *   Edit ▸ Copy picture of the sheet · Export settings… · Import settings…
 *   Point ▸ Point from point (dX, dY)…
 * and dropping an image file onto a piece (placed as artwork at 300 dpi).
 */
import type { App } from '../app';
import { registerCommand } from '../commands';
import { settings, saveSettings, type Settings } from '../settings';
import { needs } from './cmd-util';
import { ops } from '../ops-bridge';
import { showDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { download, pickFiles } from './file';
import { dirToLocal, pieceAtWorld, toLocal } from '../geometry';
import { isIsolated, toggleIsolate } from '../isolate';

type Flag = 'showLineLabels' | 'showPointTypes' | 'hideAnnotations' | 'showPieceInfo' | 'showPrevShape';

/** PNG of the sheet as it is on screen (white background). */
export async function sheetPicture(): Promise<Blob> {
  const svg = document.querySelector('svg.sheet') as SVGSVGElement | null;
  if (!svg) throw new Error('No sheet to copy');
  const r = svg.getBoundingClientRect(); const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.setAttribute('width', String(W)); clone.setAttribute('height', String(H));
  clone.querySelectorAll('[data-hit]').forEach(n => n.remove());
  // the sheet's look lives in the page style sheets: carry the rules into the picture
  let css = '';
  for (const sh of Array.from(document.styleSheets)) { try { for (const rule of Array.from(sh.cssRules)) css += rule.cssText + '\n'; } catch { /* cross-origin sheet */ } }
  const st = document.createElementNS('http://www.w3.org/2000/svg', 'style'); st.textContent = css; clone.insertBefore(st, clone.firstChild);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  const img = await new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('The sheet could not be drawn as a picture')); im.src = url; });
  const k = 2; const cv = document.createElement('canvas'); cv.width = W * k; cv.height = H * k;
  const ctx = cv.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return await new Promise<Blob>((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('No picture'))), 'image/png'));
}

/** Place dropped image files on the piece under the drop point (300 dpi, 100 %). Returns how many were placed. */
export async function dropImages(app: App, files: File[], clientX: number, clientY: number): Promise<number> {
  const svg = document.querySelector('svg.sheet') as SVGSVGElement | null; if (!svg) return 0;
  const r = svg.getBoundingClientRect();
  const w = app.view.toWorld({ x: clientX - r.left, y: clientY - r.top });
  const piece = pieceAtWorld(app.doc, w, app.activeSize, app.hiddenPieces);
  if (!piece) { toast('Drop the image on a piece to place it as artwork', 'warn'); return 0; }
  if (piece.locked) { toast(`${piece.name} is locked`, 'warn'); return 0; }
  const at = toLocal(piece, w); let n = 0;
  for (const f of files) {
    const src = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(f); });
    const dims = await new Promise<{ w: number; h: number }>(res => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth || 100, h: im.naturalHeight || 100 }); im.onerror = () => res({ w: 100, h: 100 }); im.src = src; });
    ops.addArtwork(app.doc, app.doc.piece(piece.id), { x: at.x + n * 10, y: at.y - n * 10, width: ops.pixelsToMm(dims.w, 300), height: ops.pixelsToMm(dims.h, 300), src, scaleX: 1, scaleY: 1, angleDeg: 0, name: f.name });
    n++;
  }
  if (n) toast(`${n} image${n > 1 ? 's' : ''} placed on “${piece.name}” at 300 dpi (Notch ▸ Place artwork… for other sizes)`, 'ok');
  app.invalidate();
  return n;
}

export function registerViewExtras(app: App) {
  const flag = (id: string, title: string, key: Flag, on: string, off: string) => registerCommand({
    id, title, menu: 'View/Show', checked: () => !!settings[key],
    run: () => { (settings as Settings)[key] = !settings[key]; saveSettings(); app.status(settings[key] ? on : off); app.invalidate(); },
  });
  flag('view.lineLabels', 'Line labels (number and length)', 'showLineLabels', 'Line labels on: every outline line shows its number and length', 'Line labels off');
  flag('view.pointTypes', 'Point types (G = grade, C = curve)', 'showPointTypes', 'Point types on: every outline point shows its number and type', 'Point types off');
  flag('view.hideAnnotations', 'Hide annotations (texts)', 'hideAnnotations', 'Text annotations hidden (they are still in the pattern and in exports)', 'Text annotations shown');
  flag('view.pieceInfo', 'Piece info on the piece', 'showPieceInfo', 'Piece info on: material, quantity, points and outline length under each piece name', 'Piece info off');
  flag('view.prevShape', 'Show previous shape (before the last change)', 'showPrevShape', 'Previous shape on: the orange dashed outline is the piece before the last change', 'Previous shape off');
  registerCommand({ id: 'view.isolate', title: 'Only this piece (hide the others)', menu: 'View/Show', checked: () => isIsolated(), run: () => toggleIsolate(app) });

  registerCommand({ id: 'edit.copyPicture', title: 'Copy picture of the sheet', menu: 'Edit', group: 3, run: async () => {
    const blob = await sheetPicture();
    try {
      const CI = (window as unknown as { ClipboardItem?: new (d: Record<string, Blob>) => unknown }).ClipboardItem;
      if (!CI || !navigator.clipboard?.write) throw new Error('no clipboard');
      await navigator.clipboard.write([new CI({ 'image/png': blob }) as ClipboardItem]);
      toast('Picture of the sheet copied: paste it into a mail, chat or document', 'ok');
    } catch { download('prowdcad-sheet.png', blob); toast('The browser refused the clipboard: the picture was downloaded as prowdcad-sheet.png', 'warn'); }
  } });

  registerCommand({ id: 'edit.settingsExport', title: 'Export settings…', menu: 'Edit', group: 4, run: () => {
    download('prowdcad-settings.json', new Blob([JSON.stringify({ app: 'prowdcad-settings', version: 1, settings }, null, 1)], { type: 'application/json' }));
    toast('Settings saved as prowdcad-settings.json (preferences, shortcuts, toolbar, tool options)', 'ok');
  } });
  registerCommand({ id: 'edit.settingsImport', title: 'Import settings…', menu: 'Edit', group: 4, run: async () => {
    const [f] = await pickFiles('.json,application/json', false); if (!f) return;
    importSettingsText(app, await f.text());
  } });

  registerCommand({ id: 'point.fromPoint', title: 'Point from point (dX, dY)…', menu: 'Point', group: 1, enabled: needs(c => c.app.sel.anchors.length > 0, 'a selected point to measure from'), run: async () => {
    const pa = app.primaryAnchor(); if (!pa) throw new Error('Select the point to measure from');
    const r = await showDialog({ title: 'Point from point', message: `From point ${pa.index + 1}${pa.anchor.name ? ' ' + pa.anchor.name : ''} of ${pa.piece.name}`, fields: [
      { kind: 'length', key: 'dx', label: 'dX (right +, left −)', value: 0 },
      { kind: 'length', key: 'dy', label: 'dY (up +, down −)', value: 0 },
    ] });
    if (!r) return;
    const piece = app.doc.piece(pa.piece.id);
    if (piece.locked) throw new Error(`${piece.name} is locked`);
    const base = app.doc.resolvePiece(piece.id, app.doc.baseSize(piece));
    const c = pa.contour === pa.piece.sew ? base.sew : base.internals[pa.piece.internals.indexOf(pa.contour)];
    const from = c?.anchorPos[pa.index] ?? pa.anchor;
    const d = dirToLocal(piece, { x: r.dx as number, y: r.dy as number });
    ops.addDrill(app.doc, piece, { x: from.x + d.x, y: from.y + d.y, kind: 'drill' });
    toast(`Point placed ${String(r.dx)} / ${String(r.dy)} mm from the selected point (a drill point: move or delete it like any drill)`, 'ok');
  } });
}

/** Load a settings file exported by Edit ▸ Export settings…; returns true when it was applied. */
export function importSettingsText(app: App, text: string): boolean {
  let data: { app?: string; settings?: Partial<Settings> };
  try { data = JSON.parse(text) as typeof data; } catch { toast('That file is not a ProwdCAD settings file', 'error'); return false; }
  if (data?.app !== 'prowdcad-settings' || !data.settings || typeof data.settings !== 'object') { toast('That file is not a ProwdCAD settings file', 'error'); return false; }
  Object.assign(settings, data.settings);
  saveSettings(); app.invalidate();
  toast('Settings loaded. Reload the page so shortcuts and the toolbar follow them too.', 'ok', 5000);
  return true;
}
