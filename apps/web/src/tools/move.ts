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
import { candidatesAt, gatherInBox, itemHighlight, SEL_COLOR } from '../selpick';
import { contourNear, runWorld } from '../hitkit';
import { sizeNameOf } from '../selection';
import { openInputBox, inputBoxOpen, inputBoxCommit, inputBoxCancel, type IBMode } from '../ui/inputbox';
import { fmt, unitLabel } from '../units-ui';
import { toast } from '../ui/toast';
import { confirmDialog } from '../ui/dialog';
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

export function scratchDoc(app: App, ids: Id[]): Document {
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
  /** Group: selection box being dragged on the empty sheet */
  box: { a: Vec; b: Vec; as: Vec; bs: Vec; mode: 'replace' | 'add' | 'toggle' } | null;
  /** Single: a line was grabbed where it has no point; a new point is added there and moved (one undo step) */
  ins: { pieceId: Id; contourId: Id; at: Vec; grabW: Vec; startW: Vec; s: Vec; dW: Vec; moved: boolean; err: string | null; snap?: string } | null;
} = { pick: null, before: null, tacks: null, op: null, tackDrag: null, frozen: false, hover: null, last: {}, box: null, ins: null };

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
/** Group points that really move: points of a locked internal line are left out, the lock moves them with the outline. */
function groupMovers(app: App): AnchorRef[] {
  const all = groupRefs(app);
  const free = all.filter(g => !lockBlock(app, g.pieceId, g.contourId, g.anchorId, 'point'));
  if (!free.length) { const why = lockBlock(app, all[0].pieceId, all[0].contourId, all[0].anchorId, 'point'); throw new Error(why ?? 'Nothing to move'); }
  return free;
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
  if (mode !== 'group') { const why = lockBlock(app, r.pieceId, r.contourId, r.anchorId, 'point'); if (why) throw new Error(why); }
  const cur = () => ops.pointPos(d, r, sid ?? d.baseSize(piece));
  switch (mode) {
    case 'single': case 'h': case 'v': {
      if (spec.kind === 'along') return;
      // a smooth grade point next to the moved point works as a split: the line beyond it keeps its shape
      ops.holdShapeAcrossGrade(d, r.pieceId, r.anchorId);
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
      for (const g of groupMovers(app)) { const l = by.get(g.pieceId) ?? []; l.push(g); by.set(g.pieceId, l); }
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

function mpCancelOp(app: App) { MP.op = null; MP.box = null; MP.ins = null; MP.frozen = false; app.cancelPreview(); }

/** Single: add a curve point where the line was grabbed and move it by the drag (base coordinates). Returns the new point. */
function insApply(d: Document, ins: NonNullable<typeof MP.ins>): Id {
  const piece = d.piece(ins.pieceId);
  if (piece.locked) throw new Error(lockedMsg(piece));
  const id = ops.addPointAt(d, ins.pieceId, ins.contourId, ins.at, 'curve');
  ops.holdShapeAcrossGrade(d, ins.pieceId, id);
  const dl = dirToLocal(piece, ins.dW);
  if (Math.hypot(dl.x, dl.y) > 1e-9) ops.movePoint(d, ins.pieceId, id, { dx: dl.x, dy: dl.y });
  return id;
}
function insDrag(app: App, ins: NonNullable<typeof MP.ins>, w: Vec, e: MouseEvent | PointerEvent) {
  let target = { x: ins.grabW.x + w.x - ins.startW.x, y: ins.grabW.y + w.y - ins.startW.y };
  ins.snap = undefined;
  if (e.shiftKey) target = constrain45(ins.grabW, target);
  else if (!e.altKey) { const sn = snapPoint(app, target, { exclude: new Set<Id>(), from: ins.grabW }); target = sn.p; ins.snap = SNAP_LABEL[sn.kind]; }
  ins.dW = { x: target.x - ins.grabW.x, y: target.y - ins.grabW.y };
  ins.err = previewWith(app, [ins.pieceId], d => { insApply(d, ins); });
}

function mpBoxModes(app: App, cur: Vec, d0: Vec): IBMode[] {
  const mode = mpMode();
  const L = Math.hypot(d0.x, d0.y), A = Math.atan2(d0.y, d0.x) * 180 / Math.PI;
  if (mode === 'along') {
    const last = 0;
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
  // the box opens blank when nothing is being dragged (Enter on the canvas repeats the last move)
  const d0 = op ? dirToLocal(piece, op.dW) : { x: 0, y: 0 };
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
  id: 'movePoint', title: 'Move Point', group: 'movepoint', hotkey: 'G', icon: ICON.movePoint, cursor: 'crosshair',
  activate(app) { MP.op = null; MP.frozen = false; MP.tackDrag = null; mpAdopt(app); },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); mpCancelOp(app); MP.tackDrag = null; MP.hover = null; },
  busy: () => !!MP.op || !!MP.tackDrag || !!MP.box || !!MP.ins || apexBusy(),
  modes: () => MP_MODES,
  mode: () => mpMode(),
  setMode(app, id) { settings.movePointMode = id as MPMode; saveSettings(); mpCancelOp(app); if (MP.pick) MP.tacks = defaultTacks(app, MP.pick.ref); app.invalidate(); },
  badge(app) { mpValid(app); const p = mpPiece(app); return sizeBadge(app, p ? MP.pick!.sizeId : editSidActive(app)); },

  hint(app) {
    const m = mpMode(); const head = `Move Point · ${MP_NAME[m]}`;
    const ah = apexHint(); if (ah) return ah;
    if (MP.tackDrag) return `${head} · Release on a point of the same line to put the tack there · Esc cancel`;
    if (MP.box) return `${head} · ${MP.box.bs.x < MP.box.as.x ? 'Crossing' : 'Window'} box: release to select the points inside · Shift adds · Ctrl toggles · Esc cancel`;
    if (MP.ins) return `${head} · New point on the line · ${fmtV(dirToLocal(app.doc.piece(MP.ins.pieceId), MP.ins.dW))} · release to place · Shift H/V/45° · Alt no snap · Esc cancel${MP.ins.err ? ' · ⚠ ' + MP.ins.err : ''}`;
    if (!mpValid(app)) return `${head} · ${m === 'group' ? 'Drag a box around the points to move, or click a point' : m === 'single' ? 'Drag a point, or drag a line to add a point there and shape it' : 'Select point to move'} · Tab = mode · Esc = back to Select`;
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
    const what = m === 'group' ? `Group: ${groupRefs(app).length} point(s) · drag one of them (drag on the empty sheet = box select)` : m === 'smooth' ? 'Drag the point (tacks fix the blended range; drag a tack to change it)' : m === 'along' ? 'Drag along the line' : m === 'single' ? 'Drag the point (or click it, then click the new spot) · drag a line = new point' : 'Drag the point, or click it then click the new spot';
    return `${head} · ${what} · type dX dY or right-click the point = input box · arrows nudge · ⌫ undo pick · Esc = Select${extra}`;
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
    if (!hit && mpMode() === 'group') {
      // Group: a drag that starts off the points is a selection box (Shift adds, Ctrl toggles)
      MP.box = { a: p.w, b: p.w, as: p.s, bs: p.s, mode: p.e.shiftKey ? 'add' : p.e.ctrlKey || p.e.metaKey ? 'toggle' : 'replace' };
      return;
    }
    if (!hit && mpMode() === 'single') {
      // Single: grab a line where it has no point: a new point is added there and dragged (one undo step)
      const ch = contourNear(app, p.w, { tolPx: 7 });
      if (ch) {
        if (ch.piece.locked) { toast(lockedMsg(ch.piece), 'warn'); return; }
        if (editSid(app, ch.piece)) { toast('A new point is added on the base size: switch to the base size (Ctrl+B)', 'warn'); return; }
        MP.ins = { pieceId: ch.piece.id, contourId: ch.contour.id, at: ch.local, grabW: ch.world, startW: p.w, s: p.s, dW: { x: 0, y: 0 }, moved: false, err: null };
        app.status('Drag to add a point here and shape the line (a click adds nothing)');
        app.invalidate(); return;
      }
    }
    if (!hit) { app.status(mpMode() === 'single' ? 'Nothing to pick here: press on a point, or on a line to add a point and drag it' : 'Nothing to pick here: click a point (or press on a dart apex and drag)'); return; }
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
    if (MP.box) { MP.box.b = p.w; MP.box.bs = p.s; app.invalidate('canvas', 'status'); return; }
    if (MP.ins) {
      const ins = MP.ins;
      if (!ins.moved && Math.hypot(p.s.x - ins.s.x, p.s.y - ins.s.y) < THRESH_PX) return;
      ins.moved = true; insDrag(app, ins, p.w, p.e); app.invalidate('status'); return;
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
    if (MP.box) {
      const b = MP.box; MP.box = null;
      if (Math.hypot(b.bs.x - b.as.x, b.bs.y - b.as.y) < THRESH_PX) { app.status('Group: drag a box around the points to move, or click a point'); app.invalidate(); return; }
      const box = { minX: Math.min(b.a.x, b.b.x), maxX: Math.max(b.a.x, b.b.x), minY: Math.min(b.a.y, b.b.y), maxY: Math.max(b.a.y, b.b.y) };
      const crossing = b.bs.x < b.as.x;
      const items = gatherInBox(app, box, crossing, 'points').filter(it => it.k === 'point' && !app.doc.piece(it.ref.pieceId).locked);
      if (b.mode === 'replace') { app.sel = { pieces: [], anchors: [] }; app.liveSel = null; }
      for (const it of items) app.applySel(it, b.mode === 'toggle' ? 'toggle' : 'add');
      MP.before = null; mpAdopt(app);
      const n = app.sel.anchors.length;
      app.status(n ? `Group: ${n} point(s) selected · drag one of them to move them all · Shift+drag a box adds` : 'No points in the box');
      app.invalidate(); return;
    }
    if (MP.ins) {
      const ins = MP.ins; MP.ins = null;
      if (!ins.moved || Math.hypot(ins.dW.x, ins.dW.y) * app.view.scale < 1) { app.cancelPreview(); app.status('No point added (drag the line to add a point and shape it)'); app.invalidate(); return; }
      let id: Id | null = null;
      if (commitWith(app, [ins.pieceId], 'Add point and move', d => { id = insApply(d, ins); }) && id) {
        mpSetPick(app, { pieceId: ins.pieceId, contourId: ins.contourId, anchorId: id });
        app.status('Point added and moved · drag it again to refine · Ctrl+Z removes it');
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
    // the movement box opens only on a selected point (or during a move); elsewhere the canvas menu opens
    if (mpValid(app) && MP.op) { void mpInput(app); return true; }
    const hit = pointUnder(app, p);
    if (hit && mpValid(app) && app.isSelected({ k: 'point', ref: hit.ref }) && (mpMode() === 'group' || hit.ref.anchorId === MP.pick!.ref.anchorId)) { void mpInput(app); return true; }
    if (hit && app.isSelected({ k: 'point', ref: hit.ref })) { mpSetPick(app, hit.ref, hit.sizeId, true); void mpInput(app); return true; }
    return false;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    if (e.key === 'Escape') {
      if (apexCancel(app)) return true;
      if (MP.tackDrag) { MP.tackDrag = null; app.invalidate(); return true; }
      if (MP.box) { MP.box = null; app.status('Box select cancelled'); app.invalidate(); return true; }
      if (MP.ins) { mpCancelOp(app); app.status('No point added'); app.invalidate(); return true; }
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
    if (MP.box) {
      const a = app.view.toScreen(MP.box.a), b = app.view.toScreen(MP.box.b);
      const crossing = MP.box.bs.x < MP.box.as.x;
      out.push(`<rect x="${fs(Math.min(a.x, b.x))}" y="${fs(Math.min(a.y, b.y))}" width="${fs(Math.abs(a.x - b.x))}" height="${fs(Math.abs(a.y - b.y))}" fill="${crossing ? 'rgba(46,204,113,0.08)' : 'rgba(78,161,255,0.08)'}" stroke="${crossing ? '#27ae60' : '#4ea1ff'}"${crossing ? ' stroke-dasharray="5 4"' : ''}/>`);
    }
    if (MP.ins) {
      const a = app.view.toScreen(MP.ins.grabW), b = app.view.toScreen({ x: MP.ins.grabW.x + MP.ins.dW.x, y: MP.ins.grabW.y + MP.ins.dW.y });
      out.push(`<circle cx="${fs(a.x)}" cy="${fs(a.y)}" r="4" fill="none" stroke="${SEL_COLOR}" stroke-width="1.4"/>`);
      if (MP.ins.moved) out.push(`<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="${SEL_COLOR}" stroke-width="1" stroke-dasharray="3 3"/><circle cx="${fs(b.x)}" cy="${fs(b.y)}" r="6" fill="none" stroke="${SEL_COLOR}" stroke-width="2"/>` + (MP.ins.snap ? `<text x="${fs(b.x + 9)}" y="${fs(b.y - 9)}" class="tool-note snap-note">${MP.ins.snap}</text>` : ''));
      return out.join('');
    }
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
const ML: {
  pick: LPick | null; before: ReturnType<App['snapshotSel']> | null; op: LOp | null; frozen: boolean; hover: SelItem | null; last: { mode: string; v: Record<string, number> } | null;
  /** Copy internal: the picked line is stuck to the mouse (world polyline, grab point, cursor) */
  carry: { pk: LPick; pts: Vec[]; grabW: Vec; cur: Vec; add: Vec } | null;
  /** Copy internal: a whole panel is picked; all its lines go onto the next piece clicked, where the panel lies */
  panel: Id | null;
} = { pick: null, before: null, op: null, frozen: false, hover: null, last: null, carry: null, panel: null };
type MLMode = Settings['moveLineMode'];
const mlMode = (): MLMode => settings.moveLineMode ?? 'translate';
const mlCopy = () => !!settings.moveLineCopy && mlMode() !== 'copyTo';
const ML_MODES: { id: MLMode; label: string; title: string }[] = [
  { id: 'translate', label: 'Free', title: 'The line moves freely: its end points and the curve points between them move by the same amount' },
  { id: 'h', label: 'Horizontal', title: 'The line moves left / right only' },
  { id: 'v', label: 'Vertical', title: 'The line moves up / down only' },
  { id: 'parallel', label: 'Parallel', title: 'The line moves at a right angle to itself (offset)' },
  { id: 'prop', label: 'Follow shape', title: 'Proportional: the ends slide along the lines they are attached to. A leg hem moved outward follows the leg and gets narrower, inward it gets wider' },
  { id: 'copyTo', label: 'Copy internal', title: 'Copy the picked line onto any panel as an internal line: right-click the line, OK, then click where it goes' },
];
const ML_NAME: Record<MLMode, string> = { translate: 'Free', h: 'Horizontal', v: 'Vertical', parallel: 'Parallel', prop: 'Follow shape', copyTo: 'Copy internal' };
const mlHead = () => `${mlMode() === 'copyTo' ? 'Copy Line' : mlCopy() ? 'Copy Line' : 'Move Line'} · ${ML_NAME[mlMode()]}`;
function mlRef(pk: LPick): { pieceId: Id; contourId: Id; from?: Id; to?: Id } {
  return pk.kind === 'segment' ? { pieceId: pk.seg.pieceId, contourId: pk.seg.contourId, from: pk.seg.from, to: pk.seg.to } : { pieceId: pk.c.pieceId, contourId: pk.c.contourId };
}
/** World polyline of the picked line (active size). */
function mlWorld(app: App, pk: LPick): Vec[] {
  const pc = app.doc.piece(mlPieceId(pk));
  if (pk.kind === 'segment') { const c = contourById(pc, pk.seg.contourId); return c ? runWorld(app, pc, c, pk.seg.from, pk.seg.to) : []; }
  const ci = pc.internals.findIndex(c => c.id === pk.c.contourId); if (ci < 0) return [];
  const rc = resolveFor(app.doc, pc, app.sizeOf(pc)).internals[ci]; if (!rc) return [];
  return (rc.closed ? [...rc.pts, rc.pts[0]] : rc.pts).map(q => toWorld(pc, q));
}
/** A copy that ends on the outline is attached to it (as the Internal line tool does). */
function mlLockCopy(d: Document, pieceId: Id, contourId: Id) {
  if (!settings.autoLockInternal) return;
  try { const pc = d.piece(pieceId); const c = pc.internals.find(x => x.id === contourId); if (c && ops.lockableEnds(pc, d.sizeLine(pc), c, { tol: 0.05 }).length) ops.lockInternalEnds(d, pieceId, contourId, { tol: 0.05 }); } catch { /* a free line */ }
}
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
  const copy = mlCopy(), mode = mlMode();
  if (pk.kind === 'internal' && !copy) { const why = lockBlock(app, pid, pk.c.contourId, null, 'line'); if (why) throw new Error(why); }
  if (mode === 'prop') {
    if (mlSid(app, pk)) throw new Error('Follow shape works on the base size: switch to the base size (Ctrl+B)');
    const r = ops.lineFollowShape(d, mlRef(pk), dLocal, { copy });
    if (r.contourId) mlLockCopy(d, pid, r.contourId);
    return;
  }
  if (copy) { const id = ops.copyLineTo(d, mlRef(pk), pid, { a: 1, b: 0, c: 0, d: 1, e: dLocal.x, f: dLocal.y }); mlLockCopy(d, pid, id); return; }
  ops.multiMove(d, mlTargets(app, pk).map(anchorId => ({ pieceId: pid, anchorId })), dLocal, { sizeId: mlSid(app, pk) });
}
function mlDeltaFromCursor(app: App, op: LOp, w: Vec, e: MouseEvent | PointerEvent): Vec {
  let dW = { x: w.x - op.startW.x, y: w.y - op.startW.y };
  const m = mlMode();
  if (m === 'parallel' || m === 'prop') { const n = mlNormal(app, ML.pick!); const k = dW.x * n.x + dW.y * n.y; dW = { x: n.x * k, y: n.y * k }; }
  else if (m === 'h') dW = { x: dW.x, y: 0 };
  else if (m === 'v') dW = { x: 0, y: dW.y };
  else if (e.shiftKey) dW = constrain45({ x: 0, y: 0 }, dW);
  op.dW = dW;
  return dirToLocal(app.doc.piece(mlPieceId(ML.pick!)), dW);
}
function mlCommit(app: App, dLocal: Vec, label = mlCopy() ? 'Copy line' : 'Move line'): boolean {
  const pk = ML.pick!; ML.op = null;
  if (Math.hypot(dLocal.x, dLocal.y) < 1e-9) { app.cancelPreview(); app.status('Not moved (zero distance)'); return false; }
  const ok = commitWith(app, [mlPieceId(pk)], label, d => mlApply(app, d, pk, dLocal));
  if (ok) { ML.last = { mode: 'rel', v: { dx: dLocal.x, dy: dLocal.y } }; app.status(`Line ${mlCopy() ? 'copied (the copy is an internal line)' : 'moved'} ${fmt(dLocal.x)}, ${fmt(dLocal.y)} ${unitLabel()}${mlMode() === 'prop' ? ' · ends followed the shape' : ''}`); }
  return ok;
}
/** Copy internal: put the carried line onto the piece under `atW` (its grab point lands on atW). */
function mlPaste(app: App, atW: Vec): boolean {
  const cy = ML.carry; if (!cy) return false;
  const target = pcPieceAt(app, atW) ?? pcPieceAt(app, cy.cur);
  if (!target) { app.status('Copy internal: click on a panel (piece) to put the line there'); return false; }
  if (target.locked) { toast(lockedMsg(target), 'warn'); return false; }
  const src = app.doc.piece(mlPieceId(cy.pk));
  const dW = { x: atW.x - cy.grabW.x, y: atW.y - cy.grabW.y };
  const f = (q: Vec) => { const w = toWorld(src, q); return toLocal(target, { x: w.x + dW.x, y: w.y + dW.y }); };
  const o = f({ x: 0, y: 0 }), ex = f({ x: 1, y: 0 }), ey = f({ x: 0, y: 1 });
  const m = { a: ex.x - o.x, b: ex.y - o.y, c: ey.x - o.x, d: ey.y - o.y, e: o.x, f: o.y };
  const pk = cy.pk;
  const ok = commitWith(app, [...new Set([src.id, target.id])], 'Copy internal line', d => { const id = ops.copyLineTo(d, mlRef(pk), target.id, m); mlLockCopy(d, target.id, id); });
  if (ok) { ML.carry = null; app.status(`Line copied onto “${target.name}” as an internal line · right-click the line again to copy it once more`); }
  app.invalidate();
  return ok;
}
/** Copy internal by overlay: every line of the picked panel is copied onto `target`, exactly where the panel lies on it. */
function mlPastePanel(app: App, target: Piece): boolean {
  const src = app.doc.style.pieces.find(p => p.id === ML.panel); if (!src) { ML.panel = null; return false; }
  if (target.locked) { toast(lockedMsg(target), 'warn'); return false; }
  const f = (q: Vec) => toLocal(target, toWorld(src, q));
  const o = f({ x: 0, y: 0 }), ex = f({ x: 1, y: 0 }), ey = f({ x: 0, y: 1 });
  const m = { a: ex.x - o.x, b: ex.y - o.y, c: ey.x - o.x, d: ey.y - o.y, e: o.x, f: o.y };
  // a line that is already on the target at exactly this place is not copied a second time
  const at = (q: Vec) => ({ x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f });
  const there = (c: Contour) => target.internals.some(t => t.closed === c.closed && t.points.length === c.points.length && t.points.every((tp, k) => { const q = at(c.points[k]); return Math.hypot(tp.x - q.x, tp.y - q.y) < 0.01; }));
  const all = [src.sew, ...src.internals.filter(c => c.type !== 'dartAxis' && c.type !== 'pleatAxis')];
  const lines = all.filter(c => !there(c)).map(c => c.id);
  ML.panel = null; // one copy per pick: pick the panel again to copy it somewhere else
  if (!lines.length) { app.status(`The lines of “${src.name}” are already on “${target.name}” at this place: nothing copied`); toast('Already copied here', 'warn'); app.invalidate(); return false; }
  const ok = commitWith(app, [src.id, target.id], 'Copy panel lines', d => { for (const cid of lines) ops.copyLineTo(d, { pieceId: src.id, contourId: cid }, target.id, m); });
  if (ok) { app.status(`${lines.length} line${lines.length > 1 ? 's' : ''} of “${src.name}” copied once onto “${target.name}” as internal lines, where the panel lies · click the panel again to copy it elsewhere`); app.applySel({ k: 'piece', pieceId: target.id }, 'replace'); }
  app.invalidate();
  return ok;
}
/** every visible piece whose outline contains the point (overlapping pieces all count) */
function piecesAt(app: App, w: Vec): Piece[] {
  const inside = (poly: Vec[], q: Vec) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
  return app.doc.style.pieces.filter(p => { if (app.hiddenPieces.has(p.id)) return false; try { return inside(resolveFor(app.doc, p, app.sizeOf(p)).sew.pts, toLocal(p, w)); } catch { return false; } });
}
async function mlCarryStart(app: App, w: Vec) {
  const pk = ML.pick!; const pts = mlWorld(app, pk); if (pts.length < 2) return;
  if (!(await confirmDialog('Copy internal', 'Copy this line? It sticks to the mouse: left-click a panel to put it there, or right-click to type a movement from the click position.', 'OK'))) return;
  // grab point: the place on the line nearest the right-click
  let g = pts[0], bd = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) { const a = pts[k], b = pts[k + 1], ab = { x: b.x - a.x, y: b.y - a.y }, l2 = ab.x * ab.x + ab.y * ab.y; const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((w.x - a.x) * ab.x + (w.y - a.y) * ab.y) / l2)); const q = { x: a.x + ab.x * t, y: a.y + ab.y * t }; const dd = Math.hypot(q.x - w.x, q.y - w.y); if (dd < bd) { bd = dd; g = q; } }
  ML.carry = { pk, pts, grabW: g, cur: w, add: { x: 0, y: 0 } };
  app.invalidate();
}
async function mlCarryInput(app: App, clickW: Vec) {
  const cy = ML.carry; if (!cy || inputBoxOpen()) return;
  ML.frozen = true; cy.cur = clickW;
  const res = await openInputBox({
    title: 'Copy internal · movement from the click position', at: lastClient,
    modes: [{ id: 'rel', label: 'dX dY', fields: [{ key: 'dx', label: 'dX', kind: 'length', value: 0 }, { key: 'dy', label: 'dY', kind: 'length', value: 0 }] }],
    onPreview: (_m, v) => { cy.add = v ? { x: v.dx, y: v.dy } : { x: 0, y: 0 }; app.invalidate('canvas'); },
  });
  ML.frozen = false;
  if (!res) { cy.add = { x: 0, y: 0 }; app.invalidate(); return; }
  cy.add = { x: 0, y: 0 };
  // the typed movement is in sheet (world) directions, measured from where the mouse was clicked
  if (!mlPaste(app, { x: clickW.x + res.v.dx, y: clickW.y + res.v.dy })) app.invalidate();
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
  const d0 = ML.op ? dirToLocal(pc, ML.op.dW) : { x: 0, y: 0 }; // blank unless a drag is in progress (Enter repeats the last move)
  const nW = mlNormal(app, pk), nL = dirToLocal(pc, nW);
  const off0 = d0.x * nL.x + d0.y * nL.y;
  const mm = mlMode();
  const modes: IBMode[] = mm === 'parallel' || mm === 'prop'
    ? [{ id: 'off', label: 'Offset', fields: [{ key: 'o', label: 'Offset (+ outward / left)', kind: 'length', value: off0 }] }]
    : mm === 'h' ? [{ id: 'rel', label: 'dX', fields: [{ key: 'dx', label: 'dX', kind: 'length', value: d0.x }] }]
    : mm === 'v' ? [{ id: 'rel', label: 'dY', fields: [{ key: 'dy', label: 'dY', kind: 'length', value: d0.y }] }]
    : [{ id: 'rel', label: 'dX dY', fields: [{ key: 'dx', label: 'dX', kind: 'length', value: d0.x }, { key: 'dy', label: 'dY', kind: 'length', value: d0.y }] },
      { id: 'polar', label: 'Distance ∠', fields: [{ key: 'l', label: 'Distance', kind: 'length', value: Math.hypot(d0.x, d0.y) }, { key: 'a', label: 'Angle', kind: 'angle', value: Math.round(Math.atan2(d0.y, d0.x) * 180 / Math.PI * 1e4) / 1e4 }] },
      { id: 'off', label: 'Offset', title: 'Perpendicular offset', fields: [{ key: 'o', label: 'Offset (+ outward / left)', kind: 'length', value: off0 }] }];
  const toD = (m: string, v: Record<string, number>): Vec => m === 'off' ? { x: nL.x * v.o, y: nL.y * v.o } : m === 'polar' ? { x: v.l * Math.cos(v.a * Math.PI / 180), y: v.l * Math.sin(v.a * Math.PI / 180) } : mm === 'h' || mm === 'v' ? dirToLocal(pc, { x: v.dx ?? 0, y: v.dy ?? 0 }) : { x: v.dx, y: v.dy };
  const res = await openInputBox({
    title: mlHead(), modes, at: lastClient, typed, amber: sizeBadge(app, mlSid(app, pk))?.text,
    onPreview: (m, v) => { if (!v) { app.cancelPreview(); return; } previewWith(app, [pc.id], d => mlApply(app, d, pk, toD(m, v))); },
  });
  ML.frozen = false;
  if (!res) { if (ML.op) previewWith(app, [pc.id], d => mlApply(app, d, pk, mlDeltaFromCursor(app, ML.op!, ML.op!.lastW, new MouseEvent('move')))); else app.cancelPreview(); return; }
  if (mlCommit(app, toD(res.mode, res.v))) ML.last = { mode: res.mode, v: res.v };
}
export const moveLineTool: Tool = {
  id: 'moveLine', title: 'Move / Copy Line', group: 'moveline', hotkey: 'Shift+G', icon: ICON.moveLine, cursor: 'crosshair',
  activate(app) { ML.op = null; ML.frozen = false; ML.carry = null; ML.panel = null; mlAdopt(app); },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); ML.op = null; ML.carry = null; ML.panel = null; ML.frozen = false; ML.hover = null; app.cancelPreview(); },
  busy: () => !!ML.op || !!ML.carry || !!ML.panel,
  modes: () => ML_MODES,
  mode: () => mlMode(),
  setMode(app, id) { settings.moveLineMode = id as MLMode; saveSettings(); ML.op = null; ML.carry = null; ML.panel = null; app.cancelPreview(); app.invalidate(); },
  toggles: () => mlMode() === 'copyTo' ? [] : [{ id: 'copy', label: 'Copy', title: 'On: the original line stays and a copy is made (an internal line). Off: the line itself moves.', on: !!settings.moveLineCopy }],
  toggle(app, id) { if (id === 'copy') { settings.moveLineCopy = !settings.moveLineCopy; saveSettings(); ML.op = null; app.cancelPreview(); app.invalidate(); } },
  badge(app) { return sizeBadge(app, mlValid(app) ? mlSid(app, ML.pick!) : editSidActive(app)); },
  hint(app) {
    const head = mlHead();
    if (ML.carry) return `${head} · The line is on the mouse · left-click a panel to put it there · right-click = type a movement from the click position · Esc cancel`;
    if (mlMode() === 'copyTo' && ML.panel) return `${head} · Panel picked with all its lines · click the piece it lies on: the lines are copied there, exactly where the panel is · Esc = done`;
    if (mlMode() === 'copyTo') return mlValid(app) ? `${head} · Right-click the picked line, then OK: it sticks to the mouse · or click another line · Esc = Select` : `${head} · Lay a small panel on a piece and click inside the panel = all its lines · or click one line to copy just that · Tab = mode · Esc = back to Select`;
    if (!mlValid(app)) return `${head} · Select segment (or internal line) to ${mlCopy() ? 'copy' : 'move'} · Tab = mode · Esc = back to Select`;
    if (ML.op && ML.op.kind !== 'press') {
      const pc = app.doc.piece(mlPieceId(ML.pick!));
      return `${head} · ${fmtV(dirToLocal(pc, ML.op.dW))} · ${ML.op.kind === 'carry' ? 'click to place' : 'release to place'} · type a value or right-click = input box · Shift H/V/45° · Esc cancel${ML.op.err ? ' · ⚠ ' + ML.op.err : ''}`;
    }
    const n = mlTargets(app, ML.pick!).length;
    return `${head} · ${ML.pick!.kind === 'segment' ? 'Segment' : 'Internal line'} (${n} point${n > 1 ? 's' : ''}${mlCopy() ? ', copied as an internal line' : ' move'}) · drag it, or click then click the new spot · type a value or right-click = input box · arrows nudge · ⌫ undo pick · Esc = Select`;
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen() || ML.frozen) return;
    if (ML.carry) { ML.carry.cur = p.w; mlPaste(app, p.w); return; }
    if (ML.op?.kind === 'carry') {
      if (Math.hypot(p.s.x - ML.op.s.x, p.s.y - ML.op.s.y) < 6) { ML.op = { ...ML.op, kind: 'press', s: p.s, again: true }; app.cancelPreview(); return; }
      mlCommit(app, mlDeltaFromCursor(app, ML.op, p.w, p.e)); return;
    }
    if (mlMode() === 'copyTo' && ML.panel) {
      // a panel is picked: the next piece clicked receives its lines
      const target = piecesAt(app, p.w).find(q => q.id !== ML.panel);
      if (target) mlPastePanel(app, target); else app.status('Copy internal: click the piece under the panel that should receive its lines · Esc = done');
      return;
    }
    const c = candidatesAt(app, p.w, 'all', { kinds: ['segment', 'internal'] })[0];
    if (!c && mlMode() === 'copyTo') {
      // off the lines, inside a piece: the whole panel is picked
      // where pieces overlap, the smallest one under the cursor is the panel
      const area = (q: Piece) => { const b = pieceWorldBox(app.doc, q, app.sizeOf(q)); return (b.maxX - b.minX) * (b.maxY - b.minY); };
      const under = piecesAt(app, p.w);
      if (under.length === 1) { app.status('Copy internal: click inside the small panel where it lies on another piece (or click one line to copy just that line)'); return; }
      const pc0 = under.sort((x, y) => area(x) - area(y))[0];
      if (pc0) { ML.panel = pc0.id; ML.pick = null; app.applySel({ k: 'piece', pieceId: pc0.id }, 'replace'); app.status(`Panel “${pc0.name}” picked with all its lines: now click the piece it lies on`); app.invalidate(); return; }
    }
    if (!c) { app.status('Nothing to pick here: click a segment or an internal line'); return; }
    const pk: LPick = c.item.k === 'segment' ? { kind: 'segment', seg: c.item.seg } : { kind: 'internal', c: (c.item as { c: ContourSel }).c };
    const pc = app.doc.piece(mlPieceId(pk));
    if (mlMode() === 'copyTo') { ML.panel = null; ML.pick = pk; ML.before = null; app.applySel(mlItem(pk), 'replace'); app.status('Line picked: right-click it, then OK, to copy it onto a panel'); app.invalidate(); return; }
    if (pc.locked) { toast(lockedMsg(pc), 'warn'); return; }
    const why = pk.kind === 'internal' && !mlCopy() ? lockBlock(app, pc.id, pk.c.contourId, null, 'line') : null;
    if (why) { app.applySel(mlItem(pk), 'replace'); toast(why, 'warn'); app.status('🔒 ' + why); return; }
    mlSetPick(app, pk);
    ML.op = { kind: 'press', startW: p.w, s: p.s, dW: { x: 0, y: 0 }, lastW: p.w, err: null };
  },
  move(app, p) {
    trackClient(p);
    if (ML.frozen) return;
    if (ML.carry) { ML.carry.cur = p.w; app.invalidate('canvas'); return; }
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
    // the movement box opens only on the selected line (or during a move); elsewhere the canvas menu opens
    if (ML.carry) { void mlCarryInput(app, p.w); return true; }
    if (mlValid(app) && ML.op) { void mlInput(app); return true; }
    if (mlValid(app)) {
      const want = mlItem(ML.pick!);
      const on = candidatesAt(app, p.w, 'all', { kinds: ['segment', 'internal'] }).some(c => JSON.stringify(c.item) === JSON.stringify(want));
      if (on) { if (mlMode() === 'copyTo') void mlCarryStart(app, p.w); else void mlInput(app); return true; }
    }
    return false;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    if (e.key === 'Escape' && ML.panel) { ML.panel = null; app.status('Panel released'); app.invalidate(); return true; }
    if (e.key === 'Escape') { if (ML.carry) { ML.carry = null; app.status('Copy cancelled'); app.invalidate(); return true; } if (ML.op) { ML.op = null; app.cancelPreview(); app.status('Move cancelled'); return true; } app.setTool('select'); return true; }
    if (e.key === 'Backspace') {
      if (ML.carry) { ML.carry = null; app.invalidate(); return true; }
      if (ML.op) { ML.op = null; app.cancelPreview(); return true; }
      if (ML.pick) { const b = ML.before; ML.pick = null; ML.before = null; if (b) app.restoreSel(b); app.status('Pick undone'); return true; }
      app.status('Nothing picked'); return true;
    }
    if (e.key === 'Tab' && !ML.op && !ML.carry) { const i = ML_MODES.findIndex(m => m.id === mlMode()); moveLineTool.setMode!(app, ML_MODES[(i + (e.shiftKey ? ML_MODES.length - 1 : 1)) % ML_MODES.length].id); return true; }
    if (mlMode() === 'copyTo' || ML.carry) return false;
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
    if (mlMode() === 'copyTo') return;
    const pc = app.doc.piece(mlPieceId(ML.pick!));
    let dW = { x: mlMode() === 'v' ? 0 : dx, y: mlMode() === 'h' ? 0 : dy };
    if (!dW.x && !dW.y) return;
    if (mlMode() === 'parallel' || mlMode() === 'prop') { const n = mlNormal(app, ML.pick!); const k = dW.x * n.x + dW.y * n.y || Math.hypot(dx, dy) * Math.sign(dx + dy); dW = { x: n.x * k, y: n.y * k }; }
    mlCommit(app, dirToLocal(pc, dW), 'Nudge line');
  },
  overlay(app) {
    const out: string[] = [];
    if (ML.hover && !ML.op) out.push(itemHighlight(app, ML.hover, 0.5));
    if (mlValid(app)) {
      const sid = mlSid(app, ML.pick!);
      out.push(itemHighlight(app, mlItem(ML.pick!), 1, sid ? AMBER : SEL_COLOR));
    }
    if (ML.panel && app.doc.style.pieces.some(q => q.id === ML.panel)) out.push(itemHighlight(app, { k: 'piece', pieceId: ML.panel }, 1, '#d6309b'));
    const cy = ML.carry;
    if (cy) {
      const dx = cy.cur.x + cy.add.x - cy.grabW.x, dy = cy.cur.y + cy.add.y - cy.grabW.y;
      const sp = cy.pts.map(q => app.view.toScreen({ x: q.x + dx, y: q.y + dy }));
      const g = app.view.toScreen({ x: cy.cur.x + cy.add.x, y: cy.cur.y + cy.add.y });
      out.push(`<path d="${sp.map((q, k) => `${k ? 'L' : 'M'}${fs(q.x)} ${fs(q.y)}`).join('')}" fill="none" stroke="#d6309b" stroke-width="2" stroke-dasharray="6 3" data-carry-line="1"/>` + screenMarker(g, 'cross', '#d6309b', 6));
    }
    return out.join('');
  },
};

// ───────────────────────── Piece: move / rotate / flip ─────────────────────────

type PMode = 'move' | 'rotate' | 'flip';
/** Rotate tool options: how the pivot is chosen. (Pieces are moved with the Select tool.) */
const ROT_MODES = [
  { id: 'point', label: 'By point', title: 'Rotate by point: click a pin point (a pattern point or any place on the piece), then a second point and turn the piece around the pin' },
  { id: 'piece', label: 'Piece', title: 'Piece rotation: the piece turns about its centre; drag or type an angle 0–360° (Ctrl = 15° steps)' },
];
const rotMode = (): 'point' | 'piece' => settings.rotateMode ?? 'point';
const deg360 = (d: number) => { const v = ((d % 360) + 360) % 360; return Math.round(v * 100) / 100; };
/** Grain line of a piece after its layout turned from L0 to L1 with "keep grain direction": same direction on the sheet. */
function grainKept(p: Piece, L0: PieceLayout, L1: PieceLayout): Piece['grain'] {
  const g = p.grain; const m = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
  const dW = dirToWorld({ ...p, layout: L0 } as Piece, { x: g.b.x - g.a.x, y: g.b.y - g.a.y });
  const d = dirToLocal({ ...p, layout: L1 } as Piece, dW);
  return { ...g, a: { x: m.x - d.x / 2, y: m.y - d.y / 2 }, b: { x: m.x + d.x / 2, y: m.y + d.y / 2 } };
}
type XF = { rot?: number; flip?: 'h' | 'v' };
interface POp { kind: 'press' | 'drag' | 'carry'; ids: Id[]; base: Map<Id, PieceLayout>; startW: Vec; s: Vec; d: Vec; xf: XF[]; pivot: Vec; a0: number; deg: number; lastW: Vec; again?: boolean }
const PCS: { op: POp | null; frozen: boolean; hover: Id | null; active: PMode; pin: { w: Vec; ids: Id[] } | null } = { op: null, frozen: false, hover: null, active: 'rotate', pin: null };
const pcMode = (): PMode => PCS.active;
const grainFixed = () => PCS.active === 'rotate' && !!settings.rotateKeepGrain;

function pcLayout(op: POp, id: Id, mode: PMode): PieceLayout {
  let L: PieceLayout = { ...op.base.get(id)! };
  if (mode === 'rotate') return rotatedLayout(L, op.deg, op.pivot);
  for (const x of op.xf) { if (x.rot) L = rotatedLayout(L, x.rot, op.startW); if (x.flip) L = flippedLayout(L, x.flip, op.startW); }
  return normalizeLayout({ ...L, x: L.x + op.d.x, y: L.y + op.d.y });
}
function pcPreview(app: App) {
  const op = PCS.op!; const mode = pcMode();
  for (const id of op.ids) {
    const pv = app.beginPreview(id); pv.layout = pcLayout(op, id, mode);
    if (grainFixed()) pv.grain = grainKept(app.doc.piece(id), op.base.get(id)!, pv.layout);
  }
  app.invalidate('canvas', 'panels', 'status');
}
function pcCommit(app: App, label: string) {
  const op = PCS.op!; PCS.op = null; const mode = pcMode();
  const lay = new Map(op.ids.map(id => [id, pcLayout(op, id, mode)]));
  if ([...lay].every(([id, L]) => JSON.stringify(normalizeLayout(L)) === JSON.stringify(normalizeLayout(op.base.get(id)!)))) { app.preview.clear(); app.status('Not moved'); app.invalidate(); return; }
  app.preview.clear();
  const keep = grainFixed();
  try { app.doc.transact(label, () => { for (const [id, L] of lay) { const p = app.doc.piece(id); if (keep) p.grain = grainKept(p, op.base.get(id)!, L); p.layout = L; } }); } catch (err) { reportError(err, label); }
  if (mode === 'rotate') app.status(`Rotated ${deg360(op.deg)}°${keep ? ' · grain direction kept' : ' · grain line turned with the piece'}`);
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
    ? [{ id: 'rot', label: 'Angle', fields: [{ key: 'a', label: 'Angle 0–360° (counter-clockwise)', kind: 'angle', value: deg360(op.deg) }] }]
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
export const rotateTool: Tool = {
  id: 'rotatePiece', title: 'Rotate Piece', group: 'rotate', hotkey: 'Ctrl+Shift+G', icon: ICON.rotate, cursor: 'crosshair',
  activate() { PCS.op = null; PCS.frozen = false; PCS.pin = null; PCS.active = 'rotate'; },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); PCS.op = null; PCS.pin = null; PCS.frozen = false; app.cancelPreview(); },
  busy: () => !!PCS.op || !!PCS.pin,
  modes: () => ROT_MODES,
  mode: () => rotMode(),
  setMode(app, id) { settings.rotateMode = id as 'point' | 'piece'; saveSettings(); PCS.op = null; PCS.pin = null; app.cancelPreview(); app.invalidate(); },
  toggles: () => [{ id: 'grain', label: 'Keep grain direction', title: 'On: the grain line keeps its direction on the sheet while the piece turns. Off: the grain line turns with the piece.', on: !!settings.rotateKeepGrain }],
  toggle(app, id) { if (id === 'grain') { settings.rotateKeepGrain = !settings.rotateKeepGrain; saveSettings(); if (PCS.op) pcPreview(app); app.invalidate(); } },
  badge: () => null,
  hint(app) {
    const pt = rotMode() === 'point'; const head = `Rotate · ${pt ? 'By point' : 'Piece'}`;
    const g = settings.rotateKeepGrain ? 'grain direction kept' : 'grain turns with the piece';
    const op = PCS.op;
    if (op && op.kind !== 'press') return `${head} · ${op.ids.length > 1 ? `${op.ids.length} pieces · ` : ''}${deg360(op.deg)}° · ${op.kind === 'carry' ? 'click to set' : 'release to set'} · Ctrl = 15° steps · type an angle or right-click = input box · ${g} · Esc cancel`;
    if (pt) return PCS.pin ? `${head} · Pin set · click the second point (the one you turn), then move the mouse · Esc cancel` : `${head} · Click the pin point: a pattern point or any place on the piece · ${g} · Tab = mode · Esc = Select`;
    const sel = app.sel.pieces.map(id => app.piece(id)?.name).filter(Boolean);
    return sel.length ? `${head} · ${sel.length > 1 ? `${sel.length} selected pieces` : sel[0]}: type an angle 0–360 (or right-click the piece) · or drag a piece · ${g} · Esc = Select` : `${head} · Click or drag a piece to turn it about its centre · type an angle 0–360 · ${g} · Tab = mode · Esc = Select`;
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen() || PCS.frozen) return;
    const mode = pcMode();
    if (PCS.op?.kind === 'carry') {
      if (Math.hypot(p.s.x - PCS.op.s.x, p.s.y - PCS.op.s.y) < 6 && !PCS.op.xf.length) { PCS.op = { ...PCS.op, kind: 'press', s: p.s, again: true }; app.cancelPreview(); return; }
      pcCommit(app, mode === 'rotate' ? 'Rotate piece' : 'Move piece'); return;
    }
    if (mode === 'rotate' && rotMode() === 'point' && PCS.pin) {
      // second point: the rotator. Turning starts from here.
      const pin = PCS.pin; const rot = (p.e as MouseEvent).altKey ? p.w : snapPoint(app, p.w).p;
      const ps = app.view.toScreen(pin.w);
      if (Math.hypot(ps.x - p.s.x, ps.y - p.s.y) < 6) { app.status('The second point must be away from the pin'); return; }
      PCS.pin = null;
      PCS.op = { kind: 'press', ids: pin.ids, base: new Map(pin.ids.map(id => [id, { ...layoutOf(app.doc.piece(id)) }])), startW: rot, s: p.s, d: { x: 0, y: 0 }, xf: [], pivot: pin.w, a0: Math.atan2(rot.y - pin.w.y, rot.x - pin.w.x), deg: 0, lastW: rot };
      app.invalidate(); return;
    }
    const pc = pcPieceAt(app, p.w);
    if (!pc) { app.status('Nothing to pick here: click a piece'); return; }
    const e = p.e as MouseEvent;
    if (mode === 'rotate' && rotMode() === 'point') {
      const ids = pcIdsFor(app, pc); if (!ids) return;
      PCS.pin = { w: e.altKey ? p.w : snapPoint(app, p.w).p, ids };
      app.status('Pin set: click the second point, then move the mouse to turn the piece'); app.invalidate(); return;
    }
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
    // the movement box opens only on a selected piece (or during a move); elsewhere the canvas menu opens
    const under = PCS.op ? null : pcPieceAt(app, p.w);
    if (PCS.op || (pcMode() !== 'flip' && !PCS.pin && under && app.sel.pieces.includes(under.id))) { void pcInput(app); return true; }
    return false;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    const op = PCS.op;
    if (e.key === 'Escape') { if (op) { PCS.op = null; app.cancelPreview(); app.status('Cancelled'); return true; } if (PCS.pin) { PCS.pin = null; app.status('Pin removed'); app.invalidate(); return true; } app.setTool('select'); return true; }
    if (e.key === 'Tab' && !op && pcMode() === 'rotate') { rotateTool.setMode!(app, rotMode() === 'point' ? 'piece' : 'point'); return true; }
    if (e.key === 'Backspace') { if (op) { PCS.op = null; app.cancelPreview(); } else if (PCS.pin) { PCS.pin = null; app.invalidate(); } return true; }
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
    if (PCS.pin && !op) { const c = app.view.toScreen(PCS.pin.w); out.push(screenMarker(c, 'cross', '#c0392b', 8) + screenMarker(c, 'ring', '#c0392b', 5) + `<text x="${fs(c.x + 10)}" y="${fs(c.y - 10)}" class="tool-note">pin</text>`); }
    if (op && pcMode() === 'rotate') {
      const c = app.view.toScreen(op.pivot);
      out.push(screenMarker(c, 'cross', SEL_COLOR, 8) + screenMarker(c, 'ring', SEL_COLOR, 5));
      if (op.kind !== 'press') { const w = app.view.toScreen(op.lastW); out.push(`<path d="M${fs(c.x)} ${fs(c.y)}L${fs(w.x)} ${fs(w.y)}" stroke="${SEL_COLOR}" stroke-dasharray="4 3"/><text x="${fs(w.x + 10)}" y="${fs(w.y - 10)}" class="tool-note">${deg360(op.deg)}°</text>`); }
    }
    return out.join('');
  },
};

