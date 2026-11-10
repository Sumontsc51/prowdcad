/**
 * Live-object creation tools, CLO-style workflows with AccuMark conventions (docs/CLO-RESEARCH.md):
 * every step has a status prompt and a live preview of the real kernel result (scratch copy, so the
 * preview is exactly what is committed, cut line and dart cap included); right-click or typing a
 * digit opens the input box (fractions, units); Enter / right-click = OK, Esc = cancel (Esc when
 * idle = back to Select), Backspace = back one step; one undo step per object.
 *
 * Dart (Shift+D): click leg A on a sew line → click leg B (or type the width) → move the cursor
 *   inside the piece to place the apex (live legs, depth, leg-length equality, dart cap) → click.
 *   Shift = apex on the bisector. Right-click: Width·Depth / Width·Leg length / Width·Angle.
 *   Option: Equal legs (Fix Dart, default on). Press on a dart apex and drag = re-shape it.
 *   Click a dart (legs / axis) = select it; right-click it = dart menu.
 * Pleat (Shift+L): click the START then the END of the first pleat line (Alt on the END = axis only)
 *   → move the cursor to the side the pleats go: the distance sets where the LAST pleat line lies
 *   (interval = distance / (count − 1)); + / − = count, L = spread up to a clicked last line instead,
 *   F = flip the fold → click. Right-click: count, depth at start / end (taper), interval.
 *   Modes: Knife / Box / Inverted box. Options: Open now, Notches.
 * Slash & spread (Shift+U): click the SLASH point on the spread edge (sew line) → click the HINGE
 *   (sew line = rotate about it; inside the piece = rotation centre) → + / − = number of slashes (more
 *   than one: click the last slash point and hinge) → move the cursor to the side that moves: the
 *   distance from the slash line is the opening → click. Right-click: uniform / first → last /
 *   slash · hinge openings. Modes: Rotate (hinged) / Parallel.
 */
import type { Vec, Id, Piece, SizeId } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool, type Ptr } from './tool';
import { contourNear, pieceUnder } from '../hitkit';
import { reportError } from '../commands';
import { toast } from '../ui/toast';
import { snapPoint } from '../canvas/snap';
import { fs, screenMarker } from './common';
import { liveNear, contourPos, selectLive, liveShapes, type LiveKind, type DartShape } from '../live';
import { toLocal, toWorld, resolveFor } from '../geometry';
import { ops, type LiveContourPos } from '../ops-bridge';
import { previewWith } from './move';
import { openInputBox, inputBoxOpen, inputBoxCommit, inputBoxCancel, type IBMode } from '../ui/inputbox';
import { fmt, unitLabel } from '../units-ui';
import { sizeNameOf } from '../selection';
import { atArc, arcPoly, fwdS, totalLen, roundTo, label, dot, arrow, screenPoly, LIVE_COL, toolOpt, setToolOpt, trackClient, lastClient, isNumKey } from './livekit';
import { apexDown, apexMove, apexUp, apexCancel, apexBusy, apexHint, apexOverlay } from './apexdrag';

function liveClick(app: App, p: Ptr, kind: LiveKind): boolean {
  const h = p.hit.kind === 'live' && p.hit.liveKind === kind && p.hit.pieceId && p.hit.liveId
    ? { pieceId: p.hit.pieceId, id: p.hit.liveId }
    : (() => { const n = liveNear(app, p.w, { kind }); return n ? n.ref : null; })();
  if (!h) return false;
  selectLive(app, { kind, pieceId: h.pieceId, id: h.id });
  return true;
}

/** a position on a sew line: kernel contour position (base) + active-size arc + world point */
interface SewPick { pieceId: Id; pos: LiveContourPos; w: Vec; s: number }
function sewPick(app: App, w: Vec, pieceId?: Id, tolPx = 9): SewPick | null {
  const h = contourNear(app, w, { contour: 'sew', pieceId, tolPx });
  if (!h) return null;
  return { pieceId: h.piece.id, pos: contourPos(app, h), w: h.world, s: h.s };
}
const sewRc = (app: App, piece: Piece, sid?: SizeId) => resolveFor(app.doc, piece, sid ?? app.sizeOf(piece)).sew;
const isBase = (app: App, p: Piece) => app.sizeOf(p) === app.doc.baseSize(p);
const sizeNote = (app: App, p: Piece) => isBase(app, p) ? undefined : `Size ${sizeNameOf(app, app.sizeOf(p))}: created on the base shape, graded with the legs / edges`;
const lockedOk = (app: App, pieceId: Id) => { const p = app.doc.piece(pieceId); if (p.locked) { toast(`${p.name} is locked (Ctrl+L to unlock)`, 'warn'); return false; } return true; };
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
const nrm = (a: Vec): Vec => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
const u = () => unitLabel();

// ═══════════════════════════════ Dart ═══════════════════════════════
const TD = 'dart';
const DT: { a: SewPick | null; b: SewPick | null; hov: SewPick | null; cur: Vec | null; shift: boolean; pressed: boolean; info: { width: number; depth: number; la: number; lb: number } | null; err: string | null; newId: Id | null } =
  { a: null, b: null, hov: null, cur: null, shift: false, pressed: false, info: null, err: null, newId: null };
const dtFix = () => toolOpt(TD, 'fix', true);
const dtFold = (): 'A' | 'B' => (toolOpt(TD, 'foldB', false) ? 'B' : 'A');
function dtReset(app: App) { DT.a = null; DT.b = null; DT.info = null; DT.err = null; DT.pressed = false; app.cancelPreview(); app.invalidate(); }

