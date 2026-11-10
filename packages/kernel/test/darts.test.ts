import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { area, perimeter } from '../src/geom/poly';
import { dist } from '../src/geom/vec';
import {
  createDart, createMultiDarts, moveDartApex, transferDart, rotateDartAroundCenter, closeDart, openDart,
  changeDarts, cutAllDarts, setDartCutting, copyDart, pasteDart, removeDart, insertDart, dartInfo,
  dartSewGeometry, dartCutShape, dartClosedPerimeter, setDartDepth,
} from '../src/ops/darts';

/** 300×400 bodice block. CCW from bottom-left: BL(0,0) BR(300,0) TR(300,400) TL(0,400). Right edge graded +10 x per size. */
function setup() {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const line = doc.sizeLine();
  const ids = line.sizes.map(s => s.id);
  const c = rectangleContour(0, 0, 300, 400);
  for (const i of [1, 2]) c.points[i].grade = { [ids[1]]: { dx: 10, dy: 0 }, [ids[2]]: { dx: 10, dy: 0 } };
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  const p = () => doc.piece(piece.id);
  const [BL, BR, TR, TL] = c.points.map(a => a.id);
  return { doc, pid: piece.id, ids, line, p, BL, BR, TR, TL };
}
const pos = (doc: Document, pid: string, id: string, size?: string) => {
  const r = doc.resolvePiece(pid, size), i = doc.piece(pid).sew.points.findIndex(a => a.id === id);
  return r.sew.anchorPos[i];
};
/** shoulder dart: centre 150 mm from TR on the top edge (x=150), width 20, depth 150 → legs (160,400)/(140,400), apex (150,250) */
const shoulder = (s: ReturnType<typeof setup>) => createDart(s.doc, s.pid, { at: { fromAnchorId: s.TR, distance: 150 }, width: 20, depth: 150 });

describe('dart create (A3)', () => {
  it('legs are dartLeg grade anchors, apex on the inward bisector, base shape unchanged', () => {
    const s = setup();
    const id = shoulder(s);
    const d = s.p().darts[0];
    expect(d.id).toBe(id);
    expect(pos(s.doc, s.pid, d.legA)).toEqual({ x: 160, y: 400 });
    expect(pos(s.doc, s.pid, d.legB)).toEqual({ x: 140, y: 400 });
    expect(d.apex.x).toBeCloseTo(150, 9); expect(d.apex.y).toBeCloseTo(250, 9);
    for (const leg of [d.legA, d.legB]) { const a = s.p().sew.points.find(x => x.id === leg)!; expect(a.kind).toBe('grade'); expect(a.flags.dartLeg).toBe(true); }
    expect(area(s.doc.resolvePiece(s.pid).sew.pts)).toBeCloseTo(120000, 6);
    expect(perimeter(s.doc.resolvePiece(s.pid).sew.pts)).toBeCloseTo(1400, 9);
    const info = dartInfo(s.doc, s.pid, id);
    expect(info.width).toBeCloseTo(20, 9);
    expect(info.depth).toBeCloseTo(150, 9);
    expect(info.legLengthA).toBeCloseTo(Math.hypot(10, 150), 9); // 150.33296
    expect(info.drill.y).toBeCloseTo(250 + 12, 9); // default drill 12 mm back from apex toward the opening
    expect(dartClosedPerimeter(s.p(), s.line)).toBeCloseTo(1380, 9);
  });
  it('apex grades with the legs (mean of leg offsets)', () => {
    const s = setup();
    const id = shoulder(s);
    const [, , L] = s.ids;
    // top edge grades 10 at TR → 0 at TL: legA (x=160) +5.333, legB (x=140) +4.667 → apex +5
    expect(pos(s.doc, s.pid, s.p().darts[0].legA, L).x).toBeCloseTo(160 + 10 * 160 / 300, 9);
    const g = dartSewGeometry(s.p(), s.line, L).find(x => x.dartId === id)!;
    expect(g.apex.x).toBeCloseTo(155, 9);
    expect(g.apex.y).toBeCloseTo(250, 9);
    expect(g.legA[0].x).toBeCloseTo(165.333333, 5);
    expect(g.legB[0].x).toBeCloseTo(144.666667, 5);
  });
  it('apex given → Fix Dart equalizes legs', () => {
    const s = setup();
    const id = createDart(s.doc, s.pid, { at: { fromAnchorId: s.TR, distance: 150 }, width: 20, apex: { x: 170, y: 250 } });
    const i = dartInfo(s.doc, s.pid, id);
    expect(i.legLengthA).toBeCloseTo(i.legLengthB, 9);
    expect(pos(s.doc, s.pid, s.p().darts[0].legA).x).toBeCloseTo(180, 9);
    expect(pos(s.doc, s.pid, s.p().darts[0].legB).x).toBeCloseTo(160, 9);
    expect(i.width).toBeCloseTo(20, 9);
  });
  it('apex move forces Fix Dart; depth edit along the axis', () => {
    const s = setup();
    const id = shoulder(s);
    moveDartApex(s.doc, s.pid, id, { x: 120, y: 300 });
    const i = dartInfo(s.doc, s.pid, id);
    expect(i.legLengthA - i.legLengthB).toBeCloseTo(0, 9);
    expect(pos(s.doc, s.pid, s.p().darts[0].legA).x).toBeCloseTo(130, 9);
    expect(pos(s.doc, s.pid, s.p().darts[0].legB).x).toBeCloseTo(110, 9);
    setDartDepth(s.doc, s.pid, id, 50);
    expect(dartInfo(s.doc, s.pid, id).depth).toBeCloseTo(50, 9);
    s.doc.undo(); s.doc.undo();
    expect(dartInfo(s.doc, s.pid, id).apex).toEqual({ x: 150, y: 250 });
  });
});

