/**
 * Marks tools.
 * Notch (N): click on a sew line or internal line → notch dialog: placement (anchor / from previous
 *            grade point / from next / proportional %), type, depth, width, angle, draw/cut.
 *            Clicking an existing notch opens the notch grid editor for it.
 * Drill (D): click inside a piece → dialog (drill / button / buttonhole, Ø, draw/cut).
 *            Clicking an existing drill → edit / duplicate with offset / delete.
 * Text (T):  click inside a piece → text dialog; clicking an existing text → edit / delete.
 */
import type { NotchType, NotchPlacement, Vec, Piece, Drill, TextAnnotation } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { ops } from '../ops-bridge';
import { toLocal, toWorld } from '../geometry';
import { toast } from '../ui/toast';
import { reportError } from '../commands';
import { contourNear, drillNear, pieceUnder } from '../hitkit';
import { rememberedDialog, showDialog } from '../ui/dialog';
import { fmt, unitLabel } from '../units-ui';
import { screenMarker } from './common';
import { openNotchGrid } from '../panels/notchgrid';

export let notchType: NotchType = 'slit';
export function setNotchType(t: NotchType) { notchType = t; }
export let drillDiameter = 3;
export function setDrillDiameter(d: number) { drillDiameter = d; }

const NOTCH_TYPES: NotchType[] = ['slit', 'T', 'V', 'U', 'castle'];
let hover: Vec | null = null;

function notchNear(app: App, w: Vec, tolPx = 8): { piece: Piece; notchId: string } | null {
  for (const p of app.doc.style.pieces) {
    if (app.hiddenPieces.has(p.id) || !p.notches.length) continue;
    let rn; try { rn = ops.resolveNotches(app.doc, p, app.sizeOf(p)); } catch { continue; }
    for (const n of rn) {
      const q = toWorld(p, n.pos);
      if (Math.hypot(q.x - w.x, q.y - w.y) * app.view.scale <= tolPx) return { piece: p, notchId: n.notchId };
    }
  }
  return null;
}

async function notchAt(app: App, w: Vec) {
  const hit = contourNear(app, w, { tolPx: 12 });
  if (!hit) { toast('Click on a sew line or internal line', 'warn'); return; }
  if (hit.piece.locked) { toast('Piece is locked', 'warn'); return; }
  const doc = app.doc, p = hit.piece;
  const line = doc.sizeLine(p);
  const setup = app.style.settings.notchSetup;
  // nearest anchor (for 'anchor' placement) within 10 px
  let nearAnchor: { id: string; d: number } | null = null;
  hit.contour.points.forEach((a, i) => {
    const q = toWorld(p, hit.rc.anchorPos[i]); const d = Math.hypot(q.x - w.x, q.y - w.y) * app.view.scale;
    if (d <= 10 && (!nearAnchor || d < nearAnchor.d)) nearAnchor = { id: a.id, d };
  });
  let prev: NotchPlacement, next: NotchPlacement, prop: NotchPlacement;
  try {
    prev = ops.placementAt(doc, p, hit.contour.id, hit.sBase, 'fromPrev');
    next = ops.placementAt(doc, p, hit.contour.id, hit.sBase, 'fromNext');
    prop = ops.placementAt(doc, p, hit.contour.id, hit.sBase, 'proportional');
  } catch (err) { reportError(err, 'Notch'); return; }
  const baseOf = (pl: NotchPlacement) => pl.kind === 'fromPrev' || pl.kind === 'fromNext' ? pl.dist[line.baseSizeId] ?? Object.values(pl.dist)[0] ?? 0 : 0;
  const na = nearAnchor as { id: string; d: number } | null;
  const kinds = [
    ...(na ? [{ value: 'anchor', label: 'On the point (anchored)' }] : []),
    { value: 'fromPrev', label: `From previous grade point (${fmt(baseOf(prev))} ${unitLabel()})` },
    { value: 'fromNext', label: `From next grade point (${fmt(baseOf(next))} ${unitLabel()})` },
    { value: 'proportional', label: `Proportional (${(prop.kind === 'proportional' ? prop.pct : 0).toFixed(2)} %)` },
  ];
  const r = await rememberedDialog('notch.add', {
    title: `Notch — ${p.name}`, fields: [
      { kind: 'radio', key: 'kind', label: 'Placement', value: na ? 'anchor' : 'fromPrev', options: kinds },
      { kind: 'length', key: '_dp', label: 'Distance from previous', value: baseOf(prev), min: 0 },
      { kind: 'length', key: '_dn', label: 'Distance from next', value: baseOf(next), min: 0, hint: 'Base size; the same distance is used in every size (edit per size in the notch grid).' },
      { kind: 'number', key: '_pct', label: 'Percent of segment', value: prop.kind === 'proportional' ? Math.round(prop.pct * 1000) / 1000 : 50, min: 0, max: 100, suffix: '%' },
      { kind: 'select', key: 'type', label: 'Type', value: notchType, options: NOTCH_TYPES.map(t => ({ value: t, label: t })) },
      { kind: 'length', key: 'depth', label: 'Depth', value: setup[notchType].depth, min: 0.01 },
      { kind: 'length', key: 'width', label: 'Width', value: setup[notchType].width, min: 0 },
      { kind: 'number', key: 'angle', label: 'Angle to normal', value: 0, suffix: '°' },
      { kind: 'radio', key: 'mode', label: 'Mode', value: setup[notchType].mode, options: [{ value: 'cut', label: 'Cut' }, { value: 'draw', label: 'Draw' }] },
    ],
  });
  if (!r) return;
  const kind = String(r.kind);
  let placement: NotchPlacement;
  if (kind === 'anchor' && na) placement = { kind: 'anchor', anchorId: na.id };
  else if (kind === 'proportional') placement = prop.kind === 'proportional' ? { ...prop, pct: r._pct as number } : prop;
  else {
    const pl = (kind === 'fromNext' ? next : prev) as Extract<NotchPlacement, { kind: 'fromPrev' | 'fromNext' }>;
    const typed = (kind === 'fromNext' ? r._dn : r._dp) as number;
    placement = Math.abs(typed - baseOf(pl)) > 1e-9 ? { ...pl, dist: Object.fromEntries(Object.keys(pl.dist).map(k => [k, typed])) } : pl;
  }
  setNotchType(r.type as NotchType);
  try {
    ops.addNotch(doc, p, { contourId: hit.contour.id, placement, type: r.type as NotchType, depth: r.depth as number, width: r.width as number, angleDeg: r.angle as number, mode: r.mode as 'draw' | 'cut', source: 'manual' });
    app.status(`Notch (${r.type}, ${kind}) added to ${p.name}`);
  } catch (err) { reportError(err, 'Notch'); }
}

