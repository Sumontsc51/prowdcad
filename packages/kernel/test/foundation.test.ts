import { describe, it, expect } from 'vitest';
import { parseNumber, parseLengthAuto, formatLength, formatFraction } from '../src/units';
import { offsetOutward, signedArea, perimeter, area, removeSelfIntersections } from '../src/geom/poly';
import { makeStyle, rectangleContour, makePiece, curvePoint, gradePoint, makeContour, circleContour } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour, absoluteOffset, absoluteToIncremental, incrementalToAbsolute } from '../src/model/contour';

describe('units', () => {
  it('parses decimals and fractions equivalently', () => {
    expect(parseNumber('1.125')).toBeCloseTo(1.125, 12);
    expect(parseNumber('1 1/8')).toBeCloseTo(1.125, 12);
    expect(parseNumber('1.1/8')).toBeCloseTo(1.125, 12);
    expect(parseNumber('1-1/8')).toBeCloseTo(1.125, 12);
    expect(parseNumber('9/8')).toBeCloseTo(1.125, 12);
    expect(parseNumber('-3/4')).toBeCloseTo(-0.75, 12);
    expect(parseLengthAuto('1 1/8"', 'mm')).toBeCloseTo(28.575, 9);
    expect(parseLengthAuto('2cm', 'in')).toBeCloseTo(20, 9);
    expect(Number.isNaN(parseNumber('abc'))).toBe(true);
  });
  it('formats fractions', () => {
    expect(formatFraction(1.125, 8)).toBe('1 1/8');
    expect(formatFraction(0.5, 16)).toBe('1/2');
    expect(formatLength(28.575, { unit: 'in', fractionDenominator: 8 })).toBe('1 1/8');
    expect(formatLength(12.5, { unit: 'cm' })).toBe('1.25');
  });
});

describe('offset (acceptance D1)', () => {
  const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  it('100 mm square +10 → 120×120, CCW', () => {
    const o = offsetOutward(sq, 10);
    expect(o.length).toBe(4);
    const xs = o.map(p => p.x), ys = o.map(p => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-10, 9); expect(Math.max(...xs)).toBeCloseTo(110, 9);
    expect(Math.min(...ys)).toBeCloseTo(-10, 9); expect(Math.max(...ys)).toBeCloseTo(110, 9);
    expect(area(o)).toBeCloseTo(120 * 120, 6);
    expect(signedArea(o) > 0).toBe(true); // winding preserved
  });
  it('100 mm square +10 → 120×120, CW', () => {
    const cw = sq.slice().reverse();
    const o = offsetOutward(cw, 10);
    expect(area(o)).toBeCloseTo(14400, 6);
    expect(signedArea(o) < 0).toBe(true);
  });
  it('shrink −10 → 80×80', () => {
    expect(area(offsetOutward(sq, -10))).toBeCloseTo(6400, 6);
  });
  it('per-segment seam values', () => {
    const o = offsetOutward(sq, [10, 20, 10, 20]); // bottom 10, right 20, top 10, left 20
    expect(area(o)).toBeCloseTo(140 * 120, 6);
  });
  it('removes inverted loops on inward offset of a concave shape', () => {
    const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 100 }, { x: 0, y: 100 }];
    const o = offsetOutward(L, -12); // notch arm width 30 → 6 wide, still valid
    expect(o.length).toBeGreaterThanOrEqual(6);
    const o2 = offsetOutward(L, -16); // arms collapse (30-32<0) → cleanup must leave a valid polygon
    expect(o2.length).toBeGreaterThanOrEqual(3);
    expect(area(o2)).toBeGreaterThan(0);
  });
});

