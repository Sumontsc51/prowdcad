/**
 * Text annotations and artwork placement (A6).
 * Text size is clamped to style.settings.textMinMm … textMaxMm. Artwork keeps its TRUE source
 * dimensions (width/height in mm) and is placed with scaleX/scaleY + angle about its centre (x,y).
 */
import type { Artwork, GradeInc, Id, Piece, SizeId, TextAnnotation } from '../model/types';
import type { Document } from '../model/doc';
import { absoluteOffset } from '../model/contour';
import { newId } from '../model/factory';
import { Vec, rotate, rad } from '../geom/vec';
import { livePiece } from './notches';

type GradeMap = Record<SizeId, GradeInc>;

export function clampTextSize(doc: Document, size: number): number {
  const { textMinMm, textMaxMm } = doc.style.settings;
  return Math.max(textMinMm, Math.min(textMaxMm, size));
}

const normDeg = (a: number) => { let r = a % 360; if (r < 0) r += 360; return r; };

function findText(p: Piece, id: Id): TextAnnotation { const t = p.texts.find(t => t.id === id); if (!t) throw new Error('No text ' + id); return t; }
function findArt(p: Piece, id: Id): Artwork { const a = p.artwork.find(a => a.id === id); if (!a) throw new Error('No artwork ' + id); return a; }

export interface AddTextOptions { x: number; y: number; text: string; size?: number; angleDeg?: number; grade?: GradeMap; draggable?: boolean }

export function addText(doc: Document, piece: Piece, o: AddTextOptions): TextAnnotation {
  return doc.transact('Add text', () => {
    const t: TextAnnotation = {
      id: newId('t'), x: o.x, y: o.y, grade: JSON.parse(JSON.stringify(o.grade ?? {})), text: o.text,
      size: clampTextSize(doc, o.size ?? 10), angleDeg: normDeg(o.angleDeg ?? 0), draggable: o.draggable ?? true,
    };
    livePiece(doc, piece).texts.push(t);
    return t;
  });
}

export function moveText(doc: Document, piece: Piece, textId: Id, dx: number, dy: number): TextAnnotation {
  return doc.transact('Move text', () => { const t = findText(livePiece(doc, piece), textId); t.x += dx; t.y += dy; return t; });
}
export function setTextPosition(doc: Document, piece: Piece, textId: Id, x: number, y: number): TextAnnotation {
  return doc.transact('Move text', () => { const t = findText(livePiece(doc, piece), textId); t.x = x; t.y = y; return t; });
}
/** Rotate by `deltaDeg` (relative) or set absolute angle with `absolute: true`. */
export function rotateText(doc: Document, piece: Piece, textId: Id, deg: number, absolute = false): TextAnnotation {
  return doc.transact('Rotate text', () => { const t = findText(livePiece(doc, piece), textId); t.angleDeg = normDeg(absolute ? deg : t.angleDeg + deg); return t; });
}
export function setTextSize(doc: Document, piece: Piece, textId: Id, size: number): TextAnnotation {
  return doc.transact('Text size', () => { const t = findText(livePiece(doc, piece), textId); t.size = clampTextSize(doc, size); return t; });
}
export function editText(doc: Document, piece: Piece, textId: Id, text: string): TextAnnotation {
  return doc.transact('Edit text', () => { const t = findText(livePiece(doc, piece), textId); t.text = text; return t; });
}
export function deleteText(doc: Document, piece: Piece, textId: Id): void {
  doc.transact('Delete text', () => { const p = livePiece(doc, piece); p.texts = p.texts.filter(t => t.id !== textId); });
}
/** Re-clamp every text of every piece (call after changing textMinMm/textMaxMm). Returns number changed. */
export function reclampAllTexts(doc: Document): number {
  return doc.transact('Clamp texts', s => {
    let n = 0;
    for (const p of s.pieces) for (const t of p.texts) { const c = clampTextSize(doc, t.size); if (c !== t.size) { t.size = c; n++; } }
    return n;
  });
}

export function textPosition(doc: Document, piece: Piece, t: TextAnnotation, sizeId?: SizeId): Vec {
  const line = doc.sizeLine(livePiece(doc, piece));
  const o = absoluteOffset(t.grade, line, sizeId ?? line.baseSizeId);
  return { x: t.x + o.x, y: t.y + o.y };
}

