/**
 * Internal line / polygon pen (I). Draws an internal Contour inside a host piece.
 *   start            must be inside a piece (or snapped onto its outline)
 *   outline snap     ring shown when within ~10 px of the host's sew line; anchors snap at 8 px
 *   Ctrl             curve (smooth) point
 *   Shift            H / V / 45° from the previous point
 *   click start      closes → internal polygon
 *   double-click     ends an open line (MANUAL detection ≤450 ms, ≤7 px, same target)
 *   Enter            ends open line · Esc cancels · Backspace removes last point
 *   on a line        (outline or internal line of the piece) a dot slides along it with the distance to both ends
 *                    of that line; type a number, or right-click before the first point, for the exact place:
 *                    From start · From end · Ratio % (the same box as Cut Point)
 *   right-click      after the first point: Length (+ angle), the helpers for the NEXT point
 *                    (90° square to the line · Compass · 2-point curve · exact place on the line) and Mirror creation
 * Phantom points closer than 6 px are dropped at commit.
 */
import { makeAnchor, makeContour, newId, type Anchor, type Vec, type Piece } from '@prowdcad/kernel';
import type { App } from '../app';
import type { ResolvedContour } from '@prowdcad/kernel';
import { contourNear } from '../hitkit';
import { resolveFor } from '../geometry';
import { openInputBox, inputBoxOpen, inputBoxCommit, inputBoxCancel, type IBMode } from '../ui/inputbox';
import { segmentAt, atArc, label, dot, trackClient, lastClient, isNumKey, totalLen, toolOpt, setToolOpt, type SegAt } from './livekit';
import { ICON, type Tool } from './tool';
import { constrain45, pieceAtWorld, toLocal, toWorld } from '../geometry';
import { draftScreenPath, dropPhantoms, screenMarker, snapOutline, snapPieceAnchor, reflectAnchor, fs } from './common';
import { DoubleClick } from '../ui/dom';
import { toast } from '../ui/toast';
import { showDialog } from '../ui/dialog';
import { fmt, unitLabel, parseNum } from '../units-ui';
import { settings, saveSettings } from '../settings';
import { ops } from '../ops-bridge';

type MirrorMode = 'none' | 'local' | 'x' | 'y';
interface Draft { host: Piece; pts: Anchor[]; hover: Vec | null; snapRing: Vec | null; mirror: MirrorMode }
let D: Draft | null = null;
const dbl = new DoubleClick(450, 7);
let ringHover: Vec | null = null;
/** the line of the host under the cursor: where on it, and the distance to both ends of that line */
interface LineHov { piece: Piece; rc: ResolvedContour; seg: SegAt; d: number; world: Vec }
let LH: LineHov | null = null;
/** helper for the NEXT point (chosen with right-click): square to a line, a compass radius, or a 2-point curve */
type Helper = { kind: 'square'; n: Vec } | { kind: 'compass'; r: number } | { kind: 'curve' };
let HELP: Helper | null = null;
/** 2-point curve: the end is set, the middle point follows the cursor until the next click */
let BEND = false;
const IT = 'internal';

