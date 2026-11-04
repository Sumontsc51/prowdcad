import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area } from '../src/geom/poly';
import { bbox } from '../src/geom/vec';
import { slashPiece, cutAlongInternal, cutHV, cutParallel, cutByGuideline } from '../src/ops/cut';
import { anchorAt } from '../src/ops/points';

function setup(w = 100, h = 50) {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const line = doc.sizeLine();
  const ids = line.sizes.map(s => s.id);
  const c = rectangleContour(0, 0, w, h);
  // right edge +10 x per size step
  for (const i of [1, 2]) c.points[i].grade = { [ids[1]]: { dx: 10, dy: 0 }, [ids[2]]: { dx: 10, dy: 0 } };
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, pid: piece.id, ids, line, p: () => doc.piece(piece.id) };
}
const A = (doc: Document, id: string, size?: string) => area(doc.resolvePiece(id, size).sew.pts);

describe('cutHV (C1)', () => {
  it('100×50 rectangle at x=40 → areas 2000 / 3000, names FRONT_1 / FRONT_2, original archived', () => {
    const { doc, pid, p } = setup();
    const a0 = p().sew.points[0].id;
    const [p1, p2] = cutHV(doc, pid, a0, 'V', 40, { seam: 0 });
    expect(A(doc, p1)).toBeCloseTo(2000, 9);
    expect(A(doc, p2)).toBeCloseTo(3000, 9);
    expect(doc.piece(p1).name).toBe('FRONT_1');
    expect(doc.piece(p2).name).toBe('FRONT_2');
    expect(doc.style.pieces.length).toBe(2);
    expect(doc.style.pieceArchive.map(x => x.name)).toEqual(['FRONT']);
    // FRONT_1 keeps the start point anchor id
    expect(doc.piece(p1).sew.points[0].id).toBe(a0);
    // new cut edge carries seamAfter = 0, others default
    const s1 = doc.piece(p1).sew.points.filter(a => a.seamAfter === 0).length;
    expect(s1).toBe(1);
    expect(area(doc.resolvePiece(p1).cut)).toBeCloseTo((40 + 10) * (50 + 20), 6);
    // undo restores the single piece
    doc.undo();
    expect(doc.style.pieces.map(x => x.name)).toEqual(['FRONT']);
  });
  it('gradeMode zero vs auto on the new cut anchors', () => {
    const { doc, pid, p, ids } = setup();
    const L = ids[2];
    const [, z2] = cutHV(doc, pid, p().sew.points[0].id, 'V', 50, { gradeMode: 'zero' });
    // zero: cut stays at x=50 in L; right half grows 10 in L → 60×50
    expect(A(doc, z2, L)).toBeCloseTo(60 * 50, 9);
    doc.undo();
    const [a1, a2] = cutHV(doc, pid, p().sew.points[0].id, 'V', 50, { gradeMode: 'auto' });
    // auto: cut point interpolates 50% of +10 → x=55 in L: left 55×50, right 55×50
    expect(A(doc, a1, L)).toBeCloseTo(55 * 50, 9);
    expect(A(doc, a2, L)).toBeCloseTo(55 * 50, 9);
    const zeroFlag = doc.piece(a1).sew.points.some(a => a.flags.zeroGrade);
    expect(zeroFlag).toBe(false);
  });
  it('H cut through an anchor with offset', () => {
    const { doc, pid, p } = setup();
    const [h1, h2] = cutHV(doc, pid, p().sew.points[0].id, 'H', 20);
    expect(A(doc, h1)).toBeCloseTo(2000, 9);
    expect(A(doc, h2)).toBeCloseTo(3000, 9);
  });
});

