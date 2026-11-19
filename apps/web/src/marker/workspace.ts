/**
 * Marker making workspace: a full-screen room over the pattern sheet.
 *   left   — cut plan builder: order per size, limits, Auto plan, and the editable list of markers (ratio, plies)
 *   strip  — marker tools: Nest ▶ / Stop, turn, unplace, push, clear, zoom, check, export, report
 *   centre — the marker: fabric of the set width; parts not laid yet wait in the tray above it
 * Everything is kept with the style (style.meta.marker); every change is one undo step (Ctrl+Z works here).
 */
import {
  autoCutPlan, planTotals, markerParts, markerStats, markerProblems, placedPoly, placedPoint, polyBox, placeAt, nestJob,
  markerDXF, markerHPGL, partLabel, markerPerimeter, DEFAULT_ANNOT, type MarkerAnnot, switchMarkerMaterial, directedParts, obeyDirection, directionGroup, groupMayTurn, throwParts, type MarkerDirection, type MarkerDoc, type MarkerRow, type MarkerPart, type Placements, type Placement, type Vec,
} from '@prowdcad/kernel';
import type { App } from '../app';
import { h, clear, isTyping } from '../ui/dom';
import { toast } from '../ui/toast';
import { confirmDialog, alertDialog, dialogOpen, showDialog } from '../ui/dialog';
import { download, pickFiles, loadStyle } from '../actions/file';
import { ops } from '../ops-bridge';
import { openContextMenu } from '../ui/menu';
import { fmt, unitLabel, parseLen } from '../units-ui';
import { startNest, type NestRun } from './nester';

