/**
 * ProwdCAD native document model (JSON-serialisable). Internal units: mm, float64.
 * Every geometric entity stores BASE-SIZE coordinates plus incremental grading.
 */
import type { Vec } from '../geom/vec';
import type { Unit } from '../units';

export type Id = string;
export type SizeId = string;

export interface GradeInc { dx: number; dy: number }

/** Corner treatment of the CUT line at a sew-line grade point. */
export type CornerType =
  | 'miter'        // default: intersection of the two offset edges
  | 'boxed'        // square corner: extend each seam straight past the corner (folded-back ends)
  | 'turnback'     // mirrored / turn-back corner (hem folds): mirror the adjacent seam across the corner
  | 'angled'       // bevel: chamfer between the two offset edges
  | 'manual';      // user-drafted custom corner shape (≤10 points) in the piece's local frame

export interface CornerSpec {
  type: CornerType;
  /** boxed: which side extends — 'prev' | 'next' | 'both' */
  extend?: 'prev' | 'next' | 'both';
  /** manual: polyline from sew-corner-side to cut-line, base-size absolute coordinates */
  manualPoints?: Vec[];
  /** manual (per size), filled when Lock Grading stamps the base corner onto all sizes */
  lockedPerSize?: Record<SizeId, Vec[]>;
}

export interface AnchorFlags {
  locked?: boolean;
  /** point #1: rule application order starts here, cutter plunge point */
  startPoint?: boolean;
  /** anchored notch sits here */
  notchAnchor?: boolean;
  /** point is a dart leg / apex / pleat edge (created by live objects, do not hand-edit) */
  dartLeg?: boolean;
  pleatEdge?: boolean;
  /** zero-grade cut point (created by Cut with "zero grade") */
  zeroGrade?: boolean;
  /** derived (eg. half-piece mirror) — not user editable */
  derived?: boolean;
}

export interface Anchor {
  id: Id;
  x: number;
  y: number;
  /** grading point (corner / rule carrier) vs intermediate curve point */
  kind: 'grade' | 'curve';
  /** curvature continuity through this point. Corners are smooth=false. */
  smooth: boolean;
  /** Explicit Bézier handles, RELATIVE offsets from (x,y). When absent, centripetal Catmull-Rom supplies the tangent. */
  hIn?: Vec;
  hOut?: Vec;
  name?: string;
  /** incremental grading: inc[size_i] = abs[size_i] − abs[size_{i−1}] in size-line order (first size = 0; abs[base] = 0). Missing entry = {0,0}. */
  grade: Record<SizeId, GradeInc>;
  /** two-axis Size Variation: incremental grading keyed by SizeTable.axis2 sizes (same convention as grade). */
  grade2?: Record<SizeId, GradeInc>;
  /** rule library reference (number/name); grade[] holds the materialised values */
  ruleId?: string;
  /** angle-grading: local axis rotation in degrees (0 = world) */
  gradeAxisDeg?: number;
  /** seam allowance of the segment that LEAVES this grade point (to the next grade point). undefined → piece default */
  seamAfter?: number;
  corner?: CornerSpec;
  flags: AnchorFlags;
}

export type ContourType = 'perimeter' | 'internal' | 'grain' | 'seamline' | 'guide' | 'dartAxis' | 'pleatAxis' | 'fold' | 'mirror';

export interface Contour {
  id: Id;
  type: ContourType;
  closed: boolean;
  points: Anchor[];
  name?: string;
  /** for named internal lines used by the Measurement Chart: '/m' measure tag, '/q1' single-of-pair */
  measureTag?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  /** draw vs cut (plot/cut mode) */
  mode?: 'draw' | 'cut';
  /**
   * (internal lines) lock to the sew line, re-applied after every edit in every size (ops/lock.ts).
   * Absent = free internal.
   */
  lock?: ContourLock;
}

// ───────────── internal-line locks (ops/lock.ts) ─────────────

