/**
 * CLO-style creation ops (docs/CLO-RESEARCH.md): Cut Point (addPointsOnSegment / cutPointDistances),
 * dart by two legs + apex (createDartByLegs, moveDartApex per size), pleat sets (pleatSetAxes /
 * addPleatSet, knife / box / inverted, taper), slash & spread between two lines (addFullnessBetween).
 */
import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area, perimeter } from '../src/geom/poly';
import { bbox, dist } from '../src/geom/vec';
import { addPointsOnSegment, cutPointDistances } from '../src/ops/points';
import { createDartByLegs, dartInfo, moveDartApex, dartLegSpan } from '../src/ops/darts';
import { addPleatSet, pleatSetAxes, pleatFabric, closePleats, openPleats, pleatOpenings } from '../src/ops/pleats';
import { addFullnessBetween, deleteFullness, fullnessOpenings, setFullnessOpenings, addFullness } from '../src/ops/fullness';
import { resolveContour } from '../src/model/contour';

/** 300×400 block, CCW from bottom-left: BL(0,0) BR(300,0) TR(300,400) TL(0,400). Right edge graded +10 x per size (S M L, base M). */
function setup() {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const line = doc.sizeLine();
  const ids = line.sizes.map(s => s.id);
  const c = rectangleContour(0, 0, 300, 400);
  for (const i of [1, 2]) c.points[i].grade = { [ids[1]]: { dx: 10, dy: 0 }, [ids[2]]: { dx: 10, dy: 0 } };
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  const [BL, BR, TR, TL] = c.points.map(a => a.id);
  return { doc, pid: piece.id, ids, line, p: () => doc.piece(piece.id), BL, BR, TR, TL };
}
const pos = (doc: Document, pid: string, id: string, size?: string) => {
  const r = doc.resolvePiece(pid, size), i = doc.piece(pid).sew.points.findIndex(a => a.id === id);
  return r.sew.anchorPos[i];
};
const sewJSON = (doc: Document, pid: string) => JSON.stringify(doc.resolvePiece(pid).sew.pts.map(q => [Math.round(q.x * 1e6), Math.round(q.y * 1e6)]));

