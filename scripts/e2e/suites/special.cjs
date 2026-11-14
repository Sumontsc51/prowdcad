// Cross-cutting checks: "do other points move?", units + fraction input, nested view + size
// switching, Select-tool drags, selection persistence, export scope, File System Access probe,
// and an automated "nothing selected" probe of every menu command (silent no-ops).
const Q = require('../lib/q.cjs');
const { pc, an, near, req, anchorDiff, abs } = Q;
const { P, addInternal } = require('./commands.cjs');
const { runCase } = require('../lib/runner.cjs');

const inspInput = (h, labelRe) => h.page.locator('section[data-panel="inspector"] .prow').filter({ has: h.page.locator('.plabel', { hasText: labelRe }) }).locator('input').first();
async function typeInto(h, loc, text) { await loc.click({ clickCount: 3 }); await loc.fill(text); await loc.press('Enter'); await h.settle(60); }
const allPos = (h, p) => h.ev(p => window.__e2e.allPos(p), p);
function posDiff(a, b, except, tol = 1e-3) {
  const out = [];
  for (const k of Object.keys(a)) {
    if (except.some(e => k.endsWith(':' + e))) continue;
    for (const s of Object.keys(a[k])) { const p = a[k][s], q = b[k]?.[s]; if (!q || Math.hypot(p.x - q.x, p.y - q.y) > tol) { out.push(k + (Object.keys(a[k]).length > 1 ? '' : '')); break; } }
  }
  return out;
}
const hasMove = h => h.ev(() => window.__e2e.app.tools.some(t => t.id === 'movePoint'));
const sizeName = (h, id) => h.ev(id => window.__e2e.app.sizeLine().sizes.find(s => s.id === id)?.name, id);

// ───────────────────────── A. which operations move other points ─────────────────────────
const SCEN = {
  plain: { title: 'plain sew grade point', piece: 'FRONT', point: 'UA' },
  nextToCurve: { title: 'grade point next to curve points (SH: AH2 / N1 neighbours)', piece: 'FRONT', point: 'SH' },
  curvePoint: { title: 'curve point (AH1)', piece: 'FRONT', point: 'AH1' },
  smoothHandles: { title: 'smooth point with explicit handles (UA made smooth, handles set)', piece: 'FRONT', point: 'UA', pre: P((app, ops, doc, E) => doc.transact('pre', () => { const a = E.findA('FRONT', 'UA').a; a.smooth = true; a.hIn = { x: 0, y: -40 }; a.hOut = { x: -10, y: 40 }; })) },
  connection: { title: 'sew point with a point connection (internal line ends on UA, Piece ▸ Connections ▸ global check)', piece: 'FRONT', point: 'UA', pre: async h => { await addInternal([[260, 465, 'CN_A'], [150, 420, 'CN_B']])(h); await P((app, ops, doc, E) => ops.globalCheckConnections(doc, E.P('FRONT').id))(h); } },
  half: { title: 'half piece (CF fold axis set) — point off the axis', piece: 'FRONT', point: 'SS_HEM', pre: P((app, ops, doc, E) => ops.setHalf(doc, E.P('FRONT').id, { a: { x: 0, y: 0 }, b: { x: 0, y: 622 } }, { openAtOutput: true })) },
  halfAxis: { title: 'half piece — point ON the fold axis (CF_NECK)', piece: 'FRONT', point: 'CF_NECK', pre: P((app, ops, doc, E) => ops.setHalf(doc, E.P('FRONT').id, { a: { x: 0, y: 0 }, b: { x: 0, y: 622 } }, { openAtOutput: true })) },
  sizeL: { title: 'active size L (non-base): edit = grading of L only', piece: 'FRONT', point: 'UA', size: 'L' },
  dartLeg: { title: 'point next to a dart (live fixture, SS_HEM)', piece: 'FRONT', point: 'SS_HEM', fixture: 'live' },
};
const METHODS = {
  selectDrag: { title: 'Select tool drag (pause > 450 ms after selecting)', run: async (h, s) => { await h.page.waitForTimeout(600); const w = await h.W(s.piece, s.point); await h.dragW(w, { x: w.x + 15, y: w.y - 10 }, { steps: 10 }); } },
  propDrag: { title: 'Select drag with Point ▸ Proportional drag ON', setup: h => h.ev(() => { window.__e2e.settings.proportionalDrag = true; }), run: async (h, s) => { await h.page.waitForTimeout(600); const w = await h.W(s.piece, s.point); await h.dragW(w, { x: w.x + 15, y: w.y - 10 }, { steps: 10 }); } },
  moveXY: { title: 'Point ▸ Move point XY… (dX 15, dY −10)', run: async h => { await h.cmd('point.moveXY'); await h.waitDialog(); await h.fields({ how: 'delta', _dx: '15', _dy: '-10' }); await h.ok(); } },
  nudge: { title: 'Arrow keys (Shift+→ = 10 mm; at HEAD inside Move Point)', run: async h => { if (await hasMove(h)) await h.key('g'); await h.key('Shift+ArrowRight'); } },
  mpSingle: { title: 'Move Point (G) · Single: drag', needs: 'movePoint', run: async (h, s) => { await h.key('g'); const w = await h.W(s.piece, s.point); await h.dragW(w, { x: w.x + 15, y: w.y - 10 }, { steps: 10 }); } },
  mpSmooth: { title: 'Move Point · Smooth (Point ▸ Modify Points ▸ Move Smooth): drag', needs: 'movePoint', run: async (h, s) => { await h.cmd('move.smooth'); const w = await h.W(s.piece, s.point); await h.dragW(w, { x: w.x + 15, y: w.y - 10 }, { steps: 10 }); } },
  mpInput: { title: 'Move Point · Single: click point, type dX 15 dY −10 in the input box', needs: 'movePoint', run: async (h, s) => { await h.key('g'); await h.clickA(s.piece, s.point); await h.page.keyboard.type('1'); await h.page.waitForSelector('.ibox', { timeout: 2000 }); const ins = h.page.locator('.ibox input'); await ins.nth(0).fill('15'); await ins.nth(1).fill('-10'); await ins.nth(1).press('Enter'); await h.settle(); } },
  selDragOptIn: { title: 'Select with Edit ▸ Allow drag-move (opt-in): drag', needs: 'movePoint', setup: h => h.ev(() => { window.__e2e.settings.selectDragMove = true; }), run: async (h, s) => { await h.page.waitForTimeout(600); const w = await h.W(s.piece, s.point); await h.dragW(w, { x: w.x + 15, y: w.y - 10 }, { steps: 10 }); } },
  inspX: { title: 'Inspector X field (+15)', run: async (h, s) => { const loc = inspInput(h, /^X/); const v = await loc.inputValue(); await typeInto(h, loc, String(+v + 15)); } },
  inspY: { title: 'Inspector Y field (−10)', run: async (h, s) => { const loc = inspInput(h, /^Y/); const v = await loc.inputValue(); await typeInto(h, loc, String(+v - 10)); } },
};

async function otherPoints(h, fixtures) {
  const rows = [];
  for (const [sk, s] of Object.entries(SCEN)) {
    for (const [mk, m] of Object.entries(METHODS)) {
      const row = { scenario: sk, scenarioTitle: s.title, method: mk, methodTitle: m.title, point: `${s.piece}/${s.point}` };
      if (m.needs && !(await hasMove(h))) { row.error = 'n/a at this revision'; rows.push(row); continue; }
      if (mk === 'propDrag' && (await hasMove(h))) { row.error = 'n/a at this revision (setting removed; see mpSmooth)'; rows.push(row); continue; }
      try {
        await h.reset(fixtures[s.fixture || 'base']);
        if (s.pre) { await s.pre(h); await h.settle(); }
        if (m.setup) await m.setup(h);
        try { await h.selectA(s.piece, s.point); }
        catch (e) { row.note = 'could not select the sew point by clicking (a coincident internal point is on top) — selected programmatically'; await h.ev(([p, a]) => { const E = window.__e2e; E.app.selectAnchor(E.ref(p, a)); }, [s.piece, s.point]); await h.settle(); }
        if (s.size) { await h.page.locator('select.sb-size').selectOption({ label: s.size }); await h.settle(); }
        const st0 = await h.state(), pos0 = await allPos(h, s.piece), rev0 = await h.ev(() => window.__e2e.app.doc.revision());
        await m.run(h, s);
        await h.waitIdle(2000); await h.settle(60);
        const st1 = await h.state(), pos1 = await allPos(h, s.piece);
        const a0 = an(st0, s.piece, s.point), a1 = an(st1, s.piece, s.point);
        row.movedStored = { dx: Q.r4(a1.x - a0.x), dy: Q.r4(a1.y - a0.y) };
        row.ownGradeChanged = JSON.stringify(a0.grade) !== JSON.stringify(a1.grade);
        row.ownHandlesChanged = JSON.stringify([a0.hIn, a0.hOut, a0.smooth]) !== JSON.stringify([a1.hIn, a1.hOut, a1.smooth]);
        row.ownResolved = Object.fromEntries(Object.entries(pos1['sew:' + s.point] || pos1['int1:' + s.point] || {}).map(([sid, p]) => { const q = (pos0['sew:' + s.point] || {})[sid]; return [sid, q ? { dx: Q.r4(p.x - q.x), dy: Q.r4(p.y - q.y) } : null]; }));
        row.otherStored = anchorDiff(st0, st1, s.piece).filter(d => d.name !== s.point).map(d => `${d.name}: ${d.what}`);
        row.otherResolved = posDiff(pos0, pos1, [s.point]);
        row.undoSteps = (await h.ev(() => window.__e2e.app.doc.revision())) - rev0;
        row.otherPieces = st0.pieces.filter(p => p.name !== s.piece).filter(p => JSON.stringify(p) !== JSON.stringify(pc(st1, p.name))).map(p => p.name);
        row.toasts = (await h.rec()).toasts.map(t => t.text);
        // size names for resolved keys
        const names = {}; for (const sid of Object.keys(row.ownResolved)) names[sid] = await sizeName(h, sid);
        row.ownResolved = Object.fromEntries(Object.entries(row.ownResolved).map(([k, v]) => [names[k], v]));
      } catch (e) { row.error = String(e.message || e).split('\n')[0]; await h.escapeAll(); }
      rows.push(row);
      process.stdout.write(`  other-points ${sk}/${mk}: ${row.error ? 'ERR ' + row.error : `stored others ${row.otherStored.length}, resolved others ${row.otherResolved.length}`}\n`);
    }
  }
  return rows;
}

