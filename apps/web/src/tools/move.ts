/**
 * Move tools (palette group "Move"): Move Point (G), Move Line (Shift+G), Move / Rotate / Flip
 * Piece (Ctrl+Shift+G) and Curve / Handle (Shift+C). Select (V) only selects; geometry moves here.
 *
 * Common rules (docs/UX-RESEARCH.md §2):
 *  - verb-noun and noun-verb: a tool adopts the current selection when it fits, otherwise it
 *    prompts for a pick. The picked object becomes (and stays) the selection.
 *  - press on the object and drag = move; click it (no drag) = pick it up, it follows the cursor,
 *    the next click puts it down (AccuMark click-click).
 *  - typing a digit / "-" / "." or right-clicking while something is picked opens the input box
 *    (dX dY · distance ∠ · absolute X Y; fractions OK). Enter / right-click = OK, Esc = cancel.
 *  - Backspace = undo the last pick. Esc = cancel the move in progress; Esc when idle = back to
 *    Select (the selection is kept). Tab = next mode. Arrow keys nudge (Shift ×10).
 *  - live preview on a scratch copy of the piece; ONE undo step per move.
 *  - on a non-base size the move edits only that size's grading (amber indicator).
 *
 * Move Point · Single (default) moves exactly the grabbed point: its stored position (base) or its
 * grading for the edited size, its own handles rigidly with it. Nothing else changes, except internal
 * points tied to it by a point connection (Piece ▸ Connections), which follow by design and are
 * marked on the sheet.
 */
import { Document, rotatedLayout, flippedLayout, normalizeLayout, signedArea, type Vec, type Id, type SizeId, type Piece, type PieceLayout, type Contour } from '@prowdcad/kernel';
import type { App, SelItem, SegSel, ContourSel } from '../app';
import type { Tool, Ptr } from './tool';
import { ICON } from './tool';
import { ops, type AnchorRef } from '../ops-bridge';
import { settings, saveSettings, type Settings } from '../settings';
import { constrain45, toWorld, toLocal, dirToLocal, dirToWorld, resolveFor, contourById, deepClone, layoutOf, pieceWorldBox } from '../geometry';
import { snapPoint, SNAP_LABEL } from '../canvas/snap';
import { candidatesAt, itemHighlight, SEL_COLOR } from '../selpick';
import { contourNear } from '../hitkit';
import { sizeNameOf } from '../selection';
import { openInputBox, inputBoxOpen, inputBoxCommit, inputBoxCancel, type IBMode } from '../ui/inputbox';
import { fmt, unitLabel } from '../units-ui';
import { toast } from '../ui/toast';
import { reportError } from '../commands';
import { fs, screenMarker } from './common';
import { DoubleClick } from '../ui/dom';
import { apexDown, apexMove, apexUp, apexCancel, apexBusy, apexHint, apexOverlay } from './apexdrag';

const AMBER = '#e69500';
const THRESH_PX = 3;

// ───────────────────────── shared helpers ─────────────────────────

/** Last pointer position in client px (input box placement for keyboard-opened boxes). */
let lastClient = { x: 200, y: 200 };
function trackClient(p: Ptr) { const e = p.e as MouseEvent; if (typeof e.clientX === 'number') lastClient = { x: e.clientX, y: e.clientY }; }

function scratchDoc(app: App, ids: Id[]): Document {
  const set = new Set(ids);
  const style = { ...app.doc.style, pieces: app.doc.style.pieces.map(p => (set.has(p.id) ? deepClone(p) : p)) };
  const d = new Document(style);
  // ops run directly on the copy: no undo snapshots, no events. The edit rules of a real transaction
  // (seams follow inserted points, Lock Grading refresh, locked internal lines follow the sew line) run
  // on the copied pieces only, so the preview is exactly what the commit produces.
  let depth = 0;
  (d as unknown as { transact: (l: string, f: (s: unknown) => unknown) => unknown }).transact = (_l, f) => {
    const top = depth++ === 0;
    const cap = top ? d.captureEdit(set) : null;
    const before = top ? JSON.stringify(ids.map(id => d.style.pieces.find(p => p.id === id)).filter(Boolean)) : '';
    let ok = false;
    try { const r = f(d.style); ok = true; return r; } finally {
      depth--;
      if (top && ok && cap) d.finishEdit(cap, () => JSON.parse(before) as Piece[], set);
    }
  };
  return d;
}

/**
 * Why a point / line cannot be moved on its own because of an internal-line lock (ops/lock), or null.
 * 'line' = the whole internal is moved (Move Line): allowed for a line that follows a sew point.
 */
export function lockBlock(app: App, pieceId: Id, contourId: Id, anchorId: Id | null, what: 'point' | 'line'): string | null {
  const p = app.doc.style.pieces.find(x => x.id === pieceId); if (!p || contourId === p.sew.id) return null;
  const c = p.internals.find(x => x.id === contourId); const L = c?.lock; if (!c || !L) return null;
  const k = p.internals.indexOf(c) + 1;
  const unlock = 'right-click the line ▸ Unlock to edit it freely';
  if (L.kind === 'follow') return what === 'point' ? `Internal ${k} follows a sew point (${ops.lockSummary(p, c)}): move that point, or Move Line moves the whole line · ${unlock}` : null;
  if (L.kind === 'parallel') return `Internal ${k} is locked ${ops.lockSummary(p, c)}: change the segment or the offset (Inspector) · ${unlock}`;
  if (what === 'line') return `Internal ${k} has its ${ops.lockSummary(p, c)} — ${unlock}`;
  if (anchorId && ops.isLockDriven(p, contourId, anchorId)) return `This end point is locked to the sew line (${ops.lockSummary(p, c)}) · ${unlock}`;
  return null;
}
/** Locked internal lines of a piece (they follow the sew line when it moves). */
function lockedCount(p: Piece): number { return p.internals.filter(c => c.lock).length; }
/** Run `fn` on scratch copies of the pieces and show them as the live preview. Returns an error message or null. */
export function previewWith(app: App, ids: Id[], fn: (d: Document) => void): string | null {
  const d = scratchDoc(app, ids);
  try { fn(d); } catch (err) { app.preview.clear(); app.invalidate('canvas', 'panels'); return (err as Error).message; }
  app.preview.clear();
  for (const id of ids) app.preview.set(id, d.piece(id));
  app.invalidate('canvas', 'panels');
  return null;
}
/** Validate on a scratch copy, then apply to the document as ONE undo step. */
export function commitWith(app: App, ids: Id[], label: string, fn: (d: Document) => void): boolean {
  app.preview.clear();
  try { fn(scratchDoc(app, ids)); } catch (err) { reportError(err, label); app.invalidate(); return false; }
  try { app.doc.transact(label, () => fn(app.doc)); } catch (err) { reportError(err, label); return false; }
  app.invalidate();
  return true;
}

/** Non-base size being edited for a piece (undefined = base = all sizes). */
function editSid(app: App, piece: Piece, hitSize?: string): SizeId | undefined {
  const base = app.doc.baseSize(piece);
  const s = hitSize ?? app.sizeOf(piece);
  return s === base ? undefined : s;
}
function sizeBadge(app: App, sid: SizeId | undefined): { text: string; amber: boolean } | null {
  if (sid) return { text: `Editing size ${sizeNameOf(app, sid)} grading`, amber: true };
  return app.activeSize !== app.baseSize() ? { text: `Editing size ${sizeNameOf(app, app.activeSize)} grading`, amber: true } : null;
}
function lockedMsg(p: Piece) { return `${p.name} is locked (Ctrl+L to unlock)`; }

function anchorWorld(app: App, ref: AnchorRef, sid?: SizeId): Vec | null {
  const p = app.doc.style.pieces.find(x => x.id === ref.pieceId); if (!p) return null;
  try { return toWorld(p, ops.pointPos(app.doc, ref, sid ?? app.doc.baseSize(p))); } catch { return null; }
}
const fmtV = (d: Vec) => `dX ${fmt(d.x)}  dY ${fmt(d.y)}  L ${fmt(Math.hypot(d.x, d.y))} ${unitLabel()}`;
const isNumKey = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9.\-]$/.test(e.key);

/** Candidate under the cursor: SVG anchor targets first (they carry the nested-view size), then geometry. */
function pointUnder(app: App, p: Ptr): { ref: AnchorRef; sizeId?: string } | null {
  const h = p.hit;
  // a nested-view instance of another size: only its SVG target knows the size
  if (h.kind === 'anchor' && h.pieceId && h.anchorId && h.sizeId && h.sizeId !== app.sizeOf(app.doc.piece(h.pieceId))) return { ref: { pieceId: h.pieceId, contourId: h.contourId!, anchorId: h.anchorId }, sizeId: h.sizeId };
  // geometry: coincident points rank selected first, then sew before internal (candidatesAt)
  const c = candidatesAt(app, p.w, 'points', { kinds: ['point'] })[0];
  if (c && c.item.k === 'point') return { ref: c.item.ref, sizeId: h.kind === 'anchor' && h.anchorId === c.item.ref.anchorId ? h.sizeId : undefined };
  if (h.kind === 'anchor' && h.pieceId && h.anchorId) return { ref: { pieceId: h.pieceId, contourId: h.contourId!, anchorId: h.anchorId }, sizeId: h.sizeId };
  return null;
}

function grade(c: Contour, i: number, dir: 1 | -1): number {
  const n = c.points.length;
  for (let k = 1; k < n; k++) {
    const j = c.closed ? (((i + dir * k) % n) + n) % n : i + dir * k;
    if (j < 0 || j >= n) return -1;
    if (c.points[j].kind === 'grade') return j;
  }
  return -1;
}

// ───────────────────────── Move Point ─────────────────────────

export type MPMode = Settings['movePointMode'];
export const MP_MODES: { id: MPMode; label: string; title: string }[] = [
  { id: 'single', label: 'Single', title: 'Move Single Point: only the grabbed point moves (default)' },
  { id: 'smooth', label: 'Smooth', title: 'Move Smooth: the points between the two tacks blend (proportional)' },
  { id: 'h', label: 'Horizontal', title: 'Move Point Horizontal: X only' },
  { id: 'v', label: 'Vertical', title: 'Move Point Vertical: Y only' },
  { id: 'along', label: 'Along line', title: 'Move Point Along Line / Slide: along its own contour (base size)' },
  { id: 'group', label: 'Group', title: 'Move Points: every selected point by the same delta (rigid)' },
];
const MP_NAME: Record<MPMode, string> = { single: 'Single', smooth: 'Smooth', h: 'Horizontal', v: 'Vertical', along: 'Along line', group: 'Group' };

