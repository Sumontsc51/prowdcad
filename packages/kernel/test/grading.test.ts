import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint, rectangleContour, newId } from '../src/model/factory';
import type { GradeInc, SizeId } from '../src/model/types';
import { sizeIdByName } from '../src/ops/sizes';
import {
  gradingTable, setGrade, nextGradeAnchor, prevGradeAnchor, dragGrade, copyGrading, pasteGrading, pasteXOnly, pasteYOnly,
  smartPaste, pasteGradingAround, flipX, flipY, equalX, equalY, deleteX, deleteY, deleteAll, stackPoint, stackAlongLine,
  angleGrading, gradeParallel, gradeProportionally, gradedNest, gradedPosition, anchorRun,
} from '../src/ops/grading';

function base(names = ['S', 'M', 'L', 'XL'], b = 'M') {
  const doc = new Document(makeStyle('t', names, b));
  const line = doc.sizeLine();
  const id = (n: string) => sizeIdByName(line, n)!;
  const all = (dx: number, dy: number): Record<SizeId, GradeInc> => Object.fromEntries(line.sizes.slice(1).map(s => [s.id, { dx, dy }]));
  return { doc, line, id, all };
}

/** Symmetric front with CF at x=0: left side seam (−200,·), right side seam (+200,·). */
function symmetricFront() {
  const b = base();
  const pts = [
    gradePoint(-200, 0, { name: 'LHem' }), gradePoint(200, 0, { name: 'RHem', grade: b.all(10, 0) }),
    gradePoint(200, 300, { name: 'RSide', grade: b.all(10, 6) }), gradePoint(0, 380, { name: 'CFNeck' }),
    gradePoint(-200, 300, { name: 'LSide', grade: b.all(3, 1) }),
  ];
  const piece = makePiece('FRONT', makeContour(pts), b.doc.style.activeSizeTableId);
  piece.grain = { a: { x: 0, y: 0 }, b: { x: 0, y: 380 }, gradeA: {}, gradeB: {} };
  b.doc.transact('add', s => s.pieces.push(piece));
  return { ...b, piece, P: pts };
}

