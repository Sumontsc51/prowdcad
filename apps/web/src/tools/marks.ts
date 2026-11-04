/**
 * Notch (N): click a sew-line anchor → anchored notch (ops.addNotchAtAnchor).
 * Drill (D):  click inside a piece → drill hole (ops.addDrill).
 * Both route through the ops bridge so the kernel modules take over once wired.
 */
import type { NotchType } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { ops } from '../ops-bridge';
import { pieceAtWorld, toLocal } from '../geometry';
import { toast } from '../ui/toast';
import { reportError } from '../commands';

export let notchType: NotchType = 'slit';
export function setNotchType(t: NotchType) { notchType = t; }
export let drillDiameter = 3;
export function setDrillDiameter(d: number) { drillDiameter = d; }

export const notchTool: Tool = {
  id: 'notch', title: 'Notch', group: 'marks', hotkey: 'N', icon: ICON.notch, cursor: 'crosshair',
  hint: () => `Notch (${notchType}): click a sew-line point`,
  down(app: App, p) {
    const h = p.hit;
    if (h.kind !== 'anchor' || !h.pieceId) { toast('Click a point on the sew line', 'warn'); return; }
    const piece = app.doc.piece(h.pieceId);
    if (h.contourId !== piece.sew.id) { toast('Notches go on the sew line', 'warn'); return; }
    try { ops.addNotchAtAnchor(app.doc, { pieceId: h.pieceId, contourId: h.contourId!, anchorId: h.anchorId! }, notchType); app.status('Notch added'); }
    catch (err) { reportError(err, 'Notch'); }
  },
};

export const drillTool: Tool = {
  id: 'drill', title: 'Drill hole', group: 'marks', hotkey: 'D', icon: ICON.drill, cursor: 'crosshair',
  hint: () => `Drill Ø${drillDiameter} mm: click inside a piece`,
  down(app: App, p) {
    const piece = pieceAtWorld(app.doc, p.w, app.activeSize, app.hiddenPieces);
    if (!piece) { toast('Click inside a piece', 'warn'); return; }
    try { ops.addDrill(app.doc, { pieceId: piece.id, at: toLocal(piece, p.w), diameter: drillDiameter }); app.status('Drill added'); }
    catch (err) { reportError(err, 'Drill'); }
  },
};