type MPSpec = { kind: 'delta'; d: Vec } | { kind: 'abs'; p: Vec } | { kind: 'along'; dist: number };
interface MPOp { kind: 'press' | 'drag' | 'carry'; startW: Vec; grabW: Vec; s: Vec; dW: Vec; spec: MPSpec | null; lastW: Vec; err: string | null; /** pressed again on the picked-up point (click, then press-drag) */ again?: boolean; /** snap glyph label of the current target */ snap?: string }
const MP: {
  pick: { ref: AnchorRef; sizeId?: SizeId } | null;
  before: ReturnType<App['snapshotSel']> | null;
  tacks: { prev: Id | null; next: Id | null } | null;
  op: MPOp | null;
  tackDrag: { which: 'prev' | 'next'; hover: Id | null } | null;
  frozen: boolean;
  hover: AnchorRef | null;
  last: Partial<Record<MPMode, { mode: string; v: Record<string, number> }>>;
} = { pick: null, before: null, tacks: null, op: null, tackDrag: null, frozen: false, hover: null, last: {} };

const mpMode = (): MPMode => settings.movePointMode ?? 'single';
function mpPiece(app: App): Piece | null { return MP.pick ? app.doc.style.pieces.find(p => p.id === MP.pick!.ref.pieceId) ?? null : null; }
function mpValid(app: App): boolean {
  if (MP.pick && !app.doc.style.pieces.find(p => p.id === MP.pick!.ref.pieceId)?.sew) MP.pick = null;
  if (MP.pick && !app.resolveRef(MP.pick.ref)) MP.pick = null;
  return !!MP.pick;
}
function connectionsOf(p: Piece, anchorId: Id) { return (p.connections ?? []).filter(c => c.externalAnchorId === anchorId); }

function defaultTacks(app: App, ref: AnchorRef): { prev: Id | null; next: Id | null } {
  const p = app.doc.piece(ref.pieceId); const c = contourById(p, ref.contourId)!;
  const i = c.points.findIndex(a => a.id === ref.anchorId);
  const a = grade(c, i, -1), b = grade(c, i, 1);
  return { prev: a >= 0 ? c.points[a].id : null, next: b >= 0 ? c.points[b].id : null };
}
function groupRefs(app: App): AnchorRef[] {
  const pick = MP.pick!.ref;
  const refs = app.sel.anchors.filter(r => !app.hiddenPieces.has(r.pieceId));
  return refs.some(r => r.anchorId === pick.anchorId) ? refs : [...refs, pick];
}
function mpPieceIds(app: App): Id[] {
  if (!MP.pick) return [];
  return mpMode() === 'group' ? [...new Set(groupRefs(app).map(r => r.pieceId))] : [MP.pick.ref.pieceId];
}

function mpSetPick(app: App, ref: AnchorRef, sizeId?: string, keepSelection = false) {
  const piece = app.doc.piece(ref.pieceId);
  const same = MP.pick?.ref.anchorId === ref.anchorId;
  if (!same) MP.before = app.snapshotSel();
  MP.pick = { ref, sizeId: editSid(app, piece, sizeId) };
  if (keepSelection && app.isSelected({ k: 'point', ref })) {
    // the grabbed point is already selected: keep the selection (it stays selected for further edits); the
    // grabbed point becomes primary. Only Group mode moves the others.
    app.sel.anchors = [...app.sel.anchors.filter(a => a.anchorId !== ref.anchorId), ref]; app.sel.primary = 'point'; app.invalidate();
  } else app.applySel({ k: 'point', ref }, 'replace');
  if (!same || !MP.tacks) MP.tacks = defaultTacks(app, ref);
}

/** Adopt the selection (noun → verb). */
function mpAdopt(app: App) {
  const pa = app.sel.anchors[app.sel.anchors.length - 1];
  if (pa && app.resolveRef(pa)) {
    const piece = app.doc.piece(pa.pieceId);
    if (MP.pick?.ref.anchorId !== pa.anchorId) { MP.pick = { ref: pa, sizeId: editSid(app, piece) }; MP.tacks = defaultTacks(app, pa); MP.before = null; }
    else MP.pick.sizeId = editSid(app, piece);
  } else MP.pick = null;
}

function mpApply(app: App, d: Document, spec: MPSpec) {
  const pk = MP.pick!; const r = pk.ref; const sid = pk.sizeId;
  const piece = d.piece(r.pieceId);
  if (piece.locked) throw new Error(lockedMsg(piece));
  const mode = mpMode();
  for (const g of mode === 'group' ? groupRefs(app) : [r]) { const why = lockBlock(app, g.pieceId, g.contourId, g.anchorId, 'point'); if (why) throw new Error(why); }
  const cur = () => ops.pointPos(d, r, sid ?? d.baseSize(piece));
  switch (mode) {
    case 'single': case 'h': case 'v': {
      if (spec.kind === 'along') return;
      ops.movePoint(d, r.pieceId, r.anchorId, spec.kind === 'abs' ? { x: spec.p.x, y: spec.p.y } : { dx: spec.d.x, dy: spec.d.y }, { sizeId: sid });
      return;
    }
    case 'smooth': {
      if (spec.kind === 'along') return;
      const dd = spec.kind === 'abs' ? { x: spec.p.x - cur().x, y: spec.p.y - cur().y } : spec.d;
      ops.moveProportional(d, r.pieceId, r.anchorId, dd, { fixedPrevId: MP.tacks?.prev ?? undefined, fixedNextId: MP.tacks?.next ?? undefined, sizeId: sid });
      return;
    }
    case 'along': {
      if (sid) throw new Error('Along line moves the base shape: switch to the base size (Ctrl+B)');
      if (spec.kind !== 'along') return;
      if (Math.abs(spec.dist) < 1e-9) return;
      ops.moveAlongContour(d, r.pieceId, r.anchorId, spec.dist);
      return;
    }
    case 'group': {
      if (spec.kind === 'along') return;
      const dLocal = spec.kind === 'abs' ? { x: spec.p.x - cur().x, y: spec.p.y - cur().y } : spec.d;
      const dWorld = dirToWorld(piece, dLocal);
      const by = new Map<Id, AnchorRef[]>();
      for (const g of groupRefs(app)) { const l = by.get(g.pieceId) ?? []; l.push(g); by.set(g.pieceId, l); }
      for (const [pid, refs] of by) {
        const pc = d.piece(pid);
        if (pc.locked) throw new Error(lockedMsg(pc));
        ops.multiMove(d, refs.map(x => ({ pieceId: pid, anchorId: x.anchorId })), pid === r.pieceId ? dLocal : dirToLocal(pc, dWorld), { sizeId: sid && d.sizesOf(pc).includes(sid) ? sid : undefined });
      }
    }
  }
}

/** Cursor → move spec (snap, Shift = H/V/45°, Alt = no snap, mode locks). */
function mpSpecFromCursor(app: App, op: MPOp, w: Vec, e: MouseEvent | PointerEvent): MPSpec {
  const piece = mpPiece(app)!;
  const mode = mpMode();
  if (mode === 'along') {
    const r = MP.pick!.ref;
    const h = contourNear(app, w, { pieceId: r.pieceId, contourId: r.contourId, tolPx: 1e9 });
    const c = contourById(piece, r.contourId)!; const i = c.points.findIndex(a => a.id === r.anchorId);
    const rb = resolveFor(app.doc, piece, app.doc.baseSize(piece));
    const rc = c === piece.sew ? rb.sew : rb.internals[piece.internals.indexOf(c)];
    const L = rc.cum[rc.cum.length - 1] ?? 0; const s0 = rc.cum[rc.anchorIndex[i]] ?? 0;
    let dist = (h ? h.sBase : s0) - s0;
    if (rc.closed && L > 0) { if (dist > L / 2) dist -= L; if (dist < -L / 2) dist += L; }
    op.dW = h ? { x: h.world.x - op.grabW.x, y: h.world.y - op.grabW.y } : { x: 0, y: 0 };
    return { kind: 'along', dist };
  }
  let target = { x: op.grabW.x + w.x - op.startW.x, y: op.grabW.y + w.y - op.startW.y };
  op.snap = undefined;
  if (e.shiftKey) target = constrain45(op.grabW, target);
  else if (!e.altKey) {
    const ex = new Set(mode === 'group' ? groupRefs(app).map(r => r.anchorId) : [MP.pick!.ref.anchorId]);
    const sn = snapPoint(app, target, { exclude: ex, from: op.grabW });
    target = sn.p; op.snap = SNAP_LABEL[sn.kind];
  }
  let dW = { x: target.x - op.grabW.x, y: target.y - op.grabW.y };
  if (mode === 'h') dW = { x: dW.x, y: 0 };
  if (mode === 'v') dW = { x: 0, y: dW.y };
  op.dW = dW;
  return { kind: 'delta', d: dirToLocal(piece, dW) };
}

function mpPreview(app: App, spec: MPSpec): string | null { return previewWith(app, mpPieceIds(app), d => mpApply(app, d, spec)); }

function mpLabel(): string { const m = mpMode(); return m === 'smooth' ? 'Move smooth' : m === 'group' ? 'Move points' : m === 'along' ? 'Move along line' : m === 'h' ? 'Move point horizontal' : m === 'v' ? 'Move point vertical' : 'Move point'; }

/** True when the spec moves nothing (no zero-delta undo steps). */
function mpIsNoop(app: App, spec: MPSpec): boolean {
  if (spec.kind === 'delta') return Math.hypot(spec.d.x, spec.d.y) < 1e-9;
  if (spec.kind === 'along') return Math.abs(spec.dist) < 1e-9;
  const piece = mpPiece(app); if (!piece) return true;
  const cur = ops.pointPos(app.doc, MP.pick!.ref, MP.pick!.sizeId ?? app.doc.baseSize(piece));
  return Math.hypot(spec.p.x - cur.x, spec.p.y - cur.y) < 1e-9;
}

function mpCommit(app: App, spec: MPSpec, label = mpLabel()): boolean {
  if (!MP.pick) return false;
  if (mpIsNoop(app, spec)) { MP.op = null; app.cancelPreview(); app.status('Not moved (zero distance)'); return false; }
  const ok = commitWith(app, mpPieceIds(app), label, d => mpApply(app, d, spec));
  MP.op = null;
  if (ok) {
    const mode = mpMode();
    if (spec.kind === 'delta') MP.last[mode] = { mode: 'rel', v: { dx: spec.d.x, dy: spec.d.y } };
    if (spec.kind === 'along') MP.last[mode] = { mode: 's', v: { s: spec.dist } };
    app.status(spec.kind === 'delta' ? `Moved ${fmt(spec.d.x)}, ${fmt(spec.d.y)} ${unitLabel()} · select the next point, or type / Enter to repeat` : spec.kind === 'along' ? `Slid ${fmt(spec.dist)} ${unitLabel()}` : 'Moved to the typed position');
  }
  return ok;
}

function mpCancelOp(app: App) { MP.op = null; MP.frozen = false; app.cancelPreview(); }

