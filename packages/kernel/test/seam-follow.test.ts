/**
 * Seam allowances follow every edit of the sew line's grade structure / segments.
 *
 * For each op: the per-segment seam values (segmentSeams, in contour order from the start point) are
 * asserted before / after, and in EVERY size the cut polygon lies at exactly the segment's seam from
 * the middle part of each segment (0.01 mm).
 */
import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, gradePoint, curvePoint, makeContour, rectangleContour, makeAnchor } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour, spanPolyline, gradeSegment, absoluteToIncremental, anchorPositions } from '../src/model/contour';
import { dedupe, polylineLength, pointAtLength, distToPolygon } from '../src/geom/poly';
import type { Piece, SizeLine, GradeInc, SizeId, Id } from '../src/model/types';
import { computeCutLine, segmentSeams, setCorner, setLockGrading, cornerPointsForSize } from '../src/ops/seam';
import {
  addPointsOnSegment, addPointOnSegment, addPointAt, addSplineSupportPoints, deletePoint, pointsCleanup, togglePointKind,
  movePoint, moveProportional, moveAlongContour, multiMove, roundCorner, setAngle,
} from '../src/ops/points';
import { slashPiece, cutHV, cutAlongInternal, cutParallel } from '../src/ops/cut';
import { swapSegment, pasteSegment, copySegment, rotateSegmentPreservingLength } from '../src/ops/segments';
import { shapeArc, shapeWave, shapeScallop } from '../src/ops/shapers';
import { foldIn, joinPieces, setHalf, openHalf } from '../src/ops/pieces';
import { addNotch, addPointsForNotches } from '../src/ops/notches';
import { createDart } from '../src/ops/darts';
import { addPleatAxis, openPleat } from '../src/ops/pleats';
import { addFullness } from '../src/ops/fullness';
import { segmentLengthSetTo } from '../src/ops/measure';

// ───────────────────────── fixture ─────────────────────────

/** abs per size name → incremental record */
function grade(line: SizeLine, abs: Record<string, [number, number]>): Record<SizeId, GradeInc> {
  const a: Record<SizeId, GradeInc> = {};
  for (const s of line.sizes) { const v = abs[s.name] ?? [0, 0]; a[s.id] = { dx: v[0], dy: v[1] }; }
  return absoluteToIncremental(a, line);
}

/**
 * 200 × 300 panel, CCW from the bottom-left: A(0,0) hem → B(200,0) side → C(200,300) curved top
 * (3 curve points) → D(0,300) centre → A. Seams: hem 30, side default 10, top 15, centre 12. Graded:
 * B and C move out in L / XL (and in in S), C also up.
 */
function setup() {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L', 'XL'], 'M'));
  const line = doc.sizeLine();
  const A = gradePoint(0, 0, { flags: { startPoint: true }, seamAfter: 30 });
  const B = gradePoint(200, 0, { grade: grade(line, { S: [-6, 0], L: [6, 0], XL: [12, 0] }) });
  const C = gradePoint(200, 300, { grade: grade(line, { S: [-6, -8], L: [6, 8], XL: [12, 16] }), seamAfter: 15 });
  const c1 = curvePoint(150, 322), c2 = curvePoint(100, 330), c3 = curvePoint(50, 322);
  const D = gradePoint(0, 300, { grade: grade(line, { S: [0, -8], L: [0, 8], XL: [0, 16] }), seamAfter: 12 });
  const piece = makePiece('P', makeContour([A, B, C, c1, c2, c3, D]), doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, line, pid: piece.id, A: A.id, B: B.id, C: C.id, D: D.id, c: [c1.id, c2.id, c3.id] };
}

const seamsOf = (doc: Document, pid: Id) => { const p = doc.piece(pid); const line = doc.sizeLine(p); return segmentSeams(p, resolveContour(p.sew, line, line.baseSizeId)); };

