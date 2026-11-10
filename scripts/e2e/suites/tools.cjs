// One case per palette tool: activate it from the palette (incl. flyouts) or its hotkey, then use it.
const Q = require('../lib/q.cjs');
const { pc, an, near, count, npts, req } = Q;
const { DLG, OK, W, seq, at, seg, IB } = require('./commands.cjs');

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
  T('select', { invoke: seq(hotkey('p', 'pen'), palette('select')), drive: async h => { await h.clickA('FRONT', 'SS_HEM'); }, change: false, expect: (h, c) => req(c.afterSel.anchors[0] === 'FRONT/SS_HEM', 'click did not select the point') }),
  T('pen', { invoke: palette('pen'), drive: seq(W(700, 50), W(850, 50), W(850, 250, ['Control']), W(780, 300), W(700, 50), DLG({ name: 'POCKET', seam: '5/8' })),
    expect: (h, c) => { const p = pc(c.after, 'POCKET'); return [req(p.sew.points.length === 4, 'pocket should have 4 points'), req(p.sew.points.some(a => a.kind === 'curve'), 'Ctrl+click did not make a curve point'), req(p.seamDefault === 0.625, 'seam "5/8" mm → ' + p.seamDefault)]; } }),
  T('pen#keys', { title: 'pen: Backspace removes a point, Enter closes, right-click = exact next point', invoke: hotkey('p', 'pen'),
    drive: async h => { await h.clickW({ x: 700, y: 50 }); await h.clickW({ x: 800, y: 50 }); await h.clickW({ x: 760, y: 120 }); await h.key('Backspace'); await h.clickW({ x: 800, y: 50 }, { button: 'right' }); await h.waitDialog(); await h.fields({ mode: 'la', a: '100', b: '90' }); await h.ok(); await h.key('Enter'); await h.waitDialog(); await h.ok(); },
    expect: (h, c) => { const p = c.after.pieces[2]; if (!p) return 'no piece'; const ys = p.sew.points.map(a => Math.round(a.y)); return req(p.sew.points.length === 3 && ys.includes(150), 'points ' + JSON.stringify(p.sew.points.map(a => [Math.round(a.x), Math.round(a.y)]))); } }),
  T('internal', { invoke: palette('internal'), drive: seq(W(60, 100), W(60, 300), h => h.key('Enter')), expect: (h, c) => req(count(c.after, 'FRONT', 'internals') === 2, 'no internal') }),
  T('internal#polygon', { title: 'internal: closed polygon by clicking the start', invoke: hotkey('i', 'internal'), drive: seq(W(30, 100), W(100, 100), W(100, 200), W(30, 100)), expect: (h, c) => req(pc(c.after, 'FRONT').internals.some(i => i.closed), 'no closed internal') }),
  T('smooth', { invoke: palette('smooth'), drive: async h => { await h.clickA('FRONT', 'UA'); await h.clickA('FRONT', 'SH'); await h.key('Enter'); } }),
  T('rect', { invoke: palette('rect'), drive: async h => { await h.dragW({ x: 700, y: 50 }, { x: 850, y: 250 }); }, expect: (h, c) => req(c.after.pieces.length === 3, 'no rectangle') }),
  T('rect#dialog', { title: 'rectangle: click → exact size dialog (inch fractions)', invoke: seq(h => h.page.locator('select.sb-unit').selectOption('in16'), hotkey('r', 'rect')), drive: seq(W(700, 50), DLG({ w: '10 1/2', h: '5' })),
    expect: (h, c) => { const p = c.after.pieces[2]; const xs = p.sew.points.map(a => a.x); return req(near(Math.max(...xs) - Math.min(...xs), 266.7, 0.01), 'width ' + (Math.max(...xs) - Math.min(...xs))); } }),
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
  T('dart#typed', { title: 'Dart: legs by clicks, right-click → width 20 · depth 100', invoke: hotkey('Shift+D', 'dart'),
    drive: async h => { await seg('FRONT', 'CF_HEM', 'SS_HEM', 0.45)(h); await seg('FRONT', 'CF_HEM', 'SS_HEM', 0.55)(h); await h.clickW({ x: 130, y: 120 }, { button: 'right' }); await IB({ w: '20', d: '100' }, 'Width · Depth')(h); },
    expect: async h => { const g = await h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'); return p.darts[0] ? E.ops.dartInfo(E.app.doc, p.id, p.darts[0].id) : null; }); return req(!!g && near(g.width, 20, 1e-6) && near(g.depth, 100, 1e-6), 'dart ' + JSON.stringify(g && { w: g.width, d: g.depth })); } }),
  T('pleat', { title: 'Pleat: start, end, then the cursor sets the last pleat line (3 knife pleats)', invoke: palette('pleat'), drive: seq(h => h.clickLocal('BACK', { x: 470, y: 700 }), h => h.clickLocal('BACK', { x: 470, y: 400 }), h => h.clickLocal('BACK', { x: 530, y: 500 })), expect: (h, c) => req(count(c.after, 'BACK', 'pleats') === 3, 'expected 3 pleats, got ' + count(c.after, 'BACK', 'pleats')) }),
  T('pleat#axis', { title: 'Pleat: Alt on the END click = pleat axis only', invoke: hotkey('Shift+L', 'pleat'), drive: seq(h => h.clickLocal('BACK', { x: 470, y: 700 }), h => h.clickLocal('BACK', { x: 470, y: 400 }, { mods: ['Alt'] })), expect: (h, c) => req(count(c.after, 'BACK', 'pleats') === 1 && !pc(c.after, 'BACK').pleats[0].open, 'expected 1 closed pleat axis') }),
  T('fullness', { title: 'Slash & spread: slash point, pivot, then click the opening', invoke: palette('fullness'), drive: seq(h => h.clickLocal('BACK', { x: 470, y: 0 }), h => h.clickLocal('BACK', { x: 470, y: 600 }), h => h.clickLocal('BACK', { x: 500, y: 200 })), expect: (h, c) => req(count(c.after, 'BACK', 'fullness') === 1, 'no fullness') }),
  T('fullness#typed', { title: 'Slash & spread: hem slash, waist hinge, right-click → opening 25', invoke: hotkey('Shift+U', 'fullness'),
    drive: async h => { await h.clickLocal('BACK', { x: 500, y: 0 }); await h.clickLocal('BACK', { x: 500, y: 700 }); await h.clickW(await h.local2world('BACK', { x: 540, y: 300 }), { button: 'right' }); await IB({ w: '25' }, 'Uniform')(h); },
    expect: async h => { const o = await h.ev(() => { const E = window.__e2e; const p = E.P('BACK'); return (p.fullness ?? [])[0] ? E.ops.fullnessOpenings(E.app.doc, p.id, p.fullness[0].id) : null; }); return req(!!o && near(o[0], 25, 1e-6), 'openings ' + JSON.stringify(o)); } }),
  T('slash', { title: 'slash: start OUTSIDE the piece (as the tool hint says), across, Enter', invoke: palette('slash'),
    drive: async h => { h._hint = await h.ev(() => window.__e2e.app.tool.hint(window.__e2e.app)); await W(-30, 300)(h); h._st = await h.ev(() => window.__e2e.app.statusMsg); await W(300, 300)(h); await h.key('Enter'); if (await h.hasDialog()) await h.ok(); },
    expect: (h, c) => req(c.after.pieces.length === 3, `not slashed — hint says "${h._hint}", first click outside → status "${h._st}"`) }),
  T('slash#outline', { title: 'slash: start ON the outline (CF), across, Enter', invoke: palette('slash'), drive: seq(W(0, 300), W(300, 300), h => h.key('Enter'), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'not slashed: ' + c.after.pieces.map(p => p.name)) }),
  T('trace', { invoke: palette('trace'), drive: seq(at('FRONT', 'CF_HEM'), at('FRONT', 'SS_HEM'), at('FRONT', 'UA'), h => h.key('Enter'), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'no traced piece') }),
  // Measure opens in Line mode (AccuMark Line Length; suite measure-grade); Tab = Distance mode (point to point)
  T('measure', { invoke: seq(palette('measure'), h => h.key('Tab')), change: false, drive: seq(at('FRONT', 'SS_HEM'), at('FRONT', 'UA')),
    expect: async (h, c) => [req(c.rec.statuses.some(s => /L 465/.test(s)), 'status lacks "L 465": ' + c.rec.statuses.slice(-2)), req(await h.ev(() => document.querySelectorAll('.fwin[data-win="measure"] tr').length === 5), 'per-size table missing')] }),
  T('walk', { invoke: palette('walk'), drive: async h => { await h.clickA('FRONT', 'SS_HEM'); await h.clickA('BACK', 'BL'); for (let i = 0; i < 5; i++) await h.key('ArrowRight'); await h.key('n'); await h.key('Escape'); },
    expect: (h, c) => req(count(c.after, 'FRONT', 'notches') === 2 && count(c.after, 'BACK', 'notches') === 1, 'walk notches not dropped on both pieces') }),
  T('movePoint', { tool: 'movePoint', invoke: palette('movePoint'), drive: async h => { const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 15, y: w.y }, { steps: 10 }); }, expect: (h, c) => [req(an(c.after, 'FRONT', 'UA').x > 268, 'UA not moved'), req(!Q.otherChanged(c.before, c.after, 'FRONT', ['UA']).length, 'others changed')] }),
  T('movePoint#clickclick', { tool: 'movePoint', title: 'Move Point: click the point, click the new spot (AccuMark click-click)', invoke: hotkey('g', 'movePoint'), drive: async h => { const w = await h.W('FRONT', 'UA'); await h.clickW(w); await h.page.waitForTimeout(500); await h.clickW({ x: w.x + 20, y: w.y + 10 }); }, expect: (h, c) => req(an(c.after, 'FRONT', 'UA').x > 270, 'UA.x ' + an(c.after, 'FRONT', 'UA').x) }),
  T('movePoint#input', { tool: 'movePoint', title: 'Move Point: pick, type "1 1/8" (in16) in the input box, Enter', invoke: seq(h => h.page.locator('select.sb-unit').selectOption('in16'), hotkey('g', 'movePoint')),
    drive: async h => { const w = await h.W('FRONT', 'UA'); await h.clickW(w); await h.page.keyboard.type('1'); await h.page.waitForSelector('.ibox'); const ins = h.page.locator('.ibox input'); await ins.nth(0).fill('1 1/8'); await ins.nth(1).fill('0'); await ins.nth(1).press('Enter'); await h.settle(); },
    expect: (h, c) => req(near(an(c.after, 'FRONT', 'UA').x, 288.575, 1e-3) && near(an(c.after, 'FRONT', 'UA').y, 465, 1e-3), `UA (${an(c.after, 'FRONT', 'UA').x},${an(c.after, 'FRONT', 'UA').y}) want (288.575,465)`) }),
  T('moveLine', { tool: 'moveLine', invoke: palette('moveLine'), drive: async h => { const w = await h.along('FRONT', 'SS_HEM', 'UA', 0.5); await h.dragW(w, { x: w.x + 15, y: w.y }, { steps: 10 }); }, expect: (h, c) => req(an(c.after, 'FRONT', 'UA').x > 268 && an(c.after, 'FRONT', 'SS_HEM').x > 268, 'side seam not moved') }),
  T('movePiece', { tool: 'movePiece', invoke: palette('movePiece'), drive: async h => { const w = await h.local2world('BACK', { x: 520, y: 300 }); await h.dragW(w, { x: w.x + 40, y: w.y }, { steps: 10 }); }, expect: (h, c) => req((pc(c.after, 'BACK').layout?.x ?? 0) > 30, 'BACK not moved') }),
  T('curve', { tool: 'curve', invoke: palette('curve'), drive: async h => { await h.clickA('FRONT', 'AH1'); const w = await h.ev(() => window.__e2e.handleW('FRONT', 'AH1', 'out')); await h.dragW(w, { x: w.x + 10, y: w.y + 10 }, { steps: 8 }); }, expect: (h, c) => req(!!an(c.after, 'FRONT', 'AH1').hOut, 'handle not set') }),
  T('select#box', { tool: 'movePoint', title: 'Select: window box (left→right) vs crossing box (right→left)', invoke: palette('select'), change: false,
    drive: async h => { await h.dragW({ x: -20, y: -20 }, { x: 270, y: 30 }); h._win = await h.sel(); await h.clickW({ x: 1000, y: 700 }); await h.dragW({ x: 270, y: 30 }, { x: 100, y: -20 }); h._cross = await h.sel(); },
    expect: h => [req(h._win.anchors.length === 2, 'window box: ' + JSON.stringify(h._win)), req(h._cross.anchors.length + h._cross.segments.length >= 1, 'crossing box selected nothing: ' + JSON.stringify(h._cross))] }),
  T('hand', { invoke: palette('hand'), change: false, drive: async h => { h._v = await view(h); await h.dragW({ x: 300, y: 300 }, { x: 400, y: 350 }); }, expect: async h => req((await view(h)).x !== h._v.x, 'no pan') }),
  T('zoom', { invoke: palette('zoom'), change: false, drive: async h => { h._v = await view(h); await h.clickW({ x: 300, y: 300 }); }, expect: async h => req((await view(h)).s > h._v.s, 'no zoom') }),
];

module.exports = { cases, palette, hotkey };
