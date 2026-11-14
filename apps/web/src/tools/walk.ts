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
import { resolveFor, toWorld, toLocal, layoutOf, dirToWorld, dirToLocal } from '../geometry';
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
  /** angle between the two seams at the contact when the walk started (the direction the user gave the piece) */
  delta?: number;
  /** the turn the piece is shown with at the moment (kept when the walk direction changes) */
  lastAng?: number;
}
const W: WalkUI = { stepMm: 5, ratio: 1, skipDarts: true, rev: -1 };

let hoverW: Vec | null = null;
let lastApp: App | null = null;
function reset(app: App) { W.moving = undefined; W.state = undefined; W.delta = undefined; W.lastAng = undefined; hoverW = null; app.cancelPreview(); app.invalidate('canvas', 'status'); }

/** point and unit tangent (contour-forward) of a walk side at its current arc position, piece-local */
function sideAt(side: WalkState['stationary']): { p: Vec; t: Vec } {
  const N = side.r.pts.length, cum = side.r.cum; const tot = cum[cum.length - 1] || 1;
  const sv = ((side.s % tot) + tot) % tot;
  let j = 0; while (j < cum.length - 2 && cum[j + 1] < sv) j++;
  const a = side.r.pts[j % N], b = side.r.pts[(j + 1) % N]; const l = cum[j + 1] - cum[j];
  const u = l > 1e-12 ? (sv - cum[j]) / l : 0; const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { p: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, t: { x: (b.x - a.x) / d, y: (b.y - a.y) / d } };
}
/** point of a side's contour at arc position sv (piece-local) */
function ptAt(side: WalkState['stationary'], sv0: number): Vec {
  const N = side.r.pts.length, cum = side.r.cum; const tot = cum[cum.length - 1] || 1;
  const sv = ((sv0 % tot) + tot) % tot;
  let j = 0; while (j < cum.length - 2 && cum[j + 1] < sv) j++;
  const a = side.r.pts[j % N], b = side.r.pts[(j + 1) % N]; const l = cum[j + 1] - cum[j];
  const u = l > 1e-12 ? (sv - cum[j]) / l : 0;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}
/**
 * Unit direction in which a side is walked from its contact point (piece-local), looking `eps` ahead in the walk
 * direction `dir`. At a corner this is the line the walk goes ALONG, not the line it comes from.
 */
function travelDir(side: WalkState['stationary'], dir: 1 | -1 = side.dir, eps = 0.5): Vec {
  const a = ptAt(side, side.s), b = ptAt(side, side.s + dir * eps); const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
}
/** Direction of the seam around the contact, in the walk direction: from up to 1 cm behind (only what was walked) to 1 cm ahead. */
function matchChord(side: WalkState['stationary'], span = 10): Vec {
  const back = Math.min(span, Math.abs(side.run));
  const a = ptAt(side, side.s - side.dir * back), b = ptAt(side, side.s + side.dir * span); const d = Math.hypot(b.x - a.x, b.y - a.y);
  return d > 1e-9 ? { x: (b.x - a.x) / d, y: (b.y - a.y) / d } : travelDir(side);
}
/** Walk the moving piece along whichever of its two lines at the contact runs WITH the stationary line (as the pieces lie on the sheet). */
function matchMovingDir(app: App, st: WalkState): WalkState {
  const stat = app.doc.piece(st.stationary.pieceId), mv = app.doc.piece(st.moving.pieceId);
  const ts = dirToWorld(stat, travelDir(st.stationary, st.stationary.dir, 5));
  const score = (d: 1 | -1) => { const t = dirToWorld(mv, travelDir(st.moving, d, 5)); return t.x * ts.x + t.y * ts.y; };
  return score((-st.moving.dir) as 1 | -1) > score(st.moving.dir) ? ops.flipDirection(st, 'moving') : st;
}
const rot = (v: Vec, a: number): Vec => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
/**
 * Where the moving piece is shown (world): its contact point lies on the stationary contact point and it is turned
 * just enough for the two seams to lie on each other around the contact (1 cm ahead, 1 cm behind). Of the two ways
 * to do that, the walk direction is chosen that needs the smaller turn from the direction the user gave the piece
 * (matchMovingDir), so a piece the user rotated or flipped to face the seam stays that way round.
 */
