import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: { '@prowdcad/kernel': resolve(__dirname, '../../packages/kernel/src/index.ts') } },
  build: { outDir: 'dist', target: 'es2022' },
  worker: { format: 'es' },
});
