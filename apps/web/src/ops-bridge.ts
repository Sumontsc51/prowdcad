/**
 * Bridge between the UI and the kernel ops modules (packages/kernel/src/ops/*, src/io/*).
 *
 * The UI calls kernel operations ONLY through `ops.<name>(...)`. Every entry starts as a
 * placeholder that throws NotWiredError (shown as an in-app "not wired yet" toast by the command
 * runner); `wireKernel()` (kernel-wiring.ts, called from main.ts) replaces them with the real
 * kernel functions. Entry signatures are exactly the kernel's (`Pick<typeof kernel, …>`), so the
 * UI is type-checked against the kernel's public API.
 *
 * Live objects (darts / pleats / fullness) are reached through their kernel functions
 * (ops/darts, ops/pleats, ops/fullness groups) plus four hand-written convenience wrappers
 * (`LiveOps`: addDart, rotateDart, toggleDartClosed, addPleat) wired in kernel-wiring.ts.
 */
import type * as KT from '@prowdcad/kernel';
import type { Document, Id, Vec } from '@prowdcad/kernel';

export class NotWiredError extends Error {
  constructor(public op: string, public module: string) {
    super(`${op} is not wired yet (${module})`);
    this.name = 'NotWiredError';
  }
}

/** Contour position for the live-object ops: base-size arc distance forward from a sew anchor (kernel `LiveContourPos`). */
export interface LiveContourPos { fromAnchorId: Id; distance: number }
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
  'ops/measure': ['measureRef', 'measureSegment', 'pointPos', 'measureXY', 'measureAngle', 'measureAcrossSizes', 'compareLengths', 'walkingCheck', 'segmentLengthSetTo', 'notchesOnSegment',
    'measurePart', 'cutPolyline', 'measureGroup', 'compareGroups', 'matchingSize', 'gradeByMeasurement'],
  'ops/scale': ['scalePiece', 'pctToFactor'],
  'ops/points': ['addPointOnSegment', 'addPointAt', 'movePoint', 'moveAlongContour', 'moveProportional', 'multiMove', 'alignPoints', 'cornerAngle', 'setAngle',
    'roundCorner', 'addSplineSupportPoints', 'pointsCleanup', 'deletePoint', 'togglePointKind', 'setSmooth', 'breakHandle', 'joinHandle', 'setStartPoint',
    'pinCurvePoints', 'curvePointFollows', 'addPointsOnSegment', 'cutPointDistances'],
  'ops/segments': ['copySegment', 'pasteSegment', 'rotateSegmentPreservingLength', 'swapSegment', 'divideContour', 'joinContours', 'contourToDashedLines',
    'trimAtIntersections', 'globalCheckAndTrimInternals', 'globalJoinInternals', 'extendContour', 'extendInternal'],
  'ops/cut': ['slashPiece', 'cutAlongInternal', 'cutHV', 'cutByGuideline', 'cutParallel'],
  'ops/parallel': ['createParallelInternal', 'extendParallel'],
  'ops/lock': ['lockInternalEnds', 'lockInternalParallel', 'lockInternalFollow', 'unlockInternal', 'setLockMeasure', 'setLockOffset', 'isLockDriven', 'lockSummary',
    'sewSegmentAt', 'lockableEnds', 'lockDistance', 'setLockRange', 'lockSpanLength'],
  'ops/shapers': ['shapeArc', 'shapeWave', 'shapeScallop', 'circularSkirt', 'ruffle'],
  'ops/pieces': ['traceSegments', 'regionAt', 'buildPiece', 'joinPieces', 'foldIn', 'foldOut', 'symmetryCheck', 'setHalf', 'openHalf', 'deleteHalf',
    'snapshotReference', 'restoreReference', 'showReference', 'clearReference', 'globalCheckConnections', 'globalClearConnections', 'lockPiece',
    'saveLayout', 'restoreLayout', 'saveActiveAsNew', 'replaceOld', 'mergeFromStyle', 'recenterGrain', 'grainParallelToSegment', 'rotatePieceToGrain', 'transformPieceLayouts'],
  'ops/smooth': ['smoothRun'],
  'ops/notches': ['resolveNotches', 'addNotch', 'addCornerNotch', 'placementAt', 'addNotchAtPoint', 'crossNotch', 'addPointsForNotches', 'globalNotchGrading',
    'notchDistanceGrid', 'setNotchDistance', 'fillAllNotchDistances', 'extrapolateNotchIncrement', 'pasteNotchGrid'],
  'ops/drills': ['drillPosition', 'addDrill', 'updateDrill', 'deleteDrill', 'duplicateWithOffset', 'multiButtons', 'slitContourSegment'],
  'ops/annotation': ['addText', 'textPosition', 'editText', 'deleteText', 'addArtwork', 'pixelsToMm', 'artworkPlacementRect', 'deleteArtwork'],
  'ops/binding': ['generateBinding'],
  'ops/darts': ['createDart', 'createMultiDarts', 'fixDart', 'moveDartApex', 'setDartDepth', 'setDartFold', 'setDartDrillOffset', 'changeDarts',
    'transferDart', 'rotateDartAroundCenter', 'closeDart', 'openDart', 'closeAllDarts', 'openAllDarts', 'setDartCutting', 'cutAllDarts',
    'copyDart', 'pasteDart', 'removeDart', 'insertDart', 'dartSewGeometry', 'dartInfo', 'dartClosedPerimeter', 'dartCutShape', 'createDartByLegs', 'dartLegSpan'],
  'ops/pleats': ['addPleatAxis', 'addPleatByAngle', 'addMultiPleat', 'setPleatAttributes', 'openPleats', 'closePleats', 'openPleat', 'closePleat',
    'deletePleat', 'pleatOpenings', 'pleatFabric', 'addPleatSet', 'pleatSetAxes'],
  'ops/fullness': ['addFullness', 'addMultiFullness', 'deleteFullness', 'fullnessOpenings', 'fullnessRecord', 'addFullnessBetween', 'setFullnessOpenings'],
  'ops/grading': ['gradingTable', 'setGrade', 'dragGrade', 'copyGrading', 'pasteGrading', 'smartPaste', 'pasteGradingAround', 'flipX', 'flipY', 'deleteX',
    'deleteY', 'deleteAll', 'equalX', 'equalY', 'stackPoint', 'stackAlongLine', 'anchorRun', 'angleGrading', 'gradeParallel', 'gradeProportionally', 'gradedNest', 'gradedPosition', 'setGradeRow'],
  'ops/sizes': ['insertSize', 'appendSize', 'removeSize', 'renameSize', 'setBase', 'setAxis2', 'deleteUngradedSizes', 'deleteInvisibleSizes', 'ungradedSizes', 'invisibleSizes'],
  'ops/rules': ['createLibrary', 'createRuleFromValues', 'createRuleFromPoint', 'createRuleSetFromContour', 'findRule', 'applyRule', 'detachRule', 'ruleName', 'loadSizesFromLibrary',
    'refreshRuleLinks', 'outwardSteps', 'totalsFromSteps', 'affectedSizes', 'smartFill', 'sizeBreaks', 'setSizeBreaks', 'setRuleValues', 'copyRule', 'renameRule', 'deleteRule', 'gradeStatus'],
  'ops/spec': ['addSpecItem', 'updateSpecItem', 'setSpecTargets', 'removeSpecItem', 'specValue', 'specRows', 'defaultSpecMovers', 'applySpec'],
  'ops/movement': ['createProgram', 'addMove', 'removeMove', 'applyMeasurementDelta', 'applyMeasurementSet', 'addMeasurementSet'],
  'io/dxf': ['importDXF', 'addImportToDocument', 'exportDXF'],
  'io/svg': ['importSVG', 'exportSVG'],
  'io/plt': ['importHPGL', 'exportHPGL'],
  'io/pdf': ['exportPDF'],
  'io/native': ['saveNative', 'loadNative', 'exportSizeAsStandalone'],
} as const;

