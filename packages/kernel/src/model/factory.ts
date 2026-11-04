import type { Anchor, Contour, Piece, SizeLine, SizeTable, Style, SizeId, GradeInc, NotchType } from './types';
import type { Vec } from '../geom/vec';

let counter = 0;
/** Short unique ids: time-sortable prefix + counter (deterministic enough for tests when seeded via resetIds). */
export function newId(prefix = 'o'): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}
export function resetIds() { counter = 0; }

export const now = () => new Date().toISOString();

export function makeAnchor(x: number, y: number, opt: Partial<Anchor> = {}): Anchor {
  return { id: newId('p'), x, y, kind: 'grade', smooth: false, grade: {}, flags: {}, ...opt };
}
export const gradePoint = (x: number, y: number, opt: Partial<Anchor> = {}) => makeAnchor(x, y, { kind: 'grade', smooth: false, ...opt });
export const curvePoint = (x: number, y: number, opt: Partial<Anchor> = {}) => makeAnchor(x, y, { kind: 'curve', smooth: true, ...opt });

export function makeContour(points: Anchor[], opt: Partial<Contour> = {}): Contour {
  return { id: newId('c'), type: 'perimeter', closed: true, points, ...opt };
}

export function makeSizeLine(names: string[], baseName: string, opt: Partial<SizeLine> = {}): SizeLine {
  const sizes = names.map(n => ({ id: newId('s'), name: n }));
  const base = sizes.find(s => s.name === baseName) ?? sizes[Math.floor(sizes.length / 2)];
  return { id: newId('sl'), name: opt.name ?? 'Sizes', sizes, baseSizeId: base.id, ...opt };
}

export function makeSizeTable(line: SizeLine, name = 'Default'): SizeTable {
  return { id: newId('st'), name, axis1: line };
}

export function makePiece(name: string, sew: Contour, sizeTableId: string, opt: Partial<Piece> = {}): Piece {
  const t = now();
  return {
    id: newId('pc'), name, sew, seamDefault: 10, noSeam: false, cutMode: 'auto', lockGrading: false,
    internals: [], darts: [], pleats: [], notches: [], drills: [], texts: [], artwork: [],
    grain: { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, gradeA: {}, gradeB: {}, centered: true },
    connections: [], locked: false, activeContour: 'sew', sizeTableId,
    order: { material: 'SELF', qtyPerBundle: 1, side: 'none', opposite: false, rotation: '2way', maxTiltDeg: 0, foldAllowed: false, cutContourOnly: false },
    version: 0, createdAt: t, updatedAt: t, ...opt,
  };
}

/** Rectangle bootstrap block (new-file default). Anchors CCW in a y-up frame starting bottom-left. */
export function rectangleContour(x: number, y: number, w: number, h: number): Contour {
  const pts = [gradePoint(x, y, { flags: { startPoint: true } }), gradePoint(x + w, y), gradePoint(x + w, y + h), gradePoint(x, y + h)];
  return makeContour(pts);
}

export function circleContour(cx: number, cy: number, r: number, segments = 8): Contour {
  const pts: Anchor[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(makeAnchor(cx + Math.cos(a) * r, cy + Math.sin(a) * r, { kind: i % 2 === 0 ? 'grade' : 'curve', smooth: true, flags: i === 0 ? { startPoint: true } : {} }));
  }
  return makeContour(pts);
}

export function polygonContour(center: Vec, r: number, sides: number): Contour {
  const pts: Anchor[] = [];
  for (let i = 0; i < sides; i++) { const a = (i / sides) * Math.PI * 2 + Math.PI / 2; pts.push(gradePoint(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r, { flags: i === 0 ? { startPoint: true } : {} })); }
  return makeContour(pts);
}

export function roundedRectContour(x: number, y: number, w: number, h: number, r: number): Contour {
  r = Math.min(r, w / 2, h / 2);
  const k = 0.5523 * r; // circular-arc Bézier constant
  const P: Anchor[] = [];
  const add = (px: number, py: number, hIn?: Vec, hOut?: Vec) => P.push(gradePoint(px, py, { smooth: !!(hIn || hOut), hIn, hOut }));
  add(x + r, y, undefined, undefined);
  add(x + w - r, y, undefined, { x: k, y: 0 });
  add(x + w, y + r, { x: 0, y: -k }, undefined);
  add(x + w, y + h - r, undefined, { x: 0, y: k });
  add(x + w - r, y + h, { x: k, y: 0 }, undefined);
  add(x + r, y + h, undefined, { x: -k, y: 0 });
  add(x, y + h - r, { x: 0, y: k }, undefined);
  add(x, y + r, undefined, { x: 0, y: -k });
  P[0].hIn = { x: -k, y: 0 }; P[0].smooth = true;
  P[0].flags.startPoint = true;
  return makeContour(P);
}

export const DEFAULT_NOTCH_SETUP: Record<NotchType, { depth: number; width: number; mode: 'draw' | 'cut' }> = {
  slit: { depth: 5, width: 0, mode: 'cut' },
  T: { depth: 5, width: 2, mode: 'cut' },
  V: { depth: 5, width: 3, mode: 'cut' },
  U: { depth: 5, width: 3, mode: 'cut' },
  castle: { depth: 5, width: 3, mode: 'cut' },
};

export function makeStyle(name = 'Untitled', sizeNames = ['XS', 'S', 'M', 'L', 'XL'], base = 'M'): Style {
  const line = makeSizeLine(sizeNames, base);
  const table = makeSizeTable(line);
  const t = now();
  return {
    schema: 'prowdcad/2', id: newId('st'), name, units: 'mm', fractionDenominator: 8,
    pieces: [], sizeTables: [table], activeSizeTableId: table.id,
    ruleLibraries: [], movementPrograms: [], measurementSets: [], pieceArchive: [], layouts: {},
    settings: { autoReseam: true, pointConnectionOnSnap: 'always', textMinMm: 3, textMaxMm: 50, notchSetup: { ...DEFAULT_NOTCH_SETUP } },
    meta: {}, createdAt: t, updatedAt: t,
  };
}

export function zeroGrade(line: SizeLine): Record<SizeId, GradeInc> {
  const g: Record<SizeId, GradeInc> = {}; for (const s of line.sizes) g[s.id] = { dx: 0, dy: 0 }; return g;
}