describe('cutParallel (C2)', () => {
  it('distance 30 along the top edge gives a 100×30 strip', () => {
    const { doc, pid, p } = setup(100, 80);
    const top = { from: p().sew.points[2].id, to: p().sew.points[3].id };
    const [strip, rest] = cutParallel(doc, pid, top, 30);
    expect(A(doc, strip)).toBeCloseTo(100 * 30, 6);
    expect(A(doc, rest)).toBeCloseTo(100 * 50, 6);
    const b = bbox(doc.resolvePiece(strip).sew.pts);
    expect(b.maxX - b.minX).toBeCloseTo(100, 9);
    expect(b.maxY - b.minY).toBeCloseTo(30, 9);
    expect(b.minY).toBeCloseTo(50, 9);
  });
  it('parallel to a curved waist keeps a constant 30 mm strip width', () => {
    const doc = new Document(makeStyle());
    const c = makeContour([gradePoint(0, 0), gradePoint(200, 0), gradePoint(200, 150), curvePoint(100, 170), gradePoint(0, 150)]);
    const piece = makePiece('SKIRT', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    const [strip] = cutParallel(doc, piece.id, { from: c.points[2].id, to: c.points[4].id }, 30);
    const sp = doc.resolvePiece(strip).sew.pts;
    // the bottom of the strip lies 30 mm below the waist: check the centre (waist at y=170 at x=100)
    const atCentre = sp.filter(q => Math.abs(q.x - 100) < 2).map(q => q.y);
    expect(Math.min(...atCentre)).toBeCloseTo(140, 0);
    expect(doc.piece(strip).name).toMatch(/^SKIRT_[12]$/);
  });
});

describe('slashPiece / cutAlongInternal / guide', () => {
  it('diagonal polyline through the piece; internals and notches go to the right half', () => {
    const { doc, pid, p } = setup();
    doc.transact('decorate', () => {
      const pc = p();
      // internal crossing the future cut, notch at (20,0) on the bottom edge and at (80,50) on top
      pc.internals.push(makeContour([gradePoint(10, 25), gradePoint(90, 25)], { type: 'internal', closed: false }));
      pc.notches.push({ id: 'nb', contourId: pc.sew.id, placement: { kind: 'fromPrev', anchorId: pc.sew.points[0].id, dist: { x: 20 } }, type: 'slit', depth: 5, width: 0, angleDeg: 0 });
      pc.notches.push({ id: 'nt', contourId: pc.sew.id, placement: { kind: 'proportional', anchorId: pc.sew.points[2].id, pct: 20 }, type: 'slit', depth: 5, width: 0, angleDeg: 0 });
      pc.drills.push({ id: 'd1', x: 80, y: 10, grade: {}, diameter: 3, kind: 'drill', mode: 'draw' });
    });
    // zig-zag cut from (50,0) via (40,25) to (50,50), ends exactly on the boundary
    const [p1, p2] = slashPiece(doc, pid, [{ x: 50, y: 0 }, { x: 40, y: 25 }, { x: 50, y: 50 }]);
    // left half: polygon (0,0)(50,0)(40,25)(50,50)(0,50) → 2500 − triangle 10×50/2 = 2250
    expect(A(doc, p1)).toBeCloseTo(2250, 6);
    expect(A(doc, p2)).toBeCloseTo(2750, 6);
    const P1 = doc.piece(p1), P2 = doc.piece(p2);
    expect(P1.internals.length).toBe(1); expect(P2.internals.length).toBe(1);
    expect(P1.notches.map(n => n.id)).toEqual(['nb']);
    expect(P2.notches.map(n => n.id)).toEqual(['nt']);
    expect(P2.drills.map(d => d.id)).toEqual(['d1']);
    // notch nb keeps its distance (20 from the left corner)
    const nb = P1.notches[0];
    expect(nb.placement.kind).toBe('fromPrev');
  });
  it('cutAlongInternal consumes the internal and keeps its curve', () => {
    const { doc, pid, p } = setup();
    let iid = '';
    doc.transact('style line', () => {
      const ic = makeContour([gradePoint(30, 0), curvePoint(45, 25), gradePoint(30, 50)], { type: 'internal', closed: false });
      iid = ic.id; p().internals.push(ic);
    });
    const [p1, p2] = cutAlongInternal(doc, pid, iid);
    expect(A(doc, p1) + A(doc, p2)).toBeCloseTo(5000, 6);
    expect(A(doc, p1)).toBeGreaterThan(1500 + 300);
    expect(doc.piece(p1).internals.length + doc.piece(p2).internals.length).toBe(0);
  });
  it('cutByGuideline (45° through (50,25))', () => {
    const { doc, pid } = setup();
    const [p1, p2] = cutByGuideline(doc, pid, { a: { x: 50, y: 25 }, b: { x: 60, y: 35 } });
    // line y = x − 25 cuts bottom at x=25, top at x=75: halves 2500 each
    expect(A(doc, p1)).toBeCloseTo(2500, 6);
    expect(A(doc, p2)).toBeCloseTo(2500, 6);
    const pts = doc.piece(p1).sew.points;
    const line = doc.sizeLine(doc.piece(p1));
    expect(pts.some(a => Math.abs(anchorAt(doc.piece(p1).sew, line, pts.indexOf(a)).x - 25) < 1e-9)).toBe(true);
  });
});
