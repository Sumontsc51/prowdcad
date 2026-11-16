import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, makeContour, gradePoint } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour } from '../src/model/contour';
import { runCurve, shapeRun } from '../src/ops/points';
import { layoutToWorld, pieceLayout } from '../src/ops/pieces';

describe('run across a corner', () => {
  it('the lines lie on the wanted curve', () => {
    const s = makeStyle();
    const a = [gradePoint(0, 0), gradePoint(260, 0), gradePoint(260, 465), gradePoint(0, 622)];
    const b = [gradePoint(400, 0), gradePoint(650, 0), gradePoint(650, 700), gradePoint(400, 700)];
    const A = makePiece('A', makeContour(a, { closed: true }), s.activeSizeTableId);
    const B = makePiece('B', makeContour(b, { closed: true }), s.activeSizeTableId);
    B.layout = { x: -140, y: 0, angleDeg: 0 };
    s.pieces.push(A, B);
    const doc = new Document(s);
    const parts = [{ pieceId: A.id, contourId: A.sew.id, from: a[0].id, to: a[1].id }, { pieceId: B.id, contourId: B.sew.id, from: b[3].id, to: b[0].id }];
    const rc0 = runCurve(doc, parts);
    const start = { x: 520, y: -60 };
    shapeRun(doc, parts, { start });
    const P0 = rc0.p0, H0 = { x: P0.x + start.x, y: P0.y + start.y }, H3 = rc0.h3, P3 = rc0.p3;
    const bz = (t: number) => { const u = 1 - t; return { x: u * u * u * P0.x + 3 * u * u * t * H0.x + 3 * u * t * t * H3.x + t * t * t * P3.x, y: u * u * u * P0.y + 3 * u * u * t * H0.y + 3 * u * t * t * H3.y + t * t * t * P3.y }; };
    const want = Array.from({ length: 2001 }, (_, k) => bz(k / 2000));
    let worst = 0;
    for (const p of [doc.piece(A.id), doc.piece(B.id)]) {
      const r = resolveContour(p.sew, doc.sizeLine(p), doc.baseSize(p));
      const i0 = p === doc.piece(A.id) ? 0 : 3, i1 = p === doc.piece(A.id) ? 1 : 4;
      const pts = [...r.pts, r.pts[0]].slice(r.anchorIndex[i0], i1 === 4 ? r.pts.length + 1 : r.anchorIndex[i1] + 1).map(q => layoutToWorld(pieceLayout(p), q));
      for (const q of pts) { let d = Infinity; for (const w of want) d = Math.min(d, Math.hypot(w.x - q.x, w.y - q.y)); worst = Math.max(worst, d); }
    }
    expect(worst).toBeLessThan(0.8);
    // picked again, the run is that same curve (no jump when the next drag starts)
    const rc = runCurve(doc, parts);
    expect(rc.dev).toBeLessThan(0.8);
    expect(Math.hypot(rc.h0.x - H0.x, rc.h0.y - H0.y)).toBeLessThan(1);
    expect(Math.hypot(rc.h3.x - H3.x, rc.h3.y - H3.y)).toBeLessThan(1);
  });
});
