/** Tiny DOM helpers (no framework). */
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const e = root.querySelector(sel);
  if (!e) throw new Error('Missing element ' + sel);
  return e as unknown as T;
};

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** h('div.cls#id', {attr, onclick}, ...children) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K | string, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const name = m?.[1] || 'div';
  const el = document.createElement(name);
  if (m?.[2]) for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }

/** True when keyboard focus is in an editable control (hotkeys must not fire). */
export function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  const t = a.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || a.isContentEditable;
}

/**
 * Manual double-click detector. The canvas re-renders between the two clicks of a
 * double-click, so the browser never synthesises a native `dblclick` (both clicks must hit the
 * same DOM node). Detect it by time (≤450 ms), distance (≤7 px) and a logical target key.
 */
export class DoubleClick {
  private last: { t: number; x: number; y: number; key: string } | null = null;
  constructor(public ms = 450, public px = 7) {}
  /** Register a click; returns true when it completes a double-click. */
  hit(x: number, y: number, key = ''): boolean {
    const now = performance.now();
    const l = this.last;
    if (l && now - l.t <= this.ms && Math.hypot(x - l.x, y - l.y) <= this.px && l.key === key) {
      this.last = null;
      return true;
    }
    this.last = { t: now, x, y, key };
    return false;
  }
  reset() { this.last = null; }
}
