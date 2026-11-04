/**
 * File handling: New (bootstrap rectangle block), Open / Save / Save As native JSON (File System
 * Access API when available, else <input type=file> / download), exports via ops-bridge,
 * 30-second auto-backup to localStorage with crash recovery on load.
 */
import { Document, makeStyle, makePiece, rectangleContour, type Style } from '@prowdcad/kernel';
import type { App } from '../app';
import { showDialog, confirmDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { store } from '../settings';
import { ops, type ExportFormat } from '../ops-bridge';
import { reportError } from '../commands';

const BACKUP_KEY = 'prowdcad.web.backup';
const SESSION_KEY = 'prowdcad.web.session';

type FSHandle = { name: string; createWritable(): Promise<{ write(d: Blob | string): Promise<void>; close(): Promise<void> }>; getFile?(): Promise<File> };
interface FSWindow {
  showOpenFilePicker?: (o: unknown) => Promise<FSHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FSHandle>;
}
const W = window as unknown as FSWindow;
const PICKER_TYPES = [{ description: 'ProwdCAD style', accept: { 'application/json': ['.prowd.json', '.json'] } }];

export async function newStyle(app: App) {
  if (app.isDirty() && !(await confirmDialog('New style', 'Discard unsaved changes?', 'Discard'))) return;
  const r = await showDialog({
    title: 'New style',
    fields: [
      { kind: 'text', key: 'name', label: 'Style name', value: 'Untitled' },
      { kind: 'text', key: 'sizes', label: 'Sizes (comma separated)', value: 'XS, S, M, L, XL' },
      { kind: 'text', key: 'base', label: 'Base size', value: 'M' },
      { kind: 'checkbox', key: 'block', label: 'Start with a rectangle block', value: true },
      { kind: 'length', key: 'w', label: 'Block width', value: 500, min: 1 },
      { kind: 'length', key: 'h', label: 'Block height', value: 700, min: 1 },
      { kind: 'length', key: 'seam', label: 'Seam allowance', value: 10, min: 0 },
    ],
    validate: v => String(v.sizes).split(',').map(s => s.trim()).filter(Boolean).length ? null : 'At least one size is required',
  });
  if (!r) return;
  const sizes = String(r.sizes).split(',').map(s => s.trim()).filter(Boolean);
  const style = makeStyle(String(r.name).trim() || 'Untitled', sizes, String(r.base).trim() || sizes[Math.floor(sizes.length / 2)]);
  if (r.block) {
    const w = r.w as number, h = r.h as number;
    const p = makePiece('BLOCK', rectangleContour(0, 0, w, h), style.activeSizeTableId, { seamDefault: r.seam as number });
    p.grain = { a: { x: w / 2, y: h * 0.2 }, b: { x: w / 2, y: h * 0.8 }, gradeA: {}, gradeB: {}, centered: true };
    style.pieces.push(p);
  }
  loadStyle(app, style, `${style.name}.prowd.json`, null);
}

export function loadStyle(app: App, style: Style, name: string, handle: unknown) {
  app.doc.load(style);
  app.fileName = name; app.fileHandle = handle;
  app.markSaved();
  requestAnimationFrame(() => (app as App & { zoomFit?: () => void }).zoomFit?.());
}

export async function openFile(app: App) {
  if (app.isDirty() && !(await confirmDialog('Open', 'Discard unsaved changes?', 'Discard'))) return;
  if (W.showOpenFilePicker) {
    try {
      const [hnd] = await W.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      const f = await hnd.getFile!();
      return readInto(app, await f.text(), f.name, hnd);
    } catch (err) { if ((err as Error).name === 'AbortError') return; console.warn('FS Access failed, falling back', err); }
  }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,.prowd,.prowd.json,application/json';
  inp.onchange = async () => { const f = inp.files?.[0]; if (f) readInto(app, await f.text(), f.name, null); };
  inp.click();
}

function readInto(app: App, text: string, name: string, handle: unknown) {
  try {
    const d = Document.fromJSON(text);
    loadStyle(app, d.style, name, handle);
    toast(`Opened ${name}`, 'ok');
  } catch (err) { reportError(err, 'Open'); }
}

export async function saveFile(app: App, saveAs = false) {
  const json = JSON.stringify(app.doc.style, null, 1);
  let handle = app.fileHandle as FSHandle | null;
  if (W.showSaveFilePicker && (saveAs || !handle)) {
    try { handle = await W.showSaveFilePicker({ suggestedName: app.fileName, types: PICKER_TYPES }); }
    catch (err) { if ((err as Error).name === 'AbortError') return; handle = null; }
  }
  if (handle) {
    try {
      const w = await handle.createWritable(); await w.write(json); await w.close();
      app.fileHandle = handle; app.fileName = handle.name; app.markSaved(); clearBackup();
      toast(`Saved ${handle.name}`, 'ok'); return;
    } catch (err) { console.warn('FS Access write failed, falling back to download', err); }
  }
  if (saveAs || !W.showSaveFilePicker) {
    const r = await showDialog({ title: saveAs ? 'Save as' : 'Save', fields: [{ kind: 'text', key: 'n', label: 'File name', value: app.fileName }] });
    if (!r) return;
    let n = String(r.n).trim() || 'untitled.prowd.json';
    if (!/\.json$/i.test(n)) n += '.prowd.json';
    app.fileName = n;
  }
  download(app.fileName, new Blob([json], { type: 'application/json' }));
  app.markSaved(); clearBackup();
  toast(`Downloaded ${app.fileName}`, 'ok');
}

export function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function exportAs(app: App, format: ExportFormat) {
  const base = app.fileName.replace(/\.prowd\.json$|\.json$/i, '');
  try {
    const ids = app.sel.pieces.length ? app.sel.pieces : undefined;
    const res = ops.exportFile(app.doc, format, { pieceIds: ids, nested: app.nested });
    const blob = typeof res.data === 'string' ? new Blob([res.data], { type: res.mime }) : res.data;
    download(`${base}.${res.ext}`, blob);
  } catch (err) { reportError(err, `Export ${format.toUpperCase()}`); }
}

export function importFile(app: App) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.dxf,.svg,.plt,.hpgl,.aama,.astm';
  inp.onchange = async () => {
    const f = inp.files?.[0]; if (!f) return;
    try { ops.importFile(app.doc, f.name, await f.arrayBuffer()); toast(`Imported ${f.name}`, 'ok'); }
    catch (err) { reportError(err, 'Import'); }
  };
  inp.click();
}

