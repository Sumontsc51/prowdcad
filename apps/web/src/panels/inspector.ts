/**
 * Inspector: piece properties when a piece is selected; anchor XY / handles / kind / smooth /
 * grade (active size, absolute) / seamAfter / corner when an anchor is selected.
 * Every length is typed in the display unit (decimal or fraction).
 */
import { absoluteOffset, type CornerType, type Anchor } from '@prowdcad/kernel';
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { lengthInput, numberInput, textInput, selectInput, checkbox, row, unitTag } from './widgets';
import { resolveFor, contourById, layoutOf, setAbsGradeRaw } from '../geometry';
import { ops } from '../ops-bridge';
import { reportError } from '../commands';
import { cornerGallery } from '../actions/seam-notch';
import { fmt, unitLabel } from '../units-ui';
import { spanLength, gradeSegment, totalLength } from '@prowdcad/kernel';
import { liveInspector } from './live-inspector';
import { lockInteractive, lockDetail, LOCK_KINDS, LOCK_MEASURES, type LockKind } from '../actions/lock-cmds';
import type { Piece, Contour, LockMeasure } from '@prowdcad/kernel';

export function renderInspector(app: App, host: HTMLElement) {
  clear(host);
  const pa = app.primaryAnchor();
  if (pa) { anchorInspector(app, host, pa); return; }
  const live = app.currentLive();
  if (live) { liveInspector(app, host, live); return; }
  const piece = app.primaryPiece();
  if (piece) {
    selectionSummary(app, host);
    const si = app.sel.internals[app.sel.internals.length - 1];
    const ip = si && (app.sel.primary === 'internal' || !app.sel.segments.length) ? app.doc.style.pieces.find(x => x.id === si.pieceId) : undefined;
    const ic = ip?.internals.find(x => x.id === si.contourId);
    if (ip && ic) internalLockSection(app, host, ip, ic);
    pieceInspector(app, host, piece.id); return;
  }
  host.append(h('div.empty', {}, 'Nothing selected. Click a piece or a point.'));
}

/** Segments / internal lines / notches / marks selected: what they are (and segment lengths). */
function selectionSummary(app: App, host: HTMLElement) {
  const s = app.sel;
  const n = s.segments.length + s.internals.length + s.notches.length + s.marks.length;
  if (!n) return;
  host.append(h('div.insp-title', {}, n === 1 ? 'Selected' : `Selected · ${n} items`));
  for (const g of s.segments.slice(-6)) {
    const p = app.doc.style.pieces.find(x => x.id === g.pieceId); if (!p) continue;
    const c = g.contourId === p.sew.id ? p.sew : p.internals.find(x => x.id === g.contourId); if (!c) continue;
    const i = c.points.findIndex(a => a.id === g.from) + 1, j = c.points.findIndex(a => a.id === g.to) + 1;
    let L = NaN; try { L = ops.measureSegment(app.doc, p.id, c.id, g.from, g.to, app.sizeOf(p)); } catch { /* */ }
    host.append(row(`Segment ${i}→${j}`, h('span.val', {}, `${fmt(L)} ${unitLabel()} · ${p.name}`)));
  }
  for (const g of s.internals.slice(-6)) {
    const p = app.doc.style.pieces.find(x => x.id === g.pieceId); const k = p ? p.internals.findIndex(x => x.id === g.contourId) : -1;
    if (p && k >= 0) host.append(row(`Internal ${k + 1}`, h('span.val', {}, `${fmt(totalLength(resolveFor(app.doc, p, app.sizeOf(p)).internals[k]))} ${unitLabel()} · ${p.name}`)));
  }
  if (s.notches.length) host.append(row('Notches', h('span.val', {}, String(s.notches.length))));
  if (s.marks.length) host.append(row('Drills / texts', h('span.val', {}, String(s.marks.length))));
}