describe('dart transfer (acceptance D3)', () => {
  const theta = 2 * Math.atan(10 / 150);
  it('D3: 100 % pivot transfer conserves the closed sew perimeter within 0.1 mm', () => {
    const s = setup();
    const id = shoulder(s);
    const before = dartClosedPerimeter(s.p(), s.line);
    const beforeAll = s.ids.map(sz => dartClosedPerimeter(s.p(), s.line, sz));
    // side seam (BR → TR) 200 mm up: (300,200)
    const nid = transferDart(s.doc, s.pid, id, { target: { fromAnchorId: s.BR, distance: 200 }, pct: 100 });
    const pc = s.p();
    expect(pc.darts.length).toBe(1);
    expect(pc.darts[0].id).toBe(nid);
    const after = dartClosedPerimeter(pc, s.line);
    expect(Math.abs(after - before)).toBeLessThan(0.1);
    expect(after).toBeCloseTo(1380, 9); // rigid rotation: exact
    // old dart closed: its legs merged
    expect(pc.sew.points.length).toBe(7); // BL BR T T' TR' legB(merged) TL
    const i = dartInfo(s.doc, s.pid, nid);
    expect(i.apex.x).toBeCloseTo(150, 9); expect(i.apex.y).toBeCloseTo(250, 9);
    const R = Math.hypot(150, 50);
    expect(i.width).toBeCloseTo(2 * R * Math.sin(theta / 2), 9); // same angular fullness: 27.4373 mm
    expect(i.legLengthA).toBeCloseTo(R, 9); expect(i.legLengthB).toBeCloseTo(R, 9);
    expect(dist(pos(s.doc, s.pid, pc.darts[0].legA), { x: 300, y: 200 })).toBeLessThan(1e-9); // fixed leg stays at the target
    // grading still resolves (all sizes) and the closed perimeter is conserved per size
    s.ids.forEach((sz, k) => {
      expect(s.doc.resolvePiece(s.pid, sz).sew.pts.length).toBeGreaterThan(5);
      expect(Math.abs(dartClosedPerimeter(pc, s.line, sz) - beforeAll[k])).toBeLessThan(0.1);
    });
  });
  for (const curved of [false, true]) {
    it(`B8: 100 % transfer conserves the closed perimeter within 0.1 mm in EVERY graded size (curved side seam: ${curved})`, () => {
      const doc = new Document(makeStyle('t', ['S', 'M', 'L', 'XL'], 'M'));
      const line = doc.sizeLine(); const ids = line.sizes.map(z => z.id);
      const g = (dx: number, dy: number) => Object.fromEntries(ids.map(i => [i, { dx, dy }]));
      const pts = curved
        ? [gradePoint(0, 0), gradePoint(260, 0, { grade: g(8, 0) }), curvePoint(275, 190), gradePoint(250, 380, { grade: g(8, 5) }), gradePoint(0, 400, { grade: g(0, 5) })]
        : [gradePoint(0, 0), gradePoint(260, 0, { grade: g(8, 0) }), gradePoint(250, 380, { grade: g(8, 5) }), gradePoint(0, 400, { grade: g(0, 5) })];
      const c = makeContour(pts);
      const piece = makePiece('F', c, doc.style.activeSizeTableId); doc.transact('a', st => st.pieces.push(piece));
      const TR = c.points[curved ? 3 : 2].id, BR = c.points[1].id;
      const id = createDart(doc, piece.id, { at: { fromAnchorId: TR, distance: 110 }, width: 24, depth: 170 });
      const before = ids.map(z => dartClosedPerimeter(doc.piece(piece.id), line, z));
      const nid = transferDart(doc, piece.id, id, { target: { fromAnchorId: BR, distance: 120 }, pct: 100 });
      const after = ids.map(z => dartClosedPerimeter(doc.piece(piece.id), line, z));
      // was S −0.050, L +0.057, XL +0.121 (curved XL +0.113). Straight side seam: exact in every size.
      // Curved: ≤ 0.016 mm remains because explicit Bézier handles (from the target split) are not
      // graded, so they turn by the base dart angle in every size.
      ids.forEach((z, k) => expect(Math.abs(after[k] - before[k])).toBeLessThan(curved ? 0.02 : 1e-9));
      // base size: exact
      expect(Math.abs(after[1] - before[1])).toBeLessThan(1e-3);
      expect(dartInfo(doc, piece.id, nid).width).toBeGreaterThan(0);
    });
  }
  it('D3: 50 % splits fullness evenly (equal widths at the contour within 0.05 mm)', () => {
    const s = setup();
    const id = shoulder(s);
    // target on the side seam at the leg length from the apex: (300,260), |T−apex| = √(150²+10²)
    const nid = transferDart(s.doc, s.pid, id, { target: { fromAnchorId: s.BR, distance: 260 }, pct: 50 });
    expect(s.p().darts.length).toBe(2);
    const w0 = dartInfo(s.doc, s.pid, id).width, w1 = dartInfo(s.doc, s.pid, nid).width;
    expect(Math.abs(w0 - w1)).toBeLessThan(0.05);
    expect(w0).toBeCloseTo(2 * Math.hypot(10, 150) * Math.sin(theta / 4), 9); // 10.0166 mm
    expect(dartClosedPerimeter(s.p(), s.line)).toBeCloseTo(1380, 9);
    // the remaining dart keeps equal legs (rigid rotation about the apex)
    const i0 = dartInfo(s.doc, s.pid, id);
    expect(i0.legLengthA).toBeCloseTo(i0.legLengthB, 9);
  });
  it('rotate around an offset centre: two darts, one apex, legs re-equalized', () => {
    const s = setup();
    const id = shoulder(s);
    const nid = rotateDartAroundCenter(s.doc, s.pid, id, { target: { fromAnchorId: s.BR, distance: 260 }, center: { x: 150, y: 200 }, pct: 50 });
    const a = dartInfo(s.doc, s.pid, id), b = dartInfo(s.doc, s.pid, nid);
    expect(b.apex.x).toBeCloseTo(a.apex.x, 12); expect(b.apex.y).toBeCloseTo(a.apex.y, 12);
    expect(a.legLengthA - a.legLengthB).toBeCloseTo(0, 6);
    expect(b.legLengthA - b.legLengthB).toBeCloseTo(0, 6);
    expect(b.width).toBeGreaterThan(5);
  });
});

