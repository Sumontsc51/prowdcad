/**
 * Selection hit-testing for the Select tool (and the Move tools' picks): every selectable object
 * under the cursor as a ranked candidate list, box (window / crossing) gathering, and the
 * screen-space highlight of the selection and of the hover candidate.
 *
 * Priority when several objects are inside the pick radius: point > notch > mark (drill / text) >
 * segment / internal / dart-pleat-fullness > piece interior; nearest first within a kind.
 */
import { closestPoint, pointInPolygon, arcPolyline, segmentIndexAt, type Piece, type Vec, type Id, type Contour } from '@prowdcad/kernel';
import type { App, SelItem, SegSel } from './app';
import { selItemKey } from './app';
import { settings, type SelFilter } from './settings';
import { resolveFor, toWorld, toLocal, pieceAtWorld } from './geometry';
import { ops } from './ops-bridge';
import { segmentIds, screenPath } from './hitkit';
import { liveShapes, hitLines } from './live';
import { notchesFor } from './canvas/render';

export interface Cand { item: SelItem; dpx: number; prio: number; label: string; world: Vec }

export const SEL_COLOR = '#ff8a00';
export const FILTERS: { id: SelFilter; label: string; key: string; title: string }[] = [
  { id: 'all', label: 'All', key: '0', title: 'Everything (0)' },
  { id: 'pieces', label: 'Pieces', key: '1', title: 'Pieces only (1)' },
  { id: 'points', label: 'Points', key: '2', title: 'Grade and curve points only (2)' },
  { id: 'lines', label: 'Lines', key: '3', title: 'Sew-line segments between grade points only (3)' },
  { id: 'internals', label: 'Internals', key: '4', title: 'Internal lines, darts, pleats, fullness only (4)' },
  { id: 'marks', label: 'Marks', key: '5', title: 'Notches, drills, buttons and texts only (5)' },
];

type K = SelItem['k'];
function allowed(f: SelFilter): Set<K> {
  switch (f) {
    case 'points': return new Set<K>(['point']);
    case 'lines': return new Set<K>(['segment']);
    case 'pieces': return new Set<K>(['piece']);
    case 'internals': return new Set<K>(['internal', 'live']);
    case 'marks': return new Set<K>(['notch', 'mark']);
    default: return new Set<K>(['point', 'notch', 'mark', 'segment', 'internal', 'live', 'piece']);
  }
}
const PRIO: Record<K, number> = { point: 0, notch: 1, mark: 2, segment: 3, internal: 3, live: 3, piece: 4 };

/** Move tools show (and pick) the curve points of every piece, not only of selected ones. */
export const curvePointsEverywhere = (app: App) => app.tool?.group === 'move';
const visible = (app: App) => app.pieces().filter(p => !app.hiddenPieces.has(p.id));
/** Internal contours drawn as live objects (dart / pleat axes) are selected through the live object. */
const isLiveAxis = (p: Piece, c: Contour) =>
  (c.type === 'dartAxis' && p.darts.some(d => d.axisContourId === c.id)) || (c.type === 'pleatAxis' && p.pleats.some(q => q.axisContourId === c.id));

function polyDist(poly: Vec[], q: Vec): number { return poly.length === 1 ? Math.hypot(poly[0].x - q.x, poly[0].y - q.y) : poly.length ? closestPoint(poly, q).d : Infinity; }

