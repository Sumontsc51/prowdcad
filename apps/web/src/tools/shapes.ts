/**
 * Shape tools — each click (or drag) creates a new piece via the kernel factory.
 *   R  Rectangle      : drag to size (Shift = square) or click → W×H dialog
 *   C  Circle         : drag radius or click → Ø / perimeter dialog
 *      Polygon        : drag radius or click → sides + radius dialog
 *      Rounded rect   : drag to size or click → W×H×r dialog
 */
import { rectangleContour, circleContour, polygonContour, roundedRectContour, makePiece, resolveContour, totalLength, type Contour, type Vec, type Piece } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { snapPoint } from '../canvas/snap';
import { showDialog } from '../ui/dialog';
import { settings, saveSettings } from '../settings';
import { toast } from '../ui/toast';
import { fmt, unitLabel } from '../units-ui';
import { fs } from './common';
import { pieceAtWorld, toLocal, dirToLocal } from '../geometry';

type Kind = 'rect' | 'circle' | 'polygon' | 'roundrect';
let drag: { kind: Kind; a: Vec; b: Vec; square: boolean } | null = null;

const NAMES: Record<Kind, string> = { rect: 'RECTANGLE', circle: 'CIRCLE', polygon: 'POLYGON', roundrect: 'ROUND RECT' };

/** The 8-anchor CR circle is not exactly 2πr: measure the kernel's own resolved perimeter per unit radius. */
function circlePerimeterFactor(app: App): number {
  const line = app.sizeLine();
  const r = resolveContour(circleContour(0, 0, 100, 8), line, line.baseSizeId, 0.001);
  return totalLength(r) / 100;
}

export function addShapePiece(app: App, kind: Kind, contour: Contour, name?: string) {
  const n = app.style.pieces.filter(p => p.name.startsWith(NAMES[kind])).length + 1;
  const piece = makePiece(name ?? `${NAMES[kind]} ${n}`, contour, app.doc.sizeTable().id);
  const xs = contour.points.map(p => p.x), ys = contour.points.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, y0 = Math.min(...ys), y1 = Math.max(...ys);
  piece.grain = { a: { x: cx, y: y0 + (y1 - y0) * 0.2 }, b: { x: cx, y: y0 + (y1 - y0) * 0.8 }, gradeA: {}, gradeB: {}, centered: true };
  app.doc.transact(`New ${kind}`, s => { s.pieces.push(piece); });
  app.sel = { pieces: [piece.id], anchors: [] };
  app.invalidate();
  return piece;
}

/** Tool option "Internal shape": the shape is drawn inside the piece under it, as a closed internal line. */
const internalOn = () => !!settings.shapeInternal;
/** The piece a shape drawn at `w` goes into (the piece under that point). */
function hostAt(app: App, w: Vec): Piece | null { return pieceAtWorld(app.doc, w, app.activeSize, app.hiddenPieces); }
/** Add a shape (sheet coordinates) to `host` as a closed internal line. */
export function addShapeInternal(app: App, kind: Kind, contour: Contour, host: Piece) {
  if (host.locked) { toast(`${host.name} is locked`, 'warn'); return null; }
  const c: Contour = { ...contour, type: 'internal', closed: true, points: contour.points.map(a => {
    const q = toLocal(host, a);
    return { ...a, x: q.x, y: q.y, hIn: a.hIn ? dirToLocal(host, a.hIn) : undefined, hOut: a.hOut ? dirToLocal(host, a.hOut) : undefined, seamAfter: undefined };
  }) };
  for (const a of c.points) { if (a.hIn === undefined) delete a.hIn; if (a.hOut === undefined) delete a.hOut; delete a.seamAfter; }
  if (!c.points.some(a => a.kind === 'grade')) c.points[0].kind = 'grade';
  app.doc.transact(`Internal ${kind}`, () => { app.doc.piece(host.id).internals.push(c); });
  app.applySel({ k: 'internal', c: { pieceId: host.id, contourId: c.id } }, 'replace');
  toast(`${NAMES[kind].charAt(0) + NAMES[kind].slice(1).toLowerCase()} added inside “${host.name}” as an internal shape`, 'ok');
  app.invalidate();
  return c;
}
/** Create the shape: a new piece, or (option Internal shape) an internal line of the piece under `at`. */
function place(app: App, kind: Kind, contour: Contour, at: Vec) {
  if (!internalOn()) { addShapePiece(app, kind, contour); return; }
  const host = hostAt(app, at);
  if (!host) { toast('Internal shape: start inside a piece (or switch “Internal shape” off to make a new piece)', 'warn'); return; }
  addShapeInternal(app, kind, contour, host);
}

function build(kind: Kind, a: Vec, b: Vec, square: boolean): Contour | null {
  let w = b.x - a.x, h = b.y - a.y;
  if (kind === 'rect' || kind === 'roundrect') {
    if (square) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
    const x = Math.min(a.x, a.x + w), y = Math.min(a.y, a.y + h), W = Math.abs(w), H = Math.abs(h);
    if (W < 0.5 || H < 0.5) return null;
    return kind === 'rect' ? rectangleContour(x, y, W, H) : roundedRectContour(x, y, W, H, Math.min(settings.roundRadiusMm, W / 2, H / 2));
  }
  const r = Math.hypot(w, h);
  if (r < 0.5) return null;
  return kind === 'circle' ? circleContour(a.x, a.y, r, 8) : polygonContour(a, r, Math.max(3, Math.round(settings.polygonSides)));
}

