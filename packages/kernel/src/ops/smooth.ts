/**
 * Smooth (A5): propose a fair curve through a crooked run of a contour.
 *
 * Method: the run from → to (forward) is split at the kept anchors into sub-runs. Each sub-run's
 * sampled polyline (uniform arc-length resampling) is fitted by ONE least-squares cubic Bézier whose
 * end points are the kept anchors (hard constraints). At interior kept anchors the tangent direction
 * is shared (G1 — centripetal Catmull-Rom direction through the neighbouring kept points) and only the
 * handle lengths are solved; at the run's outer ends the tangent is kept when the anchor is smooth
 * (continuity with the contour outside the run), otherwise the handle is a free 2-D unknown.
 * Linear least squares with 5 closest-point reparameterisation passes.
 *
 * The preview contains the replacement anchors; `commit()` writes them in one transaction (notches
 * are re-placed by position).
 */
import type { Anchor, Id, SizeLine, Contour } from '../model/types';
import type { Document } from '../model/doc';
import { newId } from '../model/factory';
import { Vec, add, sub, mul, dot, dist, norm, len } from '../geom/vec';
import { bezierPoint } from '../geom/curve';
import {
  findAnchorIn, idx, between, resolveBase, arcS, spanLen, arcSlice, jsonClone, freeze, captureNotches, restoreNotches, maxDev,
} from '../geom/draft-geom';

export interface SmoothPreview {
  /** replacement anchors for the run, from `from` to `to` inclusive (base coords) */
  points: Anchor[];
  /** sampled polyline of the proposed curve (base) */
  polyline: Vec[];
  /** max distance between proposed curve and the original run (mm) */
  maxDeviation: number;
  commit(): void;
}

function resample(poly: Vec[], n: number): Vec[] {
  const cum = [0]; for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + dist(poly[i - 1], poly[i]));
  const L = cum[cum.length - 1];
  const out: Vec[] = [];
  let e = 0;
  for (let k = 0; k <= n; k++) {
    const s = (L * k) / n;
    while (e < cum.length - 2 && cum[e + 1] < s) e++;
    const l = cum[e + 1] - cum[e];
    const t = l < 1e-12 ? 0 : (s - cum[e]) / l;
    out.push({ x: poly[e].x + (poly[e + 1].x - poly[e].x) * t, y: poly[e].y + (poly[e + 1].y - poly[e].y) * t });
  }
  return out;
}

