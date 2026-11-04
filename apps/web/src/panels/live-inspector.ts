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
    if (info) host.append(
      h('div.insp-title', {}, `Measures (${app.sizeLine().sizes.find(s => s.id === app.sizeOf(piece))?.name ?? ''})`),
      row('Legs A / B', val(`${fmt(info.legLengthA)} / ${fmt(info.legLengthB)} ${unitLabel()}`)),
      row('Width / depth', val(`${fmt(info.width)} / ${fmt(info.depth)} ${unitLabel()}`)),
      row('Sew, darts closed', val(`${fmt(ops.dartClosedPerimeter(piece, app.doc.sizeLine(piece), app.sizeOf(piece)))} ${unitLabel()}`)),
    );
    host.append(h('div.insp-title', {}, 'Dart tools'), wrap(
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
      row('Type', selectInput(p.type, [['knife', 'Knife (2 × depth)'], ['box', 'Box (4 × depth)']], v => set('Pleat type', { type: v as 'box' | 'knife' }))),
      row('Depth start', lengthInput(p.depthStart, v => set('Pleat depth', { depthStart: v }), { min: 0, readOnly: ro }), unitTag()),
      row('Depth end', lengthInput(p.depthEnd, v => set('Pleat depth', { depthEnd: v }), { min: 0, readOnly: ro }), unitTag()),
      row('Fold', selectInput(p.fold, [['right', 'Right'], ['left', 'Left']], v => set('Pleat fold', { fold: v as 'left' | 'right' }))),
      row('Moving side', selectInput(p.moveSide ?? 'right', [['right', 'Right of start → end'], ['left', 'Left']], v => set('Pleat side', { moveSide: v as 'left' | 'right' }))),
      row('Auto notches', checkbox(p.autoNotches, v => set('Pleat notches', { autoNotches: v }))),
      row('Notch at', selectInput(p.notchAt ?? 'start', [['start', 'Start'], ['end', 'End'], ['both', 'Both']], v => set('Pleat notches', { notchAt: v as 'start' }))),
      row('Fabric', val(`${fmt((p.type === 'box' ? 4 : 2) * p.depthStart)} → ${fmt((p.type === 'box' ? 4 : 2) * p.depthEnd)} ${unitLabel()}`)),
    );
    if (p.open) { try { const o = ops.pleatOpenings(app.doc, piece.id, p.id); host.append(row('Openings', val(`${fmt(o.start)} / ${fmt(o.end)} ${unitLabel()}`))); } catch { /* */ } }
    host.append(wrap(
      p.open ? btn('Close', 'Close this pleat (exact restore)', () => ops.closePleat(app.doc, piece.id, p.id)) : btn('Open', 'Open this pleat', () => ops.openPleat(app.doc, piece.id, p.id)),
      btn('Open all', 'Open every pleat of the piece', () => ops.openPleats(app.doc, piece.id)),
      btn('Close all', 'Close every pleat of the piece', () => ops.closePleats(app.doc, piece.id)),
      btn('Delete', 'Delete the pleat and its axis', () => deleteLive(app, ref)),
    ));
    return;
  }

  const f = (piece.fullness ?? []).find(x => x.id === ref.id)!;
  const n = f.slashAnchorIds.length / 2;
  host.append(h('div.insp-title', {}, `Fullness · ${piece.name}${f.dartId ? ' · Insert Dart' : ''}`));
  let openings: number[] = [];
  try { openings = ops.fullnessOpenings(app.doc, piece.id, f.id); } catch { /* */ }
  host.append(
    row('Mode', val(`${f.mode ?? 'rotate'}${f.op?.kind === 'multi' ? ` · ${n} slashes` : ''}`)),
    row('Pivot', val('anchorId' in f.pivot ? 'on the contour (hinge)' : `inside (${fmt(f.pivot.x)}, ${fmt(f.pivot.y)})`)),
    row('Opening A / B', val(`${fmt(f.amounts.openA)} / ${fmt(f.amounts.openB)} ${unitLabel()}`)),
    ...(f.hingeOpen !== undefined ? [row('Far hinge', val(`${fmt(f.hingeOpen)} ${unitLabel()}${f.hingeOpen < 0 ? ' (overlap)' : ''}`))] : []),
    ...(openings.length > 1 ? [row('Openings', val(openings.map(x => fmt(x)).join(' · ')))] : []),
    wrap(btn('Delete (exact restore)', 'Pinch the spread closed (later spreads are re-applied)', () => deleteLive(app, ref))),
  );
}
