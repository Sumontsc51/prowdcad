/**
 * Canvas controller: owns the SVG sheet + rulers, routes pointer events to the active tool,
 * handles pan (Space+drag / middle drag / Hand tool), wheel zoom-to-cursor and guide dragging.
 *
 * Rules (A10): setPointerCapture in try/catch and always release; NEVER auto-pan during drags.
 */
import type { App } from '../app';
import type { Hit, Ptr } from '../tools/tool';
import { renderGrid, renderWorld, renderOverlay, renderRuler } from './render';
import { settings, saveSettings } from '../settings';
import { allPiecesBox } from '../geometry';
import { PX_PER_MM_100 } from './view';
import { reportError } from '../commands';

const NS = 'http://www.w3.org/2000/svg';
const RULER = 20;

export class Canvas {
  host: HTMLElement;
  svg: SVGSVGElement;
  gGrid: SVGGElement; gWorld: SVGGElement; gOverlay: SVGGElement;
  rulerX: SVGSVGElement; rulerY: SVGSVGElement;
  private pan: { sx: number; sy: number; id: number } | null = null;
  private guideDrag: { index: number | null; axis: 'x' | 'y'; id: number; fromRuler: boolean; el: Element } | null = null;
  private ro: ResizeObserver;
  /** called on right-click when the active tool does not handle it */
  onContext: ((p: Ptr) => void) | null = null;

  constructor(public app: App, host: HTMLElement) {
    this.host = host;
    host.classList.add('canvas-host');
    host.innerHTML = `
      <div class="ruler-corner" title="Reset origin view"></div>
      <svg class="ruler ruler-x" xmlns="${NS}"></svg>
      <svg class="ruler ruler-y" xmlns="${NS}"></svg>
      <svg class="sheet" xmlns="${NS}" tabindex="0">
        <rect class="sheet-bg" x="0" y="0" width="100%" height="100%" fill="#ffffff"/>
        <g class="g-grid"></g><g class="g-world"></g><g class="g-overlay"></g>
      </svg>`;
    this.svg = host.querySelector('svg.sheet') as SVGSVGElement;
    this.rulerX = host.querySelector('.ruler-x') as SVGSVGElement;
    this.rulerY = host.querySelector('.ruler-y') as SVGSVGElement;
    this.gGrid = this.svg.querySelector('.g-grid') as SVGGElement;
    this.gWorld = this.svg.querySelector('.g-world') as SVGGElement;
    this.gOverlay = this.svg.querySelector('.g-overlay') as SVGGElement;
    (host.querySelector('.ruler-corner') as HTMLElement).onclick = () => this.zoomFit();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.bind();
    this.resize();
    app.setRenderer('canvas', () => this.render());
  }

  applyRulerVisibility() {
    this.host.classList.toggle('no-rulers', !settings.showRulers);
    this.resize();
  }

  resize() {
    const r = this.svg.getBoundingClientRect();
    this.app.view.W = Math.max(1, r.width);
    this.app.view.H = Math.max(1, r.height);
    this.app.invalidate('canvas', 'status');
  }

  render() {
    const app = this.app;
    this.host.classList.toggle('no-rulers', !settings.showRulers);
    this.gGrid.innerHTML = renderGrid(app);
    this.gWorld.setAttribute('transform', app.view.matrix());
    this.gWorld.innerHTML = renderWorld(app);
    this.gOverlay.innerHTML = renderOverlay(app);
    if (settings.showRulers) {
      this.rulerX.innerHTML = renderRuler(app, 'x', app.view.W, RULER);
      this.rulerY.innerHTML = renderRuler(app, 'y', app.view.H, RULER);
    }
    this.svg.style.cursor = this.space() ? (this.pan ? 'grabbing' : 'grab') : app.tool?.cursor ?? 'default';
  }

  private space() { return this.app.space || this.app.tool?.id === 'hand'; }

