/**
 * Bridge between the UI and the kernel ops modules (packages/kernel/src/ops/*, src/io/*).
 *
 * The UI calls kernel operations ONLY through `ops.<name>(...)`. Every entry starts as a
 * placeholder that throws NotWiredError (shown as an in-app "not wired yet" toast by the command
 * runner); `wireKernel()` (kernel-wiring.ts, called from main.ts) replaces them with the real
 * kernel functions. Entry signatures are exactly the kernel's (`Pick<typeof kernel, …>`), so the
 * UI is type-checked against the kernel's public API.
 *
 * Live-object modules that have not landed in the UI yet (darts / pleats / fullness) keep
 * hand-written signatures and stay placeholders until a later pass wires them.
 */
import type * as KT from '@prowdcad/kernel';
import type { Document, Id, Vec } from '@prowdcad/kernel';

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

/** Kernel functions reachable from the UI, grouped by module (module name is shown in Help ▸ Kernel ops). */
export const KERNEL_GROUPS = {
  'ops/seam': ['segmentSeams', 'cutLineForSize', 'cornerPointsForSize', 'setSeam', 'setSeamWholePiece', 'setGlobalSeam', 'deleteSeamSegment',
    'removeSeamPiece', 'removeSeamAll', 'setCorner', 'setCornerManual', 'revertCorner', 'trimCorner', 'setLockGrading', 'updateSeamGrading',
    'reseamPiece', 'reseamAll', 'reseamSegment', 'repairSeam', 'seamToInternal', 'internalToSeam', 'setCutModeAuto'],
  'ops/walk': ['startWalk', 'refreshWalk', 'walkStep', 'walkTo', 'flipDirection', 'setWalkRatio', 'walkReport', 'pieceTransform', 'applyTransform', 'dropNotch'],
  'ops/measure': ['measureRef', 'measureSegment', 'pointPos', 'measureXY', 'measureAngle', 'measureAcrossSizes', 'compareLengths', 'walkingCheck', 'segmentLengthSetTo', 'notchesOnSegment'],
  'ops/scale': ['scalePiece', 'pctToFactor'],
  'ops/points': ['addPointOnSegment', 'addPointAt', 'movePoint', 'moveAlongContour', 'moveProportional', 'multiMove', 'alignPoints', 'cornerAngle', 'setAngle',
    'roundCorner', 'addSplineSupportPoints', 'pointsCleanup', 'deletePoint', 'togglePointKind', 'setSmooth', 'breakHandle', 'joinHandle', 'setStartPoint'],
  'ops/segments': ['copySegment', 'pasteSegment', 'rotateSegmentPreservingLength', 'swapSegment', 'divideContour', 'joinContours', 'contourToDashedLines',
    'trimAtIntersections', 'globalCheckAndTrimInternals', 'globalJoinInternals', 'extendContour', 'extendInternal'],
  'ops/cut': ['slashPiece', 'cutAlongInternal', 'cutHV', 'cutByGuideline', 'cutParallel'],
  'ops/parallel': ['createParallelInternal', 'extendParallel'],
  'ops/shapers': ['shapeArc', 'shapeWave', 'shapeScallop', 'circularSkirt', 'ruffle'],
  'ops/pieces': ['traceSegments', 'regionAt', 'buildPiece', 'joinPieces', 'foldIn', 'foldOut', 'symmetryCheck', 'setHalf', 'openHalf', 'deleteHalf',
    'snapshotReference', 'restoreReference', 'showReference', 'clearReference', 'globalCheckConnections', 'globalClearConnections', 'lockPiece',
    'saveLayout', 'restoreLayout', 'saveActiveAsNew', 'replaceOld', 'mergeFromStyle', 'recenterGrain', 'grainParallelToSegment', 'rotatePieceToGrain'],
  'ops/smooth': ['smoothRun'],
  'ops/notches': ['resolveNotches', 'addNotch', 'addCornerNotch', 'placementAt', 'addNotchAtPoint', 'crossNotch', 'addPointsForNotches', 'globalNotchGrading',
    'notchDistanceGrid', 'setNotchDistance', 'fillAllNotchDistances', 'extrapolateNotchIncrement', 'pasteNotchGrid'],
  'ops/drills': ['drillPosition', 'addDrill', 'updateDrill', 'deleteDrill', 'duplicateWithOffset', 'multiButtons', 'slitContourSegment'],
  'ops/annotation': ['addText', 'textPosition', 'editText', 'deleteText', 'addArtwork', 'pixelsToMm', 'artworkPlacementRect', 'deleteArtwork'],
  'ops/binding': ['generateBinding'],
  'ops/grading': ['gradingTable', 'setGrade', 'dragGrade', 'copyGrading', 'pasteGrading', 'smartPaste', 'pasteGradingAround', 'flipX', 'flipY', 'deleteX',
    'deleteY', 'deleteAll', 'equalX', 'equalY', 'stackPoint', 'stackAlongLine', 'anchorRun', 'angleGrading', 'gradeParallel', 'gradeProportionally', 'gradedNest', 'gradedPosition'],
  'ops/sizes': ['insertSize', 'appendSize', 'removeSize', 'renameSize', 'setBase', 'setAxis2', 'deleteUngradedSizes', 'deleteInvisibleSizes', 'ungradedSizes', 'invisibleSizes'],
  'ops/rules': ['createLibrary', 'createRuleFromValues', 'createRuleFromPoint', 'createRuleSetFromContour', 'findRule', 'applyRule', 'detachRule', 'ruleName', 'loadSizesFromLibrary'],
  'ops/movement': ['createProgram', 'addMove', 'removeMove', 'applyMeasurementDelta', 'applyMeasurementSet', 'addMeasurementSet'],
  'io/dxf': ['importDXF', 'addImportToDocument', 'exportDXF'],
  'io/svg': ['importSVG', 'exportSVG'],
  'io/plt': ['importHPGL', 'exportHPGL'],
  'io/pdf': ['exportPDF'],
  'io/native': ['saveNative', 'loadNative', 'exportSizeAsStandalone'],
} as const;

