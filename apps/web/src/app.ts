/**
 * Application state for the Design workspace: the Document, viewport, selection, active size,
 * nested view, active tool, drag previews, file handle and render scheduling.
 */
import { Document, makeStyle, type Piece, type SizeId, type Id, type Anchor, type Contour, type Vec } from '@prowdcad/kernel';
import { Viewport } from './canvas/view';
import { settings, saveSettings } from './settings';
import type { Tool } from './tools/tool';
import { contourById, deepClone, sizeFor } from './geometry';
import type { AnchorRef } from './ops-bridge';
import type { LiveRef } from './live';

/** A grade segment of a contour (from grade anchor → next grade anchor, contour direction). */
export interface SegSel { pieceId: Id; contourId: Id; from: Id; to: Id }
/** A whole internal line / shape. */
export interface ContourSel { pieceId: Id; contourId: Id }
export interface NotchSel { pieceId: Id; notchId: Id }
/** Drill / button / buttonhole or text annotation. */
export interface MarkSel { pieceId: Id; kind: 'drill' | 'text'; id: Id }
export type SelKind = 'piece' | 'point' | 'segment' | 'internal' | 'notch' | 'mark' | 'live';

/**
 * The selection. `pieces` holds explicitly selected pieces AND the pieces of every selected
 * sub-object (context: Inspector, piece highlight, piece commands). The typed lists hold the
 * sub-objects; `primary` is the kind of the last clicked item. Selection survives commands, tool
 * switches, size switches and undo / redo (pruneSelection drops only ids that no longer exist).
 */
export interface Selection {
  pieces: Id[];
  anchors: AnchorRef[];
  segments: SegSel[];
  internals: ContourSel[];
  notches: NotchSel[];
  marks: MarkSel[];
  primary?: SelKind;
}
/** What older code assigns (`app.sel = { pieces, anchors }`); the other lists default to empty. */
export type SelectionInit = Partial<Selection> & { pieces: Id[]; anchors: AnchorRef[] };
export const emptySelection = (): Selection => ({ pieces: [], anchors: [], segments: [], internals: [], notches: [], marks: [] });

/** One selectable object (Select tool, candidate picker, marquee). */
export type SelItem =
  | { k: 'piece'; pieceId: Id }
  | { k: 'point'; ref: AnchorRef; sizeId?: SizeId }
  | { k: 'segment'; seg: SegSel }
  | { k: 'internal'; c: ContourSel }
  | { k: 'notch'; n: NotchSel }
  | { k: 'mark'; m: MarkSel }
  | { k: 'live'; live: LiveRef };
export function selItemPiece(it: SelItem): Id {
  switch (it.k) {
    case 'piece': return it.pieceId; case 'point': return it.ref.pieceId; case 'segment': return it.seg.pieceId;
    case 'internal': return it.c.pieceId; case 'notch': return it.n.pieceId; case 'mark': return it.m.pieceId; case 'live': return it.live.pieceId;
  }
}
export function selItemKey(it: SelItem): string {
  switch (it.k) {
    case 'piece': return 'pc:' + it.pieceId; case 'point': return 'pt:' + it.ref.anchorId;
    case 'segment': return `sg:${it.seg.contourId}:${it.seg.from}:${it.seg.to}`; case 'internal': return 'in:' + it.c.contourId;
    case 'notch': return 'n:' + it.n.notchId; case 'mark': return `m:${it.m.kind}:${it.m.id}`; case 'live': return `lv:${it.live.kind}:${it.live.id}`;
  }
}

type Part = 'canvas' | 'panels' | 'status' | 'menus' | 'options';

export class App {
  doc: Document;
  view = new Viewport();
  private _sel: Selection = emptySelection();
  get sel(): Selection { return this._sel; }
  set sel(v: SelectionInit) { this._sel = { ...emptySelection(), ...v }; }
  /** selected live object (dart / pleat / fullness record), shown in the Inspector */
  liveSel: LiveRef | null = null;
  activeSize: SizeId;
  nested = false;
  nestedHidden = new Set<SizeId>();
  hiddenPieces = new Set<Id>();
  tool!: Tool;
  tools: Tool[] = [];
  /** last tool used per palette group (flyout memory) */
  groupTool: Record<string, string> = {};
  /** live drag previews: pieceId → mutated clone (committed with one transact on release) */
  preview = new Map<Id, Piece>();
  cursorWorld: Vec | null = null;
  statusMsg = '';
  /** grading table point-tracking mode (arrow keys step through grade anchors) */
  pointTracking = false;
  gradeAbsolute = false;
  space = false;
  fileName = 'untitled.prowd.json';
  fileHandle: unknown = null;
  savedRev = 0;

