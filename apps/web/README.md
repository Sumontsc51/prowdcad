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
| Bottom | Grading table (Ctrl+G; rows = sizes) · status bar (cursor, unit, active size, zoom, selection counts, the **step prompt** of the active tool, last message) |

Panel number boxes (Inspector, grading table) compare the typed **value**, not the text: typing the shown, rounded `3/8` over an exact 10 mm writes exactly 9.525 mm. A rounded display is marked with a dotted underline; its tooltip gives the exact value. Greyed menu items say in their tooltip what they need ("needs a selected point").

**Every per-size table has one ROW per size** (`panels/sizegrid.ts`: sticky header and size column, base ★, active size highlighted, click a size name = make it active, row virtualisation above 40 rows so 80 sizes render in well under 1 s). Keyboard: arrows move the cell (← → at the text edge), Enter commits and goes down (Shift+Enter up), Tab / Shift+Tab next / previous cell, Esc reverts; Ctrl+V of an Excel block fills consecutive size rows (and columns to the right; read-only cells such as the base row are skipped), one undo step. Used by the grading table, the Grade Rules window, the Measure window, Grade by measurement and the notch grid. Piece info, Compare length, Walking check and the Measure ▸ Distance tables were already rows = sizes.

**Grading table** (`panels/grading.ts`): columns = the selected points (a dX / dY pair each; none selected = every grade point of the piece; one point adds X / Y position and the other view). Two plain-language views: **Step into this size** (incremental, AccuMark convention: the step from the neighbouring size toward the base, so smaller sizes carry their own step, kernel `outwardSteps`) and **Total from base size** (cumulative). With a cell focused, the rows the edit moves are tinted and the line above the table names them (`affectedSizes`: a step edit moves that size and every size further from the base; a total edit one size); **Edit L only** switches that cell to the total view. **Smart fill**: type a few rows (they get a dot) → Equal steps / Interpolate / Repeat step / Split by break → Fill (kernel `smartFill`). **Size breaks**: the ◆ gutter of a row (stored in `style.meta.sizeBreaks`, `setSizeBreaks`). **Nest preview** strip: the point's path through all sizes, redrawn while typing (before Enter). Table edits keep a point's rule link, so its badge turns amber “edited”.

All lengths are typed in the current display unit and accept decimals **or** fractions:
`12.5`, `1 1/8`, `1.1/8`, `1-1/8`, `9/8`. You can also add a unit suffix: `2cm`, `1"`, `30mm`.

## Tools

