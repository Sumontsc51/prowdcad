import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, rectangleContour, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { addSpecItem, applySpec, specValue, specRows, updateSpecItem, setSpecTargets, removeSpecItem, defaultSpecMovers } from '../src/ops/spec';
import { measureSegment } from '../src/ops/measure';
import { saveNative, loadNative } from '../src/io/native';

function doc1() {
  const s = makeStyle();
  const p = makePiece('A', rectangleContour(0, 0, 100, 50), s.activeSizeTableId);
  s.pieces.push(p);
  const doc = new Document(s);
  const P = () => doc.piece(p.id);
  const ids = p.sew.points.map(a => a.id);
  const line = doc.sizeLine(p);
  const sid = (n: string) => line.sizes.find(x => x.name === n)!.id;
  return { doc, id: p.id, P, ids, sid, sew: p.sew.id };
}
const xy = (a: { x: number; y: number }) => [Math.round(a.x * 1e6) / 1e6, Math.round(a.y * 1e6) / 1e6];

describe('Measure Spec', () => {
  it('a new item takes the current values as targets and the line end as the moving point', () => {
    const { doc, id, ids, sew, sid } = doc1();
    const k = addSpecItem(doc, { name: 'Hem', kind: 'line', parts: [{ ref: { pieceId: id, contourId: sew, from: ids[0], to: ids[1] } }] });
    const it0 = doc.style.measureSpec.find(x => x.id === k)!;
    const L = measureSegment(doc, id, sew, ids[0], ids[1]);
    expect(it0.targets[sid('M')]).toBeCloseTo(L, 9);
    expect(Object.keys(it0.targets)).toHaveLength(5);
    expect(it0.movers).toEqual([{ pieceId: id, anchorId: ids[1], dir: 'along', share: 1 }]);
    expect(applySpec(doc).written).toBe(false); // already on spec: nothing to do, no undo step
    expect(doc.canUndo()).toBe(true); // only the "add" step
    doc.undo(); expect(doc.style.measureSpec).toHaveLength(0);
  });

  it('raising a line target moves the line end along the line by the difference (offset), other end fixed', () => {
    const { doc, id, P, ids, sew, sid } = doc1();
    const a0 = xy(P().sew.points[0]), b0 = P().sew.points[1];
    const dirx = Math.sign(b0.x - a0[0]) || 0, diry = Math.sign(b0.y - a0[1]) || 0;
    const L = measureSegment(doc, id, sew, ids[0], ids[1]);
    const k = addSpecItem(doc, { name: 'Hem', kind: 'line', parts: [{ ref: { pieceId: id, contourId: sew, from: ids[0], to: ids[1] } }] });
    const want = { x: b0.x + 20 * dirx, y: b0.y + 20 * diry };
    setSpecTargets(doc, k, Object.fromEntries(['XS', 'S', 'M', 'L', 'XL'].map(n => [sid(n), L + 20])));
    const before = JSON.stringify(doc.style.pieces);
    const pv = applySpec(doc, [k], { write: false });
    expect(pv.written).toBe(false); expect(JSON.stringify(doc.style.pieces)).toBe(before); // preview writes nothing
    expect(pv.items[0].rows.find(r => r.sizeId === sid('M'))!.after).toBeCloseTo(L + 20, 5);
    const r = applySpec(doc, [k]);
    expect(r.written).toBe(true);
    expect(xy(P().sew.points[0])).toEqual(a0);
    expect(P().sew.points[1].x).toBeCloseTo(want.x, 5); expect(P().sew.points[1].y).toBeCloseTo(want.y, 5);
    for (const n of ['XS', 'S', 'M', 'L', 'XL']) expect(specValue(doc, k, sid(n))).toBeCloseTo(L + 20, 5);
    expect(r.items[0].rows.every(x => x.solved)).toBe(true);
    expect(r.items[0].maxResidual).toBeLessThan(1e-5);
    doc.undo(); // one undo step for the whole apply
    expect(JSON.stringify(doc.style.pieces)).toBe(before);
  });

  it('rules: two points sharing the change move half each, in opposite directions', () => {
    const { doc, id, P, ids, sew, sid } = doc1();
    const L = measureSegment(doc, id, sew, ids[0], ids[1]);
    const a0 = { ...P().sew.points[0] }, b0 = { ...P().sew.points[1] };
    const k = addSpecItem(doc, { name: 'Hem', kind: 'line', parts: [{ ref: { pieceId: id, contourId: sew, from: ids[0], to: ids[1] } }] });
    updateSpecItem(doc, k, { movers: [{ pieceId: id, anchorId: ids[0], dir: 'along', share: 0.5 }, { pieceId: id, anchorId: ids[1], dir: 'along', share: 0.5 }] });
    setSpecTargets(doc, k, { [sid('M')]: L + 30 });
    applySpec(doc, [k], { sizes: [sid('M')] });
    const a = P().sew.points[0], b = P().sew.points[1];
    expect(Math.hypot(a.x - a0.x, a.y - a0.y)).toBeCloseTo(15, 5);
    expect(Math.hypot(b.x - b0.x, b.y - b0.y)).toBeCloseTo(15, 5);
    expect(specValue(doc, k)).toBeCloseTo(L + 30, 5);
  });

  it('a non-base size target changes only that size (base and the other sizes keep their values)', () => {
    const { doc, id, P, ids, sew, sid } = doc1();
    const L = measureSegment(doc, id, sew, ids[0], ids[1]);
    const k = addSpecItem(doc, { name: 'Hem', kind: 'line', parts: [{ ref: { pieceId: id, contourId: sew, from: ids[0], to: ids[1] } }] });
    const base = JSON.stringify(P().sew.points.map(a => [a.x, a.y]));
    setSpecTargets(doc, k, { [sid('L')]: L + 8 });
    const r = applySpec(doc, [k]);
    expect(r.written).toBe(true);
    expect(JSON.stringify(P().sew.points.map(a => [a.x, a.y]))).toBe(base);
    expect(specValue(doc, k, sid('L'))).toBeCloseTo(L + 8, 5);
    for (const n of ['XS', 'S', 'M', 'XL']) expect(specValue(doc, k, sid(n))).toBeCloseTo(L, 5);
  });

  it('point-to-point distance: the second point moves along the line between the points', () => {
    const { doc, id, P, ids, sid } = doc1();
    const a = { ...P().sew.points[0] }, c0 = { ...P().sew.points[2] };
    const D = Math.hypot(c0.x - a.x, c0.y - a.y);
    const k = addSpecItem(doc, { name: 'Diagonal', kind: 'distance', a: { pieceId: id, anchorId: ids[0] }, b: { pieceId: id, anchorId: ids[2] } });
    expect(specValue(doc, k)).toBeCloseTo(D, 9);
    setSpecTargets(doc, k, { [sid('M')]: D + 10 });
    applySpec(doc, [k], { sizes: [sid('M')] });
    const c = P().sew.points[2];
    expect(specValue(doc, k)).toBeCloseTo(D + 10, 5);
    expect(c.x - c0.x).toBeCloseTo(10 * (c0.x - a.x) / D, 5); expect(c.y - c0.y).toBeCloseTo(10 * (c0.y - a.y) / D, 5);
    // X-only measurement with an X-only rule
    const kx = addSpecItem(doc, { name: 'Width', kind: 'distance', mode: 'x', a: { pieceId: id, anchorId: ids[0] }, b: { pieceId: id, anchorId: ids[2] }, movers: [{ pieceId: id, anchorId: ids[2], dir: 'x', share: Math.sign(c.x - a.x) || 1 }] });
    const W = specValue(doc, kx)!;
    setSpecTargets(doc, kx, { [sid('M')]: W + 4 });
    const y = P().sew.points[2].y;
    applySpec(doc, [kx], { sizes: [sid('M')] });
    expect(specValue(doc, kx)).toBeCloseTo(W + 4, 5);
    expect(P().sew.points[2].y).toBeCloseTo(y, 9);
  });

  it('a whole internal line with a curve point: its end moves along the line; the curve point follows', () => {
    const { doc, id, P, sid } = doc1();
    const ic = makeContour([gradePoint(10, 10), curvePoint(40, 30), gradePoint(80, 10)], { closed: false, type: 'internal' });
    doc.transact('ic', () => { P().internals.push(ic); });
    const k = addSpecItem(doc, { name: 'Pocket line', kind: 'line', parts: [{ ref: { pieceId: id, contourId: ic.id, from: ic.points[0].id, to: ic.points[2].id } }] });
    const L = specValue(doc, k)!;
    const cp0 = { ...P().internals[0].points[1] };
    setSpecTargets(doc, k, { [sid('M')]: L + 12 });
    const r = applySpec(doc, [k], { sizes: [sid('M')] });
    expect(r.items[0].rows.find(x => x.sizeId === sid('M'))!.solved).toBe(true);
    expect(specValue(doc, k)).toBeCloseTo(L + 12, 4);
    const I = P().internals[0].points;
    expect(xy(I[0])).toEqual([10, 10]);
    expect(I[2].x).toBeGreaterThan(80);
    expect(I[1].x).toBeGreaterThan(cp0.x); // curve point carried with the moved end
  });

  it('an unreachable target is reported and leaves the pattern unchanged; no undo step', () => {
    const { doc, id, P, ids, sid } = doc1();
    // X-only width measured, but the rule moves the point in Y only
    const k = addSpecItem(doc, { name: 'Width', kind: 'distance', mode: 'x', a: { pieceId: id, anchorId: ids[0] }, b: { pieceId: id, anchorId: ids[2] }, movers: [{ pieceId: id, anchorId: ids[2], dir: 'y', share: 1 }] });
    const W = specValue(doc, k)!;
    setSpecTargets(doc, k, { [sid('M')]: W + 5 });
    const before = JSON.stringify(P());
    const lbl = doc.undoLabel();
    const r = applySpec(doc, [k], { sizes: [sid('M')] });
    expect(r.written).toBe(false);
    const row = r.items[0].rows.find(x => x.sizeId === sid('M'))!;
    expect(row.solved).toBe(false); expect(row.note).toMatch(/cannot be reached/);
    expect(JSON.stringify(P())).toBe(before);
    expect(doc.undoLabel()).toBe(lbl);
    // no moving point at all
    updateSpecItem(doc, k, { movers: [] });
    expect(applySpec(doc, [k]).items[0].rows.find(x => x.sizeId === sid('M'))!.note).toMatch(/no point is set to move/);
  });

  it('survives save / load; a deleted point makes the item report no value instead of throwing', () => {
    const { doc, id, P, ids, sew, sid } = doc1();
    const k = addSpecItem(doc, { name: 'Hem', kind: 'line', parts: [{ ref: { pieceId: id, contourId: sew, from: ids[0], to: ids[1] } }] });
    setSpecTargets(doc, k, { [sid('L')]: 123.5 });
    const re = new Document(loadNative(saveNative(doc)).style);
    expect(re.style.measureSpec).toHaveLength(1);
    expect(re.style.measureSpec[0].targets[sid('L')]).toBe(123.5);
    expect(specRows(re, k).find(r => r.sizeId === sid('L'))!.diff).toBeCloseTo(specValue(re, k, sid('L'))! - 123.5, 9);
    // older files have no measureSpec
    const old = JSON.parse(saveNative(doc)); delete old.measureSpec;
    expect(loadNative(old).style.measureSpec).toEqual([]);
    doc.transact('del', () => { P().sew.points.splice(1, 1); });
    expect(specValue(doc, k)).toBeNull();
    const r = applySpec(doc);
    expect(r.items[0].error ?? r.items[0].rows.every(x => !x.solved || x.before === null)).toBeTruthy();
    removeSpecItem(doc, k);
    expect(doc.style.measureSpec).toHaveLength(0);
    expect(defaultSpecMovers({ kind: 'line', parts: [], a: undefined, b: undefined })).toEqual([]);
  });
});