/** Lock of a selected internal line to the outline (ops/lock): mode, target, kept measure, offset / range, unlock. */
function internalLockSection(app: App, host: HTMLElement, piece: Piece, c: Contour) {
  const k = piece.internals.indexOf(c) + 1;
  const L = c.lock;
  const run = (label: string, fn: () => unknown) => { try { const r = fn(); if (r instanceof Promise) r.catch(err => reportError(err, label)); } catch (err) { reportError(err, label); } };
  const kind: LockKind = L?.kind ?? 'none';
  const kinds = LOCK_KINDS.filter(([v]) => !(c.closed && (v === 'ends' || v === 'parallel')));
  host.append(h('div.insp-title', {}, `Internal ${k} · lock to outline`),
    row('Lock', selectInput(kind, kinds, v => run('Lock', () => lockInteractive(app, piece, c, v as LockKind))), L ? h('span.lock-badge', { title: 'Locked to the sew line' }, '🔒') : ''));
  if (!L) {
    host.append(h('div.insp-hint', {}, c.closed ? 'Follow point: the shape moves with a sew point in every size (pockets).' : 'Endpoints: ends on the outline stay on their segment · Parallel: exact offset of a segment · Follow: moves with a sew point.'));
    return;
  }
  host.append(row('Locked to', h('span.val', { title: ops.lockSummary(piece, c) }, lockDetail(app, piece, c))));
  const measure: LockMeasure | null = L.kind === 'follow' ? null : L.kind === 'ends' ? L.ends[0]?.measure ?? 'ratio' : L.measure;
  if (measure) host.append(row('Keep position', selectInput(measure, LOCK_MEASURES, v => run('Lock measure', () => ops.setLockMeasure(app.doc, piece.id, c.id, v as LockMeasure)))));
  if (L.kind === 'parallel') {
    host.append(row('Offset (+ inside)', lengthInput(L.offset, v => run('Offset', () => ops.setLockOffset(app.doc, piece.id, c.id, v))), unitTag()));
    const pct = L.measure === 'ratio';
    const field = (val: number, set: (v: number) => void) => pct ? numberInput(val * 100, v => set(v / 100), { decimals: 2 }) : lengthInput(val, set);
    host.append(
      row(pct ? 'From (% of segment)' : `From (${L.measure === 'start' ? 'start' : 'end'})`, field(L.a, v => run('Range', () => ops.setLockRange(app.doc, piece.id, c.id, v, L.b))), pct ? h('span.u', {}, '%') : unitTag()),
      row(pct ? 'To (% of segment)' : `To (${L.measure === 'start' ? 'start' : 'end'})`, field(L.b, v => run('Range', () => ops.setLockRange(app.doc, piece.id, c.id, L.a, v))), pct ? h('span.u', {}, '%') : unitTag()));
  }
  host.append(row('', h('button.btn.sm', { title: L.kind === 'follow' ? 'Click the sew point the line follows' : 'Click the sew segment to lock to', onclick: () => run('Lock', () => lockInteractive(app, piece, c, L.kind, { pickTarget: true, measure: measure ?? undefined })) }, L.kind === 'follow' ? 'Pick point…' : 'Pick segment…'),
    h('button.btn.sm', { title: 'Unlock: the line keeps its geometry and its points move freely again', onclick: () => run('Unlock', () => ops.unlockInternal(app.doc, piece.id, c.id)) }, 'Unlock')));
  host.append(h('div.insp-hint', {}, L.kind === 'follow' ? 'Points cannot be moved one by one; Move Line moves the whole line.' : 'Locked points cannot be moved on their own (Unlock first). Re-applied after every edit, in every size.'));
}

function tx(app: App, label: string, fn: () => void) {
  try { app.doc.transact(label, fn); } catch (err) { reportError(err, label); }
}

