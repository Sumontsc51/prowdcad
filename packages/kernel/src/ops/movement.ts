/**
 * Movement Programs (A7): parametric made-to-measure. A program lists anchor moves in mm per
 * +1 mm of a named measurement. Applying a delta moves the listed anchors' BASE coordinates by
 * delta × (dx,dy) (optionally also adding the move to every size's grading, i.e. per-size moves
 * that differ by size), or writes the result into a new piece version.
 */
import type { Document } from '../model/doc';
import type { Contour, GradeInc, Id, MovementProgram, Piece, SizeId } from '../model/types';
import type { Vec } from '../geom/vec';
import { newId, now } from '../model/factory';
import { type GradeRec, findRef, clonePieceFresh, refWorldAbs, incFromWorldAbs, materializeCurves, allContours } from './grading/util';

export interface MoveSpec { pieceId: Id; anchorId: Id; dx: number; dy: number }

export function program(doc: Document, programId: Id): MovementProgram {
  const p = doc.style.movementPrograms.find(p => p.id === programId || p.name === programId);
  if (!p) throw new Error('No movement program ' + programId);
  return p;
}

export function createProgram(doc: Document, name: string, measurement: string, moves: MoveSpec[] = []): Id {
  return doc.transact('New movement program', style => {
    const p: MovementProgram = { id: newId('mv'), name, measurement, moves: moves.map(m => ({ ...m })) };
    style.movementPrograms.push(p);
    return p.id;
  });
}

/** Add (or replace) a move for an anchor in a program. */
export function addMove(doc: Document, programId: Id, move: MoveSpec): void {
  doc.transact('Add move', () => {
    const p = program(doc, programId);
    findRef(doc.piece(move.pieceId), move.anchorId); // validate
    const i = p.moves.findIndex(m => m.pieceId === move.pieceId && m.anchorId === move.anchorId);
    if (i >= 0) p.moves[i] = { ...move }; else p.moves.push({ ...move });
  });
}
export function removeMove(doc: Document, programId: Id, pieceId: Id, anchorId: Id): void {
  doc.transact('Remove move', () => { const p = program(doc, programId); p.moves = p.moves.filter(m => !(m.pieceId === pieceId && m.anchorId === anchorId)); });
}

export interface ApplyOptions {
  /** write results into new piece versions (FRONT → FRONT_1 …); the originals are archived */
  asNewPieceVersion?: boolean;
  /** per-size deltas (measurement change differs by size). Key: size id. Sizes absent use `deltaMm`. When given, only grading changes for non-base sizes. */
  perSize?: Record<SizeId, number>;
}

export interface ApplyResult {
  /** pieceId (as it is AFTER the call) → moved anchor ids */
  moved: Record<Id, Id[]>;
  /** old piece id → new version piece id (asNewPieceVersion) */
  versions: Record<Id, Id>;
}

function versionPiece(doc: Document, piece: Piece): Piece {
  const style = doc.style;
  const { piece: np, idMap } = clonePieceFresh(piece);
  // keep anchor ids stable for programs: the new version reuses the original anchor ids
  const inv: Record<Id, Id> = {}; for (const [o, n] of Object.entries(idMap)) inv[n] = o;
  for (const c of allContours(np)) for (const a of c.points) a.id = inv[a.id] ?? a.id;
  for (const d of np.darts) { d.legA = inv[d.legA] ?? d.legA; d.legB = inv[d.legB] ?? d.legB; }
  for (const n of np.notches) n.placement.anchorId = inv[n.placement.anchorId] ?? n.placement.anchorId;
  for (const k of np.connections) { k.internalAnchorId = inv[k.internalAnchorId] ?? k.internalAnchorId; k.externalAnchorId = inv[k.externalAnchorId] ?? k.externalAnchorId; }
  const baseName = piece.name.replace(/_\d+$/, '');
  const maxV = Math.max(piece.version, ...[...style.pieces, ...style.pieceArchive].filter(p => p.name.replace(/_\d+$/, '') === baseName).map(p => p.version));
  np.version = maxV + 1;
  np.name = `${baseName}_${np.version}`;
  np.createdAt = np.updatedAt = now();
  const i = style.pieces.indexOf(piece);
  style.pieceArchive.push(piece);
  style.pieces.splice(i, 1, np);
  return np;
}

function applyMoves(doc: Document, moves: { pieceId: Id; anchorId: Id; dx: number; dy: number; delta: number }[], opt: ApplyOptions, res: ApplyResult) {
  const byPiece = new Map<Id, typeof moves>();
  for (const m of moves) { const l = byPiece.get(m.pieceId) ?? []; l.push(m); byPiece.set(m.pieceId, l); }
  for (const [pid, list] of byPiece) {
    let piece = doc.piece(res.versions[pid] ?? pid);
    if (opt.asNewPieceVersion && !res.versions[pid]) { piece = versionPiece(doc, piece); res.versions[pid] = piece.id; }
    const line = doc.sizeLine(piece);
    const before = new Map(allContours(piece).map(c => [c, c.points.map(a => ({ x: a.x, y: a.y }))] as const));
    for (const m of list) {
      const ref0 = findRef(piece, m.anchorId);
      if (opt.perSize) {
        if (ref0.implicit && ref0.contour) materializeCurves(ref0.contour, line, 'grade', [ref0.contour.points.indexOf(ref0.anchor!)]);
        const ref = findRef(piece, m.anchorId);
        const w = refWorldAbs(ref, line);
        const base = m.delta;
        // base moves by base delta (perSize[base] if given), other sizes by their own delta (relative to the moved base)
        const bd = opt.perSize[line.baseSizeId] ?? base;
        ref.pos.x += m.dx * bd; ref.pos.y += m.dy * bd;
        const out: Record<SizeId, { x: number; y: number }> = {};
        for (const s of line.sizes) {
          const d = (opt.perSize[s.id] ?? base) - bd;
          out[s.id] = { x: w[s.id].x + m.dx * d, y: w[s.id].y + m.dy * d };
        }
        ref.set(incFromWorldAbs(out, line, ref.axisDeg));
      } else {
        ref0.pos.x += m.dx * m.delta; ref0.pos.y += m.dy * m.delta;
      }
      (res.moved[piece.id] = res.moved[piece.id] ?? []).push(m.anchorId);
    }
    carryCurvePoints(before, new Set(list.map(m => m.anchorId)));
    piece.updatedAt = now();
  }
}

