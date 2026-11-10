/**
 * Grade Rules window (Grade ▸ Rule library…, Shift+Alt+R) — AccuMark rule tables made friendlier:
 *
 * - Library picker (+ Library = copy of the active size line; Load sizes re-points the style).
 * - Rule CHIPS (#number name). Click = show it in the table (Shift/Ctrl+click = several, one column
 *   pair each); drag a chip onto a grade point on the canvas = apply it; double-click = apply to the
 *   selected points. With the window open, select points on the canvas and type a rule number
 *   (+ Enter, or pause) to apply it (main.ts → ruleDigitKey).
 * - Rule table: ROWS = the library's sizes, COLUMNS = dX dY of each chosen rule, in the plain-language
 *   views “Step into this size” / “Total from base size”. Editing = Modify Rule (Edit Rule Delta):
 *   every point linked to the rule follows (setRuleValues + refreshRuleLinks).
 * - Size breaks (◆ gutter), Smart fill (Equal steps / Interpolate / Repeat step / Split by break),
 *   live nest strip of the rule's path.
 * - New rule (zero, or from values / point / contour), Copy Table Rule (optionally flipped),
 *   Rename / renumber, Delete (linked points keep their values), Apply / Detach.
 */
import type { App } from '../app';
import type { Id, GradeInc, RuleLibrary, GradeRule, FillMethod, SizeId } from '@prowdcad/kernel';
import { floatingWindow, windowOpen } from '../ui/window';
import { h, clear } from '../ui/dom';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { showDialog, confirmDialog } from '../ui/dialog';
import { unitLabel, parseLen } from '../units-ui';
import { toast } from '../ui/toast';
import { pick } from '../tools/pick';
import { settings, saveSettings } from '../settings';
import { sizeGrid, keepScroll, sizeRows, type SGCol, type SGState } from './sizegrid';
import { drawNestStrip, type LiveCell } from './grading';
import { anchorNear } from '../hitkit';

const RS = {
  libId: null as Id | null,
  ruleIds: [] as Id[],
  view: 'step' as 'step' | 'total',
  scroll: { scrollTop: 0 } as SGState,
  typed: new Map<string, Map<number, number>>(),
  typedView: 'step' as 'step' | 'total',
  method: 'linear' as FillMethod,
  live: null as LiveCell | null,
  aff: new Set<number>(),
};
let unsub: (() => void) | null = null;

export function ruleWindowOpen() { return windowOpen('rules'); }
export function currentLibrary(app: App): RuleLibrary | undefined { return app.style.ruleLibraries.find(l => l.id === RS.libId) ?? app.style.ruleLibraries[0]; }

/** apply a rule (id or number) to the selected points (grouped by piece), one undo step */
export function applyRuleToSelection(app: App, rule: Id | number, libId?: Id): number {
  const sel = app.sel.anchors; if (!sel.length) throw new Error('Select point(s) first');
  const lib = libId ?? currentLibrary(app)?.id;
  app.doc.transact('Apply rule', () => {
    const by = new Map<Id, Id[]>(); for (const a of sel) by.set(a.pieceId, [...(by.get(a.pieceId) ?? []), a.anchorId]);
    for (const [p, ids] of by) ops.applyRule(app.doc, p, ids, rule, lib ? { libraryId: lib } : {});
  });
  return sel.length;
}

/** canvas drop target for rule chips (registered once) */
let dropWired = false;
function wireDrop(app: App) {
  if (dropWired) return; dropWired = true;
  const el = document.getElementById('canvas'); if (!el) return;
  el.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('text/prowd-rule')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  el.addEventListener('drop', e => {
    const data = e.dataTransfer?.getData('text/prowd-rule'); if (!data) return;
    e.preventDefault();
    const [libId, ruleId] = data.split(':');
    const svg = el.querySelector('svg'); const r = (svg ?? el).getBoundingClientRect();
    const w = app.view.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
    const hit = anchorNear(app, w, { tolPx: 14 });
    if (!hit) { toast('Drop the rule chip on a point', 'warn'); return; }
    // dropping on a selected point applies to the whole selection, else to that point only
    const inSel = app.sel.anchors.some(a => a.anchorId === hit.anchor.id);
    try {
      if (inSel) applyRuleToSelection(app, ruleId, libId);
      else { ops.applyRule(app.doc, hit.piece.id, [hit.anchor.id], ruleId, { libraryId: libId }); app.selectAnchor(hit.ref); }
      const rule = app.style.ruleLibraries.find(l => l.id === libId)?.rules.find(x => x.id === ruleId);
      app.status(`Rule #${rule?.number ?? '?'} applied to ${inSel ? app.sel.anchors.length + ' point(s)' : 'point ' + (hit.index + 1)}`);
    } catch (err) { reportError(err, 'Apply rule'); }
  });
}

