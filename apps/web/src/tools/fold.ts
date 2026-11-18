/**
 * Fold (O) — show a piece folded along a line. A view only: the piece is not cut and its lines stay editable.
 *
 *  click two points of one piece (they snap to its points and outline)  → the smaller part folds over; it is drawn
 *      mirrored and dashed where it lies now, and faded where it was.
 *  click an internal line                                                → fold along that line (through its two ends).
 *  right-click a folded piece, or the Unfold buttons                     → flat again.
 *  "Other side" folds the other part over instead.
 *  While a piece is folded, Match Line and Curve / Handle pick the folded lines where they lie.
 */
import type { Vec, Piece } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool, type Ptr } from './tool';
import { ops } from '../ops-bridge';
import { pieceAtWorld, toLocal, toWorld } from '../geometry';
import { contourNear } from '../hitkit';
import { snapOutline, snapPieceAnchor, fs, screenMarker } from './common';
import { toast } from '../ui/toast';
import { reportError, runCommand } from '../commands';

interface Pt { piece: Piece; local: Vec; world: Vec; snap: 'point' | 'line' | 'free' }
const FD: { a: Pt | null; hov: Pt | null; last: string | null } = { a: null, hov: null, last: null };

function pointAt(app: App, w: Vec, only?: Piece): Pt | null {
  const pieces = only ? [only] : [...app.pieces()].reverse().filter(p => !app.hiddenPieces.has(p.id));
  for (const piece of pieces) { const s = snapPieceAnchor(app, piece, w, 9); if (s) return { piece, local: s.local, world: s.world, snap: 'point' }; }
  for (const piece of pieces) { const s = snapOutline(app, piece, w, 9); if (s) return { piece, local: s.local, world: s.world, snap: 'line' }; }
  const piece = only ?? pieceAtWorld(app.doc, w, app.activeSize, app.hiddenPieces);
  return piece ? { piece, local: toLocal(piece, w), world: w, snap: 'free' } : null;
}
export function unfoldPieces(app: App, ids: string[]): number {
  const list = ids.filter(id => app.piece(id)?.fold);
  if (!list.length) return 0;
  try { app.doc.transact(list.length > 1 ? 'Unfold pieces' : 'Unfold piece', () => { for (const id of list) ops.clearFold(app.doc, id); }); } catch (err) { reportError(err, 'Unfold'); return 0; }
  app.invalidate(); return list.length;
}
export const foldedIds = (app: App) => app.doc.style.pieces.filter(p => p.fold).map(p => p.id);

