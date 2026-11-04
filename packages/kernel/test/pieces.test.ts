import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area, polylineLength } from '../src/geom/poly';
import { bbox } from '../src/geom/vec';
import {
  traceSegments, buildPiece, regionAt, joinPieces, foldIn, foldOut, symmetryCheck, setHalf, openHalf, deleteHalf,
  snapshotReference, restoreReference, showReference, globalCheckConnections, globalClearConnections, lockPiece,
  saveLayout, restoreLayout, saveActiveAsNew, replaceOld, mergeFromStyle, recenterGrain, grainParallelToSegment, rotatePieceToGrain,
} from '../src/ops/pieces';
import { movePoint } from '../src/ops/points';
import { cutHV } from '../src/ops/cut';

function setup(w = 100, h = 50, sizes = ['S', 'M', 'L']) {
  const doc = new Document(makeStyle('t', sizes, 'M'));
  const c = rectangleContour(0, 0, w, h);
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, pid: piece.id, p: () => doc.piece(piece.id), ids: doc.sizeLine().sizes.map(s => s.id) };
}
const A = (doc: Document, id: string, size?: string) => area(doc.resolvePiece(id, size).sew.pts);
function addInternal(doc: Document, pid: string, pts: [number, number][], closed = false) {
  const c = makeContour(pts.map(([x, y]) => gradePoint(x, y)), { type: 'internal', closed });
  doc.transact('internal', () => doc.piece(pid).internals.push(c));
  return c.id;
}

describe('trace / build (PC1)', () => {
  it('traceSegments: a run + single anchor → triangle', () => {
    const { doc, pid, p } = setup();
    const P = p().sew.points;
    const id = traceSegments(doc, [{ pieceId: pid, from: P[0].id, to: P[1].id }, { pieceId: pid, anchorId: P[2].id }], { name: 'TRI' });
    expect(A(doc, id)).toBeCloseTo(2500, 9);
    expect(doc.piece(id).name).toBe('TRI');
  });
  it('buildPiece: region bounded by two crossing internals', () => {
    const { doc, pid } = setup();
    addInternal(doc, pid, [[40, -5], [40, 55]]);
    addInternal(doc, pid, [[-5, 20], [105, 20]]);
    const reg = regionAt(doc, pid, { x: 70, y: 40 });
    expect(area(reg)).toBeCloseTo(60 * 30, 9);
    const id = buildPiece(doc, pid, { x: 10, y: 10 }, { name: 'BL' });
    expect(A(doc, id)).toBeCloseTo(40 * 20, 9);
    const b = bbox(doc.resolvePiece(id).sew.pts);
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([0, 0, 40, 20].map(v => expect.closeTo(v, 9)));
    // corner (0,0) inherits original grade anchor; seed outside throws
    expect(() => regionAt(doc, pid, { x: 200, y: 0 })).toThrow();
  });
  it('buildPiece with a curved internal ending inside (dangling) ignores it', () => {
    const { doc, pid } = setup();
    addInternal(doc, pid, [[50, 0], [50, 30]]);
    expect(area(regionAt(doc, pid, { x: 20, y: 20 }))).toBeCloseTo(5000, 9);
  });
});

describe('join (PC2)', () => {
  it('cut then join restores the rectangle', () => {
    const { doc, pid, p } = setup();
    const [a, b] = cutHV(doc, pid, p().sew.points[0].id, 'V', 40);
    // move B away and rotate it, then join along the cut edge
    doc.transact('move', () => { for (const q of doc.piece(b).sew.points) { const x = q.x, y = q.y; q.x = 300 - y; q.y = 100 + x; } });
    const PA = doc.piece(a).sew.points, PB = doc.piece(b).sew.points;
    // A's cut edge: the vertical at x=40 goes (40,0)→(40,50) in A's order; find it
    const ia = PA.findIndex(q => Math.abs(q.x - 40) < 1e-9 && Math.abs(q.y) < 1e-9);
    const ja = PA.findIndex(q => Math.abs(q.x - 40) < 1e-9 && Math.abs(q.y - 50) < 1e-9);
    // B's cut edge (transformed): original (40,50)→(40,0) ⇒ now (250,140)→(300,140)
    const ib = PB.findIndex(q => Math.abs(q.x - 250) < 1e-9 && Math.abs(q.y - 140) < 1e-9);
    const jb = PB.findIndex(q => Math.abs(q.x - 300) < 1e-9 && Math.abs(q.y - 140) < 1e-9);
    const id = joinPieces(doc, a, { from: PA[ia].id, to: PA[ja].id }, b, { from: PB[ib].id, to: PB[jb].id });
    expect(doc.style.pieces.length).toBe(1);
    expect(A(doc, id)).toBeCloseTo(5000, 6);
    const bb = bbox(doc.resolvePiece(id).sew.pts);
    expect([bb.minX, bb.minY, bb.maxX, bb.maxY]).toEqual([0, 0, 100, 50].map(v => expect.closeTo(v, 6)));
    expect(doc.piece(id).internals.some(c => c.name === 'JOIN')).toBe(true);
  });
  it('alignOnly just moves B', () => {
    const doc = new Document(makeStyle());
    const a = makePiece('A', rectangleContour(0, 0, 50, 50), doc.style.activeSizeTableId);
    const b = makePiece('B', rectangleContour(200, 200, 30, 30), doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(a, b));
    joinPieces(doc, a.id, { from: a.sew.points[1].id, to: a.sew.points[2].id }, b.id, { from: b.sew.points[3].id, to: b.sew.points[0].id }, { alignOnly: true });
    const bb = bbox(doc.resolvePiece(b.id).sew.pts);
    expect([bb.minX, bb.minY, bb.maxX, bb.maxY]).toEqual([50, 0, 80, 30].map(v => expect.closeTo(v, 9)));
    expect(doc.style.pieces.length).toBe(2);
  });
});

