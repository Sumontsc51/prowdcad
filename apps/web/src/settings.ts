/**
 * Persisted UI settings (per browser). Every localStorage access is guarded: private windows,
 * blocked storage and quota errors must never break the app.
 */
import type { Unit } from '@prowdcad/kernel';

export const store = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): boolean {
    try { window.localStorage.setItem(key, value); return true; } catch { return false; }
  },
  del(key: string): void {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

export type SelFilter = 'all' | 'points' | 'lines' | 'pieces' | 'internals' | 'marks';

export interface Guide { axis: 'x' | 'y'; pos: number }

export interface Settings {
  unit: Unit;
  /** inch fraction denominator; 0 = decimal inches */
  fracDen: number;
  /** command id → key chord override (e.g. "Ctrl+Shift+S"). Empty string = unbound. */
  hotkeys: Record<string, string>;
  hiddenTools: string[];
  showGrid: boolean;
  showRulers: boolean;
  showCut: boolean;
  showAllAnchors: boolean;
  snapGrid: boolean;
  snapGuides: boolean;
  snapPoints: boolean;
  gridMm: number;
  nudgeMm: number;
  polygonSides: number;
  roundRadiusMm: number;
  panels: { pieces: boolean; sizes: boolean; inspector: boolean; grading: boolean };
  guides: Guide[];
  /** cut-line corner markers (cutLineForSize corner indices) on selected pieces */
  showCutCorners: boolean;
  /** rule names next to grade points */
  showRuleNames: boolean;
  /** reference blocks (dashed) */
  showReference: boolean;
  /** Select tool: what a click / box can select */
  selFilter: SelFilter;
  /** Select tool opt-in: dragging moves ONLY the grabbed point / handle / piece (off = Select never moves geometry) */
  selectDragMove: boolean;
  /** pick radius around the cursor, screen px (4–20) */
  pickRadiusPx: number;
  /** Move Point tool mode (Single default) */
  movePointMode: 'single' | 'smooth' | 'h' | 'v' | 'along' | 'group';
  moveLineMode: 'translate' | 'parallel';
  pieceToolMode: 'move' | 'rotate' | 'flip';
  /** last-used dialog values, keyed by dialog id */
  last: Record<string, Record<string, string | number | boolean>>;
}

const KEY = 'prowdcad.web.settings';

export const DEFAULT_SETTINGS: Settings = {
  unit: 'mm', fracDen: 16, hotkeys: {}, hiddenTools: [],
  showGrid: true, showRulers: true, showCut: true, showAllAnchors: true,
  snapGrid: false, snapGuides: true, snapPoints: true,
  gridMm: 10, nudgeMm: 1, polygonSides: 6, roundRadiusMm: 20,
  panels: { pieces: true, sizes: true, inspector: true, grading: false },
  guides: [],
  showCutCorners: false, showRuleNames: false, showReference: true,
  selFilter: 'all', selectDragMove: false, pickRadiusPx: 8, movePointMode: 'single', moveLineMode: 'translate', pieceToolMode: 'move',
  last: {},
};

function load(): Settings {
  const raw = store.get(KEY);
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!raw) return base;
  try {
    const s = JSON.parse(raw) as Partial<Settings>;
    // every session starts Move Point in Single (only the grabbed point moves)
    return { ...base, ...s, movePointMode: 'single', panels: { ...base.panels, ...(s.panels ?? {}) }, hotkeys: { ...(s.hotkeys ?? {}) }, last: { ...(s.last ?? {}) } };
  } catch { return base; }
}

export const settings: Settings = load();

export function saveSettings(): void { store.set(KEY, JSON.stringify(settings)); }