function pieceInspector(app: App, host: HTMLElement, id: string) {
  const p = app.doc.piece(id);
  const r = resolveFor(app.doc, p, app.sizeOf(p));
  const L = layoutOf(p);
  const set = (label: string, fn: (pc: typeof p) => void) => tx(app, label, () => fn(app.doc.piece(id)));
  host.append(
    h('div.insp-title', {}, 'Piece'),
    row('Name', textInput(p.name, v => set('Rename piece', pc => { pc.name = v.trim() || pc.name; }))),
    row('Description', textInput(p.description ?? '', v => set('Piece description', pc => { pc.description = v; }))),
    row('Seam default', lengthInput(p.seamDefault, v => set('Seam default', pc => { pc.seamDefault = v; }), { min: 0 }), unitTag()),
    row('No seam', checkbox(p.noSeam, v => set('No seam', pc => { pc.noSeam = v; }))),
    row('Lock grading', checkbox(p.lockGrading, v => { try { ops.setLockGrading(app.doc, id, v); } catch (err) { reportError(err, 'Lock grading'); } })),
    row('Cut line', h('span.val', {}, p.cutMode === 'manual' ? 'manual' : 'auto')),
    row('Locked', checkbox(p.locked, v => { try { ops.lockPiece(app.doc, id, v); } catch (err) { reportError(err, 'Lock'); } })),
    row('Position X', lengthInput(L.x, v => set('Move piece', pc => { pc.layout = { ...layoutOf(pc), x: v }; })), unitTag()),
    row('Position Y', lengthInput(L.y, v => set('Move piece', pc => { pc.layout = { ...layoutOf(pc), y: v }; })), unitTag()),
    row('Rotation', numberInput(L.angleDeg, v => set('Rotate piece', pc => { pc.layout = { ...layoutOf(pc), angleDeg: v }; })), h('span.u', {}, '°')),
    h('div.insp-title', {}, 'Order'),
    row('Material', textInput(p.order.material, v => set('Material', pc => { pc.order.material = v; }))),
    row('Qty / bundle', numberInput(p.order.qtyPerBundle, v => set('Quantity', pc => { pc.order.qtyPerBundle = Math.max(1, Math.round(v)); }), { min: 1, decimals: 0 })),
    row('Side', selectInput(p.order.side, [['none', 'none'], ['L', 'L'], ['R', 'R'], ['LR', 'L + R']], v => set('Side', pc => { pc.order.side = v as typeof pc.order.side; }))),
    row('Rotation', selectInput(p.order.rotation, [['1way', '1-way'], ['2way', '2-way'], ['4way', '4-way'], ['free', 'free']], v => set('Rotation allow', pc => { pc.order.rotation = v as typeof pc.order.rotation; }))),
    h('div.insp-title', {}, 'Info'),
    row('Points', h('span.val', {}, `${p.sew.points.length} (${p.sew.points.filter(a => a.kind === 'grade').length} grade)`)),
    row('Sew perimeter', h('span.val', {}, `${fmt(totalLength(r.sew))} ${unitLabel()}`)),
    row('Internals', h('span.val', {}, String(p.internals.length))),
    row('Notches / drills', h('span.val', {}, `${p.notches.length} / ${p.drills.length}`)),
  );
}

