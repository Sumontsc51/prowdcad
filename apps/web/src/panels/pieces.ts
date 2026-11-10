/** Piece list: select (Shift/Ctrl = multi), visibility toggle, lock, double-click to rename, zoom to piece. */
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { showDialog } from '../ui/dialog';

export function renderPieces(app: App, host: HTMLElement, zoomTo: (ids: string[]) => void) {
  clear(host);
  const ps = app.style.pieces;
  if (!ps.length) { host.append(h('div.empty', {}, 'No pieces. Use Pen (P), Rectangle (R) or File ▸ New.')); return; }
  const list = h('div.plist');
  ps.forEach(p => {
    const sel = app.sel.pieces.includes(p.id);
    const hidden = app.hiddenPieces.has(p.id);
    const item = h('div.pitem' + (sel ? '.sel' : '') + (hidden ? '.hidden' : ''));
    const eye = h('button.mini', { title: hidden ? 'Show' : 'Hide' }, hidden ? '◌' : '●');
    eye.onclick = e => { e.stopPropagation(); if (hidden) app.hiddenPieces.delete(p.id); else app.hiddenPieces.add(p.id); app.invalidate(); };
    const lock = h('button.mini', { title: p.locked ? 'Unlock' : 'Lock' }, p.locked ? '🔒' : '·');
    lock.textContent = p.locked ? 'L' : '·';
    lock.onclick = e => { e.stopPropagation(); app.doc.transact(p.locked ? 'Unlock piece' : 'Lock piece', () => { app.doc.piece(p.id).locked = !p.locked; }); };
    const zoom = h('button.mini', { title: 'Zoom to piece' }, '⤢');
    zoom.onclick = e => { e.stopPropagation(); zoomTo([p.id]); };
    item.append(eye, h('span.pname', {}, p.name), h('span.pmeta', {}, `${p.sew.points.length} pt`), lock, zoom);
    item.onclick = e => app.selectPiece(p.id, e.shiftKey || e.ctrlKey || e.metaKey);
    item.ondblclick = async () => {
      const r = await showDialog({ title: 'Rename piece', fields: [{ kind: 'text', key: 'n', label: 'Name', value: p.name }] });
      if (r && String(r.n).trim()) app.doc.transact('Rename piece', () => { app.doc.piece(p.id).name = String(r.n).trim(); });
    };
    list.append(item);
  });
  host.append(list);
}