/**
 * How a position along a locked sew span is kept when the span changes length or grades:
 * 'ratio' = the same fraction of the span length (AccuMark proportional, default);
 * 'start' = the same distance (mm) from the span start; 'end' = the same distance from the span end.
 */
export type LockMeasure = 'ratio' | 'start' | 'end';

/**
 * One end point of an internal line attached to a sew span. The span runs forward along the sew line
 * from anchor `from` to anchor `to` (the grade points bounding the segment at lock time; points later
 * inserted between them stay inside the span). `value` = fraction 0…1 ('ratio') or mm ('start' / 'end').
 */
export interface LockEnd { anchorId: Id; from: Id; to: Id; measure: LockMeasure; value: number }

export type ContourLock =
  /** Endpoints attached: each listed end point stays on its sew span at its kept position. */
  | { kind: 'ends'; ends: LockEnd[] }
  /**
   * Parallel: the whole internal is regenerated as the offset of the sew span `from → to` by `offset` mm
   * (positive = inside the piece), between the span positions `a` and `b` (kept as `measure`).
   */
  | { kind: 'parallel'; from: Id; to: Id; offset: number; measure: LockMeasure; a: number; b: number }
  /**
   * Rigid follow: the internal translates with sew anchor `anchorId`, per size. `ref` = that anchor's
   * per-size position the internal was last placed for (bookkeeping; updated by every re-apply).
   */
  | { kind: 'follow'; anchorId: Id; ref: Record<SizeId, { x: number; y: number }> };

// ───────────── live objects ─────────────

export interface Dart {
  id: Id;
  /** anchor ids on the SEW contour: leg A (first in contour order), leg B, apex (internal point) */
  legA: Id;
  legB: Id;
  apex: { x: number; y: number; grade: Record<SizeId, GradeInc>; grade2?: Record<SizeId, GradeInc> };
  /** fold direction: towards A or towards B (determines cut-line dart shape) */
  fold: 'A' | 'B';
  /** drill hole distance back from apex along dart axis (mm) */
  drillOffset: number;
  /** closed = zero width, legs coincide, dashed axis kept; remembers open width */
  closed: boolean;
  rememberedWidth?: number;
  /** when converted to a physically cut-out shape */
  cutting?: boolean;
  name?: string;
  /** (darts module) id of the dashed 'dartAxis' internal contour kept while the dart is closed */
  axisContourId?: Id;
  /** (darts module) Fullness record / op that created this dart (Insert Dart) */
  sourceFullnessId?: Id;
  /** (darts module) exact copies of the leg anchors taken at Close, restored by reopen */
  closedLegs?: Anchor[];
  /** (darts module) seam allowance kept on each leg of a Cutting Dart (default 0 = cut on the legs) */
  cutSeam?: number;
}

/** Pleat kind. */
export type PleatType = 'knife' | 'box' | 'inverted';

export interface Pleat {
  id: Id;
  /** knife = one fold (2 × depth); box = two folds facing away from the centre; inverted = inverted box, folds meeting at the centre (box / inverted: 4 × depth) */
  type: PleatType;
  /** two anchor ids on the SEW contour bounding the pleat on the first edge; axis defined by start/end points */
  axisStart: { x: number; y: number; grade: Record<SizeId, GradeInc>; grade2?: Record<SizeId, GradeInc> };
  axisEnd: { x: number; y: number; grade: Record<SizeId, GradeInc>; grade2?: Record<SizeId, GradeInc> };
  /** depth at start and end (variable depth = tapered) */
  depthStart: number;
  depthEnd: number;
  fold: 'left' | 'right';
  open: boolean;
  autoNotches: boolean;
  name?: string;
  /** (pleats module) pleat-edge anchors on the sew contour while OPEN, one entry per axis crossing (start crossing first) */
  edges?: PleatEdge[];
  /** (pleats module) which side of the axis (start→end) is translated when opening. Default 'right'. */
  moveSide?: 'left' | 'right';
  /** (pleats module) id of the dashed 'pleatAxis' internal contour */
  axisContourId?: Id;
  /** (pleats module) auto-notch ids written onto piece.notches while open */
  notchIds?: Id[];
  /** (pleats module) sew anchors inserted by the open state (ids are re-used on re-open) */
  insertedIds?: Id[];
  /** (pleats module) pre-open copy of everything the open transform moved; restored verbatim on close */
  snapshot?: LiveSnapshot;
  /** (pleats/fullness) order in the piece's live spread stack (LIFO close/re-apply) */
  openSeq?: number;
  /** (pleats module) which axis crossing gets the auto notches. Default 'start'. */
  notchAt?: 'start' | 'end' | 'both';
  /** (pleats module) ids reserved for the anchors the open state inserts (stable across close/re-open) */
  slotIds?: Id[];
}