/** Every selectable object within the pick radius of world point w, best first. */
export function candidatesAt(app: App, w: Vec, filter: SelFilter = settings.selFilter, o: { kinds?: K[]; tolPx?: number } = {}): Cand[] {
  const ok = o.kinds ? new Set(o.kinds) : allowed(filter);
  const tolPx = o.tolPx ?? settings.pickRadiusPx ?? 8;
  const sc = app.view.scale, tol = tolPx / sc;
  const out: Cand[] = [];
  const selPieces = new Set(app.sel.pieces);
  for (const p of visible(app)) {
    const sid = app.sizeOf(p);
    let r; try { r = resolveFor(app.doc, p, sid); } catch { continue; }
    const l = toLocal(p, w);
    const contours = [p.sew, ...p.internals], rcs = [r.sew, ...r.internals];
    // points (same visibility rule as the renderer: curve points only on selected pieces)
    const allCurve = curvePointsEverywhere(app);
    if (ok.has('point') && (selPieces.has(p.id) || settings.showAllAnchors || allCurve)) {
      contours.forEach((c, ci) => {
        const rc = rcs[ci]; if (!rc) return;
        c.points.forEach((a, i) => {
          if (a.kind !== 'grade' && !selPieces.has(p.id) && !allCurve) return;
          const q = rc.anchorPos[i]; const d = Math.hypot(q.x - l.x, q.y - l.y);
          if (d <= tol) out.push({ item: { k: 'point', ref: { pieceId: p.id, contourId: c.id, anchorId: a.id } }, dpx: d * sc, prio: PRIO.point, label: `${a.kind === 'grade' ? 'Grade pt' : 'Curve pt'} ${i + 1}${a.name ? ' ' + a.name : ''} · ${p.name}`, world: toWorld(p, q) });
        });
      });
    }
    // notches
    if (ok.has('notch')) {
      for (const n of notchesFor(app, p, sid)) {
        const d = Math.min(Math.hypot(n.pos.x - l.x, n.pos.y - l.y), ...n.cutGeometry.map(pl => polyDist(pl, l)));
        if (d <= tol) out.push({ item: { k: 'notch', n: { pieceId: p.id, notchId: n.notchId } }, dpx: d * sc, prio: PRIO.notch, label: `Notch · ${p.name}`, world: toWorld(p, n.pos) });
      }
    }
    // drills / buttons / texts
    if (ok.has('mark')) {
      for (const dr of p.drills) {
        let c: Vec = dr; try { c = ops.drillPosition(app.doc, p, dr, sid); } catch { /* base */ }
        const d = Math.max(0, Math.hypot(c.x - l.x, c.y - l.y) - dr.diameter / 2);
        if (d <= tol) out.push({ item: { k: 'mark', m: { pieceId: p.id, kind: 'drill', id: dr.id } }, dpx: d * sc, prio: PRIO.mark, label: `${dr.kind === 'drill' ? 'Drill' : dr.kind === 'button' ? 'Button' : 'Buttonhole'} · ${p.name}`, world: toWorld(p, c) });
      }
      for (const t of p.texts) {
        let c: Vec = t; try { c = ops.textPosition(app.doc, p, t, sid); } catch { /* base */ }
        const half = { x: Math.max(t.size * t.text.length * 0.3, 2), y: t.size * 0.6 };
        const a = -t.angleDeg * Math.PI / 180; const dx = l.x - c.x, dy = l.y - c.y;
        const u = dx * Math.cos(a) - dy * Math.sin(a), v = dx * Math.sin(a) + dy * Math.cos(a);
        const d = Math.hypot(Math.max(0, Math.abs(u) - half.x), Math.max(0, Math.abs(v) - half.y));
        if (d <= tol) out.push({ item: { k: 'mark', m: { pieceId: p.id, kind: 'text', id: t.id } }, dpx: d * sc, prio: PRIO.mark, label: `Text "${t.text}" · ${p.name}`, world: toWorld(p, c) });
      }
    }
    // sew segments (grade segment under the cursor)
    if (ok.has('segment') && r.sew.pts.length > 1 && r.sew.gradeIdx.length) {
      const poly = r.sew.closed ? [...r.sew.pts, r.sew.pts[0]] : r.sew.pts;
      const cp = closestPoint(poly, l);
      if (cp.d <= tol) {
        const k = segmentIndexAt(r.sew, cp.s);
        const ids = segmentIds(p.sew, r.sew, k);
        if (ids.from && ids.to) out.push({ item: { k: 'segment', seg: { pieceId: p.id, contourId: p.sew.id, from: ids.from, to: ids.to } }, dpx: cp.d * sc, prio: PRIO.segment, label: `Segment ${segName(p.sew, ids.from, ids.to)} · ${p.name}`, world: toWorld(p, cp.pt) });
      }
    }
    // internal lines (whole)
    if (ok.has('internal')) {
      p.internals.forEach((c, ci) => {
        if (isLiveAxis(p, c)) return;
        const rc = r.internals[ci]; if (!rc || rc.pts.length < 2) return;
        const poly = rc.closed ? [...rc.pts, rc.pts[0]] : rc.pts;
        const cp = closestPoint(poly, l);
        if (cp.d <= tol) out.push({ item: { k: 'internal', c: { pieceId: p.id, contourId: c.id } }, dpx: cp.d * sc, prio: PRIO.internal, label: `Internal ${ci + 1}${c.type && c.type !== 'internal' ? ' (' + c.type + ')' : ''} · ${p.name}`, world: toWorld(p, cp.pt) });
      });
    }
    // darts / pleats / fullness
    if (ok.has('live')) {
      for (const sh of liveShapes(app, p, sid)) {
        const d = Math.min(...hitLines(sh).map(pl => polyDist(pl, l)));
        if (d <= tol) out.push({ item: { k: 'live', live: { kind: sh.kind, pieceId: p.id, id: sh.id } }, dpx: d * sc, prio: PRIO.live, label: `${sh.kind[0].toUpperCase()}${sh.kind.slice(1)} · ${p.name}`, world: w });
      }
    }
  }
  if (ok.has('piece')) {
    const pc = pieceAtWorld(app.doc, w, app.activeSize, app.hiddenPieces);
    if (pc) out.push({ item: { k: 'piece', pieceId: pc.id }, dpx: tolPx + 1, prio: PRIO.piece, label: `Piece ${pc.name}`, world: w });
  }
  out.sort((a, b) => a.prio - b.prio || a.dpx - b.dpx);
  // one entry per object
  const seen = new Set<string>();
  return out.filter(c => { const k = selItemKey(c.item); if (seen.has(k)) return false; seen.add(k); return true; });
}