describe('cut point (CLO Add Point / Divide Line)', () => {
  it('distances from start / end, ratio, divide-N (pure)', () => {
    expect(cutPointDistances(300, { distances: [100] })).toEqual([100]);
    expect(cutPointDistances(300, { distances: [100], from: 'end' })).toEqual([200]);
    expect(cutPointDistances(300, { pcts: [25] })).toEqual([75]);
    expect(cutPointDistances(300, { divide: 4 })).toEqual([75, 150, 225]);
    expect(() => cutPointDistances(300, { distances: [301] })).toThrow(/outside/);
    expect(() => cutPointDistances(300, { divide: 1 })).toThrow();
  });

  it('exact length from start / end on the hem, shape unchanged, auto grading proportional', () => {
    const s = setup();
    const A0 = area(s.doc.resolvePiece(s.pid).sew.pts), P0 = perimeter(s.doc.resolvePiece(s.pid).sew.pts);
    const [a] = addPointsOnSegment(s.doc, s.pid, s.BL, { distances: [100] });
    const [b] = addPointsOnSegment(s.doc, s.pid, s.BL, { distances: [50], from: 'end' });
    expect(pos(s.doc, s.pid, a)).toEqual({ x: 100, y: 0 });
    // the segment leaving BL now ends at a; "from the end" of BL→a is measured from a
    expect(pos(s.doc, s.pid, b).x).toBeCloseTo(50, 9);
    expect(area(s.doc.resolvePiece(s.pid).sew.pts)).toBeCloseTo(A0, 9);
    expect(perimeter(s.doc.resolvePiece(s.pid).sew.pts)).toBeCloseTo(P0, 9);
    // graded: BR moves +10 in L, the point at 100/300 moves 10·(100/300) on the hem
    const ap = pos(s.doc, s.pid, a, s.ids[2]);
    expect(ap.x - 100).toBeCloseTo(10 * (100 / 300) * (pos(s.doc, s.pid, s.BR, s.ids[2]).x - 300) / 10, 6);
    expect(s.p().sew.points.find(q => q.id === a)!.kind).toBe('grade');
  });

  it('divide into N inserts N − 1 points with notches, one undo step; zero grading option', () => {
    const s = setup();
    const n0 = s.p().sew.points.length;
    const ids = addPointsOnSegment(s.doc, s.pid, s.BL, { divide: 3, notch: true, grading: 'zero' });
    expect(ids.length).toBe(2);
    expect(s.p().sew.points.length).toBe(n0 + 2);
    expect(ids.map(id => pos(s.doc, s.pid, id).x)).toEqual([100, 200]);
    expect(s.p().notches.filter(n => n.placement.kind === 'anchor' && ids.includes(n.placement.anchorId)).length).toBe(2);
    // zero grade: the new points keep their base position in L
    for (const id of ids) expect(pos(s.doc, s.pid, id, s.ids[2]).x).toBeCloseTo(pos(s.doc, s.pid, id).x, 9);
    s.doc.undo();
    expect(s.p().sew.points.length).toBe(n0);
    expect(s.p().notches.length).toBe(0);
  });

  it('curve points on a curved internal line keep the shape (curve kind, ratio)', () => {
    const s = setup();
    const ic = makeContour([gradePoint(50, 50), curvePoint(100, 120), gradePoint(150, 50)], { closed: false, type: 'internal' });
    s.doc.transact('ic', () => { s.p().internals.push(ic); });
    const line = s.doc.sizeLine();
    const r0 = resolveContour(s.p().internals[0], line, line.baseSizeId);
    const L0 = r0.cum[r0.cum.length - 1];
    const [id] = addPointsOnSegment(s.doc, s.pid, ic.points[0].id, { pcts: [50], kind: 'curve' });
    const c = s.p().internals[0];
    const r1 = resolveContour(c, line, line.baseSizeId);
    expect(c.points.find(q => q.id === id)!.kind).toBe('curve');
    expect(r1.cum[r1.cum.length - 1]).toBeCloseTo(L0, 1);
  });
});

describe('dart by legs (CLO click-click-apex)', () => {
  it('two leg clicks + depth: width = arc between the legs, centred, apex on the bisector', () => {
    const s = setup();
    // top edge runs TR(300,400) → TL(0,400): legs at x = 160 and 140
    const id = createDartByLegs(s.doc, s.pid, { a: { fromAnchorId: s.TR, distance: 140 }, b: { fromAnchorId: s.TR, distance: 160 }, depth: 150 });
    const g = dartInfo(s.doc, s.pid, id);
    expect(g.width).toBeCloseTo(20, 9);
    expect(g.apex.x).toBeCloseTo(150, 9); expect(g.apex.y).toBeCloseTo(250, 9);
    expect(g.legLengthA).toBeCloseTo(g.legLengthB, 9);
  });
  it('legs given in reverse order and an explicit apex → Fix Dart equalizes the legs', () => {
    const s = setup();
    const id = createDartByLegs(s.doc, s.pid, { a: { fromAnchorId: s.TR, distance: 160 }, b: { fromAnchorId: s.TR, distance: 140 }, apex: { x: 170, y: 260 } });
    const g = dartInfo(s.doc, s.pid, id);
    expect(g.width).toBeCloseTo(20, 6);
    expect(Math.abs(g.legLengthA - g.legLengthB)).toBeLessThan(1e-6);
  });
  it('shorter arc across the start point of a closed contour', () => {
    const s = setup();
    const sp = dartLegSpan(s.p(), s.line, { fromAnchorId: s.BL, distance: 10 }, { fromAnchorId: s.TL, distance: 390 });
    expect(sp.width).toBeCloseTo(20, 9);
  });
  it('graded: apex graded as the mean of the legs; moveDartApex per size edits only that size', () => {
    const s = setup();
    const id = createDartByLegs(s.doc, s.pid, { a: { fromAnchorId: s.BL, distance: 140 }, b: { fromAnchorId: s.BL, distance: 160 }, depth: 100 });
    const gL0 = dartInfo(s.doc, s.pid, id, s.ids[2]);
    const gM0 = dartInfo(s.doc, s.pid, id);
    expect(gL0.apex.x).not.toBeCloseTo(gM0.apex.x, 6); // graded with the legs
    moveDartApex(s.doc, s.pid, id, { x: gL0.apex.x + 5, y: gL0.apex.y + 7 }, { sizeId: s.ids[2] });
    const gL1 = dartInfo(s.doc, s.pid, id, s.ids[2]), gM1 = dartInfo(s.doc, s.pid, id), gS1 = dartInfo(s.doc, s.pid, id, s.ids[0]);
    expect(gL1.apex.x).toBeCloseTo(gL0.apex.x + 5, 9); expect(gL1.apex.y).toBeCloseTo(gL0.apex.y + 7, 9);
    expect(gM1.apex).toEqual(gM0.apex);
    expect(gS1.apex.x).toBeCloseTo(dartInfo(s.doc, s.pid, id, s.ids[0]).apex.x, 9);
    s.doc.undo();
    expect(dartInfo(s.doc, s.pid, id, s.ids[2]).apex.x).toBeCloseTo(gL0.apex.x, 9);
  });
});

