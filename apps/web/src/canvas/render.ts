/**
 * SVG rendering of the design sheet. Three layers:
 *   #grid    — screen space, adaptive grid
 *   #world   — world space (mm, y-up via the viewport matrix), non-scaling strokes: sew/cut/internals/notches/drills
 *   #overlay — screen space: guides, labels, grain arrows, anchors, handles and their hit targets (topmost), tool overlays
 */
import { type Piece, type Vec, type SizeId, type ResolvedNotch } from '@prowdcad/kernel';
import { ops } from '../ops-bridge';
import type { App } from '../app';
import { settings } from '../settings';
import { resolveFor, toWorld, layoutOf, sizeColor, sizeFor } from '../geometry';
import { MM_PER_UNIT } from '@prowdcad/kernel';

const ACCENT = '#4ea1ff';
const f = (n: number) => (Math.round(n * 1000) / 1000).toString();
const fs = (n: number) => (Math.round(n * 10) / 10).toString();

export function pathD(pts: Vec[], closed: boolean): string {
  if (!pts.length) return '';
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += `L${f(pts[i].x)} ${f(pts[i].y)}`;
  return closed ? d + 'Z' : d;
}
function pathS(pts: Vec[], closed: boolean): string {
  if (!pts.length) return '';
  let d = `M${fs(pts[0].x)} ${fs(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += `L${fs(pts[i].x)} ${fs(pts[i].y)}`;
  return closed ? d + 'Z' : d;
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** nice step ≥ minWorld from {1,2,5}×10^k */
export function niceStep(minWorld: number, base = 1): number {
  const x = minWorld / base;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-9))));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p * base;
  return 10 * p * base;
}

// resolved notches cache (notches are re-derived per revision / piece / size)
const notchCache = new Map<string, ResolvedNotch[]>();
let notchRev = -1;
function notchesFor(app: App, p: Piece, sid: SizeId): ResolvedNotch[] {
  if (!p.notches.length) return [];
  const live = app.doc.style.pieces.includes(p);
  if (notchRev !== app.doc.revision()) { notchCache.clear(); notchRev = app.doc.revision(); }
  const key = `${p.id}|${sid}`;
  if (live) { const c = notchCache.get(key); if (c) return c; }
  let res: ResolvedNotch[] = [];
  try { res = ops.resolveNotches(app.doc, p, sid); } catch (err) { console.warn('notches', err); }
  if (live) notchCache.set(key, res);
  return res;
}

// ───────────── grid ─────────────
export function renderGrid(app: App): string {
  if (!settings.showGrid) return '';
  const v = app.view;
  const vis = v.visibleWorld();
  const unitMm = settings.unit === 'mm' ? 1 : MM_PER_UNIT[settings.unit];
  const base = settings.unit === 'mm' ? settings.gridMm : unitMm;
  const minor = niceStep(v.px(9), base);
  const major = minor * (settings.unit === 'in' ? 4 : 10);
  let minorD = '', majorD = '';
  const x0 = Math.floor(vis.minX / minor) * minor, y0 = Math.floor(vis.minY / minor) * minor;
  const isMajor = (val: number) => Math.abs(val / major - Math.round(val / major)) < 1e-6;
  let guard = 0;
  for (let x = x0; x <= vis.maxX && guard++ < 600; x += minor) {
    const sx = fs(v.toScreen({ x, y: 0 }).x);
    const seg = `M${sx} 0V${v.H}`;
    if (isMajor(x)) majorD += seg; else minorD += seg;
  }
  guard = 0;
  for (let y = y0; y <= vis.maxY && guard++ < 600; y += minor) {
    const sy = fs(v.toScreen({ x: 0, y }).y);
    const seg = `M0 ${sy}H${v.W}`;
    if (isMajor(y)) majorD += seg; else minorD += seg;
  }
  const o = v.toScreen({ x: 0, y: 0 });
  return `<path d="${minorD}" stroke="#eef0f3" stroke-width="1"/><path d="${majorD}" stroke="#dde1e7" stroke-width="1"/>` +
    `<path d="M${fs(o.x)} 0V${v.H}M0 ${fs(o.y)}H${v.W}" stroke="#c9d4e3" stroke-width="1"/>`;
}

// ───────────── world layer ─────────────
export function renderWorld(app: App): string {
  const out: string[] = [];
  const line = app.sizeLine();
  const selected = new Set(app.sel.pieces);
  for (const p of app.pieces()) {
    if (app.hiddenPieces.has(p.id)) continue;
    const L = layoutOf(p);
    const tf = `translate(${f(L.x)} ${f(L.y)})${L.angleDeg ? ` rotate(${f(L.angleDeg)})` : ''}`;
    const isSel = selected.has(p.id);
    const active = app.sizeOf(p);
    const g: string[] = [`<g transform="${tf}" data-piece="${p.id}">`];
    let r;
    try { r = resolveFor(app.doc, p, active); } catch (err) { console.error(err); continue; }
    // fill (cut polygon) for visual mass
    const cutPts = r.cut.length > 2 ? r.cut : r.sew.pts;
    g.push(`<path d="${pathD(cutPts, true)}" fill="${isSel ? 'rgba(78,161,255,0.07)' : 'rgba(30,40,60,0.025)'}" stroke="none"/>`);
    if (app.nested) {
      for (const sid of app.doc.sizesOf(p)) {
        if (app.nestedHidden.has(sid) || sid === active) continue;
        let rs; try { rs = resolveFor(app.doc, p, sid); } catch { continue; }
        g.push(`<path d="${pathD(rs.sew.pts, rs.sew.closed)}" class="ns" stroke="${sizeColor(line, sid)}" stroke-width="1" fill="none"/>`);
        for (const ic of rs.internals) g.push(`<path d="${pathD(ic.pts, ic.closed)}" class="ns" stroke="${sizeColor(line, sid)}" stroke-width="0.7" fill="none" opacity="0.7"/>`);
      }
    }
    // cut line (thinner)
    if (settings.showCut && !p.noSeam && r.cut.length > 2) {
      g.push(`<path d="${pathD(r.cut, true)}" class="ns" stroke="${isSel ? '#3a78c2' : '#6b6f78'}" stroke-width="0.9" fill="none"/>`);
    }
    // sew line (solid)
    const sewColor = isSel ? ACCENT : app.nested ? sizeColor(line, active) : '#15171c';
    g.push(`<path d="${pathD(r.sew.pts, r.sew.closed)}" class="ns" stroke="${sewColor}" stroke-width="${isSel ? 2 : 1.6}" fill="none" stroke-linejoin="round"/>`);
    // internals
    p.internals.forEach((c, i) => {
      const ic = r.internals[i]; if (!ic) return;
      const dash = c.style === 'dashed' || c.type === 'fold' || c.type === 'mirror' ? ' stroke-dasharray="6 4"' : c.style === 'dotted' ? ' stroke-dasharray="1.5 3"' : '';
      g.push(`<path d="${pathD(ic.pts, ic.closed)}" class="ns" stroke="${isSel ? '#2f6fb8' : '#30343c'}" stroke-width="1.1" fill="none"${dash}/>`);
    });
    // notches (live objects, resolved through ops/notches on every displayed size)
    const notchSizes = app.nested ? [active, ...app.doc.sizesOf(p).filter(x => x !== active && !app.nestedHidden.has(x))] : [active];
    for (const sid of notchSizes) {
      const rn = notchesFor(app, p, sid);
      if (!rn.length) continue;
      let d = '', dd = '';
      for (const n of rn) for (const pl of n.cutGeometry) { const seg = pathD(pl, false); if (n.mode === 'draw') dd += seg; else d += seg; }
      const col = sid === active ? '#c0392b' : sizeColor(line, sid);
      if (d) g.push(`<path d="${d}" class="ns" stroke="${col}" stroke-width="${sid === active ? 1.4 : 0.9}" fill="none"/>`);
      if (dd) g.push(`<path d="${dd}" class="ns" stroke="${col}" stroke-width="1" stroke-dasharray="2 2" fill="none"/>`);
    }
    // drills / buttons (graded positions)
    for (const dr of p.drills) {
      let c: Vec = dr; try { c = ops.drillPosition(app.doc, p, dr, active); } catch { /* fallback base */ }
      const rr = Math.max(dr.diameter / 2, 0.5);
      const col = dr.kind === 'button' ? '#16a085' : dr.kind === 'buttonhole' ? '#d35400' : '#8e44ad';
      const dash = dr.mode === 'draw' ? ' stroke-dasharray="1.5 1.5"' : '';
      if (dr.kind === 'buttonhole') g.push(`<path d="M${f(c.x - rr)} ${f(c.y)}H${f(c.x + rr)}" class="ns" stroke="${col}" stroke-width="1.4"${dash}/>`);
      else g.push(`<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(rr)}" class="ns" stroke="${col}" stroke-width="1" fill="none"${dash}/>` +
        `<path d="M${f(c.x - rr * 1.6)} ${f(c.y)}H${f(c.x + rr * 1.6)}M${f(c.x)} ${f(c.y - rr * 1.6)}V${f(c.y + rr * 1.6)}" class="ns" stroke="${col}" stroke-width="0.8"/>`);
    }
    // artwork (true size, y-up world → flip the image upright)
    for (const aw of p.artwork) {
      let c: Vec = aw; try { c = ops.gradedPosition(app.doc, p.id, aw.id, active); } catch { /* base */ }
      g.push(`<g transform="translate(${f(c.x)} ${f(c.y)}) rotate(${f(aw.angleDeg)}) scale(${f(aw.scaleX)} ${f(-aw.scaleY)})" opacity="0.85"><image href="${esc(aw.src)}" x="${f(-aw.width / 2)}" y="${f(-aw.height / 2)}" width="${f(aw.width)}" height="${f(aw.height)}" preserveAspectRatio="none"/><rect x="${f(-aw.width / 2)}" y="${f(-aw.height / 2)}" width="${f(aw.width)}" height="${f(aw.height)}" class="ns" fill="none" stroke="#9b59b6" stroke-width="0.8" stroke-dasharray="3 2"/></g>`);
    }
    // reference block
    if (settings.showReference && p.reference) {
      try {
        const ref = ops.showReference(app.doc, p.id, active);
        if (ref) g.push(`<path d="${pathD(ref.sew, true)}${ref.internals.map(q => pathD(q, false)).join('')}" class="ns" stroke="#e67e22" stroke-width="0.9" stroke-dasharray="5 3" fill="none" opacity="0.8"/>`);
      } catch { /* ignore */ }
    }
    // half piece axis
    if (p.half) g.push(`<path d="M${f(p.half.a.x)} ${f(p.half.a.y)}L${f(p.half.b.x)} ${f(p.half.b.y)}" class="ns" stroke="#16a085" stroke-width="1.2" stroke-dasharray="8 3 2 3"/>`);
    g.push('</g>');
    out.push(g.join(''));
  }
  return out.join('');
}