const SIZE_COL = ['#d62728', '#ff7f0e', '#2ca02c', '#1f77b4', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f'];
const TIMES: [number, string][] = [[15, '15 s'], [30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min']];

let root: HTMLElement | null = null;
export const markerOpen = () => !!root;

export function openMarker(app: App) {
  if (root) return;
  const sizes = () => app.doc.sizeLine().sizes;
  const sid = () => sizes().map(s => s.id);
  // ── data kept with the style
  const blank = (): MarkerDoc => ({ order: {}, maxPlies: 50, maxBundles: 6, width: 1500, gap: 0, material: '', nestSeconds: 30, rows: [] });
  const M = (): MarkerDoc => app.doc.style.meta.marker ?? blank();
  const edit = (label: string, fn: (m: MarkerDoc) => void) => {
    try { app.doc.transact(label, s => { const m: MarkerDoc = s.meta.marker ? s.meta.marker : (s.meta.marker = blank()); fn(m); }); } catch (err) { toast((err as Error).message, 'error'); }
    partsKey = ''; draw();
  };
  // ── view state (not saved)
  let cur = M().rows[0]?.id ?? '';
  let sel = new Set<string>();
  let view = { k: 0.25, ox: 40, oy: 40 };            // screen = (mm · k) + o ; the fabric's y runs down the screen
  let parts: MarkerPart[] = [], partsKey = '', tray: Placements = {}, bad = new Set<string>();
  // Picking up and throwing (classic marker making): a click on a part picks it up and it follows the cursor; press and pull = a
  // direction line, let go = the part shoots that way until it touches; a plain click puts it down where it is.
  //   carry.base = where the carried parts were picked up (their turn may change while carried); carry.shift = how far the cursor took them
  let carry: { ids: string[]; grab: string; base: Placements; at: Vec; shift: Vec; fresh: boolean } | null = null;
  let press: { x: number; y: number } | null = null;
  let aim: { from: Vec; to: Vec } | null = null, anim = 0, raf = 0;
  let planOpen = true;
  const rule = (): MarkerDirection => M().direction ?? 'bundle';
  const r180 = (): boolean => M().rot180 ?? true;
  const RULES: [MarkerDirection, string, string][] = [
    ['bundle', 'One bundle, one direction', 'Every part of a bundle faces the same way. With Rotate 180° on, a bundle may be turned as a whole.'],
    ['size', 'Same size, same direction', 'All bundles of a size face the same way; the nester may lay the sizes opposite ways.'],
    ['all', 'All bundles one direction', 'Every part faces the same way (one-way fabric, nap).'],
    ['piece', 'By piece setting', 'Each part on its own, as far as its piece allows (Inspector ▸ Order ▸ Rotation).'],
  ];
  /** set the direction rule / the 180° switch; parts laid against the new rule go back to waiting */
  function setRule(next: { direction?: MarkerDirection; rot180?: boolean }) {
    let off = 0;
    edit('Marker direction', d => {
      if (next.direction) d.direction = next.direction;
      if (next.rot180 !== undefined) d.rot180 = next.rot180;
      for (const r of d.rows) {
        const ps = markerParts(app.doc, r.ratio, { material: d.material || undefined, block: d.block, buffer: d.buffer });
        const res = obeyDirection(ps, r.placements, d.direction ?? 'bundle', d.rot180 ?? true);
        r.placements = res.placements; off += res.removed;
      }
    });
    if (off) toast(`${off} part${off > 1 ? 's' : ''} faced the other way and went back to waiting`, 'warn');
  }
  /** the direction a part must take when it is laid now: that of the parts of its group already on the marker */
  function groupRot(p: MarkerPart, pl: Placements): number {
    const ru = rule(); if (ru === 'piece') return 0;
    const g = directionGroup(p, ru);
    const mate = parts.find(q => q.id !== p.id && pl[q.id] && directionGroup(q, ru) === g);
    return mate ? pl[mate.id].rot : 0;
  }
  let pan: { x: number; y: number } | null = null;
  let run: NestRun | null = null, runRow = '', runTimer = 0, runBest = 0;
  let live: Placements | null = null;                // layout of the running nest, shown before it is kept
  const row = (): MarkerRow | undefined => M().rows.find(r => r.id === cur) ?? M().rows[0];
  /** fabric width of a marker (default: the marker on screen); every marker has its own */
  const wd = (r?: MarkerRow): number => (r ?? row())?.width ?? M().width;
  const pls = (): Placements => (live && row()?.id === runRow ? live : row()?.placements ?? {});

  // ── elements
  const planBox = h('div.mk-plan'), tools = h('div.mk-tools'), stat = h('div.mk-status');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'mk-svg'); svg.setAttribute('tabindex', '0');
  const top = h('div.mk-top');
  root = h('div.mk-root', { role: 'dialog', 'aria-label': 'Marker making' }, top, h('div.mk-body', {}, planBox, h('div.mk-work', {}, tools, h('div.mk-stage', {}, svg as unknown as HTMLElement))), stat);
  document.body.append(root);

  // ── geometry helpers
  function refreshParts() {
    const r = row(), m = M();
    const key = r ? JSON.stringify([r.id, r.ratio, m.material, m.block ?? null, m.buffer ?? null]) : '-';
    if (key === partsKey) return;
    partsKey = key;
    parts = r ? markerParts(app.doc, r.ratio, { material: m.material || undefined, block: m.block, buffer: m.buffer }) : [];
    sel = new Set([...sel].filter(id => parts.some(p => p.id === id)));
  }
  /** parts not laid yet wait in rows above the fabric (negative y) */
  function layTray() {
    tray = {};
    const p0 = pls(), wait = parts.filter(p => !p0[p.id]);
    let x = 0, y = -60, rowH = 0; const maxX = Math.max(3000, wd() * 2.5);
    for (const p of wait) {
      const b = polyBox(p.poly), w = b.x1 - b.x0, hh = b.y1 - b.y0;
      if (x > 0 && x + w > maxX) { x = 0; y -= rowH + 40; rowH = 0; }
      tray[p.id] = { x, y: y - hh, rot: 0 }; x += w + 40; rowH = Math.max(rowH, hh);
    }
  }
  const where = (p: MarkerPart) => carry?.base[p.id] ?? pls()[p.id] ?? tray[p.id];
  const S = (q: Vec) => ({ x: q.x * view.k + view.ox, y: q.y * view.k + view.oy });
  const W = (x: number, y: number): Vec => ({ x: (x - view.ox) / view.k, y: (y - view.oy) / view.k });
  const evW = (e: MouseEvent) => { const r = svg.getBoundingClientRect(); return W(e.clientX - r.left, e.clientY - r.top); };
  function fit() {
    const st = markerStats(parts, pls(), wd());
    const r = svg.getBoundingClientRect(); if (r.width < 50) return;
    let minY = 0; for (const id in tray) minY = Math.min(minY, tray[id].y);
    const maxX = Math.max(st.length, 1500, ...Object.values(tray).map(t => t.x + 600));
    const k = Math.min((r.width - 150) / maxX, (r.height - 70) / (wd() - minY));
    view = { k, ox: 30, oy: 30 - minY * k };
  }

  // ── commits
  const keep = (label: string, next: Placements, marry?: string[][]) => { const id = row()?.id; if (!id) return; edit(label, m => { const r = m.rows.find(x => x.id === id); if (!r) return; r.placements = next; const g = (marry ?? r.marry ?? []).map(x => x.filter(q => next[q])).filter(x => x.length > 1); if (g.length) r.marry = g; else delete r.marry; }); };
  const centre = (b: { x0: number; y0: number; x1: number; y1: number }): Vec => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  /** the parts married to a part (itself included) */
  const marriedTo = (id: string): Set<string> => new Set(row()?.marry?.find(g => g.includes(id)) ?? [id]);
  /**
   * Turn a part 180° (right-click). Only with Rotate 180° on: under "One bundle, one direction" every laid part of its bundle
   * turns with it, so the bundle keeps one direction; married parts turn together as one block, about their common middle.
   */
  function turn(id: string) {
    if (run) return;
    const ru = rule(), p = parts.find(q => q.id === id); if (!p) return;
    if (ru !== 'bundle' && ru !== 'piece') { toast(`"${RULES.find(x => x[0] === ru)![1]}" does not let parts be turned`, 'warn'); return; }
    if (ru === 'bundle' && !r180()) { toast('Rotate 180° is off: tick it at the top to turn parts with a right-click', 'warn'); return; }
    const wed = marriedTo(id), rigid = parts.filter(q => wed.has(q.id));
    let group = rigid.slice();
    if (ru === 'bundle') {
      const gs = new Set(rigid.map(q => directionGroup(q, ru)));
      for (const g of gs) if (!groupMayTurn(parts, g, ru, true)) { toast('This bundle has a one-way piece and cannot be turned (Inspector ▸ Order ▸ Rotation)', 'warn'); return; }
      group = parts.filter(q => gs.has(directionGroup(q, ru)));
    } else if (rigid.some(q => !q.angles.includes(180))) { toast('This piece may not be turned (Inspector ▸ Order ▸ Rotation)', 'warn'); return; }
    const laid = { ...(row()?.placements ?? {}) }; let changed = false;
    const curOf = (q: MarkerPart) => carry?.base[q.id] ?? laid[q.id];
    const boxes = rigid.map(q => curOf(q) && polyBox(placedPoly(q, curOf(q)!))).filter(Boolean) as ReturnType<typeof polyBox>[];
    const C = boxes.length > 1 ? centre({ x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)), x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1)) }) : null;
    for (const q of group) {
      const pl = curOf(q); if (!pl) continue;
      const oc = centre(polyBox(placedPoly(q, pl))), about = C && wed.has(q.id) ? C : oc;
      const rot = (pl.rot + 180) % 360, t = placeAt(q, 0, 0, rot), tc = centre(polyBox(placedPoly(q, t)));
      const np = { x: t.x + (2 * about.x - oc.x) - tc.x, y: t.y + (2 * about.y - oc.y) - tc.y, rot };
      if (carry?.base[q.id]) carry.base[q.id] = np; else { laid[q.id] = np; changed = true; }
    }
    if (changed) keep(ru === 'bundle' ? 'Turn bundle 180°' : 'Turn part 180°', laid); else drawSvg();
  }
  function unplaceSel() {
    if (carry) { dropCarry(true); return; }
    const next = { ...pls() }; let n = 0; for (const id of sel) if (next[id]) { delete next[id]; n++; }
    if (n) keep('Take part off the marker', next);
  }
  /** Marry the selected laid parts: from now on they are picked up, thrown and turned as one. */
  function marry() {
    const r = row(); if (!r || run) return;
    const ids = [...sel].filter(id => r.placements[id]);
    if (ids.length < 2) { toast('Marry: select two or more laid parts first (Shift+click adds a part)', 'warn'); return; }
    const all = new Set(ids); const rest: string[][] = [];
    for (const g of r.marry ?? []) { if (g.some(id => all.has(id))) g.forEach(id => all.add(id)); else rest.push(g); }
    keep('Marry parts', r.placements, [...rest, [...all]]);
    toast(`${all.size} parts married: they move as one`, 'ok');
  }
  function unmarry() {
    const r = row(); if (!r || run) return;
    const left = (r.marry ?? []).filter(g => !g.some(id => sel.has(id)));
    if (left.length === (r.marry ?? []).length) { toast('Select a married part to unmarry its group', 'warn'); return; }
    keep('Unmarry parts', r.placements, left);
    toast('Unmarried: the parts move on their own again', 'ok');
  }
  /** Block fuse: the pieces of the selected parts are laid as blocks (their box plus a margin), in every size and marker. */
  async function blockFuse() {
    if (run) return;
    const ps = parts.filter(p => sel.has(p.id)); const pieceIds = [...new Set(ps.map(p => p.pieceId))];
    if (!pieceIds.length) { toast('Block fuse: select a part of the piece first', 'warn'); return; }
    const curM = M().block?.[pieceIds[0]] ?? 0;
    const r = await showDialog({ title: 'Block fuse', message: `${[...new Set(ps.map(p => p.name))].join(', ')}\nThe piece is laid and cut as a block: its box grown by the margin on every side, in every size and every marker. The outline is drawn inside the block. Margin 0 takes the block off.`,
      fields: [{ kind: 'length', key: 'm', label: 'Block margin', value: curM || 10, min: 0 }] });
    if (!r) return;
    const mg = Math.max(0, r.m as number);
    edit(mg > 0 ? 'Block fuse' : 'Remove block', d => {
      const b = { ...(d.block ?? {}) };
      for (const id of pieceIds) { if (mg > 0) b[id] = mg; else delete b[id]; }
      if (Object.keys(b).length) d.block = b; else delete d.block;
      if (mg > 0 && d.buffer) { for (const id of pieceIds) delete d.buffer[id]; if (!Object.keys(d.buffer).length) delete d.buffer; }
      // the shape of these parts changed: they go back to waiting in every marker
      for (const row2 of d.rows) { for (const k of Object.keys(row2.placements)) if (pieceIds.some(id => k.startsWith(id + '|'))) delete row2.placements[k]; row2.marry = (row2.marry ?? []).map(g => g.filter(q => row2.placements[q])).filter(g => g.length > 1); if (!row2.marry.length) delete row2.marry; }
    });
    toast(mg > 0 ? `Block fuse: ${fmt(mg)} ${unitLabel()} margin · the parts wait to be laid again` : 'Block removed', 'ok');
  }
  // ── nesting
  function nestStart() {
    const r = row(); if (run || !r) return;
    if (carry) dropCarry(true);
    if (!parts.length) { toast('This marker has no parts: give it a ratio in the cut plan', 'warn'); return; }
    const w = wd();
    const np = directedParts(parts, rule(), r180());
    const wide = np.find(p => p.angles.every(a => { const b = polyBox(placedPoly(p, { x: 0, y: 0, rot: a })); return b.y1 - b.y0 > w; }));
    if (wide) { toast(`${wide.name} (${wide.sizeName}) is wider than the fabric`, 'error'); return; }
    const job = nestJob(np, w, { gap: M().gap, name: r.name });
    runRow = r.id; live = null; runBest = 0;
    try {
      run = startNest(job, M().nestSeconds, {
        onBest: (pl, len) => { live = pl; runBest = len; draw(); },
        onDone: info => {
          clearInterval(runTimer); const got = live; run = null; live = null;
          if (info.error) toast('Nester stopped: ' + info.error, 'error');
          if (got) { const id = runRow; edit('Nest marker', m => { const x = m.rows.find(q => q.id === id); if (x) { x.placements = got; delete x.marry; } }); toast(`Nested: ${fmt(runBest)} ${unitLabel()} long${info.stopped ? ' (stopped early)' : ''}`, 'ok'); }
          else draw();
        },
      });
      runTimer = window.setInterval(() => drawStatus(), 500);
    } catch (err) { run = null; toast('The nester could not start in this browser: ' + (err as Error).message, 'error'); }
    draw();
  }
  const nestStop = () => run?.stop();

  // ── export / report
  const base = () => `${app.doc.style.name || 'style'}_${(row()?.name ?? 'marker').replace(/\s+/g, '_')}`;
  const annot = (): MarkerAnnot => ({ ...DEFAULT_ANNOT, ...(M().annot ?? {}) });
  const ratioText = (r: MarkerRow) => sizes().filter(s => r.ratio[s.id]).map(s => `${s.name} ${r.ratio[s.id]}`).join(' ');
  const outOpt = (r: MarkerRow) => ({ annot: annot(), name: r.name, ratio: ratioText(r), styleName: app.doc.style.name });
  // ── files: a marker file (.pcm) holds the style with its cut plans and markers; a pattern file is .pcd; a plot is .plt
  let markerFile = (app.fileName || 'untitled').replace(/\.(pcd|pcm|prowd\.json|json|prowd)$/i, '') + '.pcm';
  async function saveMarker(as: boolean) {
    if (carry) dropCarry(true);
    if (as) {
      const r = await showDialog({ title: 'Save marker as', fields: [{ kind: 'text', key: 'n', label: 'File name', value: markerFile }] });
      if (!r) return;
      markerFile = (String(r.n).trim() || 'untitled').replace(/\.pcm$/i, '') + '.pcm';
    }
    download(markerFile, new Blob([ops.saveNative(app.doc, { pretty: true })], { type: 'application/json' }));
    toast(`Saved ${markerFile} (the style with its cut plans and markers)`, 'ok');
  }
  async function importMarker() {
    if (carry) dropCarry(true);
    const [f] = await pickFiles('.pcm,.pcd,.json'); if (!f) return;
    let st; try { st = ops.loadNative(await f.text()).style; } catch (err) { toast('Cannot read that file: ' + (err as Error).message, 'error'); return; }
    const mk = st.meta?.marker;
    if (!mk) { toast(`${f.name} has no marker in it`, 'warn'); return; }
    const mine = new Set(app.doc.style.pieces.map(p => p.id));
    const same = st.pieces.length > 0 && st.pieces.every(p => mine.has(p.id));
    if (same) {
      if (!(await confirmDialog('Import marker', `Take the cut plans and markers of ${f.name} into this style? The ones here are replaced (Ctrl+Z brings them back).`, 'Import'))) return;
      try { app.doc.transact('Import marker', s2 => { s2.meta.marker = JSON.parse(JSON.stringify(mk)); }); } catch (err) { toast((err as Error).message, 'error'); return; }
    } else {
      if (!(await confirmDialog('Import marker', `${f.name} belongs to another style (${st.name}). Open that style with its markers? Unsaved changes of the open style are lost.`, 'Open it'))) return;
      loadStyle(app, st, f.name.replace(/\.pcm$/i, '.pcd'), null);
    }
    markerFile = f.name.replace(/\.(pcd|json)$/i, '.pcm');
    cur = M().rows[0]?.id ?? ''; sel.clear(); partsKey = ''; draw(true);
    toast(`Marker file ${f.name} loaded`, 'ok');
  }
  const exportDXF = () => { const r = row(); if (r) download(base() + '.dxf', new Blob([markerDXF(parts, r.placements, wd(r), r.name, outOpt(r))], { type: 'application/dxf' })); };
  const plot = () => { const r = row(); if (!r) return; if (!Object.keys(r.placements).length) { toast('Nothing is laid on this marker yet', 'warn'); return; } download(base() + '.plt', new Blob([markerHPGL(parts, r.placements, wd(r), outOpt(r))], { type: 'application/vnd.hp-hpgl' })); toast(`Plot file ${base()}.plt · pen 1 cuts, pen 2 draws`, 'ok'); };
  async function settings() {
    const a = annot();
    const cb = (key: keyof MarkerAnnot, label: string) => ({ kind: 'checkbox' as const, key, label, value: a[key] as boolean });
    const r = await showDialog({ title: 'Marker settings · annotation', message: 'What is written on every part and around the marker. It applies to the screen, the plot (.plt) and the DXF.', fields: [
      cb('style', 'On the part: style name'), cb('piece', 'On the part: panel (piece) name'), cb('size', 'On the part: size'), cb('bundle', 'On the part: bundle code'), cb('desc', 'On the part: description'),
      cb('grain', 'Grain line'), cb('seam', 'Seam (sew) line'),
      { kind: 'select', key: 'internals', label: 'Internal lines', value: a.internals, options: [{ value: 'draw', label: 'Draw (pen)' }, { value: 'cut', label: 'Cut' }, { value: 'none', label: 'Leave out' }] },
      cb('border', 'Marker border'), cb('bName', 'At the border: marker name'), cb('bRatio', 'At the border: ratio'), cb('bLength', 'At the border: marker length'), cb('bWidth', 'At the border: marker width'), cb('bEff', 'At the border: efficiency'), cb('bPerim', 'At the border: total perimeter'),
    ] });
    if (!r) return;
    edit('Marker settings', d => { d.annot = Object.fromEntries(Object.keys(DEFAULT_ANNOT).map(k => [k, k === 'internals' ? r[k] : !!r[k]])) as unknown as MarkerAnnot; });
  }
  /** Buffer: the pieces of the selected parts keep a clear margin around their outline, in every size and marker. */
  async function buffer() {
    if (run) return;
    const ps = parts.filter(p => sel.has(p.id)); const pieceIds = [...new Set(ps.map(p => p.pieceId))];
    if (!pieceIds.length) { toast('Buffer: select a part of the piece first (Shift+click)', 'warn'); return; }
    const r = await showDialog({ title: 'Buffer', message: `${[...new Set(ps.map(p => p.name))].join(', ')}\nThe piece keeps this much room clear all round, in every size and every marker. Only its own outline is cut. Margin 0 takes the buffer off.`,
      fields: [{ kind: 'length', key: 'm', label: 'Buffer margin', value: M().buffer?.[pieceIds[0]] ?? 3, min: 0 }] });
    if (!r) return;
    const mg = Math.max(0, r.m as number);
    edit(mg > 0 ? 'Buffer' : 'Remove buffer', d => {
      const b = { ...(d.buffer ?? {}) };
      for (const id of pieceIds) { if (mg > 0) b[id] = mg; else delete b[id]; }
      if (Object.keys(b).length) d.buffer = b; else delete d.buffer;
      if (mg > 0 && d.block) { for (const id of pieceIds) delete d.block[id]; if (!Object.keys(d.block).length) delete d.block; }
      for (const row2 of d.rows) { for (const k of Object.keys(row2.placements)) if (pieceIds.some(id => k.startsWith(id + '|'))) delete row2.placements[k]; row2.marry = (row2.marry ?? []).map(g => g.filter(q => row2.placements[q])).filter(g => g.length > 1); if (!row2.marry.length) delete row2.marry; }
    });
    toast(mg > 0 ? `Buffer: ${fmt(mg)} ${unitLabel()} all round · the parts wait to be laid again` : 'Buffer removed', 'ok');
  }
  const menu = (e: Event, items: { label: string; run: () => void }[]) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openContextMenu(r.left, r.bottom + 2, [], items); };
  function report() {
    const m = M(), t = planTotals(sid(), m.order, m.rows);
    const lines = [`Cut plan — ${app.doc.style.name}`, `Material: ${m.material || 'all materials'}`, ''];
    let fabric = 0;
    for (const r of m.rows) {
      const ps = markerParts(app.doc, r.ratio, { material: m.material || undefined, block: m.block, buffer: m.buffer }), st = markerStats(ps, r.placements, r.width ?? m.width);
      const done = st.placed === st.parts && st.parts > 0; if (done) fabric += st.length * r.plies;
      lines.push(`${r.name}: ${sizes().filter(s => r.ratio[s.id]).map(s => `${s.name} ${r.ratio[s.id]}`).join(' · ') || 'no ratio'} · ${r.plies} plies · width ${fmt(r.width ?? m.width)} ${unitLabel()} · ${done ? `${fmt(st.length)} ${unitLabel()} long, ${(st.efficiency * 100).toFixed(1)} %` : `${st.placed} of ${st.parts} parts laid`}`);
    }
    lines.push('', `Garments: ${t.garments} cut of ${t.ordered} ordered${t.exact ? ' (exact)' : ''}`, ...sizes().filter(s => t.diff[s.id]).map(s => `  ${s.name}: ${t.diff[s.id] > 0 ? '+' : ''}${t.diff[s.id]}`),
      `Fabric for the nested markers: ${(fabric / 1000).toFixed(2)} m${t.garments ? ` · ${(fabric / 1000 / t.garments).toFixed(3)} m per garment` : ''}`);
    void alertDialog('Cut plan report', lines.join('\n'));
  }

  // ── drawing
  function drawTop() {
    const m = M(); clear(top);
    const num = (v: string, title: string, on: (t: string) => void, w = 70) => { const i = h('input.mk-in', { type: 'text', value: v, title, style: `width:${w}px` }) as HTMLInputElement; i.addEventListener('change', () => on(i.value)); i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); }); return i; };
    const mats = [...new Set(app.doc.style.pieces.map(p => p.order?.material ?? '').filter(Boolean))];
    const mat = h('select.mk-in', { 'data-mk': 'material', title: 'Every material has its own cut plan and markers; the order is the same for all' }, h('option', { value: '' }, 'All materials'), ...mats.map(x => h('option', { value: x, selected: x === m.material }, x))) as HTMLSelectElement;
    mat.addEventListener('change', () => { if (carry) dropCarry(true); edit('Marker material', d => switchMarkerMaterial(d, mat.value)); cur = M().rows[0]?.id ?? ''; sel.clear(); partsKey = ''; draw(true); toast(`${mat.value || 'All materials'}: ${M().rows.length ? `${M().rows.length} marker${M().rows.length === 1 ? '' : 's'} in its cut plan` : 'no cut plan yet · press Auto plan'}`, 'ok'); });
    top.append(h('strong.mk-title', {}, 'Marker making'),
      h('button.mk-menu', { type: 'button', 'data-mk': 'menu-file', onclick: (e: Event) => menu(e, [
        { label: 'Save marker (.pcm)', run: () => void saveMarker(false) }, { label: 'Save marker as…', run: () => void saveMarker(true) },
        { label: 'Import marker (.pcm)…', run: () => void importMarker() }, { label: 'Export this marker as DXF', run: exportDXF },
        { label: 'Plot this marker (.plt)', run: plot }, { label: 'Settings · annotation…', run: () => void settings() },
      ]) }, 'File ▾'),
      h('button.mk-menu', { type: 'button', 'data-mk': 'menu-marker', onclick: (e: Event) => menu(e, [
        { label: 'Marry pieces', run: marry }, { label: 'Unmarry', run: unmarry }, { label: 'Block fuse…', run: () => void blockFuse() }, { label: 'Buffer…', run: () => void buffer() },
      ]) }, 'Marker ▾'),
      h('span.mk-dim', {}, app.doc.style.name || ''),
      h('label', {}, 'Fabric width', num(fmt(wd()), 'Usable fabric width of the marker on screen (every marker has its own; new markers start with the last width typed)', t => { const v = parseLen(t), id = row()?.id; if (Number.isFinite(v) && v > 50) { edit('Fabric width', d => { d.width = v; const x = d.rows.find(q => q.id === id); if (x) x.width = v; }); draw(true); } else draw(); }, 70), h('span.mk-dim', {}, unitLabel())),
      h('label', {}, 'Gap', num(fmt(m.gap), 'Smallest gap between parts', t => { const v = parseLen(t); if (Number.isFinite(v) && v >= 0) edit('Marker gap', d => { d.gap = v; }); else draw(); }, 54), h('span.mk-dim', {}, unitLabel())),
      h('label', {}, 'Material', mat),
      (() => {
        const dsel = h('select.mk-in', { 'data-mk': 'direction', title: RULES.find(x => x[0] === rule())![2] }, ...RULES.map(([v, l, t]) => h('option', { value: v, selected: v === rule(), title: t }, l))) as HTMLSelectElement;
        dsel.addEventListener('change', () => setRule({ direction: dsel.value as MarkerDirection }));
        return h('label', {}, 'Direction', dsel);
      })(),
      (() => {
        const can = rule() === 'bundle';
        const cb = h('input', { type: 'checkbox', 'data-mk': 'rot180', checked: can && r180(), disabled: !can }) as HTMLInputElement;
        cb.addEventListener('change', () => setRule({ rot180: cb.checked }));
        return h('label.mk-tog' + (can ? '' : '.off'), { title: can ? 'On: a bundle may be turned 180° as a whole (R), and the nester lays bundles both ways. Off: every bundle faces the same way.' : 'Only "One bundle, one direction" uses this switch' }, cb, 'Rotate 180°');
      })(),
      h('span.mk-grow'),
      h('button.btn.sm', { title: 'Back to the pattern (Esc)', 'data-mk': 'close', onclick: () => closeMarker() }, 'Close ✕'));
  }
  function drawPlan() {
    const m = M(), S2 = sizes(), t = planTotals(sid(), m.order, m.rows); clear(planBox);
    const int = (v: number, title: string, on: (n: number) => void, attrs: Record<string, string> = {}) => {
      const i = h('input.mk-n', { type: 'text', inputmode: 'numeric', value: v ? String(v) : '', placeholder: '0', title, ...attrs }) as HTMLInputElement;
      i.addEventListener('change', () => { const n = Math.max(0, Math.floor(Number(i.value) || 0)); on(n); });
      i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const all = [...planBox.querySelectorAll('input.mk-n')] as HTMLInputElement[]; const nx = all[all.indexOf(i) + 1]; i.blur(); nx?.focus(); nx?.select(); } });
      i.addEventListener('focus', () => i.select());
      return i;
    };
    const head = h('tr', {}, h('th', {}, ''), ...S2.map((s, k) => h('th', {}, h('span.mk-sw', { style: `background:${SIZE_COL[k % SIZE_COL.length]}` }), s.name)), h('th', {}, 'Plies'), h('th', {}, 'Total'), h('th', {}, `Width ${unitLabel()}`), h('th', {}, ''));
    const ordT = h('table.mk-tbl', {}, head,
      h('tr.mk-order', {}, h('td', {}, 'Order'), ...S2.map(s => h('td', {}, int(m.order[s.id] ?? 0, `Garments ordered in ${s.name}`, n => edit('Order quantity', d => { d.order[s.id] = n; }), { 'data-mk-order': s.name }))), h('td', {}, ''), h('td.mk-tot', {}, String(t.ordered)), h('td', {}, ''), h('td', {}, '')));
    for (const r of m.rows) {
      const ps = markerParts(app.doc, r.ratio, { material: m.material || undefined, block: m.block, buffer: m.buffer }), st = markerStats(ps, r.placements, r.width ?? m.width);
      const bundles = S2.reduce((a, s) => a + (r.ratio[s.id] ?? 0), 0), done = st.parts > 0 && st.placed === st.parts;
      const tr = h('tr.mk-row' + (r.id === row()?.id ? '.on' : ''), { 'data-mk-row': r.id, title: 'Click to show this marker' },
        h('td.mk-name', {}, r.name, h('span.mk-sub', {}, done ? `${fmt(st.length)} ${unitLabel()} · ${(st.efficiency * 100).toFixed(1)} %` : st.parts ? `${st.placed}/${st.parts} laid` : 'no parts')),
        ...S2.map(s => h('td', {}, int(r.ratio[s.id] ?? 0, `Bundles of ${s.name} in ${r.name}`, n => edit('Marker ratio', d => { const x = d.rows.find(q => q.id === r.id); if (x && x.ratio[s.id] !== n) { x.ratio[s.id] = n; x.placements = {}; } })))),
        h('td', {}, int(r.plies, `Plies spread for ${r.name}`, n => edit('Plies', d => { const x = d.rows.find(q => q.id === r.id); if (x) x.plies = n; }))),
        h('td.mk-tot', {}, String(bundles * r.plies)),
        h('td', {}, (() => { const i = h('input.mk-n.mk-w', { type: 'text', value: fmt(r.width ?? m.width), title: `Fabric width of ${r.name}`, 'data-mk-width': r.id }) as HTMLInputElement; i.addEventListener('change', () => { const v = parseLen(i.value); if (Number.isFinite(v) && v > 50) edit('Fabric width', d => { const x = d.rows.find(q => q.id === r.id); if (x) x.width = v; d.width = v; }); else draw(); }); i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); }); i.addEventListener('focus', () => i.select()); return i; })()),
        h('td', {}, h('button.mini', { title: `Remove ${r.name}`, onclick: (e: Event) => { e.stopPropagation(); edit('Remove marker', d => { d.rows = d.rows.filter(q => q.id !== r.id); }); } }, '✕')));
      tr.addEventListener('click', e => { if ((e.target as Element).closest('input,button')) return; cur = r.id; sel.clear(); partsKey = ''; draw(true); });
      ordT.append(tr);
    }
    ordT.append(h('tr.mk-cut', {}, h('td', {}, 'Cut'), ...S2.map(s => h('td.mk-tot', {}, String(t.cut[s.id]))), h('td.mk-tot', {}, String(t.plies)), h('td.mk-tot', {}, String(t.garments)), h('td', {}, ''), h('td', {}, '')),
      h('tr.mk-diff', {}, h('td', {}, 'Over / short'), ...S2.map(s => h('td.mk-tot' + (t.diff[s.id] > 0 ? '.over' : t.diff[s.id] < 0 ? '.short' : '.ok'), {}, t.diff[s.id] === 0 ? '✓' : (t.diff[s.id] > 0 ? '+' : '') + t.diff[s.id])), h('td', {}, ''), h('td.mk-tot' + (t.exact ? '.ok' : ''), {}, t.exact ? '✓' : String(t.garments - t.ordered)), h('td', {}, ''), h('td', {}, '')));
    const auto = async () => {
      if (!t.ordered) { toast('Type the order quantities first', 'warn'); return; }
      if (m.rows.some(r => Object.keys(r.placements).length) && !(await confirmDialog('Auto plan', 'Build the cut plan again from the order? The markers of the current plan, and their nesting, are replaced (Ctrl+Z brings them back).', 'Build plan'))) return;
      edit('Auto cut plan', d => { d.rows = autoCutPlan(sid(), d.order, { maxPlies: d.maxPlies, maxBundles: d.maxBundles }).map(r => ({ ...r, placements: {}, width: d.width })); });
      cur = M().rows[0]?.id ?? ''; partsKey = ''; draw(true);
      toast(`${M().rows.length} marker${M().rows.length === 1 ? '' : 's'} planned · press ▶ to nest`, 'ok');
    };
    const fold = h('button.mk-h', { type: 'button', 'data-mk': 'plan-fold', 'aria-expanded': String(planOpen), title: planOpen ? 'Fold the cut plan away (more room for the marker)' : 'Show the cut plan' }, h('span.caret', {}, '▾'), 'Cut plan', h('span.mk-dim', {}, planOpen ? '' : `  ${t.garments} of ${t.ordered} garments${t.exact ? ' ✓' : ''}`));
    fold.addEventListener('click', () => { planOpen = !planOpen; draw(); requestAnimationFrame(() => { fit(); draw(); }); });
    planBox.classList.toggle('folded', !planOpen);
    if (!planOpen) {
      // folded: the markers are tabs, one click shows a marker
      const tabs = h('div.mk-tabs', { role: 'tablist', 'aria-label': 'Markers' });
      for (const r of m.rows) {
        const ps = markerParts(app.doc, r.ratio, { material: m.material || undefined, block: m.block, buffer: m.buffer }), st = markerStats(ps, r.placements, r.width ?? m.width);
        const done = st.parts > 0 && st.placed === st.parts, on = r.id === row()?.id;
        const ratio = S2.filter(s => r.ratio[s.id]).map(s => `${s.name} ${r.ratio[s.id]}`).join(' · ');
        const tab = h('button.mk-tab' + (on ? '.on' : '') + (done ? '.done' : ''), { type: 'button', role: 'tab', 'aria-selected': String(on), 'data-mk-tab': r.id,
          title: `${r.name}: ${ratio || 'no ratio'} · ${r.plies} plies · ${done ? `${fmt(st.length)} ${unitLabel()}, ${(st.efficiency * 100).toFixed(1)} %` : `${st.placed} of ${st.parts} parts laid`}` },
          r.name, h('span.mk-tab-s', {}, done ? `${(st.efficiency * 100).toFixed(0)} %` : st.parts ? `${st.placed}/${st.parts}` : '–'));
        tab.addEventListener('click', () => { if (carry) dropCarry(true); cur = r.id; sel.clear(); partsKey = ''; draw(true); });
        tabs.append(tab);
      }
      planBox.append(h('div.mk-foldrow', {}, fold, tabs)); return;
    }
    planBox.append(fold,
      h('div.mk-lim', {},
        h('label', {}, 'Max plies', int(m.maxPlies, 'Most plies in one spread', n => edit('Max plies', d => { d.maxPlies = Math.max(1, n); }))),
        h('label', {}, 'Max bundles', int(m.maxBundles, 'Most garments in one marker', n => edit('Max bundles', d => { d.maxBundles = Math.max(1, n); }))),
        h('button.btn.sm.primary', { 'data-mk': 'auto', title: 'Work out the ratios and plies from the order', onclick: () => void auto() }, 'Auto plan')),
      h('div.mk-scroll', {}, ordT),
      h('div.mk-lim', {},
        h('button.btn.sm', { 'data-mk': 'add', title: 'Add an empty marker to the plan', onclick: () => { const id = 'm' + Date.now().toString(36); edit('Add marker', d => { d.rows.push({ id, name: 'Marker ' + (d.rows.length + 1), ratio: {}, plies: 1, placements: {}, width: d.width }); }); cur = id; partsKey = ''; draw(true); } }, '+ Marker'),
        h('button.btn.sm', { 'data-mk': 'report', title: 'Markers, lengths, efficiency and fabric needed', onclick: report }, 'Report')),
      h('div.mk-hint', {}, 'Type the order, press Auto plan, then ▶ to nest each marker. Ratios and plies can be changed by hand: the Over / short row shows what the plan cuts against the order.'));
  }
  function drawTools() {
    clear(tools);
    const b = (id: string, label: string, title: string, on: () => void, cls = '') => h('button.mk-tool' + cls, { type: 'button', 'data-mk': id, title, 'aria-label': title, onclick: on }, label);
    const time = h('select.mk-time', { title: 'How long the nester searches' }, ...TIMES.map(([v, l]) => h('option', { value: String(v), selected: v === M().nestSeconds }, l))) as HTMLSelectElement;
    time.addEventListener('change', () => edit('Nesting time', d => { d.nestSeconds = Number(time.value); }));
    tools.append(
      run ? b('stop', '■', 'Stop nesting and keep the best layout so far', nestStop, '.stop') : b('nest', '▶', 'Nest this marker automatically (N)', nestStart, '.play'),
      time, h('div.mk-sep'),
      b('marry', '⚭', 'Marry the selected parts: they are picked up, thrown and turned as one (Shift+click selects several)', marry),
      b('unmarry', '⚮', 'Unmarry: the parts of the selected group move on their own again', unmarry),
      b('block', '▣', 'Block fuse: lay the piece of the selected part as a block with a margin (for fusing), in every size', () => void blockFuse()),
      b('buffer', '◌', 'Buffer: the piece of the selected part keeps a clear margin all round, in every size', () => void buffer()),
      h('div.mk-sep'),
      b('off', '⤴', 'Take the selected part off the marker (Delete)', unplaceSel),
      b('clear', '⌫', 'Take every part off this marker', () => { if (carry) dropCarry(true); if (Object.keys(pls()).length) keep('Clear marker', {}); }),
      h('div.mk-sep'),
      b('fit', '⤢', 'Show the whole marker (F)', () => { fit(); draw(); }),
      b('dxf', 'DXF', 'Export this marker as DXF', exportDXF, '.txt'),
      b('plt', 'PLT', 'Plot this marker: a .plt file, written as set in File ▸ Settings', plot, '.txt'));
  }
  function drawStatus() {
    const r = row(), m = M();
    if (!r) { stat.textContent = 'No marker yet: type the order on the left and press Auto plan, or add a marker with + Marker.'; return; }
    const st = markerStats(parts, pls(), wd());
    const el = run ? Math.min(run.seconds, (performance.now() - run.startedAt) / 1000) : 0;
    stat.textContent = [r.name, `${st.placed} of ${st.parts} parts laid`, `length ${fmt(st.length)} ${unitLabel()}`, `efficiency ${(st.efficiency * 100).toFixed(2)} %`,
      `${r.plies} plies = ${(st.length * r.plies / 1000).toFixed(2)} m of fabric`, `perimeter ${(markerPerimeter(parts, pls()) / 1000).toFixed(2)} m`, bad.size ? `⚠ ${bad.size} part${bad.size > 1 ? 's' : ''} overlapping or off the fabric` : '',
      run ? `nesting… ${el.toFixed(0)} / ${run.seconds} s on ${run.threads} thread${run.threads > 1 ? 's' : ''}` : carry ? 'Carrying: click = put down · press and pull = aim, let go = shoot · right-click = turn 180° · Esc = put back' : 'Click a part to pick it up · press and pull = aim, let go = shoot · right-click = turn 180° · Shift+click = select more'].filter(Boolean).join('  ·  ');
  }
  function drawSvg() {
    const p0 = pls(), fw = wd(), st = markerStats(parts, p0, fw);
    bad = run ? new Set() : markerProblems(parts, p0, fw);
    const f = (n: number) => n.toFixed(1);
    const len = Math.max(st.length, 1000), a = S({ x: 0, y: 0 }), b2 = S({ x: len, y: fw });
    const sIdx = new Map(sizes().map((s, k) => [s.id, k]));
    let out = `<rect x="${f(a.x)}" y="${f(a.y)}" width="${f(b2.x - a.x + 4000 * view.k)}" height="${f(b2.y - a.y)}" class="mk-fabric"/>`;
    if (st.length > 0) { const e = S({ x: st.length, y: 0 }); out += `<line x1="${f(e.x)}" y1="${f(a.y - 8)}" x2="${f(e.x)}" y2="${f(b2.y + 8)}" class="mk-end"/><text x="${f(e.x + 5)}" y="${f(a.y - 12)}" class="mk-lab">${fmt(st.length)} ${unitLabel()} · ${(st.efficiency * 100).toFixed(1)} %</text>`; }
    const wedSet = new Set((row()?.marry ?? []).flat());
    const an = annot(), sname = app.doc.style.name;
    const dl = (v: Vec[], q: Placement, closed: boolean) => v.map(x => S(placedPoint(q, x))).map((x, i) => `${i ? 'L' : 'M'}${f(x.x)} ${f(x.y)}`).join('') + (closed ? 'Z' : '');
    let top2 = '';
    for (const p of parts) {
      const q = where(p); if (!q) continue;
      const pts = placedPoly(p, q).map(S), col = SIZE_COL[(sIdx.get(p.sizeId) ?? 0) % SIZE_COL.length];
      const held = !!carry?.base[p.id];
      const cls = 'mk-part' + (sel.has(p.id) ? ' sel' : '') + (bad.has(p.id) && !held ? ' bad' : '') + (p0[p.id] || held ? '' : ' wait') + (held ? ' carry' : '') + (wedSet.has(p.id) ? ' wed' : '') + (p.inner ? ' block' : '');
      const g0 = S(placedPoint(q, p.grain[0])), g1 = S(placedPoint(q, p.grain[1]));
      const bx = polyBox(pts), big = (bx.x1 - bx.x0) > 46 && (bx.y1 - bx.y0) > 16;
      const one = `<g class="${cls}" data-part="${p.id}"><path d="${pts.map((v, i) => `${i ? 'L' : 'M'}${f(v.x)} ${f(v.y)}`).join('')}Z" style="--c:${col}"/>`
        + (p.inner ? `<path class="mk-inner" d="${dl(p.inner, q, true)}" style="--c:${col}"/>` : '')
        + (an.seam && p.sew ? `<path class="mk-seam" d="${dl(p.sew, q, true)}"/>` : '')
        + (an.internals !== 'none' && p.lines ? `<path class="mk-int${an.internals === 'cut' ? ' cut' : ''}" d="${p.lines.map(l => dl(l, q, false)).join('')}"/>` : '')
        + (an.grain ? `<line x1="${f(g0.x)}" y1="${f(g0.y)}" x2="${f(g1.x)}" y2="${f(g1.y)}" class="mk-grain"/>` : '')
        + (big ? partLabel(p, an, sname).map((t, i) => `<text x="${f((bx.x0 + bx.x1) / 2)}" y="${f((bx.y0 + bx.y1) / 2 + 3 + i * 11)}" class="mk-pl">${t.slice(0, 40).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('') : '') + '</g>';
      if (held) top2 += one; else out += one; // carried parts are drawn last, on top
    }
    out += top2 + '<g class="mk-over"></g>';
    if (Object.keys(tray).length) { const t = S({ x: 0, y: -30 }); out += `<text x="${f(t.x)}" y="${f(t.y)}" class="mk-lab">Waiting to be laid: ${Object.keys(tray).length}</text>`; }
    svg.innerHTML = out;
    carryEls = carry ? carry.ids.map(id => svg.querySelector(`[data-part="${CSS.escape(id)}"]`)).filter(Boolean) as SVGGElement[] : [];
    over = svg.querySelector('.mk-over');
    place(); drawAim();
  }
  let carryEls: SVGGElement[] = [], over: Element | null = null;
  /** the carried parts follow the cursor: only their transform changes, nothing is drawn again (this is what keeps it light) */
  function place() { if (!carry) return; const t = `translate(${(carry.shift.x * view.k).toFixed(1)} ${(carry.shift.y * view.k).toFixed(1)})`; for (const el of carryEls) el.setAttribute('transform', t); }
  function drawAim() {
    if (!over) return;
    if (!aim) { over.innerHTML = ''; return; }
    const f = (n: number) => n.toFixed(1), a1 = S(aim.from), a2 = S(aim.to), ang = Math.atan2(a2.y - a1.y, a2.x - a1.x), hd = 11;
    const pt = (r: number, o: number) => `${f(a2.x + r * Math.cos(ang + o))} ${f(a2.y + r * Math.sin(ang + o))}`;
    over.innerHTML = `<g class="mk-aim"><line x1="${f(a1.x)}" y1="${f(a1.y)}" x2="${f(a2.x)}" y2="${f(a2.y)}"/><path d="M${pt(0, 0)}L${pt(-hd, 0.42)}L${pt(-hd, -0.42)}Z"/><circle cx="${f(a1.x)}" cy="${f(a1.y)}" r="3.5"/></g>`;
  }
  function draw(refit = false) {
    if (!root) return;
    refreshParts(); layTray();
    if (refit) fit();
    if (!root.contains(document.activeElement) || !isTyping()) { drawTop(); drawPlan(); }
    drawTools(); drawSvg(); drawStatus();
  }

  // ── pointer: pick up, carry, aim and shoot, put down; pan and zoom
  /** where the carried parts are right now */
  const carried = (): Placements => { const o: Placements = {}; if (carry) for (const id of carry.ids) o[id] = { ...carry.base[id], x: carry.base[id].x + carry.shift.x, y: carry.base[id].y + carry.shift.y }; return o; };
  function pickUp(id: string, at: Vec) {
    const wed = marriedTo(id), baseP: Placements = {};
    for (const p of parts) if (wed.has(p.id)) { const q = pls()[p.id] ?? tray[p.id]; if (q) baseP[p.id] = { ...q, ...(pls()[p.id] ? {} : { rot: groupRot(p, pls()) }) }; }
    if (!baseP[id]) return;
    sel = new Set(Object.keys(baseP));
    carry = { ids: Object.keys(baseP), grab: id, base: baseP, at, shift: { x: 0, y: 0 }, fresh: true };
    drawSvg(); drawStatus();
  }
  /** put the carried parts down where they are (above the fabric = back to waiting); `back` = put them back where they came from */
  function dropCarry(back = false) {
    const c = carry; if (!c) return; const now = carried(); carry = null; aim = null; press = null;
    if (back) { draw(); return; }
    const next = { ...(row()?.placements ?? {}) };
    for (const p of parts) { const q = now[p.id]; if (!q) continue; if (polyBox(placedPoly(p, q)).y1 < 0) delete next[p.id]; else next[p.id] = q; }
    keep('Put part down', next);
  }
  /** let the carried parts go along the aim line: they travel until they touch, and stop */
  function shoot(a: { from: Vec; to: Vec }) {
    const c = carry, r = row(); if (!c || !r) return;
    const dir = { x: a.to.x - a.from.x, y: a.to.y - a.from.y };
    const w = wd(), laid = { ...r.placements }; for (const id of c.ids) delete laid[id];
    const from = carried(), start: Placements = { ...laid };
    // parts still above or below the fabric come onto it first
    let lo = Infinity, hi = -Infinity, left = Infinity;
    for (const p of parts) if (from[p.id]) { const b = polyBox(placedPoly(p, from[p.id])); lo = Math.min(lo, b.y0); hi = Math.max(hi, b.y1); left = Math.min(left, b.x0); }
    const sy = lo < 0 ? -lo : hi > w ? w - hi : 0, sx = left < 0 ? -left : 0;
    for (const id of c.ids) start[id] = { ...from[id], x: from[id].x + sx, y: from[id].y + sy };
    const res = throwParts(parts, start, w, c.ids, dir, { gap: M().gap }) ?? throwParts(parts, start, w, c.ids, { x: -dir.x, y: -dir.y }, { gap: M().gap });
    if (!res) { toast('No free place that way: the part stays on the cursor', 'warn'); drawSvg(); return; }
    carry = null; press = null;
    const ids = c.ids, t0 = performance.now(), dur = 140;
    cancelAnimationFrame(anim); runRow = r.id;
    const tick = () => {
      if (!root) return;
      const k = Math.min(1, (performance.now() - t0) / dur), e = 1 - (1 - k) * (1 - k);
      live = { ...laid };
      for (const id of ids) live[id] = { rot: res[id].rot, x: from[id].x + (res[id].x - from[id].x) * e, y: from[id].y + (res[id].y - from[id].y) * e };
      if (k < 1) { drawSvg(); anim = requestAnimationFrame(tick); return; }
      live = null; keep('Throw part', { ...laid, ...res });
    };
    tick();
  }
  svg.addEventListener('pointerdown', e => {
    svg.focus();
    if (e.button === 2) return; // right-click: turn (see contextmenu)
    if (e.button === 1 || e.altKey) { pan = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); return; }
    if (carry) { press = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); return; }
    const g = (e.target as Element).closest('[data-part]') as SVGElement | null;
    if (!g) { if (!e.shiftKey && sel.size) { sel.clear(); draw(); } pan = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); return; }
    if (run) { toast('Stop the nester (■) before moving parts by hand', 'warn'); return; }
    const id = g.dataset.part!;
    if (e.shiftKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); draw(); return; }
    pickUp(id, evW(e)); press = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (pan) { view.ox += e.clientX - pan.x; view.oy += e.clientY - pan.y; pan = { x: e.clientX, y: e.clientY }; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => drawSvg()); return; }
    if (!carry) return;
    const w = evW(e);
    if (press) {
      // button held: pulling out the direction line (the part waits where it is)
      if (!aim && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 7) return;
      const now = carried(), bs = parts.filter(p => now[p.id]).map(p => polyBox(placedPoly(p, now[p.id])));
      aim = { from: centre({ x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)), x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)) }), to: w };
      drawAim(); return;
    }
    carry.shift = { x: w.x - carry.at.x, y: w.y - carry.at.y };
    cancelAnimationFrame(raf); raf = requestAnimationFrame(place);
  });
  const up = (e: PointerEvent) => {
    try { svg.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (pan) { pan = null; return; }
    if (!carry || !press) return;
    press = null;
    if (aim) { const a = aim; aim = null; drawAim(); shoot(a); return; }
    if (carry.fresh) { carry.fresh = false; return; } // the click that picked it up: it stays on the cursor
    dropCarry();
  };
  svg.addEventListener('dblclick', e => {
    const g = (e.target as Element).closest('[data-part]') as SVGElement | null; if (!g) return;
    const p = parts.find(q => q.id === g.dataset.part); if (!p) return;
    if (carry) dropCarry(true);
    sel = new Set(parts.filter(q => q.sizeId === p.sizeId && q.bundle === p.bundle).map(q => q.id)); draw();
  });
  svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  svg.addEventListener('contextmenu', e => {
    e.preventDefault();
    const id = carry?.grab ?? ((e.target as Element).closest('[data-part]') as SVGElement | null)?.dataset.part;
    if (id) turn(id);
  });
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, w = W(mx, my);
    view.k = Math.max(0.01, Math.min(8, view.k * Math.exp(-e.deltaY * 0.0015))); view.ox = mx - w.x * view.k; view.oy = my - w.y * view.k; drawSvg();
  }, { passive: false });

  // ── keys (the pattern editor's shortcuts are held back while this room is open)
  const key = (e: KeyboardEvent) => {
    if (!root) return;
    if (dialogOpen() || document.querySelector('.ctx-menu')) return; // a dialog or an open menu handles its own keys
    const typing = isTyping();
    if (e.key === 'Escape' && (aim || carry)) { if (aim) { aim = null; press = null; drawAim(); } else dropCarry(true); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === 'Escape') { if (typing) (document.activeElement as HTMLElement).blur(); else if (run) nestStop(); else if (sel.size) { sel.clear(); draw(); } else closeMarker(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (typing) { e.stopImmediatePropagation(); return; }
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { if (carry) dropCarry(true); if (!run) { if (e.shiftKey) app.doc.redo(); else app.doc.undo(); partsKey = ''; draw(); } }
    else if (mod && k === 'y') { if (!run) { app.doc.redo(); partsKey = ''; draw(); } }
    else if (mod && k === 'a') { sel = new Set(parts.filter(p => pls()[p.id]).map(p => p.id)); draw(); }
    else if (mod) return; // leave browser shortcuts (and Ctrl+S) alone
    else if (k === 'n') nestStart();
    else if (k === 'r') { const id = carry?.grab ?? [...sel][0]; if (id) turn(id); }
    else if (k === 'f') { fit(); draw(); }
    else if (k === 'delete' || k === 'backspace') unplaceSel();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', key, true);
  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  function closeMarker() {
    if (!root) return;
    run?.stop(); clearInterval(runTimer);
    window.removeEventListener('keydown', key, true); window.removeEventListener('resize', onResize);
    root.remove(); root = null; app.invalidate();
  }
  (root as HTMLElement & { closeMarker?: () => void }).closeMarker = closeMarker;
  draw(true); requestAnimationFrame(() => draw(true));
  if (!M().rows.length && !Object.keys(M().order).length) app.status('Marker making: type the order per size, press Auto plan, then ▶ to nest');
}
export function closeMarkerRoom() { (root as (HTMLElement & { closeMarker?: () => void }) | null)?.closeMarker?.(); }
