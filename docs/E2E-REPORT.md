# ProwdCAD v2 — end-to-end test report

Date: 2026-11-06 · Suite: `scripts/e2e/` (Node + Playwright, no framework) · Raw data: `scripts/e2e/out/results.json` (HEAD) and `scripts/e2e/out/results-c457a31.json` (pre-rewrite comparison).

## 0. Which code was tested

The select/move rewrite landed while this suite was being written, so two revisions were tested:

| Revision | What it is | Tested |
|---|---|---|
| **`e730eb3`** (= `e1a5d16` app code + the WIP e2e scripts) | Current HEAD: Select is selection-only. New Move Point / Move Line / Move Piece / Curve tools, selection filters and the input box | **Full suite**: every command, every tool, every hotkey, plus units, nested view, drags, selection, export scope, a "nothing selected" probe and the single-file smoke test |
| `c457a31` | Before the rewrite: Select also dragged points, handles and pieces | "Other points moved" matrix and the drag suite, for comparison |

The runner never tests the live working tree. It extracts `git archive <rev>` into `$TMPDIR/prowdcad-e2e-<rev>` and starts Vite there. This was necessary: while the run was going, the parallel developer's edits triggered Vite HMR reloads. Those reloads reset the page mid-run and briefly replaced wired ops with "not wired" placeholders (`setGrade is not wired yet`).

> Note: commit `e730eb3 "WIP: e2e feature test suite"` was not made by this task. It committed an in-progress copy of `scripts/e2e/`, including `out/` artefacts. Since then I added `scripts/e2e/.gitignore` (ignores `out/`), but files that are already tracked stay tracked. Nothing was committed from this task.

## 1. Summary (HEAD `e730eb3`)

The suite enumerates **295 registry commands at runtime**: 261 with a menu, 26 `tool.*` and 8 hotkey-only nudges. Every non-tool command has at least one case (`uncovered: []`). Each case:

1. Reloads a fixture built through the UI.
2. Selects by clicking with the Select tool.
3. Runs the command from the **menubar** (flyouts included), or from its hotkey when it has no menu.
4. Drives the canvas picks and dialogs with realistic values.
5. Checks the effect on the document.
6. Checks that no page error and no "not wired" or error toast appeared.
7. Checks that **Ctrl+Z restores the previous document byte-for-byte** and that **Ctrl+Y re-applies it**.

| Menu / area | pass | fail | skip |
|---|---:|---:|---:|
| File | 17 | 0 | 0 |
| Edit | 20 | 0 | 0 |
| (hotkey-only nudges) | 10 | 0 | 1¹ |
| Point | 28 | 0 | 0 |
| Segment | 16 | 0 | 0 |
| Piece | 27 | **1** | 0 |
| Seam | 24 | 0 | 0 |
| Notch | 16 | 0 | 0 |
| Measure | 8 | 0 | 0 |
| Cut | 21 | 0 | 0 |
| Grade | 35 | **1** | 0 |
| Dart / Pleat / Fullness | 29 | 0 | 0 |
| View | 24 | 0 | 0 |
| Help | 3 | 0 | 0 |
| Tools (palette, flyouts, hotkeys + use) | 34 | **1** | 0 |
| **Total cases** | **312** | **3** | **1** |

¹ `point.propDrag` was removed at HEAD (replaced by Move Point ▸ Smooth).

