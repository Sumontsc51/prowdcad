/** Right dock (Pieces / Sizes / Inspector) and bottom dock (Grading table). Collapsible, persisted visibility. */
import type { App } from '../app';
import { h, clear } from '../ui/dom';
import { section, focusSafe } from './widgets';
import { renderInspector } from './inspector';
import { renderPieces } from './pieces';
import { renderSizes } from './sizes';
import { renderGrading } from './grading';
import { settings, saveSettings } from '../settings';
import { ruleWindowOpen, refreshRuleWindow } from './rules';

export function mountDocks(app: App, right: HTMLElement, bottom: HTMLElement, zoomTo: (ids: string[]) => void) {
  const piecesBody = h('div'), sizesBody = h('div'), inspBody = h('div.insp'), gradBody = h('div');
  const mk = (id: keyof typeof settings.panels, title: string, body: HTMLElement) =>
    section(id, title, body, { collapsed: !settings.panels[id], onToggle: open => { settings.panels[id] = open; saveSettings(); } });
  clear(right);
  right.append(mk('pieces', 'Pieces', piecesBody), mk('sizes', 'Sizes', sizesBody), mk('inspector', 'Inspector', inspBody));
  clear(bottom);
  const gradSec = mk('grading', 'Grading table', gradBody);
  bottom.append(gradSec);

  const rPieces = focusSafe(piecesBody, () => renderPieces(app, piecesBody, zoomTo));
  const rSizes = focusSafe(sizesBody, () => renderSizes(app, sizesBody));
  const rInsp = focusSafe(inspBody, () => renderInspector(app, inspBody));
  const rGrad = focusSafe(gradBody, () => renderGrading(app, gradBody));
  const render = () => {
    // sync collapsed state with settings (View menu toggles)
    for (const sec of [...right.querySelectorAll('section.panel'), gradSec]) {
      const id = (sec as HTMLElement).dataset.panel as keyof typeof settings.panels;
      sec.classList.toggle('collapsed', !settings.panels[id]);
    }
    bottom.classList.toggle('collapsed', !settings.panels.grading);
    rPieces(); rSizes(); rInsp();
    if (settings.panels.grading) rGrad();
    if (ruleWindowOpen()) refreshRuleWindow();
  };
  app.setRenderer('panels', render);
  render();
}
