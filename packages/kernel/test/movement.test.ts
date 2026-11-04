import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, makeContour, gradePoint, curvePoint } from '../src/model/factory';
import { sizeIdByName } from '../src/ops/sizes';
import { createProgram, addMove, applyMeasurementDelta, applyMeasurementSet, addMeasurementSet, removeMove, program } from '../src/ops/movement';

/** Half front: CF at x=0, side seam at x=250 (armhole + hem anchors on the side seam). */
function setup() {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const line = doc.sizeLine();
  const id = (n: string) => sizeIdByName(line, n)!;
  const P = [gradePoint(0, 0, { name: 'CFHem' }), gradePoint(250, 0, { name: 'SSHem', grade: { [id('M')]: { dx: 10, dy: 0 }, [id('L')]: { dx: 10, dy: 0 } } }),
    gradePoint(250, 400, { name: 'SSArm', grade: { [id('M')]: { dx: 10, dy: 5 }, [id('L')]: { dx: 10, dy: 5 } } }), gradePoint(0, 550, { name: 'CFNeck' })];
  const piece = makePiece('FRONT', makeContour(P), doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  const width = (s?: string) => { const r = doc.resolvePiece(doc.style.pieces[0].id, s ? id(s) : undefined).sew.anchorPos; return r[1].x - r[0].x; };
  return { doc, piece, P, id, width };
}

describe('movement programs', () => {
  it('D9: chest program, side-seam anchors dx=0.5 → +40 mm moves them +20.00 mm (front width +20.00)', () => {
    const { doc, piece, P, width, id } = setup();
    const prog = createProgram(doc, 'Chest', 'chest');
    addMove(doc, prog, { pieceId: piece.id, anchorId: P[1].id, dx: 0.5, dy: 0 });
    addMove(doc, prog, { pieceId: piece.id, anchorId: P[2].id, dx: 0.5, dy: 0 });
    const w0 = width();
    const res = applyMeasurementDelta(doc, prog, 40);
    expect(res.moved[piece.id]).toEqual([P[1].id, P[2].id]);
    expect(doc.piece(piece.id).sew.points[1].x).toBe(270);
    expect(doc.piece(piece.id).sew.points[2].x).toBe(270);
    expect(Number((width() - w0).toFixed(2))).toBe(20.0);
    expect(width() - w0).toBe(20);
    // grading rides along: L still +10 over the moved base
    expect(width('L') - width()).toBe(10);
    void id;
  });
  it('addMove replaces an existing move; removeMove', () => {
    const { doc, piece, P } = setup();
    const prog = createProgram(doc, 'Chest', 'chest');
    addMove(doc, prog, { pieceId: piece.id, anchorId: P[1].id, dx: 0.5, dy: 0 });
    addMove(doc, prog, { pieceId: piece.id, anchorId: P[1].id, dx: 0.25, dy: 0 });
    expect(program(doc, prog).moves).toEqual([{ pieceId: piece.id, anchorId: P[1].id, dx: 0.25, dy: 0 }]);
    removeMove(doc, prog, piece.id, P[1].id);
    expect(program(doc, prog).moves.length).toBe(0);
    expect(() => addMove(doc, prog, { pieceId: piece.id, anchorId: 'nope', dx: 1, dy: 0 })).toThrow();
  });
  it('asNewPieceVersion writes FRONT_1 and archives the original', () => {
    const { doc, piece, P } = setup();
    const prog = createProgram(doc, 'Length', 'backLength', [{ pieceId: piece.id, anchorId: P[3].id, dx: 0, dy: 1 }]);
    const res = applyMeasurementDelta(doc, prog, 15, { asNewPieceVersion: true });
    const nid = res.versions[piece.id];
    const np = doc.piece(nid);
    expect(np.name).toBe('FRONT_1'); expect(np.version).toBe(1);
    expect(np.sew.points[3].y).toBe(565);
    expect(doc.style.pieceArchive.map(p => p.id)).toEqual([piece.id]);
    expect(doc.style.pieceArchive[0].sew.points[3].y).toBe(550);
    expect(doc.style.pieces.length).toBe(1);
  });
  it('per-size deltas: base moves by its delta, other sizes by their own', () => {
    const { doc, piece, P, id } = setup();
    const prog = createProgram(doc, 'Chest', 'chest', [{ pieceId: piece.id, anchorId: P[1].id, dx: 0.5, dy: 0 }]);
    applyMeasurementDelta(doc, prog, 40, { perSize: { [id('S')]: 20, [id('L')]: 60 } });
    const x = (s: string) => doc.resolvePiece(piece.id, id(s)).sew.anchorPos[1].x;
    expect(x('M')).toBe(270); expect(x('S')).toBe(250); expect(x('L')).toBe(290);
  });
  it('applyMeasurementSet applies all programs for differing measurements (moves add up)', () => {
    const { doc, piece, P } = setup();
    createProgram(doc, 'Chest', 'chest', [{ pieceId: piece.id, anchorId: P[1].id, dx: 0.5, dy: 0 }, { pieceId: piece.id, anchorId: P[2].id, dx: 0.5, dy: 0 }]);
    createProgram(doc, 'Waist', 'waist', [{ pieceId: piece.id, anchorId: P[1].id, dx: 0.25, dy: 0 }]);
    createProgram(doc, 'Length', 'length', [{ pieceId: piece.id, anchorId: P[3].id, dx: 0, dy: 1 }]);
    const b = addMeasurementSet(doc, 'Base M', { chest: 920, waist: 760, length: 600 });
    const t = addMeasurementSet(doc, 'Customer', { chest: 960, waist: 740, length: 600 });
    const res = applyMeasurementSet(doc, b, 'Customer');
    expect(res.deltas).toEqual({ chest: 40, waist: -20 });
    const p = doc.piece(piece.id).sew.points;
    expect(p[1].x).toBe(250 + 20 - 5);
    expect(p[2].x).toBe(270);
    expect(p[3].y).toBe(550);
    void t;
  });

  it('B6: curve points between moved grade anchors move too — chest line through a curved side seam +20.00', () => {
    const doc = new Document(makeStyle('s', ['S', 'M', 'L'], 'M'));
    const c = makeContour([gradePoint(0, 0), gradePoint(240, 0), curvePoint(250, 200), gradePoint(235, 420), gradePoint(0, 440)]);
    const p = makePiece('FRONT', c, doc.style.activeSizeTableId); doc.transact('a', s => s.pieces.push(p));
    /** x of the side seam where it crosses the horizontal line y */
    const sideX = (y: number) => {
      const pts = doc.resolvePiece(p.id).sew.pts; let best = -Infinity;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) best = Math.max(best, a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y)); }
      return best;
    };
    const w0 = sideX(200), wMax0 = Math.max(...doc.resolvePiece(p.id).sew.pts.map(q => q.x));
    const prog = createProgram(doc, 'chest', 'Chest', [{ pieceId: p.id, anchorId: c.points[1].id, dx: 0.5, dy: 0 }, { pieceId: p.id, anchorId: c.points[3].id, dx: 0.5, dy: 0 }]);
    applyMeasurementDelta(doc, prog, 40);
    const P = doc.piece(p.id).sew.points;
    expect(P[1].x).toBe(260); expect(P[3].x).toBe(255);
    expect(P[2].x).toBeCloseTo(270, 12); // was 250 (did not move)
    expect(sideX(200) - w0).toBeCloseTo(20, 9); // was 0.000
    expect(Math.max(...doc.resolvePiece(p.id).sew.pts.map(q => q.x)) - wMax0).toBeCloseTo(20, 9); // was 9.964
  });
});
