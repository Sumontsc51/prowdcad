import type { Vec } from '@prowdcad/kernel';
import type { App } from '../app';

/** What the pointer is over, decoded from data-* attributes of SVG hit targets. */
export interface Hit {
  kind: 'anchor' | 'handle' | 'piece' | 'edge' | 'guide' | 'none';
  pieceId?: string;
  contourId?: string;
  anchorId?: string;
  which?: 'in' | 'out';
  /** for anchors/handles drawn for a specific size (nested view); undefined = active size */
  sizeId?: string;
  guide?: number;
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
  dart: '<path d="M3 6h7l2 12 2-12h7"/>',
  seam: '<path d="M4 18V6h16v12z"/><path d="M7 15V9h10v6z" stroke-dasharray="2 2"/>',
  text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  walk: '<path d="M3 17h9"/><path d="M12 17l7-9" stroke-dasharray="3 2"/><circle cx="12" cy="17" r="1.6"/><path d="M5 8l3-3 3 3"/>',
  smooth: '<path d="M3 16l3-5 2 3 3-6 2 4 3-3" opacity=".45"/><path d="M3 17c4-9 10-9 18-2"/>',
  slash: '<path d="M4 20L20 4"/><path d="M14 4h6v6"/><rect x="3" y="6" width="9" height="12" opacity=".5"/>',
  trace: '<path d="M4 18L9 6l6 4 5-4"/><circle cx="4" cy="18" r="1.4"/><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="10" r="1.4"/>',
  pick: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/><circle cx="12" cy="12" r="2"/>',
};
