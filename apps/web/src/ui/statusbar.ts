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
  const prompt = h('span.sb-prompt');
  const sel = h('span.sb-sel');
  host.append(cursor, h('span.sb-sep'), h('label.sb-l', {}, 'Unit ', unitSel), h('label.sb-l', {}, 'Size ', sizeSel), zoom, h('span.sb-sep'), sel, prompt, msg);

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
    const S = app.sel; const np = S.pieces.length;
    const subs = [[S.anchors.length, 'pt'], [S.segments.length, 'seg'], [S.internals.length, 'int'], [S.notches.length, 'notch'], [S.marks.length, 'mark']].filter(([n]) => n).map(([n, l]) => `${n} ${l}`);
    sel.textContent = np || subs.length ? `${np} piece${np === 1 ? '' : 's'}${subs.length ? ' · ' + subs.join(' · ') : ''}` : '';
    // step prompt of the active tool (always shown) + the last message
    prompt.textContent = app.tool?.hint?.(app) || '';
    const amber = app.tool?.badge?.(app)?.amber && app.tool.id !== 'select';
    prompt.classList.toggle('amber', !!amber);
    msg.textContent = app.statusMsg || '';
  };
  app.setRenderer('status', render);
  render();
}