// ───────────────────────── B. units & fractions ─────────────────────────
async function units(h, fixtures) {
  const out = [];
  const T = async (name, fn) => { const r = { name }; try { await h.reset(fixtures.base); const v = await fn(); Object.assign(r, v); r.pass = !!v.pass; } catch (e) { r.pass = false; r.error = String(e.message || e).split('\n')[0]; await h.escapeAll(); } out.push(r); process.stdout.write(`  units ${r.pass ? '✓' : '✗'} ${name} ${r.got ?? r.error ?? ''}\n`); };
  const unit = v => h.page.locator('select.sb-unit').selectOption(v).then(() => h.settle());
  const moveDx = async (txt) => { await h.selectA('FRONT', 'SS_HEM'); await h.cmd('point.moveXY'); await h.waitDialog(); const shown = await h.dlg().locator('.dlg-hint').textContent(); await h.fields({ how: 'delta', _dx: txt, _dy: '0' }); const err = await (async () => { await h.dlg().locator('.dlg-foot .btn.primary').click(); await h.settle(); return await h.hasDialog() ? await h.dlgError() : ''; })(); if (err) await h.cancel(); const st = await h.state(); return { dx: Q.r4(an(st, 'FRONT', 'SS_HEM').x - 260), shown, err }; };
  for (const [u, txt, want] of [['in16', '1 1/8', 28.575], ['in16', '1-1/8', 28.575], ['in16', '1.1/8', 28.575], ['in16', '9/8', 28.575], ['in16', '-1 1/8', -28.575], ['in16', '2cm', 20], ['in16', '30mm', 30], ['cm', '2.5', 25], ['cm', '2 1/2', 25], ['mm', '1"', 25.4], ['in0', '1.125', 28.575], ['mm', '12,5', 12.5]]) {
    await T(`Move XY dX "${txt}" in ${u}`, async () => { await unit(u); const r = await moveDx(txt); return { got: r.err ? 'rejected: ' + r.err : r.dx + ' mm', hint: r.shown, pass: !r.err && near(r.dx, want, 0.001), want }; });
  }
  await T('Inspector X "10 1/2" in in16', async () => { await unit('in16'); await h.selectA('FRONT', 'SS_HEM'); const shown = await inspInput(h, /^X/).inputValue(); await typeInto(h, inspInput(h, /^X/), '10 1/2'); const st = await h.state(); const x = an(st, 'FRONT', 'SS_HEM').x; return { got: `${x} mm (field showed "${shown}" for 260 mm)`, pass: near(x, 266.7, 0.001) }; });
  await T('Inspector shows rounded fraction then Enter without edit = no change', async () => { await unit('in16'); await h.selectA('FRONT', 'UA'); const loc = inspInput(h, /^Y/); const shown = await loc.inputValue(); const s0 = await h.stable(); await loc.click(); await loc.press('Enter'); await h.settle(); const s1 = await h.stable(); return { got: `Y shown "${shown}" (465 mm = 18.307 in); doc changed: ${s0 !== s1}`, pass: s0 === s1 }; });
  await T('Inspector: edit Y only, X keeps its exact value (no fraction rounding)', async () => { await unit('in16'); await h.selectA('FRONT', 'AH1'); await typeInto(h, inspInput(h, /^Y/), '22'); const st = await h.state(); const a = an(st, 'FRONT', 'AH1'); return { got: `AH1 x ${a.x} (was 222), y ${a.y} (want 558.8)`, pass: near(a.x, 222, 1e-4) && near(a.y, 558.8, 1e-3) }; });
  await T('Grading table cell: type "3/8" where 10 mm is displayed as "3/8" (in16, incremental L dX of UA)', async () => {
    await unit('in16'); await h.selectA('FRONT', 'UA'); await h.key('Control+g'); await h.settle(100);
    const cell = h.page.locator('.sg-wrap.gr input[data-size="L"][data-axis="dx"]'); // rows = sizes
    const shown = await cell.inputValue();
    await typeInto(h, cell, '3/8'); const st = await h.state(); const g = abs(st, 'FRONT', 'UA');
    return { got: `cell showed "${shown}" for 10 mm; after typing 3/8 + Enter: UA abs L dx ${g.L.dx} mm (want 9.525)`, pass: near(g.L.dx, 9.525, 1e-3) };
  });
  await T('Grading table cell "1/2" (in16, incremental L dX of UA) — XL follows', async () => {
    await unit('in16'); await h.selectA('FRONT', 'UA'); await h.key('Control+g'); await h.settle(100);
    const cell = h.page.locator('.sg-wrap.gr input[data-size="L"][data-axis="dx"]');
    await typeInto(h, cell, '1/2'); const st = await h.state(); const g = abs(st, 'FRONT', 'UA');
    return { got: `UA abs L dx ${g.L.dx} mm, XL dx ${g.XL.dx} mm`, pass: near(g.L.dx, 12.7, 1e-3), note: 'incremental edit of L shifts XL too (incremental convention)' };
  });
  await T('Grading table absolute view cell "1/2" (in16, L dY of UA)', async () => {
    await unit('in16'); await h.selectA('FRONT', 'UA'); await h.key('Control+g'); await h.page.locator('.gr-bar button[data-view="total"]').click(); await h.settle(80);
    const cell = h.page.locator('.sg-wrap.gr input[data-size="L"][data-axis="dy"]');
    await typeInto(h, cell, '1/2'); const st = await h.state(); const g = abs(st, 'FRONT', 'UA');
    return { got: `UA abs L dy ${g.L.dy}, XL dy ${g.XL.dy}`, pass: near(g.L.dy, 12.7, 1e-3) && near(g.XL.dy, 10, 1e-3) };
  });
  await T('Seam dialog in cm "1,5" (comma decimal)', async () => { await unit('cm'); await h.selectA('FRONT', 'SS_HEM'); await h.cmd('seam.segment'); await h.waitDialog(); await h.fill('v', '1,5'); await h.dlg().locator('.dlg-foot .btn.primary').click(); await h.settle(); const err = await h.hasDialog() ? await h.dlgError() : ''; if (err) await h.cancel(); const st = await h.state(); return { got: err ? 'rejected: ' + err : an(st, 'FRONT', 'SS_HEM').seamAfter + ' mm', pass: !err && an(st, 'FRONT', 'SS_HEM').seamAfter === 15 }; });
  await T('Status bar cursor readout follows unit (in16)', async () => { await unit('in16'); const w = await h.local2world('FRONT', { x: 254, y: 127 }); const c = await h.toClient(w); await h.page.mouse.move(c.x, c.y); await h.settle(); const t = await h.page.locator('.sb-cursor').textContent(); return { got: t, pass: /in/.test(t) && /10/.test(t) }; });
  await T('Dialog defaults shown in current unit (Rectangle 500 mm in in16)', async () => { await unit('in16'); await h.key('r'); await h.clickW({ x: 700, y: 50 }); await h.waitDialog(); const v = await h.dlg().locator('[data-key="w"]').inputValue(); const u = await h.dlg().locator('.dlg-unit .u').first().textContent(); await h.cancel(); return { got: `"${v}" ${u}`, pass: /19/.test(v) && /in/.test(u) }; });
  return out;
}

