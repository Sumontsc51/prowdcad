/**
 * Select / Edit tool (V).
 *  click anchor            select (Shift = add/toggle)          drag  move (base size) / grade (other size)
 *  Alt-click / dbl-click   toggle corner ⇄ smooth
 *  drag handle             reshape (linked/mirrored); Alt = break handle
 *  click piece             select (Shift = toggle)              drag  translate the piece (piece.layout)
 *  drag on empty sheet     marquee (anchors of visible pieces; Shift = add)
 *  Shift while dragging    constrain H / V / 45°
 * Drags edit a preview clone and commit ONE undo step on release (Esc cancels).
 */
import type { Vec } from '@prowdcad/kernel';
import type { App } from '../app';
import type { Tool, Ptr } from './tool';
import { ICON } from './tool';
import { constrain45, toLocal, toWorld, dirToLocal, resolveFor, contourById, layoutOf, setAbsGrade } from '../geometry';
import { snapPoint } from '../canvas/snap';
import { DoubleClick } from '../ui/dom';
import { ops, type AnchorRef } from '../ops-bridge';
import { toast } from '../ui/toast';
import { fmt, unitLabel } from '../units-ui';
import { fs } from './common';

type Drag =
  | { type: 'anchors'; startW: Vec; grab: Vec; refs: AnchorRef[]; base: Map<string, Vec>; moved: boolean; sizeId: string; grade: boolean }
  | { type: 'handle'; ref: AnchorRef; which: 'in' | 'out'; alt: boolean; moved: boolean }
  | { type: 'piece'; startW: Vec; ids: string[]; base: Map<string, Vec>; moved: boolean }
  | { type: 'marquee'; a: Vec; b: Vec; additive: boolean };

let drag: Drag | null = null;
const dbl = new DoubleClick();

function toggleSmooth(app: App, ref: AnchorRef) {
  const piece = app.doc.piece(ref.pieceId);
  if (piece.locked) { toast('Piece is locked', 'warn'); return; }
  app.doc.transact('Toggle corner/smooth', () => {
    const c = contourById(piece, ref.contourId)!; const a = c.points.find(p => p.id === ref.anchorId)!;
    if (a.smooth || a.hIn || a.hOut) { a.smooth = false; delete a.hIn; delete a.hOut; app.status('Anchor → corner'); }
    else { a.smooth = true; app.status('Anchor → smooth'); }
  });
}