// ───────────────────────── artwork ─────────────────────────

export interface AddArtworkOptions {
  /** centre of the placement rectangle (base size) */
  x: number; y: number;
  /** TRUE source dimensions in mm (e.g. pixels / dpi × 25.4) */
  width: number; height: number;
  src: string;
  scaleX?: number; scaleY?: number; angleDeg?: number;
  grade?: GradeMap;
  name?: string;
}

/** Source size in mm from pixel dimensions and DPI. */
export function pixelsToMm(px: number, dpi: number): number { return (px / dpi) * 25.4; }

export function addArtwork(doc: Document, piece: Piece, o: AddArtworkOptions): Artwork {
  if (!(o.width > 0) || !(o.height > 0)) throw new Error('Artwork needs positive source dimensions');
  return doc.transact('Add artwork', () => {
    const a: Artwork = {
      id: newId('art'), x: o.x, y: o.y, grade: JSON.parse(JSON.stringify(o.grade ?? {})), width: o.width, height: o.height,
      scaleX: o.scaleX ?? 1, scaleY: o.scaleY ?? 1, angleDeg: normDeg(o.angleDeg ?? 0), src: o.src,
    };
    if (o.name) a.name = o.name;
    livePiece(doc, piece).artwork.push(a);
    return a;
  });
}

export function updateArtwork(doc: Document, piece: Piece, artId: Id, patch: Partial<Pick<Artwork, 'x' | 'y' | 'scaleX' | 'scaleY' | 'angleDeg' | 'name' | 'src'>>): Artwork {
  return doc.transact('Edit artwork', () => {
    const a = findArt(livePiece(doc, piece), artId);
    Object.assign(a, patch);
    if (patch.angleDeg !== undefined) a.angleDeg = normDeg(patch.angleDeg);
    return a;
  });
}
export function moveArtwork(doc: Document, piece: Piece, artId: Id, dx: number, dy: number): Artwork {
  return doc.transact('Move artwork', () => { const a = findArt(livePiece(doc, piece), artId); a.x += dx; a.y += dy; return a; });
}
export function rotateArtwork(doc: Document, piece: Piece, artId: Id, deg: number, absolute = false): Artwork {
  return doc.transact('Rotate artwork', () => { const a = findArt(livePiece(doc, piece), artId); a.angleDeg = normDeg(absolute ? deg : a.angleDeg + deg); return a; });
}
/** Scale to a target placed size in mm (either dimension optional; `keepAspect` mirrors the other). */
export function setArtworkPlacedSize(doc: Document, piece: Piece, artId: Id, w?: number, h?: number, keepAspect = true): Artwork {
  return doc.transact('Scale artwork', () => {
    const a = findArt(livePiece(doc, piece), artId);
    if (w !== undefined) a.scaleX = w / a.width;
    if (h !== undefined) a.scaleY = h / a.height;
    if (keepAspect && w !== undefined && h === undefined) a.scaleY = a.scaleX;
    if (keepAspect && h !== undefined && w === undefined) a.scaleX = a.scaleY;
    return a;
  });
}
export function deleteArtwork(doc: Document, piece: Piece, artId: Id): void {
  doc.transact('Delete artwork', () => { const p = livePiece(doc, piece); p.artwork = p.artwork.filter(a => a.id !== artId); });
}

/**
 * Placement rectangle of an artwork for a size: 4 corners [bottom-left, bottom-right, top-right,
 * top-left] in the artwork's own frame (before rotation), rotated CCW by angleDeg about its centre.
 * Placed size = width·|scaleX| × height·|scaleY|; a negative scale mirrors (corner order flips).
 */
export function artworkPlacementRect(doc: Document, piece: Piece, art: Artwork, sizeId?: SizeId): Vec[] {
  const line = doc.sizeLine(livePiece(doc, piece));
  const o = absoluteOffset(art.grade, line, sizeId ?? line.baseSizeId);
  const c = { x: art.x + o.x, y: art.y + o.y };
  const hw = (art.width * art.scaleX) / 2, hh = (art.height * art.scaleY) / 2;
  const local: Vec[] = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
  const r = rad(art.angleDeg);
  return local.map(p => rotate({ x: c.x + p.x, y: c.y + p.y }, r, c));
}
