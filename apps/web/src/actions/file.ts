/**
 * File handling: New, Open / Save / Save As native JSON through the kernel's io/native
 * (validation + migrations; File System Access API when available, else <input type=file> /
 * download), Import (DXF + .rul pair, SVG with DPI, PLT/HPGL with plotter profile) with an import
 * report dialog, Exports (DXF/AAMA/ASTM + .rul, SVG, PLT, tiled 1:1 PDF, size as standalone),
 * Merge from another style, preview thumbnail (SVG → PNG into style.meta.previewPng),
 * 30-second auto-backup to localStorage with crash recovery on load.
 */
import { makeStyle, makePiece, rectangleContour, type Style, type SizeId, type Id, type PlotterProfile, type importDXF } from '@prowdcad/kernel';
type ImportReport = ReturnType<typeof importDXF>;
import type { App } from '../app';
import { showDialog, confirmDialog, rememberedDialog, alertDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { store } from '../settings';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { h } from '../ui/dom';

const BACKUP_KEY = 'prowdcad.web.backup';
const SESSION_KEY = 'prowdcad.web.session';

type FSHandle = { name: string; createWritable(): Promise<{ write(d: Blob | string): Promise<void>; close(): Promise<void> }>; getFile?(): Promise<File> };
interface FSWindow {
  showOpenFilePicker?: (o: unknown) => Promise<FSHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FSHandle>;
}
const W = window as unknown as FSWindow;
const PICKER_TYPES = [{ description: 'ProwdCAD style', accept: { 'application/json': ['.prowd.json', '.prowd', '.json'] } }];

/** Hook for tests / headless runs: when set, downloads are captured instead of clicked. */
export const downloadSink: { capture?: (name: string, blob: Blob) => void } = {};

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
    const w = r.w as number, hh = r.h as number;
    const p = makePiece('BLOCK', rectangleContour(0, 0, w, hh), style.activeSizeTableId, { seamDefault: r.seam as number });
    p.grain = { a: { x: w / 2, y: hh * 0.2 }, b: { x: w / 2, y: hh * 0.8 }, gradeA: {}, gradeB: {}, centered: true };
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

/** Pick one or more files (File System Access API not needed for reading). */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.multiple = multiple;
    inp.onchange = () => resolve([...(inp.files ?? [])]);
    inp.addEventListener('cancel', () => resolve([]));
    inp.click();
  });
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
  const [f] = await pickFiles('.json,.prowd,.prowd.json,.wptn,application/json');
  if (f) readInto(app, await f.text(), f.name, null);
}

export function readInto(app: App, text: string, name: string, handle: unknown) {
  try {
    const res = ops.loadNative(text);
    loadStyle(app, res.style, name, handle);
    toast(`Opened ${name}${res.migratedFrom ? ` (migrated from ${res.migratedFrom})` : ''}`, 'ok');
    if (res.warnings.length) void alertDialog('Open — warnings', res.warnings.join('\n'));
  } catch (err) {
    const probs = (err as { problems?: string[] }).problems;
    if (probs?.length) void alertDialog('Cannot open file', probs.slice(0, 30).join('\n'));
    else reportError(err, 'Open');
  }
}

export async function saveFile(app: App, saveAs = false) {
  await attachPreview(app, true);
  const json = ops.saveNative(app.doc, { pretty: true });
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
    if (!/\.json$|\.prowd$/i.test(n)) n += '.prowd.json';
    app.fileName = n;
  }
  download(app.fileName, new Blob([json], { type: 'application/json' }));
  app.markSaved(); clearBackup();
  toast(`Downloaded ${app.fileName}`, 'ok');
}

