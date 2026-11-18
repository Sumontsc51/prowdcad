/**
 * Nester: runs the sparrow nesting engine (MIT, Gardeyn, Vanden Berghe and Wauters, KU Leuven; with its geometry
 * library jagua-rs, MPL-2.0; compiled to WebAssembly) in background workers, one search per thread, and reports
 * every better layout as it is found.
 */
import glue from './sparrow-glue.txt?raw';
import wasmB64 from './sparrow-wasm.b64.txt?raw';
import { nestResult, type NestJob, type Placements } from '@prowdcad/kernel';

let workerURL: string | null = null;
let wasmBytes: Uint8Array | null = null;
function bytes(): Uint8Array {
  if (!wasmBytes) { const bin = atob(wasmB64.trim()); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); wasmBytes = u; }
  return wasmBytes;
}
function makeWorker(): Worker {
  if (!workerURL) {
    const src = glue + `
      let ready = false;
      onmessage = e => {
        const d = e.data;
        try {
          if (!ready) { wasm_bindgen.initSync({ module: d.wasm }); ready = true; }
          const out = wasm_bindgen.nest(d.json, d.time, BigInt(d.seed), 1, d.gap, d.opts || '', '', (tag, s) => postMessage({ type: 'sol', sol: s }));
          postMessage({ type: 'final', sol: out });
        } catch (err) { postMessage({ type: 'error', msg: String((err && err.message) || err) }); }
      };`;
    workerURL = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  }
  return new Worker(workerURL);
}

export interface NestRun { stop(): void; readonly threads: number; readonly startedAt: number; readonly seconds: number }
export interface NestHandlers {
  /** a better layout: placements of the job's parts and the marker length */
  onBest(placements: Placements, length: number): void;
  /** all threads have finished, or the run was stopped (`stopped`), or the engine failed (`error`) */
  onDone(info: { stopped: boolean; error?: string }): void;
}
/** Start nesting `job` for `seconds`. Call stop() to end early; the best layout so far has already been reported. */
export function startNest(job: NestJob, seconds: number, hnd: NestHandlers, threads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))): NestRun {
  const workers: Worker[] = [];
  let best = Infinity, done = 0, over = false;
  const finish = (info: { stopped: boolean; error?: string }) => { if (over) return; over = true; for (const w of workers) w.terminate(); hnd.onDone(info); };
  const wasm = bytes();
  for (let k = 0; k < threads; k++) {
    const w = makeWorker(); workers.push(w);
    w.onmessage = e => {
      if (over) return;
      const m = e.data as { type: string; sol?: string; msg?: string };
      if (m.type === 'error') { finish({ stopped: false, error: m.msg }); return; }
      if (m.sol) {
        try { const r = nestResult(m.sol, job); if (r.length < best - 1e-6 && Object.keys(r.placements).length) { best = r.length; hnd.onBest(r.placements, r.length); } } catch { /* a partial answer */ }
      }
      if (m.type === 'final' && ++done >= threads) finish({ stopped: false });
    };
    w.onerror = err => finish({ stopped: false, error: err.message });
    w.postMessage({ wasm: wasm.slice(), json: job.json, time: seconds, gap: job.gap, seed: 1009 + k * 7919, opts: JSON.stringify({ noimp: 100, strikes: 2, csamp: 100, fsamp: 50 }) });
  }
  return { stop: () => finish({ stopped: true }), threads, startedAt: performance.now(), seconds };
}
