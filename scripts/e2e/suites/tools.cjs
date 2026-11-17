// One case per palette tool: activate it from the palette (incl. flyouts) or its hotkey, then use it.
const Q = require('../lib/q.cjs');
const { pc, an, near, count, npts, req } = Q;
const { DLG, OK, W, seq, at, seg, IB, addInternal } = require('./commands.cjs');

/** activate a tool by clicking its palette button; tools in a flyout group are opened by right-click */
const palette = id => async h => {
  const r = await h.ev(id => {
    const E = window.__e2e; const t = E.app.tools.find(x => x.id === id);
    const btns = [...document.querySelectorAll('#palette .tool-btn')];
    const groups = []; for (const x of E.app.tools) if (!x.hidden && !groups.includes(x.group)) groups.push(x.group);
    return { gi: groups.indexOf(t.group), members: E.app.tools.filter(x => x.group === t.group && !x.hidden).map(x => x.id), n: btns.length };
  }, id);
  const btn = h.page.locator('#palette .tool-btn').nth(r.gi);
  const shown = await h.ev(gi => { const E = window.__e2e; return null; }, r.gi);
  void shown;
  if (r.members.length > 1) {
    await btn.click({ button: 'right' });
    await h.page.locator('.flyout .fly-item').nth(r.members.indexOf(id)).click();
  } else await btn.click();
  await h.settle();
  const active = await h.ev(() => window.__e2e.app.tool.id);
  if (active !== id) throw new Error(`palette: active tool is ${active}, wanted ${id}`);
};
const hotkey = (chord, id) => async h => { await h.key(chord); const a = await h.ev(() => window.__e2e.app.tool.id); if (a !== id) throw new Error(`hotkey ${chord}: active tool ${a}, wanted ${id}`); };
const T = (id, o) => ({ id: 'tool:' + id, title: o.title ?? id, kind: 'tool', menu: 'Tools', ...o });
const view = h => h.ev(() => ({ s: window.__e2e.app.view.scale, x: window.__e2e.app.view.cx, y: window.__e2e.app.view.cy }));

