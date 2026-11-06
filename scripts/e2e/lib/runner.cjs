// Generic per-case executor: reset fixture → precondition → UI selection → invoke (menu / hotkey /
// tool) → drive (picks, dialogs) → generic checks (flow finished, no page errors, no "not wired" or
// error toasts, document changed) → case expectation → undo restores → redo re-applies.
const NORM = s => s; // stable() already strips style.updatedAt

async function runCase(h, fixtures, c, meta) {
  const r = { id: c.id, menu: meta?.menu ?? c.menu ?? '', title: meta?.title ?? c.title ?? c.id, kind: c.kind ?? 'command', status: 'pass', msgs: [], notes: c.notes ? [...c.notes] : [], undoSteps: null };
  if (c.skip) { r.status = 'skip'; r.msgs.push(c.skip); return r; }
  const t0 = Date.now();
  const errs0 = h.pageErrors.length, cerr0 = h.consoleErrors.length;
  const fail = m => { r.status = 'fail'; r.msgs.push(m); };
  try {
    h.currentCase = c.caseId || c.id;
    if (await h.ensureHelpers()) r.notes.push('page had reloaded before this case (see navigations)');
    await h.reset(fixtures[c.fixture ?? 'base']);
    if (c.pre) await c.pre(h);
    await h.settle();
    if (c.pre) { // a precondition must not leave undo history the case could undo into
      const j = await h.stable(); await h.ev(j => { const { app } = window.__e2e; app.doc.load(JSON.parse(j)); app.markSaved(); }, j); await h.settle();
    }
    if (c.sel) await c.sel(h);
    await h.settle();
    await h.ev(() => { const E = window.__e2e; E.toasts.length = 0; E.dialogs.length = 0; E.statuses.length = 0; E.invoked.length = 0; E.downloads.length = 0; });
    const before = await h.stable();
    const beforeSel = await h.sel();
    const beforeRev = await h.ev(() => window.__e2e.app.doc.revision());
    // invoke
    let disabled = false;
    if (c.invoke) await c.invoke(h);
    else { const res = await h.cmd(c.id); disabled = !!res?.disabled; }
    if (disabled && !c.expectDisabled) fail('menu item is DISABLED in this state (setup should enable it)');
    if (c.drive) await c.drive(h);
    const finished = await h.waitIdle(c.idleMs ?? 2500);
    if (!finished) {
      const what = await h.ev(() => { const E = window.__e2e; return { dialog: document.querySelector('.dlg-title')?.textContent ?? null, tool: E.app.tool.id, status: E.app.statusMsg }; });
      fail(`flow did not finish: ${JSON.stringify(what)}`);
      await h.escapeAll();
    }
    await h.settle(c.settleMs ?? 60);
    const after = await h.stable();
    const afterSel = await h.sel();
    const rec = await h.rec();
    const downloads = await h.downloads();
    r.toasts = rec.toasts; r.dialogs = rec.dialogs; r.statuses = [...new Set(rec.statuses)];
    r.selBefore = beforeSel; r.selAfter = afterSel;
    if (c.id && !c.invoke && !rec.invoked.includes(c.id) && !disabled) fail('command run() was never invoked');
    for (const t of rec.toasts) {
      if (/not wired/i.test(t.text)) fail('not-wired toast: ' + t.text);
      else if (t.kind === 'error' && !(c.allowError && c.allowError.test(t.text))) fail('error toast: ' + t.text);
      else if (t.kind === 'warn' && !(c.allowWarn && c.allowWarn.test(t.text))) r.notes.push('warn toast: ' + t.text);
    }
    const newErr = h.pageErrors.slice(errs0); if (newErr.length) fail('page error: ' + newErr.join(' | '));
    const newCerr = h.consoleErrors.slice(cerr0).filter(x => !/favicon|DevTools/i.test(x)); if (newCerr.length) r.notes.push('console.error: ' + newCerr.slice(0, 3).join(' | ').slice(0, 400));
    const changed = NORM(after) !== NORM(before);
    const want = c.change ?? true;
    if (want === true && !changed) fail('no document change');
    if (want === false && changed) fail('document changed unexpectedly');
    const ctx = { before: JSON.parse(before), after: JSON.parse(after), beforeSel, afterSel, rec, downloads, changed, beforeRev };
    if (c.expect) {
      let m;
      try { m = await c.expect(h, ctx); } catch (e) { m = 'expect threw: ' + (e.message || e); }
      if (typeof m === 'string' && m) fail(m);
      else if (Array.isArray(m)) m.filter(Boolean).forEach(fail);
    }
    if (c.after) await c.after(h, ctx, r);
    // undo / redo
    if (changed && c.undo !== false) {
      await h.escapeAll();
      let k = 0, back = false;
      for (; k < 6; k++) {
        await h.key('Control+z');
        if (NORM(await h.stable()) === NORM(before)) { back = true; k++; break; }
      }
      r.undoSteps = back ? k : null;
      if (!back) fail('undo (Ctrl+Z ×6) does not restore the previous document');
      else {
        if (k > 1) r.notes.push(`one user action needed ${k} undo steps`);
        for (let i = 0; i < k; i++) await h.key('Control+y');
        if (NORM(await h.stable()) !== NORM(after)) fail('redo (Ctrl+Y) does not re-apply the change');
      }
    }
  } catch (e) {
    fail('exception: ' + (e.message || String(e)).split('\n')[0]);
    try { await h.shot('fail-' + c.id); } catch { /* */ }
    await h.escapeAll().catch(() => {});
  }
  r.ms = Date.now() - t0;
  return r;
}

module.exports = { runCase };
