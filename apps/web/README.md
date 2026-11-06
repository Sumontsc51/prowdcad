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
| Under the menubar | **Tool-options strip**: active tool, its modes (Select: the selection filter; Move Point: Single / Smooth / Horizontal / Vertical / Along line / Group; Move Line: Translate / Parallel; Piece: Move / Rotate / Flip) and the mode indicator (amber **Editing size L grading** when a non-base size is active) |
| Left | Tool palette. Tools in the same group share one button with a corner triangle: right-click or long-press it to open the flyout |
| Centre | White sheet (SVG), infinite, y-up world in mm. Rulers (drag one out to make a guide; drop it back on the ruler to remove it; double-click a ruler to clear all guides) and an adaptive grid |
| Right | Pieces list · Sizes (size line, active size, nested view) · Inspector |
| Bottom | Grading table (Ctrl+G) · status bar (cursor, unit, active size, zoom, selection counts, the **step prompt** of the active tool, last message) |

All lengths are typed in the current display unit and accept decimals **or** fractions:
`12.5`, `1 1/8`, `1.1/8`, `1-1/8`, `9/8`. You can also add a unit suffix: `2cm`, `1"`, `30mm`.

## Tools

| Tool | Key | Usage |
|---|---|---|
| Select | V | **Selection only: never moves or reshapes geometry.** Click = replace, Shift+click = add, Ctrl+click = toggle, click on empty sheet (or Esc) = clear. Drag anywhere = box: left → right = **window** (fully inside), right → left = **crossing** (touching, dashed green); Shift+drag adds, Ctrl+drag toggles. When several objects are under the cursor the status bar lists them and **Tab** cycles. Double-click a piece = all its points. Filter chips (tool-options strip, keys **0–5**): All · Pieces · Points · Lines · Internals · Marks. Hover pre-highlights what a click takes. Opt-in: Edit ▸ **Allow drag-move in Select (moves only what you grab)** |
| Move Point | G | Modes (Tab cycles): **Single** (default: exactly the grabbed point moves, see below) · **Smooth** (AccuMark Move Smooth: two tacks on the neighbouring grade points, drag a tack onto another point of the line to change the range; the points strictly between the tacks blend, `moveProportional`; works per size) · **Horizontal / Vertical** (Single locked to X / Y) · **Along line** (slide on its own contour, `moveAlongContour`, base size only) · **Group** (every selected point by the same delta, `multiMove`). Press on a point and drag, or click it (it follows the cursor) and click the new spot. Shift = H/V/45°, Alt = no snap. Typing a digit, `-` or `.` (or right-click) opens the **input box**: dX dY · distance ∠ · absolute X Y (piece frame; fractions, `12,5` = dX 12 dY 5). Enter / right-click = OK, Esc = cancel, Enter with nothing typed repeats the last move, Backspace = undo the pick, Esc when idle = back to Select. Arrows nudge (Shift ×10) |
| Move Line / Segment | Shift+G | Click a sew segment (grade point → grade point) or an internal line, then drag (or click-click). The two end grade points and the curve points of that segment move by the same delta (an internal line moves whole); nothing else. **Parallel** mode locks the motion to the line normal. Input box: dX dY · distance ∠ · offset |
| Move / Rotate / Flip Piece | Ctrl+Shift+G | **Move**: drag a piece (selected pieces move together); while dragging R / Shift+R = ±90°, Q W = ±1°, A S = ±10°, X / Y = flip. **Rotate**: drag about the piece centre (Ctrl = 15° steps) or type the angle. **Flip**: click = left ⇄ right, Shift+click = up ⇄ down. Changes `piece.layout` only (sheet placement; exports keep the authored geometry). Locked pieces are refused |
| Curve / Handle | Shift+C | Click a point to show its handles; drag a handle (Alt = break the pair, Shift = H/V/45°); click a handle then type (or right-click) for length / angle; Shift+click (or double-click) a point = corner ⇄ smooth. Base size only (handles are not graded) |
| Pen — new piece | P | Click = corner, click-drag = smooth with handles, Ctrl+click = curve point. Click the start point (or Enter) to close. Right-click = exact next point |
| Internal line / polygon | I | Start inside a piece; snaps to outline/points; Ctrl = curve, Shift = H/V/45°; click start = polygon; double-click / Enter ends; right-click = exact length/angle + mirror |
| Smooth run | Shift+M | Click the first then the last point of a run → live preview of `smoothRun` (max deviation in the status bar). Click points in between to keep them. Right-click / Enter = apply, Esc = cancel |
| Rectangle / Circle / Polygon / Rounded rect | R / C / flyout | Drag, or click for a dialog |
| Seam value | S | Click the first sew grade point, then the last one of the run (same point = whole loop) → dialog (value as decimal or fraction, + outward / − inward) → `setSeam`. Double-click a piece = whole-piece seam |
| Notch | N | Click on a sew or internal line → dialog: placement (on point / from previous / from next / proportional %), type, depth, width, angle, cut/draw. Click an existing notch = notch grid editor. Notches render from `resolveNotch` cut geometry, in every size in the nested view |
| Drill / button | D | Click inside a piece → dialog (drill / button / buttonhole, Ø, cut/draw). Click an existing drill = edit / duplicate with offset / delete |
| Text | T | Click inside a piece → text dialog. Click an existing text = edit / delete |
| Dart | Shift+D | Click a sew line → *Create dart* dialog (width, apex by depth or by a clicked point, fold toward leg A/B, drill offset) → `createDart`. Click a dart (legs or axis) to select it: the Inspector shows width, depth, fold, drill offset, Closed (close / reopen, exact restore), Cutting dart (+ seam on the legs), live leg lengths, and buttons for Fix dart, Change darts, Copy / Paste, Pivot transfer, Rotate around centre, Cut all, Remove (restore / keep fullness) |
| Pleat | Shift+L | Click the axis START then END → pleat dialog (knife / box, depth at start / end, fold, auto notches, open now). Alt on the second click = **Add Pleat Axis** only; set the attributes in the Inspector, then Open. Click a pleat to select it (Inspector: type, depths, fold, moving side, notches, openings, Open / Close / Open all / Close all / Delete) |
| Add fullness | Shift+U | Click the SLASH point on a sew line, then the PIVOT (on the sew line = hinge, inside the piece = rotation centre) → dialog (opening at the slash, opening at the hinge, rotate / parallel, moving side) → `addFullness`. Click a slash line to select the record (Delete = exact restore) |
| Slash | K | Click points across a piece (snaps; Shift = H/V/45°; Backspace removes a point), Enter or right-click → dialog (zero / auto grade of the new cut points, seam on the new edges) → `slashPiece` |
| Trace segments | Shift+T | Click points (straight joins); Alt-click two points of one contour to take the run between them (Shift+Alt = backwards); Enter → new piece (`traceSegments`) |
| Measure | M | Click two points: L / dX / dY / angle, plus a per-size table when both are points of one piece. Ctrl-click 3 points = angle. Alt-click a line = grade-segment length per size with chord dX/dY (Shift+Alt-click extends the run). Alt-click a point = per-size position and dX/dY from base |
| Walk pieces | W | Click the start point on the MOVING piece, then on the STATIONARY piece. →/↑ or wheel = step forward, ←/↓ = back (Shift ×10, Alt ×0.1). `[` `]` halve/double the step, S = step dialog, R = ratio, T = walk to a distance, K = skip darts on/off, F / G / B flip moving / stationary / both. N drops notches on both pieces, Shift+N stationary only, Alt+N moving only. The HUD shows the running lengths and Δ. Esc ends. Only dropped notches are written to the document |
| Hand / Zoom | H / Z | Pan / zoom (wheel zooms everywhere except while walking) |