  private renderers: Partial<Record<Part, () => void>> = {};
  private dirtyParts = new Set<Part>();
  private raf = 0;

  constructor() {
    this.doc = new Document(makeStyle());
    this.activeSize = this.doc.sizeTable().axis1.baseSizeId;
    this.doc.on(e => {
      if (e.type === 'load') {
        this.sel = emptySelection();
        this.activeSize = this.doc.sizeTable().axis1.baseSizeId;
        this.nestedHidden.clear(); this.hiddenPieces.clear(); this.preview.clear();
        this.savedRev = this.doc.revision();
        this.statusMsg = ''; // a message about the previous document must not survive a reload
      }
      this.pruneSelection();
      this.invalidate();
    });
  }

  // ───── render scheduling ─────
  setRenderer(part: Part, fn: () => void) { this.renderers[part] = fn; }
  invalidate(...parts: Part[]) {
    const list: Part[] = parts.length ? parts : ['canvas', 'panels', 'status', 'menus', 'options'];
    if (list.includes('status') && !list.includes('options')) list.push('options');
    for (const p of list) this.dirtyParts.add(p);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }
  flush() {
    this.raf = 0;
    const parts = [...this.dirtyParts]; this.dirtyParts.clear();
    for (const p of parts) { try { this.renderers[p]?.(); } catch (err) { console.error(`render ${p}`, err); } }
  }

  // ───── document helpers ─────
  get style() { return this.doc.style; }
  sizeLine() { return this.doc.sizeTable().axis1; }
  baseSize() { return this.sizeLine().baseSizeId; }
  isDirty() { return this.doc.revision() !== this.savedRev; }
  markSaved() { this.savedRev = this.doc.revision(); this.invalidate('status'); }

  /** piece as currently displayed (drag preview clone or live) */
  piece(id: Id): Piece | undefined { return this.preview.get(id) ?? this.doc.style.pieces.find(p => p.id === id); }
  pieces(): Piece[] { return this.doc.style.pieces.map(p => this.preview.get(p.id) ?? p); }
  sizeOf(p: Piece): SizeId { return sizeFor(this.doc, p, this.activeSize); }

  primaryPiece(): Piece | undefined {
    const id = this.sel.anchors.length ? this.sel.anchors[this.sel.anchors.length - 1].pieceId : this.sel.pieces[this.sel.pieces.length - 1];
    return id ? this.piece(id) : undefined;
  }
  primaryAnchor(): { piece: Piece; contour: Contour; anchor: Anchor; index: number; ref: AnchorRef } | undefined {
    const ref = this.sel.anchors[this.sel.anchors.length - 1];
    return ref ? this.resolveRef(ref) : undefined;
  }
  resolveRef(ref: AnchorRef) {
    const piece = this.piece(ref.pieceId); if (!piece) return undefined;
    const contour = contourById(piece, ref.contourId); if (!contour) return undefined;
    const index = contour.points.findIndex(a => a.id === ref.anchorId); if (index < 0) return undefined;
    return { piece, contour, anchor: contour.points[index], index, ref };
  }

