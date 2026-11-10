/**
 * Binding generator (A6). Builds a strip piece whose length equals the total length of a chain of
 * contour spans (per size), copying every notch on the chain to the strip at the same running
 * distance and adding a support notch at each break between chained spans.
 *
 * Strip geometry (base size, y-up, CCW):
 *   P0 (0,0) → P1 (L,0) → P2 (L+o, W) → P3 (o, W),  o = W / tan(biasAngleDeg)
 * The bottom edge P0→P1 is the binding's stitching edge and carries the notches; at 90° the strip is a
 * plain rectangle. P1/P2 are graded by the per-size length difference, so every size has its own length.
 * Ends are cut parallel to the grain line, which is placed at biasAngleDeg to the strip length.
 */
import type { Id, Notch, Piece, SizeId, Contour } from '../model/types';
import type { Document } from '../model/doc';
import { absoluteToIncremental } from '../model/contour';
import { gradePoint, makeContour, makePiece, makeAnchor } from '../model/factory';
import { notchesOnSpan, segmentLength, livePiece, makeNotch } from './notches';

export interface BindingChainItem { pieceId: Id; contourId: Id; fromAnchorId: Id; toAnchorId: Id }

export interface BindingOptions {
  chain: BindingChainItem[];
  /** finished cut width of one layer (mm); doubled when halfFold */
  width: number;
  /** end-cut / grain angle relative to the strip length (degrees, default 45; 90 = square ends) */
  biasAngleDeg?: number;
  /** fabric shrinkage compensation (%): length and width are multiplied by (1 + shrinkPct/100) */
  shrinkPct?: number;
  /** length-only scale (%), e.g. 95 to cut binding 5 % short for stretch; default 100 */
  scalePct?: number;
  copyNotches?: boolean;
  halfFold?: boolean;
  supportNotchAtBreaks?: boolean;
  name?: string;
}

export interface BindingResult {
  piece: Piece;
  /** strip length (bottom edge) per size, after shrink/scale */
  lengthBySize: Record<SizeId, number>;
  /** raw chain length per size (before shrink/scale) */
  chainLengthBySize: Record<SizeId, number>;
  /** strip width (total, after halfFold doubling and shrink) */
  stripWidth: number;
  /** running chain distances (base size, raw) of the breaks between chained spans */
  breaks: number[];
}