// ───────────────────────── C. nested view & size switching ─────────────────────────
async function nested(h, fixtures) {
  const out = [];
  const T = async (name, fn) => { const r = { name }; try { await h.reset(fixtures.base); Object.assign(r, await fn()); } catch (e) { r.pass = false; r.error = String(e.message || e).split('\n')[0]; await h.escapeAll(); } out.push(r); process.stdout.write(`  nested ${r.pass ? '✓' : '✗'} ${name} ${r.got ?? r.error ?? ''}\n`); };
  await T('Alt+N toggles nested view and draws every size', async () => { await h.selectPiece('FRONT'); const n0 = await h.page.locator('svg.sheet .g-world path').count(); await h.key('Alt+n'); const n1 = await h.page.locator('svg.sheet .g-world path').count(); const on = await h.ev(() => window.__e2e.app.nested); return { got: `paths ${n0} → ${n1}, nested=${on}`, pass: on && n1 > n0 }; });
  await T('Sizes panel checkbox toggles nested', async () => { await h.page.locator('.sz-top input[type=checkbox]').check(); const on = await h.ev(() => window.__e2e.app.nested); return { got: String(on), pass: on }; });
  await T('Status-bar size → L: inspector shows "X (L)" and resolved L position', async () => { await h.selectA('FRONT', 'UA'); await h.page.locator('select.sb-size').selectOption({ label: 'L' }); await h.settle(); const lab = await h.page.locator('section[data-panel="inspector"] .plabel').filter({ hasText: /^X/ }).first().textContent(); const v = await inspInput(h, /^X/).inputValue(); return { got: `${lab} = ${v}`, pass: /\(L\)/.test(lab) && near(+v, 270, 0.01) }; });
  await T('Size chip click switches active size; selection kept', async () => { await h.selectA('FRONT', 'UA'); await h.page.locator('.sz-chip', { hasText: 'XL' }).click(); await h.settle(); const s = await h.ev(() => window.__e2e.app.sizeLine().sizes.find(x => x.id === window.__e2e.app.activeSize).name); const sel = await h.sel(); return { got: `${s}, sel ${sel.anchors}`, pass: s === 'XL' && sel.anchors[0] === 'FRONT/UA' }; });
  await T('Ctrl+] / Ctrl+[ step sizes', async () => { await h.key('Control+]'); await h.key('Control+]'); const a = await h.ev(() => window.__e2e.app.sizeLine().sizes.find(x => x.id === window.__e2e.app.activeSize).name); await h.key('Control+['); const b = await h.ev(() => window.__e2e.app.sizeLine().sizes.find(x => x.id === window.__e2e.app.activeSize).name); return { got: `${a} then ${b}`, pass: a === 'XL' && b === 'L' }; });
  await T('Nested view: drag the L instance of UA → only L grading of UA changes', async () => {
    await h.selectA('FRONT', 'UA'); await h.key('Alt+n'); if (await hasMove(h)) { await h.key('g'); const sid = await h.ev(() => window.__e2e.sizeId('L')); const wl = await h.W('FRONT', 'UA', sid); const st0 = await h.state(); await h.dragW(wl, { x: wl.x + 15, y: wl.y }, { steps: 10 }); const st1 = await h.state(); const g0 = abs(st0, 'FRONT', 'UA'), g1 = abs(st1, 'FRONT', 'UA'); const others = anchorDiff(st0, st1, 'FRONT').filter(d => d.name !== 'UA'); return { got: `Move Point on the L instance: UA abs L ${JSON.stringify(g0.L)}→${JSON.stringify(g1.L)}, XL ${JSON.stringify(g0.XL)}→${JSON.stringify(g1.XL)}, base x ${Q.r4(an(st1, 'FRONT', 'UA').x)}, others ${others.length}`, pass: g1.L.dx > 20 && near(g1.XL.dx, 20, 1e-3) && !others.length }; }
    const sid = await h.ev(() => window.__e2e.sizeId('L'));
    const c = await h.ev(sid => { const E = window.__e2e; const id = E.findA('FRONT', 'UA').a.id; const el = document.querySelector(`circle[data-hit="anchor"][data-anchor="${id}"][data-size="${sid}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sid);
    if (!c) return { got: 'no L hit target for UA in nested view', pass: false };
    const st0 = await h.state(), pos0 = await allPos(h, 'FRONT');
    await h.page.mouse.move(c.x, c.y); await h.page.mouse.down(); for (let i = 1; i <= 8; i++) await h.page.mouse.move(c.x + i * 2, c.y); await h.page.mouse.up(); await h.settle(60);
    const st1 = await h.state(), pos1 = await allPos(h, 'FRONT');
    const g0 = abs(st0, 'FRONT', 'UA'), g1 = abs(st1, 'FRONT', 'UA');
    const others = anchorDiff(st0, st1, 'FRONT').filter(d => d.name !== 'UA');
    const ua0 = pos0['sew:UA'], ua1 = pos1['sew:UA'];
    const moved = Object.keys(ua0).filter(k => Math.hypot(ua0[k].x - ua1[k].x, ua0[k].y - ua1[k].y) > 1e-3);
    const names = []; for (const k of moved) names.push(await sizeName(h, k));
    return { got: `UA abs L ${JSON.stringify(g0.L)}→${JSON.stringify(g1.L)}; sizes whose UA moved: ${names.join(',')}; other anchors changed: ${others.length}`, pass: names.join() === 'L' && !others.length, sizesMoved: names };
  });
  await T('Non-base size: Move XY edits grading only (title says so)', async () => { await h.selectA('FRONT', 'UA'); await h.page.locator('select.sb-size').selectOption({ label: 'L' }); await h.cmd('point.moveXY'); await h.waitDialog(); const t = await h.dlgTitle(); await h.fields({ how: 'delta', _dx: '4', _dy: '0' }); await h.ok(); const st = await h.state(); const g = abs(st, 'FRONT', 'UA'); return { got: `${t}; UA abs L dx ${g.L.dx}, XL dx ${g.XL.dx}, base x ${an(st, 'FRONT', 'UA').x}`, pass: /grading only/.test(t) && near(g.L.dx, 14, 1e-3) && near(g.XL.dx, 20, 1e-3) }; });
  await T('Non-base size: arrow nudge edits only that size', async () => { await h.selectA('FRONT', 'UA'); await h.page.locator('select.sb-size').selectOption({ label: 'L' }); if (await hasMove(h)) await h.key('g'); await h.key('Shift+ArrowRight'); const st = await h.state(); const g = abs(st, 'FRONT', 'UA'); return { got: `UA abs L dx ${g.L.dx}, XL dx ${g.XL.dx}`, pass: near(g.L.dx, 20, 1e-3) && near(g.XL.dx, 20, 1e-3) }; });
  return out;
}

// ───────────────────────── D. Select-tool drags ─────────────────────────
async function drags(h, fixtures) {
  if (await hasMove(h)) return dragsHead(h, fixtures);
  const out = [];
  const T = async (name, fn) => { const r = { name }; try { await h.reset(fixtures.base); Object.assign(r, await fn()); } catch (e) { r.pass = false; r.error = String(e.message || e).split('\n')[0]; await h.escapeAll(); } out.push(r); process.stdout.write(`  drag ${r.pass ? '✓' : '✗'} ${name} ${r.got ?? r.error ?? ''}\n`); };
  const rev = () => h.ev(() => window.__e2e.app.doc.revision());
  await T('Click a point, then drag it straight away (< 450 ms)', async () => { await h.selectA('FRONT', 'UA'); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y }); const st = await h.state(); const a = an(st, 'FRONT', 'UA'); const lbl = await h.ev(() => window.__e2e.app.doc.undoLabel()); return { got: `UA.x ${Q.r4(a.x)} smooth=${a.smooth}; last undo step "${lbl}"`, pass: a.x > 270 && !a.smooth }; });
  await T('Point drag moves the point, one undo step', async () => { await h.selectA('FRONT', 'UA'); await h.page.waitForTimeout(600); const r0 = await rev(); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y + 5 }); const st = await h.state(); const a = an(st, 'FRONT', 'UA'); const r1 = await rev(); await h.key('Control+z'); const back = an(await h.state(), 'FRONT', 'UA'); return { got: `UA (${Q.r4(a.x)},${Q.r4(a.y)}); revisions ${r1 - r0}; undo → (${Q.r4(back.x)},${Q.r4(back.y)})`, pass: a.x > 270 && r1 - r0 === 1 && near(back.x, 260, 1e-3) }; });
  await T('Drag an UNSELECTED point directly (no prior click)', async () => { const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y }); const st = await h.state(); return { got: `UA.x ${Q.r4(an(st, 'FRONT', 'UA').x)}; FRONT layout ${JSON.stringify(pc(st, 'FRONT').layout)}`, pass: an(st, 'FRONT', 'UA').x > 270 }; });
  await T('Drag an unselected CURVE point directly', async () => { const w = await h.W('FRONT', 'AH1'); await h.dragW(w, { x: w.x + 20, y: w.y }); const st = await h.state(); return { got: `AH1.x ${Q.r4(an(st, 'FRONT', 'AH1').x)} (was 222); FRONT layout ${JSON.stringify(pc(st, 'FRONT').layout || null)}`, pass: an(st, 'FRONT', 'AH1').x > 230 && !pc(st, 'FRONT').layout }; });
  await T('Shift-drag constrains to horizontal', async () => { await h.selectA('FRONT', 'UA'); await h.page.waitForTimeout(600); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 30, y: w.y + 4 }, { mods: ['Shift'] }); const a = an(await h.state(), 'FRONT', 'UA'); return { got: `UA (${Q.r4(a.x)},${Q.r4(a.y)})`, pass: near(a.y, 465, 1e-3) && a.x > 280 }; });
  await T('Esc during a point drag cancels', async () => { await h.selectA('FRONT', 'UA'); await h.page.waitForTimeout(600); const w = await h.W('FRONT', 'UA'); const s0 = await h.stable(); await h.dragW(w, { x: w.x + 30, y: w.y }, { beforeUp: () => h.page.keyboard.press('Escape') }); const s1 = await h.stable(); const sel = await h.sel(); return { got: `doc changed ${s0 !== s1}; selection after Esc: ${JSON.stringify(sel.anchors)}`, pass: s0 === s1, selectionLost: !sel.anchors.length }; });
  await T('Handle drag reshapes, mirrored opposite handle', async () => {
    await h.selectA('FRONT', 'AH1');
    const c = await h.ev(() => { const E = window.__e2e; const id = E.findA('FRONT', 'AH1').a.id; const el = document.querySelector(`circle[data-hit="handle"][data-anchor="${id}"][data-which="out"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (!c) return { got: 'no handle hit target on selected curve point AH1', pass: false };
    const st0 = await h.state();
    await h.page.mouse.move(c.x, c.y); await h.page.mouse.down(); for (let i = 1; i <= 6; i++) await h.page.mouse.move(c.x + i * 3, c.y - i * 2); await h.page.mouse.up(); await h.settle();
    const st1 = await h.state(); const a = an(st1, 'FRONT', 'AH1');
    const others = anchorDiff(st0, st1, 'FRONT').filter(d => d.name !== 'AH1');
    const col = a.hIn && a.hOut ? Math.abs(a.hIn.x * a.hOut.y - a.hIn.y * a.hOut.x) / (Math.hypot(a.hIn.x, a.hIn.y) * Math.hypot(a.hOut.x, a.hOut.y)) : 1;
    return { got: `hOut ${JSON.stringify(a.hOut)}, hIn ${JSON.stringify(a.hIn)}, collinear sin=${col.toFixed(4)}, other anchors changed ${others.length}`, pass: !!a.hOut && col < 1e-3 && !others.length };
  });
  await T('Alt+handle drag breaks the handle', async () => {
    await h.selectA('FRONT', 'AH1');
    const c = await h.ev(() => { const E = window.__e2e; const id = E.findA('FRONT', 'AH1').a.id; const el = document.querySelector(`circle[data-hit="handle"][data-anchor="${id}"][data-which="out"]`); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await h.page.keyboard.down('Alt'); await h.page.mouse.move(c.x, c.y); await h.page.mouse.down(); for (let i = 1; i <= 6; i++) await h.page.mouse.move(c.x + i * 3, c.y + i * 3); await h.page.mouse.up(); await h.page.keyboard.up('Alt'); await h.settle();
    const a = an(await h.state(), 'FRONT', 'AH1'); return { got: `smooth=${a.smooth}`, pass: a.smooth === false };
  });
  await T('Piece drag moves layout only, one undo step', async () => { await h.selectPiece('BACK'); const r0 = await rev(); const w = await h.local2world('BACK', { x: 520, y: 300 }); await h.dragW(w, { x: w.x + 50, y: w.y + 20 }); const st = await h.state(); const L = pc(st, 'BACK').layout; return { got: `layout ${JSON.stringify(L)}; revisions ${(await rev()) - r0}`, pass: !!L && near(L.x, 50, 2) && near(L.y, 20, 2) && (await rev()) - r0 === 1 }; });
  await T('Marquee selects the points inside', async () => { const a = { x: -20, y: -20 }, b = { x: 300, y: 30 }; await h.ensureSelect(); await h.dragW(a, b); const sel = await h.sel(); return { got: JSON.stringify(sel.anchors), pass: sel.anchors.includes('FRONT/CF_HEM') && sel.anchors.includes('FRONT/SS_HEM') && sel.anchors.length === 2 }; });
  await T('Marquee + Shift adds to the selection', async () => { await h.selectA('FRONT', 'HPS'); await h.dragW({ x: -20, y: -20 }, { x: 300, y: 30 }, { mods: ['Shift'] }); const sel = await h.sel(); return { got: JSON.stringify(sel.anchors), pass: sel.anchors.length === 3 }; });
  await T('Multi-point drag moves all selected points together', async () => { await h.selectA('FRONT', 'SS_HEM'); await h.selectA('FRONT', 'UA', true); await h.page.waitForTimeout(600); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y }); const st = await h.state(); return { got: `SS_HEM.x ${Q.r4(an(st, 'FRONT', 'SS_HEM').x)} UA.x ${Q.r4(an(st, 'FRONT', 'UA').x)}`, pass: near(an(st, 'FRONT', 'SS_HEM').x - 260, an(st, 'FRONT', 'UA').x - 260, 1e-6) && an(st, 'FRONT', 'UA').x > 270 }; });
  await T('Alt-click toggles corner ⇄ smooth', async () => { await h.clickA('FRONT', 'UA', { mods: ['Alt'] }); const a = an(await h.state(), 'FRONT', 'UA'); return { got: `smooth=${a.smooth}`, pass: a.smooth === true }; });
  await T('Drag snaps the point onto another point (8 px)', async () => { await h.selectA('FRONT', 'UA'); await h.page.waitForTimeout(600); const w = await h.W('FRONT', 'UA'); const t = await h.W('FRONT', 'SS_HEM'); await h.dragW(w, { x: t.x + 3, y: t.y + 200 }); const a = an(await h.state(), 'FRONT', 'UA'); return { got: `UA (${Q.r4(a.x)},${Q.r4(a.y)})`, pass: true, info: 'informational' }; });
  return out;
}

/** Drag interactions at HEAD: Select only selects; geometry moves with the Move tools. */
async function dragsHead(h, fixtures) {
  const out = [];
  const T = async (name, fn) => { const r = { name }; try { await h.reset(fixtures.base); Object.assign(r, await fn()); } catch (e) { r.pass = false; r.error = String(e.message || e).split('\n')[0]; await h.escapeAll(); } out.push(r); process.stdout.write(`  drag ${r.pass ? '✓' : '✗'} ${name} ${r.got ?? r.error ?? ''}\n`); };
  const rev = () => h.ev(() => window.__e2e.app.doc.revision());
  const ua = async () => an(await h.state(), 'FRONT', 'UA');
  await T('Select: dragging a point never changes the document (box select instead)', async () => { const s0 = await h.stable(); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 30, y: w.y + 10 }); const s1 = await h.stable(); return { got: `doc changed ${s0 !== s1}; selection ${JSON.stringify((await h.sel()).anchors)}`, pass: s0 === s1 }; });
  await T('Select: dragging a piece by its inside moves the piece (layout only, one undo step); the shape does not change', async () => {
    const shape = () => h.ev(() => JSON.stringify(window.__e2e.app.style.pieces.map(p => [p.sew, p.internals])));
    const lay = () => h.ev(() => { const p = window.__e2e.app.style.pieces.find(x => x.name === 'BACK'); return { x: p.layout?.x ?? 0, y: p.layout?.y ?? 0 }; });
    const g0 = await shape(), l0 = await lay(), r0 = await rev();
    const w = await h.local2world('BACK', { x: 520, y: 300 }); await h.dragW(w, { x: w.x + 50, y: w.y + 20 }, { steps: 8 });
    const l1 = await lay(), steps = (await rev()) - r0, same = g0 === await shape();
    await h.key('Control+z'); const l2 = await lay();
    return { got: `layout ${JSON.stringify(l0)} → ${JSON.stringify(l1)}; ${steps} undo step(s); shape unchanged ${same}; after undo ${JSON.stringify(l2)}`, pass: Math.abs(l1.x - l0.x - 50) < 0.5 && Math.abs(l1.y - l0.y - 20) < 0.5 && steps === 1 && same && Math.abs(l2.x - l0.x) < 1e-6 };
  });
  await T('Select: Alt+drag that starts inside a piece is a box select; nothing moves', async () => {
    const s0 = await h.stable(); const w = await h.local2world('BACK', { x: 520, y: 300 });
    await h.page.keyboard.down('Alt'); await h.dragW(w, { x: w.x + 50, y: w.y + 20 }, { steps: 6 }); await h.page.keyboard.up('Alt');
    return { got: `doc changed ${s0 !== await h.stable()}`, pass: s0 === await h.stable() };
  });
  await T('Move Point: press on an UNSELECTED grade point and drag', async () => { await h.key('g'); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y }, { steps: 10 }); const a = await ua(); return { got: `UA.x ${Q.r4(a.x)}`, pass: a.x > 270 }; });
  await T('Move Point: click a point then drag it straight away (< 450 ms)', async () => { await h.key('g'); const w = await h.W('FRONT', 'UA'); const r0 = await rev(); await h.clickW(w); await h.dragW(w, { x: w.x + 20, y: w.y }, { steps: 10 }); const a = await ua(); const lbl = await h.ev(() => window.__e2e.app.doc.undoLabel()) + ` (${(await rev()) - r0} undo step(s); status "${await h.ev(() => window.__e2e.app.statusMsg)}")`; return { got: `UA.x ${Q.r4(a.x)} smooth=${a.smooth}; last undo "${lbl}"`, pass: a.x > 265 && !a.smooth, info: 'click = pick up (carry); the next press puts it down' }; });
  await T('Move Point: drag an unselected CURVE point (AH1)', async () => { await h.key('g'); const w = await h.W('FRONT', 'AH1'); await h.dragW(w, { x: w.x + 20, y: w.y }, { steps: 10 }); const st = await h.state(); return { got: `AH1.x ${Q.r4(an(st, 'FRONT', 'AH1').x)} (was 222); FRONT layout ${JSON.stringify(pc(st, 'FRONT').layout || null)}`, pass: an(st, 'FRONT', 'AH1').x > 230 }; });
  await T('Move Point: one undo step per drag', async () => { await h.key('g'); const r0 = await rev(); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y + 5 }, { steps: 10 }); const r1 = await rev(); await h.key('Control+z'); const b = await ua(); return { got: `revisions ${r1 - r0}; undo → (${Q.r4(b.x)},${Q.r4(b.y)})`, pass: r1 - r0 === 1 && near(b.x, 260, 1e-3) }; });
  await T('Move Point: Shift constrains to horizontal', async () => { await h.key('g'); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 30, y: w.y + 4 }, { mods: ['Shift'], steps: 10 }); const a = await ua(); return { got: `UA (${Q.r4(a.x)},${Q.r4(a.y)})`, pass: near(a.y, 465, 1e-3) && a.x > 280 }; });
  await T('Move Point: Esc during the drag cancels, selection kept', async () => { await h.key('g'); const w = await h.W('FRONT', 'UA'); const s0 = await h.stable(); await h.dragW(w, { x: w.x + 30, y: w.y }, { beforeUp: () => h.page.keyboard.press('Escape') }); const s1 = await h.stable(); const sel = await h.sel(); return { got: `doc changed ${s0 !== s1}; selection ${JSON.stringify(sel.anchors)}`, pass: s0 === s1 && sel.anchors.length === 1 }; });
  await T('Move Point: snaps onto another point within 8 px', async () => { await h.key('g'); const w = await h.W('FRONT', 'UA'); const t = await h.W('FRONT', 'SS_HEM'); await h.dragW(w, { x: t.x + 3 / 0.9, y: t.y + 120 }, { steps: 10 }); const a = await ua(); return { got: `UA (${Q.r4(a.x)},${Q.r4(a.y)})`, pass: true, info: 'informational' }; });
  await T('Move Point · Group: all selected points move together', async () => { await h.selectA('FRONT', 'SS_HEM'); await h.selectA('FRONT', 'UA', true); await h.cmd('move.group'); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y }, { steps: 10 }); const st = await h.state(); return { got: `SS_HEM.x ${Q.r4(an(st, 'FRONT', 'SS_HEM').x)} UA.x ${Q.r4(an(st, 'FRONT', 'UA').x)}`, pass: near(an(st, 'FRONT', 'SS_HEM').x - 260, an(st, 'FRONT', 'UA').x - 260, 1e-6) && an(st, 'FRONT', 'UA').x > 270 }; });
  await T('Move Point · Group: drag a box on the sheet selects the points inside, then they move together', async () => {
    await h.cmd('move.group'); const a = await h.W('FRONT', 'SS_HEM'), b = await h.W('FRONT', 'UA');
    await h.dragW({ x: Math.min(a.x, b.x) - 25, y: Math.min(a.y, b.y) - 25 }, { x: Math.max(a.x, b.x) + 25, y: Math.max(a.y, b.y) + 25 }, { steps: 8 });
    const n = await h.ev(() => window.__e2e.app.sel.anchors.length); const s0 = await h.state(); const r0 = await rev();
    await h.dragW(b, { x: b.x + 20, y: b.y }, { steps: 10 }); const st = await h.state();
    const d1 = an(st, 'FRONT', 'SS_HEM').x - an(s0, 'FRONT', 'SS_HEM').x, d2 = an(st, 'FRONT', 'UA').x - an(s0, 'FRONT', 'UA').x;
    return { got: `${n} point(s) boxed; SS_HEM dx ${Q.r4(d1)} UA dx ${Q.r4(d2)}; ${await rev() - r0} undo step(s)`, pass: n >= 2 && d2 > 10 && near(d1, d2, 1e-6) && await rev() - r0 === 1 };
  });
  await T('Move Point · Group: Shift+box adds to the selection; a click on the sheet changes nothing', async () => {
    await h.cmd('move.group'); const a = await h.W('FRONT', 'SS_HEM'), b = await h.W('FRONT', 'HPS');
    await h.dragW({ x: a.x - 20, y: a.y - 20 }, { x: a.x + 20, y: a.y + 20 }, { steps: 6 }); const n1 = await h.ev(() => window.__e2e.app.sel.anchors.length);
    await h.dragW({ x: b.x - 15, y: b.y + 40 }, { x: b.x + 15, y: b.y - 15 }, { steps: 6, mods: ['Shift'] }); const n2 = await h.ev(() => window.__e2e.app.sel.anchors.length);
    const s0 = await h.stable(); await h.clickW({ x: a.x + 300, y: a.y - 200 }); const n3 = await h.ev(() => window.__e2e.app.sel.anchors.length);
    return { got: `box ${n1}, Shift+box ${n2}, after click ${n3}; doc changed ${s0 !== await h.stable()}`, pass: n1 >= 1 && n2 > n1 && n3 === n2 && s0 === await h.stable() };
  });
  await T('Move Point · Single: drag a line where it has no point adds a point there and moves it (one undo step)', async () => {
    await h.key('g'); const np = () => h.ev(() => window.__e2e.P('FRONT').sew.points.length); const n0 = await np(); const r0 = await rev();
    const w = await h.along('FRONT', 'SS_HEM', 'UA', 0.5);
    await h.dragW(w, { x: w.x + 18, y: w.y + 3 }, { steps: 10, mods: ['Alt'] });
    const n1 = await np(); const steps = await rev() - r0;
    const pos = await h.ev(() => { const E = window.__e2e, a = E.app.sel.anchors[0]; return a ? E.ops.pointPos(E.app.doc, a, E.app.doc.baseSize(E.P('FRONT'))) : null; });
    await h.key('Control+z'); const n2 = await np();
    return { got: `points ${n0} → ${n1} → undo ${n2}; ${steps} undo step(s); new point at ${pos ? Q.r4(pos.x) + ', ' + Q.r4(pos.y) : 'none'}`, pass: n1 === n0 + 1 && steps === 1 && n2 === n0 && !!pos };
  });
  await T('Move Point · Single: a click on a line (no drag) adds nothing', async () => {
    await h.key('g'); const s0 = await h.stable(); const r0 = await rev();
    await h.clickW(await h.along('FRONT', 'SS_HEM', 'UA', 0.4));
    return { got: `doc changed ${s0 !== await h.stable()}; ${await rev() - r0} undo step(s)`, pass: s0 === await h.stable() && await rev() === r0 };
  });
  await T('Move Point: right-click on the selected point opens the movement box with blank fields; on a blank area the canvas menu', async () => {
    await h.selectA('FRONT', 'UA'); await h.key('g'); const w = await h.W('FRONT', 'UA');
    await h.clickW({ x: w.x + 300, y: w.y + 150 }, { button: 'right' }); const box1 = await h.page.locator('.ibox').count(), menu1 = await h.page.locator('.ctx-menu').count();
    await h.page.keyboard.press('Escape'); await h.settle(40);
    await h.selectA('FRONT', 'UA'); await h.key('g');
    await h.clickW(w, { button: 'right' }); await h.page.waitForSelector('.ibox', { timeout: 2000 });
    const vals = await h.page.locator('.ibox input[type=text]').evaluateAll(els => els.map(e => e.value));
    await h.page.keyboard.press('Escape'); await h.settle(40);
    return { got: `blank area: box ${box1}, canvas menu ${menu1}; fields on the point ${JSON.stringify(vals)}`, pass: box1 === 0 && menu1 === 1 && vals.length >= 2 && vals.every(v => v === '') };
  });
  await T('Move Point · Single: a smooth grade point is a split, the line beyond it keeps its shape', async () => {
    await h.ev(() => { const E = window.__e2e; E.app.doc.transact('smooth SH', () => { E.findA('FRONT', 'SH').a.smooth = true; }); E.app.invalidate(); });
    const far = () => h.ev(() => { const E = window.__e2e; const o = E.handleW('FRONT', 'SH', 'out'); return `${E.segLen('FRONT', 'SH', 'HPS').toFixed(6)} ${o.x.toFixed(6)} ${o.y.toFixed(6)}`; });
    const near = () => h.ev(() => window.__e2e.segLen('FRONT', 'UA', 'SH'));
    const f0 = await far(), n0 = await near(); const r0 = await rev();
    await h.key('g'); const w = await h.W('FRONT', 'AH2'); await h.dragW(w, { x: w.x + 14, y: w.y + 5 }, { steps: 8, mods: ['Alt'] });
    const f1 = await far(), n1 = await near(); const held = await h.ev(() => !!window.__e2e.findA('FRONT', 'SH').a.hHold?.hOut);
    return { got: `beyond SH ${f0} → ${f1}; armhole ${Q.r4(n0)} → ${Q.r4(n1)}; SH holds its far side ${held}; ${await rev() - r0} undo step(s)`, pass: f0 === f1 && Math.abs(n1 - n0) > 0.5 && held && await rev() - r0 === 1 };
  });
  await T('Handles are drawn for the last selected point only', async () => {
    await h.selectA('FRONT', 'AH1'); const one = await h.page.locator('[data-hit="handle"]').count();
    await h.selectA('FRONT', 'AH2', true); const two = await h.page.locator('[data-hit="handle"]').count();
    return { got: `1 point: ${one} handle(s); 2 points: ${two} handle(s)`, pass: one === 2 && two === 2 };
  });
  await T('Move Point · Group: a box that includes the end of a locked internal line still moves; the locked end follows the outline', async () => {
    const n = await h.ev(() => { const E = window.__e2e, p = E.P('FRONT'); E.ops.movePoint(E.app.doc, p.id, E.findA('FRONT', 'IL_A').a.id, { dx: 0, dy: -80 }); const k = E.ops.lockInternalEnds(E.app.doc, p.id, p.internals[0].id); E.app.invalidate(); return k; });
    await h.cmd('move.group'); const a = await h.W('FRONT', 'CF_HEM'), b = await h.W('FRONT', 'SS_HEM');
    await h.dragW({ x: a.x - 25, y: a.y - 25 }, { x: b.x + 25, y: b.y + 25 }, { steps: 8 });
    const sel = await h.ev(() => window.__e2e.app.sel.anchors.length); const r0 = await rev(); const y0 = (await h.ev(() => window.__e2e.L('FRONT', 'IL_A'))).y;
    await h.dragW(b, { x: b.x, y: b.y - 20 }, { steps: 10, mods: ['Alt'] });
    const st = await h.state(); const y1 = (await h.ev(() => window.__e2e.L('FRONT', 'IL_A'))).y;
    return { got: `${n} end(s) locked; ${sel} points boxed; SS_HEM.y ${Q.r4(an(st, 'FRONT', 'SS_HEM').y)} CF_HEM.y ${Q.r4(an(st, 'FRONT', 'CF_HEM').y)}; locked end y ${Q.r4(y0)} → ${Q.r4(y1)}; ${await rev() - r0} undo step(s)`, pass: n >= 1 && sel >= 3 && near(an(st, 'FRONT', 'SS_HEM').y, -20, 1e-3) && near(an(st, 'FRONT', 'CF_HEM').y, -20, 1e-3) && near(y1 - y0, -20, 1e-3) && await rev() - r0 === 1 };
  });
  await T('Curve tool: click a line, drag one of its two handles: only that line changes, its curve points become one curve, one undo step', async () => {
    await h.ev(() => window.__e2e.app.setTool('curve')); await h.settle(40);
    await h.clickW(await h.along('FRONT', 'UA', 'SH', 0.5)); await h.settle(40);
    const shown = await h.page.locator('[data-seg-handle]').count();
    const info = () => h.ev(() => { const E = window.__e2e, p = E.P('FRONT'); const sc = E.ops.segmentCurve(p, E.app.doc.sizeLine(p), p.sew.id, E.findA('FRONT', 'UA').a.id, E.findA('FRONT', 'SH').a.id); return { h0: E.localToWorld('FRONT', sc.h0), len: sc.length, between: sc.between, n: p.sew.points.length, side: E.segLen('FRONT', 'SS_HEM', 'UA'), sh: E.segLen('FRONT', 'SH', 'HPS') }; });
    const a = await info(); const r0 = await rev();
    await h.dragW(a.h0, { x: a.h0.x + 30, y: a.h0.y + 10 }, { steps: 8 });
    const b = await info(); const steps = await rev() - r0;
    await h.key('Control+z'); const c = await info();
    return { got: `${shown} handles; points ${a.n} → ${b.n} → undo ${c.n}; line ${Q.r4(a.len)} → ${Q.r4(b.len)}; side seam ${Q.r4(a.side)} → ${Q.r4(b.side)}; shoulder ${Q.r4(a.sh)} → ${Q.r4(b.sh)}; ${steps} undo step(s)`,
      pass: shown === 2 && a.between === 2 && b.n === a.n - 2 && b.between === 0 && Math.abs(b.len - a.len) > 0.05 && near(a.side, b.side, 1e-6) && near(a.sh, b.sh, 1e-6) && steps === 1 && c.n === a.n };
  });
  await T('Curve tool: a straight line gets two handles and bends when one is dragged', async () => {
    await h.ev(() => window.__e2e.app.setTool('curve')); await h.settle(40);
    await h.clickW(await h.along('FRONT', 'SS_HEM', 'UA', 0.5)); await h.settle(40);
    const info = () => h.ev(() => { const E = window.__e2e, p = E.P('FRONT'); const sc = E.ops.segmentCurve(p, E.app.doc.sizeLine(p), p.sew.id, E.findA('FRONT', 'SS_HEM').a.id, E.findA('FRONT', 'UA').a.id); return { h3: E.localToWorld('FRONT', sc.h3), len: sc.length, hem: E.segLen('FRONT', 'CF_HEM', 'SS_HEM'), ah: E.segLen('FRONT', 'UA', 'SH') }; });
    const a = await info(); await h.dragW(a.h3, { x: a.h3.x + 25, y: a.h3.y }, { steps: 8 }); const b = await info();
    return { got: `side seam ${Q.r4(a.len)} → ${Q.r4(b.len)}; hem ${Q.r4(a.hem)} → ${Q.r4(b.hem)}; armhole ${Q.r4(a.ah)} → ${Q.r4(b.ah)}`, pass: b.len > a.len + 0.5 && near(a.hem, b.hem, 1e-6) && near(a.ah, b.ah, 1e-6) };
  });
  await T('Move Point · Single with a multi-selection moves only the grabbed point', async () => { await h.selectA('FRONT', 'SS_HEM'); await h.selectA('FRONT', 'UA', true); await h.key('g'); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y }, { steps: 10 }); const st = await h.state(); return { got: `SS_HEM.x ${Q.r4(an(st, 'FRONT', 'SS_HEM').x)} UA.x ${Q.r4(an(st, 'FRONT', 'UA').x)}`, pass: near(an(st, 'FRONT', 'SS_HEM').x, 260, 1e-3) && an(st, 'FRONT', 'UA').x > 270 }; });
  await T('Curve tool: handle drag reshapes, opposite handle mirrored', async () => { await h.key('Shift+C'); await h.clickA('FRONT', 'AH1'); const w = await h.ev(() => window.__e2e.handleW('FRONT', 'AH1', 'out')); const st0 = await h.state(); await h.dragW(w, { x: w.x + 8, y: w.y + 10 }, { steps: 8 }); const st1 = await h.state(); const a = an(st1, 'FRONT', 'AH1'); const others = anchorDiff(st0, st1, 'FRONT').filter(d => d.name !== 'AH1'); const col = a.hIn && a.hOut ? Math.abs(a.hIn.x * a.hOut.y - a.hIn.y * a.hOut.x) / (Math.hypot(a.hIn.x, a.hIn.y) * Math.hypot(a.hOut.x, a.hOut.y)) : 1; return { got: `hOut ${JSON.stringify(a.hOut)} hIn ${JSON.stringify(a.hIn)} sin=${col.toFixed(4)} others ${others.length}`, pass: !!a.hOut && col < 1e-3 && !others.length }; });
  await T('Curve tool: Alt+handle drag breaks the pair', async () => { await h.key('Shift+C'); await h.clickA('FRONT', 'AH1'); const w = await h.ev(() => window.__e2e.handleW('FRONT', 'AH1', 'out')); await h.dragW(w, { x: w.x + 8, y: w.y + 10 }, { steps: 8, mods: ['Alt'] }); const a = an(await h.state(), 'FRONT', 'AH1'); return { got: `smooth=${a.smooth}`, pass: a.smooth === false }; });
  await T('Curve tool: Shift+click toggles corner ⇄ smooth', async () => { await h.key('Shift+C'); await h.clickA('FRONT', 'UA', { mods: ['Shift'] }); const a = an(await h.state(), 'FRONT', 'UA'); return { got: `smooth=${a.smooth}`, pass: a.smooth === true }; });
  await T('Rotate by point: the pin stays where it is, the piece turns 90°, one undo step', async () => {
    await h.key('Control+Shift+G'); const r0 = await rev(); const w = await h.local2world('BACK', { x: 520, y: 300 });
    await h.clickW(w); await h.dragW({ x: w.x + 100, y: w.y }, { x: w.x, y: w.y + 100 }, { steps: 12, mods: ['Alt'] });
    const L = pc(await h.state(), 'BACK').layout; const w1 = await h.local2world('BACK', { x: 520, y: 300 });
    return { got: `layout ${JSON.stringify(L)}; pin moved ${Q.r4(Math.hypot(w1.x - w.x, w1.y - w.y))}; revisions ${(await rev()) - r0}`, pass: !!L && near(L.angleDeg, 90, 1.5) && Math.hypot(w1.x - w.x, w1.y - w.y) < 0.01 && (await rev()) - r0 === 1 };
  });
  await T('Rotate · Piece with "Keep grain direction": the piece turns, the grain keeps its direction on the sheet', async () => {
    const gdir = () => h.ev(() => { const E = window.__e2e, p = E.P('BACK'); const a = E.localToWorld('BACK', p.grain.a), b = E.localToWorld('BACK', p.grain.b); return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; });
    const g0 = await gdir();
    await h.ev(() => { const E = window.__e2e; E.settings.rotateKeepGrain = true; E.settings.rotateMode = 'piece'; });
    await h.selectPiece('BACK'); await h.key('Control+Shift+G'); await h.key('4'); await h.page.waitForSelector('.ibox', { timeout: 2000 }); const ib = h.page.locator('.ibox input').first(); await ib.fill('45'); await ib.press('Enter'); await h.settle();
    const L = pc(await h.state(), 'BACK').layout; const g1 = await gdir();
    await h.ev(() => { window.__e2e.settings.rotateKeepGrain = false; });
    return { got: `angle ${L && L.angleDeg}; grain direction ${Q.r4(g0)}° → ${Q.r4(g1)}°`, pass: !!L && near(L.angleDeg, 45, 0.01) && near(g0, g1, 0.01) };
  });
  await T('Rotate · Piece without "Keep grain direction": the grain turns with the piece', async () => {
    const gdir = () => h.ev(() => { const E = window.__e2e, p = E.P('BACK'); const a = E.localToWorld('BACK', p.grain.a), b = E.localToWorld('BACK', p.grain.b); return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; });
    const g0 = await gdir(); await h.ev(() => { window.__e2e.settings.rotateMode = 'piece'; });
    await h.selectPiece('BACK'); await h.key('Control+Shift+G'); await h.key('4'); await h.page.waitForSelector('.ibox', { timeout: 2000 }); const ib = h.page.locator('.ibox input').first(); await ib.fill('45'); await ib.press('Enter'); await h.settle();
    const g1 = await gdir(); let d = g1 - g0; d = ((d % 360) + 360) % 360;
    return { got: `grain direction ${Q.r4(g0)}° → ${Q.r4(g1)}°`, pass: near(d, 45, 0.01) };
  });
  await T('Select: arrow keys move the selected piece (layout only)', async () => {
    await h.selectPiece('BACK'); const s0 = JSON.stringify(pc(await h.state(), 'BACK').sew); await h.key('Shift+ArrowRight');
    const st = await h.state(); const L = pc(st, 'BACK').layout;
    return { got: `layout ${JSON.stringify(L)}`, pass: !!L && near(L.x, 10, 0.01) && JSON.stringify(pc(st, 'BACK').sew) === s0 };
  });
  await T('Move / Copy Line · Follow shape + Copy: the hem stays, an internal line appears between the side lines', async () => {
    await h.ev(() => { const E = window.__e2e; E.settings.moveLineMode = 'prop'; E.settings.moveLineCopy = true; });
    await h.key('Shift+G'); const w = await h.along('FRONT', 'CF_HEM', 'SS_HEM', 0.5); const s0 = JSON.stringify(pc(await h.state(), 'FRONT').sew); const n0 = pc(await h.state(), 'FRONT').internals.length; const r0 = await rev();
    await h.dragW(w, { x: w.x, y: w.y + 60 }, { steps: 10 });
    const st = await h.state(); const f = pc(st, 'FRONT'); const c = f.internals[f.internals.length - 1]; const a = c.points[0], b = c.points[c.points.length - 1];
    await h.ev(() => { window.__e2e.settings.moveLineCopy = false; });
    return { got: `internals ${n0} → ${f.internals.length}; copy from (${Q.r4(a.x)},${Q.r4(a.y)}) to (${Q.r4(b.x)},${Q.r4(b.y)}); outline changed ${JSON.stringify(f.sew) !== s0}; ${(await rev()) - r0} undo step(s)`,
      pass: f.internals.length === n0 + 1 && JSON.stringify(f.sew) === s0 && near(a.y, 60, 0.5) && near(b.y, 60, 0.5) && near(Math.abs(b.x - a.x), 260, 0.5) && (await rev()) - r0 === 1 };
  });
  await T('Move / Copy Line · Parallel + Copy: an offset copy as an internal line', async () => {
    await h.ev(() => { const E = window.__e2e; E.settings.moveLineMode = 'parallel'; E.settings.moveLineCopy = true; });
    await h.key('Shift+G'); const w = await h.along('FRONT', 'SS_HEM', 'UA', 0.5); const n0 = pc(await h.state(), 'FRONT').internals.length; const s0 = JSON.stringify(pc(await h.state(), 'FRONT').sew);
    await h.dragW(w, { x: w.x - 40, y: w.y + 25 }, { steps: 10 });
    const f = pc(await h.state(), 'FRONT'); const c = f.internals[f.internals.length - 1];
    await h.ev(() => { window.__e2e.settings.moveLineCopy = false; });
    return { got: `internals ${n0} → ${f.internals.length}; copy x ${c && Q.r4(c.points[0].x)}`, pass: f.internals.length === n0 + 1 && JSON.stringify(f.sew) === s0 && near(c.points[0].x, 220, 0.5) && near(c.points[c.points.length - 1].x, 220, 0.5) };
  });
  await T('Copy internal: the picked line sticks to the mouse; right-click = movement box from the click position; Esc cancels', async () => {
    await h.ev(() => { window.__e2e.settings.moveLineMode = 'copyTo'; }); await h.key('Shift+G');
    const w = await h.along('FRONT', 'CF_HEM', 'SS_HEM', 0.5); await h.clickW(w); await h.clickW(w, { button: 'right' }); await h.ok();
    const t = await h.local2world('BACK', { x: 520, y: 300 }); const c0 = await h.toClient(t); await h.page.mouse.move(c0.x, c0.y); await h.settle(40);
    const carried = await h.page.locator('[data-carry-line]').count();
    await h.clickW(t, { button: 'right' }); await h.page.waitForSelector('.ibox', { timeout: 2000 });
    const ins = h.page.locator('.ibox input'); await ins.nth(0).fill('0'); await ins.nth(1).fill('50'); await ins.nth(1).press('Enter'); await h.settle();
    const b = pc(await h.state(), 'BACK'); const c = b.internals[b.internals.length - 1];
    const ys = c ? c.points.map(p => p.y) : [];
    return { got: `carried line shown ${carried}; BACK internals ${b.internals.length}; copy y ${ys.map(Q.r4)}`, pass: carried === 1 && !!c && ys.every(y => near(y, 350, 1.5)) };
  });
  await T('Copy internal by overlay: click a small panel lying on a piece, then the piece: all the panel lines land there exactly', async () => {
    // a 100 × 60 panel laid on FRONT with its corner at FRONT (80, 200)
    await h.ev(() => { const E = window.__e2e; const f = E.P('FRONT'); const mk = (x, y) => ({ id: 'p' + Math.random().toString(36).slice(2, 9), x, y, kind: 'grade', smooth: false, grade: {}, flags: {} });
      const np = JSON.parse(JSON.stringify(E.P('BACK'))); np.id = 'pc' + Math.random().toString(36).slice(2, 9); np.name = 'PATCH'; np.sew = { ...np.sew, id: 'c' + Math.random().toString(36).slice(2, 9), points: [mk(0, 0), mk(100, 0), mk(100, 60), mk(0, 60)] };
      np.internals = [{ id: 'c' + Math.random().toString(36).slice(2, 9), type: 'internal', closed: false, points: [mk(20, 30), mk(80, 30)], style: 'solid' }]; np.notches = []; np.drills = []; np.texts = []; np.darts = []; np.pleats = []; np.connections = []; np.fullness = [];
      np.grain = { a: { x: 20, y: 10 }, b: { x: 80, y: 10 }, gradeA: {}, gradeB: {} };
      const w = E.localToWorld('FRONT', { x: 80, y: 200 }); np.layout = { x: w.x, y: w.y, angleDeg: 0 };
      E.app.doc.transact('patch', st => { st.pieces.push(np); }); E.app.invalidate(); void f; });
    await h.ev(() => { window.__e2e.settings.moveLineMode = 'copyTo'; }); await h.key('Shift+G');
    const n0 = pc(await h.state(), 'FRONT').internals.length; const r0 = await rev();
    await h.clickW(await h.local2world('PATCH', { x: 30, y: 45 }));
    await h.clickW(await h.local2world('FRONT', { x: 220, y: 100 }));
    const once = (await rev()) - r0;
    // clicking again two or three times must not make more copies
    await h.clickW(await h.local2world('FRONT', { x: 220, y: 100 })); await h.clickW(await h.local2world('PATCH', { x: 30, y: 45 })); await h.clickW(await h.local2world('FRONT', { x: 220, y: 100 })); await h.clickW(await h.local2world('FRONT', { x: 220, y: 120 }));
    const st = await h.state(); const f = pc(st, 'FRONT'); const added = f.internals.slice(n0);
    const patchInt = pc(st, 'PATCH').internals.length;
    const box = added.find(c => c.closed); const line = added.find(c => !c.closed);
    const xs = box ? box.points.map(p => Math.round(p.x)).sort((a, b) => a - b) : [], ys = box ? box.points.map(p => Math.round(p.y)).sort((a, b) => a - b) : [];
    return { got: `FRONT internals ${n0} → ${f.internals.length}; outline copy x ${xs} y ${ys}; inner line ${line ? line.points.map(p => `(${Q.r4(p.x)},${Q.r4(p.y)})`).join(' ') : 'none'}; ${(await rev()) - r0} undo step(s)`,
      pass: added.length === 2 && JSON.stringify(xs) === '[80,80,180,180]' && JSON.stringify(ys) === '[200,200,260,260]' && !!line && near(line.points[0].x, 100, 0.01) && near(line.points[0].y, 230, 0.01) && once === 1 && (await rev()) - r0 === 1 && patchInt === 1 };
  });
  await T('Internal line: clicking the last point a second time (slowly) ends the line', async () => {
    const n0 = pc(await h.state(), 'FRONT').internals.length; await h.key('i');
    await h.clickLocal('FRONT', { x: 60, y: 100 }); await h.page.waitForTimeout(700); await h.clickLocal('FRONT', { x: 60, y: 300 }); await h.page.waitForTimeout(900); await h.clickLocal('FRONT', { x: 60, y: 300 });
    const f = pc(await h.state(), 'FRONT'); const c = f.internals[f.internals.length - 1];
    return { got: `internals ${n0} → ${f.internals.length}; points ${c ? c.points.length : 0}`, pass: f.internals.length === n0 + 1 && c.points.length === 2 };
  });
  await T('Walk: point on piece 1, point on piece 2, then a click on the seam walks there', async () => {
    await h.key('w'); await h.clickA('FRONT', 'SS_HEM'); await h.clickA('BACK', 'BL');
    const rep = () => h.ev(async () => { const m = await import('/src/tools/walk.ts'); return m.walkRun ? m.walkRun() : null; });
    const r0 = await rep();
    const real0 = await h.ev(() => window.__e2e.app.preview.size);
    // placed by a move only: the piece keeps the direction it has on the sheet, its point sits on the clicked point
    const placed = await h.ev(() => { const E = window.__e2e, f = E.P('FRONT'), pv = E.app.preview.get(f.id); const a = E.findA('FRONT', 'SS_HEM').a; const r = (pv.layout.angleDeg || 0) * Math.PI / 180; const w = { x: pv.layout.x + a.x * Math.cos(r) - a.y * Math.sin(r), y: pv.layout.y + a.x * Math.sin(r) + a.y * Math.cos(r) }; const t = E.W('BACK', 'BL'); return { ang: pv.layout.angleDeg || 0, off: Math.hypot(w.x - t.x, w.y - t.y), own: (f.layout && f.layout.angleDeg) || 0 }; });
    await h.clickW(await h.along('BACK', 'TL', 'BL', 0.5)); const r1 = await rep();
    // at the contact the two seams lie on each other: 1 cm ahead and 1 cm behind, FRONT's side seam is on BACK's side line
    const gapNear = await h.ev(async () => { const m = await import('/src/tools/walk.ts'); return m.walkGap ? m.walkGap() : null; });
    // FRONT's corner has two lines (hem and side seam): the walk must take the one that runs with BACK's side, the side seam
    const mp = await h.ev(async () => (await import('/src/tools/walk.ts')).walkMovingPoint());
    // a click far along the seam stops at the next grade point (FRONT's underarm, 465 from the hem), and the wheel no longer walks
    await h.clickW(await h.along('BACK', 'TL', 'BL', 0.08)); const rLim = await rep();
    const c0 = await h.toClient(await h.along('BACK', 'TL', 'BL', 0.5)); await h.page.mouse.move(c0.x, c0.y); await h.page.mouse.wheel(0, 240); await h.settle(80); const rWheel = await rep();
    await h.ev(() => { const E = window.__e2e; const v = E.app.view; v.cx = 380; v.cy = 356; v.scale = Math.min(v.W / 900, v.H / 820); E.app.invalidate(); });
    const s0 = JSON.stringify((await h.state()).pieces.map(p => p.layout)); const sew0 = JSON.stringify(pc(await h.state(), 'FRONT').sew);
    const shown = await h.ev(() => { const E = window.__e2e; return JSON.stringify(E.app.preview.get(E.P('FRONT').id).layout); });
    const rv = await rev(); await h.key('Escape');
    const after = await h.ev(() => window.__e2e.app.preview.size);
    // the piece stays at its last walk position: placement only, one undo step, Ctrl+Z puts it back
    const stE = await h.state(); const keptL = JSON.stringify(pc(stE, 'FRONT').layout); const steps = (await rev()) - rv;
    const sameShape = JSON.stringify(pc(stE, 'FRONT').sew) === sew0;
    await h.ensureSelect(); await h.key('Control+z');
    return { got: `stationary run ${r0 && Q.r4(r0)} → ${r1 && Q.r4(r1)}; far click stops at the grade point ${Q.r4(rLim)}; after the wheel ${Q.r4(rWheel)}; piece shown on the seam during the walk ${real0 === 1}; seams 1 cm either side of the contact apart by ${gapNear === null ? '?' : Q.r4(gapNear)}; walked along FRONT's side seam to (${mp && Q.r4(mp.x)},${mp && Q.r4(mp.y)}); placed without turning (angle ${Q.r4(placed.ang)}°, point off by ${Q.r4(placed.off)}); after Esc it stays at the last walk position ${keptL === shown} (${steps} undo step, shape unchanged ${sameShape}); Ctrl+Z puts it back ${s0 === JSON.stringify((await h.state()).pieces.map(p => p.layout))}`, pass: near(rLim, 465, 0.01) && near(rWheel, rLim, 1e-9) && gapNear !== null && gapNear < 0.05 && !!mp && near(mp.x, 260, 0.5) && near(mp.y, 350, 1) && keptL === shown && steps === 1 && sameShape && r0 !== null && Math.abs(r0) < 1e-6 && r1 > 50 && real0 === 1 && after === 0 && Math.abs(placed.ang - placed.own) < 1e-6 && placed.off < 0.01 && s0 === JSON.stringify((await h.state()).pieces.map(p => p.layout)) };
  });
  await T('Trace Piece: lines picked in mixed order across an internal line make a new piece; the source is unchanged', async () => {
    await h.ev(() => { const E = window.__e2e, p = E.P('FRONT'); const mk = (x, y) => ({ id: 'p' + Math.random().toString(36).slice(2, 9), x, y, kind: 'grade', smooth: false, grade: {}, flags: {} }); E.app.doc.transact('yoke', () => { p.internals.push({ id: 'c' + Math.random().toString(36).slice(2, 9), type: 'internal', closed: false, points: [mk(260, 400), mk(0, 400)], style: 'solid' }); }); E.app.invalidate(); });
    const s0 = JSON.stringify(pc(await h.state(), 'FRONT')); const n0 = (await h.state()).pieces.length; const r0 = await rev();
    await h.key('Shift+T');
    const L = v => h.local2world('FRONT', v);
    await h.clickW(await L({ x: 60, y: 400 })); await h.clickW(await L({ x: 60, y: 0 })); await h.clickW(await L({ x: 260, y: 200 })); await h.clickW(await L({ x: 0, y: 200 }));
    const picks = await h.page.locator('[data-trace-pick]').count();
    await h.clickW(await L({ x: 60, y: 400 }), { button: 'right' }); await h.ok();
    const st = await h.state(); const np = st.pieces[st.pieces.length - 1];
    const xs = np.sew.points.map(p => Math.round(p.x)).sort((a, b) => a - b), ys = np.sew.points.map(p => Math.round(p.y)).sort((a, b) => a - b);
    return { got: `${picks} lines picked; pieces ${n0} → ${st.pieces.length}; new piece points ${np.sew.points.map(p => `(${Q.r4(p.x)},${Q.r4(p.y)})`).join(' ')}; source changed ${JSON.stringify(pc(st, 'FRONT')) !== s0}; ${(await rev()) - r0} undo step(s)`,
      pass: picks === 4 && st.pieces.length === n0 + 1 && np.sew.points.length === 4 && JSON.stringify(xs) === '[0,0,260,260]' && JSON.stringify(ys) === '[0,0,400,400]' && JSON.stringify(pc(st, 'FRONT')) === s0 && (await rev()) - r0 === 1 };
  });
  await T('Select: window (L→R) box takes only fully-inside points', async () => { await h.ensureSelect(); await h.dragW({ x: -20, y: -20 }, { x: 270, y: 30 }); const sel = await h.sel(); return { got: JSON.stringify(sel), pass: sel.anchors.length === 2 }; });
  await T('Select: Shift+box adds', async () => { await h.selectA('FRONT', 'HPS'); await h.dragW({ x: -20, y: -20 }, { x: 270, y: 30 }, { mods: ['Shift'] }); const sel = await h.sel(); return { got: JSON.stringify(sel.anchors), pass: sel.anchors.length === 3 }; });
  await T('Select: click a sew line selects the segment', async () => { await h.ensureSelect(); await h.clickSeg('FRONT', 'SS_HEM', 'UA', 0.5); const sel = await h.sel(); return { got: JSON.stringify(sel.segments), pass: sel.segments.length === 1 }; });
  await T('Select: Tab cycles coincident objects (internal end on UA)', async () => { await addInternal([[260, 465, 'CN_A'], [150, 420, 'CN_B']])(h); await h.ensureSelect(); await h.clickA('FRONT', 'UA'); const a = (await h.sel()).anchors; await h.key('Tab'); const b = (await h.sel()).anchors; const st = await h.ev(() => window.__e2e.app.statusMsg || window.__e2e.app.tool.hint(window.__e2e.app)); return { got: `first click ${JSON.stringify(a)}, after Tab ${JSON.stringify(b)}; status "${st}"`, pass: JSON.stringify(a) !== JSON.stringify(b) }; });
  await T('Select: double-click a piece selects all its points', async () => { await h.ensureSelect(); await h.dblW(await h.local2world('BACK', { x: 520, y: 300 })); const sel = await h.sel(); return { got: `${sel.anchors.length} points`, pass: sel.anchors.length === 4 }; });
  return out;
}

