/**
 * In-app modal dialogs (never window.prompt/alert/confirm). Every dialog returns a Promise that
 * resolves to the field values, or null when cancelled (Esc / Cancel / backdrop).
 *
 * Field kinds:
 *  - 'length'  : typed in the current display unit, decimal OR fraction ("1 1/8", "9/8", "2cm") → mm
 *  - 'number'  : unit-less number, fractions accepted
 *  - 'text' | 'textarea' | 'select' | 'checkbox' | 'radio'
 */
import { h } from './dom';
import { fmt, parseLen, parseNum, unitLabel } from '../units-ui';

export type FieldDef =
  | { kind: 'length'; key: string; label: string; value: number; min?: number; hint?: string }
  | { kind: 'number'; key: string; label: string; value: number; min?: number; max?: number; step?: number; hint?: string; suffix?: string }
  | { kind: 'text'; key: string; label: string; value: string; placeholder?: string; hint?: string }
  | { kind: 'textarea'; key: string; label: string; value: string; rows?: number; mono?: boolean; hint?: string }
  | { kind: 'select'; key: string; label: string; value: string; options: { value: string; label: string }[]; hint?: string }
  | { kind: 'radio'; key: string; label: string; value: string; options: { value: string; label: string }[]; hint?: string }
  | { kind: 'checkbox'; key: string; label: string; value: boolean; hint?: string };

export type DialogValues = Record<string, string | number | boolean>;

export interface DialogOptions {
  title: string;
  message?: string;
  fields?: FieldDef[];
  okLabel?: string;
  cancelLabel?: string | null;
  /** extra buttons (resolve with {__button: id, ...values}) */
  buttons?: { id: string; label: string; danger?: boolean }[];
  /** optional cross-field validation; return an error string to block OK */
  validate?: (v: DialogValues) => string | null;
  wide?: boolean;
}

let openCount = 0;
export function dialogOpen(): boolean { return openCount > 0; }

