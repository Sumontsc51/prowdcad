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
    drop.append(h('div.menu-sub', {}, h('button.menu-item', {}, h('span.check'), h('span.mlabel', {}, name), h('span.hint', {}, '▸')), buildDrop(sub, close)));
  }
  return drop;
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
        root.append(buildDrop(m, close));
        root.classList.add('open'); openRoot = root;
      });
      btn.addEventListener('pointerenter', () => {
        if (openRoot && openRoot !== root) { close(); root.querySelector('.menu-drop')?.remove(); root.append(buildDrop(m, close)); root.classList.add('open'); openRoot = root; }
      });
      root.append(btn);
      host.append(root);
      if (wasOpen === m) { root.append(buildDrop(m, close)); root.classList.add('open'); openRoot = root; }
    }
    host.append(h('div.spacer'), h('div.doc-title', { id: 'doc-title' }, ''));
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
  if (t) t.textContent = name;
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
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  ctx.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
}
