/**
 * Grading table: rows = grade anchors of the selected piece's sew line, cols = sizes (dX / dY).
 * Toggle Incremental ⇄ Absolute. Writes go through doc.transact using the kernel's
 * absoluteToIncremental / incrementalToAbsolute (incremental convention: inc[size_0] = 0).
 *
 * Point Tracking (toggle, or Alt+T): ←/→ step to previous/next grade point (selection follows,
 * canvas centres on it), ↑/↓ step the active size. Toggle: Alt+T.
 */
import { absoluteToIncremental, incrementalToAbsolute, type GradeInc, type SizeId } from '@prowdcad/kernel';
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { lengthInput } from './widgets';
import { unitLabel } from '../units-ui';
import { resolveFor, toWorld } from '../geometry';
import { ops } from '../ops-bridge';
import { getCommand, isEnabled, runCommand, effectiveHotkey, reportError } from '../commands';

export function renderGrading(app: App, host: HTMLElement) {
  clear(host);
  const piece = app.primaryPiece();
  const line = app.sizeLine();
  const bar = h('div.gr-bar');
  const mode = h('div.seg');
  const TIP = {
    inc: 'Incremental: each cell is the step from the previous size. Editing L moves L AND every larger size (XL, …) by the same amount: the sizes after it are built on it.',
    abs: 'Absolute: each cell is the offset from the base size ★. Editing L changes L only; every other size keeps its position (AccuMark-style per-size break).',
  };
  for (const [abs, label] of [[false, 'Incremental'], [true, 'Absolute']] as const) {
    mode.append(h('button' + (app.gradeAbsolute === abs ? '.on' : ''), { title: abs ? TIP.abs : TIP.inc, onclick: () => { app.gradeAbsolute = abs; app.invalidate('panels'); } }, label + (abs ? ' (one size only)' : '')));
  }
  const track = h('button.btn.sm' + (app.pointTracking ? '.on' : ''), { title: 'Point Tracking: ←/→ previous/next grade point, ↑/↓ size (Alt+T)', onclick: () => { app.pointTracking = !app.pointTracking; app.invalidate('panels'); } }, app.pointTracking ? '◉ Tracking' : '○ Tracking');
  bar.append(mode, track, h('span.dim', {}, unitLabel()));
  // power ops (command registry — same as Grade menu / hotkeys)
  const tools = h('div.gr-tools');
  for (const [id, label, tip] of TOOLBAR) {
    if (id === '|') { tools.append(h('span.gr-sep')); continue; }
    const c = getCommand(id); if (!c) continue;
    tools.append(h('button.btn.sm' + (isEnabled(c) ? '' : '.disabled'), { title: `${tip}${effectiveHotkey(id) ? ` (${effectiveHotkey(id).split(',')[0]})` : ''}`, onclick: () => void runCommand(id) }, label));
  }
  bar.append(tools);
  host.append(bar);
  host.append(h('div.gr-note' + (app.gradeAbsolute ? '' : '.warn'), { title: app.gradeAbsolute ? TIP.abs : TIP.inc }, app.gradeAbsolute
    ? 'Absolute view: offsets from the base size ★ — editing a size changes that size only.'
    : 'Incremental view: an edit also shifts every larger size (XL follows L). Use “Absolute (one size only)” to change one size.'));
  if (!piece) { host.append(h('div.empty', {}, 'Select a piece to see its grading.')); return; }
  const live = app.doc.piece(piece.id);
  const gpts = live.sew.points.map((a, i) => ({ a, i })).filter(x => x.a.kind === 'grade');
  if (!gpts.length) { host.append(h('div.empty', {}, 'No grade points.')); return; }

  const wrap = h('div.gr-wrap');
  const tbl = h('table.gr');
  const hr1 = h('tr', {}, h('th', { rowspan: 2 }, '#'), h('th', { rowspan: 2 }, 'Point'));
  const hr2 = h('tr');
  for (const s of line.sizes) {
    hr1.append(h('th' + (s.id === app.activeSize ? '.cur' : ''), { colspan: 2 }, s.name + (s.id === line.baseSizeId ? ' ★' : '')));
    hr2.append(h('th.sub', {}, 'dX'), h('th.sub', {}, 'dY'));
  }
  tbl.append(hr1, hr2);
  const selIds = new Set(app.sel.anchors.map(r => r.anchorId));
  for (const { a, i } of gpts) {
    const tr = h('tr' + (selIds.has(a.id) ? '.sel' : ''));
    const label = h('td.pt', { title: 'Select point' }, a.name || (a.flags.startPoint ? 'start' : ''));
    const num = h('td.num', {}, String(i + 1));
    for (const td of [num, label]) td.onclick = () => app.selectAnchor({ pieceId: live.id, contourId: live.sew.id, anchorId: a.id });
    tr.append(num, label);
    const abs = incrementalToAbsolute(a.grade ?? {}, line);
    const inc = absoluteToIncremental(abs, line); // normalised (fills missing entries)
    line.sizes.forEach((s, si) => {
      const vals = app.gradeAbsolute ? abs[s.id] : inc[s.id];
      const readOnly = live.locked || (app.gradeAbsolute ? s.id === line.baseSizeId : si === 0);
      for (const axis of ['dx', 'dy'] as const) {
        const td = h('td' + (s.id === app.activeSize ? '.cur' : ''));
        td.append(lengthInput(vals?.[axis] ?? 0, v => writeCell(app, live.id, a.id, s.id, axis, v), { readOnly }));
        tr.append(td);
      }
    });
    tbl.append(tr);
  }
  wrap.append(tbl);
  host.append(wrap);
  // keep the selected row visible
  const selRow = tbl.querySelector('tr.sel') as HTMLElement | null;
  if (selRow) requestAnimationFrame(() => selRow.scrollIntoView({ block: 'nearest' }));
}