| Cross-cutting suites | pass / total |
|---|---|
| Hotkeys (every default chord pressed; dispatched command checked) | 103 / 104 |
| Units + fraction input (dialogs, Inspector, grading table, input box) | 20 / 21 |
| Nested view + size switching | 8 / 8 |
| Drag interactions (Select box, Move Point / Line / Piece, Curve) | 20 / 21 |
| Selection persistence | 23 / 25 |
| "Other points moved" matrix | 9 scenarios × 9 methods (§3) |
| "Nothing selected" probe of every menu command | 253 probed, 78 greyed out, 0 page errors |
| Single-file build `dist/prowdcad-v2.html` (file://) | loads with no errors and a real PDF download works, but the build is **stale** (§2, B10) |

Every undoable command needed exactly **one** undo step: no command split into several transactions.

## 2. Failing features and bugs (ranked by impact)

The "Where" column gives the suspected file / function. "Test" names the case id in `results.json`.

| # | Feature | Repro (exact) | Observed | Expected | Where | Test |
|---|---|---|---|---|---|---|
| B1 | **Half piece: mirrored half breaks hit-testing** | Cut ▸ Half piece ▸ Set mirror axis on FRONT (CF_HEM → CF_NECK, open at output ✓). Hover over the left (mirrored) half with Select, then click CF_NECK (a point on the fold axis) | `TypeError: Cannot read properties of undefined (reading 'id') at segmentIds (hitkit.ts) ← candidatesAt (selpick.ts:105) ← select.ts move`, repeated on mouse-move. Clicking CF_NECK selects **nothing**, and neither Select nor Move Point can pick it (Select drag-move opt-in: no move) | The axis point is selectable; no exception | `selpick.ts candidatesAt` → `segmentIds(p.sew, r.sew, k)`: `r` is the *opened* half (18 resolved points) but `p.sew` is the stored half (10). The resolved index `k` / `gradeIdx` is used against the stored contour. The same index mix-up can affect any resolved-vs-stored lookup on half pieces | `special.otherPoints` halfAxis rows; consoleErrors |
| B2 | **Grading table / Inspector ignore a typed value equal to the rounded display** | Status bar unit = *in 1/16*. Select FRONT/UA, Ctrl+G. The L dX cell shows `3/8` (the true value is 10 mm = 0.394"). Type `3/8`, then Enter | Nothing is committed: UA abs L dX stays 10 mm. In the Inspector, 260 mm shows as `10 1/4`, and typing `10 1/4` is ignored the same way | 9.525 mm (exactly 3/8") | `panels/widgets.ts lengthInput.commit`: `if (inp.value.trim() === orig) return` compares the **rounded display text**, not the value. Compare the parsed mm with the stored mm, or show enough precision. Matters for inch users who type the grade they see | `units: Grading table cell "3/8"` |
| B3 | **Export scope remembers "All pieces" over the current selection** | File ▸ Export ▸ PDF with nothing selected → OK. Then select FRONT → Ctrl+P | Pieces = **All pieces (2)**. The PDF has 18 pages with FRONT and BACK. Same for SVG / DXF / PLT (`rememberedDialog` restores `pieces`) | Pieces = Selected (1), the default when something is selected. The first export of a session does show "Selected (1)" and exports FRONT only (9 pages) | `actions/file.ts` export dialogs: `pieces` is a remembered field. Prefix it `_pieces` (not remembered) or override it when `app.sel.pieces.length` | `special.exportScope` |
| B4 | Rotate Piece ignores the selected piece (noun → verb) | Select BACK → Piece ▸ Modify Piece ▸ Rotate Piece → type `90` | No input box opens. The prompt still says "Select piece to rotate". It works only after clicking the piece again | The selected piece is adopted and typing opens the angle box | `tools/move.ts pieceTool` (rotate mode adopt / key handler) | `move.pieceRotate` |
| B5 | Move Point grabs the internal point instead of the selected sew point | Internal line ending exactly on UA, Piece ▸ Connections ▸ global check. Select UA (Select puts CN_A first; Tab cycles to UA). Press G, then drag on UA, or click it and type dX dY | UA does not move. The internal end CN_A moves alone, which breaks the connection the other way round | When the selection is a coincident sew point, Move Point grabs it (or offers Tab cycling like Select) | `tools/move.ts pointUnder` / `candidatesAt` ranking | `special.otherPoints` connection/mpSingle, mpSmooth, mpInput |
| B6 | Slash tool rejects a start outside the piece, against its own hint | K → click at (−30, 300), outside FRONT, as the hint says. Then (300, 300) → Enter | Status "Start on or inside a piece". Nothing happens | Hint: "click the first point (on or outside the outline of a piece)". Starting outside is how slashes are drawn in AccuMark | `tools/construct.ts slashTool.down` (`pieceUnder` only) | `tool:slash` (passes when started on the outline: `tool:slash#outline`) |
| B7 | Graded nest default name loses the piece name | Select FRONT and its duplicate → Grade ▸ Graded nest from pieces… | Name field `" NEST"` (leading space). The piece is created as " NEST" | "FRONT NEST" | `actions/grade-cmds.ts grade.nest`: `name.replace(/[_ ]?\w+$/, '')` strips the whole single-word name | `grade.nest` |
| B8 | Snap-to-grid hotkey never works | Press Ctrl+Shift+' | Toggles the **grid display** (Ctrl+') instead. On a US layout the key is `"`, so nothing matches | Toggles Snap to grid | `commands.ts chordFromEvent` drops Shift for symbol keys, so `Ctrl+Shift+'` is unreachable. Rebind it, or match on `e.code` | `hotkeys.mismatches` |
| B9 | Move Point: click then immediate press makes an empty undo step and loses the drag | G → click UA → within 450 ms press on UA again and drag 20 mm | "Moved 0, 0 mm". One undo step "Move point" with no change. The drag that follows is ignored | Either the click-carry is cancelled by a press on the same spot, or the press starts a drag. No zero-delta undo step | `tools/move.ts movePointTool.down` (carry → commit with 0 delta) | `drags: Move Point: click … then drag` |
| B10 | Single-file build is stale | `npm run e2e` single suite, `dist/prowdcad-v2.html` (mtime 12:37) | 24 registry menu commands are missing from its menubar (all move.*, sel.filter.*, piece.flipH/V, edit.prefs, …) | Rebuild with `npm run build:single` after the rewrite | build step | `single` |
| B11 | Inspector X/Y ignores point connections | Same connection setup as B5 (select UA programmatically). Type in the Inspector X field +15 | UA moves; the connected internal end CN_A stays | Move XY, nudge and Move Point move CN_A with it (`movePoint` follows connections). The Inspector writes `an.x` directly | `panels/inspector.ts setPos` → use `ops.movePoint` | `special.otherPoints` connection/inspX, inspY |

