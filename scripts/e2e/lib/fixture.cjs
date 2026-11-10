// Fixture: a realistic graded T-shirt front + back, built through the UI (File ▸ New, Pen, Rectangle,
// Internal line, Piece ▸ Rename). Pure data setup that has no single UI gesture (anchor names, grade
// increments, one notch, one drill) is done afterwards with kernel ops via the ops bridge and is
// clearly separated in `programmaticSetup`.

// FRONT half (CF at x = 0), base M, mm, y-up. 'c' = curve point (Ctrl+click).
const FRONT = [
  ['CF_HEM', 0, 0], ['SS_HEM', 260, 0], ['UA', 260, 465],
  ['AH1', 222, 545, 'c'], ['AH2', 205, 618, 'c'],
  ['SH', 200, 680], ['HPS', 85, 712],
  ['N1', 70, 664, 'c'], ['N2', 32, 625, 'c'],
  ['CF_NECK', 0, 622],
];
// grading: absolute offset per size step (S = −1, M = 0 base, L = +1, XL = +2)
const FRONT_GRADE = { SS_HEM: [10, 0], UA: [10, 5], SH: [6, 8], HPS: [3, 8], CF_NECK: [0, 8] };
const BACK_GRADE = { BR: [10, 0], TR: [6, 8], TL: [0, 8] };
const SIZES = ['S', 'M', 'L', 'XL'];
const STEP = { S: -1, M: 0, L: 1, XL: 2 };

async function buildFixture(h) {
  const P = h.page;
  // 1. File ▸ New (UI)
  await h.menu('File', 'New…');
  if ((await h.dlgTitle()) !== 'New style') await h.ok(); // discard-changes confirm
  await h.fields({ name: 'E2E TEE', sizes: SIZES.join(', '), base: 'M' });
  await h.fill('block', false);
  await h.ok();
  await h.ev(() => { const { app } = window.__e2e; const v = app.view; v.cx = 380; v.cy = 356; v.scale = Math.min(v.W / 900, v.H / 820); app.invalidate(); });
  await h.settle();
  // 2. FRONT with the Pen tool (UI): click = corner, Ctrl+click = curve, click start = close
  await h.key('p');
  for (const [, x, y, c] of FRONT) await h.clickW({ x, y }, { mods: c ? ['Control'] : [] });
  await h.clickW({ x: 0, y: 0 });
  await h.waitDialog();
  await h.fields({ name: 'FRONT', seam: '10' });
  await h.ok();
  // 3. BACK with the Rectangle tool: click → exact-size dialog (UI)
  await h.key('r');
  await h.clickW({ x: 400, y: 0 });
  await h.waitDialog();
  await h.fields({ w: '260', h: '700' });
  await h.ok();
  await h.key('v');
  // rename via Piece ▸ Rename… (the rectangle is selected after creation)
  await h.menu('Piece', 'Rename…');
  await h.fill('n', 'BACK'); await h.ok();
  // 4. Internal line on FRONT with the Internal tool (UI): two clicks + Enter
  await h.key('i');
  await h.clickW({ x: 130, y: 80 });
  await h.clickW({ x: 130, y: 380 });
  await h.key('Enter');
  await h.key('v');
  await P.waitForTimeout(100);
  const uiErrors = h.pageErrors.slice();

  // ───────── programmatic setup (pure data; not under test) ─────────
  await h.ev(([FRONT, FG, BG, STEP]) => {
    const { app, ops } = window.__e2e;
    const doc = app.doc;
    const line = doc.sizeLine();
    const sid = n => line.sizes.find(s => s.name === n).id;
    doc.transact('e2e fixture', () => {
      const f = doc.style.pieces.find(p => p.name === 'FRONT');
      f.sew.points.forEach((a, i) => { a.name = FRONT[i][0]; });
      const b = doc.style.pieces.find(p => p.name === 'BACK');
      for (const a of b.sew.points) {
        const lx = Math.round(a.x - 400), ly = Math.round(a.y);
        a.name = (ly < 1 ? 'B' : 'T') + (lx < 1 ? 'L' : 'R');
      }
      f.internals[0].points[0].name = 'IL_A'; f.internals[0].points[f.internals[0].points.length - 1].name = 'IL_B';
      const grade = (pc, table) => {
        for (const [nm, [dx, dy]] of Object.entries(table)) {
          const a = pc.sew.points.find(q => q.name === nm);
          for (const s of Object.keys(STEP)) if (STEP[s] !== 0) ops.setGrade(doc, pc.id, a.id, sid(s), { dx: dx * STEP[s], dy: dy * STEP[s] }, { view: 'absolute' });
        }
      };
      grade(f, FG); grade(b, BG);
      // one proportional notch on the FRONT side seam, one drill
      const ss = f.sew.points.find(q => q.name === 'SS_HEM');
      const placement = ops.placementAt(doc, f, f.sew.id, 460, 'proportional');
      ops.addNotch(doc, f, { contourId: f.sew.id, placement, type: 'slit', source: 'manual' });
      ops.addDrill(doc, f, { x: 130, y: 520, diameter: 4, kind: 'drill', mode: 'cut' });
      void ss;
    });
  }, [FRONT, FRONT_GRADE, BACK_GRADE, STEP]);
  await h.settle();
  const json = await h.stable();
  return { json, uiErrors };
}

/** Variants built from the base fixture (programmatic, used as preconditions). */
async function withLive(h) {
  // dart on FRONT side seam, open knife pleat on BACK, fullness on BACK hem
  return h.ev(() => {
    const { app, ops } = window.__e2e; const doc = app.doc;
    const f = doc.style.pieces.find(p => p.name === 'FRONT'), b = doc.style.pieces.find(p => p.name === 'BACK');
    const ss = f.sew.points.find(a => a.name === 'SS_HEM');
    ops.addDart(doc, { pieceId: f.id, at: { fromAnchorId: ss.id, distance: 230 }, width: 20, depth: 100, fold: 'A', drillOffset: 12 });
    ops.addPleat(doc, { pieceId: b.id, start: { x: 530, y: 700 }, end: { x: 530, y: 400 }, attrs: { type: 'knife', depthStart: 15, depthEnd: 15, fold: 'right', autoNotches: true }, open: true });
    const bl = b.sew.points.find(a => a.name === 'BL');
    ops.addFullness(doc, b.id, { slash: { fromAnchorId: bl.id, distance: 80 }, pivot: { x: 480, y: 650 }, openA: 30, openB: 0, mode: 'rotate', side: 'forward' });
    return window.__e2e.stable();
  });
}

module.exports = { buildFixture, withLive, FRONT, SIZES, STEP, FRONT_GRADE };
