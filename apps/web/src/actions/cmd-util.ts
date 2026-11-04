/** Small helpers shared by the command modules. */
import type { Piece, Id, Vec } from '@prowdcad/kernel';
import type { App } from '../app';
import type { CommandCtx } from '../commands';
import { Cancelled } from '../selection';
import { pick, type PickOptions, type PickResult } from '../tools/pick';
import { toLocal } from '../geometry';

export const hasPiece = (c: CommandCtx) => c.app.sel.pieces.length > 0 || c.app.sel.anchors.length > 0;
export const hasAnchor = (c: CommandCtx) => c.app.sel.anchors.length > 0;
export const always = () => true;

export function onePiece(app: App): Piece {
  const p = app.primaryPiece(); if (!p) throw new Error('Select a piece');
  return app.doc.piece(p.id);
}
export function selPieces(app: App): Piece[] {
  const ids = app.sel.pieces.length ? app.sel.pieces : app.sel.anchors.map(a => a.pieceId);
  return [...new Set(ids)].map(id => app.doc.piece(id));
}
/** Selected anchors of the primary piece. */
export function pieceAnchors(app: App): { piece: Piece; ids: Id[] } {
  const piece = onePiece(app);
  const ids = app.sel.anchors.filter(a => a.pieceId === piece.id).map(a => a.anchorId);
  if (!ids.length) throw new Error('Select point(s) on the piece');
  return { piece, ids };
}

/** pick() that throws Cancelled on Esc and narrows by kind. */
export async function must<K extends PickResult['kind']>(app: App, opt: PickOptions & { kind: K | PickOptions['kind'] }, want?: K): Promise<Extract<PickResult, { kind: K }>> {
  const r = await pick(app, opt);
  if (!r || r === 'done') throw new Cancelled();
  if (want && r.kind !== want) throw new Error('Unexpected pick');
  return r as Extract<PickResult, { kind: K }>;
}
export async function pickPointLocal(app: App, piece: Piece, prompt: string, overlay?: PickOptions['overlay']): Promise<Vec> {
  const r = await must(app, { kind: 'point', prompt, overlay }, 'point');
  return toLocal(piece, r.w);
}