export const notchTool: Tool = {
  id: 'notch', title: 'Notch', group: 'marks', hotkey: 'N', icon: ICON.notch, cursor: 'crosshair',
  hint: () => `Notch (${notchType}): click a sew / internal line · click an existing notch = grid editor`,
  deactivate(app) { hover = null; app.invalidate('canvas'); },
  down(app, p) {
    const ex = notchNear(app, p.w);
    if (ex) { app.selectPiece(ex.piece.id); openNotchGrid(app, ex.piece.id, ex.notchId); return; }
    void notchAt(app, p.w);
  },
  move(app, p) { const h = contourNear(app, p.w, { tolPx: 12 }); hover = h?.world ?? null; app.invalidate('canvas'); },
  overlay(app) { return hover ? screenMarker(app.view.toScreen(hover), 'ring', '#c0392b', 6) : ''; },
};

// ───────────── drills / buttons ─────────────

async function drillDialog(app: App, title: string, d?: Drill) {
  return rememberedDialog(d ? 'drill.edit' : 'drill.add', {
    title, fields: [
      { kind: 'radio', key: 'kind', label: 'Kind', value: d?.kind ?? 'drill', options: [{ value: 'drill', label: 'Drill hole' }, { value: 'button', label: 'Button' }, { value: 'buttonhole', label: 'Buttonhole' }] },
      { kind: 'length', key: 'dia', label: 'Diameter / length', value: d?.diameter ?? drillDiameter, min: 0.1 },
      { kind: 'radio', key: 'mode', label: 'Mode', value: d?.mode ?? 'cut', options: [{ value: 'cut', label: 'Cut' }, { value: 'draw', label: 'Draw' }] },
      { kind: 'text', key: 'name', label: 'Name', value: d?.name ?? '' },
    ],
    buttons: d ? [{ id: 'dup', label: 'Duplicate…' }, { id: 'del', label: 'Delete', danger: true }] : undefined,
  });
}

export async function duplicateDrillDialog(app: App, piece: Piece, drillId: string) {
  const r = await rememberedDialog('drill.dup', {
    title: 'Duplicate with offset', fields: [
      { kind: 'number', key: 'n', label: 'Copies', value: 3, min: 1, max: 500 },
      { kind: 'length', key: 'dx', label: 'Offset X', value: 0 },
      { kind: 'length', key: 'dy', label: 'Offset Y', value: -20 },
    ],
  });
  if (r) ops.duplicateWithOffset(app.doc, piece, drillId, Math.round(r.n as number), r.dx as number, r.dy as number);
}

