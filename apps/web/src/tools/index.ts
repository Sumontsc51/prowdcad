import type { Tool } from './tool';
import { selectTool } from './select';
import { penTool } from './pen';
import { internalTool } from './internal';
import { rectTool, circleTool, polygonTool, roundRectTool } from './shapes';
import { zoomTool, handTool } from './misc';
import { measureTool, measureDistTool } from './measure';
import { notchTool, drillTool, textTool } from './marks';
import { seamTool } from './seam';
import { walkTool } from './walk';
import { smoothTool, slashTool, traceTool } from './construct';
import { pickTool } from './pick';
import { dartTool, pleatTool, fullnessTool } from './live';
import { movePointTool, moveLineTool, rotateTool, grainTool, curveTool } from './move';
import { cutPointTool } from './cutpoint';
import { clipTool } from './clip';
import { editDeltaTool } from './grade';

/** Palette order. Tools sharing `group` form one flyout button. */
export const TOOLS: Tool[] = [
  selectTool,
  movePointTool, moveLineTool, curveTool, smoothTool,   // Modify
  rotateTool, grainTool,                                 // Piece position
  internalTool, clipTool,                                // Lines
  rectTool, circleTool, polygonTool, roundRectTool,
  seamTool,
  notchTool, drillTool, textTool,
  cutPointTool,
  dartTool, pleatTool, fullnessTool,
  slashTool, traceTool,                                  // Piece build
  penTool, // not offered to the user (hidden, no key, no menu): kept for the automated test fixture
  editDeltaTool,                                         // Grade
  measureTool, measureDistTool, walkTool,                // Measure / Verify
  handTool, zoomTool,
  pickTool,
];

export const GROUP_TITLES: Record<string, string> = {
  select: 'Select', modify: 'Modify: Move Point · Move / Copy Line · Curve · Smooth', position: 'Piece position: Rotate · Grain / Flip', pen: 'Lines: Internal line · Clip Line',
  shape: 'Shapes', seam: 'Seam', marks: 'Notch / Drill / Text', cutpoint: 'Cut Point', live: 'Dart / Pleat / Fullness', cut: 'Piece build: Cut / Merge · Trace',
  grade: 'Grade: Edit Grade (copy, paste, flip, clear, stack, rules in its options)', measure: 'Measure / Verify: Lines · Distance · Walk', view: 'Navigate',
};