function mpBoxModes(app: App, cur: Vec, d0: Vec): IBMode[] {
  const mode = mpMode();
  const L = Math.hypot(d0.x, d0.y), A = Math.atan2(d0.y, d0.x) * 180 / Math.PI;
  if (mode === 'along') {
    const last = MP.last.along?.v.s ?? 0;
    return [{ id: 's', label: 'Along', fields: [{ key: 's', label: 'Distance along (+ = contour direction)', kind: 'length', value: MP.op?.spec?.kind === 'along' ? MP.op.spec.dist : last }] }];
  }
  if (mode === 'h') return [{ id: 'rel', label: 'dX', fields: [{ key: 'dx', label: 'dX', kind: 'length', value: d0.x }] }, { id: 'abs', label: 'Absolute X', fields: [{ key: 'x', label: 'X', kind: 'length', value: cur.x }] }];
  if (mode === 'v') return [{ id: 'rel', label: 'dY', fields: [{ key: 'dy', label: 'dY', kind: 'length', value: d0.y }] }, { id: 'abs', label: 'Absolute Y', fields: [{ key: 'y', label: 'Y', kind: 'length', value: cur.y }] }];
  return [
    { id: 'rel', label: 'dX dY', title: 'Relative move (piece frame)', fields: [{ key: 'dx', label: 'dX', kind: 'length', value: d0.x }, { key: 'dy', label: 'dY', kind: 'length', value: d0.y }] },
    { id: 'polar', label: 'Distance ∠', title: 'Distance and angle (0° = +X, CCW)', fields: [{ key: 'l', label: 'Distance', kind: 'length', value: L }, { key: 'a', label: 'Angle', kind: 'angle', value: Math.round(A * 1e4) / 1e4 }] },
    { id: 'abs', label: 'Absolute X Y', title: `Absolute position in the piece frame${MP.pick?.sizeId ? ' (edited size)' : ''}`, fields: [{ key: 'x', label: 'X', kind: 'length', value: cur.x }, { key: 'y', label: 'Y', kind: 'length', value: cur.y }] },
  ];
}
function mpSpecFromBox(mode: string, v: Record<string, number>, cur: Vec): MPSpec {
  const m = mpMode();
  switch (mode) {
    case 's': return { kind: 'along', dist: v.s };
    case 'polar': { const r = v.a * Math.PI / 180; return { kind: 'delta', d: { x: v.l * Math.cos(r), y: v.l * Math.sin(r) } }; }
    case 'abs': return { kind: 'abs', p: { x: v.x ?? cur.x, y: v.y ?? cur.y } };
    default: return { kind: 'delta', d: { x: m === 'v' ? 0 : v.dx ?? 0, y: m === 'h' ? 0 : v.dy ?? 0 } };
  }
}

async function mpInput(app: App, typed?: string) {
  if (!mpValid(app) || inputBoxOpen()) return;
  const piece = mpPiece(app)!;
  const sid = MP.pick!.sizeId;
  const cur = ops.pointPos(app.doc, MP.pick!.ref, sid ?? app.doc.baseSize(piece));
  const op = MP.op;
  if (op) { op.kind = 'carry'; }
  MP.frozen = true;
  const lastRel = MP.last[mpMode()]?.mode === 'rel' ? MP.last[mpMode()]!.v : null;
  const d0 = op ? dirToLocal(piece, op.dW) : lastRel ? { x: lastRel.dx, y: lastRel.dy } : { x: 0, y: 0 };
  const badge = sizeBadge(app, sid);
  const res = await openInputBox({
    title: `Move Point · ${MP_NAME[mpMode()]}`, modes: mpBoxModes(app, cur, d0), mode: mpMode() === 'along' ? 's' : 'rel', at: lastClient, typed,
    amber: badge?.text,
    onPreview: (m, v) => { if (!v) { app.cancelPreview(); return; } const e = mpPreview(app, mpSpecFromBox(m, v, cur)); app.status(e ? `⚠ ${e}` : ''); },
  });
  MP.frozen = false;
  if (!res) {
    if (MP.op) { const s = mpSpecFromCursor(app, MP.op, MP.op.lastW, new MouseEvent('move')); MP.op.spec = s; mpPreview(app, s); }
    else app.cancelPreview();
    return;
  }
  const spec = mpSpecFromBox(res.mode, res.v, cur);
  if (mpCommit(app, spec)) MP.last[mpMode()] = { mode: res.mode, v: res.v };
}

/**
 * Curve points that follow the picked grade point: the curve points without own grading between its
 * neighbouring grade points (they are placed by interpolation in graded sizes, and the curve through
 * them re-shapes in every size). Empty for curve points, Smooth / Along / Group modes.
 */
function mpFollowers(app: App): { piece: Piece; contour: Contour; idx: number[] } | null {
  if (!mpValid(app) || !['single', 'h', 'v'].includes(mpMode())) return null;
  const piece = app.doc.piece(MP.pick!.ref.pieceId); const c = contourById(piece, MP.pick!.ref.contourId); if (!c) return null;
  const i = c.points.findIndex(a => a.id === MP.pick!.ref.anchorId); if (i < 0 || c.points[i].kind !== 'grade') return null;
  const n = c.points.length; const idx: number[] = [];
  for (const dir of [-1, 1] as const) {
    for (let k = 1; k < n; k++) {
      const j = c.closed ? (((i + dir * k) % n) + n) % n : i + dir * k;
      if (j < 0 || j >= n || j === i || c.points[j].kind === 'grade') break;
      if (!Object.keys(c.points[j].grade ?? {}).length) idx.push(j);
    }
  }
  return idx.length ? { piece, contour: c, idx } : null;
}
/** Ghost of the curve before the move + "follows" marks on the curve points that follow (UX: "other points move"). */
function mpFollowOverlay(app: App): string {
  const f = mpFollowers(app); if (!f || !MP.op || MP.op.kind === 'press') return '';
  const pv = app.preview.get(f.piece.id); if (!pv) return '';
  const sizes = [app.sizeOf(f.piece), ...(app.nested && app.sel.pieces.includes(f.piece.id) ? app.doc.sizesOf(f.piece).filter(s => s !== app.sizeOf(f.piece) && !app.nestedHidden.has(s)) : [])];
  const ci = f.contour === f.piece.sew ? -1 : f.piece.internals.indexOf(f.contour);
  const out: string[] = [];
  let labelled = false;
  for (const sid of sizes) {
    let r0, r1; try { r0 = resolveFor(app.doc, f.piece, sid); r1 = resolveFor(app.doc, pv, sid); } catch { continue; }
    const c0 = ci < 0 ? r0.sew : r0.internals[ci], c1 = ci < 0 ? r1.sew : r1.internals[ci]; if (!c0 || !c1) continue;
    const pts = c0.pts.map(q => app.view.toScreen(toWorld(f.piece, q)));
    out.push(`<path d="${pts.map((q, k) => `${k ? 'L' : 'M'}${fs(q.x)} ${fs(q.y)}`).join('')}${c0.closed ? 'Z' : ''}" fill="none" stroke="#8a93a6" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/>`);
    for (const j of f.idx) {
      const a = c0.anchorPos[j], b = c1.anchorPos[j]; if (!a || !b) continue;
      const sa = app.view.toScreen(toWorld(f.piece, a)), sb = app.view.toScreen(toWorld(pv, b));
      const moved = Math.hypot(a.x - b.x, a.y - b.y) > 0.01;
      out.push(`<circle cx="${fs(sb.x)}" cy="${fs(sb.y)}" r="6" fill="none" stroke="#7b61ff" stroke-width="1.4" stroke-dasharray="2 2"/>`);
      if (moved) out.push(`<path d="M${fs(sa.x)} ${fs(sa.y)}L${fs(sb.x)} ${fs(sb.y)}" stroke="#7b61ff" stroke-width="1" opacity="0.7"/>`);
      if (!labelled) { out.push(`<text x="${fs(sb.x + 8)}" y="${fs(sb.y + 14)}" class="tool-note">follows</text>`); labelled = true; }
    }
  }
  return out.join('');
}