function placement(app: App): { ang: number; o: Vec; toWorld: (q: Vec) => Vec; toLocal: (w: Vec) => Vec } | null {
  const st = W.state; if (!st) return null;
  const stat = app.doc.style.pieces.find(x => x.id === st.stationary.pieceId), mv = app.doc.style.pieces.find(x => x.id === st.moving.pieceId);
  if (!stat || !mv) return null;
  const m = sideAt(st.moving), c = sideAt(st.stationary);
  const angOf = (v: Vec) => Math.atan2(v.y, v.x);
  // The two seams are laid on each other AT the contact: the stretch of the moving seam from 1 cm behind the
  // contact to 1 cm ahead of it is turned onto the same stretch of the stationary seam (as TUKA does). "Behind"
  // only reaches back over what was already walked, so at the start it is the 1 cm ahead that is matched.
  const tm = dirToWorld(mv, matchChord(st.moving)), ts = dirToWorld(stat, matchChord(st.stationary));
  const ang = angOf(ts) - angOf(tm);
  W.lastAng = ang;
  const cw = toWorld(stat, c.p);
  const lin = (v: Vec) => rot(dirToWorld(mv, v), ang);
  const mo = lin(m.p); const o = { x: cw.x - mo.x, y: cw.y - mo.y };
  return { ang, o, toWorld: q => { const v = lin(q); return { x: o.x + v.x, y: o.y + v.y }; }, toLocal: w => dirToLocal(mv, rot({ x: w.x - o.x, y: w.y - o.y }, -ang)) };
}
/**
 * Show the moving piece ITSELF at its walked position (seam allowance, notches, labels and all), as a live
 * preview: nothing is written to the document, and the piece is back in its own place when the walk ends.
 */
function showMoving(app: App) {
  lastApp = app;
  const st = W.state; const pl = placement(app); if (!st || !pl) return;
  const mv = app.doc.piece(st.moving.pieceId); const L = layoutOf(mv);
  app.preview.delete(mv.id);
  app.beginPreview(mv.id).layout = { ...L, x: pl.o.x, y: pl.o.y, angleDeg: (L.angleDeg ?? 0) + pl.ang * 180 / Math.PI };
  app.invalidate('canvas');
}
/**
 * End the walk and leave the moving piece where the walk put it, so the two pieces can be matched or adjusted
 * there. Only its place on the sheet changes (one undo step; Ctrl+Z puts it back); the pattern is not touched.
 */