/** (pleats module) anchors inserted where a pleat axis crosses the sew contour. `mid` = box-pleat centre fold. */
export interface PleatEdge { fixed: Id; moving: Id; mid?: Id }

/**
 * (pleats/fullness/darts) Pre-op copy of everything a reversible spread moved.
 * anchors: sew + internal anchors (by id). apexes: dart apexes by dart id; pleat axis ends use the keys
 * `pleatStart:<pleatId>` / `pleatEnd:<pleatId>`. drills: drills by id; text annotations use `text:<textId>`.
 */
export interface LiveSnapshot {
  anchors: Anchor[];
  apexes: { dartId: Id; apex: { x: number; y: number; grade: Record<SizeId, GradeInc>; grade2?: Record<SizeId, GradeInc> } }[];
  drills: { id: Id; x: number; y: number; grade: Record<SizeId, GradeInc>; grade2?: Record<SizeId, GradeInc> }[];
}

/** Contour position stored id-relative (stable across inserts): arc distance (mm, base) forward from a sew anchor. */
export interface ContourPosRef { fromAnchor: Id; dist: number }

/** Parameters of a fullness op, kept so a record can be re-applied after a LIFO unwind. */
export type FullnessOp =
  | { kind: 'single'; slash: ContourPosRef; pivot: ContourPosRef | { x: number; y: number }; openA: number; openB: number; mode: 'rotate' | 'parallel'; side: 'forward' | 'backward' }
  | { kind: 'multi'; slashes: ContourPosRef[]; hinges: ContourPosRef[]; widths: number[]; mode: 'rotate' | 'parallel'; side: 'forward' | 'backward' };

/** Slash & spread record (fullness module). */
export interface Fullness {
  id: Id;
  /** sew anchors inserted at the slash(es): [fixed, moving] per slash, flattened */
  slashAnchorIds: Id[];
  /** hinge: a sew anchor id (pivot on contour) or an internal point */
  pivot: { anchorId: Id } | { x: number; y: number };
  amounts: { openA: number; openB: number };
  mode?: 'rotate' | 'parallel';
  /** every anchor id inserted by this record (slash + hinge anchors), removed on delete, re-used on re-apply */
  insertedIds?: Id[];
  /** hinge anchor ids on the contour, flattened pairs per slash ([h, h] when the hinge is a single pivot anchor) */
  hingeIds?: Id[];
  /** multi fullness: per-slash amounts */
  perSlash?: { openA: number; openB: number }[];
  /** pre-op copy of everything the spread moved */
  snapshot?: LiveSnapshot;
  /** position in the piece's live spread stack */
  seq?: number;
  op?: FullnessOp;
  /** internal pivot only: signed opening at the far hinge (negative = overlap), mm base size */
  hingeOpen?: number;
  /** Insert Dart: dart created together with this record */
  dartId?: Id;
  /** ids reserved for the anchors this record inserts (stable across LIFO unwind/re-apply) */
  slotIds?: Id[];
}

export type NotchType = 'slit' | 'T' | 'V' | 'U' | 'castle';

export type NotchPlacement =
  | { kind: 'anchor'; anchorId: Id }
  | { kind: 'fromPrev'; anchorId: Id; dist: Record<SizeId, number> }
  | { kind: 'fromNext'; anchorId: Id; dist: Record<SizeId, number> }
  | { kind: 'proportional'; anchorId: Id; pct: number };