/** apex (base piece coords) from the cursor: the active-size offset of the opening is removed so the apex lands under the cursor in this size too */
function dtApex(app: App, w: Vec, shift: boolean): Vec {
  const piece = app.doc.piece(DT.a!.pieceId);
  const ra = sewRc(app, piece), rb = sewRc(app, piece, app.doc.baseSize(piece));
  const A = atArc(ra, DT.a!.s), B = atArc(ra, DT.b!.s);
  const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  let l = toLocal(piece, w);
  if (shift) { const t = nrm(sub(B, A)), n = { x: -t.y, y: t.x }; let k = (l.x - M.x) * n.x + (l.y - M.y) * n.y; k = roundTo(k); l = { x: M.x + n.x * k, y: M.y + n.y * k }; }
  if (isBase(app, piece)) return l;
  const arcBase = (pos: LiveContourPos) => { const i = piece.sew.points.findIndex(q => q.id === pos.fromAnchorId); return (rb.cum[rb.anchorIndex[i]] ?? 0) + pos.distance; };
  const Ab = atArc(rb, arcBase(DT.a!.pos)), Bb = atArc(rb, arcBase(DT.b!.pos));
  return { x: l.x - (M.x - (Ab.x + Bb.x) / 2), y: l.y - (M.y - (Ab.y + Bb.y) / 2) };
}
/** leg B under the cursor; Shift = width rounded (5 mm / 1/8") */
function dtLegB(app: App, w: Vec, shift: boolean): SewPick | null {
  const a = DT.a!; const h = sewPick(app, w, a.pieceId, 1e9); if (!h) return null;
  if (!shift) return h;
  const piece = app.doc.piece(a.pieceId), rc = sewRc(app, piece);
  const f = fwdS(rc, a.s, h.s), b = fwdS(rc, h.s, a.s), sign = f <= b ? 1 : -1;
  const wd = Math.max(roundTo(Math.min(f, b)), 0); if (wd <= 0) return h;
  const s = a.s + sign * wd;
  return { pieceId: a.pieceId, pos: { fromAnchorId: a.pos.fromAnchorId, distance: a.pos.distance + sign * wd }, w: toWorld(piece, atArc(rc, s)), s };
}
type DartArgs = Parameters<typeof ops.createDartByLegs>[2];
function dtArgsCursor(app: App, w: Vec, shift: boolean): DartArgs { return { a: DT.a!.pos, b: DT.b!.pos, apex: dtApex(app, w, shift), fix: dtFix(), fold: dtFold() }; }
/** typed values: legs ± width/2 about the clicked opening's centre, apex on the bisector */
function dtArgsTyped(app: App, m: string, v: Record<string, number>): DartArgs {
  const piece = app.doc.piece(DT.a!.pieceId);
  const span = ops.dartLegSpan(piece, app.doc.sizeLine(piece), DT.a!.pos, DT.b!.pos);
  const w = v.w;
  if (!(w > 0)) throw new Error('Width must be > 0');
  let depth = v.d;
  if (m === 'wl') { if (!(v.l > w / 2)) throw new Error('Leg length must be longer than half the width'); depth = Math.sqrt(v.l * v.l - (w / 2) ** 2); }
  if (m === 'wa') { if (!(v.a > 0 && v.a < 180)) throw new Error('Angle must be between 0° and 180°'); depth = (w / 2) / Math.tan((v.a * Math.PI) / 360); }
  if (!(depth > 0)) throw new Error('Depth must be > 0');
  const c = span.centre;
  return { a: { fromAnchorId: c.fromAnchorId, distance: c.distance - w / 2 }, b: { fromAnchorId: c.fromAnchorId, distance: c.distance + w / 2 }, depth, fold: dtFold() };
}
function dtPreview(app: App, args: DartArgs): void {
  const pid = DT.a!.pieceId;
  DT.err = previewWith(app, [pid], d => { DT.newId = ops.createDartByLegs(d, pid, args); });
  DT.info = null;
  const pv = app.preview.get(pid);
  if (pv && DT.newId) { try { const g = ops.dartSewGeometry(pv, app.doc.sizeLine(pv), app.sizeOf(pv)).find(x => x.dartId === DT.newId); if (g) DT.info = { width: g.width, depth: g.depth, la: g.legLengthA, lb: g.legLengthB }; } catch { /* */ } }
}
function dtCommit(app: App, args: DartArgs) {
  const pid = DT.a!.pieceId;
  if (!lockedOk(app, pid)) return;
  app.cancelPreview();
  try {
    const id = ops.createDartByLegs(app.doc, pid, args);
    selectLive(app, { kind: 'dart', pieceId: pid, id });
    const g = ops.dartInfo(app.doc, pid, id, app.sizeOf(app.doc.piece(pid)));
    app.status(`Dart created · width ${fmt(g.width)} · depth ${fmt(g.depth)} ${u()} · legs ${fmt(g.legLengthA)} / ${fmt(g.legLengthB)} · right-click it for the dart menu`);
  } catch (err) { reportError(err, 'Create dart'); }
  DT.a = null; DT.b = null; DT.info = null; DT.err = null; app.invalidate();
}
async function dtInputWidth(app: App, typed?: string) {
  const a = DT.a!; const piece = app.doc.piece(a.pieceId);
  const hov = DT.hov && DT.hov.pieceId === a.pieceId ? DT.hov : null;
  const rc = sewRc(app, piece);
  const sign = hov && fwdS(rc, a.s, hov.s) > totalLen(rc) / 2 ? -1 : 1;
  const w0 = hov ? Math.min(fwdS(rc, a.s, hov.s), fwdS(rc, hov.s, a.s)) : toolOpt(TD, 'w', 20);
  const res = await openInputBox({ title: 'Dart · width (leg A → leg B)', modes: [{ id: 'w', label: 'Width', fields: [{ key: 'w', label: 'Width', kind: 'length', value: w0 }] }], at: lastClient, typed, amber: sizeNote(app, piece) });
  if (!res || !DT.a) return;
  setToolOpt(TD, 'w', res.v.w);
  const s = a.s + sign * res.v.w;
  DT.b = { pieceId: a.pieceId, pos: { fromAnchorId: a.pos.fromAnchorId, distance: a.pos.distance + sign * res.v.w }, w: toWorld(piece, atArc(rc, s)), s };
  app.invalidate();
}
async function dtInputApex(app: App, typed?: string) {
  const piece = app.doc.piece(DT.a!.pieceId);
  const w0 = DT.info?.width ?? ops.dartLegSpan(piece, app.doc.sizeLine(piece), DT.a!.pos, DT.b!.pos).width;
  const d0 = DT.info?.depth ?? toolOpt(TD, 'd', 100);
  const L0 = Math.hypot(w0 / 2, d0), A0 = (2 * Math.atan2(w0 / 2, d0) * 180) / Math.PI;
  const modes: IBMode[] = [
    { id: 'wd', label: 'Width · Depth', title: 'Apex on the bisector at this depth', fields: [{ key: 'w', label: 'Width', kind: 'length', value: w0 }, { key: 'd', label: 'Depth', kind: 'length', value: d0 }] },
    { id: 'wl', label: 'Width · Leg', title: 'Equal legs of this length', fields: [{ key: 'w', label: 'Width', kind: 'length', value: w0 }, { key: 'l', label: 'Leg length', kind: 'length', value: L0 }] },
    { id: 'wa', label: 'Width · Angle', title: 'Dart angle at the apex', fields: [{ key: 'w', label: 'Width', kind: 'length', value: w0 }, { key: 'a', label: 'Angle', kind: 'angle', value: Math.round(A0 * 100) / 100 }] },
  ];
  const res = await openInputBox({
    title: 'Dart · exact values', modes, mode: toolOpt(TD, 'mode', 'wd'), at: lastClient, typed, amber: sizeNote(app, piece),
    onPreview: (m, v) => { if (!v || !DT.a || !DT.b) { app.cancelPreview(); return; } try { dtPreview(app, dtArgsTyped(app, m, v)); } catch (err) { DT.err = (err as Error).message; app.cancelPreview(); } app.invalidate('status'); },
  });
  if (!DT.a || !DT.b) return;
  if (!res) { if (DT.cur) dtPreview(app, dtArgsCursor(app, DT.cur, DT.shift)); else app.cancelPreview(); return; }
  setToolOpt(TD, 'mode', res.mode);
  try { const args = dtArgsTyped(app, res.mode, res.v); setToolOpt(TD, 'd', args.depth!); dtCommit(app, args); } catch (err) { reportError(err, 'Create dart'); }
}

