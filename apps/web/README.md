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
| Select / Edit | V | Click a point or piece to select it (Shift adds to the selection). Drag a point (base size) or a nested-size point (that size's grading). Drag a handle (Alt breaks the link). Drag a piece to move it. Drag on empty space for a marquee. Shift constrains to H/V/45°. Alt-click or double-click toggles corner ⇄ smooth. With **Point ▸ Proportional drag** (Alt+P) on, a point drag blends the curve run (`moveProportional`) |
| Pen — new piece | P | Click = corner, click-drag = smooth with handles, Ctrl+click = curve point. Click the start point (or Enter) to close. Right-click = exact next point |
| Internal line / polygon | I | Start inside a piece; snaps to outline/points; Ctrl = curve, Shift = H/V/45°; click start = polygon; double-click / Enter ends; right-click = exact length/angle + mirror |
| Smooth run | Shift+M | Click the first then the last point of a run → live preview of `smoothRun` (max deviation in the status bar). Click points in between to keep them. Right-click / Enter = apply, Esc = cancel |
| Rectangle / Circle / Polygon / Rounded rect | R / C / flyout | Drag, or click for a dialog |
| Seam value | S | Click the first sew grade point, then the last one of the run (same point = whole loop) → dialog (value as decimal or fraction, + outward / − inward) → `setSeam`. Double-click a piece = whole-piece seam |
| Notch | N | Click on a sew or internal line → dialog: placement (on point / from previous / from next / proportional %), type, depth, width, angle, cut/draw. Click an existing notch = notch grid editor. Notches render from `resolveNotch` cut geometry, in every size in the nested view |
| Drill / button | D | Click inside a piece → dialog (drill / button / buttonhole, Ø, cut/draw). Click an existing drill = edit / duplicate with offset / delete |
| Text | T | Click inside a piece → text dialog. Click an existing text = edit / delete |
| Slash | K | Click points across a piece (snaps; Shift = H/V/45°; Backspace removes a point), Enter or right-click → dialog (zero / auto grade of the new cut points, seam on the new edges) → `slashPiece` |
| Trace segments | Shift+T | Click points (straight joins); Alt-click two points of one contour to take the run between them (Shift+Alt = backwards); Enter → new piece (`traceSegments`) |
| Measure | M | Click two points: L / dX / dY / angle, plus a per-size table when both are points of one piece. Ctrl-click 3 points = angle. Alt-click a line = grade-segment length per size with chord dX/dY (Shift+Alt-click extends the run). Alt-click a point = per-size position and dX/dY from base |
| Walk pieces | W | Click the start point on the MOVING piece, then on the STATIONARY piece. →/↑ or wheel = step forward, ←/↓ = back (Shift ×10, Alt ×0.1). `[` `]` halve/double the step, S = step dialog, R = ratio, T = walk to a distance, K = skip darts on/off, F / G / B flip moving / stationary / both. N drops notches on both pieces, Shift+N stationary only, Alt+N moving only. The HUD shows the running lengths and Δ. Esc ends. Only dropped notches are written to the document |
| Hand / Zoom | H / Z | Pan / zoom (wheel zooms everywhere except while walking) |

Every tool: **Enter** finishes, **Esc** cancels, **Backspace** removes the last draft point.

### Canvas picks

Commands that need geometry ask for it on the canvas when the selection does not already provide it. The status bar shows the prompt; Esc cancels. Examples: *Seam ▸ Seam of segment* (click a segment), *Join pieces* (segment on A, then on B), *Binding generator* (click a chain of segments on any pieces, then Enter), *Compare length ▸ Add +/−* (click segments; Shift = reverse), *Manual seam angle* (corner, then two trim clicks), *Rotate segment* (segment, then the pivot end, then the new direction with a live preview), *Fold in* (two fold points, then the side to keep), *Half piece* (two axis points), *Build piece* (click inside a region), *Multi buttons* (two references: points or drills).

A "segment" from the selection means one of two things: two selected points on one contour (a run from the first to the second), or one selected grade point (the grade segment that leaves it).

## Menus

| Menu | Highlights |
|---|---|
| File | New, Open / Save (via `io/native`: validation and migrations; a preview PNG is attached on save), Import DXF + .rul pair / SVG (DPI prompt) / PLT (device profile) with an import report, Export DXF AAMA/ASTM (+ .rul as a second download), SVG, PLT, tiled 1:1 PDF (page size, margins, overlap, sizes), size as standalone style, merge from another style |
| Piece | Rename, lock, rotate, Scale & shrink (percent / shrinkage proportional to 100 / target / add; nest or base grading; seam scaling; description stamp), Layout save/restore, Grain (angle, recenter, parallel to segment, rotate piece to grain), Reference block, Point connections, Versions (save as new, replace old, archive), Merge |
| Point | Corner/smooth, grade/curve, break/join handles, start point, Add point (from start / from end / %), add at click, Move XY (delta / absolute; in a non-base size it edits only that size's grading), Move along contour, Move proportional, Multi move, Align H/V/angle, Set angle, Round corner, Spline support points, Points cleanup, Delete |
| Segment | Set exact length (method picker), Copy/Paste segment (modes, flip), Rotate segment keeping length, Swap internal ⇄ perimeter, Divide/Join internals, Dashed ⇄ solid, Trim at intersections, Global check & trim, Global join, Extend (by value / up to a line), Smooth tool |
| Seam | Seam tool, segment/run, whole piece, global, Corner type gallery (miter / boxed prev/next/both / turnback / angled / manual), Manual seam angle, Revert corner, Lock grading, Update seam grading, Reseam / Reseam all / Reseam segment, Repair parameters, Seam → internal, Internal → seam, Manual cut → auto, Delete / remove seam, Auto reseam, Show cut-line corner indices |
| Notch | Notch tool, notch grid editor (per-size distances, fill all, extrapolate increment, paste TSV, convert, delete), notch on points, corner notch, cross notch, Add points for notches, Global notch grading, Notch setup, Drill tool, Duplicate with offset, Multi buttons, Slit contour segment, Text tool, Place artwork (file picker → data URL), Binding generator |
| Cut | Slash tool, Cut along internal, Cut H/V at point (with offset), Cut parallel strip, Cut by guideline (drag a guide from a ruler first), Parallel internal, Extend/shrink parallel, Shapers (arc by depth/radius/length/through-point, wave, scallop/zigzag, ruffle, circular skirt), Trace, Build piece, Join pieces, Fold in/out, Half piece set/open/delete |
| Grade | Grading table (its toolbar has the same power ops), nested view, absolute values, point tracking, rule names on the canvas, Clipboard (copy, paste, X only, Y only, flipped, Smart paste, Paste around), Edit (flip, equal, delete X/Y/all, stack point, stack along line, angle grading with auto-aim, grade parallel, grade proportionally), Rule library window (libraries; rules from values / point / contour; apply by number or name; Load sizes), Apply/Detach rule, Movement programs window (programs, moves from the selection, apply delta, measurement sets), Graded nest from pieces (selection order = smallest → largest), Sizes (axis-2 variation, delete ungraded / invisible) |
| Measure | Measure / Walk tools, Piece info (all sizes), Compare length window (+/− segments, mode, per-size table, *Edit segment to target* → `segmentLengthSetTo`), Walking check report, Segment length per size, Notches on segment |

The **Sizes panel** has Insert (before / after, with the neighbour-increment fraction: 0.5 = half size; extrapolates at the ends), Append, Set base, Remove, Axis 2, Delete ungraded / invisible, Size → standalone style. Double-click a size chip to rename it or change its colour.

The **Inspector** shows *Lock grading* for a piece. For a sew grade point it adds the corner gallery button, revert corner, the start point, the rule name, and the seam of the leaving segment (typed values go through `reseamSegment`; a negative value is inward).

## Main hotkeys (all remappable: Edit ▸ Keyboard shortcuts…)

| Keys | Command |
|---|---|
| Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z | Undo / redo (200 steps) |
| Ctrl+S / Ctrl+Shift+S / Ctrl+O / Ctrl+Alt+N | Save / Save As / Open / New |
| Ctrl+Shift+I · Ctrl+Shift+E · Ctrl+P | Import · Export DXF (+RUL) · Export tiled PDF |
| Delete, Backspace | Delete the selected points (or pieces) |
| Ctrl+D · Ctrl+A · Ctrl+Shift+A | Duplicate piece · select all pieces · select all points of a piece |
| Arrows (Shift = ×10) | Nudge points or pieces (in a non-base size: grading) |
| Alt+C · Alt+G · Alt+I · Alt+A · Shift+Alt+A | Corner⇄smooth · grade⇄curve · insert point after · Add point… · add point at click |
| Alt+M · Alt+P · Shift+Alt+H / Shift+Alt+V | Move point XY · proportional drag · align H / V |
| Alt+L · Alt+O · Ctrl+Alt+Shift+C / V | Segment length · rotate segment · copy / paste segment |
| Alt+S · Alt+K · Shift+Alt+K · Ctrl+Alt+S | Seam of segment · corner gallery · manual seam angle · reseam piece |
| Ctrl+Shift+N · Ctrl+Alt+B | Notch grid · binding generator |
| Alt+B · Alt+J · Alt+Shift+P | Build piece · join pieces · parallel internal |
| Ctrl+G · Alt+N · Alt+T | Grading table · nested view · point tracking |
| Ctrl+[ / Ctrl+] / Ctrl+B | Previous / next / base size |
| Ctrl+Alt+C / V / X / Y / M | Copy grade / paste / paste X only / paste Y only / Smart paste |
| Ctrl+R · Ctrl+Shift+R | Apply rule by number or name · rule library |
| Ctrl+I · Ctrl+Shift+L | Piece info · Compare length |
| Ctrl+L · Alt+R | Lock piece · rotate 90° |
| Ctrl+0, F · Shift+F · Ctrl+1 · +/- | Fit · fit selection · 100 % · zoom |
| Ctrl+' · Ctrl+Alt+R | Grid · rulers |
| F1 | Shortcut list (complete) |

The hotkey map is stored in browser settings as JSON. Only overrides are saved, and an empty string unbinds a command. **Edit ▸ Customize toolbar…** shows or hides palette tools; hidden tools keep their shortcuts. Dialogs remember their last values per dialog (in settings).

## Persistence and safety

- Native files are the kernel `Style` JSON (`schema: "prowdcad/2"`), read and written through `io/native` (`loadNative` validates the file and migrates older schemas, including the legacy `.wptn`). The app uses the File System Access API when the browser has it; otherwise it falls back to `<input type=file>` and a download.
- Every 30 s, unsaved work is backed up to `localStorage`. On the next load, a recovery dialog offers Restore / Keep for later / Discard.
- All `localStorage` access goes through try/catch (`settings.ts → store`).
- Dialogs are in-app modals only (`ui/dialog.ts`, promise-based). The app never uses `prompt` or `alert`.

## Architecture

```
src/
  main.ts            entry: layout, keyboard routing (tool → point tracking → registry), bootstrap
  app.ts             App state: Document, viewport, selection, active size, nested view, drag previews
  commands.ts        command registry: registerCommand({id,title,menu,hotkey,run}), hotkey matching
  ops-bridge.ts      typed kernel op surface + placeholders (NotWiredError → toast) + wireOps(); kernel-wiring.ts wires it
  hitkit.ts / selection.ts   hit-testing and selection → kernel argument helpers
  geometry.ts        layout transforms, preview resolution, hit-testing, grade helpers
  settings.ts        persisted UI settings (guarded localStorage)
  units-ui.ts        display-unit format/parse on top of kernel parseLengthAuto/formatLength
  canvas/            view.ts (y-up ⇄ screen), canvas.ts (events, pan/zoom, rulers, guides), render.ts, snap.ts
  tools/             select, pen, internal, shapes, marks (notch/drill/text), seam, walk, construct (smooth/slash/trace), misc (measure/zoom/hand), pick
  panels/            inspector, pieces, sizes, grading (+ toolbar), notchgrid, rules, movement, dock, widgets
  ui/                dialog (+ remembered, popover), window, toast, menu (menubar + context menu), palette, statusbar, dom
  actions/           file.ts (native io, import/export, preview, backup), register.ts + per-menu command modules
```

Drags edit a cloned **preview** piece and commit **one** `doc.transact` on release. Esc
cancels, and the undo history stays clean.

### Kernel ops bridge

`ops-bridge.ts` lists every kernel function the UI uses (`KERNEL_GROUPS`, about 200 functions, grouped by module). `ops` is typed as `Pick<typeof kernel, …>`, so UI calls are type-checked against the kernel's public API. `kernel-wiring.ts → wireKernel()` (called first thing in `main.ts`) replaces the placeholders with the real exports.

The live-object ops for darts / pleats / fullness (`addDart`, `rotateDart`, `toggleDartClosed`, `addPleat`, `addFullness`) still have hand-written signatures and remain placeholders: they show a "not wired yet" toast. To wire them:

```ts
import { wireOps } from './ops-bridge';
wireOps({ addDart: (doc, a) => /* kernel darts op */, /* … */ });
```

Help ▸ Kernel ops status lists every op as `wired` or a placeholder.

Shared UI infrastructure for the kernel commands:

- `hitkit.ts`: geometric hit-testing (anchor, contour, segment, drill) that also covers unselected pieces.
- `tools/pick.ts`: promise-based canvas picks.
- `selection.ts`: selection → segment, run or anchor, with a pick fallback.
- `ui/window.ts`: draggable non-modal windows.
- `ui/dialog.ts`: `rememberedDialog` and `popover`.
- `actions/*-cmds.ts`, `seam-notch.ts`, `point-seg.ts`, `cut-piece.ts`: the menus.
- `panels/notchgrid.ts`, `rules.ts`, `movement.ts`: the floating editors.