export type KernelFnName = (typeof KERNEL_GROUPS)[keyof typeof KERNEL_GROUPS][number];
export const KERNEL_FNS: KernelFnName[] = Object.values(KERNEL_GROUPS).flat() as KernelFnName[];

/**
 * Convenience wrappers over the live-object kernel ops (one undo step each). Wired in
 * kernel-wiring.ts → `liveOpsImpl`.
 */
export interface LiveOps {
  /** createDart: centre on a contour position (or an existing sew anchor); apex by depth or explicit point (then Fix Dart) */
  addDart(doc: Document, args: { pieceId: Id; at: LiveContourPos | { anchorId: Id }; width: number; depth?: number; apex?: Vec; fold?: 'A' | 'B'; drillOffset?: number }): Id;
  /** pivot transfer (`transferDart`, default 100 %), or Rotate Around offset Center when `center` is given (`rotateDartAroundCenter`) */
  rotateDart(doc: Document, args: { pieceId: Id; dartId: Id; target: LiveContourPos; pct?: number; pivot?: Vec; center?: Vec }): Id;
  /** close an open dart / reopen a closed one (`width` undefined = exact restore) */
  toggleDartClosed(doc: Document, args: { pieceId: Id; dartId: Id; width?: number }): void;
  /** Add Pleat Axis with attributes, opened when `open` and depth > 0 */
  addPleat(doc: Document, args: { pieceId: Id; start: Vec; end: Vec; attrs?: KT.PleatAttributes; open?: boolean }): Id;
}
export const LIVE_GROUPS: Record<keyof LiveOps, string> = {
  addDart: 'ops/darts', rotateDart: 'ops/darts', toggleDartClosed: 'ops/darts', addPleat: 'ops/pleats',
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