export function download(name: string, blob: Blob) {
  if (downloadSink.capture) { downloadSink.capture(name, blob); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const baseName = (app: App) => app.fileName.replace(/\.prowd\.json$|\.json$|\.prowd$/i, '');

// ───────────── preview thumbnail ─────────────

/** Render the style (active size) to SVG, rasterise to a 256-px PNG and store it in style.meta.previewPng. */
export async function attachPreview(app: App, quiet = false): Promise<void> {
  if (!app.style.pieces.length) return;
  try {
    const svg = ops.exportSVG(app.doc, { sizes: [app.activeSize], labels: false, layout: 'none', stroke: 1.2 });
    const png = await svgToPng(svg, 256);
    if (!png || png === app.style.meta.previewPng) return;
    const dirty = app.isDirty();
    app.doc.transact('Attach preview', s => { s.meta.previewPng = png; });
    if (!dirty) app.markSaved();
    if (!quiet) toast('Preview thumbnail attached', 'ok');
  } catch (err) { if (!quiet) reportError(err, 'Preview'); else console.warn('preview failed', err); }
}

function svgToPng(svg: string, max: number): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const done = (v: string | null) => { URL.revokeObjectURL(url); resolve(v); };
    img.onload = () => {
      try {
        const w0 = img.naturalWidth || 300, h0 = img.naturalHeight || 300;
        const k = max / Math.max(w0, h0);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
        const g = c.getContext('2d'); if (!g) return done(null);
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        done(c.toDataURL('image/png'));
      } catch { done(null); }
    };
    img.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    img.src = url;
  });
}

// ───────────── export ─────────────

const SIZE_SCOPE = [{ value: 'active', label: 'Active size' }, { value: 'all', label: 'All sizes (nest)' }, { value: 'base', label: 'Base size' }];
function sizesFor(app: App, scope: string): SizeId[] {
  const line = app.sizeLine();
  if (scope === 'all') return line.sizes.map(s => s.id);
  if (scope === 'base') return [line.baseSizeId];
  return [app.activeSize];
}
const pieceScope = (app: App) => [{ value: 'all', label: `All pieces (${app.style.pieces.length})` }, ...(app.sel.pieces.length ? [{ value: 'sel', label: `Selected (${app.sel.pieces.length})` }] : [])];
const piecesFor = (app: App, scope: string): Id[] | undefined => scope === 'sel' && app.sel.pieces.length ? app.sel.pieces.slice() : undefined;

export async function exportDXF(app: App) {
  const r = await rememberedDialog('export.dxf', {
    title: 'Export DXF', fields: [
      { kind: 'select', key: 'flavor', label: 'Flavor', value: 'aama', options: [{ value: 'aama', label: 'AAMA-292' }, { value: 'astm', label: 'ASTM D6673' }] },
      { kind: 'select', key: 'units', label: 'Units', value: 'mm', options: [{ value: 'mm', label: 'mm' }, { value: 'in', label: 'inch' }] },
      { kind: 'select', key: 'pieces', label: 'Pieces', value: app.sel.pieces.length ? 'sel' : 'all', options: pieceScope(app) },
      { kind: 'checkbox', key: 'nested', label: 'Nested graded export (one block per size, no .rul)', value: false },
      { kind: 'select', key: 'layout', label: 'Layout', value: 'none', options: [{ value: 'none', label: 'Drafting positions' }, { value: 'pack', label: 'Pack left → right' }] },
      { kind: 'checkbox', key: 'markers', label: 'Turn / curve point markers (layers 2/3)', value: true },
    ],
  });
  if (!r) return;
  const res = ops.exportDXF(app.doc, {
    flavor: r.flavor as 'aama' | 'astm', units: r.units as 'mm' | 'in', pieceIds: piecesFor(app, String(r.pieces)),
    nested: !!r.nested, layout: r.layout as 'none' | 'pack', pointMarkers: !!r.markers, styleName: app.style.name,
  });
  const b = baseName(app);
  download(`${b}.dxf`, new Blob([res.dxf], { type: 'application/dxf' }));
  if (res.rul) download(`${b}.rul`, new Blob([res.rul], { type: 'text/plain' }));
  toast(`Exported ${b}.dxf${res.rul ? ` + ${b}.rul (${res.rules.size} rules)` : ''}`, 'ok');
}

