// Smoke test of the single-file build (dist/prowdcad-v2.html over file://): loads without errors,
// the menubar offers every registry command that has a menu, a short draft + real PDF download works.
// Build it first with `npm run build:single` (this suite does not rebuild it).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function single(ROOT, registry) {
  const file = path.join(ROOT, 'dist/prowdcad-v2.html');
  if (!fs.existsSync(file)) return { skipped: 'dist/prowdcad-v2.html missing — run npm run build:single' };
  const out = { file: path.relative(ROOT, file), mtime: fs.statSync(file).mtime.toISOString(), errors: [] };
  const b = await chromium.launch();
  try {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage();
    p.on('pageerror', e => out.errors.push(String(e.message)));
    p.on('console', m => { if (m.type() === 'error') out.errors.push('console: ' + m.text()); });
    await p.goto('file://' + file);
    await p.waitForFunction(() => !!window.prowdcad && document.querySelectorAll('.menu-root').length > 5, null, { timeout: 15000 });
    // walk the menubar DOM (drops are built on open)
    const menus = await p.$$eval('.menu-root', els => els.map(e => e.dataset.menu));
    let items = 0; const titles = [];
    for (const m of menus) {
      await p.locator(`.menu-root[data-menu="${m}"] > .menu-btn`).click();
      const t = await p.$$eval(`.menu-root[data-menu="${m}"] .menu-drop .menu-item`, els => els.filter(e => !e.parentElement.classList.contains('menu-sub')).map(e => e.querySelector('.mlabel')?.textContent ?? ''));
      items += t.length; titles.push(...t);
      await p.locator(`.menu-root[data-menu="${m}"] > .menu-btn`).click();
    }
    out.menus = menus; out.menuItems = items; out.registryMenuCommands = registry.filter(c => c.menu).length;
    out.missingFromMenubar = registry.filter(c => c.menu && !titles.includes(c.title)).map(c => c.id);
    // tiny flow: pen triangle, then File ▸ Export ▸ PDF with a real browser download
    await p.keyboard.press('p');
    const box = await p.locator('svg.sheet').boundingBox();
    for (const [x, y] of [[0.3, 0.7], [0.5, 0.7], [0.4, 0.4], [0.3, 0.7]]) await p.mouse.click(box.x + box.width * x, box.y + box.height * y);
    await p.waitForSelector('.dlg'); await p.locator('.dlg .btn.primary').click();
    out.piecesAfterPen = await p.evaluate(() => window.prowdcad.app.doc.style.pieces.length);
    const dl = p.waitForEvent('download', { timeout: 8000 });
    await p.keyboard.press('Control+p'); await p.waitForSelector('.dlg'); await p.locator('.dlg .btn.primary').click();
    const d = await dl; const tmp = path.join(require('os').tmpdir(), 'e2e-single.pdf'); await d.saveAs(tmp);
    const head = fs.readFileSync(tmp).subarray(0, 5).toString();
    out.pdfDownload = { name: d.suggestedFilename(), bytes: fs.statSync(tmp).size, header: head };
    out.pass = !out.errors.length && head === '%PDF-' && out.piecesAfterPen === 2 && !out.missingFromMenubar.length;
  } catch (e) { out.error = String(e.message || e).split('\n')[0]; out.pass = false; }
  await b.close();
  process.stdout.write(`single-file: ${JSON.stringify(out).slice(0, 400)}\n`);
  return out;
}
module.exports = { single };