Fixed by the rewrite (failed at `c457a31`, pass at HEAD):

* Click-then-drag toggled corner ⇄ smooth: the 450 ms double-click window swallowed the drag.
* Dragging an unselected **curve** point moved the whole piece.
* Shift-drag on a selected point de-selected it instead of constraining.
* Arrow-nudge bypassed point connections while Move XY honoured them.

## 3. "Do other points move?" — the owner's complaint

**Method.** Each move was applied to one point. Before and after, the suite compares:

* every other anchor's **stored** data: x/y, handles, grading, kind;
* the **resolved** position of every other anchor in every size (S, M, L, XL).

Fixture: FRONT tee half (corners CF_HEM, SS_HEM, UA, SH, HPS, CF_NECK; curve points AH1, AH2 on the armhole and N1, N2 on the neck). It is graded (UA +10/+5 per size, SH +6/+8, …).

**At HEAD (`e730eb3`)** — "stored" = other anchors whose stored data changed. "Resolved" = other anchors whose drawn position changed in at least one size.

| Scenario (point moved) | Move Point Single (drag) | Single (typed) | Move XY dialog | Nudge (in Move tool) | Inspector X/Y | Select drag opt-in | **Move Smooth** | Select (plain) |
|---|---|---|---|---|---|---|---|---|
| plain grade point (UA) | stored 0 · resolved AH1, AH2 | same | same | same | same | same | **stored AH1, AH2** | nothing (Select never edits) |
| grade point next to curves (SH) | stored 0 · resolved AH1, AH2 | same | same | stored 0 · resolved 0 (10 mm in X) | same as drag | same | **stored AH1, AH2** | nothing |
| curve point (AH1) | stored 0 · resolved AH2 | same | same | same | same | same | **stored AH2** | nothing |
| smooth point with explicit handles (UA) | stored 0 (own handles move rigidly) · resolved AH1, AH2 | same | same | same | same | same | stored AH1, AH2 | nothing |
| **point connection** (internal end on UA) | **UA not moved; CN_A moved (B5)** | same (B5) | **stored CN_A follows** | **stored CN_A follows** | **CN_A does not follow (B11)** | CN_A follows | UA not moved (B5) | nothing |
| half piece, off the axis (SS_HEM) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | nothing |
| half piece, on the axis (CF_NECK) | resolved N1, N2 (selected programmatically: B1) | same | same | same | same | **cannot be picked** | stored N1, N2 | — |
| active size L (UA) | stored: only UA's own grade · resolved AH1, AH2 | same | same | same | same | same | own grade + **AH1, AH2 grade** | nothing |
| next to a dart (SS_HEM, live fixture) | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | nothing |