export async function exportSVGFile(app: App) {
  const r = await rememberedDialog('export.svg', {
    title: 'Export SVG', fields: [
      { kind: 'select', key: 'pieces', label: 'Pieces', value: app.sel.pieces.length ? 'sel' : 'all', options: pieceScope(app) },
      { kind: 'select', key: 'sizes', label: 'Sizes', value: app.nested ? 'all' : 'active', options: SIZE_SCOPE },
      { kind: 'select', key: 'layout', label: 'Layout', value: 'pack', options: [{ value: 'pack', label: 'Pack' }, { value: 'none', label: 'Drafting positions' }] },
      { kind: 'checkbox', key: 'labels', label: 'Labels', value: true },
      { kind: 'checkbox', key: 'curves', label: 'Bézier curves (C commands)', value: true },
    ],
  });
  if (!r) return;
  const svg = ops.exportSVG(app.doc, { pieceIds: piecesFor(app, String(r.pieces)), sizes: sizesFor(app, String(r.sizes)), layout: r.layout as 'pack' | 'none', labels: !!r.labels, curves: !!r.curves });
  download(`${baseName(app)}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
  toast(`Exported ${baseName(app)}.svg`, 'ok');
}

async function plotterProfileDialog(title: string, withFrame: boolean): Promise<Partial<PlotterProfile> | null> {
  const r = await rememberedDialog('plt.profile', {
    title, message: 'Device profile (HP-GL).', fields: [
      { kind: 'number', key: 'upm', label: 'Plotter units per mm', value: 40, min: 1 },
      ...(withFrame ? [{ kind: 'length' as const, key: 'frame', label: 'Paper / fabric width (0 = none)', value: 0, min: 0 }] : []),
      { kind: 'select', key: 'notch', label: 'Notch code', value: 'line', options: [{ value: 'line', label: 'Separate stroke' }, { value: 'spike', label: 'Spike in cut path' }, { value: 'none', label: 'None' }] },
      { kind: 'number', key: 'penCut', label: 'Pen: cut', value: 1, min: 0 },
      { kind: 'number', key: 'penSew', label: 'Pen: sew / internal', value: 2, min: 0 },
      { kind: 'checkbox', key: 'sew', label: 'Write sew lines', value: true },
      { kind: 'length', key: 'text', label: 'Label height', value: 5, min: 0.5 },
    ],
  });
  if (!r) return null;
  return {
    unitsPerMm: r.upm as number, frameWidth: withFrame && (r.frame as number) > 0 ? r.frame as number : undefined,
    notchCode: r.notch as 'line' | 'spike' | 'none', pens: { cut: r.penCut as number, sew: r.penSew as number, internal: r.penSew as number },
    sew: !!r.sew, textHeight: r.text as number,
  };
}

export async function exportPLT(app: App) {
  const prof = await plotterProfileDialog('Export PLT (HPGL)', true); if (!prof) return;
  const r = await rememberedDialog('export.plt', {
    title: 'Export PLT', fields: [
      { kind: 'select', key: 'pieces', label: 'Pieces', value: app.sel.pieces.length ? 'sel' : 'all', options: pieceScope(app) },
      { kind: 'select', key: 'sizes', label: 'Sizes', value: 'active', options: SIZE_SCOPE },
      { kind: 'select', key: 'layout', label: 'Layout', value: 'pack', options: [{ value: 'pack', label: 'Pack' }, { value: 'none', label: 'Drafting positions' }] },
      { kind: 'checkbox', key: 'labels', label: 'Labels (name + size)', value: true },
    ],
  });
  if (!r) return;
  const plt = ops.exportHPGL(app.doc, { pieceIds: piecesFor(app, String(r.pieces)), sizes: sizesFor(app, String(r.sizes)), profile: prof, layout: r.layout as 'pack' | 'none', labels: !!r.labels });
  download(`${baseName(app)}.plt`, new Blob([plt], { type: 'application/vnd.hp-hpgl' }));
  toast(`Exported ${baseName(app)}.plt`, 'ok');
}

export async function exportPDFFile(app: App) {
  const r = await rememberedDialog('export.pdf', {
    title: 'Export tiled PDF (1:1)', fields: [
      { kind: 'select', key: 'page', label: 'Page size', value: 'A4', options: ['A4', 'A3', 'A2', 'A1', 'A0', 'Letter', 'Legal', 'Tabloid'].map(v => ({ value: v, label: v })) },
      { kind: 'select', key: 'orient', label: 'Orientation', value: 'portrait', options: [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }] },
      { kind: 'length', key: 'margin', label: 'Margin', value: 10, min: 0 },
      { kind: 'length', key: 'overlap', label: 'Glue overlap', value: 10, min: 0 },
      { kind: 'select', key: 'pieces', label: 'Pieces', value: app.sel.pieces.length ? 'sel' : 'all', options: pieceScope(app) },
      { kind: 'select', key: 'sizes', label: 'Sizes', value: app.nested ? 'all' : 'active', options: SIZE_SCOPE },
      { kind: 'checkbox', key: 'square', label: '100 × 100 mm calibration square', value: true },
      { kind: 'checkbox', key: 'sew', label: 'Draw sew line', value: true },
    ],
  });
  if (!r) return;
  const sizes = sizesFor(app, String(r.sizes));
  const res = ops.exportPDF(app.doc, {
    pieceIds: piecesFor(app, String(r.pieces)), sizes, mode: sizes.length > 1 ? 'nested' : 'single',
    page: String(r.page), orientation: r.orient as 'portrait' | 'landscape', margin: r.margin as number, overlap: r.overlap as number,
    referenceSquare: !!r.square, sew: !!r.sew, title: app.style.name,
  });
  download(`${baseName(app)}.pdf`, new Blob([res.bytes as BlobPart], { type: 'application/pdf' }));
  toast(`Exported ${baseName(app)}.pdf — ${res.pages} page(s), ${res.cols}×${res.rows}`, 'ok');
}

export async function exportStandalone(app: App) {
  const p = app.primaryPiece(); if (!p) throw new Error('Select a piece');
  const line = app.sizeLine();
  const r = await showDialog({ title: 'Export size as standalone style', fields: [{ kind: 'select', key: 's', label: 'Size', value: app.activeSize, options: app.doc.sizesOf(p).map(id => ({ value: id, label: line.sizes.find(s => s.id === id)?.name ?? id })) }] });
  if (!r) return;
  const st = ops.exportSizeAsStandalone(app.doc, p.id, String(r.s));
  const name = `${p.name}_${line.sizes.find(s => s.id === r.s)?.name}.prowd.json`;
  download(name, new Blob([ops.saveNative(st, { pretty: true })], { type: 'application/json' }));
  toast(`Exported ${name}`, 'ok');
}

// ───────────── import ─────────────

export async function importFile(app: App) {
  const files = await pickFiles('.dxf,.rul,.svg,.plt,.hpgl,.hpg,.aama,.astm', true);
  if (!files.length) return;
  const dxf = files.filter(f => /\.(dxf|aama|astm)$/i.test(f.name));
  const ruls = files.filter(f => /\.rul$/i.test(f.name));
  const svgs = files.filter(f => /\.svg$/i.test(f.name));
  const plts = files.filter(f => /\.(plt|hpgl|hpg)$/i.test(f.name));
  try {
    for (const f of dxf) {
      const stem = f.name.replace(/\.[^.]+$/, '').toLowerCase();
      let rulF = ruls.find(x => x.name.replace(/\.[^.]+$/, '').toLowerCase() === stem) ?? (dxf.length === 1 ? ruls[0] : undefined);
      const r = await rememberedDialog('import.dxf', {
        title: `Import ${f.name}`, message: rulF ? `Grade rules: ${rulF.name}` : 'No companion .rul selected (select both files together to pair them).',
        fields: [
          { kind: 'select', key: 'units', label: 'Units', value: 'auto', options: [{ value: 'auto', label: 'Auto ($INSUNITS / heuristic)' }, { value: 'mm', label: 'mm' }, { value: 'cm', label: 'cm' }, { value: 'in', label: 'inch' }] },
          { kind: 'checkbox', key: 'flip', label: 'Flip Y (file from a y-down system)', value: false },
          { kind: 'checkbox', key: 'merge', label: 'Merge size blocks into graded pieces', value: true },
          { kind: 'number', key: 'corner', label: 'Corner angle threshold', value: 30, min: 1, max: 179, suffix: '°' },
        ],
      });
      if (!r) continue;
      const rep = ops.importDXF(await f.text(), { rul: rulF ? await rulF.text() : undefined, units: r.units === 'auto' ? undefined : r.units as 'mm' | 'cm' | 'in', flipY: !!r.flip, mergeSizes: !!r.merge, cornerAngleDeg: r.corner as number });
      await commitImport(app, f.name + (rulF ? ` + ${rulF.name}` : ''), rep);
      rulF = undefined;
    }
    for (const f of svgs) {
      const r = await rememberedDialog('import.svg', {
        title: `Import ${f.name}`, message: 'Pixel / unit-less coordinates are converted with the DPI below (ignored when the SVG declares a physical width + viewBox).',
        fields: [
          { kind: 'number', key: 'dpi', label: 'DPI (px per inch)', value: 96, min: 1 },
          { kind: 'checkbox', key: 'mm', label: 'User units are mm', value: false },
          { kind: 'length', key: 'notch', label: 'Max notch length', value: 15, min: 0 },
          { kind: 'number', key: 'corner', label: 'Corner angle threshold', value: 30, min: 1, max: 179, suffix: '°' },
        ],
      });
      if (!r) continue;
      const rep = ops.importSVG(await f.text(), { dpi: r.dpi as number, unitsAreMm: !!r.mm, maxNotchLength: r.notch as number, cornerAngleDeg: r.corner as number });
      await commitImport(app, f.name, rep);
    }
    for (const f of plts) {
      const prof = await plotterProfileDialog(`Import ${f.name}`, false); if (!prof) continue;
      const rep = ops.importHPGL(await f.text(), { profile: prof });
      await commitImport(app, f.name, rep);
    }
    if (ruls.length && !dxf.length) toast('A .rul file is imported together with its DXF (select both)', 'warn', 4000);
  } catch (err) { reportError(err, 'Import'); }
}

/** Import report dialog → add pieces (+ rule library) to the document. */
async function commitImport(app: App, name: string, rep: ImportReport) {
  const layers = Object.entries(rep.layerMap).map(([l, i]) => `  ${l.padEnd(10)} ${i.role.padEnd(12)} ${i.entities}`).join('\n');
  const msg = [
    `${rep.pieces.length} piece(s): ${rep.pieces.map(p => p.name).join(', ') || '—'}`,
    `Units: ${rep.unitsDetected} (${rep.unitsSource})${rep.yFlipped ? ' · y flipped' : ''}`,
    `Sizes: ${rep.sizeLine.sizes.map(s => s.name).join(' ')} (base ${rep.sizeLine.sizes.find(s => s.id === rep.sizeLine.baseSizeId)?.name ?? '?'})`,
    rep.ruleLibrary ? `Rule library: ${rep.ruleLibrary.rules.length} rules` : '',
    rep.unresolvedRules?.length ? `Unresolved rules: ${rep.unresolvedRules.join(', ')}` : '',
    layers ? `Layers:\n${layers}` : '',
    rep.notes.length ? `Notes:\n  ${rep.notes.join('\n  ')}` : '',
    rep.warnings.length ? `Warnings:\n  ${rep.warnings.join('\n  ')}` : '',
  ].filter(Boolean).join('\n');
  if (!rep.pieces.length) { await alertDialog(`Import ${name} — nothing to import`, msg); return; }
  const ok = await showDialog({ title: `Import report — ${name}`, message: msg, okLabel: `Add ${rep.pieces.length} piece(s)`, wide: true });
  if (!ok) return;
  app.doc.transact(`Import ${name}`, s => {
    const added = ops.addImportToDocument(app.doc, rep);
    if (rep.ruleLibrary) s.ruleLibraries.push(JSON.parse(JSON.stringify(rep.ruleLibrary)));
    app.sel = { pieces: added.map(p => p.id), anchors: [] };
  });
  toast(`Imported ${rep.pieces.length} piece(s) from ${name}`, 'ok');
  requestAnimationFrame(() => (app as App & { zoomFit?: () => void }).zoomFit?.());
}

// ───────────── merge from another style ─────────────

export async function mergeFromFile(app: App) {
  const [f] = await pickFiles('.json,.prowd,.prowd.json,.wptn,application/json');
  if (!f) return;
  const other = ops.loadNative(await f.text()).style;
  if (!other.pieces.length) throw new Error('That style has no pieces');
  const r = await showDialog({
    title: `Merge from ${f.name}`, message: 'Pieces to copy. Sizes are mapped by name.',
    fields: other.pieces.map(p => ({ kind: 'checkbox' as const, key: p.id, label: p.name, value: true })),
  });
  if (!r) return;
  const ids = other.pieces.filter(p => r[p.id]).map(p => p.id);
  if (!ids.length) return;
  const mine = app.sizeLine();
  const map: Record<SizeId, SizeId> = {};
  const unmapped: string[] = [];
  for (const t of other.sizeTables) for (const s of t.axis1.sizes) { const m = mine.sizes.find(x => x.name === s.name); if (m) map[s.id] = m.id; else unmapped.push(s.name); }
  const added = ops.mergeFromStyle(app.doc, other, ids, map);
  app.sel = { pieces: added, anchors: [] };
  toast(`Merged ${added.length} piece(s)${unmapped.length ? ` · unmapped sizes: ${[...new Set(unmapped)].join(' ')}` : ''}`, 'ok', 4500);
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
  app.savedRev = -1;
  toast('Backup restored — save to keep it', 'ok');
  return true;
}

export { h };