describe('grading table & editing', () => {
  it('incremental vs absolute view; setGrade writes back incrementally', () => {
    const { doc, piece, P, id } = symmetricFront();
    const inc = gradingTable(doc, piece.id);
    expect(inc.rows.length).toBe(5);
    expect(inc.rows[2].cells[id('XL')]).toEqual({ dx: 10, dy: 6 });
    expect(inc.rows[2].cells[id('S')]).toEqual({ dx: 0, dy: 0 });
    const abs = gradingTable(doc, piece.id, { view: 'absolute' });
    expect(abs.rows[2].cells[id('XL')]).toEqual({ dx: 20, dy: 12 });
    expect(abs.rows[2].cells[id('S')]).toEqual({ dx: -10, dy: -6 });
    expect(abs.rows[2].cells[id('M')]).toEqual({ dx: 0, dy: 0 });
    // absolute write: XL = +30 → inc XL = 20, L stays 10
    setGrade(doc, piece.id, P[2].id, id('XL'), { dx: 30, dy: 12 }, { view: 'absolute' });
    expect(doc.piece(piece.id).sew.points[2].grade[id('XL')]).toEqual({ dx: 20, dy: 6 });
    expect(doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[2]).toEqual({ x: 230, y: 312 });
    expect(doc.resolvePiece(piece.id, id('L')).sew.anchorPos[2]).toEqual({ x: 210, y: 306 });
    // incremental write on S increment of L
    setGrade(doc, piece.id, P[2].id, id('L'), { dx: 4, dy: 0 });
    expect(doc.resolvePiece(piece.id, id('L')).sew.anchorPos[2]).toEqual({ x: 204, y: 300 });
    expect(doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[2]).toEqual({ x: 224, y: 306 });
    expect(() => setGrade(doc, piece.id, P[2].id, id('S'), { dx: 1, dy: 1 })).toThrow();
  });
  it('all-anchors option includes curve rows with interpolated values', () => {
    const { doc, all, id } = base(['S', 'M', 'L'], 'M');
    const c = makeContour([gradePoint(0, 0), gradePoint(100, 0), curvePoint(110, 50), gradePoint(100, 100, { grade: all(0, 20) }), gradePoint(0, 100, { grade: all(0, 20) })]);
    const piece = makePiece('X', c, doc.style.activeSizeTableId);
    doc.transact('a', s => s.pieces.push(piece));
    const t = gradingTable(doc, piece.id, { all: true });
    expect(t.rows.length).toBe(5);
    expect(t.rows[2].interpolated).toBe(true);
    expect(t.rows[2].cells[id('L')].dy).toBeCloseTo(10, 9);
  });
  it('point tracking next/prev grade anchor (wrap, skip curve points)', () => {
    const { doc, all } = base();
    const pts = [gradePoint(0, 0), gradePoint(100, 0), curvePoint(110, 50), gradePoint(100, 100, { grade: all(1, 1) }), gradePoint(0, 100)];
    const piece = makePiece('X', makeContour(pts), doc.style.activeSizeTableId);
    doc.transact('a', s => s.pieces.push(piece));
    expect(nextGradeAnchor(doc, piece.id, pts[1].id)).toBe(pts[3].id);
    expect(prevGradeAnchor(doc, piece.id, pts[3].id)).toBe(pts[1].id);
    expect(nextGradeAnchor(doc, piece.id, pts[4].id)).toBe(pts[0].id);
    expect(prevGradeAnchor(doc, piece.id, pts[0].id)).toBe(pts[4].id);
  });
  it('dragGrade lands the dragged nested size exactly; other sizes unchanged', () => {
    const { doc, piece, P, id } = symmetricFront();
    dragGrade(doc, piece.id, P[2].id, id('L'), { x: 215.5, y: 303.25 });
    expect(doc.resolvePiece(piece.id, id('L')).sew.anchorPos[2]).toEqual({ x: 215.5, y: 303.25 });
    expect(doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[2]).toEqual({ x: 220, y: 312 });
    expect(doc.resolvePiece(piece.id, id('S')).sew.anchorPos[2]).toEqual({ x: 190, y: 294 });
    expect(doc.piece(piece.id).sew.points[2].grade[id('L')]).toEqual({ dx: 15.5, dy: 3.25 });
    expect(doc.piece(piece.id).sew.points[2].grade[id('XL')]).toEqual({ dx: 4.5, dy: 8.75 });
  });
  it('dragGrade on an angle-graded anchor stores local-frame increments', () => {
    const { doc, piece, P, id } = symmetricFront();
    angleGrading(doc, piece.id, P[2].id, { deg: 90 });
    dragGrade(doc, piece.id, P[2].id, id('L'), { x: 220, y: 300 });
    const g = doc.piece(piece.id).sew.points[2].grade[id('L')];
    expect(g.dx).toBeCloseTo(0, 9); expect(g.dy).toBeCloseTo(-20, 9);
    const p = doc.resolvePiece(piece.id, id('L')).sew.anchorPos[2];
    expect(p.x).toBeCloseTo(220, 9); expect(p.y).toBeCloseTo(300, 9);
  });
});

