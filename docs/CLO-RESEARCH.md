# CLO 3D 2D-pattern tools: research and the ProwdCAD spec (darts, pleats, slash & spread, cut point)

Owner request (Nov 2026): *"Read the CLO user manual. Improve dart, pleat & fullness. Also make a cut point tool like CLO."*

This document has three parts: what the CLO manual says (with the pages actually read), what ProwdCAD lacked compared to it, and the spec that was implemented. Statements that the manual does not make are marked **[inferred]**: they come from general CLO / Marvelous Designer knowledge or from the owner's request, not from a page that was read. CLO and Marvelous Designer share the same 2D pattern window, so the Marvelous Designer manual is used where its page is newer or more complete.

ProwdCAD keeps its own conventions where they differ from CLO, because the owner works in AccuMark / TUKAcad (docs/UX-RESEARCH.md): **right-click or Enter = OK, Esc = cancel, a status-bar prompt for every step, the input box with fraction and unit support, one undo step per operation, live kernel objects that work on graded sizes.**

---

## 1. What the CLO manual says

### 1.1 Add Point / Split Line ("cut point") [C1][C2][C3]

- **Access:** 2D Toolbar ▸ Add Point/Split Line, or Main Menu ▸ 2D Pattern ▸ Edit ▸ Add Point/Split Line. The pages read give no keyboard shortcut.
- **Hover:** "Move the cursor over a segment. Smart Guide is displayed and the mouse cursor snaps at the intersection with the segment" (ver 7.0).
- **Click:** "Point is added at the segment."
- **Right-click a segment:** creates a reference point (the "purple guide point") and opens the **Split Line** window with three modes:
  - **Split into Two Lines:** type the length of Line 1 or Line 2 ("the shorter side is indicated as Line 1, and the longer side is indicated as Line 2"), or a **ratio** (the two sides default to 100 % in total). The page notes this is how you split a line into two equal halves or add a point at 33.3 %.
  - **Split by Length:** a segment *Length*: points are added at that interval from one end; *Number of Segments* (default 2, ver 3.2.0); *Direction* / *Reverse Direction* (start / opposite / centre basis).
  - **Uniform Split:** a *Number of Segments*; "the line is equally divided accordingly".
- **Several segments:** select them with Edit Pattern, right-click ▸ Split: they are "detected as a single line".
- **Not in the pages read:** a live distance readout while hovering, modifier keys. **[inferred]** The owner's request describes CLO showing the distances from both ends while hovering and a preview of the split; the pages only say "Smart Guide is displayed". ProwdCAD shows both lengths and the ratio while hovering (owner requirement).

### 1.2 Dart [C4][C5][C6][C7][C8]

CLO has three dart workflows:

1. **Dart tool (internal "fish-eye" dart)** [C4][C5]: 2D Toolbar ▸ Dart (Main Menu ▸ 2D Pattern ▸ Create ▸ Dart; "Base Dart" in ver 5.2).
   - *Click and drag* inside a pattern: "The preview of the Dart will appear"; release to complete.
   - *Click once* inside a pattern: the **Create Dart** window opens: **Size** = Width (Left), Width (Right), Height (Up), Height (Down), measured from the dart centre; **Position** = *Outline* (margins between the dart and the pattern outline: Left, Right, Up, Down) or *Center* (distances from the dart centre).
