# Training video recorder

Drives the real single-file app with Playwright and renders an MP4 with captions.

```
npm run build:single
node scripts/training/tee.cjs        # → scripts/training/tee.mp4 (needs ffmpeg, pdftoppm)
DRY=1 STOP=front node scripts/training/tee.cjs   # fast check: debug screenshots, no video
```
The app exposes `window.prowdcad = { app, canvas }` for scripting.