function lineHov(app: App, host: Piece, w: Vec, tolPx = 10): LineHov | null {
  const h = contourNear(app, w, { pieceId: host.id, contour: 'any', tolPx });
  if (!h) return null;
  const seg = segmentAt(h.contour, h.rc, h.s); if (!seg || seg.L <= 1e-9) return null;
  const T = totalLen(h.rc);
  let d = h.rc.closed ? ((h.s - seg.sA) % T + T) % T : h.s - seg.sA; d = Math.max(0, Math.min(seg.L, d));
  return { piece: h.piece, rc: h.rc, seg, d, world: h.world };
}
/** every line of the host as polylines (piece-local, active size) */
function hostPolys(app: App, host: Piece): Vec[][] {
  const r = resolveFor(app.doc, host, app.sizeOf(host));
  return [r.sew, ...r.internals].filter(c => c && c.pts.length > 1).map(c => (c.closed ? [...c.pts, c.pts[0]] : c.pts));
}
/** where the straight line through o along n crosses the host's lines */
function lineHits(polys: Vec[][], o: Vec, n: Vec): Vec[] {
  const out: Vec[] = [];
  for (const pl of polys) for (let e = 0; e + 1 < pl.length; e++) {
    const a = pl[e], b = pl[e + 1], dx = b.x - a.x, dy = b.y - a.y, den = n.x * dy - n.y * dx;
    if (Math.abs(den) < 1e-12) continue;
    const u = (n.x * (o.y - a.y) - n.y * (o.x - a.x)) / -den;
    if (u >= -1e-9 && u <= 1 + 1e-9) out.push({ x: a.x + dx * u, y: a.y + dy * u });
  }
  return out;
}
/** where the circle (o, r) crosses the host's lines */
function circleHits(polys: Vec[][], o: Vec, r: number): Vec[] {
  const out: Vec[] = [];
  for (const pl of polys) for (let e = 0; e + 1 < pl.length; e++) {
    const a = pl[e], b = pl[e + 1], dx = b.x - a.x, dy = b.y - a.y, fx = a.x - o.x, fy = a.y - o.y;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r, disc = B * B - 4 * A * C;
    if (A < 1e-18 || disc < 0) continue;
    for (const sg of [-1, 1]) { const u = (-B + sg * Math.sqrt(disc)) / (2 * A); if (u >= -1e-9 && u <= 1 + 1e-9) out.push({ x: a.x + dx * u, y: a.y + dy * u }); }
  }
  return out;
}
const nearestTo = (app: App, host: Piece, cands: Vec[], l: Vec, tolPx: number): Vec | null => {
  let best: Vec | null = null, bd = tolPx / app.view.scale;
  for (const c of cands) { const d = Math.hypot(c.x - l.x, c.y - l.y); if (d < bd) { bd = d; best = c; } }
  return best;
};
/** direction a new line runs square to: the normal of the host line the last point sits on, else of the previous segment */
function squareNormal(app: App): Vec {
  if (!D) return { x: 0, y: 1 };
  const last = D.pts[D.pts.length - 1];
  const lh = lineHov(app, D.host, toWorld(D.host, last), 4);
  let t: Vec | null = null;
  if (lh) { const s = lh.seg.sA + lh.d, a = atArc(lh.rc, s - 0.05), b = atArc(lh.rc, s + 0.05); t = { x: b.x - a.x, y: b.y - a.y }; }
  else if (D.pts.length >= 2) { const q = D.pts[D.pts.length - 2]; t = { x: last.x - q.x, y: last.y - q.y }; }
  const l = t ? Math.hypot(t.x, t.y) : 0;
  return t && l > 1e-9 ? { x: -t.y / l, y: t.x / l } : { x: 0, y: 1 };
}

/** world point → snapped world point + whether it snapped to the outline */
function resolvePoint(app: App, host: Piece | null, w: Vec, shift: boolean): { w: Vec; ring: Vec | null } {
  LH = null;
  if (host) {
    const an = snapPieceAnchor(app, host, w, 8, D ? D.pts.map(p => ({ x: p.x, y: p.y })) : []);
    if (an) return { w: an.world, ring: an.world };
    if (D && D.pts.length && HELP && HELP.kind !== 'curve') {
      const last = D.pts[D.pts.length - 1], l = toLocal(host, w), polys = hostPolys(app, host);
      if (HELP.kind === 'square') {
        const n = HELP.n, t = (l.x - last.x) * n.x + (l.y - last.y) * n.y;
        const pt = { x: last.x + n.x * t, y: last.y + n.y * t };
        const hit = nearestTo(app, host, lineHits(polys, last, n).filter(q => Math.hypot(q.x - last.x, q.y - last.y) > 1e-6), pt, 12);
        const wq = toWorld(host, hit ?? pt); return { w: wq, ring: hit ? wq : null };
      }
      const dl = Math.hypot(l.x - last.x, l.y - last.y) || 1, r = HELP.r;
      const pt = { x: last.x + (l.x - last.x) / dl * r, y: last.y + (l.y - last.y) / dl * r };
      const hit = nearestTo(app, host, circleHits(polys, last, r), pt, 14);
      const wq = toWorld(host, hit ?? pt); return { w: wq, ring: hit ? wq : null };
    }
    if (shift && D && D.pts.length) return { w: constrain45(toWorld(host, D.pts[D.pts.length - 1]), w), ring: null };
    const lh = lineHov(app, host, w, 10);
    if (lh) { LH = lh; return { w: lh.world, ring: lh.world }; }
    const o = snapOutline(app, host, w, 10);
    if (o) return { w: o.world, ring: o.world };
  }
  return { w, ring: null };
}

