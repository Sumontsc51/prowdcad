// Frame recorder for ProwdCAD training videos.
// Drives the real app (single-file build) with Playwright; captures JPEG frames with holds.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const FPS = 30;
const VIEW = { width: 1440, height: 810 };
const DSF = 4 / 3; // → 1920×1080 frames

const OVERLAY_CSS = `
#rec-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px)}
#rec-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #ff6a2b;z-index:2147483646;pointer-events:none;opacity:0}
#rec-cap{position:fixed;left:50%;bottom:60px;transform:translateX(-50%);max-width:78%;z-index:2147483645;pointer-events:none;
  background:rgba(14,16,22,.92);color:#fff;font:600 19px/1.35 Inter,system-ui,sans-serif;padding:12px 22px;border-radius:10px;
  border-left:5px solid #ff6a2b;box-shadow:0 8px 30px rgba(0,0,0,.35);opacity:0;transition:none}
#rec-cap small{display:block;font-weight:500;font-size:14.5px;color:#b9c3d6;margin-top:3px}
#rec-step{position:fixed;left:96px;top:58px;z-index:2147483645;pointer-events:none;background:#ff6a2b;color:#fff;
  font:700 13px/1 Inter,system-ui,sans-serif;padding:7px 11px;border-radius:6px;letter-spacing:.04em;opacity:0}
#rec-keys{position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:2147483645;pointer-events:none;display:flex;gap:6px;opacity:0}
#rec-keys kbd{background:#fff;color:#111;font:700 17px/1 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:7px;border-bottom:3px solid #aaa;box-shadow:0 4px 14px rgba(0,0,0,.3)}
#rec-card{position:fixed;inset:0;z-index:2147483640;display:none;align-items:center;justify-content:center;flex-direction:column;
  background:radial-gradient(1200px 700px at 30% 20%,#23324f 0,#12151d 60%);color:#fff;font-family:Inter,system-ui,sans-serif;text-align:center}
#rec-card .k{font:800 15px/1 Inter,system-ui;letter-spacing:.3em;color:#4ea1ff;margin-bottom:22px}
#rec-card h1{font:800 64px/1.05 Inter,system-ui;margin:0 0 18px;letter-spacing:-.02em}
#rec-card p{font:500 22px/1.5 Inter,system-ui;color:#c4cddc;margin:0;max-width:900px}
#rec-card ul{list-style:none;padding:0;margin:26px 0 0;font:500 20px/1.9 Inter,system-ui;color:#dfe6f2;text-align:left}
#rec-card li::before{content:'▸ ';color:#ff6a2b}
`;
const CURSOR_SVG = `<svg id="rec-cursor" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12.5 18.8 L9.6 12 L15.5 12 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

class Rec {
  constructor(outDir) {
    this.outDir = outDir; this.frames = []; this.n = 0; this.mouse = { x: 720, y: 400 }; this.step = 0;
    fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  }
  async open(url) {
    this.browser = await chromium.launch();
    this.ctx = await this.browser.newContext({ viewport: VIEW, deviceScaleFactor: DSF, acceptDownloads: true });
    this.page = await this.ctx.newPage();
    this.errors = [];
    this.page.on('pageerror', e => this.errors.push(e.message));
    this.page.on('dialog', d => d.dismiss());
    this.downloads = [];
    this.page.on('download', d => this.downloads.push(d));
    await this.page.addInitScript(() => { try { localStorage.clear(); } catch {} });
    await this.page.goto(url);
    await this.page.waitForTimeout(800);
    await this.page.addStyleTag({ content: OVERLAY_CSS });
    await this.page.evaluate(cur => {
      document.body.insertAdjacentHTML('beforeend', cur + '<div id="rec-ripple"></div><div id="rec-cap"></div><div id="rec-step"></div><div id="rec-keys"></div><div id="rec-card"></div>');
    }, CURSOR_SVG);
  }
  // ── frames ──
  async shot(hold = 1) {
    if (process.env.DRY) { this.frames.push({ f: '', n: hold }); return; }
    const f = path.join(this.outDir, `f${String(++this.n).padStart(5, '0')}.jpg`);
    await this.page.screenshot({ path: f, type: 'jpeg', quality: 92 });
    this.frames.push({ f, n: hold });
  }
  hold(frames) { if (this.frames.length) this.frames[this.frames.length - 1].n += frames; }
  async wait(sec) { await this.page.waitForTimeout(60); await this.shot(Math.max(1, Math.round(sec * FPS))); }
  seconds() { return this.frames.reduce((a, b) => a + b.n, 0) / FPS; }
  // ── overlays ──
  async caption(text, sub = '', readSec = null) {
    await this.page.evaluate(([t, s]) => {
      const c = document.getElementById('rec-cap'); c.innerHTML = t + (s ? `<small>${s}</small>` : ''); c.style.opacity = t ? '1' : '0';
    }, [text, sub]);
    if (readSec == null) readSec = Math.min(4.2, 1.4 + (text.length + sub.length) * 0.032);
    if (readSec > 0) await this.wait(readSec);
  }
  async capTop(on) { await this.page.evaluate(on => { const c = document.getElementById('rec-cap'); c.style.bottom = on ? 'auto' : ''; c.style.top = on ? '96px' : ''; }, on); }
  async frameW(x0, y0, x1, y1) { await this.page.evaluate(([x0, y0, x1, y1]) => { const { app } = window.prowdcad; const v = app.view; v.cx = (x0 + x1) / 2; v.cy = (y0 + y1) / 2; v.scale = Math.min(v.W / (x1 - x0), v.H / (y1 - y0)); app.invalidate(); }, [x0, y0, x1, y1]); await this.page.waitForTimeout(60); }
  async stepBadge(t) { await this.page.evaluate(t => { const s = document.getElementById('rec-step'); s.textContent = t; s.style.opacity = t ? '1' : '0'; }, t); }
  async keysBadge(keys) {
    await this.page.evaluate(k => { const e = document.getElementById('rec-keys'); e.innerHTML = k.map(x => `<kbd>${x}</kbd>`).join(''); e.style.opacity = k.length ? '1' : '0'; }, keys);
  }
  async card(html, sec) {
    await this.page.evaluate(h => { const c = document.getElementById('rec-card'); c.innerHTML = h; c.style.display = h ? 'flex' : 'none'; document.getElementById('rec-cursor').style.display = h ? 'none' : ''; }, html);
    if (sec) await this.wait(sec);
  }
  // ── mouse ──
  async setCursor(x, y) { await this.page.evaluate(([x, y]) => { const c = document.getElementById('rec-cursor'); c.style.left = x + 'px'; c.style.top = y + 'px'; }, [x, y]); }
  async moveTo(x, y, frames = null, opts = {}) {
    const a = { ...this.mouse };
    const d = Math.hypot(x - a.x, y - a.y);
    if (frames == null) frames = Math.max(5, Math.min(18, Math.round(d / 45)));
    for (let i = 1; i <= frames; i++) {
      const t = i / frames, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const px = a.x + (x - a.x) * e, py = a.y + (y - a.y) * e;
      await this.page.mouse.move(px, py);
      await this.setCursor(px, py);
      if (!opts.noShots && (i % (opts.every || 2) === 0 || i === frames)) await this.shot(opts.every || 2);
    }
    this.mouse = { x, y };
  }
  async ripple() {
    await this.page.evaluate(([x, y]) => { const r = document.getElementById('rec-ripple'); r.style.left = x + 'px'; r.style.top = y + 'px'; r.style.opacity = '1'; }, [this.mouse.x, this.mouse.y]);
  }
  async unripple() { await this.page.evaluate(() => { document.getElementById('rec-ripple').style.opacity = '0'; }); }
  async click(x, y, opts = {}) {
    if (x != null) await this.moveTo(x, y, opts.frames);
    const mods = opts.mods || [];
    if (mods.length) await this.keysBadge(mods.map(m => m === 'Control' ? 'Ctrl' : m));
    for (const m of mods) await this.page.keyboard.down(m);
    await this.ripple();
    await this.page.mouse.click(this.mouse.x, this.mouse.y, { button: opts.button || 'left' });
    for (const m of mods.slice().reverse()) await this.page.keyboard.up(m);
    await this.page.waitForTimeout(opts.settle ?? 90);
    await this.shot(4);
    await this.unripple();
    if (mods.length) await this.keysBadge([]);
    await this.shot(opts.after ?? 4);
  }
  async drag(x0, y0, x1, y1, frames = 20) {
    await this.moveTo(x0, y0);
    await this.ripple(); await this.page.mouse.down(); await this.shot(3);
    await this.unripple();
    const a = { x: x0, y: y0 };
    for (let i = 1; i <= frames; i++) {
      const t = i / frames, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const px = a.x + (x1 - a.x) * e, py = a.y + (y1 - a.y) * e;
      await this.page.mouse.move(px, py, { steps: 1 }); await this.setCursor(px, py);
      if (i % 2 === 0 || i === frames) await this.shot(2);
    }
    await this.page.mouse.up(); this.mouse = { x: x1, y: y1 };
    await this.page.waitForTimeout(80); await this.shot(6);
  }
  // ── keyboard ──
  async key(combo, label, hold = 14) {
    await this.keysBadge((label || combo).split('+'));
    await this.page.evaluate(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); });
    await this.shot(6);
    await this.page.keyboard.press(combo);
    await this.page.waitForTimeout(120);
    await this.shot(hold);
    await this.keysBadge([]);
  }
  async typeInto(selector, text, { clear = true } = {}) {
    const el = this.page.locator(selector).first();
    const box = await el.boundingBox();
    if (box) await this.moveTo(box.x + Math.min(box.width - 10, 40), box.y + box.height / 2);
    await el.click({ clickCount: 3 });
    await this.page.waitForTimeout(60);
    if (clear) await this.page.keyboard.press('Control+A');
    for (const ch of text) { await this.page.keyboard.type(ch); await this.shot(2); }
    await this.shot(6);
  }
  // ── app helpers ──
  async toScreen(x, y) {
    return this.page.evaluate(([x, y]) => {
      const { app, canvas } = window.prowdcad; const s = app.view.toScreen({ x, y }); const r = canvas.svg.getBoundingClientRect();
      return { x: r.left + s.x, y: r.top + s.y };
    }, [x, y]);
  }
  async clickW(x, y, opts = {}) { const p = await this.toScreen(x, y); await this.click(p.x, p.y, opts); }
  async moveW(x, y, frames) { const p = await this.toScreen(x, y); await this.moveTo(p.x, p.y, frames); }
  async menu(root, ...labels) {
    const r = this.page.locator(`.menu-root[data-menu="${root}"]`).first();
    const b = await r.boundingBox();
    await this.click(b.x + b.width / 2, b.y + b.height / 2, { after: 6 });
    for (let i = 0; i < labels.length; i++) {
      const esc = labels[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let item = this.page.locator('.menu-root.open .menu-item', { has: this.page.locator('.mlabel', { hasText: new RegExp('^\\s*' + esc + '\\s*$') }) }).filter({ visible: true }).last();
      if (!(await item.count())) item = this.page.locator('.menu-root.open .menu-item', { has: this.page.locator('.mlabel', { hasText: labels[i] }) }).filter({ visible: true }).last();
      let ib = await item.boundingBox();
      if (!ib) throw new Error('menu item not found: ' + labels[i]);
      if (i > 0) { // inside a flyout: go horizontally first, then vertically, so we never cross sibling items
        await this.moveTo(ib.x + 30, this.mouse.y, 6); await this.page.waitForTimeout(80);
        await this.moveTo(ib.x + 30, ib.y + ib.height / 2, 6); await this.page.waitForTimeout(80);
        ib = await item.boundingBox();
      }
      if (i < labels.length - 1) { await this.moveTo(ib.x + 40, ib.y + ib.height / 2, 8); await this.page.waitForTimeout(150); await this.shot(6); }
      else { if (process.env.DRY) console.log('menu click:', root, '>', (await item.innerText()).replace(/\s+/g,' ')); await this.click(ib.x + 40, ib.y + ib.height / 2, { after: 8, frames: 4 }); }
    }
  }
  dlg() { return this.page.locator('.dlg').last(); }
  async dlgField(key, value) { await this.typeInto(`.dlg [data-key="${key}"]`, String(value)); }
  async dlgCheck(key, want) {
    const el = this.page.locator(`.dlg [data-key="${key}"]`).first();
    if ((await el.isChecked()) !== want) { const b = await el.boundingBox(); await this.click(b.x + b.width / 2, b.y + b.height / 2); }
  }
  async dlgSelect(key, value) { const el = this.page.locator(`.dlg [data-key="${key}"]`).first(); const b = await el.boundingBox(); await this.moveTo(b.x + 30, b.y + b.height / 2); await el.selectOption(value); await this.shot(8); }
  async dlgOk() { const b = await this.page.locator('.dlg .btn.primary').last().boundingBox(); await this.click(b.x + b.width / 2, b.y + b.height / 2, { after: 10 }); }
  async snap(name) { await this.page.screenshot({ path: path.join(this.outDir, '..', name + '.jpg'), type: 'jpeg', quality: 80 }); }
  async eval(fn, arg) { return this.page.evaluate(fn, arg); }
  // ── encode ──
  async finish(outMp4) {
    await this.browser.close();
    const list = this.frames.map(fr => `file '${fr.f}'\nduration ${(fr.n / FPS).toFixed(5)}`).join('\n') + `\nfile '${this.frames[this.frames.length - 1].f}'\n`;
    const lf = path.join(this.outDir, 'list.txt'); fs.writeFileSync(lf, list);
    const tmp = outMp4.replace(/\.mp4$/, '.part.mp4');
    const { execFileSync } = require('child_process');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lf, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-movflags', '+faststart', tmp], { stdio: 'inherit' });
    fs.renameSync(tmp, outMp4);
  }
}
module.exports = { Rec, FPS };
