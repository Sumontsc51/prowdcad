/**
 * Panel widgets. Values are typed in the current display unit; decimal AND fractional input is
 * accepted (kernel parseLengthAuto: "12.5", "1 1/8", "9/8", "2cm", '1"'). Commit on Enter/blur,
 * Esc reverts. Panels never rebuild while one of their inputs has focus.
 */
import { h } from '../ui/dom';
import { fmt, parseLen, parseNum, unitLabel } from '../units-ui';
import { toast } from '../ui/toast';
import { settings } from '../settings';
import { formatLength } from '@prowdcad/kernel';

export function lengthInput(mm: number, onCommit: (mm: number) => void, opt: { min?: number; readOnly?: boolean; title?: string; blankIfNaN?: boolean } = {}): HTMLInputElement {
  const shown = Number.isFinite(mm) ? fmt(mm) : '';
  // the display may be rounded (inch fractions): say so, and give the exact value in the tooltip
  const approx = Number.isFinite(mm) && Math.abs(parseLen(shown) - mm) > 1e-6;
  const base = opt.title ?? `Length in ${unitLabel()} — decimals or fractions`;
  const inp = h('input.num' + (approx ? '.approx' : ''), { type: 'text', value: shown, title: approx ? `${base}\nShown rounded; exact value${exactText(mm)}. Typing the shown value sets it exactly.` : base, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  if (opt.readOnly) { inp.readOnly = true; inp.classList.add('ro'); return inp; }
  let orig = shown, cur = mm, typed = false;
  inp.addEventListener('input', () => { typed = true; });
  const commit = () => {
    // compare VALUES, not the (possibly rounded) display text: typing the shown "3/8" over an exact
    // 10 mm must write 9.525 mm. An untouched field never commits.
    if (!typed) return;
    typed = false;
    if (inp.value.trim() === '' && orig === '') return;
    const v = parseLen(inp.value);
    if (!Number.isFinite(v)) { toast(`“${inp.value}” is not a valid length`, 'warn'); inp.value = orig; return; }
    if (opt.min != null && v < opt.min) { toast(`Must be ≥ ${fmt(opt.min)} ${unitLabel()}`, 'warn'); inp.value = orig; return; }
    if (Math.abs(v - cur) < 1e-9) { inp.value = orig; return; }
    orig = inp.value; cur = v;
    onCommit(v);
  };
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); inp.value = orig; inp.blur(); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', commit);
  inp.addEventListener('focus', () => { orig = inp.value; setTimeout(() => inp.select(), 0); });
  return inp;
}

/** Exact decimal value in the display unit (no fraction rounding), e.g. " = 0.3937 in". */
function exactText(mm: number): string {
  if (settings.unit !== 'in') return ` ${formatLength(mm, { unit: settings.unit, decimals: 4 })} ${unitLabel()}`;
  return ` ${formatLength(mm, { unit: 'in', decimals: 4 })} in (${formatLength(mm, { unit: 'mm', decimals: 3 })} mm)`;
}

export function numberInput(v: number, onCommit: (v: number) => void, opt: { min?: number; max?: number; decimals?: number; title?: string } = {}): HTMLInputElement {
  const shown = Number.isFinite(v) ? String(Math.round(v * 10 ** (opt.decimals ?? 3)) / 10 ** (opt.decimals ?? 3)) : '';
  const inp = h('input.num', { type: 'text', value: shown, title: opt.title ?? '', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  let orig = shown, typed = false;
  inp.addEventListener('input', () => { typed = true; });
  const commit = () => {
    if (!typed) return;
    typed = false;
    if (inp.value.trim() === orig && Math.abs(parseNum(orig) - v) < 1e-9) return;
    const n = parseNum(inp.value);
    if (!Number.isFinite(n) || (opt.min != null && n < opt.min) || (opt.max != null && n > opt.max)) { toast(`“${inp.value}” is not valid`, 'warn'); inp.value = orig; return; }
    orig = inp.value; onCommit(n);
  };
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); inp.value = orig; inp.blur(); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', commit);
  inp.addEventListener('focus', () => { orig = inp.value; setTimeout(() => inp.select(), 0); });
  return inp;
}

export function textInput(v: string, onCommit: (v: string) => void, placeholder = ''): HTMLInputElement {
  const inp = h('input', { type: 'text', value: v, placeholder, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  let orig = v;
  const commit = () => { if (inp.value !== orig) { orig = inp.value; onCommit(inp.value); } };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); } else if (e.key === 'Escape') { inp.value = orig; inp.blur(); } e.stopPropagation(); });
  inp.addEventListener('blur', commit);
  return inp;
}

export function selectInput(v: string, options: [string, string][], onChange: (v: string) => void): HTMLSelectElement {
  const s = h('select') as HTMLSelectElement;
  for (const [val, label] of options) s.append(h('option', { value: val }, label));
  s.value = v;
  s.addEventListener('change', () => { onChange(s.value); s.blur(); });
  s.addEventListener('keydown', e => e.stopPropagation());
  return s;
}

export function checkbox(v: boolean, onChange: (v: boolean) => void, label?: string): HTMLElement {
  const c = h('input', { type: 'checkbox', checked: v }) as HTMLInputElement;
  c.addEventListener('change', () => { onChange(c.checked); c.blur(); });
  return label ? h('label.chk', {}, c, ' ' + label) : c;
}

export function row(label: string, ...ctl: (HTMLElement | string)[]): HTMLElement {
  return h('div.prow', {}, h('span.plabel', {}, label), h('div.pctl', {}, ...ctl));
}
export const unitTag = () => h('span.u', {}, unitLabel());

/** Collapsible right-dock section. */
export function section(id: string, title: string, body: HTMLElement, opts: { collapsed?: boolean; actions?: HTMLElement[]; onToggle?: (open: boolean) => void } = {}): HTMLElement {
  const sec = h('section.panel' + (opts.collapsed ? '.collapsed' : ''), { 'data-panel': id });
  const head = h('header.panel-head', {}, h('span.caret', {}, '▾'), h('span.ptitle', {}, title), h('span.spacer'), ...(opts.actions ?? []));
  head.addEventListener('click', e => {
    if ((e.target as Element).closest('button,input,select')) return;
    sec.classList.toggle('collapsed'); opts.onToggle?.(!sec.classList.contains('collapsed'));
  });
  sec.append(head, h('div.panel-body', {}, body));
  return sec;
}

/** Re-render a host only when none of its inputs has focus (re-render after blur instead). */
export function focusSafe(host: HTMLElement, render: () => void): () => void {
  let pending = false;
  host.addEventListener('focusout', () => { if (pending) setTimeout(() => { if (!host.contains(document.activeElement)) { pending = false; render(); } }, 0); });
  return () => {
    const a = document.activeElement;
    if (a && host.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) { pending = true; return; }
    pending = false; render();
  };
}
