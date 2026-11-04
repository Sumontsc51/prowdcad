/**
 * Sizes panel: the size line (click = active size, ★ = base), nested view toggle showing all
 * sizes colour-coded with per-size visibility, and size-line editing (rename / add / remove /
 * set base) through ops-bridge (ops/sizes) with a safe foundation fallback for rename & colour.
 */
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { sizeColor } from '../geometry';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { showDialog } from '../ui/dialog';

export function renderSizes(app: App, host: HTMLElement) {
  clear(host);
  const line = app.sizeLine();
  const top = h('div.sz-top');
  const nested = h('label.chk', {}, h('input', { type: 'checkbox', checked: app.nested, onchange: (e: Event) => { app.nested = (e.target as HTMLInputElement).checked; app.invalidate(); } }), ' Nested view (all sizes)');
  top.append(nested, h('span.dim', {}, `${line.name} · ${line.sizes.length} sizes`));
  host.append(top);
  const strip = h('div.sz-line');
  for (const s of line.sizes) {
    const isBase = s.id === line.baseSizeId, isAct = s.id === app.activeSize, hid = app.nestedHidden.has(s.id);
    const chip = h('div.sz-chip' + (isAct ? '.act' : '') + (hid && app.nested ? '.off' : ''), { title: 'Click: active size · Alt-click: show/hide in nested view · double-click: edit' });
    chip.append(h('span.sw', { style: `background:${sizeColor(line, s.id)}` }), h('span', {}, s.name + (isBase ? ' ★' : '')));
    chip.onclick = e => {
      if (e.altKey) { if (hid) app.nestedHidden.delete(s.id); else app.nestedHidden.add(s.id); }
      else app.activeSize = s.id;
      app.invalidate();
    };
    chip.ondblclick = () => void editSize(app, s.id);
    strip.append(chip);
  }
  host.append(strip);
  const bar = h('div.btnrow');
  bar.append(
    h('button.btn.sm', { onclick: () => void addSize(app) }, '+ Size'),
    h('button.btn.sm', { onclick: () => { try { ops.setBaseSize(app.doc, app.activeSize); } catch (err) { reportError(err, 'Set base size'); } } }, 'Set base'),
    h('button.btn.sm', { onclick: () => { if (app.activeSize === line.baseSizeId) return; try { ops.removeSize(app.doc, app.activeSize); } catch (err) { reportError(err, 'Remove size'); } } }, 'Remove'),
  );
  host.append(bar);
}

async function addSize(app: App) {
  const r = await showDialog({ title: 'Add size', fields: [{ kind: 'text', key: 'name', label: 'Name', value: '' }] });
  if (!r || !String(r.name).trim()) return;
  try { ops.addSize(app.doc, { name: String(r.name).trim(), after: app.activeSize }); } catch (err) { reportError(err, 'Add size'); }
}

async function editSize(app: App, id: string) {
  const line = app.sizeLine();
  const s = line.sizes.find(x => x.id === id); if (!s) return;
  const r = await showDialog({ title: `Size ${s.name}`, fields: [
    { kind: 'text', key: 'name', label: 'Name', value: s.name },
    { kind: 'text', key: 'color', label: 'Nested colour', value: s.color ?? sizeColor(line, id), placeholder: '#rrggbb' },
  ] });
  if (!r) return;
  app.doc.transact('Edit size', () => {
    const ss = app.doc.sizeTable().axis1.sizes.find(x => x.id === id)!;
    ss.name = String(r.name).trim() || ss.name;
    const c = String(r.color).trim();
    ss.color = /^#[0-9a-f]{3,8}$/i.test(c) ? c : undefined;
  });
}
