/**
 * Wires every kernel op into the ops bridge: the kernel functions listed in KERNEL_GROUPS plus the
 * live-object convenience wrappers (LiveOps: addDart, rotateDart, toggleDartClosed, addPleat).
 */
import * as K from '@prowdcad/kernel';
import { wireOps, KERNEL_FNS, type KernelOps, type LiveOps } from './ops-bridge';

export const liveOpsImpl: LiveOps = {
  addDart: (doc, a) => K.createDart(doc, a.pieceId, { at: a.at, width: a.width, depth: a.depth, apex: a.apex, fold: a.fold, drillOffset: a.drillOffset }),
  rotateDart: (doc, a) => a.center
    ? K.rotateDartAroundCenter(doc, a.pieceId, a.dartId, { target: a.target, center: a.center, pct: a.pct })
    : K.transferDart(doc, a.pieceId, a.dartId, { target: a.target, pivot: a.pivot, pct: a.pct ?? 100 }),
  toggleDartClosed: (doc, a) => {
    const d = doc.piece(a.pieceId).darts.find(x => x.id === a.dartId);
    if (!d) throw new Error('No dart ' + a.dartId);
    if (d.closed) K.openDart(doc, a.pieceId, a.dartId, a.width); else K.closeDart(doc, a.pieceId, a.dartId);
  },
  addPleat: (doc, a) => doc.transact('Add pleat', () => {
    const id = K.addPleatAxis(doc, a.pieceId, a.start, a.end, a.attrs ?? {});
    const at = a.attrs ?? {};
    if (a.open && ((at.depthStart ?? 0) > 0 || (at.depthEnd ?? 0) > 0)) K.openPleat(doc, a.pieceId, id);
    return id;
  }),
};

export function wireKernel(): void {
  const impl: Record<string, unknown> = {};
  const lib = K as unknown as Record<string, unknown>;
  for (const n of KERNEL_FNS) {
    if (typeof lib[n] !== 'function') { console.warn(`kernel export missing: ${n}`); continue; }
    impl[n] = lib[n];
  }
  wireOps({ ...(impl as Partial<KernelOps>), ...liveOpsImpl });
}
