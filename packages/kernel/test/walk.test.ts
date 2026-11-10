import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint, rectangleContour, newId } from '../src/model/factory';
import { resolveContour, totalLength } from '../src/model/contour';
import type { Contour, Piece } from '../src/model/types';
import { startWalk, walkStep, walkTo, flipDirection, walkReport, pieceTransform, applyTransform, dropNotch } from '../src/ops/walk';
import { rotate, dist } from '../src/geom/vec';

function setup() {
  const doc = new Document(makeStyle('w', ['S', 'M', 'L'], 'M'));
  const line = doc.sizeLine();
  const [S, M, L] = line.sizes.map(s => s.id);
  return { doc, line, S, M, L };
}
function add(doc: Document, name: string, c: Contour): Piece {
  const p = makePiece(name, c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(p));
  return p;
}
/** Panel with a curved top seam (between grade anchors 2 and 3), graded the same in L and S. */
function curvedPanel(L: string, S: string, ox = 0, oy = 0, rot = 0): Contour {
  const g = (dx: number, dy: number) => ({ [L]: { dx, dy }, [S]: { dx: -dx, dy: -dy } });
  const P = (x: number, y: number) => rotate({ x: x + ox, y: y + oy }, rot, { x: ox, y: oy });
  const gv = (dx: number, dy: number) => { const v = rotate({ x: dx, y: dy }, rot); return g(v.x, v.y); };
  const pts = [
    gradePoint(P(0, 0).x, P(0, 0).y),
    gradePoint(P(120, 0).x, P(120, 0).y, { grade: gv(6, 0) }),
    gradePoint(P(120, 80).x, P(120, 80).y, { grade: gv(6, 4) }),
    curvePoint(P(80, 110).x, P(80, 110).y),
    curvePoint(P(30, 95).x, P(30, 95).y),
    gradePoint(P(0, 80).x, P(0, 80).y, { grade: gv(0, 4) }),
  ];
  return makeContour(pts);
}