export function openRuleLibrary(app: App) {
  const win = floatingWindow('rules', 'Grade rules', { width: 640, onClose: () => { unsub?.(); unsub = null; } });
  win.el.classList.add('rwin');
  wireDrop(app);
  const run = (label: string, fn: () => unknown) => { try { const r = fn(); if (r instanceof Promise) r.catch(err => reportError(err, label)); } catch (err) { reportError(err, label); } };
  const render = () => {
    if (!win.isOpen()) return;
    if (win.el.contains(document.activeElement) && (document.activeElement as HTMLElement).classList.contains('sg-in')) return; // never rebuild under the cursor
    keepScroll(win.body, RS.scroll); clear(win.body); clear(win.foot);
    const libs = app.style.ruleLibraries;
    if (!libs.some(l => l.id === RS.libId)) RS.libId = libs[0]?.id ?? null;
    const top = h('div.btnrow');
    const sel = h('select.r-lib') as HTMLSelectElement;
    for (const l of libs) sel.append(h('option', { value: l.id }, `${l.name} (${l.rules.length})`));
    if (RS.libId) sel.value = RS.libId;
    sel.onchange = () => { RS.libId = sel.value; RS.ruleIds = []; render(); };
    sel.addEventListener('keydown', e => e.stopPropagation());
    top.append(libs.length ? sel : h('span.dim', {}, 'No rule library yet.'),
      h('button.btn.sm', { onclick: () => run('New library', async () => {
        const r = await showDialog({ title: 'New rule library', message: 'Uses a copy of the active size line.', fields: [{ kind: 'text', key: 'n', label: 'Name', value: `${app.style.name} rules` }] });
        if (r) { RS.libId = ops.createLibrary(app.doc, String(r.n) || 'Rules'); }
      }) }, '+ Library'),
      h('label.chk', { title: 'Rule numbers as badges next to grade points (colour = rule / edited / graded / ungraded)' }, h('input', { type: 'checkbox', checked: settings.showRuleNames, onchange: (e: Event) => { settings.showRuleNames = (e.target as HTMLInputElement).checked; saveSettings(); app.invalidate('canvas'); } }), ' Badges on canvas'));
    win.body.append(top);
    const lib = libs.find(l => l.id === RS.libId);
    if (!lib) { win.body.append(h('div.empty', {}, 'Create a library (+ Library): it holds numbered rules for a size line, like an AccuMark rule table.')); return; }
    const line = lib.sizeLine;
    RS.ruleIds = RS.ruleIds.filter(id => lib.rules.some(r => r.id === id));
    // chips
    const selRuleIds = new Set(app.sel.anchors.map(a => { try { return app.doc.piece(a.pieceId) && [app.doc.piece(a.pieceId).sew, ...app.doc.piece(a.pieceId).internals].flatMap(c => c.points).find(x => x.id === a.anchorId)?.ruleId; } catch { return undefined; } }).filter(Boolean));
    const chips = h('div.r-chips');
    for (const rule of [...lib.rules].sort((a, b) => a.number - b.number)) {
      const on = RS.ruleIds.includes(rule.id);
      const chip = h('button.r-chip' + (on ? '.on' : '') + (selRuleIds.has(rule.id) ? '.used' : ''), {
        draggable: 'true', 'data-rule': String(rule.number),
        title: `#${rule.number} ${rule.name}\nClick = show in the table (Shift / Ctrl = several) · double-click = apply to the selected points · drag onto a point = apply`,
        onclick: (ev: Event) => { const e = ev as MouseEvent; if (e.shiftKey || e.ctrlKey || e.metaKey) RS.ruleIds = on ? RS.ruleIds.filter(x => x !== rule.id) : [...RS.ruleIds, rule.id]; else RS.ruleIds = [rule.id]; RS.typed.clear(); render(); },
        ondblclick: () => run('Apply rule', () => { const n = applyRuleToSelection(app, rule.id, lib.id); app.status(`Rule #${rule.number} applied to ${n} point(s)`); }),
      }, h('b', {}, '#' + rule.number), rule.name && rule.name !== String(rule.number) ? ' ' + rule.name : '');
      chip.addEventListener('dragstart', e => { e.dataTransfer?.setData('text/prowd-rule', `${lib.id}:${rule.id}`); e.dataTransfer?.setData('text/plain', String(rule.number)); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; });
      chips.append(chip);
    }
    chips.append(h('button.r-chip.add', { title: 'New rule with zero values (fill it in the table)', onclick: () => run('New rule', () => { const r = ops.createRuleFromValues(app.doc, lib.id, {}, {}); RS.ruleIds = [r.id]; }) }, '+ Rule'));
    win.body.append(chips);
    // quick apply
    const qa = h('input.r-quick', { type: 'text', placeholder: 'rule #', title: 'Type a rule number and press Enter to apply it to the selected points (or select points on the canvas and just type the number)' }) as HTMLInputElement;
    qa.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { const v = qa.value.trim(); if (!v) return; run('Apply rule', () => { const n = applyRuleToSelection(app, /^\d+$/.test(v) ? Number(v) : v, lib.id); app.status(`Rule ${v} applied to ${n} point(s)`); qa.value = ''; }); } });
    win.body.append(h('div.btnrow.r-apply', {}, h('span.dim', {}, `Selected points: ${app.sel.anchors.length}`), qa,
      h('button.btn.sm', { disabled: !RS.ruleIds.length || !app.sel.anchors.length, onclick: () => run('Apply rule', () => { const n = applyRuleToSelection(app, RS.ruleIds[0], lib.id); app.status(`Applied to ${n} point(s)`); }) }, 'Apply shown rule'),
      h('button.btn.sm', { disabled: !app.sel.anchors.length, title: 'Keep the values, drop the rule link', onclick: () => run('Detach', () => app.doc.transact('Detach rule', () => { for (const a of app.sel.anchors) ops.detachRule(app.doc, a.pieceId, a.anchorId); })) }, 'Detach'),
      h('span.dim', {}, '· drag a chip onto a point')));

    // rule table
    const rules = RS.ruleIds.map(id => lib.rules.find(r => r.id === id)!).filter(Boolean);
    if (!rules.length) {
      win.body.append(h('div.empty', {}, lib.rules.length ? 'Click a rule chip to see and edit its values (rows = sizes).' : 'No rules yet. + Rule, or From point / From contour below.'));
    } else {
      const b = line.sizes.findIndex(s => s.id === line.baseSizeId);
      const sizes = line.sizes;
      const totals = rules.map(r => {
        const abs = incToAbs(r, line);
        return { total: { dx: sizes.map(s => abs[s.id]?.dx ?? 0), dy: sizes.map(s => abs[s.id]?.dy ?? 0) } };
      });
      const breaks = (() => { try { return ops.sizeBreaks(app.doc, line.id); } catch { return []; } })();
      const brkIdx = breaks.map(id => sizes.findIndex(s => s.id === id)).filter(i => i >= 0);
      const mode = h('div.seg');
      for (const [v, l] of [['step', 'Step into this size'], ['total', 'Total from base size']] as const) mode.append(h('button' + (RS.view === v ? '.on' : ''), { 'data-view': v, onclick: () => { RS.view = v; RS.typed.clear(); render(); } }, l));
      const linked = app.style.pieces.reduce((n, p) => n + [p.sew, ...p.internals].flatMap(c => c.points).filter(a => rules.some(r => r.id === a.ruleId)).length, 0);
      win.body.append(h('div.btnrow', {}, mode, h('span.dim', {}, `${unitLabel()} · ${linked} linked point(s) follow every edit`)));
      const valOf = (k: number, axis: 'dx' | 'dy') => (RS.view === 'total' ? totals[k].total[axis] : ops.outwardSteps(totals[k].total[axis], b));
      const cols: SGCol[] = [];
      rules.forEach((r, k) => {
        for (const axis of ['dx', 'dy'] as const) {
          const ck = r.id + ':' + axis;
          cols.push({ key: ck, group: `#${r.number} ${r.name !== String(r.number) ? r.name : ''}`.trim(), head: axis === 'dx' ? 'dX' : 'dY', edit: true, attrs: { 'data-rule': String(r.number), 'data-axis': axis },
            get: i => valOf(k, axis)[i], ro: i => i === b, cls: i => (RS.typed.get(ck)?.has(i) ? 'typed' : '') });
        }
      });
      const note = h('div.gr-note' + (RS.view === 'step' ? '.warn' : ''), {}, RS.view === 'step' ? 'Step view: editing a size’s step also moves every size further from the base (tinted while editing).' : 'Total view: each cell is the offset from the base ★ — editing changes that size only.');
      const strip = h('div.gr-strip');
      const commit = (cells: { r: number; c: number; v: number }[]) => {
        const touched = new Map<number, { dx: number[]; dy: number[] }>();
        for (const { r, c, v } of cells) {
          const [rid, axis] = cols[c].key.split(':') as [Id, 'dx' | 'dy']; const k = rules.findIndex(x => x.id === rid); if (k < 0 || r === b) continue;
          const t = touched.get(k) ?? { dx: totals[k].total.dx.slice(), dy: totals[k].total.dy.slice() };
          if (RS.view === 'total') t[axis][r] = v; else { const st = ops.outwardSteps(t[axis], b); st[r] = v; t[axis] = ops.totalsFromSteps(st, b); }
          touched.set(k, t);
          let m = RS.typed.get(cols[c].key); if (!m) RS.typed.set(cols[c].key, m = new Map()); m.set(r, v); RS.typedView = RS.view;
        }
        writeRules(app, lib, rules, touched, 'Modify rule');
        RS.live = null;
        // fresh values for the grid (it keeps focus, the window is not rebuilt while typing)
        rules.forEach((r, k) => { const rr = app.style.ruleLibraries.find(l => l.id === lib.id)?.rules.find(x => x.id === r.id); if (!rr) return; const abs = incToAbs(rr, line); totals[k].total = { dx: sizes.map(s => abs[s.id]?.dx ?? 0), dy: sizes.map(s => abs[s.id]?.dy ?? 0) }; });
        queueMicrotask(() => drawNestStrip(strip, line, totals, b, app.activeSize, null));
      };
      const grid = sizeGrid({
        rows: sizeRows(line, app.activeSize, breaks), cols, state: RS.scroll, cls: 'rtab', maxHeight: Math.min(380, window.innerHeight - 360),
        onCommit: commit,
        rowClass: i => (RS.aff.has(i) ? 'aff' : ''),
        rowExtra: i => h('button.sg-brk' + (brkIdx.includes(i) ? '.on' : ''), { title: 'Size break', onclick: (e: Event) => { e.stopPropagation(); if (i === b) return; const s = new Set(breaks); if (s.has(sizes[i].id)) s.delete(sizes[i].id); else s.add(sizes[i].id); run('Size breaks', () => ops.setSizeBreaks(app.doc, line.id, sizes.filter(x => s.has(x.id)).map(x => x.id))); } }, '◆'),
        onFocus: (i) => { RS.aff = new Set(ops.affectedSizes(sizes.length, b, i, RS.view)); for (const tr of grid.table.querySelectorAll('tbody tr[data-r]')) tr.classList.toggle('aff', RS.aff.has(+(tr as HTMLElement).dataset.r!)); },
        onInput: (i, c, v) => { const [rid, axis] = cols[c].key.split(':'); const k = rules.findIndex(x => x.id === rid); RS.live = v === null || k < 0 ? null : { k, axis: axis as 'dx' | 'dy', r: i, v, view: RS.view }; drawNestStrip(strip, line, totals, b, app.activeSize, RS.live); },
      });
      win.body.append(note, h('div.gr-body', {}, grid.el, strip));
      drawNestStrip(strip, line, totals, b, app.activeSize, null);
      const msel = h('select') as HTMLSelectElement;
      for (const [v, l] of [['linear', 'Equal steps'], ['interpolate', 'Interpolate'], ['repeat', 'Repeat step'], ['breaks', 'Split by break']] as const) msel.append(h('option', { value: v }, l));
      msel.value = RS.method; msel.onchange = () => { RS.method = msel.value as FillMethod; }; msel.addEventListener('keydown', e => e.stopPropagation());
      const nTyped = [...RS.typed.values()].reduce((n, m) => n + m.size, 0);
      win.body.append(h('div.gr-fill', {}, h('span.dim', {}, 'Smart fill:'), msel,
        h('button.btn.sm.primary' + (nTyped ? '' : '.disabled'), { 'data-act': 'fill', onclick: () => run('Fill', () => {
          const touched = new Map<number, { dx: number[]; dy: number[] }>();
          rules.forEach((r, k) => {
            const t = { dx: totals[k].total.dx.slice(), dy: totals[k].total.dy.slice() }; let any = false;
            for (const axis of ['dx', 'dy'] as const) { const m = RS.typed.get(r.id + ':' + axis); if (!m?.size) continue; any = true; t[axis] = ops.smartFill(t[axis], b, [...m].map(([i, v]) => ({ i, v })), RS.typedView, RS.method, brkIdx).totals; }
            if (any) touched.set(k, t);
          });
          if (!touched.size) { toast('Type a few size rows first (they get a dot), then Fill', 'warn'); return; }
          writeRules(app, lib, rules, touched, 'Smart fill rule'); RS.typed.clear();
        }) }, `Fill${nTyped ? ` (${nTyped} typed)` : ''}`),
        h('span.dim', {}, breaks.length ? `Breaks: ${breaks.map(id => sizes.find(s => s.id === id)?.name).join(' ')}` : 'Breaks: click ◆ next to a size')));
      // rule actions
      const r0 = rules[0];
      win.body.append(h('div.btnrow', {},
        h('button.btn.sm', { title: 'Copy Table Rule: duplicate under a new number (optionally flipped)', onclick: () => run('Copy rule', async () => {
          const d = await showDialog({ title: `Copy rule #${r0.number}`, fields: [{ kind: 'number', key: 'n', label: 'New number', value: Math.max(0, ...lib.rules.map(x => x.number)) + 1, min: 0 }, { kind: 'text', key: 'name', label: 'Name', value: r0.name === String(r0.number) ? '' : r0.name + ' copy' }, { kind: 'checkbox', key: 'fx', label: 'Flip X', value: false }, { kind: 'checkbox', key: 'fy', label: 'Flip Y', value: false }] });
          if (d) { const c = ops.copyRule(app.doc, lib.id, r0.id, { number: d.n as number, name: String(d.name) || undefined, flipX: !!d.fx, flipY: !!d.fy }); RS.ruleIds = [c.id]; }
        }) }, 'Copy rule…'),
        h('button.btn.sm', { onclick: () => run('Rename rule', async () => {
          const d = await showDialog({ title: `Rule #${r0.number}`, fields: [{ kind: 'number', key: 'n', label: 'Number', value: r0.number, min: 0 }, { kind: 'text', key: 'name', label: 'Name', value: r0.name }] });
          if (d) ops.renameRule(app.doc, lib.id, r0.id, { number: d.n as number, name: String(d.name) });
        }) }, 'Rename…'),
        h('button.btn.sm.danger', { onclick: () => run('Delete rule', async () => { if (await confirmDialog('Delete rule', `Delete rule #${r0.number}? Linked points keep their values.`, 'Delete')) { ops.deleteRule(app.doc, lib.id, r0.id); RS.ruleIds = []; } }) }, 'Delete')));
    }
    win.foot.append(
      h('button.btn.sm', { onclick: () => run('Rule from values', async () => {
        const r = await showDialog({ title: 'Rule from values', wide: true, message: 'Step into each size (dX, dY), e.g. "-5, 2" — fractions accepted.', fields: [
          { kind: 'number', key: 'num', label: 'Number', value: Math.max(0, ...lib.rules.map(x => x.number)) + 1, min: 0 },
          { kind: 'text', key: 'name', label: 'Name', value: '' },
          ...line.sizes.filter(s => s.id !== line.baseSizeId).map(s => ({ kind: 'text' as const, key: 's_' + s.id, label: s.name, value: '0, 0' })),
        ] });
        if (!r) return;
        const b = line.sizes.findIndex(s => s.id === line.baseSizeId);
        const st = { dx: line.sizes.map(() => 0), dy: line.sizes.map(() => 0) };
        line.sizes.forEach((s, i) => {
          const raw = r['s_' + s.id]; if (raw === undefined) return;
          const [x, y] = String(raw).split(',').map(q => parseLen(q.trim() || '0'));
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${s.name}: invalid values`);
          st.dx[i] = x; st.dy[i] = y;
        });
        const tx = ops.totalsFromSteps(st.dx, b), ty = ops.totalsFromSteps(st.dy, b);
        const vals: Record<string, GradeInc> = {}; line.sizes.forEach((s, i) => { vals[s.id] = { dx: tx[i], dy: ty[i] }; });
        const rule = ops.createRuleFromValues(app.doc, lib.id, vals, { number: r.num as number, name: String(r.name) || undefined, view: 'absolute' });
        RS.ruleIds = [rule.id];
      }) }, 'From values…'),
      h('button.btn.sm', { onclick: () => run('Rule from point', async () => {
        const p = app.primaryAnchor() ? { kind: 'anchor' as const, hit: { piece: app.primaryAnchor()!.piece, anchor: app.primaryAnchor()!.anchor } } : await pick(app, { kind: 'anchor', prompt: 'Rule from point: click a graded point' });
        if (!p || p === 'done' || p.kind !== 'anchor') return;
        const r = await showDialog({ title: 'Rule from point', fields: [{ kind: 'number', key: 'num', label: 'Number', value: Math.max(0, ...lib.rules.map(x => x.number)) + 1, min: 0 }, { kind: 'text', key: 'name', label: 'Name', value: p.hit.anchor.name ?? '' }, { kind: 'checkbox', key: 'link', label: 'Link the point to the new rule', value: true }] });
        if (!r) return;
        const rule = ops.createRuleFromPoint(app.doc, lib.id, p.hit.piece.id, p.hit.anchor.id, { number: r.num as number, name: String(r.name) || undefined });
        if (r.link) ops.applyRule(app.doc, p.hit.piece.id, [p.hit.anchor.id], rule.id, { libraryId: lib.id });
        RS.ruleIds = [rule.id];
      }) }, 'From point…'),
      h('button.btn.sm', { onclick: () => run('Rules from contour', async () => {
        const pc = app.primaryPiece() ?? await (async () => { const p = await pick(app, { kind: 'piece', prompt: 'Click the piece' }); return p && p !== 'done' && p.kind === 'piece' ? p.piece : undefined; })();
        if (!pc) return;
        const r = await showDialog({ title: `Rules from contour — ${pc.name}`, fields: [{ kind: 'number', key: 'start', label: 'Start number', value: Math.max(0, ...lib.rules.map(x => x.number)) + 1, min: 0 }, { kind: 'text', key: 'prefix', label: 'Name prefix', value: pc.name + ' ' }, { kind: 'checkbox', key: 'link', label: 'Link points to the new rules', value: true }] });
        if (r) { const rs = ops.createRuleSetFromContour(app.doc, lib.id, pc.id, { startNumber: r.start as number, prefix: String(r.prefix), link: !!r.link }); toast(`${rs.length} rules created`, 'ok'); }
      }) }, 'From contour…'),
      h('span.spacer'),
      h('button.btn.sm', { title: 'New size table from this library\'s size line; grading remapped by size name', onclick: () => run('Load sizes', async () => {
        if (await confirmDialog('Load sizes from library', `Re-point all pieces to a new size table: ${line.sizes.map(s => s.name).join(' ')}?`, 'Load')) { ops.loadSizesFromLibrary(app.doc, lib.id, { activate: true }); app.activeSize = app.baseSize(); }
      }) }, 'Load sizes'),
    );
  };
  unsub?.(); unsub = app.doc.on(() => requestAnimationFrame(render));
  const unsel = () => requestAnimationFrame(render);
  (openRuleLibrary as unknown as { _rerender?: () => void })._rerender = unsel;
  render();
}

/** re-render the window (selection changed) */
export function refreshRuleWindow() { (openRuleLibrary as unknown as { _rerender?: () => void })._rerender?.(); }

function incToAbs(r: GradeRule, line: RuleLibrary['sizeLine']): Record<SizeId, GradeInc> {
  // incremental (kernel convention) → absolute offsets from the library base
  const out: Record<SizeId, GradeInc> = {};
  const ids = line.sizes.map(s => s.id); const b = ids.indexOf(line.baseSizeId);
  let x = 0, y = 0; const cum: GradeInc[] = [];
  for (const id of ids) { const g = r.inc[id] ?? { dx: 0, dy: 0 }; x += g.dx; y += g.dy; cum.push({ dx: x, dy: y }); }
  ids.forEach((id, i) => { out[id] = { dx: cum[i].dx - cum[b].dx, dy: cum[i].dy - cum[b].dy }; });
  return out;
}

function writeRules(app: App, lib: RuleLibrary, rules: GradeRule[], touched: Map<number, { dx: number[]; dy: number[] }>, label: string) {
  try {
    app.doc.transact(label, () => {
      for (const [k, t] of touched) {
        const vals: Record<SizeId, GradeInc> = {};
        lib.sizeLine.sizes.forEach((s, i) => { vals[s.id] = { dx: t.dx[i], dy: t.dy[i] }; });
        ops.setRuleValues(app.doc, lib.id, rules[k].id, vals, { view: 'absolute' });
      }
    });
  } catch (err) { reportError(err, 'Rule'); }
}

// ───────────── click a point, type a number = apply rule #n ─────────────
let digitBuf = '';
let digitTimer = 0;
/**
 * With the Grade Rules window open (or rule badges on) and points selected, digits typed on the
 * canvas collect a rule number: Enter (or a 1.2 s pause) applies it, Esc / Backspace edit it.
 * Returns true when the key was consumed (main.ts calls this before the tool's own keys).
 */
export function ruleDigitKey(app: App, e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const active = (ruleWindowOpen() || settings.ruleBadges) && app.sel.anchors.length > 0;
  if (!active) { digitBuf = ''; return false; }
  const apply = () => {
    window.clearTimeout(digitTimer);
    const n = digitBuf; digitBuf = '';
    if (!n) return;
    try {
      const found = ops.findRule(app.doc, Number(n), currentLibrary(app)?.id) ?? ops.findRule(app.doc, Number(n));
      if (!found) { toast(`No rule #${n}`, 'warn'); app.status(`No rule #${n}`); return; }
      const k = applyRuleToSelection(app, found.rule.id, found.lib.id);
      app.status(`Rule #${n}${found.rule.name && found.rule.name !== n ? ' ' + found.rule.name : ''} applied to ${k} point(s)`);
    } catch (err) { reportError(err, 'Apply rule'); }
  };
  if (/^[0-9]$/.test(e.key)) {
    digitBuf += e.key;
    window.clearTimeout(digitTimer);
    digitTimer = window.setTimeout(apply, 1200);
    app.status(`Apply rule #${digitBuf} to ${app.sel.anchors.length} point(s) · Enter = apply now · Esc = cancel`);
    return true;
  }
  if (!digitBuf) return false;
  if (e.key === 'Enter') { apply(); return true; }
  if (e.key === 'Backspace') { digitBuf = digitBuf.slice(0, -1); app.status(digitBuf ? `Apply rule #${digitBuf}` : 'Rule number cleared'); return true; }
  if (e.key === 'Escape') { window.clearTimeout(digitTimer); digitBuf = ''; app.status('Rule number cancelled'); return true; }
  return false;
}
