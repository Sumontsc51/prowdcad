// Queries on a Style JSON snapshot (Node side).
const pc = (st, name) => { const p = st.pieces.find(x => x.name === name); if (!p) throw new Error('no piece ' + name); return p; };
const has = (st, name) => st.pieces.some(x => x.name === name);
const allAnchors = p => [p.sew, ...p.internals].flatMap(c => c.points);
const an = (st, piece, name) => { const a = allAnchors(pc(st, piece)).find(x => x.name === name || x.id === name); if (!a) throw new Error(`no anchor ${piece}/${name}`); return a; };
const line = st => st.sizeTables.find(t => t.id === st.activeSizeTableId).axis1;
const sizeId = (st, name) => line(st).sizes.find(s => s.name === name).id;
/** absolute grade offsets per size name {S:{dx,dy},...} (incremental convention, base = 0) */
function abs(st, piece, name) {
  const a = an(st, piece, name), L = line(st), out = {};
  let cx = 0, cy = 0; const cum = {};
  for (const s of L.sizes) { const g = a.grade?.[s.id] ?? { dx: 0, dy: 0 }; cx += g.dx; cy += g.dy; cum[s.id] = { x: cx, y: cy }; }
  const b = cum[L.baseSizeId];
  for (const s of L.sizes) out[s.name] = { dx: r4(cum[s.id].x - b.x), dy: r4(cum[s.id].y - b.y) };
  return out;
}
const r4 = v => Math.round(v * 1e4) / 1e4;
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const nearV = (a, b, tol = 0.01) => near(a.x, b.x, tol) && near(a.y, b.y, tol);
const eqJ = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** names (or ids) of anchors whose stored x/y, handles or grading differ between two snapshots */
function anchorDiff(st0, st1, piece) {
  const p0 = pc(st0, piece), p1 = pc(st1, piece);
  const m1 = new Map(allAnchors(p1).map(a => [a.id, a]));
  const out = [];
  for (const a of allAnchors(p0)) {
    const b = m1.get(a.id); if (!b) { out.push({ id: a.id, name: a.name, what: 'deleted' }); continue; }
    const what = [];
    if (!near(a.x, b.x, 1e-6) || !near(a.y, b.y, 1e-6)) what.push(`xy (${r4(a.x)},${r4(a.y)})→(${r4(b.x)},${r4(b.y)})`);
    if (!eqJ(a.hIn, b.hIn) || !eqJ(a.hOut, b.hOut)) what.push('handles');
    if (!eqJ(a.grade, b.grade)) what.push('grade');
    if (a.kind !== b.kind || a.smooth !== b.smooth) what.push('kind/smooth');
    if (what.length) out.push({ id: a.id, name: a.name || a.id, what: what.join(', ') });
  }
  for (const b of allAnchors(p1)) if (!allAnchors(p0).some(a => a.id === b.id)) out.push({ id: b.id, name: b.name || b.id, what: 'added' });
  return out;
}
const otherChanged = (st0, st1, piece, except) => anchorDiff(st0, st1, piece).filter(d => !except.includes(d.name));
const count = (st, piece, k) => (pc(st, piece)[k] ?? []).length;
const npts = (st, piece) => pc(st, piece).sew.points.length;
const req = (cond, msg) => (cond ? undefined : msg);

module.exports = { pc, has, an, abs, line, sizeId, near, nearV, eqJ, anchorDiff, otherChanged, count, npts, req, r4, allAnchors };
