import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, rectangleContour, makeContour, gradePoint } from '../src/model/factory';
import { switchMarkerMaterial, markerPerimeter, partLabel, borderText, borderLines, borderLayout, annotLength, cutOutline, DEFAULT_ANNOT, blockOutline, blockPart, blockBins, contourAround, blockRoom, facing, type MarkerDoc, type MarkerBlock } from '../src/marker/marker';
import { pointInPolygon, distToPolygon, signedArea } from '../src/geom/poly';
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

describe('fuse blocks and piece details', () => {
  const sparrow = () => {
    const glue = readFileSync(new URL('../../../apps/web/src/marker/sparrow-glue.txt', import.meta.url), 'utf8');
    const wasm = Buffer.from(readFileSync(new URL('../../../apps/web/src/marker/sparrow-wasm.b64.txt', import.meta.url), 'utf8').trim(), 'base64');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const wb = new Function(glue + '; return wasm_bindgen;')(); wb.initSync({ module: wasm });
    return (job: ReturnType<typeof nestJob>, sec = 2) => nestResult(wb.nest(job.json, sec, BigInt(11), 1, job.gap, JSON.stringify({ noimp: 100, strikes: 2, csamp: 100, fsamp: 50 }), '', () => {}), job);
  };
  it('a block is made of the chosen laid parts only: their box grown by the margin, or their contour', () => {
    const d = style(), I = ids(d);
    const parts = markerParts(d, { [I.M]: 2 }), sl = parts.filter(p => p.name === 'SLEEVE');
    const pl = { [sl[0].id]: placeAt(sl[0], 100, 100, 0), [sl[1].id]: placeAt(sl[1], 100, 410, 0), [sl[2].id]: placeAt(sl[2], 900, 100, 0) };
    const rect: MarkerBlock = { ids: [sl[0].id, sl[1].id], shape: 'rect', buffer: 10 };
    const bo = polyBox(blockOutline(parts, pl, rect)!);
    expect([bo.x0, bo.y0, bo.x1, bo.y1].map(v => Math.round(v))).toEqual([90, 90, 310, 720]); // a sleeve lies 200 long and 300 wide
    const co = blockOutline(parts, pl, { ...rect, shape: 'contour' })!, cb = polyBox(co);
    // the contour keeps at least the margin everywhere, stays close to it, and is smaller than the box (a sleeve is a trapezium)
    for (const id of rect.ids) for (const q of placedPoly(parts.find(p => p.id === id)!, pl[id])) { expect(pointInPolygon(q, co)).toBe(true); expect(distToPolygon(q, co)).toBeGreaterThan(9); }
    expect(cb.x0).toBeGreaterThan(84); expect(cb.x1).toBeLessThan(316);
    expect(Math.abs(signedArea(co))).toBeLessThan(220 * 630 * 0.93);
    // moving the block moves its contour with it
    const moved = Object.fromEntries(Object.entries(pl).map(([k, v]) => [k, { ...v, x: v.x + 50 }]));
    expect(polyBox(blockOutline(parts, moved, { ...rect, shape: 'contour' })!).x0).toBeCloseTo(cb.x0 + 50, 6);
    // the third sleeve is not in the block; the block counts for the marker length and the cut length
    expect(markerStats(parts, pl, 1000, [rect]).length).toBeCloseTo(1100, 4);
    expect(markerStats(parts, { [sl[0].id]: pl[sl[0].id] }, 1000, [rect]).length).toBeCloseTo(310, 4);
    expect(markerPerimeter(parts, pl, [rect]) - markerPerimeter(parts, pl)).toBeCloseTo(2 * (220 + 630), 3);
    const dxf = markerDXF(parts, pl, 1000, 'M', { blocks: [rect] });
    expect((dxf.match(/\nPOLYLINE\n8\nBLOCK/g) ?? []).length).toBe(1); expect((dxf.match(/\nPOLYLINE\n8\nCUT/g) ?? []).length).toBe(3);
    expect(markerHPGL(parts, pl, 1000, { blocks: [rect] }).split('SP2;')[0].match(/^PD/gm)!.length).toBe(4);
  });
  it('a contour without buffer (married parts laid as one shape) never cuts into a part and stays close', () => {
    const d = style(), I = ids(d), ps = markerParts(d, { [I.M]: 1 });
    const pl = { [ps[0].id]: placeAt(ps[0], 0, 0, 0), [ps[2].id]: { ...placeAt(ps[2], 620, 30, 0), rot: 1 }, [ps[3].id]: placeAt(ps[3], 640, 400, 0) };
    const mem = ps.filter(p => pl[p.id]), co = contourAround(mem.map(p => placedPoly(p, pl[p.id])), 0);
    for (const p of mem) for (const q of placedPoly(p, pl[p.id])) { expect(pointInPolygon(q, co)).toBe(true); expect(distToPolygon(q, co)).toBeLessThan(45); }
    expect(Math.abs(signedArea(co))).toBeLessThan(0.9 * 840 * 700); // it follows the parts: well under their common box
  });
  it('parts far apart get their common hull as contour', () => {
    const d = style(), I = ids(d), sl = markerParts(d, { [I.M]: 1 }).filter(p => p.name === 'SLEEVE');
    const pl = { [sl[0].id]: placeAt(sl[0], 0, 0, 0), [sl[1].id]: placeAt(sl[1], 600, 0, 0) };
    const co = blockOutline(sl, pl, { ids: sl.map(p => p.id), shape: 'contour', buffer: 5 })!;
    for (const p of sl) for (const q of placedPoly(p, pl[p.id])) expect(pointInPolygon(q, co)).toBe(true);
  });
  it('another part may not lie inside a block, and stops at its edge when thrown; the block is thrown as one', () => {
    const d = style(), I = ids(d);
    const parts = markerParts(d, { [I.M]: 1 }), sl = parts.filter(p => p.name === 'SLEEVE'), body = parts.find(p => p.name === 'BODY')!;
    const blk: MarkerBlock = { ids: sl.map(p => p.id), shape: 'rect', buffer: 20 };
    const pl = { [sl[0].id]: placeAt(sl[0], 20, 20, 0), [sl[1].id]: placeAt(sl[1], 20, 340, 0), [body.id]: placeAt(body, 225, 0, 0) };
    expect(markerProblems(parts, pl, 1000).size).toBe(0);                       // the outlines themselves do not touch
    expect(markerProblems(parts, pl, 1000, 0.6, [blk]).size).toBe(3);           // but the body is inside the block's margin
    const far = { ...pl, [body.id]: placeAt(body, 1500, 0, 0) };
    const r = throwParts(parts, far, 1000, [body.id], { x: -1, y: 0 }, { blocks: [blk] })!;
    expect(polyBox(placedPoly(body, r[body.id])).x0).toBeCloseTo(240, 0);       // 20 + 200 + 20
    const t = throwParts(parts, { ...pl, [body.id]: placeAt(body, 0, 500, 0), [sl[0].id]: placeAt(sl[0], 1020, 20, 0), [sl[1].id]: placeAt(sl[1], 1020, 340, 0) }, 1000, [sl[0].id], { x: -1, y: 0 }, { blocks: [blk] })!;
    expect(Object.keys(t).sort()).toEqual(sl.map(p => p.id).sort());            // both sleeves moved, by the same way
    expect(polyBox(placedPoly(sl[0], t[sl[0].id])).x0).toBeCloseTo(640, 0);      // the block's edge stops at the body (620); the sleeve is its margin further
    expect(t[sl[1].id].x - t[sl[0].id].x).toBeCloseTo(0, 6);
  });
  it('piece details: rotation and tilt of one piece, major and block marks', () => {
    const d = style(), I = ids(d), body = d.style.pieces[0], slv = d.style.pieces[1];
    const parts = markerParts(d, { [I.M]: 1 }, { detail: { [body.id]: { rotation: '1way', tilt: 2, major: true }, [slv.id]: { block: true } } });
    const b = parts.find(p => p.name === 'BODY')!, s = parts.find(p => p.name === 'SLEEVE')!;
    expect(b.angles).toEqual([0]); expect(b.tilt).toBe(2); expect(b.major).toBe(true); expect(s.fuse).toBe(true); expect(b.fuse).toBeUndefined();
    const job = JSON.parse(nestJob(parts, 1000).json);
    expect(job.items[0].orientation.rotation.angles).toEqual([0, 1, 359, 2, 358]);
    expect(job.items[1].orientation.rotation.angles).toEqual([0]);
    // a tilted part still faces its way for the direction rule
    expect(facing(358.5)).toBe(0); expect(facing(181)).toBe(180);
    const pl = Object.fromEntries(parts.map((p, i) => [p.id, { ...placeAt(p, i * 700, 0, 0), rot: p.tilt ? 1.5 : 0 }]));
    expect(obeyDirection(parts, pl, 'all', true).removed).toBe(0);
    // old files: a piece that was laid as a block reads as "goes into fuse blocks"
    expect(markerParts(d, { [I.M]: 1 }, { block: { [slv.id]: 10 } }).find(p => p.name === 'SLEEVE')!.fuse).toBe(true);
  });
  it('the nester may tilt a part within its limit (real engine)', () => {
    const d = style(), I = ids(d), body = d.style.pieces[0];
    const parts = markerParts(d, { [I.M]: 1 }, { detail: { [body.id]: { tilt: 3 } } });
    const res = sparrow()(nestJob(parts, 1000));
    expect(Object.keys(res.placements).length).toBe(parts.length);
    expect(markerProblems(parts, res.placements, 1000, 1).size).toBe(0);
    for (const p of parts.filter(q => q.name === 'BODY')) { const r = res.placements[p.id].rot, off = Math.min(Math.abs(r - facing(r)), 360 - Math.abs(r - facing(r))); expect(off).toBeLessThanOrEqual(3.001); }
  });
  it('blocks are filled within their limits: too much for one block gives two or more, and the blocks nest with the rest (real engine)', () => {
    const d = style(), I = ids(d), slv = d.style.pieces[1], nest = sparrow();
    const parts = markerParts(d, { [I.M]: 2 }, { detail: { [slv.id]: { block: true } } });
    const fuse = parts.filter(p => p.fuse), rest = parts.filter(p => !p.fuse);
    expect(fuse.length).toBe(4);
    const set = { maxLength: 700, maxWidth: 480, buffer: 10, shape: 'rect' as const };
    const room = blockRoom(set, 1000, fuse);
    expect(room.length).toBeCloseTo(677, 6); expect(room.width).toBeCloseTo(457, 6); expect(room.tooBig).toBeUndefined();
    expect(blockRoom({ ...set, maxLength: 200 }, 1000, fuse).tooBig).toBeDefined();
    // 4 sleeves of 200 × 300 do not go into 677 × 457 as one block
    let k = room.least, bins: ReturnType<typeof blockBins> = [], laid: ReturnType<typeof nest>[] = [];
    for (; k <= fuse.length; k++) { bins = blockBins(fuse, k); laid = bins.map(b => nest(nestJob(b, room.width), 1)); if (laid.every(r => r.length <= room.length + 0.5)) break; }
    expect(bins.length).toBeGreaterThanOrEqual(2);
    const stand = bins.map((b, i) => blockPart('#blk' + i, b, laid[i].placements, { ids: b.map(p => p.id), shape: set.shape, buffer: set.buffer })!);
    for (const s of stand) { const bb = polyBox(s.part.poly); expect(bb.x1).toBeLessThanOrEqual(set.maxLength); expect(bb.y1).toBeLessThanOrEqual(set.maxWidth); expect(bb.x0).toBeCloseTo(0, 6); }
    const res = nest(nestJob([...rest, ...stand.map(s => s.part)], 1000), 2);
    const pl: Record<string, { x: number; y: number; rot: number }> = {};
    for (const p of rest) pl[p.id] = res.placements[p.id];
    for (const s of stand) { const at = res.placements[s.part.id]; expect(at.rot).toBe(0); for (const id of s.ids) pl[id] = { x: s.local[id].x + at.x, y: s.local[id].y + at.y, rot: s.local[id].rot }; }
    const blocks: MarkerBlock[] = stand.map(s => ({ ids: s.ids, shape: set.shape, buffer: set.buffer, auto: true }));
    expect(Object.keys(pl).length).toBe(parts.length);
    expect(markerProblems(parts, pl, 1000, 1, blocks).size).toBe(0);
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
  it('the text is written as it is typed: lines break where they are typed, lengths in the chosen unit, the marker text where it is put', () => {
    const parts = markerParts(d, { [I.M]: 1 }).filter(q => q.name === 'BODY');
    const pl = Object.fromEntries(parts.map((p, i) => [p.id, placeAt(p, i * 620, 0, 0)]));
    const a = { ...DEFAULT_ANNOT, partText: '{style} / {piece}\n{size}   bundle {no}\n{desc}\n{material}', markerText: '{name} ({ratio})\nLength {length} · Width {width}\n{eff} · {perim} · {plies} plies · {parts}', unit: 'cm' as const };
    expect(partLabel(parts[0], a, 'ST-1')).toEqual(['ST-1 / BODY', 'M   bundle 1', 'Front body', 'SELF']);
    expect(partLabel(markerParts(d, { [I.M]: 1 }).find(q => q.name === 'SLEEVE' && !q.mirror)!, { ...a, partText: '{desc}\n{piece} {size}' })).toEqual(['SLEEVE M']); // a line with nothing on it is left out
    expect(borderLines(parts, pl, 1000, a, { name: 'M1', ratio: 'M 1', plies: 20 })).toEqual(['M1 (M 1)', 'Length 124.0 cm · Width 100.0 cm', '42.00% · 4.16 m · 20 plies · 2/2']);
    expect(annotLength(914.4, 'yd')).toBe('1.000 yd'); expect(annotLength(254, 'in')).toBe('10.00 in'); expect(annotLength(1500, 'm')).toBe('1.500 m');
    expect(borderLines(parts, pl, 1000, { ...a, unit: 'in', markerText: '{length} {perim}' })).toEqual(['48.82 in 4.55 yd']);
    // where the marker text goes
    const top = borderLayout(a, 3, 1240, 1000), bottom = borderLayout({ ...a, place: 'bottom' }, 3, 1240, 1000), end = borderLayout({ ...a, place: 'end' }, 3, 1240, 1000), start = borderLayout({ ...a, place: 'start' }, 3, 1240, 1000);
    expect(top.up).toBe(false); expect(top.at.every(v => v.y < 0)).toBe(true); expect(top.at[0].y).toBeLessThan(top.at[2].y);
    expect(bottom.at.every(v => v.y > 1000)).toBe(true); expect(end.up).toBe(true); expect(end.at.every(v => v.x > 1240)).toBe(true); expect(start.at.every(v => v.x < 0)).toBe(true);
    // DXF: text turned 90° after the end; plot: text before the start moves the plot along so that nothing is negative
    const dxf = markerDXF(parts, pl, 1000, 'M1', { annot: { ...a, place: 'end' }, ratio: 'M 1' });
    expect(dxf).toContain('M1 (M 1)\n50\n90');
    const plt = markerHPGL(parts, pl, 1000, { annot: { ...a, place: 'start' }, name: 'M1', ratio: 'M 1' });
    expect(plt).toContain('DI0,1;'); expect(plt).not.toMatch(/P[UD]-|,-/);
    expect(markerHPGL(parts, pl, 1000, { annot: { ...a, place: 'bottom' }, name: 'M1' })).not.toMatch(/P[UD]-|,-/);
  });
});
