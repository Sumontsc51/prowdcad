// Measure Line (AccuMark Measure ▸ Line Length), rows = sizes grading table, Grade Rules and grade
// by measurement. Cases run through the generic runner (reset → pre → sel → invoke → drive →
// expect → undo / redo), ids "mgrade#…" (invoke-driven, not registry commands).
const Q = require('../lib/q.cjs');
const { an, abs, near, req } = Q;
const { P, A } = require('./commands.cjs');

const M = 'Measure+Grade';
const C = (id, o) => ({ id: 'mgrade#' + id, menu: M, title: o.title ?? id, ...o });

/** the Measure window table: [{size, cells: {"g:part": {t, cls}}}] */
const mtab = h => h.ev(() => [...document.querySelectorAll('.fwin[data-win="mline"] table.sg tbody tr[data-r]')].map(tr => ({
  size: tr.dataset.size, cls: tr.className,
  cells: Object.fromEntries([...tr.querySelectorAll('td[data-part]')].map(td => [(td.dataset.g ?? '') + ':' + td.dataset.part, { t: td.textContent, cls: td.className }])),
})));
const num = t => parseFloat(String(t).replace(/[^\d.\-]/g, ''));
/** hand calculation: kernel measureSegment of each listed segment per size */
const hand = (h, segs) => h.ev(segs => { const E = window.__e2e; return E.app.sizeLine().sizes.map(s => ({ size: s.name, parts: segs.map(([p, a, b]) => E.segLen(p, a, b, s.id)) })); }, segs);
const MSmod = h => h.ev(async () => { const m = await import('/src/panels/measure-table.ts'); return { groups: m.MS.groups.map(g => ({ name: g.name, parts: g.parts.map(p => ({ label: p.label, cut: !!p.cut, from: p.ref.from, to: p.ref.to })) })), history: m.MS.history.length }; });
const resetMeasure = async h => { await h.ev(async () => { const m = await import('/src/panels/measure-table.ts'); m.MS.groups = []; m.MS.cur = -1; m.MS.history = []; m.MS.tol = null; m.MS.ease = 0; m.MS.diff = 'BA'; m.MS.mode = 'contour'; }); };
const gcell = (h, size, axis) => h.page.locator(`.sg-wrap.gr input[data-size="${size}"][data-axis="${axis}"]`).first();
async function typeInto(h, loc, text) { await loc.click({ clickCount: 3 }); await loc.fill(text); await loc.press('Enter'); await h.settle(60); }
async function pasteInto(h, sel, text) {
  await h.ev(([sel, text]) => { const inp = document.querySelector(sel); if (!inp) throw new Error('no cell ' + sel); inp.focus(); const dt = new DataTransfer(); dt.setData('text/plain', text); inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, [sel, text]);
  await h.settle(80);
}
const status = h => h.ev(() => window.__e2e.app.statusMsg);
const ae = h => h.ev(() => { const a = document.activeElement; return a ? { size: a.dataset?.size, axis: a.dataset?.axis, k: a.dataset?.k } : null; });

const cases = [
  // ── A. Measure Line: L1 + L2 + L3 = Σ per size, equal to the hand calculation ──
  C('line-sum', {
    title: 'Measure Line: hem + side seam + armhole summed per size (L1+L2+L3 = Σ) = hand calc; labels; Enter = OK',
    change: false,
    pre: resetMeasure,
    invoke: async h => { await h.key('m'); },
    drive: async h => { await h.clickSeg('FRONT', 'CF_HEM', 'SS_HEM'); await h.clickSeg('FRONT', 'SS_HEM', 'UA'); await h.clickSeg('FRONT', 'UA', 'SH'); },
    expect: async h => {
      const t = await mtab(h); const hc = await hand(h, [['FRONT', 'CF_HEM', 'SS_HEM'], ['FRONT', 'SS_HEM', 'UA'], ['FRONT', 'UA', 'SH']]);
      const labels = await h.page.locator('text.m-label').allTextContents();
      const errs = [req(t.length === 4, `table rows ${t.length} (want 4 sizes)`), req(labels.join(',') === 'L1,L2,L3', 'canvas labels ' + labels)];
      for (const row of hc) {
        const r = t.find(x => x.size === row.size); if (!r) { errs.push('no row ' + row.size); continue; }
        const sum = row.parts.reduce((a, b) => a + b, 0);
        row.parts.forEach((v, k) => { const got = num(r.cells[`0:L${k + 1}`]?.t); if (!near(got, v, 0.006)) errs.push(`${row.size} L${k + 1} ${got} ≠ ${v.toFixed(3)}`); });
        const got = num(r.cells['0:sum']?.t); if (!near(got, sum, 0.006)) errs.push(`${row.size} Σ ${got} ≠ hand ${sum.toFixed(3)}`);
      }
      const dprev = num(t[2].cells[':dprev']?.t ?? t[2].cells['undefined:dprev']?.t);
      await h.key('Enter');
      const st = await MSmod(h);
      errs.push(req(st.history === 1 && !st.groups.length, `Enter did not keep the measurement: ${JSON.stringify(st)}`));
      errs.push(req((await h.page.locator('text.m-label').count()) === 0, 'labels still drawn after OK'));
      h._note = `S Σ ${t[0].cells['0:sum'].t} · XL Σ ${t[3].cells['0:sum'].t} · Δprev(L) ${dprev}`;
      return errs;
    },
    after: async (h, c, r) => r.notes.push(h._note || ''),
  }),

  // ── click again removes, Backspace, Shift+click extends the run, Alt = cut line ──
  C('line-edit', {
    title: 'Measure Line: click a picked line = remove, Backspace = last off, Shift+click extends, Alt = cut line',
    change: false, pre: resetMeasure,
    invoke: async h => { await h.key('m'); },
    drive: async h => {
      await h.clickSeg('FRONT', 'CF_HEM', 'SS_HEM'); await h.clickSeg('FRONT', 'SS_HEM', 'UA'); await h.clickSeg('FRONT', 'UA', 'SH');
      await h.clickSeg('FRONT', 'SS_HEM', 'UA'); h._s1 = await MSmod(h);
      await h.key('Backspace'); h._s2 = await MSmod(h);
      await h.clickSeg('FRONT', 'SH', 'HPS', 0.5, { mods: ['Shift'] }); h._s3 = await MSmod(h);
      await h.clickSeg('FRONT', 'CF_NECK', 'CF_HEM', 0.5, { mods: ['Alt'] }); h._s4 = await MSmod(h);
    },
    expect: async h => {
      const n = s => s.groups[0]?.parts.length ?? 0;
      const t = await mtab(h);
      const sew = (await hand(h, [['FRONT', 'CF_NECK', 'CF_HEM']]))[1].parts[0];
      const cutM = num(t.find(r => r.size === 'M')?.cells['0:L5']?.t);
      return [
        req(n(h._s1) === 2 && h._s1.groups[0].parts[1].label === 'L2', 'click on a picked line did not remove it: ' + JSON.stringify(h._s1)),
        req(n(h._s2) === 1, 'Backspace did not remove the last line'),
        req(n(h._s3) === 4, `Shift+click should extend hem → side → armhole → shoulder (4 lines), got ${n(h._s3)}`),
        req(n(h._s4) === 5 && h._s4.groups[0].parts[4].cut, 'Alt+click did not add a cut-line part'),
        req(cutM > sew + 5, `cut CF length ${cutM} should exceed the sew CF ${sew.toFixed(2)} (seam allowance)`),
      ];
    },
  }),

  // ── B. comparison across two pieces with a difference column, A−B toggle, ease ± tolerance ──
  C('compare', {
    title: 'Measure Line comparison: FRONT side seam (A) vs BACK side seam (B): Σ A, Σ B, B − A per size, A − B toggle, ease ± tol pass/fail',
    change: false, pre: resetMeasure,
    invoke: async h => { await h.key('m'); },
    drive: async h => { await h.clickSeg('FRONT', 'SS_HEM', 'UA'); await h.clickSeg('BACK', 'BR', 'TR'); },
    expect: async h => {
      const errs = [];
      const st = await MSmod(h);
      errs.push(req(st.groups.length === 2, 'a click on another piece should start group B: ' + JSON.stringify(st)));
      const hc = await hand(h, [['FRONT', 'SS_HEM', 'UA'], ['BACK', 'BR', 'TR']]);
      let t = await mtab(h);
      for (const row of hc) {
        const r = t.find(x => x.size === row.size); const d = row.parts[1] - row.parts[0];
        const got = num(r?.cells['1:diff']?.t);
        if (!near(got, d, 0.006)) errs.push(`${row.size} B−A ${got} ≠ ${d.toFixed(3)}`);
        if (!near(num(r?.cells['0:sum']?.t), row.parts[0], 0.006) || !near(num(r?.cells['1:sum']?.t), row.parts[1], 0.006)) errs.push(`${row.size} Σ A/B wrong`);
      }
      await h.page.locator('.fwin[data-win="mline"] [data-diff="AB"]').click(); await h.settle(60);
      t = await mtab(h);
      const mRow = hc.find(r => r.size === 'M'); const dM = mRow.parts[1] - mRow.parts[0];
      errs.push(req(near(num(t.find(r => r.size === 'M').cells['1:diff'].t), -dM, 0.006), 'A − B toggle did not flip the sign'));
      await h.page.locator('.fwin[data-win="mline"] [data-diff="BA"]').click(); await h.settle(60);
      await typeInto(h, h.page.locator('.fwin[data-win="mline"] input.m-ease'), (Math.round(dM * 100) / 100).toString());
      await typeInto(h, h.page.locator('.fwin[data-win="mline"] input.m-tol'), '0.5');
      t = await mtab(h);
      const chk = s => t.find(r => r.size === s)?.cells['undefined:check'] ?? t.find(r => r.size === s)?.cells[':check'];
      errs.push(req(chk('M')?.t === '✓' && /pass/.test(chk('M')?.cls), 'base size should pass: ' + JSON.stringify(chk('M'))));
      errs.push(req(chk('XL')?.t === '✗' && /fail/.test(chk('XL')?.cls), 'XL should fail (ease grows 3 mm / size): ' + JSON.stringify(chk('XL'))));
      errs.push(req(await h.page.locator('.fwin[data-win="mline"] [data-check="fail"]').count() === 1, 'no fail summary'));
      return errs;
    },
  }),
  C('compare-ctrl', {
    title: 'Measure Line: Ctrl+click on the same piece forces a new group; groups can be renamed',
    change: false, pre: resetMeasure,
    invoke: async h => { await h.key('m'); },
    drive: async h => {
      await h.clickSeg('FRONT', 'CF_HEM', 'SS_HEM'); await h.clickSeg('FRONT', 'CF_NECK', 'CF_HEM', 0.5, { mods: ['Control'] });
      const nm = h.page.locator('.fwin[data-win="mline"] input.m-gname[data-g="0"]'); await nm.click({ clickCount: 3 }); await nm.fill('Hem'); await nm.press('Enter'); await h.settle(60);
    },
    expect: async h => { const st = await MSmod(h); return [req(st.groups.length === 2, 'Ctrl+click did not start a second group'), req(st.groups[0].name === 'Hem', 'group not renamed: ' + st.groups[0].name)]; },
  }),

  // ── nested view: each size row uses that size's geometry, other sizes' outlines are pickable ──
  C('nested', {
    title: 'Measure Line in nested view: clicking the XL outline picks the segment; rows use each size’s geometry',
    change: false, pre: resetMeasure,
    invoke: async h => { await h.key('Alt+n'); await h.key('m'); },
    drive: async h => {
      const a = await h.W('FRONT', 'SS_HEM', await h.ev(() => window.__e2e.sizeId('XL'))), b = await h.W('FRONT', 'UA', await h.ev(() => window.__e2e.sizeId('XL')));
      await h.clickW({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    },
    expect: async h => {
      const st = await MSmod(h); const t = await mtab(h); const hc = await hand(h, [['FRONT', 'SS_HEM', 'UA']]);
      const errs = [req(st.groups[0]?.parts.length === 1, 'XL outline click did not pick a line')];
      for (const row of hc) if (!near(num(t.find(r => r.size === row.size)?.cells['0:L1']?.t), row.parts[0], 0.006)) errs.push(`${row.size}: ${t.find(r => r.size === row.size)?.cells['0:L1']?.t} ≠ ${row.parts[0]}`);
      return errs;
    },
  }),

  // ── copy as TSV (Excel), rows = sizes ──
  C('tsv', {
    title: 'Measure window: Copy TSV gives a header + one row per size',
    change: false, pre: resetMeasure,
    invoke: async h => { await h.key('m'); },
    drive: async h => { await h.clickSeg('FRONT', 'CF_HEM', 'SS_HEM'); await h.clickSeg('FRONT', 'SS_HEM', 'UA'); await h.page.locator('.fwin[data-win="mline"] [data-act="copy"]').click(); await h.settle(120); },
    expect: async h => { const t = await h.ev(() => window.__lastCopied || ''); const lines = t.split('\n'); return [req(lines.length === 5, 'TSV lines ' + lines.length), req(/^Size\t/.test(lines[0]) && lines[0].split('\t').length === 5, 'header ' + lines[0]), req(lines[1].startsWith('S\t') && lines[4].startsWith('XL\t'), 'rows are not sizes')]; },
  }),

  // ── 80 sizes: grading table + Measure window render and scroll under 1 s ──
  C('sizes80', {
    title: '80-size style: grading table (rows = sizes, virtualised) and Measure window render < 1 s and scroll to the last size',
    change: false,
    pre: P((app, ops, doc) => { for (let i = 5; i <= 80; i++) ops.appendSize(doc, 'S' + i, { extrapolate: true }); }),
    sel: A('FRONT', 'UA'),
    invoke: async h => { await resetMeasure(h); },
    drive: async h => {
      h._perf = await h.ev(async () => {
        const E = window.__e2e; const { app, settings } = E;
        const t0 = performance.now(); settings.panels.grading = true; app.invalidate(); app.flush(); const t1 = performance.now();
        const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        await raf2(); await E.flush();
        let wrap = document.querySelector('.sg-wrap.gr');
        const rendered = wrap ? wrap.querySelectorAll('tbody tr[data-r]').length : -1;
        const s0 = performance.now(); wrap.scrollTop = wrap.scrollHeight;
        await raf2();
        const s1 = performance.now();
        wrap = document.querySelector('.sg-wrap.gr');
        const last = !!wrap.querySelector('tr[data-size="S80"]');
        const scrollable = wrap.scrollHeight > wrap.clientHeight;
        const m = await import('/src/panels/measure-table.ts');
        const f = E.P('FRONT'); const pts = f.sew.points; const id = n => pts.find(a => a.name === n).id;
        m.addPart({ ref: { pieceId: f.id, contourId: f.sew.id, from: id('CF_HEM'), to: id('SS_HEM') } }, -1);
        m.addPart({ ref: { pieceId: f.id, contourId: f.sew.id, from: id('SS_HEM'), to: id('UA') } }, 0);
        const m0 = performance.now(); m.renderMeasureWindow(app); const m1 = performance.now();
        const mw = document.querySelector('.fwin[data-win="mline"] .sg-wrap');
        return { rows: +wrap.dataset.rows, rendered, gradeMs: t1 - t0, scrollMs: s1 - s0, last, scrollable, h: wrap.clientHeight, sh: wrap.scrollHeight, st: wrap.scrollTop, measureMs: m1 - m0, mRows: mw ? +mw.dataset.rows : -1 };
      });
    },
    expect: h => { const p = h._perf; return [req(p.rows === 80, 'grading rows ' + p.rows), req(p.rendered > 0 && p.rendered < 80, `virtualised: ${p.rendered} rows in the DOM`), req(p.gradeMs < 1000, `grading table render ${p.gradeMs.toFixed(0)} ms`), req(p.last, `last size row not rendered after scrolling (${JSON.stringify(p)})`), req(p.mRows === 80, 'measure rows ' + p.mRows), req(p.measureMs < 1000, `measure window ${p.measureMs.toFixed(0)} ms`)]; },
    after: (h, c, r) => { const p = h._perf; r.notes.push(`grading table ${p.gradeMs.toFixed(0)} ms (${p.rendered}/80 rows in DOM), scroll ${p.scrollMs.toFixed(0)} ms, measure window ${p.measureMs.toFixed(0)} ms`); },
  }),

  // ── grading table rows = sizes: edit (step ripple vs total), Enter moves down ──
  C('table-edit', {
    title: 'Grading table (rows = sizes): step edit of L moves L + XL; Enter moves to the next size; total edit of L leaves XL',
    sel: A('FRONT', 'UA'),
    invoke: async h => { await h.key('Control+g'); await h.settle(100); },
    drive: async h => {
      const rows = await h.ev(() => [...document.querySelectorAll('.sg-wrap.gr tbody tr[data-r]')].map(tr => tr.dataset.size));
      h._rows = rows;
      await gcell(h, 'L', 'dx').click(); await h.settle(40);
      h._note = await h.page.locator('.gr-note').textContent();
      await typeInto(h, gcell(h, 'L', 'dx'), '12');
      h._st = await status(h); h._ae = await ae(h);
      h._g1 = abs(await h.state(), 'FRONT', 'UA');
      await h.page.locator('.gr-bar button[data-view="total"]').click(); await h.settle(80);
      await typeInto(h, gcell(h, 'L', 'dx'), '15');
    },
    expect: async (h, c) => {
      const g = abs(c.after, 'FRONT', 'UA');
      return [
        req(h._rows.join(',') === 'S,M,L,XL', 'rows should be the sizes: ' + h._rows),
        req(/moves L, XL/.test(h._note), 'affected-sizes note: ' + h._note),
        req(/moved sizes L, XL/.test(h._st), 'status: ' + h._st),
        req(h._ae?.size === 'XL' && h._ae?.axis === 'dx', 'Enter should move to XL dX: ' + JSON.stringify(h._ae)),
        req(near(h._g1.L.dx, 12, 1e-6) && near(h._g1.XL.dx, 22, 1e-6), 'step edit: ' + JSON.stringify(h._g1)),
        req(near(g.L.dx, 15, 1e-6) && near(g.XL.dx, 22, 1e-6) && near(g.S.dx, -10, 1e-6), 'total edit: ' + JSON.stringify(g)),
      ];
    },
  }),
  C('table-paste', {
    title: 'Grading table: paste an Excel block (dX, dY columns) into consecutive size rows (base skipped), one undo step',
    sel: A('FRONT', 'UA'),
    invoke: async h => { await h.key('Control+g'); await h.settle(100); await h.page.locator('.gr-bar button[data-view="total"]').click(); await h.settle(80); },
    drive: async h => { await pasteInto(h, '.sg-wrap.gr input[data-size="S"][data-axis="dx"]', '-8\t-1\n0\t0\n9\t2\n19\t3\n'); },
    expect: (h, c) => { const g = abs(c.after, 'FRONT', 'UA'); return req(near(g.S.dx, -8) && near(g.S.dy, -1) && near(g.L.dx, 9) && near(g.L.dy, 2) && near(g.XL.dx, 19) && near(g.XL.dy, 3) && near(g.M.dx, 0), 'pasted ' + JSON.stringify(g)); },
  }),
  C('table-fill', {
    title: 'Grading table: type one step (L = 7), Fill (Equal steps) → XL step 7; the side without typed rows keeps its values; arrows / Tab move cells',
    sel: A('FRONT', 'UA'),
    invoke: async h => { await h.key('Control+g'); await h.settle(100); },
    drive: async h => {
      await typeInto(h, gcell(h, 'L', 'dx'), '7');
      await h.page.locator('.gr-fill select').selectOption('linear');
      await h.page.locator('.gr-fill [data-act="fill"]').click(); await h.settle(80);
      // keyboard navigation
      await gcell(h, 'L', 'dx').click(); await h.page.keyboard.press('ArrowRight'); h._k1 = await ae(h);
      await h.page.keyboard.press('ArrowDown'); h._k2 = await ae(h);
      await h.page.keyboard.press('ArrowUp'); await h.page.keyboard.press('Tab'); h._k3 = await ae(h);
      await h.page.keyboard.press('Escape'); await h.settle(40);
    },
    expect: (h, c) => { const g = abs(c.after, 'FRONT', 'UA'); return [
      req(near(g.L.dx, 7) && near(g.XL.dx, 14) && near(g.S.dx, -10), 'fill ' + JSON.stringify(g)),
      req(h._k1?.size === 'L' && h._k1?.axis === 'dy', '→ ' + JSON.stringify(h._k1)),
      req(h._k2?.size === 'XL' && h._k2?.axis === 'dy', '↓ ' + JSON.stringify(h._k2)),
      req(h._k3?.size === 'XL' && h._k3?.axis === 'dx', 'Tab from L dY → XL dX: ' + JSON.stringify(h._k3)),
    ]; },
  }),
  C('table-columns', {
    title: 'Grading table: several selected points = one dX/dY column pair each; one point adds X / Y / other-view columns',
    change: false,
    sel: async h => { await h.selectA('FRONT', 'UA'); await h.selectA('FRONT', 'SH', true); },
    invoke: async h => { await h.key('Control+g'); await h.settle(100); },
    drive: async h => {
      h._two = await h.ev(() => [...document.querySelectorAll('.sg-wrap.gr thead tr:last-child th')].map(t => t.textContent));
      await h.selectA('FRONT', 'UA'); await h.settle(80);
      h._one = await h.ev(() => [...document.querySelectorAll('.sg-wrap.gr thead tr:last-child th')].map(t => t.textContent));
    },
    expect: h => [req(h._two.join(',') === 'dX,dY,dX,dY', 'two points: ' + h._two), req(h._one.join(',') === 'dX,dY,X,Y,dX,dY', 'one point: ' + h._one)],
  }),

  // ── C. grade by measurement: hem spec per size → SS_HEM + UA solved in X ──
  C('by-measurement', {
    title: 'Grade by measurement: FRONT hem measured, spec column pasted (S 245 / M 260 / L 276 / XL 291), SS_HEM + UA solved in X → hem = spec ±0.01',
    pre: resetMeasure,
    invoke: async h => { await h.key('m'); await h.clickSeg('FRONT', 'CF_HEM', 'SS_HEM'); await h.key('Enter'); await h.selectA('FRONT', 'SS_HEM'); await h.selectA('FRONT', 'UA', true); await h.cmd('grade.byMeasurement'); },
    drive: async h => {
      const w = h.page.locator('.fwin[data-win="gradefit"]');
      const opt = await w.locator('select.gf-meas option').nth(1).getAttribute('value');
      await w.locator('select.gf-meas').selectOption(opt); await h.settle(60);
      await w.locator('[data-act="usesel"]').click(); await h.settle(60);
      await pasteInto(h, '.fwin[data-win="gradefit"] input[data-size="S"][data-col="spec"]', '245\n260\n276\n291');
      await w.locator('[data-act="apply"]').click(); await h.settle(120);
      h._res = await h.ev(() => [...document.querySelectorAll('.fwin[data-win="gradefit"] td[data-col="res"]')].map(td => ({ size: td.dataset.size, t: td.textContent, cls: td.className })));
      h._sum = await h.page.locator('.fwin[data-win="gradefit"] [data-fit]').getAttribute('data-fit');
    },
    expect: async h => {
      const hc = await hand(h, [['FRONT', 'CF_HEM', 'SS_HEM']]);
      const want = { S: 245, M: 260, L: 276, XL: 291 };
      const errs = hc.map(r => req(near(r.parts[0], want[r.size], 0.01), `${r.size} hem ${r.parts[0].toFixed(4)} ≠ ${want[r.size]}`));
      errs.push(req(h._sum === 'ok', 'summary ' + h._sum));
      errs.push(req(h._res.filter(r => r.size !== 'M').every(r => /pass/.test(r.cls)), 'residual cells ' + JSON.stringify(h._res)));
      return errs;
    },
  }),

  // ── Grade Rules: chips, type a rule number on the canvas, badges, rule edit follows, edited badge ──
  C('rules', {
    title: 'Grade rules: select SS_HEM, type “1” Enter = apply rule #1; badge blue; editing the rule moves the linked point; a local edit turns the badge amber',
    pre: P((app, ops, doc) => { const lib = ops.createLibrary(doc, 'E2E'); ops.createRuleFromValues(doc, lib, { S: { dx: -5, dy: 0 }, L: { dx: 5, dy: 0 }, XL: { dx: 10, dy: 0 } }, { view: 'absolute', name: 'Side hem' }); }),
    sel: A('FRONT', 'SS_HEM'),
    invoke: async h => { await h.cmd('grade.rules'); },
    drive: async h => {
      await h.key('1'); await h.key('Enter');
      h._g1 = abs(await h.state(), 'FRONT', 'SS_HEM'); h._r1 = an(await h.state(), 'FRONT', 'SS_HEM').ruleId;
      await h.cmd('grade.badges'); await h.settle(60);
      h._b1 = await h.ev(() => { const id = window.__e2e.findA('FRONT', 'SS_HEM').a.id; return document.querySelector(`.rbadge[data-anchor="${id}"]`)?.dataset.status; });
      const w = h.page.locator('.fwin[data-win="rules"]');
      await w.locator('.r-chip[data-rule="1"]').click(); await h.settle(60);
      await w.locator('[data-view="total"]').click(); await h.settle(60);
      await typeInto(h, w.locator('input[data-size="L"][data-axis="dx"]'), '6');
      h._g2 = abs(await h.state(), 'FRONT', 'SS_HEM');
      await h.key('Control+g'); await h.settle(80);
      await h.page.locator('.gr-bar button[data-view="total"]').click(); await h.settle(60);
      await typeInto(h, gcell(h, 'XL', 'dx'), '13'); await h.blur(); await h.settle(80);
      h._b2 = await h.ev(() => { const id = window.__e2e.findA('FRONT', 'SS_HEM').a.id; return document.querySelector(`.rbadge[data-anchor="${id}"]`)?.dataset.status; });
    },
    expect: h => [
      req(!!h._r1 && near(h._g1.L.dx, 5) && near(h._g1.S.dx, -5), 'rule not applied by typing 1: ' + JSON.stringify(h._g1)),
      req(h._b1 === 'rule', 'badge after apply: ' + h._b1),
      req(near(h._g2.L.dx, 6) && near(h._g2.XL.dx, 10), 'linked point did not follow the rule edit: ' + JSON.stringify(h._g2)),
      req(h._b2 === 'edited', 'badge after a local edit: ' + h._b2),
    ],
  }),

  // ── Measure Spec: points of measure with targets and movement rules ──
  C('spec-line', {
    title: 'Measure spec: FRONT hem from the selection; base target +15 shifts every size; Apply moves the line end → hem = old + 15 in every size',
    pre: async h => { await resetMeasure(h); h._hem0 = await hand(h, [['FRONT', 'CF_HEM', 'SS_HEM']]); },
    invoke: async h => {
      await h.ev(() => { const E = window.__e2e; const a = E.findA('FRONT', 'CF_HEM'), b = E.findA('FRONT', 'SS_HEM'); E.app.sel = { pieces: [a.p.id], anchors: [], segments: [{ pieceId: a.p.id, contourId: a.c.id, from: a.a.id, to: b.a.id }] }; E.app.invalidate(); });
      await h.cmd('measure.spec');
    },
    drive: async h => {
      const w = h.page.locator('.fwin[data-win="mspec"]');
      await w.locator('[data-act="from-sel"]').click(); await h.settle(80);
      h._item = await h.ev(() => { const it = window.__e2e.app.style.measureSpec[0]; return { n: window.__e2e.app.style.measureSpec.length, kind: it.kind, movers: it.movers.map(m => m.dir + ':' + m.share), targets: Object.keys(it.targets).length }; });
      const base = h._hem0.find(r => r.size === 'M').parts[0];
      await typeInto(h, w.locator('table.sp-list input.sp-target').first(), String(Math.round((base + 15) * 1000) / 1000));
      await w.locator('.fw-foot [data-act="apply"]').click(); await h.settle(150);
      h._sum = await w.locator('[data-spec]').getAttribute('data-spec');
      h._diff = await h.ev(() => [...document.querySelectorAll('.fwin[data-win="mspec"] td[data-col="diff"]')].map(td => td.className));
    },
    expect: async h => {
      const now = await hand(h, [['FRONT', 'CF_HEM', 'SS_HEM']]);
      const errs = [req(h._item.n === 1 && h._item.kind === 'line' && h._item.movers.join() === 'along:1' && h._item.targets === 4, 'new item ' + JSON.stringify(h._item))];
      for (const r of now) { const o = h._hem0.find(x => x.size === r.size).parts[0]; errs.push(req(near(r.parts[0], o + 15, 0.01), `${r.size} hem ${r.parts[0].toFixed(4)} ≠ ${(o + 15).toFixed(4)}`)); }
      errs.push(req(h._sum === 'ok', 'summary ' + h._sum));
      errs.push(req(h._diff.length === 4 && h._diff.every(c => /pass/.test(c)), 'diff cells ' + JSON.stringify(h._diff)));
      return errs;
    },
  }),
  C('spec-distance-rules', {
    title: 'Measure spec: straight distance SS_HEM → UA, per-size targets pasted, rule = Y only; Apply → every size on target, SS_HEM never moves, UA keeps its X',
    pre: async h => { await resetMeasure(h); h._p0 = await h.ev(() => { const E = window.__e2e; const f = n => { const a = E.findA('FRONT', n); return { x: a.a.x, y: a.a.y }; }; return { hem: f('SS_HEM'), ua: f('UA') }; }); },
    invoke: async h => { await h.selectA('FRONT', 'SS_HEM'); await h.selectA('FRONT', 'UA', true); await h.cmd('measure.spec'); },
    drive: async h => {
      const w = h.page.locator('.fwin[data-win="mspec"]');
      await w.locator('[data-act="from-sel"]').click(); await h.settle(80);
      await w.locator('table.sp-rules select[data-rule="dir"]').selectOption('y'); await h.settle(80);
      h._now = await h.ev(() => { const E = window.__e2e; const it = E.app.style.measureSpec[0]; return Object.fromEntries(E.app.sizeLine().sizes.map(s => [s.name, window.prowdcad.ops.specValue(E.app.doc, it.id, s.id)])); });
      h._want = { S: h._now.S + 4, M: h._now.M + 10, L: h._now.L + 17, XL: h._now.XL + 25 };
      await pasteInto(h, '.fwin[data-win="mspec"] input[data-size="S"][data-col="target"]', ['S', 'M', 'L', 'XL'].map(k => h._want[k].toFixed(4)).join('\n'));
      await w.locator('.fw-foot [data-act="apply"]').click(); await h.settle(150);
    },
    expect: async h => {
      const got = await h.ev(() => { const E = window.__e2e; const it = E.app.style.measureSpec[0]; const f = n => { const a = E.findA('FRONT', n); return { x: a.a.x, y: a.a.y }; }; return { v: Object.fromEntries(E.app.sizeLine().sizes.map(s => [s.name, window.prowdcad.ops.specValue(E.app.doc, it.id, s.id)])), kind: it.kind, rule: it.movers.map(m => m.dir).join(), hem: f('SS_HEM'), ua: f('UA') }; });
      const errs = [req(got.kind === 'distance' && got.rule === 'y', 'item ' + got.kind + ' / ' + got.rule)];
      for (const k of ['S', 'M', 'L', 'XL']) errs.push(req(near(got.v[k], h._want[k], 0.01), `${k} distance ${got.v[k].toFixed(4)} ≠ ${h._want[k].toFixed(4)}`));
      errs.push(req(near(got.hem.x, h._p0.hem.x, 1e-6) && near(got.hem.y, h._p0.hem.y, 1e-6), 'the fixed point SS_HEM moved'));
      errs.push(req(near(got.ua.x, h._p0.ua.x, 1e-6) && !near(got.ua.y, h._p0.ua.y, 1), `UA should move in Y only: ${JSON.stringify(got.ua)} from ${JSON.stringify(h._p0.ua)}`));
      return errs;
    },
  }),
  C('adjust-segment', {
    title: 'Measure window ▸ Adjust segment…: FRONT hem made exactly 300 (all sizes follow the base)',
    pre: resetMeasure,
    invoke: async h => { await h.key('m'); await h.clickSeg('FRONT', 'CF_HEM', 'SS_HEM'); await h.page.locator('.fwin[data-win="mline"] [data-act="adjust"]').click(); },
    drive: async h => { await h.waitDialog(); h._t = await h.dlgTitle(); await h.dlg().locator('input[data-key="v"]').fill('300'); await h.ok(); },
    expect: async h => { const L = await h.ev(() => window.__e2e.segLen('FRONT', 'CF_HEM', 'SS_HEM')); return [req(h._t === 'Adjust segment', 'dialog ' + h._t), req(near(L, 300, 0.05), 'hem ' + L)]; },
  }),
  C('measure-window-follows-tool', {
    title: 'The Measure window closes when another tool is chosen and reopens with the Measure tool; the open measurement is kept',
    change: false,
    pre: resetMeasure,
    invoke: async h => { await h.key('m'); await h.clickSeg('FRONT', 'CF_HEM', 'SS_HEM'); },
    drive: async h => {
      const open = () => h.ev(() => !!document.querySelector('.fwin[data-win="mline"]'));
      h._a = await open(); await h.key('g'); h._b = await open(); await h.key('m'); h._c = await open();
      h._ms = await MSmod(h);
    },
    expect: async h => [req(h._a === true, 'not open with the Measure tool'), req(h._b === false, 'still open after choosing Move Point'), req(h._c === true, 'did not reopen with the Measure tool'), req(h._ms.groups.length === 1 && h._ms.groups[0].parts.length === 1, 'open measurement lost: ' + JSON.stringify(h._ms))],
  }),
];

module.exports = { cases };
