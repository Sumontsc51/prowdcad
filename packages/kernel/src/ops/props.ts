/**
 * Properties of internal lines and notches set from the property editor: for the chosen ones, or for every one in the
 * whole style ("global").
 *
 * Use of an internal line:
 *   'draw'       — drawn with the pen (default)
 *   'cut'        — cut
 *   'M1'         — match to the fabric: across the grain it lies on a stripe, along the grain on a plaid line
 *   'P1' … 'P15' — match piece to piece: lines with the same code lie on the same place of the fabric repeat
 */
import type { Document } from '../model/doc';
import type { Contour, Id, Notch } from '../model/types';

export type LineUse = 'draw' | 'cut' | string;
export const LINE_USES: string[] = ['draw', 'cut', 'M1', ...Array.from({ length: 15 }, (_, i) => 'P' + (i + 1))];
/** Lines whose use may be set: free internal lines (not dart / pleat axes, fold or mirror lines, grain). */
export const isPlainInternal = (c: Contour): boolean => c.type === 'internal' || c.type === 'guide' || c.type === 'seamline';
export function lineUseOf(c: Contour): LineUse { return c.match ? c.match : c.mode === 'cut' ? 'cut' : 'draw'; }
export function lineUseLabel(u: LineUse): string { return u === 'draw' ? 'Draw' : u === 'cut' ? 'Cut' : u === 'M1' ? 'Match to fabric (M1)' : `Piece to piece (${u})`; }

/** Set the use of internal lines: the given ones, or (`'all'`) every plain internal line of every piece. Returns how many changed. */
export function setLineUse(doc: Document, targets: { pieceId: Id; contourId: Id }[] | 'all', use: LineUse): number {
  if (!LINE_USES.includes(use)) throw new Error(`Unknown line use "${use}"`);
  let n = 0;
  doc.transact(targets === 'all' ? 'Line use (all lines)' : 'Line use', s => {
    for (const p of s.pieces) {
      for (const c of p.internals) {
        if (targets === 'all' ? !isPlainInternal(c) : !targets.some(t => t.pieceId === p.id && t.contourId === c.id)) continue;
        if (lineUseOf(c) === use) continue;
        if (use === 'draw') { delete c.mode; delete c.match; } else if (use === 'cut') { c.mode = 'cut'; delete c.match; } else { delete c.mode; c.match = use; }
        n++;
      }
    }
  });
  return n;
}

export type NotchPatch = Partial<Pick<Notch, 'type' | 'depth' | 'width' | 'angleDeg' | 'on' | 'mode'>>;
/** Change properties of notches: the given ones, or (`'all'`) every notch of every piece. Returns how many changed. */
export function setNotchProps(doc: Document, targets: { pieceId: Id; notchId: Id }[] | 'all', patch: NotchPatch): number {
  if (patch.depth != null && !(patch.depth > 0)) throw new Error('The notch depth must be larger than 0');
  if (patch.width != null && !(patch.width >= 0)) throw new Error('The notch width cannot be negative');
  let n = 0;
  doc.transact(targets === 'all' ? 'Notch (all notches)' : 'Notch', s => {
    for (const p of s.pieces) for (const nt of p.notches) {
      if (targets !== 'all' && !targets.some(t => t.pieceId === p.id && t.notchId === nt.id)) continue;
      let ch = false;
      for (const k of Object.keys(patch) as (keyof NotchPatch)[]) { const v = patch[k]; if (v === undefined || nt[k] === v) continue; (nt as unknown as Record<string, unknown>)[k] = v; ch = true; }
      if (ch) n++;
    }
  });
  return n;
}