describe('clipboard', () => {
  it('copy/paste, X only, Y only', () => {
    const { doc, piece, P, id } = symmetricFront();
    const clip = copyGrading(doc, piece.id, P[2].id);
    pasteGrading(doc, piece.id, P[3].id, clip);
    expect(doc.piece(piece.id).sew.points[3].grade[id('L')]).toEqual({ dx: 10, dy: 6 });
    pasteXOnly(doc, piece.id, P[4].id, clip);
    expect(doc.piece(piece.id).sew.points[4].grade[id('L')]).toEqual({ dx: 10, dy: 1 });
    pasteYOnly(doc, piece.id, P[0].id, clip);
    expect(doc.piece(piece.id).sew.points[0].grade[id('L')]).toEqual({ dx: 0, dy: 6 });
  });
  it('D6: Smart Paste negates X on the mirror side (CF at x=0)', () => {
    const { doc, piece, P, id, line } = symmetricFront();
    // right side seam point has dx=+10
    const clip = copyGrading(doc, piece.id, P[2].id);
    const flipped = smartPaste(doc, piece.id, P[4].id, clip);
    expect(flipped).toEqual([true]);
    const g = doc.piece(piece.id).sew.points[4].grade;
    for (const s of line.sizes.slice(1)) { expect(g[s.id].dx).toBe(-10); expect(g[s.id].dy).toBe(6); }
    expect(doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[4]).toEqual({ x: -220, y: 312 });
    // same side: no flip
    expect(smartPaste(doc, piece.id, P[1].id, clip)).toEqual([false]);
    expect(doc.piece(piece.id).sew.points[1].grade[id('L')]).toEqual({ dx: 10, dy: 6 });
    // explicit axis argument works without a grain line
    doc.transact('nograin', () => { doc.piece(piece.id).grain = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, gradeA: {}, gradeB: {} }; });
    expect(smartPaste(doc, piece.id, P[0].id, clip, { axis: { x: 0 } })).toEqual([true]);
    expect(doc.piece(piece.id).sew.points[0].grade[id('L')]).toEqual({ dx: -10, dy: 6 });
  });
  it('Smart Paste with a horizontal axis flips Y instead', () => {
    const { doc, all, id } = base();
    const pts = [gradePoint(0, -100, { grade: all(4, -7) }), gradePoint(50, 0), gradePoint(0, 100)];
    const piece = makePiece('X', makeContour(pts), doc.style.activeSizeTableId);
    doc.transact('a', s => s.pieces.push(piece));
    const clip = copyGrading(doc, piece.id, pts[0].id);
    expect(smartPaste(doc, piece.id, pts[2].id, clip, { axis: { y: 0 } })).toEqual([true]);
    expect(doc.piece(piece.id).sew.points[2].grade[id('XL')]).toEqual({ dx: 4, dy: 7 });
  });
  it('pasteGradingAround applies the AVERAGE of the clipboard to every anchor of a run', () => {
    const { doc, piece, P, id } = symmetricFront();
    const clip = copyGrading(doc, piece.id, [P[1].id, P[2].id, P[4].id]); // (10,0) (10,6) (3,1)
    expect(anchorRun(doc, piece.id, P[3].id, P[0].id)).toEqual([P[3].id, P[4].id, P[0].id]);
    pasteGradingAround(doc, piece.id, { from: P[3].id, to: P[0].id }, clip);
    for (const k of [3, 4, 0]) {
      const g = doc.piece(piece.id).sew.points[k].grade[id('L')];
      expect(g.dx).toBeCloseTo(23 / 3, 12); expect(g.dy).toBeCloseTo(7 / 3, 12);
    }
  });
});

describe('row operations', () => {
  it('flip / equal / delete', () => {
    const { doc, P, id } = symmetricFront();
    const piece = doc.style.pieces[0];
    flipX(doc, piece.id, P[2].id);
    expect(doc.piece(piece.id).sew.points[2].grade[id('L')]).toEqual({ dx: -10, dy: 6 });
    flipY(doc, piece.id, P[2].id);
    expect(doc.piece(piece.id).sew.points[2].grade[id('L')]).toEqual({ dx: -10, dy: -6 });
    setGrade(doc, piece.id, P[3].id, id('L'), { dx: 0, dy: 0 });
    setGrade(doc, piece.id, P[3].id, id('XL'), { dx: 7, dy: 0 });
    setGrade(doc, piece.id, P[3].id, id('M'), { dx: 0, dy: 3 });
    equalX(doc, piece.id, P[3].id);
    equalY(doc, piece.id, P[3].id);
    const g = doc.piece(piece.id).sew.points[3].grade;
    expect([g[id('M')], g[id('L')], g[id('XL')]]).toEqual([{ dx: 7, dy: 3 }, { dx: 7, dy: 3 }, { dx: 7, dy: 3 }]);
    deleteX(doc, piece.id, P[3].id);
    expect(doc.piece(piece.id).sew.points[3].grade[id('L')]).toEqual({ dx: 0, dy: 3 });
    deleteY(doc, piece.id, P[2].id);
    expect(doc.piece(piece.id).sew.points[2].grade[id('L')]).toEqual({ dx: -10, dy: 0 });
    deleteAll(doc, piece.id, [P[2].id, P[3].id]);
    expect(doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[2]).toEqual({ x: 200, y: 300 });
  });
});

