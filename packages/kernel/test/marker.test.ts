import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, rectangleContour, makeContour, gradePoint } from '../src/model/factory';
import { autoCutPlan, planTotals, markerParts, markerStats, markerProblems, placeAt, placedPoly, polyBox, nestJob, nestResult, markerDXF, markerHPGL, simplifyClosed } from '../src/marker/marker';

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
    expect((plt.match(/^PD/gm) ?? []).length).toBe(parts.length);
  });
});