export const movePointTool: Tool = {
  id: 'movePoint', title: 'Move Point', group: 'move', hotkey: 'G', icon: ICON.movePoint, cursor: 'crosshair',
  activate(app) { MP.op = null; MP.frozen = false; MP.tackDrag = null; mpAdopt(app); },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); mpCancelOp(app); MP.tackDrag = null; MP.hover = null; },
  busy: () => !!MP.op || !!MP.tackDrag || apexBusy(),
  modes: () => MP_MODES,
  mode: () => mpMode(),
  setMode(app, id) { settings.movePointMode = id as MPMode; saveSettings(); mpCancelOp(app); if (MP.pick) MP.tacks = defaultTacks(app, MP.pick.ref); app.invalidate(); },
  badge(app) { mpValid(app); const p = mpPiece(app); return sizeBadge(app, p ? MP.pick!.sizeId : editSidActive(app)); },

  hint(app) {
    const m = mpMode(); const head = `Move Point · ${MP_NAME[m]}`;
    const ah = apexHint(); if (ah) return ah;
    if (MP.tackDrag) return `${head} · Release on a point of the same line to put the tack there · Esc cancel`;
    if (!mpValid(app)) return `${head} · Select point to move · Tab = mode · Esc = back to Select`;
    const piece = mpPiece(app)!;
    const conn = m === 'single' || m === 'h' || m === 'v' ? connectionsOf(piece, MP.pick!.ref.anchorId).length : 0;
    const nl = MP.pick!.ref.contourId === piece.sew.id ? lockedCount(piece) : 0;
    const extra = (conn ? ` · ${conn} connected internal point${conn > 1 ? 's' : ''} follow${conn > 1 ? '' : 's'} (point connection)` : '')
      + (nl ? ` · 🔒 ${nl} locked internal line${nl > 1 ? 's follow' : ' follows'} the sew line` : '');
    if (MP.op && MP.op.kind !== 'press') {
      const v = MP.op.spec?.kind === 'along' ? `Along ${fmt(MP.op.spec.dist)} ${unitLabel()}` : fmtV(dirToLocal(piece, MP.op.dW));
      const fl = mpFollowers(app);
      const follow = fl ? ` · ${fl.idx.length} curve point${fl.idx.length > 1 ? 's' : ''} follow${fl.idx.length > 1 ? '' : 's'} (no own grading) — use Move Point ▸ Single on ${fl.idx.length > 1 ? 'them' : 'it'} to fix ${fl.idx.length > 1 ? 'them' : 'it'}, or Point ▸ Pin curve point` : '';
      return `${head} · ${v} · ${MP.op.kind === 'carry' ? 'click to place' : 'release to place'} · type a value or right-click = input box · Shift H/V/45° · Alt no snap · Esc cancel${extra}${follow}${MP.op.err ? ' · ⚠ ' + MP.op.err : ''}`;
    }
    const what = m === 'group' ? `Group: ${groupRefs(app).length} point(s) · drag one of them` : m === 'smooth' ? 'Drag the point (tacks fix the blended range; drag a tack to change it)' : m === 'along' ? 'Drag along the line' : 'Drag the point, or click it then click the new spot';
    return `${head} · ${what} · type dX dY or right-click = input box · arrows nudge · ⌫ undo pick · Esc = Select${extra}`;
  },

  down(app, p) {
    trackClient(p);
    if (inputBoxOpen() || MP.frozen) return;
    if (MP.op?.kind === 'carry') {
      const op = MP.op;
      // pressed again where it was picked up (click, then press-drag): start a drag, never a 0-delta move
      if (Math.hypot(p.s.x - op.s.x, p.s.y - op.s.y) < 6) { MP.op = { ...op, kind: 'press', s: p.s, again: true }; app.cancelPreview(); return; }
      const spec = mpSpecFromCursor(app, op, p.w, p.e);
      op.spec = spec; mpCommit(app, spec); return;
    }
    // smooth: grab a tack
    if (mpMode() === 'smooth' && mpValid(app) && MP.tacks) {
      for (const which of ['prev', 'next'] as const) {
        const id = MP.tacks[which]; if (!id) continue;
        const tw = anchorWorld(app, { ...MP.pick!.ref, anchorId: id }, MP.pick!.sizeId); if (!tw) continue;
        const s = app.view.toScreen(tw);
        if (Math.hypot(s.x - p.s.x, s.y - (p.s.y - 14)) < 9 || Math.hypot(s.x - p.s.x, s.y - p.s.y) < 6) {
          MP.tackDrag = { which, hover: null }; return;
        }
      }
    }
    const hit = pointUnder(app, p);
    if (!hit && apexDown(app, p)) return;
    if (!hit) { app.status('Nothing to pick here: click a point (or press on a dart apex and drag)'); return; }
    const piece = app.doc.piece(hit.ref.pieceId);
    if (piece.locked) { toast(lockedMsg(piece), 'warn'); return; }
    const why = mpMode() === 'group' ? null : lockBlock(app, hit.ref.pieceId, hit.ref.contourId, hit.ref.anchorId, 'point');
    if (why) { app.applySel({ k: 'point', ref: hit.ref }, 'replace'); toast(why, 'warn'); app.status('🔒 ' + why); return; }
    mpSetPick(app, hit.ref, hit.sizeId, true);
    if (mpMode() === 'along' && MP.pick!.sizeId) { toast('Along line moves the base shape: switch to the base size (Ctrl+B)', 'warn'); return; }
    const grabW = anchorWorld(app, hit.ref, MP.pick!.sizeId) ?? p.w;
    MP.op = { kind: 'press', startW: p.w, grabW, s: p.s, dW: { x: 0, y: 0 }, spec: null, lastW: p.w, err: null };
    app.invalidate();
  },
  move(app, p) {
    trackClient(p);
    if (MP.frozen) return;
    if (MP.tackDrag) {
      const r = MP.pick!.ref;
      const c = candidatesAt(app, p.w, 'points', { kinds: ['point'] }).find(x => x.item.k === 'point' && x.item.ref.contourId === r.contourId && x.item.ref.pieceId === r.pieceId && x.item.ref.anchorId !== r.anchorId);
      MP.tackDrag.hover = c && c.item.k === 'point' ? c.item.ref.anchorId : null;
      app.invalidate('canvas', 'status'); return;
    }
    if (!MP.op && apexMove(app, p)) return;
    const op = MP.op;
    if (!op) {
      const c = candidatesAt(app, p.w, 'points', { kinds: ['point'] })[0];
      const nh = c && c.item.k === 'point' ? c.item.ref : null;
      if (nh?.anchorId !== MP.hover?.anchorId) { MP.hover = nh; app.invalidate('canvas'); }
      return;
    }
    op.lastW = p.w;
    if (op.kind === 'press') { if (Math.hypot(p.s.x - op.s.x, p.s.y - op.s.y) < THRESH_PX) return; op.kind = 'drag'; }
    const spec = mpSpecFromCursor(app, op, p.w, p.e);
    op.spec = spec;
    op.err = mpPreview(app, spec);
    app.invalidate('status');
  },
  up(app, p) {
    if (apexUp(app, p)) return;
    if (MP.tackDrag) {
      const td = MP.tackDrag; MP.tackDrag = null;
      if (td.hover && MP.tacks) {
        const r = MP.pick!.ref; const pc = app.doc.piece(r.pieceId); const c = contourById(pc, r.contourId)!;
        const ip = c.points.findIndex(a => a.id === r.anchorId), it = c.points.findIndex(a => a.id === td.hover);
        const other = MP.tacks[td.which === 'prev' ? 'next' : 'prev'];
        const okSide = c.closed || (td.which === 'prev' ? it < ip : it > ip);
        if (!okSide || td.hover === other) toast(`That point cannot be the ${td.which === 'prev' ? 'first' : 'second'} tack`, 'warn');
        else { MP.tacks[td.which] = td.hover; app.status('Tack moved: points between the tacks blend'); }
      }
      app.invalidate(); return;
    }
    const op = MP.op; if (!op || MP.frozen) return;
    if (op.kind === 'press' && op.again) { mpCancelOp(app); app.status('Put back (clicked the picked-up point again)'); app.invalidate(); return; }
    if (op.kind === 'press') {
      op.kind = 'carry';
      const spec = mpSpecFromCursor(app, op, p.w, p.e); op.spec = spec;
      app.invalidate(); return;
    }
    if (op.kind === 'drag') { const spec = op.spec ?? mpSpecFromCursor(app, op, p.w, p.e); mpCommit(app, spec); }
  },
  context(app, p) {
    trackClient(p);
    if (inputBoxOpen()) { inputBoxCommit(); return true; }
    if (MP.tackDrag) { MP.tackDrag = null; app.invalidate(); return true; }
    if (mpValid(app) && (MP.op || app.isSelected({ k: 'point', ref: MP.pick!.ref }))) { void mpInput(app); return true; }
    return false;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    if (e.key === 'Escape') {
      if (apexCancel(app)) return true;
      if (MP.tackDrag) { MP.tackDrag = null; app.invalidate(); return true; }
      if (MP.op) { mpCancelOp(app); app.status('Move cancelled'); return true; }
      app.setTool('select'); return true;
    }
    if (e.key === 'Backspace') {
      if (MP.op) { mpCancelOp(app); return true; }
      if (MP.pick) { const b = MP.before; MP.pick = null; MP.before = null; if (b) app.restoreSel(b); app.status('Pick undone'); app.invalidate(); return true; }
      app.status('Nothing picked'); return true;
    }
    if (e.key === 'Tab' && !MP.op) {
      const i = MP_MODES.findIndex(m => m.id === mpMode());
      movePointTool.setMode!(app, MP_MODES[(i + (e.shiftKey ? MP_MODES.length - 1 : 1)) % MP_MODES.length].id);
      return true;
    }
    if (e.key === 'Enter' && !MP.op && mpValid(app)) {
      const last = MP.last[mpMode()];
      if (!last) { void mpInput(app); return true; }
      const piece = mpPiece(app)!;
      const cur = ops.pointPos(app.doc, MP.pick!.ref, MP.pick!.sizeId ?? app.doc.baseSize(piece));
      mpCommit(app, mpSpecFromBox(last.mode, last.v, cur), 'Repeat move'); return true;
    }
    if (isNumKey(e) && mpValid(app)) { void mpInput(app, e.key); return true; }
    return false;
  },
  nudge(app, dx, dy) {
    if (!mpValid(app)) { app.status('Move Point: select a point first'); return; }
    if (MP.op) return;
    const piece = mpPiece(app)!;
    const mode = mpMode();
    if (mode === 'along') { mpCommit(app, { kind: 'along', dist: (dx || dy) }, 'Nudge point'); return; }
    const dW = { x: mode === 'v' ? 0 : dx, y: mode === 'h' ? 0 : dy };
    mpCommit(app, { kind: 'delta', d: dirToLocal(piece, dW) }, mode === 'group' ? 'Nudge points' : 'Nudge point');
  },
  overlay(app) {
    const out: string[] = [apexOverlay(app)];
    if (MP.hover && !MP.op) out.push(itemHighlight(app, { k: 'point', ref: MP.hover }, 0.5));
    if (!mpValid(app)) return out.join('');
    const r = MP.pick!.ref; const sid = MP.pick!.sizeId;
    const piece = app.piece(r.pieceId)!;
    // the picked point (current preview position)
    const q = app.resolveRef(r);
    if (q) {
      const rr = resolveFor(app.doc, piece, sid ?? app.doc.baseSize(piece));
      const ci = q.contour === piece.sew ? -1 : piece.internals.indexOf(q.contour);
      const pos = (ci < 0 ? rr.sew : rr.internals[ci])?.anchorPos[q.index];
      if (pos) { const s = app.view.toScreen(toWorld(piece, pos)); out.push(`<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="8" stroke="${sid ? AMBER : SEL_COLOR}" stroke-width="2.2" fill="none"/>`); }
    }
    // point connections (the documented exception): mark the internal points that follow
    if (['single', 'h', 'v'].includes(mpMode())) {
      for (const c of connectionsOf(piece, r.anchorId)) {
        const w = anchorWorld(app, { pieceId: r.pieceId, contourId: c.internalContourId, anchorId: c.internalAnchorId }, sid);
        if (w) { const s = app.view.toScreen(w); out.push(`<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="6" stroke="#16a085" stroke-width="1.6" stroke-dasharray="2 2" fill="none"/><text x="${fs(s.x + 8)}" y="${fs(s.y - 8)}" class="tool-note">connected</text>`); }
      }
    }
    // smooth: tacks
    if (mpMode() === 'smooth' && MP.tacks) {
      for (const which of ['prev', 'next'] as const) {
        const id = MP.tackDrag?.which === which && MP.tackDrag.hover ? MP.tackDrag.hover : MP.tacks[which]; if (!id) continue;
        const w = anchorWorld(app, { ...r, anchorId: id }, sid); if (!w) continue;
        out.push(tack(app.view.toScreen(w), MP.tackDrag?.which === which));
      }
    }
    out.push(mpFollowOverlay(app));
    if (MP.op && MP.op.kind !== 'press') {
      const a = app.view.toScreen(MP.op.grabW), b = app.view.toScreen({ x: MP.op.grabW.x + MP.op.dW.x, y: MP.op.grabW.y + MP.op.dW.y });
      out.push(`<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="${SEL_COLOR}" stroke-width="1" stroke-dasharray="3 3"/>` + screenMarker(b, 'cross', SEL_COLOR, 7));
      if (MP.op.snap) out.push(`<text x="${fs(b.x + 9)}" y="${fs(b.y - 9)}" class="tool-note snap-note">${MP.op.snap}</text>`);
    }
    return out.join('');
  },
};
function editSidActive(app: App): SizeId | undefined { return app.activeSize === app.baseSize() ? undefined : app.activeSize; }
function tack(s: Vec, active: boolean): string {
  const c = active ? '#d6309b' : '#c0392b';
  return `<g><path d="M${fs(s.x)} ${fs(s.y)}L${fs(s.x)} ${fs(s.y - 10)}" stroke="${c}" stroke-width="1.6"/><circle cx="${fs(s.x)}" cy="${fs(s.y - 14)}" r="4.5" fill="${c}" stroke="#fff" stroke-width="1"/></g>`;
}

