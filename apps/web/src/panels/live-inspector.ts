/**
 * Inspector sections for the selected live object (app.currentLive()): dart, pleat, fullness record.
 * Every edit goes through one kernel op (one undo step).
 */
import type { Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { h } from '../ui/dom';
import { lengthInput, selectInput, checkbox, row, unitTag } from './widgets';
import { ops } from '../ops-bridge';
import { reportError, runCommand } from '../commands';
import { fmt, unitLabel } from '../units-ui';
import type { LiveRef } from '../live';
import { copyDartOf, removeDartFlow, deleteLive, hasDartClip } from '../actions/live-cmds';
import { selectLive } from '../live';

const btn = (label: string, title: string, fn: () => unknown) =>
  h('button.btn.sm', { title, onclick: () => { try { const r = fn(); if (r instanceof Promise) r.catch(err => reportError(err, label)); } catch (err) { reportError(err, label); } } }, label);
const val = (s: string) => h('span.val', {}, s);
/** small per-size table (current size highlighted) */
function sizeTable(head: string[], rows: { cur: boolean; cells: string[] }[]): HTMLElement {
  return h('table.gtbl', { style: 'margin:4px 0' },
    h('tr', {}, ...head.map(x => h('th', {}, x))),
    ...rows.map(r => h('tr' + (r.cur ? '.cur' : ''), {}, ...r.cells.map(c => h('td', {}, c)))));
}
const wrap = (...els: HTMLElement[]) => h('div.insp-btns', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin:4px 0' }, ...els);

export function liveInspector(app: App, host: HTMLElement, ref: LiveRef) {
  const piece = app.doc.piece(ref.pieceId);
  const ro = piece.locked;
  const call = (label: string, fn: () => void) => { try { fn(); } catch (err) { reportError(err, label); } };
  if (ro) host.append(h('div.warnline', {}, 'Piece is locked — values are read-only.'));

  if (ref.kind === 'dart') {
    const d = piece.darts.find(x => x.id === ref.id)!;
    let info: ReturnType<typeof ops.dartInfo> | null = null;
    try { info = ops.dartInfo(app.doc, piece.id, d.id, app.sizeOf(piece)); } catch { /* */ }
    const base = (() => { try { return ops.dartInfo(app.doc, piece.id, d.id); } catch { return null; } })();
    const k = piece.darts.indexOf(d) + 1;
    host.append(h('div.insp-title', {}, `Dart ${k}${d.name ? ' · ' + d.name : ''} · ${piece.name}`));
    host.append(
      row('Width', d.closed ? val(`closed (${fmt(d.rememberedWidth ?? 0)} ${unitLabel()})`) : lengthInput(base?.width ?? 0, v => call('Dart width', () => {
        // reopen-by-value semantics on an open dart: close, then reopen at the new width (scaled about the midpoint, Fix Dart)
        app.doc.transact('Dart width', () => { ops.closeDart(app.doc, piece.id, d.id); ops.openDart(app.doc, piece.id, d.id, v); });
      }), { min: 0.01, readOnly: ro }), unitTag()),
      row('Depth', lengthInput(base?.depth ?? 0, v => call('Dart depth', () => ops.setDartDepth(app.doc, piece.id, d.id, v)), { min: 0.01, readOnly: ro || d.closed }), unitTag()),
      row('Fold toward', selectInput(d.fold, [['A', 'Leg A'], ['B', 'Leg B']], v => call('Dart fold', () => ops.setDartFold(app.doc, piece.id, d.id, v as 'A' | 'B')))),
      row('Drill offset', lengthInput(d.drillOffset, v => call('Dart drill', () => ops.setDartDrillOffset(app.doc, piece.id, d.id, v)), { min: 0, readOnly: ro }), unitTag()),
      row('Closed', checkbox(d.closed, () => call('Close / reopen dart', () => ops.toggleDartClosed(app.doc, { pieceId: piece.id, dartId: d.id })))),
      row('Cutting dart', checkbox(!!d.cutting, v => call('Cutting dart', () => ops.setDartCutting(app.doc, piece.id, d.id, v)))),
      ...(d.cutting ? [row('Seam on legs', lengthInput(d.cutSeam ?? 0, v => call('Cutting dart seam', () => ops.setDartCutting(app.doc, piece.id, d.id, true, v)), { min: 0, readOnly: ro }), unitTag())] : []),
    );
    if (info) {
      const dl = Math.abs(info.legLengthA - info.legLengthB), eq = dl < 0.01;
      host.append(
        h('div.insp-title', {}, `Measures (${app.sizeLine().sizes.find(s => s.id === app.sizeOf(piece))?.name ?? ''})`),
        row('Legs A / B', val(`${fmt(info.legLengthA)} / ${fmt(info.legLengthB)} ${unitLabel()}`), h('span', { style: `margin-left:6px;font-weight:700;color:${eq ? '#1e8449' : '#c0392b'}`, title: eq ? 'The legs are equal' : 'The legs differ: Fix dart slides them until equal', 'data-legs-equal': eq ? '1' : '0' }, eq ? '✓ equal' : `Δ ${fmt(dl)}`)),
        row('Width / depth', val(`${fmt(info.width)} / ${fmt(info.depth)} ${unitLabel()}`)),
        row('Sew, darts closed', val(`${fmt(ops.dartClosedPerimeter(piece, app.doc.sizeLine(piece), app.sizeOf(piece)))} ${unitLabel()}`)),
      );
      // per size (graded with the legs; the apex grades as their mean)
      const line = app.doc.sizeLine(piece), cur = app.sizeOf(piece);
      const rows = app.doc.sizesOf(piece).map(sid => { try { const g = ops.dartInfo(app.doc, piece.id, d.id, sid); return { cur: sid === cur, cells: [line.sizes.find(x => x.id === sid)?.name ?? sid, fmt(g.width), fmt(g.depth), fmt(g.legLengthA), fmt(g.legLengthB)] }; } catch { return null; } }).filter(Boolean) as { cur: boolean; cells: string[] }[];
      if (rows.length > 1) host.append(h('div.insp-title', {}, `Per size (${unitLabel()})`), sizeTable(['Size', 'Width', 'Depth', 'Leg A', 'Leg B'], rows));
    }
    host.append(h('div.insp-title', {}, 'Dart tools'), wrap(
      btn('Edit…', 'Width, depth, fold and drill in one dialog (also: right-click the dart)', () => runCommand('dart.edit')),
      btn('Flip fold', 'Fold this dart toward the other leg', () => ops.setDartFold(app.doc, piece.id, d.id, d.fold === 'A' ? 'B' : 'A')),
      btn('Fix dart', 'Slide both legs (width kept) until the legs are equal', () => ops.fixDart(app.doc, piece.id, d.id)),
      btn('Change darts', 'Flip the fold of every dart (all pieces)', () => ops.changeDarts(app.doc)),
      btn('Copy', 'Copy this dart', () => copyDartOf(app, ref)),
      btn('Paste…', 'Paste the copied dart on a clicked sew line (any piece)', () => { if (!hasDartClip()) throw new Error('Copy a dart first'); return runCommand('dart.paste'); }),
      btn('Pivot transfer…', 'Click the target on the contour, then the percentage', () => runCommand('dart.transfer')),
      btn('Rotate around centre…', 'Transfer about an offset centre (two darts, one apex)', () => runCommand('dart.rotateCenter')),
      btn('Cut all', 'Make every dart of this piece a cutting dart', () => ops.cutAllDarts(app.doc, piece.id, true)),
      btn('Remove (restore)', 'Remove the dart and restore the contour', () => removeDartFlow(app, ref, false)),
      btn('Remove (keep fullness)', 'Remove the dart; the opening stays in the contour', () => removeDartFlow(app, ref, true)),
    ));
    if (piece.darts.length > 1) host.append(row('Other darts', selectInput(d.id, piece.darts.map((x, i) => [x.id, `Dart ${i + 1}${x.closed ? ' (closed)' : ''}`] as [string, string]), v => selectLive(app, { kind: 'dart', pieceId: piece.id, id: v as Id }))));
    return;
  }

  if (ref.kind === 'pleat') {
    const p = piece.pleats.find(x => x.id === ref.id)!;
    const set = (label: string, a: Parameters<typeof ops.setPleatAttributes>[3]) => call(label, () => ops.setPleatAttributes(app.doc, piece.id, p.id, a));
    host.append(h('div.insp-title', {}, `Pleat ${piece.pleats.indexOf(p) + 1}${p.name ? ' · ' + p.name : ''} · ${piece.name} · ${p.open ? 'open' : 'closed'}`));
    host.append(
      row('Type', selectInput(p.type, [['knife', 'Knife (2 × depth)'], ['box', 'Box (4 × depth)'], ['inverted', 'Inverted box (4 × depth)']], v => set('Pleat type', { type: v as 'box' | 'knife' | 'inverted' }))),
      row('Depth at start', lengthInput(p.depthStart, v => set('Pleat depth', { depthStart: v }), { min: 0, readOnly: ro, title: 'Depth at the first-clicked end of the pleat line (taper: start ≠ end)' }), unitTag()),
      row('Depth at end', lengthInput(p.depthEnd, v => set('Pleat depth', { depthEnd: v }), { min: 0, readOnly: ro, title: 'Depth at the second-clicked end' }), unitTag()),
      row('Fold', selectInput(p.fold, [['right', 'Right'], ['left', 'Left']], v => set('Pleat fold', { fold: v as 'left' | 'right' }))),
      row('Moving side', selectInput(p.moveSide ?? 'right', [['right', 'Right of start → end'], ['left', 'Left']], v => set('Pleat side', { moveSide: v as 'left' | 'right' }))),
      row('Auto notches', checkbox(p.autoNotches, v => set('Pleat notches', { autoNotches: v }))),
      row('Notch at', selectInput(p.notchAt ?? 'start', [['start', 'Start'], ['end', 'End'], ['both', 'Both']], v => set('Pleat notches', { notchAt: v as 'start' }))),
      row('Fabric', val(`${fmt(ops.pleatFabric(p.type, p.depthStart))} → ${fmt(ops.pleatFabric(p.type, p.depthEnd))} ${unitLabel()}${p.depthStart !== p.depthEnd ? ' (tapered)' : ''}`)),
      row('Pleat line', val(`${fmt(Math.hypot(p.axisEnd.x - p.axisStart.x, p.axisEnd.y - p.axisStart.y))} ${unitLabel()}`)),
    );
    if (p.open) { try { const o = ops.pleatOpenings(app.doc, piece.id, p.id); host.append(row('Openings', val(`${fmt(o.start)} / ${fmt(o.end)} ${unitLabel()}`))); } catch { /* */ } }
    host.append(wrap(
      btn('Edit…', 'Type, depths, fold, notches in one dialog (also: right-click the pleat)', () => runCommand('pleat.edit')),
      p.open ? btn('Close', 'Close this pleat (exact restore)', () => ops.closePleat(app.doc, piece.id, p.id)) : btn('Open', 'Open this pleat', () => ops.openPleat(app.doc, piece.id, p.id)),
      btn('Open all', 'Open every pleat of the piece', () => ops.openPleats(app.doc, piece.id)),
      btn('Close all', 'Close every pleat of the piece', () => ops.closePleats(app.doc, piece.id)),
      btn('Delete', 'Delete the pleat and its axis', () => deleteLive(app, ref)),
    ));
    return;
  }

  const f = (piece.fullness ?? []).find(x => x.id === ref.id)!;
  const n = f.slashAnchorIds.length / 2;
  host.append(h('div.insp-title', {}, `Slash & spread · ${piece.name}${f.dartId ? ' · Insert Dart' : ''}`));
  let openings: number[] = [];
  try { openings = ops.fullnessOpenings(app.doc, piece.id, f.id); } catch { /* */ }
  const op = f.op;
  const editW = (label: string, fn: () => void) => call(label, fn);
  host.append(
    row('Mode', val(`${(f.mode ?? 'rotate') === 'rotate' ? 'Rotate (hinged)' : 'Parallel'}${n > 1 ? ` · ${n} slashes` : ''}`)),
    row('Pivot', val('anchorId' in f.pivot ? 'hinge on the sew line' : `rotation centre inside (${fmt(f.pivot.x)}, ${fmt(f.pivot.y)})`)),
  );
  if (op && op.kind === 'single' && !ro) {
    host.append(row('Opening at slash', lengthInput(op.openA, v => editW('Fullness opening', () => ops.setFullnessOpenings(app.doc, piece.id, f.id, { openA: v })), { title: 'Edits the spread in place (exact; later spreads are re-applied)' }), unitTag()));
    if ('fromAnchor' in op.pivot && op.mode !== 'parallel') host.append(row('Opening at hinge', lengthInput(op.openB, v => editW('Fullness opening', () => ops.setFullnessOpenings(app.doc, piece.id, f.id, { openB: v })), { min: 0 }), unitTag()));
  } else if (op && op.kind === 'multi' && !ro) {
    op.widths.forEach((w, i) => host.append(row(`Slash ${i + 1}`, lengthInput(w, v => editW('Fullness opening', () => ops.setFullnessOpenings(app.doc, piece.id, f.id, { widths: op.widths.map((x, j) => (j === i ? v : x)) })), { title: 'Opening of this slash (edited in place)' }), unitTag())));
  } else host.append(row('Opening A / B', val(`${fmt(f.amounts.openA)} / ${fmt(f.amounts.openB)} ${unitLabel()}`)));
  if (f.hingeOpen !== undefined) host.append(row('Far hinge', val(`${fmt(f.hingeOpen)} ${unitLabel()}${f.hingeOpen < 0 ? ' (overlap)' : ''}`)));
  if (openings.length) host.append(row('Measured', val(openings.map(x => fmt(x)).join(' · ') + ' ' + unitLabel())));
  host.append(wrap(
    btn('Edit openings…', 'Uniform or first → last openings with a live ghost (also: right-click a slash line)', () => runCommand('fullness.edit')),
    btn('Delete (exact restore)', 'Pinch the spread closed (later spreads are re-applied)', () => deleteLive(app, ref)),
  ));
}
