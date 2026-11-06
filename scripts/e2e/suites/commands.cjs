// One case per command id. Every case: reset fixture → (pre: programmatic precondition) →
// (sel: UI selection by clicks) → menu click (or hotkey for menu-less commands) → (drive: canvas
// picks / dialog values a pattern maker would type) → expect.
const path = require('path');
const Q = require('../lib/q.cjs');
const { pc, an, abs, near, nearV, count, npts, req, otherChanged } = Q;

const FIX = path.join(__dirname, '..', 'out', 'fixtures');
const f = n => path.join(FIX, n);

// ───── small DSL ─────
const A = (p, n, add) => h => h.selectA(p, n, add);
const AA = (...list) => async h => { for (let i = 0; i < list.length; i++) await h.selectA(list[i][0], list[i][1], i > 0); };
const PC = (p, add) => h => h.selectPiece(p, add);
const PP = (...names) => async h => { for (let i = 0; i < names.length; i++) await h.selectPiece(names[i], i > 0); };
const DLG = (fields = {}, more) => async h => { await h.waitDialog(); await h.fields(fields); await h.ok(); if (more) await more(h); };
const OK = () => async h => { await h.waitDialog(); await h.ok(); };
const seg = (p, a, b, t = 0.5) => h => h.clickSeg(p, a, b, t);
const at = (p, n, mods) => h => h.clickA(p, n, { mods });
const W = (x, y, mods) => h => h.clickW({ x, y }, { mods });
const seq = (...fns) => async h => { for (const fn of fns) await fn(h); };
const setting = k => h => h.ev(k => window.__e2e.settings[k], k);
const appv = expr => h => h.ev(e => { const { app, settings } = window.__e2e; return (new Function('app', 'settings', 'return (' + e + ')'))(app, settings); }, expr);
const win = id => h => h.ev(id => !!document.querySelector(`.fwin[data-win="${id}"]`), id);
/** toggle command that flips a UI setting (no document change) */
const toggleS = (id, key, extra = {}) => ({ id, change: false, sel: async h => { h._v0 = await setting(key)(h); }, expect: async h => req((await setting(key)(h)) === !h._v0, `settings.${key} did not toggle`), ...extra });
const toggleApp = (id, expr) => ({ id, change: false, sel: async h => { h._v0 = await appv(expr)(h); }, expect: async h => req((await appv(expr)(h)) === !h._v0, `${expr} did not toggle`) });
const tool = (id, t) => ({ id, change: false, expect: async h => req((await appv('app.tool.id')(h)) === t, `active tool is not ${t}`) });
const chooser = (files, cmdId) => async h => {
  const p = h.page.waitForEvent('filechooser', { timeout: 4000 });
  await h.cmd(cmdId);
  const fc = await p; await fc.setFiles(files); await h.settle(150);
};
const pieces = st => st.pieces.map(p => p.name);
// Headless Chromium exposes the File System Access API but cannot show its native picker, so the
// open/save cases exercise the documented fallback (<input type=file> / download), as on Firefox/Safari.
const noFSA = h => h.ev(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; window.showOpenFilePicker = undefined; window.showSaveFilePicker = undefined; });
const FSA_NOTE = 'tested through the no-File-System-Access fallback (input[type=file] / download)';
const dl = (ctx, ext) => ctx.downloads.find(d => d.name.endsWith(ext));
const txt = d => Buffer.from(d.b64, 'base64').toString('latin1');

const pre = {
  /** programmatic: run fn(app, ops, doc, E) in page */
  js: (fn, arg) => h => h.ev(([src, arg]) => { const E = window.__e2e; return (new Function('app', 'ops', 'doc', 'E', 'arg', src))(E.app, E.ops, E.app.doc, E, arg); }, [`(${fn})(app, ops, doc, E, arg)`, arg]),
};
const P = pre.js;
// recurring preconditions
const addInternal = (pts, name) => P((app, ops, doc, E, a) => doc.transact('pre', () => {
  const f = E.P('FRONT'); const mk = (x, y, n) => ({ id: 'p' + Math.random().toString(36).slice(2, 9), x, y, kind: 'grade', smooth: false, grade: {}, flags: {}, name: n });
  f.internals.push({ id: 'c' + Math.random().toString(36).slice(2, 9), type: 'internal', closed: false, style: 'solid', points: a.pts.map(([x, y, n]) => mk(x, y, n)) });
}), { pts, name });
const YOKE = addInternal([[260, 400, 'YK_A'], [0, 400, 'YK_B']]);
const dartFixture = { fixture: 'live' };
const clickDart = h => h.ev(() => window.__e2e.livePt('FRONT', 'dart', 0.5)).then(w => h.clickW(w));
const clickPleat = h => h.ev(() => window.__e2e.livePt('BACK', 'pleat', 0.5)).then(w => h.clickW(w));
const clickFull = h => h.ev(() => window.__e2e.livePt('BACK', 'fullness', 0.6)).then(w => h.clickW(w));
const selDart = async h => { await h.ensureSelect(); await clickDart(h); };
const selPleat = async h => { await h.ensureSelect(); await clickPleat(h); };
const selFull = async h => { await h.ensureSelect(); await clickFull(h); };
const copyGradeOf = (p, n) => async h => { await h.selectA(p, n); await h.key('Control+Alt+c'); };

