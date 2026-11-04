/**
 * Bridge between the UI and the kernel ops modules (packages/kernel/src/ops/*, src/io/*).
 *
 * The UI calls ONLY `ops.<name>(...)`. Every entry starts as a placeholder that throws
 * NotWiredError (shown as an in-app "not wired yet" toast by the command runner). The integrator
 * wires a real op with `wireOps({ addDart: (doc, a) => addDart(doc, a), ... })` from main.ts —
 * no UI code changes needed.
 *
 * A few entries carry a FOUNDATION FALLBACK (marked `fallback:`) so the workspace stays usable
 * before the module lands: they only use model/contour/doc APIs and are replaced on wiring.
 */
import type { Document, Id, SizeId, Vec, NotchType, CornerType, Contour } from '@prowdcad/kernel';
import { absoluteOffset, absoluteToIncremental, incrementalToAbsolute, newId } from '@prowdcad/kernel';

export class NotWiredError extends Error {
  constructor(public op: string, public module: string) {
    super(`${op} is not wired yet (${module})`);
    this.name = 'NotWiredError';
  }
}

/** Reference to one anchor of one contour of one piece. */
export interface AnchorRef { pieceId: Id; contourId: Id; anchorId: Id }
/** A grade segment of a contour: from grade anchor `startAnchorId` to the next grade anchor. */
export interface SegmentRef { pieceId: Id; contourId: Id; startAnchorId: Id }

export type ExportFormat = 'dxf' | 'svg' | 'pdf' | 'plt';
export interface ExportOptions { pieceIds?: Id[]; sizeIds?: SizeId[]; flavor?: string; nested?: boolean }
export interface ExportResult { data: Blob | string; mime: string; ext: string }

export interface KernelOps {
  // seam.ts
  swapSewCut(doc: Document, pieceId: Id): void;
  setCornerType(doc: Document, a: AnchorRef, type: CornerType): void;
  // darts.ts / pleats.ts / fullness.ts
  addDart(doc: Document, args: { pieceId: Id; at: Vec; apex: Vec; width: number }): Id;
  rotateDart(doc: Document, args: { pieceId: Id; dartId: Id; target: Vec }): void;
  toggleDartClosed(doc: Document, args: { pieceId: Id; dartId: Id }): void;
  addPleat(doc: Document, args: { pieceId: Id; start: Vec; end: Vec; depth: number; type: 'box' | 'knife' }): Id;
  addFullness(doc: Document, args: { pieceId: Id; line: Vec[]; amount: number }): void;
  // walk.ts
  walkPieces(doc: Document, args: { a: SegmentRef; b: SegmentRef }): void;
  // measure.ts
  measurementChart(doc: Document): { name: string; values: Record<SizeId, number> }[];
  compareLengths(doc: Document, plus: SegmentRef[], minus: SegmentRef[]): Record<SizeId, number>;
  // scale.ts
  scalePiece(doc: Document, args: { pieceId: Id; sx: number; sy: number }): void;
  // points.ts
  addPointsEvenly(doc: Document, seg: SegmentRef, count: number): void;
  alignPoints(doc: Document, anchors: AnchorRef[], axis: 'x' | 'y'): void;
  pointAtDistance(doc: Document, seg: SegmentRef, dist: number, fromEnd: boolean): Id;
  // segments.ts
  setSegmentLength(doc: Document, seg: SegmentRef, length: number, method: string): void;
  // smooth.ts
  smoothSegment(doc: Document, seg: SegmentRef): void;
  // cut.ts
  cutPiece(doc: Document, args: { pieceId: Id; line: Vec[]; zeroGrade?: boolean }): Id[];
  // parallel.ts
  parallelLine(doc: Document, seg: SegmentRef, distance: number): void;
  // shapers.ts
  shaper(doc: Document, args: { pieceId: Id; kind: string }): void;
  // pieces.ts
  mirrorPiece(doc: Document, args: { pieceId: Id; axis: [Vec, Vec] }): void;
  combinePieces(doc: Document, pieceIds: Id[]): Id;
  // notches.ts / drills.ts / annotation.ts / binding.ts
  addNotchAtAnchor(doc: Document, a: AnchorRef, type: NotchType): Id;
  addDrill(doc: Document, args: { pieceId: Id; at: Vec; diameter: number }): Id;
  addText(doc: Document, args: { pieceId: Id; at: Vec; text: string; size: number }): Id;
  addBinding(doc: Document, seg: SegmentRef, width: number): Id;
  // grading.ts / sizes.ts / rules.ts / movement.ts
  dragGrade(doc: Document, a: AnchorRef, sizeId: SizeId, target: Vec): void;
  applyRule(doc: Document, anchors: AnchorRef[], ruleId: Id): void;
  addSize(doc: Document, args: { name: string; after?: SizeId }): SizeId;
  removeSize(doc: Document, sizeId: SizeId): void;
  setBaseSize(doc: Document, sizeId: SizeId): void;
  runMovement(doc: Document, programId: Id, delta: number): void;
  // io/*
  exportFile(doc: Document, format: ExportFormat, opt: ExportOptions): ExportResult;
  importFile(doc: Document, name: string, data: ArrayBuffer): void;
}