export const dartTool: Tool = {
  id: 'dart', title: 'Dart', group: 'live', hotkey: 'Shift+D', icon: ICON.dart, cursor: 'crosshair',
  activate(app) { DT.a = null; DT.b = null; DT.info = null; app.invalidate(); },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); apexCancel(app); DT.hov = null; dtReset(app); },
  busy: () => !!DT.a || apexBusy(),
  toggles: () => [
    { id: 'fix', label: 'Equal legs', title: 'Fix Dart: slide the legs (width kept) until both legs are equal', on: dtFix() },
    { id: 'foldB', label: 'Fold to leg B', title: 'Fold the dart intake toward leg B (default: leg A)', on: toolOpt(TD, 'foldB', false) },
  ],
  toggle(app, id) { setToolOpt(TD, id, !toolOpt(TD, id, id === 'fix')); if (DT.b && DT.cur) dtPreview(app, dtArgsCursor(app, DT.cur, DT.shift)); app.invalidate(); },
  badge(app) { const p = DT.a ? app.doc.piece(DT.a.pieceId) : app.primaryPiece(); return p && !isBase(app, p) ? { text: `Size ${sizeNameOf(app, app.sizeOf(p))} shown · darts are graded with their legs`, amber: true } : null; },
  hint(app) {
    const ah = apexHint(); if (ah) return ah;
    if (!DT.a) return 'Dart · click leg A on a sew line · press on a dart apex and drag = re-shape · click a dart = select · right-click a dart = dart menu · Esc = Select';
    if (!DT.b) {
      const w = DT.hov && DT.hov.pieceId === DT.a.pieceId ? (() => { const rc = sewRc(app, app.doc.piece(DT.a!.pieceId)); return Math.min(fwdS(rc, DT.a!.s, DT.hov!.s), fwdS(rc, DT.hov!.s, DT.a!.s)); })() : null;
      return `Dart · click leg B${w !== null ? ` (width ${fmt(w)} ${u()})` : ''} · or type the width · Shift = round width · Backspace = back · Esc cancel`;
    }
    const i = DT.info;
    const eq = i && Math.abs(i.la - i.lb) < 0.01;
    return `Dart · move inside the piece and click the APEX${i ? ` · width ${fmt(i.width)} · depth ${fmt(i.depth)} · legs ${fmt(i.la)} / ${fmt(i.lb)} ${u()}${eq ? ' ✓ equal' : ''}` : ''} · Shift = on the bisector, round depth · right-click / type = width·depth·leg·angle${DT.err ? ' · ⚠ ' + DT.err : ''}`;
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen()) return;
    if (!DT.a) {
      if (apexDown(app, p)) return;
      if (liveClick(app, p, 'dart')) return;
      const s = sewPick(app, p.w);
      if (!s) { app.status('Dart: click leg A on a sew line (or a dart to select it)'); return; }
      if (!lockedOk(app, s.pieceId)) return;
      DT.a = s; DT.hov = s; app.invalidate(); return;
    }
    if (!DT.b) {
      const s = sewPick(app, p.w, DT.a.pieceId) ? dtLegB(app, p.w, (p.e as MouseEvent).shiftKey) : null;
      if (!s) { app.status('Dart: click leg B on the same sew line'); return; }
      const rc = sewRc(app, app.doc.piece(s.pieceId));
      if (Math.min(fwdS(rc, DT.a.s, s.s), fwdS(rc, s.s, DT.a.s)) * app.view.scale < 3) { app.status('Dart: leg B must be away from leg A'); return; }
      DT.b = s; DT.cur = p.w; dtPreview(app, dtArgsCursor(app, p.w, (p.e as MouseEvent).shiftKey)); app.invalidate(); return;
    }
    DT.pressed = true;
  },
  move(app, p) {
    trackClient(p);
    if (inputBoxOpen()) return;
    if (apexMove(app, p)) return;
    if (!DT.a) { DT.hov = sewPick(app, p.w); app.invalidate('canvas'); return; }
    if (!DT.b) { DT.hov = dtLegB(app, p.w, (p.e as MouseEvent).shiftKey); app.invalidate('canvas', 'status'); return; }
    DT.cur = p.w; DT.shift = (p.e as MouseEvent).shiftKey;
    dtPreview(app, dtArgsCursor(app, p.w, DT.shift));
    app.invalidate('status');
  },
  up(app, p) {
    if (apexUp(app, p)) return;
    if (DT.a && DT.b && DT.pressed) { DT.pressed = false; dtCommit(app, dtArgsCursor(app, p.w, (p.e as MouseEvent).shiftKey)); }
  },
  context(app, p) {
    trackClient(p);
    if (inputBoxOpen()) { inputBoxCommit(); return true; }
    if (DT.a && !DT.b) { void dtInputWidth(app); return true; }
    if (DT.a && DT.b) { void dtInputApex(app); return true; }
    return false;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    if (e.key === 'Escape') { if (apexCancel(app)) return true; if (DT.a) { dtReset(app); app.status('Dart cancelled'); return true; } app.setTool('select'); return true; }
    if (e.key === 'Backspace' && DT.a) { if (DT.b) { DT.b = null; app.cancelPreview(); } else DT.a = null; app.invalidate(); return true; }
    if (isNumKey(e) && DT.a) { if (!DT.b) void dtInputWidth(app, e.key); else void dtInputApex(app, e.key); return true; }
    return false;
  },
  overlay(app) {
    const out: string[] = [apexOverlay(app)];
    if (!DT.a) { if (DT.hov) out.push(screenMarker(app.view.toScreen(DT.hov.w), 'ring', LIVE_COL.dart, 6)); return out.join(''); }
    const piece = app.doc.piece(DT.a.pieceId);
    const rc = sewRc(app, piece);
    const sA = app.view.toScreen(DT.a.w);
    out.push(dot(sA, LIVE_COL.dart), label({ x: sA.x + 8, y: sA.y - 8 }, 'A', { col: LIVE_COL.dart }));
    const other = DT.b ?? (DT.hov && DT.hov.pieceId === DT.a.pieceId ? DT.hov : null);
    if (other) {
      const f = fwdS(rc, DT.a.s, other.s), bk = fwdS(rc, other.s, DT.a.s);
      const [s0, len] = f <= bk ? [DT.a.s, f] : [other.s, bk];
      out.push(`<path d="${screenPoly(app, piece, arcPoly(rc, s0, len))}" stroke="${LIVE_COL.dart}" stroke-width="4" opacity="0.5" fill="none" stroke-linecap="round"/>`);
      const sB = app.view.toScreen(other.w);
      out.push(dot(sB, LIVE_COL.dart), label({ x: sB.x + 8, y: sB.y - 8 }, DT.b ? 'B' : `B · ${fmt(len)} ${u()}`, { col: LIVE_COL.dart }));
    }
    if (DT.b && DT.info && DT.cur) {
      const c = app.view.toScreen(DT.cur), eq = Math.abs(DT.info.la - DT.info.lb) < 0.01;
      out.push(label({ x: c.x + 14, y: c.y + 18 }, `W ${fmt(DT.info.width)} · D ${fmt(DT.info.depth)} ${u()}`, { col: LIVE_COL.dart }));
      out.push(label({ x: c.x + 14, y: c.y + 32 }, `legs ${fmt(DT.info.la)} / ${fmt(DT.info.lb)}${eq ? ' ✓ equal' : ' Δ ' + fmt(Math.abs(DT.info.la - DT.info.lb))}`, { col: eq ? '#1e8449' : '#c0392b' }));
    }
    if (DT.err && DT.cur) { const c = app.view.toScreen(DT.cur); out.push(label({ x: c.x + 14, y: c.y + 46 }, '⚠ ' + DT.err, { col: '#c0392b' })); }
    return out.join('');
  },
};