export const selectTool: Tool = {
  id: 'select', title: 'Select / Edit', group: 'select', hotkey: 'V', icon: ICON.select, cursor: 'default',
  deactivate(app) { if (drag) { drag = null; app.cancelPreview(); } },
  busy: () => !!drag,
  hint: () => 'Click/drag anchors & pieces · Shift add/constrain · Alt-click corner⇄smooth · Alt-drag handle = break · drag empty = marquee',

  down(app, p) {
    const e = p.e;
    const h = p.hit;
    if (h.kind === 'handle' && h.pieceId && h.anchorId) {
      const ref = { pieceId: h.pieceId, contourId: h.contourId!, anchorId: h.anchorId };
      if (app.doc.piece(ref.pieceId).locked) { toast('Piece is locked', 'warn'); return; }
      drag = { type: 'handle', ref, which: h.which!, alt: e.altKey, moved: false };
      return;
    }
    if (h.kind === 'anchor' && h.pieceId && h.anchorId) {
      const ref: AnchorRef = { pieceId: h.pieceId, contourId: h.contourId!, anchorId: h.anchorId };
      const piece = app.doc.piece(ref.pieceId);
      const sizeId = h.sizeId ?? app.sizeOf(piece);
      if (e.altKey) { toggleSmooth(app, ref); return; }
      if (dbl.hit(p.s.x, p.s.y, 'a:' + ref.anchorId)) { toggleSmooth(app, ref); return; }
      if (sizeId !== app.sizeOf(piece)) {
        // nested-size anchor: drag grading of that size
        app.selectAnchor(ref, false);
      } else if (e.shiftKey) { app.selectAnchor(ref, true); if (!app.isAnchorSelected(ref)) return; }
      else if (!app.isAnchorSelected(ref)) app.selectAnchor(ref, false);
      const line = app.sizeLine();
      const grade = sizeId !== line.baseSizeId;
      const refs = grade ? [ref] : app.sel.anchors.slice();
      const base = new Map<string, Vec>();
      for (const r of refs) {
        const rr = app.resolveRef(r); if (!rr) continue;
        const res = resolveFor(app.doc, rr.piece, grade ? sizeId : line.baseSizeId);
        const ci = rr.contour === rr.piece.sew ? -1 : rr.piece.internals.indexOf(rr.contour);
        const pos = (ci < 0 ? res.sew : res.internals[ci]).anchorPos[rr.index];
        base.set(r.anchorId, { ...pos });
      }
      const rr = app.resolveRef(ref)!;
      const grabLocal = base.get(ref.anchorId)!;
      drag = { type: 'anchors', startW: p.w, grab: toWorld(rr.piece, grabLocal), refs, base, moved: false, sizeId, grade };
      app.status(grade ? `Grading ${line.sizes.find(s => s.id === sizeId)?.name}` : '');
      return;
    }
    if (h.kind === 'piece' && h.pieceId) {
      dbl.reset();
      if (e.shiftKey) { app.selectPiece(h.pieceId, true); if (!app.sel.pieces.includes(h.pieceId)) return; }
      else if (!app.sel.pieces.includes(h.pieceId) || app.sel.anchors.length) { app.sel = { pieces: [h.pieceId], anchors: [] }; app.invalidate(); }
      const ids = app.sel.pieces.filter(id => !app.doc.piece(id).locked);
      const base = new Map(ids.map(id => { const L = layoutOf(app.doc.piece(id)); return [id, { x: L.x, y: L.y }]; }));
      drag = { type: 'piece', startW: p.w, ids, base, moved: false };
      return;
    }
    drag = { type: 'marquee', a: p.w, b: p.w, additive: e.shiftKey };
    if (!e.shiftKey) { app.sel = { pieces: [], anchors: [] }; app.invalidate(); }
  },

  move(app, p) {
    if (!drag) return;
    const e = p.e;
    const thresh = 3 / app.view.scale;
    if (drag.type === 'marquee') { drag.b = p.w; app.invalidate('canvas'); return; }
    if (drag.type === 'piece') {
      let d = { x: p.w.x - drag.startW.x, y: p.w.y - drag.startW.y };
      if (!drag.moved && Math.hypot(d.x, d.y) < thresh) return;
      drag.moved = true;
      if (e.shiftKey) { const c = constrain45({ x: 0, y: 0 }, d); d = c; }
      for (const id of drag.ids) {
        const pc = app.beginPreview(id); const b = drag.base.get(id)!; const L = layoutOf(pc);
        pc.layout = { x: b.x + d.x, y: b.y + d.y, angleDeg: L.angleDeg };
      }
      app.status(`Move ΔX ${fmt(d.x)} ΔY ${fmt(d.y)} ${unitLabel()}`);
      app.invalidate('canvas'); return;
    }
    if (drag.type === 'anchors') {
      let target = { x: drag.grab.x + p.w.x - drag.startW.x, y: drag.grab.y + p.w.y - drag.startW.y };
      if (!drag.moved && Math.hypot(p.w.x - drag.startW.x, p.w.y - drag.startW.y) < thresh) return;
      drag.moved = true;
      if (e.shiftKey) target = constrain45(drag.grab, target);
      else target = snapPoint(app, target, { exclude: new Set(drag.refs.map(r => r.anchorId)) }).p;
      const dW = { x: target.x - drag.grab.x, y: target.y - drag.grab.y };
      const line = app.sizeLine();
      for (const r of drag.refs) {
        const live = app.doc.piece(r.pieceId);
        if (live.locked) continue;
        const pc = app.beginPreview(r.pieceId);
        const c = contourById(pc, r.contourId); const a = c?.points.find(q => q.id === r.anchorId);
        if (!a || a.flags.locked) continue;
        const dl = dirToLocal(pc, dW);
        const b = drag.base.get(r.anchorId)!;
        if (drag.grade) {
          // live preview of grading: absolute offset for this size; committed via ops.dragGrade on release
          setAbsGrade(a, line, drag.sizeId, { x: b.x + dl.x - a.x, y: b.y + dl.y - a.y });
        } else { a.x = b.x + dl.x; a.y = b.y + dl.y; }
      }
      app.status(`${drag.grade ? 'Grade' : 'Move'} ΔX ${fmt(dW.x)} ΔY ${fmt(dW.y)} ${unitLabel()}`);
      app.invalidate('canvas', 'panels'); return;
    }
    if (drag.type === 'handle') {
      drag.moved = true;
      const dref = drag.ref;
      const pc = app.beginPreview(dref.pieceId);
      const c = contourById(pc, dref.contourId)!; const idx = c.points.findIndex(q => q.id === dref.anchorId);
      const a = c.points[idx];
      const res = resolveFor(app.doc, pc, app.sizeOf(pc));
      const ci = c === pc.sew ? -1 : pc.internals.indexOf(c);
      const rc = ci < 0 ? res.sew : res.internals[ci];
      const anchorPos = rc.anchorPos[idx];
      let hl = toLocal(pc, p.w);
      if (e.shiftKey) hl = constrain45(anchorPos, hl);
      const rel = { x: hl.x - anchorPos.x, y: hl.y - anchorPos.y };
      const key = drag.which === 'in' ? 'hIn' : 'hOut';
      const opp = drag.which === 'in' ? 'hOut' : 'hIn';
      // materialise the opposite handle from its current resolved position so it doesn't jump
      if (!a[opp]) { const hh = rc.handles[idx]; const op = drag.which === 'in' ? hh.hOut : hh.hIn; const v = { x: op.x - anchorPos.x, y: op.y - anchorPos.y }; if (Math.hypot(v.x, v.y) > 1e-6) a[opp] = v; }
      a[key] = rel;
      const broken = drag.alt || e.altKey;
      if (!broken && a[opp]) {
        const ol = Math.hypot(a[opp]!.x, a[opp]!.y) || 1, l = Math.hypot(rel.x, rel.y) || 1;
        a[opp] = { x: -rel.x / l * ol, y: -rel.y / l * ol };
        a.smooth = true;
      }
      a.smooth = !broken;
      app.status(`Handle ${fmt(Math.hypot(rel.x, rel.y))} ${unitLabel()} @ ${(Math.atan2(rel.y, rel.x) * 180 / Math.PI).toFixed(1)}°${broken ? ' · broken' : ''}`);
      app.invalidate('canvas', 'panels');
    }
  },

  up(app) {
    const d = drag; drag = null;
    if (!d) return;
    if (d.type === 'marquee') {
      const minX = Math.min(d.a.x, d.b.x), maxX = Math.max(d.a.x, d.b.x), minY = Math.min(d.a.y, d.b.y), maxY = Math.max(d.a.y, d.b.y);
      if ((maxX - minX) * app.view.scale < 3 && (maxY - minY) * app.view.scale < 3) { app.invalidate(); return; }
      const refs: AnchorRef[] = d.additive ? app.sel.anchors.slice() : [];
      const pieces = new Set(d.additive ? app.sel.pieces : []);
      for (const pc of app.pieces()) {
        if (app.hiddenPieces.has(pc.id)) continue;
        const r = resolveFor(app.doc, pc, app.sizeOf(pc));
        const cs = [pc.sew, ...pc.internals], rs = [r.sew, ...r.internals];
        cs.forEach((c, ci) => c.points.forEach((a, ai) => {
          const w = toWorld(pc, rs[ci].anchorPos[ai]);
          if (w.x >= minX && w.x <= maxX && w.y >= minY && w.y <= maxY && !refs.some(x => x.anchorId === a.id)) {
            refs.push({ pieceId: pc.id, contourId: c.id, anchorId: a.id }); pieces.add(pc.id);
          }
        }));
      }
      app.sel = { pieces: [...pieces], anchors: refs };
      app.status(`${refs.length} point(s) selected`);
      app.invalidate(); return;
    }
    if (d.type === 'piece') { if (d.moved) app.commitPreview('Move piece'); return; }
    if (d.type === 'handle') { if (d.moved) app.commitPreview('Edit handle'); return; }
    if (d.type === 'anchors') {
      if (!d.moved) { app.cancelPreview(); return; }
      if (d.grade) {
        // commit through the grading op (kernel) — preview is discarded first
        const targets = d.refs.map(r => { const pc = app.preview.get(r.pieceId); const res = pc ? resolveFor(app.doc, pc, d.sizeId) : null; const c = pc ? contourById(pc, r.contourId) : null; const i = c ? c.points.findIndex(q => q.id === r.anchorId) : -1; const ci = pc && c ? (c === pc.sew ? -1 : pc.internals.indexOf(c)) : -1; return res && i >= 0 ? { r, t: (ci < 0 ? res.sew : res.internals[ci]).anchorPos[i] } : null; });
        app.cancelPreview();
        for (const t of targets) if (t) ops.dragGrade(app.doc, t.r, d.sizeId, t.t);
        return;
      }
      app.commitPreview(d.refs.length > 1 ? 'Move points' : 'Move point');
    }
  },

  key(app, e) {
    if (e.key === 'Escape' && drag) { drag = null; app.cancelPreview(); return true; }
    return false;
  },

  overlay(app) {
    if (drag?.type !== 'marquee') return '';
    const a = app.view.toScreen(drag.a), b = app.view.toScreen(drag.b);
    return `<rect x="${fs(Math.min(a.x, b.x))}" y="${fs(Math.min(a.y, b.y))}" width="${fs(Math.abs(a.x - b.x))}" height="${fs(Math.abs(a.y - b.y))}" fill="rgba(78,161,255,0.08)" stroke="#4ea1ff" stroke-dasharray="4 3"/>`;
  },
};