const MODULE: Record<keyof KernelOps, string> = {
  swapSewCut: 'ops/seam', setCornerType: 'ops/seam',
  addDart: 'ops/darts', rotateDart: 'ops/darts', toggleDartClosed: 'ops/darts', addPleat: 'ops/pleats', addFullness: 'ops/fullness',
  walkPieces: 'ops/walk', measurementChart: 'ops/measure', compareLengths: 'ops/measure', scalePiece: 'ops/scale',
  addPointsEvenly: 'ops/points', alignPoints: 'ops/points', pointAtDistance: 'ops/points',
  setSegmentLength: 'ops/segments', smoothSegment: 'ops/smooth', cutPiece: 'ops/cut', parallelLine: 'ops/parallel',
  shaper: 'ops/shapers', mirrorPiece: 'ops/pieces', combinePieces: 'ops/pieces',
  addNotchAtAnchor: 'ops/notches', addDrill: 'ops/drills', addText: 'ops/annotation', addBinding: 'ops/binding',
  dragGrade: 'ops/grading', applyRule: 'ops/rules', addSize: 'ops/sizes', removeSize: 'ops/sizes', setBaseSize: 'ops/sizes',
  runMovement: 'ops/movement', exportFile: 'io/*', importFile: 'io/*',
};

function placeholder<K extends keyof KernelOps>(name: K): KernelOps[K] {
  return ((..._args: unknown[]) => { throw new NotWiredError(name, MODULE[name]); }) as unknown as KernelOps[K];
}

// ───────────── foundation fallbacks ─────────────

function findContour(doc: Document, a: { pieceId: Id; contourId: Id }): Contour {
  const p = doc.piece(a.pieceId);
  const c = [p.sew, ...p.internals, ...(p.manualCut ? [p.manualCut] : [])].find(c => c.id === a.contourId);
  if (!c) throw new Error('Contour not found');
  return c;
}

/**
 * fallback: drag a nested size's anchor. Sets the anchor's ABSOLUTE offset for `sizeId` so the
 * graded position equals `target` (piece-local), then re-expresses grading incrementally.
 * Honors gradeAxisDeg by rotating the world delta into the anchor's grade axis.
 */
const dragGradeFallback: KernelOps['dragGrade'] = (doc, a, sizeId, target) => {
  doc.transact('Drag grade', () => {
    const piece = doc.piece(a.pieceId);
    const line = doc.sizeLine(piece);
    if (sizeId === line.baseSizeId) throw new Error('Base size is moved by editing the point itself');
    const c = findContour(doc, a);
    const anc = c.points.find(p => p.id === a.anchorId);
    if (!anc) throw new Error('Anchor not found');
    let d = { x: target.x - anc.x, y: target.y - anc.y };
    if (anc.gradeAxisDeg) { const r = -anc.gradeAxisDeg * Math.PI / 180; d = { x: d.x * Math.cos(r) - d.y * Math.sin(r), y: d.x * Math.sin(r) + d.y * Math.cos(r) }; }
    const abs = incrementalToAbsolute(anc.grade ?? {}, line);
    abs[sizeId] = { dx: d.x, dy: d.y };
    anc.grade = absoluteToIncremental(abs, line);
    void absoluteOffset;
  });
};

/** fallback: anchored notch with the style's notch setup. */
const addNotchFallback: KernelOps['addNotchAtAnchor'] = (doc, a, type) => doc.transact('Add notch', s => {
  const piece = doc.piece(a.pieceId);
  const setup = s.settings.notchSetup[type];
  const id = newId('n');
  piece.notches.push({ id, contourId: a.contourId, placement: { kind: 'anchor', anchorId: a.anchorId }, type, depth: setup.depth, width: setup.width, angleDeg: 0, mode: setup.mode, source: 'manual' });
  const anc = findContour(doc, a).points.find(p => p.id === a.anchorId);
  if (anc) anc.flags.notchAnchor = true;
  return id;
});

/** fallback: plain drill hole (no grading). */
const addDrillFallback: KernelOps['addDrill'] = (doc, args) => doc.transact('Add drill', () => {
  const id = newId('d');
  doc.piece(args.pieceId).drills.push({ id, x: args.at.x, y: args.at.y, grade: {}, diameter: args.diameter, kind: 'drill', mode: 'cut' });
  return id;
});

const FALLBACKS: Partial<KernelOps> = { dragGrade: dragGradeFallback, addNotchAtAnchor: addNotchFallback, addDrill: addDrillFallback };

export const ops: KernelOps = Object.fromEntries(
  (Object.keys(MODULE) as (keyof KernelOps)[]).map(k => [k, FALLBACKS[k] ?? placeholder(k)]),
) as unknown as KernelOps;

/** Which ops are still placeholders / fallbacks (for Help ▸ Kernel Ops status). */
const wired = new Set<keyof KernelOps>();
export function opStatus(): { name: keyof KernelOps; module: string; state: 'wired' | 'fallback' | 'stub' }[] {
  return (Object.keys(MODULE) as (keyof KernelOps)[]).map(name => ({
    name, module: MODULE[name], state: wired.has(name) ? 'wired' : FALLBACKS[name] ? 'fallback' : 'stub',
  }));
}

/** Integrator entry point: replace placeholders with real kernel ops. */
export function wireOps(impl: Partial<KernelOps>): void {
  for (const [k, fn] of Object.entries(impl)) {
    if (typeof fn !== 'function') continue;
    (ops as unknown as Record<string, unknown>)[k] = fn;
    wired.add(k as keyof KernelOps);
  }
}
