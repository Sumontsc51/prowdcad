import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint, rectangleContour, newId } from '../src/model/factory';
import { resolveContour, spanPolyline } from '../src/model/contour';
import { polylineLength } from '../src/geom/poly';
import type { Contour, Piece } from '../src/model/types';
import {
  measureSegment, measureXY, measureDistance, measureAngle, measureSegmentsAngle, measureAcrossSizes,
  compareLengths, walkingCheck, segmentLengthSetTo, notchesOnSegment,
} from '../src/ops/measure';

function setup() {
  const doc = new Document(makeStyle('m', ['S', 'M', 'L', 'XL'], 'M'));
  const line = doc.sizeLine();
  const [S, M, L, XL] = line.sizes.map(s => s.id);
  return { doc, line, S, M, L, XL };
}
function add(doc: Document, name: string, c: Contour): Piece {
  const p = makePiece(name, c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(p));
  return p;
}
/** independent reference: polylineLength on the resolved geometry */
const refLen = (doc: Document, p: Piece, a: number, b: number, size: string) => polylineLength(spanPolyline(resolveContour(doc.piece(p.id).sew, doc.sizeLine(), size), a, b));

describe('basic measures', () => {
  it('segment, XY, distance, angle', () => {
    const { doc, M } = setup();
    const p = add(doc, 'A', rectangleContour(0, 0, 100, 50));
    const ids = p.sew.points.map(a => a.id);
    expect(measureSegment(doc, p.id, 'sew', ids[0], ids[2], M)).toBeCloseTo(150, 9);
    expect(measureSegment(doc, p.id, p.sew.id, ids[0], ids[2], M, true)).toBeCloseTo(150, 9);
    expect(measureSegment(doc, p.id, 'sew', ids[3], ids[1])).toBeCloseTo(150, 9); // wraps
    expect(measureSegment(doc, p.id, 'sew', ids[0], ids[1], M, true)).toBeCloseTo(200, 9);
    const xy = measureXY(doc, { pieceId: p.id, anchorId: ids[0] }, { pieceId: p.id, anchorId: ids[2] });
    expect(xy.dx).toBe(100); expect(xy.dy).toBe(50);
    expect(xy.distance).toBeCloseTo(Math.hypot(100, 50), 12);
    expect(xy.angleDeg).toBeCloseTo(Math.atan2(50, 100) * 180 / Math.PI, 12);
    expect(measureDistance(doc, { x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    const ang = measureAngle(doc, { pieceId: p.id, anchorId: ids[0] }, { pieceId: p.id, anchorId: ids[1] }, { pieceId: p.id, anchorId: ids[3] });
    expect(ang.deg).toBeCloseTo(90, 12); expect(ang.signedDeg).toBeCloseTo(90, 12);
    const sa = measureSegmentsAngle(doc, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: -10, y: 10 });
    expect(sa.deg).toBeCloseTo(135, 12); expect(sa.lineDeg).toBeCloseTo(45, 12);
  });

  it('measureAcrossSizes: per-size lengths and per-size dX/dY of a point', () => {
    const { doc, S, M, L, XL } = setup();
    const c = rectangleContour(0, 0, 100, 50);
    for (const i of [1, 2]) c.points[i].grade = { [M]: { dx: 5, dy: 0 }, [L]: { dx: 5, dy: 0 }, [XL]: { dx: 7, dy: 0 } };
    c.points[2].grade = { [M]: { dx: 5, dy: 2 }, [L]: { dx: 5, dy: 2 }, [XL]: { dx: 7, dy: 3 } };
    const p = add(doc, 'A', c);
    const seg = measureAcrossSizes(doc, { pieceId: p.id, contourId: 'sew', from: c.points[0].id, to: c.points[1].id });
    expect(seg.map(r => r.value)).toEqual([95, 100, 105, 112]);
    expect(seg.map(r => r.vsBase)).toEqual([-5, 0, 5, 12]);
    expect(seg.map(r => r.inc)).toEqual([0, 5, 5, 7]);
    const pt = measureAcrossSizes(doc, { pieceId: p.id, anchorId: c.points[2].id });
    expect(pt.map(r => [r.dX, r.dY])).toEqual([[-5, -2], [0, 0], [5, 2], [12, 5]]);
    void S;
  });
});

describe('compare lengths (acceptance D7)', () => {
  it('sleeve cap − (front + back armhole) = ease per size, equals hand computation', () => {
    const { doc, S, M, L, XL } = setup();
    const sizes = [S, M, L, XL];
    const g = (dx: number, dy: number) => ({ [M]: { dx, dy }, [L]: { dx, dy }, [XL]: { dx: dx * 1.5, dy: dy * 1.5 } });
    // sleeve: cap is a smooth curve from underarm-back (0) to underarm-front (6)
    const sleeve = makeContour([
      gradePoint(0, 0, { grade: g(-6, 0) }),
      curvePoint(45, 70), curvePoint(110, 125),
      gradePoint(200, 145, { grade: g(0, 4), smooth: true }),
      curvePoint(290, 120), curvePoint(355, 60),
      gradePoint(400, 0, { grade: g(6, 0) }),
      gradePoint(330, -420, { grade: g(3, -10) }), gradePoint(70, -420, { grade: g(-3, -10) }),
    ]);
    // front bodice: armhole from shoulder (2) down to underarm (5)
    const front = makeContour([
      gradePoint(0, 0), gradePoint(260, 0, { grade: g(6, 0) }),
      gradePoint(260, 400, { grade: g(6, 8) }), // underarm side
      curvePoint(215, 425), curvePoint(195, 480),
      gradePoint(200, 600, { grade: g(4, 12) }), // shoulder tip
      gradePoint(0, 640, { grade: g(0, 12) }),
    ]);
    const back = makeContour([
      gradePoint(0, 0), gradePoint(270, 0, { grade: g(6, 0) }),
      gradePoint(270, 400, { grade: g(6, 8) }),
      curvePoint(230, 430), curvePoint(212, 500),
      gradePoint(215, 610, { grade: g(4, 12) }),
      gradePoint(0, 650, { grade: g(0, 12) }),
    ]);
    const sp = add(doc, 'SLEEVE', sleeve), fp = add(doc, 'FRONT', front), bp = add(doc, 'BACK', back);
    const res = compareLengths(doc, {
      plus: [{ pieceId: sp.id, contourId: 'sew', from: sleeve.points[0].id, to: sleeve.points[6].id }],
      minus: [
        { pieceId: fp.id, contourId: 'sew', from: front.points[2].id, to: front.points[5].id },
        { pieceId: bp.id, contourId: 'sew', from: back.points[2].id, to: back.points[5].id },
      ],
      mode: 'contour',
    });
    expect(res.sizes.length).toBe(4);
    const eases: number[] = [];
    sizes.forEach((s, i) => {
      const cap = refLen(doc, sp, 0, 6, s);
      const arm = refLen(doc, fp, 2, 5, s) + refLen(doc, bp, 2, 5, s);
      const row = res.sizes[i];
      expect(row.sizeId).toBe(s);
      expect(row.plus).toBeCloseTo(cap, 9);
      expect(row.minus).toBeCloseTo(arm, 9);
      expect(row.diff).toBeCloseTo(cap - arm, 9);
      expect(row.minusParts.length).toBe(2);
      eases.push(row.diff);
    });
    // sanity: a real cap with positive ease, and the cap/armhole are curved (longer than chords)
    expect(eases.every(e => e > 0)).toBe(true);
    expect(res.sizes[1].plus).toBeGreaterThan(400);
    // diagonal / x / y modes
    const diag = compareLengths(doc, { plus: [{ pieceId: sp.id, contourId: 'sew', from: sleeve.points[0].id, to: sleeve.points[6].id }], minus: [], mode: 'diagonal' });
    expect(diag.sizes.map(r => r.plus)).toEqual([388, 400, 412, 430]) // XL inc ×1.5;
    const yy = compareLengths(doc, { plus: [{ pieceId: fp.id, contourId: 'sew', from: front.points[2].id, to: front.points[5].id }], minus: [], mode: 'y' });
    expect(yy.sizes[1].plus).toBe(200); expect(yy.sizes[2].plus).toBeCloseTo(204, 12);
    const xx = compareLengths(doc, { plus: [{ pieceId: fp.id, contourId: 'sew', from: front.points[2].id, to: front.points[5].id }], minus: [], mode: 'x' });
    expect(xx.sizes[1].plus).toBe(60);
  });
});

describe('walking check + notch mismatch', () => {
  it('reports lengths, Δ, pass/fail and unmatched notches per size', () => {
    const { doc, M, L, XL } = setup();
    const a = rectangleContour(0, 0, 300, 100), b = rectangleContour(0, 200, 302, 100);
    for (const i of [1, 2]) { a.points[i].grade = { [M]: { dx: 10, dy: 0 }, [L]: { dx: 10, dy: 0 }, [XL]: { dx: 10, dy: 0 } }; b.points[i].grade = { [M]: { dx: 10, dy: 0 }, [L]: { dx: 10, dy: 0 }, [XL]: { dx: 14, dy: 0 } }; }
    const pa = add(doc, 'A', a), pb = add(doc, 'B', b);
    const notch = (pc: Piece, d: number) => ({ id: newId('n'), contourId: pc.sew.id, placement: { kind: 'fromPrev' as const, anchorId: pc.sew.points[0].id, dist: { [M]: d } }, type: 'slit' as const, depth: 5, width: 0, angleDeg: 0 });
    doc.transact('n', () => {
      doc.piece(pa.id).notches.push(notch(pa, 100), notch(pa, 200));
      doc.piece(pb.id).notches.push(notch(pb, 100.3), notch(pb, 250));
    });
    const ref = (pc: Piece) => ({ pieceId: pc.id, contourId: 'sew', from: pc.sew.points[0].id, to: pc.sew.points[1].id });
    expect(notchesOnSegment(doc, ref(pa)).map(n => n.pos)).toEqual([100, 200]);
    const res = walkingCheck(doc, [{ a: ref(pb), b: ref(pa), easeTolerance: 3, notchTolerance: 0.5 }]);
    const rows = res.pairs[0].sizes;
    expect(rows.map(r => r.lengthA)).toEqual([292, 302, 312, 326]);
    expect(rows.map(r => r.lengthB)).toEqual([290, 300, 310, 320]);
    expect(rows.map(r => r.delta)).toEqual([2, 2, 2, 6]);
    const m = rows[1];
    expect(m.unmatchedA.map(n => n.pos)).toEqual([250]);
    expect(m.unmatchedB.map(n => n.pos)).toEqual([200]);
    expect(m.pass).toBe(false);
    expect(res.pass).toBe(false);
    // fix notch → lengths pass in S/M/L, XL fails on ease
    doc.transact('fix', () => { const n = doc.piece(pb.id).notches[1]; if (n.placement.kind === 'fromPrev') n.placement.dist[M] = 200.2; });
    const ok = walkingCheck(doc, [{ a: ref(pb), b: ref(pa), easeTolerance: 3, notchTolerance: 0.5 }]).pairs[0].sizes;
    expect(ok.map(r => r.pass)).toEqual([true, true, true, false]);
  });
});

describe('segment length set to', () => {
  const methods = ['moveEnd', 'halfH', 'halfV', 'halfDiag'] as const;
  for (const method of methods) {
    it(`${method}: straight diagonal segment hits target ±0.01`, () => {
      const { doc } = setup();
      const c = makeContour([gradePoint(0, 0), gradePoint(80, 60), gradePoint(80, 200), gradePoint(0, 200)]);
      const p = add(doc, 'A', c);
      for (const target of [130, 90]) {
        const r = segmentLengthSetTo(doc, p.id, 'sew', c.points[0].id, c.points[1].id, target, method);
        expect(r.converged).toBe(true);
        expect(Math.abs(measureSegment(doc, p.id, 'sew', c.points[0].id, c.points[1].id) - target)).toBeLessThan(0.01);
      }
      const end = doc.piece(p.id).sew.points[1];
      if (method === 'halfH') expect(end.y).toBe(60);
      if (method === 'halfV') expect(end.x).toBe(80);
      if (method === 'moveEnd') { expect(end.x).toBeCloseTo(72, 6); expect(end.y).toBeCloseTo(54, 6); }
      if (method === 'halfDiag') expect(end.x - 80).toBeCloseTo(end.y - 60, 9);
    });
  }

  it('curveBlend on a curved segment keeps ends fixed and converges', () => {
    const { doc } = setup();
    const c = makeContour([gradePoint(0, 0), curvePoint(40, 30), curvePoint(110, 35), gradePoint(150, 0), gradePoint(150, -100), gradePoint(0, -100)]);
    const p = add(doc, 'A', c);
    const L0 = measureSegment(doc, p.id, 'sew', c.points[0].id, c.points[3].id);
    for (const target of [L0 + 12.5, L0 - 4]) {
      const r = segmentLengthSetTo(doc, p.id, 'sew', c.points[0].id, c.points[3].id, target, 'curveBlend');
      expect(r.converged).toBe(true);
      expect(Math.abs(measureSegment(doc, p.id, 'sew', c.points[0].id, c.points[3].id) - target)).toBeLessThan(0.01);
    }
    const P = doc.piece(p.id).sew.points;
    expect([P[0].x, P[0].y, P[3].x, P[3].y]).toEqual([0, 0, 150, 0]);
  });

  it('non-base size: only that size changes; undo restores', () => {
    const { doc, M, L, XL } = setup();
    const c = rectangleContour(0, 0, 100, 50);
    for (const i of [1, 2]) c.points[i].grade = { [L]: { dx: 5, dy: 0 }, [XL]: { dx: 5, dy: 0 } };
    const p = add(doc, 'A', c);
    const r = segmentLengthSetTo(doc, p.id, 'sew', c.points[0].id, c.points[1].id, 111, 'moveEnd', L);
    expect(r.converged).toBe(true);
    const len = (s: string) => measureSegment(doc, p.id, 'sew', c.points[0].id, c.points[1].id, s);
    expect(len(L)).toBeCloseTo(111, 6);
    expect(len(M)).toBeCloseTo(100, 9);
    expect(len(XL)).toBeCloseTo(110, 6); // XL keeps its absolute size (only L changed)
    doc.undo();
    expect(len(L)).toBeCloseTo(105, 9);
  });
});
