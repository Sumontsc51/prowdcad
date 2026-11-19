import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, rectangleContour, makeContour, gradePoint } from '../src/model/factory';
import { switchMarkerMaterial, markerPerimeter, partLabel, borderText, cutOutline, DEFAULT_ANNOT, type MarkerDoc } from '../src/marker/marker';
import { directedParts, obeyDirection, groupMayTurn, directionGroup, throwParts, autoCutPlan, planTotals, markerParts, markerStats, markerProblems, placeAt, placedPoly, polyBox, nestJob, nestResult, markerDXF, markerHPGL, simplifyClosed } from '../src/marker/marker';

describe('cut plan', () => {
  const sizes = ['S', 'M', 'L', 'XL'];
  it('cuts the order exactly within the limits', () => {
    const order = { S: 100, M: 200, L: 200, XL: 100 };
    const rows = autoCutPlan(sizes, order, { maxPlies: 50, maxBundles: 6 });
    const t = planTotals(sizes, order, rows);
    expect(t.exact).toBe(true); expect(t.garments).toBe(600);
    for (const r of rows) { expect(r.plies).toBeLessThanOrEqual(50); expect(Object.values(r.ratio).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6); }
    expect(rows.length).toBe(2);
    expect(rows[0].ratio).toEqual({ S: 1, M: 2, L: 2, XL: 1 });
  });
  it('handles odd quantities with a remainder marker', () => {
    const order = { S: 37, M: 121, L: 88, XL: 5 };
    const rows = autoCutPlan(sizes, order, { maxPlies: 40, maxBundles: 8 });
    expect(planTotals(sizes, order, rows).exact).toBe(true);
    expect(rows.length).toBeLessThan(12);
  });
  it('an edited plan shows what is over and short', () => {
    const t = planTotals(sizes, { S: 10, M: 10, L: 0, XL: 0 }, [{ id: 'a', name: 'a', ratio: { S: 1, M: 2, L: 0, XL: 0 }, plies: 6 }]);
    expect(t.diff).toEqual({ S: -4, M: 2, L: 0, XL: 0 }); expect(t.exact).toBe(false);
  });
  it('an empty order gives no markers', () => { expect(autoCutPlan(sizes, {}, { maxPlies: 50, maxBundles: 6 })).toEqual([]); });
});

function style() {
  const d = new Document(makeStyle('t', ['S', 'M'], 'M'));
  const body = makePiece('BODY', rectangleContour(0, 0, 400, 600), d.style.activeSizeTableId, { seamDefault: 10 });
  const slv = makePiece('SLEEVE', makeContour([gradePoint(0, 0), gradePoint(300, 0), gradePoint(240, 200), gradePoint(60, 200)]), d.style.activeSizeTableId, { seamDefault: 0 });
  d.transact('add', s => { s.pieces.push(body, slv); s.pieces[1].order.side = 'LR'; s.pieces[0].order.qtyPerBundle = 2; s.pieces[1].order.rotation = '1way'; });
  return d;
}
const ids = (d: Document) => Object.fromEntries(d.sizeLine().sizes.map(s => [s.name, s.id]));

describe('marker parts', () => {
  it('one part per piece, size, bundle and quantity; pairs give a mirrored part; grain runs along the fabric', () => {
    const d = style(), I = ids(d);
    const parts = markerParts(d, { [I.S]: 1, [I.M]: 2 });
    // BODY ×2 per bundle, SLEEVE as a pair: 4 parts per bundle, 3 bundles
    expect(parts.length).toBe(12);
    const body = parts.find(p => p.name === 'BODY')!;
    const b = polyBox(body.poly);
    expect([b.x0, b.y0]).toEqual([0, 0]);
    expect(b.x1).toBeCloseTo(620, 6); expect(b.y1).toBeCloseTo(420, 6); // the grain (up the piece) now runs along x; seam 10 all round
    expect(body.angles).toEqual([0, 180]);
    const sl = parts.filter(p => p.name === 'SLEEVE' && p.sizeName === 'M' && p.bundle === 1);
    expect(sl.map(p => p.mirror).sort()).toEqual([false, true]);
    expect(sl[0].angles).toEqual([0]);
    expect(new Set(parts.map(p => p.id)).size).toBe(12);
  });
});

