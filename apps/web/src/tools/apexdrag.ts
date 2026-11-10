/**
 * Drag a dart apex to re-shape the dart (Move Point and the Dart tool). Base size: the apex moves in
 * every size and Fix Dart re-equalizes the legs (kernel moveDartApex). Non-base size (amber): only
 * that size's apex grading changes. Live preview on a scratch copy, one undo step on release, a
 * leg-length readout (A / B, ✓ when equal) while dragging. Esc cancels.
 */
import type { Vec, Id, SizeId } from '@prowdcad/kernel';
import type { App } from '../app';
import type { Ptr } from './tool';
import { ops } from '../ops-bridge';
import { liveShapes, selectLive, type DartShape } from '../live';
import { toWorld, toLocal, dirToLocal } from '../geometry';
import { previewWith, commitWith } from './move';
import { fmt, unitLabel } from '../units-ui';
import { label, dot, LIVE_COL } from './livekit';
import { fs } from './common';

interface ApexOp { pieceId: Id; dartId: Id; sid?: SizeId; startW: Vec; apex0: Vec; to: Vec; moved: boolean; err: string | null; legs?: [number, number] }
export const AP: { op: ApexOp | null; hover: { pieceId: Id; dartId: Id; w: Vec } | null } = { op: null, hover: null };

/** Dart apex (active size) within tolPx of the cursor. */
export function apexNear(app: App, w: Vec, tolPx = 8): { pieceId: Id; dartId: Id; w: Vec; apex: Vec } | null {
  let best: { pieceId: Id; dartId: Id; w: Vec; apex: Vec; d: number } | null = null;
  for (const p of app.doc.style.pieces) {
    if (app.hiddenPieces.has(p.id) || !p.darts.length) continue;
    for (const s of liveShapes(app, p, app.sizeOf(p))) {
      if (s.kind !== 'dart' || s.closed) continue;
      const aw = toWorld(p, (s as DartShape).apex);
      const d = Math.hypot(aw.x - w.x, aw.y - w.y) * app.view.scale;
      if (d <= tolPx && (!best || d < best.d)) best = { pieceId: p.id, dartId: s.id, w: aw, apex: (s as DartShape).apex, d };
    }
  }
  return best;
}

export function apexDown(app: App, p: Ptr): boolean {
  const h = apexNear(app, p.w); if (!h) return false;
  const piece = app.doc.piece(h.pieceId);
  if (piece.locked) { app.status(`${piece.name} is locked`); return true; }
  const base = app.doc.baseSize(piece), sz = app.sizeOf(piece);
  AP.op = { pieceId: h.pieceId, dartId: h.dartId, sid: sz === base ? undefined : sz, startW: p.w, apex0: h.apex, to: h.apex, moved: false, err: null };
  selectLive(app, { kind: 'dart', pieceId: h.pieceId, id: h.dartId });
  return true;
}

/** base apex for the base size (stored x / y), active-size apex otherwise (absolute in that size) */
function target(app: App, op: ApexOp, w: Vec, e: MouseEvent): Vec {
  const piece = app.doc.piece(op.pieceId);
  let dW = { x: w.x - op.startW.x, y: w.y - op.startW.y };
  if (e.shiftKey) { const ax = Math.abs(dW.x) >= Math.abs(dW.y); dW = ax ? { x: dW.x, y: 0 } : { x: 0, y: dW.y }; }
  const dL = dirToLocal(piece, dW);
  if (op.sid) return { x: op.apex0.x + dL.x, y: op.apex0.y + dL.y };
  const d = piece.darts.find(x => x.id === op.dartId)!;
  return { x: d.apex.x + dL.x, y: d.apex.y + dL.y };
}
const apply = (op: ApexOp) => (d: Parameters<typeof ops.moveDartApex>[0]) => ops.moveDartApex(d, op.pieceId, op.dartId, op.to, { sizeId: op.sid });

export function apexMove(app: App, p: Ptr): boolean {
  const op = AP.op;
  if (!op) { const h = apexNear(app, p.w); const k = h ? h.dartId : null; if (k !== (AP.hover?.dartId ?? null)) { AP.hover = h; app.invalidate('canvas'); } return false; }
  if (!op.moved && Math.hypot(p.w.x - op.startW.x, p.w.y - op.startW.y) * app.view.scale < 3) return true;
  op.moved = true;
  op.to = target(app, op, p.w, p.e as MouseEvent);
  op.err = previewWith(app, [op.pieceId], apply(op));
  const pv = app.preview.get(op.pieceId);
  if (pv) { try { const g = ops.dartSewGeometry(pv, app.doc.sizeLine(pv), app.sizeOf(pv)).find(x => x.dartId === op.dartId); if (g) op.legs = [g.legLengthA, g.legLengthB]; } catch { /* */ } }
  app.invalidate('status');
  return true;
}

export function apexUp(app: App, _p: Ptr): boolean {
  const op = AP.op; if (!op) return false;
  AP.op = null;
  if (!op.moved) { app.cancelPreview(); app.status('Dart selected · drag the apex to re-shape it (Fix Dart keeps the legs equal)'); return true; }
  if (commitWith(app, [op.pieceId], 'Move dart apex', apply(op))) app.status(op.sid ? 'Dart apex moved in this size only (grading)' : 'Dart apex moved · legs re-equalized (Fix Dart)');
  return true;
}
export function apexCancel(app: App): boolean { if (!AP.op) return false; AP.op = null; app.cancelPreview(); app.status('Apex move cancelled'); return true; }
export const apexBusy = () => !!AP.op;

export function apexHint(): string | null {
  const op = AP.op; if (!op) return null;
  const u = unitLabel();
  const legs = op.legs ? ` · legs ${fmt(op.legs[0])} / ${fmt(op.legs[1])} ${u}${Math.abs(op.legs[0] - op.legs[1]) < 0.01 ? ' ✓ equal' : ''}` : '';
  return `Dart apex · release to place${op.sid ? ' (this size only)' : ' · Fix Dart keeps the legs equal'}${legs} · Shift = H/V · Esc cancel${op.err ? ' · ⚠ ' + op.err : ''}`;
}
export function apexOverlay(app: App): string {
  const out: string[] = [];
  if (AP.hover && !AP.op) { const s = app.view.toScreen(AP.hover.w); out.push(`<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="7" fill="none" stroke="${LIVE_COL.dart}" stroke-width="1.5" stroke-dasharray="2 2"/>`, label({ x: s.x + 9, y: s.y - 9 }, 'apex', { col: LIVE_COL.dart })); }
  const op = AP.op; if (!op || !op.moved) return out.join('');
  const piece = app.doc.piece(op.pieceId);
  const pv = app.preview.get(op.pieceId) ?? piece;
  const sh = liveShapes(app, pv, app.sizeOf(pv)).find(x => x.id === op.dartId) as DartShape | undefined;
  if (sh) {
    const a = app.view.toScreen(toWorld(pv, sh.apex));
    out.push(dot(a, LIVE_COL.dart, 4));
    if (op.legs) { const eq = Math.abs(op.legs[0] - op.legs[1]) < 0.01; out.push(label({ x: a.x + 10, y: a.y - 10 }, `A ${fmt(op.legs[0])} · B ${fmt(op.legs[1])}${eq ? ' ✓' : ' Δ ' + fmt(Math.abs(op.legs[0] - op.legs[1]))} · depth ${fmt(sh.depth)}`, { col: eq ? '#1e8449' : '#c0392b' })); }
  }
  void toLocal;
  return out.join('');
}