function hostCandidate(app: App, w: Vec): Piece | null {
  const inside = pieceAtWorld(app.doc, w, app.activeSize, app.hiddenPieces);
  if (inside) return inside;
  for (const p of app.doc.style.pieces) { if (!app.hiddenPieces.has(p.id) && snapOutline(app, p, w, 10)) return p; }
  return null;
}

function commit(app: App, closed: boolean) {
  if (!D) return;
  const host = D.host;
  const pts = dropPhantoms(app, D.pts, closed, 6, host);
  const min = closed ? 3 : 2;
  if (pts.length < min) { toast(closed ? 'A polygon needs at least 3 points' : 'A line needs at least 2 points', 'warn'); return; }
  // ends of an open line are grade points so it has a well-defined segment
  if (!closed) { pts[0].kind = 'grade'; pts[pts.length - 1].kind = 'grade'; }
  else if (!pts.some(p => p.kind === 'grade')) pts[0].kind = 'grade';
  const contour = makeContour(pts, { type: 'internal', closed });
  const extra: typeof contour[] = [];
  if (D.mirror !== 'none') {
    const a = pts[0], b = pts[pts.length - 1];
    let p0: Vec, dir: Vec;
    if (D.mirror === 'local') { p0 = a; dir = { x: b.x - a.x, y: b.y - a.y }; if (Math.hypot(dir.x, dir.y) < 1e-6) dir = { x: 1, y: 0 }; }
    else if (D.mirror === 'x') { p0 = a; dir = { x: 0, y: 1 }; }   // mirror left ↔ right about a vertical axis through the start point
    else { p0 = a; dir = { x: 1, y: 0 }; }                          // mirror up ↔ down about a horizontal axis through the start point
    const mp = pts.map(q => reflectAnchor(q, p0, dir, () => newId('p')));
    // swap hIn/hOut sense is preserved: reflection keeps order, handles reflect as vectors
    extra.push(makeContour(mp, { type: 'internal', closed }));
  }
  // CLO / AccuMark attach: an open line that starts / ends on the outline is locked to it
  let locked = 0;
  app.doc.transact(closed ? 'Internal polygon' : 'Internal line', () => {
    const live = app.doc.piece(host.id);
    live.internals.push(contour, ...extra);
    if (!closed && settings.autoLockInternal) {
      const sizeId = app.sizeOf(live);
      for (const c of [contour, ...extra]) {
        try { if (ops.lockableEnds(live, app.doc.sizeLine(live), c, { tol: 0.05, sizeId }).length) locked += ops.lockInternalEnds(app.doc, host.id, c.id, { tol: 0.05, sizeId }); } catch { /* free line */ }
      }
    }
  });
  app.sel = { pieces: [host.id], anchors: [] };
  toast(`${closed ? 'Internal polygon' : 'Internal line'} added to “${host.name}”${extra.length ? ' + mirror' : ''}${locked ? ` · 🔒 ${locked} end${locked > 1 ? 's' : ''} locked to the outline (right-click ▸ Unlock)` : ''}`, 'ok');
  D = null; HELP = null; BEND = false; LH = null; dbl.reset();
  app.invalidate();
}

