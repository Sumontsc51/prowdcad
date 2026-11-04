import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area, perimeter } from '../src/geom/poly';
import { bbox } from '../src/geom/vec';
import {
  addPleatAxis, addPleatByAngle, addMultiPleat, setPleatAttributes, openPleats, closePleats, openPleat, closePleat,
  pleatOpenings, deletePleat, pleatFabric,
} from '../src/ops/pleats';
import { addFullness, deleteFullness } from '../src/ops/fullness';

/** 300×400 block: CCW BL(0,0) BR(300,0) TR(300,400) TL(0,400). Right edge graded +10 x per size. */
function setup() {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const line = doc.sizeLine();
  const ids = line.sizes.map(s => s.id);
  const c = rectangleContour(0, 0, 300, 400);
  for (const i of [1, 2]) c.points[i].grade = { [ids[1]]: { dx: 10, dy: 0 }, [ids[2]]: { dx: 10, dy: 0 } };
  const piece = makePiece('SKIRT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  const [BL, BR, TR, TL] = c.points.map(a => a.id);
  return { doc, pid: piece.id, ids, line, p: () => doc.piece(piece.id), BL, BR, TR, TL };
}
const A = (doc: Document, pid: string, sz?: string) => area(doc.resolvePiece(pid, sz).sew.pts);

describe('pleats', () => {
  it('axis first (closed, dashed pleatAxis), then attributes, then open: knife inserts 2×depth', () => {
    const s = setup();
    const snap = JSON.stringify(s.p().sew);
    // vertical axis x=100 from top (start) to hem (end)
    const id = addPleatAxis(s.doc, s.pid, { x: 100, y: 400 }, { x: 100, y: 0 });
    const ax = s.p().internals[0];
    expect(ax.type).toBe('pleatAxis'); expect(ax.style).toBe('dashed');
    expect(s.p().pleats[0].open).toBe(false);
    setPleatAttributes(s.doc, s.pid, id, { type: 'knife', depthStart: 20 });
    openPleat(s.doc, s.pid, id);
    const pl = s.p().pleats[0];
    expect(pl.open).toBe(true);
    expect(pleatFabric('knife', 20)).toBe(40);
    const b = bbox(s.doc.resolvePiece(s.pid).sew.pts);
    expect(b.maxX - b.minX).toBeCloseTo(340, 9);
    expect(A(s.doc, s.pid)).toBeCloseTo(340 * 400, 6);
    expect(pleatOpenings(s.doc, s.pid, id)).toEqual({ start: 40, end: 40 });
    // default moveSide "right" of start→end: the axis points down (−y), so its right is the −x side
    expect(b.minX).toBeCloseTo(-40, 9);
    // grading still applies: L is 10 mm wider at the right edge (abs offset of L = its own increment)
    expect(A(s.doc, s.pid, s.ids[2])).toBeCloseTo(350 * 400, 6);
    // auto notches on the start-crossing edges
    const ns = s.p().notches.filter(n => n.source === 'pleat');
    expect(ns.length).toBe(2);
    expect(ns.every(n => n.placement.kind === 'anchor')).toBe(true);
    expect(ns.map(n => (n.placement as { anchorId: string }).anchorId).sort()).toEqual([pl.edges![0].fixed, pl.edges![0].moving].sort());
    for (const e of pl.edges!) for (const id2 of [e.fixed, e.moving]) expect(s.p().sew.points.find(a => a.id === id2)!.flags.pleatEdge).toBe(true);
    closePleat(s.doc, s.pid, id);
    expect(JSON.stringify(s.p().sew)).toBe(snap);
    expect(s.p().notches.length).toBe(0);
    expect(s.p().pleats[0].depthStart).toBe(20); // remembers depth
    expect(s.p().internals.length).toBe(1);      // axis kept
  });
  it('box pleat: 4×depth with centre-fold anchors', () => {
    const s = setup();
    const id = addPleatAxis(s.doc, s.pid, { x: 150, y: 400 }, { x: 150, y: 0 }, { type: 'box', depthStart: 15, moveSide: 'left' });
    openPleat(s.doc, s.pid, id);
    const b = bbox(s.doc.resolvePiece(s.pid).sew.pts);
    expect(b.maxX).toBeCloseTo(360, 9);
    expect(s.p().sew.points.length).toBe(4 + 6);
    const e = s.p().pleats[0].edges!;
    const r = s.doc.resolvePiece(s.pid).sew;
    const P = (id2: string) => r.anchorPos[s.p().sew.points.findIndex(a => a.id === id2)];
    expect(P(e[0].mid!)).toEqual({ x: 180, y: 400 });
    expect(P(e[1].mid!).x).toBeCloseTo(180, 9);
    expect(s.p().notches.length).toBe(3); // fixed, mid, moving at the start crossing
  });
  it('variable depth tapers the opening (start 20 → end 5)', () => {
    const s = setup();
    const id = addPleatAxis(s.doc, s.pid, { x: 100, y: 0 }, { x: 100, y: 400 }, { depthStart: 20, depthEnd: 5 });
    openPleat(s.doc, s.pid, id);
    const o = pleatOpenings(s.doc, s.pid, id);
    expect(o.start).toBeCloseTo(40, 9);
    expect(o.end).toBeCloseTo(10, 9);
    // rotation centre C on the axis with |CS|:|CH| = 40:10 → |CS| = 1600/3, |CH| = 400/3;
    // inserted quad S S' H' H = ½(|CS|² − |CH|²)·sin φ, φ = 2·asin(20 / |CS|)  (= 9992.966 mm²)
    const RS = 1600 / 3, RH = 400 / 3, phi = 2 * Math.asin(20 / RS);
    expect(A(s.doc, s.pid) - 120000).toBeCloseTo(0.5 * (RS * RS - RH * RH) * Math.sin(phi), 6);
  });
  it('multi pleat + open/close all non-destructively; add by angle', () => {
    const s = setup();
    const snap = JSON.stringify(s.p().sew);
    const ids = addMultiPleat(s.doc, s.pid, s.BL, 3, { depthStart: 10 });
    expect(ids.length).toBe(3);
    expect(s.p().pleats.every(p => p.open)).toBe(true);
    expect(bbox(s.doc.resolvePiece(s.pid).sew.pts).maxX - bbox(s.doc.resolvePiece(s.pid).sew.pts).minX).toBeCloseTo(360, 9);
    expect(perimeter(s.doc.resolvePiece(s.pid).sew.pts)).toBeCloseTo(1400 + 120, 9);
    closePleats(s.doc, s.pid);
    expect(JSON.stringify(s.p().sew)).toBe(snap);
    openPleats(s.doc, s.pid);
    // close a middle one only: the later ones are unwound and re-applied
    closePleats(s.doc, s.pid, [ids[1]]);
    expect(s.p().pleats.map(p => p.open)).toEqual([true, false, true]);
    expect(A(s.doc, s.pid)).toBeCloseTo(340 * 400, 6);
    closePleats(s.doc, s.pid);
    expect(JSON.stringify(s.p().sew)).toBe(snap);
    const a = addPleatByAngle(s.doc, s.pid, { fromAnchorId: s.BL, distance: 100 }, 45);
    const pl = s.p().pleats.find(p => p.id === a)!;
    expect(pl.axisStart.x).toBeCloseTo(100, 9); expect(pl.axisStart.y).toBeCloseTo(0, 9);
    expect(pl.axisEnd.x).toBeCloseTo(300, 9); expect(pl.axisEnd.y).toBeCloseTo(200, 9);
    deletePleat(s.doc, s.pid, a);
    expect(s.p().pleats.length).toBe(3);
  });
  it('pleats and fullness share a LIFO stack: closing a pleat under a fullness record restores exactly', () => {
    const s = setup();
    const snap = JSON.stringify(s.p().sew);
    const pid = addPleatAxis(s.doc, s.pid, { x: 100, y: 400 }, { x: 100, y: 0 }, { depthStart: 10 });
    openPleat(s.doc, s.pid, pid);
    const fid = addFullness(s.doc, s.pid, { slash: { fromAnchorId: s.BR, distance: 200 }, pivot: { fromAnchorId: s.TL, distance: 200 }, openA: 30, openB: 30, mode: 'parallel' });
    closePleat(s.doc, s.pid, pid);
    expect(A(s.doc, s.pid)).toBeCloseTo(120000 + 30 * 300, 6);
    deleteFullness(s.doc, s.pid, fid);
    expect(JSON.stringify(s.p().sew)).toBe(snap);
  });
});