// ═══════════════════════════════ Pleat ═══════════════════════════════
const TP = 'pleat';
type PleatKind = 'knife' | 'box' | 'inverted';
const PLEAT_MODES: { id: PleatKind; label: string; title: string }[] = [
  { id: 'knife', label: 'Knife', title: 'Knife pleats: one fold each (2 × depth of fabric)' },
  { id: 'box', label: 'Box', title: 'Box pleats: two folds turned away from the centre (4 × depth)' },
  { id: 'inverted', label: 'Inverted box', title: 'Inverted box pleats: two folds meeting at the centre (4 × depth)' },
];
const PL: { pieceId: Id | null; a: Vec | null; b: Vec | null; between: boolean; la: Vec | null; lb: Vec | null; cur: Vec | null; hov: Vec | null; pressed: boolean; err: string | null; iv: number; side: 'left' | 'right' } =
  { pieceId: null, a: null, b: null, between: false, la: null, lb: null, cur: null, hov: null, pressed: false, err: null, iv: 0, side: 'right' };
const plType = (): PleatKind => toolOpt(TP, 'type', 'knife') as PleatKind;
const plCount = () => Math.max(1, Math.round(toolOpt(TP, 'count', 3)));
const plDs = () => toolOpt(TP, 'ds', 20), plDe = () => toolOpt(TP, 'de', 20);
const plFold = (): 'left' | 'right' => toolOpt(TP, 'fold', 'right') as 'left' | 'right';
function plReset(app: App) { PL.pieceId = null; PL.a = PL.b = PL.la = PL.lb = null; PL.between = false; PL.err = null; PL.pressed = false; app.cancelPreview(); app.invalidate(); }
const plStep = () => !PL.a ? 'start' : !PL.b ? 'end' : PL.between && !PL.la ? 'lastStart' : PL.between && !PL.lb ? 'lastEnd' : 'layout';