/** Exact place on the line under the cursor: From start · From end · Ratio % (as Cut Point). Starts the line, or adds its next point. */
async function placeOnLine(app: App, typed?: string) {
  const v = LH; if (!v || inputBoxOpen()) return;
  if (v.piece.locked) { toast('Piece is locked', 'warn'); return; }
  const L = v.seg.L;
  const modes: IBMode[] = [
    { id: 'start', label: 'From start', title: 'Length from the start of this line', fields: [{ key: 'd', label: 'Length from start', kind: 'length', value: v.d }] },
    { id: 'end', label: 'From end', title: 'Length from the end of this line', fields: [{ key: 'd', label: 'Length from end', kind: 'length', value: L - v.d }] },
    { id: 'pct', label: 'Ratio %', title: 'Ratio of this line, from its start', fields: [{ key: 'p', label: 'Ratio from start', kind: 'number', value: Math.round(v.d / L * 1e4) / 100, suffix: '%' }] },
  ];
  const dOf = (m: string, val: Record<string, number>) => (m === 'pct' ? L * val.p / 100 : m === 'end' ? L - val.d : val.d);
  const res = await openInputBox({
    title: `Internal line · point on a line of ${fmt(L)} ${unitLabel()}`, modes, mode: typed ? 'start' : toolOpt(IT, 'place', 'start'), at: lastClient, typed,
    hint: 'Enter / right-click = OK · Esc = cancel',
    onPreview: (m, val) => { if (val) { const d = dOf(m, val); if (d >= -1e-9 && d <= L + 1e-9) { LH = { ...v, d: Math.max(0, Math.min(L, d)), world: toWorld(v.piece, atArc(v.rc, v.seg.sA + d)) }; ringHover = LH.world; } } app.invalidate('canvas'); },
  });
  if (!res) { app.invalidate('canvas'); return; }
  setToolOpt(IT, 'place', res.mode);
  const d = dOf(res.mode, res.v);
  if (!(d >= -1e-6 && d <= L + 1e-6)) { toast(`That is outside the line (0 – ${fmt(L)} ${unitLabel()})`, 'warn'); return; }
  const l = atArc(v.rc, v.seg.sA + Math.max(0, Math.min(L, d)));
  if (!D) D = { host: v.piece, pts: [makeAnchor(l.x, l.y)], hover: null, snapRing: null, mirror: 'none' };
  else if (D.host.id === v.piece.id) { D.pts.push(makeAnchor(l.x, l.y)); HELP = null; }
  dbl.reset();
  app.status(`Point placed ${fmt(Math.max(0, Math.min(L, d)))} ${unitLabel()} from the start of the line`);
  app.invalidate('canvas');
}