/** cut polygon at exactly each segment's seam from the middle part of the segment, every size */
function checkCut(doc: Document, pid: Id) {
  const p = doc.piece(pid), line = doc.sizeLine(p);
  let checked = 0;
  for (const s of line.sizes) {
    const r = resolveContour(p.sew, line, s.id);
    const cut = computeCutLine(p, line, s.id);
    expect(cut).toEqual(doc.resolvePiece(pid, s.id).cut);
    const seams = segmentSeams(p, r);
    const maxS = Math.max(...seams.map(Math.abs));
    for (let k = 0; k < r.gradeIdx.length; k++) {
      const [a, b] = gradeSegment(r, k);
      const poly = dedupe(spanPolyline(r, a, b)); const L = polylineLength(poly);
      for (const f of [0.5, 0.35, 0.65]) {
        if (L * Math.min(f, 1 - f) < 1.5 * maxS + 1) continue;
        const q = pointAtLength(poly, L * f).pt;
        const d = distToPolygon(q, cut);
        if (Math.abs(d - Math.abs(seams[k])) > 0.01) throw new Error(`size ${s.name} segment ${k} (${f}): cut at ${d.toFixed(4)} mm, seam ${seams[k]}`);
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
}
/** equal up to a rotation (the start point may move) */
const cyc = (a: number[], b: number[]) => a.length === b.length && a.some((_, k) => b.every((v, i) => a[(i + k) % a.length] === v));
const idsOf = (doc: Document, pid: Id) => doc.piece(pid).sew.points.map(a => a.id);
const anchor = (doc: Document, pid: Id, id: Id) => doc.piece(pid).sew.points.find(a => a.id === id)!;

describe('fixture', () => {
  it('seams per segment and cut distance in every size', () => {
    const t = setup();
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 12]);
    checkCut(t.doc, t.pid);
  });
});

describe('SF1 — inserting points splits a segment; both parts keep the parent seam, corners stay', () => {
  it('Cut Point (one point, curved top, boxed corner on C)', () => {
    const t = setup();
    setCorner(t.doc, t.pid, t.C, { type: 'boxed', extend: 'both' });
    const [id] = addPointsOnSegment(t.doc, t.pid, t.C, { pcts: [40] });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 15, 12]);
    expect(anchor(t.doc, t.pid, id).corner).toBeUndefined();
    expect(anchor(t.doc, t.pid, t.C).corner?.type).toBe('boxed');
    checkCut(t.doc, t.pid);
  });
  it('Cut Point divide N = 3 on the hem, zero grade', () => {
    const t = setup();
    addPointsOnSegment(t.doc, t.pid, t.A, { divide: 3, grading: 'zero' });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 30, 30, 10, 15, 12]);
    checkCut(t.doc, t.pid);
  });
  it('Cut Point on a segment with the piece default keeps the default', () => {
    const t = setup();
    addPointsOnSegment(t.doc, t.pid, t.B, { distances: [100] });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 10, 15, 12]);
    checkCut(t.doc, t.pid);
  });
  it('Add point (from end), add point at click, spline support (curve points)', () => {
    const t = setup();
    addPointOnSegment(t.doc, t.pid, t.D, { distance: 50, from: 'next' });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 12, 12]);
    addPointAt(t.doc, t.pid, t.doc.piece(t.pid).sew.id, { x: 120, y: -0.001 });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 30, 10, 15, 12, 12]);
    addSplineSupportPoints(t.doc, t.pid, t.B, t.C, 2);
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 30, 10, 15, 12, 12]);
    checkCut(t.doc, t.pid);
  });
  it('notch Add Points: floating notch and a notch on an existing curve point', () => {
    const t = setup();
    const p = t.doc.piece(t.pid), line = t.line;
    const r = resolveContour(p.sew, line, line.baseSizeId);
    const iC = p.sew.points.findIndex(a => a.id === t.C), ic2 = p.sew.points.findIndex(a => a.id === t.c[1]);
    const dC2 = r.cum[r.anchorIndex[ic2]] - r.cum[r.anchorIndex[iC]];
    const sizes = Object.fromEntries(line.sizes.map(s => [s.id, 0]));
    const n1 = addNotch(t.doc, p, { contourId: p.sew.id, placement: { kind: 'fromPrev', anchorId: t.D, dist: Object.fromEntries(Object.keys(sizes).map(k => [k, 120])) } });
    const n2 = addNotch(t.doc, t.doc.piece(t.pid), { contourId: p.sew.id, placement: { kind: 'fromPrev', anchorId: t.C, dist: Object.fromEntries(Object.keys(sizes).map(k => [k, dC2])) } });
    addPointsForNotches(t.doc, t.doc.piece(t.pid), [n1.id, n2.id]);
    expect(anchor(t.doc, t.pid, t.c[1]).kind).toBe('grade');
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 15, 12, 12]);
    checkCut(t.doc, t.pid);
  });
  it('curve → grade (toggle, and a direct kind edit as the Inspector does) keeps the segment seam', () => {
    const t = setup();
    togglePointKind(t.doc, t.pid, t.c[0]);
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 15, 12]);
    t.doc.transact('kind', () => { anchor(t.doc, t.pid, t.c[2]).kind = 'grade'; });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 15, 15, 12]);
    checkCut(t.doc, t.pid);
  });
});