type PleatArgs = { first: [Vec, Vec]; o: Parameters<typeof ops.addPleatSet>[3] };
function plArgs(app: App, over: { count?: number; ds?: number; de?: number; iv?: number } = {}): PleatArgs {
  const piece = app.doc.piece(PL.pieceId!);
  const A = toLocal(piece, PL.a!), B = toLocal(piece, PL.b!);
  const n = over.count ?? plCount();
  const o: PleatArgs['o'] = { count: n, type: plType(), depthStart: over.ds ?? plDs(), depthEnd: over.de ?? plDe(), fold: plFold(), autoNotches: toolOpt(TP, 'notches', true), open: toolOpt(TP, 'open', true) };
  if (PL.between && PL.la && PL.lb) o.last = [toLocal(piece, PL.la), toLocal(piece, PL.lb)];
  else { o.side = PL.side; o.interval = over.iv ?? PL.iv; }
  return { first: [A, B], o };
}
/** cursor → side + interval (distance to the line = position of the last pleat line) */
function plFromCursor(app: App, w: Vec, shift: boolean) {
  const piece = app.doc.piece(PL.pieceId!);
  const A = toLocal(piece, PL.a!), B = toLocal(piece, PL.b!), C = toLocal(piece, w);
  const t = nrm(sub(B, A)), r = { x: t.y, y: -t.x };
  const d = (C.x - A.x) * r.x + (C.y - A.y) * r.y;
  PL.side = d >= 0 ? 'right' : 'left';
  const n = plCount();
  let iv = n > 1 ? Math.abs(d) / (n - 1) : 0;
  if (shift && n > 1) iv = Math.max(roundTo(iv), 0);
  PL.iv = iv;
}
function plPreview(app: App, a: PleatArgs) { PL.err = previewWith(app, [PL.pieceId!], d => { ops.addPleatSet(d, PL.pieceId!, a.first, a.o); }); }
function plRefresh(app: App) { if (plStep() === 'layout' && PL.cur) { if (!PL.between) plFromCursor(app, PL.cur, false); plPreview(app, plArgs(app)); } app.invalidate(); }
function plCommit(app: App, a: PleatArgs) {
  const pid = PL.pieceId!;
  if (!lockedOk(app, pid)) return;
  app.cancelPreview();
  try {
    const ids = ops.addPleatSet(app.doc, pid, a.first, a.o);
    selectLive(app, { kind: 'pleat', pieceId: pid, id: ids[0] });
    const fab = ops.pleatFabric(a.o.type ?? 'knife', a.o.depthStart ?? 0), fab2 = ops.pleatFabric(a.o.type ?? 'knife', a.o.depthEnd ?? 0);
    app.status(`${ids.length} ${a.o.type} pleat${ids.length > 1 ? 's' : ''} · fabric ${fmt(fab)} → ${fmt(fab2)} ${u()} each${a.o.open ? '' : ' (closed: open them from the Inspector)'} · right-click a pleat for its menu`);
  } catch (err) { reportError(err, 'Pleats'); }
  plReset(app);
}
async function plInput(app: App, typed?: string) {
  const between = PL.between && !!PL.lb;
  const fields = [
    { key: 'n', label: 'Number of pleats', kind: 'number' as const, value: plCount() },
    { key: 'ds', label: 'Depth at start', kind: 'length' as const, value: plDs() },
    { key: 'de', label: 'Depth at end', kind: 'length' as const, value: plDe() },
    ...(between ? [] : [{ key: 'iv', label: 'Interval', kind: 'length' as const, value: PL.iv || toolOpt(TP, 'iv', 40) }]),
  ];
  const piece = app.doc.piece(PL.pieceId!);
  const over = (v: Record<string, number>) => ({ count: Math.round(v.n), ds: v.ds, de: v.de, iv: v.iv });
  const res = await openInputBox({
    title: `Pleats · ${PLEAT_MODES.find(m => m.id === plType())!.label}${between ? ' · between two lines' : ''}`, modes: [{ id: 'p', label: 'Pleats', fields }], at: lastClient, typed, amber: sizeNote(app, piece),
    onPreview: (_m, v) => { if (!v || !PL.b) { app.cancelPreview(); return; } try { plPreview(app, plArgs(app, over(v))); } catch (err) { PL.err = (err as Error).message; } app.invalidate('status'); },
  });
  if (!PL.b) return;
  if (!res) { plRefresh(app); return; }
  const v = res.v;
  setToolOpt(TP, 'count', Math.max(1, Math.round(v.n))); setToolOpt(TP, 'ds', v.ds); setToolOpt(TP, 'de', v.de); if (v.iv !== undefined) { setToolOpt(TP, 'iv', v.iv); PL.iv = v.iv; }
  plCommit(app, plArgs(app, over(v)));
}