function finish(app: App): boolean {
  const st = W.state; let kept = false;
  if (st) {
    const pv = app.preview.get(st.moving.pieceId); const mv = app.doc.style.pieces.find(x => x.id === st.moving.pieceId);
    if (pv?.layout && mv && !mv.locked && JSON.stringify(pv.layout) !== JSON.stringify(layoutOf(mv))) {
      const L = { ...pv.layout };
      app.preview.clear();
      try { app.doc.transact('Walk: place piece', () => { app.doc.piece(mv.id).layout = L; }); kept = true; } catch (err) { reportError(err, 'Walk'); }
    }
  }
  reset(app);
  return kept;
}
/** arc distance from the walk start to the point of a side's contour nearest to local point `l` (in the walk direction), and how far `l` is from it */
function alongSide(side: WalkState['stationary'], l: Vec): { dist: number; off: number; tot: number } {
  const N = side.r.pts.length; const cum = side.r.cum; const tot = cum[cum.length - 1] || 1;
  let bs = 0, bd = Infinity;
  for (let j = 0; j < N; j++) {
    const a = side.r.pts[j], b = side.r.pts[(j + 1) % N]; const ab = { x: b.x - a.x, y: b.y - a.y }; const l2 = ab.x * ab.x + ab.y * ab.y;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((l.x - a.x) * ab.x + (l.y - a.y) * ab.y) / l2));
    const d = Math.hypot(a.x + ab.x * t - l.x, a.y + ab.y * t - l.y);
    if (d < bd) { bd = d; bs = cum[j] + t * Math.sqrt(l2); }
  }
  const s0 = side.s - side.run * side.dir;
  return { dist: (((bs - s0) * side.dir) % tot + tot) % tot, off: bd, tot };
}

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
  showMoving(app);
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
    // walk the way the pieces lie: the moving seam is followed in the direction that runs with the stationary one
    // of the four ways to pair the lines at the two points, start with the pair that lies closest together on the
    // sheet (the smallest turn of the piece); a click on a seam then says which way to walk
    {
      const fit = (st: WalkState) => { const stat = app.doc.piece(st.stationary.pieceId), mvp = app.doc.piece(st.moving.pieceId); const a = dirToWorld(stat, travelDir(st.stationary, st.stationary.dir, 5)), b = dirToWorld(mvp, travelDir(st.moving, st.moving.dir, 5)); return a.x * b.x + a.y * b.y; };
      const a = matchMovingDir(app, W.state), b = matchMovingDir(app, ops.flipDirection(W.state, 'stationary'));
      W.state = fit(b) > fit(a) + 1e-9 ? b : a;
    }
    W.delta = undefined; W.lastAng = undefined;
    showMoving(app);
    app.status(`Placed on the point · now click along the seam to walk there · ${hud()}`);
  } catch (err) { reportError(err, 'Walk'); reset(app); }
  app.invalidate('canvas');
}

function drop(app: App, which: 'both' | 'stationary' | 'moving') {
  if (!W.state) return;
  try {
    const r = ops.dropNotch(app.doc, W.state, which);
    W.state = ops.refreshWalk(app.doc, W.state); W.rev = app.doc.revision();
    showMoving(app);
    app.status(`Walk notch dropped (${[r.stationary && 'stationary', r.moving && 'moving'].filter(Boolean).join(' + ')}) · ${hud()}`);
  } catch (err) { reportError(err, 'Drop notch'); }
}

/** World point of a moving-piece local point under the walk transform (walk works in piece-local frames; we place the moving piece relative to the stationary piece's layout). */
function movingToWorld(app: App, _stat: Piece, p: Vec): Vec {
  const pl = placement(app);
  return pl ? pl.toWorld(p) : p;
}