describe('stacking', () => {
  it('stackPoint re-zeros the nest at an anchor', () => {
    const { doc, all, id } = base();
    const c = rectangleContour(0, 0, 100, 50);
    c.points[1].grade = all(10, 0); c.points[2].grade = all(10, 5); c.points[3].grade = all(0, 5);
    const piece = makePiece('R', c, doc.style.activeSizeTableId);
    piece.drills.push({ id: newId('dr'), x: 50, y: 25, grade: all(5, 2.5), diameter: 3, kind: 'drill', mode: 'draw' });
    doc.transact('a', s => s.pieces.push(piece));
    stackPoint(doc, piece.id, c.points[2].id); // top-right is the stacking point
    for (const s of ['S', 'L', 'XL']) expect(doc.resolvePiece(piece.id, id(s)).sew.anchorPos[2]).toEqual({ x: 100, y: 50 });
    const xl = doc.resolvePiece(piece.id, id('XL')).sew.anchorPos;
    expect(xl[0]).toEqual({ x: -20, y: -10 }); // shape preserved: 120×60
    expect(xl[1]).toEqual({ x: 100, y: -10 });
    expect(gradedPosition(doc, piece.id, piece.drills[0].id, id('XL'))).toEqual({ x: 40, y: 20 });
  });
  it('stackAlongLine: anchor A stacks and A→B keeps base direction in every size', () => {
    const { doc, line, id } = base();
    const pts = [gradePoint(0, 0), gradePoint(100, 0), gradePoint(100, 100), gradePoint(0, 100)];
    // L/XL: whole piece rotated and shifted (B=pts[1] rotated by +10° per size about A, plus a shift)
    const A0 = pts[0], B0 = pts[1];
    const rot = (p: { x: number; y: number }, deg: number) => { const r = deg * Math.PI / 180; return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) }; };
    const sizesDeg: Record<string, number> = { S: -10, M: 0, L: 10, XL: 20 };
    const shift: Record<string, { x: number; y: number }> = { S: { x: -3, y: 1 }, M: { x: 0, y: 0 }, L: { x: 5, y: 2 }, XL: { x: 9, y: 4 } };
    for (const p of pts) {
      const w: Record<SizeId, { dx: number; dy: number }> = {};
      for (const s of line.sizes) { const q = rot(p, sizesDeg[s.name]); w[s.id] = { dx: q.x + shift[s.name].x - p.x, dy: q.y + shift[s.name].y - p.y }; }
      // convert to incremental
      const ids = line.sizes.map(s => s.id); const inc: Record<SizeId, { dx: number; dy: number }> = {};
      ids.forEach((s, i) => { inc[s] = i === 0 ? { dx: 0, dy: 0 } : { dx: w[s].dx - w[ids[i - 1]].dx, dy: w[s].dy - w[ids[i - 1]].dy }; });
      p.grade = inc;
    }
    const piece = makePiece('R', makeContour(pts), doc.style.activeSizeTableId);
    doc.transact('a', s => s.pieces.push(piece));
    stackAlongLine(doc, piece.id, A0.id, B0.id);
    for (const s of ['S', 'L', 'XL']) {
      const r = doc.resolvePiece(piece.id, id(s)).sew.anchorPos;
      expect(r[0].x).toBeCloseTo(0, 9); expect(r[0].y).toBeCloseTo(0, 9);
      expect(r[1].x).toBeCloseTo(100, 9); expect(r[1].y).toBeCloseTo(0, 9);
      expect(r[2].x).toBeCloseTo(100, 9); expect(r[2].y).toBeCloseTo(100, 9);
    }
  });
});

