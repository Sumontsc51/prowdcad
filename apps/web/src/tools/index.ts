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

/** Palette order. Tools sharing `group` form one flyout button. */
export const TOOLS: Tool[] = [
  selectTool,
  movePointTool, moveLineTool, curveTool,
  rotateTool, grainTool,
  internalTool, smoothTool,
  rectTool, circleTool, polygonTool, roundRectTool,
  seamTool,
  notchTool, drillTool, textTool,
  cutPointTool,
  dartTool, pleatTool, fullnessTool,
  slashTool, traceTool,
  penTool, // not offered to the user (hidden, no key, no menu): kept for the automated test fixture
  measureTool, measureDistTool, walkTool,
  handTool, zoomTool,
  pickTool,
];

export const GROUP_TITLES: Record<string, string> = {
  select: 'Select', movepoint: 'Move Point', moveline: 'Move / Copy Line', curve: 'Curve / Handle', rotate: 'Rotate', grain: 'Grain / Flip', measuredist: 'Measure Distance', walk: 'Walk pieces', pen: 'Internal line', smooth: 'Smooth run', trace: 'Trace Piece', shape: 'Shapes', seam: 'Seam', marks: 'Notch / Drill / Text', cutpoint: 'Cut Point', live: 'Dart / Pleat', cut: 'Cut / Trace', measure: 'Measure / Walk', view: 'Navigate',
};
