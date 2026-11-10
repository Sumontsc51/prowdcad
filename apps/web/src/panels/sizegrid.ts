/**
 * Size grid: the one per-size table of the app — ROWS = sizes (1…80+), columns = values.
 * Used by the grading table, the Grade Rules window, the Measure window, the spec entry of Grade
 * by measurement and the notch grid.
 *
 * - Sticky header (two lines: group + column) and sticky size column; base size ★, active size row
 *   highlighted, optional break marker per row.
 * - Row virtualisation above VIRT rows (fixed row height), so 80 sizes render and scroll fast.
 * - Keyboard (Excel-like): arrows move the cell (←/→ only at the text edge), Enter commits and moves
 *   down (Shift+Enter up), Tab / Shift+Tab next / previous editable cell, Esc reverts.
 * - Paste: a TSV block from Excel lands from the focused cell into consecutive size rows (and the
 *   columns to the right); values landing on read-only cells (base row) are skipped.
 * - Values are typed in the display unit, decimals or fractions (units-ui parseLen).
 */
import { h, clear } from '../ui/dom';
import { fmt, parseLen } from '../units-ui';
import { toast } from '../ui/toast';

export interface SGRow { id: string; name: string; base?: boolean; active?: boolean; brk?: boolean }
export interface SGCol {
  key: string;
  head: string;
  /** first header line; consecutive columns with the same group share one cell */
  group?: string;
  groupTitle?: string;
  title?: string;
  edit?: boolean;
  /** value in mm (null = blank) */
  get(r: number): number | null;
  /** custom display text (read-only columns) */
  text?(r: number): string;
  /** extra cell class (pass / fail / typed …) */
  cls?(r: number): string;
  /** cell not editable in this row (e.g. base size) */
  ro?(r: number): boolean;
  /** extra attributes for the cell input / td (data-* for tests and styling) */
  attrs?: Record<string, string>;
  /** number formatter for read-only cells (default fmt) */
  format?(v: number): string;
}
export interface SGState { scrollTop: number; focus?: { r: number; c: number } }
export interface SGOpts {
  rows: SGRow[];
  cols: SGCol[];
  /** batch commit (one undo step for a paste); values in mm */
  onCommit?(cells: { r: number; c: number; v: number }[]): void;
  /** focus moved to a cell (affected-sizes indicator) */
  onFocus?(r: number, c: number): void;
  /** live value while typing (null = not a valid number yet) — preview strips */
  onInput?(r: number, c: number, v: number | null): void;
  /** click on a size name */
  onRowClick?(r: number): void;
  /** row header extra (break toggle …) */
  rowExtra?(r: number): HTMLElement | null;
  rowClass?(r: number): string;
  rowHead?: string;
  maxHeight?: number;
  state?: SGState;
  cls?: string;
}

export const ROW_H = 22;
export const VIRT = 40;

export interface SizeGrid { el: HTMLElement; refresh(): void; focusCell(r: number, c: number): void; table: HTMLTableElement }