export interface Notch {
  id: Id;
  contourId: Id;
  placement: NotchPlacement;
  type: NotchType;
  depth: number;
  width: number;
  /** angle relative to contour normal, degrees (0 = perpendicular) */
  angleDeg: number;
  /** corner notch direction */
  cornerDir?: 'prev' | 'next';
  mode?: 'draw' | 'cut';
  /** walk-support / pleat auto notch etc. */
  source?: 'manual' | 'walk' | 'pleat' | 'dart' | 'slit' | 'cross';
  /** proportional placement: measure pct over anchorId → spanEndAnchorId instead of anchorId → next grade anchor */
  spanEndAnchorId?: Id;
  /** free-form tag (e.g. 'binding-break' for binding support notches) */
  tag?: string;
  name?: string;
}

export interface Drill {
  id: Id;
  x: number; y: number;
  grade: Record<SizeId, GradeInc>;
  grade2?: Record<SizeId, GradeInc>;
  diameter: number;
  kind: 'drill' | 'button' | 'buttonhole';
  mode: 'draw' | 'cut';
  name?: string;
  /** B5 match: lock this element to the repeat grid */
  matchIndex?: number;
  matchUseX?: boolean;
  matchUseY?: boolean;
}

export interface TextAnnotation {
  id: Id;
  x: number; y: number; grade: Record<SizeId, GradeInc>;
  grade2?: Record<SizeId, GradeInc>;
  text: string;
  size: number;      // mm
  angleDeg: number;
  draggable?: boolean;
}

export interface Artwork {
  id: Id;
  x: number; y: number; grade: Record<SizeId, GradeInc>;
  grade2?: Record<SizeId, GradeInc>;
  /** true source dimensions (mm) */
  width: number; height: number;
  scaleX: number; scaleY: number;
  angleDeg: number;
  /** data URL or asset key */
  src: string;
  name?: string;
}

export interface GrainLine {
  a: Vec; b: Vec;
  gradeA: Record<SizeId, GradeInc>;
  gradeB: Record<SizeId, GradeInc>;
  /** axis2 grading of a / b (two-axis Size Variation) */
  gradeA2?: Record<SizeId, GradeInc>;
  gradeB2?: Record<SizeId, GradeInc>;
  /** fixed to piece centre */
  centered?: boolean;
}

export interface HalfSpec {
  /** mirror axis, two base-size points */
  a: Vec; b: Vec;
  /** 'auto' = opens at plot/marker */
  openAtOutput: boolean;
}

export interface ReferenceBlock {
  timestamp: string;
  sew: Contour;
  internals: Contour[];
  note?: string;
}

export interface PointConnection {
  /** internal anchor locked to external anchor; moves together */
  internalContourId: Id;
  internalAnchorId: Id;
  externalAnchorId: Id;
}

export interface PieceOrderDefaults {
  material: string;
  qtyPerBundle: number;
  side: 'L' | 'R' | 'LR' | 'none';
  opposite: boolean;
  rotation: '1way' | '2way' | '4way' | 'free';
  maxTiltDeg: number;
  foldAllowed: boolean;
  cutContourOnly: boolean;
}

/**
 * Placement of a piece on the drafting sheet (display / marker placement only: exporters write the
 * authored piece geometry and never apply the layout). world = R(angleDeg) · F · local + (x, y), where
 * F mirrors the local x axis (`flipX`) and / or the local y axis (`flipY`). A flipX + flipY pair is the
 * same as a 180° rotation; `flipPieceLayout` normalises it away.
 */
export interface PieceLayout { x: number; y: number; angleDeg: number; flipX?: boolean; flipY?: boolean }