describe('dart close / open, flags', () => {
  it('close: zero width, legs coincide, dashed dartAxis; reopen restores exactly; reopen by value', () => {
    const s = setup();
    const id = shoulder(s);
    const snap = JSON.stringify(s.p().sew);
    closeDart(s.doc, s.pid, id);
    const d = s.p().darts[0];
    expect(d.closed).toBe(true);
    expect(d.rememberedWidth).toBeCloseTo(20, 12);
    expect(dist(pos(s.doc, s.pid, d.legA), pos(s.doc, s.pid, d.legB))).toBe(0);
    expect(pos(s.doc, s.pid, d.legA)).toEqual({ x: 150, y: 400 });
    const ax = s.p().internals.find(c => c.id === d.axisContourId)!;
    expect(ax.type).toBe('dartAxis'); expect(ax.style).toBe('dashed');
    expect(ax.points.map(p => [p.x, p.y])).toEqual([[150, 400], [150, 250]]);
    openDart(s.doc, s.pid, id);
    expect(JSON.stringify(s.p().sew)).toBe(snap);
    expect(s.p().internals.length).toBe(0);
    closeDart(s.doc, s.pid, id);
    openDart(s.doc, s.pid, id, 30);
    const i = dartInfo(s.doc, s.pid, id);
    expect(i.width).toBeCloseTo(30, 9);
    expect(pos(s.doc, s.pid, d.legA).x).toBeCloseTo(165, 9);
  });
  it('Change Darts flips fold globally; Cut All', () => {
    const s = setup();
    shoulder(s);
    createDart(s.doc, s.pid, { at: { fromAnchorId: s.BL, distance: 100 }, width: 20, depth: 150, fold: 'B' });
    expect(changeDarts(s.doc)).toBe(2);
    expect(s.p().darts.map(d => d.fold)).toEqual(['B', 'A']);
    expect(cutAllDarts(s.doc, s.pid)).toBe(2);
    expect(s.p().darts.every(d => d.cutting)).toBe(true);
  });
  it('multi darts: N equal darts along a segment', () => {
    const s = setup();
    const ids = createMultiDarts(s.doc, s.pid, s.BL, { count: 3, width: 10, depth: 100 });
    expect(ids.length).toBe(3);
    const xs = ids.map(id => dartInfo(s.doc, s.pid, id).apex.x);
    expect(xs.map(x => +x.toFixed(9))).toEqual([75, 150, 225]);
    for (const id of ids) { const i = dartInfo(s.doc, s.pid, id); expect(i.width).toBeCloseTo(10, 9); expect(i.apex.y).toBeCloseTo(100, 9); }
    expect(dartClosedPerimeter(s.p(), s.line)).toBeCloseTo(1370, 9);
  });
});

