// Playwright harness for the ProwdCAD v2 e2e suite.
// Drives the real app (Vite dev server → the command registry and ops bridge are reachable as ES
// modules for observation) the way a user does: menubar clicks through flyouts, canvas clicks at
// world positions, dialog fields, hotkeys. See scripts/e2e/README in docs/E2E-REPORT.md.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const VIEW = { width: 1440, height: 900 };
const HELPERS = fs.readFileSync(path.join(__dirname, 'page-helpers.js'), 'utf8');

class Harness {
  constructor(url) { this.url = url; this.pageErrors = []; this.consoleErrors = []; this.navigations = []; this.stats = { secondClick: new Set() }; }

  async open() {
    this.browser = await chromium.launch();
    this.ctx = await this.browser.newContext({ viewport: VIEW, acceptDownloads: true });
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', e => this.pageErrors.push(String(e.message || e)));
    this.page.on('console', m => { if (m.type() === 'error') this.consoleErrors.push(m.text()); });
    this.page.on('dialog', d => { this.pageErrors.push('native dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    await this.page.addInitScript(() => { try { localStorage.clear(); } catch { /* */ } });
    await this.page.goto(this.url);
    this.page.on('framenavigated', fr => { if (fr === this.page.mainFrame()) this.navigations.push({ url: fr.url(), at: this.currentCase || '?' }); });
    await this.page.waitForFunction(() => !!window.prowdcad && document.querySelectorAll('.menu-root').length > 5, null, { timeout: 20000 });
    await this.page.waitForTimeout(300);
    await this.page.evaluate(HELPERS);
    await this.page.waitForFunction(() => !!window.__e2e, null, { timeout: 10000 });
  }
  /** re-inject the observation helpers after an unexpected page navigation (reported) */
  async ensureHelpers() {
    if (await this.page.evaluate(() => !!window.__e2e).catch(() => false)) return false;
    await this.page.waitForFunction(() => !!window.prowdcad && document.querySelectorAll('.menu-root').length > 5, null, { timeout: 20000 });
    await this.page.evaluate(HELPERS);
    await this.page.waitForFunction(() => !!window.__e2e, null, { timeout: 10000 });
    return true;
  }
  async close() { await this.browser?.close(); }

  // ───── low level ─────
  ev(fn, arg) { return this.page.evaluate(fn, arg); }
  async settle(ms = 30) { await this.page.evaluate(() => window.__e2e.flush()); if (ms) await this.page.waitForTimeout(ms); }
  async blur() { await this.ev(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); }); }
  async key(chord) { await this.blur(); await this.page.keyboard.press(chord); await this.settle(40); }
  async toClient(w) { return this.ev(w => window.__e2e.toClient(w), w); }
  async W(piece, anchor, sid) { return this.ev(([p, a, s]) => window.__e2e.W(p, a, s), [piece, anchor, sid]); }
  async along(piece, a, b, t = 0.5) { return this.ev(([p, x, y, t]) => window.__e2e.along(p, x, y, t), [piece, a, b, t]); }
  async local2world(piece, v) { return this.ev(([p, v]) => window.__e2e.localToWorld(p, v), [piece, v]); }

  async withMods(mods, fn) { for (const m of mods) await this.page.keyboard.down(m); try { await fn(); } finally { for (const m of mods.slice().reverse()) await this.page.keyboard.up(m); } }
  /** click at a world point (mm, y-up) */
  async clickW(w, opt = {}) {
    const c = await this.toClient(w);
    await this.withMods(opt.mods || [], async () => {
      await this.page.mouse.move(c.x, c.y);
      await this.page.mouse.click(c.x, c.y, { button: opt.button || 'left', clickCount: 1 });
    });
    await this.settle(opt.settle ?? 40);
  }
  async dblW(w) { const c = await this.toClient(w); await this.page.mouse.move(c.x, c.y); await this.page.mouse.click(c.x, c.y); await this.page.waitForTimeout(60); await this.page.mouse.click(c.x, c.y); await this.settle(40); }
  async clickA(piece, anchor, opt) { return this.clickW(await this.W(piece, anchor), opt); }
  async clickSeg(piece, a, b, t = 0.5, opt) { return this.clickW(await this.along(piece, a, b, t), opt); }
  async clickLocal(piece, v, opt) { return this.clickW(await this.local2world(piece, v), opt); }
  /** drag in world coords with intermediate moves */
  async dragW(a, b, opt = {}) {
    const ca = await this.toClient(a), cb = await this.toClient(b);
    await this.withMods(opt.mods || [], async () => {
      await this.page.mouse.move(ca.x, ca.y); await this.page.mouse.down();
      const n = opt.steps ?? 8;
      for (let i = 1; i <= n; i++) await this.page.mouse.move(ca.x + (cb.x - ca.x) * i / n, ca.y + (cb.y - ca.y) * i / n);
      if (opt.beforeUp) await opt.beforeUp();
      await this.page.mouse.up();
    });
    await this.settle(50);
  }

  // ───── menus ─────
  async openMenu(root) {
    if (await this.page.locator('.menu-root.open').count()) { await this.page.keyboard.press('Escape'); await this.page.mouse.click(700, 880); await this.settle(20); }
    const btn = this.page.locator(`.menu-root[data-menu="${root}"] > .menu-btn`);
    await btn.click();
    await this.page.waitForSelector(`.menu-root.open[data-menu="${root}"] > .menu-drop`, { timeout: 2000 });
  }
  /** Click a menu item: path 'Grade/Clipboard', title 'Copy grade'. Returns {disabled}. */
  async menu(menuPath, title) {
    const parts = menuPath.split('/');
    await this.openMenu(parts[0]);
    let drop = this.page.locator(`.menu-root.open[data-menu="${parts[0]}"] > .menu-drop`);
    for (const sub of parts.slice(1)) {
      const s = drop.locator(':scope > .menu-sub').filter({ has: this.page.locator(':scope > .menu-item .mlabel', { hasText: new RegExp('^' + esc(sub) + '$') }) }).first();
      await s.locator(':scope > .menu-item').hover();
      drop = s.locator(':scope > .menu-drop');
      await drop.waitFor({ state: 'visible', timeout: 2000 });
    }
    const item = drop.locator(':scope > .menu-item').filter({ has: this.page.locator('.mlabel', { hasText: new RegExp('^\\s*' + esc(title) + '\\s*$') }) }).first();
    if (!(await item.count())) throw new Error(`menu item not found: ${menuPath} ▸ ${title}`);
    const disabled = await item.evaluate(el => el.classList.contains('disabled'));
    if (disabled) { // pointer-events:none — a user's click does nothing; close the menu
      await this.page.locator(`.menu-root[data-menu="${parts[0]}"] > .menu-btn`).click();
      await this.settle(30);
      return { disabled };
    }
    await item.hover();
    await item.click();
    await this.settle(60);
    return { disabled };
  }
  async meta(id) { return this.ev(id => { const c = window.__e2e.C.getCommand(id); return c ? { id: c.id, title: c.title, menu: c.menu || '', hotkey: c.hotkey || '', enabled: window.__e2e.C.isEnabled(c), checked: window.__e2e.C.isChecked(c) } : null; }, id); }
  async allCommands() { return this.ev(() => window.__e2e.C.allCommands().map(c => ({ id: c.id, title: c.title, menu: c.menu || '', hotkey: c.hotkey || '' }))); }
  /** run a command the way a user would: its menu item, else its first hotkey */
  async cmd(id) {
    const m = await this.meta(id);
    if (!m) throw new Error('unknown command ' + id);
    if (m.menu) return this.menu(m.menu, m.title);
    if (m.hotkey) { await this.key(toPlaywrightChord(m.hotkey.split(',')[0])); return { disabled: !m.enabled }; }
    await this.ev(id => window.__e2e.C.runCommand(id), id); await this.settle();
    return { disabled: !m.enabled };
  }

  // ───── dialogs ─────
  dlg() { return this.page.locator('.dlg').last(); }
  async hasDialog() { return (await this.page.locator('.dlg-overlay').count()) > 0; }
  async dlgTitle() { return (await this.hasDialog()) ? (await this.dlg().locator('.dlg-title').textContent()) : null; }
  async waitDialog(ms = 2000) { await this.page.waitForSelector('.dlg-overlay .dlg', { timeout: ms }); await this.page.waitForTimeout(40); }
  async fill(key, value) {
    await this.waitDialog();
    const el = this.dlg().locator(`[data-key="${key}"]`).first();
    const tag = await el.evaluate(e => e.tagName + ':' + (e.getAttribute('type') || '') + ':' + e.className);
    if (tag.startsWith('SELECT')) { await el.selectOption(String(value)); return; }
    if (tag.startsWith('DIV')) { await el.locator(`input[value="${value}"]`).check(); return; }
    if (tag.includes(':checkbox:')) { if ((await el.isChecked()) !== !!value) await el.click(); return; }
    await el.click({ clickCount: 3 }); await el.fill(String(value));
  }
  async fields(obj) { for (const [k, v] of Object.entries(obj)) await this.fill(k, v); }
  async ok() { await this.waitDialog(); await this.dlg().locator('.dlg-foot .btn.primary').click(); await this.settle(60); }
  async dlgButton(label) { await this.waitDialog(); await this.dlg().locator('.dlg-foot .btn', { hasText: label }).first().click(); await this.settle(60); }
  async cancel() { if (await this.hasDialog()) { await this.dlg().locator('.dlg-foot .btn', { hasText: /^Cancel$/ }).first().click(); await this.settle(); } }
  async dlgError() { return this.hasDialog().then(h => h ? this.dlg().locator('.dlg-err').textContent() : ''); }
  async okThrough(max = 4) { for (let i = 0; i < max && (await this.hasDialog()); i++) await this.ok(); }

  // ───── selection helpers (via clicks with the Select tool) ─────
  async tool(id) { await this.ev(id => window.__e2e.app.setTool(id), id); await this.settle(); }
  /** click a point with the Select tool; a curve point of an unselected piece has no hit target
   *  (only grade points are drawn on unselected pieces), so a user needs a second click — counted. */
  async selectA(piece, anchor, add = false) {
    await this.ensureSelect();
    const isSel = () => this.ev(([p, a]) => { const E = window.__e2e; const id = E.findA(p, a).a.id; return E.app.sel.anchors.some(r => r.anchorId === id); }, [piece, anchor]);
    await this.clickA(piece, anchor, { mods: add ? ['Shift'] : [] });
    if (!(await isSel())) { this.stats.secondClick.add(`${piece}/${anchor}`); await this.page.waitForTimeout(450); await this.clickA(piece, anchor, { mods: add ? ['Shift'] : [] }); }
    if (!(await isSel())) throw new Error(`could not select point ${piece}/${anchor} by clicking`);
  }
  async selectPiece(piece, add = false) {
    await this.ensureSelect();
    // click inside the piece away from anchors / lines: piece-local interior point
    const pt = await this.ev(p => { const pc = window.__e2e.P(p); const xs = pc.sew.points.map(a => a.x), ys = pc.sew.points.map(a => a.y); return window.__e2e.localToWorld(p, { x: (Math.min(...xs) * 0.62 + Math.max(...xs) * 0.38), y: (Math.min(...ys) * 0.7 + Math.max(...ys) * 0.3) }); }, piece);
    await this.clickW(pt, { mods: add ? ['Shift'] : [] });
  }
  async ensureSelect() { const t = await this.ev(() => window.__e2e.app.tool.id); if (t !== 'select') await this.tool('select'); }
  async sel() { return this.ev(() => window.__e2e.sel()); }
  async state() { return JSON.parse(await this.ev(() => window.__e2e.stable())); }
  async stable() { return this.ev(() => window.__e2e.stable()); }
  async idle() { return this.ev(() => window.__e2e.idle()); }
  async waitIdle(ms = 2500) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await this.idle()) return true; await this.page.waitForTimeout(50); }
    return false;
  }
  async escapeAll() {
    for (let i = 0; i < 6; i++) {
      if (await this.idle()) break;
      if (await this.hasDialog()) await this.cancel().catch(() => {});
      await this.page.keyboard.press('Escape'); await this.page.waitForTimeout(40);
    }
  }
  async rec() { return this.ev(() => ({ toasts: window.__e2e.toasts.slice(), dialogs: window.__e2e.dialogs.slice(), statuses: window.__e2e.statuses.slice(), invoked: window.__e2e.invoked.slice() })); }
  async downloads() { await this.ev(() => window.__e2e._dl); return this.ev(() => window.__e2e.downloads.slice()); }
  async reset(json) { await this.ev(j => window.__e2e.reset(j), json); await this.settle(30); }
  async shot(name) { const d = path.join(__dirname, '..', 'out', 'shots'); fs.mkdirSync(d, { recursive: true }); await this.page.screenshot({ path: path.join(d, name.replace(/[^\w.-]+/g, '_') + '.png') }); }
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** registry chord ("Ctrl+Alt+Shift+C", "Ctrl+'") → Playwright chord */
function toPlaywrightChord(ch) {
  let c = ch.trim();
  let key;
  if (c === '+' || c.endsWith('++')) { key = '+'; c = c.slice(0, -1).replace(/\+$/, ''); } else { const p = c.split('+'); key = p.pop(); c = p.join('+'); }
  const mods = c ? c.split('+').map(m => ({ ctrl: 'Control', alt: 'Alt', shift: 'Shift', cmd: 'Control', meta: 'Control' }[m.toLowerCase()] || m)) : [];
  if (key.length === 1 && /[a-z]/i.test(key)) key = mods.includes('Shift') ? key.toUpperCase() : key.toLowerCase();
  if (key === 'Esc') key = 'Escape';
  if (key === 'Del') key = 'Delete';
  return [...mods, key].join('+');
}

module.exports = { Harness, toPlaywrightChord };