const cases = [
  T('select', { invoke: seq(hotkey('g', 'movePoint'), palette('select')), drive: async h => { await h.clickA('FRONT', 'SS_HEM'); }, change: false, expect: (h, c) => req(c.afterSel.anchors[0] === 'FRONT/SS_HEM', 'click did not select the point') }),
  T('select#sizetip', { title: 'Nested view: hovering the outline of a size with Select shows its name next to the cursor', change: false,
    invoke: seq(h => h.key('Alt+n'), palette('select')),
    drive: async h => { const sid = await h.ev(() => window.__e2e.sizeId('XL')); const a = await h.W('FRONT', 'SS_HEM', sid), b = await h.W('FRONT', 'UA', sid); const c = await h.toClient({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); await h.page.mouse.move(c.x - 3, c.y); await h.page.mouse.move(c.x, c.y); await h.settle(80); h._tip = await h.ev(() => document.querySelector('svg.sheet [data-size-tip]')?.getAttribute('data-size-tip') ?? null); },
    after: h => h.key('Alt+n'),
    expect: async h => req(h._tip === 'XL', 'size tooltip: ' + h._tip) }),
  T('select#palette', { title: 'Palette: 13 buttons; Modify, Piece position, Lines, Piece build and Measure / Verify are flyouts; Grade has its own button; Grain / Flip answers to Shift+R', change: false,
    invoke: hotkey('Shift+R', 'grain'),
    expect: async h => { const g = await h.ev(() => { const E = window.__e2e; const by = {}; for (const t of E.app.tools) if (!t.hidden) (by[t.group] ??= []).push(t.id); return { n: document.querySelectorAll('#palette .tool-btn').length, by }; });
      return [req(g.n === 13, 'palette buttons ' + g.n), req((g.by.grade || []).join() === 'editDelta', 'Grade: ' + g.by.grade), req(g.by.modify.join() === 'movePoint,moveLine,curve,match,smooth', 'Modify: ' + g.by.modify), req(g.by.position.join() === 'rotatePiece,grain,fold', 'Piece position: ' + g.by.position), req(g.by.pen.join() === 'internal,clip', 'Lines: ' + g.by.pen), req(g.by.cut.join() === 'slash,trace', 'Piece build: ' + g.by.cut), req(g.by.measure.join() === 'measure,measureDist,walk', 'Measure / Verify: ' + g.by.measure)]; } }),
  T('editDelta', { title: 'Edit Grade (palette): click a grade point → it is selected and the Grading table opens with its dX / dY per size', change: false,
    invoke: seq(palette('editDelta'), async h => { await h.settle(250); await h.ev(() => window.__e2e.C.runCommand('view.fit')); await h.settle(100); }), drive: h => h.clickA('FRONT', 'SS_HEM'),
    expect: async (h, c) => { const st = await h.ev(() => ({ open: window.__e2e.settings.panels.grading, cells: document.querySelectorAll('.sg-wrap.gr input[data-axis="dx"]').length, calc: document.querySelectorAll('.gr-bar button[data-view]').length === 3 })); return [req(c.afterSel.anchors.join() === 'FRONT/SS_HEM', 'point not selected: ' + c.afterSel.anchors), req(st.open && st.cells >= 3 && st.calc, 'grading table not shown with its three views: ' + JSON.stringify(st))]; } }),
  T('editDelta#calc', { title: 'Edit Grade (E hotkey) ▸ right-click a cell: Double on the XL step of SS_HEM turns 10 into 20; Add constant… 5 makes it 25',
    invoke: seq(hotkey('e', 'editDelta'), async h => { await h.settle(250); await h.ev(() => window.__e2e.C.runCommand('view.fit')); await h.settle(100); }),
    drive: async h => { await h.clickA('FRONT', 'SS_HEM'); const cell = () => h.page.locator('.sg-wrap.gr input[data-size="XL"][data-axis="dx"]').first(); await cell().click(); h._v0 = await cell().inputValue();
      await cell().click({ button: 'right' }); await h.page.locator('.ctx-menu .menu-item', { hasText: /^Double/ }).click(); await h.settle(120); h._v1 = await cell().inputValue();
      h._pos1 = await h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'); const a = p.sew.points.find(a => a.name === 'SS_HEM'); return E.ops.gradedPosition(E.app.doc, p.id, a.id, E.sizeId('XL')).x - E.ops.gradedPosition(E.app.doc, p.id, a.id, E.sizeId('L')).x; });
      await cell().click({ button: 'right' }); await h.page.locator('.ctx-menu .menu-item', { hasText: /^Add constant/ }).click(); await h.fill('v', '5'); await h.ok(); await h.settle(120); h._v2 = await cell().inputValue(); },
    expect: async h => [req(parseFloat(h._v0) === 10 && parseFloat(h._v1) === 20, `XL step ${h._v0} → ${h._v1} (want 10 → 20)`), req(near(h._pos1, 20, 0.01), 'XL should now sit 20 beyond L at SS_HEM, got ' + h._pos1), req(parseFloat(h._v2) === 25, 'Add constant 5 → 25, got ' + h._v2)] }),
  T('editDelta#copy', { title: 'Edit Grade options: Copy on SS_HEM, the tool switches to Paste, click CF_HEM → same grading; Clear with a box over both removes it',
    invoke: seq(palette('editDelta'), async h => { await h.settle(250); await h.ev(() => window.__e2e.C.runCommand('view.fit')); await h.settle(100); }, h => h.ev(() => { const E = window.__e2e; E.app.tool.setMode(E.app, 'copy'); })),
    drive: async h => { await h.clickA('FRONT', 'SS_HEM'); await h.settle(150); h._m = await h.ev(() => window.__e2e.app.tool.mode(window.__e2e.app)); await h.clickA('FRONT', 'CF_HEM'); await h.settle(150);
      h._g = await h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'); const g = n => { const a = p.sew.points.find(x => x.name === n); return E.ops.gradedPosition(E.app.doc, p.id, a.id, E.sizeId('XL')).x - a.x; }; return [g('SS_HEM'), g('CF_HEM')]; });
      await h.ev(() => { const E = window.__e2e; E.app.tool.setMode(E.app, 'zero'); });
      const a = await h.W('FRONT', 'CF_HEM'), b = await h.W('FRONT', 'SS_HEM'); await h.dragW({ x: a.x - 15, y: a.y - 15 }, { x: b.x + 15, y: b.y + 15 }); await h.settle(200); },
    after: h => h.ev(() => { const E = window.__e2e; if (E.settings.toolState?.grade) E.settings.toolState.grade.mode = 'edit'; }),
    expect: async h => { const z = await h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'); return ['SS_HEM', 'CF_HEM'].map(n => { const a = p.sew.points.find(x => x.name === n); return E.ops.gradedPosition(E.app.doc, p.id, a.id, E.sizeId('XL')).x - a.x; }); });
      return [req(h._m === 'paste', 'after Copy the option should be Paste, got ' + h._m), req(near(h._g[0], 20, 0.01) && near(h._g[1], 20, 0.01), 'CF_HEM did not get the grading of SS_HEM: ' + h._g), req(near(z[0], 0, 1e-6) && near(z[1], 0, 1e-6), 'Clear with a box did not remove the grading: ' + z)]; } }),
  T('internal', { invoke: palette('internal'), drive: seq(W(60, 100), W(60, 300), h => h.key('Enter')), expect: (h, c) => req(count(c.after, 'FRONT', 'internals') === 2, 'no internal') }),
  T('internal#place', { title: 'Internal line: exact start on a line (right-click on the hem → From start 50), then right-click ▸ 90° → the next point runs square to the hem',
    invoke: palette('internal'),
    drive: async h => { const w = await h.along('FRONT', 'CF_HEM', 'SS_HEM', 0.5); const cl = await h.toClient(w); await h.blur(); await h.page.mouse.move(cl.x - 2, cl.y); await h.page.mouse.move(cl.x, cl.y); await h.settle(60);
      h._lab = await h.ev(() => [...document.querySelectorAll('.live-note')].map(t => t.textContent).join(' '));
      await h.clickW(w, { button: 'right' }); await IB({ d: '50' }, 'From start')(h);
      await h.clickW({ x: 90, y: 150 }, { button: 'right' }); await h.fill('helper', 'square'); await h.ok();
      h._sq = await h.ev(() => document.querySelectorAll('[data-helper="square"]').length);
      const c2 = await h.toClient({ x: 90, y: 200 }); await h.page.mouse.move(c2.x, c2.y); await h.clickW({ x: 90, y: 200 }); await h.key('Enter'); },
    expect: (h, c) => { const p = pc(c.after, 'FRONT'), l = p.internals[p.internals.length - 1].points.map(a => [Math.round(a.x * 100) / 100, Math.round(a.y * 100) / 100]);
      return [req(count(c.after, 'FRONT', 'internals') === 2, 'no internal line'), req(/130/.test(h._lab), 'the distances to both ends are not shown: ' + h._lab), req(h._sq === 1, '90° guide not shown'),
        req(JSON.stringify(l) === '[[50,0],[50,200]]', 'line should run (50,0) → (50,200): ' + JSON.stringify(l))]; } }),
  T('internal#helpers', { title: 'Internal line helpers: right-click ▸ Compass 100 → the next point is 100 from the last; right-click ▸ 2-point curve → click the end, bend, click',
    invoke: palette('internal'),
    drive: async h => { await h.clickW({ x: 60, y: 100 });
      await h.clickW({ x: 150, y: 110 }, { button: 'right' }); await h.fill('helper', 'compass'); await h.fill('len', '100'); await h.ok();
      h._cp = await h.ev(() => document.querySelectorAll('[data-helper="compass"]').length);
      const c1 = await h.toClient({ x: 200, y: 100 }); await h.page.mouse.move(c1.x, c1.y); await h.clickW({ x: 200, y: 100 });
      await h.clickW({ x: 170, y: 200 }, { button: 'right' }); await h.fill('helper', 'curve'); await h.ok();
      await h.clickW({ x: 160, y: 300 }); await h.page.waitForTimeout(500);
      const c3 = await h.toClient({ x: 120, y: 200 }); await h.page.mouse.move(c3.x, c3.y); await h.clickW({ x: 120, y: 200 }); await h.page.waitForTimeout(500); await h.key('Enter'); },
    expect: (h, c) => { const p = pc(c.after, 'FRONT'), l = p.internals[p.internals.length - 1].points.map(a => [Math.round(a.x), Math.round(a.y), a.kind]);
      return [req(h._cp === 1, 'compass circle not shown'), req(JSON.stringify(l) === '[[60,100,"grade"],[160,100,"grade"],[120,200,"curve"],[160,300,"grade"]]', 'points: ' + JSON.stringify(l))]; } }),
  T('internal#polygon', { title: 'internal: closed polygon by clicking the start', invoke: hotkey('i', 'internal'), drive: seq(W(30, 100), W(100, 100), W(100, 200), W(30, 100)), expect: (h, c) => req(pc(c.after, 'FRONT').internals.some(i => i.closed), 'no closed internal') }),
  T('clip', { title: 'Clip Line: 1st click the line (near its end), 2nd click the side seam → the line is cut back to the seam and is NOT locked',
    pre: addInternal([[160, 200, 'CX_A'], [300, 200, 'CX_B']]),
    invoke: palette('clip'), drive: seq(h => h.clickLocal('FRONT', { x: 290, y: 200 }), seg('FRONT', 'SS_HEM', 'UA', 0.1)),
    expect: (h, c) => { const x = pc(c.after, 'FRONT').internals.find(i => i.points.some(a => a.name === 'CX_A')); const e = x.points[x.points.length - 1];
      return [req(near(e.x, 260, 1e-4) && near(e.y, 200, 1e-4), 'line not cut at the side seam: ' + JSON.stringify([e.x, e.y])), req(near(x.points[0].x, 160, 1e-9), 'the other end moved'), req(!x.lock, 'the line must not be locked')]; } }),
  T('clip#internal', { title: 'Clip Line (Shift+I): a short line is extended onto another internal line; the 2nd line does not change; no lock',
    pre: seq(addInternal([[200, 250, 'TG_A'], [200, 400, 'TG_B']]), addInternal([[150, 300, 'CN_A'], [170, 300, 'CN_B']])),
    invoke: hotkey('Shift+I', 'clip'), drive: seq(h => h.clickLocal('FRONT', { x: 168, y: 300 }), h => h.clickLocal('FRONT', { x: 200, y: 380 })),
    expect: (h, c) => { const ic = pc(c.after, 'FRONT').internals; const n = ic.find(i => i.points.some(a => a.name === 'CN_A')), t = ic.find(i => i.points.some(a => a.name === 'TG_A'));
      return [req(n.points.length === 2 && near(n.points[1].x, 200, 1e-6) && near(n.points[1].y, 300, 1e-6), 'line not extended to the 2nd line: ' + JSON.stringify(n.points.map(a => [a.x, a.y]))),
        req(!n.lock, 'the line must not be locked'), req(t.points.length === 2 && t.points[0].y === 250 && t.points[1].y === 400, 'the 2nd line changed')]; } }),
  T('clip#lock', { title: 'Lock: several internal lines selected → Lock internal to segment locks every end that lies on the outline; Unlock frees them all',
    pre: seq(addInternal([[160, 200, 'LA_A'], [260, 200, 'LA_B']]), addInternal([[160, 300, 'LB_A'], [260, 300, 'LB_B']]), addInternal([[160, 350, 'LC_A'], [200, 350, 'LC_B']])),
    invoke: palette('select'), drive: async h => {
      await h.clickLocal('FRONT', { x: 200, y: 200 }); await h.clickLocal('FRONT', { x: 200, y: 300 }, { mods: ['Shift'] }); await h.clickLocal('FRONT', { x: 180, y: 350 }, { mods: ['Shift'] });
      const n = await h.ev(() => window.__e2e.app.sel.internals.length); if (n !== 3) throw new Error('Shift+click selected ' + n + ' internal lines, wanted 3');
      await h.clickLocal('FRONT', { x: 200, y: 300 }, { button: 'right' }); await h.settle();
      await h.page.getByText('Lock internal to segment…').last().click(); await h.settle(); },
    expect: (h, c) => { const L = n => pc(c.after, 'FRONT').internals.find(i => i.points.some(a => a.name === n));
      return [req(L('LA_A').lock && L('LA_A').lock.ends.length === 1 && L('LB_A').lock && L('LB_A').lock.ends.length === 1, 'the two lines on the side seam are not locked'), req(!L('LC_A').lock, 'the free line was locked')]; } }),
  T('smooth', { invoke: palette('smooth'), drive: async h => { await h.clickA('FRONT', 'UA'); await h.clickA('FRONT', 'SH'); await h.key('Enter'); } }),
  T('rect', { invoke: palette('rect'), drive: async h => { await h.dragW({ x: 700, y: 50 }, { x: 850, y: 250 }); }, expect: (h, c) => req(c.after.pieces.length === 3, 'no rectangle') }),
  T('rect#dialog', { title: 'rectangle: click → exact size dialog (inch fractions)', invoke: seq(h => h.page.locator('select.sb-unit').selectOption('in16'), hotkey('r', 'rect')), drive: seq(W(700, 50), DLG({ w: '10 1/2', h: '5' })),
    expect: (h, c) => { const p = c.after.pieces[2]; const xs = p.sew.points.map(a => a.x); return req(near(Math.max(...xs) - Math.min(...xs), 266.7, 0.01), 'width ' + (Math.max(...xs) - Math.min(...xs))); } }),
  T('rect#internal', { title: 'Rectangle with “Internal shape” on: dragged inside FRONT it becomes a closed internal line of FRONT, no new piece',
    invoke: seq(palette('rect'), async h => { await h.page.locator('#toolopts [data-toggle="internal"]').click(); await h.settle(); }),
    drive: async h => { await h.dragW(await h.local2world('FRONT', { x: 40, y: 420 }), await h.local2world('FRONT', { x: 100, y: 450 })); },
    after: h => h.ev(() => { window.__e2e.settings.shapeInternal = false; }),
    expect: (h, c) => { const ic = pc(c.after, 'FRONT').internals; const n = ic[ic.length - 1]; const xs = n.points.map(a => a.x), ys = n.points.map(a => a.y);
      return [req(c.after.pieces.length === c.before.pieces.length, 'a new piece was made'), req(ic.length === count(c.before, 'FRONT', 'internals') + 1 && n.closed && n.type === 'internal' && n.points.length === 4, 'no closed internal rectangle: ' + JSON.stringify({ n: ic.length, closed: n.closed, type: n.type })),
        req(near(Math.min(...xs), 40, 0.6) && near(Math.max(...xs), 100, 0.6) && near(Math.min(...ys), 420, 0.6) && near(Math.max(...ys), 450, 0.6), 'rectangle not where it was drawn: ' + JSON.stringify([xs, ys]))]; } }),
  T('circle#internal', { title: 'Circle with “Internal shape” on: click inside FRONT → Ø dialog → internal circle; outside any piece nothing is made',
    invoke: seq(palette('circle'), async h => { await h.page.locator('#toolopts [data-toggle="internal"]').click(); await h.settle(); }),
    drive: async h => { await h.clickW({ x: 330, y: 300 }); h._dlg = await h.page.locator('.dialog, .dlg').count(); h._n = await h.ev(() => window.__e2e.app.doc.style.pieces.length + ':' + window.__e2e.P('FRONT').internals.length); await h.clickW(await h.local2world('FRONT', { x: 70, y: 500 })); await DLG({ by: 'd', v: '40' })(h); },
    after: h => h.ev(() => { window.__e2e.settings.shapeInternal = false; }),
    expect: (h, c) => { const ic = pc(c.after, 'FRONT').internals; const n = ic[ic.length - 1]; const xs = n.points.map(a => a.x);
      return [req(h._n === c.before.pieces.length + ':' + count(c.before, 'FRONT', 'internals'), 'a shape was made outside any piece: ' + h._n), req(c.after.pieces.length === c.before.pieces.length && ic.length === count(c.before, 'FRONT', 'internals') + 1 && n.closed, 'no internal circle'), req(near(Math.max(...xs) - Math.min(...xs), 40, 0.5), 'circle Ø ' + (Math.max(...xs) - Math.min(...xs)))]; } }),
  T('circle', { invoke: palette('circle'), drive: seq(W(780, 150), DLG({ by: 'd', v: '120' })), expect: (h, c) => req(c.after.pieces.length === 3, 'no circle') }),
  T('polygon', { invoke: palette('polygon'), drive: seq(W(780, 150), DLG({ n: '5', r: '60' })), expect: (h, c) => req(c.after.pieces.length === 3 && c.after.pieces[2].sew.points.length === 5, 'no pentagon') }),
  T('roundrect', { invoke: palette('roundrect'), drive: seq(W(700, 50), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'no rounded rect') }),
  T('seam', { invoke: palette('seam'), drive: seq(at('FRONT', 'SS_HEM'), at('FRONT', 'UA'), DLG({ v: '12' })), expect: (h, c) => req(an(c.after, 'FRONT', 'SS_HEM').seamAfter === 12, 'seam not 12') }),
  T('seam#dbl', { title: 'seam: double-click a piece = whole-piece seam', invoke: hotkey('s', 'seam'), drive: async h => { await h.dblW(await h.local2world('BACK', { x: 500, y: 300 })); await DLG({ v: '7' })(h); }, expect: (h, c) => req(pc(c.after, 'BACK').seamDefault === 7 || pc(c.after, 'BACK').sew.points.every(a => a.seamAfter === 7), 'BACK seam not 7') }),
  T('notch', { invoke: palette('notch'), drive: seq(seg('FRONT', 'CF_HEM', 'SS_HEM', 0.4), OK()), expect: (h, c) => req(count(c.after, 'FRONT', 'notches') === 2, 'no notch') }),
  T('notch#existing', { title: 'notch: click an existing notch → notch grid', invoke: hotkey('n', 'notch'), change: false,
    drive: async h => { const w = await h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'); const n = E.ops.resolveNotches(E.app.doc, p, E.app.sizeOf(p))[0]; return E.localToWorld('FRONT', n.pos); }); await h.clickW(w); },
    expect: async h => req(await h.ev(() => !!document.querySelector('.fwin[data-win="notchgrid"]')), 'grid not opened') }),
  T('drill', { invoke: palette('drill'), drive: seq(W(530, 300), OK()), expect: (h, c) => req(count(c.after, 'BACK', 'drills') === 1, 'no drill') }),
  T('drill#edit', { title: 'drill: click an existing drill → edit dialog', invoke: hotkey('d', 'drill'), drive: seq(W(130, 520), DLG({ dia: '6' })), expect: (h, c) => req(pc(c.after, 'FRONT').drills[0].diameter === 6, 'drill not edited') }),
  T('text', { invoke: palette('text'), drive: seq(W(530, 300), DLG({ text: 'BACK — CUT 1 ON FOLD' })), expect: (h, c) => req(count(c.after, 'BACK', 'texts') === 1, 'no text') }),
  T('cutPoint', { title: 'Cut Point: hover the hem, click = grade point (shape unchanged)', invoke: palette('cutPoint'), drive: seg('FRONT', 'CF_HEM', 'SS_HEM', 0.4),
    expect: (h, c) => [req(npts(c.after, 'FRONT') === npts(c.before, 'FRONT') + 1, 'no point added'), req(!Q.otherChanged(c.before, c.after, 'FRONT', []).filter(d => /xy/.test(d.what)).length, 'existing points moved')] }),
  T('cutPoint#divide', { title: 'Cut Point: right-click → Divide 3 with notches (X hotkey)', invoke: seq(hotkey('x', 'cutPoint'), async h => { await h.page.locator('#toolopts [data-toggle="notch"]').click(); await h.settle(); }),
    drive: async h => { const w = await h.along('FRONT', 'CF_HEM', 'SS_HEM', 0.5); await h.page.mouse.move(...Object.values(await h.toClient(w))); await h.clickW(w, { button: 'right' }); await IB({ n: '3' }, 'Divide')(h); },
    after: async h => { await h.ev(() => { const E = window.__e2e; if (E.settings.toolState?.cutPoint) E.settings.toolState.cutPoint.notch = false; }); },
    expect: (h, c) => [req(npts(c.after, 'FRONT') === npts(c.before, 'FRONT') + 2, 'divide 3 did not add 2 points'), req(count(c.after, 'FRONT', 'notches') === count(c.before, 'FRONT', 'notches') + 2, 'no notches on the new points')] }),
  T('cutPoint#exact', { title: 'Cut Point: type 1 1/8 (in16) from the start → exactly 28.575 mm along the hem from CF_HEM', invoke: seq(h => h.page.locator('select.sb-unit').selectOption('in16'), hotkey('x', 'cutPoint')),
    drive: async h => { const w = await h.along('FRONT', 'CF_HEM', 'SS_HEM', 0.5); const cl = await h.toClient(w); await h.blur(); await h.page.mouse.move(cl.x - 2, cl.y); await h.page.mouse.move(cl.x, cl.y); await h.page.keyboard.press('1'); await IB({ d: '1 1/8' })(h); },
    expect: (h, c) => { const p = pc(c.after, 'FRONT'), p0 = pc(c.before, 'FRONT'); const nw = p.sew.points.filter(a => !p0.sew.points.some(b => b.id === a.id)); const cf = p.sew.points.find(a => a.name === 'CF_HEM'); return req(nw.length === 1 && near(Math.hypot(nw[0].x - cf.x, nw[0].y - cf.y), 28.575, 1e-6), 'new point ' + JSON.stringify(nw.map(a => [a.x, a.y]))); } }),
  T('dart', { title: 'Dart: click leg A, leg B, then the apex (CLO)', invoke: palette('dart'), drive: seq(seg('FRONT', 'CF_HEM', 'SS_HEM', 0.45), seg('FRONT', 'CF_HEM', 'SS_HEM', 0.55), W(130, 150)), expect: (h, c) => req(count(c.after, 'FRONT', 'darts') === 1, 'no dart') }),
  T('notch#place', { title: 'Notch: exact place like Cut Point (right-click on the hem → Divide 4 → three notches, no dialog); the distances to both ends show on hover',
    invoke: hotkey('n', 'notch'),
    drive: async h => { h._n0 = await h.ev(() => window.__e2e.P('FRONT').notches.length);
      const w = await h.along('FRONT', 'CF_HEM', 'SS_HEM', 0.5); const cl = await h.toClient(w); await h.blur(); await h.page.mouse.move(cl.x - 2, cl.y); await h.page.mouse.move(cl.x, cl.y); await h.settle(60);
      h._lab = await h.ev(() => [...document.querySelectorAll('.live-note')].map(t => t.textContent).join(' '));
      await h.clickW(w, { button: 'right' }); await IB({ n: '4' }, 'Divide')(h); },
    expect: async h => { const g = await h.ev(() => { const E = window.__e2e, p = E.P('FRONT'); return { n: p.notches.length, xs: E.ops.resolveNotches(E.app.doc, p, E.app.sizeOf(p)).filter(n => Math.abs(n.pos.y) < 0.01).map(n => Math.round(n.pos.x)).sort((a, b) => a - b) }; });
      return [req(/130/.test(h._lab), 'the distances to both ends are not shown: ' + h._lab), req(g.n === h._n0 + 3, 'three notches expected: ' + h._n0 + ' → ' + g.n), req([65, 130, 195].every(x => g.xs.includes(x)), 'notches at 65 / 130 / 195 on the hem: ' + g.xs)]; } }),
  T('dart#legA', { title: 'Dart: leg A at an exact place (type on the hem → From start 60), leg B by click, apex by click → the opening starts 60 from the corner',
    invoke: hotkey('Shift+D', 'dart'),
    drive: async h => { const w = await h.along('FRONT', 'CF_HEM', 'SS_HEM', 0.3); const cl = await h.toClient(w); await h.blur(); await h.page.mouse.move(cl.x - 2, cl.y); await h.page.mouse.move(cl.x, cl.y); await h.page.keyboard.press('6'); await IB({ d: '60' })(h);
      h._a = await h.ev(() => { const el = [...document.querySelectorAll('.live-note')].map(t => t.textContent); return el.join(' '); });
      await seg('FRONT', 'CF_HEM', 'SS_HEM', 0.5)(h); await h.clickW({ x: 95, y: 110 }); },
    expect: async h => { const g = await h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'); const d = p.darts[p.darts.length - 1]; return d ? E.ops.dartInfo(E.app.doc, p.id, d.id) : null; });
      return req(!!g && near(g.width, 70, 0.5), 'dart width should be 130 − 60 = 70: ' + JSON.stringify(g && { w: g.width, d: g.depth })); } }),
  T('dart#typed', { title: 'Dart: legs by clicks, right-click → width 20 · depth 100', invoke: hotkey('Shift+D', 'dart'),
    drive: async h => { await seg('FRONT', 'CF_HEM', 'SS_HEM', 0.45)(h); await seg('FRONT', 'CF_HEM', 'SS_HEM', 0.55)(h); await h.clickW({ x: 130, y: 120 }, { button: 'right' }); await IB({ w: '20', d: '100' }, 'Width · Depth')(h); },
    expect: async h => { const g = await h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'); return p.darts[0] ? E.ops.dartInfo(E.app.doc, p.id, p.darts[0].id) : null; }); return req(!!g && near(g.width, 20, 1e-6) && near(g.depth, 100, 1e-6), 'dart ' + JSON.stringify(g && { w: g.width, d: g.depth })); } }),
  T('pleat', { title: 'Pleat: start, end, then the cursor sets the last pleat line (3 knife pleats)', invoke: palette('pleat'), drive: seq(h => h.clickLocal('BACK', { x: 470, y: 700 }), h => h.clickLocal('BACK', { x: 470, y: 400 }), h => h.clickLocal('BACK', { x: 530, y: 500 })), expect: (h, c) => req(count(c.after, 'BACK', 'pleats') === 3, 'expected 3 pleats, got ' + count(c.after, 'BACK', 'pleats')) }),
  T('pleat#axis', { title: 'Pleat: Alt on the END click = pleat axis only', invoke: hotkey('Shift+L', 'pleat'), drive: seq(h => h.clickLocal('BACK', { x: 470, y: 700 }), h => h.clickLocal('BACK', { x: 470, y: 400 }, { mods: ['Alt'] })), expect: (h, c) => req(count(c.after, 'BACK', 'pleats') === 1 && !pc(c.after, 'BACK').pleats[0].open, 'expected 1 closed pleat axis') }),
  T('fullness', { title: 'Slash & spread: slash point, pivot, then click the opening', invoke: palette('fullness'), drive: seq(h => h.clickLocal('BACK', { x: 470, y: 0 }), h => h.clickLocal('BACK', { x: 470, y: 600 }), h => h.clickLocal('BACK', { x: 500, y: 200 })), expect: (h, c) => req(count(c.after, 'BACK', 'fullness') === 1, 'no fullness') }),
  T('fullness#typed', { title: 'Slash & spread: hem slash, waist hinge, right-click → opening 25', invoke: hotkey('Shift+U', 'fullness'),
    drive: async h => { await h.clickLocal('BACK', { x: 500, y: 0 }); await h.clickLocal('BACK', { x: 500, y: 700 }); await h.clickW(await h.local2world('BACK', { x: 540, y: 300 }), { button: 'right' }); await IB({ w: '25' }, 'Uniform')(h); },
    expect: async h => { const o = await h.ev(() => { const E = window.__e2e; const p = E.P('BACK'); return (p.fullness ?? [])[0] ? E.ops.fullnessOpenings(E.app.doc, p.id, p.fullness[0].id) : null; }); return req(!!o && near(o[0], 25, 1e-6), 'openings ' + JSON.stringify(o)); } }),
  T('slash', { title: 'slash: start OUTSIDE the piece (as the tool hint says), across, Enter', invoke: seq(palette('slash'), h => h.ev(() => { const E = window.__e2e; E.app.tool.setMode(E.app, 'slash'); })),
    drive: async h => { h._hint = await h.ev(() => window.__e2e.app.tool.hint(window.__e2e.app)); await W(-30, 300)(h); h._st = await h.ev(() => window.__e2e.app.statusMsg); await W(300, 300)(h); await h.key('Enter'); if (await h.hasDialog()) await h.ok(); },
    expect: (h, c) => req(c.after.pieces.length === 3, `not slashed — hint says "${h._hint}", first click outside → status "${h._st}"`) }),
  T('slash#outline', { title: 'slash: start ON the outline (CF), across, Enter', invoke: seq(palette('slash'), h => h.ev(() => { const E = window.__e2e; E.app.tool.setMode(E.app, 'slash'); })), drive: seq(W(0, 300), W(300, 300), h => h.key('Enter'), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'not slashed: ' + c.after.pieces.map(p => p.name)) }),
  T('trace', { title: 'Trace Piece: click the four lines of BACK (any order), Enter', invoke: palette('trace'), drive: seq(seg('BACK', 'BL', 'BR'), seg('BACK', 'TR', 'TL'), seg('BACK', 'BR', 'TR'), seg('BACK', 'TL', 'BL'), h => h.key('Enter'), OK()), expect: (h, c) => req(c.after.pieces.length === 3 && c.after.pieces[2].sew.points.length === 4, 'no traced piece with 4 points: ' + c.after.pieces.map(p => p.name + ':' + p.sew.points.length)) }),
  // Measure opens in Line mode (AccuMark Line Length; suite measure-grade); Tab = Distance mode (point to point)
  T('measureDist', { tool: 'measureDist', title: 'Measure Distance (own tool): click two points', invoke: palette('measureDist'), change: false, drive: seq(at('FRONT', 'SS_HEM'), at('FRONT', 'UA')),
    expect: async (h, c) => [req(c.rec.statuses.some(s => /L 465/.test(s)), 'status lacks "L 465": ' + c.rec.statuses.slice(-2)), req(await h.ev(() => document.querySelectorAll('.fwin[data-win="measure"] tr').length === 5), 'per-size table missing')] }),
  T('walk', { invoke: palette('walk'), drive: async h => { await h.clickA('FRONT', 'SS_HEM'); await h.clickA('BACK', 'BL'); for (let i = 0; i < 5; i++) await h.key('ArrowRight'); await h.key('n'); await h.key('Escape'); },
    expect: (h, c) => req(count(c.after, 'FRONT', 'notches') === 2 && count(c.after, 'BACK', 'notches') === 1, 'walk notches not dropped on both pieces') }),
  T('movePoint', { tool: 'movePoint', invoke: palette('movePoint'), drive: async h => { const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 15, y: w.y }, { steps: 10 }); }, expect: (h, c) => [req(an(c.after, 'FRONT', 'UA').x > 268, 'UA not moved'), req(!Q.otherChanged(c.before, c.after, 'FRONT', ['UA']).length, 'others changed')] }),
  T('movePoint#clickclick', { tool: 'movePoint', title: 'Move Point: click the point, click the new spot (AccuMark click-click)', invoke: hotkey('g', 'movePoint'), drive: async h => { const w = await h.W('FRONT', 'UA'); await h.clickW(w); await h.page.waitForTimeout(500); await h.clickW({ x: w.x + 20, y: w.y + 10 }); }, expect: (h, c) => req(an(c.after, 'FRONT', 'UA').x > 270, 'UA.x ' + an(c.after, 'FRONT', 'UA').x) }),
  T('movePoint#input', { tool: 'movePoint', title: 'Move Point: pick, type "1 1/8" (in16) in the input box, Enter', invoke: seq(h => h.page.locator('select.sb-unit').selectOption('in16'), hotkey('g', 'movePoint')),
    drive: async h => { const w = await h.W('FRONT', 'UA'); await h.clickW(w); await h.page.keyboard.type('1'); await h.page.waitForSelector('.ibox'); const ins = h.page.locator('.ibox input'); await ins.nth(0).fill('1 1/8'); await ins.nth(1).fill('0'); await ins.nth(1).press('Enter'); await h.settle(); },
    expect: (h, c) => req(near(an(c.after, 'FRONT', 'UA').x, 288.575, 1e-3) && near(an(c.after, 'FRONT', 'UA').y, 465, 1e-3), `UA (${an(c.after, 'FRONT', 'UA').x},${an(c.after, 'FRONT', 'UA').y}) want (288.575,465)`) }),
  T('moveLine', { tool: 'moveLine', invoke: palette('moveLine'), drive: async h => { const w = await h.along('FRONT', 'SS_HEM', 'UA', 0.5); await h.dragW(w, { x: w.x + 15, y: w.y }, { steps: 10 }); }, expect: (h, c) => req(an(c.after, 'FRONT', 'UA').x > 268 && an(c.after, 'FRONT', 'SS_HEM').x > 268, 'side seam not moved') }),
  T('rotatePiece', { tool: 'rotatePiece', title: 'Rotate by point: click the pin, then drag from a second point', invoke: palette('rotatePiece'), drive: async h => { const w = await h.local2world('BACK', { x: 520, y: 300 }); await h.clickW(w); await h.dragW({ x: w.x + 100, y: w.y }, { x: w.x, y: w.y + 100 }, { steps: 12, mods: ['Alt'] }); }, expect: (h, c) => req(near(pc(c.after, 'BACK').layout?.angleDeg ?? 0, 90, 1.5), 'BACK angle ' + JSON.stringify(pc(c.after, 'BACK').layout)) }),
  T('grain', { tool: 'grain', title: 'Grain tool · Flip horizontal: click a piece', invoke: palette('grain'), drive: h => h.clickLocal('BACK', { x: 520, y: 300 }), expect: (h, c) => req(!!pc(c.after, 'BACK').layout?.flipX, 'BACK not flipped') }),
  T('slash#line', { title: 'Cut / Merge · Cut by line: click an internal line that runs across the piece', pre: h => h.ev(() => { const E = window.__e2e, p = E.P('FRONT'); const mk = (x, y) => ({ id: 'p' + Math.random().toString(36).slice(2, 9), x, y, kind: 'grade', smooth: false, grade: {}, flags: {} }); E.app.doc.transact('yoke', () => { p.internals.push({ id: 'c' + Math.random().toString(36).slice(2, 9), type: 'internal', closed: false, points: [mk(260, 400), mk(0, 400)], style: 'solid' }); }); E.app.invalidate(); }),
    invoke: palette('slash'), drive: seq(h => h.clickLocal('FRONT', { x: 60, y: 400 }), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'not cut along the line: ' + c.after.pieces.map(p => p.name)) }),
  T('slash#merge', { title: 'Cut / Merge · Merge: click a seam line on FRONT, then on BACK', invoke: seq(palette('slash'), h => h.ev(() => { const E = window.__e2e; E.app.tool.setMode(E.app, 'merge'); })),
    drive: seq(seg('FRONT', 'SS_HEM', 'UA', 0.4), seg('BACK', 'TL', 'BL', 0.7), OK()), expect: (h, c) => req(c.after.pieces.length === 1, 'pieces not merged: ' + c.after.pieces.map(p => p.name)) }),
  T('curve#run', { tool: 'curve', title: 'Curve / Handle on several lines: BACK is laid against FRONT, FRONT hem + BACK side are picked (Shift+click) and shaped as ONE curve; the corner where they meet moves on both pieces alike',
    pre: h => h.ev(() => { const E = window.__e2e, b = E.P('BACK'), f = E.P('FRONT'); const bl = b.sew.points.find(a => a.name === 'BL'); E.app.doc.transact('lay BACK', () => { b.layout = { x: (f.layout?.x ?? 0) + 260 - bl.x, y: (f.layout?.y ?? 0) - bl.y, angleDeg: 0 }; }); E.C.runCommand('view.fit'); }),
    invoke: palette('curve'),
    drive: async h => {
      await h.settle(150);
      await h.clickSeg('FRONT', 'CF_HEM', 'SS_HEM', 0.4);
      const m = await h.ev(() => { const E = window.__e2e, b = E.P('BACK'); const g = n => b.sew.points.find(a => a.name === n); const L = b.layout; return { x: (g('BL').x + g('TL').x) / 2 + L.x, y: (g('BL').y + g('TL').y) / 2 + L.y }; });
      await h.clickW(m, { mods: ['Shift'] }); await h.settle(150);
      h._run = await h.ev(() => { const el = document.querySelector('[data-run]'); return el ? +el.getAttribute('data-run') : 0; });
      const hs = await h.ev(() => [...document.querySelectorAll('[data-run-handle]')].map(c => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
      h._handles = hs.length;
      if (hs.length) { const c = hs[0]; await h.page.mouse.move(c.x, c.y); await h.page.mouse.down(); for (let i = 1; i <= 8; i++) await h.page.mouse.move(c.x + 5 * i, c.y + 7 * i); await h.page.mouse.up(); await h.settle(200); }
      h._w = await h.ev(() => { const E = window.__e2e; const w = (pn, an) => { const p = E.P(pn), a = p.sew.points.find(q => q.name === an), L = p.layout ?? { x: 0, y: 0 }; return [a.x + L.x, a.y + L.y]; }; return { fj: w('FRONT', 'SS_HEM'), bj: w('BACK', 'BL'), f0: w('FRONT', 'CF_HEM'), b1: w('BACK', 'TL'), undo: E.app.doc.undoStack ? E.app.doc.undoStack.length : -1 }; });
    },
    expect: h => { const w = h._w; return [req(h._run === 2, 'the two lines are not one run: ' + h._run), req(h._handles === 2, 'run handles: ' + h._handles),
      req(Math.hypot(w.fj[0] - w.bj[0], w.fj[1] - w.bj[1]) < 1e-3, 'the joint differs on the two pieces: ' + JSON.stringify(w)),
      req(Math.hypot(w.fj[0] - 260, w.fj[1]) > 2, 'the joint did not move onto the curve: ' + w.fj),
      req(Math.hypot(w.f0[0], w.f0[1]) < 1e-3, 'the run end CF_HEM moved: ' + w.f0)]; } }),
  T('curve#overlay', { tool: 'curve', title: 'Curve / Handle on lines laid on top of each other: BACK is laid against FRONT with its corner on SS_HEM, so the FRONT side seam lies on the BACK side; the longest chain (FRONT hem + BACK side) is the run, the FRONT side seam lies over it: it gets the same shape and its corner UA moves onto the curve',
    pre: h => h.ev(() => { const E = window.__e2e, b = E.P('BACK'), f = E.P('FRONT'); const bl = b.sew.points.find(a => a.name === 'BL'); E.app.doc.transact('lay BACK', () => { b.layout = { x: (f.layout?.x ?? 0) + 260 - bl.x, y: (f.layout?.y ?? 0) - bl.y, angleDeg: 0 }; }); E.C.runCommand('view.fit'); }),
    invoke: palette('curve'),
    drive: async h => {
      await h.settle(150);
      h._tl0 = await h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'), a = p.sew.points.find(q => q.name === 'UA'); return [a.x, a.y]; });
      await h.ev(() => { const E = window.__e2e, f = E.P('FRONT'), b = E.P('BACK'); const id = (p, n) => p.sew.points.find(a => a.name === n).id;
        E.app.setTool('select'); E.app.sel = { pieces: [], anchors: [], segments: [
          { pieceId: f.id, contourId: f.sew.id, from: id(f, 'CF_HEM'), to: id(f, 'SS_HEM') }, { pieceId: f.id, contourId: f.sew.id, from: id(f, 'SS_HEM'), to: id(f, 'UA') },
          { pieceId: b.id, contourId: b.sew.id, from: id(b, 'TL'), to: id(b, 'BL') }] }; E.app.setTool('curve'); E.app.invalidate(); });
      await h.settle(200);
      h._run = await h.ev(() => { const el = document.querySelector('[data-run]'); return el ? +el.getAttribute('data-run') : 0; });
      h._ov = await h.ev(() => document.querySelectorAll('[data-run-overlay]').length);
      const hs = await h.ev(() => [...document.querySelectorAll('[data-run-handle]')].map(c => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
      if (hs.length) { const c = hs[0]; await h.page.mouse.move(c.x, c.y); await h.page.mouse.down(); for (let i = 1; i <= 8; i++) await h.page.mouse.move(c.x + 4 * i, c.y + 6 * i); await h.page.mouse.up(); await h.settle(200); }
      h._w = await h.ev(() => { const E = window.__e2e; const w = (pn, an) => { const p = E.P(pn), a = p.sew.points.find(q => q.name === an); return E.localToWorld ? (() => { const v = E.localToWorld(pn, { x: a.x, y: a.y }); return [v.x, v.y]; })() : [a.x, a.y]; };
        const p = E.P('FRONT'), tl = p.sew.points.find(q => q.name === 'UA'), bl = p.sew.points.find(q => q.name === 'SS_HEM'); const rc = E.ops.runCurve(E.app.doc, [{ pieceId: E.P('FRONT').id, contourId: E.P('FRONT').sew.id, from: p.sew.points.find(q => q.name === 'CF_HEM').id, to: bl.id }, (() => { const b = E.P('BACK'); const g = n => b.sew.points.find(q => q.name === n).id; return { pieceId: b.id, contourId: b.sew.id, from: g('TL'), to: g('BL') }; })()], { tol: 3 }); const ua = w('FRONT', 'UA'); let off = Infinity; for (let k = 0; k <= 4000; k++) { const t = k / 4000, u = 1 - t; const x = u * u * u * rc.p0.x + 3 * u * u * t * rc.h0.x + 3 * u * t * t * rc.h3.x + t * t * t * rc.p3.x, y = u * u * u * rc.p0.y + 3 * u * u * t * rc.h0.y + 3 * u * t * t * rc.h3.y + t * t * t * rc.p3.y; off = Math.min(off, Math.hypot(x - ua[0], y - ua[1])); } return { fj: w('FRONT', 'SS_HEM'), bj: w('BACK', 'BL'), tl: [tl.x, tl.y], hin: bl.hOut || null, off, dev: rc.dev }; });
    },
    expect: h => { const w = h._w; return [req(h._run === 3, 'three lines in the run: ' + h._run), req(h._ov === 1, 'one line laid over the run: ' + h._ov),
      req(Math.hypot(w.fj[0] - w.bj[0], w.fj[1] - w.bj[1]) < 1e-3, 'the two corners differ at the joint: ' + JSON.stringify(w)),
      req(Math.hypot(w.tl[0] - h._tl0[0], w.tl[1] - h._tl0[1]) > 1, 'the corner UA of the overlay line did not move: ' + w.tl), req(w.off < 0.3, 'UA is not on the curve: ' + w.off + ' (run dev ' + w.dev + ')'),
      req(Math.hypot(w.fj[0] - 260, w.fj[1]) > 2, 'the joint did not move: ' + w.fj), req(!!w.hin, 'the overlay line was not shaped')]; } }),
  T('fold', { tool: 'fold', change: false, title: 'Fold: click two points of FRONT (hem at x = 85, then HPS) → the smaller part is shown folded over (a view: the outline does not change); Piece ▸ Unfold all puts it back',
    invoke: palette('fold'),
    drive: async h => { h._pts0 = await h.ev(() => JSON.stringify(window.__e2e.P('FRONT').sew.points.map(a => [a.x, a.y]))); await h.clickLocal('FRONT', { x: 85, y: 0 }); await h.clickA('FRONT', 'HPS'); await h.settle(150);
      h._f = await h.ev(() => { const E = window.__e2e, p = E.P('FRONT'); return { fold: p.fold || null, over: document.querySelectorAll('[data-fold="over"]').length, same: JSON.stringify(p.sew.points.map(a => [a.x, a.y])), folded: p.fold ? [E.ops.onFoldedPart(p, { x: 40, y: 300 }), E.ops.onFoldedPart(p, { x: 200, y: 300 })] : [] }; });
      await h.ev(() => window.__e2e.C.runCommand('piece.unfoldAll')); await h.settle(100);
      h._u = await h.ev(() => !window.__e2e.P('FRONT').fold); },
    expect: h => [req(!!h._f.fold, 'FRONT is not folded'), req(h._f.over === 1, 'the folded part is not drawn: ' + h._f.over), req(h._f.same === h._pts0, 'the outline changed'),
      req(h._f.folded.join() === 'true,false', 'the smaller (left) part should be the folded one: ' + h._f.folded), req(h._u === true, 'Unfold all did not unfold')] }),
  T('match', { tool: 'match', title: 'Match Line: BACK is laid against FRONT and its side is bent; STEP 1 click the BACK side, right-click ▸ OK (top of the menu); STEP 2 click the FRONT side seam, right-click ▸ OK → the side seam takes that shape, keeps its length, and UA moves onto it; BACK does not change',
    pre: h => h.ev(() => { const E = window.__e2e, b = E.P('BACK'), f = E.P('FRONT'); const g = n => b.sew.points.find(a => a.name === n); E.app.doc.transact('lay BACK', () => { b.layout = { x: (f.layout?.x ?? 0) + 260 - g('BL').x, y: (f.layout?.y ?? 0) - g('BL').y, angleDeg: 0 }; });
      E.ops.shapeSegment(E.app.doc, b.id, b.sew.id, g('TL').id, g('BL').id, { start: { x: 60, y: -200 }, end: { x: 60, y: 200 } }); E.C.runCommand('view.fit'); }),
    invoke: palette('match'),
    drive: async h => {
      await h.settle(150);
      const info = () => h.ev(() => { const E = window.__e2e, f = E.P('FRONT'), b = E.P('BACK'); const id = (p, n) => p.sew.points.find(a => a.name === n).id; const len = (p, x, y) => E.ops.segmentCurve(p, E.app.doc.sizeLine(p), p.sew.id, id(p, x), id(p, y)).length; const ua = f.sew.points.find(a => a.name === 'UA'), ss = f.sew.points.find(a => a.name === 'SS_HEM');
        return { fl: len(f, 'SS_HEM', 'UA'), back: JSON.stringify(b.sew.points.map(a => [a.x, a.y, a.hIn, a.hOut])), ua: [ua.x, ua.y], hout: ss.hOut || null }; });
      h._a = await info();
      const bm = await h.ev(() => { const E = window.__e2e, b = E.P('BACK'); const g = n => b.sew.points.find(a => a.name === n); const sc = E.ops.segmentCurve(b, E.app.doc.sizeLine(b), b.sew.id, g('TL').id, g('BL').id); const t = 0.12, u = 1 - t; const L = b.layout; return { x: u * u * u * sc.p0.x + 3 * u * u * t * sc.h0.x + 3 * u * t * t * sc.h3.x + t * t * t * sc.p3.x + L.x, y: u * u * u * sc.p0.y + 3 * u * u * t * sc.h0.y + 3 * u * t * t * sc.h3.y + t * t * t * sc.p3.y + L.y }; });
      const okMenu = async () => { await h.clickW({ x: 520, y: 350 }, { button: 'right' }); await h.page.waitForSelector('.ctx-menu .menu-item'); const items = await h.ev(() => [...document.querySelectorAll('.ctx-menu .menu-item')].map(b => b.textContent.trim())); await h.page.locator('.ctx-menu .menu-item').first().click(); await h.settle(150); return items; };
      await h.clickW(bm); await h.settle(100);
      h._m1 = await okMenu();
      h._step = await h.ev(() => window.__e2e.app.tool.mode(window.__e2e.app));
      await h.clickSeg('FRONT', 'SS_HEM', 'UA', 0.5); await h.settle(200);
      h._n = await h.ev(() => [document.querySelectorAll('[data-match="1st"]').length, document.querySelectorAll('[data-match="2nd"]').length]);
      h._m2 = await okMenu();
      h._b = await info(); },
    expect: h => [req(/^OK/.test(h._m1[0]) && /Select tool/.test(h._m1.join('|')) && h._m1.findIndex(t => /^OK/.test(t)) < h._m1.findIndex(t => /Select tool/.test(t)), 'OK should be on top of the right-click menu, above Select tool: ' + h._m1.slice(0, 4)), req(h._step === '2', 'OK should go to step 2: ' + h._step), req(/^OK/.test(h._m2[0]), 'step 2 menu: ' + h._m2.slice(0, 3)),
      req(h._n.join() === '1,1', '1st / 2nd line marks: ' + h._n), req(h._b.back === h._a.back, 'BACK (the 1st line) changed'),
      req(Math.abs(h._b.fl - h._a.fl) < 0.1, `the side seam length changed: ${h._a.fl} → ${h._b.fl}`), req(!!h._b.hout, 'the side seam was not shaped'),
      req(Math.hypot(h._b.ua[0] - h._a.ua[0], h._b.ua[1] - h._a.ua[1]) > 2, 'UA did not move onto the 1st line: ' + h._b.ua)] }),
  T('curve', { tool: 'curve', invoke: palette('curve'), drive: async h => { await h.clickA('FRONT', 'AH1'); const w = await h.ev(() => window.__e2e.handleW('FRONT', 'AH1', 'out')); await h.dragW(w, { x: w.x + 10, y: w.y + 10 }, { steps: 8 }); }, expect: (h, c) => req(!!an(c.after, 'FRONT', 'AH1').hOut, 'handle not set') }),
  T('select#box', { tool: 'movePoint', title: 'Select: window box (left→right) vs crossing box (right→left)', invoke: palette('select'), change: false,
    drive: async h => { await h.dragW({ x: -20, y: -20 }, { x: 270, y: 30 }); h._win = await h.sel(); await h.clickW({ x: 1000, y: 700 }); /* a box starts on the empty sheet: a drag that starts inside a piece moves the piece */ await h.dragW({ x: 290, y: -20 }, { x: 100, y: 30 }); h._cross = await h.sel(); },
    expect: h => [req(h._win.anchors.length === 2, 'window box: ' + JSON.stringify(h._win)), req(h._cross.anchors.length + h._cross.segments.length >= 1, 'crossing box selected nothing: ' + JSON.stringify(h._cross))] }),
  T('hand', { invoke: palette('hand'), change: false, drive: async h => { h._v = await view(h); await h.dragW({ x: 300, y: 300 }, { x: 400, y: 350 }); }, expect: async h => req((await view(h)).x !== h._v.x, 'no pan') }),
  T('zoom', { invoke: palette('zoom'), change: false, drive: async h => { h._v = await view(h); await h.clickW({ x: 300, y: 300 }); }, expect: async h => req((await view(h)).s > h._v.s, 'no zoom') }),
];

module.exports = { cases, palette, hotkey };
