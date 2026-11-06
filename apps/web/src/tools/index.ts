import type { Tool } from './tool';
import { selectTool } from './select';
import { penTool } from './pen';
import { internalTool } from './internal';
import { rectTool, circleTool, polygonTool, roundRectTool } from './shapes';
import { measureTool, zoomTool, handTool } from './misc';
import { notchTool, drillTool, textTool } from './marks';
import { seamTool } from './seam';
import { walkTool } from './walk';
import { smoothTool, slashTool, traceTool } from './construct';
import { pickTool } from './pick';
import { dartTool, pleatTool, fullnessTool } from './live';
import { movePointTool, moveLineTool, pieceTool, curveTool } from './move';

/** Palette order. Tools sharing `group` form one flyout button. */
export const TOOLS: Tool[] = [
  selectTool,
  movePointTool, moveLineTool, pieceTool, curveTool,
  penTool, internalTool, smoothTool,
  rectTool, circleTool, polygonTool, roundRectTool,
  seamTool,
  notchTool, drillTool, textTool,
  dartTool, pleatTool, fullnessTool,
  slashTool, traceTool,
  measureTool, walkTool,
  handTool, zoomTool,
  pickTool,
];

export const GROUP_TITLES: Record<string, string> = {
  select: 'Select', move: 'Move', pen: 'Pens', shape: 'Shapes', seam: 'Seam', marks: 'Notch / Drill / Text', live: 'Dart / Pleat / Fullness', cut: 'Cut / Trace', measure: 'Measure / Walk', view: 'Navigate',
};