// ───────────────────────── E. selection persistence ─────────────────────────
async function selection(h, fixtures) {
  const out = [];
  const T = async (name, setup, act, want) => {
    const r = { name };
    try { await h.reset(fixtures[want.fixture || 'base']); await setup(); const s0 = await h.ev(() => window.__e2e.selRaw()); await act(); await h.waitIdle(1500); const s1 = await h.ev(() => window.__e2e.selRaw()); r.names = [await h.sel()]; r.before = s0; r.after = s1; r.pass = JSON.stringify(s0) === JSON.stringify(s1); }
    catch (e) { r.pass = false; r.error = String(e.message || e).split('\n')[0]; await h.escapeAll(); }
    out.push(r); process.stdout.write(`  selection ${r.pass ? '✓' : '✗'} ${name} ${r.pass ? '' : JSON.stringify(r.before) + ' → ' + JSON.stringify(r.after)}\n`);
  };
  const pt = () => h.selectA('FRONT', 'UA'), pcF = () => h.selectPiece('FRONT');
  await T('point → Grade ▸ Clipboard ▸ Copy grade (menu)', pt, () => h.cmd('grade.copy'), {});
  await T('point → Copy grade (Ctrl+Alt+C)', pt, () => h.key('Control+Alt+c'), {});
  await T('point → Copy grade (grading-table toolbar button)', async () => { await pt(); await h.key('Control+g'); }, () => h.page.locator('.gr-tools button', { hasText: /^Copy$/ }).click(), {});
  await T('point → Paste grade', async () => { await h.selectA('FRONT', 'SS_HEM'); await h.key('Control+Alt+c'); await pt(); }, () => h.cmd('grade.paste'), {});
  await T('point → Seam ▸ Seam of segment… (dialog OK)', pt, async () => { await h.cmd('seam.segment'); await h.waitDialog(); await h.fill('v', '12'); await h.ok(); }, {});
  await T('piece → Seam ▸ Whole-piece seam… (dialog OK)', pcF, async () => { await h.cmd('seam.piece'); await h.waitDialog(); await h.fill('v', '12'); await h.ok(); }, {});
  await T('piece → Seam ▸ Reseam piece', pcF, () => h.cmd('seam.reseam'), {});
  await T('point → Point ▸ Move point XY…', pt, async () => { await h.cmd('point.moveXY'); await h.waitDialog(); await h.fields({ _dx: '3' }); await h.ok(); }, {});
  await T('point → Edit ▸ Undo after a nudge', async () => { await pt(); await h.key('ArrowRight'); }, () => h.key('Control+z'), {});
  await T('point → switch size (status bar)', pt, () => h.page.locator('select.sb-size').selectOption({ label: 'L' }), {});
  await T('point → nested view on (Alt+N)', pt, () => h.key('Alt+n'), {});
  await T('point → type in Inspector Kind/Name field', pt, () => typeInto(h, h.page.locator('section[data-panel="inspector"] .prow').filter({ has: h.page.locator('.plabel', { hasText: /^Name$/ }) }).locator('input'), 'UNDERARM'), {});
  await T('point → open a menu and close it with Esc', pt, async () => { await h.openMenu('Grade'); await h.page.keyboard.press('Escape'); await h.settle(); }, {});
  await T('point → open a menu and close it by clicking its title again', pt, async () => { await h.openMenu('Grade'); await h.page.locator('.menu-root[data-menu="Grade"] > .menu-btn').click(); await h.settle(); }, {});
  await T('point → cancel a dialog with Esc', pt, async () => { await h.cmd('point.moveXY'); await h.waitDialog(); await h.page.keyboard.press('Escape'); await h.settle(); }, {});
  await T('point → Segment ▸ Rotate segment, cancel the pivot pick with one Esc', async () => { await pt(); }, async () => { await h.cmd('seg.rotate'); await h.page.keyboard.press('Escape'); await h.settle(); }, {});
  await T('nothing → Segment ▸ Rotate segment, Esc at the first pick, then Esc again', async () => { await pt(); }, async () => { await h.cmd('seg.rotate'); await h.page.keyboard.press('Escape'); await h.settle(); await h.page.keyboard.press('Escape'); await h.settle(); }, {});
  await T('dart selected → Dart ▸ Close / reopen', async () => { await h.ensureSelect(); const w = await h.ev(() => window.__e2e.livePt('FRONT', 'dart', 0.5)); await h.clickW(w); }, () => h.cmd('dart.toggle'), { fixture: 'live' });
  await T('two points → Point ▸ Align horizontally', async () => { await h.selectA('FRONT', 'HPS'); await h.selectA('FRONT', 'SH', true); }, () => h.cmd('point.alignH'), {});
  await T('point → Point ▸ Corner ⇄ smooth (Alt+C)', pt, () => h.key('Alt+c'), {});
  await T('piece → Piece ▸ Rotate 90°', pcF, () => h.cmd('piece.rotate90'), {});
  if (await hasMove(h)) {
    await T('point → G (Move Point) → Esc → back in Select', pt, async () => { await h.key('g'); await h.page.keyboard.press('Escape'); await h.settle(); }, {});
    await T('point → Move Point drag → Esc', pt, async () => { await h.key('g'); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 10, y: w.y }, { steps: 6 }); await h.page.keyboard.press('Escape'); await h.settle(); }, {});
    await T('segment → Seam ▸ Seam of segment… (dialog OK)', () => h.clickSeg('FRONT', 'SS_HEM', 'UA', 0.5), async () => { await h.cmd('seam.segment'); await h.waitDialog(); await h.fill('v', '12'); await h.ok(); }, {});
    await T('point → switch to Measure tool and back (M, V)', pt, async () => { await h.key('m'); await h.key('v'); }, {});
  }
  return out;
}

