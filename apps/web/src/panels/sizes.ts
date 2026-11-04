/**
 * Sizes panel: the size line (click = active size, ★ = base, Alt-click = show/hide in nested view,
 * double-click = rename / colour), nested view toggle, and the size-line editor backed by ops/sizes:
 * insert before / after (with half-size fraction or end extrapolation), append, remove, set base;
 * axis-2 variation summary; housekeeping (ungraded / invisible sizes); export size as standalone.
 */
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { sizeColor } from '../geometry';
import { ops } from '../ops-bridge';
import { reportError, runCommand } from '../commands';
import { showDialog, confirmDialog } from '../ui/dialog';

export function renderSizes(app: App, host: HTMLElement) {
  clear(host);
  const line = app.sizeLine();
  const table = app.doc.sizeTable();
  const top = h('div.sz-top');
  const nested = h('label.chk', {}, h('input', { type: 'checkbox', checked: app.nested, onchange: (e: Event) => { app.nested = (e.target as HTMLInputElement).checked; app.invalidate(); } }), ' Nested view');
  top.append(nested, h('span.dim', {}, `${line.name} · ${line.sizes.length} sizes`));
  host.append(top);
  const strip = h('div.sz-line');
  for (const s of line.sizes) {
    const isBase = s.id === line.baseSizeId, isAct = s.id === app.activeSize, hid = app.nestedHidden.has(s.id);
    const chip = h('div.sz-chip' + (isAct ? '.act' : '') + (hid && app.nested ? '.off' : ''), { title: 'Click: active size · Alt-click: show/hide in nested view · double-click: rename / colour' });
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
  const safe = (label: string, fn: () => unknown) => async () => { try { await fn(); } catch (err) { reportError(err, label); } };
  host.append(h('div.btnrow', {},
    h('button.btn.sm', { title: 'Insert a size before / after the active size', onclick: safe('Insert size', () => insertSize(app)) }, '+ Insert'),
    h('button.btn.sm', { title: 'Append a size at the end of the line', onclick: safe('Append size', async () => {
      const r = await showDialog({ title: 'Append size', fields: [{ kind: 'text', key: 'n', label: 'Name', value: '' }, { kind: 'checkbox', key: 'ext', label: 'Extrapolate the last increment', value: true }], validate: v => String(v.n).trim() ? null : 'Name required' });
      if (r) app.activeSize = ops.appendSize(app.doc, String(r.n).trim(), { extrapolate: !!r.ext });
    }) }, '+ Append'),
    h('button.btn.sm', { onclick: safe('Set base size', () => ops.setBase(app.doc, app.activeSize)), disabled: app.activeSize === line.baseSizeId }, 'Set base'),
    h('button.btn.sm', { disabled: app.activeSize === line.baseSizeId, onclick: safe('Remove size', async () => {
      const nm = line.sizes.find(s => s.id === app.activeSize)?.name;
      if (await confirmDialog('Remove size', `Remove size ${nm}? Neighbouring sizes keep their geometry.`, 'Remove')) { ops.removeSize(app.doc, app.activeSize); app.activeSize = app.baseSize(); }
    }) }, 'Remove'),
  ));
  host.append(h('div.btnrow', {},
    h('button.btn.sm', { onclick: () => void runCommand('size.axis2') }, table.axis2 ? `Axis 2: ${table.axis2.sizes.map(s => s.name).join(' ')}` : 'Axis 2 (variation)…'),
    h('button.btn.sm', { onclick: () => void runCommand('size.deleteUngraded') }, 'Del ungraded'),
    h('button.btn.sm', { onclick: () => void runCommand('size.deleteInvisible') }, 'Del invisible'),
    h('button.btn.sm', { onclick: () => void runCommand('file.export.standalone') }, 'Size → style'),
  ));
}

async function insertSize(app: App) {
  const line = app.sizeLine();
  const act = line.sizes.find(s => s.id === app.activeSize)!;
  const r = await showDialog({ title: `Insert size next to ${act.name}`, fields: [
    { kind: 'text', key: 'n', label: 'Name', value: '' },
    { kind: 'radio', key: 'where', label: 'Position', value: 'after', options: [{ value: 'before', label: `Before ${act.name}` }, { value: 'after', label: `After ${act.name}` }] },
    { kind: 'number', key: 'f', label: 'Fraction of the neighbour increment', value: 0.5, min: 0, max: 1, hint: '0.5 = half size between two sizes' },
    { kind: 'checkbox', key: 'ext', label: 'At an end of the line: extrapolate', value: true },
  ], validate: v => String(v.n).trim() ? (line.sizes.some(s => s.name === String(v.n).trim()) ? 'Name already used' : null) : 'Name required' });
  if (!r) return;
  app.activeSize = ops.insertSize(app.doc, { name: String(r.n).trim(), [r.where === 'before' ? 'before' : 'after']: act.id, fraction: r.f as number, extrapolate: !!r.ext });
}

async function editSize(app: App, id: string) {
  const line = app.sizeLine();
  const s = line.sizes.find(x => x.id === id); if (!s) return;
  const r = await showDialog({ title: `Size ${s.name}`, fields: [
    { kind: 'text', key: 'name', label: 'Name', value: s.name },
    { kind: 'text', key: 'color', label: 'Nested colour', value: s.color ?? sizeColor(line, id), placeholder: '#rrggbb' },
  ] });
  if (!r) return;
  try {
    app.doc.transact('Edit size', () => {
      const nm = String(r.name).trim();
      if (nm && nm !== s.name) ops.renameSize(app.doc, id, nm);
      const ss = app.doc.sizeTable().axis1.sizes.find(x => x.id === id)!;
      const c = String(r.color).trim();
      ss.color = /^#[0-9a-f]{3,8}$/i.test(c) ? c : undefined;
    });
  } catch (err) { reportError(err, 'Edit size'); }
}
