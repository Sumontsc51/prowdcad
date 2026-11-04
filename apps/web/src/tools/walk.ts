/**
 * Walk tool (W) — drives the kernel walk state machine (ops/walk).
 *   1. click a sew point on the MOVING piece        (anchor = contact start)
 *   2. click a sew point on the STATIONARY piece
 *   then:  →/↑ or wheel-down = step forward · ←/↓ or wheel-up = step back (Shift ×10, Alt ×0.1)
 *          [ / ] step size ÷2 / ×2 · S step-size dialog · R walk ratio dialog · K toggle skip darts
 *          F flip moving direction · G flip stationary direction · B flip both
 *          N drop notch on both · Shift+N stationary only · Alt+N moving only
 *          T walk to a distance (dialog) · Esc end the walk
 * The moving piece is rendered live through pieceTransform/applyTransform; the HUD shows running
 * lengths and Δ (walkReport). Nothing is written to the document except dropped notches.
 */
import { type WalkState, type Vec, type Piece } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { anchorNear } from '../hitkit';
import { ops } from '../ops-bridge';
import { resolveFor, toWorld, layoutOf } from '../geometry';
import { reportError } from '../commands';
import { showDialog } from '../ui/dialog';
import { fmt, unitLabel } from '../units-ui';
import { fs, screenMarker } from './common';
import { toast } from '../ui/toast';

interface WalkUI {
  moving?: { pieceId: string; anchorId: string };
  state?: WalkState;
  stepMm: number; ratio: number; skipDarts: boolean;
  rev: number;
}
const W: WalkUI = { stepMm: 5, ratio: 1, skipDarts: true, rev: -1 };

function reset(app: App) { W.moving = undefined; W.state = undefined; app.invalidate('canvas', 'status'); }

function hud(): string {
  const st = W.state; if (!st) return '';
  const r = ops.walkReport(st);
  return `Walk · stationary ${fmt(r.stationary)} · moving ${fmt(r.moving)} · Δ ${fmt(r.delta)} ${unitLabel()} · step ${fmt(W.stepMm)} · ratio ${W.ratio} · darts ${W.skipDarts ? 'skipped' : 'walked'}`;
}

function step(app: App, mult: number) {
  if (!W.state) return;
  try {
    if (W.rev !== app.doc.revision()) { W.state = ops.refreshWalk(app.doc, W.state); W.rev = app.doc.revision(); }
    W.state = ops.walkStep(W.state, W.stepMm * mult);
  } catch (err) { reportError(err, 'Walk'); }
  app.status(hud()); app.invalidate('canvas');
}

function start(app: App, stat: { pieceId: string; anchorId: string }) {
  const mv = W.moving!;
  if (mv.pieceId === stat.pieceId) { toast('Pick a point on a DIFFERENT piece for the stationary side', 'warn'); return; }
  try {
    W.state = ops.startWalk(app.doc, {
      movingPieceId: mv.pieceId, movingAnchorId: mv.anchorId, stationaryPieceId: stat.pieceId, stationaryAnchorId: stat.anchorId,
      sizeId: app.sizeOf(app.doc.piece(stat.pieceId)),
      direction: { moving: 'backward', stationary: 'forward' },
      options: { skipDarts: W.skipDarts, step: W.stepMm, walkRatio: W.ratio },
    });
    W.rev = app.doc.revision();
    app.status(hud());
  } catch (err) { reportError(err, 'Walk'); reset(app); }
  app.invalidate('canvas');
}

function drop(app: App, which: 'both' | 'stationary' | 'moving') {
  if (!W.state) return;
  try {
    const r = ops.dropNotch(app.doc, W.state, which);
    W.state = ops.refreshWalk(app.doc, W.state); W.rev = app.doc.revision();
    app.status(`Walk notch dropped (${[r.stationary && 'stationary', r.moving && 'moving'].filter(Boolean).join(' + ')}) · ${hud()}`);
  } catch (err) { reportError(err, 'Drop notch'); }
}

