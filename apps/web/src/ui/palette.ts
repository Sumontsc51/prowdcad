/**
 * Left tool palette. Tools sharing a group collapse into one button showing the last-used tool of
 * the group with a corner triangle; right-click or long-press (350 ms) opens the flyout.
 * Hidden tools (toolbar customizer) are skipped.
 */
import type { App } from '../app';
import type { Tool } from '../tools/tool';
import { h, clear } from './dom';
import { settings } from '../settings';
import { effectiveHotkey } from '../commands';

const svgIcon = (inner: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

let fly: HTMLElement | null = null;
function closeFly() { fly?.remove(); fly = null; }

export function mountPalette(app: App, host: HTMLElement) {
  document.addEventListener('pointerdown', e => { if (fly && !(e.target as Element).closest?.('.flyout,.tool-btn')) closeFly(); });
  const render = () => {
    clear(host);
    const visible = app.tools.filter(t => !t.hidden && !settings.hiddenTools.includes(t.id));
    const groups: string[] = [];
    for (const t of visible) if (!groups.includes(t.group)) groups.push(t.group);
    for (const g of groups) {
      const members = visible.filter(t => t.group === g);
      const shown = members.find(t => t.id === app.groupTool[g]) ?? members[0];
      const active = members.includes(app.tool);
      const cur = active ? app.tool : shown;
      const hk = effectiveHotkey('tool.' + cur.id);
      const btn = h('button.tool-btn' + (active ? '.active' : ''), { title: `${cur.title}${hk ? ` (${hk})` : ''}${members.length > 1 ? ' — right-click for more' : ''}` });
      btn.innerHTML = svgIcon(cur.icon) + (members.length > 1 ? '<span class="flytri"></span>' : '');
      let lp = 0;
      btn.addEventListener('pointerdown', e => {
        if (e.button !== 0 || members.length < 2) return;
        lp = window.setTimeout(() => { lp = 0; openFly(app, btn, members); }, 350);
      });
      btn.addEventListener('pointerup', () => { if (lp) { clearTimeout(lp); lp = 0; app.setTool(cur.id); } else if (members.length < 2) app.setTool(cur.id); });
      btn.addEventListener('pointerleave', () => { if (lp) { clearTimeout(lp); lp = 0; } });
      btn.addEventListener('contextmenu', e => { e.preventDefault(); if (members.length > 1) openFly(app, btn, members); });
      host.append(btn);
    }
  };
  return render;
}

function openFly(app: App, btn: HTMLElement, members: Tool[]) {
  closeFly();
  const r = btn.getBoundingClientRect();
  fly = h('div.flyout');
  for (const t of members) {
    const hk = effectiveHotkey('tool.' + t.id);
    const b = h('button.fly-item' + (app.tool === t ? '.active' : ''), { onclick: () => { closeFly(); app.setTool(t.id); } });
    b.innerHTML = svgIcon(t.icon);
    b.append(h('span', {}, t.title), h('span.hint', {}, hk));
    fly.append(b);
  }
  fly.style.left = r.right + 4 + 'px';
  fly.style.top = r.top + 'px';
  document.body.append(fly);
}
