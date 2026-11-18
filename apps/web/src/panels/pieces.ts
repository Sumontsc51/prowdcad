/** Piece list: select (Shift/Ctrl = multi), visibility toggle, lock, double-click to rename, zoom to piece. */
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { showDialog } from '../ui/dialog';
import { resolveFor, toWorld } from '../geometry';
import type { Piece } from '@prowdcad/kernel';

/** Small picture of a piece as it lies on the sheet (active size): cut line faint, sew line in the piece colour. */
export function pieceThumb(app: App, p: Piece, px = 30): string {
  try {
    const r = resolveFor(app.doc, p, app.sizeOf(p));
    const W = (pts: { x: number; y: number }[]) => pts.map(q => toWorld(p, q));
    const sew = W(r.sew.pts), cut = r.cut.length > 2 && !p.noSeam ? W(r.cut) : [];
    const all = cut.length ? cut : sew; if (all.length < 2) return '';
    const xs = all.map(q => q.x), ys = all.map(q => q.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const span = Math.max(x1 - x0, y1 - y0, 1e-6), pad = span * 0.06, k = span / px;
    const d = (pts: { x: number; y: number }[]) => pts.map((q, i) => `${i ? 'L' : 'M'}${(q.x - x0).toFixed(1)} ${(y1 - q.y).toFixed(1)}`).join('') + 'Z';
    const col = /^#[0-9a-f]{6}$/i.test(p.color ?? '') ? p.color! : '#4ea1ff';
    const ox = (span - (x1 - x0)) / 2, oy = (span - (y1 - y0)) / 2;
    return `<svg class="pthumb" viewBox="${(-pad - ox).toFixed(1)} ${(-pad - oy).toFixed(1)} ${(span + 2 * pad).toFixed(1)} ${(span + 2 * pad).toFixed(1)}" width="${px}" height="${px}" aria-hidden="true">`
      + (cut.length ? `<path d="${d(cut)}" fill="${col}" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.45" stroke-width="${(k * 0.7).toFixed(2)}"/>` : '')
      + `<path d="${d(sew)}" fill="${col}" fill-opacity="0.28" stroke="${col}" stroke-width="${(k * 1.2).toFixed(2)}" stroke-linejoin="round"/></svg>`;
  } catch { return ''; }
}

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
    const pic = h('span.ppic', { title: 'Double-click the row to rename · click to select' }); pic.innerHTML = pieceThumb(app, p);
    const sub = [p.description?.trim(), p.order?.material && p.order.material !== 'SELF' ? p.order.material : '', p.order?.qtyPerBundle > 1 ? `×${p.order.qtyPerBundle}` : ''].filter(Boolean).join(' · ');
    item.append(pic, h('span.pname', {}, h('span.pn', {}, p.name), sub ? h('span.psub', {}, sub) : ''), eye, lock, zoom);
    item.onclick = e => app.selectPiece(p.id, e.shiftKey || e.ctrlKey || e.metaKey);
    item.ondblclick = async () => {
      const r = await showDialog({ title: 'Rename piece', fields: [{ kind: 'text', key: 'n', label: 'Name', value: p.name }] });
      if (r && String(r.n).trim()) app.doc.transact('Rename piece', () => { app.doc.piece(p.id).name = String(r.n).trim(); });
    };
    list.append(item);
  });
  host.append(list);
}
