/**
 * Wires every Phase-1 kernel op into the ops bridge. Darts / pleats / fullness (LiveOps) are NOT
 * wired here: they stay placeholders until their modules are integrated.
 */
import * as K from '@prowdcad/kernel';
import { wireOps, KERNEL_FNS, type KernelOps } from './ops-bridge';

export function wireKernel(): void {
  const impl: Record<string, unknown> = {};
  const lib = K as unknown as Record<string, unknown>;
  for (const n of KERNEL_FNS) {
    if (typeof lib[n] !== 'function') { console.warn(`kernel export missing: ${n}`); continue; }
    impl[n] = lib[n];
  }
  wireOps(impl as Partial<KernelOps>);
}
