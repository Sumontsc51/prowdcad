/**
 * Marker making workspace: a full-screen room over the pattern sheet.
 *   left   — cut plan builder: order per size, limits, Auto plan, and the editable list of markers (ratio, plies)
 *   strip  — marker tools: Nest ▶ / Stop, turn, unplace, push, clear, zoom, check, export, report
 *   centre — the marker: fabric of the set width; parts not laid yet wait in the tray above it
 * Everything is kept with the style (style.meta.marker); every change is one undo step (Ctrl+Z works here).
 */
import {
  autoCutPlan, planTotals, markerParts, markerStats, markerProblems, placedPoly, placedPoint, polyBox, placeAt, nestJob,
  markerDXF, markerHPGL, partLabel, markerPerimeter, DEFAULT_ANNOT, type MarkerAnnot, blockOutline, blockPart, blockBins, contourAround, cutOutline, matchShifts, markerMismatch, matchPlan, sweptPart, settleMatch, matchActive, lineWay, type FabricMatch, shadeProblems, shadeBundles, columnHull, type ShadeSet, blockRoom, facing, borderLines, borderLayout, partTemplate, markerTemplate, DEFAULT_BLOCKSET,
  type MarkerBlock, type PieceDetail, type BlockSet, type AnnotUnit, type AnnotPlace, switchMarkerMaterial, directedParts, obeyDirection, directionGroup, groupMayTurn, throwParts, type MarkerDirection, type MarkerDoc, type MarkerRow, type MarkerPart, type Placements, type Placement, type Vec,
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
import { pieceThumb } from '../panels/pieces';

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
  const mp = (ratio: MarkerRow['ratio'], d: MarkerDoc = M()) => markerParts(app.doc, ratio, { material: d.material || undefined, block: d.block, buffer: d.buffer, detail: d.detail });
  const fab = (): FabricMatch | undefined => M().match;
  const shade = (): ShadeSet | undefined => { const x = M().shade; return x && x.rows >= 1 ? x : undefined; };
  const bset = (): BlockSet => ({ ...DEFAULT_BLOCKSET, ...(M().blockSet ?? {}) });
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
        const ps = mp(r.ratio, d);
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
  let liveBlocks: MarkerBlock[] | null = null;       // … and its fuse blocks
  let phase = '', aborted = false;                   // building the fuse blocks before the nest; Stop pressed
  const busy = () => !!run || !!phase;
  let shadeOff = new Set<string>();                  // major parts outside their shade zone
  let trayShift = 0, off = new Set<string>();           // parts off their stripe / plaid match
  let mq: { a: Vec; b: Vec; add: boolean; px: { x: number; y: number } } | null = null; // box drawn to select parts
  let dlg: { close: () => void } | null = null;      // piece details / settings window
  const row = (): MarkerRow | undefined => M().rows.find(r => r.id === cur) ?? M().rows[0];
  /** fabric width of a marker (default: the marker on screen); every marker has its own */
  const wd = (r?: MarkerRow): number => (r ?? row())?.width ?? M().width;
  const pls = (): Placements => (live && row()?.id === runRow ? live : row()?.placements ?? {});
  /** the fuse blocks of the marker on screen */
  const blks = (): MarkerBlock[] => (live && liveBlocks && row()?.id === runRow ? liveBlocks : row()?.blocks ?? []);

  // ── elements
  const planBox = h('div.mk-plan'), tools = h('div.mk-tools'), stat = h('div.mk-status');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'mk-svg'); svg.setAttribute('tabindex', '0');
  const top = h('div.mk-top');
  root = h('div.mk-root', { role: 'dialog', 'aria-label': 'Marker making' }, top, h('div.mk-body', {}, planBox, h('div.mk-work', {}, tools, h('div.mk-stage', {}, svg as unknown as HTMLElement))), stat);
  document.body.append(root);

  // ── geometry helpers
  function refreshParts() {
    const r = row(), m = M();
    const key = r ? JSON.stringify([r.id, r.ratio, m.material, m.block ?? null, m.buffer ?? null, m.detail ?? null]) : '-';
    if (key === partsKey) return;
    partsKey = key;
    parts = r ? mp(r.ratio, m) : [];
    parts = [...parts.filter(p => p.major), ...parts.filter(p => !p.major)]; // the major pieces wait first
    sel = new Set([...sel].filter(id => parts.some(p => p.id === id)));
  }
  /** parts not laid yet wait in rows above the fabric (negative y) */
  function layTray() {
    tray = {};
    const p0 = pls(), wait = parts.filter(p => !p0[p.id]);
    const an = annot(), topLines = an.border && (an.place ?? 'top') === 'top' ? markerTemplate(an).split('\n').filter(t => t.trim()).length : 0;
    trayShift = topLines ? Math.min(900, (topLines * 15 + 40) / Math.max(view.k, 0.02)) : 0; // room for the marker text above the fabric
    let x = 0, y = -60 - trayShift, rowH = 0; const maxX = Math.max(3000, wd() * 2.5);
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
    const st = markerStats(parts, pls(), wd(), blks());
    const r = svg.getBoundingClientRect(); if (r.width < 50) return;
    let minY = 0; for (const id in tray) minY = Math.min(minY, tray[id].y);
    const maxX = Math.max(st.length, 1500, ...Object.values(tray).map(t => t.x + 600));
    // room for the marker text where the settings put it
    const an = annot(), n = an.border ? markerTemplate(an).split('\n').filter(t => t.trim()).length : 0, pl = an.place ?? 'top';
    const padT = pl === 'top' && !Object.keys(tray).length ? n * 15 + 26 : 0, padB = pl === 'bottom' ? n * 15 + 12 : 0, padL = pl === 'start' ? n * 15 + 10 : 0, padR = pl === 'end' ? n * 15 + 10 : 0;
    const k = Math.min((r.width - 150 - padL - padR) / maxX, (r.height - 70 - padT - padB) / (wd() - minY));
    view = { k, ox: 30 + padL, oy: 30 + padT - minY * k };
  }

  // ── commits
  const keep = (label: string, next: Placements, marry?: string[][], blocks?: MarkerBlock[]) => { const id = row()?.id; if (!id) return; edit(label, m => {
    const r = m.rows.find(x => x.id === id); if (!r) return; r.placements = next;
    const g = (marry ?? r.marry ?? []).map(x => x.filter(q => next[q])).filter(x => x.length > 1); if (g.length) r.marry = g; else delete r.marry;
    const b = (blocks ?? r.blocks ?? []).map(x => ({ ...x, ids: x.ids.filter(q => next[q]) })).filter(x => x.ids.length); if (b.length) r.blocks = b; else delete r.blocks;
  }); };
  /** parts of these pieces go back to waiting in every marker of every material (their shape or their rules changed) */
  const strip = (d: MarkerDoc, pieceIds: string[]) => {
    for (const r of [...d.rows, ...Object.values(d.others ?? {}).flatMap(o => o.rows)]) {
      for (const k of Object.keys(r.placements)) if (pieceIds.some(id => k.startsWith(id + '|'))) delete r.placements[k];
      r.marry = (r.marry ?? []).map(g => g.filter(q => r.placements[q])).filter(g => g.length > 1); if (!r.marry.length) delete r.marry;
      r.blocks = (r.blocks ?? []).map(b => ({ ...b, ids: b.ids.filter(q => r.placements[q]) })).filter(b => b.ids.length); if (!r.blocks.length) delete r.blocks;
    }
  };
  const centre = (b: { x0: number; y0: number; x1: number; y1: number }): Vec => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  /** the parts married to a part (itself included) */
  const marriedTo = (id: string): Set<string> => {
    // married parts and the parts of a fuse block move as one
    const out = new Set([id]), groups = [...(row()?.marry ?? []), ...(row()?.blocks ?? []).map(b => b.ids)];
    for (let grew = true; grew;) { grew = false; for (const g of groups) if (g.some(q => out.has(q)) && g.some(q => !out.has(q))) { g.forEach(q => out.add(q)); grew = true; } }
    return out;
  };
  /**
   * Turn a part 180° (right-click). Only with Rotate 180° on: under "One bundle, one direction" every laid part of its bundle
   * turns with it, so the bundle keeps one direction; married parts turn together as one block, about their common middle.
   */
  function turn(id: string) {
    if (busy()) return;
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
    const r = row(); if (!r || busy()) return;
    const ids = [...sel].filter(id => r.placements[id]);
    if (ids.length < 2) { toast('Marry: select two or more laid parts first (Shift+click adds a part)', 'warn'); return; }
    const all = new Set(ids); const rest: string[][] = [];
    for (const g of r.marry ?? []) { if (g.some(id => all.has(id))) g.forEach(id => all.add(id)); else rest.push(g); }
    keep('Marry parts', r.placements, [...rest, [...all]]);
    toast(`${all.size} parts married: they move as one`, 'ok');
  }
  function unmarry() {
    const r = row(); if (!r || busy()) return;
    const left = (r.marry ?? []).filter(g => !g.some(id => sel.has(id)));
    if (left.length === (r.marry ?? []).length) { toast('Select a married part to unmarry its group', 'warn'); return; }
    keep('Unmarry parts', r.placements, left);
    toast('Unmarried: the parts move on their own again', 'ok');
  }
  /** Block fuse: the selected laid parts become one fuse block (only these parts, on this marker): their box or their contour, grown by a buffer. */
  async function blockFuse() {
    const r = row(); if (!r || busy()) return;
    if (carry) dropCarry(true);
    const ids = [...sel].filter(id => r.placements[id]);
    if (!ids.length) { toast('Block fuse: select the laid parts that go into the block first (Shift+click, or draw a box around them)', 'warn'); return; }
    const set = bset(), old = (r.blocks ?? []).find(b => ids.some(id => b.ids.includes(id)));
    const res = await showDialog({ title: 'Block fuse', message: `${ids.length} laid part${ids.length > 1 ? 's' : ''} become${ids.length > 1 ? '' : 's'} one fuse block, on this marker only. The block is cut out first; nothing else may lie inside it. Its parts move as one.`,
      fields: [{ kind: 'select', key: 'shape', label: 'Block outline', value: old?.shape ?? set.shape, options: [{ value: 'contour', label: 'Contour (follows the parts)' }, { value: 'rect', label: 'Rectangular' }] },
        { kind: 'length', key: 'm', label: 'Buffer', value: old?.buffer ?? set.buffer, min: 0, hint: 'Room kept around the parts inside the block' }] });
    if (!res) return;
    const pick = new Set(ids), rest = (r.blocks ?? []).map(b => ({ ...b, ids: b.ids.filter(id => !pick.has(id)) })).filter(b => b.ids.length);
    keep('Block fuse', r.placements, undefined, [...rest, { ids, shape: res.shape === 'rect' ? 'rect' : 'contour', buffer: Math.max(0, res.m as number) }]);
    toast(`Fuse block of ${ids.length} part${ids.length > 1 ? 's' : ''}${bad.size ? ' · parts inside its buffer are shown red: move them away' : ''}`, bad.size ? 'warn' : 'ok');
  }
  function unblock() {
    const r = row(); if (!r || busy()) return;
    const left = (r.blocks ?? []).filter(b => !b.ids.some(id => sel.has(id)));
    if (left.length === (r.blocks ?? []).length) { toast('Select a part of a fuse block to take the block away', 'warn'); return; }
    keep('Remove fuse block', r.placements, undefined, left);
    toast('Fuse block removed: the parts lie on their own again', 'ok');
  }
  /** Tilt the carried or selected parts off the grain, as far as Piece details lets each of them. */
  function tiltBy(step: number) {
    const r = row(); if (!r || busy()) return;
    const ids = carry ? carry.ids : [...sel].filter(id => r.placements[id]);
    const laid = { ...r.placements }; let n = 0, changed = false;
    for (const id of ids) {
      const q = parts.find(x => x.id === id), pl = carry?.base[id] ?? laid[id]; if (!q || !pl || !q.tilt || marriedTo(id).size > 1) continue;
      const f = facing(pl.rot), off = ((pl.rot - f + 540) % 360) - 180, to = Math.max(-q.tilt, Math.min(q.tilt, off + step)); n++;
      if (Math.abs(to - off) < 1e-6) continue;
      const rot = +(((f + to) % 360 + 360) % 360).toFixed(2), oc = centre(polyBox(placedPoly(q, pl))), t = placeAt(q, 0, 0, rot), tc = centre(polyBox(placedPoly(q, t)));
      const np = { x: t.x + oc.x - tc.x, y: t.y + oc.y - tc.y, rot };
      if (carry?.base[id]) carry.base[id] = np; else { laid[id] = np; changed = true; }
    }
    if (!n) { toast('No tilt is allowed for this part: set it in Piece details (single parts only, not blocks or married parts)', 'warn'); return; }
    if (changed) keep('Tilt part', laid); else drawSvg();
  }
  // ── nesting
  /** one run of the engine, waited for (a part alone needs no engine) */
  const nestOnce = (job: ReturnType<typeof nestJob>, ps: MarkerPart[], seconds: number, room: { length: number; width: number }, onBest?: (pl: Placements) => void): Promise<{ placements: Placements; length: number } | null> => {
    if (ps.length === 1 && !onBest) {
      const p = ps[0], a = p.angles.find(x => { const b = polyBox(placedPoly(p, { x: 0, y: 0, rot: x })); return b.x1 - b.x0 <= room.length && b.y1 - b.y0 <= room.width; }) ?? p.angles[0];
      const q = placeAt(p, 0, 0, a), b = polyBox(placedPoly(p, q));
      return Promise.resolve({ placements: { [p.id]: q }, length: b.x1 });
    }
    return new Promise(res => {
      let best: { placements: Placements; length: number } | null = null;
      try {
        run = startNest(job, seconds, { onBest: (pl, len) => { best = { placements: pl, length: len }; onBest?.(pl); }, onDone: info => { run = null; if (info.stopped) aborted = true; if (info.error) { aborted = true; toast('Nester stopped: ' + info.error, 'error'); } res(best); } });
      } catch (err) { run = null; aborted = true; toast('The nester could not start in this browser: ' + (err as Error).message, 'error'); res(null); }
    });
  };
  /**
   * Nest the marker. Pieces marked for block fuse (Piece details) are first laid into fuse blocks no longer or wider than the limits:
   * when they do not go into one block, two or more are made. Every block, and every block made by hand, is then laid with the
   * other parts as one shape.
   */
  async function nestStart() {
    const r = row(); if (busy() || !r) return;
    if (carry) dropCarry(true);
    if (!parts.length) { toast('This marker has no parts: give it a ratio in the cut plan', 'warn'); return; }
    const w = wd(), m = M(), gap = m.gap;
    const np = directedParts(parts, rule(), r180());
    const wide = np.find(p => p.angles.every(a => { const b = polyBox(placedPoly(p, { x: 0, y: 0, rot: a })); return b.y1 - b.y0 > w; }));
    if (wide) { toast(`${wide.name} (${wide.sizeName}) is wider than the fabric`, 'error'); return; }
    type Stand = { part: MarkerPart; local: Placements; ids: string[]; block: MarkerBlock };
    const stand: Stand[] = [];
    // blocks made by hand stay as they are
    const kept = (r.blocks ?? []).filter(b => !b.auto && b.ids.every(id => r.placements[id]));
    // married parts stay married: every married group is laid as one shape (with the hand-made blocks it shares parts with)
    const wed = (r.marry ?? []).map(g => g.filter(id => r.placements[id])).filter(g => g.length > 1);
    const keptMarry: string[][] = [], wedStand = new Set<string>();
    const sets: { ids: Set<string>; blocks: MarkerBlock[] }[] = [];
    for (const g of wed) {
      const hit = sets.filter(x => g.some(id => x.ids.has(id))), one = { ids: new Set(g), blocks: [] as MarkerBlock[] };
      for (const x of hit) { x.ids.forEach(id => one.ids.add(id)); sets.splice(sets.indexOf(x), 1); }
      sets.push(one); keptMarry.push(g);
    }
    for (const b of kept) for (const x of sets) if (b.ids.some(id => x.ids.has(id))) { b.ids.forEach(id => x.ids.add(id)); x.blocks.push(b); }
    for (let i = 0; i < sets.length; i++) for (let j = sets.length - 1; j > i; j--) if ([...sets[j].ids].some(id => sets[i].ids.has(id))) { sets[j].ids.forEach(id => sets[i].ids.add(id)); for (const b of sets[j].blocks) if (!sets[i].blocks.includes(b)) sets[i].blocks.push(b); sets.splice(j, 1); }
    const inSet = new Set(sets.flatMap(x => x.blocks));
    kept.filter(b => !inSet.has(b)).forEach((b, i) => { const bp = blockPart('#keep' + i, parts, r.placements, b); if (bp) stand.push({ ...bp, block: b }); });
    sets.forEach((x, i) => {
      const inB = new Set(x.blocks.flatMap(b => b.ids)), mem = parts.filter(p => x.ids.has(p.id) && r.placements[p.id]); if (!mem.length) return;
      const polys = [...x.blocks.map(b => blockOutline(parts, r.placements, b)).filter(Boolean) as Vec[][], ...mem.filter(p => !inB.has(p.id)).map(p => cutOutline(p).map(q => placedPoint(r.placements[p.id], q)))];
      const o = contourAround(polys, 0), bb = polyBox(o), local: Placements = {};
      for (const p of mem) local[p.id] = { x: r.placements[p.id].x - bb.x0, y: r.placements[p.id].y - bb.y0, rot: r.placements[p.id].rot };
      const f = mem[0], id = '#wed' + i;
      stand.push({ part: { id, pieceId: id, name: 'Married', sizeId: f.sizeId, sizeName: f.sizeName, bundle: f.bundle, mirror: false, angles: [0], poly: o.map(q => ({ x: q.x - bb.x0, y: q.y - bb.y0 })), grain: [{ x: 0, y: 0 }, { x: 1, y: 0 }], area: mem.reduce((a, p) => a + p.area, 0), material: f.material, hold: 'block', code: '' }, local, ids: mem.map(p => p.id), block: null as unknown as MarkerBlock });
      mem.forEach(p => wedStand.add(p.id));
      x.blocks.forEach(b => stand.push({ part: null as unknown as MarkerPart, local: {}, ids: [], block: b })); // the blocks inside stay blocks
    });
    const inKept = new Set(stand.flatMap(x => x.ids));
    const fuse = np.filter(p => p.fuse && !inKept.has(p.id));
    runRow = r.id; live = null; liveBlocks = null; runBest = 0; aborted = false;
    if (fuse.length) {
      const set = bset(), room = blockRoom(set, w, fuse);
      if (room.tooBig) { toast(`${room.tooBig.name} (${room.tooBig.sizeName}) is larger than a fuse block may be: raise the limits in Piece details`, 'error'); return; }
      const each = Math.max(2, Math.min(6, m.nestSeconds * 0.15));
      let done: { bin: MarkerPart[]; pl: Placements }[] | null = null;
      for (let k = room.least; k <= fuse.length && !done && !aborted; k++) {
        const bins = blockBins(fuse, k), got: { bin: MarkerPart[]; pl: Placements }[] = [];
        for (const bin of bins) {
          phase = `fuse blocks: filling block ${got.length + 1} of ${bins.length}`; drawTools(); drawStatus();
          const res = await nestOnce(nestJob(bin, room.width, { gap, name: 'block' }), bin, each, room);
          if (aborted || !root) break;
          if (!res || Object.keys(res.placements).length < bin.length || res.length > room.length + 0.5) break; // too much for this many blocks
          got.push({ bin, pl: res.placements });
        }
        if (got.length === bins.length) done = got;
      }
      phase = '';
      if (!root) return;
      if (aborted || !done) { if (!aborted) toast('The fuse blocks could not be filled within their limits', 'error'); draw(); return; }
      done.forEach((g, i) => { const block: MarkerBlock = { ids: g.bin.map(p => p.id), shape: set.shape, buffer: set.buffer, auto: true }; const bp = blockPart('#blk' + i, parts, g.pl, block); if (bp) stand.push({ ...bp, block }); });
    }
    // shade zones: the major pieces of every bundle are laid together (once per size) and stay together as one shape, in their row
    const sh = shade(), rowOf = new Map<string, number>(), bundleRow = new Map<string, number>();
    const rowsN = sh ? Math.max(1, Math.floor(sh.rows)) : 1, bandH = w / rowsN;
    if (sh) {
      const inS = new Set(stand.filter(x => x.part).flatMap(x => x.ids)), co = Math.max(0, sh.colOverlap) / 100;
      const groups = new Map<string, MarkerPart[]>();
      for (const p of np) { if (!p.major || p.fuse || inS.has(p.id)) continue; const k = p.sizeId + '|' + p.bundle; groups.set(k, [...(groups.get(k) ?? []), p]); }
      const innerH = bandH - 2; // a little less than the row, so that the shape of a bundle always goes into its row
      const cache = new Map<string, { pl: Placements; ids: string[] }>(), each = Math.max(2, Math.min(6, m.nestSeconds * 0.15));
      let i = 0, fail = '';
      for (const [key, ps] of groups) {
        const tall = ps.find(p => p.angles.every(a => { const b = polyBox(placedPoly(p, { x: 0, y: 0, rot: a })); return b.y1 - b.y0 > innerH; }));
        if (tall) { fail = `${tall.name} (${tall.sizeName}) is wider than a shade row (${fmt(bandH)} ${unitLabel()}): use fewer rows`; break; }
        const sig = ps.map(p => [p.pieceId, p.sizeId, p.mirror ? 1 : 0, p.angles.join(',')].join(':')).join(';');
        if (!cache.has(sig)) {
          phase = `shade zones: laying the major pieces of size ${ps[0].sizeName}`; drawTools(); drawStatus();
          const res = await nestOnce(nestJob(ps, innerH, { gap, name: 'shade' }), ps, each, { length: Infinity, width: innerH });
          if (aborted || !root) break;
          if (!res || Object.keys(res.placements).length < ps.length) { fail = `The major pieces of size ${ps[0].sizeName} could not be laid within a shade row`; break; }
          if (sh.colBy === 'length' && res.length > sh.colLength * (1 + 2 * co) + 0.5) { fail = `The major pieces of size ${ps[0].sizeName} need ${fmt(res.length)} ${unitLabel()}: longer than a shade column. Raise the column length or use fewer rows`; break; }
          cache.set(sig, { pl: res.placements, ids: ps.map(p => p.id) });
        }
        const c = cache.get(sig)!, at = (k: number) => c.pl[c.ids[k]];
        const polys = ps.map((p, k) => cutOutline(p).map(q => placedPoint(at(k), q))), bb = polyBox(polys.flat()), len = bb.x1 - bb.x0;
        const hull = columnHull(polys, sh.colBy === 'bundle' ? { x0: bb.x0 + co * len, x1: bb.x1 - co * len, y0: 0, y1: innerH } : undefined), hb = polyBox(hull);
        const local: Placements = {}; ps.forEach((p, k) => { local[p.id] = { x: at(k).x - hb.x0, y: at(k).y - hb.y0, rot: at(k).rot }; });
        const id = '#shade' + i, f0 = ps[0];
        stand.push({ part: { id, pieceId: id, name: 'Bundle ' + f0.code, sizeId: f0.sizeId, sizeName: f0.sizeName, bundle: f0.bundle, mirror: false, angles: [0], poly: hull.map(q => ({ x: q.x - hb.x0, y: q.y - hb.y0 })), grain: [{ x: 0, y: 0 }, { x: 1, y: 0 }], area: ps.reduce((a, p) => a + p.area, 0), material: f0.material, hold: 'block', code: '' }, local, ids: ps.map(p => p.id), block: null as unknown as MarkerBlock });
        rowOf.set(id, i % rowsN); bundleRow.set(key, i % rowsN); i++;
      }
      phase = '';
      if (!root) return;
      if (aborted || fail) { if (fail) toast(fail, 'error'); draw(); return; }
    }
    const solid = stand.filter(x => x.part);
    const by = new Map(solid.map(x => [x.part.id, x])), inStand = new Set(solid.flatMap(x => x.ids));
    // match lines: a part that must go onto a stripe / plaid bar is given room for a whole repeat, and slid onto its match afterwards
    const f = fab(), plan = matchPlan(np, f, new Set(np.filter(p => !inStand.has(p.id)).map(p => p.id)));
    const items = [...np.filter(p => !inStand.has(p.id)).map(p => (plan.has(p.id) ? sweptPart(p, plan.get(p.id)!) : p)), ...solid.map(x => x.part)];
    const tooWide = items.find(p => p.angles.every(a => { const b = polyBox(placedPoly(p, { x: 0, y: 0, rot: a })); return b.y1 - b.y0 > w; }));
    if (tooWide) { toast(`${tooWide.name} (${tooWide.sizeName}) with the room for its plaid match is wider than the fabric`, 'error'); draw(); return; }
    const expand = (pl: Placements): Placements => { const out: Placements = {}; for (const id in pl) { const x = by.get(id); if (!x) { out[id] = pl[id]; continue; } for (const q of x.ids) out[q] = { x: x.local[q].x + pl[id].x, y: x.local[q].y + pl[id].y, rot: x.local[q].rot }; } return plan.size ? settleMatch(np, out, f, plan) : out; };
    const newBlocks: MarkerBlock[] = stand.filter(x => x.block).map(x => (x.part ? { ...x.block, ids: x.ids } : x.block));
    const finish = (got: Placements | null, info: { stopped: boolean; error?: string }) => {
      clearInterval(runTimer); run = null; live = null; liveBlocks = null; phase = '';
      if (info.error) toast('Nester stopped: ' + info.error, 'error');
      if (!got) { draw(); return; }
      const id = runRow, n = Object.keys(got).length;
      edit('Nest marker', d => { const x = d.rows.find(q => q.id === id); if (x) { x.placements = got; if (keptMarry.length) x.marry = keptMarry.map(g => g.filter(q => got[q])).filter(g => g.length > 1); else delete x.marry; const nb = newBlocks.map(bk => ({ ...bk, ids: bk.ids.filter(q => got[q]) })).filter(bk => bk.ids.length); if (nb.length) x.blocks = nb; else delete x.blocks; } });
      toast(`Nested: ${fmt(runBest)} ${unitLabel()} long${newBlocks.length ? ` · ${newBlocks.length} fuse block${newBlocks.length > 1 ? 's' : ''}` : ''}${plan.size ? ` · ${plan.size} part${plan.size > 1 ? 's' : ''} laid onto the stripe / plaid match` : ''}${sh ? ` · major pieces in ${rowsN} shade row${rowsN > 1 ? 's' : ''}` : ''}${info.stopped ? ` (stopped early${n < parts.length ? `: ${parts.length - n} parts wait` : ''})` : ''}`, 'ok');
    };
    if (sh) {
      // every shade row is nested on its own, then what is too wide for a row goes behind the rows on the full width
      const fits = (p: MarkerPart) => p.angles.some(a => { const bx = polyBox(placedPoly(p, { x: 0, y: 0, rot: a })); return bx.y1 - bx.y0 <= bandH - 0.5; });
      const bands: MarkerPart[][] = Array.from({ length: rowsN }, () => []), load = bands.map(() => 0), tail: MarkerPart[] = [];
      for (const p of items.filter(q => rowOf.has(q.id))) { bands[rowOf.get(p.id)!].push(p); load[rowOf.get(p.id)!] += p.area; }
      for (const p of items.filter(q => !rowOf.has(q.id)).sort((a, c) => c.area - a.area)) {
        if (!fits(p)) { tail.push(p); continue; }
        // the small pieces of a bundle go to the row of its major pieces while that keeps the rows even
        let k = bundleRow.get(p.sizeId + '|' + p.bundle) ?? -1; const least = load.indexOf(Math.min(...load));
        if (k < 0 || p.id[0] === '#' || load[k] > load[least] * 1.15 + p.area) k = least;
        bands[k].push(p); load[k] += p.area;
      }
      const runs = [...bands.map((its, k) => ({ its, k })).filter(x => x.its.length), ...(tail.length ? [{ its: tail, k: -1 }] : [])];
      const total = items.length, acc: Placements = {};
      let ends = 0, stopped = false;
      const show = (extra: Placements) => { live = expand({ ...acc, ...extra }); liveBlocks = newBlocks; runBest = markerStats(parts, live, w, newBlocks).length; draw(); };
      phase = 'shade rows';
      for (let q = 0; q < runs.length && !stopped; q++) {
        const { its, k } = runs[q], oy = k < 0 ? 0 : k * bandH, ox = k < 0 ? ends : 0;
        phase = k < 0 ? 'the pieces too wide for a shade row' : `shade row ${k + 1} of ${rowsN}`; drawTools(); drawStatus();
        const move = (pl: Placements): Placements => Object.fromEntries(Object.entries(pl).map(([id, v]) => [id, { ...v, x: v.x + ox, y: v.y + oy }]));
        const res = await nestOnce(nestJob(its, k < 0 ? w : bandH, { gap, name: r.name }), its, Math.max(3, m.nestSeconds * its.length / total), { length: Infinity, width: k < 0 ? w : bandH }, its.length > 1 ? pl => show(move(pl)) : undefined);
        if (!root) return;
        if (res) { const mv = move(res.placements); Object.assign(acc, mv); if (k >= 0) ends = Math.max(ends, res.length); }
        if (aborted) stopped = true;
      }
      const got = Object.keys(acc).length ? expand(acc) : null;
      if (got) runBest = markerStats(parts, got, w, newBlocks).length;
      finish(got, { stopped });
      return;
    }
    const job = nestJob(items, w, { gap, name: r.name });
    try {
      run = startNest(job, m.nestSeconds, {
        onBest: (pl, len) => { live = expand(pl); liveBlocks = newBlocks; runBest = len; draw(); },
        onDone: info => finish(live, info),
      });
      runTimer = window.setInterval(() => drawStatus(), 500);
    } catch (err) { run = null; toast('The nester could not start in this browser: ' + (err as Error).message, 'error'); }
    draw();
  }
  const nestStop = () => { aborted = true; run?.stop(); };

  // ── export / report
  const base = () => `${app.doc.style.name || 'style'}_${(row()?.name ?? 'marker').replace(/\s+/g, '_')}`;
  const annot = (): MarkerAnnot => ({ ...DEFAULT_ANNOT, ...(M().annot ?? {}) });
  const ratioText = (r: MarkerRow) => sizes().filter(s => r.ratio[s.id]).map(s => `${s.name} ${r.ratio[s.id]}`).join(' ');
  const outOpt = (r: MarkerRow) => ({ annot: annot(), name: r.name, ratio: ratioText(r), styleName: app.doc.style.name, blocks: r.blocks, plies: r.plies, material: M().material });
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
  /** a window of the marker room (piece details, settings): Esc or Cancel closes it, the OK button runs `ok` (false = stay open) */
  function modal(title: string, body: HTMLElement, okLabel: string, ok: () => boolean | void, cls = '') {
    dlg?.close();
    const back = h('div.mk-dlg-back'), close = () => { back.remove(); dlg = null; svg.focus(); };
    const box = h('div.mk-dlg' + cls, { role: 'dialog', 'aria-label': title },
      h('div.dlg-title', {}, title), body,
      h('div.dlg-foot', {}, h('span.spacer'), h('button.btn', { type: 'button', 'data-mk-dlg': 'cancel', onclick: close }, 'Cancel'), h('button.btn.primary', { type: 'button', 'data-mk-dlg': 'ok', onclick: () => { if (ok() !== false) { close(); draw(); } } }, okLabel)));
    back.append(box); back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
    root!.append(back); dlg = { close };
    (box.querySelector('input,select,textarea') as HTMLElement | null)?.focus();
  }
  /** Settings · annotation: the text on the parts and at the marker is typed as it should be written (a new line breaks the line), with its unit and its place. */
  function settings() {
    const a = annot(), r = row();
    const chips = (ta: HTMLTextAreaElement, toks: string[]) => h('div.mk-chips', {}, ...toks.map(t => h('button.mk-chip', { type: 'button', title: `Put ${t} in the text`, onclick: () => { const i = ta.selectionStart ?? ta.value.length, j = ta.selectionEnd ?? i; ta.value = ta.value.slice(0, i) + t + ta.value.slice(j); ta.focus(); ta.selectionStart = ta.selectionEnd = i + t.length; show(); } }, t)));
    const pt = h('textarea.mk-ta', { rows: '4', 'data-mk-set': 'partText', spellcheck: 'false' }) as HTMLTextAreaElement; pt.value = partTemplate(a);
    const mt = h('textarea.mk-ta', { rows: '4', 'data-mk-set': 'markerText', spellcheck: 'false' }) as HTMLTextAreaElement; mt.value = markerTemplate(a);
    const cbx = (key: 'grain' | 'seam' | 'border', label: string) => { const i = h('input', { type: 'checkbox', 'data-mk-set': key, checked: a[key] }) as HTMLInputElement; i.addEventListener('change', show); return [h('label.mk-ck', {}, i, label), i] as const; };
    const sel2 = <T extends string>(key: string, val: T, opts: [T, string][]) => { const e = h('select.mk-in', { 'data-mk-set': key }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l))) as HTMLSelectElement; e.addEventListener('change', show); return e; };
    const numIn = (key: string, v: number) => h('input.mk-n', { type: 'text', 'data-mk-set': key, value: String(v) }) as HTMLInputElement;
    const [grainL, grain] = cbx('grain', 'Grain line'), [seamL, seam] = cbx('seam', 'Seam (sew) line'), [borderL, border] = cbx('border', 'Marker border and its text');
    const internals = sel2('internals', a.internals, [['draw', 'Draw (pen)'], ['cut', 'Cut'], ['none', 'Leave out']]);
    const unit = sel2<AnnotUnit>('unit', a.unit ?? 'mm', [['mm', 'Millimetres'], ['cm', 'Centimetres'], ['m', 'Metres'], ['in', 'Inches'], ['yd', 'Yards']]);
    const place = sel2<AnnotPlace>('place', a.place ?? 'top', [['top', 'Above the marker, at its start'], ['bottom', 'Below the marker, at its start'], ['start', 'Before the start, written upward'], ['end', 'After the end, written upward']]);
    const th = numIn('textH', a.textH ?? 8), bh = numIn('bTextH', a.bTextH ?? 12);
    const prevP = h('pre.mk-prev', { 'data-mk-set': 'prevPart' }), prevM = h('pre.mk-prev', { 'data-mk-set': 'prevMarker' });
    const read = (): MarkerAnnot => ({ ...a, grain: grain.checked, seam: seam.checked, border: border.checked, internals: internals.value as MarkerAnnot['internals'], partText: pt.value.replace(/\s+$/, ''), markerText: mt.value.replace(/\s+$/, ''),
      unit: unit.value as AnnotUnit, place: place.value as AnnotPlace, textH: Math.max(1, Math.min(100, Number(th.value) || 8)), bTextH: Math.max(1, Math.min(200, Number(bh.value) || 12)) });
    function show() {
      const n = read(), p = parts.find(q => pls()[q.id]) ?? parts[0];
      prevP.textContent = p ? partLabel(p, n, app.doc.style.name).join('\n') || '(nothing is written on the parts)' : '(this marker has no parts yet)';
      prevM.textContent = !n.border ? '(no border, no marker text)' : r ? borderLines(parts, pls(), wd(r), n, outOpt(r)).join('\n') || '(nothing is written at the marker)' : '(no marker yet)';
    }
    pt.addEventListener('input', show); mt.addEventListener('input', show);
    const body = h('div.dlg-body.mk-set', {},
      h('p.dlg-msg', {}, 'Type the text as it should be written: every line you type is one written line. The words in { } are filled in. It applies to the screen, the plot (.plt) and the DXF.'),
      h('div.mk-set-h', {}, 'On every part'), chips(pt, ['{style}', '{piece}', '{size}', '{bundle}', '{no}', '{desc}', '{material}']), pt,
      h('div.mk-set-row', {}, h('label', {}, 'Text height', th, h('span.mk-dim', {}, 'mm')), grainL, seamL, h('label', {}, 'Internal lines', internals)),
      h('div.mk-set-l', {}, 'Written like this'), prevP,
      h('div.mk-set-h', {}, 'At the marker'), borderL, chips(mt, ['{name}', '{ratio}', '{length}', '{width}', '{eff}', '{perim}', '{style}', '{material}', '{plies}', '{parts}']), mt,
      h('div.mk-set-row', {}, h('label', {}, 'Units', unit), h('label', {}, 'Place', place), h('label', {}, 'Text height', bh, h('span.mk-dim', {}, 'mm'))),
      h('div.mk-set-l', {}, 'Written like this'), prevM);
    modal('Marker settings · annotation', body, 'Apply', () => { const n = read(); edit('Marker settings', d => { d.annot = n; }); draw(true); });
    show();
  }
  /** Buffer: the pieces of the selected parts keep a clear margin around their outline, in every size and marker. */
  async function buffer() {
    if (busy()) return;
    const ps = parts.filter(p => sel.has(p.id)); const pieceIds = [...new Set(ps.map(p => p.pieceId))];
    if (!pieceIds.length) { toast('Buffer: select a part of the piece first (Shift+click), or set it for any piece in Piece details', 'warn'); return; }
    const r = await showDialog({ title: 'Buffer', message: `${[...new Set(ps.map(p => p.name))].join(', ')}\nThe piece keeps this much room clear all round, in every size and every marker. Only its own outline is cut. Margin 0 takes the buffer off.`,
      fields: [{ kind: 'length', key: 'm', label: 'Buffer margin', value: M().buffer?.[pieceIds[0]] ?? 3, min: 0 }] });
    if (!r) return;
    const mg = Math.max(0, r.m as number);
    edit(mg > 0 ? 'Buffer' : 'Remove buffer', d => {
      const b = { ...(d.buffer ?? {}) };
      for (const id of pieceIds) { if (mg > 0) b[id] = mg; else delete b[id]; }
      if (Object.keys(b).length) d.buffer = b; else delete d.buffer;
      strip(d, pieceIds);
    });
    toast(mg > 0 ? `Buffer: ${fmt(mg)} ${unitLabel()} all round · the parts wait to be laid again` : 'Buffer removed', 'ok');
  }
  /** Stripe and plaid of the fabric: the repeat distances and where the first bar lies. Match lines of the pieces go onto the bars. */
  async function matchSettings() {
    if (busy()) return; if (carry) dropCarry(true);
    const f = fab() ?? {};
    const r = await showDialog({ title: 'Stripe and plaid', message: 'Stripe: bars across the fabric width, repeating along its length. A match line across the grain of a piece (a horizontal line on a piece with an upright grain) lies on a stripe.\nPlaid: bars along the fabric length, repeating across its width. A match line along the grain (a vertical line) lies on a plaid bar.\nSet a line to Match in the property editor of the pattern (M1 = to the fabric, P1 … P15 = piece to piece). Distance 0 = none.',
      fields: [{ kind: 'length', key: 'stripe', label: 'Stripe distance', value: f.stripe ?? 0, min: 0 }, { kind: 'length', key: 'stripe1', label: '1st stripe, from the marker start', value: f.stripe1 ?? 0, min: 0 },
        { kind: 'length', key: 'plaid', label: 'Plaid distance', value: f.plaid ?? 0, min: 0 }, { kind: 'length', key: 'plaid1', label: '1st plaid, from the fabric edge', value: f.plaid1 ?? 0, min: 0 }] });
    if (!r) return;
    const n = { stripe: Math.max(0, r.stripe as number), stripe1: Math.max(0, r.stripe1 as number), plaid: Math.max(0, r.plaid as number), plaid1: Math.max(0, r.plaid1 as number) };
    edit('Stripe and plaid', d => { if (n.stripe || n.plaid) d.match = n; else delete d.match; });
    const lines = parts.some(p => p.match?.length);
    toast(n.stripe || n.plaid ? `${n.stripe ? `Stripe every ${fmt(n.stripe)} ${unitLabel()}` : 'No stripe'} · ${n.plaid ? `plaid every ${fmt(n.plaid)} ${unitLabel()}` : 'no plaid'}${lines ? ' · press ▶ to nest onto the match' : ' · no piece has a match line yet (pattern ▸ select an internal line ▸ Line is)'}` : 'Stripe and plaid off', lines || !(n.stripe || n.plaid) ? 'ok' : 'warn');
  }
  /** Shade zones: rows across the width, columns by a length or by bundle end, with an overlap on each. The major pieces of a bundle are laid within one zone. */
  async function shadeSettings() {
    if (busy()) return; if (carry) dropCarry(true);
    const cur = M().shade, majors = parts.filter(p => p.major).length;
    const r = await showDialog({ title: 'Shade zones', message: 'For fabric that shades from side to centre or along the roll: the major pieces of a bundle (Piece details ▸ Major) are laid within one zone, so the panels of a garment have the same shade.\nRows divide the fabric width into equal parts. Columns are a set length, or end where the bundle ends (bundles follow each other). The overlap lets a piece reach that much into the next row or column.',
      fields: [{ kind: 'checkbox', key: 'on', label: 'Shade zones on', value: !!cur && cur.rows >= 1 },
        { kind: 'number', key: 'rows', label: 'Rows (the width is divided by)', value: cur?.rows && cur.rows >= 1 ? cur.rows : 2, min: 1, max: 12, step: 1 },
        { kind: 'select', key: 'colBy', label: 'Columns by', value: cur?.colBy ?? 'bundle', options: [{ value: 'bundle', label: 'Bundle end' }, { value: 'length', label: 'Length' }] },
        { kind: 'length', key: 'colLength', label: 'Column length', value: cur?.colLength ?? 2000, min: 0, hint: 'Used with Columns by ▸ Length' },
        { kind: 'number', key: 'rowOverlap', label: 'Row overlap', value: cur?.rowOverlap ?? 0, min: 0, max: 100, suffix: '%' },
        { kind: 'number', key: 'colOverlap', label: 'Column overlap', value: cur?.colOverlap ?? 0, min: 0, max: 50, suffix: '%' }],
      validate: v => (v.on && v.colBy === 'length' && !((v.colLength as number) > 50) ? 'Type the column length' : null) });
    if (!r) return;
    const n: ShadeSet = { rows: r.on ? Math.max(1, Math.min(12, Math.round(r.rows as number) || 1)) : 0, colBy: r.colBy === 'length' ? 'length' : 'bundle', colLength: Math.max(0, r.colLength as number), rowOverlap: Math.max(0, Math.min(100, (r.rowOverlap as number) || 0)), colOverlap: Math.max(0, Math.min(50, (r.colOverlap as number) || 0)) };
    edit('Shade zones', d => { d.shade = n; });
    toast(!n.rows ? 'Shade zones off' : `Shade zones: ${n.rows} row${n.rows > 1 ? 's' : ''} · columns by ${n.colBy === 'length' ? `length ${fmt(n.colLength)} ${unitLabel()}` : 'bundle end'}${majors ? ' · press ▶ to lay the major pieces in their zones' : ' · no piece is marked Major yet (Piece details)'}`, !n.rows || majors ? 'ok' : 'warn');
  }
  /** the carried / thrown parts step onto their match: the first of them that has a match line decides, the rest go with it */
  function snapMatch(next: Placements, ids: string[], way?: { x?: number; y?: number }): Placements {
    const f = fab(); if (!f || !matchActive(parts, f)) return next;
    const only = new Set(ids.filter(id => next[id]));
    const sh = matchShifts(parts, next, f, { way, only });
    const s = ids.map(id => sh.get(id)).find(v => v && (Math.abs(v.x) > 1e-6 || Math.abs(v.y) > 1e-6)); if (!s) return next;
    const out = { ...next }; for (const id of only) out[id] = { ...out[id], x: out[id].x + s.x, y: out[id].y + s.y };
    // a step that would take the part off the fabric is taken to the nearest match instead
    const w = wd(), offFab = parts.some(p => { if (!only.has(p.id)) return false; const b = polyBox(placedPoly(p, out[p.id])); return b.x0 < -0.6 || b.y0 < -0.6 || b.y1 > w + 0.6; });
    return offFab && way ? snapMatch(next, ids) : out;
  }
  /**
   * Piece details: every panel of the style in one window. Per panel: major piece, goes into fuse blocks, its own rotation, tilt
   * and buffer. With a panel marked for block fuse the limits of the blocks are set here too: the nester fills blocks no longer or
   * wider than that (two or more when one is not enough), every block with its own buffer, and lays them with the other panels.
   */
  function pieceDetails() {
    if (busy()) return; if (carry) dropCarry(true);
    const m = M(), set = bset();
    const pieces = app.doc.style.pieces.filter(p => !m.material || (p.order?.material ?? '') === m.material);
    if (!pieces.length) { toast('This style has no panels for this material', 'warn'); return; }
    const ROT: [string, string][] = [['', 'Piece setting'], ['1way', '1 way'], ['2way', '2 way (180°)'], ['4way', '4 way (90°)']];
    const rotName = (v?: string) => v === '1way' ? '1 way' : v === '4way' ? '4 way' : '2 way';
    const rows = pieces.map(p => {
      const d0: PieceDetail = { ...(m.detail?.[p.id] ?? {}) }; if (d0.block === undefined && m.block?.[p.id]) d0.block = true;
      const ck = (k: string, on: boolean, title: string) => h('input', { type: 'checkbox', 'data-pd': `${k}:${p.name}`, checked: on, title }) as HTMLInputElement;
      const major = ck('major', !!d0.major, 'Major piece: one of the big panels; it waits first to be laid'), block = ck('block', !!d0.block, 'Goes into fuse blocks when the marker is nested');
      const rot = h('select.mk-in', { 'data-pd': `rot:${p.name}`, title: 'Turns this panel may take on the marker' }, ...ROT.map(([v, l]) => h('option', { value: v, selected: v === (d0.rotation ?? '') }, v ? l : `${l} (${rotName(p.order?.rotation)})`))) as HTMLSelectElement;
      const tilt = h('input.mk-n', { type: 'text', 'data-pd': `tilt:${p.name}`, value: d0.tilt ? String(d0.tilt) : '', placeholder: '0', title: 'How far the panel may be tilted off the grain, either way (degrees, up to 15)' }) as HTMLInputElement;
      const buf = h('input.mk-n', { type: 'text', 'data-pd': `buffer:${p.name}`, value: m.buffer?.[p.id] ? fmt(m.buffer[p.id]) : '', placeholder: '0', title: 'Room kept clear around this panel' }) as HTMLInputElement;
      const pic = h('td.mk-pd-pic'); pic.innerHTML = pieceThumb(app, p, 34);
      const tr = h('tr', {}, pic, h('td.mk-pd-name', {}, p.name, h('span.mk-sub', {}, [p.description?.trim(), `${Math.max(1, p.order?.qtyPerBundle ?? 1)}${p.order?.side === 'LR' ? ' pair' : ''} per bundle`, p.order?.material].filter(Boolean).join(' · '))),
        h('td', {}, major), h('td', {}, block), h('td', {}, rot), h('td', {}, tilt, h('span.mk-dim', {}, ' °')), h('td', {}, buf, h('span.mk-dim', {}, ' ' + unitLabel())));
      return { p, d0, major, block, rot, tilt, buf, tr };
    });
    const len = (k: string, v: number, title: string) => h('input.mk-n.mk-w', { type: 'text', 'data-pd': k, value: fmt(v), title }) as HTMLInputElement;
    const maxL = len('maxLength', set.maxLength, 'No fuse block is longer than this (along the fabric)'), maxW = len('maxWidth', set.maxWidth, 'No fuse block is wider than this (across the fabric)'), bbuf = len('blockBuffer', set.buffer, 'Room kept around the panels inside every block');
    const shape = h('select.mk-in', { 'data-pd': 'shape' }, h('option', { value: 'rect', selected: set.shape === 'rect' }, 'Rectangular'), h('option', { value: 'contour', selected: set.shape === 'contour' }, 'Contour (follows the panels)')) as HTMLSelectElement;
    const note = h('span.mk-dim');
    const blockBox = h('div.mk-pd-block', { 'data-pd': 'blockset' }, h('div.mk-set-h', {}, 'Fuse blocks'),
      h('div.mk-set-row', {}, h('label', {}, 'Max length', maxL, h('span.mk-dim', {}, unitLabel())), h('label', {}, 'Max width', maxW, h('span.mk-dim', {}, unitLabel())), h('label', {}, 'Buffer', bbuf, h('span.mk-dim', {}, unitLabel())), h('label', {}, 'Outline', shape)), note);
    const sync = () => { const n = rows.filter(x => x.block.checked).length; blockBox.classList.toggle('off', !n); for (const e of [maxL, maxW, bbuf, shape]) e.disabled = !n; note.textContent = n ? `${n} panel${n > 1 ? 's' : ''} go into fuse blocks. Nest ▶ fills blocks within these limits (two or more when one is not enough), each with its own buffer, then lays them with the other panels.` : 'Tick Block for the panels that are fused as a block; the limits of the blocks are then set here.'; };
    rows.forEach(x => x.block.addEventListener('change', sync)); sync();
    const all = (k: 'major' | 'block') => h('button.mk-chip', { type: 'button', title: `Tick or clear every panel`, onclick: () => { const on = !rows.every(x => x[k].checked); rows.forEach(x => { x[k].checked = on; }); sync(); } }, 'all');
    const body = h('div.dlg-body', {},
      h('div.mk-scroll.mk-pd-scroll', {}, h('table.mk-tbl.mk-pd', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Panel'), h('th', {}, 'Major ', all('major')), h('th', {}, 'Block ', all('block')), h('th', {}, 'Rotation'), h('th', {}, 'Tilt'), h('th', {}, 'Buffer')), ...rows.map(x => x.tr))),
      blockBox);
    modal(`Piece details · ${pieces.length} panel${pieces.length > 1 ? 's' : ''}${m.material ? ' · ' + m.material : ''}`, body, 'Apply', () => {
      const L = parseLen(maxL.value), Wd = parseLen(maxW.value), B = parseLen(bbuf.value), anyBlock = rows.some(x => x.block.checked);
      if (anyBlock && !(Number.isFinite(L) && L > 20 && Number.isFinite(Wd) && Wd > 20 && Number.isFinite(B) && B >= 0 && L > 2 * B + 10 && Wd > 2 * B + 10)) { toast('Fuse blocks: type a max length and a max width larger than twice the buffer', 'error'); return false; }
      const changed: string[] = []; let bad2 = '';
      const next = rows.map(x => {
        const t = x.tilt.value.trim() ? Number(x.tilt.value.replace(',', '.')) : 0, bf = x.buf.value.trim() ? parseLen(x.buf.value) : 0;
        if (!Number.isFinite(t) || t < 0 || t > 15) bad2 = `${x.p.name}: the tilt is 0 to 15 degrees`;
        if (!Number.isFinite(bf) || bf < 0) bad2 = `${x.p.name}: the buffer is not a length`;
        const det: PieceDetail = { ...(x.major.checked ? { major: true } : {}), ...(x.block.checked ? { block: true } : {}), ...(x.rot.value ? { rotation: x.rot.value as PieceDetail['rotation'] } : {}), ...(t > 0 ? { tilt: t } : {}) };
        const was = m.buffer?.[x.p.id] ?? 0;
        if ((det.rotation ?? '') !== (x.d0.rotation ?? '') || (det.tilt ?? 0) !== (x.d0.tilt ?? 0) || !!det.block !== !!x.d0.block || Math.abs(bf - was) > 1e-6) changed.push(x.p.id);
        return { id: x.p.id, det, bf };
      });
      if (bad2) { toast(bad2, 'error'); return false; }
      edit('Piece details', d => {
        const det = { ...(d.detail ?? {}) }, buf2 = { ...(d.buffer ?? {}) };
        for (const n of next) { if (Object.keys(n.det).length) det[n.id] = n.det; else delete det[n.id]; if (n.bf > 0) buf2[n.id] = n.bf; else delete buf2[n.id]; if (d.block) delete d.block[n.id]; }
        if (Object.keys(det).length) d.detail = det; else delete d.detail;
        if (Object.keys(buf2).length) d.buffer = buf2; else delete d.buffer;
        if (d.block && !Object.keys(d.block).length) delete d.block;
        if (anyBlock) d.blockSet = { maxLength: L, maxWidth: Wd, buffer: B, shape: shape.value === 'contour' ? 'contour' : 'rect' };
        if (changed.length) strip(d, changed);
      });
      toast(`Piece details kept${changed.length ? ` · the parts of ${changed.length} panel${changed.length > 1 ? 's' : ''} wait to be laid again: press ▶` : ''}`, 'ok');
    }, '.wide');
  }
  const menu = (e: Event, items: { label: string; run: () => void }[]) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openContextMenu(r.left, r.bottom + 2, [], items); };
  function report() {
    const m = M(), t = planTotals(sid(), m.order, m.rows);
    const lines = [`Cut plan — ${app.doc.style.name}`, `Material: ${m.material || 'all materials'}`, ''];
    let fabric = 0;
    for (const r of m.rows) {
      const ps = mp(r.ratio, m), st = markerStats(ps, r.placements, r.width ?? m.width, r.blocks);
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
        { label: 'Plot this marker (.plt)', run: plot }, { label: 'Settings · annotation…', run: settings },
      ]) }, 'File ▾'),
      h('button.mk-menu', { type: 'button', 'data-mk': 'menu-marker', onclick: (e: Event) => menu(e, [
        { label: 'Piece details…', run: pieceDetails }, { label: 'Marry pieces', run: marry }, { label: 'Unmarry', run: unmarry },
        { label: 'Block fuse (selected parts)…', run: () => void blockFuse() }, { label: 'Unblock', run: unblock }, { label: 'Buffer…', run: () => void buffer() }, { label: 'Stripe and plaid…', run: () => void matchSettings() }, { label: 'Shade zones…', run: () => void shadeSettings() },
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
      const ps = mp(r.ratio, m), st = markerStats(ps, r.placements, r.width ?? m.width, r.blocks);
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
        const ps = mp(r.ratio, m), st = markerStats(ps, r.placements, r.width ?? m.width, r.blocks);
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
      busy() ? b('stop', '■', 'Stop nesting and keep the best layout so far', nestStop, '.stop') : b('nest', '▶', 'Nest this marker automatically (N). Panels marked Block in Piece details are laid into fuse blocks first.', () => void nestStart(), '.play'),
      time, h('div.mk-sep'),
      b('marry', '⚭', 'Marry the selected parts: they are picked up, thrown and turned as one (Shift+click selects several)', marry),
      b('unmarry', '⚮', 'Unmarry: the parts of the selected group move on their own again', unmarry),
      b('details', '☰', 'Piece details: every panel with its major mark, block fuse, rotation, tilt and buffer; the limits of the fuse blocks', pieceDetails),
      b('block', '▣', 'Block fuse: the selected laid parts become one fuse block, contour or rectangular, with a buffer (Shift+click or draw a box to select)', () => void blockFuse()),
      b('match', '▦', 'Stripe and plaid: the repeat of the fabric and its first bar; match lines of the pieces are laid onto the bars', () => void matchSettings()),
      b('shade', '▤', 'Shade zones: rows across the width and columns along the length; the major pieces of a bundle are laid within one zone', () => void shadeSettings()),
      b('unblock', '▢', 'Unblock: take away the fuse block of the selected part', unblock),
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
    const st = markerStats(parts, pls(), wd(), blks());
    const el = run ? Math.min(run.seconds, (performance.now() - run.startedAt) / 1000) : 0;
    stat.textContent = [r.name, `${st.placed} of ${st.parts} parts laid`, `length ${fmt(st.length)} ${unitLabel()}`, `efficiency ${(st.efficiency * 100).toFixed(2)} %`,
      `${r.plies} plies = ${(st.length * r.plies / 1000).toFixed(2)} m of fabric`, `perimeter ${(markerPerimeter(parts, pls(), blks()) / 1000).toFixed(2)} m`, blks().length ? `${blks().length} fuse block${blks().length > 1 ? 's' : ''}` : '', bad.size ? `⚠ ${bad.size} part${bad.size > 1 ? 's' : ''} overlapping, inside a block or off the fabric` : '', off.size ? `⚠ ${off.size} part${off.size > 1 ? 's' : ''} off the stripe / plaid match` : '', shadeOff.size ? `⚠ ${shadeOff.size} major part${shadeOff.size > 1 ? 's' : ''} outside one shade zone` : '',
      phase ? `nesting… ${phase}${run ? ` · ${Math.min(run.seconds, (performance.now() - run.startedAt) / 1000).toFixed(0)} / ${run.seconds.toFixed(0)} s` : ''}` : run ? `nesting… ${el.toFixed(0)} / ${run.seconds} s on ${run.threads} thread${run.threads > 1 ? 's' : ''}` : carry ? 'Carrying: click = put down · press and pull = aim, let go = shoot · right-click = turn 180° · Esc = put back' : 'Click a part to pick it up · press and pull = aim, let go = shoot · right-click = turn 180° · Shift+click or draw a box = select · [ ] = tilt'].filter(Boolean).join('  ·  ');
  }
  function drawSvg() {
    const p0 = pls(), fw = wd(), bk = blks(), st = markerStats(parts, p0, fw, bk);
    bad = busy() ? new Set() : markerProblems(parts, p0, fw, 0.6, bk);
    const fm = fab(); off = busy() || !fm ? new Set() : markerMismatch(parts, p0, fm);
    const sz = shade(); shadeOff = busy() || !sz ? new Set() : shadeProblems(parts, p0, fw, sz);
    const f = (n: number) => n.toFixed(1);
    const len = Math.max(st.length, 1000), a = S({ x: 0, y: 0 }), b2 = S({ x: len, y: fw });
    const sIdx = new Map(sizes().map((s, k) => [s.id, k]));
    let out = `<rect x="${f(a.x)}" y="${f(a.y)}" width="${f(b2.x - a.x + 4000 * view.k)}" height="${f(b2.y - a.y)}" class="mk-fabric"/>`;
    if (fm && ((fm.stripe ?? 0) > 0 || (fm.plaid ?? 0) > 0)) {
      // the bars of the fabric: stripes across the width (blue), plaid bars along the length (orange); the first of each is heavier
      const endX = len + 4000; let g2 = '';
      if ((fm.stripe ?? 0) > 0 && endX / fm.stripe! < 900 && fm.stripe! * view.k > 2.5) for (let x = fm.stripe1 ?? 0, k2 = 0; x <= endX; x += fm.stripe!, k2++) { const q = S({ x, y: 0 }); g2 += `<line${k2 ? '' : ' class="first"'} x1="${f(q.x)}" y1="${f(a.y)}" x2="${f(q.x)}" y2="${f(b2.y)}"/>`; }
      if ((fm.plaid ?? 0) > 0 && fw / fm.plaid! < 900 && fm.plaid! * view.k > 2.5) for (let y = fm.plaid1 ?? 0, k2 = 0; y <= fw; y += fm.plaid!, k2++) { const q = S({ x: 0, y }); g2 += `<line class="pl${k2 ? '' : ' first'}" x1="${f(a.x)}" y1="${f(q.y)}" x2="${f(b2.x + 4000 * view.k)}" y2="${f(q.y)}"/>`; }
      out += `<g class="mk-grid">${g2}</g>`;
    }
    if (sz) {
      // shade zones: the rows (with the overlap shown as a band), the column lengths as a ruler, and the box of every bundle's major pieces
      const R = Math.max(1, Math.floor(sz.rows)), hh = fw / R, ro = Math.max(0, sz.rowOverlap) / 100 * hh, x1 = b2.x + 4000 * view.k; let z = '';
      for (let k2 = 1; k2 < R; k2++) { const y = S({ x: 0, y: k2 * hh }).y; if (ro > 0) z += `<rect class="ov" x="${f(a.x)}" y="${f(y - ro * view.k)}" width="${f(x1 - a.x)}" height="${f(2 * ro * view.k)}"/>`; z += `<line x1="${f(a.x)}" y1="${f(y)}" x2="${f(x1)}" y2="${f(y)}"/>`; }
      for (let k2 = 0; k2 < R; k2++) { const t = S({ x: 0, y: k2 * hh }); z += `<text x="${f(a.x + 4)}" y="${f(t.y + 12)}">row ${k2 + 1}</text>`; }
      if (sz.colBy === 'length' && sz.colLength > 0 && sz.colLength * view.k > 6) for (let x = sz.colLength; x <= len + 4000 && x / sz.colLength < 400; x += sz.colLength) { const q = S({ x, y: 0 }); z += `<line class="col" x1="${f(q.x)}" y1="${f(a.y)}" x2="${f(q.x)}" y2="${f(b2.y)}"/>`; }
      for (const bz of shadeBundles(parts, p0, fw, sz)) { const p1 = S({ x: bz.box.x0, y: bz.box.y0 }), p2 = S({ x: bz.box.x1, y: bz.box.y1 }), badZ = bz.ids.some(id => shadeOff.has(id)); const first = parts.find(p => p.id === bz.ids[0]); z += `<rect class="bz${badZ ? ' bad' : ''}" x="${f(p1.x)}" y="${f(p1.y)}" width="${f(p2.x - p1.x)}" height="${f(p2.y - p1.y)}"/><text class="bzt${badZ ? ' bad' : ''}" x="${f(p1.x + 4)}" y="${f(p2.y - 4)}">${first ? first.code : ''}</text>`; }
      out += `<g class="mk-shade">${z}</g>`;
    }
    if (st.length > 0) { const e = S({ x: st.length, y: 0 }); out += `<line x1="${f(e.x)}" y1="${f(a.y - 8)}" x2="${f(e.x)}" y2="${f(b2.y + 8)}" class="mk-end"/><text x="${f(e.x + 5)}" y="${f(a.y - 12)}" class="mk-lab">${fmt(st.length)} ${unitLabel()} · ${(st.efficiency * 100).toFixed(1)} %</text>`; }
    const wedSet = new Set((row()?.marry ?? []).flat());
    const an = annot(), sname = app.doc.style.name, esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    // the text at the marker, where the settings put it (on screen it keeps a readable size)
    const r0 = row();
    if (an.border && r0) {
      const bl = borderLines(parts, p0, fw, an, outOpt(r0)), up = borderLayout(an, bl.length, st.length, fw).up, pl2 = an.place ?? 'top', e = S({ x: Math.max(st.length, 0), y: 0 });
      bl.forEach((t, i) => {
        const x = pl2 === 'start' ? a.x - 8 - (bl.length - 1 - i) * 15 : pl2 === 'end' ? e.x + 18 + i * 15 : a.x, y = pl2 === 'top' ? a.y - 8 - (bl.length - 1 - i) * 15 - (st.length > 0 ? 16 : 0) : pl2 === 'bottom' ? b2.y + 18 + i * 15 : b2.y;
        out += `<text x="${f(x)}" y="${f(y)}" class="mk-lab mk-btext"${up ? ` transform="rotate(-90 ${f(x)} ${f(y)})"` : ''}>${esc(t)}</text>`;
      });
    }
    // fuse blocks: their outline, under their parts
    const wp: Placements = {}; for (const p of parts) { const q = where(p); if (q) wp[p.id] = q; }
    for (const b of bk) { const o = blockOutline(parts, wp, b); if (!o) continue; const held = !!carry && b.ids.some(id => carry!.base[id]); out += `<path class="mk-blk${b.shape === 'rect' ? ' rect' : ''}${held ? ' carry' : ''}${b.ids.some(id => sel.has(id)) ? ' sel' : ''}" d="${o.map(S).map((v, i) => `${i ? 'L' : 'M'}${f(v.x)} ${f(v.y)}`).join('')}Z"/>`; }
    const dl = (v: Vec[], q: Placement, closed: boolean) => v.map(x => S(placedPoint(q, x))).map((x, i) => `${i ? 'L' : 'M'}${f(x.x)} ${f(x.y)}`).join('') + (closed ? 'Z' : '');
    let top2 = '';
    for (const p of parts) {
      const q = where(p); if (!q) continue;
      const pts = placedPoly(p, q).map(S), col = SIZE_COL[(sIdx.get(p.sizeId) ?? 0) % SIZE_COL.length];
      const held = !!carry?.base[p.id];
      const cls = 'mk-part' + (sel.has(p.id) ? ' sel' : '') + (bad.has(p.id) && !held ? ' bad' : '') + (p0[p.id] || held ? '' : ' wait') + (held ? ' carry' : '') + (wedSet.has(p.id) ? ' wed' : '') + (p.inner ? ' block' : '') + (p.major ? ' major' : '') + (p.fuse ? ' fuse' : '') + (off.has(p.id) && !held ? ' off' : '') + (shadeOff.has(p.id) && !held ? ' shadeoff' : '');
      const g0 = S(placedPoint(q, p.grain[0])), g1 = S(placedPoint(q, p.grain[1]));
      const bx = polyBox(pts), big = (bx.x1 - bx.x0) > 46 && (bx.y1 - bx.y0) > 16;
      const one = `<g class="${cls}" data-part="${p.id}"><path d="${pts.map((v, i) => `${i ? 'L' : 'M'}${f(v.x)} ${f(v.y)}`).join('')}Z" style="--c:${col}"/>`
        + (p.inner ? `<path class="mk-inner" d="${dl(p.inner, q, true)}" style="--c:${col}"/>` : '')
        + (an.seam && p.sew ? `<path class="mk-seam" d="${dl(p.sew, q, true)}"/>` : '')
        + (() => { const ways = (p.lines ?? []).map((_, i) => lineWay(p, i, an)), dOf = (w: string) => (p.lines ?? []).filter((_, i) => ways[i] === w).map(l => dl(l, q, false)).join('');
          const dd = dOf('draw'), dc = dOf('cut'), dm = dOf('match');
          return (dd ? `<path class="mk-int" d="${dd}"/>` : '') + (dc ? `<path class="mk-int cut" d="${dc}"/>` : '') + (dm ? `<path class="mk-mline" d="${dm}"/>` : '')
            + (big ? (p.match ?? []).map(m => { const t = S(placedPoint(q, m.mid)); return `<text class="mk-mcode" x="${f(t.x + 3)}" y="${f(t.y - 3)}">${m.code}</text>`; }).join('') : ''); })()
        + (an.grain ? `<line x1="${f(g0.x)}" y1="${f(g0.y)}" x2="${f(g1.x)}" y2="${f(g1.y)}" class="mk-grain"/>` : '')
        + (big ? partLabel(p, an, sname).map((t, i) => `<text x="${f((bx.x0 + bx.x1) / 2)}" y="${f((bx.y0 + bx.y1) / 2 + 3 + i * 11)}" class="mk-pl">${esc(t.slice(0, 40))}</text>`).join('') : '') + '</g>';
      if (held) top2 += one; else out += one; // carried parts are drawn last, on top
    }
    out += top2 + '<g class="mk-over"></g>';
    if (Object.keys(tray).length) { const t = S({ x: 0, y: -30 - trayShift }); out += `<text x="${f(t.x)}" y="${f(t.y)}" class="mk-lab">Waiting to be laid: ${Object.keys(tray).length}</text>`; }
    svg.innerHTML = out;
    carryEls = carry ? [...carry.ids.map(id => svg.querySelector(`[data-part="${CSS.escape(id)}"]`)).filter(Boolean) as SVGGElement[], ...svg.querySelectorAll('.mk-blk.carry') as unknown as SVGGElement[]] : [];
    over = svg.querySelector('.mk-over');
    place(); drawAim();
  }
  let carryEls: SVGGElement[] = [], over: Element | null = null;
  /** the carried parts follow the cursor: only their transform changes, nothing is drawn again (this is what keeps it light) */
  function place() { if (!carry) return; const t = `translate(${(carry.shift.x * view.k).toFixed(1)} ${(carry.shift.y * view.k).toFixed(1)})`; for (const el of carryEls) el.setAttribute('transform', t); }
  function drawAim() {
    if (!over) return;
    if (mq) { const p = S(mq.a), q = S(mq.b); over.innerHTML = `<rect class="mk-mq${mq.b.x < mq.a.x ? ' touch' : ''}" x="${Math.min(p.x, q.x).toFixed(1)}" y="${Math.min(p.y, q.y).toFixed(1)}" width="${Math.abs(q.x - p.x).toFixed(1)}" height="${Math.abs(q.y - p.y).toFixed(1)}"/>`; return; }
    if (!aim) { over.innerHTML = ''; return; }
    const f = (n: number) => n.toFixed(1), a1 = S(aim.from), a2 = S(aim.to), ang = Math.atan2(a2.y - a1.y, a2.x - a1.x), hd = 11;
    const pt = (r: number, o: number) => `${f(a2.x + r * Math.cos(ang + o))} ${f(a2.y + r * Math.sin(ang + o))}`;
    over.innerHTML = `<g class="mk-aim"><line x1="${f(a1.x)}" y1="${f(a1.y)}" x2="${f(a2.x)}" y2="${f(a2.y)}"/><path d="M${pt(0, 0)}L${pt(-hd, 0.42)}L${pt(-hd, -0.42)}Z"/><circle cx="${f(a1.x)}" cy="${f(a1.y)}" r="3.5"/></g>`;
  }
  function draw(refit = false) {
    if (!root) return;
    refreshParts(); layTray();
    if (refit) { fit(); layTray(); }
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
    keep('Put part down', snapMatch(next, c.ids)); // onto the nearest stripe / plaid match
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
    const tb = (r.blocks ?? []).filter(b => b.ids.every(id => start[id]));
    let went = dir;
    const res = throwParts(parts, start, w, c.ids, dir, { gap: M().gap, blocks: tb }) ?? (went = { x: -dir.x, y: -dir.y }, throwParts(parts, start, w, c.ids, went, { gap: M().gap, blocks: tb }));
    if (!res) { toast('No free place that way: the part stays on the cursor', 'warn'); drawSvg(); return; }
    {
      // with a stripe / plaid match the part steps back along its way to the match it passed last (never forward into what stopped it)
      const way = { x: went.x < -1e-6 ? 1 : went.x > 1e-6 ? -1 : 0, y: went.y < -1e-6 ? 1 : went.y > 1e-6 ? -1 : 0 };
      const sn = snapMatch({ ...laid, ...res }, c.ids, way); for (const id of c.ids) if (sn[id]) res[id] = sn[id];
    }
    carry = null; press = null;
    const ids = c.ids, t0 = performance.now(), dur = 140;
    cancelAnimationFrame(anim); runRow = r.id; liveBlocks = null;
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
    const onPart = (e.target as Element).closest('[data-part]');
    if (e.button === 2 && (onPart || carry)) return; // right-click on a part: turn (see contextmenu)
    if (e.button === 1 || e.button === 2 || e.altKey) { pan = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); return; } // middle, right or Alt: move the view
    if (carry) { press = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); return; }
    const g = (e.target as Element).closest('[data-part]') as SVGElement | null;
    if (!g) { const w = evW(e); mq = { a: w, b: w, add: e.shiftKey, px: { x: e.clientX, y: e.clientY } }; svg.setPointerCapture(e.pointerId); return; } // empty place: draw a box to select
    if (busy()) { toast('Stop the nester (■) before moving parts by hand', 'warn'); return; }
    const id = g.dataset.part!;
    if (e.shiftKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); draw(); return; }
    pickUp(id, evW(e)); press = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (pan) { view.ox += e.clientX - pan.x; view.oy += e.clientY - pan.y; pan = { x: e.clientX, y: e.clientY }; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => drawSvg()); return; }
    if (mq) { mq.b = evW(e); drawAim(); return; }
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
    if (mq) {
      // a box drawn to the right takes the parts wholly inside it, a box drawn to the left every part it touches
      const q = mq; mq = null;
      const moved = Math.hypot(e.clientX - q.px.x, e.clientY - q.px.y) > 5, next = q.add ? new Set(sel) : new Set<string>();
      if (moved) {
        const x0 = Math.min(q.a.x, q.b.x), x1 = Math.max(q.a.x, q.b.x), y0 = Math.min(q.a.y, q.b.y), y1 = Math.max(q.a.y, q.b.y), touch = q.b.x < q.a.x;
        for (const p of parts) { const pl = where(p); if (!pl) continue; const b = polyBox(placedPoly(p, pl)); if (touch ? b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1 : b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1) next.add(p.id); }
      }
      sel = next; draw(); return;
    }
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
  svg.addEventListener('lostpointercapture', () => { if (mq) { mq = null; drawAim(); } });
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, w = W(mx, my);
    view.k = Math.max(0.01, Math.min(8, view.k * Math.exp(-e.deltaY * 0.0015))); view.ox = mx - w.x * view.k; view.oy = my - w.y * view.k; drawSvg();
  }, { passive: false });

  // ── keys (the pattern editor's shortcuts are held back while this room is open)
  const key = (e: KeyboardEvent) => {
    if (!root) return;
    if (dialogOpen() || document.querySelector('.ctx-menu')) return; // a dialog or an open menu handles its own keys
    if (dlg) { if (e.key === 'Escape') { dlg.close(); e.preventDefault(); } e.stopImmediatePropagation(); return; } // a window of this room: typing stays in it
    const typing = isTyping();
    if (e.key === 'Escape' && (aim || carry)) { if (aim) { aim = null; press = null; drawAim(); } else dropCarry(true); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === 'Escape') { if (typing) (document.activeElement as HTMLElement).blur(); else if (busy()) nestStop(); else if (sel.size) { sel.clear(); draw(); } else closeMarker(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (typing) { e.stopImmediatePropagation(); return; }
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { if (carry) dropCarry(true); if (!busy()) { if (e.shiftKey) app.doc.redo(); else app.doc.undo(); partsKey = ''; draw(); } }
    else if (mod && k === 'y') { if (!busy()) { app.doc.redo(); partsKey = ''; draw(); } }
    else if (mod && k === 'a') { sel = new Set(parts.filter(p => pls()[p.id]).map(p => p.id)); draw(); }
    else if (mod) return; // leave browser shortcuts (and Ctrl+S) alone
    else if (k === 'n') void nestStart();
    else if (k === '[' || k === ']') tiltBy(k === '[' ? -0.5 : 0.5);
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
    aborted = true; run?.stop(); clearInterval(runTimer); dlg?.close();
    window.removeEventListener('keydown', key, true); window.removeEventListener('resize', onResize);
    root.remove(); root = null; app.invalidate();
  }
  (root as HTMLElement & { closeMarker?: () => void }).closeMarker = closeMarker;
  draw(true); requestAnimationFrame(() => draw(true));
  if (!M().rows.length && !Object.keys(M().order).length) app.status('Marker making: type the order per size, press Auto plan, then ▶ to nest');
}
export function closeMarkerRoom() { (root as (HTMLElement & { closeMarker?: () => void }) | null)?.closeMarker?.(); }
