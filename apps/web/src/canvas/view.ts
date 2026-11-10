/**
 * Viewport: y-UP world (mm) ⇄ y-DOWN screen (CSS px of the canvas element).
 *   sx = (wx − cx)·scale + W/2
 *   sy = H/2 − (wy − cy)·scale
 * The world SVG group uses the equivalent matrix(scale, 0, 0, −scale, tx, ty).
 */
import type { Vec, Box } from '@prowdcad/kernel';

export class Viewport {
  cx = 0; cy = 0;
  /** screen px per mm */
  scale = 2;
  W = 800; H = 600;
  static MIN = 0.02; static MAX = 400;

  toScreen(p: Vec): Vec { return { x: (p.x - this.cx) * this.scale + this.W / 2, y: this.H / 2 - (p.y - this.cy) * this.scale }; }
  toWorld(s: Vec): Vec { return { x: (s.x - this.W / 2) / this.scale + this.cx, y: (this.H / 2 - s.y) / this.scale + this.cy }; }
  /** world mm per screen px */
  px(n = 1): number { return n / this.scale; }
  matrix(): string {
    const tx = this.W / 2 - this.cx * this.scale, ty = this.H / 2 + this.cy * this.scale;
    return `matrix(${this.scale} 0 0 ${-this.scale} ${tx} ${ty})`;
  }
  /** zoom by factor keeping the world point under screen point `s` fixed */
  zoomAt(s: Vec, factor: number) {
    const before = this.toWorld(s);
    this.scale = Math.min(Viewport.MAX, Math.max(Viewport.MIN, this.scale * factor));
    const after = this.toWorld(s);
    this.cx += before.x - after.x; this.cy += before.y - after.y;
  }
  panPx(dx: number, dy: number) { this.cx -= dx / this.scale; this.cy += dy / this.scale; }
  fit(b: Box, padPx = 40) {
    const w = Math.max(1, b.maxX - b.minX), hgt = Math.max(1, b.maxY - b.minY);
    this.scale = Math.min(Viewport.MAX, Math.max(Viewport.MIN, Math.min((this.W - 2 * padPx) / w, (this.H - 2 * padPx) / hgt)));
    this.cx = (b.minX + b.maxX) / 2; this.cy = (b.minY + b.maxY) / 2;
  }
  visibleWorld(): Box {
    const a = this.toWorld({ x: 0, y: this.H }), b = this.toWorld({ x: this.W, y: 0 });
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }
}

/** 100 % zoom = true size on a 96-dpi display */
export const PX_PER_MM_100 = 96 / 25.4;
