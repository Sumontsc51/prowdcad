// Injected into the page (Vite dev server) by harness.cjs → window.__e2e.
// Test-only observation hooks: command spy, toast/dialog/status recorders, download capture,
// geometry helpers. Nothing here changes application behaviour.
(async () => {
  if (window.__e2e) return;
  const C = await import('/src/commands.ts');
  const B = await import('/src/ops-bridge.ts');
  const G = await import('/src/geometry.ts');
  const S = await import('/src/settings.ts');
  const HK = await import('/src/hitkit.ts');
  const { app, canvas } = window.prowdcad;
  const E = {
    app, canvas, C, ops: B.ops, G, settings: S.settings, saveSettings: S.saveSettings,
    toasts: [], dialogs: [], statuses: [], invoked: [], downloads: [], errors: [],
  };
  window.__e2e = E;

  // ── command spy (wraps run; same object stays in the registry) ──
  E.dispatched = [];
  for (const c of C.allCommands()) {
    if (c.__spied) continue;
    const orig = c.run;
    c.run = function (...a) { E.invoked.push(c.id); E.dispatched.push(c.id); return orig.apply(this, a); };
    // runCommand() checks enabled() before run(): record that too, so a hotkey that reaches a
    // disabled command still counts as "dispatched to this id"
    if (c.enabled) { const en = c.enabled; c.enabled = function (...a) { if (E.trackEnabled) E.dispatched.push(c.id); return en.apply(this, a); }; }
    c.__spied = true;
  }
  const LV = await import('/src/live.ts');
  /** world point on the hit line of the first live object of `kind` on piece `pname` */
  E.livePt = (pname, kind, t = 0.5, which = 0) => {
    const p = E.P(pname); const shapes = LV.liveShapes(app, p, app.sizeOf(p)).filter(s => s.kind === kind);
    const s = shapes[which]; if (!s) throw new Error(`no ${kind} on ${pname}`);
    const line = LV.hitLines(s)[0]; const a = line[0], b = line[line.length - 1];
    const loc = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    return G.toWorld(p, loc);
  };
  // ── status recorder ──
  const origStatus = app.status.bind(app);
  app.status = (m) => { if (m) E.statuses.push(m); return origStatus(m); };
  // ── toast + dialog recorder ──
  const mo = new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.classList.contains('toast')) E.toasts.push({ kind: (n.className.match(/toast-(\w+)/) || [])[1] || 'info', text: n.textContent });
      const dlg = n.classList.contains('dlg-overlay') ? n.querySelector('.dlg') : null;
      if (dlg) {
        const fields = [...dlg.querySelectorAll('.dlg-row')].map(r => {
          const lab = r.querySelector('.dlg-label')?.textContent ?? r.querySelector('span')?.textContent ?? '';
          const ctl = r.querySelector('[data-key]');
          let value = '';
          if (ctl) {
            if (ctl.matches('input[type=checkbox]')) value = ctl.checked;
            else if (ctl.matches('.dlg-radio')) value = ctl.querySelector('input:checked')?.value ?? '';
            else if (ctl.matches('select')) value = ctl.value + ' [' + [...ctl.options].map(o => o.value).join('|') + ']';
            else value = ctl.value ?? '';
          }
          return { label: lab, key: ctl?.getAttribute('data-key') ?? '', value };
        });
        E.dialogs.push({ title: dlg.querySelector('.dlg-title')?.textContent ?? '', message: dlg.querySelector('.dlg-msg')?.textContent ?? '', fields, buttons: [...dlg.querySelectorAll('.dlg-foot .btn')].map(b => b.textContent) });
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  // ── downloads ──
  window.prowd.downloadSink.capture = (name, blob) => {
    const p = blob.arrayBuffer().then(buf => {
      let s = ''; const u = new Uint8Array(buf);
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      E.downloads.push({ name, type: blob.type, b64: btoa(s), size: u.length });
    });
    E._dl = p;
  };

  // ── helpers ──
  E.stable = () => { const s = JSON.parse(JSON.stringify(app.doc.style)); delete s.updatedAt; return JSON.stringify(s); };
  E.P = (name) => { const p = app.doc.style.pieces.find(x => x.name === name); if (!p) throw new Error('no piece ' + name); return p; };
  E.findA = (pname, aname) => {
    const p = E.P(pname);
    for (const c of [p.sew, ...p.internals]) { const i = c.points.findIndex(a => a.name === aname || a.id === aname); if (i >= 0) return { p, c, i, a: c.points[i] }; }
    throw new Error(`no anchor ${pname}/${aname}`);
  };
  E.ref = (pname, aname) => { const q = E.findA(pname, aname); return { pieceId: q.p.id, contourId: q.c.id, anchorId: q.a.id }; };
  E.resolved = (p, c, sid) => { const r = G.resolveFor(app.doc, p, sid ?? app.sizeOf(p)); return c === p.sew || c.id === p.sew.id ? r.sew : r.internals[p.internals.findIndex(x => x.id === c.id)]; };
  E.W = (pname, aname, sid) => { const q = E.findA(pname, aname); const rc = E.resolved(q.p, q.c, sid); return G.toWorld(q.p, rc.anchorPos[q.i]); };
  E.L = (pname, aname, sid) => { const q = E.findA(pname, aname); const rc = E.resolved(q.p, q.c, sid); return { ...rc.anchorPos[q.i] }; };
  E.toClient = (w) => { const s = app.view.toScreen(w); const r = canvas.svg.getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y }; };
  E.localToWorld = (pname, v) => G.toWorld(E.P(pname), v);
  /** world point at fraction t along the run from→to (resolved polyline, active size) */
  E.along = (pname, fromName, toName, t = 0.5) => {
    const a = E.findA(pname, fromName), b = E.findA(pname, toName);
    const pts = HK.runWorld(app, a.p, a.c, a.a.id, b.a.id);
    let L = 0; const seg = [];
    for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); seg.push(d); L += d; }
    let goal = L * t;
    for (let i = 1; i < pts.length; i++) { if (goal <= seg[i - 1]) { const k = seg[i - 1] ? goal / seg[i - 1] : 0; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k }; } goal -= seg[i - 1]; }
    return pts[pts.length - 1];
  };
  E.idle = () => !document.querySelector('.dlg-overlay') && !document.querySelector('.popover') && app.tool?.id !== 'pick';
  E.sel = () => JSON.parse(JSON.stringify({ pieces: app.sel.pieces.map(id => app.doc.style.pieces.find(p => p.id === id)?.name ?? id), anchors: app.sel.anchors.map(r => { const p = app.doc.style.pieces.find(x => x.id === r.pieceId); const a = p && [p.sew, ...p.internals].flatMap(c => c.points).find(x => x.id === r.anchorId); return (p?.name ?? '?') + '/' + (a?.name ?? r.anchorId); }), live: app.liveSel ? app.liveSel.kind : null }));
  E.selRaw = () => JSON.parse(JSON.stringify({ pieces: app.sel.pieces, anchors: app.sel.anchors, live: app.liveSel }));
  E.segLen = (pname, fromName, toName, sid) => { const a = E.findA(pname, fromName), b = E.findA(pname, toName); return B.ops.measureSegment(app.doc, a.p.id, a.c.id, a.a.id, b.a.id, sid); };
  E.cutPerim = (pname, sid) => { const p = E.P(pname); const r = G.resolveFor(app.doc, p, sid ?? app.sizeOf(p)); let L = 0; const c = r.cut; for (let i = 0; i < c.length; i++) { const q = c[(i + 1) % c.length]; L += Math.hypot(q.x - c[i].x, q.y - c[i].y); } return L; };
  E.reset = (json) => {
    document.querySelectorAll('.fwin .fw-x').forEach(b => b.click());
    if (app.tool?.id !== 'select') app.setTool('select');
    app.doc.load(JSON.parse(json));
    app.nested = false; app.pointTracking = false; app.gradeAbsolute = false; app.liveSel = null;
    app.preview.clear();
    app.fileName = 'e2e.prowd.json'; app.markSaved();
    Object.assign(S.settings, structuredClone(S.DEFAULT_SETTINGS));
    S.saveSettings();
    E.toasts.length = 0; E.dialogs.length = 0; E.statuses.length = 0; E.invoked.length = 0; E.downloads.length = 0; E.errors.length = 0;
    app.invalidate(); app.flush(); canvas.applyRulerVisibility();
    app.view.W = canvas.svg.getBoundingClientRect().width; app.view.H = canvas.svg.getBoundingClientRect().height;
    app.view.cx = 380; app.view.cy = 356; app.view.scale = Math.min(app.view.W / 900, app.view.H / 820);
    app.invalidate(); app.flush();
  };
  E.flush = () => new Promise(r => requestAnimationFrame(() => { app.flush(); requestAnimationFrame(() => r(true)); }));
  E.sizeIds = () => app.sizeLine().sizes.map(s => s.id);
  E.sizeId = (name) => app.sizeLine().sizes.find(s => s.name === name)?.id;
  /** resolved anchor positions (piece-local) of every anchor of a piece in every size: name/id → size → {x,y} */
  E.allPos = (pname) => {
    const p = E.P(pname); const out = {};
    for (const sid of app.doc.sizesOf(p)) {
      const r = G.resolveFor(app.doc, p, sid);
      [p.sew, ...p.internals].forEach((c, ci) => { const rc = ci === 0 ? r.sew : r.internals[ci - 1]; c.points.forEach((a, i) => { const k = (ci === 0 ? 'sew:' : `int${ci}:`) + (a.name || a.id); (out[k] ??= {})[sid] = { x: +rc.anchorPos[i].x.toFixed(4), y: +rc.anchorPos[i].y.toFixed(4) }; }); });
    }
    return out;
  };
  return true;
})();