// ───────────── auto-backup / crash recovery ─────────────

export function clearBackup() { store.del(BACKUP_KEY); }

export function startAutoBackup(app: App) {
  let lastRev = -1;
  const tick = () => {
    if (!app.isDirty() || app.doc.revision() === lastRev) return;
    const ok = store.set(BACKUP_KEY, JSON.stringify({ at: new Date().toISOString(), fileName: app.fileName, style: app.doc.style }));
    if (ok) lastRev = app.doc.revision();
  };
  setInterval(tick, 30_000);
  // session marker: present while the app is open; removed on clean unload
  store.set(SESSION_KEY, String(Date.now()));
  window.addEventListener('beforeunload', e => {
    if (app.isDirty()) { tick(); e.preventDefault(); e.returnValue = ''; return; }
    store.del(SESSION_KEY); clearBackup();
  });
}

/** On load: offer to restore a backup left by a crash / unsaved close. Returns true when restored. */
export async function offerRecovery(app: App): Promise<boolean> {
  const raw = store.get(BACKUP_KEY);
  if (!raw) return false;
  let data: { at: string; fileName: string; style: Style };
  try { data = JSON.parse(raw); if (data?.style?.schema !== 'prowdcad/2') throw new Error('bad'); }
  catch { clearBackup(); return false; }
  const when = new Date(data.at).toLocaleString();
  const r = await showDialog({
    title: 'Recover unsaved work?',
    message: `An auto-backup of “${data.style.name}” (${data.fileName}, ${data.style.pieces.length} pieces) from ${when} was found. It was not saved before the app closed.`,
    okLabel: 'Restore', cancelLabel: 'Keep for later',
    buttons: [{ id: 'discard', label: 'Discard backup', danger: true }],
  });
  if (r?.__button === 'discard') { clearBackup(); return false; }
  if (!r) return false;
  app.doc.load(data.style);
  app.fileName = data.fileName; app.fileHandle = null;
  // restored work is unsaved
  app.savedRev = -1;
  toast('Backup restored — save to keep it', 'ok');
  return true;
}
