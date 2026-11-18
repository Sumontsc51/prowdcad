/**
 * Marker making workspace: a full-screen room over the pattern sheet.
 *   left   — cut plan builder: order per size, limits, Auto plan, and the editable list of markers (ratio, plies)
 *   strip  — marker tools: Nest ▶ / Stop, turn, unplace, push, clear, zoom, check, export, report
 *   centre — the marker: fabric of the set width; parts not laid yet wait in the tray above it
 * Everything is kept with the style (style.meta.marker); every change is one undo step (Ctrl+Z works here).
 */
import {
  autoCutPlan, planTotals, markerParts, markerStats, markerProblems, placedPoly, placedPoint, polyBox, placeAt, nestJob,
  markerDXF, markerHPGL, type MarkerDoc, type MarkerRow, type MarkerPart, type Placements, type Vec,
} from '@prowdcad/kernel';
import type { App } from '../app';
import { h, clear, isTyping } from '../ui/dom';
import { toast } from '../ui/toast';
import { confirmDialog, alertDialog, dialogOpen } from '../ui/dialog';
import { download } from '../actions/file';
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
  let drag: { ids: string[]; start: Vec; base: Placements; moved: boolean } | null = null;
  let pan: { x: number; y: number } | null = null;
  let run: NestRun | null = null, runRow = '', runTimer = 0, runBest = 0;
  let live: Placements | null = null;                // layout of the running nest, shown before it is kept
  const row = (): MarkerRow | undefined => M().rows.find(r => r.id === cur) ?? M().rows[0];
  const pls = (): Placements => (live && row()?.id === runRow ? live : row()?.placements ?? {});

  // ── elements
  const planBox = h('div.mk-plan'), tools = h('div.mk-tools'), stat = h('div.mk-status');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'mk-svg'); svg.setAttribute('tabindex', '0');
  const top = h('div.mk-top');
  root = h('div.mk-root', { role: 'dialog', 'aria-label': 'Marker making' }, top, h('div.mk-body', {}, planBox, tools, h('div.mk-stage', {}, svg as unknown as HTMLElement)), stat);
  document.body.append(root);

  // ── geometry helpers
  function refreshParts() {
    const r = row(), m = M();
    const key = r ? JSON.stringify([r.id, r.ratio, m.material]) : '-';
    if (key === partsKey) return;
    partsKey = key;
    parts = r ? markerParts(app.doc, r.ratio, { material: m.material || undefined }) : [];
    sel = new Set([...sel].filter(id => parts.some(p => p.id === id)));
  }
  /** parts not laid yet wait in rows above the fabric (negative y) */
  function layTray() {
    tray = {};
    const p0 = pls(), wait = parts.filter(p => !p0[p.id]);
    let x = 0, y = -60, rowH = 0; const maxX = Math.max(3000, M().width * 2.5);
    for (const p of wait) {
      const b = polyBox(p.poly), w = b.x1 - b.x0, hh = b.y1 - b.y0;
      if (x > 0 && x + w > maxX) { x = 0; y -= rowH + 40; rowH = 0; }
      tray[p.id] = { x, y: y - hh, rot: 0 }; x += w + 40; rowH = Math.max(rowH, hh);
    }
  }
  const where = (p: MarkerPart) => pls()[p.id] ?? tray[p.id];
  const S = (q: Vec) => ({ x: q.x * view.k + view.ox, y: q.y * view.k + view.oy });
  const W = (x: number, y: number): Vec => ({ x: (x - view.ox) / view.k, y: (y - view.oy) / view.k });
  const evW = (e: MouseEvent) => { const r = svg.getBoundingClientRect(); return W(e.clientX - r.left, e.clientY - r.top); };
  function fit() {
    const st = markerStats(parts, pls(), M().width);
    const r = svg.getBoundingClientRect(); if (r.width < 50) return;
    let minY = 0; for (const id in tray) minY = Math.min(minY, tray[id].y);
    const maxX = Math.max(st.length, 1500, ...Object.values(tray).map(t => t.x + 600));
    const k = Math.min((r.width - 150) / maxX, (r.height - 70) / (M().width - minY));
    view = { k, ox: 30, oy: 30 - minY * k };
  }

  // ── commits
  const keep = (label: string, next: Placements) => { const id = row()?.id; if (!id) return; edit(label, m => { const r = m.rows.find(x => x.id === id); if (r) r.placements = next; }); };
  function rotateSel() {
    const p0 = pls(), next = { ...p0 }; let n = 0;
    for (const p of parts) {
      if (!sel.has(p.id) || !p0[p.id] || p.angles.length < 2) continue;
      const q = p0[p.id], b = polyBox(placedPoly(p, q));
      const rot = p.angles[(p.angles.indexOf(q.rot) + 1) % p.angles.length];
      const t = placeAt(p, 0, 0, rot), nb = polyBox(placedPoly(p, t));
      next[p.id] = { x: t.x + (b.x0 + b.x1) / 2 - (nb.x0 + nb.x1) / 2, y: t.y + (b.y0 + b.y1) / 2 - (nb.y0 + nb.y1) / 2, rot }; n++;
    }
    if (n) keep('Turn part', next); else toast('Select a laid part that the fabric allows to turn (piece ▸ Order ▸ Rotation)', 'warn');
  }
  function unplaceSel() { const next = { ...pls() }; let n = 0; for (const id of sel) if (next[id]) { delete next[id]; n++; } if (n) keep('Take part off the marker', next); }
  function nudge(dx: number, dy: number) { const next = { ...pls() }; let n = 0; for (const id of sel) if (next[id]) { next[id] = { ...next[id], x: next[id].x + dx, y: next[id].y + dy }; n++; } if (n) keep('Move part', next); }
  /** push the selected parts along (dx, dy) until they touch something */
  function push(dx: number, dy: number) {
    const p0 = pls(); const ids = [...sel].filter(id => p0[id]); if (!ids.length) { toast('Select a laid part to push', 'warn'); return; }
    const w = M().width; const cur2 = { ...p0 };
    const ok = (pl: Placements) => { const b = markerProblems(parts, pl, w); return ids.every(id => !b.has(id)); };
    if (!ok(cur2)) { toast('The part overlaps: move it free first', 'warn'); return; }
    for (const step of [200, 50, 10, 2, 0.5]) for (let i = 0; i < 400; i++) {
      const t = { ...cur2 }; for (const id of ids) t[id] = { ...t[id], x: t[id].x + dx * step, y: t[id].y + dy * step };
      if (!ok(t)) break; Object.assign(cur2, t);
    }
    keep('Push part', cur2);
  }
  // ── nesting
  function nestStart() {
    const r = row(); if (run || !r) return;
    if (!parts.length) { toast('This marker has no parts: give it a ratio in the cut plan', 'warn'); return; }
    const w = M().width;
    const wide = parts.find(p => p.angles.every(a => { const b = polyBox(placedPoly(p, { x: 0, y: 0, rot: a })); return b.y1 - b.y0 > w; }));
    if (wide) { toast(`${wide.name} (${wide.sizeName}) is wider than the fabric`, 'error'); return; }
    const job = nestJob(parts, w, { gap: M().gap, name: r.name });
    runRow = r.id; live = null; runBest = 0;
    try {
      run = startNest(job, M().nestSeconds, {
        onBest: (pl, len) => { live = pl; runBest = len; draw(); },
        onDone: info => {
          clearInterval(runTimer); const got = live; run = null; live = null;
          if (info.error) toast('Nester stopped: ' + info.error, 'error');
          if (got) { const id = runRow; edit('Nest marker', m => { const x = m.rows.find(q => q.id === id); if (x) x.placements = got; }); toast(`Nested: ${fmt(runBest)} ${unitLabel()} long${info.stopped ? ' (stopped early)' : ''}`, 'ok'); }
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
  function report() {
    const m = M(), t = planTotals(sid(), m.order, m.rows);
    const lines = [`Cut plan — ${app.doc.style.name}`, `Fabric width ${fmt(m.width)} ${unitLabel()} · ${m.material || 'all materials'}`, ''];
    let fabric = 0;
    for (const r of m.rows) {
      const ps = markerParts(app.doc, r.ratio, { material: m.material || undefined }), st = markerStats(ps, r.placements, m.width);
      const done = st.placed === st.parts && st.parts > 0; if (done) fabric += st.length * r.plies;
      lines.push(`${r.name}: ${sizes().filter(s => r.ratio[s.id]).map(s => `${s.name} ${r.ratio[s.id]}`).join(' · ') || 'no ratio'} · ${r.plies} plies · ${done ? `${fmt(st.length)} ${unitLabel()} long, ${(st.efficiency * 100).toFixed(1)} %` : `${st.placed} of ${st.parts} parts laid`}`);
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
    const mat = h('select.mk-in', { title: 'Lay only the pieces of this material' }, h('option', { value: '' }, 'All materials'), ...mats.map(x => h('option', { value: x, selected: x === m.material }, x))) as HTMLSelectElement;
    mat.addEventListener('change', () => edit('Marker material', d => { d.material = mat.value; }));
    top.append(h('strong.mk-title', {}, 'Marker making'), h('span.mk-dim', {}, app.doc.style.name || ''),
      h('label', {}, 'Fabric width', num(fmt(m.width), 'Usable fabric width', t => { const v = parseLen(t); if (Number.isFinite(v) && v > 50) edit('Fabric width', d => { d.width = v; }); else draw(); }), h('span.mk-dim', {}, unitLabel())),
      h('label', {}, 'Gap', num(fmt(m.gap), 'Smallest gap between parts', t => { const v = parseLen(t); if (Number.isFinite(v) && v >= 0) edit('Marker gap', d => { d.gap = v; }); else draw(); }, 54), h('span.mk-dim', {}, unitLabel())),
      h('label', {}, 'Material', mat),
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
    const head = h('tr', {}, h('th', {}, ''), ...S2.map((s, k) => h('th', {}, h('span.mk-sw', { style: `background:${SIZE_COL[k % SIZE_COL.length]}` }), s.name)), h('th', {}, 'Plies'), h('th', {}, 'Total'), h('th', {}, ''));
    const ordT = h('table.mk-tbl', {}, head,
      h('tr.mk-order', {}, h('td', {}, 'Order'), ...S2.map(s => h('td', {}, int(m.order[s.id] ?? 0, `Garments ordered in ${s.name}`, n => edit('Order quantity', d => { d.order[s.id] = n; }), { 'data-mk-order': s.name }))), h('td', {}, ''), h('td.mk-tot', {}, String(t.ordered)), h('td', {}, '')));
    for (const r of m.rows) {
      const ps = markerParts(app.doc, r.ratio, { material: m.material || undefined }), st = markerStats(ps, r.placements, m.width);
      const bundles = S2.reduce((a, s) => a + (r.ratio[s.id] ?? 0), 0), done = st.parts > 0 && st.placed === st.parts;
      const tr = h('tr.mk-row' + (r.id === row()?.id ? '.on' : ''), { 'data-mk-row': r.id, title: 'Click to show this marker' },
        h('td.mk-name', {}, r.name, h('span.mk-sub', {}, done ? `${fmt(st.length)} ${unitLabel()} · ${(st.efficiency * 100).toFixed(1)} %` : st.parts ? `${st.placed}/${st.parts} laid` : 'no parts')),
        ...S2.map(s => h('td', {}, int(r.ratio[s.id] ?? 0, `Bundles of ${s.name} in ${r.name}`, n => edit('Marker ratio', d => { const x = d.rows.find(q => q.id === r.id); if (x && x.ratio[s.id] !== n) { x.ratio[s.id] = n; x.placements = {}; } })))),
        h('td', {}, int(r.plies, `Plies spread for ${r.name}`, n => edit('Plies', d => { const x = d.rows.find(q => q.id === r.id); if (x) x.plies = n; }))),
        h('td.mk-tot', {}, String(bundles * r.plies)),
        h('td', {}, h('button.mini', { title: `Remove ${r.name}`, onclick: (e: Event) => { e.stopPropagation(); edit('Remove marker', d => { d.rows = d.rows.filter(q => q.id !== r.id); }); } }, '✕')));
      tr.addEventListener('click', e => { if ((e.target as Element).closest('input,button')) return; cur = r.id; sel.clear(); partsKey = ''; draw(true); });
      ordT.append(tr);
    }
    ordT.append(h('tr.mk-cut', {}, h('td', {}, 'Cut'), ...S2.map(s => h('td.mk-tot', {}, String(t.cut[s.id]))), h('td.mk-tot', {}, String(t.plies)), h('td.mk-tot', {}, String(t.garments)), h('td', {}, '')),
      h('tr.mk-diff', {}, h('td', {}, 'Over / short'), ...S2.map(s => h('td.mk-tot' + (t.diff[s.id] > 0 ? '.over' : t.diff[s.id] < 0 ? '.short' : '.ok'), {}, t.diff[s.id] === 0 ? '✓' : (t.diff[s.id] > 0 ? '+' : '') + t.diff[s.id])), h('td', {}, ''), h('td.mk-tot' + (t.exact ? '.ok' : ''), {}, t.exact ? '✓' : String(t.garments - t.ordered)), h('td', {}, '')));
    const auto = async () => {
      if (!t.ordered) { toast('Type the order quantities first', 'warn'); return; }
      if (m.rows.some(r => Object.keys(r.placements).length) && !(await confirmDialog('Auto plan', 'Build the cut plan again from the order? The markers of the current plan, and their nesting, are replaced (Ctrl+Z brings them back).', 'Build plan'))) return;
      edit('Auto cut plan', d => { d.rows = autoCutPlan(sid(), d.order, { maxPlies: d.maxPlies, maxBundles: d.maxBundles }).map(r => ({ ...r, placements: {} })); });
      cur = M().rows[0]?.id ?? ''; partsKey = ''; draw(true);
      toast(`${M().rows.length} marker${M().rows.length === 1 ? '' : 's'} planned · press ▶ to nest`, 'ok');
    };
    planBox.append(h('div.mk-h', {}, 'Cut plan'),
      h('div.mk-lim', {},
        h('label', {}, 'Max plies', int(m.maxPlies, 'Most plies in one spread', n => edit('Max plies', d => { d.maxPlies = Math.max(1, n); }))),
        h('label', {}, 'Max bundles', int(m.maxBundles, 'Most garments in one marker', n => edit('Max bundles', d => { d.maxBundles = Math.max(1, n); }))),
        h('button.btn.sm.primary', { 'data-mk': 'auto', title: 'Work out the ratios and plies from the order', onclick: () => void auto() }, 'Auto plan')),
      h('div.mk-scroll', {}, ordT),
      h('div.mk-lim', {},
        h('button.btn.sm', { 'data-mk': 'add', title: 'Add an empty marker to the plan', onclick: () => { const id = 'm' + Date.now().toString(36); edit('Add marker', d => { d.rows.push({ id, name: 'Marker ' + (d.rows.length + 1), ratio: {}, plies: 1, placements: {} }); }); cur = id; partsKey = ''; draw(true); } }, '+ Marker'),
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
      b('turn', '⟳', 'Turn the selected part to its next allowed direction (R)', rotateSel),
      b('left', '⇤', 'Push the selected part towards the start of the fabric (←← Home)', () => push(-1, 0)),
      b('down', '⤓', 'Push the selected part towards the lower edge (End)', () => push(0, 1)),
      b('up', '⤒', 'Push the selected part towards the upper edge (PageUp)', () => push(0, -1)),
      b('off', '⤴', 'Take the selected part off the marker (Delete)', unplaceSel),
      b('clear', '⌫', 'Take every part off this marker', () => { if (Object.keys(pls()).length) keep('Clear marker', {}); }),
      h('div.mk-sep'),
      b('fit', '⤢', 'Show the whole marker (F)', () => { fit(); draw(); }),
      b('dxf', 'DXF', 'Save this marker as DXF', () => { const r = row(); if (r) download(base() + '.dxf', new Blob([markerDXF(parts, r.placements, M().width, r.name)], { type: 'application/dxf' })); }, '.txt'),
      b('plt', 'PLT', 'Save this marker as a plotter file (HPGL)', () => { const r = row(); if (r) download(base() + '.plt', new Blob([markerHPGL(parts, r.placements)], { type: 'application/vnd.hp-hpgl' })); }, '.txt'));
  }
  function drawStatus() {
    const r = row(), m = M();
    if (!r) { stat.textContent = 'No marker yet: type the order on the left and press Auto plan, or add a marker with + Marker.'; return; }
    const st = markerStats(parts, pls(), m.width);
    const el = run ? Math.min(run.seconds, (performance.now() - run.startedAt) / 1000) : 0;
    stat.textContent = [r.name, `${st.placed} of ${st.parts} parts laid`, `length ${fmt(st.length)} ${unitLabel()}`, `efficiency ${(st.efficiency * 100).toFixed(2)} %`,
      `${r.plies} plies = ${(st.length * r.plies / 1000).toFixed(2)} m of fabric`, bad.size ? `⚠ ${bad.size} part${bad.size > 1 ? 's' : ''} overlapping or off the fabric` : '',
      run ? `nesting… ${el.toFixed(0)} / ${run.seconds} s on ${run.threads} thread${run.threads > 1 ? 's' : ''}` : sel.size ? `${sel.size} selected · drag = move · R = turn · Del = take off` : 'drag a part onto the fabric · ▶ nests automatically'].filter(Boolean).join('  ·  ');
  }
  function drawSvg() {
    const m = M(), p0 = pls(), st = markerStats(parts, p0, m.width);
    bad = run ? new Set() : markerProblems(parts, p0, m.width);
    const f = (n: number) => n.toFixed(1);
    const len = Math.max(st.length, 1000), a = S({ x: 0, y: 0 }), b2 = S({ x: len, y: m.width });
    const sIdx = new Map(sizes().map((s, k) => [s.id, k]));
    let out = `<rect x="${f(a.x)}" y="${f(a.y)}" width="${f(b2.x - a.x + 4000 * view.k)}" height="${f(b2.y - a.y)}" class="mk-fabric"/>`;
    if (st.length > 0) { const e = S({ x: st.length, y: 0 }); out += `<line x1="${f(e.x)}" y1="${f(a.y - 8)}" x2="${f(e.x)}" y2="${f(b2.y + 8)}" class="mk-end"/><text x="${f(e.x + 5)}" y="${f(a.y - 12)}" class="mk-lab">${fmt(st.length)} ${unitLabel()} · ${(st.efficiency * 100).toFixed(1)} %</text>`; }
    for (const p of parts) {
      const q = where(p); if (!q) continue;
      const pts = placedPoly(p, q).map(S), col = SIZE_COL[(sIdx.get(p.sizeId) ?? 0) % SIZE_COL.length];
      const cls = 'mk-part' + (sel.has(p.id) ? ' sel' : '') + (bad.has(p.id) ? ' bad' : '') + (p0[p.id] ? '' : ' wait');
      const g0 = S(placedPoint(q, p.grain[0])), g1 = S(placedPoint(q, p.grain[1]));
      const bx = polyBox(pts), big = (bx.x1 - bx.x0) > 46 && (bx.y1 - bx.y0) > 16;
      out += `<g class="${cls}" data-part="${p.id}"><path d="${pts.map((v, i) => `${i ? 'L' : 'M'}${f(v.x)} ${f(v.y)}`).join('')}Z" style="--c:${col}"/>`
        + `<line x1="${f(g0.x)}" y1="${f(g0.y)}" x2="${f(g1.x)}" y2="${f(g1.y)}" class="mk-grain"/>`
        + (big ? `<text x="${f((bx.x0 + bx.x1) / 2)}" y="${f((bx.y0 + bx.y1) / 2 + 3)}" class="mk-pl">${p.name.slice(0, 14)} ${p.sizeName}${p.mirror ? '·M' : ''}</text>` : '') + '</g>';
    }
    if (Object.keys(tray).length) { const t = S({ x: 0, y: -30 }); out += `<text x="${f(t.x)}" y="${f(t.y)}" class="mk-lab">Waiting to be laid: ${Object.keys(tray).length}</text>`; }
    svg.innerHTML = out;
  }
  function draw(refit = false) {
    if (!root) return;
    refreshParts(); layTray();
    if (refit) fit();
    if (!root.contains(document.activeElement) || !isTyping()) { drawTop(); drawPlan(); }
    drawTools(); drawSvg(); drawStatus();
  }

  // ── pointer: select, drag, pan, zoom
  svg.addEventListener('pointerdown', e => {
    svg.focus();
    if (e.button === 1 || e.button === 2 || e.altKey) { pan = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); return; }
    const g = (e.target as Element).closest('[data-part]') as SVGElement | null;
    if (!g) { if (!e.shiftKey) sel.clear(); pan = { x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); draw(); return; }
    if (run) { toast('Stop the nester (■) before moving parts by hand', 'warn'); return; }
    const id = g.dataset.part!;
    if (e.shiftKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); } else if (!sel.has(id)) sel = new Set([id]);
    const baseP: Placements = {}; for (const p of parts) if (sel.has(p.id)) { const q = where(p); if (q) baseP[p.id] = { ...q }; }
    drag = { ids: Object.keys(baseP), start: evW(e), base: baseP, moved: false };
    svg.setPointerCapture(e.pointerId); draw();
  });
  svg.addEventListener('pointermove', e => {
    if (pan) { view.ox += e.clientX - pan.x; view.oy += e.clientY - pan.y; pan = { x: e.clientX, y: e.clientY }; drawSvg(); return; }
    if (!drag) return;
    const w = evW(e), dx = w.x - drag.start.x, dy = w.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) * view.k < 3) return;
    drag.moved = true;
    const r = row(); if (!r) return;
    // shown live without touching the document: the row's placements are swapped for the drag
    live = { ...r.placements }; runRow = r.id;
    for (const id of drag.ids) live[id] = { ...drag.base[id], x: drag.base[id].x + dx, y: drag.base[id].y + dy };
    drawSvg(); drawStatus();
  });
  const up = (e: PointerEvent) => {
    try { svg.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (pan) { pan = null; return; }
    const d = drag; drag = null; if (!d) return;
    const got = live; live = null;
    if (!d.moved || !got) { draw(); return; }
    const next: Placements = {};
    // a part dropped above the fabric goes back to waiting
    for (const p of parts) { const q = got[p.id]; if (!q) continue; const b = polyBox(placedPoly(p, q)); if (d.ids.includes(p.id) && b.y1 < 0) continue; next[p.id] = q; }
    keep('Move part', next);
  };
  svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  svg.addEventListener('contextmenu', e => e.preventDefault());
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, w = W(mx, my);
    view.k = Math.max(0.01, Math.min(8, view.k * Math.exp(-e.deltaY * 0.0015))); view.ox = mx - w.x * view.k; view.oy = my - w.y * view.k; drawSvg();
  }, { passive: false });

  // ── keys (the pattern editor's shortcuts are held back while this room is open)
  const key = (e: KeyboardEvent) => {
    if (!root) return;
    if (dialogOpen()) return;
    const typing = isTyping();
    if (e.key === 'Escape') { if (typing) (document.activeElement as HTMLElement).blur(); else if (run) nestStop(); else if (sel.size) { sel.clear(); draw(); } else closeMarker(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (typing) { e.stopImmediatePropagation(); return; }
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { if (!run) { if (e.shiftKey) app.doc.redo(); else app.doc.undo(); partsKey = ''; draw(); } }
    else if (mod && k === 'y') { if (!run) { app.doc.redo(); partsKey = ''; draw(); } }
    else if (mod && k === 'a') { sel = new Set(parts.filter(p => pls()[p.id]).map(p => p.id)); draw(); }
    else if (mod) return; // leave browser shortcuts (and Ctrl+S) alone
    else if (k === 'n') nestStart();
    else if (k === 'r') rotateSel();
    else if (k === 'f') { fit(); draw(); }
    else if (k === 'delete' || k === 'backspace') unplaceSel();
    else if (k === 'home') push(-1, 0); else if (k === 'end') push(0, 1); else if (k === 'pageup') push(0, -1);
    else if (k.startsWith('arrow')) { const s = e.shiftKey ? 10 : 1; nudge(k === 'arrowleft' ? -s : k === 'arrowright' ? s : 0, k === 'arrowup' ? -s : k === 'arrowdown' ? s : 0); }
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
