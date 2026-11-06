// Builds apps/web and inlines JS+CSS into one self-contained file: dist/prowdcad-v2.html
// Usage: npm run build:single   → open dist/prowdcad-v2.html in Chrome/Edge (works offline).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
execSync('npx vite build --base ./', { cwd: 'apps/web', stdio: 'inherit' });
const dist = 'apps/web/dist', assets = join(dist, 'assets');
const files = readdirSync(assets);
const js = readFileSync(join(assets, files.find(f => f.endsWith('.js'))), 'utf8');
const css = readFileSync(join(assets, files.find(f => f.endsWith('.css'))), 'utf8');
let html = readFileSync(join(dist, 'index.html'), 'utf8')
  .replace(/<script type="module" crossorigin src="[^"]+"><\/script>/, '')
  .replace(/<link rel="stylesheet" crossorigin href="[^"]+">/, () => `<style>${css}</style>`)
  .replace('</body>', () => `<script type="module">${js}</script>\n</body>`);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/prowdcad-v2.html', html);
console.log('wrote dist/prowdcad-v2.html', html.length, 'bytes');