// ───────────── overlay layer ─────────────
export function renderOverlay(app: App): string {
  const v = app.view;
  const out: string[] = [];
  const line = app.sizeLine();
  // guides
  settings.guides.forEach((gd, i) => {
    if (gd.axis === 'x') {
      const sx = fs(v.toScreen({ x: gd.pos, y: 0 }).x);
      out.push(`<line x1="${sx}" y1="0" x2="${sx}" y2="${v.H}" stroke="#18b4c8" stroke-width="1"/><line x1="${sx}" y1="0" x2="${sx}" y2="${v.H}" stroke="transparent" stroke-width="7" data-hit="guide" data-guide="${i}" style="cursor:ew-resize"/>`);
    } else {
      const sy = fs(v.toScreen({ x: 0, y: gd.pos }).y);
      out.push(`<line x1="0" y1="${sy}" x2="${v.W}" y2="${sy}" stroke="#18b4c8" stroke-width="1"/><line x1="0" y1="${sy}" x2="${v.W}" y2="${sy}" stroke="transparent" stroke-width="7" data-hit="guide" data-guide="${i}" style="cursor:ns-resize"/>`);
    }
  });

  const selected = new Set(app.sel.pieces);
  const anchorsOut: string[] = [];
  const hitAnchors: string[] = [];
  const handlesOut: string[] = [];
  const hitHandles: string[] = [];

  for (const p of app.pieces()) {
    if (app.hiddenPieces.has(p.id)) continue;
    const isSel = selected.has(p.id);
    const active = app.sizeOf(p);
    let r; try { r = resolveFor(app.doc, p, active); } catch { continue; }
    // label + grain
    const ga = v.toScreen(toWorld(p, r.grain.a)), gb = v.toScreen(toWorld(p, r.grain.b));
    out.push(grainArrow(ga, gb, isSel ? ACCENT : '#555b66'));
    const cen = labelPoint(r.sew.pts.map(q => v.toScreen(toWorld(p, q))));
    const sizeName = line.sizes.find(s => s.id === active)?.name ?? '';
    out.push(`<text x="${fs(cen.x)}" y="${fs(cen.y)}" class="plabel${isSel ? ' sel' : ''}" text-anchor="middle">${esc(p.name)}</text>` +
      `<text x="${fs(cen.x)}" y="${fs(cen.y + 13)}" class="psub" text-anchor="middle">${esc(sizeName)}${p.locked ? ' · locked' : ''}</text>`);

    // text annotations (screen space so glyphs stay upright)
    for (const t of p.texts) {
      let tp: Vec = t; try { tp = ops.textPosition(app.doc, p, t, active); } catch { /* base */ }
      const sp = v.toScreen(toWorld(p, tp));
      const px = Math.max(6, t.size * v.scale);
      const ang = -(t.angleDeg + layoutOf(p).angleDeg);
      out.push(`<text x="${fs(sp.x)}" y="${fs(sp.y)}" font-size="${fs(px)}" fill="#2c3e50" text-anchor="middle" dominant-baseline="middle" transform="rotate(${fs(ang)} ${fs(sp.x)} ${fs(sp.y)})">${esc(t.text)}</text>`);
    }
    // cut-line corner indices (where cut-line notches / corners land)
    if (settings.showCutCorners && isSel && !p.noSeam) {
      try {
        const cl = ops.cutLineForSize(p, line, active);
        cl.cornerIndex.forEach((ci, k) => {
          const q = cl.pts[ci]; if (!q) return;
          const s2 = v.toScreen(toWorld(p, q));
          out.push(`<circle cx="${fs(s2.x)}" cy="${fs(s2.y)}" r="3" fill="#fff" stroke="#3a78c2" stroke-width="1.2"/><text x="${fs(s2.x + 5)}" y="${fs(s2.y - 5)}" class="cc-idx">${k + 1}·${ci}</text>`);
        });
      } catch { /* ignore */ }
    }
    if (settings.showRuleNames && (isSel || settings.showAllAnchors)) {
      p.sew.points.forEach((a, ai) => {
        if (!a.ruleId) return;
        let nm = ''; try { nm = ops.ruleName(app.doc, p.id, a.id); } catch { return; }
        if (!nm) return;
        const s2 = v.toScreen(toWorld(p, r.sew.anchorPos[ai]));
        out.push(`<text x="${fs(s2.x + 7)}" y="${fs(s2.y + 12)}" class="rule-name">${esc(nm)}</text>`);
      });
    }
    const showAnchors = isSel || settings.showAllAnchors;
    if (!showAnchors) continue;
    const sizesToDraw: SizeId[] = app.nested && isSel
      ? [active, ...app.doc.sizesOf(p).filter(s => s !== active && !app.nestedHidden.has(s))]
      : [active];
    for (const sid of sizesToDraw) {
      const isActive = sid === active;
      let rs; try { rs = isActive ? r : resolveFor(app.doc, p, sid); } catch { continue; }
      const contours = [p.sew, ...p.internals];
      const resolved = [rs.sew, ...rs.internals];
      contours.forEach((c, ci) => {
        const rc = resolved[ci]; if (!rc) return;
        c.points.forEach((a, ai) => {
          if (!isActive && a.kind !== 'grade') return; // nested sizes: grade anchors only
          if (!isSel && a.kind !== 'grade') return;     // unselected pieces: grade anchors only
          const s = v.toScreen(toWorld(p, rc.anchorPos[ai]));
          const selA = isActive && app.isAnchorSelected({ anchorId: a.id });
          const col = !isActive ? sizeColor(line, sid) : selA ? ACCENT : isSel ? '#1d2330' : '#7b8190';
          const fill = selA ? ACCENT : '#ffffff';
          const sz = isSel ? 3.6 : 2.6;
          if (a.kind === 'grade') anchorsOut.push(`<rect x="${fs(s.x - sz)}" y="${fs(s.y - sz)}" width="${fs(sz * 2)}" height="${fs(sz * 2)}" fill="${fill}" stroke="${col}" stroke-width="1.3"/>`);
          else anchorsOut.push(`<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="${fs(sz * 0.9)}" fill="${fill}" stroke="${col}" stroke-width="1.2"/>`);
          if (a.flags.startPoint && c === p.sew && isActive) anchorsOut.push(`<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="7" fill="none" stroke="#e67e22" stroke-width="1"/>`);
          if (a.flags.locked && isActive) anchorsOut.push(`<path d="M${fs(s.x + 4)} ${fs(s.y - 9)}h5v4h-5z" fill="#888"/>`);
          // ~9 px anchor hit target
          hitAnchors.push(`<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="9" fill="transparent" data-hit="anchor" data-piece="${p.id}" data-contour="${c.id}" data-anchor="${a.id}" data-size="${sid}" style="cursor:move"/>`);
          // handles for selected anchors (active size, smooth or explicit)
          if (selA && (a.smooth || a.hIn || a.hOut)) {
            const hh = rc.handles[ai];
            const n = c.points.length;
            const hasIn = c.closed || ai > 0, hasOut = c.closed || ai < n - 1;
            for (const which of ['in', 'out'] as const) {
              if (which === 'in' ? !hasIn : !hasOut) continue;
              const hp = which === 'in' ? hh.hIn : hh.hOut;
              const hs = v.toScreen(toWorld(p, hp));
              if (Math.hypot(hs.x - s.x, hs.y - s.y) < 1.5) continue;
              const explicit = which === 'in' ? !!a.hIn : !!a.hOut;
              handlesOut.push(`<line x1="${fs(s.x)}" y1="${fs(s.y)}" x2="${fs(hs.x)}" y2="${fs(hs.y)}" stroke="#d6309b" stroke-width="1"${explicit ? '' : ' stroke-dasharray="3 2"'}/>` +
                `<circle cx="${fs(hs.x)}" cy="${fs(hs.y)}" r="3.4" fill="${explicit ? '#d6309b' : '#fff'}" stroke="#d6309b" stroke-width="1.2"/>`);
              // 11 px invisible handle hit target, rendered topmost
              hitHandles.push(`<circle cx="${fs(hs.x)}" cy="${fs(hs.y)}" r="11" fill="transparent" data-hit="handle" data-piece="${p.id}" data-contour="${c.id}" data-anchor="${a.id}" data-which="${which}" style="cursor:grab"/>`);
            }
          }
        });
      });
    }
  }
  out.push(handlesOut.join(''), anchorsOut.join(''));
  const tool = app.tool?.overlay?.(app);
  if (tool) out.push(tool);
  out.push(hitAnchors.join(''), hitHandles.join(''));
  return out.join('');
}