export const foldTool: Tool = {
  id: 'fold', title: 'Fold piece', group: 'position', hotkey: 'O', icon: ICON.fold, cursor: 'crosshair',
  activate() { FD.a = null; FD.hov = null; },
  deactivate(app) { FD.a = null; FD.hov = null; app.invalidate('canvas'); },
  busy: () => !!FD.a,
  toggles: app => [
    { id: 'other', label: 'Other side', title: 'Fold the other part of the last folded piece over instead', on: false },
    { id: 'unfold', label: 'Unfold', title: 'Unfold the selected pieces (or the last folded piece)', on: false },
    { id: 'unfoldAll', label: `Unfold all (${foldedIds(app).length})`, title: 'Unfold every folded piece', on: false },
    { id: 'mirror', label: 'Mirror piece', title: 'Click the mirror line of a piece: the other half is generated and stays linked (Piece ▸ Mirror piece)', on: false },
    ...(app.primaryPiece()?.half ? [
      app.primaryPiece()!.half!.openAtOutput === false
        ? { id: 'unfoldMirror', label: 'Unfold mirror', title: 'Show the full mirrored piece again (still linked)', on: false }
        : { id: 'foldMirror', label: 'Fold mirror', title: 'Show only the working half of the mirrored piece', on: false },
      { id: 'openMirror', label: 'Open mirror', title: 'Break the link: the piece becomes an ordinary full piece', on: false },
    ] : []),
  ],
  toggle(app, id) {
    if (id === 'mirror') { void runCommand('piece.mirror'); return; }
    if (id === 'foldMirror' || id === 'unfoldMirror' || id === 'openMirror') { void runCommand('piece.' + id); return; }
    if (id === 'unfoldAll') { const n = unfoldPieces(app, foldedIds(app)); app.status(n ? `${n} piece${n > 1 ? 's' : ''} unfolded` : 'No piece is folded'); return; }
    const sel = app.sel.pieces.filter(pid => app.piece(pid)?.fold);
    const target = sel.length ? sel : FD.last && app.piece(FD.last)?.fold ? [FD.last] : foldedIds(app).slice(-1);
    if (!target.length) { app.status('No piece is folded'); return; }
    if (id === 'unfold') { unfoldPieces(app, target); app.status('Unfolded'); return; }
    if (id === 'other') {
      try { app.doc.transact('Fold the other side', () => { for (const pid of target) { const f = app.doc.piece(pid).fold!; f.side = f.side === 1 ? -1 : 1; } }); } catch (err) { reportError(err, 'Fold'); }
      app.invalidate();
    }
  },
  hint() {
    return FD.a ? `Fold · click the second point of the fold line on ${FD.a.piece.name} · Esc = cancel`
      : 'Fold · click two points of a piece (the smaller part folds over), or click an internal line to fold along it · right-click a folded piece = unfold · Esc = Select';
  },
  move(app, p: Ptr) { FD.hov = pointAt(app, p.w, FD.a?.piece); app.invalidate('canvas'); },
  down(app, p: Ptr) {
    if (!FD.a) {
      // an internal line (clicked away from its points): fold along it
      const first = pointAt(app, p.w);
      const ih = contourNear(app, p.w, { contour: 'internal', tolPx: 6 });
      if (ih && !ih.contour.closed && ih.contour.points.length >= 2 && first?.snap !== 'point') {
        const r = ih.rc.anchorPos, a = r[0], b = r[r.length - 1];
        try { ops.setFold(app.doc, ih.piece.id, a, b); FD.last = ih.piece.id; app.status(`${ih.piece.name} folded along the line · right-click it = unfold`); } catch (err) { reportError(err, 'Fold'); }
        app.invalidate(); return;
      }
      if (!first) { app.status('Click a point of a piece'); return; }
      FD.a = first; app.invalidate('canvas'); return;
    }
    const b = pointAt(app, p.w, FD.a.piece); const a = FD.a;
    if (!b) return;
    FD.a = null;
    try { ops.setFold(app.doc, a.piece.id, a.local, b.local); FD.last = a.piece.id; app.status(`${a.piece.name} folded · “Other side” folds the other part · right-click it = unfold`); } catch (err) { reportError(err, 'Fold'); }
    app.invalidate();
  },
  context(app, p: Ptr) {
    if (FD.a) { FD.a = null; app.invalidate('canvas'); return true; }
    const piece = pieceAtWorld(app.doc, p.w, app.activeSize, app.hiddenPieces);
    if (piece?.fold) { unfoldPieces(app, [piece.id]); app.status(`${piece.name} unfolded`); return true; }
    if (piece) { toast(`${piece.name} is not folded`, 'info'); return true; }
    return false;
  },
  key(app, e) {
    if (e.key !== 'Escape') return false;
    if (FD.a) { FD.a = null; app.invalidate('canvas'); return true; }
    app.setTool('select'); return true;
  },
  overlay(app) {
    let s = '';
    const h = FD.hov;
    if (FD.a) {
      const a = app.view.toScreen(toWorld(FD.a.piece, FD.a.local));
      s += screenMarker(a, 'ring', '#e8590c', 7);
      if (h) { const b = app.view.toScreen(h.world); s += `<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="#e8590c" stroke-width="1.4" stroke-dasharray="10 3 2 3"/>`; }
    }
    if (h && h.snap !== 'free') s += screenMarker(app.view.toScreen(h.world), h.snap === 'point' ? 'ring' : 'circle', '#e8590c', 6);
    return s;
  },
};
