import { describe, it, expect } from 'vitest';
import { exportDXF, importDXF, addImportToDocument } from '../src/io/dxf';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, rectangleContour } from '../src/model/factory';
import { gradedDoc } from './io.test';

const names = (d: Document) => d.sizeLine().sizes.map(s => s.name).join(' ');
const width = (d: Document, id: string, size: string) => {
  const p = d.piece(id), sid = d.sizeLine(p).sizes.find(s => s.name === size)!.id;
  const xs = d.resolvePiece(id, sid).sew.pts.map(q => q.x); return Math.max(...xs) - Math.min(...xs);
};
function target() {
  const d = new Document(makeStyle('target', ['XS', 'S', 'M', 'L', 'XL'], 'M'));
  const block = makePiece('BLOCK', rectangleContour(0, 0, 400, 600), d.style.activeSizeTableId);
  d.transact('add', s => s.pieces.push(block));
  return { d, block };
}

describe('DXF import — sizes of the file and of the style', () => {
  const src = gradedDoc();
  const r = exportDXF(src.doc, { flavor: 'astm' });
  const imp = importDXF(r.dxf, { rul: r.rul });
  const w = (s: string) => width(src.doc, src.piece.id, s);

  it("'file': the file's sizes become the style's, pieces already there follow", () => {
    const { d, block } = target();
    const [p] = addImportToDocument(d, imp, { sizes: 'file' });
    expect(names(d)).toBe('S M L XL');
    expect(d.sizeLine(p).id).toBe(d.sizeLine().id);
    expect(d.piece(block.id).sizeTableId).toBe(d.style.activeSizeTableId);
    expect(d.style.sizeTables.length).toBe(1);
    for (const s of ['S', 'M', 'L', 'XL']) expect(width(d, p.id, s)).toBeCloseTo(w(s), 1);
    for (const s of ['S', 'XL']) expect(width(d, block.id, s)).toBeCloseTo(400, 6);
    d.undo();
    expect(names(d)).toBe('XS S M L XL'); expect(d.style.pieces.length).toBe(1);
  });

  it("'style': the imported pieces take the style's sizes, matched by name", () => {
    const { d } = target();
    const [p] = addImportToDocument(d, imp, { sizes: 'style' });
    expect(names(d)).toBe('XS S M L XL');
    expect(p.sizeTableId).toBe(d.style.activeSizeTableId);
    expect(d.style.sizeTables.length).toBe(1);
    for (const s of ['S', 'M', 'L', 'XL']) expect(width(d, p.id, s)).toBeCloseTo(w(s), 1);
    expect(width(d, p.id, 'XS')).toBeCloseTo(w('S'), 1); // a size the file lacks: no step
  });

  it('a file without grading joins the style sizes and can be graded there', () => {
    const { d } = target();
    const one = importDXF(r.dxf); // no .rul
    expect(one.sizeLine.sizes.length).toBe(1);
    const [p] = addImportToDocument(d, one, { sizes: 'style' });
    expect(p.sizeTableId).toBe(d.style.activeSizeTableId);
    expect(d.sizesOf(p).length).toBe(5);
    expect(width(d, p.id, 'XL')).toBeCloseTo(width(d, p.id, 'M'), 6);
    expect(d.style.sizeTables.length).toBe(1);
  });

  it("'keep' (default) leaves the style's sizes alone", () => {
    const { d } = target();
    const [p] = addImportToDocument(d, imp);
    expect(names(d)).toBe('XS S M L XL');
    expect(d.sizeLine(p).sizes.map(s => s.name).join(' ')).toBe('S M L XL');
  });
});