/** Small dense linear solve (Gaussian elimination with partial pivoting). */
function solve(A: number[][], x: number[]): number[] | null {
  const n = x.length; const M = A.map((r, i) => [...r, x[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * Least-squares inner control points for a cubic with fixed ends P0, P3 fitting samples Q.
 * t0 / t3 given ⇒ that handle is constrained to the direction (1 unknown: its length); null ⇒ free (2 unknowns).
 */
function fitHandles(Q: Vec[], P0: Vec, P3: Vec, t0: Vec | null, t3: Vec | null): [Vec, Vec] {
  const n = Q.length - 1;
  let u = Q.map((_, i) => i / n);
  const C = dist(P0, P3);
  let P1 = add(P0, mul(t0 ?? norm(sub(P3, P0)), C / 3)), P2 = sub(P3, mul(t3 ?? norm(sub(P3, P0)), C / 3));
  // unknown basis: each unknown contributes (B1 or B2) × direction
  const dirs: { which: 1 | 2; d: Vec }[] = [];
  if (t0) dirs.push({ which: 1, d: t0 }); else dirs.push({ which: 1, d: { x: 1, y: 0 } }, { which: 1, d: { x: 0, y: 1 } });
  if (t3) dirs.push({ which: 2, d: mul(t3, -1) }); else dirs.push({ which: 2, d: { x: 1, y: 0 } }, { which: 2, d: { x: 0, y: 1 } });
  for (let pass = 0; pass < 5; pass++) {
    const m = dirs.length;
    const N = Array.from({ length: m }, () => new Array(m).fill(0)), rhs = new Array(m).fill(0);
    for (let i = 0; i <= n; i++) {
      const t = u[i], s = 1 - t;
      const B = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
      // fixed part: endpoints, plus the anchor points of direction-constrained handles
      let base = add(mul(P0, B[0]), mul(P3, B[3]));
      if (t0) base = add(base, mul(P0, B[1]));
      if (t3) base = add(base, mul(P3, B[2]));
      const r = sub(Q[i], base);
      const cols = dirs.map(dd => mul(dd.d, dd.which === 1 ? B[1] : B[2]));
      for (let a = 0; a < m; a++) { rhs[a] += dot(cols[a], r); for (let b = 0; b < m; b++) N[a][b] += dot(cols[a], cols[b]); }
    }
    const x = solve(N, rhs);
    if (x) {
      let k = 0;
      if (t0) { const l = Math.max(1e-6, Math.min(x[k++], 2 * C)); P1 = add(P0, mul(t0, l)); } else { P1 = { x: x[k], y: x[k + 1] }; k += 2; }
      if (t3) { const l = Math.max(1e-6, Math.min(x[k++], 2 * C)); P2 = sub(P3, mul(t3, l)); } else { P2 = { x: x[k], y: x[k + 1] }; k += 2; }
    }
    const M = 96; const cs: Vec[] = []; for (let k = 0; k <= M; k++) cs.push(bezierPoint(P0, P1, P2, P3, k / M));
    u = Q.map((q, i) => { if (i === 0) return 0; if (i === n) return 1; let best = 0, bd = Infinity; for (let k = 0; k <= M; k++) { const d = dist(cs[k], q); if (d < bd) { bd = d; best = k; } } return best / M; });
  }
  return [P1, P2];
}

/**
 * Propose a fair curve for the run fromAnchor → toAnchor. `keepAnchorIds` (plus the two ends) are
 * hard constraints; every other anchor of the run is replaced. Base size; grading of kept anchors is
 * untouched (new intermediates are curve points graded proportionally).
 */
export function smoothRun(doc: Document, pieceId: Id, contourId: Id, fromAnchorId: Id, toAnchorId: Id, keepAnchorIds: Id[] = []): SmoothPreview {
  const piece = doc.piece(pieceId), line: SizeLine = doc.sizeLine(piece);
  const { contour } = findAnchorIn(piece, fromAnchorId);
  if (contour.id !== contourId) throw new Error('Anchor is not on contour ' + contourId);
  const ia = idx(contour, fromAnchorId), ib = idx(contour, toAnchorId);
  const r = resolveBase(contour, line);
  const runIdx = [ia, ...between(contour, ia, ib), ib];
  const keep = new Set([fromAnchorId, toAnchorId, ...keepAnchorIds]);
  const kept = runIdx.filter(i => keep.has(contour.points[i].id));
  const orig = arcSlice(r, arcS(r, ia), arcS(r, ia) + spanLen(r, ia, ib));
  const K = kept.map(i => r.anchorPos[i]);
  // tangents at kept anchors
  const n = contour.points.length;
  const tang: (Vec | null)[] = K.map((p, k) => {
    if (k > 0 && k < K.length - 1) {
      // Catmull-Rom style through the neighbouring kept points (centripetal weights)
      const d1 = Math.sqrt(dist(K[k - 1], p)), d2 = Math.sqrt(dist(p, K[k + 1]));
      return norm(add(mul(norm(sub(p, K[k - 1])), d2), mul(norm(sub(K[k + 1], p)), d1)));
    }
    const i = kept[k];
    // run ends: keep the existing tangent of the contour on the run side when smooth, otherwise
    // estimate from the original samples near the end
    const a = contour.points[i];
    const outside = k === 0 ? (contour.closed ? (i - 1 + n) % n : i - 1) : (contour.closed ? (i + 1) % n : i + 1);
    if (a.smooth && outside >= 0 && outside < n) {
      const h = k === 0 ? sub(r.handles[i].hOut, r.anchorPos[i]) : sub(r.anchorPos[i], r.handles[i].hIn);
      if (len(h) > 1e-9) return norm(h);
    }
    return null; // corner end: free handle (fitted)
  });
  // per sub-run fit
  const pts: Anchor[] = [];
  const subPolys: Vec[] = [];
  for (let k = 0; k + 1 < kept.length; k++) {
    const i0 = kept[k], i1 = kept[k + 1];
    const sub0 = arcSlice(r, arcS(r, i0), arcS(r, i0) + spanLen(r, i0, i1));
    const Q = resample(sub0, 48);
    const [P1, P2] = fitHandles(Q, K[k], K[k + 1], tang[k], tang[k + 1]);
    const start = k === 0 ? jsonClone(contour.points[i0]) : pts[pts.length - 1];
    if (k === 0) pts.push(start);
    start.hOut = sub(P1, K[k]);
    const end = jsonClone(contour.points[i1]);
    end.hIn = sub(P2, K[k + 1]);
    if (k + 1 < kept.length - 1) end.smooth = true;
    delete end.hOut;
    pts.push(end);
    for (let j = 0; j <= 32; j++) if (!(k > 0 && j === 0)) subPolys.push(bezierPoint(K[k], P1, P2, K[k + 1], j / 32));
  }
  const first = contour.points[ia], last = contour.points[ib];
  if (first.hIn) pts[0].hIn = jsonClone(first.hIn); else delete pts[0].hIn;
  if (last.hOut) pts[pts.length - 1].hOut = jsonClone(last.hOut);
  const maxDeviation = Math.max(maxDev(subPolys, orig), maxDev(orig, subPolys));
  const commit = () => doc.transact('Smooth', () => {
    const p = doc.piece(pieceId);
    const c = [p.sew, ...p.internals].find(x => x.id === contourId) as Contour;
    const rr = resolveBase(c, line);
    const ja = idx(c, fromAnchorId), jb = idx(c, toAnchorId);
    // freeze outer neighbours (their CR tangents must not change)
    const m = c.points.length;
    for (const q of [c.closed ? (ja - 1 + m) % m : ja - 1, c.closed ? (jb + 1) % m : jb + 1]) if (q >= 0 && q < m && c.points[q].smooth) freeze(c, rr, q);
    if (c.points[ja].smooth && !c.points[ja].hIn) freeze(c, rr, ja);
    if (c.points[jb].smooth && !c.points[jb].hOut) freeze(c, rr, jb);
    const inner = new Set(between(c, ja, jb).map(q => c.points[q].id));
    const caps = captureNotches(p, line, [c.id]);
    const hInA = c.points[ja].hIn, hOutB = c.points[jb].hOut;
    const repl = pts.map(a => jsonClone(a));
    if (hInA) repl[0].hIn = hInA; if (hOutB) repl[repl.length - 1].hOut = hOutB;
    // replace in place: remove inner, overwrite the two ends, insert kept-interiors
    c.points = c.points.filter(a => !inner.has(a.id));
    const na = idx(c, fromAnchorId);
    c.points[na] = { ...c.points[na], ...repl[0], id: fromAnchorId };
    const nb = idx(c, toAnchorId);
    c.points[nb] = { ...c.points[nb], ...repl[repl.length - 1], id: toAnchorId };
    if (!repl[0].hIn) delete c.points[na].hIn;
    c.points.splice(na + 1, 0, ...repl.slice(1, -1));
    p.notches = p.notches.filter(nn => !caps.some(cp => cp.notch.id === nn.id));
    restoreNotches(p, line, caps, Math.max(1, maxDeviation * 2));
  });
  return { points: pts, polyline: subPolys, maxDeviation, commit };
}


