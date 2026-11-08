/**
 * Cut Point tool (X) — CLO "Add Point / Split Line" with AccuMark conventions.
 *
 *  hover any sew or internal line → a preview dot slides along the line; the grade segment under
 *  the cursor is split visually (part 1 from the segment start, part 2 to its end) with each part's
 *  length and the ratio, in the display unit. Shift = round distances (5 mm / 1/8").
 *  click            → insert a point there (grade point; Ctrl / the "Curve point" option = curve
 *                     point). The contour shape never changes.
 *  right-click or a digit while hovering → input box locked on that segment:
 *                     From start · From end · Ratio % · Divide (N equal parts → N − 1 points) ·
 *                     Every (a point every X from the start); live preview of the resulting points.
 *                     Enter / right-click = OK, Esc = cancel.
 *  options (tool-options strip): Curve point · Notch (a notch on every new point) · Zero grade
 *  (default: the new points grade proportionally, 'auto').
 *  Esc when idle = back to Select. One undo step per insertion. Works on internals and on graded
 *  sizes (lengths are measured on the active size and placed at the same ratio of the base segment).
 */
import type { Vec, Id, Piece, Contour, ResolvedContour } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool, type Ptr } from './tool';
import { contourNear } from '../hitkit';
import { ops } from '../ops-bridge';
import { resolveFor, toWorld } from '../geometry';
import { fmt, unitLabel } from '../units-ui';
import { toast } from '../ui/toast';
import { reportError } from '../commands';
import { openInputBox, inputBoxOpen, inputBoxCommit, inputBoxCancel, type IBMode } from '../ui/inputbox';
import { segmentAt, atArc, arcPoly, roundTo, label, dot, screenPoly, LIVE_COL, toolOpt, setToolOpt, trackClient, lastClient, isNumKey, totalLen, type SegAt } from './livekit';
import { fs, screenMarker } from './common';
import { sizeNameOf } from '../selection';

const T = 'cutPoint';
interface Hov { piece: Piece; contour: Contour; ci: number; rc: ResolvedContour; seg: SegAt; d: number; snapped: boolean }
const CP: { hov: Hov | null; lock: Hov | null; preview: number[] | null; err: string } = { hov: null, lock: null, preview: null, err: '' };

const optCurve = () => toolOpt(T, 'curve', false);
const optNotch = () => toolOpt(T, 'notch', false);
const optZero = () => toolOpt(T, 'zero', false);

function hoverAt(app: App, w: Vec, e: MouseEvent): Hov | null {
  const h = contourNear(app, w, { contour: 'any' });
  if (!h) return null;
  const seg = segmentAt(h.contour, h.rc, h.s);
  if (!seg || seg.L <= 1e-9) return null;
  const ci = h.contour === h.piece.sew ? -1 : h.piece.internals.indexOf(h.contour);
  let d = h.rc.closed ? ((h.s - seg.sA) % totalLen(h.rc) + totalLen(h.rc)) % totalLen(h.rc) : h.s - seg.sA;
  if (d > seg.L) d = seg.L;
  let snapped = false;
  if (e.shiftKey) {
    // round the distance from the nearer end
    const fromEnd = seg.L - d;
    d = d <= fromEnd ? roundTo(d) : seg.L - roundTo(fromEnd);
    d = Math.max(0, Math.min(seg.L, d)); snapped = true;
  }
  return { piece: h.piece, contour: h.contour, ci, rc: h.rc, seg, d, snapped };
}

/** Base-size length of the hovered segment (the kernel works in base distances). */
function baseLen(app: App, v: Hov): number {
  const rb = resolveFor(app.doc, v.piece, app.doc.baseSize(v.piece));
  const rc = v.ci < 0 ? rb.sew : rb.internals[v.ci];
  const s = segmentAt(v.contour, rc, (rc.cum[rc.anchorIndex[v.seg.iFrom]] ?? 0) + 1e-6);
  return s && s.fromId === v.seg.fromId ? s.L : v.seg.L;
}
const isBaseSize = (app: App, p: Piece) => app.sizeOf(p) === app.doc.baseSize(p);

type Spec = { kind: 'start' | 'end'; d: number } | { kind: 'pct'; p: number } | { kind: 'divide'; n: number } | { kind: 'every'; step: number };

/** Active-size distances (from the segment start) a spec produces on segment length L. */
function specDistances(L: number, sp: Spec): number[] {
  switch (sp.kind) {
    case 'start': return ops.cutPointDistances(L, { distances: [sp.d] });
    case 'end': return ops.cutPointDistances(L, { distances: [sp.d], from: 'end' });
    case 'pct': return ops.cutPointDistances(L, { pcts: [sp.p] });
    case 'divide': return ops.cutPointDistances(L, { divide: sp.n });
    case 'every': {
      if (!(sp.step > 0)) throw new Error('Step must be > 0');
      const out: number[] = []; for (let x = sp.step; x < L - 1e-6 && out.length < 500; x += sp.step) out.push(x);
      if (!out.length) throw new Error('The step is longer than the segment');
      return out;
    }
  }
}