/**
 * Curve points between moved grade anchors follow them (B6), with the grading rule for implicit
 * curve points: the base displacement of a curve point is the displacement of its previous and next
 * grade anchors interpolated by base chord distance along the contour (pre-move positions). Curve
 * points before the first / after the last grade anchor of an open contour follow their only
 * neighbour rigidly. Curve points the program moves itself are left alone.
 */
function carryCurvePoints(before: Map<Contour, Vec[]>, explicit: Set<Id>) {
  for (const [c, old] of before) {
    const P = c.points, n = P.length;
    if (n !== old.length) continue;
    const disp = P.map((a, i) => ({ x: a.x - old[i].x, y: a.y - old[i].y }));
    if (!P.some((a, i) => a.kind === 'grade' && (disp[i].x !== 0 || disp[i].y !== 0))) continue;
    const step = (i: number, dir: 1 | -1) => (c.closed ? (i + dir + n) % n : i + dir);
    for (let i = 0; i < n; i++) {
      if (P[i].kind !== 'curve' || explicit.has(P[i].id)) continue;
      let prev = -1, next = -1, dPrev = 0, dNext = 0;
      for (let j = i, g = 0; g < n; g++) { const k = step(j, -1); if (k < 0 || k >= n) break; dPrev += Math.hypot(old[j].x - old[k].x, old[j].y - old[k].y); j = k; if (P[k].kind === 'grade') { prev = k; break; } }
      for (let j = i, g = 0; g < n; g++) { const k = step(j, 1); if (k < 0 || k >= n) break; dNext += Math.hypot(old[j].x - old[k].x, old[j].y - old[k].y); j = k; if (P[k].kind === 'grade') { next = k; break; } }
      if (prev < 0 && next < 0) continue;
      let dx: number, dy: number;
      if (prev < 0 || next < 0) { const g = prev < 0 ? next : prev; dx = disp[g].x; dy = disp[g].y; }
      else { const tot = dPrev + dNext, t = tot < 1e-9 ? 0.5 : dPrev / tot; dx = disp[prev].x * (1 - t) + disp[next].x * t; dy = disp[prev].y * (1 - t) + disp[next].y * t; }
      P[i].x = old[i].x + dx; P[i].y = old[i].y + dy;
    }
  }
}

/** Apply one program for a measurement change of `deltaMm`. */
export function applyMeasurementDelta(doc: Document, programId: Id, deltaMm: number, opt: ApplyOptions = {}): ApplyResult {
  return doc.transact('Apply movement program', () => {
    const p = program(doc, programId);
    const res: ApplyResult = { moved: {}, versions: {} };
    applyMoves(doc, p.moves.map(m => ({ ...m, delta: deltaMm })), opt, res);
    return res;
  });
}

/**
 * Apply every program whose measurement differs between `base` and `target` (values in mm, or
 * MeasurementSet ids/names). Moves of several programs on the same anchor add up.
 */
export function applyMeasurementSet(doc: Document, base: Record<string, number> | Id, target: Record<string, number> | Id, opt: Omit<ApplyOptions, 'perSize'> = {}): ApplyResult & { deltas: Record<string, number> } {
  return doc.transact('Apply measurement set', style => {
    const vals = (m: Record<string, number> | Id) => {
      if (typeof m !== 'string') return m;
      const s = style.measurementSets.find(x => x.id === m || x.name === m); if (!s) throw new Error('No measurement set ' + m);
      return s.values;
    };
    const b = vals(base), t = vals(target);
    const deltas: Record<string, number> = {};
    for (const k of Object.keys(t)) if (b[k] !== undefined && Math.abs(t[k] - b[k]) > 1e-12) deltas[k] = t[k] - b[k];
    const moves: { pieceId: Id; anchorId: Id; dx: number; dy: number; delta: number }[] = [];
    for (const p of style.movementPrograms) { const d = deltas[p.measurement]; if (d !== undefined) for (const m of p.moves) moves.push({ ...m, delta: d }); }
    const res: ApplyResult = { moved: {}, versions: {} };
    applyMoves(doc, moves, opt, res);
    return { ...res, deltas };
  });
}

export function addMeasurementSet(doc: Document, name: string, values: Record<string, number>): Id {
  return doc.transact('New measurement set', style => { const id = newId('ms'); style.measurementSets.push({ id, name, values: { ...values } }); return id; });
}

export type { GradeInc, GradeRec };