async function exactDialog(app: App) {
  if (!D || !D.pts.length) return;
  const host = D.host;
  const last = D.pts[D.pts.length - 1];
  const hv = D.hover ? toLocal(host, D.hover) : { x: last.x + 1, y: last.y };
  const curAng = Math.atan2(hv.y - last.y, hv.x - last.x) * 180 / Math.PI;
  const r = await showDialog({
    title: 'Internal line — next point',
    fields: [
      { kind: 'select', key: 'helper', label: 'Next point', value: 'len', options: [
        { value: 'len', label: 'Length + angle (below)' },
        { value: 'square', label: '90°: square to the line the last point is on' },
        { value: 'compass', label: 'Compass: the Length below from the last point, onto a line' },
        { value: 'curve', label: '2-point curve: click the end, then bend it' },
        ...(LH ? [{ value: 'place', label: 'Exact place on the line under the cursor…' }] : [])] },
      { kind: 'length', key: 'len', label: 'Length', value: Math.hypot(hv.x - last.x, hv.y - last.y), min: 0 },
      { kind: 'text', key: 'ang', label: 'Angle °', value: (Math.round(curAng * 100) / 100).toString(), hint: '0 = right, 90 = up (piece frame). Leave as-is to keep the cursor direction.' },
      { kind: 'checkbox', key: 'curve', label: 'Curve point', value: false },
      { kind: 'select', key: 'mirror', label: 'Mirror creation', value: D.mirror, options: [
        { value: 'none', label: 'None' }, { value: 'local', label: 'Local (across first→last chord)' },
        { value: 'x', label: 'X (left ↔ right about start point)' }, { value: 'y', label: 'Y (up ↔ down about start point)' }] },
      { kind: 'checkbox', key: 'finish', label: 'Finish line after this point', value: false },
    ],
    validate: v => Number.isFinite(parseNum(String(v.ang))) ? null : 'Angle: invalid number',
  });
  if (!r || !D) return;
  D.mirror = r.mirror as MirrorMode;
  const L = r.len as number;
  const helper = String(r.helper ?? 'len');
  if (helper === 'place') { await placeOnLine(app); return; }
  if (helper === 'square') { HELP = { kind: 'square', n: squareNormal(app) }; app.status('90°: the next point runs square to the line · it snaps where it meets a line · click to set'); app.invalidate('canvas'); return; }
  if (helper === 'compass') { if (!(L > 0)) { toast('Compass needs a Length', 'warn'); return; } HELP = { kind: 'compass', r: L }; app.status(`Compass ${fmt(L)} ${unitLabel()}: the next point stays that far from the last one · it snaps where the circle meets a line · click to set`); app.invalidate('canvas'); return; }
  if (helper === 'curve') { HELP = { kind: 'curve' }; app.status('2-point curve: click the end point, then move to bend the line and click again'); app.invalidate('canvas'); return; }
  if (L > 0) {
    const a = parseNum(String(r.ang)) * Math.PI / 180;
    const x = last.x + L * Math.cos(a), y = last.y + L * Math.sin(a);
    D.pts.push(r.curve ? makeAnchor(x, y, { kind: 'curve', smooth: true }) : makeAnchor(x, y));
  }
  if (r.finish) commit(app, false);
  app.invalidate('canvas');
}