What actually moves other points:

1. **Curve-point following (resolved only, by design).** When a grade point moves, the drawn position of the curve points between it and its neighbouring grade points (AH1/AH2, N1/N2) changes. Their stored coordinates do not change. Two causes:
   * Curve points carry no grading of their own, so in the graded sizes they interpolate between their neighbours.
   * In the base size the Catmull-Rom tangents are recomputed.

   This is what a pattern maker sees on screen as "the neighbouring points moved", especially in the nested view. It is the single biggest source of the complaint. **Suggestion:** say it in the Move Point prompt, or offer a "freeze neighbours" option that materialises curve-point grading before the move.
2. **Move Smooth** (and `Point ▸ Move proportional`; formerly *Proportional drag*, Alt+P, at `c457a31`) intentionally re-writes the **stored** x/y of every curve point between the tacks. In a non-base size it writes their **grading**. At `c457a31` this mode was a sticky global toggle (Alt+P, persisted in settings), so a user who once pressed Alt+P got blended moves from every later Select drag, with only a small "[Proportional drag ON]" prefix in the status hint. HEAD fixes this: the mode is explicit and resets to Single every session.
3. **Point connections** move the connected internal point by design, but inconsistently:
   * Move XY, nudge (HEAD), Move Point and Select drag opt-in follow them.
   * The Inspector does not (B11).
   * At `c457a31`, the Select drag and arrow nudge did not follow them either.

   Separately, the coincident internal end is on top in hit-testing, so the sew point cannot be grabbed with Move Point (B5).
4. **Explicit handles** of the moved point move rigidly with it (stored relative). No other point's handles changed in any test.
5. **Grading of other points** never changed, except under Move Smooth in a non-base size.
6. **Half pieces / darts:** no other stored point changed, and the stored half never gains points. Axis points are unreachable (B1).
7. **Non-base size edits** change only the moved point's grade for that size: XL keeps its absolute position (verified for Move Point, Move XY, nudge, Inspector, nested-view drag). A direct **incremental** grading-table edit of L *does* shift XL (L +12.7 → XL 22.7). This follows the incremental convention, but an AccuMark user expects grading-table edits to be absolute per size. The table has an Absolute toggle, but it is off by default.

At `c457a31` (old Select tool) the results were the same as the HEAD columns, plus these differences:

* Select-drag of a selected point within 450 ms of the selecting click toggled corner/smooth instead of moving.
* Shift-drag de-selected the point.
* Proportional drag was sticky.
* Nudge ignored connections.

## 4. Selection persistence

All of these keep the selection (exact ids compared, HEAD):

* Copy grade from the menu, Ctrl+Alt+C or the grading-table toolbar button; Paste grade.
* Seam of segment (point or segment selected); Whole-piece seam; Reseam piece; Move point XY.
* Undo after a change; switching the size (status bar, chips, Ctrl+[ ]); nested view.
* Typing in the Inspector; cancelling a dialog with Esc; cancelling a canvas pick with one Esc.
* Dart close/reopen with a dart selected; Align H with two points; Corner ⇄ smooth; Rotate 90°.
* G → Esc; a Move Point drag → Esc; tool switch M → V.

Every menu command was also run with its precondition selection (316 cases). The selection changes only where the command creates or removes objects:

* The new piece becomes the selection: Duplicate, Cut ▸ \*, Join, Build, Ruffle, Skirt, Binding, Save as new, Merge, Import, Nest.
* Add point / Insert point / Add at click select the new point.
* Round corner, Divide internal, Delete point and Remove dart clear the point selection, because the object no longer exists.
* Dart / pleat / fullness creation selects the new live object, which drops the point selection.

Failures:

| Action | Result |
|---|---|
| Point selected → open any menu → press **Esc** to close it | **Selection cleared.** Esc closes the dropdown *and* runs Edit ▸ Deselect all (`main.ts` keydown → `commandForEvent('Escape')`; the menubar has no Esc handler). Users dismiss menus with Esc all the time |
| Point selected → command with a pick (e.g. Segment ▸ Rotate segment) → Esc → Esc | The second Esc clears the selection. This is by design at HEAD ("Esc in Select clears"), but because the first Esc gives no feedback, a double-tap is common. Consider: Esc clears only when nothing else was cancelled in the last ~0.5 s |

## 5. Export scope

With FRONT selected, File ▸ Export ▸ PDF (Ctrl+P) shows **Pieces = "Selected (1)"**, options "All pieces (2) / Selected (1)", and the PDF holds FRONT only (9 A4 pages, no "BACK" text). SVG and DXF behave the same way. Selecting a point (FRONT/UA) also gives "Selected (1)".

The scope problem is B3. As soon as the user has once exported with "All pieces", every later export dialog reopens on **All pieces even when a piece is selected**, and exports everything (18 pages).

## 6. Usability findings (ranked by impact for an AccuMark / TUKAcad pattern maker)

1. **Fraction display swallows input** (B2). Values display rounded to 1/16", and typing the displayed value is ignored. Inch users cannot set "3/8" when the cell already shows 3/8. Show the exact value (e.g. `0.394` or `25/64+`), or compare values rather than text.
2. **Curve points visibly move with their neighbours** (§3.1) with no explanation in the UI. This is the root of the "other points moved" perception. Add a line to the Move Point prompt, e.g. "curve points between UA and SH follow (no own grading)", and a one-click "grade curve points explicitly".
3. **Export dialogs remember the scope** (B3), so it is easy to send all pieces to the plotter or PDF by accident.
4. **Esc on an open menu clears the selection** (§4).
5. **Coincident points:**
   * Select offers Tab cycling and lists the candidates in the status bar ("2/5: Grade pt 1 CN_A · FRONT · Tab = next").
   * The Move tools have no equivalent (B5).
   * The internal end, not the sew point, wins the first click.
   * AccuMark users expect the perimeter point to have priority.
6. **Curve points of an unselected piece have no hit target in Select.** The first click on AH1 selects the piece, and a second click is needed (FRONT/AH1 needed two clicks in every run). TUKAcad and AccuMark pick the point directly.
7. **Comma means two different things:**
   * In dialogs, `12,5` is 12.5 mm (decimal comma).
   * In the Move input box, `12,5` is dX 12 dY 5.

   A European user typing a decimal comma in the input box gets a diagonal move.
8. **Slash hint versus behaviour** (B6). The hint invites a start outside the piece, then the click is refused.
9. **Commands that need a piece but do not pick one.** File ▸ Export ▸ Size as standalone style… and Cut by guideline… show an error toast ("Select a piece", "Drag a guide out of a ruler first"). Most other commands start a canvas pick ("Click a piece"). Make these consistent.
10. **Greyed-out menu items never explain why** (78 of 253 with nothing selected). Clicking them does nothing; there is no tooltip such as "needs a selected point". AccuMark-style users look for the function, find it grey, and get stuck. Add `hint` text, or enable the item and prompt for the pick.
11. **Plain Save prompts for a file name every time** when the File System Access API is missing (Firefox/Safari): Ctrl+S always opens "Save". In headless Chromium with the API present, Ctrl+S did nothing visible at `c457a31`: no toast, no download, still dirty. This is likely environment-specific (no native picker), but a toast on `AbortError` vs. failure would help.
12. **Browser-reserved hotkeys:**
    * Ctrl+Shift+N (Notch grid) opens an incognito window in Chrome/Edge and never reaches the page.
    * Ctrl+Shift+I (Import) opens DevTools.
    * Ctrl+Shift+R (Rule library) reloads.
    * Ctrl+1 (100 %) switches tab.

    Headless tests reach the page, but real browsers will not. Remap them.
