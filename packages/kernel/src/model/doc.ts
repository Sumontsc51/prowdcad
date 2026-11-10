/**
 * Document: owns a Style, provides resolution (geometry per size), a snapshot-based undo/redo
 * stack (≥100 steps), change events, and timed auto-backup hooks.
 *
 * ASSUMPTION: undo/redo is snapshot-based (structured clone of the Style per transaction) rather
 * than per-command inverse operations. Styles are a few hundred KB at most; 200 snapshots is cheap,
 * and it makes every kernel op trivially undoable.
 */
import type { Style, Piece, SizeId, SizeLine, SizeTable, Id, Contour, Anchor } from './types';
import { resolveContour, absoluteOffset, halfOpenedPiece, type ResolvedContour } from './contour';
import { computeCutLine, captureSew, followSeams, type SewCapture } from '../ops/seam';
import { applyInternalLocks } from '../ops/lock';
import { makeStyle } from './factory';
import type { Vec } from '../geom/vec';

export interface ResolvedPiece {
  pieceId: Id;
  sizeId: SizeId;
  sew: ResolvedContour;
  /** closed polygon of the cut line (== sew when noSeam) */
  cut: Vec[];
  internals: ResolvedContour[];
  grain: { a: Vec; b: Vec };
}

export type DocEvent = { type: 'change'; label: string } | { type: 'undo' | 'redo'; label: string } | { type: 'load' };
type Listener = (e: DocEvent) => void;

export class Document {
  style: Style;
  private undoStack: { label: string; snap: string }[] = [];
  private redoStack: { label: string; snap: string }[] = [];
  maxUndo = 200;
  private listeners = new Set<Listener>();
  private cache = new Map<string, ResolvedPiece>();
  private openCache = new Map<string, Piece>();
  private rev = 0;
  /** depth counter so nested transact() calls produce a single undo step */
  private txDepth = 0;
  private txLabel = '';

  constructor(style?: Style) { this.style = style ?? makeStyle(); }

  // ───── events ─────
  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(e: DocEvent) { for (const l of this.listeners) l(e); }

  /**
   * Run a mutation as one undoable step. Returns fn's result. After a successful top-level step the
   * edit rules run in the same step (`finishEdit`): seams follow segment edits, Lock Grading snapshots
   * refresh, locked internal lines follow the sew line.
   */
  transact<T>(label: string, fn: (s: Style) => T): T {
    let cap: SewCapture | undefined, snap = '';
    if (this.txDepth === 0) {
      snap = JSON.stringify(this.style);
      this.undoStack.push({ label, snap });
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
      this.redoStack = [];
      this.txLabel = label;
      cap = this.captureEdit();
    }
    this.txDepth++;
    let ok = false;
    try {
      const r = fn(this.style);
      ok = true;
      return r;
    } finally {
      this.txDepth--;
      if (this.txDepth === 0) {
        if (ok && cap) this.finishEdit(cap, () => (JSON.parse(snap) as Style).pieces);
        this.touch(); this.emit({ type: 'change', label: this.txLabel });
      }
    }
  }

