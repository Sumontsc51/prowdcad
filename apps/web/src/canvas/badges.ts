/**
 * Rule badges (Grade ▸ Rule badges, the “#” button of the grading table): a small tag next to every
 * grade point of every visible piece — the rule number when the point is linked to a rule.
 * Colour = status (kernel gradeStatus): blue = follows its rule, amber “12*” = linked but locally
 * edited, green “g” = own grading without a rule, grey “0” = ungraded.
 */
import type { App } from '../app';
import { settings } from '../settings';
import { ops } from '../ops-bridge';
import { resolveFor, toWorld } from '../geometry';
import { registerOverlay } from './overlays';

export const BADGE_COL = { rule: '#1c7ed6', edited: '#e67700', graded: '#2b8a3e', ungraded: '#868e96' } as const;

let cache = { rev: -1, map: new Map<string, { status: keyof typeof BADGE_COL; text: string }>() };
function info(app: App, pieceId: string, anchorId: string) {
  const rev = app.doc.revision();
  if (rev !== cache.rev) cache = { rev, map: new Map() };
  const k = pieceId + '|' + anchorId;
  let v = cache.map.get(k);
  if (!v) {
    let status: keyof typeof BADGE_COL = 'ungraded', text = '0';
    try {
      status = ops.gradeStatus(app.doc, pieceId, anchorId);
      if (status === 'rule' || status === 'edited') { const n = ops.ruleName(app.doc, pieceId, anchorId); text = n.split(' ')[0].replace(/\*$/, '') + (status === 'edited' ? '*' : ''); }
      else text = status === 'graded' ? 'g' : '0';
    } catch { /* */ }
    v = { status, text }; cache.map.set(k, v);
  }
  return v;
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();

export function badgesOverlay(app: App): string {
  if (!settings.ruleBadges) return '';
  let s = '';
  for (const p of app.pieces()) {
    if (app.hiddenPieces.has(p.id)) continue;
    let r; try { r = resolveFor(app.doc, p, app.sizeOf(p)); } catch { continue; }
    const cs = [p.sew, ...p.internals], rs = [r.sew, ...r.internals];
    cs.forEach((c, ci) => {
      const rc = rs[ci]; if (!rc) return;
      c.points.forEach((a, i) => {
        if (a.kind !== 'grade') return;
        const b = info(app, p.id, a.id);
        const sp = app.view.toScreen(toWorld(p, rc.anchorPos[i]));
        const w = 6 + b.text.length * 6.2, x = sp.x + 7, y = sp.y - 19;
        s += `<g class="rbadge" data-status="${b.status}" data-anchor="${a.id}"><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="13" rx="6.5" fill="${BADGE_COL[b.status]}"/><text x="${f(x + w / 2)}" y="${f(y + 9.6)}" text-anchor="middle">${b.text}</text></g>`;
      });
    });
  }
  return s;
}

registerOverlay('ruleBadges', badgesOverlay);