// ───────────────────────── Move Line / Segment ─────────────────────────

type LPick = { kind: 'segment'; seg: SegSel } | { kind: 'internal'; c: ContourSel };
interface LOp { kind: 'press' | 'drag' | 'carry'; startW: Vec; s: Vec; dW: Vec; lastW: Vec; err: string | null; again?: boolean }
const ML: { pick: LPick | null; before: ReturnType<App['snapshotSel']> | null; op: LOp | null; frozen: boolean; hover: SelItem | null; last: { mode: string; v: Record<string, number> } | null } =
  { pick: null, before: null, op: null, frozen: false, hover: null, last: null };
const mlMode = (): Settings['moveLineMode'] => settings.moveLineMode ?? 'translate';
const ML_MODES = [
  { id: 'translate', label: 'Translate', title: 'Move Line: both end points and the curve points between them move by the same delta' },
  { id: 'parallel', label: 'Parallel', title: 'Move Parallel / Offset: motion locked to the line normal' },
];
function mlItem(p: LPick): SelItem { return p.kind === 'segment' ? { k: 'segment', seg: p.seg } : { k: 'internal', c: p.c }; }
function mlPieceId(p: LPick) { return p.kind === 'segment' ? p.seg.pieceId : p.c.pieceId; }
function mlValid(app: App): boolean {
  const p = ML.pick; if (!p) return false;
  const pc = app.doc.style.pieces.find(x => x.id === mlPieceId(p));
  const c = pc && contourById(pc, p.kind === 'segment' ? p.seg.contourId : p.c.contourId);
  if (!c || (p.kind === 'segment' && !(c.points.some(a => a.id === p.seg.from) && c.points.some(a => a.id === p.seg.to)))) ML.pick = null;
  return !!ML.pick;
}
/** Anchor ids that move: segment = from … to (contour direction, inclusive); internal = all. */
function mlTargets(app: App, pk: LPick): Id[] {
  const pc = app.doc.piece(mlPieceId(pk));
  if (pk.kind === 'internal') return pc.internals.find(c => c.id === pk.c.contourId)?.points.map(a => a.id) ?? [];
  const c = contourById(pc, pk.seg.contourId)!; const n = c.points.length;
  const ia = c.points.findIndex(a => a.id === pk.seg.from), ib = c.points.findIndex(a => a.id === pk.seg.to);
  const out: Id[] = [];
  for (let i = ia, g = 0; g <= n; g++) { out.push(c.points[i].id); if (i === ib && g > 0) break; if (i === ib && ia !== ib) break; i = c.closed ? (i + 1) % n : i + 1; if (i >= n) break; }
  return [...new Set(out)];
}
/** Unit normal (world) of the picked line: outward for sew segments, left of the direction for internals. */
function mlNormal(app: App, pk: LPick): Vec {
  const pc = app.doc.piece(mlPieceId(pk)); const ids = mlTargets(app, pk);
  const cid = pk.kind === 'segment' ? pk.seg.contourId : pk.c.contourId; const c = contourById(pc, cid)!;
  const r = resolveFor(app.doc, pc, app.sizeOf(pc)); const rc = c === pc.sew ? r.sew : r.internals[pc.internals.indexOf(c)];
  const a = rc.anchorPos[c.points.findIndex(x => x.id === ids[0])], b = rc.anchorPos[c.points.findIndex(x => x.id === ids[ids.length - 1])];
  let t = { x: b.x - a.x, y: b.y - a.y }; const l = Math.hypot(t.x, t.y) || 1; t = { x: t.x / l, y: t.y / l };
  let n = { x: -t.y, y: t.x }; // left (local)
  if (c === pc.sew && signedArea(r.sew.pts) > 0) n = { x: t.y, y: -t.x }; // CCW outline: outward = right
  const nw = dirToWorld(pc, n); const L = Math.hypot(nw.x, nw.y) || 1; return { x: nw.x / L, y: nw.y / L };
}
function mlSid(app: App, pk: LPick) { return editSid(app, app.doc.piece(mlPieceId(pk))); }
function mlApply(app: App, d: Document, pk: LPick, dLocal: Vec) {
  const pid = mlPieceId(pk); const pc = d.piece(pid);
  if (pc.locked) throw new Error(lockedMsg(pc));
  if (pk.kind === 'internal') { const why = lockBlock(app, pid, pk.c.contourId, null, 'line'); if (why) throw new Error(why); }
  ops.multiMove(d, mlTargets(app, pk).map(anchorId => ({ pieceId: pid, anchorId })), dLocal, { sizeId: mlSid(app, pk) });
}
function mlDeltaFromCursor(app: App, op: LOp, w: Vec, e: MouseEvent | PointerEvent): Vec {
  let dW = { x: w.x - op.startW.x, y: w.y - op.startW.y };
  if (mlMode() === 'parallel') { const n = mlNormal(app, ML.pick!); const k = dW.x * n.x + dW.y * n.y; dW = { x: n.x * k, y: n.y * k }; }
  else if (e.shiftKey) dW = constrain45({ x: 0, y: 0 }, dW);
  op.dW = dW;
  return dirToLocal(app.doc.piece(mlPieceId(ML.pick!)), dW);
}
function mlCommit(app: App, dLocal: Vec, label = 'Move line'): boolean {
  const pk = ML.pick!; ML.op = null;
  if (Math.hypot(dLocal.x, dLocal.y) < 1e-9) { app.cancelPreview(); app.status('Not moved (zero distance)'); return false; }
  const ok = commitWith(app, [mlPieceId(pk)], label, d => mlApply(app, d, pk, dLocal));
  if (ok) { ML.last = { mode: 'rel', v: { dx: dLocal.x, dy: dLocal.y } }; app.status(`Line moved ${fmt(dLocal.x)}, ${fmt(dLocal.y)} ${unitLabel()}`); }
  return ok;
}
function mlSetPick(app: App, pk: LPick) {
  const same = ML.pick && JSON.stringify(ML.pick) === JSON.stringify(pk);
  if (!same) ML.before = app.snapshotSel();
  ML.pick = pk; app.applySel(mlItem(pk), 'replace');
}
function mlAdopt(app: App) {
  const s = app.sel;
  if (s.segments.length && (s.primary === 'segment' || !s.internals.length)) ML.pick = { kind: 'segment', seg: s.segments[s.segments.length - 1] };
  else if (s.internals.length) ML.pick = { kind: 'internal', c: s.internals[s.internals.length - 1] };
  else if (s.anchors.length >= 2) {
    const [a, b] = s.anchors.slice(-2);
    if (a.pieceId === b.pieceId && a.contourId === b.contourId && a.anchorId !== b.anchorId) ML.pick = { kind: 'segment', seg: { pieceId: a.pieceId, contourId: a.contourId, from: a.anchorId, to: b.anchorId } };
  } else ML.pick = null;
  ML.before = null;
}
async function mlInput(app: App, typed?: string) {
  if (!mlValid(app) || inputBoxOpen()) return;
  const pk = ML.pick!; const pc = app.doc.piece(mlPieceId(pk));
  if (ML.op) ML.op.kind = 'carry';
  ML.frozen = true;
  const d0 = ML.op ? dirToLocal(pc, ML.op.dW) : ML.last ? { x: ML.last.v.dx ?? 0, y: ML.last.v.dy ?? 0 } : { x: 0, y: 0 };
  const nW = mlNormal(app, pk), nL = dirToLocal(pc, nW);
  const off0 = d0.x * nL.x + d0.y * nL.y;
  const modes: IBMode[] = mlMode() === 'parallel'
    ? [{ id: 'off', label: 'Offset', fields: [{ key: 'o', label: 'Offset (+ outward / left)', kind: 'length', value: off0 }] }]
    : [{ id: 'rel', label: 'dX dY', fields: [{ key: 'dx', label: 'dX', kind: 'length', value: d0.x }, { key: 'dy', label: 'dY', kind: 'length', value: d0.y }] },
      { id: 'polar', label: 'Distance ∠', fields: [{ key: 'l', label: 'Distance', kind: 'length', value: Math.hypot(d0.x, d0.y) }, { key: 'a', label: 'Angle', kind: 'angle', value: Math.round(Math.atan2(d0.y, d0.x) * 180 / Math.PI * 1e4) / 1e4 }] },
      { id: 'off', label: 'Offset', title: 'Perpendicular offset', fields: [{ key: 'o', label: 'Offset (+ outward / left)', kind: 'length', value: off0 }] }];
  const toD = (m: string, v: Record<string, number>): Vec => m === 'off' ? { x: nL.x * v.o, y: nL.y * v.o } : m === 'polar' ? { x: v.l * Math.cos(v.a * Math.PI / 180), y: v.l * Math.sin(v.a * Math.PI / 180) } : { x: v.dx, y: v.dy };
  const res = await openInputBox({
    title: `Move Line · ${mlMode() === 'parallel' ? 'Parallel' : 'Translate'}`, modes, at: lastClient, typed, amber: sizeBadge(app, mlSid(app, pk))?.text,
    onPreview: (m, v) => { if (!v) { app.cancelPreview(); return; } previewWith(app, [pc.id], d => mlApply(app, d, pk, toD(m, v))); },
  });
  ML.frozen = false;
  if (!res) { if (ML.op) previewWith(app, [pc.id], d => mlApply(app, d, pk, mlDeltaFromCursor(app, ML.op!, ML.op!.lastW, new MouseEvent('move')))); else app.cancelPreview(); return; }
  if (mlCommit(app, toD(res.mode, res.v))) ML.last = { mode: res.mode, v: res.v };
}
export const moveLineTool: Tool = {
  id: 'moveLine', title: 'Move Line / Segment', group: 'move', hotkey: 'Shift+G', icon: ICON.moveLine, cursor: 'crosshair',
  activate(app) { ML.op = null; ML.frozen = false; mlAdopt(app); },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); ML.op = null; ML.frozen = false; ML.hover = null; app.cancelPreview(); },
  busy: () => !!ML.op,
  modes: () => ML_MODES,
  mode: () => mlMode(),
  setMode(app, id) { settings.moveLineMode = id as Settings['moveLineMode']; saveSettings(); ML.op = null; app.cancelPreview(); app.invalidate(); },
  badge(app) { return sizeBadge(app, mlValid(app) ? mlSid(app, ML.pick!) : editSidActive(app)); },
  hint(app) {
    const head = `Move Line · ${mlMode() === 'parallel' ? 'Parallel' : 'Translate'}`;
    if (!mlValid(app)) return `${head} · Select segment (or internal line) to move · Tab = mode · Esc = back to Select`;
    if (ML.op && ML.op.kind !== 'press') {
      const pc = app.doc.piece(mlPieceId(ML.pick!));
      return `${head} · ${fmtV(dirToLocal(pc, ML.op.dW))} · ${ML.op.kind === 'carry' ? 'click to place' : 'release to place'} · type a value or right-click = input box · Shift H/V/45° · Esc cancel${ML.op.err ? ' · ⚠ ' + ML.op.err : ''}`;
    }
    const n = mlTargets(app, ML.pick!).length;
    return `${head} · ${ML.pick!.kind === 'segment' ? 'Segment' : 'Internal line'} (${n} point${n > 1 ? 's' : ''} move) · drag it, or click then click the new spot · type a value or right-click = input box · arrows nudge · ⌫ undo pick · Esc = Select`;
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen() || ML.frozen) return;
    if (ML.op?.kind === 'carry') {
      if (Math.hypot(p.s.x - ML.op.s.x, p.s.y - ML.op.s.y) < 6) { ML.op = { ...ML.op, kind: 'press', s: p.s, again: true }; app.cancelPreview(); return; }
      mlCommit(app, mlDeltaFromCursor(app, ML.op, p.w, p.e)); return;
    }
    const c = candidatesAt(app, p.w, 'all', { kinds: ['segment', 'internal'] })[0];
    if (!c) { app.status('Nothing to pick here: click a segment or an internal line'); return; }
    const pk: LPick = c.item.k === 'segment' ? { kind: 'segment', seg: c.item.seg } : { kind: 'internal', c: (c.item as { c: ContourSel }).c };
    const pc = app.doc.piece(mlPieceId(pk));
    if (pc.locked) { toast(lockedMsg(pc), 'warn'); return; }
    const why = pk.kind === 'internal' ? lockBlock(app, pc.id, pk.c.contourId, null, 'line') : null;
    if (why) { app.applySel(mlItem(pk), 'replace'); toast(why, 'warn'); app.status('🔒 ' + why); return; }
    mlSetPick(app, pk);
    ML.op = { kind: 'press', startW: p.w, s: p.s, dW: { x: 0, y: 0 }, lastW: p.w, err: null };
  },
  move(app, p) {
    trackClient(p);
    if (ML.frozen) return;
    const op = ML.op;
    if (!op) {
      const c = candidatesAt(app, p.w, 'all', { kinds: ['segment', 'internal'] })[0] ?? null;
      const k = c ? JSON.stringify(c.item) : '', o = ML.hover ? JSON.stringify(ML.hover) : '';
      if (k !== o) { ML.hover = c?.item ?? null; app.invalidate('canvas'); }
      return;
    }
    op.lastW = p.w;
    if (op.kind === 'press') { if (Math.hypot(p.s.x - op.s.x, p.s.y - op.s.y) < THRESH_PX) return; op.kind = 'drag'; }
    const dL = mlDeltaFromCursor(app, op, p.w, p.e);
    const pk = ML.pick!;
    op.err = previewWith(app, [mlPieceId(pk)], d => mlApply(app, d, pk, dL));
    app.invalidate('status');
  },
  up(app, p) {
    const op = ML.op; if (!op || ML.frozen) return;
    if (op.kind === 'press' && op.again) { ML.op = null; app.cancelPreview(); app.status('Put back (clicked the picked-up line again)'); return; }
    if (op.kind === 'press') { op.kind = 'carry'; app.invalidate(); return; }
    if (op.kind === 'drag') mlCommit(app, mlDeltaFromCursor(app, op, p.w, p.e));
  },
  context(app, p) {
    trackClient(p);
    if (inputBoxOpen()) { inputBoxCommit(); return true; }
    if (mlValid(app)) { void mlInput(app); return true; }
    return false;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    if (e.key === 'Escape') { if (ML.op) { ML.op = null; app.cancelPreview(); app.status('Move cancelled'); return true; } app.setTool('select'); return true; }
    if (e.key === 'Backspace') {
      if (ML.op) { ML.op = null; app.cancelPreview(); return true; }
      if (ML.pick) { const b = ML.before; ML.pick = null; ML.before = null; if (b) app.restoreSel(b); app.status('Pick undone'); return true; }
      app.status('Nothing picked'); return true;
    }
    if (e.key === 'Tab' && !ML.op) { moveLineTool.setMode!(app, mlMode() === 'translate' ? 'parallel' : 'translate'); return true; }
    if (e.key === 'Enter' && !ML.op && mlValid(app) && ML.last) {
      const pc = app.doc.piece(mlPieceId(ML.pick!)); const v = ML.last.v;
      const nL = dirToLocal(pc, mlNormal(app, ML.pick!));
      mlCommit(app, ML.last.mode === 'off' ? { x: nL.x * v.o, y: nL.y * v.o } : ML.last.mode === 'polar' ? { x: v.l * Math.cos(v.a * Math.PI / 180), y: v.l * Math.sin(v.a * Math.PI / 180) } : { x: v.dx, y: v.dy }, 'Repeat move line');
      return true;
    }
    if (isNumKey(e) && mlValid(app)) { void mlInput(app, e.key); return true; }
    return false;
  },
  nudge(app, dx, dy) {
    if (!mlValid(app)) { app.status('Move Line: select a segment first'); return; }
    const pc = app.doc.piece(mlPieceId(ML.pick!));
    let dW = { x: dx, y: dy };
    if (mlMode() === 'parallel') { const n = mlNormal(app, ML.pick!); const k = dW.x * n.x + dW.y * n.y || Math.hypot(dx, dy) * Math.sign(dx + dy); dW = { x: n.x * k, y: n.y * k }; }
    mlCommit(app, dirToLocal(pc, dW), 'Nudge line');
  },
  overlay(app) {
    const out: string[] = [];
    if (ML.hover && !ML.op) out.push(itemHighlight(app, ML.hover, 0.5));
    if (mlValid(app)) {
      const sid = mlSid(app, ML.pick!);
      out.push(itemHighlight(app, mlItem(ML.pick!), 1, sid ? AMBER : SEL_COLOR));
    }
    return out.join('');
  },
};