describe('fold in / out, half (PC3)', () => {
  it('foldIn at x=70 then foldOut restores; symmetry check 25 vs 0', () => {
    const { doc, pid, p } = setup();
    const fid = foldIn(doc, pid, { a: { x: 70, y: 0 }, b: { x: 70, y: 50 } });
    expect(A(doc, pid)).toBeCloseTo(3500, 9);
    const ic = p().internals.find(c => c.id === fid)!;
    const xs = ic.points.map(a => a.x);
    expect(Math.min(...xs)).toBeCloseTo(40, 9); // folded behind: mirrored onto the kept side
    // the 30 mm flap does not match the 70 mm kept side: its far edge (x=40) is up to 25 mm off the outline
    expect(symmetryCheck(doc, pid, fid)).toBeCloseTo(25, 9);
    const dev = foldOut(doc, pid, fid);
    expect(dev).toBeCloseTo(25, 9);
    expect(A(doc, pid)).toBeCloseTo(5000, 9);
    const bb = bbox(doc.resolvePiece(pid).sew.pts);
    expect([bb.minX, bb.maxX]).toEqual([expect.closeTo(0, 9), expect.closeTo(100, 9)]);
    // symmetric fold at the centre line: the folded half coincides with the kept half → 0
    const f2 = foldIn(doc, pid, { a: { x: 50, y: 0 }, b: { x: 50, y: 50 } });
    expect(symmetryCheck(doc, pid, f2)).toBeCloseTo(0, 9);
    expect(foldOut(doc, pid, f2, { checkOnly: true })).toBeCloseTo(0, 9);
  });
  it('setHalf (trim) + openHalf mirrors the piece', () => {
    const { doc, pid, p } = setup();
    doc.transact('d', () => p().drills.push({ id: 'd1', x: 20, y: 25, grade: {}, diameter: 3, kind: 'drill', mode: 'draw' }));
    setHalf(doc, pid, { a: { x: 50, y: 0 }, b: { x: 50, y: 50 } }, { trim: true, keep: { x: 10, y: 10 } });
    expect(A(doc, pid)).toBeCloseTo(2500, 9);
    expect(p().half).toBeDefined();
    openHalf(doc, pid);
    expect(A(doc, pid)).toBeCloseTo(5000, 9);
    expect(p().half).toBeUndefined();
    expect(p().drills.map(d => d.x).sort((a, b) => a - b)).toEqual([20, expect.closeTo(80, 9)]);
    setHalf(doc, pid, { a: { x: 100, y: 0 }, b: { x: 100, y: 50 } });
    deleteHalf(doc, pid);
    expect(p().half).toBeUndefined();
  });
});

