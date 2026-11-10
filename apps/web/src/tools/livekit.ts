/**
 * Shared helpers for the CLO-style creation tools (Cut Point, Dart, Pleat, Slash & spread):
 * arc-length addressing on resolved contours, the grade segment under the cursor, round-value
 * snapping (Shift), screen labels / arrows, the per-tool remembered options and input-box opening
 * at the cursor.
 */
import type { Vec, Piece, Contour, ResolvedContour, Id } from '@prowdcad/kernel';
import type { App } from '../app';
import type { Ptr } from './tool';
import { settings, saveSettings } from '../settings';
import { toWorld } from '../geometry';
import { fs } from './common';
import type { ContourHit } from '../hitkit';

export const LIVE_COL = { dart: '#d6309b', pleat: '#2e86c1', fullness: '#d35400', cut: '#7b61ff', part1: '#2e86c1', part2: '#e67e22' };

/** Last pointer position in client px (input box placement for keyboard-opened boxes). */
export const lastClient = { x: 200, y: 200 };
export function trackClient(p: Ptr) { const e = p.e as MouseEvent; if (typeof e.clientX === 'number') { lastClient.x = e.clientX; lastClient.y = e.clientY; } }
export const isNumKey = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9.]$/.test(e.key);

// ───────────── remembered tool options ─────────────
export function toolOpt<T extends string | number | boolean>(tool: string, key: string, def: T): T {
  const v = settings.toolState?.[tool]?.[key];
  return (v === undefined || typeof v !== typeof def ? def : v) as T;
}
export function setToolOpt(tool: string, key: string, v: string | number | boolean) {
  settings.toolState ??= {};
  (settings.toolState[tool] ??= {})[key] = v;
  saveSettings();
}