export function sizeGrid(o: SGOpts): SizeGrid {
  const st = o.state ?? { scrollTop: 0 };
  const virt = o.rows.length > VIRT;
  const wrap = h('div.sg-wrap' + (o.cls ? '.' + o.cls : ''), { 'data-rows': String(o.rows.length) });
  if (o.maxHeight) wrap.style.maxHeight = o.maxHeight + 'px';
  const tbl = h('table.sg') as HTMLTableElement;
  const thead = h('thead'), tbody = h('tbody');
  // header
  const hasGroups = o.cols.some(c => c.group);
  const h1 = h('tr'), h2 = h('tr');
  h1.append(h('th.sg-rh', { rowspan: hasGroups ? 2 : 1 }, o.rowHead ?? 'Size'));
  if (hasGroups) {
    let i = 0;
    while (i < o.cols.length) {
      const g = o.cols[i].group ?? '';
      let j = i; while (j < o.cols.length && (o.cols[j].group ?? '') === g) j++;
      h1.append(h('th.sg-g', { colspan: j - i, title: o.cols[i].groupTitle ?? '' }, g));
      i = j;
    }
    for (const c of o.cols) h2.append(h('th.sg-c' + (c.edit ? '.ed' : ''), { title: c.title ?? '' }, c.head));
    thead.append(h1, h2);
  } else {
    for (const c of o.cols) h1.append(h('th.sg-c' + (c.edit ? '.ed' : ''), { title: c.title ?? '' }, c.head));
    thead.append(h1);
  }
  tbl.append(thead, tbody);
  wrap.append(tbl);

  const inputs = new Map<string, HTMLInputElement>();
  let range = { a: 0, b: o.rows.length };
  const editable = (r: number, c: number) => !!o.cols[c]?.edit && !o.cols[c].ro?.(r);

  const cellText = (col: SGCol, r: number) => {
    if (col.text) return col.text(r);
    const v = col.get(r);
    return v === null || !Number.isFinite(v) ? '' : (col.format ?? fmt)(v);
  };

  function rowEl(r: number): HTMLElement {
    const row = o.rows[r];
    const tr = h('tr' + (row.active ? '.cur' : '') + (row.base ? '.base' : ''), { 'data-r': String(r), 'data-size': row.name });
    const extra = o.rowClass?.(r); if (extra) for (const c of extra.split(' ').filter(Boolean)) tr.classList.add(c);
    const head = h('td.sg-rh' + (row.brk ? '.brk' : ''), { title: row.base ? 'Base size' : o.onRowClick ? 'Make this the active size' : '' },
      h('span.sg-name', {}, row.name + (row.base ? ' ★' : '')));
    const ex = o.rowExtra?.(r); if (ex) head.prepend(ex);
    if (o.onRowClick) head.addEventListener('click', e => { if ((e.target as Element).closest('button,input')) return; o.onRowClick!(r); });
    tr.append(head);
    o.cols.forEach((col, c) => {
      const cls = col.cls?.(r) ?? '';
      const td = h('td' + (cls ? '.' + cls.split(' ').filter(Boolean).join('.') : ''));
      if (col.edit && !col.ro?.(r)) {
        const inp = h('input.sg-in', { type: 'text', value: cellText(col, r), spellcheck: 'false', autocomplete: 'off', 'data-r': String(r), 'data-c': String(c), 'data-size': row.name, 'data-k': col.key, ...(col.attrs ?? {}) }) as HTMLInputElement;
        wire(inp, r, c);
        inputs.set(r + ':' + c, inp);
        td.append(inp);
      } else {
        td.classList.add('ro');
        td.textContent = cellText(col, r);
        for (const [k, v] of Object.entries({ 'data-size': row.name, 'data-k': col.key, ...(col.attrs ?? {}) })) td.setAttribute(k, v);
      }
      tr.append(td);
    });
    return tr;
  }

  function renderBody() {
    // read the scroll range BEFORE touching the rows: emptying the body first would let the browser
    // clamp scrollTop to 0 (the table collapses for a layout)
    inputs.clear();
    const nodes: HTMLElement[] = [];
    if (!virt) { range = { a: 0, b: o.rows.length }; for (let r = 0; r < o.rows.length; r++) nodes.push(rowEl(r)); tbody.replaceChildren(...nodes); return; }
    const vh = wrap.clientHeight || o.maxHeight || 400;
    const top = wrap.scrollTop;
    const a = Math.max(0, Math.floor(top / ROW_H) - 8);
    const b = Math.min(o.rows.length, Math.ceil((top + vh) / ROW_H) + 8);
    range = { a, b };
    const pad = (n: number) => { const tr = h('tr.sg-pad'); const td = h('td', { colspan: o.cols.length + 1 }); td.style.height = (n * ROW_H) + 'px'; tr.append(td); return tr; };
    if (a > 0) nodes.push(pad(a));
    for (let r = a; r < b; r++) nodes.push(rowEl(r));
    if (b < o.rows.length) nodes.push(pad(o.rows.length - b));
    tbody.replaceChildren(...nodes);
  }

  let raf = 0;
  wrap.addEventListener('scroll', () => {
    st.scrollTop = wrap.scrollTop;
    if (!virt || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const vh = wrap.clientHeight || 400;
      const a = Math.floor(wrap.scrollTop / ROW_H), b = Math.ceil((wrap.scrollTop + vh) / ROW_H);
      if (a >= range.a && b <= range.b && !(a < range.a + 3 && range.a > 0) && !(b > range.b - 3 && range.b < o.rows.length)) return;
      const f = document.activeElement as HTMLInputElement | null;
      const keep = f && wrap.contains(f) ? { r: +f.dataset.r!, c: +f.dataset.c!, v: f.value, typed: f.dataset.typed } : null;
      renderBody();
      if (keep) { const i = inputs.get(keep.r + ':' + keep.c); if (i) { i.value = keep.v; if (keep.typed) i.dataset.typed = '1'; i.focus({ preventScroll: true }); } }
    });
  }, { passive: true });

  function commitInput(inp: HTMLInputElement): boolean {
    if (!inp.dataset.typed) return true;
    delete inp.dataset.typed;
    const r = +inp.dataset.r!, c = +inp.dataset.c!;
    const txt = inp.value.trim();
    const cur = o.cols[c].get(r);
    if (txt === '') { inp.value = cellText(o.cols[c], r); return true; }
    const v = parseLen(txt);
    if (!Number.isFinite(v)) { toast(`“${inp.value}” is not a valid length`, 'warn'); inp.value = cellText(o.cols[c], r); return false; }
    if (cur !== null && Math.abs(v - cur) < 1e-9) { inp.value = cellText(o.cols[c], r); return true; }
    o.onCommit?.([{ r, c, v }]);
    refresh();
    return true;
  }

  function move(r: number, c: number, dr: number, dc: number) {
    let nr = r, nc = c;
    if (dc) {
      // next editable cell in reading order
      for (let k = 0; k < o.rows.length * o.cols.length; k++) {
        nc += dc;
        if (nc >= o.cols.length) { nc = 0; nr++; } else if (nc < 0) { nc = o.cols.length - 1; nr--; }
        if (nr < 0 || nr >= o.rows.length) return;
        if (editable(nr, nc)) break;
      }
    } else {
      for (let k = 0; k < o.rows.length; k++) { nr += dr; if (nr < 0 || nr >= o.rows.length) return; if (editable(nr, nc)) break; }
    }
    focusCell(nr, nc);
  }

  function wire(inp: HTMLInputElement, r: number, c: number) {
    inp.addEventListener('input', () => {
      inp.dataset.typed = '1';
      const v = parseLen(inp.value.trim());
      o.onInput?.(r, c, inp.value.trim() && Number.isFinite(v) ? v : null);
    });
    // select the text once focused; select() also FOCUSES, so only when the cell still has focus (else two cells ping-pong)
    inp.addEventListener('focus', () => { st.focus = { r, c }; o.onFocus?.(r, c); setTimeout(() => { if (document.activeElement === inp) try { inp.select(); } catch { /* */ } }, 0); });
    inp.addEventListener('blur', () => { commitInput(inp); });
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      const k = e.key;
      if (k === 'Enter') { e.preventDefault(); commitInput(inp); move(r, c, e.shiftKey ? -1 : 1, 0); return; }
      if (k === 'Tab') { e.preventDefault(); commitInput(inp); move(r, c, 0, e.shiftKey ? -1 : 1); return; }
      if (k === 'Escape') { e.preventDefault(); delete inp.dataset.typed; inp.value = cellText(o.cols[c], r); o.onInput?.(r, c, null); inp.blur(); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); commitInput(inp); move(r, c, k === 'ArrowDown' ? 1 : -1, 0); return; }
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        const atEdge = !inp.dataset.typed || (k === 'ArrowLeft' ? inp.selectionStart === 0 && inp.selectionEnd === 0 : inp.selectionStart === inp.value.length);
        const all = inp.selectionStart === 0 && inp.selectionEnd === inp.value.length;
        if (atEdge || all) { e.preventDefault(); commitInput(inp); move(r, c, 0, k === 'ArrowRight' ? 1 : -1); }
      }
    });
    inp.addEventListener('paste', e => {
      const txt = e.clipboardData?.getData('text/plain') ?? '';
      if (!/[\t\n\r]/.test(txt.trim()) && !/\n/.test(txt)) return; // single value: normal paste
      e.preventDefault();
      pasteBlock(txt, r, c);
    });
  }

  /** Paste a TSV block from (r, c): rows → consecutive sizes, columns → consecutive columns. */
  function pasteBlock(txt: string, r0: number, c0: number) {
    const lines = txt.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
    const cells: { r: number; c: number; v: number }[] = [];
    let bad = 0;
    lines.forEach((ln, i) => {
      const r = r0 + i; if (r >= o.rows.length) return;
      ln.split('\t').forEach((t, j) => {
        const c = c0 + j; if (c >= o.cols.length || !editable(r, c)) return;
        const s = t.trim(); if (!s) return;
        const v = parseLen(s);
        if (!Number.isFinite(v)) { bad++; return; }
        cells.push({ r, c, v });
      });
    });
    if (bad) toast(`${bad} pasted value(s) skipped (not a length)`, 'warn');
    if (cells.length) o.onCommit?.(cells);
    refresh();
  }

  function focusCell(r: number, c: number) {
    st.focus = { r, c };
    if (virt) {
      const top = r * ROW_H, vh = wrap.clientHeight || 400, hh = thead.getBoundingClientRect().height || ROW_H * 2;
      if (top < wrap.scrollTop + hh) wrap.scrollTop = Math.max(0, top - hh);
      else if (top + ROW_H > wrap.scrollTop + vh) wrap.scrollTop = top + ROW_H - vh + 2;
      st.scrollTop = wrap.scrollTop;
      if (r < range.a || r >= range.b) renderBody();
    }
    const inp = inputs.get(r + ':' + c);
    if (inp) { inp.focus({ preventScroll: !virt ? false : true }); if (!virt) inp.scrollIntoView({ block: 'nearest' }); }
  }

  /** re-read values of every rendered cell (the focused, typed one keeps the user's text) */
  function refresh() {
    const f = document.activeElement;
    for (const tr of tbody.querySelectorAll('tr[data-r]')) {
      const r = +(tr as HTMLElement).dataset.r!;
      const tds = tr.querySelectorAll(':scope > td');
      o.cols.forEach((col, c) => {
        const td = tds[c + 1] as HTMLElement | undefined; if (!td) return;
        const inp = td.querySelector('input') as HTMLInputElement | null;
        if (inp) { if (inp !== f || !inp.dataset.typed) inp.value = cellText(col, r); }
        else td.textContent = cellText(col, r);
        const cls = col.cls?.(r) ?? '';
        td.className = (inp ? '' : 'ro ') + cls;
      });
    }
  }

  renderBody();
  // restore scroll after insertion into the DOM
  requestAnimationFrame(() => {
    if (st.scrollTop) { wrap.scrollTop = st.scrollTop; if (virt) renderBody(); }
    else if (virt) renderBody();
    if (!st.scrollTop) { const cur = o.rows.findIndex(x => x.active); if (cur > 0 && virt) { wrap.scrollTop = Math.max(0, cur * ROW_H - 3 * ROW_H); st.scrollTop = wrap.scrollTop; renderBody(); } }
  });
  return { el: wrap, refresh, focusCell, table: tbl };
}