export type KernelFnName = (typeof KERNEL_GROUPS)[keyof typeof KERNEL_GROUPS][number];
export const KERNEL_FNS: KernelFnName[] = Object.values(KERNEL_GROUPS).flat() as KernelFnName[];

/** Live-object ops (darts / pleats / fullness): placeholders — wired by a later pass. */
export interface LiveOps {
  addDart(doc: Document, args: { pieceId: Id; at: Vec; apex: Vec; width: number }): Id;
  rotateDart(doc: Document, args: { pieceId: Id; dartId: Id; target: Vec }): void;
  toggleDartClosed(doc: Document, args: { pieceId: Id; dartId: Id }): void;
  addPleat(doc: Document, args: { pieceId: Id; start: Vec; end: Vec; depth: number; type: 'box' | 'knife' }): Id;
  addFullness(doc: Document, args: { pieceId: Id; line: Vec[]; amount: number }): void;
}
export const LIVE_GROUPS: Record<keyof LiveOps, string> = {
  addDart: 'ops/darts', rotateDart: 'ops/darts', toggleDartClosed: 'ops/darts', addPleat: 'ops/pleats', addFullness: 'ops/fullness',
};

export type KernelOps = Pick<typeof KT, KernelFnName> & LiveOps;
export type OpName = keyof KernelOps;

const MODULE = {} as Record<OpName, string>;
for (const [mod, names] of Object.entries(KERNEL_GROUPS)) for (const n of names) MODULE[n as OpName] = mod;
for (const [n, mod] of Object.entries(LIVE_GROUPS)) MODULE[n as OpName] = mod;

function placeholder(name: OpName): unknown {
  return (..._args: unknown[]) => { throw new NotWiredError(name, MODULE[name]); };
}

export const ops: KernelOps = Object.fromEntries(
  (Object.keys(MODULE) as OpName[]).map(k => [k, placeholder(k)]),
) as unknown as KernelOps;

const wired = new Set<OpName>();
/** Which ops are wired / still placeholders (Help ▸ Kernel ops status). */
export function opStatus(): { name: OpName; module: string; state: 'wired' | 'stub' }[] {
  return (Object.keys(MODULE) as OpName[]).map(name => ({ name, module: MODULE[name], state: wired.has(name) ? 'wired' : 'stub' }));
}

/** Integrator entry point: replace placeholders with real implementations. */
export function wireOps(impl: Partial<KernelOps>): void {
  for (const [k, fn] of Object.entries(impl)) {
    if (typeof fn !== 'function' || !(k in MODULE)) continue;
    (ops as unknown as Record<string, unknown>)[k] = fn;
    wired.add(k as OpName);
  }
}
