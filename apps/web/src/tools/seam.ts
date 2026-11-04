/**
 * Seam value tool (S).
 *   click a sew grade point         first point of the run (highlighted)
 *   click a second sew grade point  run first → second along the contour → seam dialog (ops.setSeam)
 *   click the same point again      whole loop from that point
 *   double-click inside a piece     whole-piece seam (ops.setSeamWholePiece)
 *   Esc                             cancel the run
 * Dialog: value (decimal or fraction, display unit) and direction (+ outward / − inward).
 */
import type { Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { anchorNear, pieceUnder, runWorld, screenPath } from '../hitkit';
import { ops } from '../ops-bridge';
import { rememberedDialog } from '../ui/dialog';
import { DoubleClick } from '../ui/dom';
import { reportError } from '../commands';
import { screenMarker } from './common';
import { fmt, unitLabel } from '../units-ui';
import { toast } from '../ui/toast';

let first: { pieceId: Id; anchorId: Id } | null = null;
let hoverTo: Id | null = null;
const dbl = new DoubleClick();

export async function seamDialog(app: App, title: string, current: number): Promise<number | null> {
  const r = await rememberedDialog('seam.value', {
    title, fields: [
      { kind: 'length', key: 'v', label: 'Seam allowance', value: Math.abs(current), min: 0 },
      { kind: 'radio', key: 'dir', label: 'Direction', value: current < 0 ? 'in' : 'out', options: [{ value: 'out', label: '+ outward (normal)' }, { value: 'in', label: '− inward' }] },
    ],
  });
  if (!r) return null;
  return (r.dir === 'in' ? -1 : 1) * (r.v as number);
}

async function applyRun(app: App, pieceId: Id, from: Id, to: Id) {
  const p = app.doc.piece(pieceId);
  const a = p.sew.points.find(q => q.id === from);
  const v = await seamDialog(app, `Seam — ${p.name}${from === to ? ' (whole loop)' : ''}`, a?.seamAfter ?? p.seamDefault);
  if (v == null) return;
  try { ops.setSeam(app.doc, pieceId, from, to, v); app.status(`Seam ${fmt(v)} ${unitLabel()}`); } catch (err) { reportError(err, 'Seam'); }
}

export const seamTool: Tool = {
  id: 'seam', title: 'Seam value', group: 'seam', hotkey: 'S', icon: ICON.seam, cursor: 'crosshair',
  activate() { first = null; hoverTo = null; },
  deactivate(app) { first = null; hoverTo = null; app.invalidate('canvas'); },
  busy: () => !!first,
  hint: () => first ? 'Seam: click the LAST grade point of the run (same point = whole loop) · Esc cancel' : 'Seam: click the first sew grade point · double-click a piece = whole piece',
  down(app, p) {
    const h = anchorNear(app, p.w, { gradeOnly: true, contour: 'sew', pieceId: first?.pieceId });
    if (dbl.hit(p.s.x, p.s.y, h ? 'a' + h.anchor.id : 'piece')) {
      if (!h || first) {
        const pc = pieceUnder(app, p.w);
        if (pc) {
          first = null;
          void (async () => {
            const v = await seamDialog(app, `Seam — whole piece ${pc.name}`, pc.seamDefault);
            if (v != null) try { ops.setSeamWholePiece(app.doc, pc.id, v); } catch (err) { reportError(err, 'Seam'); }
          })();
          return;
        }
      }
    }
    if (!h) { if (!first) app.status('Click a grade point on a sew line'); return; }
    if (h.piece.locked) { toast('Piece is locked', 'warn'); return; }
    if (!first) { first = { pieceId: h.piece.id, anchorId: h.anchor.id }; app.invalidate('canvas'); return; }
    const f = first; first = null; hoverTo = null;
    void applyRun(app, f.pieceId, f.anchorId, h.anchor.id);
  },
  move(app, p) {
    if (!first) return;
    const h = anchorNear(app, p.w, { gradeOnly: true, contour: 'sew', pieceId: first.pieceId });
    hoverTo = h?.anchor.id ?? null;
    app.invalidate('canvas');
  },
  key(app, e) { if (e.key === 'Escape' && first) { first = null; hoverTo = null; app.invalidate('canvas'); return true; } return false; },
  overlay(app) {
    if (!first) return '';
    const pc = app.doc.style.pieces.find(x => x.id === first!.pieceId); if (!pc) return '';
    let s = '';
    const a = pc.sew.points.findIndex(q => q.id === first!.anchorId);
    if (hoverTo) s += `<path d="${screenPath(app, runWorld(app, pc, pc.sew, first.anchorId, hoverTo))}" fill="none" stroke="#ff9f1a" stroke-width="4" opacity="0.6"/>`;
    const r = app.doc.resolvePiece(pc.id, app.sizeOf(pc));
    if (a >= 0) { const L = pc.layout ?? { x: 0, y: 0, angleDeg: 0 }; void L; s += screenMarker(app.view.toScreen(runWorld(app, pc, pc.sew, first.anchorId, first.anchorId)[0] ?? r.sew.anchorPos[a]), 'square', '#ff9f1a', 6); }
    return s;
  },
};