export function generateBinding(doc: Document, o: BindingOptions): BindingResult {
  if (!o.chain.length) throw new Error('Binding chain is empty');
  if (!(o.width > 0)) throw new Error('Binding width must be positive');
  const bias = o.biasAngleDeg ?? 45;
  if (!(bias > 0 && bias <= 90)) throw new Error('biasAngleDeg must be in (0, 90]');
  const shrinkF = 1 + (o.shrinkPct ?? 0) / 100;
  const lenF = shrinkF * ((o.scalePct ?? 100) / 100);
  const copy = o.copyNotches ?? true;
  const support = o.supportNotchAtBreaks ?? true;
  const halfFold = o.halfFold ?? false;

  const first = livePiece(doc, o.chain[0].pieceId);
  const line = doc.sizeLine(first);
  const sizes = line.sizes.map(s => s.id);
  const base = line.baseSizeId;

  // ── per-size chain lengths, break positions and notch running distances ──
  const chainLen: Record<SizeId, number> = {};
  const breaksBy: Record<SizeId, number[]> = {};
  const notchDist = new Map<string, { src: Notch; d: Record<SizeId, number> }>();
  for (const sid of sizes) {
    let run = 0;
    breaksBy[sid] = [];
    o.chain.forEach((it, k) => {
      const p = livePiece(doc, it.pieceId);
      if (k > 0) breaksBy[sid].push(run);
      if (copy) {
        for (const n of notchesOnSpan(doc, p, it.contourId, it.fromAnchorId, it.toAnchorId, sid)) {
          const key = `${it.pieceId}|${n.notch.id}|${k}`;
          // skip a notch already copied from the previous chain item at the shared break
          const dupKey = `${it.pieceId}|${n.notch.id}|${k - 1}`;
          const prev = notchDist.get(dupKey);
          if (prev && n.dist < 1e-6 && Math.abs((prev.d[sid] ?? -1) - run) < 1e-6) continue;
          if (!notchDist.has(key)) notchDist.set(key, { src: n.notch, d: {} });
          notchDist.get(key)!.d[sid] = run + n.dist;
        }
      }
      run += segmentLength(doc, p, it.contourId, it.fromAnchorId, it.toAnchorId, sid);
    });
    chainLen[sid] = run;
  }

  const lengthBySize: Record<SizeId, number> = {};
  for (const sid of sizes) lengthBySize[sid] = chainLen[sid] * lenF;
  const Lb = lengthBySize[base];
  const W = o.width * (halfFold ? 2 : 1) * shrinkF;
  const off = bias >= 90 ? 0 : W / Math.tan((bias * Math.PI) / 180);

  // ── strip contour, graded by length difference ──
  const absG: Record<SizeId, { dx: number; dy: number }> = {};
  for (const sid of sizes) absG[sid] = { dx: lengthBySize[sid] - Lb, dy: 0 };
  const inc = absoluteToIncremental(absG, line);
  const P0 = gradePoint(0, 0, { flags: { startPoint: true } });
  const P1 = gradePoint(Lb, 0, { grade: JSON.parse(JSON.stringify(inc)) });
  const P2 = gradePoint(Lb + off, W, { grade: JSON.parse(JSON.stringify(inc)) });
  const P3 = gradePoint(off, W);
  const sew = makeContour([P0, P1, P2, P3]);
  const name = o.name ?? 'BINDING';
  const piece = makePiece(name, sew, first.sizeTableId, {
    noSeam: true, seamDefault: 0, description: `Binding ${o.width} mm${halfFold ? ' half-fold' : ''}, ${bias}°`,
  });
  if (first.sizes) piece.sizes = first.sizes.slice();
  // grain at the bias angle through the strip centre (centre moves by half the length difference)
  {
    const r = (bias * Math.PI) / 180, c = { x: (Lb + off) / 2, y: W / 2 }, h = Math.min(W, 50) / 2 / Math.max(Math.sin(r), 1e-9);
    const half: Record<SizeId, { dx: number; dy: number }> = {};
    for (const sid of sizes) half[sid] = { dx: absG[sid].dx / 2, dy: 0 };
    const gi = absoluteToIncremental(half, line);
    piece.grain = {
      a: { x: c.x - Math.cos(r) * h, y: c.y - Math.sin(r) * h }, b: { x: c.x + Math.cos(r) * h, y: c.y + Math.sin(r) * h },
      gradeA: JSON.parse(JSON.stringify(gi)), gradeB: JSON.parse(JSON.stringify(gi)), centered: true,
    };
  }
  if (halfFold) {
    const fold: Contour = makeContour([
      makeAnchor(off / 2, W / 2), makeAnchor(Lb + off / 2, W / 2, { grade: JSON.parse(JSON.stringify(inc)) }),
    ], { type: 'fold', closed: false, style: 'dashed', mode: 'draw', name: 'FOLD' });
    piece.internals.push(fold);
  }

  // ── notches ──
  const addEdgeNotches = (d: Record<SizeId, number>, tmpl: Partial<Notch>, tag: string) => {
    const scaled: Record<SizeId, number> = {};
    for (const sid of sizes) scaled[sid] = (d[sid] ?? d[base]) * lenF;
    if (scaled[base] <= 1e-6 || scaled[base] >= Lb - 1e-6) return; // strip ends are already marked by the end cuts
    const mk = (placement: Notch['placement']) => {
      const n = makeNotch(doc, piece, { placement, type: tmpl.type ?? 'slit', depth: tmpl.depth, width: tmpl.width, mode: tmpl.mode, tag });
      piece.notches.push(n);
    };
    mk({ kind: 'fromPrev', anchorId: P0.id, dist: scaled });
    if (halfFold) {
      // mirrored notch on the opposite raw edge: reflection across the fold puts it at the same x.
      // Top edge runs P2 → P3 with P3 at x = off, so measure back from P3 by (d − off).
      const top: Record<SizeId, number> = {};
      for (const sid of sizes) top[sid] = scaled[sid] - off;
      if (top[base] >= -1e-9 && top[base] <= Lb + 1e-9) mk({ kind: 'fromNext', anchorId: P3.id, dist: top });
    }
  };
  for (const { src, d } of notchDist.values()) addEdgeNotches(d, src, 'binding-copy');
  if (support) {
    const setup = doc.style.settings.notchSetup.slit;
    o.chain.slice(1).forEach((_, k) => {
      const d: Record<SizeId, number> = {};
      for (const sid of sizes) d[sid] = breaksBy[sid][k];
      // skip if a copied notch already sits exactly at the break (base size)
      const dup = [...notchDist.values()].some(v => Math.abs((v.d[base] ?? NaN) - d[base]) < 1e-6);
      if (!dup) addEdgeNotches(d, { type: 'slit', depth: setup.depth, width: setup.width }, 'binding-break');
    });
  }

  doc.transact('Generate binding', s => { s.pieces.push(piece); });
  return { piece: doc.piece(piece.id), lengthBySize, chainLengthBySize: chainLen, stripWidth: W, breaks: breaksBy[base] };
}