function commit(app: App, v: Hov, sp: Spec, ctrl = false): boolean {
  if (v.piece.locked) { toast(`${v.piece.name} is locked`, 'warn'); return false; }
  const kind = optCurve() !== ctrl ? 'curve' : 'grade';
  const notch = optNotch();
  let ids: Id[] = [];
  try {
    const opts = { kind: kind as 'grade' | 'curve', grading: optZero() ? 'zero' as const : 'auto' as const, notch };
    if (sp.kind === 'pct') ids = ops.addPointsOnSegment(app.doc, v.piece.id, v.seg.fromId, { ...opts, pcts: [sp.p] });
    else if (sp.kind === 'divide') ids = ops.addPointsOnSegment(app.doc, v.piece.id, v.seg.fromId, { ...opts, divide: sp.n });
    else {
      // lengths measured on the active size → same ratio of the base segment
      const k = isBaseSize(app, v.piece) ? 1 : baseLen(app, v) / v.seg.L;
      ids = ops.addPointsOnSegment(app.doc, v.piece.id, v.seg.fromId, { ...opts, distances: specDistances(v.seg.L, sp).map(x => x * k) });
    }
  } catch (err) { reportError(err, 'Cut point'); return false; }
  app.clearSelection();
  ids.forEach((id, i) => app.applySel({ k: 'point', ref: { pieceId: v.piece.id, contourId: v.contour.id, anchorId: id } }, i ? 'add' : 'replace'));
  app.status(`Cut point: ${ids.length} ${kind} point${ids.length > 1 ? 's' : ''} added${notch ? ' with notches' : ''}${optZero() ? ' (zero grade)' : ''} · Ctrl+Z undoes`);
  return true;
}

async function inputBox(app: App, v: Hov, typed?: string) {
  if (inputBoxOpen()) return;
  CP.lock = v;
  const L = v.seg.L;
  const last = toolOpt(T, 'mode', 'start');
  const modes: IBMode[] = [
    { id: 'start', label: 'From start', title: 'Length from the segment start (blue part)', fields: [{ key: 'd', label: 'Length from start', kind: 'length', value: v.d }] },
    { id: 'end', label: 'From end', title: 'Length from the segment end (orange part)', fields: [{ key: 'd', label: 'Length from end', kind: 'length', value: L - v.d }] },
    { id: 'pct', label: 'Ratio %', title: 'Ratio of the segment, from the start', fields: [{ key: 'p', label: 'Ratio from start', kind: 'number', value: Math.round(v.d / L * 1e4) / 100, suffix: '%' }] },
    { id: 'divide', label: 'Divide', title: 'Divide into N equal parts (inserts N − 1 points)', fields: [{ key: 'n', label: 'Number of parts', kind: 'number', value: toolOpt(T, 'n', 2) }] },
    { id: 'every', label: 'Every', title: 'A point every X from the start', fields: [{ key: 's', label: 'Every', kind: 'length', value: toolOpt(T, 'step', 50) }] },
  ];
  const toSpec = (m: string, val: Record<string, number>): Spec => m === 'pct' ? { kind: 'pct', p: val.p } : m === 'divide' ? { kind: 'divide', n: val.n } : m === 'every' ? { kind: 'every', step: val.s } : { kind: m as 'start' | 'end', d: val.d };
  const sz = isBaseSize(app, v.piece) ? undefined : `Size ${sizeNameOf(app, app.sizeOf(v.piece))}: lengths on this size, placed at the same ratio of the base`;
  const res = await openInputBox({
    title: `Cut Point · segment ${fmt(L)} ${unitLabel()}`, modes, mode: typed ? 'start' : last, at: lastClient, typed, amber: sz,
    hint: 'Enter / right-click = OK · Esc = cancel · Tab = next field',
    onPreview: (m, val) => {
      if (!val) { CP.preview = null; app.invalidate('canvas'); return; }
      try { CP.preview = specDistances(L, toSpec(m, val)); CP.err = ''; } catch (err) { CP.preview = null; CP.err = (err as Error).message; }
      app.status(CP.err ? `⚠ ${CP.err}` : `Cut Point · ${CP.preview!.length} point${CP.preview!.length > 1 ? 's' : ''} · OK to insert`);
      app.invalidate('canvas');
    },
  });
  CP.preview = null; CP.lock = null; CP.err = '';
  if (!res) { app.invalidate('canvas'); return; }
  setToolOpt(T, 'mode', res.mode);
  if (res.mode === 'divide') setToolOpt(T, 'n', res.v.n);
  if (res.mode === 'every') setToolOpt(T, 'step', res.v.s);
  commit(app, v, toSpec(res.mode, res.v));
  app.invalidate();
}