// ───────────── arc addressing ─────────────
export const totalLen = (rc: ResolvedContour) => rc.cum[rc.cum.length - 1] ?? 0;
export const arcOf = (rc: ResolvedContour, i: number) => rc.cum[rc.anchorIndex[i]] ?? 0;
export function wrapS(rc: ResolvedContour, s: number): number { const L = totalLen(rc); if (!rc.closed || L <= 0) return Math.max(0, Math.min(L, s)); let w = s % L; if (w < 0) w += L; return w; }
/** forward distance s0 → s1 (closed: modulo the length) */
export function fwdS(rc: ResolvedContour, s0: number, s1: number): number { if (!rc.closed) return s1 - s0; const L = totalLen(rc); let d = (s1 - s0) % L; if (d < 0) d += L; return d; }
/** point at arc length s (piece-local) */
export function atArc(rc: ResolvedContour, s: number): Vec {
  const P = rc.pts, C = rc.cum; if (!P.length) return { x: 0, y: 0 };
  const L = totalLen(rc); s = wrapS(rc, s);
  const n = rc.closed ? P.length : P.length - 1;
  for (let e = 0; e < n; e++) {
    const a = P[e], b = P[(e + 1) % P.length], c0 = C[e], c1 = e + 1 < C.length ? C[e + 1] : L;
    if (s <= c1 + 1e-12 || e === n - 1) { const t = c1 - c0 > 1e-12 ? Math.max(0, Math.min(1, (s - c0) / (c1 - c0))) : 0; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
  }
  return P[P.length - 1];
}
/** polyline from arc s0 forward by `len` (closed contours wrap), piece-local */
export function arcPoly(rc: ResolvedContour, s0: number, len: number): Vec[] {
  const out: Vec[] = [atArc(rc, s0)];
  if (len <= 1e-9) return out;
  const N = rc.pts.length;
  const rel = (i: number) => (rc.closed ? fwdS(rc, s0, rc.cum[i]) : rc.cum[i] - s0);
  const ids: number[] = [];
  for (let i = 0; i < N; i++) { const f = rel(i); if (f > 1e-9 && f < len - 1e-9) ids.push(i); }
  ids.sort((i, j) => rel(i) - rel(j));
  for (const i of ids) out.push(rc.pts[i]);
  out.push(atArc(rc, s0 + len));
  return out;
}

/** Grade segment (or open-contour end run) around arc s: boundary anchors are grade points (+ the ends of an open contour). */
export interface SegAt { iFrom: number; iTo: number; fromId: Id; toId: Id; sA: number; L: number }
export function segmentAt(c: Contour, rc: ResolvedContour, s: number): SegAt | null {
  const n = c.points.length; if (n < 2) return null;
  const bnd: number[] = [];
  c.points.forEach((a, i) => { if (a.kind === 'grade' || (!c.closed && (i === 0 || i === n - 1))) bnd.push(i); });
  if (!bnd.length) bnd.push(0);
  const Ltot = totalLen(rc);
  let best = -1, bestD = Infinity;
  for (const i of bnd) { const d = rc.closed ? fwdS(rc, arcOf(rc, i), s) : s - arcOf(rc, i); if (d >= -1e-9 && d < bestD) { bestD = d; best = i; } }
  if (best < 0) best = bnd[0];
  const k = bnd.indexOf(best);
  let iTo: number;
  if (k + 1 < bnd.length) iTo = bnd[k + 1]; else iTo = c.closed ? bnd[0] : n - 1;
  const sA = arcOf(rc, best);
  let L = rc.closed ? fwdS(rc, sA, arcOf(rc, iTo)) : arcOf(rc, iTo) - sA;
  if (rc.closed && L < 1e-9) L = Ltot;
  return { iFrom: best, iTo, fromId: c.points[best].id, toId: c.points[iTo].id, sA, L };
}

/** Shift snapping step in mm: 5 mm (metric) or 1/8" (inch display). */
export const roundStep = () => (settings.unit === 'in' ? 25.4 / 8 : 5);
export const roundTo = (v: number, step = roundStep()) => Math.round(v / step) * step;

// ───────────── screen helpers ─────────────
export function label(s: Vec, text: string, o: { col?: string; anchor?: 'start' | 'middle' | 'end'; dy?: number } = {}): string {
  const t = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<text x="${fs(s.x)}" y="${fs(s.y + (o.dy ?? 0))}" class="tool-note live-note" text-anchor="${o.anchor ?? 'start'}"${o.col ? ` style="fill:${o.col}"` : ''}>${t}</text>`;
}
export function screenPoly(app: App, piece: Piece, pts: Vec[]): string {
  return pts.map((q, i) => { const s = app.view.toScreen(toWorld(piece, q)); return `${i ? 'L' : 'M'}${fs(s.x)} ${fs(s.y)}`; }).join('');
}
/** arrow from a to b (screen) */
export function arrow(a: Vec, b: Vec, col: string, w = 1.6): string {
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, hs = Math.min(7, l * 0.45);
  const p1 = { x: b.x - ux * hs - uy * hs * 0.55, y: b.y - uy * hs + ux * hs * 0.55 }, p2 = { x: b.x - ux * hs + uy * hs * 0.55, y: b.y - uy * hs - ux * hs * 0.55 };
  return `<path d="M${fs(a.x)} ${fs(a.y)}L${fs(b.x)} ${fs(b.y)}M${fs(p1.x)} ${fs(p1.y)}L${fs(b.x)} ${fs(b.y)}L${fs(p2.x)} ${fs(p2.y)}" stroke="${col}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
}
export function dot(s: Vec, col: string, r = 4.5): string { return `<circle cx="${fs(s.x)}" cy="${fs(s.y)}" r="${r}" fill="#fff" stroke="${col}" stroke-width="2"/>`; }

/** Base-size arc position of a hit, as the kernel contour position from the hit's segment start. */
export function hitSeg(app: App, h: ContourHit): SegAt | null { return segmentAt(h.contour, h.rc, h.s); }