describe('contour resolution & grading', () => {
  it('rectangle resolves to 4 pts and grades incrementally in both directions', () => {
    const style = makeStyle('t', ['S', 'M', 'L', 'XL'], 'M');
    const doc = new Document(style);
    const line = doc.sizeLine();
    const [S, M, L, XL] = line.sizes.map(s => s.id);
    const c = rectangleContour(0, 0, 100, 50);
    // grade right edge +10 per size in X
    for (const i of [1, 2]) c.points[i].grade = { [M]: { dx: 10, dy: 0 }, [L]: { dx: 10, dy: 0 }, [XL]: { dx: 10, dy: 0 } };
    const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
    doc.transact('add', s => s.pieces.push(piece));
    const rM = doc.resolvePiece(piece.id, M), rL = doc.resolvePiece(piece.id, L), rXL = doc.resolvePiece(piece.id, XL), rS = doc.resolvePiece(piece.id, S);
    expect(rM.sew.pts.length).toBe(4);
    expect(rM.sew.anchorPos[1].x).toBeCloseTo(100);
    expect(rL.sew.anchorPos[1].x).toBeCloseTo(110);
    expect(rXL.sew.anchorPos[1].x).toBeCloseTo(120);
    expect(rS.sew.anchorPos[1].x).toBeCloseTo(90);
    expect(area(rXL.cut)).toBeCloseTo((120 + 20) * (50 + 20), 6);
  });
  it('absolute ⇄ incremental round-trips', () => {
    const style = makeStyle('t', ['S', 'M', 'L', 'XL'], 'M');
    const line = style.sizeTables[0].axis1;
    const [S, M, L, XL] = line.sizes.map(s => s.id);
    const abs = { [S]: { dx: -8, dy: -2 }, [L]: { dx: 12, dy: 3 }, [XL]: { dx: 25, dy: 6 } };
    const inc = absoluteToIncremental(abs, line);
    expect(inc[M]).toEqual({ dx: 8, dy: 2 }); expect(inc[L]).toEqual({ dx: 12, dy: 3 }); expect(inc[XL]).toEqual({ dx: 13, dy: 3 });
    const back = incrementalToAbsolute(inc, line);
    expect(back[S]).toEqual({ dx: -8, dy: -2 }); expect(back[XL]).toEqual({ dx: 25, dy: 6 }); expect(back[M]).toEqual({ dx: 0, dy: 0 });
    expect(absoluteOffset(inc, line, S)).toEqual({ x: -8, y: -2 });
  });
  it('curve points interpolate grading proportionally and sample a smooth curve', () => {
    const style = makeStyle('t', ['S', 'M', 'L'], 'M');
    const line = style.sizeTables[0].axis1;
    const L = line.sizes[2].id;
    const c = makeContour([
      gradePoint(0, 0), gradePoint(100, 0, { grade: { [L]: { dx: 0, dy: 0 } } }),
      curvePoint(110, 50), gradePoint(100, 100, { grade: { [L]: { dx: 0, dy: 20 } } }), gradePoint(0, 100, { grade: { [L]: { dx: 0, dy: 20 } } }),
    ]);
    const base = resolveContour(c, line, line.baseSizeId);
    expect(base.pts.length).toBeGreaterThan(10); // the curved side was sampled
    const r = resolveContour(c, line, L);
    expect(r.anchorPos[2].y).toBeCloseTo(60, 1); // 50 + ~50% of 20
  });
  it('circle contour perimeter ≈ 2πr', () => {
    const style = makeStyle(); const line = style.sizeTables[0].axis1;
    const r = resolveContour(circleContour(0, 0, 50, 16), line, line.baseSizeId);
    expect(perimeter(r.pts)).toBeCloseTo(2 * Math.PI * 50, 0);
  });
});

describe('document undo/redo', () => {
  it('undoes and redoes transactions, nested = one step', () => {
    const doc = new Document(makeStyle());
    const piece = makePiece('A', rectangleContour(0, 0, 10, 10), doc.style.activeSizeTableId);
    doc.transact('add', s => { s.pieces.push(piece); doc.transact('rename', s2 => { s2.pieces[0].name = 'B'; }); });
    expect(doc.style.pieces[0].name).toBe('B');
    expect(doc.undo()).toBe(true);
    expect(doc.style.pieces.length).toBe(0);
    expect(doc.redo()).toBe(true);
    expect(doc.style.pieces[0].name).toBe('B');
    for (let i = 0; i < 250; i++) doc.transact('n', s => { s.pieces[0].seamDefault = i; });
    expect(doc.canUndo()).toBe(true);
    let n = 0; while (doc.undo()) n++;
    expect(n).toBe(200);
  });
});
