/**
 * Size table window (Grade ▸ Size table…, or the Sizes panel): the sizes of the style in one place.
 *   · rename a size, give it a nested-view colour, choose the base size, remove a size, add a size
 *   · Import… a list of sizes (CSV / text) · Export the list as CSV
 *   · Sizes per piece: tick the sizes a piece is made in (untick = the piece does not exist in that size)
 */
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { floatingWindow, closeWindow, windowOpen, type FloatWin } from '../ui/window';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { toast } from '../ui/toast';
import { confirmDialog } from '../ui/dialog';
import { sizeColor } from '../geometry';
import { pickFiles, download } from '../actions/file';

const WIN = 'sizetable';
let win: FloatWin | null = null;
export const sizeTableOpen = () => windowOpen(WIN);

/** A size list from a file: one size per line, or one line split by commas / tabs / semicolons. `*` after a name, or a second column saying base, marks the base size. */
export function parseSizeList(text: string): { names: string[]; base: string | null } {
  const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  let rows: string[][] = lines.map(l => l.split(/[,;\t]/).map(x => x.trim()));
  if (rows.length === 1 && rows[0].length > 1 && !/^(base|\*|1|true|yes)$/i.test(rows[0][1] ?? '')) rows = rows[0].filter(Boolean).map(x => [x]);
  const names: string[] = []; let base: string | null = null;
  for (const r of rows) {
    let n = (r[0] ?? '').replace(/^"|"$/g, '').trim(); if (!n) continue;
    if (!names.length && /^(size|sizes|name|size name)$/i.test(n)) continue; // header
    let isBase = /^(base|\*|1|true|yes|x)$/i.test((r[1] ?? '').trim());
    if (/\*$/.test(n)) { isBase = true; n = n.replace(/\s*\*$/, '').trim(); }
    if (!n || names.includes(n)) continue;
    names.push(n); if (isBase) base = n;
  }
  return { names, base };
}
/** Apply a size list: sizes are renamed in order, missing ones are added at the end; sizes left over are removed only when `removeExtra`. One undo step. */
export function applySizeList(app: App, list: { names: string[]; base: string | null }, removeExtra: boolean): { renamed: number; added: number; removed: number } {
  const out = { renamed: 0, added: 0, removed: 0 };
  if (!list.names.length) throw new Error('No sizes found in the file');
  app.doc.transact('Import size table', () => {
    const line = () => app.doc.sizeLine();
    const n0 = line().sizes.length;
    // rename in two passes so a name that moves to another row does not clash
    const ids = line().sizes.map(s => s.id);
    ids.forEach((id, i) => { if (i < list.names.length && line().sizes[i].name !== list.names[i]) ops.renameSize(app.doc, id, ' ' + i + ' '); });
    ids.forEach((id, i) => { if (i < list.names.length && line().sizes[i].name !== list.names[i]) { ops.renameSize(app.doc, id, list.names[i]); out.renamed++; } });
    for (let i = n0; i < list.names.length; i++) { ops.appendSize(app.doc, list.names[i], { extrapolate: true }); out.added++; }
    if (list.base) { const b = line().sizes.find(s => s.name === list.base); if (b && b.id !== line().baseSizeId) ops.setBase(app.doc, b.id); }
    if (removeExtra) for (const s of line().sizes.slice(list.names.length)) { if (s.id === line().baseSizeId) continue; ops.removeSize(app.doc, s.id); out.removed++; }
  });
  if (!app.doc.sizeLine().sizes.some(s => s.id === app.activeSize)) app.activeSize = app.baseSize();
  return out;
}
export function sizeListCSV(app: App): string {
  const line = app.doc.sizeLine();
  return ['Size,Base', ...line.sizes.map(s => `${/[",]/.test(s.name) ? '"' + s.name.replace(/"/g, '""') + '"' : s.name},${s.id === line.baseSizeId ? 'base' : ''}`)].join('\n') + '\n';
}
/** The sizes a piece is made in: `on` = it exists in that size. All sizes ticked = no restriction. The base size always stays. */
export function setPieceSize(app: App, pieceId: string, sizeId: string, on: boolean) {
  app.doc.transact('Sizes of piece', () => {
    const p = app.doc.piece(pieceId), line = app.doc.sizeLine(p);
    const all = line.sizes.map(s => s.id);
    const cur = new Set(p.sizes ?? all);
    if (on) cur.add(sizeId); else if (sizeId !== line.baseSizeId) cur.delete(sizeId);
    const next = all.filter(id => cur.has(id));
    if (next.length === all.length) delete p.sizes; else p.sizes = next;
  });
}

