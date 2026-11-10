import { describe, it, expect } from 'vitest';
import { makeStyle, makePiece, rectangleContour } from '../src/model/factory';
import { Document } from '../src/model/doc';

function doc1() {
  const s = makeStyle();
  const p = makePiece('A', rectangleContour(0, 0, 100, 50), s.activeSizeTableId);
  s.pieces.push(p);
  return { doc: new Document(s), id: p.id };
}

describe('Document.transact is atomic', () => {
  it('a step that throws leaves the style, the undo stack and the redo stack untouched', () => {
    const { doc, id } = doc1();
    doc.transact('rename', () => { doc.piece(id).name = 'B'; });
    doc.transact('rename', () => { doc.piece(id).name = 'C'; });
    doc.undo(); // redo history: C
    const before = JSON.stringify(doc.style.pieces);
    expect(() => doc.transact('broken', s => { s.pieces[0].name = 'HALF DONE'; s.pieces[0].sew.points.pop(); throw new Error('boom'); })).toThrow('boom');
    expect(JSON.stringify(doc.style.pieces)).toBe(before);
    expect(doc.piece(id).name).toBe('B');
    expect(doc.undoLabel()).toBe('rename');
    expect(doc.canRedo()).toBe(true);
    doc.redo();
    expect(doc.piece(id).name).toBe('C');
  });

  it('an inner step whose error the outer step handles does not roll the outer step back', () => {
    const { doc, id } = doc1();
    doc.transact('outer', () => {
      doc.piece(id).name = 'OUTER';
      try { doc.transact('inner', () => { throw new Error('inner'); }); } catch { /* handled */ }
    });
    expect(doc.piece(id).name).toBe('OUTER');
    doc.undo();
    expect(doc.piece(id).name).toBe('A');
  });

  it('a failed step emits a change so views redraw the restored style', () => {
    const { doc } = doc1();
    let n = 0; doc.on(() => { n++; });
    expect(() => doc.transact('broken', () => { throw new Error('x'); })).toThrow();
    expect(n).toBe(1);
    expect(doc.canUndo()).toBe(false);
  });
});
