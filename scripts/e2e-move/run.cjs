#!/usr/bin/env node
// ProwdCAD v2: selection + Move tools end-to-end checks (Playwright, real UI events).
//   node scripts/e2e-move/run.cjs                       → starts Vite (apps/web) on :5289
//   E2E_MOVE_URL=http://localhost:5288/ node scripts/e2e-move/run.cjs   → use a running dev server
//   E2E_MOVE_ONLY=smooth node scripts/e2e-move/run.cjs  → only cases whose id matches
// Output: scripts/e2e-move/out/results.json (+ a screenshot per failing case). Exit 1 on failure.
//
// What is proven (docs/UX-RESEARCH.md §2, owner decisions):
//  select.*      the Select tool never changes the document on any click / drag / key
//  single.*      Move Point · Single changes exactly ONE anchor (full JSON of every other anchor,
//                base and on a graded size)
//  smooth.*      Move Smooth changes only the points strictly between the bounding grade points
//  line.*        Move Line changes only that segment's points, by the same delta
//  persist.*     the selection survives Copy grade, a seam command, undo / redo, size and tool switches
//  input.*       typed input-box values (fractions, inch mode, absolute) land exactly
//  cutpoint.*    Cut Point (X): hover readout, click, exact length from start / end, ratio, divide-N with
//                notches, graded size, internal line + curve point; one undo step each
//  dart.*        Dart (Shift+D) by clicks (leg A, leg B, apex), typed width·depth / width·angle, graded
//                sizes, apex drag with Move Point (Fix Dart), Multi darts with a live ghost
//  pleat.*       Pleat (Shift+L): count by interval, inverted + taper typed, between two lines
//  fullness.*    Slash & spread (Shift+U): interactive (Shift-rounded) and typed first → last, exact delete
//  lock.*        internal lines locked to the outline: auto-lock of ends drawn on the outline (I), the end keeps
//                its proportional position when the segment moves (base + graded size), a locked end refuses
//                Move Point, Unlock frees it; Inspector ▸ Lock = Parallel to segment: exact offset in every
//                size, follows Move Line of the segment, Inspector Unlock; one undo step each
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'out');
const PORT = 5289;
const ONLY = process.env.E2E_MOVE_ONLY ? new RegExp(process.env.E2E_MOVE_ONLY) : null;

function ping(url) { return new Promise(res => { http.get(url, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)); }); }
async function startVite() {
  if (process.env.E2E_MOVE_URL) return { url: process.env.E2E_MOVE_URL, stop() {} };
  const url = `http://localhost:${PORT}/`;
  if (await ping(url)) return { url, stop() {} };
  const p = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], { cwd: path.join(ROOT, 'apps/web'), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { if (await ping(url)) return { url, stop: () => p.kill() }; await new Promise(r => setTimeout(r, 200)); }
  p.kill(); throw new Error('vite did not start');
}

// ───────────── in-page helpers (test observation only) ─────────────
const PAGE_HELPERS = async () => {
  const K = await import('/@fs' + window.__ROOT + '/packages/kernel/src/index.ts');
  // app modules come from the app's own scripting hook (same module instances as the running app)
  const { app, canvas, ops, settings, runCommand, geometry: G } = window.prowdcad;
  const B = { ops }, S = { settings }, C = { runCommand };
  const T = { app, canvas, K, ops, G, settings, C };
  T.flush = () => app.flush();
  T.P = name => app.doc.style.pieces.find(p => p.name === name);
  T.A = (pname, aname) => { const p = T.P(pname); for (const c of [p.sew, ...p.internals]) { const a = c.points.find(q => q.name === aname); if (a) return { p, c, a }; } throw new Error('no anchor ' + aname); };
  T.ref = (pname, aname) => { const { p, c, a } = T.A(pname, aname); return { pieceId: p.id, contourId: c.id, anchorId: a.id }; };
  /** world position of an anchor in a size (default: the active size) */
  T.W = (pname, aname, sid) => { const { p, a } = T.A(pname, aname); const s = sid ?? app.sizeOf(p); return G.toWorld(p, B.ops.pointPos(app.doc, { pieceId: p.id, anchorId: a.id }, s)); };
  T.sid = n => app.sizeLine().sizes.find(s => s.name === n).id;
  T.toClient = w => { const r = canvas.svg.getBoundingClientRect(); const s = app.view.toScreen(w); return { x: r.left + s.x, y: r.top + s.y }; };
  /** world point at fraction t along the straight chord of two anchors (for clicking a segment) */
  T.along = (pname, a1, a2, t) => { const p = T.P(pname); const r = G.resolveFor(app.doc, p, app.sizeOf(p)); const { c, a } = T.A(pname, a1); const i = c.points.indexOf(a); const j = c.points.indexOf(T.A(pname, a2).a); const poly = K.arcPolyline(c === p.sew ? r.sew : r.internals[p.internals.indexOf(c)], i, j, false); let L = 0; for (let k = 1; k < poly.length; k++) L += Math.hypot(poly[k].x - poly[k - 1].x, poly[k].y - poly[k - 1].y); let acc = 0; for (let k = 1; k < poly.length; k++) { const d = Math.hypot(poly[k].x - poly[k - 1].x, poly[k].y - poly[k - 1].y); if (acc + d >= L * t) { const u = (L * t - acc) / d; return G.toWorld(p, { x: poly[k - 1].x + (poly[k].x - poly[k - 1].x) * u, y: poly[k - 1].y + (poly[k].y - poly[k - 1].y) * u }); } acc += d; } return G.toWorld(p, poly[poly.length - 1]); };
  /** every anchor of every piece: name → full JSON */
  T.anchors = () => { const out = {}; for (const p of app.doc.style.pieces) for (const c of [p.sew, ...p.internals]) for (const a of c.points) out[`${p.name}/${a.name ?? a.id}`] = JSON.stringify(a); return out; };
  T.selIds = () => ({ pieces: app.sel.pieces.slice().sort(), anchors: app.sel.anchors.map(a => a.anchorId).sort(), segments: app.sel.segments.map(g => g.from + '>' + g.to).sort(), internals: app.sel.internals.map(g => g.contourId).sort() });
  T.docJSON = () => app.doc.toJSON();
  T.prompt = () => document.querySelector('.sb-prompt')?.textContent ?? '';
  T.badge = () => document.querySelector('#toolopts .to-badge')?.textContent ?? '';
  T.ibox = () => !!document.querySelector('.ibox');

  // fixture: FRONT (grade + curve points, graded S / M / L / XL, an internal line, a point
  // connection, a notch, a drill) and BACK (rectangle). Pure data: the code under test is the UI.
  T.fixture = () => {
    const style = K.makeStyle('E2E MOVE', ['S', 'M', 'L', 'XL'], 'M');
    const g = (x, y, name) => K.gradePoint(x, y, { name });
    const cv = (x, y, name) => K.curvePoint(x, y, { name });
    const sew = K.makeContour([g(0, 0, 'A'), g(200, 0, 'B'), cv(225, 80, 'C'), cv(232, 160, 'D'), cv(222, 240, 'E'), g(200, 300, 'F'), cv(100, 322, 'G'), g(0, 300, 'H')]);
    sew.points[0].flags.startPoint = true;
    const front = K.makePiece('FRONT', sew, style.activeSizeTableId);
    front.internals.push(K.makeContour([g(60, 60, 'IA'), cv(70, 130, 'IM'), g(60, 200, 'IB')], { closed: false, type: 'internal' }));
    const back = K.makePiece('BACK', K.rectangleContour(400, 0, 200, 300), style.activeSizeTableId);
    back.sew.points.forEach((a, i) => { a.name = 'R' + i; });
    style.pieces.push(front, back);
    app.doc.load(style);
    const doc = app.doc;
    const steps = { S: -1, L: 1, XL: 2 };
    const GR = { B: [10, 0], F: [10, 8], H: [0, 8], IB: [4, 6] };
    for (const [n, [dx, dy]] of Object.entries(GR)) for (const [s, k] of Object.entries(steps)) B.ops.setGrade(doc, T.P('FRONT').id, T.A('FRONT', n).a.id, T.sid(s), { dx: dx * k, dy: dy * k }, { view: 'absolute' });
    // point connection: internal IA follows sew A (the documented exception)
    doc.transact('fixture connection', () => { const p = T.P('FRONT'); p.connections.push({ internalContourId: p.internals[0].id, internalAnchorId: T.A('FRONT', 'IA').a.id, externalAnchorId: T.A('FRONT', 'H').a.id }); });
    const f = T.P('FRONT');
    B.ops.addNotch(doc, f, { contourId: f.sew.id, placement: B.ops.placementAt(doc, f, f.sew.id, 100, 'proportional'), type: 'slit' });
    B.ops.addDrill(doc, f, { x: 120, y: 150, diameter: 4, kind: 'drill', mode: 'cut' });
    app.activeSize = app.baseSize();
    Object.assign(S.settings, { movePointMode: 'single', moveLineMode: 'translate', pieceToolMode: 'move', selFilter: 'all', selectDragMove: false, unit: 'mm', nudgeMm: 1, toolState: {} });
    app.clearSelection();
    app.setTool('select');
    const v = app.view; v.cx = 300; v.cy = 160; v.scale = Math.min(v.W / 760, v.H / 420);
    app.invalidate(); app.flush();
  };
  window.__mv = T;
};