function segName(c: Contour, from: Id, to: Id): string {
  const i = c.points.findIndex(a => a.id === from) + 1, j = c.points.findIndex(a => a.id === to) + 1;
  return `${i}→${j}`;
}

/** World polyline of a selected segment (active size). */
export function segWorld(app: App, g: SegSel): Vec[] {
  const p = app.piece(g.pieceId); if (!p) return [];
  const c = g.contourId === p.sew.id ? p.sew : p.internals.find(x => x.id === g.contourId); if (!c) return [];
  const r = resolveFor(app.doc, p, app.sizeOf(p));
  const rc = c === p.sew ? r.sew : r.internals[p.internals.indexOf(c)];
  const ia = c.points.findIndex(a => a.id === g.from), ib = c.points.findIndex(a => a.id === g.to);
  if (ia < 0 || ib < 0 || !rc) return [];
  const poly = ia === ib && rc.closed ? [...rc.pts.slice(rc.anchorIndex[ia]), ...rc.pts.slice(0, rc.anchorIndex[ia] + 1)] : arcPolyline(rc, ia, ib, false);
  return poly.map(q => toWorld(p, q));
}
function internalWorld(app: App, pieceId: Id, contourId: Id): { pts: Vec[]; closed: boolean } {
  const p = app.piece(pieceId); if (!p) return { pts: [], closed: false };
  const ci = p.internals.findIndex(c => c.id === contourId); if (ci < 0) return { pts: [], closed: false };
  const rc = resolveFor(app.doc, p, app.sizeOf(p)).internals[ci];
  return { pts: rc.pts.map(q => toWorld(p, q)), closed: rc.closed };
}
function notchWorld(app: App, pieceId: Id, notchId: Id): Vec[][] {
  const p = app.piece(pieceId); if (!p) return [];
  const n = notchesFor(app, p, app.sizeOf(p)).find(x => x.notchId === notchId); if (!n) return [];
  return n.cutGeometry.map(pl => pl.map(q => toWorld(p, q)));
}
function markWorld(app: App, pieceId: Id, kind: 'drill' | 'text', id: Id): { c: Vec; r: number } | null {
  const p = app.piece(pieceId); if (!p) return null;
  const sid = app.sizeOf(p);
  if (kind === 'drill') { const d = p.drills.find(x => x.id === id); if (!d) return null; let c: Vec = d; try { c = ops.drillPosition(app.doc, p, d, sid); } catch { /* */ } return { c: toWorld(p, c), r: Math.max(d.diameter / 2, 1) }; }
  const t = p.texts.find(x => x.id === id); if (!t) return null; let c: Vec = t; try { c = ops.textPosition(app.doc, p, t, sid); } catch { /* */ }
  return { c: toWorld(p, c), r: Math.max(t.size * t.text.length * 0.3, t.size) };
}

// ───────────── box select ─────────────