// ───────────────────────── Piece: move / rotate / flip ─────────────────────────

type PMode = Settings['pieceToolMode'];
const PC_MODES = [
  { id: 'move', label: 'Move', title: 'Move Piece: drag (R / Shift+R ±90°, Q W ±1°, A S ±10°, X / Y flip while dragging)' },
  { id: 'rotate', label: 'Rotate', title: 'Rotate Piece about its centre: drag or type an angle (Ctrl = 15° steps)' },
  { id: 'flip', label: 'Flip', title: 'Flip Piece: click = left ⇄ right, Shift+click = up ⇄ down' },
];
type XF = { rot?: number; flip?: 'h' | 'v' };
interface POp { kind: 'press' | 'drag' | 'carry'; ids: Id[]; base: Map<Id, PieceLayout>; startW: Vec; s: Vec; d: Vec; xf: XF[]; pivot: Vec; a0: number; deg: number; lastW: Vec; again?: boolean }
const PCS: { op: POp | null; frozen: boolean; hover: Id | null } = { op: null, frozen: false, hover: null };
const pcMode = (): PMode => settings.pieceToolMode ?? 'move';

function pcLayout(op: POp, id: Id, mode: PMode): PieceLayout {
  let L: PieceLayout = { ...op.base.get(id)! };
  if (mode === 'rotate') return rotatedLayout(L, op.deg, op.pivot);
  for (const x of op.xf) { if (x.rot) L = rotatedLayout(L, x.rot, op.startW); if (x.flip) L = flippedLayout(L, x.flip, op.startW); }
  return normalizeLayout({ ...L, x: L.x + op.d.x, y: L.y + op.d.y });
}
function pcPreview(app: App) {
  const op = PCS.op!; const mode = pcMode();
  for (const id of op.ids) app.beginPreview(id).layout = pcLayout(op, id, mode);
  app.invalidate('canvas', 'panels', 'status');
}
function pcCommit(app: App, label: string) {
  const op = PCS.op!; PCS.op = null; const mode = pcMode();
  const lay = new Map(op.ids.map(id => [id, pcLayout(op, id, mode)]));
  if ([...lay].every(([id, L]) => JSON.stringify(normalizeLayout(L)) === JSON.stringify(normalizeLayout(op.base.get(id)!)))) { app.preview.clear(); app.status('Not moved'); app.invalidate(); return; }
  app.preview.clear();
  try { app.doc.transact(label, () => { for (const [id, L] of lay) app.doc.piece(id).layout = L; }); } catch (err) { reportError(err, label); }
  app.invalidate();
}
function pcIdsFor(app: App, pc: Piece): Id[] | null {
  const ids = app.sel.pieces.includes(pc.id) && !app.hasSubSelection() ? app.sel.pieces.slice() : [pc.id];
  const locked = ids.map(id => app.doc.piece(id)).find(p => p.locked);
  if (locked) { toast(lockedMsg(locked), 'warn'); return null; }
  if (!app.sel.pieces.includes(pc.id) || app.hasSubSelection()) app.applySel({ k: 'piece', pieceId: pc.id }, 'replace');
  return ids;
}
function pcCentre(app: App, ids: Id[]): Vec {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) { const b = pieceWorldBox(app.doc, app.doc.piece(id), app.sizeOf(app.doc.piece(id))); minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY); }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}
function pcPieceAt(app: App, w: Vec): Piece | null {
  const c = candidatesAt(app, w, 'all', { kinds: ['piece', 'segment'] })[0];
  if (!c) return null;
  return app.doc.piece(c.item.k === 'piece' ? c.item.pieceId : (c.item as { seg: SegSel }).seg.pieceId);
}
/** Flip the given pieces about their common centre (one undo step). */
export function flipPieces(app: App, ids: Id[], axis: 'h' | 'v') {
  if (!ids.length) { app.status('Select a piece to flip'); return; }
  const locked = ids.map(id => app.doc.piece(id)).find(p => p.locked);
  if (locked) { toast(lockedMsg(locked), 'warn'); return; }
  try { ops.transformPieceLayouts(app.doc, ids, { flip: axis, pivot: pcCentre(app, ids) }, axis === 'h' ? 'Flip piece left ⇄ right' : 'Flip piece up ⇄ down'); app.status(`Flipped ${ids.length} piece(s) ${axis === 'h' ? 'left ⇄ right' : 'up ⇄ down'} (sheet placement; exports keep the authored geometry)`); } catch (err) { reportError(err, 'Flip piece'); }
}
/** Noun → verb: an op on the selected pieces (Rotate pivots about their centre), for typed input. */
function pcAdopt(app: App): POp | null {
  const ids = app.sel.pieces.filter(id => app.doc.style.pieces.some(p => p.id === id));
  if (!ids.length) return null;
  const locked = ids.map(id => app.doc.piece(id)).find(p => p.locked);
  if (locked) { toast(lockedMsg(locked), 'warn'); return null; }
  const c = pcCentre(app, ids);
  return { kind: 'carry', ids, base: new Map(ids.map(id => [id, { ...layoutOf(app.doc.piece(id)) }])), startW: c, s: app.view.toScreen(c), d: { x: 0, y: 0 }, xf: [], pivot: c, a0: 0, deg: 0, lastW: c };
}
async function pcInput(app: App, typed?: string) {
  if (!PCS.op && !inputBoxOpen() && pcMode() !== 'flip') PCS.op = pcAdopt(app);
  const op = PCS.op; if (!op || inputBoxOpen()) return;
  op.kind = 'carry'; PCS.frozen = true;
  const mode = pcMode();
  const modes: IBMode[] = mode === 'rotate'
    ? [{ id: 'rot', label: 'Angle', fields: [{ key: 'a', label: 'Angle (CCW +)', kind: 'angle', value: Math.round(op.deg * 1e4) / 1e4 }] }]
    : [{ id: 'rel', label: 'dX dY', fields: [{ key: 'dx', label: 'dX', kind: 'length', value: op.d.x }, { key: 'dy', label: 'dY', kind: 'length', value: op.d.y }] },
      { id: 'polar', label: 'Distance ∠', fields: [{ key: 'l', label: 'Distance', kind: 'length', value: Math.hypot(op.d.x, op.d.y) }, { key: 'a', label: 'Angle', kind: 'angle', value: Math.round(Math.atan2(op.d.y, op.d.x) * 180 / Math.PI * 1e4) / 1e4 }] }];
  const set = (m: string, v: Record<string, number>) => {
    if (m === 'rot') op.deg = v.a; else if (m === 'polar') op.d = { x: v.l * Math.cos(v.a * Math.PI / 180), y: v.l * Math.sin(v.a * Math.PI / 180) }; else op.d = { x: v.dx, y: v.dy };
  };
  const res = await openInputBox({ title: mode === 'rotate' ? 'Rotate Piece' : 'Move Piece', modes, at: lastClient, typed, onPreview: (m, v) => { if (v) { set(m, v); pcPreview(app); } } });
  PCS.frozen = false;
  if (!res) { PCS.op = null; app.cancelPreview(); return; }
  set(res.mode, res.v);
  pcCommit(app, mode === 'rotate' ? 'Rotate piece' : 'Move piece');
}
export const pieceTool: Tool = {
  id: 'movePiece', title: 'Move / Rotate / Flip Piece', group: 'move', hotkey: 'Ctrl+Shift+G', icon: ICON.movePiece, cursor: 'move',
  activate() { PCS.op = null; PCS.frozen = false; },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); PCS.op = null; PCS.frozen = false; app.cancelPreview(); },
  busy: () => !!PCS.op,
  modes: () => PC_MODES,
  mode: () => pcMode(),
  setMode(app, id) { settings.pieceToolMode = id as PMode; saveSettings(); PCS.op = null; app.cancelPreview(); app.invalidate(); },
  badge: () => null,
  hint(app) {
    const m = pcMode(); const head = `Piece · ${m === 'move' ? 'Move' : m === 'rotate' ? 'Rotate' : 'Flip'}`;
    const op = PCS.op;
    if (m === 'flip') return `${head} · Click a piece = flip left ⇄ right · Shift+click = up ⇄ down (selected pieces flip together) · Esc = Select`;
    if (!op || op.kind === 'press') {
      const sel = app.sel.pieces.map(id => app.piece(id)?.name).filter(Boolean);
      if (sel.length && !op) return `${head} · ${sel.length > 1 ? `${sel.length} selected pieces` : sel[0]}: type ${m === 'rotate' ? 'an angle' : 'dX dY'} (or right-click) · or drag a piece${m === 'rotate' ? ' (about its centre)' : ''} · arrows nudge · Esc = Select`;
      return `${head} · Select piece to ${m === 'rotate' ? 'rotate (about its centre)' : 'move'} · drag, or click then click · type a value or right-click = input box · arrows nudge selected pieces · Esc = Select`;
    }
    const n = op.ids.length > 1 ? `${op.ids.length} pieces · ` : '';
    if (m === 'rotate') return `${head} · ${n}${(Math.round(op.deg * 100) / 100)}° · ${op.kind === 'carry' ? 'click to set' : 'release to set'} · Ctrl = 15° steps · type an angle or right-click = input box · Esc cancel`;
    return `${head} · ${n}dX ${fmt(op.d.x)} dY ${fmt(op.d.y)} ${unitLabel()} · R/Shift+R ±90° · Q W ±1° · A S ±10° · X Y flip · Shift H/V/45° · ${op.kind === 'carry' ? 'click to place' : 'release to place'} · right-click = input box · Esc cancel`;
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen() || PCS.frozen) return;
    const mode = pcMode();
    if (PCS.op?.kind === 'carry') {
      if (Math.hypot(p.s.x - PCS.op.s.x, p.s.y - PCS.op.s.y) < 6 && !PCS.op.xf.length) { PCS.op = { ...PCS.op, kind: 'press', s: p.s, again: true }; app.cancelPreview(); return; }
      pcCommit(app, mode === 'rotate' ? 'Rotate piece' : 'Move piece'); return;
    }
    const pc = pcPieceAt(app, p.w);
    if (!pc) { app.status('Nothing to pick here: click a piece'); return; }
    const e = p.e as MouseEvent;
    if (mode === 'flip') { const ids = pcIdsFor(app, pc); if (ids) flipPieces(app, ids, e.shiftKey ? 'v' : 'h'); return; }
    const ids = pcIdsFor(app, pc); if (!ids) return;
    const pivot = mode === 'rotate' ? pcCentre(app, ids) : p.w;
    PCS.op = { kind: 'press', ids, base: new Map(ids.map(id => [id, { ...layoutOf(app.doc.piece(id)) }])), startW: p.w, s: p.s, d: { x: 0, y: 0 }, xf: [], pivot, a0: Math.atan2(p.w.y - pivot.y, p.w.x - pivot.x), deg: 0, lastW: p.w };
  },
  move(app, p) {
    trackClient(p);
    const op = PCS.op;
    if (!op) { const pc = pcPieceAt(app, p.w); const id = pc?.id ?? null; if (id !== PCS.hover) { PCS.hover = id; app.invalidate('canvas'); } return; }
    if (PCS.frozen) return;
    op.lastW = p.w;
    if (op.kind === 'press') { if (Math.hypot(p.s.x - op.s.x, p.s.y - op.s.y) < THRESH_PX) return; op.kind = 'drag'; }
    const e = p.e as MouseEvent;
    if (pcMode() === 'rotate') {
      let deg = (Math.atan2(p.w.y - op.pivot.y, p.w.x - op.pivot.x) - op.a0) * 180 / Math.PI;
      deg = ((deg + 540) % 360) - 180;
      if (e.ctrlKey) deg = Math.round(deg / 15) * 15;
      op.deg = deg;
    } else {
      let d = { x: p.w.x - op.startW.x, y: p.w.y - op.startW.y };
      if (e.shiftKey) d = constrain45({ x: 0, y: 0 }, d);
      op.d = d;
    }
    pcPreview(app);
  },
  up(app) {
    const op = PCS.op; if (!op || PCS.frozen) return;
    if (op.kind === 'press' && op.again) { PCS.op = null; app.cancelPreview(); app.status('Put back'); return; }
    if (op.kind === 'press') { op.kind = 'carry'; app.invalidate(); return; }
    if (op.kind === 'drag') pcCommit(app, pcMode() === 'rotate' ? 'Rotate piece' : 'Move piece');
  },
  context(app, p) {
    trackClient(p);
    if (inputBoxOpen()) { inputBoxCommit(); return true; }
    if (PCS.op || (pcMode() !== 'flip' && app.sel.pieces.length)) { void pcInput(app); return true; }
    return false;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    const op = PCS.op;
    if (e.key === 'Escape') { if (op) { PCS.op = null; app.cancelPreview(); app.status('Move cancelled'); return true; } app.setTool('select'); return true; }
    if (e.key === 'Tab' && !op) { const i = PC_MODES.findIndex(m => m.id === pcMode()); pieceTool.setMode!(app, PC_MODES[(i + 1) % PC_MODES.length].id); return true; }
    if (e.key === 'Backspace') { if (op) { PCS.op = null; app.cancelPreview(); } return true; }
    if (op && pcMode() === 'move' && op.kind !== 'press' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const xf: XF | null = k === 'r' ? { rot: e.shiftKey ? -90 : 90 } : k === 'q' ? { rot: 1 } : k === 'w' ? { rot: -1 } : k === 'a' ? { rot: 10 } : k === 's' ? { rot: -10 } : k === 'x' ? { flip: 'h' } : k === 'y' ? { flip: 'v' } : null;
      if (xf) { op.xf.push(xf); pcPreview(app); return true; }
    }
    if (isNumKey(e) && (op || (pcMode() !== 'flip' && app.sel.pieces.length))) { void pcInput(app, e.key); return true; }
    return false;
  },
  nudge(app, dx, dy) {
    const ids = app.sel.pieces.filter(id => !app.hasSubSelection(id));
    if (!ids.length) { app.status('Piece: select a piece first'); return; }
    const locked = ids.map(id => app.doc.piece(id)).find(p => p.locked);
    if (locked) { toast(lockedMsg(locked), 'warn'); return; }
    try { ops.transformPieceLayouts(app.doc, ids, { dx, dy }, 'Nudge piece'); } catch (err) { reportError(err, 'Nudge piece'); }
  },
  overlay(app) {
    const out: string[] = [];
    if (PCS.hover && !PCS.op) out.push(itemHighlight(app, { k: 'piece', pieceId: PCS.hover }, 0.5));
    const op = PCS.op;
    if (op && pcMode() === 'rotate') {
      const c = app.view.toScreen(op.pivot);
      out.push(screenMarker(c, 'cross', SEL_COLOR, 8) + screenMarker(c, 'ring', SEL_COLOR, 5));
      if (op.kind !== 'press') { const w = app.view.toScreen(op.lastW); out.push(`<path d="M${fs(c.x)} ${fs(c.y)}L${fs(w.x)} ${fs(w.y)}" stroke="${SEL_COLOR}" stroke-dasharray="4 3"/><text x="${fs(w.x + 10)}" y="${fs(w.y - 10)}" class="tool-note">${(Math.round(op.deg * 100) / 100)}°</text>`); }
    }
    return out.join('');
  },
};

