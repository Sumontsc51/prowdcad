import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint, newId } from '../src/model/factory';
import type { Piece, SizeId } from '../src/model/types';
import {
  insertSize, appendSize, removeSize, renameSize, setBase, setAxis2, resolveCombined, combinedSizes,
  combineTables, switchActiveTable, createSizeTable, ungradedSizes, deleteUngradedSizes, invisibleSizes,
  deleteInvisibleSizes, sizeIdByName, sizesOfTable, sizesOfPiece, visitGradedRecords,
} from '../src/ops/sizes';

function setup(names = ['S', 'M', 'L', 'XL'], base = 'M') {
  const doc = new Document(makeStyle('t', names, base));
  const line = doc.sizeLine();
  const id = (n: string) => sizeIdByName(line, n)!;
  // right side graded +10 x per size step, top +5 y; curved right side with an implicit curve point
  const inc = (dx: number, dy: number) => Object.fromEntries(line.sizes.slice(1).map(s => [s.id, { dx, dy }]));
  const c = makeContour([
    gradePoint(0, 0, { flags: { startPoint: true } }),
    gradePoint(100, 0, { grade: inc(10, 0) }),
    curvePoint(115, 60),
    gradePoint(100, 150, { grade: inc(10, 5) }),
    gradePoint(0, 150, { grade: inc(0, 5) }),
  ]);
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  piece.drills.push({ id: newId('dr'), x: 50, y: 75, grade: inc(4, 2), diameter: 3, kind: 'drill', mode: 'draw' });
  piece.notches.push({ id: newId('n'), contourId: c.id, placement: { kind: 'fromPrev', anchorId: c.points[1].id, dist: Object.fromEntries(line.sizes.map((s, i) => [s.id, 20 + 2 * i])) }, type: 'slit', depth: 5, width: 0, angleDeg: 0 });
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, piece, id, line };
}
const snapshot = (doc: Document, piece: Piece, sizes: SizeId[]) => {
  const out: Record<string, { x: number; y: number }[]> = {};
  for (const s of sizes) out[s] = doc.resolvePiece(piece.id, s).sew.anchorPos.map(p => ({ x: p.x, y: p.y }));
  return out;
};
const expectSame = (a: Record<string, { x: number; y: number }[]>, b: Record<string, { x: number; y: number }[]>) => {
  for (const k of Object.keys(a)) a[k].forEach((p, i) => { expect(b[k][i].x).toBeCloseTo(p.x, 9); expect(b[k][i].y).toBeCloseTo(p.y, 9); });
};

describe('sizes: half-size insertion', () => {
  it('inserting SM between S and M splits every S→M increment in half', () => {
    const { doc, piece, id } = setup();
    const ids = ['S', 'M', 'L', 'XL'].map(id);
    const before = snapshot(doc, piece, ids);
    const sm = insertSize(doc, { name: 'SM', after: 'S' });
    expect(sizesOfTable(doc).map(s => s.name)).toEqual(['S', 'SM', 'M', 'L', 'XL']);
    const p = doc.piece(piece.id);
    expect(p.sew.points[1].grade[sm]).toEqual({ dx: 5, dy: 0 });
    expect(p.sew.points[1].grade[id('M')]).toEqual({ dx: 5, dy: 0 });
    expect(p.sew.points[3].grade[sm]).toEqual({ dx: 5, dy: 2.5 });
    expect(p.drills[0].grade[sm]).toEqual({ dx: 2, dy: 1 });
    expect(p.drills[0].grade[id('M')]).toEqual({ dx: 2, dy: 1 });
    const n = p.notches[0].placement as { dist: Record<string, number> };
    expect(n.dist[sm]).toBe(21); // between S=20 and M=22
    expectSame(before, snapshot(doc, piece, ids));
    const r = doc.resolvePiece(piece.id, sm).sew.anchorPos;
    expect(r[1].x).toBeCloseTo(95, 9);
    expect(r[3].x).toBeCloseTo(95, 9); expect(r[3].y).toBeCloseTo(147.5, 9);
  });
  it('insertSize before the first size / appendSize with and without extrapolation', () => {
    const { doc, piece, id } = setup();
    const xs = insertSize(doc, { name: 'XS', before: 'S', extrapolate: true });
    const p = doc.piece(piece.id);
    expect(p.sew.points[1].grade[xs]).toEqual({ dx: 0, dy: 0 });
    expect(p.sew.points[1].grade[id('S')]).toEqual({ dx: 10, dy: 0 });
    expect(doc.resolvePiece(piece.id, xs).sew.anchorPos[1].x).toBeCloseTo(80, 9);
    const xxl = appendSize(doc, 'XXL', { extrapolate: true });
    expect(doc.resolvePiece(piece.id, xxl).sew.anchorPos[1].x).toBeCloseTo(130, 9);
    const x3 = appendSize(doc, '3XL');
    expect(doc.resolvePiece(piece.id, x3).sew.anchorPos[1].x).toBeCloseTo(130, 9);
    expect(doc.resolvePiece(piece.id, id('S')).sew.anchorPos[1].x).toBeCloseTo(90, 9);
  });
});

