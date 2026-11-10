/**
 * Command finder (Ctrl+K) and searchable shortcut list (F1).
 * Every registered command — menus, tools, hotkey-only — in one list: type a few letters of what you
 * want ("notch", "seam corner", "dxf"), ↑ ↓ to choose, Enter to run. Each row shows where the command
 * lives in the menus and its shortcut, so the finder also teaches the menu layout and the keys.
 */
import { allCommands, effectiveHotkey, isEnabled, isChecked, runCommand, type Command } from '../commands';
import { h, clear } from './dom';
import { modalHold } from './dialog';

let open: { close: () => void } | null = null;

interface Row { c: Command; path: string; keys: string; hay: string; title: string }

function rows(): Row[] {
  return allCommands().map(c => {
    const isTool = c.id.startsWith('tool.');
    const path = c.menu ? c.menu.split('/').join(' ▸ ') : isTool ? 'Tool' : 'Shortcut only';
    const keys = effectiveHotkey(c.id).split(',').map(s => s.trim()).filter(Boolean).join('  ·  ');
    const title = c.title.replace(/^Tool:\s*/, '');
    return { c, path, keys, title, hay: `${title} ${path} ${c.id.replace(/[._]/g, ' ')} ${keys}`.toLowerCase() };
  });
}

/** all query words must occur; earlier / word-start matches in the title rank first */
function score(r: Row, words: string[]): number {
  let s = 0;
  const t = r.title.toLowerCase();
  for (const w of words) {
    const i = r.hay.indexOf(w);
    if (i < 0) return -1;
    const ti = t.indexOf(w);
    if (ti === 0) s += 100; else if (ti > 0 && /[\s(/·—-]/.test(t[ti - 1])) s += 60; else if (ti > 0) s += 30; else s += 5;
  }
  return s - t.length * 0.05;
}

export function openCommandFinder(opt: { shortcutsOnly?: boolean } = {}) {
  if (open) { open.close(); }
  const release = modalHold();
  const prevFocus = document.activeElement as HTMLElement | null;
  let onlyKeys = !!opt.shortcutsOnly;
  let sel = 0;
  let shown: Row[] = [];
  const all = rows();

  const input = h('input.cmdk-input', { type: 'text', placeholder: 'Type what you want to do — e.g. “notch”, “seam”, “export dxf”, “rotate”', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Find a command' }) as HTMLInputElement;
  const list = h('div.cmdk-list', { role: 'listbox' });
  const count = h('span.cmdk-count');
  const keysToggle = h('label.cmdk-toggle', { title: 'Show only the commands that have a keyboard shortcut' }, h('input', { type: 'checkbox', checked: onlyKeys }), ' With shortcut only');
  const closeBtn = h('button.btn.primary', { onclick: () => close() }, 'Close');
  const box = h('div.dlg.wide.cmdk', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Find a command' },
    h('div.dlg-title', {}, opt.shortcutsOnly ? 'Keyboard shortcuts' : 'Find a command'),
    h('div.cmdk-head', {}, input),
    list,
    h('div.dlg-foot', {}, keysToggle, count, h('span.spacer'), h('span.cmdk-help', {}, '↑ ↓ choose · Enter run · Esc close'), closeBtn));
  const overlay = h('div.dlg-overlay', {}, box);

  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let cand = all.filter(r => !onlyKeys || r.keys);
    if (words.length) cand = cand.map(r => ({ r, s: score(r, words) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).map(x => x.r);
    shown = cand;
    sel = Math.max(0, Math.min(sel, shown.length - 1));
    clear(list);
    if (!shown.length) list.append(h('div.cmdk-empty', {}, `Nothing matches “${input.value}”. Try a shorter word.`));
    let lastPath = '';
    shown.forEach((r, i) => {
      // without a query the list reads like the menus: a heading per menu
      if (!words.length && r.path !== lastPath) { list.append(h('div.cmdk-group', {}, r.path)); lastPath = r.path; }
      const en = isEnabled(r.c);
      const need = (r.c.enabled as { need?: string } | undefined)?.need;
      const row = h('div.cmdk-row' + (i === sel ? '.sel' : '') + (en ? '' : '.off'), {
        role: 'option', 'data-i': i, 'aria-selected': i === sel ? 'true' : 'false',
        title: en ? (r.c.hint ?? '') : `Not available now — needs ${need ?? 'a selection it can work on (select the object first)'}`,
      },
        h('span.cmdk-check', {}, isChecked(r.c) ? '✓' : ''),
        h('span.cmdk-title', {}, r.title),
        words.length ? h('span.cmdk-path', {}, r.path) : null,
        !en ? h('span.cmdk-need', {}, 'select something first') : null,
        h('span.cmdk-keys', {}, r.keys));
      list.append(row);
    });
    count.textContent = `${shown.length} command${shown.length === 1 ? '' : 's'}`;
    list.querySelector('.cmdk-row.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const move = (d: number) => {
    if (!shown.length) return;
    sel = (sel + d + shown.length) % shown.length;
    list.querySelectorAll('.cmdk-row').forEach(el => { const on = Number((el as HTMLElement).dataset.i) === sel; el.classList.toggle('sel', on); el.setAttribute('aria-selected', on ? 'true' : 'false'); });
    list.querySelector('.cmdk-row.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i: number) => {
    const r = shown[i]; if (!r) return;
    if (!isEnabled(r.c)) { const row = list.querySelector(`.cmdk-row[data-i="${i}"]`); row?.classList.remove('shake'); void (row as HTMLElement | null)?.offsetWidth; row?.classList.add('shake'); return; }
    close();
    void runCommand(r.c.id);
  };
  function close() {
    if (!open) return;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove(); release();
    try { prevFocus?.focus(); } catch { /* ignore */ }
  }
  const onKey = (e: KeyboardEvent) => {
    const top = document.querySelectorAll('.dlg-overlay');
    if (top[top.length - 1] !== overlay) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); move(Math.min(8, Math.max(1, shown.length - 1 - sel))); }
    else if (e.key === 'PageUp') { e.preventDefault(); move(-Math.min(8, Math.max(1, sel))); }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); run(sel); }
    else if (e.key === 'Tab') {
      const f = [input, keysToggle.querySelector('input') as HTMLElement, closeBtn];
      const i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', () => { sel = 0; render(); });
  (keysToggle.querySelector('input') as HTMLInputElement).addEventListener('change', e => { onlyKeys = (e.target as HTMLInputElement).checked; sel = 0; render(); input.focus(); });
  list.addEventListener('click', e => { const row = (e.target as Element).closest('.cmdk-row') as HTMLElement | null; if (row) run(Number(row.dataset.i)); });
  list.addEventListener('pointermove', e => { const row = (e.target as Element).closest('.cmdk-row') as HTMLElement | null; if (row && Number(row.dataset.i) !== sel) { sel = Number(row.dataset.i); move(0); } });
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close(); });

  open = { close };
  document.body.append(overlay);
  render();
  setTimeout(() => input.focus(), 20);
}