export const drillTool: Tool = {
  id: 'drill', title: 'Drill / button', group: 'marks', hotkey: 'D', icon: ICON.drill, cursor: 'crosshair',
  hint: () => 'Drill/Button: click inside a piece · click an existing drill = edit / duplicate / delete',
  down(app: App, p) {
    const ex = drillNear(app, p.w, 6);
    if (ex) {
      void (async () => {
        const r = await drillDialog(app, `Drill — ${ex.piece.name}`, ex.drill);
        if (!r) return;
        try {
          if (r.__button === 'del') { ops.deleteDrill(app.doc, ex.piece, ex.drill.id); return; }
          if (r.__button === 'dup') { await duplicateDrillDialog(app, ex.piece, ex.drill.id); return; }
          ops.updateDrill(app.doc, ex.piece, ex.drill.id, { kind: r.kind as Drill['kind'], diameter: r.dia as number, mode: r.mode as Drill['mode'], name: String(r.name) || undefined });
        } catch (err) { reportError(err, 'Drill'); }
      })();
      return;
    }
    const piece = pieceUnder(app, p.w);
    if (!piece) { toast('Click inside a piece', 'warn'); return; }
    if (piece.locked) { toast('Piece is locked', 'warn'); return; }
    const at = toLocal(piece, p.w);
    void (async () => {
      const r = await drillDialog(app, `Drill — ${piece.name}`);
      if (!r) return;
      setDrillDiameter(r.dia as number);
      try { ops.addDrill(app.doc, piece, { x: at.x, y: at.y, diameter: r.dia as number, kind: r.kind as Drill['kind'], mode: r.mode as Drill['mode'], name: String(r.name) || undefined }); app.status('Drill added'); }
      catch (err) { reportError(err, 'Drill'); }
    })();
  },
};

// ───────────── text ─────────────

function textNear(app: App, w: Vec): { piece: Piece; t: TextAnnotation } | null {
  for (const p of app.doc.style.pieces) {
    for (const t of p.texts) {
      let tp: Vec = t; try { tp = ops.textPosition(app.doc, p, t, app.sizeOf(p)); } catch { /* base */ }
      const q = toWorld(p, tp);
      const halfW = Math.max(t.size * t.text.length * 0.3, t.size), halfH = t.size * 0.7;
      if (Math.abs(q.x - w.x) <= halfW && Math.abs(q.y - w.y) <= halfH) return { piece: p, t };
    }
  }
  return null;
}

export const textTool: Tool = {
  id: 'text', title: 'Text', group: 'marks', hotkey: 'T', icon: ICON.text, cursor: 'text',
  hint: () => 'Text: click inside a piece · click an existing text = edit / delete',
  down(app, p) {
    const ex = textNear(app, p.w);
    if (ex) {
      void (async () => {
        const r = await showDialog({ title: 'Edit text', fields: [
          { kind: 'text', key: 'text', label: 'Text', value: ex.t.text },
          { kind: 'length', key: 'size', label: 'Height', value: ex.t.size, min: 0.1 },
          { kind: 'number', key: 'ang', label: 'Angle', value: ex.t.angleDeg, suffix: '°' },
        ], buttons: [{ id: 'del', label: 'Delete', danger: true }] });
        if (!r) return;
        try {
          if (r.__button === 'del') { ops.deleteText(app.doc, ex.piece, ex.t.id); return; }
          app.doc.transact('Edit text', () => {
            ops.editText(app.doc, ex.piece, ex.t.id, String(r.text));
            const live = app.doc.piece(ex.piece.id).texts.find(x => x.id === ex.t.id)!;
            const lo = app.style.settings.textMinMm, hi = app.style.settings.textMaxMm;
            live.size = Math.min(hi, Math.max(lo, r.size as number)); live.angleDeg = r.ang as number;
          });
        } catch (err) { reportError(err, 'Text'); }
      })();
      return;
    }
    const piece = pieceUnder(app, p.w);
    if (!piece) { toast('Click inside a piece', 'warn'); return; }
    const at = toLocal(piece, p.w);
    void (async () => {
      const r = await rememberedDialog('text.add', { title: `Text — ${piece.name}`, fields: [
        { kind: 'text', key: 'text', label: 'Text', value: '' },
        { kind: 'length', key: 'size', label: 'Height', value: 8, min: 0.1, hint: `Clamped to ${fmt(app.style.settings.textMinMm)}–${fmt(app.style.settings.textMaxMm)} ${unitLabel()}` },
        { kind: 'number', key: 'ang', label: 'Angle', value: 0, suffix: '°' },
      ], validate: v => String(v.text).trim() ? null : 'Text is empty' });
      if (!r) return;
      try { ops.addText(app.doc, piece, { x: at.x, y: at.y, text: String(r.text), size: r.size as number, angleDeg: r.ang as number }); }
      catch (err) { reportError(err, 'Text'); }
    })();
  },
};
