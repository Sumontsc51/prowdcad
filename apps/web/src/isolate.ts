/**
 * "Only this piece" (AccuMark Current Pieces): the selected piece(s) stay on the sheet and every other
 * piece is hidden, so overlapping or close pieces cannot be picked by mistake. Switching it off puts
 * back exactly the pieces that were visible before.
 */
import type { App } from './app';
import { toast } from './ui/toast';

let before: Set<string> | null = null;
export const isIsolated = () => !!before;
export function toggleIsolate(app: App): void {
  if (before) {
    app.hiddenPieces.clear(); for (const id of before) if (app.doc.style.pieces.some(p => p.id === id)) app.hiddenPieces.add(id);
    before = null; app.status('Every piece is shown again'); app.invalidate(); return;
  }
  const keep = new Set(app.sel.pieces.filter(id => app.doc.style.pieces.some(p => p.id === id)));
  if (!keep.size) { toast('Only this piece: select a piece first', 'warn'); return; }
  before = new Set(app.hiddenPieces);
  for (const p of app.doc.style.pieces) if (!keep.has(p.id)) app.hiddenPieces.add(p.id);
  app.status(`Only ${keep.size === 1 ? app.doc.style.pieces.find(p => keep.has(p.id))?.name : keep.size + ' pieces'} shown · switch “Only this piece” off to bring the others back`);
  app.invalidate();
}
