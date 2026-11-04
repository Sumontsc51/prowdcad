/** Non-blocking in-app notifications (bottom centre, stacked). */
export type ToastKind = 'info' | 'warn' | 'error' | 'ok';

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host && document.body.contains(host)) return host;
  host = document.createElement('div');
  host.className = 'toast-host';
  document.body.appendChild(host);
  return host;
}

export function toast(msg: string, kind: ToastKind = 'info', ms = 2800): void {
  const h = ensureHost();
  const t = document.createElement('div');
  t.className = 'toast toast-' + kind;
  t.textContent = msg;
  h.appendChild(t);
  while (h.children.length > 4) h.removeChild(h.firstChild!);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, ms);
}
