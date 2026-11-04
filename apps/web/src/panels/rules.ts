/**
 * Rule library window: create libraries (copy of the active size line), list rules with their
 * per-size increments, create rules from typed values / from a point / from a whole contour,
 * apply by number or name to the selected points, Load Sizes from a library.
 */
import type { App } from '../app';
import type { Id, GradeInc } from '@prowdcad/kernel';
import { floatingWindow } from '../ui/window';
import { h, clear } from '../ui/dom';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { showDialog, confirmDialog } from '../ui/dialog';
import { fmt, unitLabel, parseLen } from '../units-ui';
import { toast } from '../ui/toast';
import { pick } from '../tools/pick';
import { settings, saveSettings } from '../settings';

let libId: Id | null = null;
let unsub: (() => void) | null = null;

export function openRuleLibrary(app: App) {
  const win = floatingWindow('rules', 'Rule library', { width: 560, onClose: () => { unsub?.(); unsub = null; } });
  const run = (label: string, fn: () => unknown) => { try { const r = fn(); if (r instanceof Promise) r.catch(err => reportError(err, label)); } catch (err) { reportError(err, label); } };
  const render = () => {
    if (!win.isOpen()) return;
    clear(win.body); clear(win.foot);
    const libs = app.style.ruleLibraries;
    if (!libs.some(l => l.id === libId)) libId = libs[0]?.id ?? null;
    const top = h('div.btnrow');
    const sel = h('select') as HTMLSelectElement;
    for (const l of libs) sel.append(h('option', { value: l.id }, `${l.name} (${l.rules.length})`));
    if (libId) sel.value = libId;
    sel.onchange = () => { libId = sel.value; render(); };
    top.append(libs.length ? sel : h('span.dim', {}, 'No library yet.'),
      h('button.btn.sm', { onclick: () => run('New library', async () => {
        const r = await showDialog({ title: 'New rule library', message: 'Uses a copy of the active size line.', fields: [{ kind: 'text', key: 'n', label: 'Name', value: `${app.style.name} rules` }] });
        if (r) { libId = ops.createLibrary(app.doc, String(r.n) || 'Rules'); }
      }) }, '+ Library'),
      h('label.chk', {}, h('input', { type: 'checkbox', checked: settings.showRuleNames, onchange: (e: Event) => { settings.showRuleNames = (e.target as HTMLInputElement).checked; saveSettings(); app.invalidate('canvas'); } }), ' Show rule names'));
    win.body.append(top);
    const lib = libs.find(l => l.id === libId);
    if (!lib) return;
    const line = lib.sizeLine;
    const t = h('table.fw-table');
    t.append(h('tr', {}, h('th', {}, '#'), h('th', {}, 'Name'), ...line.sizes.map(s => h('th', {}, s.name + (s.id === line.baseSizeId ? ' ★' : ''))), h('th', {}, '')));
    for (const rule of [...lib.rules].sort((a, b) => a.number - b.number)) {
      t.append(h('tr', {}, h('td', {}, String(rule.number)), h('td', {}, rule.name),
        ...line.sizes.map(s => { const v = rule.inc[s.id] ?? { dx: 0, dy: 0 }; return h('td.mono', {}, `${fmt(v.dx)}, ${fmt(v.dy)}`); }),
        h('td', {}, h('button.mini', { title: 'Apply to selected points', onclick: () => run('Apply rule', () => {
          const sel = app.sel.anchors; if (!sel.length) throw new Error('Select point(s) first');
          app.doc.transact('Apply rule', () => { const by = new Map<Id, Id[]>(); for (const a of sel) by.set(a.pieceId, [...(by.get(a.pieceId) ?? []), a.anchorId]); for (const [p, ids] of by) ops.applyRule(app.doc, p, ids, rule.id, { libraryId: lib.id }); });
        }) }, '→'))));
    }
    win.body.append(lib.rules.length ? t : h('div.empty', {}, 'No rules. Create from values, a point or a contour.'));
    win.body.append(h('div.dim', {}, `Increments per size (dX, dY) in ${unitLabel()}.`));
    win.foot.append(
      h('button.btn.sm', { onclick: () => run('Rule from values', async () => {
        const r = await showDialog({ title: 'Rule from values', wide: true, message: 'Incremental dX, dY per size, e.g. "-5, 2" (fractions accepted).', fields: [
          { kind: 'number', key: 'num', label: 'Number', value: Math.max(0, ...lib.rules.map(x => x.number)) + 1, min: 0 },
          { kind: 'text', key: 'name', label: 'Name', value: '' },
          ...line.sizes.filter(s => s.id !== line.sizes[0].id).map(s => ({ kind: 'text' as const, key: 's_' + s.id, label: s.name, value: '0, 0' })),
        ] });
        if (!r) return;
        const vals: Record<string, GradeInc> = {};
        for (const s of line.sizes) {
          const raw = r['s_' + s.id]; if (raw === undefined) continue;
          const [x, y] = String(raw).split(',').map(q => parseLen(q.trim() || '0'));
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${s.name}: invalid values`);
          vals[s.id] = { dx: x, dy: y };
        }
        ops.createRuleFromValues(app.doc, lib.id, vals, { number: r.num as number, name: String(r.name) || undefined });
      }) }, 'From values…'),
      h('button.btn.sm', { onclick: () => run('Rule from point', async () => {
        const p = await pick(app, { kind: 'anchor', prompt: 'Rule from point: click a graded point' });
        if (!p || p === 'done' || p.kind !== 'anchor') return;
        const r = await showDialog({ title: 'Rule from point', fields: [{ kind: 'number', key: 'num', label: 'Number', value: Math.max(0, ...lib.rules.map(x => x.number)) + 1, min: 0 }, { kind: 'text', key: 'name', label: 'Name', value: p.hit.anchor.name ?? '' }] });
        if (r) ops.createRuleFromPoint(app.doc, lib.id, p.hit.piece.id, p.hit.anchor.id, { number: r.num as number, name: String(r.name) || undefined });
      }) }, 'From point…'),
      h('button.btn.sm', { onclick: () => run('Rules from contour', async () => {
        const pc = app.primaryPiece() ?? await (async () => { const p = await pick(app, { kind: 'piece', prompt: 'Click the piece' }); return p && p !== 'done' && p.kind === 'piece' ? p.piece : undefined; })();
        if (!pc) return;
        const r = await showDialog({ title: `Rules from contour — ${pc.name}`, fields: [{ kind: 'number', key: 'start', label: 'Start number', value: Math.max(0, ...lib.rules.map(x => x.number)) + 1, min: 0 }, { kind: 'text', key: 'prefix', label: 'Name prefix', value: pc.name + ' ' }, { kind: 'checkbox', key: 'link', label: 'Link points to the new rules', value: true }] });
        if (r) { const rs = ops.createRuleSetFromContour(app.doc, lib.id, pc.id, { startNumber: r.start as number, prefix: String(r.prefix), link: !!r.link }); toast(`${rs.length} rules created`, 'ok'); }
      }) }, 'From contour…'),
      h('button.btn.sm', { onclick: () => run('Apply rule', async () => {
        const r = await showDialog({ title: 'Apply rule to selected points', fields: [{ kind: 'text', key: 'r', label: 'Number or name', value: '' }] });
        if (!r) return;
        const v = String(r.r).trim(); const sel = app.sel.anchors; if (!sel.length) throw new Error('Select point(s) first');
        app.doc.transact('Apply rule', () => { for (const a of sel) ops.applyRule(app.doc, a.pieceId, a.anchorId, /^\d+$/.test(v) ? Number(v) : v, { libraryId: lib.id }); });
      }) }, 'Apply #/name…'),
      h('span.spacer'),
      h('button.btn.sm', { title: 'New size table from this library\'s size line; grading remapped by size name', onclick: () => run('Load sizes', async () => {
        if (await confirmDialog('Load sizes from library', `Re-point all pieces to a new size table: ${line.sizes.map(s => s.name).join(' ')}?`, 'Load')) { ops.loadSizesFromLibrary(app.doc, lib.id, { activate: true }); app.activeSize = app.baseSize(); }
      }) }, 'Load sizes'),
    );
  };
  unsub?.(); unsub = app.doc.on(() => requestAnimationFrame(render));
  render();
}