export const internalTool: Tool = {
  id: 'internal', title: 'Internal line / polygon', group: 'pen', hotkey: 'I', icon: ICON.internal, cursor: 'crosshair',
  deactivate(app) { if (inputBoxOpen()) inputBoxCancel(); D = null; ringHover = null; LH = null; HELP = null; BEND = false; dbl.reset(); app.invalidate('canvas'); },
  busy: () => !!D,
  toggles: () => [{ id: 'autolock', label: 'Lock ends to outline', title: 'An end drawn on the outline stays attached to its segment (proportional) when the segment moves, changes length or grades', on: settings.autoLockInternal }],
  toggle(app, id) { if (id === 'autolock') { settings.autoLockInternal = !settings.autoLockInternal; saveSettings(); app.invalidate(); } },
  hint: () => BEND ? 'Internal · 2-point curve: move to bend the line · click to set it'
    : D ? `Internal: ${D.pts.length} pts on “${D.host.name}”${HELP ? ` · ${HELP.kind === 'square' ? '90° to the line' : HELP.kind === 'compass' ? 'compass' : '2-point curve: click the end'}` : ''} · click start = polygon · click the last point again (or Enter) = end line · right-click = 90° / compass / 2-point curve / exact length · on a line: type a number = exact place${D.mirror !== 'none' ? ` · mirror ${D.mirror}` : ''}`
      : LH ? `Internal: on a line · ${fmt(LH.d)} from its start, ${fmt(LH.seg.L - LH.d)} from its end · click = start here · type a number or right-click = exact place (From start / From end / Ratio %)`
        : 'Internal: click inside a piece to start · on a line the distances to both ends show · Ctrl = curve · Shift = H/V/45°',

  down(app, p) {
    const e = p.e as PointerEvent;
    trackClient(p);
    if (inputBoxOpen()) return;
    // 2-point curve: this click sets the bend
    if (BEND) { BEND = false; dbl.reset(); app.invalidate('canvas'); return; }
    if (!D) {
      const host = hostCandidate(app, p.w);
      if (!host) { toast('Click inside a piece to start an internal line', 'warn'); return; }
      if (host.locked) { toast('Piece is locked', 'warn'); return; }
      const rp = resolvePoint(app, host, p.w, false);
      const l = toLocal(host, rp.w);
      const curve = e.ctrlKey || e.metaKey;
      D = { host, pts: [curve ? makeAnchor(l.x, l.y, { kind: 'curve', smooth: true }) : makeAnchor(l.x, l.y)], hover: null, snapRing: null, mirror: 'none' };
      dbl.hit(p.s.x, p.s.y, 'draft');
      app.invalidate('canvas'); return;
    }
    // manual double-click → end open line
    if (dbl.hit(p.s.x, p.s.y, 'draft')) { commit(app, false); return; }
    // the last point clicked a second time (however slowly) → end the line there
    if (D.pts.length >= 2) {
      const sl = app.view.toScreen(toWorld(D.host, D.pts[D.pts.length - 1]));
      if (Math.hypot(sl.x - p.s.x, sl.y - p.s.y) <= 7) { commit(app, false); return; }
    }
    // click on start → close polygon
    if (D.pts.length >= 3) {
      const s0 = app.view.toScreen(toWorld(D.host, D.pts[0]));
      if (Math.hypot(s0.x - p.s.x, s0.y - p.s.y) <= 9) { commit(app, true); return; }
    }
    const rp = resolvePoint(app, D.host, p.w, e.shiftKey);
    const l = toLocal(D.host, rp.w);
    const curve = e.ctrlKey || e.metaKey;
    const prev = D.pts[D.pts.length - 1];
    D.pts.push(curve ? makeAnchor(l.x, l.y, { kind: 'curve', smooth: true }) : makeAnchor(l.x, l.y));
    if (HELP?.kind === 'curve') {
      // 2-point curve: a curve point between the last two points follows the cursor until the next click
      D.pts.splice(D.pts.length - 1, 0, makeAnchor((prev.x + l.x) / 2, (prev.y + l.y) / 2, { kind: 'curve', smooth: true }));
      BEND = true; D.hover = null; dbl.reset();
    }
    HELP = null;
    app.invalidate('canvas');
  },
  move(app, p) {
    const e = p.e as PointerEvent;
    trackClient(p);
    if (inputBoxOpen()) return;
    if (BEND && D && D.pts.length >= 3) {
      const m = D.pts[D.pts.length - 2], l = toLocal(D.host, p.w);
      m.x = l.x; m.y = l.y; D.hover = null; D.snapRing = null; LH = null;
      app.invalidate('canvas'); return;
    }
    if (!D) {
      const host = hostCandidate(app, p.w);
      const rp = resolvePoint(app, host, p.w, false);
      ringHover = rp.ring;
      app.invalidate('canvas'); return;
    }
    const rp = resolvePoint(app, D.host, p.w, e.shiftKey);
    D.hover = rp.w; D.snapRing = rp.ring;
    const last = toWorld(D.host, D.pts[D.pts.length - 1]);
    app.status(`L ${fmt(Math.hypot(rp.w.x - last.x, rp.w.y - last.y))} ${unitLabel()} · ${(Math.atan2(rp.w.y - last.y, rp.w.x - last.x) * 180 / Math.PI).toFixed(1)}°`);
    app.invalidate('canvas');
  },
  context(app, p) {
    trackClient(p);
    if (inputBoxOpen()) { inputBoxCommit(); return true; }
    if (BEND) { BEND = false; app.invalidate('canvas'); return true; }
    if (D) { void exactDialog(app); return true; }
    if (LH) { void placeOnLine(app); return true; }
    return false;
  },
  key(app, e) {
    if (inputBoxOpen()) return false;
    if (isNumKey(e) && LH && !BEND && !(D && HELP)) { void placeOnLine(app, e.key); return true; }
    if (!D) return false;
    if (e.key === 'Escape' && HELP) { HELP = null; app.status('Helper off'); app.invalidate('canvas'); return true; }
    if (e.key === 'Escape') { D = null; HELP = null; BEND = false; dbl.reset(); app.status('Internal line cancelled'); app.invalidate('canvas'); return true; }
    if (e.key === 'Enter') { commit(app, false); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { if (BEND) { D.pts.splice(D.pts.length - 2, 1); BEND = false; } D.pts.pop(); HELP = null; if (!D.pts.length) D = null; app.invalidate('canvas'); return true; }
    return false;
  },
  overlay(app) {
    let s = '';
    // on a line: the sliding dot and the distance to both ends of that line
    if (LH && !BEND) {
      const c = app.view.toScreen(LH.world);
      const a = app.view.toScreen(toWorld(LH.piece, atArc(LH.rc, LH.seg.sA))), b = app.view.toScreen(toWorld(LH.piece, atArc(LH.rc, LH.seg.sA + LH.seg.L)));
      s += dot(c, '#e67e22') + dot(a, '#3b7cff', 3) + dot(b, '#e8590c', 3)
        + label({ x: c.x + 10, y: c.y - 10 }, `${fmt(LH.d)} | ${fmt(LH.seg.L - LH.d)}`, { col: '#b35c00' });
    }
    if (!D) { if (ringHover && !LH) s += screenMarker(app.view.toScreen(ringHover), 'ring', '#e67e22', 10 * 0.8); return s; }
    if (HELP && HELP.kind !== 'curve') {
      const o = app.view.toScreen(toWorld(D.host, D.pts[D.pts.length - 1]));
      if (HELP.kind === 'compass') s += `<circle cx="${fs(o.x)}" cy="${fs(o.y)}" r="${fs(HELP.r * app.view.scale)}" fill="none" stroke="#e67e22" stroke-width="1" stroke-dasharray="4 4" data-helper="compass"/>`;
      else { const last = D.pts[D.pts.length - 1], n = HELP.n, R = 4000 / app.view.scale; const a = app.view.toScreen(toWorld(D.host, { x: last.x - n.x * R, y: last.y - n.y * R })), b = app.view.toScreen(toWorld(D.host, { x: last.x + n.x * R, y: last.y + n.y * R })); s += `<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}" stroke="#e67e22" stroke-width="1" stroke-dasharray="4 4" data-helper="square"/>`; }
    }
    const host = D.host;
    const pts = D.hover ? [...D.pts, makeAnchor(toLocal(host, D.hover).x, toLocal(host, D.hover).y, { id: 'hover' })] : D.pts;
    s += `<path d="${draftScreenPath(app, pts, false, host)}" fill="none" stroke="#4ea1ff" stroke-width="1.6" stroke-dasharray="5 3"/>`;
    for (const a of D.pts) s += screenMarker(app.view.toScreen(toWorld(host, a)), a.kind === 'grade' ? 'square' : 'circle', '#4ea1ff', 3.5);
    if (D.pts.length >= 3) s += screenMarker(app.view.toScreen(toWorld(host, D.pts[0])), 'ring', '#e67e22', 9);
    if (D.snapRing) s += screenMarker(app.view.toScreen(D.snapRing), 'ring', '#e67e22', 8);
    if (D.mirror !== 'none') { const a = app.view.toScreen(toWorld(host, D.pts[0])); s += `<text x="${fs(a.x + 8)}" y="${fs(a.y - 8)}" class="tool-note">mirror: ${D.mirror}</text>`; }
    return s;
  },
};