describe('walk tool (A4)', () => {
  it('D4a: walk ratio 2:1 advances the moving piece 2× the stationary', () => {
    const { doc } = setup();
    const a = add(doc, 'A', rectangleContour(0, 0, 200, 50));
    const b = add(doc, 'B', rectangleContour(300, 100, 300, 50));
    let st = startWalk(doc, { stationaryPieceId: a.id, stationaryAnchorId: a.sew.points[0].id, movingPieceId: b.id, movingAnchorId: b.sew.points[0].id, direction: 'forward', options: { walkRatio: 2 } });
    st = walkStep(st, 10);
    let rep = walkReport(st);
    expect(rep.stationary).toBeCloseTo(10, 9);
    expect(rep.moving).toBeCloseTo(20, 9);
    expect(rep.delta).toBeCloseTo(10, 9);
    expect(rep.stationaryPoint.x).toBeCloseTo(10, 9);
    expect(rep.movingPoint.x).toBeCloseTo(320, 9);
    st = walkTo(st, 45);
    rep = walkReport(st);
    expect(rep.stationary).toBeCloseTo(45, 9);
    expect(rep.moving).toBeCloseTo(90, 9);
    st = walkStep(st, -5);
    expect(walkReport(st).stationary).toBeCloseTo(40, 9);
    expect(walkReport(st).moving).toBeCloseTo(80, 9);
    // transform puts the moving contact on the stationary contact
    const t = pieceTransform(st);
    const m = applyTransform(t, walkReport(st).movingPoint);
    expect(dist(m, walkReport(st).stationaryPoint)).toBeLessThan(1e-9);
    expect(t.rotateRad).toBeCloseTo(0, 12);
  });

  it('transform tangent-aligns the moving contour to the stationary contour', () => {
    const { doc } = setup();
    const a = add(doc, 'A', rectangleContour(0, 0, 100, 100));
    // moving piece rotated 90°: its bottom edge runs along +Y
    const c = rectangleContour(0, 0, 100, 100);
    for (const p of c.points) { const q = rotate(p, Math.PI / 2, { x: 0, y: 0 }); p.x = q.x + 500; p.y = q.y; }
    const b = add(doc, 'B', c);
    let st = startWalk(doc, { stationaryPieceId: a.id, stationaryAnchorId: a.sew.points[0].id, movingPieceId: b.id, movingAnchorId: b.sew.points[0].id, direction: 'forward' });
    st = walkStep(st, 30);
    const t = pieceTransform(st);
    expect(t.rotateRad).toBeCloseTo(-Math.PI / 2, 9);
    // a second point further along the moving edge lands on the stationary edge
    const ahead = applyTransform(t, { x: 500, y: 60 });
    expect(ahead.x).toBeCloseTo(60, 9); expect(ahead.y).toBeCloseTo(0, 9);
    // walk round the corner: stationary pivots at (100,0) to the right edge
    st = walkTo(st, 120);
    const t2 = pieceTransform(st);
    const rep = walkReport(st);
    expect(rep.stationaryPoint.x).toBeCloseTo(100, 9); expect(rep.stationaryPoint.y).toBeCloseTo(20, 9);
    // both now walk +90° from their first edge ⇒ relative rotation unchanged
    expect(t2.rotateRad).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('flipDirection reverses mid-walk and running length keeps counting', () => {
    const { doc } = setup();
    const a = add(doc, 'A', rectangleContour(0, 0, 100, 50));
    const b = add(doc, 'B', rectangleContour(0, 200, 100, 50));
    let st = startWalk(doc, { stationaryPieceId: a.id, stationaryAnchorId: a.sew.points[0].id, movingPieceId: b.id, movingAnchorId: b.sew.points[1].id, direction: { stationary: 'forward', moving: 'backward' } });
    st = walkStep(st, 20);
    expect(walkReport(st).movingPoint.x).toBeCloseTo(80, 9);
    st = flipDirection(st);
    st = walkStep(st, 5);
    const r = walkReport(st);
    expect(r.movingPoint.x).toBeCloseTo(85, 9);
    expect(r.moving).toBeCloseTo(25, 9);
    expect(r.stationary).toBeCloseTo(25, 9);
    // closed contour wraps backwards past the start point
    st = walkStep(startWalk(doc, { stationaryPieceId: a.id, stationaryAnchorId: a.sew.points[0].id, movingPieceId: b.id, movingAnchorId: b.sew.points[0].id, direction: 'backward' }), 10);
    expect(walkReport(st).stationaryPoint.x).toBeCloseTo(0, 9);
    expect(walkReport(st).stationaryPoint.y).toBeCloseTo(10, 9);
  });

  it('skipDarts hops over the dart opening without consuming length', () => {
    const { doc } = setup();
    const legA = gradePoint(40, 0, { flags: { dartLeg: true } }), legB = gradePoint(56, 0, { flags: { dartLeg: true } });
    const c = makeContour([gradePoint(0, 0), legA, legB, gradePoint(150, 0), gradePoint(150, 80), gradePoint(0, 80)]);
    const a = add(doc, 'A', c);
    doc.transact('dart', () => doc.piece(a.id).darts.push({ id: newId('d'), legA: legA.id, legB: legB.id, apex: { x: 48, y: 60, grade: {} }, fold: 'A', drillOffset: 10, closed: false }));
    const b = add(doc, 'B', rectangleContour(0, 200, 200, 50));
    const mk = (skipDarts: boolean) => walkTo(startWalk(doc, { stationaryPieceId: a.id, stationaryAnchorId: c.points[0].id, movingPieceId: b.id, movingAnchorId: b.sew.points[0].id, direction: 'forward', options: { skipDarts } }), 60);
    const on = walkReport(mk(true)), off = walkReport(mk(false));
    expect(off.stationaryPoint.x).toBeCloseTo(60, 9);
    expect(on.stationaryPoint.x).toBeCloseTo(76, 9);
    expect(on.stationary).toBeCloseTo(60, 9);
    expect(on.moving).toBeCloseTo(60, 9);
    // backwards through the dart too
    const back = walkReport(walkStep(mk(true), -30));
    expect(back.stationaryPoint.x).toBeCloseTo(30, 9);
    expect(back.stationary).toBeCloseTo(30, 9);
  });

  it('D4b: ratio 1 on two pieces sharing an equal-length (curved) edge → dropped notch pairs coincide', () => {
    const { doc, line, S, M, L } = setup();
    const a = add(doc, 'A', curvedPanel(L, S));
    const b = add(doc, 'B', curvedPanel(L, S, 400, 300, 0.7)); // congruent copy, rotated + moved
    let st = startWalk(doc, { stationaryPieceId: a.id, stationaryAnchorId: a.sew.points[2].id, movingPieceId: b.id, movingAnchorId: b.sew.points[2].id, direction: 'forward', options: { supportNotchType: 'T' } });
    const ids: { stationary?: string; moving?: string }[] = [];
    for (const d of [25, 60, 95]) { st = walkTo(st, d); ids.push(dropNotch(doc, st, 'both')); }
    const pa = doc.piece(a.id), pb = doc.piece(b.id);
    expect(pa.notches.length).toBe(3); expect(pb.notches.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      const na = pa.notches.find(n => n.id === ids[i].stationary)!, nb = pb.notches.find(n => n.id === ids[i].moving)!;
      expect(na.source).toBe('walk'); expect(na.type).toBe('T');
      expect(na.placement.kind).toBe('fromPrev');
      if (na.placement.kind !== 'fromPrev' || nb.placement.kind !== 'fromPrev') throw new Error();
      expect(na.placement.anchorId).toBe(pa.sew.points[2].id);
      expect(nb.placement.anchorId).toBe(pb.sew.points[2].id);
      for (const s of [S, M, L]) expect(Math.abs(na.placement.dist[s] - nb.placement.dist[s])).toBeLessThan(0.01);
      expect(na.placement.dist[M]).toBeCloseTo([25, 60, 95][i], 9);
      // proportional across sizes
      const segLen = (sz: string) => { const r = resolveContour(pa.sew, line, sz); return r.cum[r.anchorIndex[5]] - r.cum[r.anchorIndex[2]]; };
      expect(na.placement.dist[L] / segLen(L)).toBeCloseTo(na.placement.dist[M] / segLen(M), 12);
    }
    // sewn flat: the moving notch position maps onto the stationary one through the walk transform
    const rep = walkReport(st);
    expect(dist(applyTransform(pieceTransform(st), rep.movingPoint), rep.stationaryPoint)).toBeLessThan(1e-9);
  });

  it('dropNotch on one side only; preceding grade anchor is found past a wrap', () => {
    const { doc } = setup();
    const a = add(doc, 'A', rectangleContour(0, 0, 100, 50));
    const b = add(doc, 'B', rectangleContour(0, 200, 100, 50));
    let st = startWalk(doc, { stationaryPieceId: a.id, stationaryAnchorId: a.sew.points[3].id, movingPieceId: b.id, movingAnchorId: b.sew.points[0].id, direction: 'forward' });
    st = walkStep(st, 70); // 50 up the left edge (wraps to start) + 20 along the bottom
    dropNotch(doc, st, 'stationary');
    const pa = doc.piece(a.id);
    expect(doc.piece(b.id).notches.length).toBe(0);
    const n = pa.notches[0];
    if (n.placement.kind !== 'fromPrev') throw new Error();
    expect(n.placement.anchorId).toBe(pa.sew.points[0].id);
    expect(n.placement.dist[doc.baseSize(pa)]).toBeCloseTo(20, 9);
    expect(totalLength(doc.resolvePiece(a.id).sew)).toBeCloseTo(300, 9);
  });
});
