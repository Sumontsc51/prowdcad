// Every default hotkey: press the chord in a neutral state (Select tool, one sew grade point
// selected, grade + dart clipboards filled) and check which command the app dispatched.
const { toPlaywrightChord } = require('../lib/harness.cjs');

// chords a browser keeps for itself (cannot be overridden by a web page in Chrome/Edge)
const RESERVED = { 'Ctrl+Shift+N': 'new incognito/private window (browser-reserved, never reaches the page)', 'Ctrl+Shift+I': 'opens DevTools in Chrome/Edge', 'Ctrl+Shift+R': 'hard reload in Chrome/Edge/Firefox', 'Ctrl+1': 'switch to tab 1 (Chrome/Edge/Firefox)' };

async function hotkeys(h, fixtures, registry) {
  const out = { tested: [], mismatches: [], unreachable: [], duplicates: [], reserved: [] };
  // static duplicates (same normalised chord on two commands)
  const norm = await h.ev(() => { const C = window.__e2e.C; return C.allCommands().flatMap(c => C.effectiveHotkey(c.id).split(',').filter(Boolean).map(k => [C.normalizeChord(k), c.id])); });
  const by = {}; for (const [k, id] of norm) (by[k] ??= []).push(id);
  for (const [k, ids] of Object.entries(by)) if (ids.length > 1) out.duplicates.push({ chord: k, ids });
  for (const c of registry) {
    if (!c.hotkey) continue;
    for (const chord of c.hotkey.split(',')) {
      const ch = chord.trim();
      if (RESERVED[ch]) out.reserved.push({ id: c.id, chord: ch, why: RESERVED[ch] });
      await h.reset(c.id.startsWith('dart.') ? fixtures.live : fixtures.base);
      await h.selectA('FRONT', 'SS_HEM');
      await h.ev(() => { const E = window.__e2e; E.dispatched.length = 0; E.trackEnabled = true; });
      const pw = toPlaywrightChord(ch);
      let err = null;
      try { await h.blur(); await h.page.keyboard.press(pw); await h.page.waitForTimeout(120); } catch (e) { err = String(e.message || e).split('\n')[0]; }
      const got = await h.ev(() => { const E = window.__e2e; E.trackEnabled = false; return [...new Set(E.dispatched)]; });
      const rec = { id: c.id, chord: ch, playwright: pw, dispatched: got, err };
      out.tested.push(rec);
      if (!got.includes(c.id)) {
        // a key consumed by the active tool / point tracking is not a registry dispatch
        if (!got.length) out.unreachable.push(rec); else out.mismatches.push(rec);
      }
      await h.escapeAll();
    }
  }
  return out;
}
module.exports = { hotkeys };