export const walkTool: Tool = {
  id: 'walk', title: 'Walk pieces', group: 'walk', hotkey: 'W', icon: ICON.walk, cursor: 'crosshair',
  activate(app) { reset(app); },
  deactivate(app) { finish(app); },
  busy: () => !!W.moving,
  hint: () => W.state ? hud() + ' · click the seam = walk to there · arrows/wheel step · N notch · F/G/B flip · [ ] step · R ratio · K darts · Esc = end (the piece stays here)'
    : W.moving ? 'Walk: click the point on the second piece (it stays): the first piece is placed onto it' : 'Walk: click a point on the first piece (the one that walks)',
  down(app, p) {
    if (W.state) {
      // click on a seam (the stationary one, or the moving piece's own): the moving piece walks up to the click
      const st = W.state; const stat = app.doc.style.pieces.find(x => x.id === st.stationary.pieceId); if (!stat) return;
      if (st.stationary.r.pts.length < 2 || st.moving.r.pts.length < 2) return;
      const l = toLocal(stat, p.w);
      const a = alongSide(st.stationary, l);
      // the moving piece is shown where the walk put it: bring the click back into its own frame
      const pl = placement(app);
      const b = pl ? alongSide(st.moving, pl.toLocal(p.w)) : { dist: 0, off: Infinity, tot: 1 };
      const useMoving = b.off < a.off;
      const hit = useMoving ? b : a;
      if (hit.off * app.view.scale > 25) { app.status('Walk: click on (or near) a seam line to walk there · arrows / wheel step · Esc = end'); return; }
      const ratio = st.options.walkRatio || 1;
      let dist = useMoving ? hit.dist / ratio : hit.dist; const tot = useMoving ? hit.tot / ratio : hit.tot;
      try {
        let cur = st;
        // a fresh walk goes the shorter way round to the click
        if (Math.abs(st.stationary.run) < 1e-6) {
          if (useMoving) {
            // clicked on the moving piece's own line: that is the line to walk, the stationary side follows it
            if (dist > tot / 2) { cur = ops.flipDirection(cur, 'moving'); dist = tot - dist; }
            const mvp = app.doc.piece(cur.moving.pieceId), stp = app.doc.piece(cur.stationary.pieceId);
            const tmv = dirToWorld(mvp, travelDir(cur.moving, cur.moving.dir, 5));
            const sc = (d: 1 | -1) => { const t = dirToWorld(stp, travelDir(cur.stationary, d, 5)); return t.x * tmv.x + t.y * tmv.y; };
            if (sc((-cur.stationary.dir) as 1 | -1) > sc(cur.stationary.dir)) cur = ops.flipDirection(cur, 'stationary');
          } else {
            // clicked on the stationary line: walk towards the click, along the moving line that runs with it
            if (dist > tot / 2) { cur = ops.flipDirection(cur, 'stationary'); dist = tot - dist; }
            cur = matchMovingDir(app, cur);
          }
          W.delta = undefined; W.lastAng = undefined; // nothing walked yet: the piece keeps the direction the user set
        }
        W.state = ops.walkTo(cur, dist); showMoving(app); app.status(`Walked to the click · ${hud()}`);
      } catch (err) { reportError(err, 'Walk'); }
      app.invalidate('canvas'); return;
    }
    const h = anchorNear(app, p.w, { contour: 'sew' });
    if (!h) { app.status('Click a point on a sew line'); return; }
    if (!W.moving) { W.moving = { pieceId: h.piece.id, anchorId: h.anchor.id }; app.invalidate('canvas', 'status'); return; }
    start(app, { pieceId: h.piece.id, anchorId: h.anchor.id });
  },
  move(app, p) { if (W.moving && !W.state) { const h = anchorNear(app, p.w, { contour: 'sew' }); hoverW = h ? h.world : p.w; app.invalidate('canvas'); } },
  wheel(app, e) {
    if (!W.state || e.ctrlKey) return false;
    const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    step(app, (e.deltaY > 0 ? 1 : -1) * k);
    return true;
  },
  key(app, e) {
    if (!W.moving && !W.state) return false;
    if (e.key === 'Escape') { const kept = finish(app); app.status(kept ? 'Walk ended · the piece stays at its last walk position, so you can match or adjust there (Ctrl+Z puts it back)' : 'Walk ended'); return true; }
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
      case 'f': W.state = ops.flipDirection(W.state, 'moving'); W.delta = undefined; showMoving(app); app.status(hud()); app.invalidate('canvas'); return true;
      case 'g': W.state = ops.flipDirection(W.state, 'stationary'); W.delta = undefined; showMoving(app); app.status(hud()); app.invalidate('canvas'); return true;
      case 'b': W.state = ops.flipDirection(W.state, 'both'); W.delta = undefined; showMoving(app); app.status(hud()); app.invalidate('canvas'); return true;
      case 'k': {
        W.skipDarts = !W.skipDarts;
        const st = W.state; W.state = { ...st, options: { ...st.options, skipDarts: W.skipDarts } };
        W.state = ops.refreshWalk(app.doc, W.state); showMoving(app); app.status(hud()); return true;
      }
      case 's': void (async () => {
        const r = await showDialog({ title: 'Walk step', fields: [{ kind: 'length', key: 'v', label: 'Step (arrow / wheel)', value: W.stepMm, min: 0.001 }] });
        if (r) { W.stepMm = r.v as number; app.status(hud()); }
      })(); return true;
      case 'r': void (async () => {
        const r = await showDialog({ title: 'Walk ratio', message: 'Moving advances ratio × the stationary step (ease / gathering).', fields: [{ kind: 'number', key: 'v', label: 'Ratio', value: W.ratio, min: 0.01 }] });
        if (r && W.state) { W.ratio = r.v as number; W.state = ops.setWalkRatio(W.state, W.ratio); showMoving(app); app.status(hud()); }
      })(); return true;
      case 't': void (async () => {
        const r = await showDialog({ title: 'Walk to', fields: [{ kind: 'length', key: 'v', label: 'Stationary distance', value: ops.walkReport(W.state!).stationary }] });
        if (r && W.state) { W.state = ops.walkTo(W.state, r.v as number); showMoving(app); app.status(hud()); app.invalidate('canvas'); }
      })(); return true;
    }
    return false;
  },
  overlay(app) {
    let s = '';
    if (W.moving && !W.state) {
      const pc = app.doc.style.pieces.find(x => x.id === W.moving!.pieceId);
      const i = pc ? pc.sew.points.findIndex(a => a.id === W.moving!.anchorId) : -1;
      if (pc && i >= 0) {
        const a = app.view.toScreen(toWorld(pc, resolveFor(app.doc, pc, app.sizeOf(pc)).sew.anchorPos[i]));
        s += screenMarker(a, 'square', '#ff9f1a', 6);
        // rubber band to the cursor: where this point will be placed
        if (hoverW) { const b = app.view.toScreen(hoverW); s += `<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="#e03131" stroke-width="1.4" data-walk-band="1"/>`; }
      }
    }
    const st = W.state; if (!st) return s;
    const stat = app.doc.style.pieces.find(x => x.id === st.stationary.pieceId);
    const mv = app.doc.style.pieces.find(x => x.id === st.moving.pieceId);
    if (!stat || !mv) return s;
    // ghost of the moving piece placed by the walk transform (in the stationary piece's frame)
    const r = resolveFor(app.doc, mv, st.sizeId);
    const path = (pts: Vec[], closed: boolean) => pts.map((q, i) => { const w = app.view.toScreen(movingToWorld(app, stat, q)); return `${i ? 'L' : 'M'}${fs(w.x)} ${fs(w.y)}`; }).join('') + (closed ? 'Z' : '');
    // the piece itself is drawn at its walked position (live preview); this only tints its outline
    s += `<path d="${path(r.sew.pts, true)}" fill="rgba(255,159,26,0.06)" stroke="#ff9f1a" stroke-width="1.2" data-walk-ghost="1"/>`;
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
/** largest distance between the two seams 1 cm behind and 1 cm ahead of the contact, on the sheet (null = no walk). For tests. */
export function walkGap(): number | null {
  const st = W.state; const app = lastApp; if (!st || !app) return null;
  const pl = placement(app); const stat = app.doc.style.pieces.find(x => x.id === st.stationary.pieceId); if (!pl || !stat) return null;
  let g = 0;
  for (const k of [-10, 10]) { const a = pl.toWorld(ptAt(st.moving, st.moving.s + st.moving.dir * k)), b = toWorld(stat, ptAt(st.stationary, st.stationary.s + st.stationary.dir * k)); g = Math.max(g, Math.hypot(a.x - b.x, a.y - b.y)); }
  return g;
}
/** distance walked on the stationary piece (null = no walk) */
/** contact point on the moving piece, piece-local (null = no walk) */
export function walkMovingPoint(): Vec | null { return W.state ? ptAt(W.state.moving, W.state.moving.s) : null; }
export function walkRun(): number | null { return W.state ? ops.walkReport(W.state).stationary : null; }
