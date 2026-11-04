/**
 * Live-object tools.
 *
 * Dart (Shift+D):   click a dart (legs / axis) → select it (Inspector) · click a sew line → create
 *                   dart dialog (width, apex by depth or click, fold, drill offset) → createDart.
 * Pleat (Shift+L):  click a pleat → select it · click two points for the axis (start, end) →
 *                   pleat dialog (type, depth start/end, fold, auto notches, open now). Alt on the
 *                   second click = axis only (attributes later in the Inspector).
 * Fullness (Shift+U): click a fullness slash → select it · click the slash point on a sew line, then
 *                   the pivot (on the sew line = hinge, inside the piece = rotation centre) → dialog.
 * Esc cancels a pending click.
 */
import type { Vec, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool, type Ptr } from './tool';
import { contourNear } from '../hitkit';
import { reportError } from '../commands';
import { toast } from '../ui/toast';
import { snapPoint } from '../canvas/snap';
import { fs, screenMarker } from './common';
import { liveNear, contourPos, selectLive, type LiveKind } from '../live';
import { createDartFlow, pleatFromAxis, fullnessDialogApply } from '../actions/live-cmds';
import { toLocal } from '../geometry';
import type { LiveContourPos } from '../ops-bridge';

function liveClick(app: App, p: Ptr, kind: LiveKind): boolean {
  const h = p.hit.kind === 'live' && p.hit.liveKind === kind && p.hit.pieceId && p.hit.liveId
    ? { pieceId: p.hit.pieceId, id: p.hit.liveId }
    : (() => { const n = liveNear(app, p.w, { kind }); return n ? n.ref : null; })();
  if (!h) return false;
  selectLive(app, { kind, pieceId: h.pieceId, id: h.id });
  return true;
}
const run = (what: string, fn: () => Promise<unknown>) => { fn().catch(err => reportError(err, what)); };

// ───────────── Dart ─────────────
let dartHover: Vec | null = null;
export const dartTool: Tool = {
  id: 'dart', title: 'Dart', group: 'live', hotkey: 'Shift+D', icon: ICON.dart, cursor: 'crosshair',
  deactivate(app) { dartHover = null; app.invalidate('canvas'); },
  hint: () => 'Dart: click a sew line to create a dart · click a dart to select it (Inspector)',
  down(app, p) {
    if (liveClick(app, p, 'dart')) return;
    const h = contourNear(app, p.w, { contour: 'sew' });
    if (!h) { app.status('Click a sew line (create) or a dart (select)'); return; }
    if (h.piece.locked) { toast('Piece is locked', 'warn'); return; }
    run('Create dart', () => createDartFlow(app, h.piece.id, contourPos(app, h), h.world));
  },
  move(app, p) { const h = contourNear(app, p.w, { contour: 'sew' }); dartHover = h ? h.world : null; app.invalidate('canvas'); },
  overlay(app) { return dartHover ? screenMarker(app.view.toScreen(dartHover), 'ring', '#d6309b', 6) : ''; },
};

// ───────────── Pleat ─────────────
let pleatA: Vec | null = null;
let pleatHover: Vec | null = null;
export const pleatTool: Tool = {
  id: 'pleat', title: 'Pleat', group: 'live', hotkey: 'Shift+L', icon: ICON.pleat, cursor: 'crosshair',
  activate() { pleatA = null; },
  deactivate(app) { pleatA = null; pleatHover = null; app.invalidate('canvas'); },
  busy: () => !!pleatA,
  hint: () => pleatA ? 'Pleat: click the axis END (Alt = axis only, attributes later) · Esc cancel' : 'Pleat: click the axis START · click a pleat to select it',
  down(app, p) {
    if (!pleatA && liveClick(app, p, 'pleat')) return;
    const w = snapPoint(app, p.w, {}).p;
    if (!pleatA) { pleatA = w; app.invalidate('canvas'); return; }
    const a = pleatA; pleatA = null;
    const pc = contourNear(app, a, { contour: 'sew', tolPx: 12 })?.piece ?? contourNear(app, w, { contour: 'sew', tolPx: 12 })?.piece ?? app.primaryPiece();
    if (!pc) { toast('The axis must start or end on a piece', 'warn'); return; }
    const alt = (p.e as MouseEvent).altKey;
    run('Pleat', () => pleatFromAxis(app, app.doc.piece(pc.id), a, w, !alt));
  },
  move(app, p) { pleatHover = snapPoint(app, p.w, {}).p; if (pleatA) app.invalidate('canvas'); },
  key(app, e) { if (e.key === 'Escape' && pleatA) { pleatA = null; app.invalidate('canvas'); return true; } return false; },
  overlay(app) {
    if (!pleatA) return '';
    const a = app.view.toScreen(pleatA), b = pleatHover ? app.view.toScreen(pleatHover) : a;
    return `<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="#2e86c1" stroke-width="1.4" stroke-dasharray="8 3 2 3"/>` + screenMarker(a, 'square', '#2e86c1', 4);
  },
};

// ───────────── Fullness ─────────────
let fSlash: { pieceId: Id; pos: LiveContourPos; w: Vec } | null = null;
let fHover: Vec | null = null;
export const fullnessTool: Tool = {
  id: 'fullness', title: 'Add fullness', group: 'live', hotkey: 'Shift+U', icon: ICON.fullness, cursor: 'crosshair',
  activate() { fSlash = null; },
  deactivate(app) { fSlash = null; fHover = null; app.invalidate('canvas'); },
  busy: () => !!fSlash,
  hint: () => fSlash ? 'Fullness: click the PIVOT (sew line = hinge, inside = centre) · Esc cancel' : 'Fullness: click the SLASH point on a sew line · click a slash to select it',
  down(app, p) {
    if (!fSlash) {
      if (liveClick(app, p, 'fullness')) return;
      const h = contourNear(app, p.w, { contour: 'sew' });
      if (!h) { app.status('Click a sew line'); return; }
      if (h.piece.locked) { toast('Piece is locked', 'warn'); return; }
      fSlash = { pieceId: h.piece.id, pos: contourPos(app, h), w: h.world };
      app.invalidate('canvas'); return;
    }
    const s = fSlash; fSlash = null;
    const piece = app.doc.piece(s.pieceId);
    const h = contourNear(app, p.w, { contour: 'sew', pieceId: s.pieceId });
    const pivot = h ? contourPos(app, h) : toLocal(piece, snapPoint(app, p.w, {}).p);
    run('Add fullness', () => fullnessDialogApply(app, piece, s.pos, pivot));
  },
  move(app, p) { fHover = p.w; if (fSlash) app.invalidate('canvas'); },
  key(app, e) { if (e.key === 'Escape' && fSlash) { fSlash = null; app.invalidate('canvas'); return true; } return false; },
  overlay(app) {
    if (!fSlash) return '';
    const a = app.view.toScreen(fSlash.w), b = fHover ? app.view.toScreen(fHover) : a;
    return `<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="#d35400" stroke-width="1.4" stroke-dasharray="4 3"/>` + screenMarker(a, 'ring', '#d35400', 6);
  },
};