// ───────────────────────── Curve / Handle ─────────────────────────

interface HOp { ref: AnchorRef; which: 'in' | 'out'; alt: boolean; moved: boolean; s: Vec }
const CV: { op: HOp | null; picked: { ref: AnchorRef; which: 'in' | 'out' } | null; frozen: boolean } = { op: null, picked: null, frozen: false };
const cvDbl = new DoubleClick();

function handleSet(app: App, pc: Piece, ref: AnchorRef, which: 'in' | 'out', rel: Vec, broken: boolean) {
  const c = contourById(pc, ref.contourId)!; const idx = c.points.findIndex(q => q.id === ref.anchorId);
  const a = c.points[idx];
  const res = resolveFor(app.doc, pc, app.doc.baseSize(pc));
  const rc = c === pc.sew ? res.sew : res.internals[pc.internals.indexOf(c)];
  const key = which === 'in' ? 'hIn' : 'hOut', opp = which === 'in' ? 'hOut' : 'hIn';
  if (!a[opp]) { const hh = rc.handles[idx]; const op = which === 'in' ? hh.hOut : hh.hIn; const ap = rc.anchorPos[idx]; const v = { x: op.x - ap.x, y: op.y - ap.y }; if (Math.hypot(v.x, v.y) > 1e-6) a[opp] = v; }
  a[key] = rel;
  if (!broken && a[opp]) { const ol = Math.hypot(a[opp]!.x, a[opp]!.y) || 1, l = Math.hypot(rel.x, rel.y) || 1; a[opp] = { x: -rel.x / l * ol, y: -rel.y / l * ol }; }
  a.smooth = !broken;
}
function handleRel(app: App, ref: AnchorRef, which: 'in' | 'out'): Vec | null {
  const pc = app.doc.piece(ref.pieceId); const c = contourById(pc, ref.contourId); if (!c) return null;
  const idx = c.points.findIndex(q => q.id === ref.anchorId); if (idx < 0) return null;
  const a = c.points[idx]; const ex = which === 'in' ? a.hIn : a.hOut; if (ex) return ex;
  const res = resolveFor(app.doc, pc, app.doc.baseSize(pc)); const rc = c === pc.sew ? res.sew : res.internals[pc.internals.indexOf(c)];
  const hp = which === 'in' ? rc.handles[idx].hIn : rc.handles[idx].hOut; const ap = rc.anchorPos[idx];
  return { x: hp.x - ap.x, y: hp.y - ap.y };
}
async function cvInput(app: App, typed?: string) {
  const pk = CV.picked; if (!pk || inputBoxOpen()) return;
  const rel = handleRel(app, pk.ref, pk.which); if (!rel) return;
  CV.frozen = true;
  const apply = (v: Record<string, number>) => (d: Document) => { const pc = d.piece(pk.ref.pieceId); const r = v.a * Math.PI / 180; handleSet(app, pc, pk.ref, pk.which, { x: v.l * Math.cos(r), y: v.l * Math.sin(r) }, false); };
  const res = await openInputBox({
    title: `Handle ${pk.which === 'in' ? 'in' : 'out'}`, at: lastClient, typed,
    modes: [{ id: 'h', label: 'Handle', fields: [{ key: 'l', label: 'Length', kind: 'length', value: Math.hypot(rel.x, rel.y) }, { key: 'a', label: 'Angle', kind: 'angle', value: Math.round(Math.atan2(rel.y, rel.x) * 180 / Math.PI * 1e4) / 1e4 }] }],
    onPreview: (_m, v) => { if (v) previewWith(app, [pk.ref.pieceId], apply(v)); else app.cancelPreview(); },
  });
  CV.frozen = false;
  if (!res) { app.cancelPreview(); return; }
  commitWith(app, [pk.ref.pieceId], 'Edit handle', apply(res.v));
}
export const curveTool: Tool = {
  id: 'curve', title: 'Curve / Handle', group: 'move', hotkey: 'Shift+C', icon: ICON.curve, cursor: 'default',
  activate() { CV.op = null; CV.frozen = false; },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); CV.op = null; app.cancelPreview(); },
  busy: () => !!CV.op,
  badge(app) { return app.activeSize !== app.baseSize() ? { text: 'Handles are not graded: switch to the base size to edit them', amber: true } : null; },
  hint(app) {
    if (CV.op?.moved) return 'Curve · drag the handle · Alt = break the pair · Shift = H/V/45° · Esc cancel';
    if (CV.picked) return 'Curve · handle picked · type a length or right-click = input box (length ∠) · drag a handle to reshape · Shift+click a point = corner ⇄ smooth · Esc = Select';
    const pa = app.primaryAnchor();
    return pa ? 'Curve · drag a handle (Alt = break the pair) · click a handle to type its length / angle · Shift+click a point = corner ⇄ smooth · Esc = Select'
      : 'Curve · Click a point to show its handles · Shift+click = corner ⇄ smooth · Esc = Select';
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen() || CV.frozen) return;
    const h = p.hit; const e = p.e as MouseEvent;
    if (h.kind === 'handle' && h.pieceId && h.anchorId) {
      const ref = { pieceId: h.pieceId, contourId: h.contourId!, anchorId: h.anchorId };
      const pc = app.doc.piece(ref.pieceId);
      if (pc.locked) { toast(lockedMsg(pc), 'warn'); return; }
      if (app.sizeOf(pc) !== app.doc.baseSize(pc)) { toast('Handles are not graded: switch to the base size (Ctrl+B) to edit them', 'warn'); return; }
      CV.op = { ref, which: h.which!, alt: e.altKey, moved: false, s: p.s };
      return;
    }
    const hit = pointUnder(app, p);
    if (!hit) { CV.picked = null; app.status('Nothing to pick here: click a point'); return; }
    const pc = app.doc.piece(hit.ref.pieceId);
    if (e.shiftKey || cvDbl.hit(p.s.x, p.s.y, 'a:' + hit.ref.anchorId)) {
      if (pc.locked) { toast(lockedMsg(pc), 'warn'); return; }
      const a = app.doc.findAnchor(pc, hit.ref.anchorId)!.anchor;
      try { ops.setSmooth(app.doc, pc.id, a.id, !(a.smooth || a.hIn || a.hOut)); app.status(a.smooth ? 'Point → smooth' : 'Point → corner'); } catch (err) { reportError(err, 'Corner / smooth'); }
      app.applySel({ k: 'point', ref: hit.ref }, 'replace');
      return;
    }
    CV.picked = null;
    app.applySel({ k: 'point', ref: hit.ref }, 'replace');
    const a = app.doc.findAnchor(pc, hit.ref.anchorId)!.anchor;
    if (!a.smooth && !a.hIn && !a.hOut) app.status('Corner point: Shift+click makes it smooth so it gets handles');
  },
  move(app, p) {
    trackClient(p);
    const op = CV.op; if (!op || CV.frozen) return;
    if (!op.moved && Math.hypot(p.s.x - op.s.x, p.s.y - op.s.y) < THRESH_PX) return;
    op.moved = true;
    const e = p.e as MouseEvent;
    previewWith(app, [op.ref.pieceId], d => {
      const pc = d.piece(op.ref.pieceId); const c = contourById(pc, op.ref.contourId)!; const idx = c.points.findIndex(q => q.id === op.ref.anchorId);
      const res = resolveFor(app.doc, app.doc.piece(op.ref.pieceId), app.doc.baseSize(pc));
      const rc = c === pc.sew ? res.sew : res.internals[pc.internals.indexOf(c)];
      const ap = rc.anchorPos[idx];
      let hl = toLocal(pc, p.w); if (e.shiftKey) hl = constrain45(ap, hl);
      handleSet(app, pc, op.ref, op.which, { x: hl.x - ap.x, y: hl.y - ap.y }, op.alt || e.altKey);
      const rel = { x: hl.x - ap.x, y: hl.y - ap.y };
      app.status(`Handle ${fmt(Math.hypot(rel.x, rel.y))} ${unitLabel()} @ ${(Math.atan2(rel.y, rel.x) * 180 / Math.PI).toFixed(1)}°${op.alt || e.altKey ? ' · broken' : ''}`);
    });
  },
  up(app) {
    const op = CV.op; CV.op = null; if (!op) return;
    if (!op.moved) { CV.picked = { ref: op.ref, which: op.which }; app.invalidate(); return; }
    const pv = app.preview.get(op.ref.pieceId);
    if (!pv) return;
    app.preview.clear();
    const c = contourById(pv, op.ref.contourId)!; const a = c.points.find(q => q.id === op.ref.anchorId)!;
    app.doc.transact('Edit handle', () => { const la = app.doc.findAnchor(app.doc.piece(op.ref.pieceId), op.ref.anchorId)!.anchor; la.hIn = a.hIn ? { ...a.hIn } : undefined; la.hOut = a.hOut ? { ...a.hOut } : undefined; if (!la.hIn) delete la.hIn; if (!la.hOut) delete la.hOut; la.smooth = a.smooth; });
    CV.picked = { ref: op.ref, which: op.which };
  },
  context(app, p) {
    trackClient(p);
    if (inputBoxOpen()) { inputBoxCommit(); return true; }
    if (CV.picked) { void cvInput(app); return true; }
    return false;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    if (e.key === 'Escape') { if (CV.op) { CV.op = null; app.cancelPreview(); return true; } if (CV.picked) { CV.picked = null; app.invalidate(); return true; } app.setTool('select'); return true; }
    if (e.key === 'Backspace') { CV.picked = null; app.invalidate(); return true; }
    if (isNumKey(e) && CV.picked) { void cvInput(app, e.key); return true; }
    return false;
  },
  overlay(app) {
    const pk = CV.picked; if (!pk) return '';
    const pc = app.piece(pk.ref.pieceId); const rel = pc && handleRel(app, pk.ref, pk.which); const q = app.resolveRef(pk.ref);
    if (!pc || !rel || !q) return '';
    const r = resolveFor(app.doc, pc, app.doc.baseSize(pc)); const ci = q.contour === pc.sew ? -1 : pc.internals.indexOf(q.contour);
    const ap = (ci < 0 ? r.sew : r.internals[ci]).anchorPos[q.index];
    const s = app.view.toScreen(toWorld(pc, { x: ap.x + rel.x, y: ap.y + rel.y }));
    return `<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="7" stroke="${SEL_COLOR}" stroke-width="2" fill="none"/>`;
  },
};

/** Route arrow-key nudges: only Move tools nudge (Select never moves geometry). */
export function nudgeActive(app: App, dx: number, dy: number) {
  if (app.tool?.nudge) { app.tool.nudge(app, dx, dy); return; }
  app.status('Arrow-key nudge works in a Move tool: G = Move Point, Shift+G = Move Line, Ctrl+Shift+G = Piece');
}

