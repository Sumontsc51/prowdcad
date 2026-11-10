/**
 * Notch grid editor (floating window): every notch of a piece; the selected fromPrev/fromNext notch
 * shows its per-size distance grid (ops.notchDistanceGrid) with direct cell editing
 * (ops.setNotchDistance), Fill all, Extrapolate increment (from two sizes) and Paste TSV
 * (Excel block; rows = notches, columns = sizes, optional header row of size names).
 * Also: change type/depth/width/angle/mode, convert placement (Global Notch Grading), delete.
 */
import type { App } from '../app';
import type { Id, Notch, NotchType } from '@prowdcad/kernel';
import { floatingWindow, windowOpen } from '../ui/window';
import { h, clear } from '../ui/dom';
import { lengthInput, numberInput, selectInput } from './widgets';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { showDialog } from '../ui/dialog';
import { unitLabel } from '../units-ui';
import { sizeGrid, keepScroll, type SGState } from './sizegrid';
const NG = { scroll: { scrollTop: 0 } as SGState };

let state: { pieceId: Id; notchId: Id | null } | null = null;
let unsub: (() => void) | null = null;

const describe = (n: Notch) => n.placement.kind === 'proportional' ? `${n.placement.pct.toFixed(2)} %` : n.placement.kind === 'anchor' ? 'on point' : n.placement.kind;