// ───────────────────────── F. export scope ─────────────────────────
async function exportScope(h, fixtures) {
  const out = {};
  const pdfDialog = async () => { await h.key('Control+p'); await h.waitDialog(); const sel = h.dlg().locator('[data-key="pieces"]'); const v = await sel.inputValue(); const opts = await sel.locator('option').allTextContents(); const label = await sel.locator('option:checked').textContent(); return { value: v, label, options: opts }; };
  const pdfText = async () => { await h.ev(() => window.__e2e._dl); const d = (await h.downloads()).find(x => x.name.endsWith('.pdf')); if (!d) return null; const t = Buffer.from(d.b64, 'base64').toString('latin1'); return { pages: (t.match(/\/Type\s*\/Page[^s]/g) || []).length, hasFront: /FRONT/.test(t), hasBack: /BACK/.test(t), size: d.size }; };
  await h.reset(fixtures.base); await h.selectPiece('FRONT');
  out.firstTimeWithSelection = await pdfDialog(); await h.ok(); await h.settle(100); out.firstTimeExport = await pdfText();
  await h.reset(fixtures.base);
  out.noSelection = await pdfDialog(); await h.ok(); await h.settle(100); out.noSelectionExport = await pdfText();
  // reset() clears remembered dialog values; emulate a session: export all first, then select a piece
  await h.reset(fixtures.base);
  await pdfDialog(); await h.ok(); await h.settle(100);
  await h.ev(() => { window.__e2e.downloads.length = 0; });
  await h.selectPiece('FRONT');
  out.afterExportingAll_thenSelecting = await pdfDialog(); await h.ok(); await h.settle(100); out.afterExportingAll_thenSelectingExport = await pdfText();
  // same for SVG / DXF / PLT defaults with a selection
  await h.reset(fixtures.base); await h.selectPiece('FRONT');
  for (const [id, key] of [['file.export.svg', 'pieces'], ['file.export.dxf', 'pieces']]) { await h.cmd(id); await h.waitDialog(); out[id] = await h.dlg().locator(`[data-key="${key}"]`).inputValue(); await h.cancel(); }
  await h.reset(fixtures.base); await h.selectA('FRONT', 'UA');
  out.pointSelected = await pdfDialog(); await h.cancel();
  process.stdout.write(`  export scope: ${JSON.stringify(out).slice(0, 400)}\n`);
  return out;
}