  // ───── selection ─────
  /** The selected live object when it is still valid (exists, its piece selected, no point selection). */
  currentLive(): LiveRef | null {
    const l = this.liveSel; if (!l) return null;
    if (this.sel.anchors.length || !this.sel.pieces.includes(l.pieceId)) return null;
    const p = this.doc.style.pieces.find(x => x.id === l.pieceId); if (!p) return null;
    const list: { id: Id }[] = l.kind === 'dart' ? p.darts : l.kind === 'pleat' ? p.pleats : p.fullness ?? [];
    return list.some(o => o.id === l.id) ? l : null;
  }
  selectPiece(id: Id | null, additive = false) {
    if (!additive) this.liveSel = null;
    if (!id) { if (!additive) this.sel = emptySelection(); }
    else if (additive) {
      const i = this.sel.pieces.indexOf(id);
      if (i >= 0) this.sel.pieces.splice(i, 1); else this.sel.pieces.push(id);
    } else { this.sel = { pieces: [id], anchors: [], primary: 'piece' }; }
    this.invalidate();
  }
  isAnchorSelected(r: { anchorId: Id }) { return this.sel.anchors.some(a => a.anchorId === r.anchorId); }
  selectAnchor(ref: AnchorRef | null, additive = false) {
    this.liveSel = null;
    if (!ref) { this.sel.anchors = []; this.invalidate(); return; }
    if (additive) {
      const i = this.sel.anchors.findIndex(a => a.anchorId === ref.anchorId);
      if (i >= 0) this.sel.anchors.splice(i, 1); else this.sel.anchors.push(ref);
    } else this.sel = { pieces: [ref.pieceId], anchors: [ref] };
    if (!this.sel.pieces.includes(ref.pieceId)) this.sel.pieces = additive ? [...this.sel.pieces, ref.pieceId] : [ref.pieceId];
    this.sel.primary = 'point';
    this.invalidate();
  }
  pruneSelection() {
    const ids = new Set(this.doc.style.pieces.map(p => p.id));
    this.sel.pieces = this.sel.pieces.filter(id => ids.has(id));
    this.sel.anchors = this.sel.anchors.filter(r => ids.has(r.pieceId) && !!this.resolveRef(r));
    const pc = (id: Id) => this.doc.style.pieces.find(p => p.id === id);
    this.sel.segments = this.sel.segments.filter(g => {
      const p = pc(g.pieceId); const c = p && contourById(p, g.contourId);
      return !!c && [g.from, g.to].every(id => c.points.some(a => a.id === id && a.kind === 'grade'));
    });
    this.sel.internals = this.sel.internals.filter(g => { const p = pc(g.pieceId); return !!p && p.internals.some(c => c.id === g.contourId); });
    this.sel.notches = this.sel.notches.filter(g => !!pc(g.pieceId)?.notches.some(n => n.id === g.notchId));
    this.sel.marks = this.sel.marks.filter(g => { const p = pc(g.pieceId); return !!p && (g.kind === 'drill' ? p.drills : p.texts).some(d => d.id === g.id); });
    if (this.liveSel) {
      const l = this.liveSel, p = this.doc.style.pieces.find(x => x.id === l.pieceId);
      const ok = !!p && (l.kind === 'dart' ? p.darts : l.kind === 'pleat' ? p.pleats : p.fullness ?? []).some((o: { id: Id }) => o.id === l.id);
      if (!ok || !this.sel.pieces.includes(l.pieceId) || this.sel.anchors.length) this.liveSel = null;
    }
    const sizes = this.sizeLine().sizes.map(s => s.id);
    if (!sizes.includes(this.activeSize)) this.activeSize = this.baseSize();
  }

