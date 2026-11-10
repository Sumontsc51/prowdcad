import { describe, it, expect } from 'vitest';
import { makeStyle, rectangleContour, makePiece } from '../src/model/factory';
import { Document } from '../src/model/doc';
import { resolveContour } from '../src/model/contour';
import {
  addDrill, drillPosition, duplicateWithOffset, multiButtons, slitContourSegment, distributionParams, moveDrill,
} from '../src/ops/drills';
import { resolveNotch } from '../src/ops/notches';
import {
  addText, moveText, rotateText, setTextSize, reclampAllTexts, addArtwork, artworkPlacementRect, setArtworkPlacedSize, pixelsToMm, rotateArtwork,
} from '../src/ops/annotation';

function setup() {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L'], 'M'));
  const ids = doc.sizeLine().sizes.map(s => s.id);
  const c = rectangleContour(0, 0, 200, 100);
  // top edge grades +10 y per step; right edge +10 x per step
  for (const i of [1, 2]) for (const id of ids) c.points[i].grade[id] = { dx: 10, dy: 0 };
  for (const id of ids) { c.points[2].grade[id] = { dx: 10, dy: 10 }; c.points[3].grade[id] = { dx: 0, dy: 10 }; }
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, piece: doc.piece(piece.id), ids };
}

describe('drills & buttons', () => {
  it('add with size + plot mode, move', () => {
    const { doc, piece } = setup();
    const d = addDrill(doc, piece, { x: 50, y: 50, diameter: 4, mode: 'draw' });
    expect(d.diameter).toBe(4); expect(d.mode).toBe('draw'); expect(d.kind).toBe('drill');
    const b = addDrill(doc, piece, { x: 10, y: 10, kind: 'button' });
    expect(b.diameter).toBe(15); expect(b.mode).toBe('draw');
    moveDrill(doc, piece, d.id, 5, -5);
    expect(doc.piece(piece.id).drills[0].x).toBe(55);
  });

  it('duplicateWithOffset: n copies, graded like the source', () => {
    const { doc, piece, ids } = setup();
    const [S, M, L] = ids;
    const d = addDrill(doc, piece, { x: 20, y: 20, grade: { [M]: { dx: 2, dy: 1 }, [L]: { dx: 2, dy: 1 } } });
    const copies = duplicateWithOffset(doc, piece, d.id, 3, 15, 5);
    expect(copies).toHaveLength(3);
    expect(copies.map(c => [c.x, c.y])).toEqual([[35, 25], [50, 30], [65, 35]]);
    const p = doc.piece(piece.id);
    expect(drillPosition(doc, p, p.drills[3], L)).toEqual({ x: 67, y: 36 });
    expect(drillPosition(doc, p, p.drills[3], S)).toEqual({ x: 63, y: 34 });
    expect(new Set(p.drills.map(x => x.id)).size).toBe(4);
  });

  it('multiButtons between two anchors, inclusive & exclusive, graded by interpolation', () => {
    const { doc, piece, ids } = setup();
    const [S, , L] = ids;
    const P = piece.sew.points;
    // P0 (0,0) not graded; P3 (0,100) grades +10 y/step
    const inc = multiButtons(doc, piece, { from: { anchorId: P[0].id }, to: { anchorId: P[3].id }, count: 5, ends: 'inclusive' });
    expect(inc.map(b => b.y)).toEqual([0, 25, 50, 75, 100]);
    const p = doc.piece(piece.id);
    expect(drillPosition(doc, p, p.drills[2], L).y).toBeCloseTo(55, 9);
    expect(drillPosition(doc, p, p.drills[4], L).y).toBeCloseTo(110, 9);
    expect(drillPosition(doc, p, p.drills[1], S).y).toBeCloseTo(22.5, 9);
    const exc = multiButtons(doc, piece, { from: { anchorId: P[0].id }, to: { x: 0, y: 100 }, count: 3, ends: 'exclusive' });
    expect(exc.map(b => b.y)).toEqual([25, 50, 75]);
    expect(drillPosition(doc, doc.piece(piece.id), exc[1], L).y).toBeCloseTo(50, 9); // ungraded coordinate ref
    expect(distributionParams(1, 'inclusive')).toEqual([0.5]);
  });

  it('slitContourSegment: proportional vs fixedFromStart, notches / buttons / slit lines', () => {
    const { doc, piece, ids } = setup();
    const [, M, L] = ids;
    const P = piece.sew.points;
    // right edge P1→P2: base length 100, L = 110
    const r1 = slitContourSegment(doc, piece, { fromAnchorId: P[1].id, toAnchorId: P[2].id, element: 'notch', count: 3, ends: 'exclusive' });
    expect(r1.notches).toHaveLength(3);
    let p = doc.piece(piece.id);
    expect(r1.notches.map(n => resolveNotch(doc, p, n, M).pos.y)).toEqual([25, 50, 75].map(v => expect.closeTo(v, 9)));
    expect(resolveNotch(doc, p, r1.notches[1], L).pos.y).toBeCloseTo(55, 9);
    const r2 = slitContourSegment(doc, piece, { fromAnchorId: P[1].id, toAnchorId: P[2].id, element: 'button', distances: [10, 40], grading: 'fixedFromStart', inset: 15, diameter: 12 });
    p = doc.piece(piece.id);
    expect(drillPosition(doc, p, r2.drills[1])).toEqual({ x: 185, y: 40 });
    const l = drillPosition(doc, p, r2.drills[1], L);
    expect(l.x).toBeCloseTo(195, 9); expect(l.y).toBeCloseTo(40, 9);
    expect(r2.drills[0].diameter).toBe(12);
    const r3 = slitContourSegment(doc, piece, { fromAnchorId: P[1].id, toAnchorId: P[2].id, element: 'slit', distances: [50], length: 20, inset: 5 });
    const rc = resolveContour(r3.lines[0], doc.sizeLine(), L);
    expect(rc.anchorPos[0].x).toBeCloseTo(205, 9); expect(rc.anchorPos[0].y).toBeCloseTo(55, 9);
    expect(rc.anchorPos[1].x).toBeCloseTo(185, 9);
    expect(r3.lines[0].mode).toBe('cut');
    const r4 = slitContourSegment(doc, piece, { fromAnchorId: P[1].id, toAnchorId: P[2].id, element: 'notch', distances: [30], grading: 'fixedFromStart' });
    expect(resolveNotch(doc, doc.piece(piece.id), r4.notches[0], L).pos.y).toBeCloseTo(30, 9);
  });
});

