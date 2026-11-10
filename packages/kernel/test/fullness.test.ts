import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece, makeContour, gradePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area, perimeter } from '../src/geom/poly';
import { addFullness, addMultiFullness, deleteFullness, fullnessOpenings } from '../src/ops/fullness';

/** 300×400 block: CCW BL(0,0) BR(300,0) TR(300,400) TL(0,400). Right edge graded +10 x per size. */
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
const A = (doc: Document, pid: string, sz?: string) => area(doc.resolvePiece(pid, sz).sew.pts);

describe('fullness (slash & spread)', () => {
  it('rotate about a contour hinge: opening chord exact, wedge area exact, delete restores exactly', () => {
    const s = setup();
    const snap = JSON.stringify(s.p().sew);
    // slash at hem x=150, hinge at top x=150 (TR + 150); forward arc (hem → right side → top) rotates about (150,400)
    const id = addFullness(s.doc, s.pid, { slash: { fromAnchorId: s.BL, distance: 150 }, pivot: { fromAnchorId: s.TR, distance: 150 }, openA: 40 });
    const f = s.p().fullness![0];
    expect(f.id).toBe(id);
    expect(fullnessOpenings(s.doc, s.pid, id)[0]).toBeCloseTo(40, 9);
    expect(f.hingeIds![0]).toBe(f.hingeIds![1]); // single hinge anchor
    // inserted triangle: ½·400²·sin φ, φ = 2·asin(20/400)
    const phi = 2 * Math.asin(20 / 400);
    expect(A(s.doc, s.pid) - 120000).toBeCloseTo(0.5 * 400 * 400 * Math.sin(phi), 6);
    // the rotated arc keeps its length; the sew line now spans the 40 mm opening chord S → S'
    expect(perimeter(s.doc.resolvePiece(s.pid).sew.pts)).toBeCloseTo(1400 + 40, 9);
    // grading carried by the rotated arc: every size resolves and stays larger than base
    expect(A(s.doc, s.pid, s.ids[2])).toBeGreaterThan(A(s.doc, s.pid));
    deleteFullness(s.doc, s.pid, id);
    expect(JSON.stringify(s.p().sew)).toBe(snap);
    expect(s.p().fullness!.length).toBe(0);
  });
  it('parallel spread: translation by openA, both ends open', () => {
    const s = setup();
    const id = addFullness(s.doc, s.pid, { slash: { fromAnchorId: s.BL, distance: 100 }, pivot: { fromAnchorId: s.TR, distance: 200 }, openA: 25, mode: 'parallel' });
    expect(A(s.doc, s.pid)).toBeCloseTo(325 * 400, 6);
    const f = s.p().fullness![0];
    expect(f.amounts).toEqual({ openA: 25, openB: 25 });
    expect(f.hingeIds![0]).not.toBe(f.hingeIds![1]);
    expect(fullnessOpenings(s.doc, s.pid, id)[0]).toBeCloseTo(25, 12);
  });
  it('openB on a contour hinge: both chords exact', () => {
    const s = setup();
    const id = addFullness(s.doc, s.pid, { slash: { fromAnchorId: s.BL, distance: 150 }, pivot: { fromAnchorId: s.TR, distance: 150 }, openA: 40, openB: 10 });
    const f = s.p().fullness![0];
    const r = s.doc.resolvePiece(s.pid).sew;
    const P = (id2: string) => r.anchorPos[s.p().sew.points.findIndex(a => a.id === id2)];
    const d = (a: string, b: string) => Math.hypot(P(a).x - P(b).x, P(a).y - P(b).y);
    expect(d(f.slashAnchorIds[0], f.slashAnchorIds[1])).toBeCloseTo(40, 9);
    expect(d(f.hingeIds![0], f.hingeIds![1])).toBeCloseTo(10, 9);
    deleteFullness(s.doc, s.pid, id);
    expect(A(s.doc, s.pid)).toBeCloseTo(120000, 9);
  });
  it('internal pivot: rotation about P, far hinge overlap reported', () => {
    const s = setup();
    const id = addFullness(s.doc, s.pid, { slash: { fromAnchorId: s.BL, distance: 150 }, pivot: { x: 150, y: 300 }, openA: 30 });
    const f = s.p().fullness![0];
    expect(fullnessOpenings(s.doc, s.pid, id)[0]).toBeCloseTo(30, 9);
    // far hinge at (150,400): 100 mm beyond P → overlap of 30·100/300 = 10 mm (chord, negative)
    expect(f.hingeOpen!).toBeCloseTo(-10, 9);
    expect('x' in f.pivot && f.pivot.x).toBe(150);
  });
  it('internals in the moving region follow the spread and are restored', () => {
    const s = setup();
    const ic = makeContour([gradePoint(200, 100), gradePoint(250, 100)], { type: 'internal', closed: false });
    s.doc.transact('ic', () => s.p().internals.push(ic));
    const snapI = JSON.stringify(s.p().internals);
    const id = addFullness(s.doc, s.pid, { slash: { fromAnchorId: s.BL, distance: 150 }, pivot: { fromAnchorId: s.TR, distance: 150 }, openA: 40, mode: 'parallel' });
    expect(s.p().internals[0].points[0].x).toBeCloseTo(240, 9);
    deleteFullness(s.doc, s.pid, id);
    expect(JSON.stringify(s.p().internals)).toBe(snapI);
  });
  it('multi fullness: first/last widths interpolated; LIFO delete of the lower record restores exactly', () => {
    const s = setup();
    const snap = JSON.stringify(s.p().sew);
    const m = addMultiFullness(s.doc, s.pid, { slashSegment: s.BL, hingeSegment: s.TR, count: 3, firstWidth: 10, lastWidth: 30, mode: 'parallel' });
    expect(fullnessOpenings(s.doc, s.pid, m).map(x => +x.toFixed(9))).toEqual([10, 20, 30]);
    expect(A(s.doc, s.pid)).toBeCloseTo(360 * 400, 6);
    const top = addFullness(s.doc, s.pid, { slash: { fromAnchorId: s.BR, distance: 100 }, pivot: { fromAnchorId: s.TL, distance: 300 }, openA: 15, mode: 'parallel' });
    expect(A(s.doc, s.pid)).toBeCloseTo(360 * 415, 6);
    deleteFullness(s.doc, s.pid, m); // below `top`: unwind, delete, re-apply
    expect(A(s.doc, s.pid)).toBeCloseTo(300 * 415, 6);
    expect(fullnessOpenings(s.doc, s.pid, top)[0]).toBeCloseTo(15, 9);
    deleteFullness(s.doc, s.pid, top);
    expect(JSON.stringify(s.p().sew)).toBe(snap);
  });
  it('multi fullness, rotate mode: each slash hinged on the contour', () => {
    const s = setup();
    const m = addMultiFullness(s.doc, s.pid, { slashSegment: s.BL, hingeSegment: s.TR, count: 2, firstWidth: 20, lastWidth: 20 });
    expect(fullnessOpenings(s.doc, s.pid, m).map(x => +x.toFixed(9))).toEqual([20, 20]);
    expect(A(s.doc, s.pid)).toBeGreaterThan(120000 + 2 * 0.5 * 400 * 20 * 0.99);
    s.doc.undo();
    expect(A(s.doc, s.pid)).toBeCloseTo(120000, 9);
  });
});