describe('placing, checks, statistics', () => {
  it('finds overlaps and parts off the fabric, and measures length and efficiency', () => {
    const d = style(), I = ids(d);
    const parts = markerParts(d, { [I.M]: 1 }).filter(p => p.name === 'BODY');
    const [a, b] = parts;
    const pl = { [a.id]: placeAt(a, 0, 0, 0), [b.id]: placeAt(b, 620, 0, 180) };
    expect(markerProblems(parts, pl, 420).size).toBe(0);
    const st = markerStats(parts, pl, 420);
    expect(st.length).toBeCloseTo(1240, 6); expect(st.efficiency).toBeCloseTo(1, 6); expect(st.placed).toBe(2);
    pl[b.id] = placeAt(b, 300, 0, 0);
    expect([...markerProblems(parts, pl, 420)].sort()).toEqual([a.id, b.id].sort());
    pl[b.id] = placeAt(b, 620, 30, 0);
    expect([...markerProblems(parts, pl, 420)]).toEqual([b.id]);
    expect(polyBox(placedPoly(b, placeAt(b, 50, 60, 90))).x0).toBeCloseTo(50, 6);
  });
});

describe('nesting engine', () => {
  it('builds a job with demands, and the real engine lays every part without overlap', () => {
    const d = style(), I = ids(d);
    const parts = markerParts(d, { [I.S]: 1, [I.M]: 1 });
    const job = nestJob(parts, 1000);
    const inst = JSON.parse(job.json);
    expect(inst.strip_height).toBe(1000);
    expect(inst.items.reduce((a: number, it: { demand: number }) => a + it.demand, 0)).toBe(parts.length);
    const glue = readFileSync(new URL('../../../apps/web/src/marker/sparrow-glue.txt', import.meta.url), 'utf8');
    const wasm = Buffer.from(readFileSync(new URL('../../../apps/web/src/marker/sparrow-wasm.b64.txt', import.meta.url), 'utf8').trim(), 'base64');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const wb = new Function(glue + '; return wasm_bindgen;')();
    wb.initSync({ module: wasm });
    const out = wb.nest(job.json, 3, BigInt(11), 1, job.gap, JSON.stringify({ noimp: 100, strikes: 2, csamp: 100, fsamp: 50 }), '', () => {});
    const res = nestResult(out, job);
    expect(Object.keys(res.placements).length).toBe(parts.length);
    expect(markerProblems(parts, res.placements, 1000, 1).size).toBe(0);
    const st = markerStats(parts, res.placements, 1000);
    expect(st.length).toBeCloseTo(res.length, 0);
    expect(st.efficiency).toBeGreaterThan(0.6);
    // a sleeve that may not turn stays at 0°
    for (const p of parts.filter(q => q.name === 'SLEEVE')) expect(res.placements[p.id].rot).toBe(0);
  }, 30000);
  it('simplifying an outline keeps its corners', () => {
    const circle = Array.from({ length: 200 }, (_, i) => ({ x: 100 * Math.cos(i / 200 * 2 * Math.PI), y: 100 * Math.sin(i / 200 * 2 * Math.PI) }));
    const s = simplifyClosed(circle, 0.3);
    expect(s.length).toBeLessThan(80); expect(s.length).toBeGreaterThan(20);
    expect(simplifyClosed([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], 0.3).length).toBe(4);
  });
});

describe('marker export', () => {
  it('writes DXF and HPGL with every placed part', () => {
    const d = style(), I = ids(d);
    const parts = markerParts(d, { [I.M]: 1 });
    const pl = Object.fromEntries(parts.map((p, i) => [p.id, placeAt(p, i * 700, 0, 0)]));
    const dxf = markerDXF(parts, pl, 1500, 'M1');
    expect((dxf.match(/\nPOLYLINE\n8\nCUT/g) ?? []).length).toBe(parts.length);
    expect(dxf).toContain('BODY M'); expect(dxf.trim().endsWith('EOF')).toBe(true);
    const plt = markerHPGL(parts, pl);
    expect((plt.split('SP2;')[0].match(/^PD/gm) ?? []).length).toBe(parts.length); // pen 1 cuts one outline per part
  });
});