/** Nudge selected anchors (base size) or pieces by (dx,dy) mm. */
export function nudge(app: App, dx: number, dy: number) {
  if (app.sel.anchors.length) {
    if (app.activeSize !== app.baseSize()) {
      for (const r of app.sel.anchors) {
        const q = app.resolveRef(r); if (!q) continue;
        const rs = resolveFor(app.doc, q.piece, app.activeSize);
        const qi = q.contour === q.piece.sew ? -1 : q.piece.internals.indexOf(q.contour);
        const qp = (qi < 0 ? rs.sew : rs.internals[qi]).anchorPos[q.index];
        const dl = dirToLocal(q.piece, { x: dx, y: dy });
        ops.dragGrade(app.doc, r, app.activeSize, { x: qp.x + dl.x, y: qp.y + dl.y });
      }
      return;
    }
    app.doc.transact('Nudge points', () => {
      for (const r of app.sel.anchors) {
        const q = app.resolveRef(r); if (!q || q.piece.locked || q.anchor.flags.locked) continue;
        const dl = dirToLocal(q.piece, { x: dx, y: dy });
        q.anchor.x += dl.x; q.anchor.y += dl.y;
      }
    });
  } else if (app.sel.pieces.length) {
    app.doc.transact('Nudge piece', () => {
      for (const id of app.sel.pieces) {
        const pc = app.doc.piece(id); if (pc.locked) continue;
        const L = layoutOf(pc); pc.layout = { x: L.x + dx, y: L.y + dy, angleDeg: L.angleDeg };
      }
    });
  }
}
