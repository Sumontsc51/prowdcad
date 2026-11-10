import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area, perimeter, polylineLength } from '../src/geom/poly';
import {
  copySegment, pasteSegment, rotateSegmentPreservingLength, swapSegment, divideContour, joinContours,
  contourToDashedLines, trimAtIntersections, globalCheckAndTrimInternals, globalJoinInternals, extendContour, extendInternal,
} from '../src/ops/segments';
import { addPointOnSegment } from '../src/ops/points';

function setup(w = 100, h = 50) {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const c = rectangleContour(0, 0, w, h);
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, pid: piece.id, p: () => doc.piece(piece.id) };
}
const A = (doc: Document, id: string) => area(doc.resolvePiece(id).sew.pts);
function addInternal(doc: Document, pid: string, pts: [number, number][], curveIdx: number[] = []) {
  const c = makeContour(pts.map(([x, y], i) => (curveIdx.includes(i) ? curvePoint(x, y) : gradePoint(x, y))), { type: 'internal', closed: false });
  doc.transact('internal', () => doc.piece(pid).internals.push(c));
  return c.id;
}

describe('copy / paste segment (S1)', () => {
  it('exact, proportional-to-external and -internal', () => {
    const doc = new Document(makeStyle());
    const src = makeContour([gradePoint(0, 0), gradePoint(100, 0), curvePoint(110, 25), gradePoint(100, 50), gradePoint(0, 50)]);
    const dst = rectangleContour(200, 0, 100, 100);
    const ps = makePiece('SRC', src, doc.style.activeSizeTableId), pd = makePiece('DST', dst, doc.style.activeSizeTableId);
    doc.transact('add', s => { s.pieces.push(ps, pd); });
    const clip = copySegment(doc, ps.id, src.points[1].id, src.points[3].id);
    expect(clip.chord).toBeCloseTo(50, 9);
    expect(clip.anchors.length).toBe(3);
    expect(clip.anchors[1].x).toBeCloseTo(25, 9); expect(clip.anchors[1].y).toBeCloseTo(-10, 9); // right of travel = outward
    // proportional-to-external onto the 100 mm right edge: x stretched ×2, bulge keeps 10 mm
    const D = () => doc.piece(pd.id).sew.points;
    pasteSegment(doc, pd.id, D()[1].id, D()[2].id, clip, 'proportional-to-external');
    const m = doc.piece(pd.id).sew.points[2];
    expect(m.x).toBeCloseTo(310, 9); expect(m.y).toBeCloseTo(50, 9);
    doc.undo();
    pasteSegment(doc, pd.id, D()[1].id, D()[2].id, clip, 'proportional-to-internal');
    expect(doc.piece(pd.id).sew.points[2].x).toBeCloseTo(320, 9);
    doc.undo();
    pasteSegment(doc, pd.id, D()[1].id, D()[2].id, clip, 'exact');
    const P = doc.piece(pd.id).sew.points;
    expect(P[2].x).toBeCloseTo(310, 9); expect(P[2].y).toBeCloseTo(25, 9);
    expect(P[3].y).toBeCloseTo(50, 9); // `to` moved to the clip end
    // shape is identical: the pasted curve has the same length as the source
    const srcLen = clip.length;
    const r = doc.resolvePiece(pd.id).sew;
    const run = r.pts.slice(r.anchorIndex[1], r.anchorIndex[3] + 1);
    expect(polylineLength(run)).toBeCloseTo(srcLen, 6);
  });
});

describe('rotate segment (S2)', () => {
  it('slash-pivot keeps the length', () => {
    const { doc, pid, p } = setup();
    const a1 = p().sew.points[1].id, a2 = p().sew.points[2].id;
    rotateSegmentPreservingLength(doc, pid, a1, a2, 'from', -30);
    const P2 = p().sew.points[2];
    expect(Math.hypot(P2.x - 100, P2.y)).toBeCloseTo(50, 9);
    expect(P2.x).toBeCloseTo(100 + 50 * Math.sin(Math.PI / 6), 9);
  });
});

describe('swap segment (S3)', () => {
  it('a style line becomes perimeter, the old perimeter becomes an internal', () => {
    const { doc, pid, p } = setup();
    // V-shaped style line from (30,50) down to (50,30) and back up to (70,50)
    const iid = addInternal(doc, pid, [[30, 50], [50, 30], [70, 50]]);
    const newId = swapSegment(doc, pid, iid);
    expect(A(doc, pid)).toBeCloseTo(5000 - 400, 9);
    const internals = p().internals;
    expect(internals.length).toBe(1);
    expect(internals[0].id).toBe(newId);
    const ir = doc.resolvePiece(pid).internals[0];
    expect(polylineLength(ir.pts)).toBeCloseTo(40, 9);
    expect(p().sew.points.filter(a => a.flags.startPoint).length).toBe(1);
  });
});