13. **File ▸ New "discard changes?" confirm has the same title ("New style") as the form that follows**, so it is easy to confirm the wrong thing.
14. **The status message survives a document reload.** "Point tracking ON…" stayed in the status bar after the document changed.
15. **DXF default flavour is AAMA (flat ENTITIES, no BLOCK per piece)**, while `docs/FILE-FORMATS.md` calls ASTM the default. Round-trip import works (DXF+RUL → 2 graded pieces, 7 rules). Gerber AccuMark importers commonly expect a BLOCK per piece, so verify AAMA output with AccuMark before shipping, or default to ASTM.
16. **Several commands silently do nothing on a typical fixture**: Update seam grading, Reseam piece, Repair, Fix dart (legs already equal), Grade parallel (already parallel). Each reports a count, or nothing at all, and makes no document change. A toast such as "nothing to fix" would help.
17. **Grading table edits are incremental by default.** Editing L shifts XL (§3.7). AccuMark users think in per-size breaks ("absolute"): consider defaulting the table to Absolute, or warn when an incremental edit cascades.

Things that worked well and are worth keeping:

* Every command's undo/redo is exact and single-step.
* No page errors in 316 cases, apart from B1.
* Fraction / suffix parsing is robust: `1 1/8`, `1-1/8`, `1.1/8`, `9/8`, `-1 1/8`, `2cm`, `30mm`, `1"`, `12,5`, `2 1/2` cm.
* Inspector edits never round an untouched axis.
* Non-base-size edits are exact.
* Select never edits geometry.
* Window and crossing boxes, Tab cycling, and the Move Point input box (`1 1/8` in inch mode → exactly +28.575 mm) all work.

## 7. How to run

```bash
npm install                      # once
npm run e2e                      # snapshot of HEAD → Vite on :5199 → all suites (~25 min)
E2E_REV=c457a31 npm run e2e      # any other revision (git archive → $TMPDIR/prowdcad-e2e-<rev>)
E2E_TREE=1 npm run e2e           # the live working tree instead (beware Vite HMR reloads)
E2E_URL=http://localhost:5173/ npm run e2e     # an already running dev server
E2E_SUITES=commands,tools npm run e2e          # suites: commands, tools, hotkeys, special, single
E2E_ONLY='^seam\.' npm run e2e   # only matching case ids; special parts: 'special:(otherPoints|units|nested|drags|selection|exportScope|fsa|noSelection)'
E2E_OUT=my-run.json npm run e2e  # results file name under scripts/e2e/out/
npm run build:single             # before relying on the single-file smoke suite
```

The exit code is 1 when any case fails. Output goes to `scripts/e2e/out/`:

* `results.json`: per case status, messages, toasts, dialogs (title, labels, defaults), status-bar prompts, selection before/after and undo steps. It also holds the hotkey, special and noSelection data.
* `shots/fail-*.png`
* `fixtures/`: generated DXF, RUL, SVG, PLT and native files used by Open / Import / Merge.

Layout:

* `lib/harness.cjs`: Playwright driver. Menu flyouts, dialogs, world→screen clicks and drags, file chooser.
* `lib/page-helpers.js`: in-page observation only. Command spy, toast / dialog / status recorders, download capture, geometry queries; it never changes app behaviour.
* `lib/fixture.cjs`: graded tee FRONT/BACK.
  * Built through the UI: File ▸ New, Pen with Ctrl+click curve points, Rectangle dialog, Piece ▸ Rename, Internal tool.
  * Pure data set through kernel ops in a clearly separated block: point names, grade values, one notch, one drill. The "live" variant adds a dart, a pleat and fullness.
* `lib/runner.cjs`: generic case executor.
* `suites/commands.cjs`: one or more cases per command id.
* `suites/tools.cjs`: every palette tool via the palette or flyout.
* `suites/hotkeys.cjs`
* `suites/special.cjs`: other-points matrix, units, nested, drags, selection, export scope, FS-API probe, nothing-selected probe.
* `suites/single.cjs`

Commands whose id does not exist at the tested revision are reported as *skip*. A command in the registry without a case is listed in `uncovered` in `results.json`.

The parallel developer's `scripts/e2e-move/run.cjs` covers the Move tools in more depth. This suite overlaps it only in §3 and the drag suite.
