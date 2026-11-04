/**
 * Internal line / polygon pen (I). Draws an internal Contour inside a host piece.
 *   start            must be inside a piece (or snapped onto its outline)
 *   outline snap     ring shown when within ~10 px of the host's sew line; anchors snap at 8 px
 *   Ctrl             curve (smooth) point
 *   Shift            H / V / 45° from the previous point
 *   click start      closes → internal polygon
 *   double-click     ends an open line (MANUAL detection ≤450 ms, ≤7 px, same target)
 *   Enter            ends open line · Esc cancels · Backspace removes last point
 *   right-click      in-app dialog: exact next-segment Length (+ angle) and Mirror creation (Local/X/Y)
 * Phantom points closer than 6 px are dropped at commit.
 */
import { makeAnchor, makeContour, newId, type Anchor, type Vec, type Piece } from '@prowdcad/kernel';
import type { App } from '../app';
import { ICON, type Tool } from './tool';
import { constrain45, pieceAtWorld, toLocal, toWorld } from '../geometry';
import { draftScreenPath, dropPhantoms, screenMarker, snapOutline, snapPieceAnchor, reflectAnchor, fs } from './common';
import { DoubleClick } from '../ui/dom';
import { toast } from '../ui/toast';
import { showDialog } from '../ui/dialog';
import { fmt, unitLabel, parseNum } from '../units-ui';

type MirrorMode = 'none' | 'local' | 'x' | 'y';
interface Draft { host: Piece; pts: Anchor[]; hover: Vec | null; snapRing: Vec | null; mirror: MirrorMode }
let D: Draft | null = null;
const dbl = new DoubleClick(450, 7);
let ringHover: Vec | null = null;

/** world point → snapped world point + whether it snapped to the outline */
function resolvePoint(app: App, host: Piece | null, w: Vec, shift: boolean): { w: Vec; ring: Vec | null } {
  if (host) {
    const an = snapPieceAnchor(app, host, w, 8, D ? D.pts.map(p => ({ x: p.x, y: p.y })) : []);
    if (an) return { w: an.world, ring: an.world };
    if (shift && D && D.pts.length) return { w: constrain45(toWorld(host, D.pts[D.pts.length - 1]), w), ring: null };
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
  app.doc.transact(closed ? 'Internal polygon' : 'Internal line', () => {
    const live = app.doc.piece(host.id);
    live.internals.push(contour, ...extra);
  });
  app.sel = { pieces: [host.id], anchors: [] };
  toast(`${closed ? 'Internal polygon' : 'Internal line'} added to “${host.name}”${extra.length ? ' + mirror' : ''}`, 'ok');
  D = null; dbl.reset();
  app.invalidate();
}

async function exactDialog(app: App) {
  if (!D || !D.pts.length) return;
  const host = D.host;
  const last = D.pts[D.pts.length - 1];
  const hv = D.hover ? toLocal(host, D.hover) : { x: last.x + 1, y: last.y };
  const curAng = Math.atan2(hv.y - last.y, hv.x - last.x) * 180 / Math.PI;
  const r = await showDialog({
    title: 'Internal line — next segment',
    fields: [
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
  deactivate(app) { D = null; ringHover = null; dbl.reset(); app.invalidate('canvas'); },
  busy: () => !!D,
  hint: () => D ? `Internal: ${D.pts.length} pts on “${D.host.name}” · click start = polygon · dbl-click/Enter = end line · right-click = exact/mirror${D.mirror !== 'none' ? ` · mirror ${D.mirror}` : ''}` : 'Internal: click inside a piece to start · Ctrl = curve · Shift = H/V/45°',

  down(app, p) {
    const e = p.e as PointerEvent;
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
    // click on start → close polygon
    if (D.pts.length >= 3) {
      const s0 = app.view.toScreen(toWorld(D.host, D.pts[0]));
      if (Math.hypot(s0.x - p.s.x, s0.y - p.s.y) <= 9) { commit(app, true); return; }
    }
    const rp = resolvePoint(app, D.host, p.w, e.shiftKey);
    const l = toLocal(D.host, rp.w);
    const curve = e.ctrlKey || e.metaKey;
    D.pts.push(curve ? makeAnchor(l.x, l.y, { kind: 'curve', smooth: true }) : makeAnchor(l.x, l.y));
    app.invalidate('canvas');
  },
  move(app, p) {
    const e = p.e as PointerEvent;
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
  context(app) { if (D) { void exactDialog(app); return true; } return false; },
  key(app, e) {
    if (!D) return false;
    if (e.key === 'Escape') { D = null; dbl.reset(); app.status('Internal line cancelled'); app.invalidate('canvas'); return true; }
    if (e.key === 'Enter') { commit(app, false); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { D.pts.pop(); if (!D.pts.length) D = null; app.invalidate('canvas'); return true; }
    return false;
  },
  overlay(app) {
    let s = '';
    if (!D) { if (ringHover) s += screenMarker(app.view.toScreen(ringHover), 'ring', '#e67e22', 10 * 0.8); return s; }
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
