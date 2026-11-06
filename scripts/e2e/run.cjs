#!/usr/bin/env node
// ProwdCAD v2 end-to-end suite.
//   npm run e2e                      → starts Vite (apps/web) on :5199, runs every suite
//   E2E_URL=http://localhost:5173/ npm run e2e    → use an already running dev server
//   E2E_ONLY='^seam\.' npm run e2e   → only cases whose id matches the regex
//   E2E_SUITES=commands,tools npm run e2e   (commands, tools, hotkeys, special, single)
// Output: scripts/e2e/out/results.json (+ shots/ for failures). Exit code 1 when any case fails.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Harness } = require('./lib/harness.cjs');
const { buildFixture, withLive } = require('./lib/fixture.cjs');
const { runCase } = require('./lib/runner.cjs');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'out');
const PORT = 5199;
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
const SUITES = (process.env.E2E_SUITES || 'commands,tools,hotkeys,special,single').split(',');

function ping(url) { return new Promise(res => { http.get(url, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)); }); }
/**
 * The suite runs against a frozen snapshot of a git revision (default HEAD), extracted with
 * `git archive` into the OS temp dir, so concurrent edits in the working tree (Vite HMR reloads)
 * cannot change the app under test mid-run. E2E_TREE=1 tests the live working tree instead.
 */
function snapshot() {
  const { execSync } = require('child_process');
  if (process.env.E2E_TREE) return { dir: ROOT, rev: 'working tree' };
  const rev = execSync(`git rev-parse --short ${process.env.E2E_REV || 'HEAD'}`, { cwd: ROOT }).toString().trim();
  const dir = path.join(require('os').tmpdir(), 'prowdcad-e2e-' + rev);
  if (!fs.existsSync(path.join(dir, 'apps/web/src/main.ts'))) {
    fs.mkdirSync(dir, { recursive: true });
    execSync(`git archive --format=tar ${rev} | tar -x -C "${dir}"`, { cwd: ROOT, shell: '/bin/bash' });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  }
  fs.mkdirSync(path.join(dir, 'apps/web/node_modules'), { recursive: true });
  return { dir, rev };
}
async function startVite() {
  if (process.env.E2E_URL) return { url: process.env.E2E_URL, rev: 'external', stop() {} };
  const snap = snapshot();
  const url = `http://localhost:${PORT}/`;
  if (await ping(url)) throw new Error(`port ${PORT} is busy — stop the other server or set E2E_URL`);
  const p = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], { cwd: path.join(snap.dir, 'apps/web'), stdio: 'ignore', detached: false });
  for (let i = 0; i < 100; i++) { if (await ping(url)) return { url, rev: snap.rev, dir: snap.dir, stop: () => p.kill() }; await new Promise(r => setTimeout(r, 200)); }
  for (let i = 0; i < 100; i++) { if (await ping(url)) return { url, stop: () => p.kill() }; await new Promise(r => setTimeout(r, 200)); }
  p.kill(); throw new Error('vite did not start');
}