export const cutPointTool: Tool = {
  id: 'cutPoint', title: 'Cut Point', group: 'cutpoint', hotkey: 'X', icon: ICON.cutPoint, cursor: 'crosshair',
  activate() { CP.hov = null; CP.lock = null; CP.preview = null; },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); CP.hov = null; CP.lock = null; CP.preview = null; app.invalidate('canvas'); },
  busy: () => !!CP.lock,
  toggles: () => [
    { id: 'curve', label: 'Curve point', title: 'Insert curve points instead of grade points (Ctrl+click inverts it for one click)', on: optCurve() },
    { id: 'notch', label: 'Notch', title: 'Also add a notch on every new point', on: optNotch() },
    { id: 'zero', label: 'Zero grade', title: 'New points get no grading (default: proportional / auto)', on: optZero() },
  ],
  toggle(app, id) { setToolOpt(T, id, !toolOpt(T, id, false)); app.invalidate(); },
  badge(app) { const p = CP.hov?.piece ?? app.primaryPiece(); return p && !isBaseSize(app, p) ? { text: `Measuring on size ${sizeNameOf(app, app.sizeOf(p))}`, amber: true } : null; },
  hint(app) {
    if (CP.lock) return 'Cut Point · type the length / ratio / parts · Enter or right-click = OK · Esc = cancel';
    const v = CP.hov;
    const head = `Cut Point · ${optCurve() ? 'curve' : 'grade'} point${optNotch() ? ' + notch' : ''}${optZero() ? ' · zero grade' : ''}`;
    if (!v) return `${head} · hover a sew or internal line · click = add point · right-click / type = exact length, ratio or divide · Esc = Select`;
    const u = unitLabel();
    return `${head} · start ${fmt(v.d)} ${u} · end ${fmt(v.seg.L - v.d)} ${u} · ${(v.d / v.seg.L * 100).toFixed(1)}%${v.snapped ? ' (rounded)' : ''} · click = add (Ctrl = ${optCurve() ? 'grade' : 'curve'}) · right-click / type = exact · Shift = round values`;
  },
  move(app, p) {
    trackClient(p);
    if (CP.lock) return;
    CP.hov = hoverAt(app, p.w, p.e as MouseEvent);
    app.invalidate('canvas', 'status');
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen()) return;
    const v = hoverAt(app, p.w, p.e as MouseEvent);
    if (!v) { app.status('Cut Point: click on a sew or internal line'); return; }
    if (commit(app, v, { kind: 'start', d: v.d }, (p.e as MouseEvent).ctrlKey || (p.e as MouseEvent).metaKey)) CP.hov = hoverAt(app, p.w, p.e as MouseEvent);
    app.invalidate();
  },
  context(app, p) {
    trackClient(p);
    if (inputBoxOpen()) { inputBoxCommit(); return true; }
    const v = hoverAt(app, p.w, p.e as MouseEvent) ?? CP.hov;
    if (!v) return false;
    void inputBox(app, v);
    return true;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    if (e.key === 'Escape') { app.setTool('select'); return true; }
    if (isNumKey(e) && CP.hov) { void inputBox(app, CP.hov, e.key); return true; }
    return false;
  },
  overlay(app) {
    const v = CP.lock ?? CP.hov; if (!v) return '';
    const out: string[] = [];
    const { piece, rc, seg } = v;
    const scr = (q: Vec) => app.view.toScreen(toWorld(piece, q));
    const u = unitLabel();
    const part = (s0: number, len: number, col: string, txt: string) => {
      const pts = arcPoly(rc, s0, len);
      out.push(`<path d="${screenPoly(app, piece, pts)}" stroke="${col}" stroke-width="4" opacity="0.55" fill="none" stroke-linecap="round"/>`);
      if (txt) { const m = scr(atArc(rc, s0 + len / 2)); out.push(label({ x: m.x + 8, y: m.y - 8 }, txt, { col })); }
    };
    const ds = CP.lock ? CP.preview ?? [] : [v.d];
    const cuts = [0, ...ds, seg.L];
    for (let k = 0; k + 1 < cuts.length; k++) part(seg.sA + cuts[k], cuts[k + 1] - cuts[k], k % 2 ? LIVE_COL.part2 : LIVE_COL.part1, `${fmt(cuts[k + 1] - cuts[k])}`);
    // segment start marker
    const s0 = scr(atArc(rc, seg.sA));
    out.push(screenMarker(s0, 'square', LIVE_COL.part1, 3.5), label({ x: s0.x + 6, y: s0.y + 14 }, 'start', { col: LIVE_COL.part1 }));
    for (const d of ds) out.push(dot(scr(atArc(rc, seg.sA + d)), LIVE_COL.cut, 4.5));
    if (!CP.lock) {
      const s = scr(atArc(rc, seg.sA + v.d));
      out.push(label({ x: s.x + 10, y: s.y + 18 }, `${fmt(v.d)} | ${fmt(seg.L - v.d)} ${u} · ${(v.d / seg.L * 100).toFixed(1)}%`, { col: LIVE_COL.cut }));
    } else if (CP.err) { const s = scr(atArc(rc, seg.sA + seg.L / 2)); out.push(label({ x: s.x + 10, y: s.y + 30 }, '⚠ ' + CP.err, { col: '#c0392b' })); }
    void fs;
    return out.join('');
  },
};