export const pleatTool: Tool = {
  id: 'pleat', title: 'Pleat', group: 'live', hotkey: 'Shift+L', icon: ICON.pleat, cursor: 'crosshair',
  activate(app) { plReset(app); },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); PL.hov = null; plReset(app); },
  busy: () => !!PL.a,
  modes: () => PLEAT_MODES,
  mode: () => plType(),
  setMode(app, id) { setToolOpt(TP, 'type', id); plRefresh(app); },
  toggles: () => [
    { id: 'open', label: 'Open now', title: 'Open the pleats when they are created (else only the pleat lines; open them later)', on: toolOpt(TP, 'open', true) },
    { id: 'notches', label: 'Notches', title: 'Auto notches on the pleat edges', on: toolOpt(TP, 'notches', true) },
  ],
  toggle(app, id) { setToolOpt(TP, id, !toolOpt(TP, id, true)); plRefresh(app); },
  hint(app) {
    const t = PLEAT_MODES.find(m => m.id === plType())!.label;
    switch (plStep()) {
      case 'start': return `Pleat · ${t} · click the START of the first pleat line (e.g. on the waist) · click a pleat = select · Esc = Select`;
      case 'end': return `Pleat · click the END of the first pleat line (e.g. on the hem) · Alt+click = pleat axis only · Backspace = back · Esc cancel`;
      case 'lastStart': return 'Pleat · between lines: click the START of the LAST pleat line · Backspace = back';
      case 'lastEnd': return 'Pleat · between lines: click the END of the LAST pleat line';
      default: {
        const n = plCount(), fab = ops.pleatFabric(plType(), plDs()), fab2 = ops.pleatFabric(plType(), plDe());
        const lay = PL.between ? 'spread to the last line' : `interval ${fmt(PL.iv)} ${u()} (${PL.side} side)`;
        void app;
        return `Pleat · ${n} ${t} · ${lay} · depth ${fmt(plDs())} → ${fmt(plDe())} · fabric ${fmt(fab)} → ${fmt(fab2)} each · click = create · +/− count · L = up to a last line · F = fold (${plFold()}) · Shift = round interval · right-click / type = values${PL.err ? ' · ⚠ ' + PL.err : ''}`;
      }
    }
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen()) return;
    const st = plStep();
    const w = snapPoint(app, p.w, {}).p;
    if (st === 'start') {
      if (liveClick(app, p, 'pleat')) return;
      const pc = contourNear(app, w, { contour: 'sew', tolPx: 12 })?.piece ?? pieceUnder(app, w);
      if (!pc) { app.status('Pleat: start the pleat line on a piece'); return; }
      if (!lockedOk(app, pc.id)) return;
      PL.pieceId = pc.id; PL.a = w; app.invalidate(); return;
    }
    if (st === 'end') {
      if (Math.hypot(w.x - PL.a!.x, w.y - PL.a!.y) * app.view.scale < 4) { app.status('Pleat: click the END away from the start'); return; }
      if ((p.e as MouseEvent).altKey) {
        const piece = app.doc.piece(PL.pieceId!);
        try { const id = ops.addPleatAxis(app.doc, piece.id, toLocal(piece, PL.a!), toLocal(piece, w), { type: plType(), fold: plFold() }); selectLive(app, { kind: 'pleat', pieceId: piece.id, id }); toast('Pleat axis added — set its attributes in the Inspector, then Open', 'ok'); } catch (err) { reportError(err, 'Pleat axis'); }
        plReset(app); return;
      }
      PL.b = w; PL.cur = p.w; plRefresh(app); return;
    }
    if (st === 'lastStart') { PL.la = w; app.invalidate(); return; }
    if (st === 'lastEnd') { PL.lb = w; plRefresh(app); return; }
    PL.pressed = true;
  },
  move(app, p) {
    trackClient(p);
    if (inputBoxOpen()) return;
    PL.hov = snapPoint(app, p.w, {}).p;
    if (plStep() === 'layout') { PL.cur = p.w; if (!PL.between) plFromCursor(app, p.w, (p.e as MouseEvent).shiftKey); plPreview(app, plArgs(app)); app.invalidate('status'); return; }
    if (PL.a) app.invalidate('canvas');
  },
  up(app, p) {
    if (plStep() === 'layout' && PL.pressed) { PL.pressed = false; if (!PL.between) plFromCursor(app, p.w, (p.e as MouseEvent).shiftKey); plCommit(app, plArgs(app)); }
  },
  context(app, p) {
    trackClient(p);
    if (inputBoxOpen()) { inputBoxCommit(); return true; }
    if (plStep() === 'layout') { void plInput(app); return true; }
    return !!PL.a;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    const st = plStep();
    if (e.key === 'Escape') { if (PL.a) { plReset(app); app.status('Pleat cancelled'); return true; } app.setTool('select'); return true; }
    if (e.key === 'Backspace' && PL.a) { if (PL.lb) PL.lb = null; else if (PL.la) PL.la = null; else if (PL.between) PL.between = false; else if (PL.b) PL.b = null; else PL.a = null; app.cancelPreview(); plRefresh(app); return true; }
    if (!PL.b) return false;
    if (e.key === '+' || e.key === '=' || e.key === ']') { setToolOpt(TP, 'count', plCount() + 1); plRefresh(app); return true; }
    if (e.key === '-' || e.key === '[') { setToolOpt(TP, 'count', Math.max(1, plCount() - 1)); plRefresh(app); return true; }
    if (e.key === 'f' || e.key === 'F') { setToolOpt(TP, 'fold', plFold() === 'right' ? 'left' : 'right'); plRefresh(app); return true; }
    if (e.key === 'l' || e.key === 'L') { PL.between = !PL.between; PL.la = PL.lb = null; app.cancelPreview(); plRefresh(app); return true; }
    if (isNumKey(e) && st === 'layout') { void plInput(app, e.key); return true; }
    return false;
  },
  overlay(app) {
    if (!PL.a) return '';
    const out: string[] = [];
    const a = app.view.toScreen(PL.a), b = app.view.toScreen(PL.b ?? PL.hov ?? PL.a);
    out.push(`<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="${LIVE_COL.pleat}" stroke-width="1.6" stroke-dasharray="8 3 2 3"/>`, screenMarker(a, 'square', LIVE_COL.pleat, 4), label({ x: a.x + 8, y: a.y - 8 }, 'start', { col: LIVE_COL.pleat }));
    if (PL.b) out.push(screenMarker(b, 'square', LIVE_COL.pleat, 4), label({ x: b.x + 8, y: b.y + 14 }, 'end', { col: LIVE_COL.pleat }));
    if (PL.la) { const c = app.view.toScreen(PL.la), d = app.view.toScreen(PL.lb ?? PL.hov ?? PL.la); out.push(`<path d="M${fs(c.x)} ${fs(c.y)}L${fs(d.x)} ${fs(d.y)}" stroke="${LIVE_COL.pleat}" stroke-width="1.6" stroke-dasharray="8 3 2 3"/>`, label({ x: c.x + 8, y: c.y - 8 }, 'last', { col: LIVE_COL.pleat })); }
    if (plStep() === 'layout' && PL.pieceId) {
      // ghost of every pleat line (the fold-direction arrows are drawn with the previewed pleats)
      const piece = app.doc.piece(PL.pieceId);
      try {
        const ar = plArgs(app);
        const axes = ops.pleatSetAxes(ar.first, ar.o);
        for (const [p0, p1] of axes) {
          const s0 = app.view.toScreen(toWorld(piece, p0)), s1 = app.view.toScreen(toWorld(piece, p1));
          out.push(`<path d="M${fs(s0.x)} ${fs(s0.y)}L${fs(s1.x)} ${fs(s1.y)}" stroke="${LIVE_COL.pleat}" stroke-width="1" opacity="0.7" stroke-dasharray="3 3"/>`);
        }
      } catch { /* shown in the prompt */ }
      if (PL.cur) {
        const c = app.view.toScreen(PL.cur);
        out.push(label({ x: c.x + 14, y: c.y + 18 }, `${plCount()} × ${plType()}${PL.between ? '' : ` · interval ${fmt(PL.iv)} ${u()}`}`, { col: LIVE_COL.pleat }));
        out.push(label({ x: c.x + 14, y: c.y + 32 }, `depth ${fmt(plDs())} → ${fmt(plDe())} · fabric ${fmt(ops.pleatFabric(plType(), plDs()))} → ${fmt(ops.pleatFabric(plType(), plDe()))}`, { col: LIVE_COL.pleat }));
        if (PL.err) out.push(label({ x: c.x + 14, y: c.y + 46 }, '⚠ ' + PL.err, { col: '#c0392b' }));
      }
    }
    return out.join('');
  },
};

// ═══════════════════════════════ Slash & spread ═══════════════════════════════
const TF = 'fullness';
type Hinge = { pieceId: Id; pos?: LiveContourPos; P?: Vec; w: Vec; s?: number };
const FU: { s1: SewPick | null; h1: Hinge | null; s2: SewPick | null; h2: Hinge | null; cur: Vec | null; amt: number; side: 'forward' | 'backward'; pressed: boolean; err: string | null; last?: { w0: number; w1: number } | null } =
  { s1: null, h1: null, s2: null, h2: null, cur: null, amt: 0, side: 'forward', pressed: false, err: null, last: null };
const fuMode = (): 'rotate' | 'parallel' => toolOpt(TF, 'mode', 'rotate') as 'rotate' | 'parallel';
const fuCount = () => Math.max(1, Math.round(toolOpt(TF, 'count', 1)));
const FU_MODES = [
  { id: 'rotate', label: 'Rotate', title: 'Rotate the moving side about the hinge (hinged slash & spread)' },
  { id: 'parallel', label: 'Parallel', title: 'Translate the moving side (parallel spread: the hinge opens too)' },
];
function fuReset(app: App) { FU.s1 = FU.h1 = FU.s2 = FU.h2 = null; FU.err = null; FU.pressed = false; FU.last = null; app.cancelPreview(); app.invalidate(); }
const fuStep = () => !FU.s1 ? 'slash' : !FU.h1 ? 'hinge' : fuCount() > 1 && !FU.s2 ? 'lastSlash' : fuCount() > 1 && !FU.h2 ? 'lastHinge' : 'spread';