  /** Is this object currently selected? */
  isSelected(it: SelItem): boolean {
    const s = this.sel;
    switch (it.k) {
      case 'piece': return s.pieces.includes(it.pieceId) && !this.hasSubSelection(it.pieceId);
      case 'point': return s.anchors.some(a => a.anchorId === it.ref.anchorId);
      case 'segment': return s.segments.some(g => g.contourId === it.seg.contourId && g.from === it.seg.from && g.to === it.seg.to);
      case 'internal': return s.internals.some(g => g.contourId === it.c.contourId);
      case 'notch': return s.notches.some(g => g.notchId === it.n.notchId);
      case 'mark': return s.marks.some(g => g.id === it.m.id && g.kind === it.m.kind);
      case 'live': return this.liveSel?.id === it.live.id;
    }
  }
  /** Any sub-object (point / segment / internal / notch / mark / live) selected (optionally on one piece)? */
  hasSubSelection(pieceId?: Id): boolean {
    const s = this.sel; const on = (p: Id) => !pieceId || p === pieceId;
    return s.anchors.some(a => on(a.pieceId)) || s.segments.some(a => on(a.pieceId)) || s.internals.some(a => on(a.pieceId)) ||
      s.notches.some(a => on(a.pieceId)) || s.marks.some(a => on(a.pieceId)) || (!!this.liveSel && on(this.liveSel.pieceId));
  }
  selCount(): number {
    const s = this.sel;
    const sub = s.anchors.length + s.segments.length + s.internals.length + s.notches.length + s.marks.length + (this.currentLive() ? 1 : 0);
    return sub || s.pieces.length;
  }
  hasSelection(): boolean { const s = this.sel; return !!(s.pieces.length || s.anchors.length || s.segments.length || s.internals.length || s.notches.length || s.marks.length || this.liveSel); }
  clearSelection() { this.sel = emptySelection(); this.liveSel = null; this.invalidate(); }
  /** Click semantics: replace (plain click), add (Shift), toggle (Ctrl), remove. */
  applySel(it: SelItem, mode: 'replace' | 'add' | 'toggle' | 'remove' = 'replace') {
    const has = this.isSelected(it);
    if (mode === 'toggle') mode = has ? 'remove' : 'add';
    if (mode === 'replace') { this.sel = emptySelection(); this.liveSel = null; }
    if (mode === 'add' && has) { this.sel.primary = it.k; this.invalidate(); return; }
    const s = this.sel, pid = selItemPiece(it);
    if (mode === 'remove') {
      switch (it.k) {
        case 'piece': s.pieces = s.pieces.filter(x => x !== it.pieceId); break;
        case 'point': s.anchors = s.anchors.filter(a => a.anchorId !== it.ref.anchorId); break;
        case 'segment': s.segments = s.segments.filter(g => !(g.contourId === it.seg.contourId && g.from === it.seg.from && g.to === it.seg.to)); break;
        case 'internal': s.internals = s.internals.filter(g => g.contourId !== it.c.contourId); break;
        case 'notch': s.notches = s.notches.filter(g => g.notchId !== it.n.notchId); break;
        case 'mark': s.marks = s.marks.filter(g => !(g.id === it.m.id && g.kind === it.m.kind)); break;
        case 'live': this.liveSel = null; break;
      }
      // a piece that is only context for removed sub-objects drops out with its last sub-object
      if (it.k !== 'piece' && !this.hasSubSelection(pid)) s.pieces = s.pieces.filter(x => x !== pid);
      this.invalidate(); return;
    }
    switch (it.k) {
      case 'piece': break;
      case 'point': s.anchors.push(it.ref); break;
      case 'segment': s.segments.push(it.seg); break;
      case 'internal': s.internals.push(it.c); break;
      case 'notch': s.notches.push(it.n); break;
      case 'mark': s.marks.push(it.m); break;
      case 'live': this.liveSel = it.live; break;
    }
    if (!s.pieces.includes(pid)) s.pieces.push(pid);
    s.primary = it.k;
    this.invalidate();
  }
  /** Snapshot / restore (Move tools: Backspace = undo the last pick). */
  snapshotSel(): { sel: Selection; live: LiveRef | null } { return { sel: JSON.parse(JSON.stringify(this.sel)) as Selection, live: this.liveSel }; }
  restoreSel(s: { sel: Selection; live: LiveRef | null }) { this.sel = s.sel; this.liveSel = s.live; this.pruneSelection(); this.invalidate(); }

  // ───── previews (drag without undo spam) ─────
  beginPreview(id: Id): Piece {
    let p = this.preview.get(id);
    if (!p) { p = deepClone(this.doc.piece(id)); this.preview.set(id, p); }
    return p;
  }
  cancelPreview() { if (this.preview.size) { this.preview.clear(); this.invalidate(); } }
  commitPreview(label: string) {
    if (!this.preview.size) return;
    const pv = new Map(this.preview);
    this.preview.clear();
    this.doc.transact(label, s => {
      s.pieces = s.pieces.map(p => { const c = pv.get(p.id); if (!c) return p; c.updatedAt = new Date().toISOString(); return c; });
    });
  }

  // ───── tools ─────
  setTool(id: string) {
    const t = this.tools.find(t => t.id === id);
    if (!t) return;
    if (this.tool && this.tool !== t) this.tool.deactivate?.(this);
    this.tool = t;
    this.groupTool[t.group] = t.id;
    t.activate?.(this);
    this.statusMsg = '';
    this.invalidate();
  }

  setUnit(u: typeof settings.unit, den?: number) {
    settings.unit = u; if (den != null) settings.fracDen = den;
    saveSettings();
    this.invalidate();
  }

  status(msg: string) { this.statusMsg = msg; this.invalidate('status'); }
}