describe('marker direction rules', () => {
  const d = style(), I = ids(d);
  d.transact('2way', s => { for (const p of s.pieces) p.order.rotation = '2way'; });
  const parts = markerParts(d, { [I.S]: 2, [I.M]: 1 });
  const dirOf = (ps: typeof parts, f: (p: typeof parts[0]) => boolean) => [...new Set(ps.filter(f).map(p => p.angles.join()))].join('/');
  it('all bundles one direction: every part faces 0°, nothing may turn', () => {
    const a = directedParts(parts, 'all', true);
    expect(dirOf(a, () => true)).toBe('0');
    expect(groupMayTurn(parts, '*', 'all', true)).toBe(false);
  });
  it('one bundle one direction: a bundle is one direction; bundles alternate only with the 180° switch on', () => {
    const on = directedParts(parts, 'bundle', true), off = directedParts(parts, 'bundle', false);
    for (const g of new Set(parts.map(p => directionGroup(p, 'bundle')))) expect(dirOf(on, p => directionGroup(p, 'bundle') === g)).toMatch(/^(0|180)$/);
    expect(new Set(on.map(p => p.angles[0])).size).toBe(2);
    expect(dirOf(off, () => true)).toBe('0');
    expect(groupMayTurn(parts, directionGroup(parts[0], 'bundle'), 'bundle', true)).toBe(true);
    expect(groupMayTurn(parts, directionGroup(parts[0], 'bundle'), 'bundle', false)).toBe(false);
  });
  it('same size same direction: both bundles of S face the same way', () => {
    const a = directedParts(parts, 'size', true);
    expect(dirOf(a, p => p.sizeId === I.S)).toMatch(/^(0|180)$/);
    expect(dirOf(a, p => p.sizeId === I.M)).toMatch(/^(0|180)$/);
  });
  it('a bundle with a one-way piece does not turn', () => {
    const d2 = style(), J = ids(d2); // SLEEVE is 1-way in style()
    const ps = markerParts(d2, { [J.M]: 2 });
    expect(directedParts(ps, 'bundle', true).every(p => p.angles[0] === 0)).toBe(true);
  });
  it('placements that break the rule are taken off', () => {
    const two = parts.filter(p => p.name === 'BODY' && p.sizeId === I.M);
    const pl = { [two[0].id]: placeAt(two[0], 0, 0, 0), [two[1].id]: placeAt(two[1], 700, 0, 180) };
    expect(obeyDirection(parts, pl, 'bundle', true).removed).toBe(1);
    expect(obeyDirection(parts, pl, 'piece', true).removed).toBe(0);
    const all = obeyDirection(parts, { [two[1].id]: pl[two[1].id] }, 'all', true);
    expect(all.removed).toBe(1);
  });
});

describe('throwing a part', () => {
  const d = style(), I = ids(d);
  const [a, b] = markerParts(d, { [I.M]: 1 }).filter(p => p.name === 'BODY'); // 620 × 420 each
  it('travels until it touches the other part, or the fabric edge', () => {
    const pl = { [a.id]: placeAt(a, 0, 0, 0), [b.id]: placeAt(b, 1500, 300, 0) };
    const left = throwParts([a, b], pl, 1000, [b.id], { x: -1, y: 0 })!;
    expect(polyBox(placedPoly(b, left[b.id])).x0).toBeCloseTo(620, 0);     // a (0…420 high) is in its way: it stops against it
    const up = throwParts([a, b], { ...pl, [b.id]: placeAt(b, 1500, 500, 0) }, 1000, [b.id], { x: 0, y: -1 })!;
    expect(polyBox(placedPoly(b, up[b.id])).y0).toBeCloseTo(0, 0);
  });
  it('stops against a part in its way and keeps the gap', () => {
    const pl = { [a.id]: placeAt(a, 0, 0, 0), [b.id]: placeAt(b, 1500, 0, 0) };
    const r = throwParts([a, b], pl, 1000, [b.id], { x: -1, y: 0 })!;
    expect(polyBox(placedPoly(b, r[b.id])).x0).toBeCloseTo(620, 0);
    const g = throwParts([a, b], pl, 1000, [b.id], { x: -1, y: 0 }, { gap: 10 })!;
    expect(polyBox(placedPoly(b, g[b.id])).x0).toBeGreaterThan(628);
    expect(polyBox(placedPoly(b, g[b.id])).x0).toBeLessThan(632);
    expect(markerProblems([a, b], { ...pl, ...r }, 1000).size).toBe(0);
  });
  it('a part that starts on top of another travels until it is free, then on to the next stop', () => {
    const pl = { [a.id]: placeAt(a, 0, 0, 0), [b.id]: placeAt(b, 100, 100, 0) };
    const r = throwParts([a, b], pl, 1000, [b.id], { x: 0, y: 1 })!;
    expect(polyBox(placedPoly(b, r[b.id])).y1).toBeCloseTo(1000, 0);
    expect(markerProblems([a, b], { ...pl, ...r }, 1000).size).toBe(0);
  });
  it('thrown along the fabric it stops at the end of the marker', () => {
    const pl = { [a.id]: placeAt(a, 0, 0, 0), [b.id]: placeAt(b, 0, 500, 0) };
    const r = throwParts([a, b], pl, 1000, [b.id], { x: 1, y: 0 })!;
    expect(polyBox(placedPoly(b, r[b.id])).x0).toBeLessThanOrEqual(621);
  });
});