// ───────────────────────── Curve / Handle ─────────────────────────

interface HOp { ref: AnchorRef; which: 'in' | 'out'; alt: boolean; moved: boolean; s: Vec }
const CV: {
  op: HOp | null; picked: { ref: AnchorRef; which: 'in' | 'out' } | null; frozen: boolean;
  /** a picked line: it is shaped as ONE curve with a handle at each end */
  seg: SegSel | null;
  segOp: { which: 'start' | 'end'; s: Vec; moved: boolean; rel: Vec | null } | null;
} = { op: null, picked: null, frozen: false, seg: null, segOp: null };

const SEG_YELLOW = '#f2c200';
/** The picked line as one curve (base size), from the live preview when there is one. */
function cvSeg(app: App): { pc: Piece; sc: ReturnType<typeof ops.segmentCurve> } | null {
  const g = CV.seg; if (!g) return null;
  const doc = app.doc.style.pieces.find(p => p.id === g.pieceId); if (!doc) { CV.seg = null; return null; }
  const pc = app.preview.get(g.pieceId) ?? doc;
  try { return { pc, sc: ops.segmentCurve(pc, app.doc.sizeLine(doc), g.contourId, g.from, g.to) }; } catch { CV.seg = null; return null; }
}
function cvSegApply(d: Document, g: SegSel, op: NonNullable<typeof CV.segOp>): number {
  return ops.shapeSegment(d, g.pieceId, g.contourId, g.from, g.to, op.rel ? { [op.which]: op.rel } : {});
}
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
  id: 'curve', title: 'Curve / Handle', group: 'curve', hotkey: 'Shift+C', icon: ICON.curve, cursor: 'default',
  activate() { CV.op = null; CV.frozen = false; CV.seg = null; CV.segOp = null; },
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); CV.op = null; CV.seg = null; CV.segOp = null; app.cancelPreview(); },
  busy: () => !!CV.op || !!CV.segOp,
  badge(app) { return app.activeSize !== app.baseSize() ? { text: 'Handles are not graded: switch to the base size to edit them', amber: true } : null; },
  hint(app) {
    if (CV.segOp?.moved) { const g = cvSeg(app); return `Curve · shaping the line · length ${g ? fmt(g.sc.length) : ''} ${unitLabel()} · only this line changes · Shift = H/V/45° · Esc cancel`; }
    if (CV.seg) { const g = cvSeg(app); if (g) return `Curve · line ${fmt(g.sc.length)} ${unitLabel()} · drag one of its two handles to shape it${g.sc.between ? ` · its ${g.sc.between} curve point(s) become one curve (shape within ${fmt(g.sc.dev)} ${unitLabel()})` : ''} · click another line or a point · Esc = deselect`; }
    if (CV.op?.moved) return 'Curve · drag the handle · Alt = break the pair · Shift = H/V/45° · Esc cancel';
    if (CV.picked) return 'Curve · handle picked · type a length or right-click = input box (length ∠) · drag a handle to reshape · Shift+click a point = corner ⇄ smooth · Esc = Select';
    const pa = app.primaryAnchor();
    return pa ? 'Curve · drag a handle (Alt = break the pair) · click a handle to type its length / angle · Shift+click a point = corner ⇄ smooth · Esc = Select'
      : 'Curve · Click a line to shape it with its two handles · click a point to show its handles · Shift+click = corner ⇄ smooth · Esc = Select';
  },
  down(app, p) {
    trackClient(p);
    if (inputBoxOpen() || CV.frozen) return;
    const h = p.hit; const e = p.e as MouseEvent;
    // a picked line: its two handles come first
    const g = cvSeg(app);
    if (g) {
      for (const which of ['start', 'end'] as const) {
        const hs = app.view.toScreen(toWorld(g.pc, which === 'start' ? g.sc.h0 : g.sc.h3));
        if (Math.hypot(hs.x - p.s.x, hs.y - p.s.y) > 10) continue;
        if (g.pc.locked) { toast(lockedMsg(g.pc), 'warn'); return; }
        if (app.sizeOf(g.pc) !== app.doc.baseSize(g.pc)) { toast('Handles are not graded: switch to the base size (Ctrl+B) to edit them', 'warn'); return; }
        CV.segOp = { which, s: p.s, moved: false, rel: null };
        return;
      }
    }
    if (h.kind === 'handle' && h.pieceId && h.anchorId) {
      const ref = { pieceId: h.pieceId, contourId: h.contourId!, anchorId: h.anchorId };
      const pc = app.doc.piece(ref.pieceId);
      if (pc.locked) { toast(lockedMsg(pc), 'warn'); return; }
      if (app.sizeOf(pc) !== app.doc.baseSize(pc)) { toast('Handles are not graded: switch to the base size (Ctrl+B) to edit them', 'warn'); return; }
      CV.op = { ref, which: h.which!, alt: e.altKey, moved: false, s: p.s };
      return;
    }
    const hit = pointUnder(app, p);
    if (!hit) {
      // a line: pick it, it gets one handle at each end
      CV.picked = null;
      const ch = contourNear(app, p.w, { tolPx: 8 });
      if (!ch) { CV.seg = null; app.status('Nothing to pick here: click a line or a point'); app.invalidate(); return; }
      const pts = ch.contour.points;
      const from = ch.from ?? pts[0].id, to = ch.to ?? pts[pts.length - 1].id;
      if (from === to) { CV.seg = null; app.status('This line has one grade point only: add a point (Cut Point) to split it into lines'); app.invalidate(); return; }
      CV.seg = { pieceId: ch.piece.id, contourId: ch.contour.id, from, to };
      app.sel = { pieces: [], anchors: [] }; app.liveSel = null;
      app.invalidate(); return;
    }
    CV.seg = null;
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
    if (CV.segOp && CV.seg && !CV.frozen) {
      const so = CV.segOp, sg = CV.seg;
      if (!so.moved && Math.hypot(p.s.x - so.s.x, p.s.y - so.s.y) < THRESH_PX) return;
      so.moved = true;
      const pc = app.doc.piece(sg.pieceId);
      const base = ops.segmentCurve(pc, app.doc.sizeLine(pc), sg.contourId, sg.from, sg.to);
      const ap = so.which === 'start' ? base.p0 : base.p3;
      let hl = toLocal(pc, p.w); if ((p.e as MouseEvent).shiftKey) hl = constrain45(ap, hl);
      so.rel = { x: hl.x - ap.x, y: hl.y - ap.y };
      const err = previewWith(app, [sg.pieceId], d => { cvSegApply(d, sg, so); });
      if (err) app.status('⚠ ' + err); else app.invalidate('status');
      return;
    }
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
    if (CV.segOp) {
      const so = CV.segOp, sg = CV.seg; CV.segOp = null;
      if (!sg || !so.moved || !so.rel) { app.cancelPreview(); app.invalidate(); return; }
      let merged = 0;
      if (commitWith(app, [sg.pieceId], 'Shape line', d => { merged = cvSegApply(d, sg, so); })) {
        const g = cvSeg(app);
        app.status(`Line shaped${g ? ` · length ${fmt(g.sc.length)} ${unitLabel()}` : ''}${merged ? ` · ${merged} curve point(s) became one curve` : ''}`);
      }
      app.invalidate(); return;
    }
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
    if (e.key === 'Escape' && CV.segOp) { CV.segOp = null; app.cancelPreview(); app.invalidate(); return true; }
    if (e.key === 'Escape' && CV.seg && !CV.op) { CV.seg = null; app.invalidate(); return true; }
    if (e.key === 'Escape') { if (CV.op) { CV.op = null; app.cancelPreview(); return true; } if (CV.picked) { CV.picked = null; app.invalidate(); return true; } app.setTool('select'); return true; }
    if (e.key === 'Backspace') { CV.picked = null; app.invalidate(); return true; }
    if (isNumKey(e) && CV.picked) { void cvInput(app, e.key); return true; }
    return false;
  },
  overlay(app) {
    const g = cvSeg(app);
    if (g) {
      const S = (q: Vec) => app.view.toScreen(toWorld(g.pc, q));
      const a = S(g.sc.p0), b = S(g.sc.h0), c = S(g.sc.h3), d = S(g.sc.p3);
      // label at the middle of the curve (t = 0.5)
      const m = { x: (a.x + 3 * b.x + 3 * c.x + d.x) / 8, y: (a.y + 3 * b.y + 3 * c.y + d.y) / 8 };
      const dot = (q: Vec) => `<circle cx="${fs(q.x)}" cy="${fs(q.y)}" r="4" fill="#fff" stroke="#3b7cff" stroke-width="1.6" data-seg-handle="1"/>`;
      return `<path d="M${fs(a.x)} ${fs(a.y)}C${fs(b.x)} ${fs(b.y)} ${fs(c.x)} ${fs(c.y)} ${fs(d.x)} ${fs(d.y)}" fill="none" stroke="${SEG_YELLOW}" stroke-width="2.6" stroke-linecap="round"/>`
        + `<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}M${fs(d.x)} ${fs(d.y)}L${fs(c.x)} ${fs(c.y)}" stroke="#3b7cff" stroke-width="1.1"/>` + dot(b) + dot(c)
        + `<circle cx="${fs(a.x)}" cy="${fs(a.y)}" r="3.2" fill="#1d2330"/><circle cx="${fs(d.x)}" cy="${fs(d.y)}" r="3.2" fill="#1d2330"/>`
        + `<text x="${fs(m.x + 8)}" y="${fs(m.y - 8)}" class="tool-note">${fmt(g.sc.length)}</text>`;
    }
    const pk = CV.picked; if (!pk) return '';
    const pc = app.piece(pk.ref.pieceId); const rel = pc && handleRel(app, pk.ref, pk.which); const q = app.resolveRef(pk.ref);
    if (!pc || !rel || !q) return '';
    const r = resolveFor(app.doc, pc, app.doc.baseSize(pc)); const ci = q.contour === pc.sew ? -1 : pc.internals.indexOf(q.contour);
    const ap = (ci < 0 ? r.sew : r.internals[ci]).anchorPos[q.index];
    const s = app.view.toScreen(toWorld(pc, { x: ap.x + rel.x, y: ap.y + rel.y }));
    return `<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="7" stroke="${SEL_COLOR}" stroke-width="2" fill="none"/>`;
  },
};