// ───────────────────────── G. File System Access probe ─────────────────────────
async function fsaProbe(h, fixtures) {
  await h.reset(fixtures.base);
  const has = await h.ev(() => ({ open: typeof window.showOpenFilePicker, save: typeof window.showSaveFilePicker }));
  await h.selectPiece('FRONT'); await h.key('ArrowRight');
  await h.key('Control+s'); await h.page.waitForTimeout(1500);
  const rec = await h.rec(); const dls = await h.downloads(); const dirty = await h.ev(() => window.__e2e.app.isDirty());
  const dialog = await h.dlgTitle();
  await h.escapeAll();
  const r = { api: has, toasts: rec.toasts, downloads: dls.map(d => d.name), dialog, stillDirty: dirty, console: h.consoleErrors.slice(-3) };
  process.stdout.write(`  FS Access probe: ${JSON.stringify(r)}\n`);
  return r;
}

// ───────────────────────── H. nothing-selected probe of every menu command ─────────────────────────
async function noSelectionProbe(h, fixtures, registry) {
  const out = [];
  for (const c of registry) {
    if (!c.menu || /^file\.(open|import|merge|save|saveAs)$|^art\.place$|^piece\.merge$|^file\.new$/.test(c.id)) continue;
    await h.reset(fixtures.base);
    const s0 = await h.stable();
    let res = {};
    try { res = await h.menu(c.menu, c.title); } catch (e) { out.push({ id: c.id, error: String(e.message).split('\n')[0] }); continue; }
    await h.page.waitForTimeout(250);
    const st = await h.ev(() => { const E = window.__e2e; return { tool: E.app.tool.id, status: E.app.statusMsg || E.app.tool?.hint?.(E.app) || '', dialog: document.querySelector('.dlg-title')?.textContent ?? null, popover: !!document.querySelector('.popover'), win: [...document.querySelectorAll('.fwin .fw-title')].map(x => x.textContent), toasts: E.toasts.map(t => t.kind + ': ' + t.text) }; });
    const changed = (await h.stable()) !== s0;
    const feedback = res.disabled ? 'disabled (greyed)' : st.dialog ? `dialog "${st.dialog}"` : st.tool === 'pick' ? `pick: "${st.status}"` : st.popover ? 'popover' : st.win.length ? `window ${st.win}` : st.toasts.length ? `toast ${st.toasts.join(' / ')}` : changed ? 'document changed' : '';
    out.push({ id: c.id, menu: c.menu, title: c.title, disabled: !!res.disabled, feedback, changed, tool: st.tool, status: st.status, silent: !feedback });
    await h.escapeAll();
  }
  return out;
}

