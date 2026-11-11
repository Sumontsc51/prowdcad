import { describe, it, expect } from 'vitest';
import { exportDXF, importDXF, addImportToDocument, parseRUL, writeRUL, parseDXF } from '../src/io/dxf';
import { exportSVG, importSVG, samplePath, parseTransform } from '../src/io/svg';
import { exportHPGL, importHPGL, parseHPGL } from '../src/io/plt';
import { exportPDF, PT_PER_MM, colLabel } from '../src/io/pdf';
import { saveNative, loadNative, registerMigration, exportSizeAsStandalone, notchPositions, NativeFormatError } from '../src/io/native';
import { resolveNotch, bulgePoints } from '../src/io/common';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, rectangleContour } from '../src/model/factory';
import { resolveContour, absoluteOffset } from '../src/model/contour';
import { distToPolygon, area, perimeter } from '../src/geom/poly';
import type { Piece } from '../src/model/types';
import { makeContour, gradePoint, curvePoint, newId } from '../src/model/factory';

/** Graded test piece: 200×300 bodice-ish block with a curved side, a notch, grain, text, internal line + drill. */
export function gradedDoc() {
  const style = makeStyle('TEST', ['S', 'M', 'L', 'XL'], 'M');
  const doc = new Document(style);
  const line = doc.sizeLine();
  const [S, M, L, XL] = line.sizes.map(s => s.id);
  const g = (dx: number, dy: number) => ({ [S]: { dx: 0, dy: 0 }, [M]: { dx, dy }, [L]: { dx, dy }, [XL]: { dx: dx * 1.5, dy: dy * 1.5 } });
  const sew = makeContour([
    gradePoint(0, 0, { flags: { startPoint: true } }),
    gradePoint(200, 0, { grade: g(10, 0) }),
    curvePoint(215, 150),
    gradePoint(200, 300, { grade: g(10, 15) }),
    gradePoint(0, 300, { grade: g(0, 15) }),
  ]);
  const piece: Piece = makePiece('FRONT', sew, doc.style.activeSizeTableId, { seamDefault: 10 });
  piece.sew.points[0].seamAfter = 20; // hem 20 mm
  piece.notches.push({ id: newId('n'), contourId: sew.id, type: 'slit', depth: 5, width: 0, angleDeg: 0, mode: 'cut',
    placement: { kind: 'fromPrev', anchorId: sew.points[3].id, dist: { [S]: 80, [M]: 80, [L]: 80, [XL]: 80 } } });
  piece.grain = { a: { x: 100, y: 60 }, b: { x: 100, y: 240 }, gradeA: g(5, 0), gradeB: g(5, 15), centered: false };
  piece.texts.push({ id: newId('t'), x: 40, y: 150, grade: g(2, 7), text: 'FRONT CF FOLD', size: 8, angleDeg: 0 });
  piece.internals.push(makeContour([gradePoint(50, 100, { grade: g(3, 0) }), gradePoint(150, 100, { grade: g(7, 0) })], { type: 'internal', closed: false }));
  piece.drills.push({ id: newId('d'), x: 100, y: 200, grade: g(5, 10), diameter: 4, kind: 'drill', mode: 'draw' });
  piece.order.qtyPerBundle = 2;
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, piece, ids: { S, M, L, XL } };
}

/** max distance from every vertex of a to polygon b */
const maxDev = (a: { x: number; y: number }[], b: { x: number; y: number }[]) => Math.max(...a.map(q => distToPolygon(q, b)));

function reimport(doc: Document, flavor: 'astm' | 'aama') {
  const r = exportDXF(doc, { flavor });
  const imp = importDXF(r.dxf, { rul: r.rul });
  const d2 = new Document(makeStyle('target', ['X'], 'X'));
  const [p2] = addImportToDocument(d2, imp);
  return { r, imp, d2, p2 };
}

// ════════════════════════════════════ DXF ════════════════════════════════════

