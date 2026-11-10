/**
 * Measure ▸ Line groups (L1 + L2 + … per size, cut-line parts, comparisons), grade by measurement
 * (solver), and the Gerber-style rule table helpers (outward steps, smart fill, size breaks,
 * rule editing, grade status).
 */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint, rectangleContour } from '../src/model/factory';
import type { Contour, Piece } from '../src/model/types';
import { measureGroup, compareGroups, measurePart, gradeByMeasurement, cutPolyline, measureSegment, type MeasurePart } from '../src/ops/measure';
import { setGrade } from '../src/ops/grading';
import { cutLineForSize } from '../src/ops/seam';
import { polylineLength } from '../src/geom/poly';
import {
  outwardSteps, totalsFromSteps, affectedSizes, smartFill, sizeBreaks, setSizeBreaks,
  createLibrary, createRuleFromValues, applyRule, setRuleValues, copyRule, deleteRule, renameRule, gradeStatus, library, ruleName,
} from '../src/ops/rules';
import { incrementalToAbsolute } from '../src/model/contour';

function setup(names = ['S', 'M', 'L', 'XL'], base = 'M') {
  const doc = new Document(makeStyle('m', names, base));
  const line = doc.sizeLine();
  const id = (n: string) => line.sizes.find(s => s.name === n)!.id;
  return { doc, line, id };
}
function add(doc: Document, name: string, c: Contour): Piece {
  const p = makePiece(name, c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(p));
  return p;
}
const seg = (p: Piece, a: number, b: number, cut = false): MeasurePart => ({ ref: { pieceId: p.id, contourId: p.sew.id, from: p.sew.points[a].id, to: p.sew.points[b].id }, ...(cut ? { cut } : {}) });

describe('measureGroup: L1 + L2 + L3 = Σ per size', () => {
  it('sums every picked line per size and equals the hand calculation', () => {
    const { doc, id } = setup();
    const p = add(doc, 'A', rectangleContour(0, 0, 100, 50));
    // corner 2 grows 5 per size in X and 2 in Y (absolute), corner 1 grows 5 in X
    for (const [n, k] of [['S', -1], ['L', 1], ['XL', 2]] as const) {
      setGrade(doc, p.id, p.sew.points[1].id, id(n), { dx: 5 * k, dy: 0 }, { view: 'absolute' });
      setGrade(doc, p.id, p.sew.points[2].id, id(n), { dx: 5 * k, dy: 2 * k }, { view: 'absolute' });
    }
    const rows = measureGroup(doc, [seg(p, 0, 1), seg(p, 1, 2), seg(p, 2, 3)]);
    expect(rows.map(r => r.sizeName)).toEqual(['S', 'M', 'L', 'XL']);
    rows.forEach((r, i) => {
      const k = i - 1;
      const L1 = 100 + 5 * k, L2 = 50 + 2 * k, L3 = Math.hypot(100 + 5 * k, 2 * k); // top edge: (100+5k, 50+2k) → (0, 50)
      expect(r.parts[0]).toBeCloseTo(L1, 9); expect(r.parts[1]).toBeCloseTo(L2, 9); expect(r.parts[2]).toBeCloseTo(L3, 9);
      expect(r.total).toBeCloseTo(L1 + L2 + L3, 9);
      expect(r.total).toBeCloseTo(r.parts.reduce((a, b) => a! + b!, 0)!, 12);
    });
    // modes: dX of the bottom edge, dY of the right edge
    expect(measureGroup(doc, [seg(p, 0, 1)], 'x')[3].total).toBeCloseTo(110, 9);
    expect(measureGroup(doc, [seg(p, 1, 2)], 'y')[0].total).toBeCloseTo(48, 9);
    expect(measureGroup(doc, [seg(p, 0, 2)], 'diagonal')[2].total).toBeCloseTo(Math.hypot(105, 52), 9);
  });

  it('cut-line parts measure between the cut-line corners of the grade points', () => {
    const { doc } = setup();
    const p = add(doc, 'A', rectangleContour(0, 0, 100, 50)); // seam 10 everywhere, miter corners
    const v = measurePart(doc, seg(p, 0, 1, true));
    expect(v).toBeCloseTo(120, 6); // cut edge from miter to miter
    const poly = cutPolyline(doc, seg(p, 0, 1).ref);
    const cl = cutLineForSize(doc.piece(p.id), doc.sizeLine(), doc.sizeLine().baseSizeId);
    expect(poly[0]).toEqual(cl.pts[cl.cornerIndex[0]]);
    expect(polylineLength(poly)).toBeCloseTo(v, 9);
    const rows = measureGroup(doc, [seg(p, 0, 1, true), seg(p, 1, 2, true)]);
    expect(rows[1].total).toBeCloseTo(120 + 70, 6);
    expect(() => measurePart(doc, { ref: { ...seg(p, 0, 1).ref, contourId: 'nope' }, cut: true })).toThrow();
  });

  it('compareGroups: totals per group and B − A across two pieces (sizes matched by id)', () => {
    const { doc, id } = setup();
    const a = add(doc, 'A', rectangleContour(0, 0, 100, 50));
    const b = add(doc, 'B', rectangleContour(200, 0, 90, 60));
    setGrade(doc, b.id, b.sew.points[1].id, id('XL'), { dx: 10, dy: 0 }, { view: 'absolute' });
    const rows = compareGroups(doc, [[seg(a, 0, 1)], [seg(b, 0, 1), seg(b, 1, 2)]]);
    expect(rows).toHaveLength(4);
    expect(rows[1].totals[0]).toBeCloseTo(100, 9);
    expect(rows[1].totals[1]).toBeCloseTo(150, 9);
    expect(rows[1].diff[1]).toBeCloseTo(50, 9);
    expect(rows[3].totals[1]).toBeCloseTo(100 + Math.hypot(10, 60), 9);
    expect(rows[3].diff[0]).toBe(0);
  });

  it('a piece cut in fewer sizes gives null for the missing sizes', () => {
    const { doc, id } = setup();
    const a = add(doc, 'A', rectangleContour(0, 0, 100, 50));
    doc.transact('sizes', () => { doc.piece(a.id).sizes = [id('M'), id('L')]; });
    const rows = measureGroup(doc, [seg(a, 0, 1)], 'contour', { line: doc.sizeLine() });
    expect(rows.map(r => r.total)).toEqual([null, 100, 100, null]);
  });
});