Every tool: **Enter** finishes, **Esc** cancels, **Backspace** removes the last draft point.

### Selection model

- Selectable objects: grade and curve points, **sew segments** (grade point → next grade point), **internal lines**, **notches**, **drills / buttons / texts**, darts / pleats / fullness, pieces. Selected objects are orange (segments and internals get a thick overlay with a direction arrow; points a filled orange square; the primary point of a multi-selection a ring).
- `app.sel` = `{ pieces, anchors, segments, internals, notches, marks, primary }` (`app.ts`). `pieces` also lists the piece of every selected sub-object (Inspector / piece commands). `app.applySel(item, 'replace' | 'add' | 'toggle' | 'remove')`, `app.isSelected(item)`, `app.clearSelection()`.
- The selection **persists** across commands, dialogs, undo / redo (ids are kept; only objects that no longer exist drop out), size switches and tool switches. Only Esc (Select), a click on empty sheet (Select), Edit ▸ Deselect all and opening a file clear it.
- Commands use the selection when it fits and fall back to a canvas pick otherwise: a selected segment is "the segment / run" (`selectedRun`), a selected internal line is "the internal line" (`internalOrPick`).
- Move tools adopt the selection (noun → verb) and the picked object becomes the selection. Grabbing a point that is already part of a multi-selection keeps the selection; only Group mode moves the others.

