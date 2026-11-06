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
  selectDrag: { title: 'Select tool drag', run: async (h, s) => { const w = await h.W(s.piece, s.point); await h.dragW(w, { x: w.x + 15, y: w.y - 10 }, { steps: 10 }); } },
  propDrag: { title: 'Select drag with Point ▸ Proportional drag ON', setup: h => h.ev(() => { window.__e2e.settings.proportionalDrag = true; }), run: async (h, s) => { const w = await h.W(s.piece, s.point); await h.dragW(w, { x: w.x + 15, y: w.y - 10 }, { steps: 10 }); } },
  moveXY: { title: 'Point ▸ Move point XY… (dX 15, dY −10)', run: async h => { await h.cmd('point.moveXY'); await h.waitDialog(); await h.fields({ how: 'delta', _dx: '15', _dy: '-10' }); await h.ok(); } },
  nudge: { title: 'Arrow keys (Shift+→ = 10 mm)', run: async h => { await h.key('Shift+ArrowRight'); } },
  inspX: { title: 'Inspector X field (+15)', run: async (h, s) => { const loc = inspInput(h, /^X/); const v = await loc.inputValue(); await typeInto(h, loc, String(+v + 15)); } },
  inspY: { title: 'Inspector Y field (−10)', run: async (h, s) => { const loc = inspInput(h, /^Y/); const v = await loc.inputValue(); await typeInto(h, loc, String(+v - 10)); } },
};

async function otherPoints(h, fixtures) {
  const rows = [];
  for (const [sk, s] of Object.entries(SCEN)) {
    for (const [mk, m] of Object.entries(METHODS)) {
      const row = { scenario: sk, scenarioTitle: s.title, method: mk, methodTitle: m.title, point: `${s.piece}/${s.point}` };
      try {
        await h.reset(fixtures[s.fixture || 'base']);
        if (s.pre) { await s.pre(h); await h.settle(); }
        if (m.setup) await m.setup(h);
        await h.selectA(s.piece, s.point);
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
  await T('Grading table cell "3/8" (in16, incremental L dX of UA)', async () => {
    await unit('in16'); await h.selectA('FRONT', 'UA'); await h.key('Control+g'); await h.settle(100);
    const cell = h.page.locator('table.gr tr.sel input.num').nth(2 * 2); // sizes S,M,L → L dX = index 4
    await typeInto(h, cell, '3/8'); const st = await h.state(); const g = abs(st, 'FRONT', 'UA');
    return { got: `UA abs L dx ${g.L.dx} mm, XL dx ${g.XL.dx} mm`, pass: near(g.L.dx, 9.525, 1e-3), note: 'incremental edit of L also shifts XL (incremental convention)' };
  });
  await T('Grading table absolute view cell "1/2" (in16, L dY of UA)', async () => {
    await unit('in16'); await h.selectA('FRONT', 'UA'); await h.key('Control+g'); await h.page.locator('.gr-bar button', { hasText: 'Absolute' }).click(); await h.settle(80);
    const cell = h.page.locator('table.gr tr.sel input.num').nth(2 * 2 + 1);
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
    await h.selectA('FRONT', 'UA'); await h.key('Alt+n');
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
  await T('Non-base size: arrow nudge edits only that size', async () => { await h.selectA('FRONT', 'UA'); await h.page.locator('select.sb-size').selectOption({ label: 'L' }); await h.key('Shift+ArrowRight'); const st = await h.state(); const g = abs(st, 'FRONT', 'UA'); return { got: `UA abs L dx ${g.L.dx}, XL dx ${g.XL.dx}`, pass: near(g.L.dx, 20, 1e-3) && near(g.XL.dx, 20, 1e-3) }; });
  return out;
}

// ───────────────────────── D. Select-tool drags ─────────────────────────
async function drags(h, fixtures) {
  const out = [];
  const T = async (name, fn) => { const r = { name }; try { await h.reset(fixtures.base); Object.assign(r, await fn()); } catch (e) { r.pass = false; r.error = String(e.message || e).split('\n')[0]; await h.escapeAll(); } out.push(r); process.stdout.write(`  drag ${r.pass ? '✓' : '✗'} ${name} ${r.got ?? r.error ?? ''}\n`); };
  const rev = () => h.ev(() => window.__e2e.app.doc.revision());
  await T('Point drag moves the point, one undo step', async () => { await h.selectA('FRONT', 'UA'); const r0 = await rev(); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y + 5 }); const st = await h.state(); const a = an(st, 'FRONT', 'UA'); const r1 = await rev(); await h.key('Control+z'); const back = an(await h.state(), 'FRONT', 'UA'); return { got: `UA (${Q.r4(a.x)},${Q.r4(a.y)}); revisions ${r1 - r0}; undo → (${Q.r4(back.x)},${Q.r4(back.y)})`, pass: a.x > 270 && r1 - r0 === 1 && near(back.x, 260, 1e-3) }; });
  await T('Drag an UNSELECTED point directly (no prior click)', async () => { const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y }); const st = await h.state(); return { got: `UA.x ${Q.r4(an(st, 'FRONT', 'UA').x)}; FRONT layout ${JSON.stringify(pc(st, 'FRONT').layout)}`, pass: an(st, 'FRONT', 'UA').x > 270 }; });
  await T('Drag an unselected CURVE point directly', async () => { const w = await h.W('FRONT', 'AH1'); await h.dragW(w, { x: w.x + 20, y: w.y }); const st = await h.state(); return { got: `AH1.x ${Q.r4(an(st, 'FRONT', 'AH1').x)} (was 222); FRONT layout ${JSON.stringify(pc(st, 'FRONT').layout || null)}`, pass: an(st, 'FRONT', 'AH1').x > 230 && !pc(st, 'FRONT').layout }; });
  await T('Shift-drag constrains to horizontal', async () => { await h.selectA('FRONT', 'UA'); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 30, y: w.y + 4 }, { mods: ['Shift'] }); const a = an(await h.state(), 'FRONT', 'UA'); return { got: `UA (${Q.r4(a.x)},${Q.r4(a.y)})`, pass: near(a.y, 465, 1e-3) && a.x > 280 }; });
  await T('Esc during a point drag cancels', async () => { await h.selectA('FRONT', 'UA'); const w = await h.W('FRONT', 'UA'); const s0 = await h.stable(); await h.dragW(w, { x: w.x + 30, y: w.y }, { beforeUp: () => h.page.keyboard.press('Escape') }); const s1 = await h.stable(); const sel = await h.sel(); return { got: `doc changed ${s0 !== s1}; selection after Esc: ${JSON.stringify(sel.anchors)}`, pass: s0 === s1, selectionLost: !sel.anchors.length }; });
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
  await T('Multi-point drag moves all selected points together', async () => { await h.selectA('FRONT', 'SS_HEM'); await h.selectA('FRONT', 'UA', true); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 20, y: w.y }); const st = await h.state(); return { got: `SS_HEM.x ${Q.r4(an(st, 'FRONT', 'SS_HEM').x)} UA.x ${Q.r4(an(st, 'FRONT', 'UA').x)}`, pass: near(an(st, 'FRONT', 'SS_HEM').x - 260, an(st, 'FRONT', 'UA').x - 260, 1e-6) && an(st, 'FRONT', 'UA').x > 270 }; });
  await T('Alt-click toggles corner ⇄ smooth', async () => { await h.clickA('FRONT', 'UA', { mods: ['Alt'] }); const a = an(await h.state(), 'FRONT', 'UA'); return { got: `smooth=${a.smooth}`, pass: a.smooth === true }; });
  await T('Drag snaps the point onto another point (8 px)', async () => { await h.selectA('FRONT', 'UA'); const w = await h.W('FRONT', 'UA'); const t = await h.W('FRONT', 'SS_HEM'); await h.dragW(w, { x: t.x + 3, y: t.y + 200 }); const a = an(await h.state(), 'FRONT', 'UA'); return { got: `UA (${Q.r4(a.x)},${Q.r4(a.y)})`, pass: true, info: 'informational' }; });
  return out;
}