  // ───── coords / hit decode ─────
  screenOf(e: { clientX: number; clientY: number }) {
    const r = this.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  ptr(e: PointerEvent | MouseEvent): Ptr {
    const s = this.screenOf(e);
    return { s, w: this.app.view.toWorld(s), e, hit: this.decode(e) };
  }
  decode(e: { clientX: number; clientY: number; target: EventTarget | null }): Hit {
    // pointer capture retargets events to the svg, so look up the element under the cursor
    let el = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
    if (!el || !this.svg.contains(el)) el = e.target as Element | null;
    const tgt = el?.closest?.('[data-hit],[data-piece]') as HTMLElement | SVGElement | null;
    if (!tgt || !this.svg.contains(tgt)) return { kind: 'none' };
    const d = (tgt as SVGElement).dataset;
    if (d.hit === 'anchor') return { kind: 'anchor', pieceId: d.piece, contourId: d.contour, anchorId: d.anchor, sizeId: d.size };
    if (d.hit === 'handle') return { kind: 'handle', pieceId: d.piece, contourId: d.contour, anchorId: d.anchor, which: d.which as 'in' | 'out' };
    if (d.hit === 'guide') return { kind: 'guide', guide: Number(d.guide) };
    if (d.piece) return { kind: 'piece', pieceId: d.piece };
    return { kind: 'none' };
  }

  private capture(id: number) { try { this.svg.setPointerCapture(id); } catch { /* ignore */ } }
  private release(id: number) { try { if (this.svg.hasPointerCapture(id)) this.svg.releasePointerCapture(id); } catch { /* ignore */ } }

  private bind() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', e => {
      svg.focus({ preventScroll: true });
      const p = this.ptr(e);
      if (e.button === 1 || (e.button === 0 && this.space())) {
        e.preventDefault();
        this.pan = { sx: e.clientX, sy: e.clientY, id: e.pointerId };
        this.capture(e.pointerId); this.render(); return;
      }
      if (e.button === 0 && p.hit.kind === 'guide' && !this.app.tool?.busy?.(this.app)) {
        const g = settings.guides[p.hit.guide!];
        this.guideDrag = { index: p.hit.guide!, axis: g.axis, id: e.pointerId, fromRuler: false, el: svg };
        this.capture(e.pointerId); return;
      }
      if (e.button !== 0) return;
      this.capture(e.pointerId);
      this.safe(() => this.app.tool?.down?.(this.app, p));
    });
    svg.addEventListener('pointermove', e => {
      const s = this.screenOf(e);
      this.app.cursorWorld = this.app.view.toWorld(s);
      if (this.pan) {
        this.app.view.panPx(e.clientX - this.pan.sx, e.clientY - this.pan.sy);
        this.pan.sx = e.clientX; this.pan.sy = e.clientY;
        this.app.invalidate('canvas', 'status'); return;
      }
      if (this.guideDrag) { this.moveGuide(e); return; }
      this.safe(() => this.app.tool?.move?.(this.app, this.ptr(e)));
      this.app.invalidate('status');
      if (settings.showRulers) this.app.invalidate('canvas');
    });
    const up = (e: PointerEvent) => {
      if (this.pan && e.pointerId === this.pan.id) { this.pan = null; this.release(e.pointerId); this.render(); return; }
      if (this.guideDrag) { this.endGuide(e); return; }
      this.release(e.pointerId);
      if (e.button !== 0 && e.type === 'pointerup') return;
      this.safe(() => this.app.tool?.up?.(this.app, this.ptr(e)));
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('pointerleave', () => { this.app.cursorWorld = null; this.app.invalidate('status'); });
    svg.addEventListener('contextmenu', e => {
      e.preventDefault();
      const p = this.ptr(e);
      this.safe(() => { if (!this.app.tool?.context?.(this.app, p)) this.onContext?.(p); });
    });
    svg.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      let used = false;
      this.safe(() => { used = !!this.app.tool?.wheel?.(this.app, e); });
      if (used) { this.app.invalidate('canvas', 'status'); return; }
      const s = this.screenOf(e);
      if (e.ctrlKey || !e.shiftKey) {
        const k = e.deltaMode === 1 ? 0.05 : 0.0015;
        const factor = Math.exp(-e.deltaY * k * (e.ctrlKey ? 2 : 1));
        this.app.view.zoomAt(s, factor);
      } else this.app.view.panPx(-e.deltaY, 0);
      this.app.invalidate('canvas', 'status');
    }, { passive: false });

    // rulers: drag out a new guide
    for (const [el, axis] of [[this.rulerX, 'y'], [this.rulerY, 'x']] as const) {
      el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        try { el.setPointerCapture(e.pointerId); } catch { /* */ }
        this.guideDrag = { index: null, axis, id: e.pointerId, fromRuler: true, el };
      });
      el.addEventListener('pointermove', e => { if (this.guideDrag) this.moveGuide(e); });
      el.addEventListener('pointerup', e => { if (this.guideDrag) this.endGuide(e); });
      el.addEventListener('dblclick', () => { settings.guides = []; saveSettings(); this.app.invalidate('canvas'); this.app.status('Guides cleared'); });
    }
  }

  private moveGuide(e: PointerEvent) {
    const gd = this.guideDrag!;
    const w = this.app.view.toWorld(this.screenOf(e));
    const pos = gd.axis === 'x' ? w.x : w.y;
    if (gd.index == null) { settings.guides.push({ axis: gd.axis, pos }); gd.index = settings.guides.length - 1; }
    else settings.guides[gd.index].pos = pos;
    this.app.status(`Guide ${gd.axis === 'x' ? 'X' : 'Y'} = ${pos.toFixed(2)} mm`);
    this.app.invalidate('canvas');
  }
  private endGuide(e: PointerEvent) {
    const gd = this.guideDrag!;
    try { (gd.el as Element).releasePointerCapture?.(e.pointerId); } catch { /* */ }
    this.release(e.pointerId);
    // dropping a guide back onto the ruler removes it
    const s = this.screenOf(e);
    if (gd.index != null && (s.x < 0 || s.y < 0)) settings.guides.splice(gd.index, 1);
    this.guideDrag = null;
    saveSettings();
    this.app.invalidate('canvas');
  }

  private safe(fn: () => void) { try { fn(); } catch (err) { reportError(err, this.app.tool?.title ?? 'Tool'); } }

  // ───── view commands ─────
  zoomFit(ids?: string[]) {
    const b = allPiecesBox(this.app.doc, this.app.activeSize, ids);
    if (b) this.app.view.fit({ minX: b.minX - 10, minY: b.minY - 10, maxX: b.maxX + 10, maxY: b.maxY + 10 });
    else { this.app.view.cx = 0; this.app.view.cy = 0; this.app.view.scale = 2; }
    this.app.invalidate('canvas', 'status');
  }
  zoomBy(f: number) { this.app.view.zoomAt({ x: this.app.view.W / 2, y: this.app.view.H / 2 }, f); this.app.invalidate('canvas', 'status'); }
  zoom100() { const v = this.app.view; v.zoomAt({ x: v.W / 2, y: v.H / 2 }, PX_PER_MM_100 / v.scale); this.app.invalidate('canvas', 'status'); }
}
