/**
 * Canvas pick sessions: commands that need clicks on the sheet (segments, anchors, pieces, free
 * points) `await pick(app, {...})`. A hidden tool takes over the canvas until the pick resolves,
 * then the previous tool is restored. Esc → null (cancel), Enter → 'done' (when `allowDone`),
 * right-click → 'done' too when allowed. A command chains several picks for multi-click flows.
 *
 *   const a = await pick(app, { kind: 'anchor', prompt: 'Click the first grade point', gradeOnly: true });
 *   if (!a || a === 'done') return;
 */
import type { Vec, Piece, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { anchorNear, contourNear, pieceUnder, drillNear, type AnchorHit, type ContourHit, type DrillHit, type ContourFilter } from '../hitkit';
import { snapPoint } from '../canvas/snap';
import { screenMarker } from './common';
import { DoubleClick } from '../ui/dom';
import { liveNear, type LiveHit, type LiveKind } from '../live';

export type PickKind = 'anchor' | 'contour' | 'piece' | 'point' | 'drill' | 'anchorOrDrill' | 'live';
export type PickResult =
  | { kind: 'anchor'; hit: AnchorHit; w: Vec; e: MouseEvent; dbl: boolean }
  | { kind: 'contour'; hit: ContourHit; w: Vec; e: MouseEvent; dbl: boolean }
  | { kind: 'piece'; piece: Piece; w: Vec; e: MouseEvent; dbl: boolean }
  | { kind: 'point'; w: Vec; snapped: boolean; e: MouseEvent; dbl: boolean }
  | { kind: 'drill'; hit: DrillHit; w: Vec; e: MouseEvent; dbl: boolean }
  | { kind: 'live'; hit: LiveHit; w: Vec; e: MouseEvent; dbl: boolean };

export interface PickOptions {
  kind: PickKind;
  prompt: string;
  gradeOnly?: boolean;
  contour?: ContourFilter;
  pieceId?: Id;
  excludePieceId?: Id;
  contourId?: Id;
  /** kind 'live': restrict to darts / pleats / fullness records */
  liveKind?: LiveKind;
  /** Enter / right-click finishes a multi-pick with 'done' */
  allowDone?: boolean;
  /** extra overlay (screen-space SVG) drawn while picking (hover point given) */
  overlay?: (app: App, hover: Vec | null) => string;
  /** extra key handling while picking; return true when consumed */
  key?: (app: App, e: KeyboardEvent) => boolean;
  /** wheel handling while picking */
  wheel?: (app: App, e: WheelEvent) => boolean;
  cursor?: string;
}

interface Session { opt: PickOptions; resolve: (r: PickResult | 'done' | null) => void; prevTool: string; hover: Vec | null; hoverMark: string }
let S: Session | null = null;
const dbl = new DoubleClick();

function hitFor(app: App, w: Vec, e: MouseEvent, o: PickOptions, isDbl: boolean): PickResult | null {
  const base = { w, e, dbl: isDbl };
  const ho = { gradeOnly: o.gradeOnly, contour: o.contour, pieceId: o.pieceId, contourId: o.contourId, excludePieceId: o.excludePieceId };
  switch (o.kind) {
    case 'anchor': { const h = anchorNear(app, w, ho); return h ? { kind: 'anchor', hit: h, ...base } : null; }
    case 'contour': { const h = contourNear(app, w, ho); return h ? { kind: 'contour', hit: h, ...base } : null; }
    case 'piece': { const p = o.pieceId ? app.doc.style.pieces.find(x => x.id === o.pieceId) ?? null : pieceUnder(app, w); return p && p.id !== o.excludePieceId ? { kind: 'piece', piece: p, ...base } : null; }
    case 'drill': { const h = drillNear(app, w); return h ? { kind: 'drill', hit: h, ...base } : null; }
    case 'anchorOrDrill': {
      const d = drillNear(app, w); if (d) return { kind: 'drill', hit: d, ...base };
      const h = anchorNear(app, w, ho); return h ? { kind: 'anchor', hit: h, ...base } : null;
    }
    case 'live': { const h = liveNear(app, w, { kind: o.liveKind, pieceId: o.pieceId }); return h ? { kind: 'live', hit: h, ...base } : null; }
    case 'point': { const s = snapPoint(app, w, { noGrid: false }); return { kind: 'point', w: s.p, snapped: s.kind !== 'none', e, dbl: isDbl }; }
  }
}

function hoverMarkFor(app: App, w: Vec, o: PickOptions): string {
  const r = hitFor(app, w, new MouseEvent('move'), o, false);
  if (!r) return '';
  const pt = r.kind === 'anchor' || r.kind === 'contour' || r.kind === 'drill' || r.kind === 'live' ? r.hit.world : r.kind === 'point' ? r.w : null;
  return pt ? screenMarker(app.view.toScreen(pt), r.kind === 'anchor' ? 'square' : 'ring', '#ff9f1a', r.kind === 'anchor' ? 5 : 6) : '';
}

function finish(app: App, r: PickResult | 'done' | null) {
  const s = S; if (!s) return;
  S = null;
  app.setTool(s.prevTool);
  app.status('');
  s.resolve(r);
}

export const pickTool: Tool = {
  id: 'pick', title: 'Pick', group: 'pick', icon: ICON.pick, cursor: 'crosshair', hidden: true,
  busy: () => !!S,
  hint: () => S ? `${S.opt.prompt}${S.opt.allowDone ? ' · Enter = done' : ''} · Esc = cancel` : '',
  deactivate() { /* switching tools away from a live pick cancels it (resolve null) */ if (S) { const s = S; S = null; s.resolve(null); } },
  down(app, p) {
    if (!S) return;
    const isDbl = dbl.hit(p.s.x, p.s.y, 'pick');
    const r = hitFor(app, p.w, p.e as MouseEvent, S.opt, isDbl);
    if (!r) { app.status(`Nothing to pick here — ${S.opt.prompt}`); return; }
    finish(app, r);
  },
  move(app, p) { if (!S) return; S.hover = p.w; S.hoverMark = hoverMarkFor(app, p.w, S.opt); app.invalidate('canvas'); },
  context(app) { if (S?.opt.allowDone) { finish(app, 'done'); return true; } return !!S; },
  key(app, e) {
    if (!S) return false;
    if (S.opt.key?.(app, e)) { app.invalidate('canvas', 'status'); return true; }
    if (e.key === 'Escape') { finish(app, null); return true; }
    if (e.key === 'Enter' && S.opt.allowDone) { finish(app, 'done'); return true; }
    return false;
  },
  wheel(app, e) { return !!S?.opt.wheel?.(app, e); },
  overlay(app) { if (!S) return ''; return (S.opt.overlay?.(app, S.hover) ?? '') + S.hoverMark; },
};

/** Start a pick session. Resolves with the pick, 'done' (Enter/right-click when allowed) or null (Esc / tool switch). */
export function pick(app: App, opt: PickOptions): Promise<PickResult | 'done' | null> {
  if (S) { const s = S; S = null; s.resolve(null); }
  return new Promise(resolve => {
    const prev = app.tool?.id === 'pick' ? 'select' : app.tool?.id ?? 'select';
    S = { opt, resolve, prevTool: prev, hover: null, hoverMark: '' };
    app.tool?.deactivate?.(app);
    app.tool = pickTool;
    pickTool.cursor = opt.cursor ?? 'crosshair';
    app.status(opt.prompt);
    app.invalidate();
  });
}
export function picking(): boolean { return !!S; }