export interface Piece {
  id: Id;
  name: string;
  description?: string;
  /** MASTER contour: the sew line */
  sew: Contour;
  /** piece-wide default seam allowance (mm). Per-segment overrides live on Anchor.seamAfter */
  seamDefault: number;
  /** true when the piece has no seam engineering: cut == sew */
  noSeam: boolean;
  /** 'auto' regenerates the cut line; 'manual' keeps a user-drawn cut contour */
  cutMode: 'auto' | 'manual';
  manualCut?: Contour;
  /** Lock Grading: stamp base-size engineered corners onto every size */
  lockGrading: boolean;
  internals: Contour[];
  darts: Dart[];
  pleats: Pleat[];
  /** slash & spread records (fullness module), reversible via deleteFullness */
  fullness?: Fullness[];
  notches: Notch[];
  drills: Drill[];
  texts: TextAnnotation[];
  artwork: Artwork[];
  grain: GrainLine;
  half?: HalfSpec;
  reference?: ReferenceBlock;
  connections: PointConnection[];
  locked: boolean;
  activeContour: 'sew' | 'cut';
  sizeTableId: Id;
  /** which sizes exist for this piece (subset of the size table). undefined → all */
  sizes?: SizeId[];
  order: PieceOrderDefaults;
  /** versioning: FRONT, FRONT_1, FRONT_2 … */
  version: number;
  /** B5 engineered matching authored in design */
  matchIndex?: number;
  layout?: PieceLayout;
  createdAt: string;
  updatedAt: string;
}

// ───────────── sizes & grading ─────────────

export interface SizeDef { id: SizeId; name: string; /** display colour for nested view */ color?: string }

export interface SizeLine {
  id: Id;
  name: string;
  sizes: SizeDef[];       // ordered small → large
  baseSizeId: SizeId;
}

/** Two-axis variation table: sizes = axis1 × axis2 (e.g. waist × inseam). Combined only at marker-order time. */
export interface SizeTable {
  id: Id;
  name: string;
  axis1: SizeLine;
  axis2?: SizeLine;
  /** set by combineTables(): this single-axis table was flattened (one-way) from a two-axis table */
  combinedFrom?: Id;
  /** combined (axis1×axis2 flattened) tables are discouraged: grading can no longer be edited per axis */
  discouraged?: boolean;
  /** combined table: new size id → [axis1 size id, axis2 size id] of the source table */
  combinedPairs?: Record<SizeId, [SizeId, SizeId]>;
}

export interface GradeRule {
  id: Id;
  number: number;
  name: string;
  inc: Record<SizeId, GradeInc>;
  sizeLineId: Id;
  description?: string;
}

export interface RuleLibrary {
  id: Id;
  name: string;
  sizeLine: SizeLine;
  rules: GradeRule[];
}

/** Movement program: mm of point displacement per +1 mm of a named measurement. */
export interface MovementProgram {
  id: Id;
  name: string;
  measurement: string;             // e.g. "chest"
  moves: { pieceId: Id; anchorId: Id; dx: number; dy: number }[]; // per +1 mm
}

export interface MeasurementSet {
  id: Id;
  name: string;
  values: Record<string, number>;  // measurement name → mm
}

// ───────────── style (document root) ─────────────

export interface StyleMeta {
  trim?: string;
  outsideWork?: string;
  specialInstructions?: string;
  previewPng?: string;
  customer?: string;
  season?: string;
}

export interface Style {
  schema: 'prowdcad/2';
  id: Id;
  name: string;
  units: Unit;
  fractionDenominator?: number;
  pieces: Piece[];
  sizeTables: SizeTable[];
  activeSizeTableId: Id;
  ruleLibraries: RuleLibrary[];
  movementPrograms: MovementProgram[];
  measurementSets: MeasurementSet[];
  /** archived piece versions (Replace Old / Save Active As New) */
  pieceArchive: Piece[];
  /** named layouts (Save/Restore Layout) */
  layouts: Record<string, Record<Id, PieceLayout>>;
  settings: {
    autoReseam: boolean;
    pointConnectionOnSnap: 'always' | 'ask' | 'never';
    textMinMm: number;
    textMaxMm: number;
    notchSetup: Record<NotchType, { depth: number; width: number; mode: 'draw' | 'cut' }>;
  };
  meta: StyleMeta;
  createdAt: string;
  updatedAt: string;
}