export interface Box { minX: number; minY: number; maxX: number; maxY: number }
const inBox = (b: Box, q: Vec) => q.x >= b.minX && q.x <= b.maxX && q.y >= b.minY && q.y <= b.maxY;
function segHitsBox(b: Box, a: Vec, c: Vec): boolean {
  if (inBox(b, a) || inBox(b, c)) return true;
  const edges: [Vec, Vec][] = [[{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }], [{ x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }], [{ x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], [{ x: b.minX, y: b.maxY }, { x: b.minX, y: b.minY }]];
  const cr = (o: Vec, p: Vec, q: Vec) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  return edges.some(([p, q]) => (cr(p, q, a) > 0) !== (cr(p, q, c) > 0) && (cr(a, c, p) > 0) !== (cr(a, c, q) > 0));
}
/** Window (all inside) or crossing (touches) test of a world polyline. */
function polyInBox(b: Box, pts: Vec[], crossing: boolean, closed = false): boolean {
  if (!pts.length) return false;
  if (!crossing) return pts.every(q => inBox(b, q));
  for (let i = 0; i + 1 < pts.length; i++) if (segHitsBox(b, pts[i], pts[i + 1])) return true;
  if (closed && pts.length > 2 && segHitsBox(b, pts[pts.length - 1], pts[0])) return true;
  return pts.length === 1 && inBox(b, pts[0]);
}

/**
 * Objects in a box. Window (drawn left → right): fully inside. Crossing (right → left): touched.
 * Filter "All" box-selects points (pick a filter chip to box-select another kind).
 */
export function gatherInBox(app: App, b: Box, crossing: boolean, filter: SelFilter = settings.selFilter): SelItem[] {
  const out: SelItem[] = [];
  const selPieces = new Set(app.sel.pieces);
  for (const p of visible(app)) {
    const sid = app.sizeOf(p);
    let r; try { r = resolveFor(app.doc, p, sid); } catch { continue; }
    const W = (q: Vec) => toWorld(p, q);
    if (filter === 'all' || filter === 'points') {
      const contours = [p.sew, ...p.internals], rcs = [r.sew, ...r.internals];
      contours.forEach((c, ci) => c.points.forEach((a, i) => {
        if (filter === 'all' && a.kind !== 'grade' && !selPieces.has(p.id) && !settings.showAllAnchors) return;
        if (rcs[ci] && inBox(b, W(rcs[ci].anchorPos[i]))) out.push({ k: 'point', ref: { pieceId: p.id, contourId: c.id, anchorId: a.id } });
      }));
    }
    if (filter === 'lines' && r.sew.gradeIdx.length) {
      for (let k = 0; k < r.sew.gradeIdx.length; k++) {
        const ids = segmentIds(p.sew, r.sew, k); if (!ids.from || !ids.to) continue;
        const g = { pieceId: p.id, contourId: p.sew.id, from: ids.from, to: ids.to };
        if (polyInBox(b, segWorld(app, g), crossing)) out.push({ k: 'segment', seg: g });
      }
    }
    if (filter === 'internals') {
      p.internals.forEach((c, ci) => { if (!isLiveAxis(p, c) && r.internals[ci] && polyInBox(b, r.internals[ci].pts.map(W), crossing, r.internals[ci].closed)) out.push({ k: 'internal', c: { pieceId: p.id, contourId: c.id } }); });
      for (const sh of liveShapes(app, p, sid)) if (hitLines(sh).some(pl => polyInBox(b, pl.map(W), crossing))) out.push({ k: 'live', live: { kind: sh.kind, pieceId: p.id, id: sh.id } });
    }
    if (filter === 'pieces') {
      const outline = (r.cut.length > 2 ? r.cut : r.sew.pts).map(W);
      const hit = polyInBox(b, outline, crossing, true) || (crossing && pointInPolygon(toLocal(p, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }), r.cut.length > 2 ? r.cut : r.sew.pts));
      if (hit) out.push({ k: 'piece', pieceId: p.id });
    }
    if (filter === 'marks') {
      for (const n of notchesFor(app, p, sid)) if (inBox(b, W(n.pos))) out.push({ k: 'notch', n: { pieceId: p.id, notchId: n.notchId } });
      for (const d of p.drills) { const m = markWorld(app, p.id, 'drill', d.id); if (m && inBox(b, m.c)) out.push({ k: 'mark', m: { pieceId: p.id, kind: 'drill', id: d.id } }); }
      for (const t of p.texts) { const m = markWorld(app, p.id, 'text', t.id); if (m && inBox(b, m.c)) out.push({ k: 'mark', m: { pieceId: p.id, kind: 'text', id: t.id } }); }
    }
  }
  return out;
}

