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
/** Close the tool flyout. True when one was open (Esc then does nothing else). */
export function closeFly(): boolean { const had = !!fly; fly?.remove(); fly = null; return had; }

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
      // a fast, readable tooltip instead of the slow native one: name, key, and the other tools hiding in the group
      const btn = h('button.tool-btn' + (active ? '.active' : ''), { 'aria-label': `${cur.title}${hk ? ` (${hk})` : ''}`, 'data-tool': cur.id });
      btn.addEventListener('pointerenter', () => showTip(btn, cur, hk, members));
      btn.addEventListener('pointerleave', hideTip);
      btn.addEventListener('pointerdown', hideTip);
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

let tip: HTMLElement | null = null, tipTimer = 0;
function hideTip() { clearTimeout(tipTimer); tipTimer = 0; tip?.remove(); tip = null; }
function showTip(btn: HTMLElement, cur: Tool, hk: string, members: Tool[]) {
  hideTip();
  tipTimer = window.setTimeout(() => {
    if (fly || !document.body.contains(btn)) return;
    tip = h('div.tool-tip', { role: 'tooltip' });
    tip.append(h('div.tt-head', {}, h('b', {}, cur.title), hk ? h('kbd', {}, hk.split(',')[0]) : null));
    const others = members.filter(m => m !== cur);
    if (others.length) {
      tip.append(h('div.tt-more', {}, 'Right-click or hold for:'));
      for (const m of others) { const k = effectiveHotkey('tool.' + m.id).split(',')[0]; tip.append(h('div.tt-item', {}, h('span', {}, m.title), k ? h('kbd', {}, k) : null)); }
    }
    document.body.append(tip);
    const r = btn.getBoundingClientRect(), t = tip.getBoundingClientRect();
    tip.style.left = r.right + 8 + 'px';
    tip.style.top = Math.max(4, Math.min(r.top, window.innerHeight - t.height - 4)) + 'px';
  }, 350);
}

function openFly(app: App, btn: HTMLElement, members: Tool[]) {
  closeFly(); hideTip();
  const r = btn.getBoundingClientRect();
  fly = h('div.flyout');
  for (const t of members) {
    const hk = effectiveHotkey('tool.' + t.id);
    const b = h('button.fly-item' + (app.tool === t ? '.active' : ''), { onclick: () => { closeFly(); app.setTool(t.id); } });
    b.innerHTML = svgIcon(t.icon);
    b.append(h('span', {}, t.title), h('span.hint', {}, hk));
    fly.append(b);
  }
  document.body.append(fly);
  fly.style.left = r.right + 4 + 'px';
  fly.style.top = Math.max(4, Math.min(r.top, window.innerHeight - fly.getBoundingClientRect().height - 4)) + 'px';
}