describe('sizes: remove / rename / setBase', () => {
  it('removeSize keeps every other size exactly', () => {
    const { doc, piece, id } = setup(['XS', 'S', 'M', 'L', 'XL']);
    const keep = ['XS', 'M', 'L', 'XL'].map(id);
    const before = snapshot(doc, piece, keep);
    removeSize(doc, 'S');
    expect(sizesOfTable(doc).map(s => s.name)).toEqual(['XS', 'M', 'L', 'XL']);
    expect(doc.piece(piece.id).sew.points[1].grade[id('M')]).toEqual({ dx: 20, dy: 0 });
    expectSame(before, snapshot(doc, piece, keep));
    expect(() => removeSize(doc, 'M')).toThrow();
  });
  it('renameSize', () => {
    const { doc } = setup();
    renameSize(doc, 'XL', '1X');
    expect(sizesOfTable(doc).map(s => s.name)).toEqual(['S', 'M', 'L', '1X']);
    expect(() => renameSize(doc, 'L', 'S')).toThrow();
  });
  it('setBase re-expresses the style: geometry unchanged for every size, incl. implicit curve point', () => {
    const { doc, piece, id } = setup();
    const ids = ['S', 'M', 'L', 'XL'].map(id);
    const before = snapshot(doc, piece, ids);
    const drillBefore = { x: 50 + 4, y: 75 + 2 }; // drill in L
    setBase(doc, 'L');
    expect(doc.sizeLine().baseSizeId).toBe(id('L'));
    const p = doc.piece(piece.id);
    expect(p.sew.points[1].x).toBeCloseTo(110, 9);
    expect(p.sew.points[3].y).toBeCloseTo(155, 9);
    expect(p.drills[0].x).toBeCloseTo(drillBefore.x, 9); expect(p.drills[0].y).toBeCloseTo(drillBefore.y, 9);
    expectSame(before, snapshot(doc, piece, ids));
    // and back
    setBase(doc, 'M');
    expectSame(before, snapshot(doc, piece, ids));
    expect(p.sew.points[1].x).toBeCloseTo(100, 9);
  });
});