describe('block fuse', () => {
  it('lays the piece as its box grown by the margin and keeps the outline inside', () => {
    const d = style(), I = ids(d);
    const slv = d.style.pieces.find(p => p.name === 'SLEEVE')!;
    const plain = markerParts(d, { [I.M]: 1 }).find(p => p.name === 'SLEEVE')!;
    const blk = markerParts(d, { [I.M]: 1 }, { block: { [slv.id]: 10 } }).find(p => p.name === 'SLEEVE')!;
    const b0 = polyBox(plain.poly), b1 = polyBox(blk.poly);
    expect(blk.poly.length).toBe(4);
    expect(b1.x1).toBeCloseTo(b0.x1 + 20, 6); expect(b1.y1).toBeCloseTo(b0.y1 + 20, 6);
    expect(polyBox(blk.inner!).x0).toBeCloseTo(10, 6); expect(blk.inner!.length).toBe(plain.poly.length);
    expect(blk.area).toBeGreaterThan(plain.area);
    expect(markerParts(d, { [I.M]: 1 }, { block: { [slv.id]: 10 } }).find(p => p.name === 'BODY')!.inner).toBeUndefined();
    const dxf = markerDXF([blk], { [blk.id]: placeAt(blk, 0, 0, 0) }, 1000);
    expect(dxf).toContain('BLOCK'); expect((dxf.match(/\nPOLYLINE\n8\nCUT/g) ?? []).length).toBe(1);
  });
});

describe('parts lying exactly on top of each other', () => {
  const d = style(), I = ids(d);
  const [a, b] = markerParts(d, { [I.M]: 1 }).filter(p => p.name === 'BODY');
  it('are found as a problem', () => {
    const pl = { [a.id]: placeAt(a, 0, 0, 0), [b.id]: placeAt(b, 0, 0, 0) };
    expect(markerProblems([a, b], pl, 1000).size).toBe(2);
  });
  it('a part thrown from on top of another comes free, even towards the end of the marker', () => {
    const pl = { [a.id]: placeAt(a, 0, 0, 0), [b.id]: placeAt(b, 0, 0, 0) };
    const r = throwParts([a, b], pl, 1000, [b.id], { x: 1, y: 0.3 })!;
    expect(r).not.toBeNull();
    expect(markerProblems([a, b], { ...pl, ...r }, 1000).size).toBe(0);
  });
});

describe('a cut plan per material', () => {
  it('switching the material keeps each plan apart and brings it back', () => {
    const d: MarkerDoc = { order: { M: 10 }, maxPlies: 50, maxBundles: 6, width: 1500, gap: 0, material: 'SELF', nestSeconds: 30, rows: [{ id: 'a', name: 'Marker 1', ratio: { M: 2 }, plies: 5, placements: {}, width: 1500 }] };
    switchMarkerMaterial(d, 'LINING');
    expect(d.material).toBe('LINING'); expect(d.rows).toEqual([]); expect(d.maxPlies).toBe(50); expect(d.order).toEqual({ M: 10 });
    d.rows.push({ id: 'b', name: 'Marker 1', ratio: { M: 1 }, plies: 10, placements: {}, width: 1400 }); d.maxPlies = 80;
    switchMarkerMaterial(d, 'SELF');
    expect(d.rows.map(r => r.id)).toEqual(['a']); expect(d.maxPlies).toBe(50);
    expect(d.others!.LINING.rows[0].width).toBe(1400);
    switchMarkerMaterial(d, 'LINING');
    expect(d.rows.map(r => r.id)).toEqual(['b']); expect(d.maxPlies).toBe(80); expect(d.others!.LINING).toBeUndefined();
  });
});

