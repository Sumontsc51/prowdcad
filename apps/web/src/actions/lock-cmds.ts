/**
 * Internal-line locks (kernel ops/lock): Segment ▸ Lock internal to segment… / Unlock, the right-click
 * entries on an internal line, and the helpers the Inspector uses.
 *
 *  - Endpoints on segment: every end of the line that lies on the outline stays on its segment
 *    (proportional, or a fixed distance from the segment start / end).
 *  - Parallel to segment: the line is regenerated as the exact offset of a sew segment (topstitch,
 *    facing, placement line), in every size.
 *  - Follow point: the line moves rigidly with a sew point, per size (pockets).
 */
import { pointAtLength, type Contour, type LockMeasure, type Piece, type Id } from '@prowdcad/kernel';
import type { App } from '../app';
import { registerCommand } from '../commands';
import { needs } from './cmd-util';
import { ops } from '../ops-bridge';
import { pick } from '../tools/pick';
import { internalOrPick, Cancelled } from '../selection';
import { showDialog } from '../ui/dialog';
import { toast } from '../ui/toast';
import { resolveFor } from '../geometry';
import { fmt, unitLabel } from '../units-ui';

export type LockKind = 'none' | 'ends' | 'parallel' | 'follow';
export const LOCK_KINDS: [LockKind, string][] = [['none', 'None'], ['ends', 'Endpoints on segment'], ['parallel', 'Parallel to segment'], ['follow', 'Follow point']];
export const LOCK_MEASURES: [LockMeasure, string][] = [['ratio', 'Proportional'], ['start', 'Distance from segment start'], ['end', 'Distance from segment end']];

/** The selected internal line (primary), if any. */
export function selectedInternal(app: App): { piece: Piece; contour: Contour } | null {
  const si = app.sel.internals[app.sel.internals.length - 1];
  if (si) { const p = app.doc.style.pieces.find(x => x.id === si.pieceId); const c = p?.internals.find(x => x.id === si.contourId); if (p && c) return { piece: p, contour: c }; }
  const a = app.sel.anchors[app.sel.anchors.length - 1];
  if (a) { const p = app.doc.style.pieces.find(x => x.id === a.pieceId); const c = p?.internals.find(x => x.id === a.contourId); if (p && c) return { piece: p, contour: c }; }
  return null;
}

/** Base-size midpoint of an internal line (piece frame). */
function midOf(app: App, piece: Piece, c: Contour) {
  const r = resolveFor(app.doc, piece, app.doc.baseSize(piece)).internals[piece.internals.indexOf(c)];
  if (!r || !r.pts.length) return c.points[0];
  return pointAtLength(r.closed ? [...r.pts, r.pts[0]] : r.pts, (r.cum[r.cum.length - 1] ?? 0) / 2).pt;
}

async function pickSegment(app: App, piece: Piece, prompt: string): Promise<{ from: Id; to: Id }> {
  const res = await pick(app, { kind: 'contour', prompt, contour: 'sew', pieceId: piece.id });
  if (!res || res === 'done' || res.kind !== 'contour') throw new Cancelled();
  if (!res.hit.from || !res.hit.to) throw new Error('Click a sew segment between two grade points');
  return { from: res.hit.from, to: res.hit.to };
}
async function pickSewPoint(app: App, piece: Piece, prompt: string): Promise<Id> {
  const res = await pick(app, { kind: 'anchor', prompt, contour: 'sew', pieceId: piece.id });
  if (!res || res === 'done' || res.kind !== 'anchor') throw new Cancelled();
  return res.hit.ref.anchorId;
}

/** Nearest sew grade point to the line (default of Follow point). */
function nearestGrade(app: App, piece: Piece, c: Contour): Id {
  const m = midOf(app, piece, c);
  const r = resolveFor(app.doc, piece, app.doc.baseSize(piece)).sew;
  let best = piece.sew.points[0].id, bd = Infinity;
  r.gradeIdx.forEach(i => { const q = r.anchorPos[i]; const d = Math.hypot(q.x - m.x, q.y - m.y); if (d < bd) { bd = d; best = piece.sew.points[i].id; } });
  return best;
}

/**
 * Lock (or re-lock) an internal line. `kind` given = no mode question. `pickTarget` = ask for the
 * segment / point on the canvas instead of using the one under the line.
 */