describe('gradeByMeasurement', () => {
  it('hits the spec within 0.01 mm on straight segments (one undo step, other sizes untouched)', () => {
    const { doc, id } = setup(['S', 'M', 'L', 'XL', '2XL']);
    const p = add(doc, 'A', rectangleContour(0, 0, 100, 50));
    const parts = [seg(p, 0, 1), seg(p, 2, 3)]; // hem + top = "chest" 200 at base
    const targets = { [id('S')]: 190, [id('M')]: 200, [id('L')]: 212, [id('XL')]: 222.5, [id('2XL')]: 236 };
    const movers = [1, 2].map(i => ({ pieceId: p.id, anchorId: p.sew.points[i].id, dir: { x: 1, y: 0 } }));
    const before = JSON.stringify(doc.style);
    const res = gradeByMeasurement(doc, { parts, targets, movers });
    expect(res.written).toBe(true);
    for (const r of res.rows) {
      if (r.sizeName === 'M') { expect(r.solved).toBe(false); expect(r.residual).toBeCloseTo(0, 9); continue; }
      expect(r.solved).toBe(true);
      expect(Math.abs(r.residual!)).toBeLessThan(0.01);
      expect(measureGroup(doc, parts).find(g => g.sizeId === r.sizeId)!.total).toBeCloseTo(targets[r.sizeId], 2);
    }
    // half the change per moved edge: L +12 → each X +6
    expect(res.rows.find(r => r.sizeName === 'L')!.t).toBeCloseTo(6, 4);
    expect(res.maxResidual).toBeLessThan(0.01);
    // the base and the unmoved points keep their geometry
    expect(doc.piece(p.id).sew.points[1].x).toBe(100);
    expect(doc.piece(p.id).sew.points[0].grade).toEqual({});
    expect(doc.undo()).toBe(true);
    expect(JSON.stringify(doc.style).replace(/"updatedAt":"[^"]*"/g, '')).toBe(before.replace(/"updatedAt":"[^"]*"/g, ''));
  });

  it('straight segment moved off its own direction is still exact; preview does not write', () => {
    const { doc, id } = setup();
    const p = add(doc, 'D', makeContour([gradePoint(0, 0), gradePoint(80, 60), gradePoint(0, 60)]));
    const parts = [seg(p, 0, 1)]; // diagonal 100
    const r0 = JSON.stringify(doc.style);
    const res = gradeByMeasurement(doc, { parts, targets: { [id('L')]: 107, [id('XL')]: 115, [id('S')]: 93 }, movers: [{ pieceId: p.id, anchorId: p.sew.points[1].id, dir: { x: 0, y: 1 } }], write: false });
    expect(res.written).toBe(false);
    expect(JSON.stringify(doc.style)).toBe(r0);
    for (const r of res.rows.filter(r => r.solved)) expect(Math.abs(r.residual!)).toBeLessThan(0.01);
    // dX would be exact too: y moves → hypot(80, 60 + t) = target
    expect(res.rows.find(r => r.sizeName === 'L')!.t).toBeCloseTo(Math.sqrt(107 ** 2 - 80 ** 2) - 60, 4);
  });

  it('curves: reports the achieved value and the residual per size; unreachable targets stay unsolved', () => {
    const { doc, id } = setup();
    const c = makeContour([gradePoint(0, 0), curvePoint(40, 30), curvePoint(80, 30), gradePoint(120, 0), gradePoint(120, -50), gradePoint(0, -50)]);
    const p = add(doc, 'C', c);
    const parts = [seg(p, 0, 3)];
    const base = measureSegment(doc, p.id, p.sew.id, c.points[0].id, c.points[3].id);
    const res = gradeByMeasurement(doc, {
      parts, mode: 'contour',
      targets: { [id('L')]: base + 6, [id('XL')]: base + 13, [id('S')]: 50 /* below the straight chord: impossible by an X move? */ },
      movers: [{ pieceId: p.id, anchorId: c.points[3].id, dir: { x: 1, y: 0 } }],
    });
    for (const n of ['L', 'XL']) {
      const r = res.rows.find(x => x.sizeName === n)!;
      expect(r.solved).toBe(true);
      expect(r.after).not.toBeNull();
      expect(Math.abs(r.residual!)).toBeLessThan(0.01);
    }
    const s = res.rows.find(x => x.sizeName === 'S')!;
    expect(s.residual).not.toBeNull();
    expect(typeof s.residual).toBe('number');
    // every row reports before/after/residual = after − target
    for (const r of res.rows) if (r.target !== null && r.after !== null) expect(r.residual).toBeCloseTo(r.after - r.target, 9);
  });

  it('implicit curve point as mover is materialised (other sizes keep their position)', () => {
    const { doc, id } = setup();
    const c = makeContour([gradePoint(0, 0), curvePoint(50, 10), gradePoint(100, 0), gradePoint(100, -40), gradePoint(0, -40)]);
    const p = add(doc, 'K', c);
    const res = gradeByMeasurement(doc, { parts: [seg(p, 0, 2)], targets: { [id('L')]: 105 }, movers: [{ pieceId: p.id, anchorId: c.points[1].id, dir: { x: 0, y: 1 } }] });
    expect(res.rows.find(r => r.sizeName === 'L')!.solved).toBe(true);
    const a = doc.piece(p.id).sew.points[1];
    expect(Object.keys(a.grade).length).toBeGreaterThan(0);
    const abs = incrementalToAbsolute(a.grade, doc.sizeLine());
    expect(abs[id('XL')].dy).toBeCloseTo(0, 9);
    expect(abs[id('L')].dy).not.toBeCloseTo(0, 3);
  });
});