function fuHinge(app: App, w: Vec, pieceId: Id): Hinge {
  const h = sewPick(app, w, pieceId);
  if (h) return { pieceId, pos: h.pos, w: h.w, s: h.s };
  const piece = app.doc.piece(pieceId);
  return { pieceId, P: toLocal(piece, snapPoint(app, w, {}).p), w: snapPoint(app, w, {}).p };
}
/** cursor → opening (distance to the first slash line) + moving side (the cursor's side) */
function fuFromCursor(app: App, w: Vec, shift: boolean) {
  const piece = app.doc.piece(FU.s1!.pieceId);
  const S = toLocal(piece, FU.s1!.w), H = FU.h1!.P ?? toLocal(piece, FU.h1!.w), C = toLocal(piece, w);
  const t = nrm(sub(H, S));
  let amt = Math.abs(cross(t, sub(C, S)));
  if (shift) amt = roundTo(amt);
  FU.amt = amt;
  // the forward arc starts right after S: which side of the slash line is it on?
  const rc = sewRc(app, piece);
  const m = atArc(rc, FU.s1!.s + Math.min(3, totalLen(rc) / 100));
  const fside = Math.sign(cross(t, sub(m, S))), cside = Math.sign(cross(t, sub(C, S)));
  FU.side = fside === cside || !fside ? 'forward' : 'backward';
}
type FuOp = (d: Parameters<typeof ops.addFullness>[0]) => Id;
function fuOp(app: App, o: { a?: number; b?: number; w0?: number; w1?: number } = {}): FuOp {
  const pid = FU.s1!.pieceId, n = fuCount(), mode = fuMode(), side = FU.side;
  if (n === 1) {
    const pivot = FU.h1!.pos ?? FU.h1!.P!;
    return d => ops.addFullness(d, pid, { slash: FU.s1!.pos, pivot, openA: o.a ?? o.w0 ?? FU.amt, openB: FU.h1!.pos ? o.b ?? 0 : 0, mode, side });
  }
  if (!FU.h1!.pos || !FU.h2?.pos) throw new Error('Several slashes need their hinges on the sew line');
  const w0 = o.w0 ?? FU.last?.w0 ?? FU.amt, w1 = o.w1 ?? FU.last?.w1 ?? FU.amt;
  return d => ops.addFullnessBetween(d, pid, { firstSlash: FU.s1!.pos, firstHinge: FU.h1!.pos!, lastSlash: FU.s2!.pos, lastHinge: FU.h2!.pos!, count: n, firstWidth: w0, lastWidth: w1, mode, side });
}
function fuPreview(app: App, op: FuOp) { FU.err = previewWith(app, [FU.s1!.pieceId], d => { op(d); }); }
function fuRefresh(app: App) { if (fuStep() === 'spread' && FU.cur) { fuFromCursor(app, FU.cur, false); try { fuPreview(app, fuOp(app)); } catch (err) { FU.err = (err as Error).message; app.cancelPreview(); } } else app.cancelPreview(); app.invalidate(); }
function fuCommit(app: App, op: FuOp) {
  const pid = FU.s1!.pieceId;
  if (!lockedOk(app, pid)) return;
  app.cancelPreview();
  try {
    const id = op(app.doc);
    selectLive(app, { kind: 'fullness', pieceId: pid, id });
    const o = ops.fullnessOpenings(app.doc, pid, id);
    app.status(`Slash & spread · ${o.length} slash${o.length > 1 ? 'es' : ''} · opening ${o.map(x => fmt(x)).join(' · ')} ${u()} · Delete = exact restore · right-click it to edit`);
  } catch (err) { reportError(err, 'Slash & spread'); }
  fuReset(app);
}
async function fuInput(app: App, typed?: string) {
  const n = fuCount(), piece = app.doc.piece(FU.s1!.pieceId);
  const modes: IBMode[] = [{ id: 'u', label: 'Uniform', title: 'Same opening at every slash', fields: [{ key: 'w', label: 'Opening at the slash', kind: 'length', value: FU.amt }] }];
  if (n > 1) modes.push({ id: 'v', label: 'First → last', title: 'Openings interpolated from the first to the last slash', fields: [{ key: 'w0', label: 'First opening', kind: 'length', value: FU.last?.w0 ?? FU.amt }, { key: 'w1', label: 'Last opening', kind: 'length', value: FU.last?.w1 ?? FU.amt }] });
  if (n === 1 && FU.h1!.pos && fuMode() === 'rotate') modes.push({ id: 'h', label: 'Slash · hinge', title: 'Opening at the slash and at the hinge (0 = hinged)', fields: [{ key: 'a', label: 'At the slash', kind: 'length', value: FU.amt }, { key: 'b', label: 'At the hinge', kind: 'length', value: 0 }] });
  const toO = (m: string, v: Record<string, number>) => m === 'u' ? { a: v.w, w0: v.w, w1: v.w } : m === 'v' ? { w0: v.w0, w1: v.w1 } : { a: v.a, b: v.b };
  const res = await openInputBox({
    title: `Slash & spread · ${fuMode() === 'rotate' ? 'rotate' : 'parallel'} · ${n} slash${n > 1 ? 'es' : ''}`, modes, at: lastClient, typed, amber: sizeNote(app, piece),
    onPreview: (m, v) => { if (!v || !FU.s1) { app.cancelPreview(); return; } try { fuPreview(app, fuOp(app, toO(m, v))); } catch (err) { FU.err = (err as Error).message; } app.invalidate('status'); },
  });
  if (!FU.s1) return;
  if (!res) { fuRefresh(app); return; }
  try { fuCommit(app, fuOp(app, toO(res.mode, res.v))); } catch (err) { reportError(err, 'Slash & spread'); }
}