const cases = [
  // ═════════ File ═════════
  { id: 'file.new', drive: DLG({ name: 'NEW STYLE', sizes: 'XS, S, M', base: 'S', block: true, w: '300', h: '400', seam: '12' }), undo: false,
    notes: ['File ▸ New replaces the document (history cleared) — not undoable by design'],
    expect: (h, c) => [req(c.after.name === 'NEW STYLE', 'style name not set'), req(c.after.pieces.length === 1 && c.after.pieces[0].seamDefault === 12, 'block piece / seam not created'), req(Q.line(c.after).sizes.map(s => s.name).join() === 'XS,S,M', 'sizes not set'), req(Q.line(c.after).baseSizeId === Q.sizeId(c.after, 'S'), 'base not S')] },
  { id: 'file.new#dirty', title: 'New… (with unsaved changes → discard confirm)', invoke: async h => { await h.selectPiece('FRONT'); await h.key('Alt+r'); await h.cmd('file.new'); },
    drive: async h => { await h.waitDialog(); h._t1 = await h.dlgTitle(); h._m1 = await h.dlg().locator('.dlg-msg').textContent().catch(() => ''); await h.ok(); await h.waitDialog(); await h.ok(); }, undo: false,
    expect: (h, c) => req(/Discard/i.test(h._m1 || ''), 'no discard-changes confirmation'), after: async (h, c, r) => { r.notes.push(`confirm dialog title: "${h._t1}" (same title as the form that follows)`); } },
  { id: 'file.open', sel: noFSA, notes: [FSA_NOTE], invoke: chooser([f('e2e-open.prowd.json')], 'file.open'), undo: false,
    expect: (h, c) => [req(c.after.name === 'OPENED STYLE', 'opened style not loaded'), req(c.after.pieces.length === 2, 'piece count')] },
  { id: 'file.save', sel: noFSA, notes: [FSA_NOTE], change: 'maybe', undo: false, drive: async h => { await h.waitDialog(3000).catch(() => {}); if (await h.hasDialog()) { h._askedName = await h.dlgTitle(); await h.ok(); } },
    after: async (h, c, r) => { if (h._askedName) r.notes.push(`plain Save (Ctrl+S) asks for a file name ("${h._askedName}" dialog) every time when the File System Access API is missing`); },
    expect: async (h, c) => { const d = dl(c, '.json'); if (!d) return 'no .prowd.json download'; const j = JSON.parse(txt(d)); return [req(j.schema === 'prowdcad/2', 'schema'), req(j.pieces.length === 2, 'pieces in saved file'), req(!!j.meta.previewPng, 'preview PNG not attached on save')]; } },
  { id: 'file.saveAs', sel: noFSA, notes: [FSA_NOTE], change: 'maybe', undo: false, drive: async h => { await h.waitDialog(3000).catch(() => {}); if (await h.hasDialog()) { await h.fill('n', 'my-tee'); await h.ok(); } },
    expect: (h, c) => req(c.downloads.some(d => d.name === 'my-tee.prowd.json'), 'expected download my-tee.prowd.json, got ' + c.downloads.map(d => d.name)) },
  { id: 'file.import', title: 'Import DXF + RUL', invoke: chooser([f('e2e-src.dxf'), f('e2e-src.rul')], 'file.import'),
    drive: async h => { await h.waitDialog(); await h.ok(); await h.waitDialog(); h._rep = await h.dlg().locator('.dlg-msg').textContent(); await h.ok(); },
    expect: (h, c) => [req(c.after.pieces.length === 4, `expected 4 pieces after import, got ${pieces(c.after)}`), req(/Rule library/i.test(h._rep || ''), 'import report shows no rule library')],
    after: async (h, c, r) => { r.notes.push('import report: ' + (h._rep || '').replace(/\s+/g, ' ').slice(0, 300)); const imp = c.after.pieces.slice(2); if (imp[0]) { const g = imp[0].sew.points.filter(a => Object.values(a.grade || {}).some(v => v.dx || v.dy)).length; r.notes.push(`imported ${imp.map(p => p.name)}; graded points on first: ${g}`); if (!g) r.status = 'fail', r.msgs.push('imported DXF+RUL pieces carry no grading'); } } },
  { id: 'file.import#svg', title: 'Import SVG', invoke: chooser([f('e2e-src.svg')], 'file.import'), drive: async h => { await h.waitDialog(); await h.fill('mm', true); await h.ok(); await h.waitDialog(); await h.ok(); },
    expect: (h, c) => req(c.after.pieces.length > 2, 'no pieces imported from SVG') },
  { id: 'file.import#plt', title: 'Import PLT', invoke: chooser([f('e2e-src.plt')], 'file.import'), drive: async h => { await h.waitDialog(); await h.ok(); await h.waitDialog(); await h.ok(); },
    expect: (h, c) => req(c.after.pieces.length > 2, 'no pieces imported from PLT') },
  { id: 'file.merge', invoke: chooser([f('e2e-open.prowd.json')], 'file.merge'), drive: OK(),
    expect: (h, c) => req(c.after.pieces.length === 4, `merge: expected 4 pieces, got ${pieces(c.after)}`) },
  { id: 'file.export.dxf', change: false, drive: OK(),
    expect: (h, c) => { const d = dl(c, '.dxf'), r = dl(c, '.rul'); if (!d) return 'no .dxf download'; const t = txt(d); return [req(/SECTION/.test(t) && /EOF\s*$/.test(t.trim()), 'DXF not well-formed (SECTION/EOF)'), req(/Piece Name: FRONT/.test(t) && /Piece Name: BACK/.test(t), 'piece name attributes missing'), req(!!r && /RULE: DELTA/i.test(txt(r)), 'no .rul with rules')]; } },
  { id: 'file.export.dxf#astm', title: 'DXF export, ASTM flavor (BLOCK per piece)', change: false, invoke: h => h.cmd('file.export.dxf'), drive: DLG({ flavor: 'astm' }),
    expect: (h, c) => { const d = dl(c, '.dxf'); if (!d) return 'no .dxf'; const t = txt(d); return req((t.match(/\n\s*BLOCK\s*\n/g) || []).length >= 2 && /INSERT/.test(t), 'ASTM DXF lacks BLOCK/INSERT per piece'); } },
  { id: 'file.export.svg', change: false, drive: OK(), expect: (h, c) => { const d = dl(c, '.svg'); if (!d) return 'no .svg download'; const t = txt(d); return req(/^<\?xml|<svg/.test(t.trim()) && (t.match(/<path/g) || []).length >= 2, 'SVG has no paths'); } },
  { id: 'file.export.pdf', change: false, drive: OK(), expect: (h, c) => { const d = dl(c, '.pdf'); if (!d) return 'no .pdf download'; const t = txt(d); return [req(t.startsWith('%PDF-'), 'not a PDF'), req((t.match(/\/Type\s*\/Page[^s]/g) || []).length >= 1, 'PDF has no pages'), req(/%%EOF\s*$/.test(t), 'PDF not terminated')]; } },
  { id: 'file.export.plt', change: false, drive: async h => { await OK()(h); await OK()(h); }, expect: (h, c) => { const d = dl(c, '.plt'); if (!d) return 'no .plt download'; const t = txt(d); return req(/IN;/.test(t) && /PD/.test(t), 'PLT lacks IN;/PD'); } },
  { id: 'file.export.standalone', sel: PC('FRONT'), change: false, drive: async h => { await h.waitDialog(); await h.dlg().locator('[data-key="s"]').selectOption({ label: 'L' }); await h.ok(); },
    expect: (h, c) => { const d = dl(c, '.prowd.json'); if (!d) return 'no standalone download'; const j = JSON.parse(txt(d)); return [req(d.name === 'FRONT_L.prowd.json', 'name ' + d.name), req(j.pieces.length === 1 && Q.line(j).sizes.length === 1, 'standalone should hold 1 piece × 1 size')]; } },
  { id: 'file.preview', expect: (h, c) => req(!!c.after.meta.previewPng && c.after.meta.previewPng.startsWith('data:image/png'), 'no preview PNG') },
  { id: 'file.styleInfo', drive: DLG({ customer: 'ACME', season: 'SS27' }), expect: (h, c) => req(c.after.meta.customer === 'ACME' && c.after.meta.season === 'SS27', 'meta not stored') },

  // ═════════ Edit ═════════
  { id: 'edit.undo', sel: async h => { await h.selectPiece('FRONT'); await h.key('Alt+r'); }, undo: false,
    expect: async (h, c) => req(!pc(c.after, 'FRONT').layout?.angleDeg, 'Undo did not revert Rotate 90°') },
  { id: 'edit.redo', sel: async h => { await h.selectPiece('FRONT'); await h.key('Alt+r'); await h.key('Control+z'); }, undo: false,
    expect: (h, c) => req(pc(c.after, 'FRONT').layout?.angleDeg === 90, 'Redo did not re-apply Rotate 90°') },
  { id: 'edit.delete', sel: A('FRONT', 'AH1'), expect: (h, c) => req(npts(c.after, 'FRONT') === 9, 'point not deleted') },
  { id: 'edit.delete#piece', title: 'Delete (piece selected → confirm)', sel: PC('BACK'), invoke: h => h.cmd('edit.delete'), drive: OK(), expect: (h, c) => req(c.after.pieces.length === 1, 'piece not deleted') },
  { id: 'edit.duplicate', sel: PC('FRONT'), expect: (h, c) => [req(c.after.pieces.length === 3 && Q.has(c.after, 'FRONT COPY'), 'no FRONT COPY'), req(c.afterSel.pieces[0] === 'FRONT COPY', 'copy not selected')] },
  { id: 'edit.selectAll', change: false, expect: (h, c) => req(c.afterSel.pieces.length === 2, 'not all pieces selected') },
  { id: 'edit.selectAllPoints', sel: PC('FRONT'), change: false, expect: (h, c) => req(c.afterSel.anchors.length === 12, `expected 12 points, got ${c.afterSel.anchors.length}`) },
  { id: 'edit.deselect', sel: PC('FRONT'), change: false, expect: (h, c) => req(!c.afterSel.pieces.length, 'still selected') },
  ...[['edit.nudgeL', -1, 0], ['edit.nudgeR', 1, 0], ['edit.nudgeU', 0, 1], ['edit.nudgeD', 0, -1], ['edit.nudgeL10', -10, 0], ['edit.nudgeR10', 10, 0], ['edit.nudgeU10', 0, 10], ['edit.nudgeD10', 0, -10]].map(([id, dx, dy]) => ({
    id, sel: async h => { await h.selectA('FRONT', 'SS_HEM'); if (await h.ev(() => window.__e2e.app.tools.some(t => t.id === 'movePoint'))) await h.key('g'); },
    notes: ['at HEAD the arrows nudge only while a Move tool is active: the case selects SS_HEM, presses G (Move Point adopts the selection), then the arrow'],
    expect: (h, c) => { const a0 = an(c.before, 'FRONT', 'SS_HEM'), a1 = an(c.after, 'FRONT', 'SS_HEM'); return [req(near(a1.x - a0.x, dx) && near(a1.y - a0.y, dy), `SS_HEM moved (${a1.x - a0.x},${a1.y - a0.y}) expected (${dx},${dy})`), req(!otherChanged(c.before, c.after, 'FRONT', ['SS_HEM']).length, 'other anchors changed: ' + JSON.stringify(otherChanged(c.before, c.after, 'FRONT', ['SS_HEM'])))]; } })),
  { id: 'edit.nudgeStep', change: false, drive: DLG({ v: '2.5' }), expect: async h => req((await setting('nudgeMm')(h)) === 2.5, 'nudge step not stored') },
  { id: 'edit.hotkeys', change: false, drive: async h => { await h.waitDialog(); const ta = h.dlg().locator('textarea'); const j = JSON.parse(await ta.inputValue()); h._n = Object.keys(j).length; j['view.grid'] = 'Ctrl+Alt+G'; await ta.fill(JSON.stringify(j)); await h.ok(); h._g0 = await setting('showGrid')(h); await h.key('Control+Alt+g'); },
    expect: async h => [req(h._n >= 240, `JSON map lists only ${h._n} commands`), req((await setting('hotkeys')(h))['view.grid'] === 'Ctrl+Alt+G', 'override not stored'), req((await setting('showGrid')(h)) === !h._g0, 'new chord Ctrl+Alt+G did not toggle the grid')] },
  { id: 'edit.toolbar', change: false, drive: async h => { await h.waitDialog(); h._b0 = await h.page.locator('#palette .tool-btn').count(); await h.fill('measure', false); await h.fill('walk', false); await h.ok(); },
    expect: async h => { const hid = await setting('hiddenTools')(h); const b1 = await h.page.locator('#palette .tool-btn').count(); return [req(hid.includes('measure') && hid.includes('walk'), 'hiddenTools not stored'), req(b1 === h._b0 - 1, `palette buttons ${h._b0}→${b1} (measure group should vanish)`)]; } },

  { id: 'edit.nudge#select', title: 'Arrow key with the Select tool active (point selected)', invoke: async h => { await h.selectA('FRONT', 'SS_HEM'); await h.key('ArrowRight'); }, change: 'maybe',
    after: async (h, c, r) => { r.notes.push(c.changed ? 'arrow in Select moved the point' : 'arrow in Select did nothing (no status message: ' + JSON.stringify(c.rec.statuses.slice(-1)) + ')'); } },
  { id: 'edit.selectDragMove', change: false, expect: async h => req((await setting('selectDragMove')(h)) === true, 'opt-in not toggled') },
  { id: 'edit.selectDragMove#drag', title: 'Select drag-move opt-in: drag a point moves only it', invoke: async h => { await h.cmd('edit.selectDragMove'); await h.selectA('FRONT', 'UA'); await h.page.waitForTimeout(600); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 15, y: w.y }); },
    expect: (h, c) => [req(near(an(c.after, 'FRONT', 'UA').x, 275, 1), 'UA.x ' + an(c.after, 'FRONT', 'UA').x), req(!otherChanged(c.before, c.after, 'FRONT', ['UA']).length, 'other anchors changed')] },
  { id: 'edit.prefs', change: false, drive: DLG({ dm: true, pr: '12', nu: '0.5' }), expect: async h => [req((await setting('pickRadiusPx')(h)) === 12, 'pick radius'), req((await setting('nudgeMm')(h)) === 0.5, 'nudge')] },
  ...['all', 'pieces', 'points', 'lines', 'internals', 'marks'].map(f => ({ id: 'sel.filter.' + f, change: false, sel: h => h.ev(() => { window.__e2e.settings.selFilter = 'internals'; }), expect: async h => req((await setting('selFilter')(h)) === f, 'filter ' + f) })),
  { id: 'sel.filter#ctrlA', title: 'Selection filter Points + Ctrl+A selects every point', invoke: async h => { await h.cmd('sel.filter.points'); await h.key('Control+a'); }, change: false, expect: (h, c) => req(c.afterSel.anchors.length === 16, 'points selected: ' + c.afterSel.anchors.length) },
  // Move tools via their menu entries (Point ▸ Modify Points, Segment ▸ Modify Line, Piece ▸ Modify Piece)
  ...[['move.single', 'single', 'UA', ['UA']], ['move.h', 'h', 'UA', ['UA']], ['move.v', 'v', 'UA', ['UA']]].map(([id, mode, pt, moved]) => ({
    id, sel: A('FRONT', pt), drive: async h => { await h.page.waitForTimeout(500); const w = await h.W('FRONT', pt); await h.dragW(w, { x: w.x + 15, y: w.y - 12 }, { steps: 10 }); },
    expect: (h, c) => { const a0 = an(c.before, 'FRONT', pt), a1 = an(c.after, 'FRONT', pt); const dx = a1.x - a0.x, dy = a1.y - a0.y; const others = otherChanged(c.before, c.after, 'FRONT', moved);
      return [req(mode === 'h' ? (Math.abs(dy) < 1e-6 && dx > 5) : mode === 'v' ? (Math.abs(dx) < 1e-6 && dy < -5) : (dx > 5 && dy < -5), `${mode}: moved (${Q.r4(dx)},${Q.r4(dy)})`), req(!others.length, 'other anchors changed: ' + JSON.stringify(others))]; } })),
  { id: 'move.smooth', sel: A('FRONT', 'SH'), drive: async h => { await h.page.waitForTimeout(500); const w = await h.W('FRONT', 'SH'); await h.dragW(w, { x: w.x + 12, y: w.y }, { steps: 10 }); },
    expect: (h, c) => { const ch = Q.anchorDiff(c.before, c.after, 'FRONT').map(d => d.name); return [req(ch.includes('SH'), 'SH not moved'), req(ch.every(n => ['SH', 'AH1', 'AH2', 'N1', 'N2'].includes(n)), 'changed outside the tacks: ' + ch)]; } },
  { id: 'move.along', sel: A('FRONT', 'UA'), drive: async h => { await h.page.waitForTimeout(500); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x, y: w.y - 30 }, { steps: 10 }); },
    expect: (h, c) => { const a = an(c.after, 'FRONT', 'UA'); return req(near(a.x, 260, 0.01) && a.y < 455, `UA (${a.x},${a.y}) should slide down the side seam`); } },
  { id: 'move.group', sel: AA(['FRONT', 'SS_HEM'], ['FRONT', 'UA']), drive: async h => { await h.page.waitForTimeout(500); const w = await h.W('FRONT', 'UA'); await h.dragW(w, { x: w.x + 15, y: w.y }, { steps: 10 }); },
    expect: (h, c) => { const d1 = an(c.after, 'FRONT', 'UA').x - 260, d2 = an(c.after, 'FRONT', 'SS_HEM').x - 260; return [req(d1 > 5 && near(d1, d2, 1e-6), `group moved UA ${d1} SS_HEM ${d2}`), req(!otherChanged(c.before, c.after, 'FRONT', ['UA', 'SS_HEM']).length, 'others changed')]; } },
  { id: 'move.line', drive: async h => { const w = await h.along('FRONT', 'SS_HEM', 'UA', 0.5); await h.dragW(w, { x: w.x + 15, y: w.y }, { steps: 10 }); },
    expect: (h, c) => { const ch = Q.anchorDiff(c.before, c.after, 'FRONT').map(d => d.name); return [req(ch.includes('SS_HEM') && ch.includes('UA'), 'segment ends not moved: ' + ch), req(ch.every(n => ['SS_HEM', 'UA'].includes(n)), 'other points changed: ' + ch)]; } },
  { id: 'move.lineParallel', drive: async h => { const w = await h.along('FRONT', 'SS_HEM', 'UA', 0.5); await h.dragW(w, { x: w.x + 15, y: w.y + 40 }, { steps: 10 }); },
    expect: (h, c) => { const a = an(c.after, 'FRONT', 'UA'), b = an(c.after, 'FRONT', 'SS_HEM'); return req(near(a.y, 465, 0.01) && near(b.y, 0, 0.01) && a.x > 265, `parallel move should keep Y: UA (${a.x},${a.y}) SS_HEM (${b.x},${b.y})`); } },
  { id: 'move.curve', sel: A('FRONT', 'AH1'), drive: async h => { await h.clickA('FRONT', 'AH1'); const w = await h.ev(() => window.__e2e.handleW('FRONT', 'AH1', 'out')); await h.dragW(w, { x: w.x + 10, y: w.y + 10 }, { steps: 8 }); },
    expect: (h, c) => [req(!!an(c.after, 'FRONT', 'AH1').hOut, 'no explicit handle after drag'), req(!otherChanged(c.before, c.after, 'FRONT', ['AH1']).length, 'other anchors changed')] },
  { id: 'move.piece', drive: async h => { const w = await h.local2world('BACK', { x: 520, y: 300 }); await h.dragW(w, { x: w.x + 40, y: w.y + 10 }, { steps: 10 }); }, expect: (h, c) => req(near(pc(c.after, 'BACK').layout?.x ?? 0, 40, 2), 'layout ' + JSON.stringify(pc(c.after, 'BACK').layout)) },
  { id: 'move.pieceRotate', title: 'Rotate Piece with BACK already selected: type 90 (noun → verb)', sel: PC('BACK'), drive: async h => { await h.key('9'); if (!(await h.page.locator('.ibox').count())) throw new Error('typing a digit with the piece selected opens no input box (hint still says "Select piece to rotate")'); await h.page.waitForTimeout(100); const ib = h.page.locator('.ibox input').first(); await ib.fill('90'); await ib.press('Enter'); await h.settle(); },
    expect: (h, c) => req(near(Math.abs(pc(c.after, 'BACK').layout?.angleDeg ?? 0), 90, 0.01) || near(pc(c.after, 'BACK').layout?.angleDeg ?? 0, 270, 0.01), 'angle ' + JSON.stringify(pc(c.after, 'BACK').layout)) },
  { id: 'move.pieceFlip', drive: h => h.clickLocal('BACK', { x: 520, y: 300 }), expect: (h, c) => req(!!pc(c.after, 'BACK').layout?.flipX, 'not flipped: ' + JSON.stringify(pc(c.after, 'BACK').layout)) },
  { id: 'piece.flipH', sel: PC('BACK'), expect: (h, c) => req(!!pc(c.after, 'BACK').layout?.flipX, 'no flipX') },
  { id: 'piece.flipV', sel: PC('BACK'), expect: (h, c) => req(!!pc(c.after, 'BACK').layout?.flipY, 'no flipY') },

  // ═════════ Seam ═════════
  tool('seam.tool', 'seam'),
  { id: 'seam.segment', sel: A('FRONT', 'SS_HEM'), drive: DLG({ v: '15' }), expect: (h, c) => req(an(c.after, 'FRONT', 'SS_HEM').seamAfter === 15, 'seamAfter ≠ 15') },
  { id: 'seam.segment#pick', title: 'Seam of segment (nothing selected → canvas pick)', invoke: h => h.cmd('seam.segment'), drive: seq(seg('FRONT', 'SS_HEM', 'UA'), DLG({ v: '1 1/2' })), expect: (h, c) => req(an(c.after, 'FRONT', 'SS_HEM').seamAfter === 1.5, `fraction "1 1/2" mm → ${an(c.after, 'FRONT', 'SS_HEM').seamAfter}`) },
  { id: 'seam.piece', sel: PC('FRONT'), drive: DLG({ v: '12' }), expect: (h, c) => { const p = pc(c.after, 'FRONT'); return req(p.seamDefault === 12 || p.sew.points.filter(a => a.kind === 'grade').every(a => a.seamAfter === 12), 'whole-piece seam not 12'); } },
  { id: 'seam.global', drive: DLG({ v: '8' }), expect: (h, c) => req(c.after.pieces.every(p => p.seamDefault === 8 || p.sew.points.filter(a => a.kind === 'grade').every(a => a.seamAfter === 8)), 'global seam not applied to every piece') },
  { id: 'seam.corner', sel: A('FRONT', 'UA'), drive: async h => { await h.page.waitForSelector('.popover .cg-item'); await h.page.locator('.popover .cg-item', { hasText: 'Boxed (both)' }).click(); await h.settle(); }, expect: (h, c) => req(an(c.after, 'FRONT', 'UA').corner?.type === 'boxed', 'corner not boxed') },
  { id: 'seam.trimCorner', sel: A('FRONT', 'UA'), drive: seq(W(271, 445), W(250, 482)), expect: (h, c) => req(an(c.after, 'FRONT', 'UA').corner?.type === 'manual', 'corner not manual: ' + JSON.stringify(an(c.after, 'FRONT', 'UA').corner)) },
  { id: 'seam.revertCorner', pre: P((app, ops, doc, E) => ops.setCorner(doc, E.P('FRONT').id, E.findA('FRONT', 'UA').a.id, { type: 'boxed', extend: 'both' })), sel: A('FRONT', 'UA'), expect: (h, c) => req(!an(c.after, 'FRONT', 'UA').corner, 'corner not reverted') },
  { id: 'seam.lockGrading', sel: PC('FRONT'), expect: (h, c) => req(pc(c.after, 'FRONT').lockGrading === true, 'lockGrading not set') },
  { id: 'seam.updateGrading', sel: PC('FRONT'), change: 'maybe', pre: P((app, ops, doc, E) => ops.setLockGrading(doc, E.P('FRONT').id, true)) },
  { id: 'seam.reseam', sel: PC('FRONT'), change: 'maybe', expect: (h, c) => req(c.rec.toasts.some(t => /Reseamed/.test(t.text)), 'no reseam report toast') },
  { id: 'seam.reseamAll', change: 'maybe', expect: (h, c) => req(c.rec.toasts.some(t => /reseamed/i.test(t.text)), 'no toast') },
  { id: 'seam.reseamSegment', sel: A('FRONT', 'SS_HEM'), drive: DLG({ set: true, v: '14' }), expect: (h, c) => req(an(c.after, 'FRONT', 'SS_HEM').seamAfter === 14, 'seamAfter ≠ 14') },
  { id: 'seam.repair', change: 'maybe', drive: OK() },
  { id: 'seam.toInternal', sel: PC('FRONT'), expect: (h, c) => req(count(c.after, 'FRONT', 'internals') === 2, 'cut line not converted to an internal') },
  { id: 'seam.fromInternal', pre: P((app, ops, doc, E) => ops.seamToInternal(doc, E.P('FRONT').id)), invoke: h => h.cmd('seam.fromInternal'),
    drive: seq(h => h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'); const c = p.internals[1]; const a = c.points[0], b = c.points[1]; return E.localToWorld('FRONT', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); }).then(w => h.clickW(w)), DLG({ m: 'manual' })),
    expect: (h, c) => req(pc(c.after, 'FRONT').cutMode === 'manual', 'cutMode not manual') },
  { id: 'seam.cutAuto', pre: P((app, ops, doc, E) => { const id = ops.seamToInternal(doc, E.P('FRONT').id); ops.internalToSeam(doc, E.P('FRONT').id, id, 'manual'); }), sel: PC('FRONT'), expect: (h, c) => req(pc(c.after, 'FRONT').cutMode !== 'manual', 'still manual') },
  { id: 'seam.deleteSegment', sel: A('FRONT', 'SS_HEM'), expect: (h, c) => req(an(c.after, 'FRONT', 'SS_HEM').seamAfter === 0, 'seamAfter not 0: ' + an(c.after, 'FRONT', 'SS_HEM').seamAfter) },
  { id: 'seam.removePiece', sel: PC('FRONT') },
  { id: 'seam.removeAll', drive: OK() },
  { id: 'seam.noSeam', sel: PC('FRONT'), expect: (h, c) => req(pc(c.after, 'FRONT').noSeam === true, 'noSeam not set') },
  { id: 'seam.autoReseam', expect: (h, c) => req(c.after.settings.autoReseam === !c.before.settings.autoReseam, 'autoReseam not toggled') },
  toggleS('seam.showCut', 'showCut'),
  toggleS('seam.showCorners', 'showCutCorners'),

  // ═════════ Notch ═════════
  tool('notch.tool', 'notch'),
  { id: 'notch.grid', sel: PC('FRONT'), change: false, expect: async h => req(await win('notchgrid')(h), 'notch grid window not open') },
  { id: 'notch.atPoint', sel: A('FRONT', 'UA'), expect: (h, c) => req(count(c.after, 'FRONT', 'notches') === 2 && pc(c.after, 'FRONT').notches[1].placement.kind === 'anchor', 'no anchored notch') },
  { id: 'notch.corner', sel: A('FRONT', 'UA'), drive: OK(), expect: (h, c) => req(count(c.after, 'FRONT', 'notches') === 2, 'no corner notch') },
  { id: 'notch.cross', invoke: h => h.cmd('notch.cross'), drive: seq(at('FRONT', 'IL_A'), OK()), expect: (h, c) => req(count(c.after, 'FRONT', 'notches') === 2, 'no cross notch') },
  { id: 'notch.addPoints', sel: PC('FRONT'), expect: (h, c) => req(npts(c.after, 'FRONT') === 11, 'no point added under the notch') },
  { id: 'notch.global', sel: PC('FRONT'), drive: DLG({ rule: 'fromPrev' }), expect: (h, c) => req(pc(c.after, 'FRONT').notches[0].placement.kind === 'fromPrev', 'placement not converted') },
  { id: 'notch.setup', drive: DLG({ slit_d: '8' }), expect: (h, c) => req(c.after.settings.notchSetup.slit.depth === 8, 'slit depth not 8') },
  tool('drill.tool', 'drill'),
  { id: 'drill.duplicate', invoke: h => h.cmd('drill.duplicate'), drive: seq(h => h.clickLocal('FRONT', { x: 130, y: 520 }), DLG({ n: '3' })), expect: (h, c) => req(count(c.after, 'FRONT', 'drills') === 4, 'expected 4 drills') },
  { id: 'drill.multi', invoke: h => h.cmd('drill.multi'), drive: seq(h => h.clickLocal('FRONT', { x: 130, y: 520 }), at('FRONT', 'IL_B'), DLG({ n: '4' })), expect: (h, c) => req(count(c.after, 'FRONT', 'drills') >= 4, 'buttons not created: ' + count(c.after, 'FRONT', 'drills')) },
  { id: 'drill.slit', sel: A('FRONT', 'SS_HEM'), drive: OK(), expect: (h, c) => req(count(c.after, 'FRONT', 'drills') === 6, 'expected 1+5 drills, got ' + count(c.after, 'FRONT', 'drills')) },
  tool('text.tool', 'text'),
  { id: 'art.place', invoke: chooser([f('tiny.png')], 'art.place'), drive: seq(h => h.clickLocal('FRONT', { x: 120, y: 300 }), OK()), expect: (h, c) => req(count(c.after, 'FRONT', 'artwork') === 1, 'no artwork') },
  { id: 'art.delete', pre: P((app, ops, doc, E) => ops.addArtwork(doc, E.P('FRONT'), { x: 100, y: 300, width: 50, height: 50, src: 'data:image/png;base64,iVBORw0KGgo=', scaleX: 1, scaleY: 1, angleDeg: 0, name: 'a' })), sel: PC('FRONT'), expect: (h, c) => req(count(c.after, 'FRONT', 'artwork') === 0, 'artwork not deleted') },
  { id: 'binding', invoke: h => h.cmd('binding'), drive: seq(seg('FRONT', 'HPS', 'CF_NECK', 0.5), h => h.key('Enter'), OK()), expect: (h, c) => req(Q.has(c.after, 'BINDING'), 'no BINDING piece') },

  // ═════════ Measure ═════════
  tool('measure.tool', 'measure'), tool('measure.walk', 'walk'),
  { id: 'measure.piece', sel: PC('FRONT'), change: false, expect: async h => req((await h.page.locator('.fwin[data-win="pieceinfo"] tr').count()) === 5, 'piece info: expected header + 4 size rows') },
  { id: 'measure.compare', change: false, drive: async h => { await h.page.waitForSelector('.fwin[data-win="compare"]'); await h.page.locator('.fwin[data-win="compare"] button', { hasText: 'Add + …' }).click(); await h.clickSeg('FRONT', 'SS_HEM', 'UA'); await h.key('Enter'); },
    expect: async h => req((await h.page.locator('.fwin[data-win="compare"] tr').count()) === 5, 'compare table not filled') },
  { id: 'measure.compare#edit', title: 'Compare length ▸ Edit segment to target…', invoke: h => h.cmd('measure.compare'),
    drive: async h => { await h.page.locator('.fwin[data-win="compare"] button', { hasText: 'Clear' }).click(); await h.page.locator('.fwin[data-win="compare"] button', { hasText: 'Add + …' }).click(); await h.clickSeg('FRONT', 'SS_HEM', 'UA'); await h.key('Enter'); await h.page.locator('.fwin[data-win="compare"] button', { hasText: 'Edit segment to target' }).click(); await h.waitDialog(); await h.fields({ how: 'len', v: '480' }); await h.ok(); },
    expect: async h => { const L = await h.ev(() => window.__e2e.segLen('FRONT', 'SS_HEM', 'UA')); return req(near(L, 480, 0.05), 'segment length ' + L); } },
  { id: 'measure.walkCheck', change: false, invoke: h => h.cmd('measure.walkCheck'), drive: async h => { await h.clickSeg('FRONT', 'SS_HEM', 'UA'); await h.clickSeg('BACK', 'BL', 'TL'); await h.key('Enter'); await OK()(h); },
    expect: async h => req(await win('walkcheck')(h), 'walking-check window not open') },
  { id: 'measure.segLength', sel: A('FRONT', 'SS_HEM'), change: false, expect: async h => req((await h.page.locator('.fwin[data-win="measure"] tr').count()) === 5, 'per-size table missing') },
  { id: 'measure.notchReport', sel: A('FRONT', 'SS_HEM'), change: false, drive: async h => { await h.waitDialog(); h._m = await h.dlg().locator('.dlg-msg').textContent(); await h.ok(); }, expect: h => req(/^1\./.test(h._m || ''), 'notch not listed: ' + h._m) },
  { id: 'piece.scale', sel: PC('FRONT'), drive: DLG({ _x: '2', _y: '3' }), expect: (h, c) => { const w = an(c.after, 'FRONT', 'SS_HEM').x - an(c.after, 'FRONT', 'CF_HEM').x, ht = an(c.after, 'FRONT', 'HPS').y - an(c.after, 'FRONT', 'CF_HEM').y; return req(near(w, 265.2, 0.05) && near(ht, 733.36, 0.05), `scaled width ${w} (want 265.2) height ${ht} (want 733.36)`); } },

  // ═════════ Point ═════════
  { id: 'point.toggleSmooth', sel: A('FRONT', 'UA'), expect: (h, c) => req(an(c.after, 'FRONT', 'UA').smooth === true, 'UA not smooth') },
  { id: 'point.toggleKind', sel: A('FRONT', 'AH1'), expect: (h, c) => req(an(c.after, 'FRONT', 'AH1').kind === 'grade', 'AH1 not grade') },
  { id: 'point.breakHandle', sel: A('FRONT', 'AH1') },
  { id: 'point.joinHandle', pre: P((app, ops, doc, E) => ops.breakHandle(doc, E.P('FRONT').id, E.findA('FRONT', 'AH1').a.id)), sel: A('FRONT', 'AH1') },
  { id: 'point.resetHandles', pre: P((app, ops, doc, E) => doc.transact('pre', () => { const a = E.findA('FRONT', 'AH1').a; a.hIn = { x: 10, y: -20 }; a.hOut = { x: -10, y: 20 }; })), sel: A('FRONT', 'AH1'), expect: (h, c) => req(!an(c.after, 'FRONT', 'AH1').hIn, 'handles not reset') },
  { id: 'point.lock', sel: A('FRONT', 'UA'), expect: (h, c) => req(an(c.after, 'FRONT', 'UA').flags.locked === true, 'not locked') },
  { id: 'point.startPoint', sel: A('FRONT', 'UA'), expect: (h, c) => req(an(c.after, 'FRONT', 'UA').flags.startPoint === true, 'not start point') },
  { id: 'point.add', sel: A('FRONT', 'SS_HEM'), drive: DLG({ how: 'prev', d: '100' }), expect: (h, c) => { const p = pc(c.after, 'FRONT'); const n = p.sew.points.find(a => !pc(c.before, 'FRONT').sew.points.some(b => b.id === a.id)); return [req(n && near(n.x, 260, 0.01) && near(n.y, 100, 0.01), 'new point not at (260,100): ' + JSON.stringify(n && [n.x, n.y])), req(c.afterSel.anchors.length === 1, 'new point not selected')]; } },
  { id: 'point.insertMid', sel: A('FRONT', 'SS_HEM'), expect: (h, c) => req(npts(c.after, 'FRONT') === 11, 'no point inserted') },
  { id: 'point.addAt', invoke: h => h.cmd('point.addAt'), drive: seg('FRONT', 'SS_HEM', 'UA', 0.3), expect: (h, c) => req(npts(c.after, 'FRONT') === 11, 'no point inserted') },
  { id: 'point.moveXY', sel: A('FRONT', 'SS_HEM'), drive: DLG({ _dx: '5', _dy: '0' }), expect: (h, c) => [req(near(an(c.after, 'FRONT', 'SS_HEM').x, 265), 'not moved by 5'), req(!otherChanged(c.before, c.after, 'FRONT', ['SS_HEM']).length, 'other anchors changed: ' + JSON.stringify(otherChanged(c.before, c.after, 'FRONT', ['SS_HEM'])))] },
  { id: 'point.moveAlong', sel: A('FRONT', 'UA'), drive: DLG({ d: '-15' }), expect: (h, c) => req(near(an(c.after, 'FRONT', 'UA').y, 450, 0.05), 'UA.y ' + an(c.after, 'FRONT', 'UA').y) },
  { id: 'point.moveProportional', sel: A('FRONT', 'SH'), drive: DLG({ dx: '6', dy: '0' }), expect: (h, c) => [req(near(an(c.after, 'FRONT', 'SH').x, 206, 0.01), 'SH not moved'), req(an(c.after, 'FRONT', 'AH2').x > an(c.before, 'FRONT', 'AH2').x, 'curve points did not blend')] },
  toggleS('point.propDrag', 'proportionalDrag'),
  { id: 'point.multiMove', sel: AA(['FRONT', 'SS_HEM'], ['FRONT', 'UA']), drive: DLG({ dx: '4', dy: '0' }), expect: (h, c) => req(near(an(c.after, 'FRONT', 'SS_HEM').x, 264) && near(an(c.after, 'FRONT', 'UA').x, 264), 'both not moved') },
  { id: 'point.alignH', sel: AA(['FRONT', 'HPS'], ['FRONT', 'SH']), expect: (h, c) => req(near(an(c.after, 'FRONT', 'SH').y, 712, 0.01), 'SH.y ' + an(c.after, 'FRONT', 'SH').y) },
  { id: 'point.alignV', sel: AA(['FRONT', 'SH'], ['FRONT', 'HPS']), expect: (h, c) => req(near(an(c.after, 'FRONT', 'HPS').x, 200, 0.01), 'HPS.x ' + an(c.after, 'FRONT', 'HPS').x) },
  { id: 'point.alignAngle', sel: AA(['FRONT', 'SH'], ['FRONT', 'HPS']), drive: DLG({ a: '0' }) },
  { id: 'point.setAngle', sel: A('FRONT', 'SS_HEM'), drive: DLG({ a: '95' }), expect: async h => { const v = await h.ev(() => window.__e2e.ops.cornerAngle(window.__e2e.app.doc, window.__e2e.P('FRONT').id, window.__e2e.findA('FRONT', 'SS_HEM').a.id)); return req(near(v, 95, 0.05), 'angle now ' + v); } },
  { id: 'point.round', sel: A('FRONT', 'SS_HEM'), drive: DLG({ r: '20' }), expect: (h, c) => req(npts(c.after, 'FRONT') > 10, 'no rounding points') },
  { id: 'point.splineSupport', sel: A('FRONT', 'SS_HEM'), drive: DLG({ n: '3' }), expect: (h, c) => req(npts(c.after, 'FRONT') === 13, 'expected +3 points, got ' + npts(c.after, 'FRONT')) },
  { id: 'point.cleanup', pre: P((app, ops, doc, E) => doc.transact('pre', () => { const p = E.P('FRONT'); const i = p.sew.points.findIndex(a => a.name === 'SS_HEM'); p.sew.points.splice(i + 1, 0, { id: 'pXTRA', x: 260, y: 200, kind: 'curve', smooth: false, grade: {}, flags: {} }); })), sel: PC('FRONT'), drive: DLG({ tol: '0.05' }), expect: (h, c) => req(npts(c.after, 'FRONT') === 10, 'redundant collinear point not removed') },
  { id: 'point.delete', sel: A('FRONT', 'AH1'), expect: (h, c) => req(npts(c.after, 'FRONT') === 9, 'not deleted') },

  // ═════════ Segment ═════════
  { id: 'seg.length', sel: A('FRONT', 'SS_HEM'), drive: DLG({ _L: '480' }), expect: async h => { const L = await h.ev(() => window.__e2e.segLen('FRONT', 'SS_HEM', 'UA')); return req(near(L, 480, 0.05), 'length ' + L); } },
  { id: 'seg.copy', sel: A('FRONT', 'UA'), change: false, expect: (h, c) => req(c.rec.toasts.some(t => /Segment copied/.test(t.text)), 'no copied toast') },
  { id: 'seg.paste', sel: async h => { await h.selectA('FRONT', 'UA'); await h.key('Control+Alt+Shift+C'); await h.selectA('BACK', 'TR'); }, drive: OK(), expect: (h, c) => req(npts(c.after, 'BACK') > 4, 'BACK top edge not reshaped') },
  { id: 'seg.rotate', sel: A('FRONT', 'SS_HEM'), drive: seq(at('FRONT', 'SS_HEM'), W(320, 450), OK()), expect: async (h, c) => { const u0 = an(c.before, 'FRONT', 'UA'), u1 = an(c.after, 'FRONT', 'UA'); const L = Math.hypot(u1.x - 260, u1.y); return [req(!nearV(u0, u1, 0.5), 'UA did not move'), req(near(L, 465, 0.1), 'length not kept: ' + L)]; } },
  { id: 'seg.swap', pre: YOKE, invoke: h => h.cmd('seg.swap'), drive: W(130, 400), expect: (h, c) => req(npts(c.after, 'FRONT') !== 10 || count(c.after, 'FRONT', 'internals') !== 2, 'nothing swapped') },
  { id: 'seg.divide', pre: addInternal([[60, 100, 'D1'], [60, 200, 'D2'], [60, 300, 'D3']]), sel: A('FRONT', 'D2'), expect: (h, c) => req(count(c.after, 'FRONT', 'internals') === 3, 'internal not divided') },
  { id: 'seg.join', pre: addInternal([[130, 380, 'J1'], [200, 450, 'J2']]), invoke: h => h.cmd('seg.join'), drive: seq(W(130, 230), W(165, 415)), expect: (h, c) => req(count(c.after, 'FRONT', 'internals') === 1, 'internals not joined') },
  { id: 'seg.dashed', sel: A('FRONT', 'IL_A'), expect: (h, c) => req(pc(c.after, 'FRONT').internals[0].style === 'dashed', 'not dashed') },
  { id: 'seg.trim', pre: addInternal([[60, 200, 'H1'], [200, 200, 'H2']]), invoke: h => h.cmd('seg.trim'), drive: W(130, 300), expect: (h, c) => req(JSON.stringify(pc(c.after, 'FRONT').internals) !== JSON.stringify(pc(c.before, 'FRONT').internals), 'nothing trimmed') },
  { id: 'seg.globalTrim', pre: addInternal([[180, 600, 'G1'], [180, 800, 'G2']]), change: 'maybe', expect: (h, c) => req(c.changed, 'internal crossing the neckline not trimmed') },
  { id: 'seg.globalJoin', pre: addInternal([[130, 380, 'J1'], [200, 450, 'J2']]), expect: (h, c) => req(count(c.after, 'FRONT', 'internals') === 1, 'not joined') },
  { id: 'seg.extend', invoke: h => h.cmd('seg.extend'), drive: seq(at('FRONT', 'IL_B'), DLG({ how: 'by', by: '20' })), expect: (h, c) => { const ic = pc(c.after, 'FRONT').internals[0]; const ys = ic.points.map(a => +a.y.toFixed(2)); return req(near(Math.max(...ys), 400, 0.05) && near(Math.min(...ys), 80, 0.05), 'internal y-range after extend at IL_B end: ' + JSON.stringify(ys)); } },
  tool('seg.smooth', 'smooth'),

  // ═════════ Cut ═════════
  tool('cut.slash', 'slash'),
  { id: 'cut.alongInternal', pre: YOKE, invoke: h => h.cmd('cut.alongInternal'), drive: seq(W(60, 400), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'not cut: ' + pieces(c.after)) },
  { id: 'cut.h', sel: A('FRONT', 'UA'), drive: seq(OK(), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'not cut: ' + pieces(c.after)) },
  { id: 'cut.v', sel: A('FRONT', 'HPS'), drive: seq(OK(), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'not cut: ' + pieces(c.after)) },
  { id: 'cut.parallel', sel: A('FRONT', 'CF_HEM'), drive: seq(DLG({ d: '40' }), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'not cut') },
  { id: 'cut.guide', sel: async h => { await h.ev(() => { const E = window.__e2e; E.settings.guides = [{ axis: 'x', pos: 130 }]; E.app.invalidate(); }); await h.selectPiece('FRONT'); }, drive: OK(), expect: (h, c) => req(c.after.pieces.length === 3, 'not cut') },
  { id: 'cut.parallelInternal', invoke: h => h.cmd('cut.parallelInternal'), drive: seq(seg('FRONT', 'SS_HEM', 'UA'), DLG({ d: '30' })), expect: (h, c) => req(count(c.after, 'FRONT', 'internals') === 2, 'no parallel internal') },
  { id: 'cut.extendParallel', sel: A('FRONT', 'SS_HEM'), drive: DLG({ a: '10' }), expect: (h, c) => req(near(an(c.after, 'FRONT', 'UA').x, 270, 0.5), 'side seam not moved out: UA.x ' + an(c.after, 'FRONT', 'UA').x) },
  { id: 'shape.arc', sel: A('FRONT', 'CF_HEM'), drive: DLG({ by: 'depth', v: '20' }) },
  { id: 'shape.wave', sel: A('FRONT', 'CF_HEM'), drive: OK() },
  { id: 'shape.scallop', sel: A('FRONT', 'CF_HEM'), drive: OK() },
  { id: 'shape.ruffle', sel: A('FRONT', 'CF_HEM'), drive: OK(), expect: (h, c) => req(Q.has(c.after, 'RUFFLE'), 'no RUFFLE') },
  { id: 'shape.circular', drive: OK(), expect: (h, c) => req(c.after.pieces.length > 2, 'no skirt') },
  tool('cut.trace', 'trace'),
  { id: 'cut.build', pre: YOKE, invoke: h => h.cmd('cut.build'), drive: seq(W(60, 500), OK()), expect: (h, c) => req(c.after.pieces.length === 3, 'no piece built') },
  { id: 'cut.join', invoke: h => h.cmd('cut.join'), drive: seq(seg('FRONT', 'SS_HEM', 'UA', 0.4), seg('BACK', 'TL', 'BL', 0.7), OK()), expect: (h, c) => req(c.after.pieces.length === 1, 'pieces not joined: ' + pieces(c.after)) },
  { id: 'cut.foldIn', sel: PC('FRONT'), drive: seq(W(200, -40), W(200, 745), W(80, 300), OK()) },
  { id: 'cut.foldOut', pre: P((app, ops, doc, E) => ops.foldIn(doc, E.P('FRONT').id, { a: { x: 200, y: -40 }, b: { x: 200, y: 745 } }, { keep: { x: 80, y: 300 } })), invoke: h => h.cmd('cut.foldOut'),
    drive: async h => { const w = await h.ev(() => { const E = window.__e2e; const p = E.P('FRONT'); const c = p.internals[p.internals.length - 1]; const a = c.points[0], b = c.points[c.points.length - 1]; return E.localToWorld('FRONT', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); }); await h.clickW(w); await OK()(h); } },
  { id: 'cut.halfSet', sel: PC('FRONT'), drive: seq(at('FRONT', 'CF_HEM'), at('FRONT', 'CF_NECK'), OK()), expect: (h, c) => req(!!pc(c.after, 'FRONT').half, 'half not set') },
  { id: 'cut.halfOpen', pre: P((app, ops, doc, E) => ops.setHalf(doc, E.P('FRONT').id, { a: { x: 0, y: 0 }, b: { x: 0, y: 622 } }, { openAtOutput: true })), sel: PC('FRONT'), expect: (h, c) => req(!pc(c.after, 'FRONT').half && npts(c.after, 'FRONT') > 12, 'not opened') },
  { id: 'cut.halfDelete', pre: P((app, ops, doc, E) => ops.setHalf(doc, E.P('FRONT').id, { a: { x: 0, y: 0 }, b: { x: 0, y: 622 } }, { openAtOutput: true })), sel: PC('FRONT'), expect: (h, c) => req(!pc(c.after, 'FRONT').half, 'half not deleted') },

  // ═════════ Piece ═════════
  { id: 'piece.rename', sel: PC('FRONT'), drive: DLG({ n: 'FRONT A' }), expect: (h, c) => req(Q.has(c.after, 'FRONT A'), 'not renamed') },
  { id: 'piece.lock', sel: PC('FRONT'), expect: (h, c) => req(pc(c.after, 'FRONT').locked === true, 'not locked') },
  { id: 'piece.rotate', sel: PC('FRONT'), drive: DLG({ a: '45' }), expect: (h, c) => req(pc(c.after, 'FRONT').layout?.angleDeg === 45, 'angle') },
  { id: 'piece.rotate90', sel: PC('FRONT'), expect: (h, c) => req(pc(c.after, 'FRONT').layout?.angleDeg === 90, 'angle') },
  { id: 'piece.resetLayout', pre: P((app, ops, doc, E) => doc.transact('pre', () => { E.P('BACK').layout = { x: 80, y: 20, angleDeg: 0 }; })), sel: PC('BACK'), expect: (h, c) => req(!pc(c.after, 'BACK').layout, 'layout kept') },
  { id: 'piece.saveLayout', drive: DLG({ n: 'MARKER A' }), expect: (h, c) => req(!!c.after.layouts['MARKER A'], 'layout not saved') },
  { id: 'piece.restoreLayout', pre: P((app, ops, doc, E) => { ops.saveLayout(doc, 'L1'); doc.transact('pre', () => { E.P('BACK').layout = { x: 120, y: 0, angleDeg: 0 }; }); }), drive: OK(), expect: (h, c) => req(!pc(c.after, 'BACK').layout || pc(c.after, 'BACK').layout.x === 0, 'layout not restored') },
  { id: 'piece.grain', sel: PC('FRONT'), drive: DLG({ a: '45' }), expect: (h, c) => { const g = pc(c.after, 'FRONT').grain; return req(near(Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x) * 180 / Math.PI, 45, 0.01), 'grain angle'); } },
  { id: 'piece.grainCenter', pre: P((app, ops, doc, E) => doc.transact('pre', () => { const g = E.P('FRONT').grain; g.a = { x: 40, y: 100 }; g.b = { x: 40, y: 500 }; g.centered = false; })), sel: PC('FRONT') },
  { id: 'piece.grainParallel', sel: A('FRONT', 'SH'), expect: (h, c) => { const g = pc(c.after, 'FRONT').grain; const ang = Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x) * 180 / Math.PI; const s = Math.atan2(712 - 680, 85 - 200) * 180 / Math.PI; return req(near(((ang - s) % 180 + 180) % 180, 0, 0.5) || near(((ang - s) % 180 + 180) % 180, 180, 0.5), `grain ${ang} vs shoulder ${s}`); } },
  { id: 'piece.rotateToGrain', pre: P((app, ops, doc, E) => doc.transact('pre', () => { const g = E.P('FRONT').grain; g.a = { x: 100, y: 100 }; g.b = { x: 200, y: 200 }; })), sel: PC('FRONT'), drive: OK(), expect: (h, c) => { const g = pc(c.after, 'FRONT').grain; return req(near(Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x) * 180 / Math.PI, 90, 0.01), 'grain not vertical after rotate-to-grain'); } },
  { id: 'piece.refSave', sel: PC('FRONT'), drive: DLG({ n: 'before fit' }), expect: (h, c) => req(!!pc(c.after, 'FRONT').reference, 'no reference') },
  toggleS('piece.refShow', 'showReference'),
  { id: 'piece.refRestore', pre: P((app, ops, doc, E) => { ops.snapshotReference(doc, E.P('FRONT').id); ops.movePoint(doc, E.P('FRONT').id, E.findA('FRONT', 'SS_HEM').a.id, { dx: 30, dy: 0 }); }), sel: PC('FRONT'), drive: OK(), expect: (h, c) => req(near(an(c.after, 'FRONT', 'SS_HEM').x, 260, 0.01), 'not restored') },
  { id: 'piece.refClear', pre: P((app, ops, doc, E) => ops.snapshotReference(doc, E.P('FRONT').id)), sel: PC('FRONT'), expect: (h, c) => req(!pc(c.after, 'FRONT').reference, 'reference kept') },
  { id: 'piece.connCheck', pre: addInternal([[260, 465, 'CN_A'], [150, 420, 'CN_B']]), sel: PC('FRONT'), expect: (h, c) => req(count(c.after, 'FRONT', 'connections') >= 1, 'no connection found for the internal end on UA') },
  { id: 'piece.connClear', pre: seq(addInternal([[260, 465, 'CN_A'], [150, 420, 'CN_B']]), P((app, ops, doc, E) => ops.globalCheckConnections(doc, E.P('FRONT').id))), sel: PC('FRONT'), expect: (h, c) => req(count(c.after, 'FRONT', 'connections') === 0, 'connections kept') },
  { id: 'piece.saveAsNew', sel: PC('FRONT'), expect: (h, c) => req(c.after.pieces.length === 3 || c.after.pieceArchive.length === 1, 'no version') },
  { id: 'piece.replaceOld', pre: P((app, ops, doc, E) => ops.saveActiveAsNew(doc, E.P('FRONT').id)), sel: async h => { const n = await h.ev(() => window.__e2e.app.doc.style.pieces.map(p => p.name)); h._new = n.find(x => x !== 'FRONT' && x !== 'BACK'); await h.selectPiece(h._new); }, drive: async h => { await h.waitDialog(); await h.dlg().locator('[data-key="old"]').selectOption({ label: 'FRONT' }); await h.ok(); },
    expect: (h, c) => req(c.after.pieceArchive.length >= 1, 'old piece not archived') },
  { id: 'piece.archive', pre: P((app, ops, doc, E) => { const id = ops.saveActiveAsNew(doc, E.P('FRONT').id); ops.replaceOld(doc, E.P('FRONT').id, id); }), drive: OK(), expect: (h, c) => req(c.after.pieces.some(p => / \(restored\)$/.test(p.name)), 'no restored copy') },
  { id: 'piece.merge', invoke: chooser([f('e2e-open.prowd.json')], 'piece.merge'), drive: OK(), expect: (h, c) => req(c.after.pieces.length === 4, 'not merged') },
  { id: 'piece.delete', sel: PC('BACK'), drive: OK(), expect: (h, c) => req(c.after.pieces.length === 1, 'not deleted') },

  // ═════════ Grade ═════════
  { id: 'grade.table', change: false, sel: async h => { h._v0 = await h.ev(() => window.__e2e.settings.panels.grading); }, expect: async h => req((await h.ev(() => window.__e2e.settings.panels.grading)) === !h._v0, 'grading panel not toggled') },
  toggleApp('grade.nested', 'app.nested'), toggleApp('grade.absolute', 'app.gradeAbsolute'), toggleApp('grade.tracking', 'app.pointTracking'), toggleS('grade.ruleNames', 'showRuleNames'),
  { id: 'grade.prevSize', change: false, expect: async h => req((await appv("app.sizeLine().sizes.find(s=>s.id===app.activeSize).name")(h)) === 'S', 'active size not S') },
  { id: 'grade.nextSize', change: false, expect: async h => req((await appv("app.sizeLine().sizes.find(s=>s.id===app.activeSize).name")(h)) === 'L', 'active size not L') },
  { id: 'grade.baseSize', change: false, sel: async h => { await h.page.locator('select.sb-size').selectOption({ label: 'XL' }); }, expect: async h => req((await appv('app.activeSize === app.baseSize()')(h)), 'not base') },
  { id: 'grade.copy', sel: A('FRONT', 'SS_HEM'), change: false, expect: (h, c) => req(c.rec.statuses.some(s => /Grade copied/.test(s)), 'no status') },
  ...[['grade.paste', (s, c) => s.L.dx === 10 && s.L.dy === 0], ['grade.pasteX', s => s.L.dx === 10], ['grade.pasteY', s => s.L.dy === 5 && s.L.dx === 0], ['grade.pasteFlipX', s => s.L.dx === -10], ['grade.pasteFlipY', s => s.L.dy === 0 && s.L.dx === 10], ['grade.smartPaste', s => Math.abs(s.L.dx) === 10]].map(([id, ok]) => ({
    id, sel: async h => { await copyGradeOf(id === 'grade.pasteY' ? 'FRONT' : 'FRONT', id === 'grade.pasteY' ? 'UA' : 'SS_HEM')(h); await h.selectA('FRONT', 'CF_HEM'); },
    expect: (h, c) => { const s = abs(c.after, 'FRONT', 'CF_HEM'); return req(ok(s), `${id}: CF_HEM grade L = ${JSON.stringify(s.L)}`); } })),
  { id: 'grade.pasteAround', sel: async h => { await copyGradeOf('FRONT', 'UA')(h); await h.selectA('FRONT', 'UA'); await h.selectA('FRONT', 'SH', true); }, change: 'maybe' },
  ...[['grade.flipX', s => s.L.dx === -10], ['grade.flipY', s => s.L.dy === -5], ['grade.equalX', null], ['grade.equalY', null], ['grade.deleteX', s => s.L.dx === 0 && s.L.dy === 5], ['grade.deleteY', s => s.L.dy === 0 && s.L.dx === 10], ['grade.zero', s => s.L.dx === 0 && s.L.dy === 0]].map(([id, ok]) => ({
    id, pre: ok ? undefined : P((app, ops, doc, E) => { const L = app.sizeLine(); ops.setGrade(doc, E.P('FRONT').id, E.findA('FRONT', 'UA').a.id, L.sizes[3].id, { dx: 25, dy: 13 }, { view: 'absolute' }); }), sel: ok ? A('FRONT', 'UA') : AA(['FRONT', 'UA'], ['FRONT', 'SH']), expect: (h, c) => ok ? req(ok(abs(c.after, 'FRONT', 'UA')), `${id}: UA L = ${JSON.stringify(abs(c.after, 'FRONT', 'UA').L)}`) : undefined })),
  { id: 'grade.stackPoint', sel: A('FRONT', 'SS_HEM'), expect: (h, c) => { const s = abs(c.after, 'FRONT', 'SS_HEM'); return req(s.L.dx === 0 && s.XL.dx === 0, 'SS_HEM still graded: ' + JSON.stringify(s)); } },
  { id: 'grade.stackLine', invoke: h => h.cmd('grade.stackLine'), drive: seq(at('FRONT', 'SS_HEM'), at('FRONT', 'UA')) },
  { id: 'grade.angle', sel: A('FRONT', 'UA'), drive: OK(), expect: (h, c) => req(an(c.after, 'FRONT', 'UA').gradeAxisDeg != null, 'no grade axis') },
  { id: 'grade.parallel', pre: P((app, ops, doc, E) => { const L = app.sizeLine(); ops.setGrade(doc, E.P('FRONT').id, E.findA('FRONT', 'UA').a.id, L.sizes[2].id, { dx: 14, dy: 5 }, { view: 'absolute' }); }), sel: A('FRONT', 'SS_HEM'), drive: OK(), expect: (h, c) => { const a = abs(c.after, 'FRONT', 'UA'), b = abs(c.after, 'FRONT', 'SS_HEM'); return req(near(a.L.dx, b.L.dx, 0.01), `side seam not parallel in L: SS_HEM dx ${b.L.dx}, UA dx ${a.L.dx}`); } },
  { id: 'grade.proportional', invoke: h => h.cmd('grade.proportional'), drive: seq(at('FRONT', 'SS_HEM'), at('FRONT', 'SH'), OK()) },
  { id: 'grade.rules', change: false, expect: async h => req(await h.ev(() => !!document.querySelector('.fwin')), 'rule library window not open') },
  { id: 'grade.applyRule', pre: P((app, ops, doc, E) => { const lib = ops.createLibrary(doc, 'LIB'); const L = app.sizeLine(); const v = {}; for (const s of L.sizes.slice(1)) v[s.id] = { dx: 7, dy: 1 }; ops.createRuleFromValues(doc, lib, v, { number: 1, name: 'R1' }); }), sel: A('FRONT', 'UA'), drive: DLG({ r: '1' }), expect: (h, c) => req(an(c.after, 'FRONT', 'UA').ruleId != null, 'rule not applied') },
  { id: 'grade.detachRule', pre: P((app, ops, doc, E) => { const lib = ops.createLibrary(doc, 'LIB'); const L = app.sizeLine(); const v = {}; for (const s of L.sizes.slice(1)) v[s.id] = { dx: 7, dy: 1 }; ops.createRuleFromValues(doc, lib, v, { number: 1, name: 'R1' }); ops.applyRule(doc, E.P('FRONT').id, [E.findA('FRONT', 'UA').a.id], 1); }), sel: A('FRONT', 'UA'), expect: (h, c) => req(an(c.after, 'FRONT', 'UA').ruleId == null, 'rule still attached') },
  { id: 'grade.movement', change: false, expect: async h => req(await h.ev(() => !!document.querySelector('.fwin')), 'movement window not open') },
  { id: 'grade.nest', sel: async h => { await h.selectPiece('FRONT'); await h.key('Control+d'); await h.selectPiece('FRONT'); await h.selectPiece('FRONT COPY', true); }, drive: async h => { await h.waitDialog(); h._nm = await h.dlg().locator('[data-key="name"]').inputValue(); await h.ok(); }, expect: (h, c) => [req(c.after.pieces.length === 4, 'no nest piece'), req(/\S/.test((h._nm || '').split('NEST')[0]), `default name for a nest of "FRONT" + "FRONT COPY" is "${h._nm}" (base name lost)`)] },
  { id: 'size.deleteUngraded', pre: P((app, ops, doc) => ops.appendSize(doc, 'XXL', { extrapolate: false })), drive: OK(), expect: (h, c) => req(!Q.line(c.after).sizes.some(s => s.name === 'XXL'), 'XXL kept') },
  { id: 'size.deleteInvisible', pre: P((app, ops, doc) => doc.transact('pre', () => { const L = app.sizeLine(); for (const p of doc.style.pieces) p.sizes = L.sizes.slice(0, 3).map(s => s.id); })), drive: OK(), expect: (h, c) => req(Q.line(c.after).sizes.length === 3, 'XL kept') },
  { id: 'size.axis2', drive: OK(), expect: (h, c) => req(!!c.after.sizeTables[0].axis2, 'no axis 2') },

  // ═════════ Dart / Pleat / Fullness ═════════
  { id: 'dart.add', pre: P((app, ops, doc, E) => { const id = ops.addPointOnSegment(doc, E.P('FRONT').id, E.findA('FRONT', 'CF_HEM').a.id, { distance: 130, from: 'prev', kind: 'grade' }); doc.transact('pre', () => { E.findA('FRONT', id).a.name = 'HEM_MID'; }); }), sel: A('FRONT', 'HEM_MID'), drive: DLG({ w: '20', d: '90' }), expect: (h, c) => req(count(c.after, 'FRONT', 'darts') === 1, 'no dart') },
  { id: 'dart.multi', sel: A('FRONT', 'CF_HEM'), drive: OK(), expect: (h, c) => req(count(c.after, 'FRONT', 'darts') === 2, 'expected 2 darts') },
  { id: 'dart.insert', invoke: h => h.cmd('dart.insert'), drive: seq(h => h.clickLocal('FRONT', { x: 100, y: 0 }), h => h.key('Enter'), OK()), expect: (h, c) => req(count(c.after, 'FRONT', 'darts') === 1, 'no dart') },
  { id: 'dart.toggle', ...dartFixture, sel: selDart, expect: (h, c) => req(pc(c.after, 'FRONT').darts[0].closed === true, 'not closed') },
  { id: 'dart.toggle#pick', title: 'Close / reopen dart (no selection → pick)', ...dartFixture, invoke: h => h.cmd('dart.toggle'), drive: clickDart, expect: (h, c) => req(pc(c.after, 'FRONT').darts[0].closed === true, 'not closed') },
  { id: 'dart.reopenWidth', ...dartFixture, pre: P((app, ops, doc, E) => ops.closeDart(doc, E.P('FRONT').id, E.P('FRONT').darts[0].id)), sel: selDart, drive: DLG({ w: '25' }), expect: (h, c) => req(!pc(c.after, 'FRONT').darts[0].closed, 'still closed') },
  { id: 'dart.fix', ...dartFixture, sel: selDart, change: 'maybe' },
  { id: 'dart.cutting', ...dartFixture, sel: selDart, expect: (h, c) => req(pc(c.after, 'FRONT').darts[0].cutting === true, 'not cutting') },
  { id: 'dart.change', ...dartFixture, expect: (h, c) => req(pc(c.after, 'FRONT').darts[0].fold !== pc(c.before, 'FRONT').darts[0].fold, 'fold not flipped') },
  { id: 'dart.closeAll', ...dartFixture, sel: PC('FRONT'), expect: (h, c) => req(pc(c.after, 'FRONT').darts.every(d => d.closed), 'not all closed') },
  { id: 'dart.openAll', ...dartFixture, pre: P((app, ops, doc, E) => ops.closeAllDarts(doc, E.P('FRONT').id)), sel: PC('FRONT'), expect: (h, c) => req(pc(c.after, 'FRONT').darts.every(d => !d.closed), 'not all open') },
  { id: 'dart.cutAll', ...dartFixture, sel: PC('FRONT'), drive: OK(), expect: (h, c) => req(pc(c.after, 'FRONT').darts[0].cutting === true, 'not cutting') },
  { id: 'dart.transfer', ...dartFixture, sel: selDart, drive: seq(h => h.clickLocal('FRONT', { x: 120, y: 0 }), OK()) },
  { id: 'dart.rotateCenter', ...dartFixture, sel: selDart, drive: seq(h => h.clickLocal('FRONT', { x: 120, y: 0 }), h => h.clickLocal('FRONT', { x: 170, y: 200 }), OK()) },
  { id: 'dart.copy', ...dartFixture, sel: selDart, change: false, expect: (h, c) => req(c.rec.toasts.some(t => /Dart copied/.test(t.text)), 'no toast') },
  { id: 'dart.paste', ...dartFixture, sel: async h => { await selDart(h); await h.cmd('dart.copy'); await h.waitIdle(); }, drive: seg('BACK', 'TL', 'BL', 0.5), expect: (h, c) => req(count(c.after, 'BACK', 'darts') === 1, 'no dart on BACK') },
  { id: 'dart.remove', ...dartFixture, sel: selDart, drive: OK(), expect: (h, c) => req(count(c.after, 'FRONT', 'darts') === 0, 'not removed') },
  { id: 'pleat.axis', invoke: h => h.cmd('pleat.axis'), drive: seq(h => h.clickLocal('BACK', { x: 470, y: 700 }), h => h.clickLocal('BACK', { x: 470, y: 400 })), expect: (h, c) => req(count(c.after, 'BACK', 'pleats') === 1, 'no pleat') },
  { id: 'pleat.add', invoke: h => h.cmd('pleat.add'), drive: seq(h => h.clickLocal('BACK', { x: 470, y: 700 }), h => h.clickLocal('BACK', { x: 470, y: 400 }), OK()), expect: (h, c) => req(count(c.after, 'BACK', 'pleats') === 1, 'no pleat') },
  { id: 'pleat.byAngle', invoke: h => h.cmd('pleat.byAngle'), drive: seq(h => h.clickLocal('BACK', { x: 600, y: 700 }), OK()), expect: (h, c) => req(count(c.after, 'BACK', 'pleats') === 1, 'no pleat') },
  { id: 'pleat.multi', sel: A('BACK', 'TR'), drive: DLG({ n: '3' }), expect: (h, c) => req(count(c.after, 'BACK', 'pleats') === 3, 'expected 3 pleats') },
  { id: 'pleat.close', ...dartFixture, sel: selPleat },
  { id: 'pleat.open', ...dartFixture, pre: P((app, ops, doc, E) => ops.closePleat(doc, E.P('BACK').id, E.P('BACK').pleats[0].id)), sel: selPleat },
  { id: 'pleat.closeAll', ...dartFixture, sel: PC('BACK') },
  { id: 'pleat.openAll', ...dartFixture, pre: P((app, ops, doc, E) => ops.closePleats(doc, E.P('BACK').id)), sel: PC('BACK') },
  { id: 'pleat.delete', ...dartFixture, sel: selPleat, expect: (h, c) => req(count(c.after, 'BACK', 'pleats') === 0, 'not deleted') },
  { id: 'fullness.add', invoke: h => h.cmd('fullness.add'), drive: seq(h => h.clickLocal('BACK', { x: 470, y: 0 }), h => h.clickLocal('BACK', { x: 470, y: 600 }), OK()), expect: (h, c) => req(count(c.after, 'BACK', 'fullness') === 1, 'no fullness') },
  { id: 'fullness.multi', sel: A('BACK', 'BL'), drive: seq(h => h.clickLocal('BACK', { x: 530, y: 700 }), OK()), expect: (h, c) => req(count(c.after, 'BACK', 'fullness') === 1, 'no fullness') },
  { id: 'fullness.delete', ...dartFixture, sel: selFull, expect: (h, c) => req(count(c.after, 'BACK', 'fullness') === 0, 'not deleted') },

  // ═════════ View ═════════
  ...['view.fit', 'view.zoomIn', 'view.zoomOut', 'view.zoom100'].map(id => ({ id, change: false, sel: async h => { await h.ev(() => { const v = window.__e2e.app.view; v.scale *= 1.7; v.cx += 300; }); h._v = await appv('[app.view.scale, app.view.cx]')(h); }, expect: async h => req(JSON.stringify(await appv('[app.view.scale, app.view.cx]')(h)) !== JSON.stringify(h._v), 'view unchanged') })),
  { id: 'view.fitSel', sel: async h => { await h.selectPiece('BACK'); h._v = await appv('[app.view.scale, app.view.cx]')(h); }, change: false, expect: async h => req(JSON.stringify(await appv('[app.view.scale, app.view.cx]')(h)) !== JSON.stringify(h._v), 'view unchanged') },
  toggleS('view.grid', 'showGrid'), toggleS('view.rulers', 'showRulers'), toggleS('view.cut', 'showCut'), toggleS('view.anchors', 'showAllAnchors'),
  toggleS('view.snapPoints', 'snapPoints'), toggleS('view.snapGuides', 'snapGuides'), toggleS('view.snapGrid', 'snapGrid'),
  { id: 'view.gridSize', change: false, drive: DLG({ g: '5' }), expect: async h => req((await setting('gridMm')(h)) === 5, 'grid not 5') },
  { id: 'view.clearGuides', change: false, sel: h => h.ev(() => { window.__e2e.settings.guides = [{ axis: 'x', pos: 10 }]; }), expect: async h => req((await setting('guides')(h)).length === 0, 'guides kept') },
  { id: 'view.addGuide', change: false, drive: DLG({ a: 'y', p: '100' }), expect: async h => req(JSON.stringify(await setting('guides')(h)) === JSON.stringify([{ axis: 'y', pos: 100 }]), 'guide not added') },
  ...['pieces', 'sizes', 'inspector'].map(k => ({ id: 'view.panel.' + k, change: false, sel: async h => { h._v0 = await h.ev(k => window.__e2e.settings.panels[k], k); }, expect: async h => req((await h.ev(k => window.__e2e.settings.panels[k], k)) === !h._v0, 'panel not toggled') })),
  ...[['mm', 'mm', 16], ['cm', 'cm', 16], ['in', 'in', 0], ['in8', 'in', 8], ['in16', 'in', 16], ['in32', 'in', 32]].map(([k, u, d]) => ({ id: 'view.unit.' + k, change: false, sel: h => h.ev(() => { window.__e2e.settings.unit = 'cm'; if (true) window.__e2e.settings.fracDen = 64; }), expect: async h => { const s = await h.ev(() => [window.__e2e.settings.unit, window.__e2e.settings.fracDen]); return req(s[0] === u && (u !== 'in' || s[1] === d), 'unit ' + s); } })),

  // ═════════ Help ═════════
  { id: 'help.keys', change: false, drive: OK() },
  { id: 'help.ops', change: false, drive: async h => { await h.waitDialog(); h._m = await h.dlg().locator('.dlg-msg').textContent(); await h.ok(); }, expect: h => req(/ 0 placeholder/.test(h._m || ''), 'placeholders remain: ' + (h._m || '').slice(0, 120)) },
  { id: 'help.about', change: false, drive: OK() },
];

module.exports = { cases, pre, P, addInternal, YOKE, A, AA, PC, DLG, OK, W, seq, at, seg };
