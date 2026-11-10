/**
 * Tool-options strip under the menubar: the active tool (icon + name), its modes as a segmented
 * control (Select: the selection filter; Move Point: Single / Smooth / Horizontal / Vertical /
 * Along line / Group; …) and the tool-mode indicator (amber while a non-base size's grading is
 * being edited). Rebuilt only when what it shows changes.
 */
import type { App } from '../app';
import { h, clear } from './dom';
import { effectiveHotkey } from '../commands';

const svgIcon = (inner: string) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export function mountToolOptions(app: App, host: HTMLElement) {
  let key = '';
  const render = () => {
    const t = app.tool; if (!t) return;
    const modes = t.modes?.(app) ?? [];
    const cur = t.mode?.(app) ?? '';
    const badge = t.badge?.(app) ?? null;
    const toggles = t.toggles?.(app) ?? [];
    const k = [t.id, cur, modes.map(m => m.id).join(','), toggles.map(x => x.id + (x.on ? '+' : '-')).join(','), badge?.text ?? '', badge?.amber ? 1 : 0].join('|');
    if (k === key) return;
    key = k;
    clear(host);
    host.classList.toggle('amber', !!badge?.amber);
    const hk = effectiveHotkey('tool.' + t.id);
    const name = h('span.to-tool', { title: hk ? `${t.title} (${hk})` : t.title });
    name.innerHTML = svgIcon(t.icon);
    name.append(h('span', {}, t.title));
    host.append(name);
    if (modes.length) {
      const seg = h('div.to-modes', { role: 'radiogroup', 'aria-label': t.id === 'select' ? 'Selection filter' : 'Mode' });
      if (t.id === 'select') seg.append(h('span.to-lab', {}, 'Select:'));
      for (const m of modes) {
        seg.append(h('button.to-mode' + (m.id === cur ? '.on' : ''), { type: 'button', role: 'radio', 'aria-checked': m.id === cur ? 'true' : 'false', 'data-mode': m.id, title: m.title ?? m.label, onclick: () => { t.setMode?.(app, m.id); key = ''; render(); (document.activeElement as HTMLElement | null)?.blur?.(); } }, m.label));
      }
      host.append(seg);
    }
    if (toggles.length) {
      const tg = h('div.to-toggles', { role: 'group', 'aria-label': 'Options' });
      for (const x of toggles) {
        tg.append(h('button.to-toggle' + (x.on ? '.on' : ''), { type: 'button', role: 'checkbox', 'aria-checked': x.on ? 'true' : 'false', 'data-toggle': x.id, title: x.title ?? x.label, onclick: () => { t.toggle?.(app, x.id); key = ''; render(); (document.activeElement as HTMLElement | null)?.blur?.(); } }, (x.on ? '☑ ' : '☐ ') + x.label));
      }
      host.append(tg);
    }
    host.append(h('span.spacer'));
    if (badge) host.append(h('span.to-badge' + (badge.amber ? '.amber' : ''), { 'data-badge': '1' }, badge.text));
  };
  app.setRenderer('options', render);
  render();
  return render;
}
