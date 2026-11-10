/** Menubar + context menus, built entirely from the command registry. */
import { MENUS, menuCommands, subMenus, isEnabled, isChecked, runCommand, effectiveHotkey, getCommand, type Command } from '../commands';
import { h, clear } from './dom';
import type { App } from '../app';

let openRoot: HTMLElement | null = null;

function itemFor(c: Command, close: () => void): HTMLElement {
  const en = isEnabled(c);
  const chk = isChecked(c);
  const hk = effectiveHotkey(c.id).split(',')[0];
  return h('button.menu-item' + (en ? '' : '.disabled'), {
    onclick: (e: Event) => { e.stopPropagation(); close(); void runCommand(c.id); },
    // a greyed item says why (UX: users find the function grey and get stuck)
    title: en ? (c.hint ?? '') : `Not available now — needs ${(c.enabled as { need?: string } | undefined)?.need ?? 'a selection it can work on (select the object first)'}`,
  }, h('span.check', {}, chk === undefined ? '' : chk ? '✓' : ''), h('span.mlabel', {}, c.title), h('span.hint', {}, c.hint && !hk ? c.hint : hk));
}

function buildDrop(path: string, close: () => void): HTMLElement {
  const drop = h('div.menu-drop');
  const cmds = menuCommands(path);
  let lastGroup: number | undefined;
  for (const c of cmds) {
    if (lastGroup !== undefined && (c.group ?? 0) !== lastGroup) drop.append(h('div.menu-sep'));
    lastGroup = c.group ?? 0;
    drop.append(itemFor(c, close));
  }
  for (const sub of subMenus(path)) {
    if (drop.children.length) drop.append(h('div.menu-sep'));
    const name = sub.slice(path.length + 1);
    const subDrop = buildDrop(sub, close);
    const subRoot = h('div.menu-sub', {}, h('button.menu-item', {}, h('span.check'), h('span.mlabel', {}, name), h('span.hint', {}, '▸')), subDrop);
    // the flyout is position:fixed and placed on hover, so it is never cut off by the screen edge or by a scrolling parent menu
    subRoot.addEventListener('pointerenter', () => placeSub(subRoot, subDrop));
    drop.append(subRoot);
  }
  return drop;
}

/** Place a sub-menu flyout beside its parent row, flipped / shifted to stay on screen. */
function placeSub(root: HTMLElement, drop: HTMLElement) {
  const r = root.getBoundingClientRect();
  drop.style.left = '0px'; drop.style.top = '0px'; drop.style.maxHeight = '';
  const d = drop.getBoundingClientRect();
  const left = r.right + d.width <= window.innerWidth - 4 ? r.right : Math.max(4, r.left - d.width);
  const top = Math.max(4, Math.min(r.top - 5, window.innerHeight - d.height - 4));
  drop.style.left = left + 'px'; drop.style.top = top + 'px';
  if (d.height > window.innerHeight - 8) { drop.style.maxHeight = window.innerHeight - 8 + 'px'; drop.style.overflowY = 'auto'; }
}

/** Keep an open menu inside the window: tighter rows first, then a scroll bar (short laptop screens, long menus). */
function fitDrop(drop: HTMLElement) {
  drop.classList.remove('compact'); drop.style.maxHeight = ''; drop.style.overflowY = '';
  const avail = () => window.innerHeight - drop.getBoundingClientRect().top - 6;
  if (drop.getBoundingClientRect().height <= avail()) return;
  drop.classList.add('compact');
  if (drop.getBoundingClientRect().height <= avail()) return;
  drop.style.maxHeight = Math.max(120, avail()) + 'px'; drop.style.overflowY = 'auto';
}

let closeOpenMenu: (() => void) | null = null;
/** Close an open menubar drop-down or context menu. True when one was open (Esc then does nothing else). */
export function closeMenus(): boolean {
  const had = !!openRoot || !!ctx;
  closeOpenMenu?.(); closeContextMenu();
  return had;
}

