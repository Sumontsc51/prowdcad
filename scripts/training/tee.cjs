// Training video: drafting a basic T-shirt in ProwdCAD v2.
const { Rec } = require('./lib.cjs');
const path = require('path');
const HERE = __dirname;
const APP = 'file://' + require('path').resolve(__dirname, '../../dist/prowdcad-v2.html');
const STOP = process.env.STOP || 'end';

// Front half (CF at x=0), base size M, mm, y-up. Curve points are Ctrl+clicked.
const FRONT = [
  [0, 0], [260, 0], [260, 465],
  [222, 545, 'c'], [205, 618, 'c'],
  [200, 680], [85, 712],
  [70, 664, 'c'], [32, 625, 'c'],
  [0, 622],
];
// Sleeve (full), centred on x = SX
const SX = 1160;
const SLEEVE = [
  [SX - 165, 0], [SX + 165, 0], [SX + 192, 190],
  [SX + 120, 268, 'c'], [SX + 48, 320, 'c'], [SX, 330, 'c'], [SX - 48, 320, 'c'], [SX - 120, 268, 'c'],
  [SX - 192, 190],
];

(async () => {
  const r = new Rec(path.join(HERE, 'frames'));
  await r.open(APP);
  const P = r.page;
  const at = async (name) => { if (process.env.DRY) console.log(name, JSON.stringify(await P.evaluate(() => { const { app } = window.prowdcad; return app.doc.style.pieces.map(p => p.name + ':' + p.sew.points.filter(a => Object.values(a.grade||{}).some(g => g.dx||g.dy)).map(a => `(${a.x},${a.y})`).join('')); }))); if (process.env.DRY) await r.snap('dbg-' + name); if (STOP === name) { console.log('stop at', name, 'sec', r.seconds().toFixed(1), 'errors', JSON.stringify(r.errors)); await r.browser.close(); process.exit(0); } };

  // ── Title ──
  await r.card(`<div class="k">PROWDCAD · TRAINING 01</div><h1>Drafting a basic T-shirt</h1><p>Front, back and sleeve — seams, notches, grading S–2XL and a 1:1 PDF, start to finish.</p>`, 4.5);
  await r.card(`<div class="k">WHAT YOU WILL DO</div><h1>9 steps · about 3 minutes</h1><ul><li>1 · New style with a size range</li><li>2 · Draft the front half with the Pen tool</li><li>3 · Centre-front fold as a half piece</li><li>4 · Seam allowance: 10 mm, 25 mm hem</li><li>5 · Armhole notch</li><li>6 · Grade the front, check the nest</li><li>7 · Back from the front</li><li>8 · Sleeve, graded with Smart paste</li><li>9 · Check, save and export a 1:1 PDF</li></ul>`, 7);
  await r.card('', 0);
  await r.setCursor(720, 400);
  await r.caption('This is the ProwdCAD design workspace.', 'Menus on top · tools on the left · pieces, sizes and Inspector on the right.', 4);

  // ── 1. New style ──
  await r.stepBadge('STEP 1 · NEW STYLE');
  await r.caption('Step 1 — start a new style.', 'File ▸ New. Type the size range and the base size.', 0);
  await r.menu('File', 'New');
  if (await P.locator('.dlg-title', { hasText: 'New style' }).count() === 0) { await r.dlgOk(); } // discard confirm
  await r.dlgField('name', 'BASIC TEE');
  await r.dlgField('sizes', 'S, M, L, XL, 2XL');
  await r.dlgField('base', 'M');
  await r.dlgCheck('block', false);
  await r.wait(0.8);
  await r.dlgOk();
  // frame the drafting area (front −280…280, back 380…900 later via layout, sleeve 860…1260)
  await r.eval(() => { const { app } = window.prowdcad; const v = app.view; v.cx = 540; v.cy = 340; v.scale = Math.min(v.W / 1760, v.H / 900); app.invalidate(); });
  await r.caption('An empty sheet, sizes S–2XL, base size M.', 'All values are in millimetres — inch with fractions is one click away in the status bar.', 3.2);
  await at('new');

  // ── 2. Front with pen ──
  await r.stepBadge('STEP 2 · DRAFT THE FRONT');
  await r.caption('Step 2 — draft the front half with the Pen tool (P).', 'Click = corner point. Ctrl+click = curve point. Click the first point again to close.', 0);
  await r.key('p', 'P', 10);
  for (let i = 0; i < FRONT.length; i++) {
    const [x, y, c] = FRONT[i];
    if (i === 0) await r.caption('Centre-front hem → side hem → underarm…', '', 0);
    if (i === 3) await r.caption('Armhole: two Ctrl+clicks make a smooth curve.', 'Curve points sit between grade points and follow the grading automatically.', 0);
    if (i === 5) await r.caption('Shoulder point → neck point (HPS).', '', 0);
    if (i === 7) await r.caption('Front neckline: two more curve points, then centre-front neck.', '', 0);
    await r.clickW(x, y, { mods: c ? ['Control'] : [] });
  }
  await r.caption('Click the first point to close the outline.', '', 0);
  await r.clickW(0, 0);
  await r.wait(0.5);
  await r.caption('Name the piece and set the default seam allowance.', '', 0);
  await r.dlgField('name', 'FRONT');
  await r.dlgField('seam', '10');
  await r.dlgOk();
  await r.key('v', 'V', 6);
  await r.caption('FRONT is created: sew line (bold) and a cut line 10 mm outside it.', 'The cut line is always derived from the sew line — edit the sew line, the cut line follows.', 3.6);
  await at('front');

  // ── 3. Half piece ──
  await r.stepBadge('STEP 3 · CENTRE-FRONT FOLD');
  await r.caption('Step 3 — the front is cut on the fold.', 'Cut ▸ Half piece ▸ Set mirror axis, then click centre-front hem and centre-front neck.', 0);
  await r.menu('Cut', 'Half piece', 'set mirror axis');
  await r.clickW(0, 0);
  await r.clickW(0, 622);
  await r.wait(0.4);
  await r.dlgOk();
  await r.caption('Now you edit one half — the other half mirrors live.', 'No seam on the fold edge. Plot, PDF and marker open it to the full piece automatically.', 4);
  await at('half');


  const insp = (label) => `xpath=//*[normalize-space(text())="${label}"]/following-sibling::*[1]/descendant-or-self::input[1]`;
  const grCell = (sizeIdx, axis) => P.locator('table.gr tr.sel input.num').nth(sizeIdx * 2 + (axis === 'y' ? 1 : 0));
  const typeCell = async (loc, val) => {
    const b = await loc.boundingBox(); await r.moveTo(b.x + b.width / 2, b.y + b.height / 2);
    await loc.click(); await P.waitForTimeout(60); await P.keyboard.press('Control+A');
    for (const ch of String(val)) { await P.keyboard.type(ch); await r.shot(2); }
    await P.keyboard.press('Enter'); await P.waitForTimeout(100); await r.shot(8);
  };
  const selectPointW = async (x, y, shift = false) => { await r.clickW(x, y, { mods: shift ? ['Shift'] : [] }); };

  // ── 4. Seams ──
  await r.stepBadge('STEP 4 · SEAM ALLOWANCE');
  await r.caption('Step 4 — the hem needs 25 mm instead of 10.', 'Seam tool (S): click the first point of the run, then the last one.', 0);
  await r.key('s', 'S', 8);
  await r.clickW(0, 0);
  await r.clickW(260, 0);
  await r.wait(0.4);
  await r.dlgField('v', '25');
  await r.wait(0.5);
  await r.dlgOk();
  await r.key('v', 'V', 6);
  await r.caption('Hem allowance 25 mm — the cut line regenerates instantly.', 'Corners are engineered automatically; Seam ▸ Corner type lets you choose miter, boxed, turn-back or a manual corner.', 4);
  await at('seam');

  // ── 5. Notch ──
  await r.stepBadge('STEP 5 · NOTCHES');
  await r.caption('Step 5 — a front armhole notch.', 'Notch tool (N): click the sew line. Single notch = front, by trade convention.', 0);
  await r.key('n', 'N', 8);
  await r.clickW(214, 590);
  await r.wait(0.5);
  await r.caption('Placement: from previous point, a fixed distance, a percentage, or on a point.', 'Floating notches keep their distance — or their percentage — when the seam changes length.', 0);
  await r.wait(2.2);
  await r.dlgOk();
  await r.key('v', 'V', 6);
  await r.wait(1.2);
  await at('notch');

  // ── 6. Grading ──
  await r.stepBadge('STEP 6 · GRADING');
  await r.caption('Step 6 — grade the front. Open the grading table (Ctrl+G).', 'Rows are grade points, columns are sizes. Values are the step from the previous size.', 0);
  await r.capTop(true);
  await r.key('Control+g', 'Ctrl+G', 4);
  await r.frameW(-320, -60, 760, 770); await r.shot(16);
  await r.caption('Select the underarm point: +12.5 mm wider and +6 mm longer per size.', 'Type in the M column (the S → M step), then Equal X / Equal Y copy it to every size.', 0);
  await selectPointW(260, 465);
  await at('gr0');
  await typeCell(grCell(1, 'x'), '12.5');
  await typeCell(grCell(1, 'y'), '6');
  await r.menu('Grade', 'Edit', 'Equal X');
  await r.menu('Grade', 'Edit', 'Equal Y');
  await r.wait(1.2);
  await at('grade1');
  await r.caption('Side hem gets the same width step: Copy grade → Paste X only.', 'Grade ▸ Clipboard (Ctrl+Alt+C / Ctrl+Alt+X).', 0);
  await r.menu('Grade', 'Clipboard', 'Copy grade');
  await selectPointW(260, 0);
  await r.menu('Grade', 'Clipboard', 'Paste X only');
  await at('px');
  await r.wait(1);
  await r.caption('Shoulder point: +9 mm across, +12 mm up.', '', 0);
  await selectPointW(200, 680);
  await at('gr1');
  await typeCell(grCell(1, 'x'), '9');
  await typeCell(grCell(1, 'y'), '12');
  await r.menu('Grade', 'Edit', 'Equal X');
  await r.menu('Grade', 'Edit', 'Equal Y');
  await r.caption('Neck point and centre-front neck rise the same 12 mm: Paste Y only.', 'Shift+click adds points to the selection.', 0);
  await r.menu('Grade', 'Clipboard', 'Copy grade');
  await selectPointW(85, 712);
  await selectPointW(0, 622, true);
  await r.menu('Grade', 'Clipboard', 'Paste Y only');
  await r.wait(0.8);
  await r.caption('Tick Nested view to see every size at once.', 'Each size has its own colour; the base size is drawn bold.', 0);
  { const cb = P.locator('label', { hasText: 'Nested view' }).locator('input').first(); const b = await cb.boundingBox(); await r.click(b.x + b.width / 2, b.y + b.height / 2, { after: 10 }); }
  await r.key('Control+g', 'Ctrl+G', 4);
  await r.capTop(false);
  await r.frameW(-330, -80, 760, 820); await r.shot(8);
  await r.caption('A clean graded nest S → 2XL — curve points followed on their own.', 'Armhole and neckline curves interpolate between graded points: no hand-grading of curves.', 4.2);
  await at('nest');

  // ── 7. Back from front ──
  await r.stepBadge('STEP 7 · BACK');
  await r.caption('Step 7 — the back starts as a copy of the front, grading included.', 'Edit ▸ Duplicate piece (Ctrl+D), then rename it in the Inspector.', 0);
  await r.frameW(-320, -80, 1000, 820); await r.shot(4);
  await r.clickW(130, 300);
  await r.key('Control+d', 'Ctrl+D', 14);
  await typeCell(P.locator(insp('Name')).first(), 'BACK');
  await typeCell(P.locator(insp('Position X')).first(), '620');
  await r.eval(() => { window.prowdcad.app.invalidate(); });
  await r.wait(0.6);
  await r.caption('The back neck is higher: move centre-back neck up 55 mm.', 'Point ▸ Move proportional blends the neck curve with the move.', 0);
  await selectPointW(620, 622);
  await r.menu('Point', 'Move proportional');
  await r.dlgField('dy', '55');
  await r.wait(0.4);
  await r.dlgOk();
  await r.wait(1.5);
  await at('back');

  // ── 8. Sleeve ──
  await r.stepBadge('STEP 8 · SLEEVE');
  await r.caption('Step 8 — the sleeve, drawn whole with the Pen tool.', 'Hem, underarms, and a smooth cap from five curve points.', 0);
  await r.frameW(-320, -60, 1420, 800); await r.shot(8);
  await r.key('p', 'P', 8);
  for (let i = 0; i < SLEEVE.length; i++) { const [x, y, c] = SLEEVE[i]; await r.clickW(x, y, { mods: c ? ['Control'] : [] }); }
  await r.clickW(SLEEVE[0][0], SLEEVE[0][1]);
  await r.wait(0.4);
  await r.dlgField('name', 'SLEEVE');
  await r.dlgField('seam', '10');
  await r.dlgOk();
  await r.key('s', 'S', 6);
  await r.clickW(SX - 165, 0);
  await r.clickW(SX + 165, 0);
  await r.dlgField('v', '25');
  await r.dlgOk();
  await r.key('v', 'V', 6);
  await r.caption('Grade the right underarm: +8 mm wider, +4 mm per size.', '', 0);
  await r.capTop(true);
  await r.key('Control+g', 'Ctrl+G', 4);
  await r.frameW(SX - 480, -60, SX + 480, 560); await r.shot(10);
  await selectPointW(SX + 192, 190);
  await typeCell(grCell(1, 'x'), '8');
  await typeCell(grCell(1, 'y'), '4');
  await r.menu('Grade', 'Edit', 'Equal X');
  await r.menu('Grade', 'Edit', 'Equal Y');
  await r.caption('Left underarm: Smart paste flips X automatically for the mirror side.', 'Grade ▸ Clipboard ▸ Smart paste (Ctrl+Alt+M) — no sign juggling.', 0);
  await r.menu('Grade', 'Clipboard', 'Copy grade');
  await selectPointW(SX - 192, 190);
  await r.menu('Grade', 'Clipboard', 'Smart paste');
  await r.wait(1.6);
  await at('sleeve');
  await r.key('Control+g', 'Ctrl+G', 4);
  await r.capTop(false);
  await r.frameW(-320, -80, 1400, 820); await r.shot(8);
  await r.caption('Cap notch at the shoulder point (N).', '', 0);
  await r.key('n', 'N', 6);
  await r.clickW(SX, 330);
  await r.wait(0.4);
  await r.dlgOk();
  await r.key('v', 'V', 6);
  await r.eval(() => { const { app } = window.prowdcad; app.sel = { pieces: [], anchors: [] }; app.invalidate(); });
  await r.caption('Front, back and sleeve — graded S to 2XL.', '', 3.4);
  await at('all');

  // ── 9. Check & output ──
  await r.stepBadge('STEP 9 · CHECK & OUTPUT');
  await r.caption('Step 9 — check lengths and areas for every size: Measure ▸ Piece info (Ctrl+I).', '', 0);
  await r.clickW(SX, 120);
  await r.key('Control+i', 'Ctrl+I', 10);
  await r.wait(3.6);
  await at('info');
  { const x = P.locator('.fw-x').last(); const b = await x.boundingBox(); await r.click(b.x + b.width / 2, b.y + b.height / 2, { after: 8 }); }
  await r.caption('Save any time with File ▸ Save (Ctrl+S) — the whole style is one .prowd.json file.', 'Auto-backup runs every 30 s and offers recovery after a crash.', 3.6);
  await r.clickW(1250, 700);
  await r.caption('Export a tiled 1:1 PDF: File ▸ Export ▸ PDF (Ctrl+P).', 'Choose paper, overlap and sizes. Registration crosses and page labels are added for taping.', 0);
  await r.menu('File', 'Export', 'PDF');
  await r.dlgSelect('pieces', 'all');
  await r.dlgSelect('sizes', 'all');
  await r.wait(1.6);
  await at('pdfdlg');
  await r.dlgOk();
  await r.wait(1.2);
  // show the produced PDF
  await P.waitForTimeout(800);
  const fsx = require('fs'); const { execFileSync } = require('child_process');
  console.log('sel', JSON.stringify(await P.evaluate(() => window.prowdcad.app.sel)), 'toast', await P.evaluate(() => [...document.querySelectorAll('.toast, [class*=toast]')].map(e => e.textContent).join(' | ')));
  console.log('downloads', r.downloads.map(d => d.suggestedFilename())); await require('fs').promises.writeFile(path.join(HERE, 'style.json'), await P.evaluate(() => JSON.stringify(window.prowdcad.app.doc.style)));
  const pdfDl = r.downloads.find(d => /\.pdf$/i.test(d.suggestedFilename()));
  let pages = '';
  if (pdfDl) {
    const pdf = path.join(HERE, 'out.pdf'); await pdfDl.saveAs(pdf);
    execFileSync('pdftoppm', ['-r', '22', '-thinlinemode', 'solid', '-png', pdf, path.join(HERE, 'pg')]);
    const pngs = fsx.readdirSync(HERE).filter(f => /^pg-\d+\.png$/.test(f)).sort();
    pages = pngs.map(f => `<img src="data:image/png;base64,${fsx.readFileSync(path.join(HERE, f)).toString('base64')}" style="height:76px;margin:0;border-radius:4px;box-shadow:0 8px 30px rgba(0,0,0,.5);background:#fff">`).join('');
    const info = execFileSync('pdfinfo', [pdf]).toString(); console.log((info.match(/Pages:.*|Page size:.*/g) || []).join(' | '));
  }
  await r.caption('', '', 0);
  await r.stepBadge('');
  await r.card(`<div style="display:flex;gap:56px;align-items:center"><div style="display:grid;grid-template-columns:repeat(4,auto);gap:3px">${pages}</div><div style="text-align:left;max-width:560px"><div class="k">RESULT</div><h1 style="font-size:46px">Tiled PDF, exactly 1:1</h1><p>All three pieces, all five sizes nested, on A4: a 4 × 8 page grid.</p><p style="margin-top:14px">Every page has registration crosses, a 10 mm glue overlap, A1/B2 labels — and a 100 mm calibration square on the first page to check your printer.</p></div></div>`, 6.5);
  await r.card(`<div class="k">RECAP</div><h1>Basic T-shirt — done</h1><ul><li>Pen tool: Click = corner, Ctrl+click = curve point</li><li>Half piece: edit one side, the fold mirrors live</li><li>Seam tool (S): first point → last point → value</li><li>Grading table (Ctrl+G) + Equal X/Y, Copy / Paste X / Paste Y / Smart paste</li><li>Nested view shows every size; Piece info checks lengths</li><li>Export: DXF + RUL · SVG · PLT · tiled 1:1 PDF</li></ul><p style="margin-top:26px;color:#8fb8ff">Next: Training 02 — darts, walking seams and the seam check</p>`, 7);

  console.log('done', r.seconds().toFixed(1), 'errors', JSON.stringify(r.errors));
  await r.finish(path.join(HERE, 'tee.mp4'));
})().catch(e => { console.error(e); process.exit(1); });