| Tool | Key | Usage |
|---|---|---|
| Select | V | **Selection only: never moves or reshapes geometry.** Click = replace, Shift+click = add, Ctrl+click = toggle, click on empty sheet (or Esc) = clear. Drag anywhere = box: left → right = **window** (fully inside), right → left = **crossing** (touching, dashed green); Shift+drag adds, Ctrl+drag toggles. When several objects are under the cursor the status bar lists them and **Tab** cycles; coincident points rank the selected one first, then the sew-line point before an internal one. A click right on a curve point of an unselected piece takes the point directly. Double-click a piece = all its points. Filter chips (tool-options strip, keys **0–5**): All · Pieces · Points · Lines · Internals · Marks. Hover pre-highlights what a click takes. Opt-in: Edit ▸ **Allow drag-move in Select (moves only what you grab)** |
| Move Point | G | Modes (Tab cycles): **Single** (default: exactly the grabbed point moves, see below) · **Smooth** (AccuMark Move Smooth: two tacks on the neighbouring grade points, drag a tack onto another point of the line to change the range; the points strictly between the tacks blend, `moveProportional`; works per size) · **Horizontal / Vertical** (Single locked to X / Y) · **Along line** (slide on its own contour, `moveAlongContour`, base size only) · **Group** (every selected point by the same delta, `multiMove`). Press on a point and drag, or click it (it follows the cursor) and click the new spot; pressing again on the picked-up point starts a drag, clicking it again on the same spot puts it back (never a zero-move undo step). Coincident points: the selected one is grabbed, then the sew-line point (not an internal end lying on it). While a grade point is dragged, the old curve is drawn dashed and the curve points that follow it (no own grading) are ringed and labelled "follows"; the prompt names Move Point ▸ Single and Point ▸ Pin curve point. Shift = H/V/45°, Alt = no snap; the snap kind is labelled at the target (`pt` / `int` / `mid` / `perp`). Typing a digit, `-` or `.` (or right-click) opens the **input box**: dX dY · distance ∠ · absolute X Y (piece frame; fractions, `12,5` = dX 12 dY 5, and the box says so in a note). Enter / right-click = OK, Esc = cancel, Enter with nothing typed repeats the last move, Backspace = undo the pick, Esc when idle = back to Select. Arrows nudge (Shift ×10) |
| Move Line / Segment | Shift+G | Click a sew segment (grade point → grade point) or an internal line, then drag (or click-click). The two end grade points and the curve points of that segment move by the same delta (an internal line moves whole); nothing else. **Parallel** mode locks the motion to the line normal. Input box: dX dY · distance ∠ · offset |
| Move / Rotate / Flip Piece | Ctrl+Shift+G | **Move**: drag a piece (selected pieces move together); while dragging R / Shift+R = ±90°, Q W = ±1°, A S = ±10°, X / Y = flip. **Rotate**: drag about the piece centre (Ctrl = 15° steps) or type the angle; with a piece already selected, typing (or right-click) opens the angle box at once (noun → verb). **Flip**: click = left ⇄ right, Shift+click = up ⇄ down. Changes `piece.layout` only (sheet placement; exports keep the authored geometry). Locked pieces are refused |
| Curve / Handle | Shift+C | Click a point to show its handles; drag a handle (Alt = break the pair, Shift = H/V/45°); click a handle then type (or right-click) for length / angle; Shift+click (or double-click) a point = corner ⇄ smooth. Base size only (handles are not graded) |
| Pen — new piece | P | Click = corner, click-drag = smooth with handles, Ctrl+click = curve point. Click the start point (or Enter) to close. Right-click = exact next point |
| Internal line / polygon | I | Start inside a piece; snaps to outline/points; Ctrl = curve, Shift = H/V/45°; click start = polygon; double-click / Enter ends; right-click = exact length/angle + mirror. Strip option **Lock ends to outline** (default on, also Edit ▸ Preferences): an end of an open line snapped onto the outline is locked to its segment (Endpoints, proportional; see *Internal lines locked to the outline*) |
| Smooth run | Shift+M | Click the first then the last point of a run → live preview of `smoothRun` (max deviation in the status bar). Click points in between to keep them. Right-click / Enter = apply, Esc = cancel |
| Rectangle / Circle / Polygon / Rounded rect | R / C / flyout | Drag, or click for a dialog |
| Seam value | S | Click the first sew grade point, then the last one of the run (same point = whole loop) → dialog (value as decimal or fraction, + outward / − inward) → `setSeam`. Double-click a piece = whole-piece seam |
| Notch | N | Click on a sew or internal line → dialog: placement (on point / from previous / from next / proportional %), type, depth, width, angle, cut/draw. Click an existing notch = notch grid editor. Notches render from `resolveNotch` cut geometry, in every size in the nested view |
| Drill / button | D | Click inside a piece → dialog (drill / button / buttonhole, Ø, cut/draw). Click an existing drill = edit / duplicate with offset / delete |
| Text | T | Click inside a piece → text dialog. Click an existing text = edit / delete |
| Cut Point | X | CLO *Add Point / Split Line* (docs/CLO-RESEARCH.md §3.1). Hover any sew or internal line: a dot slides along it, the grade segment under the cursor is drawn in two colours (from its start / to its end) with both lengths and the ratio in the display unit (also in the prompt); Shift = round to 5 mm / 1/8". Click = grade point (Ctrl = curve point), shape unchanged (`addPointsOnSegment`). Right-click or a digit = input box locked on that segment: From start · From end · Ratio % · Divide (N parts → N − 1 points) · Every (a point every X), with a live preview of the points. Strip options: Curve point · Notch (a notch on every new point) · Zero grade (default *auto* = proportional). On a graded size the lengths are measured on that size and placed at the same ratio of the base segment. The new points are selected; one undo step |
| Dart | Shift+D | Click **leg A** on a sew line → **leg B** (opening highlighted with its width; Shift = round width; or type the width) → move inside the piece: live ghost of the real result (legs, apex, drill, dart cap on the cut line), labels W · D and legs A / B with ✓ equal / Δ; Shift = apex on the bisector, depth rounded → click (`createDartByLegs`). Right-click / digit at the apex step = Width · Depth / Width · Leg / Width · Angle. Strip: Equal legs (Fix Dart, default on), Fold to leg B. **Press on a dart apex and drag** (here or in Move Point) = re-shape it (`moveDartApex`: base = all sizes + Fix Dart; another size = only its apex grading). Click a dart (legs or axis) = select (Inspector: width, depth, fold, drill offset, Closed, Cutting dart, legs A / B with ✓ / Δ, a per-size table, Edit… / Flip fold / Fix dart / Change darts / Copy / Paste / Pivot transfer / Rotate around centre / Cut all / Remove). Right-click a dart = dart menu (Edit dart…, Flip fold, close / reopen, …) |
| Pleat | Shift+L | Modes Knife / Box / Inverted box; options Open now, Notches. Click the **start** then the **end** of the first pleat line (Alt on the end = Add Pleat Axis only) → move to the side the pleats go: the distance is where the **last** pleat line lies (interval = distance / (count − 1), Shift rounds it), live ghost of all pleats opened (shaded fabric, fold lines, notches, fold-direction arrows) → click (`addPleatSet`, one undo step). + / − = count, L = spread up to a clicked last line (ends interpolated), F = flip fold. Right-click / digit = count, depth at start / end (taper), interval. Click a pleat to select it (Inspector: type, depths, fold, moving side, notches, fabric, openings, Edit… / Open / Close / Open all / Close all / Delete) |
| Slash & spread | Shift+U | Modes Rotate / Parallel (Tab). Click the **slash** point on the spread edge → the **hinge** (sew line = hinge; inside = rotation centre) → + / − = number of slashes (more than one: click the **last** slash point and hinge) → move to the side that moves: the distance from the slash line is the opening (readout, Shift rounds) → click (`addFullness` / `addFullnessBetween`). Right-click / digit = Uniform · First → last · Slash · hinge openings. Click a slash line to select the record (Inspector: each opening editable in place via `setFullnessOpenings`; Delete = exact restore) |
| Slash | K | Click points across a piece (snaps; Shift = H/V/45°; Backspace removes a point), Enter or right-click → dialog (zero / auto grade of the new cut points, seam on the new edges) → `slashPiece` |
| Trace segments | Shift+T | Click points (straight joins); Alt-click two points of one contour to take the run between them (Shift+Alt = backwards); Enter → new piece (`traceSegments`) |
| Measure | M | Modes (Tab): **Line** (default; AccuMark *Measure ▸ Line Length*, `tools/measure.ts`) and **Distance**. *Line*: hover highlights the line under the cursor (a sew / internal segment between two consecutive grade points, cut points included; any shown size in nested view) with its length; click = add it to the open group as L1, L2, … (label on the sheet), click a picked line again = remove, Backspace = last off, Shift+click = every segment from the last picked one up to this one, Alt (or the strip option *Cut line*) = measure the CUT line between the segment's cut corners (`cutPolyline`). A click on another piece, or Ctrl+click, starts a new group → comparison. The docked **Measure** window (`panels/measure-table.ts`): rows = all sizes, columns L1 … Σ and Δ prev; with several groups Σ A, Σ B, …, B − A (A − B toggle), optional parts, a target ease ± tolerance colouring each size row pass / fail; mode along the line / straight / dX / dY; group names editable. Enter / right-click = OK (kept in the window's list: rename, Reopen, Copy TSV, Grade to spec…), Esc = cancel (kernel `measureGroup` / `compareGroups`). *Distance*: click two points: L / dX / dY / angle + a per-size table; Ctrl-click 3 points = angle; Alt-click a point = per-size position |
| Walk pieces | W | Click the start point on the MOVING piece, then on the STATIONARY piece. →/↑ or wheel = step forward, ←/↓ = back (Shift ×10, Alt ×0.1). `[` `]` halve/double the step, S = step dialog, R = ratio, T = walk to a distance, K = skip darts on/off, F / G / B flip moving / stationary / both. N drops notches on both pieces, Shift+N stationary only, Alt+N moving only. The HUD shows the running lengths and Δ. Esc ends. Only dropped notches are written to the document |
| Hand / Zoom | H / Z | Pan / zoom (wheel zooms everywhere except while walking) |

