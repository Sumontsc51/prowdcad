/** Right dock (Pieces / Sizes / Inspector), collapsible with persisted visibility, and the Grading table: a floating window over the sheet. */
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { section, focusSafe } from './widgets';
import { renderInspector } from './inspector';
import { renderPieces } from './pieces';
import { renderSizes } from './sizes';
import { renderGrading } from './grading';
import { settings, saveSettings } from '../settings';
import { floatingWindow, type FloatWin } from '../ui/window';
import { sizeTableOpen, refreshSizeTable } from './sizetable';
import { ruleWindowOpen, refreshRuleWindow } from './rules';
import { specWindowOpen, refreshSpecWindow } from './spec';

export function mountDocks(app: App, right: HTMLElement, bottom: HTMLElement, zoomTo: (ids: string[]) => void) {
  const piecesBody = h('div'), sizesBody = h('div'), inspBody = h('div.insp'), gradBody = h('div');
  const mk = (id: keyof typeof settings.panels, title: string, body: HTMLElement) =>
    section(id, title, body, { collapsed: !settings.panels[id], onToggle: open => { settings.panels[id] = open; saveSettings(); } });
  clear(right);
  right.append(mk('pieces', 'Pieces', piecesBody), mk('sizes', 'Sizes', sizesBody), mk('inspector', 'Inspector', inspBody));
  clear(bottom); bottom.style.display = 'none'; // the grading table no longer takes sheet height
  // Grading table: a pop-up window (drag by its title, resize at its corner); it remembers where it was left
  let gwin: FloatWin | null = null;
  let gpos: { x: number; y: number; w: number; h: number } | null = null;
  const showGrad = (on: boolean) => {
    if (on && !gwin) {
      const w = gpos?.w ?? Math.min(620, window.innerWidth - 120);
      gwin = floatingWindow('grading', 'Grading table', { width: w, cls: 'gradewin', keepOnEsc: true, x: gpos?.x ?? Math.max(60, window.innerWidth - w - 330), y: gpos?.y ?? 96,
        onClose: () => { gwin = null; if (settings.panels.grading) { settings.panels.grading = false; saveSettings(); app.invalidate('panels'); } } });
      if (gpos?.h) gwin.el.style.height = gpos.h + 'px';
      gwin.body.append(gradBody);
    } else if (!on && gwin) {
      const r = gwin.el.getBoundingClientRect(); gpos = { x: r.left, y: r.top, w: r.width, h: gwin.el.style.height ? r.height : 0 };
      const g = gwin; gwin = null; g.close();
    }
  };
  // closing with × also remembers the place
  document.addEventListener('pointerdown', e => { const t = e.target as Element; if (gwin && t.closest?.('.gradewin .fw-x')) { const r = gwin.el.getBoundingClientRect(); gpos = { x: r.left, y: r.top, w: r.width, h: gwin.el.style.height ? r.height : 0 }; } }, true);

  const rPieces = focusSafe(piecesBody, () => renderPieces(app, piecesBody, zoomTo));
  const rSizes = focusSafe(sizesBody, () => renderSizes(app, sizesBody));
  const rInsp = focusSafe(inspBody, () => renderInspector(app, inspBody));
  const rGrad = focusSafe(gradBody, () => renderGrading(app, gradBody));
  const render = () => {
    // sync collapsed state with settings (View menu toggles)
    for (const sec of [...right.querySelectorAll('section.panel')]) {
      const id = (sec as HTMLElement).dataset.panel as keyof typeof settings.panels;
      sec.classList.toggle('collapsed', !settings.panels[id]);
    }
    showGrad(settings.panels.grading);
    rPieces(); rSizes(); rInsp();
    if (settings.panels.grading) rGrad();
    if (ruleWindowOpen()) refreshRuleWindow();
    if (sizeTableOpen()) refreshSizeTable(app);
    refreshSpecWindow(app); // Measure spec + its Rules window (no-op when both are closed)
  };
  app.setRenderer('panels', render);
  render();
}