export const fullnessTool: Tool = {
  id: 'fullness', title: 'Slash & spread', group: 'live', hotkey: 'Shift+U', icon: ICON.fullness, cursor: 'crosshair',
  activate(app) { fuReset(app); },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); fuReset(app); },
  busy: () => !!FU.s1,
  modes: () => FU_MODES,
  mode: () => fuMode(),
  setMode(app, id) { setToolOpt(TF, 'mode', id); fuRefresh(app); },
  hint(app) {
    const n = fuCount(), m = fuMode() === 'rotate' ? 'Rotate' : 'Parallel';
    switch (fuStep()) {
      case 'slash': return `Slash & spread · ${m} · click the SLASH point on the spread edge (e.g. the hem) · click a slash line = select · Esc = Select`;
      case 'hinge': return `Slash & spread · click the HINGE (on the sew line = rotate about it; inside the piece = rotation centre) · Backspace = back · Esc cancel`;
      case 'lastSlash': return `Slash & spread · ${n} slashes · click the LAST slash point · − = fewer · Backspace = back`;
      case 'lastHinge': return `Slash & spread · ${n} slashes · click the LAST hinge on the sew line`;
      default: {
        void app;
        const amt = FU.last ? `${fmt(FU.last.w0)} → ${fmt(FU.last.w1)}` : fmt(FU.amt);
        return `Slash & spread · ${m} · ${n} slash${n > 1 ? 'es' : ''} · opening ${amt} ${u()} · moves the ${FU.side} side (the cursor side) · click = apply · +/− slashes · Tab = mode · Shift = round · right-click / type = exact${FU.err ? ' · ⚠ ' + FU.err : ''}`;
      }
    }
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen()) return;
    const st = fuStep();
    if (st === 'slash') {
      if (liveClick(app, p, 'fullness')) return;
      const s = sewPick(app, p.w);
      if (!s) { app.status('Slash & spread: click the slash point on a sew line'); return; }
      if (!lockedOk(app, s.pieceId)) return;
      FU.s1 = s; app.invalidate(); return;
    }
    if (st === 'hinge') { FU.h1 = fuHinge(app, p.w, FU.s1!.pieceId); FU.cur = p.w; fuRefresh(app); return; }
    if (st === 'lastSlash') { const s = sewPick(app, p.w, FU.s1!.pieceId); if (!s) { app.status('Click the last slash point on the same sew line'); return; } FU.s2 = s; app.invalidate(); return; }
    if (st === 'lastHinge') { const h = sewPick(app, p.w, FU.s1!.pieceId); if (!h) { app.status('Click the last hinge on the sew line'); return; } FU.h2 = { pieceId: h.pieceId, pos: h.pos, w: h.w, s: h.s }; FU.cur = p.w; fuRefresh(app); return; }
    FU.pressed = true;
  },
  move(app, p) {
    trackClient(p);
    if (inputBoxOpen()) return;
    FU.cur = p.w;
    if (fuStep() === 'spread') {
      fuFromCursor(app, p.w, (p.e as MouseEvent).shiftKey); FU.last = null;
      try { fuPreview(app, fuOp(app)); } catch (err) { FU.err = (err as Error).message; app.cancelPreview(); }
      app.invalidate('status'); return;
    }
    if (FU.s1) app.invalidate('canvas');
  },
  up(app, p) {
    if (fuStep() === 'spread' && FU.pressed) { FU.pressed = false; fuFromCursor(app, p.w, (p.e as MouseEvent).shiftKey); try { fuCommit(app, fuOp(app)); } catch (err) { reportError(err, 'Slash & spread'); } }
  },
  context(app, p) {
    trackClient(p);
    if (inputBoxOpen()) { inputBoxCommit(); return true; }
    if (fuStep() === 'spread') { void fuInput(app); return true; }
    return !!FU.s1;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    if (e.key === 'Escape') { if (FU.s1) { fuReset(app); app.status('Slash & spread cancelled'); return true; } app.setTool('select'); return true; }
    if (e.key === 'Backspace' && FU.s1) { if (FU.h2) FU.h2 = null; else if (FU.s2) FU.s2 = null; else if (FU.h1) FU.h1 = null; else FU.s1 = null; fuRefresh(app); return true; }
    if (e.key === 'Tab') { setToolOpt(TF, 'mode', fuMode() === 'rotate' ? 'parallel' : 'rotate'); fuRefresh(app); return true; }
    if (!FU.h1) return false;
    if (e.key === '+' || e.key === '=' || e.key === ']') { setToolOpt(TF, 'count', fuCount() + 1); fuRefresh(app); return true; }
    if (e.key === '-' || e.key === '[') { setToolOpt(TF, 'count', Math.max(1, fuCount() - 1)); if (fuCount() === 1) { FU.s2 = FU.h2 = null; } fuRefresh(app); return true; }
    if (isNumKey(e) && fuStep() === 'spread') { void fuInput(app, e.key); return true; }
    return false;
  },
  overlay(app) {
    if (!FU.s1) return '';
    const out: string[] = [];
    const col = LIVE_COL.fullness;
    const line = (a: Vec, b: Vec | null, txt: string) => { const s = app.view.toScreen(a); out.push(screenMarker(s, 'ring', col, 6), label({ x: s.x + 8, y: s.y + 16 }, txt, { col })); if (b) { const t = app.view.toScreen(b); out.push(`<path d="M${fs(s.x)} ${fs(s.y)}L${fs(t.x)} ${fs(t.y)}" stroke="${col}" stroke-width="1.6" stroke-dasharray="5 3"/>`, screenMarker(t, 'cross', col, 6)); } };
    const hov = FU.cur;
    line(FU.s1.w, FU.h1?.w ?? (fuStep() === 'hinge' ? hov : null), 'slash');
    if (FU.s2) line(FU.s2.w, FU.h2?.w ?? (fuStep() === 'lastHinge' ? hov : null), 'last');
    if (fuStep() === 'spread' && FU.cur) {
      const s = app.view.toScreen(FU.s1.w), c = app.view.toScreen(FU.cur);
      out.push(arrow(s, c, col, 1.2));
      const amt = FU.last ? `${fmt(FU.last.w0)} → ${fmt(FU.last.w1)}` : fmt(FU.amt);
      out.push(label({ x: c.x + 14, y: c.y + 18 }, `opening ${amt} ${u()} · ${fuMode()} · ${fuCount()} slash${fuCount() > 1 ? 'es' : ''}`, { col }));
      if (FU.err) out.push(label({ x: c.x + 14, y: c.y + 32 }, '⚠ ' + FU.err, { col: '#c0392b' }));
    }
    void liveShapes; void dot;
    return out.join('');
  },
};

export type { DartShape };
