/**
 * Seam system (A2). Computes the CUT line from the SEW line.
 * This file is the kernel-level provider used by Document.resolvePiece(); the engineered-corner
 * gallery, manual seam angle, lock-grading stamping and seam⇄internal conversions extend it.
 */
import type { Vec } from '../geom/vec';
import { offsetOutward } from '../geom/poly';
import type { Piece, SizeLine, SizeId } from '../model/types';
import { resolveContour, type ResolvedContour } from '../model/contour';

/** Per-grade-segment seam allowances for a piece (segment k leaves gradeIdx[k]). */
export function segmentSeams(piece: Piece, r: ResolvedContour): number[] {
  const out: number[] = [];
  for (const gi of r.gradeIdx) {
    const a = piece.sew.points[gi];
    out.push(a.seamAfter ?? piece.seamDefault);
  }
  return out;
}

/** Expand per-grade-segment seam values to per-sample-edge distances. */
export function perEdgeDistances(piece: Piece, r: ResolvedContour): number[] {
  const seg = segmentSeams(piece, r);
  const N = r.pts.length;
  const d = new Array(N).fill(piece.seamDefault);
  const g = r.gradeIdx;
  for (let k = 0; k < g.length; k++) {
    const start = r.anchorIndex[g[k]];
    const end = r.closed ? r.anchorIndex[g[(k + 1) % g.length]] : r.anchorIndex[g[Math.min(k + 1, g.length - 1)]];
    let i = start;
    let guard = 0;
    while (guard++ <= N) { d[i] = seg[k]; i = (i + 1) % N; if (i === end) break; }
  }
  return d;
}

/** Basic cut-line computation: true geometric offset with per-segment allowances, miter joins. */
export function computeCutLine(piece: Piece, line: SizeLine, sizeId: SizeId): Vec[] {
  const r = resolveContour(piece.sew, line, sizeId);
  if (piece.noSeam) return r.pts.slice();
  const d = perEdgeDistances(piece, r);
  return offsetOutward(r.pts, d, 'miter');
}