describe('dart cut shape', () => {
  it('folded dart cap (fold A, 10 mm seam, straight edge)', () => {
    const s = setup();
    const id = shoulder(s);
    const cs = dartCutShape(s.p(), s.line, s.line.baseSizeId, id);
    expect(cs.kind).toBe('fold');
    // QF on the A-side cut line, peak on the dart axis, mirror point on the B side
    const exp = [[160 + 10 / 15, 410], [150, 250 + 160 * 226 / 224], [140 - 10 / 15, 410]];
    expect(cs.path.length).toBe(3);
    cs.path.forEach((p, k) => { expect(p.x).toBeCloseTo(exp[k][0], 9); expect(p.y).toBeCloseTo(exp[k][1], 9); });
    expect(cs.polygon.length).toBe(5);
    // fold B: same cap, reversed travel (start still on the A side)
    changeDarts(s.doc);
    const cb = dartCutShape(s.p(), s.line, s.line.baseSizeId, id);
    expect(cb.path[0].x).toBeCloseTo(160 + 10 / 15, 9);
    expect(cb.path[1].y).toBeCloseTo(411.428571, 5);
  });
  it('cutting dart: cut line follows into the dart', () => {
    const s = setup();
    const id = shoulder(s);
    setDartCutting(s.doc, s.pid, id, true);
    const cs = dartCutShape(s.p(), s.line, s.line.baseSizeId, id);
    expect(cs.kind).toBe('cutting');
    expect(cs.path[0].x).toBeCloseTo(160 + 10 / 15, 9); expect(cs.path[0].y).toBeCloseTo(410, 9);
    expect(cs.path[1]).toEqual({ x: 150, y: 250 });
    expect(cs.path[2].x).toBeCloseTo(140 - 10 / 15, 9);
  });
});