describe('angle grading', () => {
  it('next-point auto-aim sets the axis toward the next grade anchor and preserves geometry', () => {
    const { doc, all, id } = base();
    const pts = [gradePoint(0, 0), gradePoint(100, 100, { grade: all(3, 4) }), gradePoint(100, 200)];
    const piece = makePiece('X', makeContour(pts, { closed: false }), doc.style.activeSizeTableId);
    doc.transact('a', s => s.pieces.push(piece));
    const before = doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[1];
    const [deg] = angleGrading(doc, piece.id, pts[1].id, { aim: 'next' });
    expect(deg).toBeCloseTo(90, 12);
    expect(doc.piece(piece.id).sew.points[1].gradeAxisDeg).toBeCloseTo(90, 12);
    const after = doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[1];
    expect(after.x).toBeCloseTo(before.x, 9); expect(after.y).toBeCloseTo(before.y, 9);
    const g = doc.piece(piece.id).sew.points[1].grade[id('L')];
    expect(g.dx).toBeCloseTo(4, 9); expect(g.dy).toBeCloseTo(-3, 9); // along / across the aim axis
    // non-preserving: numbers read along the axis
    angleGrading(doc, piece.id, pts[0].id, { aim: 'next', preserve: false });
    expect(doc.piece(piece.id).sew.points[0].gradeAxisDeg).toBeCloseTo(45, 12);
  });
});

describe('parallel & proportional', () => {
  it('gradeParallel keeps the segment parallel to its base direction', () => {
    const { doc, all, id } = base();
    const pts = [gradePoint(0, 0, { grade: all(2, 1) }), gradePoint(100, 50, { grade: all(10, 0) }), gradePoint(0, 100)];
    const piece = makePiece('X', makeContour(pts), doc.style.activeSizeTableId);
    doc.transact('a', s => s.pieces.push(piece));
    gradeParallel(doc, piece.id, pts[0].id, pts[1].id);
    for (const s of ['S', 'L', 'XL']) {
      const r = doc.resolvePiece(piece.id, id(s)).sew.anchorPos;
      const d = { x: r[1].x - r[0].x, y: r[1].y - r[0].y };
      expect(d.x * 50 - d.y * 100).toBeCloseTo(0, 9); // parallel to (100,50)
    }
    // XL: F=(4,2); M raw=(120,50) → projection onto u of (116,48): t=(116*100+48*50)/√12500 → P = F + u t
    const xl = doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[1];
    expect(xl.x).toBeCloseTo(4 + 100 * 14000 / 12500, 9); expect(xl.y).toBeCloseTo(2 + 50 * 14000 / 12500, 9);
  });
  it('gradeParallel xOnly keeps graded Y; preserveLength keeps size length', () => {
    const { doc, all, id } = base();
    const pts = [gradePoint(0, 0), gradePoint(100, 50, { grade: all(10, 5) }), gradePoint(0, 100)];
    const piece = makePiece('X', makeContour(pts), doc.style.activeSizeTableId);
    doc.transact('a', s => s.pieces.push(piece));
    setGrade(doc, piece.id, pts[1].id, id('XL'), { dx: 3, dy: 10 });
    gradeParallel(doc, piece.id, pts[0].id, pts[1].id, { xOnly: true });
    const xl = doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[1];
    expect(xl.y).toBeCloseTo(65, 9); expect(xl.x).toBeCloseTo(130, 9);
    setGrade(doc, piece.id, pts[1].id, id('XL'), { dx: 0, dy: 10 }); // XL raw (110+0, 55+10) = (110,65)
    gradeParallel(doc, piece.id, pts[0].id, pts[1].id, { preserveLength: true });
    const p = doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[1];
    const L = Math.hypot(110, 65);
    expect(p.x).toBeCloseTo(100 / Math.hypot(100, 50) * L, 9); expect(p.y).toBeCloseTo(50 / Math.hypot(100, 50) * L, 9);
  });
  it('gradeProportionally: buttons down a CF (drills) by chord proportion', () => {
    const { doc, all, id } = base();
    const pts = [gradePoint(0, 0), gradePoint(100, 0), gradePoint(100, 400, { grade: all(5, 20) }), gradePoint(0, 400, { grade: all(0, 20) })];
    const piece = makePiece('X', makeContour(pts), doc.style.activeSizeTableId);
    const btn = [100, 200, 300].map(y => ({ id: newId('dr'), x: 0, y, grade: {}, diameter: 15, kind: 'button' as const, mode: 'draw' as const }));
    piece.drills.push(...btn);
    doc.transact('a', s => s.pieces.push(piece));
    const ts = gradeProportionally(doc, piece.id, btn.map(b => b.id), pts[0].id, pts[3].id);
    expect(ts).toEqual([0.25, 0.5, 0.75]);
    expect(gradedPosition(doc, piece.id, btn[0].id, id('XL'))).toEqual({ x: 0, y: 110 });
    expect(gradedPosition(doc, piece.id, btn[2].id, id('XL'))).toEqual({ x: 0, y: 330 });
    expect(gradedPosition(doc, piece.id, btn[1].id, id('S'))).toEqual({ x: 0, y: 190 });
  });
  it('gradeProportionally along a contour by arc length', () => {
    const { doc, all, id } = base();
    const pts = [gradePoint(0, 0), gradePoint(100, 0, { grade: all(10, 0) }), gradePoint(100, 30), gradePoint(100, 100, { grade: all(10, 10) }), gradePoint(0, 100, { grade: all(0, 10) })];
    const piece = makePiece('X', makeContour(pts), doc.style.activeSizeTableId);
    doc.transact('a', s => s.pieces.push(piece));
    const [t] = gradeProportionally(doc, piece.id, [pts[2].id], pts[1].id, pts[3].id);
    expect(t).toBeCloseTo(0.3, 12);
    expect(doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[2]).toEqual({ x: 120, y: 36 });
  });
});