describe('reference, connections, lock, layouts, versions (PC4)', () => {
  it('reference snapshot/restore/show', () => {
    const { doc, pid, p } = setup();
    snapshotReference(doc, pid);
    movePoint(doc, pid, p().sew.points[2].id, { dx: 20, dy: 0 });
    expect(showReference(doc, pid)!.sew.length).toBe(5);
    restoreReference(doc, pid);
    expect(A(doc, pid)).toBeCloseTo(5000, 9);
  });
  it('globalCheckConnections connects and the internal follows the perimeter', () => {
    const { doc, pid, p } = setup();
    addInternal(doc, pid, [[30, 0], [30, 50]]);
    addInternal(doc, pid, [[0, 25], [100, 25]]);
    const r = globalCheckConnections(doc, pid);
    expect(r.connections).toBe(4);
    expect(r.anchorsAdded).toBe(4 + 2); // 4 sew anchors, 2 crossing anchors
    const ext = p().sew.points.find(a => a.x === 30 && a.y === 50)!;
    movePoint(doc, pid, ext.id, { dx: 5, dy: 0 });
    expect(p().internals[0].points[p().internals[0].points.length - 1].x).toBe(35);
    expect(globalClearConnections(doc, pid)).toBe(4);
  });
  it('lock prevents point moves; layouts save/restore', () => {
    const { doc, pid, p } = setup();
    lockPiece(doc, pid);
    expect(() => movePoint(doc, pid, p().sew.points[0].id, { dx: 1, dy: 0 })).toThrow();
    lockPiece(doc, pid, false);
    doc.transact('place', () => { p().layout = { x: 10, y: 20, angleDeg: 90 }; });
    saveLayout(doc, 'A');
    doc.transact('place', () => { p().layout = { x: 0, y: 0, angleDeg: 0 }; });
    expect(restoreLayout(doc, 'A')).toBe(1);
    expect(p().layout).toEqual({ x: 10, y: 20, angleDeg: 90 });
  });
  it('saveActiveAsNew → FRONT_1, FRONT_2; replaceOld', () => {
    const { doc, pid } = setup();
    const n1 = saveActiveAsNew(doc, pid), n2 = saveActiveAsNew(doc, pid);
    expect(doc.piece(n1).name).toBe('FRONT_1'); expect(doc.piece(n2).name).toBe('FRONT_2');
    const ids = new Set([...doc.piece(pid).sew.points, ...doc.piece(n1).sew.points].map(a => a.id));
    expect(ids.size).toBe(8);
    movePoint(doc, n1, doc.piece(n1).sew.points[2].id, { dx: 10, dy: 0 });
    replaceOld(doc, pid, n1);
    expect(doc.style.pieces.map(x => x.name)).toEqual(['FRONT', 'FRONT_2']);
    expect(A(doc, n1)).toBeCloseTo(5250, 9);
    expect(doc.style.pieceArchive.length).toBe(1);
  });
  it('mergeFromStyle maps sizes and grading', () => {
    const { doc, ids } = setup();
    const other = new Document(makeStyle('o', ['36', '38', '40'], '38'));
    const oid = other.sizeLine().sizes.map(s => s.id);
    const c = rectangleContour(0, 0, 10, 10);
    for (const i of [1, 2]) c.points[i].grade = { [oid[1]]: { dx: 5, dy: 0 }, [oid[2]]: { dx: 5, dy: 0 } };
    const op = makePiece('FRONT', c, other.style.activeSizeTableId);
    other.transact('add', s => s.pieces.push(op));
    const [mid] = mergeFromStyle(doc, other.style, [op.id], { [oid[0]]: ids[0], [oid[1]]: ids[1], [oid[2]]: ids[2] });
    expect(doc.piece(mid).name).toBe('FRONT_1');
    expect(A(doc, mid, ids[2])).toBeCloseTo(150, 9);
    expect(A(doc, mid, ids[0])).toBeCloseTo(50, 9);
  });
});

describe('grain (PC5)', () => {
  it('recenter, parallel to a segment, rotate piece to grain', () => {
    const { doc, pid, p } = setup();
    recenterGrain(doc, pid);
    const m = { x: (p().grain.a.x + p().grain.b.x) / 2, y: (p().grain.a.y + p().grain.b.y) / 2 };
    expect(m.x).toBeCloseTo(50, 9); expect(m.y).toBeCloseTo(25, 9);
    // slant the grain 30° from vertical, then rotate the piece so it is vertical again
    grainParallelToSegment(doc, pid, p().sew.points[0].id, p().sew.points[1].id);
    expect(p().grain.b.y - p().grain.a.y).toBeCloseTo(0, 9);
    const rot = rotatePieceToGrain(doc, pid, 'vertical');
    expect(Math.abs(rot)).toBeCloseTo(90, 9);
    const bb = bbox(doc.resolvePiece(pid).sew.pts);
    expect(bb.maxX - bb.minX).toBeCloseTo(50, 9); expect(bb.maxY - bb.minY).toBeCloseTo(100, 9);
    expect(p().grain.a.x).toBeCloseTo(p().grain.b.x, 9);
  });
});

void curvePoint; void polylineLength;