describe('pleat set (CLO Pleats)', () => {
  it('interval layout: N parallel lines toward the side; between-lines layout interpolates', () => {
    const ax = pleatSetAxes([{ x: 50, y: 400 }, { x: 50, y: 0 }], { count: 3, interval: 60, side: 'left' });
    // start→end points down (−y); left of that is +x
    expect(ax.map(a => a[0].x)).toEqual([50, 110, 170]);
    const bw = pleatSetAxes([{ x: 50, y: 400 }, { x: 50, y: 0 }], { count: 3, last: [{ x: 150, y: 400 }, { x: 250, y: 0 }] });
    expect(bw[1][0].x).toBeCloseTo(100, 9); expect(bw[1][1].x).toBeCloseTo(150, 9);
  });
  it('3 knife pleats, tapered (top 20 → hem 10): width grows by Σ fabric at top and hem; one undo step', () => {
    const s = setup();
    const before = sewJSON(s.doc, s.pid);
    const ids = addPleatSet(s.doc, s.pid, [{ x: 50, y: 400 }, { x: 50, y: 0 }], { count: 3, interval: 60, side: 'left', type: 'knife', depthStart: 20, depthEnd: 10 });
    expect(ids.length).toBe(3);
    expect(s.p().pleats.every(p => p.open)).toBe(true);
    for (const id of ids) {
      const o = pleatOpenings(s.doc, s.pid, id);
      expect(o.start).toBeCloseTo(pleatFabric('knife', 20), 6);
      expect(o.end).toBeCloseTo(pleatFabric('knife', 10), 6);
    }
    // auto notches on every pleat
    expect(s.p().notches.filter(n => n.source === 'pleat').length).toBeGreaterThanOrEqual(3 * 2);
    s.doc.undo();
    expect(s.p().pleats.length).toBe(0);
    expect(sewJSON(s.doc, s.pid)).toBe(before);
  });
  it('inverted box pleat inserts 4 × depth with a centre-fold anchor; close all restores exactly', () => {
    const s = setup();
    const before = sewJSON(s.doc, s.pid);
    addPleatSet(s.doc, s.pid, [{ x: 150, y: 400 }, { x: 150, y: 0 }], { count: 2, interval: 80, side: 'left', type: 'inverted', depthStart: 15 });
    const b = bbox(s.doc.resolvePiece(s.pid).sew.pts);
    expect(b.maxX - b.minX).toBeCloseTo(300 + 2 * pleatFabric('inverted', 15), 6);
    expect(s.p().pleats.every(p => p.edges!.every(e => !!e.mid))).toBe(true);
    closePleats(s.doc, s.pid);
    expect(sewJSON(s.doc, s.pid)).toBe(before);
    openPleats(s.doc, s.pid);
    expect(bbox(s.doc.resolvePiece(s.pid).sew.pts).maxX).toBeCloseTo(300 + 120, 6);
  });
});