describe('annotation', () => {
  it('text add / move / rotate / clamp', () => {
    const { doc, piece } = setup();
    const t = addText(doc, piece, { x: 10, y: 10, text: 'FRONT', size: 100 });
    expect(t.size).toBe(50); // clamped to textMaxMm
    expect(setTextSize(doc, piece, t.id, 1).size).toBe(3);
    expect(setTextSize(doc, piece, t.id, 12).size).toBe(12);
    moveText(doc, piece, t.id, 5, 7);
    expect(rotateText(doc, piece, t.id, 400).angleDeg).toBe(40);
    expect(rotateText(doc, piece, t.id, -90, true).angleDeg).toBe(270);
    const p = doc.piece(piece.id);
    expect([p.texts[0].x, p.texts[0].y]).toEqual([15, 17]);
    doc.transact('limits', s => { s.settings.textMaxMm = 10; });
    expect(reclampAllTexts(doc)).toBe(1);
    expect(doc.piece(piece.id).texts[0].size).toBe(10);
  });

  it('artwork placement rectangle uses true source dimensions, scale and angle', () => {
    const { doc, piece, ids } = setup();
    expect(pixelsToMm(300, 300)).toBeCloseTo(25.4, 12);
    const a = addArtwork(doc, piece, { x: 100, y: 50, width: 40, height: 20, src: 'asset:logo', scaleX: 1.5, scaleY: 0.5 });
    const r = artworkPlacementRect(doc, piece, a);
    expect(r.map(p => [p.x, p.y])).toEqual([[70, 45], [130, 45], [130, 55], [70, 55]]);
    rotateArtwork(doc, piece, a.id, 90);
    const p = doc.piece(piece.id);
    const r2 = artworkPlacementRect(doc, p, p.artwork[0]);
    expect(r2[0].x).toBeCloseTo(105, 9); expect(r2[0].y).toBeCloseTo(20, 9);
    expect(r2[2].x).toBeCloseTo(95, 9); expect(r2[2].y).toBeCloseTo(80, 9);
    setArtworkPlacedSize(doc, p, a.id, 80);
    const art = doc.piece(piece.id).artwork[0];
    expect(art.scaleX).toBe(2); expect(art.scaleY).toBe(2);
    expect(art.width).toBe(40); // source dims untouched
    // graded artwork
    const g = addArtwork(doc, piece, { x: 0, y: 0, width: 10, height: 10, src: 'x', grade: { [ids[2]]: { dx: 5, dy: 0 } } });
    expect(artworkPlacementRect(doc, piece, g, ids[2])[0]).toEqual({ x: 0, y: -5 });
  });
});