export function mountMenubar(app: App, host: HTMLElement) {
  closeOpenMenu = () => { openRoot?.classList.remove('open'); openRoot = null; };
  const render = () => {
    const wasOpen = openRoot?.dataset.menu;
    clear(host);
    host.append(h('div.logo', {}, 'PROWD', h('span', {}, 'CAD')));
    const close = () => { openRoot?.classList.remove('open'); openRoot = null; };
    for (const m of MENUS) {
      if (!menuCommands(m).length && !subMenus(m).length) continue;
      const root = h('div.menu-root', { 'data-menu': m });
      const btn = h('button.menu-btn', {}, m);
      btn.addEventListener('pointerdown', e => {
        e.stopPropagation();
        if (openRoot === root) { close(); return; }
        close();
        // rebuild the drop each time it opens so enabled/checked state is fresh
        root.querySelector('.menu-drop')?.remove();
        const d = buildDrop(m, close); root.append(d);
        root.classList.add('open'); openRoot = root; fitDrop(d);
      });
      btn.addEventListener('pointerenter', () => {
        if (openRoot && openRoot !== root) { close(); root.querySelector('.menu-drop')?.remove(); const d = buildDrop(m, close); root.append(d); root.classList.add('open'); openRoot = root; fitDrop(d); }
      });
      root.append(btn);
      host.append(root);
      if (wasOpen === m) { const d = buildDrop(m, close); root.append(d); root.classList.add('open'); openRoot = root; fitDrop(d); }
    }
    // quick access: the five things everyone reaches for, one click away, plus the command finder
    const q = (id: string, icon: string) => {
      const b = h('button.qa-btn', { 'data-cmd': id, type: 'button', onclick: () => { void runCommand(id); } });
      b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`;
      return b;
    };
    const find = h('button.qa-find', { type: 'button', title: 'Search every command and tool by name', onclick: () => { void runCommand('help.find'); } });
    find.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>';
    find.append(h('span', {}, 'Find a command'), h('kbd', {}, effectiveHotkey('help.find').split(',')[0] || ''));
    host.append(
      h('div.qa', { role: 'toolbar', 'aria-label': 'Quick access' },
        q('edit.undo', '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
        q('edit.redo', '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>'),
        h('span.qa-sep'),
        q('file.save', '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>'),
        q('view.fit', '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="9" y="9" width="6" height="6"/>')),
      h('div.spacer'), find, h('div.spacer'), h('div.doc-title', { id: 'doc-title' }, ''));
    updateTitle(app);
  };
  document.addEventListener('pointerdown', e => {
    if (openRoot && !(e.target as Element).closest?.('.menu-root')) { openRoot.classList.remove('open'); openRoot = null; }
    if (!(e.target as Element).closest?.('.ctx-menu')) closeContextMenu();
  });
  render();
  app.setRenderer('menus', () => updateTitle(app));
  return render;
}

export function updateTitle(app: App) {
  const t = document.getElementById('doc-title');
  const name = `${app.style.name} — ${app.fileName}${app.isDirty() ? ' •' : ''}`;
  if (t) { t.textContent = name; t.title = app.isDirty() ? `${name} — unsaved changes` : name; }
  // quick-access buttons: enabled state + what exactly they will do
  for (const b of document.querySelectorAll<HTMLButtonElement>('#menubar .qa-btn')) {
    const c = getCommand(b.dataset.cmd!); if (!c) continue;
    const en = isEnabled(c); b.disabled = !en;
    const hk = effectiveHotkey(c.id).split(',')[0];
    const what = c.id === 'edit.undo' ? (app.doc.undoLabel() ? `Undo: ${app.doc.undoLabel()}` : 'Nothing to undo')
      : c.id === 'edit.redo' ? (app.doc.redoLabel() ? `Redo: ${app.doc.redoLabel()}` : 'Nothing to redo')
        : c.id === 'file.save' ? (app.isDirty() ? 'Save (unsaved changes)' : 'Save') : c.title;
    b.title = hk ? `${what} (${hk})` : what; b.setAttribute('aria-label', what);
    b.classList.toggle('attn', c.id === 'file.save' && app.isDirty());
  }
  document.title = `${app.isDirty() ? '• ' : ''}${app.style.name} · ProwdCAD`;
}

// ───────────── context menu ─────────────
let ctx: HTMLElement | null = null;
export function closeContextMenu() { ctx?.remove(); ctx = null; }
export function openContextMenu(x: number, y: number, ids: (string | '-')[], extra: { label: string; run: () => void }[] = []) {
  closeContextMenu();
  const close = () => closeContextMenu();
  ctx = h('div.ctx-menu.menu-drop');
  for (const e of extra) ctx.append(h('button.menu-item', { onclick: () => { close(); e.run(); } }, h('span.check'), h('span.mlabel', {}, e.label)));
  if (extra.length && ids.length) ctx.append(h('div.menu-sep'));
  for (const id of ids) {
    if (id === '-') { ctx.append(h('div.menu-sep')); continue; }
    const c = getCommand(id);
    if (c) ctx.append(itemFor(c, close));
  }
  document.body.append(ctx);
  // a long context menu on a short screen: tighter rows, then scroll — never taller than the window
  if (ctx.getBoundingClientRect().height > window.innerHeight - 8) ctx.classList.add('compact');
  if (ctx.getBoundingClientRect().height > window.innerHeight - 8) { ctx.style.maxHeight = window.innerHeight - 8 + 'px'; ctx.style.overflowY = 'auto'; }
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  ctx.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
}
