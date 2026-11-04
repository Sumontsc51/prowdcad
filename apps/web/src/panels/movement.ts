/**
 * Movement programs window (made-to-measure): create programs (measurement name), add moves from
 * the selected points (mm per +1 mm of the measurement), remove moves, apply a delta (optionally
 * as new piece versions), measurement sets and apply-set (base → target).
 */
import type { App } from '../app';
import type { Id } from '@prowdcad/kernel';
import { floatingWindow } from '../ui/window';
import { h, clear } from '../ui/dom';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { showDialog } from '../ui/dialog';
import { fmt, unitLabel, parseLen } from '../units-ui';
import { toast } from '../ui/toast';

let progId: Id | null = null;
let unsub: (() => void) | null = null;

export function openMovement(app: App) {
  const win = floatingWindow('movement', 'Movement programs', { width: 540, onClose: () => { unsub?.(); unsub = null; } });
  const run = (label: string, fn: () => unknown) => { try { const r = fn(); if (r instanceof Promise) r.catch(err => reportError(err, label)); } catch (err) { reportError(err, label); } };
  const render = () => {
    if (!win.isOpen()) return;
    clear(win.body); clear(win.foot);
    const progs = app.style.movementPrograms;
    if (!progs.some(p => p.id === progId)) progId = progs[0]?.id ?? null;
    const sel = h('select') as HTMLSelectElement;
    for (const p of progs) sel.append(h('option', { value: p.id }, `${p.name} — ${p.measurement} (${p.moves.length})`));
    if (progId) sel.value = progId;
    sel.onchange = () => { progId = sel.value; render(); };
    win.body.append(h('div.btnrow', {}, progs.length ? sel : h('span.dim', {}, 'No program.'), h('button.btn.sm', { onclick: () => run('New program', async () => {
      const r = await showDialog({ title: 'New movement program', fields: [{ kind: 'text', key: 'n', label: 'Name', value: 'Chest' }, { kind: 'text', key: 'm', label: 'Measurement', value: 'chest' }] });
      if (r) progId = ops.createProgram(app.doc, String(r.n), String(r.m));
    }) }, '+ Program')));
    const prog = progs.find(p => p.id === progId);
    if (prog) {
      const t = h('table.fw-table');
      t.append(h('tr', {}, h('th', {}, 'Piece'), h('th', {}, 'Point'), h('th', {}, `dX / +1`), h('th', {}, 'dY / +1'), h('th', {}, '')));
      for (const m of prog.moves) {
        const pc = app.style.pieces.find(p => p.id === m.pieceId);
        const idx = pc ? pc.sew.points.findIndex(a => a.id === m.anchorId) : -1;
        t.append(h('tr', {}, h('td', {}, pc?.name ?? '?'), h('td', {}, idx >= 0 ? String(idx + 1) : 'int'), h('td', {}, m.dx.toFixed(4)), h('td', {}, m.dy.toFixed(4)),
          h('td', {}, h('button.mini', { onclick: () => run('Remove move', () => ops.removeMove(app.doc, prog.id, m.pieceId, m.anchorId)) }, '×'))));
      }
      win.body.append(prog.moves.length ? t : h('div.empty', {}, 'Select points and press “Add moves from selection”.'));
    }
    const sets = app.style.measurementSets;
    win.body.append(h('div.insp-title', {}, `Measurement sets (${sets.length})`), ...sets.map(s => h('div.dim', {}, `${s.name}: ${Object.entries(s.values).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`)));
    win.foot.append(
      h('button.btn.sm', { disabled: !prog, onclick: () => run('Add moves', async () => {
        if (!prog) return; const sel = app.sel.anchors; if (!sel.length) throw new Error('Select point(s) first');
        const r = await showDialog({ title: `Moves per +1 mm of ${prog.measurement}`, fields: [{ kind: 'number', key: 'dx', label: 'dX ratio', value: 0.25 }, { kind: 'number', key: 'dy', label: 'dY ratio', value: 0 }] });
        if (r) app.doc.transact('Add moves', () => sel.forEach(a => ops.addMove(app.doc, prog.id, { pieceId: a.pieceId, anchorId: a.anchorId, dx: r.dx as number, dy: r.dy as number })));
      }) }, 'Add moves from selection…'),
      h('button.btn.sm.primary', { disabled: !prog, onclick: () => run('Apply delta', async () => {
        if (!prog) return;
        const r = await showDialog({ title: `Apply ${prog.name}`, fields: [{ kind: 'length', key: 'd', label: `Change of ${prog.measurement}`, value: 10 }, { kind: 'checkbox', key: 'ver', label: 'Write as new piece versions', value: false }] });
        if (r) { const res = ops.applyMeasurementDelta(app.doc, prog.id, r.d as number, { asNewPieceVersion: !!r.ver }); toast(`Moved ${Object.values(res.moved).flat().length} point(s)`, 'ok'); }
      }) }, 'Apply delta…'),
      h('span.spacer'),
      h('button.btn.sm', { onclick: () => run('Measurement set', async () => {
        const r = await showDialog({ title: 'New measurement set', message: `One per line: name value (${unitLabel()})`, fields: [{ kind: 'text', key: 'n', label: 'Name', value: 'Customer' }, { kind: 'textarea', key: 'v', label: 'Values', value: progs.map(p => `${p.measurement} 0`).join('\n'), rows: 6, mono: true }] });
        if (!r) return;
        const vals: Record<string, number> = {};
        for (const ln of String(r.v).split('\n')) { const m = /^\s*(\S+)\s+(.+)$/.exec(ln); if (m) { const v = parseLen(m[2]); if (Number.isFinite(v)) vals[m[1]] = v; } }
        ops.addMeasurementSet(app.doc, String(r.n), vals);
      }) }, '+ Set…'),
      h('button.btn.sm', { disabled: sets.length < 2, onclick: () => run('Apply set', async () => {
        const opts = sets.map(s => ({ value: s.id, label: s.name }));
        const r = await showDialog({ title: 'Apply measurement set', fields: [{ kind: 'select', key: 'b', label: 'Base (pattern)', value: opts[0].value, options: opts }, { kind: 'select', key: 't', label: 'Target (customer)', value: opts[1].value, options: opts }, { kind: 'checkbox', key: 'ver', label: 'New piece versions', value: true }] });
        if (r) { const res = ops.applyMeasurementSet(app.doc, String(r.b), String(r.t), { asNewPieceVersion: !!r.ver }); toast(`Deltas: ${Object.entries(res.deltas).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`, 'ok', 5000); }
      }) }, 'Apply set…'),
    );
  };
  unsub?.(); unsub = app.doc.on(() => requestAnimationFrame(render));
  render();
}