// ───────────── highlight (screen space) ─────────────

const fs = (n: number) => (Math.round(n * 10) / 10).toString();

function arrowAt(app: App, pts: Vec[], col: string, op: number): string {
  if (pts.length < 2) return '';
  // arrowhead at the middle of the run, pointing in the run direction
  let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]; const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + d >= L / 2 && d > 0) {
      const t = (L / 2 - acc) / d; const m = app.view.toScreen({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      const sa = app.view.toScreen(a), sb = app.view.toScreen(b); const ux = sb.x - sa.x, uy = sb.y - sa.y, l = Math.hypot(ux, uy) || 1;
      const x = ux / l, y = uy / l, k = 9, wv = 5;
      return `<path d="M${fs(m.x - x * k - y * wv)} ${fs(m.y - y * k + x * wv)}L${fs(m.x)} ${fs(m.y)}L${fs(m.x - x * k + y * wv)} ${fs(m.y - y * k - x * wv)}" stroke="${col}" stroke-width="2.4" fill="none" opacity="${op}"/>`;
    }
    acc += d;
  }
  return '';
}

/** Highlight markup for one item (orange; op = opacity, 0.5 for the hover pre-highlight). */
export function itemHighlight(app: App, it: SelItem, op = 1, col = SEL_COLOR): string {
  switch (it.k) {
    case 'segment': { const pts = segWorld(app, it.seg); return `<path d="${screenPath(app, pts)}" stroke="${col}" stroke-width="4.5" fill="none" stroke-linecap="round" opacity="${op * 0.85}"/>` + arrowAt(app, pts, col, op); }
    case 'internal': { const w = internalWorld(app, it.c.pieceId, it.c.contourId); return `<path d="${screenPath(app, w.pts, w.closed)}" stroke="${col}" stroke-width="4" fill="none" stroke-linecap="round" opacity="${op * 0.85}"/>` + arrowAt(app, w.pts, col, op); }
    case 'notch': return notchWorld(app, it.n.pieceId, it.n.notchId).map(pl => `<path d="${screenPath(app, pl)}" stroke="${col}" stroke-width="4" fill="none" stroke-linecap="round" opacity="${op}"/>`).join('');
    case 'mark': { const m = markWorld(app, it.m.pieceId, it.m.kind, it.m.id); if (!m) return ''; const s = app.view.toScreen(m.c); const r = Math.max(7, m.r * app.view.scale + 4); return `<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="${fs(r)}" stroke="${col}" stroke-width="2.5" fill="none" opacity="${op}"/>`; }
    case 'point': { const p = app.piece(it.ref.pieceId); const q = p && app.resolveRef(it.ref); if (!p || !q) return ''; const sid = it.sizeId ?? app.sizeOf(p); const r = resolveFor(app.doc, p, sid); const ci = q.contour === p.sew ? -1 : p.internals.indexOf(q.contour); const pos = (ci < 0 ? r.sew : r.internals[ci])?.anchorPos[q.index]; if (!pos) return ''; const s = app.view.toScreen(toWorld(p, pos)); return `<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="7.5" stroke="${col}" stroke-width="2.2" fill="none" opacity="${op}"/>`; }
    case 'piece': { const p = app.piece(it.pieceId); if (!p) return ''; const r = resolveFor(app.doc, p, app.sizeOf(p)); return `<path d="${screenPath(app, r.sew.pts.map(q => toWorld(p, q)), r.sew.closed)}" stroke="${col}" stroke-width="3" fill="none" opacity="${op * 0.6}"/>`; }
    case 'live': return '';
  }
}

/** Screen overlay: the selected segments / internals / notches / marks, plus the primary point ring. */
export function selectionOverlay(app: App): string {
  const s = app.sel; const out: string[] = [];
  for (const g of s.segments) out.push(itemHighlight(app, { k: 'segment', seg: g }));
  for (const c of s.internals) out.push(itemHighlight(app, { k: 'internal', c }));
  for (const n of s.notches) out.push(itemHighlight(app, { k: 'notch', n }));
  for (const m of s.marks) out.push(itemHighlight(app, { k: 'mark', m }));
  const pa = s.anchors[s.anchors.length - 1];
  if (pa && s.anchors.length > 1 && s.primary === 'point') out.push(itemHighlight(app, { k: 'point', ref: pa }, 0.9));
  return out.join('');
}