describe('DXF round-trip (acceptance D11)', () => {
  for (const flavor of ['astm', 'aama'] as const) {
    it(`${flavor.toUpperCase()}: graded piece with notch, grain, text, internal, drill survives export → import`, () => {
      const { doc, piece } = gradedDoc();
      const { r, imp, d2, p2 } = reimport(doc, flavor);
      expect(imp.warnings).toEqual([]);
      expect(imp.unitsDetected).toBe('mm');
      expect(imp.unitsSource).toBe('header');
      expect(imp.yFlipped).toBe(false);
      expect(imp.pieces.length).toBe(1);
      expect(p2.name).toBe('FRONT');
      expect(p2.order.qtyPerBundle).toBe(2);
      // seam engineering re-inferred: default 10, hem 20, not a manual cut
      expect(p2.cutMode).toBe('auto');
      expect(p2.seamDefault).toBe(10);
      expect(p2.sew.points.filter(a => a.kind === 'grade').length).toBe(4);
      expect(p2.sew.points.find(a => a.seamAfter !== undefined)?.seamAfter).toBe(20);
      const line1 = doc.sizeLine(), line2 = d2.sizeLine(p2);
      expect(line2.sizes.map(s => s.name)).toEqual(['S', 'M', 'L', 'XL']);
      expect(line2.sizes.find(s => s.id === line2.baseSizeId)!.name).toBe('M');
      for (const s of line1.sizes) {
        const s2 = line2.sizes.find(z => z.name === s.name)!.id;
        const a = doc.resolvePiece(piece.id, s.id), b = d2.resolvePiece(p2.id, s2);
        // boundary: every EXPORTED vertex (sampled sew + cut) within 0.01 mm of the re-imported contour, every size
        expect(maxDev(a.sew.pts, b.sew.pts)).toBeLessThan(0.01);
        expect(maxDev(a.cut, b.cut)).toBeLessThan(0.01);
        // grade-point positions exact (rule increments applied by rule number)
        for (const gi of a.sew.gradeIdx) {
          const q = a.sew.anchorPos[gi];
          expect(Math.min(...b.sew.anchorPos.map(p => Math.hypot(p.x - q.x, p.y - q.y)))).toBeLessThan(1e-6);
        }
        // notch position
        const n1 = resolveNotch(piece, piece.notches[0], line1, s.id)!.p, n2 = resolveNotch(p2, p2.notches[0], line2, s2)!.p;
        expect(Math.hypot(n1.x - n2.x, n1.y - n2.y)).toBeLessThan(0.01);
        // grain (graded)
        expect(b.grain.a.x).toBeCloseTo(a.grain.a.x, 9); expect(b.grain.a.y).toBeCloseTo(a.grain.a.y, 9);
        expect(b.grain.b.x).toBeCloseTo(a.grain.b.x, 9); expect(b.grain.b.y).toBeCloseTo(a.grain.b.y, 9);
        // internal line, drill, text graded positions
        expect(b.internals[0].anchorPos[1].x).toBeCloseTo(a.internals[0].anchorPos[1].x, 9);
        const dOff = (p: Piece, ln: typeof line1, sid: string) => { const d = p.drills[0]; const o = absoluteOffset(d.grade, ln, sid); return { x: d.x + o.x, y: d.y + o.y }; };
        expect(dOff(p2, line2, s2)).toEqual(dOff(piece, line1, s.id));
        const tOff = (p: Piece, ln: typeof line1, sid: string) => { const t = p.texts[0]; const o = absoluteOffset(t.grade, ln, sid); return { x: t.x + o.x, y: t.y + o.y }; };
        expect(tOff(p2, line2, s2)).toEqual(tOff(piece, line1, s.id));
      }
      expect(p2.notches[0].placement.kind).toBe('fromPrev');
      expect(p2.notches[0].depth).toBeCloseTo(5, 6);
      expect(p2.texts.map(t => t.text)).toEqual(['FRONT CF FOLD']);
      expect(p2.texts[0].size).toBe(8);
      expect(p2.drills[0].diameter).toBe(4);
      expect(p2.internals.length).toBe(1);
      // y intact: the top edge y = 300 (base) appears positive in the DXF text
      expect(r.dxf).toMatch(/\r\n20\r\n300\r\n/);
      expect(r.dxf).not.toMatch(/\r\n20\r\n-300\r\n/);
      expect(r.dxf).toContain('$INSUNITS');
    });
  }

  for (const flavor of ['astm', 'aama'] as const) for (const curved of [false, true]) {
    it(`B2 ${flavor.toUpperCase()} flat + RUL keeps per-size notch distances (curved=${curved})`, () => {
      const doc = new Document(makeStyle('T', ['2', '4', '6', '8', '10'], '6'));
      const line = doc.sizeLine(); const ids = line.sizes.map(s => s.id);
      const g = (dx: number, dy: number) => Object.fromEntries(ids.map((i, k) => [i, k === 0 ? { dx: 0, dy: 0 } : { dx, dy }]));
      const sew = makeContour([gradePoint(-50, -400), gradePoint(-50, -100, { grade: g(0, 6) }), ...(curved ? [curvePoint(60, -60)] : []), gradePoint(180, -110, { grade: g(8, 6) }), gradePoint(170, -400, { grade: g(8, 0) })]);
      const p = makePiece('BY', sew, doc.style.activeSizeTableId);
      const dist = Object.fromEntries(ids.map((i, k) => [i, 100 + k * 3]));
      p.notches.push({ id: newId('n'), contourId: sew.id, type: 'slit', depth: 6, width: 0, angleDeg: 0, mode: 'cut', placement: { kind: 'fromPrev', anchorId: sew.points[0].id, dist } });
      p.grain = { a: { x: 60, y: -350 }, b: { x: 60, y: -150 }, gradeA: {}, gradeB: {}, centered: false };
      doc.transact('a', s => s.pieces.push(p));
      const r = exportDXF(doc, { flavor });
      const imp = importDXF(r.dxf, { rul: r.rul });
      expect(imp.warnings).toEqual([]);
      const d2 = new Document(makeStyle('x', ['X'], 'X')); const [p2] = addImportToDocument(d2, imp); const line2 = d2.sizeLine(p2);
      const pl = p2.notches[0].placement;
      expect(pl.kind).toBe('fromPrev');
      if (pl.kind !== 'fromPrev') throw new Error();
      line.sizes.forEach((s, k) => {
        const s2 = line2.sizes.find(z => z.name === s.name)!.id;
        expect(pl.dist[s2]).toBeCloseTo(100 + k * 3, 6);
        const n1 = resolveNotch(p, p.notches[0], line, s.id)!.p, n2 = resolveNotch(p2, p2.notches[0], line2, s2)!.p;
        expect(Math.hypot(n1.x - n2.x, n1.y - n2.y)).toBeLessThan(1e-5);
      });
    });
  }

  it('B2 nested export keeps per-size notch distances', () => {
    const doc = new Document(makeStyle('T', ['2', '4', '6', '8', '10'], '6'));
    const ids = doc.sizeLine().sizes.map(s => s.id);
    const g = (dx: number, dy: number) => Object.fromEntries(ids.map((i, k) => [i, k === 0 ? { dx: 0, dy: 0 } : { dx, dy }]));
    const sew = makeContour([gradePoint(-50, -400), gradePoint(-50, -100, { grade: g(0, 6) }), gradePoint(180, -110, { grade: g(8, 6) }), gradePoint(170, -400, { grade: g(8, 0) })]);
    const p = makePiece('BY', sew, doc.style.activeSizeTableId);
    p.notches.push({ id: newId('n'), contourId: sew.id, type: 'slit', depth: 6, width: 0, angleDeg: 0, mode: 'cut', placement: { kind: 'fromPrev', anchorId: sew.points[0].id, dist: Object.fromEntries(ids.map((i, k) => [i, 100 + k * 3])) } });
    doc.transact('a', s => s.pieces.push(p));
    const imp = importDXF(exportDXF(doc, { nested: true }).dxf);
    const pl = imp.pieces[0].notches[0].placement;
    if (pl.kind !== 'fromPrev') throw new Error('kind ' + pl.kind);
    imp.sizeLine.sizes.forEach((s, k) => expect(pl.dist[s.id]).toBeCloseTo(100 + k * 3, 6));
  });

  it('companion .rul re-imports to the same increments', () => {
    const { doc } = gradedDoc();
    const r = exportDXF(doc, { flavor: 'astm' });
    expect(r.rul).toBeDefined();
    const t = parseRUL(r.rul!);
    expect(t.sizes).toEqual(['S', 'M', 'L', 'XL']);
    expect(t.sampleSize).toBe('M');
    expect(t.units).toBe('mm');
    expect(t.rules.size).toBe(r.rules.size);
    const line = doc.sizeLine();
    for (const [n, g] of r.rules) expect(t.rules.get(n)).toEqual(line.sizes.map(s => g[s.id]));
    // the corner (200,300) carries the rule M:+10/+15, L:+10/+15, XL:+15/+22.5
    const corner = [...t.rules.values()].find(v => v[3].dx === 15 && v[3].dy === 22.5);
    expect(corner).toEqual([{ dx: 0, dy: 0 }, { dx: 10, dy: 15 }, { dx: 10, dy: 15 }, { dx: 15, dy: 22.5 }]);
    // rule text round-trip is byte-identical
    const doc2 = new Document(makeStyle('x', t.sizes, t.sampleSize));
    const line2 = doc2.sizeLine();
    const m = new Map([...t.rules].map(([n, v]) => [n, Object.fromEntries(line2.sizes.map((s, i) => [s.id, v[i]]))]));
    expect(writeRUL(m, { ...line2, name: line.name }, { flavor: 'astm' })).toBe(r.rul);
  });

  it('inch export: $INSUNITS=1, re-imported to mm exactly', () => {
    const { doc, piece } = gradedDoc();
    const r = exportDXF(doc, { flavor: 'aama', units: 'in' });
    expect(r.dxf).toMatch(/\$INSUNITS\r\n70\r\n1\r\n/);
    expect(r.rul).toContain('UNITS: ENGLISH');
    const imp = importDXF(r.dxf, { rul: r.rul });
    expect(imp.unitsDetected).toBe('in');
    const d2 = new Document(makeStyle('t', ['X'], 'X')); const [p2] = addImportToDocument(d2, imp);
    const a = doc.resolvePiece(piece.id), b = d2.resolvePiece(p2.id);
    expect(maxDev(a.sew.pts, b.sew.pts)).toBeLessThan(0.01);
    const XL2 = d2.sizeLine(p2).sizes[3].id;
    // XL = base + inc[L] + inc[XL] = (200,300) + (10,15) + (15,22.5)
    expect(d2.resolvePiece(p2.id, XL2).sew.anchorPos.some(p => Math.abs(p.x - 225) < 1e-5 && Math.abs(p.y - 337.5) < 1e-5)).toBe(true);
  });

  it('graded nest export: one BLOCK per size, re-import merges sizes into a graded piece', () => {
    const { doc, piece } = gradedDoc();
    const r = exportDXF(doc, { nested: true });
    expect(r.rul).toBeUndefined();
    const f = parseDXF(r.dxf);
    expect(Object.keys(f.blocks).sort()).toEqual(['FRONT_L', 'FRONT_M', 'FRONT_S', 'FRONT_XL']);
    const imp = importDXF(r.dxf);
    expect(imp.pieces.length).toBe(1);
    expect(imp.sizeLine.sizes.map(s => s.name)).toEqual(['S', 'M', 'L', 'XL']);
    expect(imp.sizeLine.sizes.find(s => s.id === imp.sizeLine.baseSizeId)!.name).toBe('M');
    const d2 = new Document(makeStyle('t', ['X'], 'X')); const [p2] = addImportToDocument(d2, imp);
    for (const s of doc.sizeLine().sizes) {
      const s2 = d2.sizeLine(p2).sizes.find(z => z.name === s.name)!.id;
      const a = doc.resolvePiece(piece.id, s.id), b = d2.resolvePiece(p2.id, s2);
      for (const gi of a.sew.gradeIdx) { const q = a.sew.anchorPos[gi]; expect(Math.min(...b.sew.anchorPos.map(p => Math.hypot(p.x - q.x, p.y - q.y)))).toBeLessThan(1e-6); }
      // sampled curve points of non-base sizes are graded proportionally (kernel rule) → sub-0.1 mm
      expect(maxDev(a.sew.pts, b.sew.pts)).toBeLessThan(s.id === doc.baseSize() ? 0.01 : 0.1);
    }
  });

  // A jeans back panel as TUKAcad writes it: the outline is only the pattern's own points, every
  // one of them (but three in the crotch curve) marked as a turn point, no curve points at all.
  const tukaBack = () => {
    const P: [number, number, 'g' | 'c'][] = [[2221, 327, 'g'], [2577, 336, 'g'], [2729, 343, 'g'], [2877, 365, 'g'], [3044, 395, 'g'], [3133, 398, 'g'], [3218, 386, 'g'], [3257, 374, 'g'], [3270, 138, 'g'], [3260, 136, 'g'], [3139, 111, 'g'], [3118, 106, 'c'], [3074, 85, 'c'], [3058, 39, 'c'], [3057, 17, 'g'], [3040, 21, 'g'], [2880, 58, 'g'], [2729, 81, 'g'], [2577, 90, 'g'], [2221, 99, 'g'], [2221, 214, 'g']];
    const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '8', '1', '90', String(P.length), '70', '1', ...P.flatMap(([x, y]) => ['10', String(x), '20', String(y)]),
      ...P.filter(q => q[2] === 'g').flatMap(([x, y]) => ['0', 'POINT', '8', '2', '10', String(x), '20', String(y)]),
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    return { P, dxf };
  };
  it('turn points only, no curve points (TUKAcad-style): curves are rebuilt through the sparse points; corners and straight edges stay', () => {
    const { P, dxf } = tukaBack();
    const imp = importDXF(dxf);
    const pts = imp.pieces[0].sew.points;
    expect(pts.map(a => [a.x, a.y])).toEqual(P.map(([x, y]) => [x, y])); // no point is moved, added or dropped
    const at = (x: number, y: number) => pts.find(a => a.x === x && a.y === y)!;
    // the hip curve: shallow bends between long edges → smooth grade points
    for (const [x, y] of [[2729, 343], [2877, 365], [3044, 395], [3133, 398], [2880, 58], [2729, 81]]) expect([x, y, at(x, y).kind, at(x, y).smooth]).toEqual([x, y, 'grade', true]);
    // the crotch curve: points the file did not mark as turn points → smooth curve points
    for (const [x, y] of [[3118, 106], [3074, 85], [3058, 39]]) expect([x, y, at(x, y).kind, at(x, y).smooth]).toEqual([x, y, 'curve', true]);
    // real corners (hem ends, waist corners) and a point on a straight edge stay as they are
    for (const [x, y] of [[2221, 327], [2221, 99], [3257, 374], [3270, 138], [3057, 17], [2221, 214]]) expect([x, y, at(x, y).smooth]).toEqual([x, y, false]);
    // the rebuilt outline is a curve: it leaves the polygon between the sparse points, by millimetres not centimetres
    const line = imp.sizeLine;
    const r = resolveContour(imp.pieces[0].sew, line, line.baseSizeId);
    const poly = P.map(([x, y]) => ({ x, y }));
    const dev = Math.max(...r.pts.map(q => distToPolygon(q, poly)));
    expect(r.pts.length).toBeGreaterThan(P.length * 3);
    expect(dev).toBeGreaterThan(1); expect(dev).toBeLessThan(15);
    // opt out: exactly the polygon of the file
    const flat = importDXF(dxf, { sparseCurves: false });
    expect(flat.pieces[0].sew.points.every(a => !a.smooth)).toBe(true);
  });
  it('a file that marks its curve points is read as written (no rebuilding): a shallow turn point stays a corner', () => {
    const P: [number, number][] = [[0, 0], [150, 0], [300, 12], [300, 200], [150, 215], [0, 200]];
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', '1', '90', String(P.length), '70', '1', ...P.flatMap(([x, y]) => ['10', String(x), '20', String(y)]),
      ...P.filter((_, i) => i !== 4).flatMap(([x, y]) => ['0', 'POINT', '8', '2', '10', String(x), '20', String(y)]), '0', 'POINT', '8', '3', '10', '150', '20', '215',
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const pts = importDXF(dxf, { units: 'mm' }).pieces[0].sew.points;
    expect(pts.find(a => a.x === 150 && a.y === 0)!.smooth).toBe(false); // turn point with a 4.6° bend: still a corner
    expect(pts.find(a => a.x === 150 && a.y === 215)!.kind).toBe('curve');
  });

  it('boundary only (layer 1) → sew = boundary, noSeam, noted in report', () => {
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', '1', '90', '4', '70', '1',
      '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '50', '10', '0', '20', '50', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const imp = importDXF(dxf);
    expect(imp.pieces.length).toBe(1);
    const p = imp.pieces[0];
    expect(p.noSeam).toBe(true);
    expect(p.sew.points.map(a => [a.x, a.y])).toEqual([[0, 0], [100, 0], [100, 50], [0, 50]]);
    expect(p.sew.points.every(a => a.kind === 'grade' && !a.smooth)).toBe(true);
    expect(imp.notes.some(n => /noSeam/.test(n))).toBe(true);
    expect(imp.unitsSource).toBe('heuristic');
    expect(imp.layerMap['1']).toEqual({ role: 'boundary', entities: 1 });
  });

  it('layers 1 + 14 with a non-offset boundary → manual cut, flagged', () => {
    const poly = (layer: string, pts: number[][]) => ['0', 'LWPOLYLINE', '8', layer, '90', String(pts.length), '70', '1', ...pts.flatMap(([x, y]) => ['10', String(x), '20', String(y)])];
    const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
      ...poly('1', [[-10, -10], [110, -10], [130, 60], [-10, 60]]), ...poly('14', [[0, 0], [100, 0], [100, 50], [0, 50]]), '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const imp = importDXF(dxf);
    const p = imp.pieces[0];
    expect(p.cutMode).toBe('manual');
    expect(p.manualCut!.points.map(a => [a.x, a.y])).toEqual([[-10, -10], [110, -10], [130, 60], [-10, 60]]);
    expect(imp.warnings.some(w => /seams could not be inferred/.test(w))).toBe(true);
    const d = new Document(makeStyle('t', ['X'], 'X')); const [q] = addImportToDocument(d, imp);
    expect(area(d.resolvePiece(q.id).cut)).toBeCloseTo(120 * 70 + 0.5 * 20 * 70, 6);
  });

  it('entities: bulge arc, ARC, CIRCLE drill, SPLINE, POINT markers, INSERT transform, notch layer, inches by header', () => {
    // 2×1 in rectangle whose right side is a semicircular bulge; inserted via a block scaled ×1 and translated by (1,1) in
    const L: string[] = [];
    const g = (...kv: (string | number)[]) => { for (const x of kv) L.push(String(x)); };
    g(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 1, 0, 'ENDSEC');
    g(0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 8, 0, 2, 'P1', 70, 0, 10, 0, 20, 0);
    g(0, 'LWPOLYLINE', 8, '1', 90, 4, 70, 1, 10, 0, 20, 0, 10, 2, 20, 0, 42, 1, 10, 2, 20, 1, 10, 0, 20, 1);
    g(0, 'LINE', 8, '4', 10, 1, 20, 0, 11, 1, 21, 0.25);
    g(0, 'CIRCLE', 8, '13', 10, 1, 20, 0.5, 40, 0.0787401575);
    g(0, 'LINE', 8, '7', 10, 0.5, 20, 0.2, 11, 0.5, 21, 0.8);
    g(0, 'TEXT', 8, '1', 10, 0.2, 20, 0.5, 40, 0.1, 1, 'Piece Name: CUFF');
    g(0, 'TEXT', 8, '15', 10, 0.2, 20, 0.7, 40, 0.2, 1, 'CUT 2');
    g(0, 'POINT', 8, '2', 10, 0, 20, 0); g(0, 'POINT', 8, '2', 10, 2, 20, 0); g(0, 'POINT', 8, '2', 10, 2, 20, 1); g(0, 'POINT', 8, '2', 10, 0, 20, 1);
    g(0, 'SPLINE', 8, '8', 70, 8, 71, 3, 72, 8, 73, 4, 40, 0, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 40, 1, 10, 0.2, 20, 0.2, 10, 0.6, 20, 0.6, 10, 1.0, 20, 0.2, 10, 1.4, 20, 0.6);
    g(0, 'ENDBLK');
    g(0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'INSERT', 8, 0, 2, 'P1', 10, 1, 20, 1, 0, 'ENDSEC', 0, 'EOF');
    const imp = importDXF(L.join('\r\n'));
    expect(imp.unitsDetected).toBe('in');
    expect(imp.warnings).toEqual([]);
    const p = imp.pieces[0];
    expect(p.name).toBe('CUFF');
    const pts = p.sew.points;
    // 4 marked turn points (offset by insert (25.4, 25.4)), arc points are curve
    const turns = pts.filter(a => a.kind === 'grade').map(a => [+a.x.toFixed(9), +a.y.toFixed(9)]);
    expect(turns).toEqual([[25.4, 25.4], [76.2, 25.4], [76.2, 50.8], [25.4, 50.8]]);
    expect(pts.filter(a => a.kind === 'curve').length).toBeGreaterThan(5);
    // bulge = 1 → semicircle of radius 12.7 mm centred at (76.2, 38.1), bulging to +x
    const maxX = Math.max(...pts.map(a => a.x));
    expect(maxX).toBeCloseTo(76.2 + 12.7, 3);
    for (const a of pts.filter(a => a.kind === 'curve')) expect(Math.hypot(a.x - 76.2, a.y - 38.1)).toBeCloseTo(12.7, 9);
    // notch line on layer 4 at x = 1 in → 25.4 mm from the start corner, depth 0.25 in
    expect(p.notches.length).toBe(1);
    const line = imp.sizeLine;
    const np = resolveNotch(p, p.notches[0], line, line.baseSizeId)!.p;
    expect(np.x).toBeCloseTo(50.8, 9); expect(np.y).toBeCloseTo(25.4, 9);
    expect(p.notches[0].depth).toBeCloseTo(6.35, 9);
    expect(p.drills.length).toBe(1);
    expect(p.drills[0].x).toBeCloseTo(50.8, 9); expect(p.drills[0].y).toBeCloseTo(38.1, 9); expect(p.drills[0].diameter).toBeCloseTo(4, 6);
    expect(p.grain.a.x).toBeCloseTo(38.1, 9); expect(p.grain.a.y).toBeCloseTo(30.48, 9);
    expect(p.texts.map(t => t.text)).toEqual(['CUT 2']);
    expect(p.texts[0].size).toBeCloseTo(5.08, 9);
    // spline internal: clamped cubic Bézier ends at its end control points
    expect(p.internals.length).toBe(1);
    const ic = p.internals[0].points;
    expect(ic[0].x).toBeCloseTo(30.48, 9); expect(ic[ic.length - 1].x).toBeCloseTo(60.96, 9); expect(ic[ic.length - 1].y).toBeCloseTo(40.64, 9);
  });

  it('bulgePoints: quarter circle sagitta', () => {
    const b = Math.tan(Math.PI / 8); // 90° CCW arc
    const pts = bulgePoints({ x: 10, y: 0 }, { x: 0, y: 10 }, b, 0.001);
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 9);
  });

  it('rule numbers on vertices without a .rul are reported, unknown rules are listed', () => {
    const { doc } = gradedDoc();
    const r = exportDXF(doc);
    const noRul = importDXF(r.dxf);
    expect(noRul.warnings.some(w => /no \.rul/.test(w))).toBe(true);
    const short = r.rul!.replace(/RULE: DELTA 3\r\n[^\r]*\r\n/, '');
    const imp = importDXF(r.dxf, { rul: short });
    expect(imp.unresolvedRules).toEqual([3]);
  });

  it('parseRUL reads wrapped inch rules', () => {
    const t = parseRUL(['UNITS: ENGLISH', 'GRADE RULE TABLE: MISSY', 'NUMBER OF SIZES: 3', 'SIZE LIST: 8 10', '12', 'SAMPLE SIZE: 10',
      'RULE: DELTA 7', '0,0,0.25,', '-0.125,0.5,0', 'END'].join('\n'));
    expect(t.sizes).toEqual(['8', '10', '12']);
    expect(t.rules.get(7)).toEqual([{ dx: 0, dy: 0 }, { dx: 6.35, dy: -3.175 }, { dx: 12.7, dy: 0 }]);
  });
});