Every tool: **Enter** finishes, **Esc** cancels, **Backspace** removes the last draft point.

The **tool-options strip** shows a tool's modes (segmented control) and its on/off options (`Tool.toggles` / `Tool.toggle`, e.g. Cut Point: Curve point · Notch · Zero grade). The creation tools remember their options per tool in `settings.toolState`.

**Space tap** (press and release in under 220 ms without panning): in any tool other than Select, back to Select with the selection kept; a second tap returns to that tool. Space held + drag pans.

**Esc**: an Esc that closes a menubar drop-down or a context menu does only that. Within 0.5 s of an Esc that cancelled something (pick, move, draft, menu), a second Esc keeps the selection and says "press Esc again to clear it"; a click or any other key in between resets this.

**Snapping** (`canvas/snap.ts`), in priority order: anchor points (all shown sizes) → intersection of two lines → midpoint of a grade segment → perpendicular foot from the move's start point (Move Point) → guides → grid. The line snaps use the document geometry, never the drag preview, and skip the moved point's own segments for midpoints.

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
- **Locked internal lines** follow the sew line by design (they are constraints, re-applied after every edit; the prompt says "🔒 N locked internal lines follow the sew line"). A point driven by a lock refuses Move Point / Move Line with the reason in the status bar and a toast (`tools/move.ts → lockBlock`; the kernel refuses too).
- Curve points carry no grading of their own unless edited, so in a graded size a curve point next to a moved grade point follows its neighbours' grading. That is expected, and the tool shows it while dragging (ghost of the old curve, "follows" rings, prompt). **Point ▸ Pin curve point (keep position)** (`ops.pinCurvePoints`) gives the selected curve points explicit grading equal to their current per-size positions, so they keep every size when a neighbour moves; **Unpin** drops it. Pinned curve points are drawn with a dot; the point tooltip and the Inspector (*Grading: Follows neighbours / Pinned*) say which.
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
| Point | Cut Point tool (X), **Modify Points ▸** Move Single Point / Move Smooth / Move Point Horizontal / Move Point Vertical / Move Point Along Line / Move Points (group) (each opens Move Point in that mode), Corner/smooth, grade/curve, break/join handles, start point, Add point (from start / from end / %), add at click, Move XY (delta / absolute; in a non-base size it edits only that size's grading), Move along contour, Move proportional, Multi move, Align H/V/angle, Set angle, Round corner, Spline support points, Points cleanup, Delete |
| Segment | **Modify Line ▸** Move Line / Move Parallel / Curve tool, Set exact length (method picker), Copy/Paste segment (modes, flip), Rotate segment keeping length, Swap internal ⇄ perimeter, Divide/Join internals, **Lock internal to segment… / Unlock internal line** (also on the right-click menu of an internal line), Dashed ⇄ solid, Trim at intersections, Global check & trim, Global join, Extend (by value / up to a line), Smooth tool |
| Seam | Seam tool, segment/run, whole piece, global, Corner type gallery (miter / boxed prev/next/both / turnback / angled / manual), Manual seam angle, Revert corner, Lock grading, Update seam grading, Reseam / Reseam all / Reseam segment, Repair parameters, Seam → internal, Internal → seam, Manual cut → auto, Delete / remove seam, Auto reseam, Show cut-line corner indices |
| Notch | Notch tool, notch grid editor (per-size distances, fill all, extrapolate increment, paste TSV, convert, delete), notch on points, corner notch, cross notch, Add points for notches, Global notch grading, Notch setup, Drill tool, Duplicate with offset, Multi buttons, Slit contour segment, Text tool, Place artwork (file picker → data URL), Binding generator |
| Cut | Slash tool, Cut along internal, Cut H/V at point (with offset), Cut parallel strip, Cut by guideline (drag a guide from a ruler first), Parallel internal (from a sew segment: *Lock parallel to the segment*, default on), Extend/shrink parallel, Shapers (arc by depth/radius/length/through-point, wave, scallop/zigzag, ruffle, circular skirt), Trace, Build piece, Join pieces, Fold in/out, Half piece set/open/delete |
| Grade | Grading table (its toolbar has the same power ops, plus Rules, By measure, # badges), nested view, absolute values (= Total from base size view), point tracking, rule names on the canvas, **Rule badges on grade points** (Shift+Alt+B: blue = follows its rule, amber `n*` = linked but locally edited, green `g` = own grading, grey `0` = ungraded; kernel `gradeStatus`; `canvas/badges.ts` via the overlay registry `canvas/overlays.ts`), **Grade rules (rule library)…** (Shift+Alt+R; `panels/rules.ts`: library picker, rule chips (click = show, Shift/Ctrl = several, double-click = apply to the selection, drag onto a point = apply; with the window open or badges on, select points and type the rule number + Enter), rule table rows = sizes with the two views, breaks, Smart fill and nest strip; edits = Modify Rule, linked points follow (`setRuleValues` + `refreshRuleLinks`); + Rule, From values / point / contour, Copy rule (Copy Table Rule, flip X / Y), Rename / renumber, Delete (links dropped, values kept), Detach, Load sizes), **Grade by measurement…** (`panels/grade-fit.ts`: a Measure group, the selected points with direction X / Y / angle and a weight each, the spec per size (paste a column; spec = measurement or change from base, × factor) → Preview / Apply; now / after / residual per size; kernel `gradeByMeasurement`), Clipboard (copy, paste, X only, Y only, flipped, Smart paste, Paste around), Edit (flip, equal, delete X/Y/all, stack point, stack along line, angle grading with auto-aim, grade parallel, grade proportionally), Rule library window (libraries; rules from values / point / contour; apply by number or name; Load sizes), Apply/Detach rule, Movement programs window (programs, moves from the selection, apply delta, measurement sets), Graded nest from pieces (selection order = smallest → largest), Sizes (axis-2 variation, delete ungraded / invisible) |
| Dart | Add dart at point (selected sew point), Multi darts (segment pick → input box N, width, depth with a live ghost), Edit dart (width, depth, fold, drill — one dialog), Flip fold of this dart, Insert dart (slash point, pivot pick or Enter = automatic, width, depth), Close / reopen (Ctrl+Alt+D), Reopen at width, Fix dart, Cutting on/off, Change darts (flip every fold), Close / reopen all darts of the piece, Cut all darts (piece or all; cutting or folded), Pivot transfer (Shift+Alt+T: dart → target on the contour → input box % (default 100) *About the apex* / *About a clicked pivot*, live ghost), Rotate around offset centre (dart → target → centre → input box %, default 50, live ghost; the two darts share the apex), Copy / Paste dart (paste on a clicked sew line of any piece), Remove dart. **Pleat ▸** Add pleat axis (attributes later), Add pleat, Add by angle, Multi pleat (segment pick), Edit pleat, Open / close selected, Open / close all, Delete (types knife / box / inverted box). **Fullness ▸** Add fullness, Multi fullness (slash segment, hinge segment, N, first / last width, mode), Edit openings (live ghost; exact, later spreads re-applied), Delete fullness (exact restore; later spreads are re-applied) |
| Measure | Measure / Walk tools, **Measure line (sum per size)…** (Shift+Alt+L), Piece info (all sizes), Compare length window (+/− segments, mode, per-size table, *Edit segment to target* → `segmentLengthSetTo`), Walking check report, Segment length per size, Notches on segment |

The **Sizes panel** has Insert (before / after, with the neighbour-increment fraction: 0.5 = half size; extrapolates at the ends), Append, Set base, Remove, Axis 2, Delete ungraded / invisible, Size → standalone style. Double-click a size chip to rename it or change its colour.

The **Inspector** shows *Lock grading* for a piece. For a sew grade point it adds the corner gallery button, revert corner, the start point, the rule name, and the seam of the leaving segment (typed values go through `reseamSegment`; a negative value is inward). *Kind* goes through `togglePointKind` (curve → grade materialises the current grading; the seam of the segment is inherited). For a selected internal line it shows **Lock to outline**: Lock (None / Endpoints on segment / Parallel to segment / Follow point), what it is locked to, Keep position (Proportional / Distance from segment start / end), for Parallel the offset (+ inside) and the From / To range, *Pick segment… / Pick point…* and *Unlock*. A point of a locked line shows a 🔒 line and is read-only when the lock drives it.

## Main hotkeys (all remappable: Edit ▸ Keyboard shortcuts…)

| Keys | Command |
|---|---|
| Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z | Undo / redo (200 steps) |
| Ctrl+S / Ctrl+Shift+S / Ctrl+O / Ctrl+Alt+N | Save / Save As / Open / New |
| Ctrl+Alt+I · Ctrl+Shift+E · Ctrl+P | Import (Ctrl+Shift+I also bound; Chrome keeps it for DevTools) · Export DXF (+RUL) · Export tiled PDF |
| Delete, Backspace | Delete the selection: points, else notches / drills / texts / internal lines, else pieces (asks). Backspace inside a Move tool = undo the last pick |
| V · G · Shift+G · Ctrl+Shift+G · Shift+C | Select · Move Point · Move Line · Move / Rotate / Flip Piece · Curve / Handle |
| 0 1 2 3 4 5 (Select) · Tab | Filter All / Pieces / Points / Lines / Internals / Marks · cycle the objects under the cursor (Select) or the mode (Move tools) |
| Space (tap) | Move / Modify tool ⇄ Select, selection kept (hold = pan) |
| Ctrl+D · Ctrl+A · Ctrl+Shift+A | Duplicate piece · select all of the current filter (All = pieces) · select all points of a piece |
| Arrows (Shift = ×10) | Nudge the selection **only while a Move tool is active** (Move Point: the picked point, Group: all selected points; Move Line: the line; Piece: the selected pieces). In Select the arrows do nothing |
| Alt+C · Alt+G · Alt+I · Alt+A · Shift+Alt+A | Corner⇄smooth · grade⇄curve · insert point after · Add point… · add point at click |
| Alt+M · Shift+Alt+H / Shift+Alt+V | Move point XY dialog · align H / V |
| Alt+L · Alt+O · Ctrl+Alt+Shift+C / V | Segment length · rotate segment · copy / paste segment |
| Alt+S · Alt+K · Shift+Alt+K · Ctrl+Alt+S | Seam of segment · corner gallery · manual seam angle · reseam piece |
| Shift+Alt+N · Ctrl+Alt+B | Notch grid (Ctrl+Shift+N also bound; browser-reserved) · binding generator |
| Alt+B · Alt+J · Alt+Shift+P | Build piece · join pieces · parallel internal |
| Ctrl+G · Alt+N · Alt+T | Grading table · nested view · point tracking |
| Ctrl+[ / Ctrl+] / Ctrl+B | Previous / next / base size |
| Ctrl+Alt+C / V / X / Y / M | Copy grade / paste / paste X only / paste Y only / Smart paste |
| Ctrl+R · Shift+Alt+R · Shift+Alt+B | Apply rule by number or name · Grade rules window (Ctrl+Shift+R also bound; browser-reserved) · rule badges |
| digits + Enter | With points selected and the Grade rules window open (or badges on): apply rule #n (Enter applies, Esc cancels; nothing is applied without Enter). Takes precedence over the Select filter keys 0–5 only in that state |
| Shift+Alt+L | Measure line (Measure tool in Line mode + the Measure window) |
| Ctrl+I · Ctrl+Shift+L | Piece info · Compare length |
| X | Cut Point tool |
| Shift+D · Shift+L · Shift+U | Dart · Pleat · Slash & spread tools (inside them: right-click / digit = exact values, Shift = round, + / − = count, F = flip pleat fold, L = pleats up to a last line, Tab = rotate / parallel, Backspace = back one click) |
| Ctrl+Alt+D · Shift+Alt+T | Close / reopen dart · Pivot transfer |
| Ctrl+L · Alt+R | Lock piece · rotate 90° |
| Ctrl+0, F · Shift+F · Ctrl+Alt+0 · +/- | Fit · fit selection · 100 % (Ctrl+1 also bound; browser-reserved) · zoom |
| Ctrl+' · Ctrl+Shift+' · Ctrl+Alt+R | Grid · snap to grid (matched on the physical key, so it works although Shift+' types `"`) · rulers |
| F1 | Shortcut list (complete) |

**Presets**: Edit ▸ Keyboard preset ▸ *AccuMark keys* / *ProwdCAD (default)*, or the *Preset* box at the top of Edit ▸ Keyboard shortcuts…. AccuMark keys (`actions/register.ts → ACCUMARK_KEYS`, UX-RESEARCH §1.5): Alt+F12 Move Single Point, Alt+F11 Move Smooth, Alt+F2 Move Points, Alt+F3 Align, Alt+F1 Delete point, Ctrl+F2 Move Line, Ctrl+F11 Move Parallel, Ctrl+F10 Split, Alt+S Swap line (Seam of segment → Shift+Alt+S), Shift+F2 / Shift+F9 / Shift+F10 Move / Flip / Rotate Piece, Shift+W Walk, Ctrl+A Select all, Ctrl+D Clear selection (Duplicate → Ctrl+Shift+D).

The hotkey map is stored in browser settings as JSON. Only overrides are saved, and an empty string unbinds a command. **Edit ▸ Customize toolbar…** shows or hides palette tools; hidden tools keep their shortcuts. Dialogs remember their last values per dialog (in settings), except context fields: the **Pieces** scope of every export dialog is never remembered; it is *Selected* whenever a piece is selected, else *All pieces*, and a hint names the selected pieces. A length field you do not touch returns its exact value (the display may be rounded to 1/16").

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
  canvas/            view.ts (y-up ⇄ screen), canvas.ts (events, pan/zoom, rulers, guides), render.ts, snap.ts, overlays.ts (extra overlay layers registered by feature modules), badges.ts (rule badges)
  selpick.ts         selection hit-testing: ranked candidates under the cursor, window / crossing box gathering, selection highlight
  tools/             select (selection only), move (Move Point / Move Line / Piece / Curve), cutpoint (Cut Point), pen, internal, shapes, marks (notch/drill/text), seam, live (Dart / Pleat / Slash & spread), apexdrag (dart apex drag, shared by Move Point and Dart), livekit (arc addressing, segment under the cursor, labels, remembered options), walk, construct (smooth/slash/trace), measure (Measure Line / Distance), misc (zoom/hand), pick
  panels/            inspector, pieces, sizes, grading (+ toolbar, nest strip), sizegrid (rows = sizes grid), measure-table (Measure window + state), grade-fit (grade by measurement), notchgrid, rules (Grade rules window, digit apply, chip drop), movement, dock, widgets
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
switches; typed input-box values (fractions, inch mode, absolute) land exactly; internal lines locked to the outline (auto-lock while drawing, the end keeps its proportional position when the segment moves in base and graded sizes, locked points refuse Move Point, Inspector ▸ Parallel lock exact in every size and following Move Line, Unlock); the CLO-style tools (Cut Point at an exact
length / ratio / divide-N with notches, graded and on internals; darts by clicks and typed values, graded, apex drag; pleat
count / inverted taper / between lines; slash & spread interactive and typed, exact delete) and that each is one undo step
that Ctrl+Z / Ctrl+Y undo and redo exactly.

`npm run e2e` (scripts/e2e, ≈25 min) runs every registry command, tool and hotkey, the Measure + Grade suite (`suites/measure-grade.cjs`: L1+L2+L3 per size = hand calculation, click-again / Backspace / Shift-extend / Alt cut line, comparison across two pieces with B − A, A − B and ease ± tolerance, Ctrl = new group, nested-view picks, TSV, an 80-size style rendering and scrolling under 1 s, grading table rows = sizes edit / ripple / Enter-down / paste / Smart fill / arrows-Tab, grade by measurement to a pasted spec, Grade rules: type a rule number, badges, rule edit follows, edited badge) plus the cross-cutting checks
(other-points matrix, units, nested view, drags, selection persistence, export scope, the fix-pass regressions
`special:fixes`, single-file smoke). It tests a `git archive` snapshot of HEAD by default; use `E2E_TREE=1` for
uncommitted work. The exit code counts failing cases **and** failing checks (special parts, hotkey mismatches,
single-file). See docs/E2E-REPORT.md.

### Seams follow segment edits

The seam allowance is stored per grade segment (`seamAfter` of its start grade point) and the cut line is derived live, per size. `Document.transact` runs the **edit rules** after every top-level step (`doc.finishEdit`, kernel `ops/seam → followSeams`), in the same undo step:

- a sew grade point that is new (or was a curve point) and has no seam of its own takes the seam of the old segment its outgoing segment lies on, so any insertion (Cut Point, Add point, Divide, spline support, notch *Add points*, curve → grade from any op or the Inspector) gives both sub-segments the parent's seam; a corner spec on a point inserted inside one segment is dropped (corners stay on the original corners);
- a point that was a grade point and is now a curve point loses its seam / corner; deleting / demoting a grade point merges two segments and the merged one keeps the seam of the segment that started the run (AccuMark);
- new edges of slash / cut along internal / cut parallel / fold keep the op's value (dialog value or piece default; fold edge 0); shapers, round corner, swap, join, darts, pleats and slash & spread keep the replaced / opened segment's seam;
- Lock Grading pieces whose sew line, seams or sizes changed get `corner.lockedPerSize` re-stamped (with `settings.autoReseam`).

The Move-tool previews run the same rules on their scratch copy (`tools/move.ts → scratchDoc`), so the ghost is exactly the committed result. Kernel tests: `packages/kernel/test/seam-follow.test.ts` (per op: seams per segment before / after, and in every size the cut polygon at exactly each segment's seam, 0.01 mm).

### Internal lines locked to the outline

`Contour.lock` (kernel `ops/lock.ts`, published through `ops/parallel`): `ends` (each attached end point keeps its position on a sew span `from → to` as a ratio or a distance from the span start / end), `parallel` (the line is regenerated as the exact offset of a span between two kept positions: grade ends, smooth curve points with explicit grading, refined until within 0.004 mm of the offset in every size) and `follow` (rigid translation with one sew point, per size). The span is stored as two anchor ids, so points inserted inside it keep the lock; a lock whose anchors are deleted is dropped. `doc.finishEdit → applyInternalLocks` re-applies every lock after every edit (and on load), so the stored internal is never stale. A point-connected end is driven by its connection. `isLockDriven` points cannot be moved on their own (kernel `moveIndex` refuses; the Move tools explain why). Commands: `actions/lock-cmds.ts`; Inspector section in `panels/inspector.ts`; padlock / end rings in `canvas/render.ts` (interior points of a parallel line are not drawn or picked). Tests: `packages/kernel/test/lock.test.ts`, e2e `lock.*`.

### Half pieces and resolved indices

`geometry.ts → resolveFor` is the one way the UI resolves a piece. For a live half piece the kernel resolves the opened (mirrored) piece; `resolveFor` re-indexes its sew contour to the **stored** anchor order (`anchorPos`, `anchorIndex`, `handles`, `gradeIdx` follow `piece.sew.points`; `pts` / `cum` stay the full opened outline) and marks the stored fold edge (`foldAfter`), which `hitkit.segmentIds` never returns as a segment. So `rc.anchorPos[i]` is always `contour.points[i]`, and hover / pick / highlight work on both halves. Do not call `doc.resolvePiece` directly from UI code.

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
- `live.ts`: live-object display geometry (pleat fold-direction arrows included), hit-testing (`liveNear`), contour hit → `LiveContourPos`, `app.liveSel`; `tools/live.ts` the Dart / Pleat / Slash & spread tools (CLO-style, docs/CLO-RESEARCH.md); `tools/cutpoint.ts` Cut Point; `panels/live-inspector.ts` their Inspector sections. The creation tools preview with `tools/move.ts → previewWith` (the real kernel op on a scratch copy), so the ghost is exactly what is committed.
- `panels/notchgrid.ts`, `rules.ts`, `movement.ts`: the floating editors.