export async function lockInteractive(app: App, piece: Piece, c: Contour, kind?: LockKind, o: { pickTarget?: boolean; measure?: LockMeasure } = {}): Promise<void> {
  const line = app.doc.sizeLine(piece);
  let measure: LockMeasure = o.measure ?? (c.lock && c.lock.kind !== 'follow' ? (c.lock.kind === 'ends' ? c.lock.ends[0]?.measure : c.lock.measure) ?? 'ratio' : 'ratio');
  let pickTarget = !!o.pickTarget;
  let offset: number | undefined;
  if (!kind) {
    const m = midOf(app, piece, c);
    const near = ops.sewSegmentAt(piece, line, m);
    const canEnds = !c.closed && ops.lockableEnds(piece, line, c).length > 0;
    const r = await showDialog({
      title: `Lock internal ${piece.internals.indexOf(c) + 1} to the outline`,
      fields: [
        { kind: 'select', key: 'k', label: 'Lock', value: c.lock?.kind ?? (canEnds ? 'ends' : c.closed ? 'follow' : 'parallel'), options: LOCK_KINDS.filter(([k]) => k !== 'none' && !(c.closed && k !== 'follow')).map(([value, label]) => ({ value, label })),
          hint: 'Endpoints: the ends on the outline stay on their segment · Parallel: the line is the exact offset of a segment · Follow: the line moves with one sew point' },
        { kind: 'select', key: 'm', label: 'Keep position', value: measure, options: LOCK_MEASURES.map(([value, label]) => ({ value, label })), hint: 'How a position along the segment is kept when the segment changes length or grades' },
        { kind: 'checkbox', key: 'pick', label: 'Pick the segment / point on the canvas', value: false, hint: 'Off: the segment under each end (Endpoints), under the line (Parallel), the nearest grade point (Follow)' },
        ...(!c.closed ? [{ kind: 'length' as const, key: 'off', label: 'Parallel offset (+ inside)', value: near ? Math.round(near.d * 1000) / 1000 : 10, hint: 'Parallel only: distance from the segment' }] : []),
      ],
    });
    if (!r) return;
    kind = r.k as LockKind; measure = r.m as LockMeasure; pickTarget = !!r.pick;
    if (r.off !== undefined) offset = r.off as number;
  }
  const pid = piece.id, cid = c.id;
  if (kind === 'none') { ops.unlockInternal(app.doc, pid, cid); toast('Internal line unlocked', 'ok'); return; }
  if (kind === 'ends') {
    const span = pickTarget ? await pickSegment(app, piece, 'Lock ends: click the sew segment the ends belong to') : undefined;
    const n = ops.lockInternalEnds(app.doc, pid, cid, { measure, span });
    toast(`🔒 ${n} end point${n > 1 ? 's' : ''} locked to the outline`, 'ok');
  } else if (kind === 'parallel') {
    const span = pickTarget ? await pickSegment(app, piece, 'Parallel lock: click the sew segment to follow') : (() => {
      const g = ops.sewSegmentAt(piece, line, midOf(app, piece, c)); if (!g) throw new Error('No sew segment near the line'); return { from: g.from, to: g.to };
    })();
    ops.lockInternalParallel(app.doc, pid, cid, span, { measure, offset });
    toast('🔒 Line locked parallel to the segment', 'ok');
  } else {
    const anchorId = pickTarget ? await pickSewPoint(app, piece, 'Follow lock: click the sew point the line moves with') : nearestGrade(app, piece, c);
    ops.lockInternalFollow(app.doc, pid, cid, anchorId);
    toast(`🔒 Line follows sew point ${piece.sew.points.findIndex(a => a.id === anchorId) + 1}`, 'ok');
  }
  app.applySel({ k: 'internal', c: { pieceId: pid, contourId: cid } }, 'replace');
}

export function registerLockCmds(app: App) {
  const sel = () => selectedInternal(app);
  registerCommand({ id: 'internal.lock', title: 'Lock internal to segment…', menu: 'Segment', group: 2, run: async () => {
    const { piece, contour } = await internalOrPick(app, 'Lock: click the internal line to lock to the outline');
    await lockInteractive(app, piece, contour);
  } });
  registerCommand({ id: 'internal.unlock', title: 'Unlock internal line', menu: 'Segment', group: 2,
    enabled: needs(() => !!sel()?.contour.lock, 'a selected locked internal line'),
    run: () => { const s = sel(); if (!s?.contour.lock) return; ops.unlockInternal(app.doc, s.piece.id, s.contour.id); toast('Internal line unlocked: its points move freely', 'ok'); } });
}

/** Inspector rows helper: one-line description of a lock with lengths in the display unit. */
export function lockDetail(app: App, piece: Piece, c: Contour): string {
  const L = c.lock; if (!L) return 'Free (not locked)';
  const line = app.doc.sizeLine(piece);
  const pn = (id: Id) => piece.sew.points.findIndex(a => a.id === id) + 1;
  const val = (m: LockMeasure, v: number) => (m === 'ratio' ? `${fmt(v * 100)} %` : `${fmt(v)} ${unitLabel()} from ${m === 'start' ? 'start' : 'end'}`);
  if (L.kind === 'ends') return L.ends.map(e => `${c.points[0]?.id === e.anchorId ? 'Start' : 'End'} on ${pn(e.from)}→${pn(e.to)} at ${val(e.measure, e.value)}`).join(' · ');
  if (L.kind === 'parallel') { const len = ops.lockSpanLength(piece, line, L.from, L.to); return `Segment ${pn(L.from)}→${pn(L.to)} (${fmt(len)} ${unitLabel()}) · ${val(L.measure, L.a)} … ${val(L.measure, L.b)}`; }
  return `Sew point ${pn(L.anchorId)}`;
}