describe('graded nest / reverse grading', () => {
  it('equal anchor counts → increments by index', () => {
    const { doc, id } = base();
    const ids = ['S', 'M', 'L', 'XL'].map((n, i) => {
      const p = makePiece('F-' + n, rectangleContour(0, 0, 90 + 10 * i, 45 + 5 * i), doc.style.activeSizeTableId);
      doc.transact('a', s => s.pieces.push(p)); return p.id;
    });
    const nest = gradedNest(doc, ids, { name: 'FRONT' });
    expect(nest.name).toBe('FRONT');
    expect(nest.sew.points[2].x).toBe(100); expect(nest.sew.points[2].y).toBe(50);
    expect(nest.sew.points[2].grade[id('L')]).toEqual({ dx: 10, dy: 5 });
    expect(nest.sew.points[2].grade[id('M')]).toEqual({ dx: 10, dy: 5 });
    expect(doc.resolvePiece(nest.id, id('XL')).sew.anchorPos[2]).toEqual({ x: 120, y: 60 });
    expect(doc.resolvePiece(nest.id, id('S')).sew.anchorPos[1]).toEqual({ x: 90, y: 0 });
  });
  it('unequal counts → proportional position along contour', () => {
    const { doc, id } = base(['S', 'M'], 'M');
    const S = makePiece('S', makeContour([gradePoint(0, 0), gradePoint(50, 0), gradePoint(100, 0), gradePoint(100, 100), gradePoint(0, 100)]), doc.style.activeSizeTableId);
    const M = makePiece('M', rectangleContour(0, 0, 120, 100), doc.style.activeSizeTableId);
    doc.transact('a', s => { s.pieces.push(S); s.pieces.push(M); });
    const nest = gradedNest(doc, [S.id, M.id], { baseIndex: 1 });
    expect(nest.sew.points.length).toBe(4);
    // M perimeter 440: anchor fractions 0, 120/440, 220/440, 340/440; S perimeter 400
    const s = doc.resolvePiece(nest.id, id('S')).sew.anchorPos;
    expect(s[1].x).toBeCloseTo(100, 9); expect(s[1].y).toBeCloseTo(9.090909090909, 9); // 109.09 along S
    expect(s[2].x).toBeCloseTo(100, 9); expect(s[2].y).toBeCloseTo(100, 9);             // 200 along S
    expect(s[3].x).toBeCloseTo(0, 9); expect(s[3].y).toBeCloseTo(90.909090909091, 9);   // 309.09 along S
    expect(nest.sew.points[1].grade[id('M')].dx).toBeCloseTo(20, 9);
  });
});