describe('slash & spread between two lines', () => {
  it('N hinged slashes from the hem to the waist, openings first → last, exact delete', () => {
    const s = setup();
    const before = sewJSON(s.doc, s.pid);
    const P0 = perimeter(s.doc.resolvePiece(s.pid).sew.pts);
    // hem BL→BR: slashes at x 60 … 240; waist TR→TL: hinges at x 60 … 240 (arc from TR = 300 − x)
    const id = addFullnessBetween(s.doc, s.pid, {
      firstSlash: { fromAnchorId: s.BL, distance: 60 }, firstHinge: { fromAnchorId: s.TR, distance: 240 },
      lastSlash: { fromAnchorId: s.BL, distance: 240 }, lastHinge: { fromAnchorId: s.TR, distance: 60 },
      count: 4, firstWidth: 10, lastWidth: 40, mode: 'rotate',
    });
    const o = fullnessOpenings(s.doc, s.pid, id);
    expect(o.length).toBe(4);
    // openings in hem order (left → right) interpolate 10 → 40
    const sorted = [...o].sort((a, b) => a - b);
    sorted.forEach((x, i) => expect(x).toBeCloseTo(10 + i * 10, 6));
    expect(perimeter(s.doc.resolvePiece(s.pid).sew.pts)).toBeGreaterThan(P0 + 99);
    deleteFullness(s.doc, s.pid, id);
    expect(sewJSON(s.doc, s.pid)).toBe(before);
  });
  it('single parallel slash: the moving side translates by the opening', () => {
    const s = setup();
    const a0 = area(s.doc.resolvePiece(s.pid).sew.pts);
    addFullnessBetween(s.doc, s.pid, { firstSlash: { fromAnchorId: s.BL, distance: 150 }, firstHinge: { fromAnchorId: s.TR, distance: 150 }, count: 1, firstWidth: 30, mode: 'parallel' });
    expect(area(s.doc.resolvePiece(s.pid).sew.pts)).toBeCloseTo(a0 + 30 * 400, 3);
    expect(dist({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });
  it('edit the openings in place: same anchor ids, exact, one undo step; later spreads re-applied', () => {
    const s = setup();
    const before = sewJSON(s.doc, s.pid);
    const id = addFullnessBetween(s.doc, s.pid, {
      firstSlash: { fromAnchorId: s.BL, distance: 100 }, firstHinge: { fromAnchorId: s.TR, distance: 200 },
      lastSlash: { fromAnchorId: s.BL, distance: 200 }, lastHinge: { fromAnchorId: s.TR, distance: 100 }, count: 2, firstWidth: 20,
    });
    const later = addFullness(s.doc, s.pid, { slash: { fromAnchorId: s.BL, distance: 30 }, pivot: { fromAnchorId: s.TR, distance: 270 }, openA: 10 });
    const ids0 = s.p().sew.points.map(a => a.id).join();
    setFullnessOpenings(s.doc, s.pid, id, { widths: [30, 50] });
    expect(fullnessOpenings(s.doc, s.pid, id).map(x => Math.round(x * 1e6) / 1e6).sort((a, b) => a - b)).toEqual([30, 50]);
    expect(fullnessOpenings(s.doc, s.pid, later)[0]).toBeCloseTo(10, 6);
    expect(s.p().sew.points.map(a => a.id).join()).toBe(ids0);
    s.doc.undo();
    expect(fullnessOpenings(s.doc, s.pid, id).map(x => Math.round(x * 1e6) / 1e6)).toEqual([20, 20]);
    deleteFullness(s.doc, s.pid, later); deleteFullness(s.doc, s.pid, id);
    expect(sewJSON(s.doc, s.pid)).toBe(before);
  });
});