export function showDialog(opt: DialogOptions): Promise<DialogValues | null> {
  return new Promise(resolve => {
    openCount++;
    const prevFocus = document.activeElement as HTMLElement | null;
    const err = h('div.dlg-err');
    const inputs = new Map<string, { def: FieldDef; el: HTMLElement }>();
    const body = h('div.dlg-body');
    if (opt.message) body.append(h('p.dlg-msg', {}, opt.message));

    for (const f of opt.fields ?? []) {
      let ctl: HTMLElement;
      switch (f.kind) {
        case 'length':
          ctl = h('div.dlg-unit', {}, h('input', { type: 'text', value: fmt(f.value), 'data-key': f.key, autocomplete: 'off', spellcheck: 'false' }), h('span.u', {}, unitLabel()));
          break;
        case 'number':
          ctl = h('div.dlg-unit', {}, h('input', { type: 'text', value: String(f.value), 'data-key': f.key, autocomplete: 'off' }), f.suffix ? h('span.u', {}, f.suffix) : null);
          break;
        case 'text':
          ctl = h('input', { type: 'text', value: f.value, placeholder: f.placeholder ?? '', 'data-key': f.key, autocomplete: 'off' });
          break;
        case 'textarea':
          ctl = h('textarea', { rows: f.rows ?? 8, 'data-key': f.key, class: f.mono ? 'mono' : '', spellcheck: 'false' });
          (ctl as HTMLTextAreaElement).value = f.value;
          break;
        case 'select': {
          const s = h('select', { 'data-key': f.key }) as HTMLSelectElement;
          for (const o of f.options) s.append(h('option', { value: o.value }, o.label));
          s.value = f.value; ctl = s; break;
        }
        case 'radio': {
          ctl = h('div.dlg-radio', { 'data-key': f.key });
          for (const o of f.options) {
            ctl.append(h('label', {}, h('input', { type: 'radio', name: 'r_' + f.key, value: o.value, checked: o.value === f.value }), ' ' + o.label));
          }
          break;
        }
        case 'checkbox':
          ctl = h('input', { type: 'checkbox', checked: f.value, 'data-key': f.key });
          break;
      }
      inputs.set(f.key, { def: f, el: ctl });
      const row = f.kind === 'checkbox'
        ? h('label.dlg-row.dlg-check', {}, ctl, h('span', {}, f.label))
        : h('label.dlg-row', {}, h('span.dlg-label', {}, f.label), ctl);
      body.append(row);
      if (f.hint) body.append(h('div.dlg-hint', {}, f.hint));
    }
    body.append(err);

    const read = (): DialogValues | string => {
      const out: DialogValues = {};
      for (const [key, { def, el }] of inputs) {
        const inp = (el.matches('input,select,textarea') ? el : el.querySelector('input,select,textarea')) as HTMLInputElement;
        switch (def.kind) {
          case 'length': {
            const v = parseLen(inp.value);
            if (!Number.isFinite(v)) return `${def.label}: not a valid length`;
            if (def.min != null && v < def.min) return `${def.label}: must be ≥ ${fmt(def.min)} ${unitLabel()}`;
            out[key] = v; break;
          }
          case 'number': {
            const v = parseNum(inp.value);
            if (!Number.isFinite(v)) return `${def.label}: not a valid number`;
            if (def.min != null && v < def.min) return `${def.label}: must be ≥ ${def.min}`;
            if (def.max != null && v > def.max) return `${def.label}: must be ≤ ${def.max}`;
            out[key] = v; break;
          }
          case 'checkbox': out[key] = inp.checked; break;
          case 'radio': {
            const r = el.querySelector('input:checked') as HTMLInputElement | null;
            out[key] = r?.value ?? def.value; break;
          }
          default: out[key] = inp.value;
        }
      }
      if (opt.validate) { const e = opt.validate(out); if (e) return e; }
      return out;
    };

    const overlay = h('div.dlg-overlay');
    const finish = (v: DialogValues | null) => {
      overlay.remove();
      openCount--;
      document.removeEventListener('keydown', onKey, true);
      try { prevFocus?.focus(); } catch { /* ignore */ }
      resolve(v);
    };
    const ok = () => { const r = read(); if (typeof r === 'string') { err.textContent = r; return; } finish(r); };
    const onKey = (e: KeyboardEvent) => {
      if (!document.body.contains(overlay)) return;
      // only the topmost dialog reacts
      const all = document.querySelectorAll('.dlg-overlay');
      if (all[all.length - 1] !== overlay) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); e.stopPropagation(); ok(); }
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);

    const foot = h('div.dlg-foot');
    for (const b of opt.buttons ?? []) {
      foot.append(h('button.btn' + (b.danger ? '.danger' : ''), { onclick: () => { const r = read(); finish({ ...(typeof r === 'string' ? {} : r), __button: b.id }); } }, b.label));
    }
    foot.append(h('span.spacer'));
    if (opt.cancelLabel !== null) foot.append(h('button.btn', { onclick: () => finish(null) }, opt.cancelLabel ?? 'Cancel'));
    foot.append(h('button.btn.primary', { onclick: ok }, opt.okLabel ?? 'OK'));

    const box = h('div.dlg' + (opt.wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' }, h('div.dlg-title', {}, opt.title), body, foot);
    overlay.append(box);
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) finish(null); });
    document.body.append(overlay);
    const first = box.querySelector('input:not([type=checkbox]):not([type=radio]),textarea,select') as HTMLInputElement | null;
    setTimeout(() => { first?.focus(); if (first && 'select' in first) try { first.select(); } catch { /* */ } }, 20);
  });
}

export async function confirmDialog(title: string, message: string, okLabel = 'OK'): Promise<boolean> {
  return (await showDialog({ title, message, okLabel })) !== null;
}

export async function alertDialog(title: string, message: string): Promise<void> {
  await showDialog({ title, message, cancelLabel: null });
}

export async function promptLength(title: string, label: string, value: number): Promise<number | null> {
  const r = await showDialog({ title, fields: [{ kind: 'length', key: 'v', label, value }] });
  return r ? (r.v as number) : null;
}