### Move Point · Single: what exactly changes

- Base size: the grabbed anchor's stored `x / y`; its handles are stored relative to it, so they move rigidly with it. Every other anchor, curve point and handle keeps its stored data.
- Non-base size (amber indicator): only that anchor's grading for the active size; its base position and every other size stay put.
- **The one exception: point connections** (Piece ▸ Connections). An internal point connected to the moved sew point follows it; the prompt says so and the connected point is marked "connected" on the sheet.
- Curve points carry no grading of their own unless edited, so in a graded size a curve point next to a moved grade point follows its neighbours' grading. That is expected.
- Along line re-inserts the point on the existing curve: neighbouring points keep their position and grading; their Bézier handles may be re-fitted so the shape stays the same.

### Canvas picks

Darts, pleats and fullness records are **live objects**: they render in every displayed size (nested view included) from the kernel geometry (`dartSewGeometry`, graded pleat axes, the slash / hinge anchors of each fullness record): dart legs + apex + dashed axis (closed dart: axis only) and a drill mark at the drill offset; pleat axis (dash-dot), fold lines and shaded inserted fabric when open, fold-direction ticks when closed; fullness slash lines (dashed) and shaded wedges. Each has a hit target: clicking it with Select or its own tool selects it (orange highlight) and shows its Inspector section; right-click opens its context menu; Delete removes it (darts ask restore / keep fullness). The cut line follows `dartCutShape`: a folded dart gets its dart cap, a cutting dart is cut into the legs.

Commands that need geometry ask for it on the canvas when the selection does not already provide it. The status bar shows the prompt; Esc cancels. Examples: *Seam ▸ Seam of segment* (click a segment), *Join pieces* (segment on A, then on B), *Binding generator* (click a chain of segments on any pieces, then Enter), *Compare length ▸ Add +/−* (click segments; Shift = reverse), *Manual seam angle* (corner, then two trim clicks), *Rotate segment* (segment, then the pivot end, then the new direction with a live preview), *Fold in* (two fold points, then the side to keep), *Half piece* (two axis points), *Build piece* (click inside a region), *Multi buttons* (two references: points or drills).

A "segment" from the selection means one of two things: two selected points on one contour (a run from the first to the second), or one selected grade point (the grade segment that leaves it).

## Menus

