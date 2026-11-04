# ProwdCAD — Design workspace (`apps/web`)

Vite + TypeScript, no framework: plain DOM + SVG. The kernel is imported from
`@prowdcad/kernel` (aliased to `../../packages/kernel/src/index.ts`).

## Run

```bash
npm install                 # once, at the repo root (workspaces)
npm run dev                 # from the repo root, or `npx vite` in apps/web
npm run build               # → apps/web/dist (no runtime CDN)
npx tsc --noEmit -p apps/web
```

## Layout

| Area | What it holds |
|---|---|
| Top | Menubar (File / Edit / Piece / Point / Segment / Seam / Dart / Grade / Measure / View / Help), built from the command registry |
| Left | Tool palette. Tools in the same group share one button with a corner triangle: right-click or long-press it to open the flyout |
| Centre | White sheet (SVG), infinite, y-up world in mm. Rulers (drag one out to make a guide; drop it back on the ruler to remove it; double-click a ruler to clear all guides) and an adaptive grid |
| Right | Pieces list · Sizes (size line, active size, nested view) · Inspector |
| Bottom | Grading table (Ctrl+G) · status bar (cursor, unit, active size, zoom, hints) |

All lengths are typed in the current display unit and accept decimals **or** fractions:
`12.5`, `1 1/8`, `1.1/8`, `1-1/8`, `9/8`. You can also add a unit suffix: `2cm`, `1"`, `30mm`.

## Tools

| Tool | Key | Usage |
|---|---|---|
| Select / Edit | V | Click a point or piece to select it (Shift adds to the selection). Drag a point (base size), or drag a nested-size point to change grading. Drag a handle (Alt breaks the handle link). Drag a piece to move it (`piece.layout`). Drag on empty space for a marquee. Shift constrains to H/V/45°. Alt-click or double-click a point toggles corner ⇄ smooth |
| Pen — new piece | P | Click for a corner, click-drag for a smooth point with handles, Ctrl+click for a curve point. Click the start point (or press Enter) to close and create the piece. Backspace removes the last point. Right-click opens the exact-next-point dialog |
| Internal line / polygon | I | Start inside a piece. Snaps to the outline (~10 px, orange ring) and to points. Ctrl = curve point, Shift = H/V/45°. Click the start point to make a polygon. Double-click (detected manually) or Enter ends an open line. Right-click opens a dialog for the exact next-segment length/angle and for mirror creation (Local / X / Y) |
| Rectangle | R | Drag (Shift = square), or click for a W×H dialog |
| Circle | C | Drag the radius, or click for a dialog by Ø or by perimeter |
| Polygon / Rounded rect | (flyout) | Drag, or click for a dialog |
| Notch | N | Click a sew-line point |
| Drill | D | Click inside a piece |
| Measure | M | Click two points to get L / dX / dY / angle in the status bar. Alt-click a line to get its grade-segment length |
| Hand | H | Drag to pan. Space+drag or middle-drag pans from any tool |
| Zoom | Z | Click to zoom in, Alt-click to zoom out, drag to zoom to a box. The wheel zooms to the cursor in every tool |

Every tool: **Enter** finishes, **Esc** cancels, **Backspace** removes the last draft point.

## Main hotkeys (all remappable: Edit ▸ Keyboard shortcuts…)

| Keys | Command |
|---|---|
| Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z | Undo / redo (`doc.undo/redo`, 200 steps) |
| Ctrl+S / Ctrl+Shift+S / Ctrl+O / Ctrl+Alt+N | Save / Save As / Open / New |
| Delete, Backspace | Delete the selected points (or pieces) |
| Ctrl+D · Ctrl+A · Ctrl+Shift+A | Duplicate piece · select all pieces · select all points of a piece |
| Arrows (Shift = ×10) | Nudge points or pieces. In a non-base size, nudging moves grading |
| Alt+C · Alt+G · Alt+I | Corner⇄smooth · grade⇄curve point · insert point after |
| Alt+S | Seam allowance of the selected segment(s) |
| Ctrl+G · Alt+N · Alt+T | Grading table · nested view · point tracking (←/→ moves between points, ↑/↓ changes size) |
| Ctrl+[ / Ctrl+] / Ctrl+B | Previous / next / base size |
| Ctrl+Alt+C / Ctrl+Alt+V | Copy / paste grade |
| Ctrl+0, F · Shift+F · Ctrl+1 · +/- | Fit · fit selection · 100 % · zoom |
| Ctrl+' · Ctrl+Alt+R | Grid · rulers |
| Ctrl+I | Piece info (all sizes) |
| F1 | Shortcut list |

The hotkey map is stored in browser settings as JSON. Only overrides are saved, and an empty
string unbinds a command. **Edit ▸ Customize toolbar…** shows or hides palette tools; hidden
tools keep their shortcuts.

## Persistence and safety

- Native files are the kernel `Style` JSON (`schema: "prowdcad/2"`). The app uses the File System Access API when the browser has it; otherwise it falls back to `<input type=file>` and a download.
- Every 30 s, unsaved work is backed up to `localStorage`. On the next load, a recovery dialog offers Restore / Keep for later / Discard.
- All `localStorage` access goes through try/catch (`settings.ts → store`).
- Dialogs are in-app modals only (`ui/dialog.ts`, promise-based). The app never uses `prompt` or `alert`.

## Architecture

```
src/
  main.ts            entry: layout, keyboard routing (tool → point tracking → registry), bootstrap
  app.ts             App state: Document, viewport, selection, active size, nested view, drag previews
  commands.ts        command registry: registerCommand({id,title,menu,hotkey,run}), hotkey matching
  ops-bridge.ts      KernelOps interface + placeholders (NotWiredError → toast) + wireOps()
  geometry.ts        layout transforms, preview resolution, hit-testing, grade helpers
  settings.ts        persisted UI settings (guarded localStorage)
  units-ui.ts        display-unit format/parse on top of kernel parseLengthAuto/formatLength
  canvas/            view.ts (y-up ⇄ screen), canvas.ts (events, pan/zoom, rulers, guides), render.ts, snap.ts
  tools/             select, pen, internal, shapes, marks (notch/drill), misc (measure/zoom/hand)
  panels/            inspector, pieces, sizes, grading, dock, widgets
  ui/                dialog, toast, menu (menubar + context menu), palette, statusbar, dom
  actions/           file.ts (new/open/save/export/backup), register.ts (all built-in commands)
```

Drags edit a cloned **preview** piece and commit **one** `doc.transact` on release. Esc
cancels, and the undo history stays clean.

### Wiring kernel ops (integrator)

```ts
import { wireOps } from './ops-bridge';
import { addDart } from '@prowdcad/kernel';            // once exported from src/index.ts
wireOps({ addDart: (doc, a) => addDart(doc, a), /* … */ });
```

Help ▸ Kernel ops status lists every op as `stub`, `fallback` or `wired`.