async function importSizes(app: App) {
  const [f] = await pickFiles('.csv,.txt,.tsv,text/plain,text/csv'); if (!f) return;
  try {
    const list = parseSizeList(await f.text());
    if (!list.names.length) { toast('No sizes found in that file', 'warn'); return; }
    const have = app.doc.sizeLine().sizes.length;
    let removeExtra = false;
    if (list.names.length < have) removeExtra = await confirmDialog('Import size table', `The file has ${list.names.length} sizes, the style has ${have}. Remove the ${have - list.names.length} size(s) that are not in the file? (Cancel keeps them.)`, 'Remove them');
    const r = applySizeList(app, list, removeExtra);
    toast(`Size table imported · ${r.renamed} renamed · ${r.added} added${r.removed ? ` · ${r.removed} removed` : ''} · Ctrl+Z undoes`, 'ok');
  } catch (err) { reportError(err, 'Import size table'); }
  app.invalidate();
}

export function refreshSizeTable(app: App) {
  if (!win || !win.isOpen()) return;
  const a = document.activeElement as HTMLElement | null;
  if (a && win.body.contains(a) && a.tagName === 'INPUT' && (a as HTMLInputElement).type === 'text') return; // typing: keep the row
  const line = app.doc.sizeLine();
  const body = win.body; clear(body); body.classList.add('sztab');
  const safe = (label: string, fn: () => void) => { try { fn(); } catch (err) { reportError(err, label); } app.invalidate(); };
  const tb = h('table', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Size name'), h('th', {}, 'Colour'), h('th', {}, 'Base'), h('th', {}, '')));
  line.sizes.forEach((s, i) => {
    const name = h('input.szt-name', { type: 'text', value: s.name, 'data-size-id': s.id, spellcheck: 'false', title: 'Type a new name, Enter' }) as HTMLInputElement;
    const commit = () => { const v = name.value.trim(); if (!v || v === s.name) { name.value = s.name; return; } if (line.sizes.some(x => x.id !== s.id && x.name === v)) { toast(`There already is a size “${v}”`, 'warn'); name.value = s.name; return; } safe('Rename size', () => ops.renameSize(app.doc, s.id, v)); };
    name.addEventListener('change', commit);
    name.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { commit(); (name.closest('tr')?.nextElementSibling?.querySelector('input.szt-name') as HTMLInputElement | null)?.focus(); } if (e.key === 'Escape') { name.value = s.name; name.blur(); } });
    const col = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(s.color ?? '') ? s.color! : toHex(sizeColor(line, s.id)), title: 'Colour in the nested view', onchange: (e: Event) => safe('Size colour', () => app.doc.transact('Size colour', () => { s.color = (e.target as HTMLInputElement).value; })) });
    const isBase = s.id === line.baseSizeId;
    const base = h('input', { type: 'radio', name: 'szt-base', checked: isBase, title: 'Make this the base size', onchange: () => safe('Set base size', () => ops.setBase(app.doc, s.id)) });
    const del = h('button.mini', { title: isBase ? 'The base size cannot be removed' : `Remove size ${s.name}`, disabled: isBase, 'data-act': 'del', onclick: async () => { if (await confirmDialog('Remove size', `Remove size ${s.name}? Neighbouring sizes keep their geometry.`, 'Remove')) safe('Remove size', () => { ops.removeSize(app.doc, s.id); if (app.activeSize === s.id) app.activeSize = app.baseSize(); }); } }, '✕');
    tb.append(h('tr', { 'data-size': s.name }, h('td.dim', {}, String(i + 1)), h('td', {}, name), h('td', {}, col), h('td', {}, base), h('td', {}, del)));
  });
  body.append(tb);
  const add = h('input.szt-name', { type: 'text', placeholder: 'New size name', 'data-act': 'new-name', spellcheck: 'false' }) as HTMLInputElement;
  const doAdd = () => { const v = add.value.trim(); if (!v) { add.focus(); return; } if (line.sizes.some(x => x.name === v)) { toast(`There already is a size “${v}”`, 'warn'); return; } add.value = ''; safe('Add size', () => { ops.appendSize(app.doc, v, { extrapolate: true }); }); };
  add.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') doAdd(); });
  body.append(h('div.szt-add', {}, add, h('button.btn.sm', { 'data-act': 'add', title: 'Add this size after the last one (its grading continues the last step)', onclick: doAdd }, '+ Add size')));
  // sizes per piece
  const sec = h('div.szt-sec', {}, h('div', {}, h('b', {}, 'Sizes per piece'), h('span.dim', {}, '  ·  untick a size and the piece is not made in it')));
  const pieces = app.sel.pieces.length ? app.doc.style.pieces.filter(p => app.sel.pieces.includes(p.id)) : app.doc.style.pieces;
  if (!pieces.length) sec.append(h('div.dim', {}, 'No pieces yet.'));
  for (const p of pieces.slice(0, 40)) {
    const pl = app.doc.sizeLine(p), has = new Set(p.sizes ?? pl.sizes.map(s => s.id));
    const row = h('div.szt-pc', { 'data-piece': p.name }, h('b', {}, p.name));
    for (const s of pl.sizes) row.append(h('label.chk', { title: s.id === pl.baseSizeId ? 'The base size always stays' : '' }, h('input', { type: 'checkbox', checked: has.has(s.id), disabled: s.id === pl.baseSizeId || p.locked, 'data-size': s.name, onchange: (e: Event) => safe('Sizes of piece', () => setPieceSize(app, p.id, s.id, (e.target as HTMLInputElement).checked)) }), ' ' + s.name));
    if (p.sizes) row.append(h('button.mini', { title: 'Every size again', onclick: () => safe('Sizes of piece', () => app.doc.transact('Sizes of piece', () => { delete app.doc.piece(p.id).sizes; })) }, 'all'));
    sec.append(row);
  }
  if (app.sel.pieces.length) sec.append(h('div.dim', {}, 'Showing the selected piece(s). Deselect to see every piece.'));
  body.append(sec);
  clear(win.foot);
  win.foot.append(
    h('button.btn.sm', { 'data-act': 'import', title: 'A CSV or text file: one size per line (or one line: XS, S, M, L). “*” after a name marks the base. Sizes are renamed in order; new ones are added.', onclick: () => void importSizes(app) }, 'Import…'),
    h('button.btn.sm', { 'data-act': 'export', title: 'Save the size names as a CSV file (opens in Excel)', onclick: () => { download(`${app.style.name || 'style'}-sizes.csv`, new Blob([sizeListCSV(app)], { type: 'text/csv' })); toast('Size table exported', 'ok'); } }, 'Export'),
    h('span.spacer'), h('span.dim', {}, `${line.sizes.length} sizes · base ${line.sizes.find(s => s.id === line.baseSizeId)?.name ?? ''}`));
}
function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c); if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  try { const d = document.createElement('canvas').getContext('2d')!; d.fillStyle = c; const v = d.fillStyle; return /^#[0-9a-f]{6}$/i.test(v) ? v : '#888888'; } catch { return '#888888'; }
}
export function openSizeTable(app: App) {
  if (win?.isOpen()) { closeWindow(WIN); return; }
  win = floatingWindow(WIN, 'Size table', { width: 430, cls: 'sztwin', onClose: () => { win = null; } });
  refreshSizeTable(app);
}