  /** State the edit rules compare against (call before an edit; `pieceIds` limits it to those pieces). */
  captureEdit(pieceIds?: Set<Id>): SewCapture { return captureSew(this.style, pieceIds); }
  /**
   * Edit rules, run after an edit (by transact; Move-tool previews call it on their scratch copy):
   * seam allowances follow inserted / removed grade points (`followSeams`), Lock Grading corner
   * snapshots are re-stamped, and every internal-line lock is re-applied from the current sew line in
   * every size (`applyInternalLocks`). `oldPieces` = the pieces before the edit (read lazily).
   */
  finishEdit(cap: SewCapture, oldPieces: () => Piece[], pieceIds?: Set<Id>): void {
    const lineOf = (p: Piece) => this.sizeLine(p);
    try { followSeams(this.style, cap, oldPieces, lineOf, pieceIds); } catch { /* never block an edit */ }
    for (const p of this.style.pieces) {
      if (pieceIds && !pieceIds.has(p.id)) continue;
      if (!p.internals?.some(c => c.lock)) continue;
      try { applyInternalLocks(p, lineOf(p)); } catch { /* idem */ }
    }
  }
  private touch() { this.rev++; this.cache.clear(); this.openCache.clear(); this.style.updatedAt = new Date().toISOString(); }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label; }
  redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label; }
  undo(): boolean {
    const u = this.undoStack.pop(); if (!u) return false;
    this.redoStack.push({ label: u.label, snap: JSON.stringify(this.style) });
    this.style = JSON.parse(u.snap); this.touch(); this.emit({ type: 'undo', label: u.label }); return true;
  }
  redo(): boolean {
    const r = this.redoStack.pop(); if (!r) return false;
    this.undoStack.push({ label: r.label, snap: JSON.stringify(this.style) });
    this.style = JSON.parse(r.snap); this.touch(); this.emit({ type: 'redo', label: r.label }); return true;
  }

  // ───── persistence ─────
  toJSON(): string { return JSON.stringify(this.style); }
  static fromJSON(json: string): Document {
    const s = JSON.parse(json) as Style;
    if (s.schema !== 'prowdcad/2') throw new Error('Unsupported file schema: ' + (s as any).schema);
    return new Document(s);
  }
  load(style: Style) {
    this.style = style; this.undoStack = []; this.redoStack = [];
    for (const p of style.pieces ?? []) if (p.internals?.some(c => c.lock)) { try { applyInternalLocks(p, this.sizeLine(p)); } catch { /* keep as loaded */ } }
    this.touch(); this.emit({ type: 'load' });
  }
  revision() { return this.rev; }

  // ───── lookup ─────
  piece(id: Id): Piece { const p = this.style.pieces.find(p => p.id === id); if (!p) throw new Error('No piece ' + id); return p; }
  pieceByName(name: string): Piece | undefined { return this.style.pieces.find(p => p.name === name); }
  sizeTable(id?: Id): SizeTable { const t = this.style.sizeTables.find(t => t.id === (id ?? this.style.activeSizeTableId)); if (!t) throw new Error('No size table'); return t; }
  sizeLine(pieceOrId?: Piece | Id): SizeLine {
    const p = typeof pieceOrId === 'string' ? this.piece(pieceOrId) : pieceOrId;
    return this.sizeTable(p?.sizeTableId ?? undefined).axis1;
  }
  baseSize(piece?: Piece): SizeId { return this.sizeLine(piece).baseSizeId; }
  sizesOf(piece: Piece): SizeId[] { const line = this.sizeLine(piece); return piece.sizes ?? line.sizes.map(s => s.id); }
  findAnchor(piece: Piece, anchorId: Id): { contour: Contour; index: number; anchor: Anchor } | undefined {
    const all = [piece.sew, ...piece.internals, ...(piece.manualCut ? [piece.manualCut] : [])];
    for (const c of all) { const i = c.points.findIndex(a => a.id === anchorId); if (i >= 0) return { contour: c, index: i, anchor: c.points[i] }; }
    return undefined;
  }
  anchorIndex(contour: Contour, anchorId: Id): number { const i = contour.points.findIndex(a => a.id === anchorId); if (i < 0) throw new Error('No anchor ' + anchorId); return i; }

  // ───── resolution ─────
  /**
   * The piece as it is displayed / measured (`output` false) or written by exporters (`output` true).
   * A live half piece (`piece.half`) resolves as the full piece mirrored across its fold edge
   * (`halfOpenedPiece`, derived on the fly, never stored). With `half.openAtOutput === false` the
   * half is shown as authored and only exports open it.
   */
  effectivePiece(pieceOrId: Piece | Id, output = false): Piece {
    const piece = typeof pieceOrId === 'string' ? this.piece(pieceOrId) : pieceOrId;
    if (!piece.half) return piece;
    if (!output && piece.half.openAtOutput === false) return piece;
    const key = `${piece.id}|open`;
    const hit = this.openCache.get(key); if (hit) return hit;
    const open = halfOpenedPiece(piece, this.sizeLine(piece));
    this.openCache.set(key, open);
    return open;
  }
  resolvePiece(pieceId: Id, sizeId?: SizeId, opts: { output?: boolean } = {}): ResolvedPiece {
    const piece = this.effectivePiece(pieceId, !!opts.output);
    const line = this.sizeLine(piece);
    const sid = sizeId ?? line.baseSizeId;
    const key = `${pieceId}|${sid}|${piece === this.piece(pieceId) ? 'a' : 'o'}`;
    const hit = this.cache.get(key); if (hit) return hit;
    const sew = resolveContour(piece.sew, line, sid);
    const cut = piece.cutMode === 'manual' && piece.manualCut ? resolveContour(piece.manualCut, line, sid).pts : computeCutLine(piece, line, sid);
    const internals = piece.internals.map(c => resolveContour(c, line, sid));
    const ga = this.offsetVec(piece.grain.gradeA, line, sid), gb = this.offsetVec(piece.grain.gradeB, line, sid);
    const rp: ResolvedPiece = { pieceId, sizeId: sid, sew, cut, internals, grain: { a: { x: piece.grain.a.x + ga.x, y: piece.grain.a.y + ga.y }, b: { x: piece.grain.b.x + gb.x, y: piece.grain.b.y + gb.y } } };
    this.cache.set(key, rp);
    return rp;
  }
  resolveContour(piece: Piece, contour: Contour, sizeId?: SizeId): ResolvedContour {
    const line = this.sizeLine(piece);
    return resolveContour(contour, line, sizeId ?? line.baseSizeId);
  }
  resolveAllSizes(pieceId: Id): ResolvedPiece[] { const p = this.piece(pieceId); return this.sizesOf(p).map(s => this.resolvePiece(pieceId, s)); }
  private offsetVec(g: Record<SizeId, { dx: number; dy: number }> | undefined, line: SizeLine, sid: SizeId): Vec {
    return absoluteOffset(g, line, sid);
  }
}

