import { describe, it, expect } from 'vitest';
import { parseNumber, parseLengthAuto, formatLength, formatFraction } from '../src/units';
import { offsetOutward, signedArea, perimeter, area, removeSelfIntersections, distToPolygon, segIntersect, pointInPolygon } from '../src/geom/poly';

type V = { x: number; y: number };
/** minimum distance from any point of the closed polygon o (edges sampled) to the closed polygon p */
const minDistFrom = (o: V[], p: V[]) => { let m = Infinity; for (let i = 0; i < o.length; i++) { const a = o[i], b = o[(i + 1) % o.length]; for (let k = 0; k <= 20; k++) m = Math.min(m, distToPolygon({ x: a.x + (b.x - a.x) * k / 20, y: a.y + (b.y - a.y) * k / 20 }, p)); } return m; };
const selfCrossings = (p: V[]) => { let c = 0; const n = p.length; for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) { if (i === 0 && j === n - 1) continue; const r = segIntersect(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n]); if (r && r.t > 1e-9 && r.t < 1 - 1e-9 && r.u > 1e-9 && r.u < 1 - 1e-9) c++; } return c; };
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
    const o = offsetOutward(L, -12); // arm width 30 → 6 wide, still valid
    expect(o.length).toBe(6);
    expect(area(o)).toBeCloseTo(6 * 76 + 6 * 70, 6); // (12..88)×(12..18) ∪ (12..18)×(18..88)
    // B4: arms 30 < 2·16 → the whole L vanishes (the old code kept an inverted sliver: area > 0)
    const o2 = offsetOutward(L, -16);
    expect(o2).toEqual([]);
    expect(area(o2)).toBe(0);
  });
  it('B4: an inward offset that vanishes returns an empty polygon', () => {
    for (const p of [sq, sq.slice().reverse()]) {
      expect(offsetOutward(p, -60)).toEqual([]); // was an inverted 20×20 square
      expect(offsetOutward(p, -50)).toEqual([]); // was a single point
      expect(area(offsetOutward(p, -49))).toBeCloseTo(4, 9);
    }
    // dumbbell: the 20 mm neck closes at −15, the larger lobe survives
    const D = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 150, y: 40 }, { x: 150, y: 0 }, { x: 250, y: 0 }, { x: 250, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 60 }, { x: 100, y: 60 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const od = offsetOutward(D, -15);
    expect(area(od)).toBeCloseTo(70 * 70, 6);
    expect(signedArea(od) > 0).toBe(true);
  });
  it('B5: outward offset closes a slot narrower than 2d instead of dipping to the sew line', () => {
    const U = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 55, y: 100 }, { x: 55, y: 40 }, { x: 45, y: 40 }, { x: 45, y: 100 }, { x: 0, y: 100 }];
    for (const p of [U, U.slice().reverse()]) {
      const o = offsetOutward(p, 10);
      expect(area(o)).toBeCloseTo(120 * 120, 6); // was 15000 (cut dipped into the slot)
      expect(Math.sign(signedArea(o))).toBe(Math.sign(signedArea(p)));
      expect(minDistFrom(o, p)).toBeGreaterThanOrEqual(10 - 1e-9);
    }
    // a slot wider than 2d stays open
    const W = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 65, y: 100 }, { x: 65, y: 40 }, { x: 35, y: 40 }, { x: 35, y: 100 }, { x: 0, y: 100 }];
    expect(area(offsetOutward(W, 10))).toBeCloseTo(14400 - 10 * 60, 6);
  });
  it('B10: duplicate consecutive points do not notch the offset', () => {
    const P = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const o = offsetOutward(P, 10);
    expect(area(o)).toBeCloseTo(14400, 6);
    expect(minDistFrom(o, P)).toBeGreaterThanOrEqual(10 - 1e-9);
    const style = makeStyle('t', ['S', 'M', 'L'], 'M'); const doc = new Document(style);
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), gradePoint(100, 0), gradePoint(100, 100), gradePoint(0, 100)]);
    const piece = makePiece('DUP', c, doc.style.activeSizeTableId, { seamDefault: 10 });
    doc.transact('add', s => s.pieces.push(piece));
    const cut = doc.resolvePiece(piece.id).cut;
    expect(area(cut)).toBeCloseTo(14400, 6); // was 14300 with the cut touching the sew corner
    expect(minDistFrom(cut, P)).toBeGreaterThanOrEqual(10 - 1e-9);
  });
  it('B11: a 5° spike keeps the full allowance at the tip (miter limit → square cap)', () => {
    const h = 200 * Math.tan(5 * Math.PI / 180) / 2;
    const P = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 300, y: 50 + h }, { x: 100, y: 50 + 2 * h }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    for (const join of ['miter', 'bevel', 'round'] as const) {
      const o = offsetOutward(P, 10, join);
      expect(minDistFrom(o, P)).toBeGreaterThanOrEqual(10 - 1e-9); // was 0.25 mm at the tip
      expect(Math.max(...o.map(q => q.x))).toBeLessThan(300 + 10 * 4 + 1e-6);
    }
  });
  it('random star polygons: no self-crossings, winding kept, ≥ 0.999·d from the sew line', () => {
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let bad = 0;
    for (let t = 0; t < 300; t++) {
      const n = 5 + Math.floor(rnd() * 14); const P: V[] = [];
      for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI, r = 40 + rnd() * 80; P.push({ x: r * Math.cos(a), y: r * Math.sin(a) }); }
      const poly = rnd() < 0.5 ? P : P.slice().reverse();
      const d = (rnd() < 0.5 ? 1 : -1) * (2 + rnd() * 20);
      for (const ml of [1e9, 4]) {
        const o = offsetOutward(poly, d, 'miter', ml);
        const ok = o.length >= 3 && selfCrossings(o) === 0 && Math.sign(signedArea(o)) === Math.sign(signedArea(poly))
          && (d > 0 ? minDistFrom(o, poly) >= 0.999 * d && o.every(q => !pointInPolygon(q, poly)) : o.every(q => pointInPolygon(q, poly)) && minDistFrom(o, poly) >= 0.999 * -d);
        if (!ok) bad++;
      }
    }
    expect(bad).toBe(0);
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

describe('contour robustness & precision (B9, B12)', () => {
  it('B9: open contour starting with curve points resolves in every size (rigid with the only grade neighbour)', () => {
    const style = makeStyle('t', ['S', 'M', 'L'], 'M'); const line = style.sizeTables[0].axis1;
    const L = line.sizes[2].id;
    const c = makeContour([curvePoint(0, 0), curvePoint(50, 30), gradePoint(100, 0, { grade: { [L]: { dx: 10, dy: 5 } } }), gradePoint(150, 0)], { closed: false });
    const r = resolveContour(c, line, L);
    expect(r.anchorPos.map(p => [p.x, p.y])).toEqual([[10, 5], [60, 35], [110, 5], [150, 0]]);
    // trailing curve points too
    const c2 = makeContour([gradePoint(0, 0), gradePoint(100, 0, { grade: { [L]: { dx: 10, dy: 5 } } }), curvePoint(150, 30), curvePoint(200, 0)], { closed: false });
    expect(resolveContour(c2, line, L).anchorPos.map(p => [p.x, p.y])).toEqual([[0, 0], [110, 5], [160, 35], [210, 5]]);
  });
  it('B12: curve lengths within 0.001 mm of a tol = 0.001 reference', () => {
    const style = makeStyle('t', ['S', 'M', 'L'], 'M'); const line = style.sizeTables[0].axis1;
    const [S, , L] = line.sizes.map(s => s.id);
    const R = 600, k = 0.5522847498 * R;
    const quarter = makeContour([gradePoint(R, 0, { hOut: { x: 0, y: k } }), gradePoint(0, R, { hIn: { x: k, y: 0 } })], { closed: false });
    const cap = makeContour([gradePoint(0, 0), curvePoint(60, 90), curvePoint(160, 140), curvePoint(260, 90), gradePoint(320, 0, { grade: { [L]: { dx: 8, dy: 0 }, [S]: { dx: 0, dy: 0 } } })], { closed: false });
    const hem = makeContour([gradePoint(0, 0), curvePoint(100, -20), curvePoint(250, -10), gradePoint(400, 30), gradePoint(400, 600), gradePoint(0, 600)]);
    const refLen = (c: typeof hem, sz: string) => {
      // reference: the same resolver at chord tolerance 0.001 mm (independent check: dense integration below)
      const r = resolveContour(c, line, sz, 0.001);
      return r.cum[r.cum.length - 1];
    };
    for (const c of [quarter, cap, hem]) for (const sz of [S, line.baseSizeId, L]) {
      const r = resolveContour(c, line, sz);
      expect(Math.abs(r.cum[r.cum.length - 1] - refLen(c, sz))).toBeLessThan(0.001);
    }
    // the quarter circle (was 942.6054 vs 942.6100)
    const rq = resolveContour(quarter, line, line.baseSizeId);
    let exact = 0, pr = { x: R, y: 0 }; const N = 200000;
    for (let i = 1; i <= N; i++) { const t = i / N, u = 1 - t; const q = { x: u * u * u * R + 3 * u * u * t * R + 3 * u * t * t * k, y: 3 * u * u * t * k + 3 * u * t * t * R + t * t * t * R }; exact += Math.hypot(q.x - pr.x, q.y - pr.y); pr = q; }
    expect(Math.abs(rq.cum[rq.cum.length - 1] - exact)).toBeLessThan(0.001);
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