// ───────────────────────── I. fix-pass regressions (docs/E2E-REPORT.md "Fix pass") ─────────────────────────
async function fixes(h, fixtures) {
  const out = [];
  const T = async (name, fn, fixture = 'base') => {
    const r = { name }; const e0 = h.pageErrors.length;
    try { await h.reset(fixtures[fixture]); Object.assign(r, await fn()); } catch (e) { r.pass = false; r.error = String(e.message || e).split('\n')[0]; await h.escapeAll(); }
    const pe = h.pageErrors.slice(e0); if (pe.length) { r.pass = false; r.pageErrors = pe.slice(0, 3); }
    out.push(r); process.stdout.write(`  fix ${r.pass ? '✓' : '✗'} ${name} ${r.pass ? '' : (r.got ?? r.error ?? '') + (r.pageErrors ? ' page errors: ' + r.pageErrors.join(' | ') : '')}\n`);
  };
  const half = P((app, ops, doc, E) => ops.setHalf(doc, E.P('FRONT').id, { a: { x: 0, y: 0 }, b: { x: 0, y: 622 } }, { openAtOutput: true }));
  const conn = async () => { await addInternal([[260, 465, 'CN_A'], [150, 420, 'CN_B']])(h); await P((app, ops, doc, E) => ops.globalCheckConnections(doc, E.P('FRONT').id))(h); await h.settle(); };
  const unit = v => h.page.locator('select.sb-unit').selectOption(v).then(() => h.settle());
  const tool = () => h.ev(() => window.__e2e.app.tool.id);
  const prompt = () => h.ev(() => document.querySelector('.sb-prompt')?.textContent ?? '');

  // B1 — half piece: hovering the mirrored half never throws; the fold-axis point is selectable and movable
  await T('B1 half piece: hover the mirrored half (no TypeError), click CF_NECK selects it, Move Point moves it', async () => {
    await half(h); await h.settle(); await h.ensureSelect();
    for (const [x, y] of [[-130, 300], [-200, 20], [-60, 640], [-5, 400], [-130, 0]]) { const c = await h.toClient({ x, y }); await h.page.mouse.move(c.x, c.y); await h.settle(10); }
    await h.clickA('FRONT', 'CF_NECK'); const sel = await h.sel();
    await h.key('g'); const w = await h.W('FRONT', 'CF_NECK'); await h.dragW(w, { x: w.x + 12, y: w.y + 6 }, { steps: 8, mods: ['Alt'] });
    const a = an(await h.state(), 'FRONT', 'CF_NECK');
    return { got: `selection ${JSON.stringify(sel.anchors)}; CF_NECK (${Q.r4(a.x)},${Q.r4(a.y)})`, pass: sel.anchors[0] === 'FRONT/CF_NECK' && near(a.x, 12, 0.6) && near(a.y, 628, 0.6) };
  });
  await T('B1 half piece: Select · Lines filter: a click on the mirrored half selects no fold-edge segment, a click on the authored half selects its segment', async () => {
    await half(h); await h.settle(); await h.ensureSelect(); await h.key('3');
    await h.clickW({ x: -260, y: 200 }); const s1 = await h.sel();
    await h.clickSeg('FRONT', 'SS_HEM', 'UA', 0.5); const s2 = await h.sel();
    return { got: `mirrored half: ${JSON.stringify(s1.segments)}; authored: ${JSON.stringify(s2.segments)}`, pass: !s1.segments.length && s2.segments.length === 1 };
  });
  // B2 — typed value equal to the rounded display is committed exactly (grading table: units part; here Inspector + dialog)
  await T('B2 Inspector: typing the shown rounded "10 1/4" over 260 mm sets exactly 260.35 mm (in16)', async () => {
    await unit('in16'); await h.selectA('FRONT', 'SS_HEM'); const loc = inspInput(h, /^X/); const shown = await loc.inputValue(); await typeInto(h, loc, shown);
    const x = an(await h.state(), 'FRONT', 'SS_HEM').x; return { got: `shown "${shown}" → x ${x}`, pass: shown === '10 1/4' && near(x, 260.35, 1e-6) };
  });
  await T('B2 dialog: an untouched length field keeps its exact value (seam 10 mm shown as 3/8" → OK keeps 10)', async () => {
    await unit('in16'); await h.selectA('FRONT', 'SS_HEM'); await h.cmd('seam.segment'); await h.waitDialog(); const v = await h.dlg().locator('[data-key="v"]').inputValue(); await h.ok();
    const sa = an(await h.state(), 'FRONT', 'SS_HEM').seamAfter ?? pc(await h.state(), 'FRONT').seamDefault; return { got: `field "${v}" → seam ${sa}`, pass: sa === 10 };
  });
  // B3 — export scope follows the selection even after an "All pieces" export
  await T('B3 export: after exporting All, selecting FRONT → Pieces = Selected (1), the select shows it, the PDF has FRONT only', async () => {
    await h.key('Control+p'); await h.waitDialog(); await h.ok(); await h.settle(100);
    await h.ev(() => { window.__e2e.downloads.length = 0; });
    await h.selectPiece('FRONT'); await h.key('Control+p'); await h.waitDialog();
    const sel = h.dlg().locator('[data-key="pieces"]'); const v = await sel.inputValue(); const label = await sel.locator('option:checked').textContent();
    await h.ok(); await h.settle(150); await h.ev(() => window.__e2e._dl);
    const d = (await h.downloads()).find(x => x.name.endsWith('.pdf')); const t = d ? Buffer.from(d.b64, 'base64').toString('latin1') : '';
    return { got: `value ${v} "${label}", PDF FRONT ${/FRONT/.test(t)} BACK ${/BACK/.test(t)}`, pass: v === 'sel' && /Selected \(1\)/.test(label) && /FRONT/.test(t) && !/BACK/.test(t) };
  });
  await T('B3 export: SVG / DXF / PLT also default to Selected after an All export', async () => {
    const res = {};
    for (const id of ['file.export.svg', 'file.export.dxf']) { await h.reset(fixtures.base); await h.cmd(id); await h.waitDialog(); await h.ok(); await h.settle(60); await h.selectPiece('BACK'); await h.cmd(id); await h.waitDialog(); res[id] = await h.dlg().locator('[data-key="pieces"]').inputValue(); await h.cancel(); }
    return { got: JSON.stringify(res), pass: Object.values(res).every(v => v === 'sel') };
  });
  // B5 — Move Point prefers the selected sew point over the coincident internal end
  await T('B5 Move Point grabs the selected sew point UA (not the coincident internal end CN_A); CN_A follows by the connection', async () => {
    await conn(); await h.selectA('FRONT', 'UA'); const s0 = (await h.sel()).anchors;
    await h.key('g'); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 15, y: w.y - 10 }, { steps: 10, mods: ['Alt'] });
    const st = await h.state(); const ua = an(st, 'FRONT', 'UA'), cn = an(st, 'FRONT', 'CN_A');
    return { got: `selected ${JSON.stringify(s0)}; UA (${Q.r4(ua.x)},${Q.r4(ua.y)}), CN_A (${Q.r4(cn.x)},${Q.r4(cn.y)})`, pass: s0[0] === 'FRONT/UA' && near(ua.x, 275, 0.6) && near(cn.x, ua.x, 1e-6) && near(cn.y, ua.y, 1e-6) };
  });
  await T('B5 Select: a click on coincident UA / CN_A takes the sew point first; Tab reaches CN_A', async () => {
    await conn(); await h.ensureSelect(); await h.clickA('FRONT', 'UA'); const a = (await h.sel()).anchors; await h.key('Tab'); const b = (await h.sel()).anchors;
    return { got: `click ${JSON.stringify(a)}, Tab ${JSON.stringify(b)}`, pass: a[0] === 'FRONT/UA' && b[0] === 'FRONT/CN_A' };
  });
  // B8 — snap-to-grid hotkey
  await T("B8 Ctrl+Shift+' toggles Snap to grid (not the grid display)", async () => {
    const g0 = await h.ev(() => [window.__e2e.settings.snapGrid, window.__e2e.settings.showGrid]); await h.key("Control+Shift+'"); const g1 = await h.ev(() => [window.__e2e.settings.snapGrid, window.__e2e.settings.showGrid]);
    await h.key("Control+'"); const g2 = await h.ev(() => [window.__e2e.settings.snapGrid, window.__e2e.settings.showGrid]);
    return { got: `[snap, grid] ${JSON.stringify(g0)} → ${JSON.stringify(g1)} → Ctrl+' ${JSON.stringify(g2)}`, pass: g1[0] !== g0[0] && g1[1] === g0[1] && g2[1] !== g1[1] && g2[0] === g1[0] };
  });
  // B9 — click, then press again on the picked-up point: a drag, no zero-delta undo step
  await T('B9 Move Point: click UA then immediately press-drag it 20 mm → one undo step, UA +20', async () => {
    await h.key('g'); const w = await h.W('FRONT', 'UA'); const r0 = await h.ev(() => window.__e2e.app.doc.revision());
    await h.clickW(w); await h.dragW(w, { x: w.x + 20, y: w.y }, { steps: 10, mods: ['Alt'] });
    const ua = an(await h.state(), 'FRONT', 'UA'); const steps = (await h.ev(() => window.__e2e.app.doc.revision())) - r0;
    return { got: `UA.x ${Q.r4(ua.x)}, revisions ${steps}`, pass: near(ua.x, 280, 0.6) && near(ua.y, 465, 0.6) && steps === 1 };
  });
  await T('B9 Move Point: click UA then click it again on the same spot → put back, no undo step', async () => {
    await h.key('g'); const w = await h.W('FRONT', 'UA'); const r0 = await h.ev(() => window.__e2e.app.doc.revision());
    await h.clickW(w); await h.clickW(w); const steps = (await h.ev(() => window.__e2e.app.doc.revision())) - r0;
    return { got: `revisions ${steps}`, pass: steps === 0 };
  });
  // B11 — Inspector X / Y follows point connections (same op as Move XY)
  await T('B11 Inspector X +15 on UA: the connected internal end CN_A follows', async () => {
    await conn(); await h.selectA('FRONT', 'UA'); const loc = inspInput(h, /^X/); await typeInto(h, loc, String(+(await loc.inputValue()) + 15));
    const st = await h.state(); const ua = an(st, 'FRONT', 'UA'), cn = an(st, 'FRONT', 'CN_A');
    return { got: `UA.x ${ua.x}, CN_A.x ${cn.x}`, pass: near(ua.x, 275, 1e-6) && near(cn.x, 275, 1e-6) };
  });
  await T('B11 Inspector Y on a non-base size edits only that size (L), connection follows', async () => {
    await conn(); await h.selectA('FRONT', 'UA'); await h.page.locator('select.sb-size').selectOption({ label: 'L' }); await h.settle();
    const y0 = an(await h.state(), 'FRONT', 'UA').y;
    const loc = inspInput(h, /^Y/); await typeInto(h, loc, String(+(await loc.inputValue()) - 4));
    const st = await h.state(); const g = abs(st, 'FRONT', 'UA'); const ua = an(st, 'FRONT', 'UA'), cn = abs(st, 'FRONT', 'CN_A');
    return { got: `UA base y ${y0} → ${ua.y}, abs L ${JSON.stringify(g.L)}, XL ${JSON.stringify(g.XL)}, CN_A abs L ${JSON.stringify(cn.L)}`, pass: ua.y === y0 && near(g.L.dy, 1, 1e-6) && near(g.XL.dy, 10, 1e-6) && near(cn.L.dy, -4, 1e-6) };
  });
  // grading table: the incremental cascade is explained, Absolute edits one size
  await T('Grading table: the Incremental note warns that larger sizes follow; Absolute edit of L leaves XL', async () => {
    await h.selectA('FRONT', 'UA'); await h.key('Control+g'); await h.settle(80);
    const note = await h.page.locator('.gr-note').textContent();
    await typeInto(h, h.page.locator('.sg-wrap.gr input[data-size="L"][data-axis="dx"]'), '12'); const st1 = await h.ev(() => window.__e2e.app.statusMsg);
    await h.page.locator('.gr-bar button[data-view="total"]').click(); await h.settle(60);
    const note2 = await h.page.locator('.gr-note').textContent();
    const xl0 = abs(await h.state(), 'FRONT', 'UA').XL.dx;
    await typeInto(h, h.page.locator('.sg-wrap.gr input[data-size="L"][data-axis="dx"]'), '15'); const g = abs(await h.state(), 'FRONT', 'UA');
    return { got: `note "${note}" · status "${st1}" · abs note "${note2}" · L ${g.L.dx} XL ${xl0}→${g.XL.dx}`, pass: /XL follows L/.test(note) && /moved sizes L, XL/.test(st1) && /that size only/.test(note2) && near(g.L.dx, 15, 1e-9) && near(g.XL.dx, xl0, 1e-9) };
  });
  // Esc: closing a menu never clears the selection; a second Esc right after a cancel keeps it too
  await T('Esc on an open menu closes it and keeps the selection; Esc again (later) clears', async () => {
    await h.selectA('FRONT', 'UA'); await h.openMenu('Point'); await h.page.keyboard.press('Escape'); await h.settle();
    const open = await h.page.locator('.menu-root.open').count(); const s1 = (await h.sel()).anchors;
    await h.page.waitForTimeout(600); await h.page.keyboard.press('Escape'); await h.settle(); const s2 = (await h.sel()).anchors;
    return { got: `menu open ${open}, after Esc ${JSON.stringify(s1)}, after a later Esc ${JSON.stringify(s2)}`, pass: !open && s1[0] === 'FRONT/UA' && !s2.length };
  });
  // curve points that follow their neighbours: ghost + "follows" marks + prompt while a grade point is dragged
  await T('Move Point drag of UA: ghost of the old curve, AH1 / AH2 marked "follows", prompt explains and names Pin', async () => {
    await h.key('g'); const w = await h.W('FRONT', 'UA'); const a = await h.toClient(w);
    await h.page.mouse.move(a.x, a.y); await h.page.mouse.down(); for (let i = 1; i <= 6; i++) await h.page.mouse.move(a.x + i * 4, a.y - i * 2); await h.settle(30);
    const ov = await h.ev(() => ({ follows: [...document.querySelectorAll('svg.sheet text.tool-note')].filter(t => t.textContent === 'follows').length, ghost: document.querySelectorAll('svg.sheet path[stroke="#8a93a6"]').length }));
    const pr = await prompt(); await h.page.mouse.up(); await h.settle();
    return { got: `overlay ${JSON.stringify(ov)}; prompt "${pr}"`, pass: ov.follows === 1 && ov.ghost >= 1 && /2 curve points follow/.test(pr) && /Pin curve point/.test(pr) };
  });
  await T('Curve point tooltip: AH1 says it follows its neighbours; after Point ▸ Pin it says pinned', async () => {
    await h.selectA('FRONT', 'AH1');
    const tip = () => h.ev(() => { const E = window.__e2e; const id = E.findA('FRONT', 'AH1').a.id; return document.querySelector(`circle[data-hit="anchor"][data-anchor="${id}"] title`)?.textContent ?? ''; });
    const t0 = await tip(); await h.cmd('point.pin'); await h.settle(); const t1 = await tip();
    const insp = await h.page.locator('section[data-panel="inspector"] .prow').filter({ has: h.page.locator('.plabel', { hasText: /^Grading$/ }) }).textContent();
    return { got: `"${t0}" → "${t1}"; inspector "${insp}"`, pass: /follows its neighbouring/.test(t0) && /pinned/.test(t1) && /Pinned/.test(insp) };
  });
  // Space tap: Move tool ⇄ Select, selection kept
  await T('Space tap: Move Point → Select (selection kept) → Space again → Move Point', async () => {
    await h.selectA('FRONT', 'UA'); await h.key('g'); const t0 = await tool();
    await h.page.keyboard.press('Space'); await h.settle(); const t1 = await tool(); const s1 = (await h.sel()).anchors;
    await h.page.keyboard.press('Space'); await h.settle(); const t2 = await tool();
    return { got: `${t0} → ${t1} (sel ${JSON.stringify(s1)}) → ${t2}`, pass: t0 === 'movePoint' && t1 === 'select' && s1[0] === 'FRONT/UA' && t2 === 'movePoint' };
  });
  // snaps: midpoint, intersection, perpendicular foot
  await T('Snaps: midpoint of a segment, intersection of two lines, perpendicular foot from the start point', async () => {
    await addInternal([[60, 300, 'YK_A'], [200, 300, 'YK_B']])(h); await h.settle();
    const r = await h.ev(async () => {
      const S = await import('/src/canvas/snap.ts'); const app = window.__e2e.app;
      const mid = S.snapPoint(app, { x: 532, y: 3 });                 // BACK hem BL–BR → (530, 0)
      const int = S.snapPoint(app, { x: 132, y: 302 });               // internal IL (x 130) × YK (y 300) → (130, 300)
      const perp = S.snapPoint(app, { x: 128, y: 196 }, { from: { x: 20, y: 200 } }); // foot on IL from (20,200) → (130, 200)
      return { mid, int, perp };
    });
    const ok = (s, k, x, y) => s.kind === k && near(s.p.x, x, 1e-3) && near(s.p.y, y, 1e-3); // the fixture outline comes from canvas clicks (± 1e-5 mm)
    // and a real Move Point drag lands exactly on the midpoint
    await h.key('g'); const w = await h.W('BACK', 'TR'); await h.dragW(w, { x: 531.5, y: 2.5 }, { steps: 10 });
    const tr = an(await h.state(), 'BACK', 'TR');
    return { got: `${JSON.stringify(r)}; BACK/TR → (${Q.r4(tr.x)},${Q.r4(tr.y)})`, pass: ok(r.mid, 'mid', 530, 0) && ok(r.int, 'int', 130, 300) && ok(r.perp, 'perp', 130, 200) && near(tr.x, r.mid.p.x, 1e-9) && near(tr.y, r.mid.p.y, 1e-9) };
  });
  // greyed menu items say what they need
  await T('A greyed menu item explains what it needs (tooltip)', async () => {
    await h.openMenu('Point'); const t = await h.page.locator('.menu-root.open .menu-item.disabled').first().getAttribute('title'); await h.page.keyboard.press('Escape');
    return { got: t, pass: /needs/i.test(t || '') };
  });
  return out;
}

async function run(h, fixtures, results, ONLY) {
  const S = {};
  const want = k => !ONLY || ONLY.test('special:' + k);
  if (want('otherPoints')) S.otherPoints = await otherPoints(h, fixtures);
  if (want('units')) S.units = await units(h, fixtures);
  if (want('nested')) S.nested = await nested(h, fixtures);
  if (want('drags')) S.drags = await drags(h, fixtures);
  if (want('selection')) S.selection = await selection(h, fixtures);
  if (want('exportScope')) S.exportScope = await exportScope(h, fixtures);
  if (want('fsa')) S.fsa = await fsaProbe(h, fixtures);
  if (want('noSelection')) S.noSelection = await noSelectionProbe(h, fixtures, results.registry);
  if (want('fixes')) S.fixes = await fixes(h, fixtures);
  void runCase; void req;
  return S;
}
module.exports = { run };