export function openNotchGrid(app: App, pieceId: Id, notchId: Id | null = null) {
  state = { pieceId, notchId };
  const win = floatingWindow('notchgrid', 'Notches', { width: 520, onClose: () => { state = null; unsub?.(); unsub = null; } });
  const render = () => {
    if (!state || !win.isOpen()) return;
    if (win.el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    keepScroll(win.body, NG.scroll); clear(win.body); clear(win.foot);
    const piece = app.doc.style.pieces.find(p => p.id === state!.pieceId);
    if (!piece) { win.body.append(h('div.empty', {}, 'Piece no longer exists.')); return; }
    win.setTitle(`Notches — ${piece.name}`);
    if (!piece.notches.length) { win.body.append(h('div.empty', {}, 'No notches. Use the Notch tool (N).')); return; }
    if (!state.notchId || !piece.notches.some(n => n.id === state!.notchId)) state.notchId = piece.notches[0].id;
    const tx = (label: string, fn: () => void | Promise<void>) => { try { const r = fn(); if (r) r.catch(err => reportError(err, label)); } catch (err) { reportError(err, label); } };
    // list
    const list = h('div.ng-list');
    piece.notches.forEach((n, i) => {
      const contour = n.contourId === piece.sew.id ? 'sew' : 'int';
      list.append(h('button.ng-item' + (n.id === state!.notchId ? '.on' : ''), { onclick: () => { state!.notchId = n.id; render(); } },
        `${i + 1}. ${n.type} · ${describe(n)} · ${contour}${n.source && n.source !== 'manual' ? ' · ' + n.source : ''}`));
    });
    win.body.append(list);
    const n = piece.notches.find(x => x.id === state!.notchId)!;
    const setN = (label: string, fn: (m: Notch) => void) => tx(label, () => app.doc.transact(label, () => { const m = app.doc.piece(piece.id).notches.find(x => x.id === n.id); if (m) fn(m); }));
    const props = h('div.ng-props',
      {},
      h('label', {}, 'Type ', selectInput(n.type, (['slit', 'T', 'V', 'U', 'castle'] as NotchType[]).map(t => [t, t]), v => setN('Notch type', m => { m.type = v as NotchType; }))),
      h('label', {}, 'Depth ', lengthInput(n.depth, v => setN('Notch depth', m => { m.depth = v; }), { min: 0.01 })),
      h('label', {}, 'Width ', lengthInput(n.width, v => setN('Notch width', m => { m.width = v; }), { min: 0 })),
      h('label', {}, 'Angle ', numberInput(n.angleDeg, v => setN('Notch angle', m => { m.angleDeg = v; }), { decimals: 2 }), '°'),
      h('label', {}, 'Mode ', selectInput(n.mode ?? 'cut', [['cut', 'cut'], ['draw', 'draw']], v => setN('Notch mode', m => { m.mode = v as 'cut' | 'draw'; }))),
    );
    win.body.append(props);
    // grid
    if (n.placement.kind === 'fromPrev' || n.placement.kind === 'fromNext') {
      let grid: { sizeId: string; name: string; value: number }[] = [];
      try { grid = ops.notchDistanceGrid(app.doc, piece, n.id); } catch (err) { reportError(err, 'Notch grid'); }
      // rows = sizes (shared size grid: arrows / Enter / Tab, paste an Excel column into consecutive sizes)
      const line = app.sizeLine();
      const rows = grid.map(g => ({ id: g.sizeId, name: g.name, base: g.sizeId === line.baseSizeId, active: g.sizeId === app.activeSize }));
      const sg = sizeGrid({
        rows, state: NG.scroll, cls: 'ngtab', maxHeight: 360,
        cols: [
          { key: 'dist', head: `Distance ${n.placement.kind === 'fromPrev' ? 'from previous' : 'from next'} (${unitLabel()})`, edit: true, attrs: { 'data-col': 'dist' }, get: r => grid[r].value },
          { key: 'inc', head: 'Δ prev', get: r => (r ? grid[r].value - grid[r - 1].value : null) },
        ],
        onCommit: cells => { tx('Notch distance', () => app.doc.transact(cells.length > 1 ? 'Paste notch distances' : 'Notch distance', () => { for (const c of cells) if (c.v >= 0) ops.setNotchDistance(app.doc, piece, n.id, grid[c.r].sizeId, c.v); })); try { grid.splice(0, grid.length, ...ops.notchDistanceGrid(app.doc, app.doc.piece(piece.id), n.id)); } catch { /* */ } },
      });
      win.body.append(sg.el);
      win.foot.append(
        h('button.btn.sm', { onclick: async () => {
          const r = await showDialog({ title: 'Fill all sizes', fields: [{ kind: 'length', key: 'v', label: 'Distance', value: grid.find(g => g.sizeId === app.activeSize)?.value ?? 0, min: 0 }] });
          if (r) tx('Fill all', () => ops.fillAllNotchDistances(app.doc, piece, n.id, r.v as number));
        } }, 'Fill all…'),
        h('button.btn.sm', { onclick: async () => {
          const opts = grid.map(g => ({ value: g.sizeId, label: g.name }));
          const r = await showDialog({ title: 'Extrapolate increment', message: 'The per-size increment between two sizes is extended linearly to every size.', fields: [
            { kind: 'select', key: 'a', label: 'From size', value: opts[0]?.value ?? '', options: opts },
            { kind: 'select', key: 'b', label: 'To size', value: opts[Math.min(1, opts.length - 1)]?.value ?? '', options: opts },
          ], validate: v => v.a === v.b ? 'Choose two different sizes' : null });
          if (r) tx('Extrapolate', () => ops.extrapolateNotchIncrement(app.doc, piece, n.id, String(r.a), String(r.b)));
        } }, 'Extrapolate…'),
      );
    } else win.body.append(h('div.dim', {}, n.placement.kind === 'proportional' ? `Proportional: ${n.placement.pct.toFixed(3)} % of the segment in every size.` : 'Anchored: the notch follows its point in every size.'));
    win.foot.append(
      h('button.btn.sm', { title: 'Paste an Excel block: rows = notches (from the selected one), columns = sizes', onclick: async () => {
        const floating = piece.notches.filter(x => x.placement.kind === 'fromPrev' || x.placement.kind === 'fromNext');
        const r = await showDialog({ title: 'Paste notch grid (TSV)', wide: true, message: `Rows = notches in list order starting at the selected one (${floating.length} floating notches). Columns = sizes (${app.sizeLine().sizes.map(s => s.name).join(' ')}). An optional first row of size names maps columns. Values in ${app.style.units}.`, fields: [{ kind: 'textarea', key: 't', label: '', value: '', rows: 8, mono: true }] });
        if (!r) return;
        const start = Math.max(0, floating.findIndex(x => x.id === n.id));
        tx('Paste grid', () => { const k = ops.pasteNotchGrid(app.doc, piece, floating.slice(start).map(x => x.id), String(r.t)); app.status(`${k} cell(s) pasted`); });
      } }, 'Paste TSV…'),
      h('span.spacer'),
      h('button.btn.sm', { onclick: () => tx('Global notch grading', async () => {
        const r = await showDialog({ title: 'Global Notch Grading', message: 'Convert floating notches of this piece to one placement rule (base positions preserved).', fields: [
          { kind: 'select', key: 'rule', label: 'Rule', value: 'proportional', options: [{ value: 'fromPrev', label: 'From previous' }, { value: 'fromNext', label: 'From next' }, { value: 'proportional', label: 'Proportional' }] },
          { kind: 'select', key: 'per', label: 'Per size (prev/next)', value: 'preserve', options: [{ value: 'preserve', label: 'Keep each size\'s position' }, { value: 'constant', label: 'Constant (base distance)' }] },
          { kind: 'checkbox', key: 'one', label: 'Only the selected notch', value: false },
        ] });
        if (r) { const k = ops.globalNotchGrading(app.doc, piece, r.rule as 'fromPrev', { perSize: r.per as 'preserve', notchIds: r.one ? [n.id] : undefined }); app.status(`${k} notch(es) converted`); }
      }) }, 'Convert…'),
      h('button.btn.sm.danger', { onclick: () => tx('Delete notch', () => app.doc.transact('Delete notch', () => { const pc = app.doc.piece(piece.id); pc.notches = pc.notches.filter(x => x.id !== n.id); })) }, 'Delete'),
    );
  };
  unsub?.();
  unsub = app.doc.on(() => requestAnimationFrame(render));
  render();
}

export function notchGridOpen() { return windowOpen('notchgrid'); }
