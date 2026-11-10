/**
 * Cut & construct (Cut menu) and piece management (Piece menu): slash / cut along internal / H-V /
 * parallel / guideline cuts, parallel internals, shapers (arc, wave, scallop, ruffle, circular
 * skirt), trace, build, join, fold in/out, half pieces, reference block, point connections, lock,
 * layouts, versioning, merge, grain ops.
 */
import type { Vec, Id, ArcSpec, SlashOptions } from '@prowdcad/kernel';
import type { App } from '../app';
import { registerCommand } from '../commands';
import { ops } from '../ops-bridge';
import { settings, saveSettings } from '../settings';
import { showDialog, rememberedDialog, confirmDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { hasPiece, onePiece, selPieces, must, pickPointLocal } from './cmd-util';
import { runOrPick, anchorOrPick, internalOrPick, pieceOrPick } from '../selection';
import { toLocal, toWorld, layoutOf } from '../geometry';
import { screenPath } from '../hitkit';
import { screenMarker } from '../tools/common';
import { mergeFromFile } from './file';
import { fmt, unitLabel } from '../units-ui';

async function slashOpts(app: App, title: string, pieceId: Id): Promise<SlashOptions | null> {
  const p = app.doc.piece(pieceId);
  const r = await rememberedDialog('slash', { title, fields: [
    { kind: 'radio', key: 'grade', label: 'New cut points', value: 'auto', options: [{ value: 'auto', label: 'Auto grade (proportional)' }, { value: 'zero', label: 'Zero grade' }] },
    { kind: 'length', key: 'seam', label: 'Seam on new edges', value: p.seamDefault, min: 0 },
  ] });
  return r ? { gradeMode: r.grade as 'auto' | 'zero', seam: r.seam as number } : null;
}
function selectResult(app: App, ids: Id[]) { app.sel = { pieces: ids, anchors: [] }; toast(`→ ${ids.map(id => app.doc.style.pieces.find(p => p.id === id)?.name ?? id).join(' + ')}`, 'ok'); }

/** Two clicked points (world) → line in a piece's local frame. */
async function pickLine(app: App, prompt1: string, prompt2: string): Promise<{ a: Vec; b: Vec }> {
  const a = await must(app, { kind: 'point', prompt: prompt1 }, 'point');
  const b = await must(app, { kind: 'point', prompt: prompt2, overlay: (ap, hov) => hov ? `<path d="${screenPath(ap, [a.w, hov])}" stroke="#16a085" stroke-width="1.4" stroke-dasharray="6 3" fill="none"/>` : '' }, 'point');
  return { a: a.w, b: b.w };
}

export function registerCutPiece(app: App) {
  const tx = (label: string, fn: () => void) => app.doc.transact(label, fn);

  // ───────────── Cut menu ─────────────
  registerCommand({ id: 'cut.slash', title: 'Slash tool', menu: 'Cut', group: 0, run: () => app.setTool('slash') });
  registerCommand({ id: 'cut.alongInternal', title: 'Cut along internal…', menu: 'Cut', group: 0, run: async () => {
    const { piece, contour } = await internalOrPick(app, 'Click the internal line to cut along');
    const o = await slashOpts(app, `Cut ${piece.name} along internal`, piece.id); if (!o) return;
    selectResult(app, ops.cutAlongInternal(app.doc, piece.id, contour.id, o));
  } });
  const hv = (dir: 'H' | 'V') => async () => {
    const ref = await anchorOrPick(app, `Cut ${dir === 'H' ? 'horizontally' : 'vertically'}: click the point`);
    const r = await rememberedDialog('cut.hv', { title: `Cut ${dir === 'H' ? 'horizontal' : 'vertical'}`, fields: [{ kind: 'length', key: 'off', label: `Offset (${dir === 'H' ? '+Y' : '+X'})`, value: 0 }] });
    if (!r) return;
    const o = await slashOpts(app, 'Cut options', ref.pieceId); if (!o) return;
    selectResult(app, ops.cutHV(app.doc, ref.pieceId, ref.anchorId, dir, r.off as number, o));
  };
  registerCommand({ id: 'cut.h', title: 'Cut horizontal at point…', menu: 'Cut', group: 0, run: hv('H') });
  registerCommand({ id: 'cut.v', title: 'Cut vertical at point…', menu: 'Cut', group: 0, run: hv('V') });
  registerCommand({ id: 'cut.parallel', title: 'Cut parallel strip…', menu: 'Cut', group: 0, run: async () => {
    const run = await runOrPick(app, 'Cut parallel: click the sew segment (waistband / facing edge)', 'sew');
    const r = await rememberedDialog('cut.parallel', { title: 'Cut parallel strip', fields: [{ kind: 'length', key: 'd', label: 'Strip width (inside)', value: 40, min: 0.01 }] });
    if (!r) return;
    const o = await slashOpts(app, 'Cut options', run.pieceId); if (!o) return;
    selectResult(app, ops.cutParallel(app.doc, run.pieceId, { from: run.from, to: run.to }, r.d as number, o));
  } });
  registerCommand({ id: 'cut.guide', title: 'Cut by guideline…', menu: 'Cut', group: 0, run: async () => {
    if (!settings.guides.length) { toast('Cut by guideline needs a guide: drag one out of a ruler first (or View ▸ Add guide…)', 'warn', 4000); return; }
    const piece = await pieceOrPick(app, 'Click the piece to cut');
    const L = layoutOf(piece);
    const gi = settings.guides.length === 1 ? 0 : await (async () => {
      const r = await showDialog({ title: 'Cut by guideline', fields: [{ kind: 'select', key: 'g', label: 'Guide', value: String(settings.guides.length - 1), options: settings.guides.map((g, i) => ({ value: String(i), label: `${g.axis === 'x' ? 'Vertical X' : 'Horizontal Y'} = ${fmt(g.pos)} ${unitLabel()}` })) }] });
      return r ? Number(r.g) : -1;
    })();
    if (gi < 0) return;
    const g = settings.guides[gi];
    const wa = g.axis === 'x' ? { x: g.pos, y: 0 } : { x: 0, y: g.pos }, wb = g.axis === 'x' ? { x: g.pos, y: 1 } : { x: 1, y: g.pos };
    void L;
    const o = await slashOpts(app, `Cut ${piece.name} along guide`, piece.id); if (!o) return;
    selectResult(app, ops.cutByGuideline(app.doc, piece.id, { a: toLocal(piece, wa), b: toLocal(piece, wb) }, o));
  } });
  registerCommand({ id: 'cut.parallelInternal', title: 'Parallel internal line…', menu: 'Cut', group: 1, hotkey: 'Alt+Shift+P', run: async () => {
    const r0 = await must(app, { kind: 'contour', prompt: 'Parallel: click a sew segment or an internal line' }, 'contour');
    const h = r0.hit; const isSew = h.contour === h.piece.sew;
    if (isSew && (!h.from || !h.to)) throw new Error('Click between two grade points');
    const r = await rememberedDialog('cut.parInt', { title: 'Create parallel internal', fields: [
      { kind: 'length', key: 'd', label: 'Distance', value: 30, min: 0.01 },
      { kind: 'radio', key: 'side', label: 'Side', value: '1', options: [{ value: '1', label: isSew ? 'Inside the piece' : 'Left of travel' }, { value: '-1', label: isSew ? 'Outside' : 'Right of travel' }] },
      { kind: 'checkbox', key: 'ext', label: 'Extend / trim ends to the perimeter', value: true },
      { kind: 'checkbox', key: 'dash', label: 'Dashed', value: false },
      ...(isSew ? [{ kind: 'checkbox' as const, key: 'lock', label: 'Lock parallel to the segment (follows it in every size)', value: true, hint: 'Ignored with “Extend / trim ends”' }] : []),
    ] });
    if (!r) return;
    ops.createParallelInternal(app.doc, h.piece.id, isSew ? { from: h.from!, to: h.to! } : { internalId: h.contour.id }, r.d as number, Number(r.side) as 1 | -1, { extendToContour: !!r.ext, style: r.dash ? 'dashed' : 'solid', lock: isSew && !!r.lock && !r.ext });
  } });
  registerCommand({ id: 'cut.extendParallel', title: 'Extend / shrink parallel…', menu: 'Cut', group: 1, run: async () => {
    const run = await runOrPick(app, 'Click the sew segment to move parallel', 'sew');
    const r = await rememberedDialog('cut.extPar', { title: 'Extend / shrink parallel', fields: [{ kind: 'length', key: 'a', label: 'Amount (+ grow, − shrink)', value: 10 }] });
    if (r) ops.extendParallel(app.doc, [{ pieceId: run.pieceId, from: run.from, to: run.to }], r.a as number);
  } });
  // shapers
  registerCommand({ id: 'shape.arc', title: 'Arc…', menu: 'Cut/Shapers', run: async () => {
    const run = await runOrPick(app, 'Arc: click the segment to replace');
    const r = await rememberedDialog('shape.arc', { title: 'Arc', fields: [
      { kind: 'select', key: 'by', label: 'Defined by', value: 'depth', options: [{ value: 'depth', label: 'Depth (sagitta, + outward)' }, { value: 'radius', label: 'Radius' }, { value: 'length', label: 'Arc length' }, { value: 'through', label: 'Through a point (click)' }] },
      { kind: 'length', key: 'v', label: 'Value', value: 20 },
      { kind: 'checkbox', key: 'major', label: 'Major arc (radius)', value: false },
      { kind: 'radio', key: 'side', label: 'Side', value: '1', options: [{ value: '1', label: 'Outward / left' }, { value: '-1', label: 'Inward / right' }] },
    ] });
    if (!r) return;
    const side = Number(r.side) as 1 | -1;
    let spec: ArcSpec;
    if (r.by === 'through') spec = { through: await pickPointLocal(app, app.doc.piece(run.pieceId), 'Arc: click a point the arc passes through') };
    else if (r.by === 'radius') spec = { radius: r.v as number, major: !!r.major, side };
    else if (r.by === 'length') spec = { length: r.v as number, side };
    else spec = { depth: side * (r.v as number) };
    const L = ops.shapeArc(app.doc, run.pieceId, run.from, run.to, spec);
    app.status(`Arc length ${fmt(L)} ${unitLabel()}`);
  } });
  registerCommand({ id: 'shape.wave', title: 'Wave…', menu: 'Cut/Shapers', run: async () => {
    const run = await runOrPick(app, 'Wave: click the segment');
    const r = await rememberedDialog('shape.wave', { title: 'Wave', fields: [
      { kind: 'number', key: 'n', label: 'Waves', value: 4, min: 0.5 }, { kind: 'length', key: 'd', label: 'Amplitude', value: 8, min: 0.01 },
      { kind: 'number', key: 'dev', label: 'Crest skew (−1…1)', value: 0, min: -1, max: 1 }, { kind: 'checkbox', key: 'inv', label: 'Start with a trough', value: false },
    ] });
    if (r) ops.shapeWave(app.doc, run.pieceId, run.from, run.to, { count: r.n as number, depth: r.d as number, deviation: r.dev as number, invert: !!r.inv });
  } });
  registerCommand({ id: 'shape.scallop', title: 'Scallop / zigzag…', menu: 'Cut/Shapers', run: async () => {
    const run = await runOrPick(app, 'Scallop: click the segment');
    const r = await rememberedDialog('shape.scallop', { title: 'Scallop', fields: [
      { kind: 'radio', key: 'by', label: 'By', value: 'count', options: [{ value: 'count', label: 'Count' }, { value: 'width', label: 'Width' }] },
      { kind: 'number', key: 'n', label: 'Count', value: 6, min: 1 }, { kind: 'length', key: 'w', label: 'Width', value: 40, min: 0.1 },
      { kind: 'length', key: 'd', label: 'Depth (0 = semicircle)', value: 0, min: 0 },
      { kind: 'select', key: 'partial', label: 'Partial scallop', value: 'none', options: ['none', 'start', 'end', 'both'].map(v => ({ value: v, label: v })) },
      { kind: 'checkbox', key: 'zig', label: 'Zigzag', value: false },
    ] });
    if (!r) return;
    const sol = ops.shapeScallop(app.doc, run.pieceId, run.from, run.to, { ...(r.by === 'count' ? { count: Math.round(r.n as number) } : { width: r.w as number }), depth: (r.d as number) > 0 ? r.d as number : undefined, partial: r.partial as 'none', zigzag: !!r.zig });
    app.status(`${sol.count} scallops × ${fmt(sol.width)} ${unitLabel()}`);
  } });
  registerCommand({ id: 'shape.ruffle', title: 'Ruffle strip…', menu: 'Cut/Shapers', run: async () => {
    const run = await runOrPick(app, 'Ruffle: click the segment the ruffle is sewn to');
    const r = await rememberedDialog('shape.ruffle', { title: 'Ruffle', fields: [
      { kind: 'number', key: 'f', label: 'Fullness (× length)', value: 2, min: 1 }, { kind: 'length', key: 'w', label: 'Strip width', value: 60, min: 0.1 },
      { kind: 'number', key: 's', label: 'Notched sections', value: 4, min: 1 }, { kind: 'text', key: '_name', label: 'Name', value: 'RUFFLE' },
    ] });
    if (r) selectResult(app, [ops.ruffle(app.doc, run.pieceId, run.from, run.to, { fullness: r.f as number, width: r.w as number, sections: Math.round(r.s as number), name: String(r._name) })]);
  } });
  registerCommand({ id: 'shape.circular', title: 'Circular skirt…', menu: 'Cut/Shapers', run: async () => {
    const r = await rememberedDialog('shape.circ', { title: 'Circular skirt', fields: [
      { kind: 'length', key: 'waist', label: 'Waist (whole skirt)', value: 700, min: 1 }, { kind: 'length', key: 'len', label: 'Skirt length', value: 600, min: 1 },
      { kind: 'number', key: 'sweep', label: 'Sweep', value: 360, min: 1, max: 720, suffix: '°' }, { kind: 'number', key: 'panels', label: 'Panels (0 = auto)', value: 0, min: 0 },
      { kind: 'text', key: '_name', label: 'Name', value: 'SKIRT' },
    ] });
    if (r) selectResult(app, ops.circularSkirt(app.doc, { waist: r.waist as number, length: r.len as number, sweepDeg: r.sweep as number, panels: (r.panels as number) > 0 ? Math.round(r.panels as number) : undefined, name: String(r._name), at: app.view.toWorld({ x: app.view.W / 2, y: app.view.H / 2 }) }));
  } });
  // construct pieces
  registerCommand({ id: 'cut.trace', title: 'Trace segments tool', menu: 'Cut', group: 2, run: () => app.setTool('trace') });
  registerCommand({ id: 'cut.build', title: 'Build piece from region', menu: 'Cut', group: 2, hotkey: 'Alt+B', run: async () => {
    const r = await must(app, { kind: 'piece', prompt: 'Build piece: click inside a region bounded by internal lines' }, 'piece');
    const n = await rememberedDialog('cut.build', { title: 'Build piece', fields: [{ kind: 'text', key: '_name', label: 'Name', value: `${r.piece.name} PART` }] });
    if (n) selectResult(app, [ops.buildPiece(app.doc, r.piece.id, toLocal(r.piece, r.w), { name: String(n._name) })]);
  } });
  registerCommand({ id: 'cut.join', title: 'Join pieces…', menu: 'Cut', group: 2, hotkey: 'Alt+J', run: async () => {
    const a = await must(app, { kind: 'contour', prompt: 'Join: click the seam segment on piece A (stays)', contour: 'sew' }, 'contour');
    if (!a.hit.from || !a.hit.to) throw new Error('Click between two grade points');
    const b = await must(app, { kind: 'contour', prompt: 'Join: click the matching seam segment on piece B (moves)', contour: 'sew', excludePieceId: a.hit.piece.id }, 'contour');
    if (!b.hit.from || !b.hit.to) throw new Error('Click between two grade points');
    const r = await rememberedDialog('cut.join', { title: 'Join pieces', fields: [
      { kind: 'radio', key: 'anchor', label: 'Unequal lengths: align', value: 'first', options: [{ value: 'first', label: 'First end' }, { value: 'last', label: 'Last end' }] },
      { kind: 'checkbox', key: 'align', label: 'Align only (do not merge)', value: false },
      { kind: 'checkbox', key: 'keep', label: 'Keep seam as dashed internal', value: true },
    ] });
    if (!r) return;
    selectResult(app, [ops.joinPieces(app.doc, a.hit.piece.id, { from: a.hit.from, to: a.hit.to }, b.hit.piece.id, { from: b.hit.from, to: b.hit.to }, { anchor: r.anchor as 'first', alignOnly: !!r.align, keepSeamLine: !!r.keep })]);
  } });
  registerCommand({ id: 'cut.foldIn', title: 'Fold in…', menu: 'Cut', group: 3, run: async () => {
    const piece = await pieceOrPick(app, 'Fold in: click the piece');
    const ln = await pickLine(app, 'Fold in: click the 1st point of the fold line', 'Fold in: click the 2nd point of the fold line');
    const keep = await must(app, { kind: 'point', prompt: 'Fold in: click the side to KEEP' }, 'point');
    const r = await rememberedDialog('cut.fold', { title: 'Fold in', fields: [{ kind: 'length', key: 'seam', label: 'Seam on the fold edge', value: 0, min: 0 }] });
    if (r) ops.foldIn(app.doc, piece.id, { a: toLocal(piece, ln.a), b: toLocal(piece, ln.b) }, { keep: toLocal(piece, keep.w), seam: r.seam as number });
  } });
  registerCommand({ id: 'cut.foldOut', title: 'Fold out (mirror internal)…', menu: 'Cut', group: 3, run: async () => {
    const { piece, contour } = await internalOrPick(app, 'Fold out: click the folded internal');
    const dev = ops.symmetryCheck(app.doc, piece.id, contour.id);
    if (!(await confirmDialog('Fold out', `Symmetry deviation before fold-out: ${fmt(dev)} ${unitLabel()}.`, 'Fold out'))) return;
    ops.foldOut(app.doc, piece.id, contour.id);
  } });
  registerCommand({ id: 'cut.halfSet', title: 'Half piece: set mirror axis…', menu: 'Cut/Half piece', run: async () => {
    const piece = await pieceOrPick(app, 'Half piece: click the piece');
    const ln = await pickLine(app, 'Mirror axis: click the 1st point (on a straight sew edge)', 'Mirror axis: click the 2nd point');
    const r = await rememberedDialog('cut.half', { title: 'Half piece', fields: [{ kind: 'checkbox', key: 'open', label: 'Open automatically at plot / marker', value: true }, { kind: 'checkbox', key: 'trim', label: 'Trim the part beyond the axis', value: false }] });
    if (!r) return;
    let keep: Vec | undefined;
    if (r.trim) keep = toLocal(piece, (await must(app, { kind: 'point', prompt: 'Click the side to keep' }, 'point')).w);
    ops.setHalf(app.doc, piece.id, { a: toLocal(piece, ln.a), b: toLocal(piece, ln.b) }, { openAtOutput: !!r.open, trim: !!r.trim, keep });
  } });
  registerCommand({ id: 'cut.halfOpen', title: 'Half piece: open', menu: 'Cut/Half piece', enabled: c => !!c.app.primaryPiece()?.half, run: () => ops.openHalf(app.doc, onePiece(app).id) });
  registerCommand({ id: 'cut.halfDelete', title: 'Half piece: delete spec', menu: 'Cut/Half piece', enabled: c => !!c.app.primaryPiece()?.half, run: () => ops.deleteHalf(app.doc, onePiece(app).id) });

  // ───────────── Piece menu ─────────────
  registerCommand({ id: 'piece.rename', title: 'Rename…', menu: 'Piece', group: 0, enabled: hasPiece, run: async () => {
    const p = onePiece(app);
    const r = await showDialog({ title: 'Rename piece', fields: [{ kind: 'text', key: 'n', label: 'Name', value: p.name }] });
    if (r && String(r.n).trim()) tx('Rename piece', () => { p.name = String(r.n).trim(); });
  } });
  registerCommand({ id: 'piece.lock', title: 'Lock / unlock', menu: 'Piece', group: 0, hotkey: 'Ctrl+L', enabled: hasPiece, checked: c => !!c.app.primaryPiece()?.locked,
    run: () => { const v = !onePiece(app).locked; tx('Lock piece', () => selPieces(app).forEach(p => ops.lockPiece(app.doc, p.id, v))); } });
  registerCommand({ id: 'piece.rotate', title: 'Rotate…', menu: 'Piece', group: 1, enabled: hasPiece, run: async () => {
    const r = await showDialog({ title: 'Rotate piece', fields: [{ kind: 'number', key: 'a', label: 'Angle (° CCW)', value: 90, suffix: '°' }] });
    if (r) tx('Rotate piece', () => selPieces(app).forEach(p => { const L = layoutOf(p); p.layout = { ...L, angleDeg: ((L.angleDeg + (r.a as number)) % 360 + 360) % 360 }; }));
  } });
  registerCommand({ id: 'piece.rotate90', title: 'Rotate 90° CCW', menu: 'Piece', group: 1, hotkey: 'Alt+R', enabled: hasPiece,
    run: () => tx('Rotate piece', () => selPieces(app).forEach(p => { const L = layoutOf(p); p.layout = { ...L, angleDeg: (L.angleDeg + 90) % 360 }; })) });
  registerCommand({ id: 'piece.resetLayout', title: 'Reset position', menu: 'Piece', group: 1, enabled: hasPiece, run: () => tx('Reset position', () => selPieces(app).forEach(p => { delete p.layout; })) });
  registerCommand({ id: 'piece.saveLayout', title: 'Save layout…', menu: 'Piece/Layout', run: async () => { const r = await showDialog({ title: 'Save layout', fields: [{ kind: 'text', key: 'n', label: 'Name', value: 'Layout ' + (Object.keys(app.style.layouts).length + 1) }] }); if (r && String(r.n).trim()) ops.saveLayout(app.doc, String(r.n).trim()); } });
  registerCommand({ id: 'piece.restoreLayout', title: 'Restore layout…', menu: 'Piece/Layout', enabled: c => Object.keys(c.app.style.layouts).length > 0, run: async () => {
    const names = Object.keys(app.style.layouts);
    const r = await showDialog({ title: 'Restore layout', fields: [{ kind: 'select', key: 'n', label: 'Layout', value: names[names.length - 1], options: names.map(n => ({ value: n, label: n })) }] });
    if (r) toast(`${ops.restoreLayout(app.doc, String(r.n))} piece(s) placed`, 'ok');
  } });
  // grain
  registerCommand({ id: 'piece.grain', title: 'Grain angle…', menu: 'Piece/Grain', enabled: hasPiece, run: async () => {
    const p = onePiece(app);
    const ang = Math.atan2(p.grain.b.y - p.grain.a.y, p.grain.b.x - p.grain.a.x) * 180 / Math.PI;
    const r = await showDialog({ title: 'Grain line', fields: [{ kind: 'number', key: 'a', label: 'Angle (°, 90 = vertical)', value: Math.round(ang * 100) / 100, suffix: '°' }] });
    if (!r) return;
    tx('Grain line', () => {
      const mid = { x: (p.grain.a.x + p.grain.b.x) / 2, y: (p.grain.a.y + p.grain.b.y) / 2 };
      const L = Math.hypot(p.grain.b.x - p.grain.a.x, p.grain.b.y - p.grain.a.y) / 2 || 50;
      const a = (r.a as number) * Math.PI / 180;
      p.grain.a = { x: mid.x - Math.cos(a) * L, y: mid.y - Math.sin(a) * L }; p.grain.b = { x: mid.x + Math.cos(a) * L, y: mid.y + Math.sin(a) * L };
    });
  } });
  registerCommand({ id: 'piece.grainCenter', title: 'Fix grain to centre (recenter)', menu: 'Piece/Grain', enabled: hasPiece, run: () => tx('Recenter grain', () => selPieces(app).forEach(p => ops.recenterGrain(app.doc, p.id))) });
  registerCommand({ id: 'piece.grainParallel', title: 'Grain parallel to segment', menu: 'Piece/Grain', run: async () => { const run = await runOrPick(app, 'Click the segment the grain follows'); ops.grainParallelToSegment(app.doc, run.pieceId, run.from, run.to); } });
  registerCommand({ id: 'piece.rotateToGrain', title: 'Rotate piece to grain…', menu: 'Piece/Grain', enabled: hasPiece, run: async () => {
    const r = await rememberedDialog('piece.rotGrain', { title: 'Rotate piece to grain', fields: [{ kind: 'select', key: 't', label: 'Grain points', value: 'vertical', options: [{ value: 'vertical', label: 'Vertical (+Y)' }, { value: 'horizontal', label: 'Horizontal (+X)' }, { value: 'deg', label: 'Angle…' }] }, { kind: 'number', key: 'a', label: 'Angle', value: 90, suffix: '°' }] });
    if (r) tx('Rotate to grain', () => selPieces(app).forEach(p => ops.rotatePieceToGrain(app.doc, p.id, r.t === 'deg' ? r.a as number : r.t as 'vertical')));
  } });
  // reference / connections
  registerCommand({ id: 'piece.refSave', title: 'Reference block: snapshot', menu: 'Piece/Reference', enabled: hasPiece, run: async () => { const r = await showDialog({ title: 'Reference block', fields: [{ kind: 'text', key: 'n', label: 'Note', value: '' }] }); if (r) tx('Reference snapshot', () => selPieces(app).forEach(p => ops.snapshotReference(app.doc, p.id, String(r.n) || undefined))); } });
  registerCommand({ id: 'piece.refShow', title: 'Show reference blocks', menu: 'Piece/Reference', checked: () => settings.showReference, run: () => { settings.showReference = !settings.showReference; saveSettings(); } });
  registerCommand({ id: 'piece.refRestore', title: 'Restore from reference', menu: 'Piece/Reference', enabled: c => !!c.app.primaryPiece()?.reference, run: async () => { if (await confirmDialog('Restore reference', 'Replace the sew line and internals with the reference block?', 'Restore')) ops.restoreReference(app.doc, onePiece(app).id); } });
  registerCommand({ id: 'piece.refClear', title: 'Clear reference', menu: 'Piece/Reference', enabled: c => !!c.app.primaryPiece()?.reference, run: () => ops.clearReference(app.doc, onePiece(app).id) });
  registerCommand({ id: 'piece.connCheck', title: 'Point connections: global check', menu: 'Piece/Connections', enabled: hasPiece, run: () => { let c = 0, a = 0; tx('Check connections', () => selPieces(app).forEach(p => { const r = ops.globalCheckConnections(app.doc, p.id); c += r.connections; a += r.anchorsAdded; })); toast(`${c} connection(s), ${a} point(s) added`, 'ok'); } });
  registerCommand({ id: 'piece.connClear', title: 'Point connections: clear', menu: 'Piece/Connections', run: () => { const k = ops.globalClearConnections(app.doc, app.sel.pieces.length === 1 ? app.sel.pieces[0] : undefined); toast(`${k} connection(s) cleared`, 'ok'); } });
  // versioning
  registerCommand({ id: 'piece.saveAsNew', title: 'Save active as new version', menu: 'Piece/Versions', enabled: hasPiece, run: () => selectResult(app, [ops.saveActiveAsNew(app.doc, onePiece(app).id)]) });
  registerCommand({ id: 'piece.replaceOld', title: 'Replace old with selected…', menu: 'Piece/Versions', enabled: hasPiece, run: async () => {
    const repl = onePiece(app);
    const others = app.style.pieces.filter(p => p.id !== repl.id);
    if (!others.length) throw new Error('No other piece to replace');
    const r = await showDialog({ title: 'Replace old', message: `“${repl.name}” takes the slot and name of the old piece; the old piece is archived.`, fields: [{ kind: 'select', key: 'old', label: 'Old piece', value: others[0].id, options: others.map(p => ({ value: p.id, label: p.name })) }] });
    if (r) ops.replaceOld(app.doc, String(r.old), repl.id);
  } });
  registerCommand({ id: 'piece.archive', title: 'Archived versions…', menu: 'Piece/Versions', enabled: c => c.app.style.pieceArchive.length > 0, run: async () => {
    const arc = app.style.pieceArchive;
    const r = await showDialog({ title: 'Archived pieces', message: `${arc.length} archived piece(s).`, fields: [{ kind: 'select', key: 'p', label: 'Restore a copy of', value: arc[arc.length - 1].id, options: arc.map((p, i) => ({ value: p.id, label: `${i + 1}. ${p.name} (${new Date(p.updatedAt).toLocaleString()})` })) }], okLabel: 'Restore copy' });
    if (!r) return;
    const src = arc.find(p => p.id === r.p)!;
    tx('Restore archived', () => { const c = JSON.parse(JSON.stringify(src)); c.id = 'pc' + Math.random().toString(36).slice(2, 9); c.name = src.name + ' (restored)'; app.style.pieces.push(c); app.sel = { pieces: [c.id], anchors: [] }; });
  } });
  registerCommand({ id: 'piece.merge', title: 'Merge from another style…', menu: 'Piece', group: 3, run: () => mergeFromFile(app) });
  registerCommand({ id: 'piece.delete', title: 'Delete piece', menu: 'Piece', group: 4, enabled: hasPiece, run: async () => {
    if (!(await confirmDialog('Delete piece', `Delete ${app.sel.pieces.length} piece(s)?`, 'Delete'))) return;
    const ids = new Set(app.sel.pieces);
    tx('Delete piece', () => { app.style.pieces = app.style.pieces.filter(p => !ids.has(p.id)); });
  } });
  void toWorld; void screenMarker;
}