2. **Add Dart on the outline (Segment Darts)** [C6]: Edit Pattern tool ▸ right-click the point on the outline ▸ **Add Dart** ▸ the Dart window: **Total Width**, **Dart Arm Width** ("the width of each dart half"), **Length** (of the dart's centre line); option **Shape Dart Cap** (ver 6.1: "automatically executed after Dart creation and modification"). Edit: right-click the dart ▸ **Edit Dart** (same window).
3. **Add Dart with Fullness** (ver 5.2) [C7]: Edit Pattern ▸ right-click the start point ▸ *Add Dart with Fullness*: a reference line runs from that point to the cursor; click the opposite outline (the pattern splits along the line); choose one side or the centre for the dart and **move the mouse to set its width** (preview of the pattern with the dart and the fullness); **move along the centre line to set its length**; **right-click during either step to enter exact width / length**.
- **Shape Dart Cap** [C8]: right-click the dart ▸ Shape Dart Cap: the cap is shown light blue; drag curve points, Enter to finish.
- **Not in the pages read:** modifier keys, a leg-length equality display, fold direction. **[inferred]** CLO folds the cap to one side; there is no AccuMark-style "Fix Dart" (equal legs) in the pages read.

### 1.3 Pleats [C9][C10][C11]

- **Access:** 2D Toolbar ▸ Pleats, or Main Menu ▸ 2D Pattern ▸ Pleats ▸ Pleats.
- **Click sequence:** click a **start point and an end point** of the pleat reference line on the pattern outlines ("A Pattern is divided into two"), then **click the side of the line where the pleats are added**; the **Pleats** window opens; OK creates them.
- **Pleats window:** **Pleats Type** = Knife, Box or Accordion (no "inverted" type is listed); **Number of Pleats**; **Depth** ("the depth of folded pleats"); **Interval** (spacing when there are two or more); **Create Notch** = Both / Start / End; **Reverse Direction** (flips the side where pleats are added); **Option** = fold angles (Outside Fold / Inside Fold: the bigger the difference the sharper the folds).
- Internal lines move and rotate with the pattern (ver 6.0). A pleated segment sewn to another pattern is sewn automatically; else use Pleats Sewing. "If a pleat starts between two segment points, it cannot extend past the next one … the pleat turns red" [C10].
- **Pleats Fold** [C11] (for existing internal lines): click the start of the pleat direction, drag toward the folding direction, double-click; the guide must enclose all the internal lines; the window: **type** (knife / box / accordion), **fold angle**, **number of internal lines per pleat** (two or three), **Reverse Direction**. Outside folds are shown red, inside folds green.
- **Not in the pages read:** tapered pleats (different depth at each end), default values, previews before OK, modifier keys. **[inferred]** CLO shows the result after OK, not a live ghost.

### 1.4 Slash and Spread / Fullness [C12][C13][C14]

- **Fullness (Point)** [C12]: click a start point and an end point on the outline to draw the slash line (or pick an internal line / baseline): the pattern divides and "the arrow shows which side spreads"; **click the side** (or the baseline) and **move the cursor in the direction to rotate**: the pattern spreads by the corresponding distance and angle; **right-click during rotation to enter the distance and angle**. Internal lines move and rotate with it.
- **Fullness (Line)** [C12]: click two points on the outline (the fullness line), then two points for the slash line: the **Fullness (Line)** window: **Direction** and **Length**; the fullness is added evenly.
- Cutting applies a natural curve by default; **D** keeps the original curvature (ver 6.2).
- Slash and Spread (Marvelous Designer) [C14]: click the first outside edge, then a point on the next edge (slash line), click inside on the side to move, move it, left-click to confirm. Several small cuts are recommended over one large one.
- Community questions [C13] show users asking for a spread **without rotation** (parallel) and for the reverse operation (suppress).
- **Not in the pages read:** several slashes at once with a first → last amount, parallel mode, hinge opening. **[inferred]**

### 1.5 Cut, Fold, curvature [C15][C16][C17][C18]

- **Cut** [C15]: Edit Pattern / Transform Pattern or Trace ▸ right-click an internal line ▸ **Cut**: "The Pattern will cut based on the Internal Line".
- **Fold Arrangement** [C16] (3D): click an internal or sewing line, a gizmo appears, drag to fold; the line's Fold Angle updates (0 / 360 = crisp fold).
- **Edit Curvature** [C17]: click and drag a part of a straight line to make it a curve; drag a curve to exaggerate or moderate it.
- **Change Length** [C18]: Edit Pattern ▸ right-click a segment ▸ Change Length: *Location* Start / End / Both and *Length*.
- **Divide Internal Lines** [C19]: Edit Pattern ▸ right-click an internal point ▸ divide at it, or right-click an internal line ▸ *Divide Internal Line*.

---

## 2. What ProwdCAD lacked (before this change)

| Area | CLO | ProwdCAD before |
|---|---|---|
| Cut point | A dedicated Add Point / Split Line tool: hover, click, right-click → two-line lengths, ratio, split by length, uniform split | Point ▸ Add point… (dialog, segment from the selection) and Add point at click; no hover readout, no divide-N, no split preview, no notch option |
| Dart creation | Click-drag preview, right-click / dialog values (total width, arm width, length) | Click a sew line → dialog (width, depth) → optional apex click. No preview while placing; legs placed symmetrically about one click only |
| Dart editing | Right-click ▸ Edit Dart | Inspector fields; no "Edit dart" dialog in the right-click menu, no leg equality indicator, no per-size readout; the apex could not be dragged |
| Multi dart / pivot transfer | — | Dialogs with no ghost of the result |
| Pleats | Reference line, side, count, depth, interval, notches, reverse direction, fold-angle options; knife / box / accordion | One pleat per axis (two clicks + dialog) or Multi pleat on a whole grade segment; knife / box only; no live preview of the set; fold direction shown only as small ticks |
| Slash & spread | Slash line, side, drag to spread, right-click distance / angle; evenly spread fullness lines | Slash point + pivot → dialog; Multi fullness only on whole grade segments; no interactive spread, no ghost, no in-place edit of the opening |

---

## 3. Spec (implemented)

Common rules for all four tools: a status-bar prompt names the step and the keys; a live **ghost of the real kernel result** is drawn before the click (the preview runs the same kernel op on a scratch copy of the piece, so the ghost is exactly what is committed, cut line and dart cap included); **right-click or typing a digit** opens the input box (fractions, units, `Tab` = next field); **Enter / right-click = OK, Esc = cancel**, Esc when idle = back to Select, Backspace = back one step; **one undo step** per object; on a graded active size the badge is amber and the objects are created on the base shape and grade with their anchors. Remembered options live in `settings.toolState` per tool. Tool-options strip: modes (segmented) and option toggles (new `Tool.toggles` / `Tool.toggle`).

### 3.1 Cut Point tool (`X`, palette button "Cut Point") — `tools/cutpoint.ts`

`X` was free (registry, AccuMark preset and tools checked; `X` is only used *inside* the Move Piece tool while dragging, where the tool consumes it first).

| Step | Behaviour |
|---|---|
| Hover a sew or internal line | A dot slides along the line. The grade segment under the cursor is drawn in two colours (part 1 from the segment start, blue; part 2 to its end, orange) with each part's length, the dot's distances "start \| end" and the ratio %, in the display unit. The segment start is marked "start". The prompt repeats the numbers. **Shift** rounds the distance from the nearer end to 5 mm (1/8" in inch display) |
| Click | Inserts a **grade point** there (**Ctrl+click** or the *Curve point* option = curve point). The contour shape does not change (kernel geometry-preserving split). The new point is selected |
| Right-click, or a digit while hovering | Input box locked on that segment, modes: **From start**, **From end**, **Ratio %**, **Divide** (N equal parts → N − 1 points), **Every** (a point every X from the start). The resulting points are previewed (dots and part lengths) while typing |
| Options (strip) | **Curve point**, **Notch** (a notch on every new point, Notch Setup defaults), **Zero grade** (default: proportional / *auto* grading) |
| Graded size | Lengths are measured on the active size and placed at the same ratio of the base segment; with auto grading the point lands at that ratio in every size |

Kernel: `cutPointDistances(L, spec)` (pure) and `addPointsOnSegment(doc, piece, segStart, { distances \| pcts \| divide, from, kind, grading, notch })` (ops/points.ts), one transaction.

### 3.2 Dart (`Shift+D`) — `tools/live.ts`, `tools/apexdrag.ts`

| Step | Behaviour |
|---|---|
| 1 | Click **leg A** on a sew line (or click a dart = select it; press on a dart apex and drag = re-shape it) |
| 2 | Move along the sew line: the opening is highlighted with its width. Click **leg B** (Shift = width rounded), or type / right-click → **Width** (leg B is placed toward the cursor) |
| 3 | Move inside the piece: live ghost of the dart (legs, apex, drill, **dart cap on the cut line**), labels **W · D** and **legs A / B** with **✓ equal** (green) or **Δ** (red). **Shift** = apex on the bisector, depth rounded. Click = create. Right-click / digit → input box **Width · Depth**, **Width · Leg** (equal legs of that length), **Width · Angle** (dart angle at the apex); the ghost follows the typed values |
| Options | **Equal legs** (Fix Dart after placing the apex, default on), **Fold to leg B** |

- Kernel: `createDartByLegs(doc, piece, { a, b, apex \| depth, fix, fold })` and `dartLegSpan` (shorter arc between the legs; the dart is centred on it), ops/darts.ts. `moveDartApex(…, { sizeId, fix })`: on the base size the apex moves and Fix Dart re-equalizes the legs; on another size only that size's apex grading changes.
- **Apex drag:** with Move Point (`G`) or the Dart tool, press on an apex and drag; the prompt and a label show the leg lengths while dragging; one undo step; Esc cancels.
- **Right-click a dart:** *Edit dart (width, depth, fold, drill)…* (one dialog, one undo step), *Flip fold of this dart*, close / reopen, reopen at width, fix, cutting, pivot transfer, rotate around centre, multi darts, copy / paste / remove, change darts.
- **Multi darts, Pivot transfer, Rotate around centre:** the dialogs became input boxes with a live ghost of the result before OK (pivot transfer: *About the apex* or *About a clicked pivot*).
- **Inspector:** legs A / B with ✓ / Δ, a per-size table (width, depth, leg A, leg B), Edit… and Flip fold buttons.

### 3.3 Pleat (`Shift+L`)

| Step | Behaviour |
|---|---|
| 1 | Click the **START** of the first pleat line (e.g. on the waist) — or click a pleat to select it |
| 2 | Click the **END** (e.g. on the hem). **Alt** on this click = pleat axis only (attributes later, TUKA workflow) |
| 3 | Move the cursor to the side where the pleats go: the distance from the first line is where the **last** pleat line lies (interval = distance / (count − 1); Shift rounds the interval). Live ghost: every pleat line, the opened pleats with shaded fabric, fold lines, notches and **fold-direction arrows**. **+ / −** = count, **L** = spread up to a clicked **last line** instead (two more clicks; ends interpolated, for flared panels), **F** = flip the fold. Click = create |
| Input box | **Number of pleats**, **Depth at start**, **Depth at end** (taper), **Interval** |
| Modes / options | **Knife / Box / Inverted box** (new type; box and inverted insert 4 × depth with a centre-fold anchor); **Open now**, **Notches** |

- Kernel: `pleatSetAxes(first, { count, interval, side \| last })` (pure) and `addPleatSet(doc, piece, first, opts)` (ops/pleats.ts): one live pleat per line, `moveSide` = the side the set grows toward so the openings stack, opened in one transaction. `PleatType` = `'knife' | 'box' | 'inverted'`.
- Fold-direction arrows are drawn on the pattern for every pleat (open or closed): knife = toward the fold side, box = away from the centre, inverted = toward the centre.
- Right-click a pleat: *Edit pleat (type, depths, fold)…*, open / close (all), delete. Inspector: type incl. inverted, depth at start / end, fabric (tapered), pleat-line length, Edit….

### 3.4 Slash & spread (`Shift+U`, was "Add fullness")

| Step | Behaviour |
|---|---|
| 1 | Click the **SLASH** point on the spread edge (sew line), or click a slash line = select it |
| 2 | Click the **HINGE**: on the sew line = rotate about it; inside the piece = rotation centre (single slash) |
| 2b | **+ / −** = number of slashes. More than one: click the **LAST** slash point and the **LAST** hinge; the slashes are spread evenly between the first and the last line |
| 3 | Move the cursor to the side that moves: the distance from the slash line is the **opening** (readout at the cursor, Shift = round). Live ghost of the spread. Click = apply |
| Input box | **Uniform** opening, **First → last** (interpolated), **Slash · hinge** (opening at the hinge too, single rotate slash) |
| Modes | **Rotate** (hinged) / **Parallel** (Tab toggles) |

- Kernel: `addFullnessBetween(doc, piece, { firstSlash, firstHinge, lastSlash, lastHinge, count, firstWidth, lastWidth, mode, side })` (one live multi record; delete = exact restore) and `setFullnessOpenings(doc, piece, id, { widths \| openA, openB })`: edits the opening in place (later spreads are unwound and re-applied, anchor ids kept, one undo step).
- Right-click a slash line: *Edit openings…* (live ghost), *Delete (exact restore)*. Inspector: the opening of each slash is editable.

### 3.5 Palette, menus, keys

- Palette: **Cut Point** (own button, `X`) next to the **Dart / Pleat** group (Dart · Pleat · Slash & spread), with new icons. Point ▸ *Cut Point tool*; right-click a segment or internal line ▸ *Cut Point tool*.
- New commands: `point.cutTool`, `dart.edit`, `dart.flipFold`, `pleat.edit`, `fullness.edit`.

### 3.6 Deviations from CLO (deliberate)

- Right-click = exact values / OK (AccuMark), never a context menu while a tool step is in progress; the context menu is reached by right-clicking an existing object when the tool is idle.
- Darts are sew-line darts (AccuMark / TUKA live objects), not CLO's internal diamond dart; Fix Dart (equal legs) is on by default.
- Pleat "side" is chosen by the cursor (CLO: a click), and the cursor distance sets where the last pleat goes; CLO's fold-angle options (3D simulation) are not applicable to a 2D CAD and are not implemented; Accordion pleats are not implemented (Inverted box was asked for instead).
- Slash & spread uses a hinge point on the sew line or an interior centre instead of CLO's "click the side, then rotate"; the opening is the distance from the slash line.
- Cut Point measures on grade segments (grade point → grade point, plus the ends of open internal lines), the AccuMark notion of a segment; CLO's "segment" is between any two points. Multi-segment selection split is not implemented.

---

## 4. Sources

Fetched and read (content used):

- [C1] CLO Help Center — Add Point / Split Line: https://support.clo3d.com/hc/en-us/articles/115012181207-Add-Point-Split-Line
- [C2] CLO Help Center — Add Point / Split Line (ver 7.0 article): https://support.clo3d.com/hc/en-us/articles/115000375727-Add-Point-Split-Line
- [C3] Marvelous Designer manual — Add Point / Split Line: https://support.marvelousdesigner.com/hc/en-us/articles/47358427280153-Add-Point-Split-Line
- [C4] CLO Help Center — Dart (Create Dart with specific values): https://support.clo3d.com/hc/en-us/articles/115012226127-Dart
- [C5] CLO Help Center — Dart / Base Dart: https://support.clo3d.com/hc/en-us/articles/115000472748-Dart-Base-Dart
- [C6] CLO Help Center — Segment Darts: https://support.clo3d.com/hc/en-us/articles/115008753767-Segment-Darts
- [C7] CLO Help Center — Add Dart with Fullness (ver 5.2): https://support.clo3d.com/hc/en-us/articles/360043100233-Add-Dart-with-Fullness-ver-5-2
- [C8] CLO Help Center — Shape Dart Cap: https://support.clo3d.com/hc/en-us/articles/360000451627-Shape-Dart-Cap
- [C9] CLO Help Center — Pleats: https://support.clo3d.com/hc/en-us/articles/360044081693-Pleats
- [C10] Marvelous Designer manual — Pleats: https://support.marvelousdesigner.com/hc/en-us/articles/51752931944857-Pleats
- [C11] CLO Help Center — Pleats Fold: https://support.clo3d.com/hc/en-us/articles/360000459348-Pleats-Fold
- [C12] CLO Help Center — Slash Spread (Fullness Point / Fullness Line): https://support.clo3d.com/hc/en-us/articles/115000391168-Slash-Spread
- [C13] CLO Help Center — Slash and Spread (community questions only): https://support.clo3d.com/hc/en-us/articles/115012381368-Slash-and-Spread
- [C14] Versluis — How to use the Slash and Spread tool in Marvelous Designer: https://www.versluis.com/2021/01/clo-slash
- [C15] CLO Help Center — Cut: https://support.clo3d.com/hc/en-us/articles/115012380668-Cut
- [C16] CLO Help Center — Fold Arrangement: https://support.clo3d.com/hc/en-us/articles/115012226507-Fold-Arrangement
- [C17] CLO Help Center — Edit Curvature: https://support.clo3d.com/hc/en-us/articles/115012380008-Edit-Curvature
- [C18] CLO Help Center — Change Length: https://support.clo3d.com/hc/en-us/articles/115012226787-Change-Length
- [C19] CLO Help Center — Divide Internal Lines: https://support.clo3d.com/hc/en-us/articles/115013405508-Divide-Internal-Lines

Seen in search results only (not read): CLO 2D Pattern Edit section (https://support.clo3d.com/hc/en-us/sections/115000617868-2D-Pattern-Edit), Marvelous Designer Change Length, Fold Sew Pleats, Optitex Create Multi Pleats / Adding Fullness, Style3D help. Embedded manual videos were not watched.

### What is inferred, not cited (check with the owner)

- CLO's hover distance readout and split preview (the pages only mention the Smart Guide and the purple guide point).
- That CLO has no live ghost before OK for pleats and slash & spread.
- The "inverted box" pleat type (requested by the owner; CLO lists Knife, Box, Accordion).
- Rounding step for Shift (5 mm / 1/8") is a ProwdCAD choice.