describe('divide / join / dashed (S4)', () => {
  it('divide at an anchor, rejoin, dashed', () => {
    const { doc, pid, p } = setup();
    const iid = addInternal(doc, pid, [[10, 10], [50, 20], [90, 10]], [1]);
    const len0 = polylineLength(doc.resolvePiece(pid).internals[0].pts);
    const mid = p().internals[0].points[1].id;
    const parts = divideContour(doc, pid, iid, mid);
    expect(parts.length).toBe(2);
    const l = doc.resolvePiece(pid).internals.map(r => polylineLength(r.pts));
    expect(l[0] + l[1]).toBeCloseTo(len0, 3);
    const j = joinContours(doc, pid, parts[1], parts[0]);
    expect(p().internals.length).toBe(1);
    expect(polylineLength(doc.resolvePiece(pid).internals[0].pts)).toBeCloseTo(len0, 3);
    contourToDashedLines(doc, pid, j);
    expect(p().internals[0].style).toBe('dashed');
  });
  it('globalJoinInternals joins chains', () => {
    const { doc, pid, p } = setup();
    addInternal(doc, pid, [[10, 10], [20, 10]]);
    addInternal(doc, pid, [[30, 10], [20, 10]]);
    addInternal(doc, pid, [[30, 10], [30, 40]]);
    expect(globalJoinInternals(doc)).toBe(2);
    expect(p().internals.length).toBe(1);
    expect(p().internals[0].points.length).toBe(4);
  });
});

describe('trim & extend (S5)', () => {
  it('trimAtIntersections removes overhangs; with keep point keeps one part', () => {
    const { doc, pid, p } = setup();
    const iid = addInternal(doc, pid, [[-20, 25], [120, 25]]);
    trimAtIntersections(doc, pid, iid);
    expect(polylineLength(doc.resolvePiece(pid).internals[0].pts)).toBeCloseTo(100, 9);
    const cross = addInternal(doc, pid, [[40, 0], [40, 50]]);
    trimAtIntersections(doc, pid, p().internals[0].id, { keep: { x: 80, y: 25 } });
    const lens = doc.resolvePiece(pid).internals.map(r => polylineLength(r.pts)).sort((a, b) => a - b);
    expect(lens).toEqual([expect.closeTo(50, 9), expect.closeTo(60, 9)]);
    void cross;
  });
  it('globalCheckAndTrimInternals', () => {
    const { doc, pid } = setup();
    addInternal(doc, pid, [[50, -10], [50, 60]]);
    addInternal(doc, pid, [[10, 10], [20, 10]]);
    expect(globalCheckAndTrimInternals(doc)).toBe(1);
    const lens = doc.resolvePiece(pid).internals.map(r => polylineLength(r.pts)).sort((a, b) => a - b);
    expect(lens).toEqual([expect.closeTo(10, 9), expect.closeTo(50, 9)]);
  });
  it('extend by value, up to the perimeter, and shorten', () => {
    const { doc, pid, p } = setup();
    const iid = addInternal(doc, pid, [[20, 25], [60, 25]]);
    expect(extendInternal(doc, pid, iid, 'end', { by: 10 })).toBeCloseTo(50, 9);
    expect(extendContour(doc, pid, iid, 'end', { upTo: p().sew.id })).toBeCloseTo(80, 9);
    expect(extendContour(doc, pid, iid, 'start', { upTo: p().sew.id })).toBeCloseTo(100, 9);
    expect(extendContour(doc, pid, iid, 'start', { by: -30 })).toBeCloseTo(70, 9);
    expect(p().internals[0].points[0].x).toBeCloseTo(30, 9);
  });
});

void perimeter; void addPointOnSegment;

import { smoothRun } from '../src/ops/smooth';
describe('smoothRun (SM1)', () => {
  it('fairs a crooked run through kept anchors; commit replaces the intermediates', () => {
    const doc = new Document(makeStyle());
    // a circle-ish arc of radius 100 sampled with jitter
    const pts = [gradePoint(0, 0)];
    for (let k = 1; k < 20; k++) {
      const a = Math.PI - (k / 20) * Math.PI;
      const j = k % 4 === 1 ? 1.5 : k % 4 === 3 ? -1.5 : 0; // kept anchor k=10 lies on the true circle
      pts.push(curvePoint(100 + (100 + j) * Math.cos(a), (100 + j) * Math.sin(a)));
    }
    pts.push(gradePoint(200, 0));
    const c = makeContour(pts);
    const piece = makePiece('S', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    const top = c.points[10].id, topX = c.points[10].x;
    const pv = smoothRun(doc, piece.id, c.id, c.points[0].id, c.points[20].id, [top]);
    expect(pv.points.length).toBe(3);
    expect(pv.points[1].id).toBe(top);
    // proposed curve lies within ~2 mm of the jittered input and within 1 mm of the true circle
    expect(pv.maxDeviation).toBeLessThan(3);
    for (const q of pv.polyline) expect(Math.abs(Math.hypot(q.x - 100, q.y) - 100)).toBeLessThan(0.75);
    pv.commit();
    const P = doc.piece(piece.id).sew.points;
    expect(P.length).toBe(3);
    expect(P[1].id).toBe(top);
    expect(P[1].x).toBeCloseTo(topX, 9);
    // no wiggles: curvature sign constant (y strictly increasing then decreasing)
    const sp = doc.resolvePiece(piece.id).sew.pts;
    const upper = sp.filter(q => q.y > 0.5);
    let flips = 0; for (let i = 2; i < upper.length; i++) { const d1 = upper[i - 1].y - upper[i - 2].y, d2 = upper[i].y - upper[i - 1].y; if (d1 * d2 < 0) flips++; }
    expect(flips).toBe(1);
  });
});
