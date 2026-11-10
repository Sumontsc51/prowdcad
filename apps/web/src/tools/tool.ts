import type { Vec } from '@prowdcad/kernel';
import type { App } from '../app';

/** What the pointer is over, decoded from data-* attributes of SVG hit targets. */
export interface Hit {
  kind: 'anchor' | 'handle' | 'piece' | 'edge' | 'guide' | 'live' | 'none';
  pieceId?: string;
  contourId?: string;
  anchorId?: string;
  which?: 'in' | 'out';
  /** for anchors/handles drawn for a specific size (nested view); undefined = active size */
  sizeId?: string;
  guide?: number;
  /** live object hit target (dart / pleat / fullness) */
  liveKind?: 'dart' | 'pleat' | 'fullness';
  liveId?: string;
}

export interface Ptr {
  /** world mm (y-up) */
  w: Vec;
  /** canvas px (y-down) */
  s: Vec;
  e: PointerEvent | MouseEvent;
  hit: Hit;
}

export interface Tool {
  id: string;
  title: string;
  /** palette group id; tools sharing a group form a flyout */
  group: string;
  hotkey?: string;
  /** inline SVG (24×24 viewBox, stroke = currentColor) */
  icon: string;
  cursor?: string;
  activate?(app: App): void;
  /** called when switching away; must discard drafts */
  deactivate?(app: App): void;
  down?(app: App, p: Ptr): void;
  move?(app: App, p: Ptr): void;
  up?(app: App, p: Ptr): void;
  /** right click; return true when handled (suppresses context menu) */
  context?(app: App, p: Ptr): boolean;
  /** key handling while active; return true when consumed */
  key?(app: App, e: KeyboardEvent): boolean;
  /** overlay SVG markup in SCREEN coordinates */
  overlay?(app: App): string;
  /** status-bar hint */
  hint?(app: App): string;
  /** true while a multi-click construction is in progress (blocks guide grabbing etc.) */
  busy?(app: App): boolean;
  /** mouse wheel; return true when consumed (suppresses wheel zoom) */
  wheel?(app: App, e: WheelEvent): boolean;
  /** not shown in the palette (transient pick sessions) */
  hidden?: boolean;
  /** arrow-key nudge (world mm); only Move tools implement it */
  nudge?(app: App, dx: number, dy: number): void;
  /** tool-options strip: mode buttons (segmented control) */
  modes?(app: App): { id: string; label: string; title?: string }[];
  mode?(app: App): string;
  setMode?(app: App, id: string): void;
  /** tool-options strip: on/off option buttons shown after the modes (e.g. Cut Point: Curve point · Notch · Zero grade) */
  toggles?(app: App): { id: string; label: string; title?: string; on: boolean }[];
  toggle?(app: App, id: string): void;
  /** tool-mode indicator text (amber = editing a non-base size's grading) */
  badge?(app: App): { text: string; amber?: boolean } | null;
}

export const ICON = {
  select: '<path d="M5 3l14 8-6 2-3 6z"/>',
  hand: '<path d="M8 13V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7a7 7 0 01-7 7h-1a6 6 0 01-5-3l-2.5-4a1.5 1.5 0 012.5-1.5L8 15"/>',
  zoom: '<circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L20 20M7.5 10h5M10 7.5v5"/>',
  pen: '<path d="M4 20l3-1 11-11-2-2L5 17z"/><path d="M14 6l2 2"/><circle cx="4" cy="20" r="1"/>',
  internal: '<path d="M4 18c3-8 7-1 9-7s4-5 7-6" stroke-dasharray="3 2"/><circle cx="4" cy="18" r="1.4"/><circle cx="20" cy="5" r="1.4"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="0.5"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  polygon: '<path d="M12 3l8 6-3 10H7L4 9z"/>',
  roundrect: '<rect x="4" y="6" width="16" height="12" rx="4"/>',
  measure: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  notch: '<path d="M3 8h18M12 8v8"/><path d="M9 16h6"/>',
  drill: '<circle cx="12" cy="12" r="5"/><path d="M12 4v16M4 12h16"/>',
  dart: '<path d="M3 5h6.5l2.5 13 2.5-13H21"/><path d="M12 18v-6" stroke-dasharray="1.5 1.5"/><circle cx="12" cy="18" r="1.3"/>',
  cutPoint: '<path d="M3 17c4-8 9-10 18-9"/><circle cx="11.5" cy="10.6" r="2.3" fill="currentColor" stroke="none"/><path d="M11.5 3v3.5M11.5 14.5V21" stroke-dasharray="1.6 1.6"/>',
  seam: '<path d="M4 18V6h16v12z"/><path d="M7 15V9h10v6z" stroke-dasharray="2 2"/>',
  text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  walk: '<path d="M3 17h9"/><path d="M12 17l7-9" stroke-dasharray="3 2"/><circle cx="12" cy="17" r="1.6"/><path d="M5 8l3-3 3 3"/>',
  smooth: '<path d="M3 16l3-5 2 3 3-6 2 4 3-3" opacity=".45"/><path d="M3 17c4-9 10-9 18-2"/>',
  slash: '<path d="M4 20L20 4"/><path d="M14 4h6v6"/><rect x="3" y="6" width="9" height="12" opacity=".5"/>',
  trace: '<path d="M4 18L9 6l6 4 5-4"/><circle cx="4" cy="18" r="1.4"/><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="10" r="1.4"/>',
  pleat: '<path d="M3 4h18M3 20h18"/><path d="M6 4v16M11 4v16M16 4v16" stroke-dasharray="3 1.5"/><path d="M6 12h3.5M8 10.5l1.5 1.5-1.5 1.5M11 12h3.5M13 10.5l1.5 1.5-1.5 1.5"/>',
  fullness: '<path d="M3 20h7l2-16 2 16h7"/><path d="M12 4L8.5 20M12 4l3.5 16" stroke-dasharray="1.6 1.6" opacity=".7"/><path d="M5 17l-2 3 3 .5M19 17l2 3-3 .5"/>',
  movePoint: '<rect x="3" y="15" width="6" height="6"/><path d="M6 15V6M6 6l-3 3M6 6l3 3"/><path d="M12 12h9M21 12l-3-3M21 12l-3 3"/>',
  moveLine: '<path d="M3 18L13 8" stroke-dasharray="2 2" opacity=".55"/><path d="M9 21L19 11"/><path d="M14 4h6v6"/><path d="M20 4l-6 6"/>',
  movePiece: '<path d="M5 6h9l3 5-3 7H5z"/><path d="M19 3a4 4 0 010 6" /><path d="M19 9l-2 0M19 9l0-2"/>',
  curve: '<path d="M4 19C6 8 14 6 20 6"/><path d="M4 19l5-11"/><circle cx="9" cy="8" r="1.8"/><circle cx="4" cy="19" r="1.4"/>',
  pick: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/><circle cx="12" cy="12" r="2"/>',
};
