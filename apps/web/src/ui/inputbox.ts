/**
 * Move-tool input box (ProwdCAD's version of the AccuMark user input box). A small floating panel
 * near the cursor with one row per value. Opened by typing a digit or by right-clicking while a
 * Move tool holds a pick. Lengths accept decimals, fractions and unit suffixes ("1 1/8", "9/8",
 * "2cm"); angles accept degrees (fractions too). "12,5" typed in the first of two fields fills
 * both (12 and 5).
 *
 *   Enter / right-click on the sheet = OK · Esc = cancel · Tab = next field
 *
 * `onPreview` is called on every edit with the parsed values (null while a field is invalid) so the
 * tool can show the result live before OK.
 */
import { h, clear } from './dom';
import { fmt, parseLen, parseNum, unitLabel } from '../units-ui';

export interface IBField { key: string; label: string; kind: 'length' | 'angle' | 'number'; value: number; suffix?: string }
export interface IBMode { id: string; label: string; fields: IBField[]; title?: string }
export interface IBOptions {
  title: string;
  modes: IBMode[];
  mode?: string;
  at: { x: number; y: number };
  /** first keystroke that opened the box: it replaces the first field */
  typed?: string;
  hint?: string;
  amber?: string;
  onPreview?: (mode: string, v: Record<string, number> | null) => void;
}
export interface IBResult { mode: string; v: Record<string, number> }

interface Live { ok: () => void; cancel: () => void }
let live: Live | null = null;

export function inputBoxOpen(): boolean { return !!live; }
/** Right-click on the sheet while the box is open = OK. */
export function inputBoxCommit(): void { live?.ok(); }
export function inputBoxCancel(): void { live?.cancel(); }

const fmtVal = (f: IBField) => f.kind === 'length' ? fmt(f.value) : String(Math.round(f.value * 1e6) / 1e6);

export function openInputBox(o: IBOptions): Promise<IBResult | null> {
  live?.cancel();
  return new Promise(resolve => {
    let mode = o.modes.find(m => m.id === o.mode) ?? o.modes[0];
    const box = h('div.ibox', { role: 'dialog', 'aria-label': o.title });
    const err = h('div.ibox-err');
    const rows = h('div.ibox-rows');
    const tabs = h('div.ibox-modes');
    const inputs = new Map<string, HTMLInputElement>();
    let first = true;

    const read = (): Record<string, number> | string => {
      const v: Record<string, number> = {};
      for (const f of mode.fields) {
        const t = inputs.get(f.key)!.value;
        const n = f.kind === 'length' ? parseLen(t) : parseNum(t);
        if (!Number.isFinite(n)) return `${f.label}: not a valid ${f.kind === 'length' ? 'length' : 'number'}`;
        v[f.key] = n;
      }
      return v;
    };
    const preview = () => { const r = read(); err.textContent = typeof r === 'string' ? r : ''; o.onPreview?.(mode.id, typeof r === 'string' ? null : r); };

    const build = () => {
      clear(rows);
      inputs.clear();
      mode.fields.forEach((f, i) => {
        const inp = h('input', { type: 'text', value: i === 0 && first && o.typed != null ? o.typed : fmtVal(f), 'data-key': f.key, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
        inp.addEventListener('input', () => {
          // "12,5" in the first of two fields → both fields
          if (i === 0 && mode.fields.length > 1 && /^[^,]+,[^,]+$/.test(inp.value)) {
            const [a, b] = inp.value.split(',');
            inp.value = a.trim(); const n2 = inputs.get(mode.fields[1].key)!; n2.value = b.trim();
          }
          preview();
        });
        inputs.set(f.key, inp);
        rows.append(h('label.ibox-row', {}, h('span.ibox-l', {}, f.label), inp, h('span.ibox-u', {}, f.kind === 'length' ? unitLabel() : f.kind === 'angle' ? '°' : f.suffix ?? '')));
      });
      clear(tabs);
      if (o.modes.length > 1) for (const m of o.modes) {
        tabs.append(h('button.ibox-mode' + (m.id === mode.id ? '.on' : ''), { type: 'button', title: m.title ?? m.label, onclick: () => { mode = m; first = false; build(); focusFirst(); preview(); } }, m.label));
      }
    };
    const focusFirst = () => setTimeout(() => {
      const f = inputs.get(mode.fields[0]?.key ?? '');
      if (!f) return;
      f.focus();
      if (first && o.typed != null) { const n = f.value.length; f.setSelectionRange(n, n); } else f.select();
    }, 0);

    const finish = (r: IBResult | null) => {
      if (!live) return;
      live = null;
      box.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(r);
    };
    const ok = () => { const r = read(); if (typeof r === 'string') { err.textContent = r; return; } finish({ mode: mode.id, v: r }); };
    const onKey = (e: KeyboardEvent) => {
      if (!box.contains(e.target as Node) && e.key !== 'Escape' && e.key !== 'Enter') return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ok(); }
      else e.stopPropagation();
    };
    live = { ok, cancel: () => finish(null) };
    document.addEventListener('keydown', onKey, true);

    box.append(h('div.ibox-title', {}, o.title));
    if (o.amber) box.append(h('div.ibox-amber', {}, o.amber));
    box.append(
      tabs, rows, err,
      h('div.ibox-foot', {},
        h('span.ibox-hint', {}, o.hint ?? 'Enter / right-click = OK · Esc = cancel · Tab = next field'),
        h('button.btn.sm', { type: 'button', onclick: () => finish(null) }, 'Cancel'),
        h('button.btn.sm.primary', { type: 'button', onclick: ok }, 'OK')),
    );
    build();
    document.body.append(box);
    const r = box.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(o.at.x + 18, window.innerWidth - r.width - 4)) + 'px';
    box.style.top = Math.max(4, Math.min(o.at.y + 18, window.innerHeight - r.height - 4)) + 'px';
    focusFirst();
    preview();
  });
}
