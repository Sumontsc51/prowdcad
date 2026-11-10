/**
 * Selection → kernel argument helpers shared by commands: "the selected segment", "the selected
 * run", sizes, and interactive fallbacks (pick on canvas when nothing suitable is selected).
 */
import type { Id, Piece, Contour, SizeId } from '@prowdcad/kernel';
import type { App } from './app';
import type { AnchorRef } from './ops-bridge';
import { contourById } from './geometry';
import { pick } from './tools/pick';
import { segmentIds } from './hitkit';
import { resolveFor } from './geometry';

export class Cancelled extends Error { constructor() { super('cancelled'); this.name = 'Cancelled'; } }

export interface Run { pieceId: Id; contourId: Id; from: Id; to: Id; isSew: boolean }

export function livePiece(app: App, id: Id): Piece { return app.doc.piece(id); }

/** Non-base active size for a piece, or undefined (base edit = all sizes). */
export function editSize(app: App, piece: Piece): SizeId | undefined {
  const s = app.sizeOf(piece); return s === app.doc.baseSize(piece) ? undefined : s;
}

/** The grade segment that leaves grade anchor `anchorId` (next grade anchor). */
export function segmentFrom(app: App, pieceId: Id, contourId: Id, anchorId: Id): Run | null {
  const p = app.doc.piece(pieceId); const c = contourById(p, contourId); if (!c) return null;
  const r = resolveFor(app.doc, p, app.doc.baseSize(p));
  const rc = c === p.sew ? r.sew : r.internals[p.internals.indexOf(c)];
  const i = c.points.findIndex(a => a.id === anchorId);
  const k = rc.gradeIdx.indexOf(i); if (k < 0) return null;
  const ids = segmentIds(c, rc, k); if (!ids.from || !ids.to) return null;
  return { pieceId, contourId, from: ids.from, to: ids.to, isSew: c === p.sew };
}

/**
 * Selected run: two selected anchors on one contour → from first to second (selection order);
 * one selected grade anchor → its grade segment. Null otherwise.
 */
export function selectedRun(app: App): Run | null {
  const segs = app.sel.segments;
  if (segs.length && (app.sel.primary === 'segment' || app.sel.anchors.length === 0)) {
    const g = segs[segs.length - 1];
    const p = app.doc.style.pieces.find(x => x.id === g.pieceId);
    if (p) return { pieceId: g.pieceId, contourId: g.contourId, from: g.from, to: g.to, isSew: p.sew.id === g.contourId };
  }
  const sel = app.sel.anchors;
  if (sel.length >= 2) {
    const [a, b] = sel.slice(-2);
    if (a.pieceId === b.pieceId && a.contourId === b.contourId && a.anchorId !== b.anchorId) {
      const p = app.doc.piece(a.pieceId);
      return { pieceId: a.pieceId, contourId: a.contourId, from: a.anchorId, to: b.anchorId, isSew: p.sew.id === a.contourId };
    }
  }
  const last = sel[sel.length - 1];
  if (last) { const q = app.resolveRef(last); if (q && q.anchor.kind === 'grade') return segmentFrom(app, last.pieceId, last.contourId, last.anchorId); }
  return null;
}

/** Selected run, or ask the user to click a segment on the canvas. */
export async function runOrPick(app: App, prompt = 'Click a segment', contour: 'sew' | 'internal' | 'any' = 'any'): Promise<Run> {
  const r = selectedRun(app);
  if (r && (contour === 'any' || (contour === 'sew') === r.isSew)) return r;
  const res = await pick(app, { kind: 'contour', prompt, contour });
  if (!res || res === 'done' || res.kind !== 'contour') throw new Cancelled();
  const h = res.hit;
  if (!h.from || !h.to) throw new Error('That part of the line has no grade segment (needs grade points at both ends)');
  return { pieceId: h.piece.id, contourId: h.contour.id, from: h.from, to: h.to, isSew: h.contour === h.piece.sew };
}

/** Pick an internal contour (or use the selected one). */
export async function internalOrPick(app: App, prompt = 'Click an internal line'): Promise<{ piece: Piece; contour: Contour; w: { x: number; y: number } }> {
  const si = app.sel.internals[app.sel.internals.length - 1];
  if (si && (app.sel.primary === 'internal' || !app.sel.anchors.length)) {
    const p = app.doc.style.pieces.find(x => x.id === si.pieceId); const c = p?.internals.find(x => x.id === si.contourId);
    if (p && c) return { piece: p, contour: c, w: c.points[0] };
  }
  const last = app.sel.anchors[app.sel.anchors.length - 1];
  if (last) {
    const p = app.doc.piece(last.pieceId); const c = p.internals.find(x => x.id === last.contourId);
    if (c) { const q = app.resolveRef(last)!; return { piece: p, contour: c, w: q.anchor }; }
  }
  const res = await pick(app, { kind: 'contour', prompt, contour: 'internal' });
  if (!res || res === 'done' || res.kind !== 'contour') throw new Cancelled();
  return { piece: res.hit.piece, contour: res.hit.contour, w: res.hit.local };
}

export async function pieceOrPick(app: App, prompt = 'Click a piece'): Promise<Piece> {
  const p = app.primaryPiece();
  if (p) return app.doc.piece(p.id);
  const res = await pick(app, { kind: 'piece', prompt });
  if (!res || res === 'done' || res.kind !== 'piece') throw new Cancelled();
  return res.piece;
}

export async function anchorOrPick(app: App, prompt: string, o: { gradeOnly?: boolean; contour?: 'sew' | 'internal' | 'any' } = {}): Promise<AnchorRef> {
  const pa = app.primaryAnchor();
  if (pa && (!o.gradeOnly || pa.anchor.kind === 'grade') && (!o.contour || o.contour === 'any' || (o.contour === 'sew') === (pa.contour === pa.piece.sew))) return pa.ref;
  const res = await pick(app, { kind: 'anchor', prompt, gradeOnly: o.gradeOnly, contour: o.contour });
  if (!res || res === 'done' || res.kind !== 'anchor') throw new Cancelled();
  return res.hit.ref;
}

/** Selected anchor ids grouped per piece. */
export function anchorsByPiece(app: App): Map<Id, Id[]> {
  const m = new Map<Id, Id[]>();
  for (const r of app.sel.anchors) { const l = m.get(r.pieceId) ?? []; l.push(r.anchorId); m.set(r.pieceId, l); }
  return m;
}

export function sizeNameOf(app: App, id: SizeId): string { return app.sizeLine().sizes.find(s => s.id === id)?.name ?? id; }