// ───────────────────────── E. selection persistence ─────────────────────────
async function selection(h, fixtures) {
  const out = [];
  const T = async (name, setup, act, want) => {
    const r = { name };
    try { await h.reset(fixtures[want.fixture || 'base']); await setup(); const s0 = await h.sel(); await act(); await h.waitIdle(1500); await h.escapeAllNoKey?.(); const s1 = await h.sel(); r.before = s0; r.after = s1; r.pass = JSON.stringify(s0) === JSON.stringify(s1); }
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
  await T('point → type in Inspector Name field', pt, () => typeInto(h, h.page.locator('section[data-panel="inspector"] .prow').filter({ has: h.page.locator('.plabel', { hasText: /^Name$/ }) }).locator('input'), 'UNDERARM'), {});
  await T('point → open a menu and close it with Esc', pt, async () => { await h.openMenu('Grade'); await h.page.keyboard.press('Escape'); await h.settle(); }, {});
  await T('point → open a menu and close it by clicking its title again', pt, async () => { await h.openMenu('Grade'); await h.page.locator('.menu-root[data-menu="Grade"] > .menu-btn').click(); await h.settle(); }, {});
  await T('point → cancel a dialog with Esc', pt, async () => { await h.cmd('point.moveXY'); await h.waitDialog(); await h.page.keyboard.press('Escape'); await h.settle(); }, {});
  await T('point → cancel a pick with Esc (Segment ▸ Rotate segment)', async () => { await pt(); }, async () => { await h.cmd('seg.rotate'); await h.page.keyboard.press('Escape'); await h.settle(); await h.page.keyboard.press('Escape'); await h.settle(); }, {});
  await T('dart selected → Dart ▸ Close / reopen', async () => { await h.ensureSelect(); const w = await h.ev(() => window.__e2e.livePt('FRONT', 'dart', 0.5)); await h.clickW(w); }, () => h.cmd('dart.toggle'), { fixture: 'live' });
  await T('two points → Point ▸ Align horizontally', async () => { await h.selectA('FRONT', 'HPS'); await h.selectA('FRONT', 'SH', true); }, () => h.cmd('point.alignH'), {});
  await T('point → Point ▸ Corner ⇄ smooth (Alt+C)', pt, () => h.key('Alt+c'), {});
  await T('piece → Piece ▸ Rotate 90°', pcF, () => h.cmd('piece.rotate90'), {});
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
  void runCase; void req;
  return S;
}
module.exports = { run };