async function dialogFor(app: App, kind: Kind, at: Vec) {
  if (kind === 'rect') {
    const r = await showDialog({ title: 'Rectangle', fields: [{ kind: 'length', key: 'w', label: 'Width', value: 500, min: 0.1 }, { kind: 'length', key: 'h', label: 'Height', value: 700, min: 0.1 }] });
    if (r) place(app, 'rect', rectangleContour(at.x, at.y, r.w as number, r.h as number), at);
  } else if (kind === 'roundrect') {
    const r = await showDialog({ title: 'Rounded rectangle', fields: [{ kind: 'length', key: 'w', label: 'Width', value: 300, min: 0.1 }, { kind: 'length', key: 'h', label: 'Height', value: 200, min: 0.1 }, { kind: 'length', key: 'r', label: 'Corner radius', value: settings.roundRadiusMm, min: 0 }] });
    if (r) { settings.roundRadiusMm = r.r as number; saveSettings(); place(app, 'roundrect', roundedRectContour(at.x, at.y, r.w as number, r.h as number, r.r as number), at); }
  } else if (kind === 'circle') {
    const r = await showDialog({
      title: 'Circle', fields: [
        { kind: 'select', key: 'by', label: 'Size by', value: 'd', options: [{ value: 'd', label: 'Diameter Ø' }, { value: 'p', label: 'Perimeter' }] },
        { kind: 'length', key: 'v', label: 'Value', value: 200, min: 0.1 },
      ],
    });
    if (r) {
      const rad = r.by === 'd' ? (r.v as number) / 2 : (r.v as number) / circlePerimeterFactor(app);
      place(app, 'circle', circleContour(at.x, at.y, rad, 8), at);
    }
  } else {
    const r = await showDialog({ title: 'Polygon', fields: [{ kind: 'number', key: 'n', label: 'Sides', value: settings.polygonSides, min: 3, max: 64 }, { kind: 'length', key: 'r', label: 'Radius (centre → corner)', value: 100, min: 0.1 }] });
    if (r) { settings.polygonSides = Math.round(r.n as number); saveSettings(); place(app, 'polygon', polygonContour(at, r.r as number, settings.polygonSides), at); }
  }
}

function makeShapeTool(kind: Kind, id: string, title: string, hotkey: string | undefined, icon: string): Tool {
  return {
    id, title, group: 'shape', hotkey, icon, cursor: 'crosshair',
    deactivate(app) { drag = null; app.invalidate('canvas'); },
    busy: () => !!drag,
    toggles: () => [{ id: 'internal', label: 'Internal shape', title: 'On: the shape is drawn inside the piece under it, as a closed internal line (cut-out, pocket, placement). Off: the shape becomes a new piece.', on: internalOn() }],
    toggle(app, tid) { if (tid === 'internal') { settings.shapeInternal = !settings.shapeInternal; saveSettings(); app.status(internalOn() ? `${title}: drawn as an internal shape of the piece under it` : `${title}: drawn as a new piece`); app.invalidate(); } },
    hint: () => `${title}${internalOn() ? ' · internal shape: start inside a piece' : ' · new piece'}: drag to draw (Shift = square) · click for exact size dialog`,
    down(app, p) { const a = snapPoint(app, p.w).p; drag = { kind, a, b: a, square: p.e.shiftKey }; },
    move(app, p) {
      if (!drag) return;
      drag.b = snapPoint(app, p.w).p; drag.square = p.e.shiftKey;
      const w = drag.b.x - drag.a.x, h = drag.b.y - drag.a.y;
      app.status(kind === 'rect' || kind === 'roundrect' ? `W ${fmt(Math.abs(w))} × H ${fmt(Math.abs(h))} ${unitLabel()}` : `R ${fmt(Math.hypot(w, h))} ${unitLabel()}`);
      app.invalidate('canvas');
    },
    up(app) {
      const d = drag; drag = null; if (!d) return;
      if (internalOn() && !hostAt(app, d.a)) { toast('Internal shape: start inside a piece (or switch “Internal shape” off to make a new piece)', 'warn'); app.invalidate('canvas'); return; }
      const px = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) * app.view.scale;
      if (px < 4) { void dialogFor(app, kind, d.a); return; }
      const c = build(kind, d.a, d.b, d.square);
      if (!c) { toast('Shape too small', 'warn'); return; }
      place(app, kind, c, d.a);
    },
    key(app, e) { if (e.key === 'Escape' && drag) { drag = null; app.invalidate('canvas'); return true; } return false; },
    overlay(app) {
      if (!drag) return '';
      const c = build(drag.kind, drag.a, drag.b, drag.square);
      if (!c) return '';
      const pts = c.points.map(p => app.view.toScreen(p));
      return `<path d="M${pts.map(p => `${fs(p.x)} ${fs(p.y)}`).join('L')}Z" fill="rgba(78,161,255,0.06)" stroke="#4ea1ff" stroke-dasharray="5 3"/>`;
    },
  };
}

export const rectTool = makeShapeTool('rect', 'rect', 'Rectangle', 'R', ICON.rect);
export const circleTool = makeShapeTool('circle', 'circle', 'Circle', 'C', ICON.circle);
export const polygonTool = makeShapeTool('polygon', 'polygon', 'Polygon', undefined, ICON.polygon);
export const roundRectTool = makeShapeTool('roundrect', 'roundrect', 'Rounded rectangle', undefined, ICON.roundrect);
export { dialogFor as shapeDialog };
