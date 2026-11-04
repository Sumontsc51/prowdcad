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

export interface Selection {
  pieces: Id[];
  anchors: AnchorRef[];
}

type Part = 'canvas' | 'panels' | 'status' | 'menus';

export class App {
  doc: Document;
  view = new Viewport();
  sel: Selection = { pieces: [], anchors: [] };
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
        this.sel = { pieces: [], anchors: [] };
        this.activeSize = this.doc.sizeTable().axis1.baseSizeId;
        this.nestedHidden.clear(); this.hiddenPieces.clear(); this.preview.clear();
        this.savedRev = this.doc.revision();
      }
      this.pruneSelection();
      this.invalidate();
    });
  }

  // ───── render scheduling ─────
  setRenderer(part: Part, fn: () => void) { this.renderers[part] = fn; }
  invalidate(...parts: Part[]) {
    const list: Part[] = parts.length ? parts : ['canvas', 'panels', 'status', 'menus'];
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
  selectPiece(id: Id | null, additive = false) {
    if (!additive) this.liveSel = null;
    if (!id) { if (!additive) this.sel = { pieces: [], anchors: [] }; }
    else if (additive) {
      const i = this.sel.pieces.indexOf(id);
      if (i >= 0) this.sel.pieces.splice(i, 1); else this.sel.pieces.push(id);
    } else { this.sel.pieces = [id]; this.sel.anchors = []; }
    this.invalidate();
  }
  isAnchorSelected(r: { anchorId: Id }) { return this.sel.anchors.some(a => a.anchorId === r.anchorId); }
  selectAnchor(ref: AnchorRef | null, additive = false) {
    this.liveSel = null;
    if (!ref) { this.sel.anchors = []; this.invalidate(); return; }
    if (additive) {
      const i = this.sel.anchors.findIndex(a => a.anchorId === ref.anchorId);
      if (i >= 0) this.sel.anchors.splice(i, 1); else this.sel.anchors.push(ref);
    } else this.sel.anchors = [ref];
    if (!this.sel.pieces.includes(ref.pieceId)) this.sel.pieces = additive ? [...this.sel.pieces, ref.pieceId] : [ref.pieceId];
    this.invalidate();
  }
  pruneSelection() {
    const ids = new Set(this.doc.style.pieces.map(p => p.id));
    this.sel.pieces = this.sel.pieces.filter(id => ids.has(id));
    this.sel.anchors = this.sel.anchors.filter(r => ids.has(r.pieceId) && !!this.resolveRef(r));
    if (this.liveSel) {
      const l = this.liveSel, p = this.doc.style.pieces.find(x => x.id === l.pieceId);
      const ok = !!p && (l.kind === 'dart' ? p.darts : l.kind === 'pleat' ? p.pleats : p.fullness ?? []).some((o: { id: Id }) => o.id === l.id);
      if (!ok || !this.sel.pieces.includes(l.pieceId) || this.sel.anchors.length) this.liveSel = null;
    }
    const sizes = this.sizeLine().sizes.map(s => s.id);
    if (!sizes.includes(this.activeSize)) this.activeSize = this.baseSize();
  }

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
