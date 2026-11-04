/** Bottom status bar: cursor (display unit), unit switch (mm / cm / in decimal / in fractions), active size, zoom, tool hint. */
import type { App } from '../app';
import { h, clear } from './dom';
import { fmt, unitLabel } from '../units-ui';
import { settings } from '../settings';
import { PX_PER_MM_100 } from '../canvas/view';
import type { Unit } from '@prowdcad/kernel';

const UNIT_OPTS: { v: string; label: string; unit: Unit; den: number }[] = [
  { v: 'mm', label: 'mm', unit: 'mm', den: settings.fracDen },
  { v: 'cm', label: 'cm', unit: 'cm', den: settings.fracDen },
  { v: 'in0', label: 'in (decimal)', unit: 'in', den: 0 },
  { v: 'in8', label: 'in 1/8', unit: 'in', den: 8 },
  { v: 'in16', label: 'in 1/16', unit: 'in', den: 16 },
  { v: 'in32', label: 'in 1/32', unit: 'in', den: 32 },
  { v: 'in64', label: 'in 1/64', unit: 'in', den: 64 },
];

export function mountStatusbar(app: App, host: HTMLElement) {
  clear(host);
  const cursor = h('span.sb-cursor');
  const unitSel = h('select.sb-unit', { title: 'Display unit' }) as HTMLSelectElement;
  for (const o of UNIT_OPTS) unitSel.append(h('option', { value: o.v }, o.label));
  unitSel.onchange = () => {
    const o = UNIT_OPTS.find(o => o.v === unitSel.value)!;
    app.setUnit(o.unit, o.unit === 'in' ? o.den : undefined);
    unitSel.blur();
  };
  const sizeSel = h('select.sb-size', { title: 'Active size' }) as HTMLSelectElement;
  sizeSel.onchange = () => { app.activeSize = sizeSel.value; app.invalidate(); sizeSel.blur(); };
  const zoom = h('button.sb-zoom', { title: 'Click: 100 % (true size) · Ctrl+0 fit' });
  zoom.onclick = () => { const v = app.view; v.zoomAt({ x: v.W / 2, y: v.H / 2 }, PX_PER_MM_100 / v.scale); app.invalidate('canvas', 'status'); };
  const msg = h('span.sb-msg');
  const sel = h('span.sb-sel');
  host.append(cursor, h('span.sb-sep'), h('label.sb-l', {}, 'Unit ', unitSel), h('label.sb-l', {}, 'Size ', sizeSel), zoom, h('span.sb-sep'), sel, msg);

  const render = () => {
    const c = app.cursorWorld;
    cursor.textContent = c ? `X ${fmt(c.x)}  Y ${fmt(c.y)} ${unitLabel()}` : `X —  Y — ${unitLabel()}`;
    unitSel.value = settings.unit === 'in' ? 'in' + (settings.fracDen || 0) : settings.unit;
    if (!UNIT_OPTS.some(o => o.v === unitSel.value)) unitSel.value = 'in0';
    const line = app.sizeLine();
    const key = line.sizes.map(s => s.id + s.name).join('|') + line.baseSizeId;
    if (sizeSel.dataset.key !== key) {
      clear(sizeSel);
      for (const s of line.sizes) sizeSel.append(h('option', { value: s.id }, s.name + (s.id === line.baseSizeId ? ' (base)' : '')));
      sizeSel.dataset.key = key;
    }
    sizeSel.value = app.activeSize;
    zoom.textContent = `${Math.round(app.view.scale / PX_PER_MM_100 * 100)}%`;
    const np = app.sel.pieces.length, na = app.sel.anchors.length;
    sel.textContent = np || na ? `${np} piece${np === 1 ? '' : 's'}${na ? ` · ${na} pt` : ''}` : '';
    msg.textContent = app.statusMsg || app.tool?.hint?.(app) || '';
  };
  app.setRenderer('status', render);
  render();
}