function grainArrow(a: Vec, b: Vec, col: string): string {
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
  if (l < 4) return '';
  const ux = dx / l, uy = dy / l, k = 8, w = 4;
  const head = (p: Vec, sx: number, sy: number) => `M${fs(p.x - sx * k - sy * w)} ${fs(p.y - sy * k + sx * w)}L${fs(p.x)} ${fs(p.y)}L${fs(p.x - sx * k + sy * w)} ${fs(p.y - sy * k - sx * w)}`;
  return `<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}${head(b, ux, uy)}${head(a, -ux, -uy)}" stroke="${col}" stroke-width="1.2" fill="none"/>`;
}

/** label anchor: centroid of the sampled outline (screen) */
function labelPoint(pts: Vec[]): Vec {
  if (!pts.length) return { x: 0, y: 0 };
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n]; const c = p.x * q.y - q.x * p.y;
    a += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-6) return pts[0];
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

// ───────────── rulers ─────────────
export function renderRuler(app: App, axis: 'x' | 'y', lenPx: number, thick: number): string {
  const v = app.view;
  const u = settings.unit;
  const unitMm = MM_PER_UNIT[u];
  const majorW = niceStep(v.px(60) / unitMm) * unitMm;
  const sub = u === 'in' ? 8 : 10;
  const minorW = majorW / sub;
  const vis = v.visibleWorld();
  const lo = axis === 'x' ? vis.minX : vis.minY, hi = axis === 'x' ? vis.maxX : vis.maxY;
  let d = '', txt = '';
  const start = Math.floor(lo / minorW) * minorW;
  let guard = 0;
  for (let w = start; w <= hi && guard++ < 2000; w += minorW) {
    const k = Math.round(w / minorW);
    const isMaj = k % sub === 0, isHalf = !isMaj && sub % 2 === 0 && k % (sub / 2) === 0;
    const len = isMaj ? thick - 2 : isHalf ? thick * 0.45 : thick * 0.25;
    const s = axis === 'x' ? v.toScreen({ x: w, y: 0 }).x : v.toScreen({ x: 0, y: w }).y;
    if (s < -1 || s > lenPx + 1) continue;
    if (axis === 'x') d += `M${fs(s)} ${thick}V${fs(thick - len)}`; else d += `M${thick} ${fs(s)}H${fs(thick - len)}`;
    if (isMaj) {
      const val = Math.round((w / unitMm) * 1000) / 1000;
      if (axis === 'x') txt += `<text x="${fs(s + 3)}" y="10">${val}</text>`;
      else txt += `<text x="10" y="${fs(s - 3)}" transform="rotate(-90 10 ${fs(s - 3)})">${val}</text>`;
    }
  }
  // cursor marker
  let cur = '';
  if (app.cursorWorld) {
    const s = axis === 'x' ? v.toScreen(app.cursorWorld).x : v.toScreen(app.cursorWorld).y;
    cur = axis === 'x' ? `<path d="M${fs(s)} 0V${thick}" stroke="${ACCENT}"/>` : `<path d="M0 ${fs(s)}H${thick}" stroke="${ACCENT}"/>`;
  }
  return `<path d="${d}" stroke="#8a8f99" stroke-width="1" fill="none"/>${txt}${cur}`;
}

export { sizeFor };
export type { Piece };
