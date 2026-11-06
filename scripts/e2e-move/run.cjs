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
    Object.assign(S.settings, { movePointMode: 'single', moveLineMode: 'translate', pieceToolMode: 'move', selFilter: 'all', selectDragMove: false, unit: 'mm', nudgeMm: 1 });
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