describe('annotation, buffer and plot', () => {
  const d = style(), I = ids(d);
  d.transact('desc', st => { st.pieces[0].description = 'Front body'; });
  const body = d.style.pieces[0];
  it('a part looks as on the pattern sheet (y turned for the view from above) and carries its sew line and code', () => {
    const p = markerParts(d, { [I.M]: 2 }).find(q => q.name === 'BODY' && q.bundle === 2)!;
    expect(p.code).toBe('M-2'); expect(p.desc).toBe('Front body');
    expect(p.sew!.length).toBe(4);
    const sb = polyBox(p.sew!); expect(sb.x0).toBeCloseTo(10, 6); expect(sb.y0).toBeCloseTo(10, 6); // seam 10 inside the cut line
  });
  it('labels follow the settings', () => {
    const p = markerParts(d, { [I.M]: 1 }).find(q => q.name === 'BODY')!;
    expect(partLabel(p, DEFAULT_ANNOT, 'ST-1')).toEqual(['BODY M M-1']);
    expect(partLabel(p, { ...DEFAULT_ANNOT, style: true, desc: true, bundle: false }, 'ST-1')).toEqual(['ST-1 BODY M', 'Front body']);
    expect(partLabel(p, { ...DEFAULT_ANNOT, piece: false, size: false, bundle: false })).toEqual([]);
  });
  it('buffer keeps a margin around the part; only the real outline is cut', () => {
    const plain = markerParts(d, { [I.M]: 1 }).find(q => q.name === 'BODY')!;
    const buf = markerParts(d, { [I.M]: 1 }, { buffer: { [body.id]: 5 } }).find(q => q.name === 'BODY')!;
    expect(buf.hold).toBe('buffer');
    expect(polyBox(buf.poly).x1).toBeCloseTo(polyBox(plain.poly).x1 + 10, 4);
    expect(polyBox(cutOutline(buf)).x1 - polyBox(cutOutline(buf)).x0).toBeCloseTo(620, 4);
    const pl = { [buf.id]: placeAt(buf, 0, 0, 0) };
    expect(markerPerimeter([buf], pl)).toBeCloseTo(2 * (620 + 420), 3);
    const dxf = markerDXF([buf], pl, 1000);
    expect((dxf.match(/\nPOLYLINE\n8\nCUT/g) ?? []).length).toBe(1); expect(dxf).not.toContain('BLOCK');
  });
  it('the plot cuts with pen 1 and draws seam, grain, text and the border facts with pen 2, as set', () => {
    const parts = markerParts(d, { [I.M]: 1 }).filter(q => q.name === 'BODY');
    const pl = Object.fromEntries(parts.map((p, i) => [p.id, placeAt(p, i * 620, 0, 0)]));
    const full = markerHPGL(parts, pl, 1000, { annot: { seam: true }, name: 'Marker 1', ratio: 'M 1', styleName: 'ST-1' });
    const [cut, draw] = full.split('SP2;');
    expect((cut.match(/^PD/gm) ?? []).length).toBe(2);
    expect(draw).toContain('LBBODY M M-1'); expect(draw).toContain('Marker 1'); expect(draw).toContain('EFF'); expect(draw).toContain('PERIM');
    expect((draw.match(/^PD/gm) ?? []).length).toBe(2 + 2 + 1); // seam + grain per part, and the border
    const bare = markerHPGL(parts, pl, 1000, { annot: { piece: false, size: false, bundle: false, grain: false, border: false, internals: 'none' } });
    expect(bare).not.toContain('SP2;'); expect(bare).not.toContain('LB');
    expect(borderText(parts, pl, 1000, { ...DEFAULT_ANNOT, bPerim: false, bEff: false }, { name: 'M1', ratio: 'M 1' })).toBe('M1   M 1   L 1240 mm   W 1000 mm');
  });
});
