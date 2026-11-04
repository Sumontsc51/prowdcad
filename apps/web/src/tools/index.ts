import type { Tool } from './tool';
import { selectTool } from './select';
import { penTool } from './pen';
import { internalTool } from './internal';
import { rectTool, circleTool, polygonTool, roundRectTool } from './shapes';
import { measureTool, zoomTool, handTool } from './misc';
import { notchTool, drillTool } from './marks';

/** Palette order. Tools sharing `group` form one flyout button. */
export const TOOLS: Tool[] = [
  selectTool,
  penTool, internalTool,
  rectTool, circleTool, polygonTool, roundRectTool,
  notchTool, drillTool,
  measureTool,
  handTool, zoomTool,
];

export const GROUP_TITLES: Record<string, string> = {
  select: 'Select', pen: 'Pens', shape: 'Shapes', marks: 'Notch / Drill', measure: 'Measure', view: 'Navigate',
};