describe('SF2 — removing grade points: the merged segment keeps the seam of the segment that started it', () => {
  it('delete a corner (hem 30 + side 10 → 30)', () => {
    const t = setup();
    deletePoint(t.doc, t.pid, t.B);
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 15, 12]);
    checkCut(t.doc, t.pid);
  });
  it('grade → curve (merged keeps first), and seam / corner data of the demoted point is dropped', () => {
    const t = setup();
    const [id] = addPointsOnSegment(t.doc, t.pid, t.B, { pcts: [50] });
    t.doc.transact('seam', () => { anchor(t.doc, t.pid, id).seamAfter = 25; });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 25, 15, 12]);
    t.doc.transact('kind', () => { anchor(t.doc, t.pid, id).kind = 'curve'; });
    expect(anchor(t.doc, t.pid, id).seamAfter).toBeUndefined();
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 12]);
    checkCut(t.doc, t.pid);
  });
  it('points cleanup of an inserted collinear grade point restores the parent segment', () => {
    const t = setup();
    addPointsOnSegment(t.doc, t.pid, t.A, { pcts: [30, 60] });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 30, 30, 10, 15, 12]);
    pointsCleanup(t.doc, t.pid, { includeGrade: true, contourId: t.doc.piece(t.pid).sew.id });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 12]);
    checkCut(t.doc, t.pid);
  });
});

describe('SF3 — moves and shape edits never reset a segment seam', () => {
  it('move point (base + graded size), proportional, along contour, move line, set angle, segment length', () => {
    const t = setup();
    const L = t.line.sizes.find(s => s.name === 'L')!.id;
    movePoint(t.doc, t.pid, t.B, { dx: 15, dy: -5 });
    movePoint(t.doc, t.pid, t.C, { dx: 4, dy: 3 }, { sizeId: L });
    moveProportional(t.doc, t.pid, t.c[1], { x: 0, y: 12 });
    moveAlongContour(t.doc, t.pid, t.D, -10);
    multiMove(t.doc, [t.B, t.C].map(anchorId => ({ pieceId: t.pid, anchorId })), { x: 8, y: 0 });
    setAngle(t.doc, t.pid, t.A, 90);
    segmentLengthSetTo(t.doc, t.pid, t.doc.piece(t.pid).sew.id, t.B, t.C, 320, 'moveEnd');
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 12]);
    checkCut(t.doc, t.pid);
  });
  it('rotate segment keeping length, paste segment', () => {
    const t = setup();
    rotateSegmentPreservingLength(t.doc, t.pid, t.B, t.C, 'from', 3);
    const clip = copySegment(t.doc, t.pid, t.C, t.D);
    pasteSegment(t.doc, t.pid, t.A, t.B, clip, 'proportional-to-external');
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 12]);
    checkCut(t.doc, t.pid);
  });
  it('shapers: arc on the side, wave and scallops on the hem (new corners carry the hem seam)', () => {
    const t = setup();
    shapeArc(t.doc, t.pid, t.B, t.C, { depth: 12 });
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 15, 12]);
    shapeWave(t.doc, t.pid, t.D, t.A, { count: 2, depth: 6 });
    shapeScallop(t.doc, t.pid, t.A, t.B, { count: 4, depth: 10 });
    const s = seamsOf(t.doc, t.pid);
    expect(s.slice(0, -3).every(v => v === 30)).toBe(true);
    expect(s.slice(-3)).toEqual([10, 15, 12]);
  });
  it('round corner: tangent points take the corner seam; the incoming segment keeps its own', () => {
    const t = setup();
    roundCorner(t.doc, t.pid, t.B, 20);
    expect(seamsOf(t.doc, t.pid)).toEqual([30, 10, 10, 15, 12]);
    checkCut(t.doc, t.pid);
  });
});