/**
 * Grain tool (replaces the Flip tool). Options on top:
 *   Flip horizontal / Flip vertical   click a piece: it flips left ⇄ right / up ⇄ down
 *   Grain to piece position           click a piece: its grain line becomes screen-horizontal again, the piece stays
 *   Piece to grain                    click a piece: the piece turns so that its grain line lies screen-horizontal
 */
type GrainMode = 'flipH' | 'flipV' | 'grainSet' | 'pieceToGrain';
const GRAIN_MODES: { id: GrainMode; label: string; title: string }[] = [
  { id: 'flipH', label: 'Flip horizontal', title: 'Click a piece: flip it left ⇄ right (selected pieces flip together)' },
  { id: 'flipV', label: 'Flip vertical', title: 'Click a piece: flip it up ⇄ down (selected pieces flip together)' },
  { id: 'grainSet', label: 'Grain to piece position', title: 'After a piece was rotated or flipped: click it and its grain line is set to screen-horizontal. The piece stays where it is.' },
  { id: 'pieceToGrain', label: 'Piece to grain', title: 'Click a piece: it turns back so that its grain line lies screen-horizontal (its original direction)' },
];
const grainMode = (): GrainMode => (settings.toolState?.grain?.mode as GrainMode) ?? 'flipH';
/** screen angle (degrees) of a piece's grain line */
function grainAngle(p: Piece): number { const d = dirToWorld(p, { x: p.grain.b.x - p.grain.a.x, y: p.grain.b.y - p.grain.a.y }); return Math.atan2(d.y, d.x) * 180 / Math.PI; }
/** Grain line → screen-horizontal; the piece does not move. */
export function grainToHorizontal(app: App, ids: Id[]) {
  if (!ids.length) { app.status('Select a piece first'); return; }
  const locked = ids.map(id => app.doc.piece(id)).find(p => p.locked);
  if (locked) { toast(lockedMsg(locked), 'warn'); return; }
  try {
    app.doc.transact('Set grain to piece position', () => {
      for (const id of ids) {
        const p = app.doc.piece(id); const g = p.grain;
        const L = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) || 100; const m = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
        const u = dirToLocal(p, { x: 1, y: 0 }); const ul = Math.hypot(u.x, u.y) || 1;
        const d = { x: u.x / ul * L, y: u.y / ul * L };
        p.grain = { ...g, a: { x: m.x - d.x / 2, y: m.y - d.y / 2 }, b: { x: m.x + d.x / 2, y: m.y + d.y / 2 } };
      }
    });
    app.status(`Grain line set to screen-horizontal on ${ids.length} piece(s) · the piece${ids.length > 1 ? 's' : ''} did not move`);
  } catch (err) { reportError(err, 'Set grain'); }
  app.invalidate();
}
/** Turn the piece so that its grain line lies screen-horizontal (layout only). */
export function pieceToGrain(app: App, ids: Id[]) {
  if (!ids.length) { app.status('Select a piece first'); return; }
  const locked = ids.map(id => app.doc.piece(id)).find(p => p.locked);
  if (locked) { toast(lockedMsg(locked), 'warn'); return; }
  try {
    let turned = 0;
    app.doc.transact('Piece to grain', () => {
      for (const id of ids) {
        const p = app.doc.piece(id);
        let rot = -grainAngle(p); rot = ((rot + 90) % 180 + 180) % 180 - 90; // the smaller turn: the grain has no head or tail
        if (Math.abs(rot) < 1e-9) continue;
        p.layout = rotatedLayout(layoutOf(p), rot, pcCentre(app, [id])); turned++;
      }
    });
    app.status(turned ? `${turned} piece(s) turned back onto the grain (grain line screen-horizontal)` : 'Already on the grain');
  } catch (err) { reportError(err, 'Piece to grain'); }
  app.invalidate();
}
export const grainTool: Tool = {
  id: 'grain', title: 'Grain / Flip', group: 'grain', icon: ICON.grain, cursor: 'crosshair',
  activate() { PCS.op = null; PCS.frozen = false; PCS.pin = null; PCS.active = 'flip'; },
  deactivate(app) { PCS.op = null; PCS.pin = null; PCS.hover = null; app.cancelPreview(); },
  modes: () => GRAIN_MODES,
  mode: () => grainMode(),
  setMode(app, id) { (settings.toolState ??= {}).grain = { ...(settings.toolState.grain ?? {}), mode: id }; saveSettings(); app.invalidate(); },
  hint: () => {
    const m = grainMode();
    return m === 'flipH' ? 'Grain · Flip horizontal: click a piece = flip left ⇄ right (selected pieces flip together) · Tab = next option · Esc = Select'
      : m === 'flipV' ? 'Grain · Flip vertical: click a piece = flip up ⇄ down · Tab = next option · Esc = Select'
      : m === 'grainSet' ? 'Grain · Grain to piece position: click a piece, its grain line becomes screen-horizontal and the piece stays · Tab = next option · Esc = Select'
      : 'Grain · Piece to grain: click a piece, it turns so that its grain line lies screen-horizontal · Tab = next option · Esc = Select';
  },
  down(app, p) {
    const pc = pcPieceAt(app, p.w);
    if (!pc) { app.status('Nothing to pick here: click a piece'); return; }
    const ids = pcIdsFor(app, pc); if (!ids) return;
    const m = grainMode();
    if (m === 'flipH' || m === 'flipV') flipPieces(app, ids, m === 'flipH' ? 'h' : 'v');
    else if (m === 'grainSet') grainToHorizontal(app, ids);
    else pieceToGrain(app, ids);
  },
  move(app, p) { const pc = pcPieceAt(app, p.w); const id = pc?.id ?? null; if (id !== PCS.hover) { PCS.hover = id; app.invalidate('canvas'); } },
  key(app, e) {
    if (e.key === 'Escape') { app.setTool('select'); return true; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { const i = GRAIN_MODES.findIndex(m => m.id === grainMode()); grainTool.setMode!(app, GRAIN_MODES[(i + (e.shiftKey ? GRAIN_MODES.length - 1 : 1)) % GRAIN_MODES.length].id); return true; }
    return false;
  },
  overlay(app) { return PCS.hover ? itemHighlight(app, { k: 'piece', pieceId: PCS.hover }, 0.5) : ''; },
};

/** Route arrow-key nudges: only Move tools nudge (Select never moves geometry). */
export function nudgeActive(app: App, dx: number, dy: number) {
  if (app.tool?.nudge) { app.tool.nudge(app, dx, dy); return; }
  // Select: the arrows move the selected pieces on the sheet (layout only), like a drag does
  const ids = app.tool?.id === 'select' ? app.sel.pieces.filter(id => !app.hasSubSelection(id)) : [];
  if (ids.length) {
    const locked = ids.map(id => app.doc.piece(id)).find(p => p.locked);
    if (locked) { toast(lockedMsg(locked), 'warn'); return; }
    try { ops.transformPieceLayouts(app.doc, ids, { dx, dy }, 'Nudge piece'); } catch (err) { reportError(err, 'Nudge piece'); }
    return;
  }
  app.status('Arrow keys: select a piece (Select tool) to move it, or use G = Move Point / Shift+G = Move Line');
}