function anchorInspector(app: App, host: HTMLElement, pa: NonNullable<ReturnType<App['primaryAnchor']>>) {
  const { piece, contour, anchor: a, index, ref } = pa;
  const line = app.sizeLine();
  const active = app.sizeOf(piece);
  const isBase = active === line.baseSizeId;
  const res = resolveFor(app.doc, piece, active);
  const ci = contour === piece.sew ? -1 : piece.internals.indexOf(contour);
  const rc = ci < 0 ? res.sew : res.internals[ci];
  const pos = rc.anchorPos[index];
  const set = (label: string, fn: (an: Anchor) => void) => tx(app, label, () => {
    const pc = app.doc.piece(ref.pieceId); const c = contourById(pc, ref.contourId)!; const an = c.points.find(q => q.id === ref.anchorId)!;
    fn(an);
  });
  const sizeName = line.sizes.find(s => s.id === active)?.name ?? '';
  const where = contour === piece.sew ? 'sew line' : `internal ${piece.internals.indexOf(contour) + 1}`;
  const multi = app.sel.anchors.length > 1 ? ` (+${app.sel.anchors.length - 1} more)` : '';
  host.append(h('div.insp-title', {}, `Point ${index + 1} · ${piece.name} · ${where}${multi}`));
  if (piece.locked) host.append(h('div.warnline', {}, 'Piece is locked — values are read-only.'));
  const lockNote = contour !== piece.sew && contour.lock ? (() => { try { return ops.lockSummary(piece, contour); } catch { return 'locked'; } })() : '';
  const lockDriven = !!lockNote && (contour.lock?.kind === 'follow' || (() => { try { return ops.isLockDriven(piece, contour.id, a.id); } catch { return false; } })());
  if (lockNote) host.append(h('div.warnline', {}, `🔒 Line locked: ${lockNote}${lockDriven ? ' — this point follows the outline (Unlock the line to edit it)' : ''}`));
  const ro = piece.locked || !!a.flags.locked || lockDriven;

  // position: base size edits the anchor; other sizes edit its grading for that size
  // Same op as Move Point / Move XY (ops.movePoint): point connections follow, and on a non-base size
  // only that size's grading changes. The untouched axis gets a zero delta (never rounded).
  const setPos = (axis: 'x' | 'y', v: number) => {
    const d = v - pos[axis];
    if (Math.abs(d) < 1e-12) return;
    try { ops.movePoint(app.doc, ref.pieceId, ref.anchorId, axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d }, { sizeId: isBase ? undefined : active }); } catch (err) { reportError(err, `Point ${axis.toUpperCase()}`); }
  };
  host.append(
    row(`X${isBase ? '' : ` (${sizeName})`}`, lengthInput(pos.x, v => setPos('x', v), { readOnly: ro }), unitTag()),
    row(`Y${isBase ? '' : ` (${sizeName})`}`, lengthInput(pos.y, v => setPos('y', v), { readOnly: ro }), unitTag()),
    row('Name', textInput(a.name ?? '', v => set('Point name', an => { an.name = v || undefined; }), 'e.g. 03 Hip/m')),
    // through the kernel op: curve → grade materialises its current grading (no jump in graded sizes)
    row('Kind', selectInput(a.kind, [['grade', 'Grade point'], ['curve', 'Curve point']], v => { if (v === a.kind) return; try { ops.togglePointKind(app.doc, ref.pieceId, ref.anchorId); } catch (err) { reportError(err, 'Point kind'); } })),
    row('Smooth', checkbox(a.smooth, v => set('Smooth', an => { an.smooth = v; if (!v) { delete an.hIn; delete an.hOut; } }))),
    row('Locked', checkbox(!!a.flags.locked, v => set('Lock point', an => { an.flags.locked = v || undefined; }))),
  );
  if (a.kind === 'curve') {
    const pinned = Object.keys(a.grade ?? {}).length > 0;
    host.append(row('Grading', h('span.val', { title: pinned ? 'Own grading: keeps its position in every size when a neighbouring grade point moves' : 'No own grading: in graded sizes it is placed between its neighbouring grade points, so it moves when they move' }, pinned ? 'Pinned (own) ' : 'Follows neighbours '),
      ro ? '' : h('button.btn.sm', { title: pinned ? 'Unpin: follow the neighbouring grade points again' : 'Pin (keep position): give it its own grading', onclick: () => { try { ops.pinCurvePoints(app.doc, ref.pieceId, [ref.anchorId], !pinned); } catch (err) { reportError(err, 'Pin'); } } }, pinned ? 'Unpin' : 'Pin')));
  }
  // handles
  host.append(h('div.insp-title', {}, 'Handles'));
  const hh = rc.handles[index];
  for (const which of ['hIn', 'hOut'] as const) {
    const explicit = a[which];
    const abs = which === 'hIn' ? hh.hIn : hh.hOut;
    const rel = explicit ?? { x: abs.x - pos.x, y: abs.y - pos.y };
    const L = Math.hypot(rel.x, rel.y), ang = Math.atan2(rel.y, rel.x) * 180 / Math.PI;
    const setH = (len: number, deg: number) => set(`Handle ${which}`, an => {
      const r = deg * Math.PI / 180; an[which] = { x: len * Math.cos(r), y: len * Math.sin(r) };
      if (len > 0) an.smooth = an.smooth || !!(an.hIn && an.hOut);
    });
    host.append(row(`${which === 'hIn' ? 'In' : 'Out'}${explicit ? '' : ' (auto)'}`,
      lengthInput(L, v => setH(v, ang), { readOnly: ro, title: 'Handle length' }), unitTag(),
      numberInput(ang, v => setH(L, v), { decimals: 2, title: 'Handle angle (°)' }), h('span.u', {}, '°'),
      explicit ? h('button.mini', { title: 'Reset to automatic (Catmull-Rom)', onclick: () => set('Reset handle', an => { delete an[which]; }) }, '↺') : ''));
  }

  // grading (grade anchors + curve points with explicit grade)
  if (a.kind === 'grade' || Object.keys(a.grade ?? {}).length) {
    host.append(h('div.insp-title', {}, `Grade (absolute, ${unitLabel()})`));
    const tbl = h('table.gtbl');
    tbl.append(h('tr', {}, h('th', {}, 'Size'), h('th', {}, 'dX'), h('th', {}, 'dY')));
    for (const s of line.sizes) {
      const off = absoluteOffset(a.grade, line, s.id);
      const base = s.id === line.baseSizeId;
      // values are in the anchor's grade-axis frame (what is stored), so write them raw
      const setG2 = (axis: 'x' | 'y', v: number) => set('Edit grade', an => setAbsGradeRaw(an, line, s.id, axis, v));
      tbl.append(h('tr' + (s.id === active ? '.cur' : ''), {}, h('td', {}, s.name + (base ? ' ★' : '')),
        h('td', {}, base ? h('span.val', {}, '0') : lengthInput(off.x, v => setG2('x', v), { readOnly: ro })),
        h('td', {}, base ? h('span.val', {}, '0') : lengthInput(off.y, v => setG2('y', v), { readOnly: ro }))));
    }
    host.append(tbl);
    host.append(row('Grade axis', numberInput(a.gradeAxisDeg ?? 0, v => set('Grade axis', an => { an.gradeAxisDeg = v || undefined; }), { decimals: 2 }), h('span.u', {}, '°')));
  }

  // seam & corner (sew-line grade anchors)
  if (contour === piece.sew && a.kind === 'grade') {
    const k = rc.gradeIdx.indexOf(index);
    let segInfo = '';
    if (k >= 0) { const [s0, s1] = gradeSegment(rc, k); segInfo = `${fmt(spanLength(rc, s0, s1))} ${unitLabel()}`; }
    host.append(h('div.insp-title', {}, 'Seam'),
      row('Segment length', h('span.val', {}, segInfo)),
      row('Seam after', lengthInput(a.seamAfter ?? piece.seamDefault, v => { try { ops.reseamSegment(app.doc, ref.pieceId, ref.anchorId, v); } catch (err) { reportError(err, 'Seam'); } }, { readOnly: ro, title: 'Seam of the segment leaving this point (negative = inward)' }), unitTag(),
        a.seamAfter != null ? h('button.mini', { title: 'Use piece default', onclick: () => set('Seam allowance', an => { delete an.seamAfter; }) }, '↺') : ''),
      row('Corner', h('button.btn.sm', { title: 'Corner type gallery', onclick: (e: Event) => { const b = (e.target as HTMLElement).getBoundingClientRect(); void cornerGallery(app, ref, { x: b.left, y: b.bottom + 4 }); } },
        a.corner ? `${a.corner.type}${a.corner.extend ? ' · ' + a.corner.extend : ''}` : 'miter'),
        a.corner ? h('button.mini', { title: 'Revert to miter', onclick: () => { try { ops.revertCorner(app.doc, ref.pieceId, ref.anchorId); } catch (err) { reportError(err, 'Revert corner'); } } }, '↺') : ''),
      row('Start point', checkbox(!!a.flags.startPoint, v => { if (v) { try { ops.setStartPoint(app.doc, ref.pieceId, ref.anchorId); } catch (err) { reportError(err, 'Start point'); } } })),
      ...(a.ruleId ? [row('Rule', h('span.val', {}, (() => { try { return ops.ruleName(app.doc, ref.pieceId, ref.anchorId); } catch { return a.ruleId!; } })()))] : []),
    );
  }
}