class H {
  constructor(url) { this.url = url; this.errors = []; }
  async open() {
    this.browser = await chromium.launch();
    this.page = await (await this.browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    this.page.on('pageerror', e => this.errors.push(String(e.message || e)));
    this.page.on('dialog', d => { this.errors.push('native dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    await this.page.addInitScript(root => { try { localStorage.clear(); } catch { /* */ } window.__ROOT = root; }, ROOT);
    await this.page.goto(this.url);
    await this.page.waitForFunction(() => !!window.prowdcad && document.querySelectorAll('.menu-root').length > 5, null, { timeout: 20000 });
    await this.page.evaluate(PAGE_HELPERS);
    await this.page.waitForFunction(() => !!window.__mv);
  }
  ev(fn, arg) { return this.page.evaluate(fn, arg); }
  async settle(ms = 30) { await this.ev(() => window.__mv.flush()); if (ms) await this.page.waitForTimeout(ms); }
  async key(k) { await this.ev(() => { const a = document.activeElement; if (a && a !== document.body && !a.closest('.ibox')) a.blur?.(); }); await this.page.keyboard.press(k); await this.settle(40); }
  async type(t) { await this.page.keyboard.type(t, { delay: 15 }); await this.settle(20); }
  async c(w) { return this.ev(w => window.__mv.toClient(w), w); }
  async mods(m, fn) { for (const k of m) await this.page.keyboard.down(k); try { await fn(); } finally { for (const k of [...m].reverse()) await this.page.keyboard.up(k); } }
  async click(w, o = {}) { const c = await this.c(w); await this.mods(o.mods || [], async () => { await this.page.mouse.move(c.x, c.y); await this.page.mouse.click(c.x, c.y, { button: o.button || 'left' }); }); await this.settle(40); }
  async dbl(w) { const c = await this.c(w); await this.page.mouse.move(c.x, c.y); await this.page.mouse.click(c.x, c.y); await this.page.waitForTimeout(60); await this.page.mouse.click(c.x, c.y); await this.settle(40); }
  async drag(a, b, o = {}) {
    const ca = await this.c(a), cb = await this.c(b);
    await this.mods(o.mods || [], async () => {
      await this.page.mouse.move(ca.x, ca.y); await this.page.mouse.down();
      const n = o.steps ?? 8;
      for (let i = 1; i <= n; i++) await this.page.mouse.move(ca.x + (cb.x - ca.x) * i / n, ca.y + (cb.y - ca.y) * i / n);
      await this.page.mouse.up();
    });
    await this.settle(50);
  }
  W(p, a, s) { return this.ev(([p, a, s]) => window.__mv.W(p, a, s ? window.__mv.sid(s) : undefined), [p, a, s]); }
  along(p, a, b, t = 0.5) { return this.ev(([p, a, b, t]) => window.__mv.along(p, a, b, t), [p, a, b, t]); }
  anchors() { return this.ev(() => window.__mv.anchors()); }
  sel() { return this.ev(() => window.__mv.selIds()); }
  json() { return this.ev(() => window.__mv.docJSON()); }
  async fixture() { await this.ev(() => window.__mv.fixture()); await this.settle(60); }
  async hover(w, mods = []) { const c = await this.c(w); await this.mods(mods, async () => { await this.page.mouse.move(c.x - 3, c.y - 2); await this.page.mouse.move(c.x, c.y); }); await this.settle(30); }
  async waitIbox() { await this.page.waitForSelector('.ibox', { timeout: 3000 }); await this.page.waitForTimeout(40); }
  /** fill the input box: optional mode tab label, then { key: text }, then Enter */
  async ibox(mode, vals, enter = true) {
    await this.waitIbox();
    if (mode) { await this.page.locator('.ibox .ibox-mode', { hasText: mode }).first().click(); await this.page.waitForTimeout(30); }
    for (const [k, v] of Object.entries(vals)) await this.page.locator(`.ibox input[data-key="${k}"]`).fill(String(v));
    await this.page.waitForTimeout(30);
    if (enter) { await this.page.locator('.ibox input').first().press('Enter'); await this.settle(60); }
  }
  rev() { return this.ev(() => window.__mv.app.doc.revision()); }
  /** Ctrl+Z restores `j0` exactly, Ctrl+Y re-applies `j1` exactly */
  async undoRedo(id, j0, j1) {
    const st = j => j.replace(/"updatedAt":"[^"]*",?/g, '');
    await this.key('Control+z');
    const ju = st(await this.json()), a = st(j0);
    let k = 0; while (k < a.length && a[k] === ju[k]) k++;
    check(id + ' · one Ctrl+Z restores the document exactly', ju === a, `differs at ${k}: …${a.slice(Math.max(0, k - 80), k + 80)}… vs …${ju.slice(Math.max(0, k - 80), k + 80)}…`);
    await this.key('Control+y');
    check(id + ' · Ctrl+Y re-applies it exactly', st(await this.json()) === st(j1));
  }
}

const results = [];
function check(id, cond, detail) { results.push({ id, ok: !!cond, detail: cond ? undefined : detail }); if (!cond) console.log('  ✗', id, detail ?? ''); }
const changedKeys = (a, b) => Object.keys({ ...a, ...b }).filter(k => a[k] !== b[k]);
const near = (x, y, eps = 1e-6) => Math.abs(x - y) <= eps;

const CASES = [];
const test = (id, fn) => CASES.push({ id, fn });

// ───────────────────────── Select never edits ─────────────────────────
test('select.neverEdits', async h => {
  await h.fixture();
  await h.key('v');
  const j0 = await h.json();
  const rev0 = await h.ev(() => window.__mv.app.doc.revision());
  const B = await h.W('FRONT', 'B'), D = await h.W('FRONT', 'D'), F = await h.W('FRONT', 'F');
  const mid = await h.along('FRONT', 'F', 'H', 0.3);
  const inside = { x: 110, y: 120 }, empty = { x: 330, y: 380 };
  const steps = [
    ['click grade point', () => h.click(B)],
    ['click segment', () => h.click(mid)],
    ['click piece interior', () => h.click(inside)],
    ['shift-click point', () => h.click(F, { mods: ['Shift'] })],
    ['ctrl-click point', () => h.click(F, { mods: ['Control'] })],
    ['alt-click point', () => h.click(B, { mods: ['Alt'] })],
    ['double-click point', () => h.dbl(B)],
    ['double-click piece', () => h.dbl(inside)],
    ['drag from a point', () => h.drag(B, { x: B.x + 40, y: B.y + 30 })],
    ['drag from a curve point', () => h.drag(D, { x: D.x + 25, y: D.y - 20 })],
    ['drag from a piece interior', () => h.drag(inside, { x: inside.x + 60, y: inside.y + 50 })],
    ['drag from a segment', () => h.drag(mid, { x: mid.x - 30, y: mid.y + 30 })],
    ['drag BACK piece', () => h.drag({ x: 500, y: 150 }, { x: 560, y: 200 })],
    ['window box', () => h.drag({ x: -20, y: -20 }, { x: 250, y: 120 })],
    ['crossing box', () => h.drag({ x: 250, y: 120 }, { x: 150, y: 60 })],
    ['click empty', () => h.click(empty)],
    ['arrow keys', async () => { await h.click(B); await h.key('ArrowLeft'); await h.key('Shift+ArrowUp'); }],
    ['digits / Tab', async () => { await h.click(B); await h.key('3'); await h.key('0'); await h.key('Tab'); }],
    ['shift-drag point', () => h.drag(B, { x: B.x + 30, y: B.y }, { mods: ['Shift'] })],
  ];
  for (const [name, fn] of steps) {
    await fn();
    const j = await h.json();
    check(`select.neverEdits · ${name}`, j === j0, 'document changed');
  }
  const rev = await h.ev(() => window.__mv.app.doc.revision());
  check('select.neverEdits · revision unchanged', rev === rev0, `${rev0} → ${rev}`);
  // and it does select things
  await h.click(B);
  check('select.click selects the point', (await h.sel()).anchors.length === 1);
  await h.click(mid);
  check('select.click selects the segment', (await h.sel()).segments.length === 1, JSON.stringify(await h.sel()));
  await h.drag({ x: -20, y: -20 }, { x: 250, y: 120 });
  const s = await h.sel();
  check('select.window box selects points', s.anchors.length >= 4, JSON.stringify(s));
  await h.click(empty);
  check('select.click empty clears', (await h.sel()).anchors.length === 0 && (await h.sel()).pieces.length === 0);
  check('select.prompt shown', (await h.ev(() => window.__mv.prompt())).startsWith('Select'));
});

// ───────────────────────── Move Point · Single ─────────────────────────
test('single.base', async h => {
  await h.fixture();
  await h.key('v');
  // select 5 points with a box, then Move Point (G) and drag ONE of them
  await h.drag({ x: 190, y: -20 }, { x: 260, y: 310 });
  const sel0 = await h.sel();
  check('single.base · 5 points boxed', sel0.anchors.length === 5, JSON.stringify(sel0));
  await h.key('g');
  check('single.base · tool = Move Point', await h.ev(() => window.__mv.app.tool.id === 'movePoint'));
  check('single.base · prompt', (await h.ev(() => window.__mv.prompt())).startsWith('Move Point · Single'));
  const before = await h.anchors();
  const D = await h.W('FRONT', 'D');
  await h.drag(D, { x: D.x + 20, y: D.y + 12 }, { mods: ['Alt'] }); // Alt = no snap
  const after = await h.anchors();
  const ch = changedKeys(before, after);
  check('single.base · exactly one anchor changed', ch.length === 1 && ch[0] === 'FRONT/D', ch.join(','));
  const a0 = JSON.parse(before['FRONT/D']), a1 = JSON.parse(after['FRONT/D']);
  check('single.base · only x / y of that anchor changed', JSON.stringify({ ...a1, x: 0, y: 0 }) === JSON.stringify({ ...a0, x: 0, y: 0 }) && (a1.x !== a0.x || a1.y !== a0.y), JSON.stringify([a0, a1]));
  check('single.base · selection kept (5 points)', (await h.sel()).anchors.length === 5);
  await h.key('Control+z');
  check('single.base · undo restores', JSON.stringify(await h.anchors()) === JSON.stringify(before));
  check('single.base · selection kept after undo', (await h.sel()).anchors.length === 5);
  // click-click (AccuMark): click picks up, next click places
  const B = await h.W('FRONT', 'B');
  await h.click(B);
  await h.click({ x: B.x + 15, y: B.y - 7 }, { mods: ['Alt'] });
  const ch2 = changedKeys(before, await h.anchors());
  check('single.base · click-click moves only B', ch2.length === 1 && ch2[0] === 'FRONT/B', ch2.join(','));
  // point connection: the documented exception (IA follows H)
  await h.key('Control+z');
  const Hh = await h.W('FRONT', 'H');
  await h.click(Hh);
  check('single.base · connection shown in prompt', (await h.ev(() => window.__mv.prompt())).includes('point connection'));
  await h.key('Escape');
  await h.drag(Hh, { x: Hh.x + 10, y: Hh.y + 10 }, { mods: ['Alt'] });
  const ch3 = changedKeys(before, await h.anchors()).sort();
  check('single.base · connected internal point follows H (only exception)', JSON.stringify(ch3) === JSON.stringify(['FRONT/H', 'FRONT/IA']), ch3.join(','));
  await h.key('Control+z');
});

test('single.graded', async h => {
  await h.fixture();
  await h.key('v');
  await h.key('Control+]'); // → L
  check('single.graded · active L', await h.ev(() => window.__mv.app.sizeLine().sizes.find(s => s.id === window.__mv.app.activeSize).name === 'L'));
  await h.key('g');
  const B = await h.W('FRONT', 'B');
  await h.click(B); await h.key('Escape'); // pick B, drop carry
  check('single.graded · amber badge', (await h.ev(() => window.__mv.badge())).includes('Editing size L grading'));
  const before = await h.anchors();
  const pos = {}; for (const s of ['S', 'M', 'L', 'XL']) pos[s] = await h.W('FRONT', 'B', s);
  await h.drag(B, { x: B.x + 12, y: B.y + 9 }, { mods: ['Alt'] });
  const after = await h.anchors();
  const ch = changedKeys(before, after);
  check('single.graded · exactly one anchor changed', ch.length === 1 && ch[0] === 'FRONT/B', ch.join(','));
  const a0 = JSON.parse(before['FRONT/B']), a1 = JSON.parse(after['FRONT/B']);
  check('single.graded · base x / y unchanged (grading only)', a0.x === a1.x && a0.y === a1.y);
  for (const s of ['S', 'M', 'XL']) { const p = await h.W('FRONT', 'B', s); check(`single.graded · size ${s} position unchanged`, near(p.x, pos[s].x) && near(p.y, pos[s].y), JSON.stringify([pos[s], p])); }
  const pL = await h.W('FRONT', 'B', 'L');
  check('single.graded · size L moved by the drag', near(pL.x - pos.L.x, 12, 0.05) && near(pL.y - pos.L.y, 9, 0.05), JSON.stringify([pos.L, pL]));
});

// ───────────────────────── Smooth ─────────────────────────
test('smooth.base', async h => {
  await h.fixture();
  await h.key('g');
  await h.ev(() => window.__mv.app.tool.setMode(window.__mv.app, 'smooth'));
  const D = await h.W('FRONT', 'D');
  await h.click(D); await h.key('Escape');
  check('smooth.base · prompt mentions tacks', (await h.ev(() => window.__mv.prompt())).includes('tack'));
  const before = await h.anchors();
  await h.drag(D, { x: D.x + 25, y: D.y + 5 }, { mods: ['Alt'] });
  const ch = changedKeys(before, await h.anchors()).sort();
  check('smooth.base · only C, D, E (between grade points B and F) changed', JSON.stringify(ch) === JSON.stringify(['FRONT/C', 'FRONT/D', 'FRONT/E']), ch.join(','));
  await h.key('Control+z');
  // graded size: only the edited size moves, outside points untouched
  await h.key('Control+]');
  await h.click(await h.W('FRONT', 'D')); await h.key('Escape');
  const pos = {}; for (const n of ['C', 'D', 'E']) for (const s of ['S', 'M', 'XL']) pos[n + s] = await h.W('FRONT', n, s);
  const before2 = await h.anchors();
  const D2 = await h.W('FRONT', 'D');
  await h.drag(D2, { x: D2.x + 20, y: D2.y }, { mods: ['Alt'] });
  const ch2 = changedKeys(before2, await h.anchors()).sort();
  check('smooth.graded · only points between the tacks changed', ch2.every(k => ['FRONT/C', 'FRONT/D', 'FRONT/E'].includes(k)) && ch2.includes('FRONT/D'), ch2.join(',') + ' | ' + (await h.ev(() => window.__mv.prompt())));
  let same = true; for (const n of ['C', 'D', 'E']) for (const s of ['S', 'M', 'XL']) { const p = await h.W('FRONT', n, s); if (!near(p.x, pos[n + s].x, 1e-6) || !near(p.y, pos[n + s].y, 1e-6)) same = false; }
  check('smooth.graded · other sizes unchanged', same);
});

// ───────────────────────── Move Line ─────────────────────────
test('line.base', async h => {
  await h.fixture();
  await h.key('Shift+g');
  check('line.base · tool = Move Line', await h.ev(() => window.__mv.app.tool.id === 'moveLine'));
  const m = await h.along('FRONT', 'B', 'F', 0.5);
  const before = await h.anchors();
  await h.drag(m, { x: m.x + 18, y: m.y + 6 });
  const after = await h.anchors();
  const ch = changedKeys(before, after).sort();
  check('line.base · only B..F changed', JSON.stringify(ch) === JSON.stringify(['FRONT/B', 'FRONT/C', 'FRONT/D', 'FRONT/E', 'FRONT/F']), ch.join(','));
  const d = n => { const a = JSON.parse(before['FRONT/' + n]), b = JSON.parse(after['FRONT/' + n]); return [b.x - a.x, b.y - a.y]; };
  const d0 = d('B');
  check('line.base · same delta for every point', ['C', 'D', 'E', 'F'].every(n => near(d(n)[0], d0[0], 1e-9) && near(d(n)[1], d0[1], 1e-9)), JSON.stringify(['B', 'C', 'D', 'E', 'F'].map(d)));
  check('line.base · segment stays selected', (await h.sel()).segments.length === 1);
  // internal line: whole line moves
  await h.key('Control+z');
  const im = await h.along('FRONT', 'IA', 'IB', 0.25);
  const b2 = await h.anchors();
  await h.drag(im, { x: im.x + 10, y: im.y });
  const ch2 = changedKeys(b2, await h.anchors()).sort();
  check('line.internal · only the internal line moved', JSON.stringify(ch2) === JSON.stringify(['FRONT/IA', 'FRONT/IB', 'FRONT/IM']), ch2.join(','));
});

// ───────────────────────── persistence ─────────────────────────
test('persist', async h => {
  await h.fixture();
  await h.key('v');
  await h.click(await h.W('FRONT', 'B'));
  await h.click(await h.W('FRONT', 'F'), { mods: ['Shift'] });
  const s0 = JSON.stringify(await h.sel());
  check('persist · 2 points selected', JSON.parse(s0).anchors.length === 2);
  await h.key('Control+Alt+c'); // Copy grade
  check('persist · after Copy grade', JSON.stringify(await h.sel()) === s0);
  // seam command on the selected run (B → F): Seam of segment / run…
  await h.key('Alt+s');
  await h.page.waitForSelector('.dlg', { timeout: 3000 }).catch(() => {});
  if (await h.ev(() => !!document.querySelector('.dlg'))) { await h.page.keyboard.press('Enter'); await h.settle(60); }
  check('persist · after a seam command', JSON.stringify(await h.sel()) === s0, JSON.stringify(await h.sel()));
  await h.key('Control+z');
  check('persist · after undo', JSON.stringify(await h.sel()) === s0);
  await h.key('Control+y');
  check('persist · after redo', JSON.stringify(await h.sel()) === s0);
  await h.key('Control+]');
  check('persist · after size switch', JSON.stringify(await h.sel()) === s0);
  await h.key('g'); await h.key('Shift+g'); await h.key('m'); await h.key('v');
  check('persist · after tool switches', JSON.stringify(await h.sel()) === s0);
  // segment selection too
  await h.click(await h.along('FRONT', 'F', 'H', 0.4));
  const s1 = JSON.stringify(await h.sel());
  await h.key('Shift+g'); await h.key('v'); await h.key('Control+[');
  check('persist · segment after tool + size switch', JSON.stringify(await h.sel()) === s1, JSON.stringify(await h.sel()));
  await h.key('Escape');
  check('persist · Esc clears', (await h.sel()).segments.length === 0);
});

// ───────────────────────── typed input ─────────────────────────
test('input.fractions', async h => {
  await h.fixture();
  await h.ev(() => window.__mv.app.setUnit('in', 16));
  await h.key('g');
  const before = await h.anchors();
  await h.click(await h.W('FRONT', 'B')); await h.key('Escape'); // pick B
  await h.page.keyboard.press('1'); await h.settle(60);
  check('input · digit opens the input box', await h.ev(() => window.__mv.ibox()));
  await h.type(' 1/8');
  await h.page.keyboard.press('Tab');
  await h.type('-2');
  await h.page.keyboard.press('Enter'); await h.settle(60);
  const a0 = JSON.parse(before['FRONT/B']), a1 = JSON.parse((await h.anchors())['FRONT/B']);
  check('input · dX = 1 1/8" lands exactly (28.575 mm)', near(a1.x - a0.x, 28.575, 1e-9), a1.x - a0.x);
  check('input · dY = -2" lands exactly (-50.8 mm)', near(a1.y - a0.y, -50.8, 1e-9), a1.y - a0.y);
  check('input · one anchor changed', changedKeys(before, await h.anchors()).length === 1, changedKeys(before, await h.anchors()).join(','));
  // right-click opens the box; absolute mode; Enter = OK
  const B = await h.W('FRONT', 'B');
  await h.click(B, { button: 'right' });
  check('input · right-click opens the input box', await h.ev(() => window.__mv.ibox()));
  await h.ev(() => [...document.querySelectorAll('.ibox-mode')].find(b => b.textContent.startsWith('Absolute')).click());
  await h.settle(30);
  await h.ev(() => { const i = document.querySelector('.ibox input[data-key=x]'); i.focus(); i.select(); });
  await h.type('3 1/4');
  await h.page.keyboard.press('Tab'); await h.type('1/2');
  await h.click(B, { button: 'right' }); // right-click = OK
  const a2 = JSON.parse((await h.anchors())['FRONT/B']);
  check('input · absolute X = 3 1/4" (82.55 mm)', near(a2.x, 82.55, 1e-9), a2.x);
  check('input · absolute Y = 1/2" (12.7 mm)', near(a2.y, 12.7, 1e-9), a2.y);
  check('input · box closed after OK', !(await h.ev(() => window.__mv.ibox())));
  // mm: "12,5" in dX fills dX and dY
  await h.ev(() => window.__mv.app.setUnit('mm'));
  const b3 = JSON.parse((await h.anchors())['FRONT/B']);
  await h.page.keyboard.press('1'); await h.settle(40); await h.type('2,5'); await h.page.keyboard.press('Enter'); await h.settle(60);
  const a3 = JSON.parse((await h.anchors())['FRONT/B']);
  check('input · "12,5" = dX 12, dY 5', near(a3.x - b3.x, 12, 1e-9) && near(a3.y - b3.y, 5, 1e-9), [a3.x - b3.x, a3.y - b3.y]);
  // Enter repeats the last move
  await h.key('Enter');
  const a4 = JSON.parse((await h.anchors())['FRONT/B']);
  check('input · Enter repeats the last delta', near(a4.x - a3.x, 12, 1e-9) && near(a4.y - a3.y, 5, 1e-9), [a4.x - a3.x, a4.y - a3.y]);
});

// ───────────────────────── nudge + piece tool ─────────────────────────
test('nudge.and.piece', async h => {
  await h.fixture();
  await h.key('v');
  await h.click(await h.W('FRONT', 'B'));
  const j0 = await h.json();
  await h.key('ArrowRight');
  check('nudge · arrows in Select do nothing', (await h.json()) === j0);
  await h.key('g');
  const before = await h.anchors();
  await h.key('ArrowRight'); await h.key('Shift+ArrowUp');
  const a0 = JSON.parse(before['FRONT/B']), a1 = JSON.parse((await h.anchors())['FRONT/B']);
  check('nudge · Move Point arrows move only B (1, 10)', changedKeys(before, await h.anchors()).length === 1 && near(a1.x - a0.x, 1) && near(a1.y - a0.y, 10), [a1.x - a0.x, a1.y - a0.y, changedKeys(before, await h.anchors())]);
  // piece flip: placement only, geometry untouched
  await h.key('v');
  await h.click({ x: 500, y: 150 });
  const sew0 = await h.ev(() => JSON.stringify(window.__mv.P('BACK').sew));
  await h.ev(() => window.__mv.C.runCommand('piece.flipH'));
  await h.settle(40);
  check('piece · flip H sets layout.flipX', await h.ev(() => window.__mv.P('BACK').layout?.flipX === true));
  check('piece · flip keeps the authored geometry', (await h.ev(() => JSON.stringify(window.__mv.P('BACK').sew))) === sew0);
  // piece move tool: drag moves the layout, one undo step
  await h.key('Control+Shift+g');
  const L0 = await h.ev(() => ({ ...window.__mv.P('BACK').layout }));
  await h.drag({ x: 500, y: 150 }, { x: 540, y: 170 });
  const L1 = await h.ev(() => ({ ...window.__mv.P('BACK').layout }));
  check('piece · drag moves the piece', near(L1.x - L0.x, 40, 0.5) && near(L1.y - L0.y, 20, 0.5), JSON.stringify([L0, L1]));
  await h.key('Control+z');
  const L2 = await h.ev(() => ({ ...window.__mv.P('BACK').layout }));
  check('piece · one undo step', near(L2.x, L0.x) && near(L2.y, L0.y));
});

// ───────────────────────── other modes / tools ─────────────────────────
test('modes', async h => {
  await h.fixture();
  await h.key('g');
  // Esc while idle → back to Select, selection kept
  await h.click(await h.W('FRONT', 'B')); await h.key('Escape');
  await h.key('Escape');
  check('modes · Esc idle → Select', await h.ev(() => window.__mv.app.tool.id === 'select'));
  check('modes · selection kept on leaving the tool', (await h.sel()).anchors.length === 1);
  // Group: every selected point by the same delta, nothing else
  await h.click(await h.W('FRONT', 'F'), { mods: ['Shift'] });
  await h.key('g');
  await h.ev(() => window.__mv.app.tool.setMode(window.__mv.app, 'group')); await h.settle();
  check('modes · prompt says Group', (await h.ev(() => window.__mv.prompt())).includes('Group: 2'), await h.ev(() => window.__mv.prompt()));
  const b0 = await h.anchors();
  const B = await h.W('FRONT', 'B');
  await h.drag(B, { x: B.x + 10, y: B.y + 4 }, { mods: ['Alt'] });
  const ch = changedKeys(b0, await h.anchors()).sort();
  check('group · only the 2 selected points moved', JSON.stringify(ch) === JSON.stringify(['FRONT/B', 'FRONT/F']), ch.join(','));
  // Along line (slide): only the slid point changes its stored position (contour shape kept)
  await h.key('Control+z');
  await h.ev(() => window.__mv.app.tool.setMode(window.__mv.app, 'along'));
  const b1 = await h.anchors();
  const G = await h.W('FRONT', 'G');
  await h.click(G); await h.key('Escape');
  await h.page.keyboard.press('2'); await h.settle(40); await h.type('0'); await h.page.keyboard.press('Enter'); await h.settle(60);
  const a1 = await h.anchors();
  const ch1 = changedKeys(b1, a1);
  // sliding re-inserts G on the existing curve: neighbours keep x / y / grading; only their Bézier
  // handles may be re-fitted so the curve shape stays the same (documented in the README)
  const posOnly = j => { const a = JSON.parse(j); return JSON.stringify([a.x, a.y, a.grade, a.kind]); };
  const moved = Object.keys(b1).filter(k => posOnly(b1[k]) !== posOnly(a1[k]));
  check('along · only G changed position / grading', moved.length === 1 && moved[0] === 'FRONT/G', moved.join(',') + ' | json: ' + ch1.join(','));
  // Horizontal: dY locked
  await h.ev(() => window.__mv.app.tool.setMode(window.__mv.app, 'h'));
  const b2 = await h.anchors();
  const Bh = await h.W('FRONT', 'B');
  await h.click(Bh); await h.key('Escape');
  await h.drag(Bh, { x: Bh.x + 15, y: Bh.y + 20 }, { mods: ['Alt'] });
  const x0 = JSON.parse(b2['FRONT/B']), x1 = JSON.parse((await h.anchors())['FRONT/B']);
  check('horizontal · only X changed, only B', changedKeys(b2, await h.anchors()).length === 1 && x1.y === x0.y && Math.abs(x1.x - x0.x - 15) < 0.5, JSON.stringify([x0.x, x1.x, x0.y, x1.y]));
  // Curve tool: Shift+click = smooth; dragging a handle edits only that anchor
  await h.key('Shift+c');
  check('curve · tool active', await h.ev(() => window.__mv.app.tool.id === 'curve'));
  const b3 = await h.anchors();
  const F = await h.W('FRONT', 'F');
  await h.click(F, { mods: ['Shift'] });
  const ch3 = changedKeys(b3, await h.anchors());
  check('curve · Shift+click changes only that point', ch3.length === 1 && ch3[0] === 'FRONT/F', ch3.join(','));
  const hp = await h.ev(() => { const h0 = document.querySelector('[data-hit=handle][data-which=out]'); if (!h0) return null; const r = h0.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  check('curve · handles shown', !!hp);
  if (hp) {
    const b4 = await h.anchors();
    await h.page.mouse.move(hp.x, hp.y); await h.page.mouse.down(); await h.page.mouse.move(hp.x + 20, hp.y + 10, { steps: 5 }); await h.page.mouse.up(); await h.settle(50);
    const ch4 = changedKeys(b4, await h.anchors());
    check('curve · handle drag changes only that point', ch4.length === 1 && ch4[0] === 'FRONT/F', ch4.join(','));
  }
  // every step has a non-empty prompt
  for (const t of ['select', 'movePoint', 'moveLine', 'movePiece', 'curve']) {
    await h.ev(t => window.__mv.app.setTool(t), t); await h.settle(20);
    check(`prompt · ${t}`, (await h.ev(() => window.__mv.prompt())).length > 10);
  }
});

// ───────────────────────── fix pass (docs/E2E-REPORT.md "Fix pass") ─────────────────────────
test('fixpass', async h => {
  await h.fixture();
  // B4: Rotate Piece adopts the selected piece; typing opens the angle box
  await h.key('v');
  await h.click({ x: 500, y: 150 });
  await h.ev(() => window.__mv.C.runCommand('move.pieceRotate')); await h.settle();
  check('fixpass · Rotate Piece prompt names the selected piece', (await h.ev(() => window.__mv.prompt())).includes('BACK'), await h.ev(() => window.__mv.prompt()));
  await h.page.keyboard.press('9'); await h.settle(40);
  check('fixpass · typing with the piece selected opens the input box', await h.ev(() => window.__mv.ibox()));
  await h.type('0'); await h.page.keyboard.press('Enter'); await h.settle(60);
  check('fixpass · BACK rotated 90°', await h.ev(() => Math.abs((window.__mv.P('BACK').layout?.angleDeg ?? 0) - 90) < 1e-9), await h.ev(() => JSON.stringify(window.__mv.P('BACK').layout)));
  await h.key('Control+z');
  // B9: click B (pick up), press again on B and drag: one undo step, B moved; never a 0-delta step
  await h.ev(() => { window.__mv.settings.pieceToolMode = 'move'; window.__mv.app.setTool('movePoint'); }); await h.settle();
  const before = await h.anchors(); const rev0 = await h.ev(() => window.__mv.app.doc.revision());
  const B = await h.W('FRONT', 'B');
  await h.click(B);
  await h.drag(B, { x: B.x + 14, y: B.y + 6 }, { mods: ['Alt'] });
  const ch = changedKeys(before, await h.anchors());
  check('fixpass · click then press-drag moves only B', ch.length === 1 && ch[0] === 'FRONT/B', ch.join(','));
  check('fixpass · … in one undo step', (await h.ev(() => window.__mv.app.doc.revision())) - rev0 === 1);
  // Space tap: Move Point → Select → Move Point, selection kept
  await h.page.keyboard.press('Space'); await h.settle(30);
  check('fixpass · Space tap → Select', await h.ev(() => window.__mv.app.tool.id === 'select'));
  check('fixpass · selection kept', (await h.sel()).anchors.length === 1);
  await h.page.keyboard.press('Space'); await h.settle(30);
  check('fixpass · Space tap again → Move Point', await h.ev(() => window.__mv.app.tool.id === 'movePoint'));
  // curve points that follow: pin C, then moving B (its neighbour) leaves C in every size
  await h.ev(() => { const T = window.__mv; T.ops.pinCurvePoints(T.app.doc, T.P('FRONT').id, [T.A('FRONT', 'C').a.id], true); });
  const posC = {}; for (const s of ['S', 'M', 'L', 'XL']) posC[s] = await h.W('FRONT', 'C', s);
  const B2 = await h.W('FRONT', 'B');
  await h.drag(B2, { x: B2.x - 10, y: B2.y + 8 }, { mods: ['Alt'] });
  let same = true; for (const s of ['S', 'M', 'L', 'XL']) { const p = await h.W('FRONT', 'C', s); if (!near(p.x, posC[s].x, 1e-9) || !near(p.y, posC[s].y, 1e-9)) same = false; }
  check('fixpass · pinned curve point C keeps every size when B moves', same);
});


// ───────────────────────── Cut Point (X) ─────────────────────────
const sewPts = (h, pn) => h.ev(pn => window.__mv.P(pn).sew.points.map(a => ({ id: a.id, x: a.x, y: a.y, kind: a.kind })), pn);
const newPts = (before, after) => after.filter(a => !before.some(b => b.id === a.id));
test('cutpoint.hoverClick', async h => {
  await h.fixture();
  await h.key('x');
  check('cutpoint · X selects the Cut Point tool', await h.ev(() => window.__mv.app.tool.id === 'cutPoint'));
  const w = await h.along('FRONT', 'A', 'B', 0.3);
  await h.hover(w, ['Shift']);
  const pr = await h.ev(() => window.__mv.prompt());
  check('cutpoint · hover readout: start 60 · end 140 (Shift = round)', /start 60 mm · end 140 mm · 30\.0%/.test(pr), pr);
  check('cutpoint · hover draws the split preview', await h.ev(() => document.querySelectorAll('#canvas svg text.live-note').length >= 3));
  const j0 = await h.json(), p0 = await sewPts(h, 'FRONT'), rev0 = await h.rev(), an0 = await h.anchors();
  await h.click(w, { mods: ['Shift'] });
  const p1 = await sewPts(h, 'FRONT'), np = newPts(p0, p1);
  check('cutpoint · click inserts one grade point at 60', np.length === 1 && near(np[0].x, 60, 1e-9) && near(np[0].y, 0, 1e-9) && np[0].kind === 'grade', JSON.stringify(np));
  check('cutpoint · every other anchor unchanged', changedKeys(an0, await h.anchors()).every(k => !an0[k]), changedKeys(an0, await h.anchors()).join(','));
  check('cutpoint · one undo step', (await h.rev()) - rev0 === 1);
  check('cutpoint · the new point is selected', (await h.sel()).anchors.length === 1);
  await h.undoRedo('cutpoint.hoverClick', j0, await h.json());
});
test('cutpoint.exact', async h => {
  await h.fixture();
  await h.key('x');
  const w = await h.along('FRONT', 'A', 'B', 0.5);
  await h.hover(w);
  await h.page.keyboard.press('5'); // a digit opens the input box (From start)
  await h.ibox(null, { d: '50' });
  let np = newPts([{ id: 'x' }], (await sewPts(h, 'FRONT')).filter(a => a.y === 0 && a.x > 0 && a.x < 200));
  check('cutpoint · typed 50 from start → x = 50 exactly', np.length === 1 && np[0].x === 50, JSON.stringify(np));
  // from the end, on the segment that now runs 50 → 200
  await h.hover(await h.along('FRONT', 'A', 'B', 0.8));
  await h.click(await h.along('FRONT', 'A', 'B', 0.8), { button: 'right' });
  await h.ibox('From end', { d: '30' });
  np = (await sewPts(h, 'FRONT')).filter(a => a.y === 0 && a.x > 0 && a.x < 200).map(a => a.x).sort((a, b) => a - b);
  check('cutpoint · 30 from the end → x = 170', np.length === 2 && near(np[1], 170, 1e-9), JSON.stringify(np));
  // fractions in inch mode: 1 1/8" from start on BACK bottom edge
  await h.ev(() => { window.__mv.settings.unit = 'in'; window.__mv.settings.fracDen = 16; });
  await h.hover({ x: 500, y: 0 });
  await h.page.keyboard.press('1');
  await h.ibox(null, { d: '1 1/8' });
  const bx = (await sewPts(h, 'BACK')).filter(a => a.y === 0 && a.x > 400 && a.x < 600).map(a => a.x);
  check('cutpoint · 1 1/8" from start → x = 428.575', bx.length === 1 && near(bx[0], 428.575, 1e-9), JSON.stringify(bx));
});
test('cutpoint.ratioDivideNotch', async h => {
  await h.fixture();
  await h.key('x');
  await h.hover({ x: 520, y: 0 });
  await h.click({ x: 520, y: 0 }, { button: 'right' });
  await h.ibox('Ratio %', { p: '25' });
  const bx = (await sewPts(h, 'BACK')).filter(a => a.y === 0 && a.x > 400 && a.x < 600).map(a => a.x);
  check('cutpoint · ratio 25 % → x = 450', bx.length === 1 && near(bx[0], 450, 1e-9), JSON.stringify(bx));
  // divide the right edge into 4 with notches (toggle in the tool-options strip)
  await h.page.locator('#toolopts [data-toggle="notch"]').click(); await h.settle();
  check('cutpoint · Notch option on', await h.ev(() => window.__mv.settings.toolState.cutPoint.notch === true));
  const j0 = await h.json(), n0 = await h.ev(() => window.__mv.P('BACK').notches.length), rev0 = await h.rev();
  await h.hover({ x: 600, y: 120 });
  await h.click({ x: 600, y: 120 }, { button: 'right' });
  await h.ibox('Divide', { n: '4' }, false);
  const pv = await h.ev(() => document.querySelectorAll('#canvas svg circle[stroke="#7b61ff"]').length);
  check('cutpoint · divide preview shows the 3 points before OK', pv === 3, String(pv));
  await h.page.locator('.ibox input').first().press('Enter'); await h.settle(60);
  const ys = (await sewPts(h, 'BACK')).filter(a => a.x === 600 && a.y > 0 && a.y < 300).map(a => a.y).sort((a, b) => a - b);
  check('cutpoint · divide 4 → y 75 / 150 / 225', ys.length === 3 && near(ys[0], 75, 1e-9) && near(ys[1], 150, 1e-9) && near(ys[2], 225, 1e-9), JSON.stringify(ys));
  check('cutpoint · a notch on every new point', (await h.ev(() => window.__mv.P('BACK').notches.length)) - n0 === 3);
  check('cutpoint · divide = one undo step', (await h.rev()) - rev0 === 1);
  await h.undoRedo('cutpoint.divide', j0, await h.json());
});
test('cutpoint.gradedInternal', async h => {
  await h.fixture();
  await h.ev(() => { const T = window.__mv; T.app.activeSize = T.sid('L'); T.app.invalidate(); }); await h.settle();
  await h.key('x');
  const w = await h.along('FRONT', 'A', 'B', 0.4);
  await h.hover(w);
  check('cutpoint · amber badge on a graded size', /size L/i.test(await h.ev(() => window.__mv.badge())), await h.ev(() => window.__mv.badge()));
  await h.click(w, { button: 'right' });
  await h.ibox('Divide', { n: '2' });
  const id = await h.ev(() => { const T = window.__mv; const p = T.P('FRONT'); return p.sew.points.find(a => a.y === 0 && a.x > 0 && a.x < 200).id; });
  const pos = await h.ev(id => { const T = window.__mv; const p = T.P('FRONT'); const f = s => T.ops.pointPos(T.app.doc, { pieceId: p.id, anchorId: id }, s); return { M: f(T.sid('M')), L: f(T.sid('L')), XL: f(T.sid('XL')) }; }, id);
  check('cutpoint · graded: midpoint at 100 (M), 105 (L), 110 (XL) — auto grading', near(pos.M.x, 100, 1e-9) && near(pos.L.x, 105, 1e-6) && near(pos.XL.x, 110, 1e-6), JSON.stringify(pos));
  // internal line, Ctrl+click = curve point
  await h.ev(() => { const T = window.__mv; T.app.activeSize = T.app.baseSize(); T.app.invalidate(); }); await h.settle();
  const n0 = await h.ev(() => window.__mv.P('FRONT').internals[0].points.length);
  const wi = await h.along('FRONT', 'IM', 'IB', 0.5);
  await h.hover(wi);
  await h.click(wi, { mods: ['Control'] });
  const ic = await h.ev(() => window.__mv.P('FRONT').internals[0].points.map(a => a.kind));
  check('cutpoint · Ctrl+click on an internal line adds a curve point', ic.length === n0 + 1 && ic.filter(k => k === 'curve').length === 2, JSON.stringify(ic));
});

// ───────────────────────── Dart (Shift+D) ─────────────────────────
const dartG = (h, pn, k = 0, s) => h.ev(([pn, k, s]) => { const T = window.__mv; const p = T.P(pn); const d = p.darts[k]; return d ? T.ops.dartInfo(T.app.doc, p.id, d.id, s ? T.sid(s) : undefined) : null; }, [pn, k, s]);
test('dart.clicks', async h => {
  await h.fixture();
  await h.key('Shift+D');
  const j0 = await h.json(), rev0 = await h.rev();
  await h.click({ x: 480, y: 0 });
  check('dart · prompt asks for leg B', /leg B/.test(await h.ev(() => window.__mv.prompt())));
  await h.hover({ x: 515, y: 0 }, ['Shift']);
  check('dart · leg B hover shows the width (Shift = round)', /width 35 mm/.test(await h.ev(() => window.__mv.prompt())), await h.ev(() => window.__mv.prompt()));
  await h.click({ x: 520, y: 0 }, { mods: ['Shift'] });
  await h.hover({ x: 505, y: 150 }, ['Shift']);
  const pr = await h.ev(() => window.__mv.prompt());
  check('dart · apex step shows width / depth / legs ✓', /width 40.*depth 150.*✓ equal/.test(pr), pr);
  check('dart · live ghost before the click (document unchanged)', (await h.json()) === j0 && await h.ev(() => window.__mv.app.preview.size === 1));
  check('dart · dart cap previewed on the cut line', await h.ev(() => { const T = window.__mv; const pv = T.app.preview.get(T.P('BACK').id); return !!pv && pv.darts.length === 1; }));
  await h.click({ x: 505, y: 150 }, { mods: ['Shift'] });
  const g = await dartG(h, 'BACK');
  check('dart · created by clicks: width 40, depth 150 exact (Shift), legs equal', !!g && near(g.width, 40, 1e-6) && near(g.depth, 150, 1e-6) && Math.abs(g.legLengthA - g.legLengthB) < 1e-6, JSON.stringify(g));
  check('dart · one undo step', (await h.rev()) - rev0 === 1);
  check('dart · selected after creation', await h.ev(() => window.__mv.app.liveSel?.kind === 'dart'));
  await h.undoRedo('dart.clicks', j0, await h.json());
});
test('dart.typed', async h => {
  await h.fixture();
  await h.key('Shift+D');
  await h.click({ x: 470, y: 0 }); await h.click({ x: 500, y: 0 });
  await h.hover({ x: 485, y: 100 });
  await h.click({ x: 485, y: 100 }, { button: 'right' });
  await h.ibox('Width · Depth', { w: '30', d: '120' });
  let g = await dartG(h, 'BACK');
  check('dart · typed width 30 / depth 120 exact', !!g && near(g.width, 30, 1e-6) && near(g.depth, 120, 1e-6), JSON.stringify(g));
  await h.click({ x: 540, y: 0 }); await h.click({ x: 560, y: 0 });
  await h.hover({ x: 550, y: 100 });
  await h.page.keyboard.press('2');
  await h.ibox('Width · Angle', { w: '20', a: '10' });
  g = await dartG(h, 'BACK', 1);
  check('dart · width 20 at 10° → depth 114.301', !!g && near(g.depth, 10 / Math.tan(5 * Math.PI / 180), 1e-6), JSON.stringify(g));
  // typed width at the leg-B step
  await h.click({ x: 400, y: 150 }); // left edge
  await h.hover({ x: 400, y: 170 });
  await h.page.keyboard.press('2');
  await h.ibox(null, { w: '24' });
  await h.click({ x: 450, y: 162 }, { mods: ['Shift'] });
  g = await dartG(h, 'BACK', 2);
  check('dart · typed width 24 at the leg-B step', !!g && near(g.width, 24, 1e-6), JSON.stringify(g));
});
test('dart.graded', async h => {
  await h.fixture();
  await h.ev(() => { const T = window.__mv; T.app.activeSize = T.sid('L'); T.app.invalidate(); }); await h.settle();
  await h.key('Shift+D');
  await h.click(await h.along('FRONT', 'A', 'B', 0.45)); await h.click(await h.along('FRONT', 'A', 'B', 0.55));
  await h.click(await h.along('FRONT', 'A', 'B', 0.5), { button: 'right' });
  await h.ibox('Width · Depth', { w: '20', d: '100' });
  const r = await h.ev(() => { const T = window.__mv; const p = T.P('FRONT'); const d = p.darts[0]; const S = n => T.ops.dartInfo(T.app.doc, p.id, d.id, T.sid(n)); return { M: S('M'), L: S('L'), XL: S('XL'), S: S('S') }; });
  check('dart · graded: created in the base (width 20 / depth 100 in M)', near(r.M.width, 20, 1e-6) && near(r.M.depth, 100, 1e-6), JSON.stringify(r.M));
  const mid = g => ({ x: (g.legA[0].x + g.legB[0].x) / 2, y: (g.legA[0].y + g.legB[0].y) / 2 });
  check('dart · graded: legs follow the hem grading in L / XL', mid(r.L).x > mid(r.M).x + 1 && mid(r.XL).x > mid(r.L).x + 1, JSON.stringify([mid(r.M), mid(r.L), mid(r.XL)]));
  check('dart · graded: apex grades with the opening (mean of the legs)', near(r.L.apex.x - r.M.apex.x, mid(r.L).x - mid(r.M).x, 1e-6) && near(r.S.apex.x - r.M.apex.x, mid(r.S).x - mid(r.M).x, 1e-6), JSON.stringify([r.M.apex, r.L.apex]));
  check('dart · Inspector per-size table', await h.ev(() => [...document.querySelectorAll('.insp-title')].some(e => /Per size/.test(e.textContent))));
});
test('dart.apexDrag', async h => {
  await h.fixture();
  await h.ev(() => { const T = window.__mv; const p = T.P('BACK'); T.ops.createDartByLegs(T.app.doc, p.id, { a: { fromAnchorId: p.sew.points[0].id, distance: 90 }, b: { fromAnchorId: p.sew.points[0].id, distance: 110 }, depth: 120 }); T.app.invalidate(); }); await h.settle();
  await h.key('g');
  const g0 = await dartG(h, 'BACK'), j0 = await h.json(), rev0 = await h.rev();
  await h.drag({ x: g0.apex.x, y: g0.apex.y }, { x: g0.apex.x + 15, y: g0.apex.y + 10 });
  const g1 = await dartG(h, 'BACK');
  check('dart · Move Point drags the apex', near(g1.apex.x, g0.apex.x + 15, 0.6) && near(g1.apex.y, g0.apex.y + 10, 0.6), JSON.stringify([g0.apex, g1.apex]));
  check('dart · Fix Dart keeps the legs equal after the drag', Math.abs(g1.legLengthA - g1.legLengthB) < 1e-6 && near(g1.width, 20, 1e-6), JSON.stringify(g1));
  check('dart · apex drag = one undo step', (await h.rev()) - rev0 === 1);
  await h.undoRedo('dart.apexDrag', j0, await h.json());
});
test('dart.multiPreview', async h => {
  await h.fixture();
  await h.key('v');
  await h.click({ x: 500, y: 0 }); // BACK bottom segment
  const j0 = await h.json();
  await h.ev(() => { void window.__mv.C.runCommand('dart.multi'); }); await h.settle();
  await h.ibox(null, { n: '3', w: '12', d: '60' }, false);
  check('dart · Multi darts shows a live ghost of 3 darts before OK', await h.ev(() => { const T = window.__mv; const pv = T.app.preview.get(T.P('BACK').id); return !!pv && pv.darts.length === 3; }) && (await h.json()) === j0);
  await h.page.locator('.ibox input').first().press('Enter'); await h.settle(60);
  check('dart · Multi darts created', await h.ev(() => window.__mv.P('BACK').darts.length === 3));
});

// ───────────────────────── Pleat (Shift+L) ─────────────────────────
const bw = (h, pn) => h.ev(pn => { const T = window.__mv; const r = T.G.resolveFor(T.app.doc, T.P(pn), T.app.sizeOf(T.P(pn))); const xs = r.sew.pts.map(q => q.x); return Math.max(...xs) - Math.min(...xs); }, pn);
test('pleat.count', async h => {
  await h.fixture();
  await h.key('Shift+L');
  const j0 = await h.json(), rev0 = await h.rev();
  await h.click({ x: 450, y: 300 }); await h.click({ x: 450, y: 0 });
  await h.hover({ x: 530, y: 150 }, ['Shift']);
  const pr = await h.ev(() => window.__mv.prompt());
  check('pleat · layout prompt: 3 knife · interval 40', /3 Knife · interval 40 mm/.test(pr), pr);
  check('pleat · live ghost (3 open pleats) before the click', await h.ev(() => { const T = window.__mv; const pv = T.app.preview.get(T.P('BACK').id); return !!pv && pv.pleats.length === 3 && pv.pleats.every(p => p.open); }) && (await h.json()) === j0);
  check('pleat · fold-direction arrows drawn', await h.ev(() => document.querySelectorAll('#canvas svg path[data-pleat-arrows]').length >= 3));
  await h.click({ x: 530, y: 150 }, { mods: ['Shift'] });
  const n = await h.ev(() => window.__mv.P('BACK').pleats.length);
  check('pleat · 3 pleats created and open', n === 3 && await h.ev(() => window.__mv.P('BACK').pleats.every(p => p.open)), String(n));
  check('pleat · BACK grows by 3 × 2 × 20 = 120', near(await bw(h, 'BACK'), 320, 1e-6), String(await bw(h, 'BACK')));
  check('pleat · auto notches', await h.ev(() => window.__mv.P('BACK').notches.filter(x => x.source === 'pleat').length >= 6));
  check('pleat · one undo step', (await h.rev()) - rev0 === 1);
  await h.undoRedo('pleat.count', j0, await h.json());
});
test('pleat.invertedTaper', async h => {
  await h.fixture();
  await h.key('Shift+L');
  await h.page.locator('#toolopts [data-mode="inverted"]').click(); await h.settle();
  await h.click({ x: 440, y: 300 }); await h.click({ x: 440, y: 0 });
  await h.hover({ x: 520, y: 150 });
  await h.click({ x: 520, y: 150 }, { button: 'right' });
  await h.ibox(null, { n: '2', ds: '10', de: '5', iv: '60' });
  const r = await h.ev(() => { const T = window.__mv; const p = T.P('BACK'); return p.pleats.map(q => ({ type: q.type, o: T.ops.pleatOpenings(T.app.doc, p.id, q.id), mid: q.edges.every(e => !!e.mid) })); });
  check('pleat · 2 inverted box pleats, tapered 40 → 20 fabric each', r.length === 2 && r.every(q => q.type === 'inverted' && near(q.o.start, 40, 1e-6) && near(q.o.end, 20, 1e-6) && q.mid), JSON.stringify(r));
  // between two lines (L): 3 pleats spread up to a last line
  await h.fixture();
  await h.key('Shift+L');
  await h.click({ x: 430, y: 300 }); await h.click({ x: 430, y: 0 });
  await h.key('l');
  await h.click({ x: 570, y: 300 }); await h.click({ x: 570, y: 0 });
  await h.hover({ x: 500, y: 150 });
  await h.click({ x: 500, y: 150 });
  await h.ev(() => { const T = window.__mv; T.ops.closePleats(T.app.doc, T.P('BACK').id); });
  const ax = await h.ev(() => window.__mv.P('BACK').pleats.map(q => Math.round(q.axisStart.x)));
  check('pleat · between lines: 3 pleats evenly from the first to the last line', ax.length === 3 && Math.abs(ax[1] - 500) <= 1, JSON.stringify(ax));
});

// ───────────────────────── Slash & spread (Shift+U) ─────────────────────────
const openings = (h, pn, k = 0) => h.ev(([pn, k]) => { const T = window.__mv; const p = T.P(pn); const f = (p.fullness ?? [])[k]; return f ? T.ops.fullnessOpenings(T.app.doc, p.id, f.id) : null; }, [pn, k]);
test('fullness.interactive', async h => {
  await h.fixture();
  await h.key('Shift+U');
  const j0 = await h.json(), rev0 = await h.rev();
  await h.click({ x: 500, y: 0 }); await h.click({ x: 500, y: 300 });
  await h.hover({ x: 531, y: 100 }, ['Shift']);
  const pr = await h.ev(() => window.__mv.prompt());
  check('fullness · readout: opening 30 (Shift = round)', /opening 30 mm/.test(pr), pr);
  check('fullness · live ghost before the click', await h.ev(() => { const T = window.__mv; const pv = T.app.preview.get(T.P('BACK').id); return !!pv && (pv.fullness ?? []).length === 1; }) && (await h.json()) === j0);
  await h.click({ x: 531, y: 100 }, { mods: ['Shift'] });
  const o = await openings(h, 'BACK');
  check('fullness · hinged spread with opening 30 exactly', !!o && o.length === 1 && near(o[0], 30, 1e-6), JSON.stringify(o));
  check('fullness · one undo step', (await h.rev()) - rev0 === 1);
  await h.undoRedo('fullness.interactive', j0, await h.json());
});
test('fullness.typedDelete', async h => {
  await h.fixture();
  const sew0 = await h.ev(() => JSON.stringify(window.__mv.P('BACK').sew));
  await h.key('Shift+U');
  await h.click({ x: 440, y: 0 }); await h.click({ x: 440, y: 300 });
  await h.key('+'); await h.key('+');
  check('fullness · 3 slashes → asks for the last slash', /LAST slash/.test(await h.ev(() => window.__mv.prompt())));
  await h.click({ x: 560, y: 0 }); await h.click({ x: 560, y: 300 });
  await h.hover({ x: 470, y: 100 });
  await h.click({ x: 470, y: 100 }, { button: 'right' });
  await h.ibox('First → last', { w0: '10', w1: '30' });
  const o = await openings(h, 'BACK');
  check('fullness · typed first → last 10 / 20 / 30', !!o && o.length === 3 && JSON.stringify(o.map(x => Math.round(x * 1e6) / 1e6).sort((a, b) => a - b)) === '[10,20,30]', JSON.stringify(o));
  // Inspector edit in place, then Delete = exact restore
  await h.key('v');
  await h.ev(() => { const T = window.__mv; const p = T.P('BACK'); T.ops.setFullnessOpenings(T.app.doc, p.id, p.fullness[0].id, { widths: [5, 5, 5] }); });
  check('fullness · edit openings in place', JSON.stringify((await openings(h, 'BACK')).map(x => Math.round(x * 1e6) / 1e6)) === '[5,5,5]');
  await h.ev(() => { void window.__mv.C.runCommand('fullness.delete'); }); await h.settle(120);
  check('fullness · delete restores the sew line exactly', (await h.ev(() => JSON.stringify(window.__mv.P('BACK').sew))) === sew0);
});

// ───────────────────────── internal lines locked to the outline ─────────────────────────
/** per-size piece-frame positions of the anchors of internal k (default: the last one) of a piece */
const ipts = (h, pn, size, k) => h.ev(([pn, size, k]) => { const T = window.__mv; const p = T.P(pn); const c = p.internals[k ?? p.internals.length - 1]; const line = T.app.doc.sizeLine(p); return T.K.anchorPositions(c.points, line, size ? T.sid(size) : line.baseSizeId, c.closed); }, [pn, size, k]);
const iworld = (h, pn, q) => h.ev(([pn, q]) => window.__mv.G.toWorld(window.__mv.P(pn), q), [pn, q]);
const sewAt = (h, pn, an, size) => h.ev(([pn, an, size]) => { const T = window.__mv; const p = T.P(pn); const line = T.app.doc.sizeLine(p); const i = p.sew.points.findIndex(a => a.name === an); return T.K.anchorPositions(p.sew.points, line, size ? T.sid(size) : line.baseSizeId, true)[i]; }, [pn, an, size]);
test('lock.autoDraw', async h => {
  await h.fixture();
  await h.key('i');
  const s0 = await h.along('FRONT', 'A', 'B', 0.4), e0 = await h.along('FRONT', 'H', 'A', 0.5);
  const rev0 = await h.rev();
  await h.click(s0); await h.click({ x: 90, y: 120 }); await h.click(e0); await h.key('Enter');
  const L = await h.ev(() => { const p = window.__mv.P('FRONT'); const c = p.internals[p.internals.length - 1]; return c.lock?.kind === 'ends' ? c.lock.ends.map(e => e.value) : c.lock ?? null; });
  check('lock.autoDraw · both ends drawn on the outline are locked, proportional 40 % / 50 % (one undo step)', Array.isArray(L) && L.length === 2 && near(L[0], 0.4, 1e-6) && near(L[1], 0.5, 1e-6) && (await h.rev()) - rev0 === 1, JSON.stringify(L));
  check('lock.autoDraw · padlock drawn on the line', await h.ev(() => document.querySelectorAll('[data-lock]').length >= 1));
  // Move Point B (grade point at the end of the hem): the locked end keeps 40 % of the hem, base and size L
  await h.key('g');
  const B = await h.W('FRONT', 'B');
  const j0 = await h.json();
  await h.drag(B, { x: B.x + 40, y: B.y }, { mods: ['Alt'] });
  for (const size of [undefined, 'L', 'XL']) {
    const P = await ipts(h, 'FRONT', size), A = await sewAt(h, 'FRONT', 'A', size), Bn = await sewAt(h, 'FRONT', 'B', size);
    const v = L[0]; // the stored ratio (the drawn click is 40 % to screen precision)
    check(`lock.autoDraw · end stays at 40 % of the moved hem (${size ?? 'base'})`, near(P[0].x, A.x + v * (Bn.x - A.x), 1e-6) && near(P[0].y, A.y + v * (Bn.y - A.y), 1e-6), JSON.stringify([P[0], A, Bn, v]));
  }
  await h.undoRedo('lock.autoDraw · move B', j0, await h.json());
  // a locked end point refuses an independent move
  const end = await iworld(h, 'FRONT', (await ipts(h, 'FRONT'))[0]);
  const rev1 = await h.rev();
  await h.drag(end, { x: end.x + 15, y: end.y + 20 }, { mods: ['Alt'] });
  check('lock.autoDraw · locked end is not moved by Move Point (message shown)', (await h.rev()) === rev1 && /locked/i.test(await h.ev(() => window.__mv.app.statusMsg + ' ' + window.__mv.prompt())), await h.ev(() => window.__mv.app.statusMsg));
  // Unlock (right-click entry = command), then it moves
  await h.ev(() => { const T = window.__mv; const p = T.P('FRONT'); T.app.applySel({ k: 'internal', c: { pieceId: p.id, contourId: p.internals[p.internals.length - 1].id } }, 'replace'); return T.C.runCommand('internal.unlock'); });
  await h.settle(60);
  check('lock.autoDraw · Unlock removes the lock', await h.ev(() => { const p = window.__mv.P('FRONT'); return !p.internals[p.internals.length - 1].lock; }));
  const rev2 = await h.rev();
  await h.key('g');
  await h.drag(end, { x: end.x + 15, y: end.y + 20 }, { mods: ['Alt'] });
  check('lock.autoDraw · after Unlock the end moves', (await h.rev()) === rev2 + 1);
  // auto-lock off (tool option): a new line is free
  await h.key('i');
  await h.ev(() => window.__mv.app.tool.toggle(window.__mv.app, 'autolock'));
  await h.click(await h.along('FRONT', 'A', 'B', 0.7)); await h.click({ x: 120, y: 100 }); await h.key('Enter');
  check('lock.autoDraw · auto-lock off → free line', await h.ev(() => { const p = window.__mv.P('FRONT'); return !p.internals[p.internals.length - 1].lock; }));
  await h.ev(() => window.__mv.app.tool.toggle(window.__mv.app, 'autolock'));
});
test('lock.inspectorParallel', async h => {
  await h.fixture();
  await h.key('v');
  // select the fixture internal line (IA – IM – IB), lock it parallel from the Inspector
  await h.click(await h.along('FRONT', 'IM', 'IB', 0.5));
  check('lock.parallel · internal selected', (await h.sel()).internals.length === 1, JSON.stringify(await h.sel()));
  const j0 = await h.json(), rev0 = await h.rev();
  await h.page.locator('.insp .prow', { hasText: 'Lock' }).locator('select').first().selectOption('parallel');
  await h.settle(80);
  const L = await h.ev(() => { const T = window.__mv; const p = T.P('FRONT'); const c = p.internals[0]; const pn = id => p.sew.points.find(a => a.id === id)?.name; return c.lock?.kind === 'parallel' ? { from: pn(c.lock.from), to: pn(c.lock.to), off: c.lock.offset } : c.lock ?? null; });
  check('lock.parallel · locked parallel to the segment under the line (H → A)', L && L.from === 'H' && L.to === 'A' && L.off > 50 && L.off < 80 && (await h.rev()) - rev0 === 1, JSON.stringify(L));
  await h.undoRedo('lock.parallel · lock', j0, await h.json());
  const exact = async () => {
    let worst = 0;
    for (const size of [undefined, 'S', 'L', 'XL']) worst = Math.max(worst, await h.ev(([size]) => {
      const T = window.__mv; const p = T.P('FRONT'); const line = T.app.doc.sizeLine(p); const sid = size ? T.sid(size) : line.baseSizeId;
      const r = T.K.resolveContour(p.sew, line, sid); const iH = p.sew.points.findIndex(a => a.name === 'H'), iA = p.sew.points.findIndex(a => a.name === 'A');
      const span = T.K.spanPolyline(r, iH, iA); const ic = T.K.resolveContour(p.internals[0], line, sid);
      return Math.max(...ic.pts.map(q => Math.abs(T.K.closestPoint(span, q).d - p.internals[0].lock.offset)));
    }, [size]));
    return worst;
  };
  check('lock.parallel · exact offset (0.01 mm) in every size', (await exact()) < 0.01, String(await exact()));
  check('lock.parallel · Inspector shows the lock (offset row)', await h.ev(() => [...document.querySelectorAll('.insp .prow .plabel')].some(e => /Offset/.test(e.textContent))));
  // Move Line on the sew segment H → A: the parallel follows
  await h.key('Shift+G');
  const m = await h.along('FRONT', 'H', 'A', 0.3);
  await h.drag(m, { x: m.x - 20, y: m.y });
  const Ax = (await sewAt(h, 'FRONT', 'A')).x;
  check('lock.parallel · the segment moved', Ax < -10, String(Ax));
  check('lock.parallel · still exact after Move Line of the segment', (await exact()) < 0.01, String(await exact()));
  // its points are not movable on their own
  await h.key('g');
  const p0 = await iworld(h, 'FRONT', (await ipts(h, 'FRONT', undefined, 0))[0]);
  const rev1 = await h.rev();
  await h.drag(p0, { x: p0.x + 10, y: p0.y + 10 }, { mods: ['Alt'] });
  check('lock.parallel · its points refuse Move Point', (await h.rev()) === rev1);
  // Inspector Unlock button
  await h.key('v');
  await h.ev(() => { const T = window.__mv; const p = T.P('FRONT'); T.app.applySel({ k: 'internal', c: { pieceId: p.id, contourId: p.internals[0].id } }, 'replace'); T.app.flush(); });
  await h.settle(40);
  await h.page.locator('.insp button', { hasText: 'Unlock' }).first().click(); await h.settle(60);
  check('lock.parallel · Inspector Unlock', await h.ev(() => !window.__mv.P('FRONT').internals[0].lock));
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const vite = await startVite();
  const h = new H(vite.url);
  let code = 0;
  try {
    await h.open();
    for (const c of CASES) {
      if (ONLY && !ONLY.test(c.id)) continue;
      console.log('▶', c.id);
      const n0 = results.length;
      try { await c.fn(h); } catch (err) { check(c.id + ' · threw', false, String(err && err.stack || err)); }
      if (results.slice(n0).some(r => !r.ok)) await h.page.screenshot({ path: path.join(OUT, c.id + '.png') }).catch(() => {});
      await h.ev(() => { document.querySelectorAll('.dlg-overlay,.ibox').forEach(e => e.remove()); }).catch(() => {});
    }
    check('no page errors', h.errors.length === 0, h.errors.join('\n'));
  } finally {
    await h.browser?.close();
    vite.stop();
  }
  const fail = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), url: vite.url, total: results.length, failed: fail.length, results }, null, 2));
  console.log(`\n${results.length - fail.length}/${results.length} checks passed${fail.length ? `, ${fail.length} FAILED` : ''}`);
  if (fail.length) code = 1;
  process.exit(code);
})().catch(e => { console.error(e); process.exit(2); });