/** Before a host is rebuilt: remember the scroll position of its grid (the scroll event may not have fired yet). */
export function keepScroll(host: Element | null | undefined, st: SGState, sel = '.sg-wrap') {
  const w = host?.querySelector(sel) as HTMLElement | null;
  if (w && w.isConnected) st.scrollTop = w.scrollTop;
}

/** Rows for a size line (base / active / breaks marked). */
export function sizeRows(line: { sizes: { id: string; name: string }[]; baseSizeId: string }, active?: string, breaks: string[] = []): SGRow[] {
  return line.sizes.map(s => ({ id: s.id, name: s.name, base: s.id === line.baseSizeId, active: s.id === active, brk: breaks.includes(s.id) }));
}

/** TSV text of a grid (header + rows) for Excel. */
export function gridTSV(rows: SGRow[], cols: SGCol[], rowHead = 'Size'): string {
  const head = [rowHead, ...cols.map(c => (c.group ? c.group + ' ' : '') + c.head)].join('\t');
  const body = rows.map((row, r) => [row.name, ...cols.map(c => { if (c.text) return c.text(r); const v = c.get(r); return v === null || !Number.isFinite(v) ? '' : (Math.round(v * 1e4) / 1e4).toString(); })].join('\t'));
  return [head, ...body].join('\n');
}

/** Copy text to the clipboard (falls back to a selectable textarea popover when the API is refused). */
export async function copyText(txt: string): Promise<boolean> {
  (window as unknown as { __lastCopied?: string }).__lastCopied = txt;
  try { await navigator.clipboard.writeText(txt); return true; } catch { /* fall back */ }
  try {
    const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0' }) as HTMLTextAreaElement;
    ta.value = txt; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