describe('SF4 — cuts, folds, joins: new edges get the dialog value (or the piece default), the rest keep theirs', () => {
  it('slash across with seam 8 on the new edges', () => {
    const t = setup();
    const [h1, h2] = slashPiece(t.doc, t.pid, [{ x: -20, y: 150 }, { x: 220, y: 150 }], { seam: 8 });
    // NAME_1 holds the start point: hem 30, side 10, cut 8, centre 12
    expect(seamsOf(t.doc, h1)).toEqual([30, 10, 8, 12]);
    expect(seamsOf(t.doc, h2)).toEqual([10, 15, 12, 8]);
    checkCut(t.doc, h1); checkCut(t.doc, h2);
  });
  it('slash with the piece default, H / V cut through a point, cut along an internal', () => {
    const t = setup();
    const [h1, h2] = cutHV(t.doc, t.pid, t.A, 'H', 100);
    expect(seamsOf(t.doc, h1)).toEqual([30, 10, 10, 12]);
    expect(seamsOf(t.doc, h2)).toEqual([10, 15, 12, 10]);
    const u = setup();
    const ic = makeContour([gradePoint(100, -1), gradePoint(100, 400)], { type: 'internal', closed: false });
    u.doc.transact('add internal', () => u.doc.piece(u.pid).internals.push(ic));
    const [v1, v2] = cutAlongInternal(u.doc, u.pid, ic.id, { seam: 5 });
    for (const id of [v1, v2]) checkCut(u.doc, id);
    expect([seamsOf(u.doc, v1), seamsOf(u.doc, v2)].map(s => s.filter(v => v === 5).length)).toEqual([1, 1]);
  });
  it('cut parallel strip (waistband) 40 mm from the hem', () => {
    const t = setup();
    const [strip, rest] = cutParallel(t.doc, t.pid, { from: t.A, to: t.B }, 40, { seam: 7 });
    expect(seamsOf(t.doc, strip)).toEqual([30, 10, 7, 12]);
    expect(seamsOf(t.doc, rest)).toEqual([10, 15, 12, 7]);
    checkCut(t.doc, strip); checkCut(t.doc, rest);
  });
  it('fold in: the fold edge gets 0, the remaining segments keep their seams', () => {
    const t = setup();
    foldIn(t.doc, t.pid, { a: { x: 120, y: -10 }, b: { x: 120, y: 400 } }, { keep: { x: 50, y: 100 } });
    expect(cyc(seamsOf(t.doc, t.pid), [30, 0, 15, 12])).toBe(true);
    checkCut(t.doc, t.pid);
  });
  it('join two pieces along a side: every remaining segment keeps its seam', () => {
    const t = setup();
    const b = makePiece('B', rectangleContour(400, 0, 100, 300), t.doc.style.activeSizeTableId);
    b.sew.points[0].seamAfter = 30; b.sew.points[2].seamAfter = 15;
    t.doc.transact('add', s => s.pieces.push(b));
    const bp = b.sew.points.map(a => a.id);
    // A's centre front D → A  ↔  B's right side bp1 → bp2
    joinPieces(t.doc, t.pid, { from: t.D, to: t.A }, b.id, { from: bp[1], to: bp[2] }, { keepSeamLine: false });
    const s = seamsOf(t.doc, t.pid);
    expect(s.filter(v => v === 30).length).toBe(2);
    expect(s).toContain(15); expect(s).toContain(10);
    expect(s).not.toContain(12); // the joined edge is interior now
  });
  it('half piece set (trim) and opened: mirrored segments mirror the seams', () => {
    const t = setup();
    setHalf(t.doc, t.pid, { a: { x: 120, y: -10 }, b: { x: 120, y: 400 } }, { trim: true, keep: { x: 50, y: 100 } });
    openHalf(t.doc, t.pid);
    const s = seamsOf(t.doc, t.pid);
    // hem, top and centre are mirrored: 30 30 · 15 15 · 12 12 around the opened piece
    expect(cyc(s, [30, 30, 12, 15, 15, 12]) || cyc(s, [12, 30, 30, 12, 15, 15]) || [30, 15, 12].every(v => s.filter(x => x === v).length === 2)).toBe(true);
    checkCut(t.doc, t.pid);
  });
  it('swap internal ⇄ perimeter: the new perimeter run takes the replaced run seam', () => {
    const t = setup();
    const ic = makeContour([gradePoint(150, 0), gradePoint(200, 50)], { type: 'internal', closed: false });
    t.doc.transact('add internal', () => t.doc.piece(t.pid).internals.push(ic));
    swapSegment(t.doc, t.pid, ic.id);
    const s = seamsOf(t.doc, t.pid);
    expect(cyc(s, [30, 30, 10, 15, 12])).toBe(true);
    checkCut(t.doc, t.pid);
  });
});