function writeCell(app: App, pieceId: string, anchorId: string, sizeId: SizeId, axis: 'dx' | 'dy', v: number) {
  const line = app.sizeLine();
  const a = app.doc.piece(pieceId).sew.points.find(q => q.id === anchorId)!;
  const view = app.gradeAbsolute ? 'absolute' : 'incremental';
  const curMap = app.gradeAbsolute ? incrementalToAbsolute(a.grade ?? {}, line) : absoluteToIncremental(incrementalToAbsolute(a.grade ?? {}, line), line);
  const cur: GradeInc = curMap[sizeId] ?? { dx: 0, dy: 0 };
  const abs0 = incrementalToAbsolute(a.grade ?? {}, line);
  try { ops.setGrade(app.doc, pieceId, anchorId, sizeId, { ...cur, [axis]: v }, { view }); } catch (err) { reportError(err, 'Grade'); return; }
  if (!app.gradeAbsolute) {
    // say which sizes an incremental edit moved (the cascade an AccuMark user does not expect)
    const a1 = app.doc.piece(pieceId).sew.points.find(q => q.id === anchorId)!;
    const abs1 = incrementalToAbsolute(a1.grade ?? {}, line);
    const moved = line.sizes.filter(s => { const p = abs0[s.id] ?? { dx: 0, dy: 0 }, q = abs1[s.id] ?? { dx: 0, dy: 0 }; return Math.hypot(p.dx - q.dx, p.dy - q.dy) > 1e-9; }).map(s => s.name);
    if (moved.length > 1) app.status(`Incremental edit moved sizes ${moved.join(', ')} · switch to Absolute (one size only) to change one size`);
  }
}

const TOOLBAR: [string, string, string][] = [
  ['grade.copy', 'Copy', 'Copy grade of selected points'], ['grade.paste', 'Paste', 'Paste grade'], ['grade.pasteX', 'X', 'Paste X only'], ['grade.pasteY', 'Y', 'Paste Y only'],
  ['grade.smartPaste', 'Smart', 'Smart paste (flips X across the mirror axis)'], ['grade.pasteAround', 'Around', 'Paste around a run'], ['|', '', ''],
  ['grade.flipX', '⇋X', 'Flip X'], ['grade.flipY', '⇅Y', 'Flip Y'], ['grade.equalX', '=X', 'Equal X'], ['grade.equalY', '=Y', 'Equal Y'],
  ['grade.deleteX', '∅X', 'Delete X'], ['grade.deleteY', '∅Y', 'Delete Y'], ['grade.zero', '∅', 'Delete all grading'], ['|', '', ''],
  ['grade.stackPoint', 'Stack', 'Stack nest at a point'], ['grade.stackLine', 'Stack line', 'Stack along line'], ['grade.angle', '∠', 'Angle grading (auto-aim)'],
  ['grade.parallel', '∥', 'Grade parallel'], ['grade.proportional', 'Prop', 'Grade proportionally'], ['|', '', ''], ['grade.rules', 'Rules', 'Rule library'], ['grade.movement', 'MTM', 'Movement programs'],
];

/** Point-tracking key handling; returns true when consumed. */
export function trackingKey(app: App, e: KeyboardEvent, centreOn: (x: number, y: number) => void): boolean {
  if (!app.pointTracking || e.ctrlKey || e.metaKey || e.altKey) return false;
  const line = app.sizeLine();
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const ids = line.sizes.map(s => s.id);
    const i = ids.indexOf(app.activeSize);
    const j = Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    app.activeSize = ids[j]; app.status(`Size ${line.sizes[j].name}`); app.invalidate();
    return true;
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
  const piece = app.primaryPiece(); if (!piece) return false;
  const g = piece.sew.points.filter(a => a.kind === 'grade');
  if (!g.length) return false;
  const cur = app.primaryAnchor();
  let k = cur && cur.contour === piece.sew ? g.findIndex(a => a.id === cur.anchor.id) : -1;
  k = k < 0 ? 0 : (k + (e.key === 'ArrowRight' ? 1 : -1) + g.length) % g.length;
  app.selectAnchor({ pieceId: piece.id, contourId: piece.sew.id, anchorId: g[k].id });
  const r = resolveFor(app.doc, piece, app.sizeOf(piece));
  const idx = piece.sew.points.indexOf(g[k]);
  const w = toWorld(piece, r.sew.anchorPos[idx]);
  centreOn(w.x, w.y);
  app.status(`Point ${idx + 1}${g[k].name ? ' · ' + g[k].name : ''}`);
  return true;
}