describe('rule table helpers', () => {
  it('outward steps ⇄ totals (AccuMark: smaller sizes carry their own step away from the base)', () => {
    const tot = [-10, -5, 0, 5, 12];
    expect(outwardSteps(tot, 2)).toEqual([-5, -5, 0, 5, 7]);
    expect(totalsFromSteps([-5, -5, 0, 5, 7], 2)).toEqual(tot);
    expect(affectedSizes(5, 2, 3, 'step')).toEqual([3, 4]);
    expect(affectedSizes(5, 2, 1, 'step')).toEqual([1, 0]);
    expect(affectedSizes(5, 2, 1, 'total')).toEqual([1]);
    expect(affectedSizes(5, 2, 2, 'step')).toEqual([]);
  });

  it('smartFill: linear / interpolate / repeat / breaks', () => {
    const z = [0, 0, 0, 0, 0, 0, 0];
    // linear: one typed step above the base → equal steps; a side without anchors keeps current
    let r = smartFill([-3, -1, 0, 0, 0, 0, 0], 2, [{ i: 3, v: 5 }], 'step', 'linear');
    expect(r.totals).toEqual([-3, -1, 0, 5, 10, 15, 20]);
    // linear in totals: last size typed = 40 → 10 per size
    r = smartFill(z, 2, [{ i: 6, v: 40 }, { i: 0, v: -12 }], 'total', 'linear');
    expect(r.totals).toEqual([-12, -6, 0, 10, 20, 30, 40]);
    // interpolate totals: through (L=5) and (3XL=29) → piecewise, ends continue
    r = smartFill(z, 2, [{ i: 3, v: 5 }, { i: 5, v: 21 }], 'total', 'interpolate');
    expect(r.totals.slice(2)).toEqual([0, 5, 13, 21, 29]);
    // interpolate steps: ramp 5 → 11 between L and 3XL
    r = smartFill(z, 2, [{ i: 3, v: 5 }, { i: 6, v: 11 }], 'step', 'interpolate');
    expect(r.steps.slice(3)).toEqual([5, 7, 9, 11]);
    // repeat: step 5 from L, step 8 from 2XL
    r = smartFill(z, 2, [{ i: 3, v: 5 }, { i: 5, v: 8 }, { i: 1, v: -4 }], 'step', 'repeat');
    expect(r.steps).toEqual([-4, -4, 0, 5, 5, 8, 8]);
    // breaks: break at 2XL (index 5) with total 15 → 5 per size until it, then continue 5
    r = smartFill(z, 2, [{ i: 5, v: 15 }], 'total', 'breaks', [5]);
    expect(r.totals.slice(2)).toEqual([0, 5, 10, 15, 20]);
    // breaks with two ranges (step view: value = change over the range)
    r = smartFill(z, 2, [{ i: 4, v: 10 }, { i: 6, v: 16 }], 'step', 'breaks', [4, 6]);
    expect(r.totals.slice(2)).toEqual([0, 5, 10, 18, 26]);
    // breaks without typed values re-distribute the current totals at the breaks
    r = smartFill([0, 0, 0, 2, 12, 13, 30], 2, [{ i: 6, v: 30 }], 'total', 'breaks', [4]);
    expect(r.totals.slice(2)).toEqual([0, 6, 12, 21, 30]);
  });

  it('size breaks are stored with the style (undoable)', () => {
    const { doc, line, id } = setup();
    expect(sizeBreaks(doc, line.id)).toEqual([]);
    setSizeBreaks(doc, line.id, [id('L'), id('L')]);
    expect(sizeBreaks(doc, line.id)).toEqual([id('L')]);
    doc.undo();
    expect(sizeBreaks(doc, line.id)).toEqual([]);
  });

  it('Modify rule refreshes linked points; Copy Table Rule flips; delete detaches; status badges', () => {
    const { doc } = setup();
    const p = add(doc, 'A', rectangleContour(0, 0, 100, 50));
    const libId = createLibrary(doc, 'L');
    const lib = library(doc, libId);
    const sid = (n: string) => lib.sizeLine.sizes.find(s => s.name === n)!.id;
    const r = createRuleFromValues(doc, libId, { L: { dx: 5, dy: 0 }, XL: { dx: 5, dy: 0 } });
    const a1 = p.sew.points[1].id, a2 = p.sew.points[2].id, a0 = p.sew.points[0].id;
    applyRule(doc, p.id, [a1], r.number);
    expect(gradeStatus(doc, p.id, a1)).toBe('rule');
    expect(gradeStatus(doc, p.id, a0)).toBe('ungraded');
    const n = setRuleValues(doc, libId, r.id, { [sid('S')]: { dx: -4, dy: 0 }, [sid('L')]: { dx: 6, dy: 1 }, [sid('XL')]: { dx: 13, dy: 2 } }, { view: 'absolute' });
    expect(n).toBe(1);
    const inc = doc.piece(p.id).sew.points[1].grade;
    const abs = incrementalToAbsolute(inc, doc.sizeLine());
    const did = (nm: string) => doc.sizeLine().sizes.find(s => s.name === nm)!.id;
    expect(abs[did('XL')]).toEqual({ dx: 13, dy: 2 });
    expect(abs[did('S')]).toEqual({ dx: -4, dy: 0 });
    const c = copyRule(doc, libId, r.id, { flipX: true });
    expect(c.number).toBe(2);
    applyRule(doc, p.id, [a2], c.number);
    expect(incrementalToAbsolute(doc.piece(p.id).sew.points[2].grade, doc.sizeLine())[did('XL')]).toEqual({ dx: -13, dy: 2 });
    // locally edited → 'edited' (ruleName gets '*')
    doc.transact('edit', () => { doc.piece(p.id).sew.points[2].grade[did('XL')] = { dx: 0, dy: 0 }; });
    expect(ruleName(doc, p.id, a2).endsWith('*')).toBe(true);
    expect(gradeStatus(doc, p.id, a2)).toBe('edited');
    renameRule(doc, libId, c.id, { name: 'Mirror', number: 7 });
    expect(library(doc, libId).rules.find(x => x.id === c.id)!.number).toBe(7);
    expect(() => renameRule(doc, libId, c.id, { number: 1 })).toThrow();
    expect(deleteRule(doc, libId, r.id)).toBe(1);
    expect(doc.piece(p.id).sew.points[1].ruleId).toBeUndefined();
    expect(gradeStatus(doc, p.id, a1)).toBe('graded');
  });
});