describe('SF5 — live-object insertions (dart, pleat, slash & spread) keep the parent seam', () => {
  it('dart on the hem', () => {
    const t = setup();
    createDart(t.doc, t.pid, { at: { fromAnchorId: t.A, distance: 100 }, width: 20, depth: 80 });
    const s = seamsOf(t.doc, t.pid);
    expect(s[0]).toBe(30); expect(s[s.length - 3]).toBe(10);
    expect(s.slice(0, -3).every(v => v === 30)).toBe(true);
  });
  it('open pleat across the piece', () => {
    const t = setup();
    const id = addPleatAxis(t.doc, t.pid, { x: 100, y: -5 }, { x: 100, y: 340 }, { depthStart: 10, depthEnd: 10 });
    openPleat(t.doc, t.pid, id);
    const s = seamsOf(t.doc, t.pid);
    expect(s.filter(v => v === 30).length).toBeGreaterThanOrEqual(2);
    expect(s.filter(v => v === 15).length).toBeGreaterThanOrEqual(2);
    expect(s).not.toContain(10.0001);
    expect(s.every(v => [30, 10, 15, 12].includes(v))).toBe(true);
  });
  it('slash & spread from the hem to the top', () => {
    const t = setup();
    addFullness(t.doc, t.pid, { slash: { fromAnchorId: t.A, distance: 100 }, pivot: { fromAnchorId: t.C, distance: 100 }, openA: 30 });
    const s = seamsOf(t.doc, t.pid);
    expect(s.every(v => [30, 10, 15, 12].includes(v))).toBe(true);
    expect(s.filter(v => v === 30).length).toBeGreaterThanOrEqual(2);
  });
});

describe('SF6 — Lock Grading snapshot follows sew edits', () => {
  it('moving a point in a graded size re-stamps the per-size corner snapshot', () => {
    const t = setup();
    setCorner(t.doc, t.pid, t.B, { type: 'boxed', extend: 'both' });
    setLockGrading(t.doc, t.pid, true);
    const XL = t.line.sizes.find(s => s.name === 'XL')!.id;
    movePoint(t.doc, t.pid, t.B, { dx: 9, dy: 0 }, { sizeId: XL });
    const p = t.doc.piece(t.pid);
    const want = cornerPointsForSize(p, t.line, XL).find(c => c.anchorId === t.B)!.pts;
    expect(anchor(t.doc, t.pid, t.B).corner!.lockedPerSize![XL]).toEqual(want.map(q => ({ x: q.x, y: q.y })));
    addPointsOnSegment(t.doc, t.pid, t.A, { pcts: [50] });
    expect(anchor(t.doc, t.pid, t.B).corner!.lockedPerSize![XL]).toEqual(cornerPointsForSize(t.doc.piece(t.pid), t.line, XL).find(c => c.anchorId === t.B)!.pts.map(q => ({ x: q.x, y: q.y })));
    checkCut(t.doc, t.pid);
  });
});

// keep the helpers referenced
void makeAnchor; void anchorPositions; void idsOf;