| Menu | Highlights |
|---|---|
| File | New, Open / Save (via `io/native`: validation and migrations; a preview PNG is attached on save), Import DXF + .rul pair / SVG (DPI prompt) / PLT (device profile) with an import report, Export DXF AAMA/ASTM (+ .rul as a second download), SVG, PLT, tiled 1:1 PDF (page size, margins, overlap, sizes), size as standalone style, merge from another style |
| Piece | **Modify Piece ▸** Move / Rotate / Flip tool, Flip selected left ⇄ right / up ⇄ down, Rename, lock, rotate, Scale & shrink (percent / shrinkage proportional to 100 / target / add; nest or base grading; seam scaling; description stamp), Layout save/restore, Grain (angle, recenter, parallel to segment, rotate piece to grain), Reference block, Point connections, Versions (save as new, replace old, archive), Merge |
| Edit | Undo / redo, Delete, Duplicate, Select all (filter), Selection filter ▸, Deselect all, Nudge step, **Preferences…** (drag-move in Select, pick radius, nudge step), **Allow drag-move in Select (moves only what you grab)**, Keyboard shortcuts, Customize toolbar |
| Point | **Modify Points ▸** Move Single Point / Move Smooth / Move Point Horizontal / Move Point Vertical / Move Point Along Line / Move Points (group) (each opens Move Point in that mode), Corner/smooth, grade/curve, break/join handles, start point, Add point (from start / from end / %), add at click, Move XY (delta / absolute; in a non-base size it edits only that size's grading), Move along contour, Move proportional, Multi move, Align H/V/angle, Set angle, Round corner, Spline support points, Points cleanup, Delete |
| Segment | **Modify Line ▸** Move Line / Move Parallel / Curve tool, Set exact length (method picker), Copy/Paste segment (modes, flip), Rotate segment keeping length, Swap internal ⇄ perimeter, Divide/Join internals, Dashed ⇄ solid, Trim at intersections, Global check & trim, Global join, Extend (by value / up to a line), Smooth tool |
| Seam | Seam tool, segment/run, whole piece, global, Corner type gallery (miter / boxed prev/next/both / turnback / angled / manual), Manual seam angle, Revert corner, Lock grading, Update seam grading, Reseam / Reseam all / Reseam segment, Repair parameters, Seam → internal, Internal → seam, Manual cut → auto, Delete / remove seam, Auto reseam, Show cut-line corner indices |
| Notch | Notch tool, notch grid editor (per-size distances, fill all, extrapolate increment, paste TSV, convert, delete), notch on points, corner notch, cross notch, Add points for notches, Global notch grading, Notch setup, Drill tool, Duplicate with offset, Multi buttons, Slit contour segment, Text tool, Place artwork (file picker → data URL), Binding generator |
| Cut | Slash tool, Cut along internal, Cut H/V at point (with offset), Cut parallel strip, Cut by guideline (drag a guide from a ruler first), Parallel internal, Extend/shrink parallel, Shapers (arc by depth/radius/length/through-point, wave, scallop/zigzag, ruffle, circular skirt), Trace, Build piece, Join pieces, Fold in/out, Half piece set/open/delete |
| Grade | Grading table (its toolbar has the same power ops), nested view, absolute values, point tracking, rule names on the canvas, Clipboard (copy, paste, X only, Y only, flipped, Smart paste, Paste around), Edit (flip, equal, delete X/Y/all, stack point, stack along line, angle grading with auto-aim, grade parallel, grade proportionally), Rule library window (libraries; rules from values / point / contour; apply by number or name; Load sizes), Apply/Detach rule, Movement programs window (programs, moves from the selection, apply delta, measurement sets), Graded nest from pieces (selection order = smallest → largest), Sizes (axis-2 variation, delete ungraded / invisible) |
| Dart | Add dart at point (selected sew point), Multi darts (segment pick → N, width, depth), Insert dart (slash point, pivot pick or Enter = automatic, width, depth), Close / reopen (Ctrl+Alt+D), Reopen at width, Fix dart, Cutting on/off, Change darts (flip every fold), Close / reopen all darts of the piece, Cut all darts (piece or all; cutting or folded), Pivot transfer (Shift+Alt+T: dart → target on the contour → % (default 100) + optional pivot click), Rotate around offset centre (dart → target → centre → %, default 50; the two darts share the apex), Copy / Paste dart (paste on a clicked sew line of any piece), Remove dart. **Pleat ▸** Add pleat axis (attributes later), Add pleat, Add by angle, Multi pleat (segment pick), Open / close selected, Open / close all, Delete. **Fullness ▸** Add fullness, Multi fullness (slash segment, hinge segment, N, first / last width, mode), Delete fullness (exact restore; later spreads are re-applied) |
| Measure | Measure / Walk tools, Piece info (all sizes), Compare length window (+/− segments, mode, per-size table, *Edit segment to target* → `segmentLengthSetTo`), Walking check report, Segment length per size, Notches on segment |

The **Sizes panel** has Insert (before / after, with the neighbour-increment fraction: 0.5 = half size; extrapolates at the ends), Append, Set base, Remove, Axis 2, Delete ungraded / invisible, Size → standalone style. Double-click a size chip to rename it or change its colour.

The **Inspector** shows *Lock grading* for a piece. For a sew grade point it adds the corner gallery button, revert corner, the start point, the rule name, and the seam of the leaving segment (typed values go through `reseamSegment`; a negative value is inward).

## Main hotkeys (all remappable: Edit ▸ Keyboard shortcuts…)

| Keys | Command |
|---|---|
| Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z | Undo / redo (200 steps) |
| Ctrl+S / Ctrl+Shift+S / Ctrl+O / Ctrl+Alt+N | Save / Save As / Open / New |
| Ctrl+Shift+I · Ctrl+Shift+E · Ctrl+P | Import · Export DXF (+RUL) · Export tiled PDF |
| Delete, Backspace | Delete the selection: points, else notches / drills / texts / internal lines, else pieces (asks). Backspace inside a Move tool = undo the last pick |
| V · G · Shift+G · Ctrl+Shift+G · Shift+C | Select · Move Point · Move Line · Move / Rotate / Flip Piece · Curve / Handle |
| 0 1 2 3 4 5 (Select) · Tab | Filter All / Pieces / Points / Lines / Internals / Marks · cycle the objects under the cursor (Select) or the mode (Move tools) |
| Ctrl+D · Ctrl+A · Ctrl+Shift+A | Duplicate piece · select all of the current filter (All = pieces) · select all points of a piece |
| Arrows (Shift = ×10) | Nudge the selection **only while a Move tool is active** (Move Point: the picked point, Group: all selected points; Move Line: the line; Piece: the selected pieces). In Select the arrows do nothing |
| Alt+C · Alt+G · Alt+I · Alt+A · Shift+Alt+A | Corner⇄smooth · grade⇄curve · insert point after · Add point… · add point at click |
| Alt+M · Shift+Alt+H / Shift+Alt+V | Move point XY dialog · align H / V |
| Alt+L · Alt+O · Ctrl+Alt+Shift+C / V | Segment length · rotate segment · copy / paste segment |
| Alt+S · Alt+K · Shift+Alt+K · Ctrl+Alt+S | Seam of segment · corner gallery · manual seam angle · reseam piece |
| Ctrl+Shift+N · Ctrl+Alt+B | Notch grid · binding generator |
| Alt+B · Alt+J · Alt+Shift+P | Build piece · join pieces · parallel internal |
| Ctrl+G · Alt+N · Alt+T | Grading table · nested view · point tracking |
| Ctrl+[ / Ctrl+] / Ctrl+B | Previous / next / base size |
| Ctrl+Alt+C / V / X / Y / M | Copy grade / paste / paste X only / paste Y only / Smart paste |
| Ctrl+R · Ctrl+Shift+R | Apply rule by number or name · rule library |
| Ctrl+I · Ctrl+Shift+L | Piece info · Compare length |
| Shift+D · Shift+L · Shift+U | Dart · Pleat · Add fullness tools |
| Ctrl+Alt+D · Shift+Alt+T | Close / reopen dart · Pivot transfer |
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
  ops-bridge.ts      typed kernel op surface + placeholders (NotWiredError → toast) + wireOps(); kernel-wiring.ts wires it (+ LiveOps wrappers)
  live.ts            darts / pleats / fullness: per-size geometry, hit-testing, live selection
  hitkit.ts / selection.ts   hit-testing and selection → kernel argument helpers
  geometry.ts        layout transforms, preview resolution, hit-testing, grade helpers
  settings.ts        persisted UI settings (guarded localStorage)
  units-ui.ts        display-unit format/parse on top of kernel parseLengthAuto/formatLength
  canvas/            view.ts (y-up ⇄ screen), canvas.ts (events, pan/zoom, rulers, guides), render.ts, snap.ts
  selpick.ts         selection hit-testing: ranked candidates under the cursor, window / crossing box gathering, selection highlight
  tools/             select (selection only), move (Move Point / Move Line / Piece / Curve), pen, internal, shapes, marks (notch/drill/text), seam, live (dart/pleat/fullness), walk, construct (smooth/slash/trace), misc (measure/zoom/hand), pick
  panels/            inspector, pieces, sizes, grading (+ toolbar), notchgrid, rules, movement, dock, widgets
  ui/                dialog (+ remembered, popover), inputbox (Move-tool input box), toolopts (tool-options strip), window, toast, menu (menubar + context menu), palette, statusbar, dom
  actions/           file.ts (native io, import/export, preview, backup), register.ts + per-menu command modules
```

Drags edit a cloned **preview** piece and commit **one** `doc.transact` on release. Esc
cancels, and the undo history stays clean. The Move tools run the real kernel op (`movePoint`,
`moveProportional`, `moveAlongContour`, `multiMove`) on a scratch copy of the piece for the live
preview (`tools/move.ts → previewWith`), then once on the document (`commitWith`), so the preview
is exactly what is committed.

Piece layout (`piece.layout`: x, y, angleDeg, optional flipX / flipY) is sheet placement only. The
kernel helpers `layoutToWorld / layoutToLocal / flippedLayout / rotatedLayout / transformPieceLayouts`
(ops/pieces) define it; exports write the authored geometry and never apply the layout.

### End-to-end checks

`node scripts/e2e-move/run.cjs` (starts Vite on :5289, or `E2E_MOVE_URL=…`) drives the real UI with
Playwright and proves: Select never changes the document; Move Point Single changes exactly one
anchor (base and graded); Smooth changes only the points between the tacks; Move Line only the
segment's points; the selection survives Copy grade, a seam command, undo / redo, size and tool
switches; typed input-box values (fractions, inch mode, absolute) land exactly.

### Kernel ops bridge

`ops-bridge.ts` lists every kernel function the UI uses (`KERNEL_GROUPS`, about 200 functions, grouped by module). `ops` is typed as `Pick<typeof kernel, …>`, so UI calls are type-checked against the kernel's public API. `kernel-wiring.ts → wireKernel()` (called first thing in `main.ts`) replaces the placeholders with the real exports.

The live-object modules (`ops/darts`, `ops/pleats`, `ops/fullness`) are wired like every other group. Four convenience wrappers with hand-written signatures (`LiveOps`, implemented in `kernel-wiring.ts → liveOpsImpl`) sit on top: `addDart` (→ `createDart`), `rotateDart` (→ `transferDart`, or `rotateDartAroundCenter` when `center` is given), `toggleDartClosed` (→ `closeDart` / `openDart`) and `addPleat` (→ `addPleatAxis` + `openPleat` in one undo step). Fullness is called directly through `addFullness`. To override any op:

```ts
import { wireOps } from './ops-bridge';
wireOps({ addDart: (doc, a) => /* … */ });
```

Help ▸ Kernel ops status lists every op as `wired` or a placeholder.

Shared UI infrastructure for the kernel commands:

- `hitkit.ts`: geometric hit-testing (anchor, contour, segment, drill) that also covers unselected pieces.
- `tools/pick.ts`: promise-based canvas picks.
- `selection.ts`: selection → segment, run or anchor, with a pick fallback.
- `ui/window.ts`: draggable non-modal windows.
- `ui/dialog.ts`: `rememberedDialog` and `popover`.
- `actions/*-cmds.ts`, `seam-notch.ts`, `point-seg.ts`, `cut-piece.ts`: the menus (`live-cmds.ts` = Dart / Pleat / Fullness).
- `live.ts`: live-object display geometry, hit-testing (`liveNear`), contour hit → `LiveContourPos`, `app.liveSel`; `tools/live.ts` the Dart / Pleat / Fullness tools; `panels/live-inspector.ts` their Inspector sections.
- `panels/notchgrid.ts`, `rules.ts`, `movement.ts`: the floating editors.
