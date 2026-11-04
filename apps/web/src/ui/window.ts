/**
 * Non-modal floating windows (Compare Length, Notch grid, Measure results…). Draggable by the
 * title bar (pointer capture in try/catch), one instance per id, closed with × or Esc when focused.
 * Content is rebuilt by calling the returned `render()`; inputs inside keep keyboard focus because
 * key events are stopped at the window boundary.
 */
import { h, clear } from './dom';

export interface FloatWin { el: HTMLElement; body: HTMLElement; foot: HTMLElement; close(): void; setTitle(t: string): void; isOpen(): boolean }

const open = new Map<string, FloatWin>();

export function floatingWindow(id: string, title: string, opt: { width?: number; onClose?: () => void; x?: number; y?: number } = {}): FloatWin {
  const existing = open.get(id);
  if (existing) { existing.setTitle(title); return existing; }
  const titleEl = h('span.fw-title', {}, title);
  const closeBtn = h('button.fw-x', { title: 'Close' }, '×');
  const head = h('div.fw-head', {}, titleEl, h('span.spacer'), closeBtn);
  const body = h('div.fw-body');
  const foot = h('div.fw-foot');
  const el = h('div.fwin', { 'data-win': id }, head, body, foot);
  el.style.width = (opt.width ?? 420) + 'px';
  el.style.left = (opt.x ?? Math.max(60, window.innerWidth - (opt.width ?? 420) - 330)) + 'px';
  el.style.top = (opt.y ?? 70 + open.size * 28) + 'px';
  let isOpen = true;
  const win: FloatWin = {
    el, body, foot,
    close() { if (!isOpen) return; isOpen = false; el.remove(); open.delete(id); opt.onClose?.(); },
    setTitle(t: string) { titleEl.textContent = t; },
    isOpen: () => isOpen,
  };
  closeBtn.onclick = () => win.close();
  // drag by the head
  let drag: { dx: number; dy: number; id: number } | null = null;
  head.addEventListener('pointerdown', e => {
    if ((e.target as Element).closest('button')) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  head.addEventListener('pointermove', e => {
    if (!drag) return;
    el.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.dx)) + 'px';
    el.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.dy)) + 'px';
  });
  const end = (e: PointerEvent) => { if (!drag) return; drag = null; try { head.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
  el.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); win.close(); }
    e.stopPropagation();
  });
  document.body.append(el);
  open.set(id, win);
  return win;
}

export function closeWindow(id: string) { open.get(id)?.close(); }
export function windowOpen(id: string) { return open.has(id); }

/** Simple HTML table from rows. */
export function table(head: string[], rows: (string | number | HTMLElement)[][], cls = 'fw-table'): HTMLElement {
  const t = h('table.' + cls);
  t.append(h('tr', {}, ...head.map(x => h('th', {}, x))));
  for (const r of rows) t.append(h('tr', {}, ...r.map(c => h('td', {}, c instanceof HTMLElement ? c : String(c)))));
  return t;
}

export { clear };