describe('copy / paste / remove / insert', () => {
  it('copy a dart and paste it on another piece', () => {
    const s = setup();
    const id = shoulder(s);
    const clip = copyDart(s.doc, s.pid, id);
    const other = makePiece('BACK', rectangleContour(0, 0, 200, 300), s.doc.style.activeSizeTableId);
    s.doc.transact('add', st => st.pieces.push(other));
    const nid = pasteDart(s.doc, other.id, clip, { fromAnchorId: other.sew.points[0].id, distance: 100 });
    const i = dartInfo(s.doc, other.id, nid);
    expect(i.width).toBeCloseTo(20, 9); expect(i.depth).toBeCloseTo(150, 9);
    expect(i.apex.x).toBeCloseTo(100, 9); expect(i.apex.y).toBeCloseTo(150, 9);
  });
  it('remove dart restores the contour; keep-fullness leaves the opening', () => {
    const s = setup();
    const snap = JSON.stringify(s.p().sew);
    const id = shoulder(s);
    removeDart(s.doc, s.pid, id);
    expect(JSON.stringify(s.p().sew)).toBe(snap);
    const id2 = shoulder(s);
    const legs = [s.p().darts[0].legA, s.p().darts[0].legB];
    removeDart(s.doc, s.pid, id2, { keepFullness: true });
    expect(s.p().darts.length).toBe(0);
    expect(s.p().sew.points.length).toBe(6);
    for (const l of legs) expect(s.p().sew.points.find(a => a.id === l)!.flags.dartLeg).toBeUndefined();
  });
  it('insert dart = fullness + dart in one step; removing it pinches the fullness closed exactly', () => {
    const s = setup();
    const snap = JSON.stringify(s.p().sew);
    const { dartId, fullnessId } = insertDart(s.doc, s.pid, { at: { fromAnchorId: s.TR, distance: 150 }, width: 20, depth: 100 });
    const pc = s.p();
    expect(pc.fullness!.length).toBe(1);
    expect(pc.darts[0].sourceFullnessId).toBe(fullnessId);
    const i = dartInfo(s.doc, s.pid, dartId);
    expect(i.width).toBeCloseTo(20, 9);
    expect(i.depth).toBeCloseTo(100, 6);
    // rotation about the hinge (150,0) by 2·asin(10/400): area grows by the wedge, closed perimeter = 1400
    expect(dartClosedPerimeter(pc, s.line)).toBeCloseTo(1400, 9);
    removeDart(s.doc, s.pid, dartId);
    expect(JSON.stringify(s.p().sew)).toBe(snap);
    expect(s.p().fullness!.length).toBe(0);
  });
});
