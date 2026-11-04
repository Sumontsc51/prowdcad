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

export function renderInspector(app: App, host: HTMLElement) {
  clear(host);
  const pa = app.primaryAnchor();
  if (pa) { anchorInspector(app, host, pa); return; }
  const live = app.currentLive();
  if (live) { liveInspector(app, host, live); return; }
  const piece = app.primaryPiece();
  if (piece) { pieceInspector(app, host, piece.id); return; }
  host.append(h('div.empty', {}, 'Nothing selected. Click a piece or a point.'));
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
  const ro = piece.locked || !!a.flags.locked;

  // position: base size edits the anchor; other sizes edit its grading for that size
  const setPos = (axis: 'x' | 'y', v: number) => {
    if (isBase) set(`Point ${axis.toUpperCase()}`, an => { an[axis] = v; });
    else {
      const target = { ...pos, [axis]: v };
      try { ops.dragGrade(app.doc, ref.pieceId, ref.anchorId, active, target); } catch (err) { reportError(err, 'Grade'); }
    }
  };
  host.append(
    row(`X${isBase ? '' : ` (${sizeName})`}`, lengthInput(pos.x, v => setPos('x', v), { readOnly: ro }), unitTag()),
    row(`Y${isBase ? '' : ` (${sizeName})`}`, lengthInput(pos.y, v => setPos('y', v), { readOnly: ro }), unitTag()),
    row('Name', textInput(a.name ?? '', v => set('Point name', an => { an.name = v || undefined; }), 'e.g. 03 Hip/m')),
    row('Kind', selectInput(a.kind, [['grade', 'Grade point'], ['curve', 'Curve point']], v => set('Point kind', an => { an.kind = v as Anchor['kind']; }))),
    row('Smooth', checkbox(a.smooth, v => set('Smooth', an => { an.smooth = v; if (!v) { delete an.hIn; delete an.hOut; } }))),
    row('Locked', checkbox(!!a.flags.locked, v => set('Lock point', an => { an.flags.locked = v || undefined; }))),
  );
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