/** World point of a moving-piece local point under the walk transform (walk works in piece-local frames; we place the moving piece relative to the stationary piece's layout). */
function movingToWorld(app: App, stat: Piece, p: Vec): Vec {
  return toWorld(stat, ops.applyTransform(W.state!.transform, p));
}

export const walkTool: Tool = {
  id: 'walk', title: 'Walk pieces', group: 'measure', hotkey: 'W', icon: ICON.walk, cursor: 'crosshair',
  activate(app) { reset(app); },
  deactivate(app) { reset(app); },
  busy: () => !!W.moving,
  hint: () => W.state ? hud() + ' · arrows/wheel step · N notch · F/G/B flip · [ ] step · R ratio · K darts · Esc end'
    : W.moving ? 'Walk: click the start point on the STATIONARY piece' : 'Walk: click the start point on the MOVING piece (sew line)',
  down(app, p) {
    if (W.state) return;
    const h = anchorNear(app, p.w, { contour: 'sew' });
    if (!h) { app.status('Click a point on a sew line'); return; }
    if (!W.moving) { W.moving = { pieceId: h.piece.id, anchorId: h.anchor.id }; app.invalidate('canvas', 'status'); return; }
    start(app, { pieceId: h.piece.id, anchorId: h.anchor.id });
  },
  wheel(app, e) {
    if (!W.state || e.ctrlKey) return false;
    const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    step(app, (e.deltaY > 0 ? 1 : -1) * k);
    return true;
  },
  key(app, e) {
    if (!W.moving && !W.state) return false;
    if (e.key === 'Escape') { reset(app); app.status('Walk ended'); return true; }
    if (!W.state) return false;
    const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': step(app, k); return true;
      case 'ArrowLeft': case 'ArrowDown': step(app, -k); return true;
      case '[': W.stepMm /= 2; app.status(hud()); return true;
      case ']': W.stepMm *= 2; app.status(hud()); return true;
    }
    switch (e.key.toLowerCase()) {
      case 'n': drop(app, e.shiftKey ? 'stationary' : e.altKey ? 'moving' : 'both'); return true;
      case 'f': W.state = ops.flipDirection(W.state, 'moving'); app.status(hud()); app.invalidate('canvas'); return true;
      case 'g': W.state = ops.flipDirection(W.state, 'stationary'); app.status(hud()); app.invalidate('canvas'); return true;
      case 'b': W.state = ops.flipDirection(W.state, 'both'); app.status(hud()); app.invalidate('canvas'); return true;
      case 'k': {
        W.skipDarts = !W.skipDarts;
        const st = W.state; W.state = { ...st, options: { ...st.options, skipDarts: W.skipDarts } };
        W.state = ops.refreshWalk(app.doc, W.state); app.status(hud()); return true;
      }
      case 's': void (async () => {
        const r = await showDialog({ title: 'Walk step', fields: [{ kind: 'length', key: 'v', label: 'Step (arrow / wheel)', value: W.stepMm, min: 0.001 }] });
        if (r) { W.stepMm = r.v as number; app.status(hud()); }
      })(); return true;
      case 'r': void (async () => {
        const r = await showDialog({ title: 'Walk ratio', message: 'Moving advances ratio × the stationary step (ease / gathering).', fields: [{ kind: 'number', key: 'v', label: 'Ratio', value: W.ratio, min: 0.01 }] });
        if (r && W.state) { W.ratio = r.v as number; W.state = ops.setWalkRatio(W.state, W.ratio); app.status(hud()); }
      })(); return true;
      case 't': void (async () => {
        const r = await showDialog({ title: 'Walk to', fields: [{ kind: 'length', key: 'v', label: 'Stationary distance', value: ops.walkReport(W.state!).stationary }] });
        if (r && W.state) { W.state = ops.walkTo(W.state, r.v as number); app.status(hud()); app.invalidate('canvas'); }
      })(); return true;
    }
    return false;
  },
  overlay(app) {
    let s = '';
    if (W.moving && !W.state) {
      const pc = app.doc.style.pieces.find(x => x.id === W.moving!.pieceId);
      const i = pc ? pc.sew.points.findIndex(a => a.id === W.moving!.anchorId) : -1;
      if (pc && i >= 0) s += screenMarker(app.view.toScreen(toWorld(pc, resolveFor(app.doc, pc, app.sizeOf(pc)).sew.anchorPos[i])), 'square', '#ff9f1a', 6);
    }
    const st = W.state; if (!st) return s;
    const stat = app.doc.style.pieces.find(x => x.id === st.stationary.pieceId);
    const mv = app.doc.style.pieces.find(x => x.id === st.moving.pieceId);
    if (!stat || !mv) return s;
    // ghost of the moving piece placed by the walk transform (in the stationary piece's frame)
    const r = resolveFor(app.doc, mv, st.sizeId);
    const path = (pts: Vec[], closed: boolean) => pts.map((q, i) => { const w = app.view.toScreen(movingToWorld(app, stat, q)); return `${i ? 'L' : 'M'}${fs(w.x)} ${fs(w.y)}`; }).join('') + (closed ? 'Z' : '');
    s += `<path d="${path(r.sew.pts, true)}" fill="rgba(255,159,26,0.10)" stroke="#ff9f1a" stroke-width="1.6"/>`;
    for (const ic of r.internals) s += `<path d="${path(ic.pts, ic.closed)}" fill="none" stroke="#ff9f1a" stroke-width="0.9" opacity="0.7"/>`;
    if (r.cut.length > 2) s += `<path d="${path(r.cut, true)}" fill="none" stroke="#ff9f1a" stroke-width="0.8" stroke-dasharray="4 3" opacity="0.7"/>`;
    const rep = ops.walkReport(st);
    const sp = app.view.toScreen(toWorld(stat, rep.stationaryPoint));
    s += screenMarker(sp, 'circle', '#d6309b', 5);
    // walked runs highlighted
    const runPts = (side: typeof st.stationary, frame: (q: Vec) => Vec) => {
      const pts: Vec[] = []; const N = side.r.pts.length; if (!N) return '';
      const cum = side.r.cum; const tot = cum[cum.length - 1] || 1;
      const s0 = ((side.s - side.run * side.dir) % tot + tot) % tot;
      const n = 40;
      for (let i = 0; i <= n; i++) {
        const sv = ((s0 + side.dir * side.run * i / n) % tot + tot) % tot;
        let j = 0; while (j < cum.length - 1 && cum[j + 1] < sv) j++;
        const a = side.r.pts[j % N], b = side.r.pts[(j + 1) % N];
        const t = cum[j + 1] > cum[j] ? (sv - cum[j]) / (cum[j + 1] - cum[j]) : 0;
        pts.push(frame({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
      }
      return pts.map((q, i) => { const w = app.view.toScreen(q); return `${i ? 'L' : 'M'}${fs(w.x)} ${fs(w.y)}`; }).join('');
    };
    try {
      s += `<path d="${runPts(st.stationary, q => toWorld(stat, q))}" fill="none" stroke="#2ecc71" stroke-width="4" opacity="0.55"/>`;
      s += `<path d="${runPts(st.moving, q => movingToWorld(app, stat, q))}" fill="none" stroke="#d6309b" stroke-width="2.4" opacity="0.7"/>`;
    } catch { /* cosmetic */ }
    const L = layoutOf(stat); void L;
    s += `<text x="${fs(sp.x + 10)}" y="${fs(sp.y - 10)}" class="tool-note">Δ ${fmt(rep.delta)} ${unitLabel()}</text>`;
    return s;
  },
};

export function walkActive() { return !!W.state; }