// ════════════════════════════════════ SVG ════════════════════════════════════

describe('SVG', () => {
  it('path sampler: M/L/H/V/C/Q/A/Z (relative + absolute)', () => {
    const subs = samplePath('M0 0 h100 v50 H0 Z m10 10 l10 0 c0 0 10 0 10 10 q0 10 -10 10 a10 10 0 0 1 -10 -10z', 0.01);
    expect(subs.length).toBe(2);
    expect(subs[0].closed).toBe(true);
    expect(subs[0].pts.map(p => [p.x, p.y])).toEqual([[0, 0], [100, 0], [100, 50], [0, 50]]);
    const s2 = subs[1].pts;
    expect(s2[0]).toEqual({ x: 10, y: 10 });
    // arc from (20,30) to (10,20), r = 10, sweep=1 → centre (20,20) — every arc sample is 10 from it
    const arc = s2.slice(s2.findIndex(p => p.x === 20 && p.y === 30) + 1, -1);
    expect(arc.length).toBeGreaterThan(3);
    for (const p of arc) expect(Math.hypot(p.x - 20, p.y - 20)).toBeCloseTo(10, 9);
  });

  it('transforms compose (translate · rotate · scale)', () => {
    const T = parseTransform('translate(10 20) rotate(90) scale(2)');
    expect(T.map(v => +v.toFixed(12))).toEqual([0, 2, -2, 0, 10, 20]);
  });

  it('import: px at 96 dpi → mm, y flipped, transforms applied, short stroke → notch', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
      <g transform="translate(96 96)">
        <rect x="0" y="0" width="384" height="192"/>
        <line x1="192" y1="0" x2="192" y2="18.897637795"/>
        <text x="20" y="100" font-size="12">BACK</text>
      </g></svg>`;
    const imp = importSVG(svg);
    expect(imp.yFlipped).toBe(true);
    expect(imp.pieces.length).toBe(1);
    const p = imp.pieces[0];
    const xs = p.sew.points.map(a => a.x), ys = p.sew.points.map(a => a.y);
    expect(Math.min(...xs)).toBeCloseTo(25.4, 9); expect(Math.max(...xs)).toBeCloseTo(127, 9);
    expect(Math.max(...ys)).toBeCloseTo(-25.4, 9); expect(Math.min(...ys)).toBeCloseTo(-76.2, 9);
    expect(p.noSeam).toBe(true);
    expect(p.notches.length).toBe(1);
    expect(p.notches[0].depth).toBeCloseTo(5, 6);
    const np = resolveNotch(p, p.notches[0], imp.sizeLine, imp.sizeLine.baseSizeId)!.p;
    expect(np.x).toBeCloseTo(76.2, 9); expect(np.y).toBeCloseTo(-25.4, 9);
    expect(p.texts[0].text).toBe('BACK');
    expect(p.texts[0].size).toBeCloseTo(3.175, 9);
  });

  it('import: physical width + viewBox defines mm per user unit', () => {
    const imp = importSVG('<svg width="200mm" height="100mm" viewBox="0 0 2000 1000"><path d="M100 100 L1100 100 L1100 600 L100 600 Z"/></svg>');
    const p = imp.pieces[0];
    expect(imp.unitsSource).toBe('header');
    expect(p.sew.points.map(a => [a.x, a.y])).toEqual([[10, -10], [110, -10], [110, -60], [10, -60]]);
  });

  it('export: 1:1 mm viewBox, one <g> per piece with role groups; re-import preserves geometry', () => {
    const { doc, piece } = gradedDoc();
    const svg = exportSVG(doc);
    expect(svg).toMatch(/<svg [^>]*width="([\d.]+)mm" height="([\d.]+)mm" viewBox="[-\d.]+ [-\d.]+ \1 \2"/);
    for (const role of ['cut', 'sew', 'internal', 'notch', 'grain', 'drill', 'text']) expect(svg).toContain(`data-role="${role}"`);
    expect(svg.match(/<g class="piece"/g)!.length).toBe(1);
    // base sew corner (200,300) written as (200,-300)
    expect(svg).toContain('200,-300');
    const imp = importSVG(svg);
    expect(imp.warnings).toEqual([]);
    const p2 = imp.pieces[0];
    expect(p2.name).toBe('FRONT');
    expect(p2.seamDefault).toBe(10);
    const d2 = new Document(makeStyle('t', ['X'], 'X')); const [q] = addImportToDocument(d2, imp);
    const a = doc.resolvePiece(piece.id), b = d2.resolvePiece(q.id);
    expect(maxDev(a.sew.pts, b.sew.pts)).toBeLessThan(0.02);
    expect(maxDev(a.cut, b.cut)).toBeLessThan(0.02);
    expect(q.texts[0].text).toBe('FRONT CF FOLD');
    expect(q.grain.a).toEqual({ x: 100, y: 60 });
    expect(q.notches.length).toBe(1);
  });

  it('export: per-size nest writes one cut path per size', () => {
    const { doc } = gradedDoc();
    const ids = doc.sizeLine().sizes.map(s => s.id);
    const svg = exportSVG(doc, { sizes: ids });
    expect(svg.match(/<path class="cut"/g)!.length).toBe(4);
    expect(svg.match(/data-size="/g)!.length).toBe(4);
  });
});

// ════════════════════════════════════ HPGL ════════════════════════════════════

describe('PLT / HPGL', () => {
  it('parser: PU/PD/PA/PR/SP/LB/CI', () => {
    const r = parseHPGL('IN;SP2;PU0,0;PD4000,0,4000,2000;PR-4000,0;PA0,0;PU;LBHELLO\x03PU100,100;CI40;');
    expect(r.strokes[0].pen).toBe(2);
    expect(r.strokes[0].pts).toEqual([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }, { x: 0, y: 0 }]);
    expect(r.labels).toEqual([{ p: { x: 0, y: 0 }, text: 'HELLO', pen: 2, h: undefined }]);
    expect(r.strokes[1].pts.every(p => Math.abs(Math.hypot(p.x - 100, p.y - 100) - 40) < 1e-9)).toBe(true);
  });

  it('import: 0.025 mm units, closed run → piece, notch spike removed + detected, separate stroke notch', () => {
    // 100 × 50 mm; bottom edge carries a 5 mm spike at x = 30; a separate 4 mm stroke notch on the top edge at x = 70
    const plt = 'IN;SP1;PU0,0;PD1200,0,1200,200,1200,0,4000,0,4000,2000,0,2000,0,0;PU2800,2000;PD2800,1840;PU;LBPiece Name: YOKE\x03';
    const imp = importHPGL(plt);
    expect(imp.yFlipped).toBe(false);
    const p = imp.pieces[0];
    expect(p.name).toBe('YOKE');
    expect(p.sew.points.map(a => [a.x, a.y])).toEqual([[0, 0], [30, 0], [100, 0], [100, 50], [0, 50]]);
    expect(p.notches.length).toBe(2);
    const pos = p.notches.map(n => resolveNotch(p, n, imp.sizeLine, imp.sizeLine.baseSizeId)!.p);
    expect(pos).toContainEqual({ x: 30, y: 0 });
    expect(pos.some(q => Math.abs(q.x - 70) < 1e-9 && Math.abs(q.y - 50) < 1e-9)).toBe(true);
    expect(p.notches.map(n => n.depth).sort()).toEqual([4, 5]);
    expect(area(resolveContour(p.sew, imp.sizeLine, imp.sizeLine.baseSizeId).pts)).toBeCloseTo(5000, 9);
  });

  it('export: device profile (units/mm, pens, notch code, labels) and round-trip', () => {
    const { doc, piece } = gradedDoc();
    const plt = exportHPGL(doc, { profile: { unitsPerMm: 40, notchCode: 'line', pens: { cut: 1, sew: 2, notch: 7 } } });
    expect(plt.startsWith('IN;')).toBe(true);
    expect(plt).toContain('SP7;'); expect(plt).toContain('SP2;');
    expect(plt).toContain('LBPiece Name: FRONT\x03');
    expect(plt).toContain('LBFRONT CF FOLD\x03');
    // base cut corner (−10,−20) → (−400,−800) plotter units, layout none keeps drafting coordinates
    expect(plt).toContain('PU-400,-800;');
    const imp = importHPGL(plt, { profile: { pens: { sew: 2 } } });
    const p2 = imp.pieces[0];
    expect(p2.name).toBe('FRONT');
    expect(p2.seamDefault).toBe(10);
    expect(p2.notches.length).toBe(1);
    expect(p2.drills.length).toBe(1);
    const d2 = new Document(makeStyle('t', ['X'], 'X')); const [q] = addImportToDocument(d2, imp);
    expect(maxDev(doc.resolvePiece(piece.id).cut, d2.resolvePiece(q.id).cut)).toBeLessThanOrEqual(0.0125 * Math.SQRT2 + 0.01);
    // spike notch code
    const spk = exportHPGL(doc, { profile: { notchCode: 'spike' } });
    const imp2 = importHPGL(spk);
    expect(imp2.pieces[0].notches.length).toBe(1);
    // 80 units/mm profile doubles every coordinate
    expect(exportHPGL(doc, { profile: { unitsPerMm: 80 } })).toContain('PU-800,-1600;');
  });

  it('frame width overflow throws', () => {
    const { doc } = gradedDoc();
    expect(() => exportHPGL(doc, { profile: { frameWidth: 100 } })).toThrow(/exceeds plotter frame width/);
  });
});

// ════════════════════════════════════ PDF ════════════════════════════════════

function pdfText(bytes: Uint8Array) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; }
function pageStreams(pdf: string): string[] { return [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m => m[1]); }

describe('tiled PDF (acceptance D16)', () => {
  it('A4 media box and the 100 mm reference square measure exactly 100 mm (283.4646 pt)', () => {
    const { doc } = gradedDoc();
    const r = exportPDF(doc, { page: 'A4' });
    const pdf = pdfText(r.bytes);
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    const mb = [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];
    expect(mb.length).toBe(r.pages);
    for (const m of mb) {
      expect(Number(m[1])).toBeCloseTo(210 * 72 / 25.4, 4); // 595.2756
      expect(Number(m[2])).toBeCloseTo(297 * 72 / 25.4, 4); // 841.8898
      expect(Number(m[1]) * 25.4 / 72).toBeCloseTo(210, 3);
    }
    expect(100 * PT_PER_MM).toBeCloseTo(283.4646, 4);
    // the reference square is drawn with `re` at 283.4646 × 283.4646 pt
    const squares = pageStreams(pdf).flatMap(s => [...s.matchAll(/([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+) re S/g)]);
    expect(squares.length).toBeGreaterThanOrEqual(1);
    for (const m of squares) { expect(m[3]).toBe('283.4646'); expect(m[4]).toBe('283.4646'); expect(Number(m[3]) * 25.4 / 72).toBeCloseTo(100, 4); }
    // xref offsets are correct
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    const offs = [...pdf.slice(startxref).matchAll(/(\d{10}) 00000 n/g)].map(m => Number(m[1]));
    offs.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it('tiling: page count, A1/B2 labels, glue overlap and 1:1 piece geometry across pages', () => {
    const { doc, piece } = gradedDoc();
    const r = exportPDF(doc, { page: 'A4', referenceSquare: false, margin: 10, overlap: 10 });
    // content: cut line 235.x × 340 mm ; printable 190×277, step 180×267
    const cut = doc.resolvePiece(piece.id).cut;
    const xs = cut.map(p => p.x), ys = cut.map(p => p.y);
    expect(r.contentMm.h).toBeCloseTo(Math.max(...ys, 240) - Math.min(...ys), 9);
    expect(r.cols).toBe(Math.ceil((r.contentMm.w - 10) / 180));
    expect(r.rows).toBe(Math.ceil((r.contentMm.h - 10) / 267));
    expect(r.cols).toBe(2); expect(r.rows).toBe(2);
    expect(r.labels).toEqual(['A1', 'B1', 'A2', 'B2']);
    const pdf = pdfText(r.bytes);
    expect(pdf).toContain('(A1) Tj'); expect(pdf).toContain('(B2) Tj');
    expect(pdf).toContain('(glue B1 here) Tj');
    // the 300 mm left edge of the sew line: on page A1 the sew line's (0,0)→… is drawn, compare two
    // drawn vertices of the cut polygon on page A1: horizontal hem edge length = 200 + 2·10 mm
    const s0 = pageStreams(pdf)[0];
    const firstCut = /0\.6 w \[\] 0 d\n([-\d.]+) ([-\d.]+) m\n([-\d.]+) ([-\d.]+) l/.exec(s0)!;
    const dx = (Number(firstCut[3]) - Number(firstCut[1])) / PT_PER_MM, dy = (Number(firstCut[4]) - Number(firstCut[2])) / PT_PER_MM;
    expect(Math.hypot(dx, dy)).toBeCloseTo(Math.hypot(cut[1].x - cut[0].x, cut[1].y - cut[0].y), 3);
    expect(Math.min(...xs)).toBeCloseTo(-10, 9);
    // registration crosses: 4 per page
    for (const s of pageStreams(pdf)) expect((s.match(/ c S/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('Letter / A0 / custom pages and per-size nest', () => {
    const { doc } = gradedDoc();
    const L = exportPDF(doc, { page: 'Letter' });
    expect(L.mediaBox).toEqual([612, 792]);
    const A0 = exportPDF(doc, { page: 'A0', sizes: doc.sizeLine().sizes.map(s => s.id) });
    expect(A0.pages).toBe(1);
    expect(A0.mediaBox[0]).toBeCloseTo(841 * PT_PER_MM, 4);
    const nested = pdfText(A0.bytes);
    expect((nested.match(/RG 0\.6 w \[\] 0 d/g) ?? []).length).toBe(4);
    const C = exportPDF(doc, { page: { w: 500, h: 500 }, orientation: 'landscape' });
    expect(C.mediaBox[0]).toBeCloseTo(1417.3228, 4);
    expect(colLabel(0)).toBe('A'); expect(colLabel(25)).toBe('Z'); expect(colLabel(26)).toBe('AA');
  });
});

// ════════════════════════════════════ native ════════════════════════════════════

describe('native JSON (prowdcad/2)', () => {
  it('save → load round-trips the Style exactly', () => {
    const { doc } = gradedDoc();
    const json = saveNative(doc);
    const r = loadNative(json);
    expect(r.migratedFrom).toBeUndefined();
    expect(r.style).toEqual(doc.style);
  });

  it('validation rejects broken files with precise problems', () => {
    const { doc } = gradedDoc();
    const bad = JSON.parse(saveNative(doc));
    bad.pieces[0].notches[0].placement.anchorId = 'nope';
    bad.pieces[0].sew.points[1].x = 'x';
    try { loadNative(bad); throw new Error('should throw'); } catch (e) {
      expect(e).toBeInstanceOf(NativeFormatError);
      expect((e as NativeFormatError).problems).toEqual(['pieces[0].sew.points[1] malformed', 'pieces[0].notches[0].placement.anchorId unknown']);
    }
    expect(() => loadNative('{nope')).toThrow(/not valid JSON/);
    expect(() => loadNative({ schema: 'prowdcad/9' })).toThrow(/unsupported schema "prowdcad\/9"/);
  });

  it('migration hook upgrades older schemas', () => {
    const { doc } = gradedDoc();
    const old = JSON.parse(saveNative(doc)); old.schema = 'prowdcad/1'; old.title = old.name; delete old.name;
    registerMigration({ from: 'prowdcad/1', to: 'prowdcad/2', migrate: o => { o.name = o.title; delete o.title; o.schema = 'prowdcad/2'; return o; } });
    const r = loadNative(old);
    expect(r.migratedFrom).toBe('prowdcad/1');
    expect(r.style.name).toBe('TEST');
    expect(r.warnings).toEqual(['migrated prowdcad/1 → prowdcad/2']);
  });

  it('legacy .wptn migrates (y-down → y-up, notches {seg,t})', () => {
    const wptn = { type: 'wptn', version: 2, name: 'OLD', size: 'M', measurements: [], pieces: [{ name: 'BACK', seam: 10, qty: 2,
      points: [{ x: 0, y: 0, curve: false }, { x: 100, y: 0, curve: false }, { x: 100, y: 50, curve: false }, { x: 0, y: 50, curve: false }],
      notches: [{ seg: 0, t: 0.25 }], internals: [{ x1: 10, y1: 10, x2: 90, y2: 10 }], grain: { x1: 50, y1: 5, x2: 50, y2: 45 }, annotations: ['CUT 2'] }] };
    const r = loadNative(wptn);
    expect(r.migratedFrom).toBe('wptn/2');
    const p = r.style.pieces[0];
    expect(p.sew.points.map(a => [a.x, a.y])).toEqual([[0, -0], [100, -0], [100, -50], [0, -50]].map(([x, y]) => [x, y]));
    expect(p.seamDefault).toBe(10);
    const doc = new Document(r.style);
    expect(notchPositions(p, doc.sizeLine(p), doc.baseSize(p))[0]).toEqual({ x: 25, y: 0 });
    expect(p.grain.a).toEqual({ x: 50, y: -5 });
  });

  it('exportSizeAsStandalone: size L becomes the base; notches/internals follow; grading stripped', () => {
    const { doc, piece, ids } = gradedDoc();
    const st = exportSizeAsStandalone(doc, piece.id, ids.L);
    expect(loadNative(saveNative(st)).style.pieces.length).toBe(1);
    const d2 = new Document(st);
    const p2 = d2.style.pieces[0];
    expect(d2.sizeLine(p2).sizes.map(s => s.name)).toEqual(['L']);
    const a = doc.resolvePiece(piece.id, ids.L), b = d2.resolvePiece(p2.id);
    expect(b.sew.anchorPos).toEqual(a.sew.anchorPos);
    expect(maxDev(a.cut, b.cut)).toBeLessThan(1e-9);
    expect(perimeter(b.sew.pts)).toBeCloseTo(perimeter(a.sew.pts), 9);
    expect(b.grain).toEqual(a.grain);
    expect(b.internals[0].anchorPos).toEqual(a.internals[0].anchorPos);
    const n1 = resolveNotch(piece, piece.notches[0], doc.sizeLine(), ids.L)!.p, n2 = resolveNotch(p2, p2.notches[0], d2.sizeLine(p2), d2.baseSize(p2))!.p;
    expect(n2.x).toBeCloseTo(n1.x, 9); expect(n2.y).toBeCloseTo(n1.y, 9);
    // base M → L is one increment: drill (100,200)+(5,10), text (40,150)+(2,7)
    expect(p2.drills[0]).toMatchObject({ x: 105, y: 210, grade: {} });
    expect(p2.texts[0]).toMatchObject({ x: 42, y: 157, grade: {} });
    for (const c of [p2.sew, ...p2.internals]) for (const an of c.points) expect(an.grade).toEqual({});
    // fresh ids
    expect(p2.sew.points.some(an => piece.sew.points.some(o => o.id === an.id))).toBe(false);
    expect(p2.id).not.toBe(piece.id);
  });

  it('plain ungraded piece: rectangle + makePiece default survives loadNative', () => {
    const doc = new Document(makeStyle());
    doc.transact('add', s => s.pieces.push(makePiece('A', rectangleContour(0, 0, 10, 10), s.activeSizeTableId)));
    expect(loadNative(saveNative(doc, { pretty: true })).style.pieces[0].name).toBe('A');
  });
});