/** export the fixture through the kernel to files the import / open / merge cases pick */
async function writeFixtureFiles(h) {
  const dir = path.join(OUT, 'fixtures'); fs.mkdirSync(dir, { recursive: true });
  const files = await h.ev(() => {
    const { app, ops } = window.__e2e; const doc = app.doc;
    const dxf = ops.exportDXF(doc, { flavor: 'aama', units: 'mm', styleName: 'E2E SRC' });
    const svg = ops.exportSVG(doc, { sizes: [app.baseSize()], layout: 'pack', labels: false, curves: false });
    const plt = ops.exportHPGL(doc, { sizes: [app.baseSize()], layout: 'pack', labels: false, profile: { unitsPerMm: 40 } });
    const st = JSON.parse(JSON.stringify(doc.style)); st.name = 'OPENED STYLE'; st.pieces.forEach(p => { p.name = p.name + ' M'; });
    const native = ops.saveNative(new doc.constructor(st), { pretty: true });
    return { dxf: dxf.dxf, rul: dxf.rul, svg, plt, native };
  });
  fs.writeFileSync(path.join(dir, 'e2e-src.dxf'), files.dxf);
  fs.writeFileSync(path.join(dir, 'e2e-src.rul'), files.rul || '');
  fs.writeFileSync(path.join(dir, 'e2e-src.svg'), files.svg);
  fs.writeFileSync(path.join(dir, 'e2e-src.plt'), files.plt);
  fs.writeFileSync(path.join(dir, 'e2e-open.prowd.json'), files.native);
  // 4×4 red PNG
  fs.writeFileSync(path.join(dir, 'tiny.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAEAQMAAACTPww9AAAAA1BMVEX/AAAZ4gk3AAAAC0lEQVQI12NgQAcAABQAAWmaovgAAAAASUVORK5CYII=', 'base64'));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const vite = await startVite();
  const h = new Harness(vite.url);
  const results = { startedAt: new Date().toISOString(), url: vite.url, rev: vite.rev, cases: [], special: {}, hotkeys: null, single: null, fixture: null };
  try {
    await h.open();
    const fx = await buildFixture(h);
    results.fixture = { uiErrors: fx.uiErrors, pieces: JSON.parse(fx.json).pieces.map(p => `${p.name}: ${p.sew.points.length} pts, ${p.internals.length} internals`) };
    await h.reset(fx.json);
    await writeFixtureFiles(h);
    await h.reset(fx.json);
    const live = await withLive(h);
    const fixtures = { base: fx.json, live };
    fs.writeFileSync(path.join(OUT, 'fixtures', 'fixture-base.json'), fx.json);
    const registry = await h.allCommands();
    const metaOf = id => registry.find(c => c.id === id.split('#')[0]);
    results.registry = registry;

    const runList = async (list, kind) => {
      for (const c of list) {
        if (ONLY && !ONLY.test(c.id)) continue;
        const m = metaOf(c.id);
        if (!m && !c.id.startsWith('tool:') && !(c.invoke && c.id.includes('#'))) { const r = { id: c.id, menu: '', title: c.title ?? c.id, kind, status: 'skip', msgs: [`command ${c.id.split('#')[0]} does not exist at ${results.rev}`], notes: [] }; results.cases.push(r); console.log('· ' + c.id + ' (not in registry)'); continue; }
        if (c.tool && !(await h.ev(t => window.__e2e.app.tools.some(x => x.id === t), c.tool))) { results.cases.push({ id: c.id, menu: 'Tools', title: c.title ?? c.id, kind, status: 'skip', msgs: [`tool ${c.tool} does not exist at ${results.rev}`], notes: [] }); console.log('· ' + c.id + ' (tool missing)'); continue; }
        const r = await runCase(h, fixtures, { ...c, id: c.id.split('#')[0], caseId: c.id, invoke: c.invoke, kind }, m && { menu: m.menu, title: c.title ?? m.title });
        r.id = c.id;
        results.cases.push(r);
        process.stdout.write(`${r.status === 'pass' ? '✓' : r.status === 'skip' ? '·' : '✗'} ${c.id}${r.status === 'fail' ? '  — ' + r.msgs.join(' ; ').slice(0, 300) : ''}\n`);
        if (h.pageErrors.length > 50) h.pageErrors.splice(0, 40);
      }
    };
    if (SUITES.includes('commands')) {
      const { cases } = require('./suites/commands.cjs');
      // coverage: every registry command (except tool.* — covered by the tools suite) needs a case
      const covered = new Set(cases.map(c => c.id.split('#')[0]));
      results.uncovered = registry.filter(c => !c.id.startsWith('tool.') && !covered.has(c.id)).map(c => c.id);
      await runList(cases, 'command');
    }
    if (SUITES.includes('tools')) { const { cases } = require('./suites/tools.cjs'); await runList(cases, 'tool'); }
    if (SUITES.includes('hotkeys') && !ONLY) { const { hotkeys } = require('./suites/hotkeys.cjs'); results.hotkeys = await hotkeys(h, fixtures, registry); }
    if (SUITES.includes('special')) { const S = require('./suites/special.cjs'); results.special = await S.run(h, fixtures, results, ONLY); }
  } catch (e) {
    console.error('FATAL', e); results.fatal = String(e && e.stack || e);
  } finally {
    results.pageErrors = h.pageErrors; results.navigations = h.navigations; results.secondClick = [...h.stats.secondClick]; results.consoleErrors = h.consoleErrors.slice(0, 50);
    await h.close().catch(() => {});
    vite.stop();
  }
  if (SUITES.includes('single') && !ONLY) { const { single } = require('./suites/single.cjs'); results.single = await single(ROOT, results.registry || []).catch(e => ({ error: String(e) })); }
  results.finishedAt = new Date().toISOString();
  const by = {};
  for (const r of results.cases) { const k = r.kind === 'tool' ? 'Tools' : (r.menu || '(hotkey only)').split('/')[0]; by[k] ??= { pass: 0, fail: 0, skip: 0 }; by[k][r.status]++; }
  results.summary = by;
  fs.writeFileSync(path.join(OUT, process.env.E2E_OUT || 'results.json'), JSON.stringify(results, null, 1));
  console.log('\nSummary by menu:'); for (const [k, v] of Object.entries(by)) console.log(`  ${k.padEnd(16)} pass ${v.pass}  fail ${v.fail}  skip ${v.skip}`);
  if (results.uncovered?.length) console.log('Uncovered commands:', results.uncovered.join(', '));
  const nFail = results.cases.filter(r => r.status === 'fail').length;
  console.log(`\n${results.cases.length} cases, ${nFail} failing → ${path.relative(ROOT, path.join(OUT, 'results.json'))}`);
  process.exit(nFail || results.fatal ? 1 : 0);
})();