describe('sizes: two-axis Size Variation', () => {
  it('resolveCombined = base + abs1 + abs2; combinedSizes enumerates on request', () => {
    const { doc, piece, id } = setup();
    const a2 = setAxis2(doc, ['30', '32', '34'], '32', { name: 'Inseam' });
    const [i30, i32, i34] = a2.sizes.map(s => s.id);
    doc.transact('g2', () => {
      const p = doc.piece(piece.id);
      p.sew.points[3].grade2 = { [i32]: { dx: 0, dy: 50 }, [i34]: { dx: 0, dy: 50 } };
      p.sew.points[4].grade2 = { [i32]: { dx: 0, dy: 50 }, [i34]: { dx: 0, dy: 50 } };
    });
    const r = resolveCombined(doc, piece.id, id('L'), i34);
    expect(r.sew.anchorPos[3]).toEqual({ x: 110, y: 205 });
    expect(r.sew.anchorPos[4]).toEqual({ x: 0, y: 205 });
    expect(r.sew.anchorPos[1]).toEqual({ x: 110, y: 0 });
    const r2 = resolveCombined(doc, piece.id, id('S'), i30);
    expect(r2.sew.anchorPos[3].x).toBeCloseTo(90, 9); expect(r2.sew.anchorPos[3].y).toBeCloseTo(95, 9);
    const base = resolveCombined(doc, piece.id, id('M'), i32);
    expect(base.sew.anchorPos[3]).toEqual({ x: 100, y: 150 });
    expect(combinedSizes(doc).length).toBe(12);
    expect(combinedSizes(doc)[0].name).toBe('S/30');
    // half-size insertion on axis 2 splits grade2
    const i31 = insertSize(doc, { name: '31', after: '30', axis: 2 });
    expect(doc.piece(piece.id).sew.points[3].grade2![i31]).toEqual({ dx: 0, dy: 25 });
    expect(resolveCombined(doc, piece.id, id('M'), i30).sew.anchorPos[3].y).toBeCloseTo(100, 9);
  });
  it('combineTables flattens one-way (discouraged) and keeps every combined geometry', () => {
    const { doc, piece, id } = setup();
    const a2 = setAxis2(doc, ['30', '32'], '32');
    const [i30, i32] = a2.sizes.map(s => s.id);
    doc.transact('g2', () => { doc.piece(piece.id).sew.points[4].grade2 = { [i32]: { dx: 0, dy: 40 } }; });
    const expected = combinedSizes(doc).map(c => resolveCombined(doc, piece.id, c.size1, c.size2).sew.anchorPos);
    const oldTable = doc.style.activeSizeTableId;
    const nt = combineTables(doc);
    const t = doc.sizeTable(nt);
    expect(t.discouraged).toBe(true); expect(t.combinedFrom).toBe(oldTable);
    expect(t.axis1.sizes.map(s => s.name)).toEqual(['S/30', 'S/32', 'M/30', 'M/32', 'L/30', 'L/32', 'XL/30', 'XL/32']);
    expect(doc.sizeLine(doc.piece(piece.id)).baseSizeId).toBe(sizeIdByName(t.axis1, 'M/32'));
    t.axis1.sizes.forEach((s, k) => {
      const got = doc.resolvePiece(piece.id, s.id).sew.anchorPos;
      expected[k].forEach((p, i) => { expect(got[i].x).toBeCloseTo(p.x, 9); expect(got[i].y).toBeCloseTo(p.y, 9); });
    });
    expect(doc.resolvePiece(piece.id, sizeIdByName(t.axis1, 'XL/30')!).sew.anchorPos[4].y).toBeCloseTo(150 + 10 - 40, 9);
    void i30; void id;
  });
});

describe('sizes: tables & cleanup', () => {
  it('switchActiveTable / createSizeTable / sizesOf helpers', () => {
    const { doc, piece } = setup();
    const t2 = createSizeTable(doc, 'Kids', ['4', '6', '8'], '6');
    switchActiveTable(doc, t2);
    expect(sizesOfTable(doc).map(s => s.name)).toEqual(['4', '6', '8']);
    expect(sizesOfPiece(doc, piece.id).length).toBe(4); // piece still uses its own table
    expect(() => switchActiveTable(doc, 'nope')).toThrow();
  });
  it('ungraded sizes: sizes with no non-zero increment anywhere are deleted', () => {
    const { doc, piece, id } = setup();
    const extra = appendSize(doc, 'XXL'); // zero increments everywhere
    // notch distances: make XXL equal XL
    doc.transact('n', () => { const pl = doc.piece(piece.id).notches[0].placement as { dist: Record<string, number> }; pl.dist[extra] = pl.dist[id('XL')]; });
    expect(ungradedSizes(doc)).toEqual([extra]);
    expect(deleteUngradedSizes(doc)).toEqual([extra]);
    expect(sizesOfTable(doc).map(s => s.name)).toEqual(['S', 'M', 'L', 'XL']);
  });
  it('invisible sizes (no piece cut in them) are deleted', () => {
    const { doc, piece, id } = setup();
    doc.transact('subset', () => { doc.piece(piece.id).sizes = [id('S'), id('M'), id('L')]; });
    expect(invisibleSizes(doc)).toEqual([id('XL')]);
    deleteInvisibleSizes(doc);
    expect(sizesOfTable(doc).map(s => s.name)).toEqual(['S', 'M', 'L']);
  });
  it('visitor walks every graded record', () => {
    const { doc } = setup();
    const kinds: string[] = [];
    visitGradedRecords(doc.style, doc.style.activeSizeTableId, 1, ({ ref }) => { kinds.push(ref.kind); });
    expect(kinds.filter(k => k === 'anchor').length).toBe(4); // implicit curve point skipped
    expect(kinds).toContain('drill'); expect(kinds).toContain('grainA');
  });
});
