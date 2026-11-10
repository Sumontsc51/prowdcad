# ProwdCAD interaction model: research and spec for select / move / modify

Status: research + proposed spec, for the developer implementing it in `apps/web`.
Date: 2026-11-06. No code was changed while writing this.

How claims are marked:

- **[C]**: cited. A source in section 3 states it (number in brackets, for example [C3]).
- **[I]**: inferred. It comes from general knowledge of the product or from industry convention, and I could not confirm it in a source I was able to read. Check it with the owner, who uses AccuMark and TUKAcad every day.
- **[P]**: proposal for ProwdCAD. It is a design decision, not a claim about another CAD.

---

## 0. The problem, and where ProwdCAD stands today

The owner's feedback, paraphrased:

- Moving a point must not move other points.
- What I select must stay selected so I can keep modifying it.
- Other CADs are "hard-coded": each move needs its own tool. Make ProwdCAD friendlier than that, and take ideas from AccuMark and other manuals.

What the code does today:

- `apps/web/src/tools/select.ts`: when you drag an anchor that is already selected, every selected anchor moves (`const refs = grade ? [ref] : app.sel.anchors.slice()`). The owner is complaining about exactly this: after a Shift-select or a marquee, grabbing one point drags the whole group.
- In the same tool, a press on a piece body followed by a move translates the piece. A click meant to select a piece can therefore nudge it by a few pixels.
- `Selection` in `app.ts` holds only `{ pieces, anchors }`. Lines and segments, internals, notches, drills and text cannot be selected as first-class objects, and there is no selection filter.
- Selection, point move, handle edit, piece move and marquee are all in one tool, controlled by modifiers (Alt, double-click). Nothing on screen tells the user which of these will happen.
- Snaps (`canvas/snap.ts`) cover anchors, guides and the grid. There is no snap to the nearest point on a line, midpoint, intersection or perpendicular foot.

**About "Select never moves geometry".** The brief asks for a Select tool that never moves geometry, and section 2 follows it. The owner's wording ("other CADs are hard-coded… make it more user friendly") can also be read as "let me drag in Select, but move only the thing I grabbed". Section 2.3.6 covers both readings with a fast path: noun-then-verb hotkeys work on the current selection, plus an opt-in setting **Select ▸ Drag edits (single item)**. Confirm with the owner which one should be the default.

---

## 1. Comparison of the reference CADs

### 1.1 Selecting vs modifying

| CAD | How selecting is separated from modifying | Order (verb-noun or noun-verb) | Does the tool stay active? |
|---|---|---|---|
| **Gerber AccuMark PDS** | Hard split. Every edit is a named function in a menu: Point ▸ Modify Points ▸ Move Single Point / Move Points / Move Smooth / Move Pt Line/Slide / Move Pt Horiz/Vert / Align 2 Points / Move Range; Line ▸ Modify Line ▸ Move Line / Move Line Anchor / Move Offset / Rotate Line / Adjust Length / Swap Line; Piece ▸ Modify Piece ▸ Move / Rotate / Flip / Walk [C7][C8][C6]. Select All and Clear All (Ctrl+A / Ctrl+D) are separate commands [C6][C8]. | Verb then noun: choose the function, pick the objects, right-click **OK**, then drag or type the value [C7]. | The function repeats. After one point is moved, "select the next point if needed". You leave with right-click ▸ OK [C7]. |
| **TUKAcad / TUKAdesign** | Separate tools, also hard-coded: "point on, move point, move proportional, move parallel" [C17]. The training covers "How to Use a Tool", "Right Mouse Click Option", "Movement" and "Previous, Next, and Clockwise" as core principles [C15][C16]. | Verb then noun [I]. | Repeats until right-click or a tool change [I]. |
| **Optitex PDS** | Separate tools in a Movement toolbox: Move Point Tool, Move Points Tool, Move Points Proportionally Tool, Move Points In Parallel Tool, Move Point Along Contour, Multi Move Tool, Move Point Size, Move Size Proportional, Smooth Tool [C11 titles]. The Select tool is its own tool and is reached with the END key or the right-click menu [C12]. Some quick moves skip tool changes: "Move piece – with space bar only (no mouse drag)", "move internal – Ctrl+space" [C12]. | Both. | Not documented. |
| **Lectra Modaris** | Function boxes F1–F8. **F3 = Pattern Modification: Re-shape / Move / Stretch / Pin / Merge / Section** [C13]. "S – short cut for Selection – (safe mode)". Going back to Selection "will prevent the function from repeating" [C13]. | Verb then noun: "first select the Function required… then click on the relevant Command Field" [C13]. | Yes: "Once a Command is selected the process will continue whilst the box is Highlighted" [C13]. |
| **CLO 3D (2D window)** | Selecting and moving share tools, split by object type. **Edit Pattern** selects and moves points and segments. **Transform Pattern** moves, rotates and scales whole patterns. **Transform Point/Segment** puts a bounding box round selected points or segments. **Edit Curvature** bends a segment. **Edit Curve Point** adds and moves curve points [C1][C2][C3][C4][C5]. | Noun then verb: select, then drag in the same tool. | Yes, a normal modal tool. |
| **Style3D Studio** | Edit Pattern selects and drags points and lines, on internals and on the outline. Reference lines can be selected only under Trace [C14]. | Noun then verb. | Yes. |
| **Richpeace DGS** | **Intelligent Pen (F)** draws. **Modify (A)** edits points. Right-click on a line inside the pen switches to Modify, and Shift toggles between the selection cursor and the adjust cursor [C18]. | Mixed. | Yes. |
| **Seamly2D / Valentina** | Parametric. Points are results of formulas, so you do not drag them. You edit the tool that created them (right-click ▸ Options) [C19][C20]. Operations (Move Alt+M, Rotate R, Mirror M,L / M,A) work on selected objects, and Enter ends the selection [C21][C22]. | Verb then noun, with Enter to finish the selection [C22]. | One-shot. |

### 1.2 Point-move tools

| Behaviour | AccuMark | TUKAcad | Optitex | Modaris | CLO | Richpeace |
|---|---|---|---|---|---|---|
| **Single point, nothing else moves** | **Move Single Point** (Alt+F12): left-click the point, drag, left-click to set; the function repeats; right-click ▸ OK ends it [C7][C6] | Move Point [C17] | Move Point Tool. O/15: "the Segment Length now appears interactively next to the cursor" [C11][C10] | F3 Move [C13] | Edit Pattern: drag a point [C1] | Modify (A): "Click control point and drag to suitable place, Then click" [C18] |
| **Several points by the same delta** | **Move Points** (Alt+F2): same as Move Single Point, but you can pick several points first [C7][C6] | Not documented | Move Points Tool, Multi Move (O/15.5: "move only visible objects") [C11][C10] | Not documented | Shift-select, then drag [C1] | Marquee, then Enter for an offset [C18] |
| **Smooth / proportional** | **Move Smooth** (Alt+F11): click the point, and **two thumbtacks** appear to anchor the fixed points. Drag the tacks to the points that must stay, then move the point. The curve between the tacks blends [C7]. Variants: Move Smooth Line, Horiz, Vert [C7] | Move Proportional [C17] | Move Points Proportionally Tool [C11] | Not documented | Not documented | Drag A→C, and Shift switches to proportional adjust with an offset dialog [C18] |
| **Along a line (slide)** | **Move Pt Line/Slide**: the point slides along its line, and a value can be typed [C7][C8] | Not documented | Move Point Along Contour [C11] | Not documented | Ctrl constrains to the slope of the item [C2] | Not documented |
| **H / V constrained** | **Move Pt Horiz / Vert** and Move Smooth Horiz / Vert [C7] | Not documented | Not documented | Ctrl snaps to 0°, 45°, 90°… [C13] | Shift / Ctrl constrain to vertical, horizontal, diagonal or slope [C1][C2] | Shift = H / V / 45° [C18] |
| **Align** | Align 2 Points (Alt+F3): H, V, midpoint or along a line [C7] | Not documented | Not documented | F1 Ali3Pts [C13] | Not documented | Not documented |
| **Per size** | Edited through grade rules (Edit Delta Alt+J, Create Delta Alt+K) [C6] | Not documented | **Move Point Size**, **Move Size Proportional** [C11] | F6 grading, F7 size changes [C13] | Not applicable | Not documented |

### 1.3 Moving lines, moving pieces, editing curves

| Function | AccuMark | Others |
|---|---|---|
| **Move line** | **Move Line** (Ctrl+F2): select the line, then drag it or type the distance from the old line. Mostly used for internal lines [C7][C8]. | CLO: drag a segment in Edit Pattern. Typed values give only "Distance Moved" [C1]. Optitex: Ctrl+Space moves an internal line [C12]. |
| **Move line, keep length** | **Move Line Anchor** (Ctrl+F3): pins appear at the ends of the neighbouring lines. Drag each pin to a fixed point, right-click OK, then drag or type [C7]. | Not documented. |
| **Parallel move** | Move Offset; Make/Move Parallel (Ctrl+F11) [C7][C6]. | Richpeace: "Parallel move: drag the point and an offset dialog appears" [C18]. TUKA: move parallel [C17]. Optitex: Move Points In Parallel [C11]. |
| **Rotate line** | Rotate Line: select the line, right-click OK, click the pivot, then drag or type an angle [C7]. | Not documented. |
| **Adjust length** | Select the line, drag the pin to the end that stays, click. The panel shows the current length and you can overwrite it [C7]. | ProwdCAD already has Segment ▸ Set exact length. |
| **Swap line** | **Swap Line** (Alt+S): select the internal line(s), right-click OK, select the perimeter line(s), right-click OK [C7][C6]. | ProwdCAD: Segment ▸ Swap internal ⇄ perimeter. |
| **Move piece** | Move Piece (Shift+F2): moves along X / Y [C8][C6]. | CLO Transform Pattern: drag or arrow keys; Shift / Ctrl constrain; right-click or F1 while moving to type the distance [C2]. Optitex: Space bar moves a piece with no tool change [C12]. |
| **Rotate piece** | Rotate Piece (Shift+F10). Free mode: select pieces, OK, pick the pivot, pick a start line, then drag or type the angle. Preset mode: angle plus CW / CCW, click the pieces, OK [C7][C6]. | Modaris: Q / W rotate 1° and A / S rotate 10° (Q, A anticlockwise; W, S clockwise) [C13]. CLO: double-click the pivot to activate it, then drag the rotation handle [C2]. Optitex O/15.3: "flip and rotate pieces while dragging" [C10]. |
| **Flip piece** | Flip Piece (Shift+F9): about a symmetry line you click, or in a direction you pick from the panel [C7][C6]. | Modaris: X / Y keys = horizontal and vertical symmetry [C13]. |
| **Curve editing** | Modify Curve, Reshape Curve (Expert edition), Smooth (each click smooths more), Flatten Line Segment (Ctrl+F12) [C7][C8][C6]. | CLO: Edit Curvature (drag part of a straight line and it bends) [C4]. CLO Edit Curve Point: click a segment to add a curve point; drag a segment to add a point and shape it in one move; Delete removes; right-click while moving to type the distance [C5]. Richpeace: click the curve = add a point; right-click a point or Delete = remove; Shift = curve ⇄ corner; Ctrl = tangent-smooth [C18]. |

### 1.4 Numeric input, right-click, snapping, selection, feedback

| Topic | AccuMark | TUKAcad | Optitex | Modaris | CLO / Style3D | Richpeace | Seamly2D |
|---|---|---|---|---|---|---|---|
| **Numeric input** | A **user input box**, a panel docked at the side ("bảng bên phải màn hình"). After the pick, a left-then-right click opens the value, and you type it and press Enter [C7]. Dialogs end with "Press OK to continue" [C9]. | User input dialog [I] | Point location dialog; the default can be set to "From snap point" (O/15.5) [C10] | Dialogue box: "Use these arrows to type in a value (e.g. in Pin and Move function)" [C13] | **Right-click or F1 while dragging** opens Distance Moved, or X-Axis / Y-Axis for a point [C1][C2][C3][C5]. Style3D: "right click to input the specific distance to move" [C14] | Enter while the cursor is on a point opens the value dialog. Type one value, or two in sequence [C18] | A dialog after the left click that places the object [C22] |
| **Right-click** | Confirms and exits: "bấm phải chọn OK" (right-click, choose OK). The right-click menu gives OK and Cancel [C7][C9]. Undo in that menu: [I] | A dedicated "Right Mouse Click Option" lesson [C16]. Ends the function [I] | Opens the Select tool, among other things [C12] | "Right click to end a command, multi[-select]" [C13] | Typed distance during a move. Context functions on a point or line [C2][C14] | Switches pen → Modify; on a control point it deletes [C18] | Context menu ▸ Options edits a point [C20] |
| **Middle button / wheel** | Not documented | Not documented | Not documented | "The middle scroll button undoes the last click in certain functions"; V8: zoom [C13] | Not documented | Not documented | Not documented |
| **Snapping** | Snap to geometry; the PE release notes fix "snap to geom" under Move Smooth Point [C9] | Not documented | Hovering highlights the element red before you click [C12]. O/15.3 adds snaps when rotating a segment [C10] | "Click accuracy" sets a radius, and any object inside it is attracted to the click [C13] | Guidelines appear while dragging with Shift [C3] | Snap to key points and intersections [C18] | Not documented |
| **Several objects under the cursor** | Not documented | Not documented | Not documented | "Space bar cycles through ambiguous selections while the mouse button is held" [C13] | A pop-up menu lets you pick one (v3.0) [C1][C3] | Not documented | Not documented |
| **Multi-select / marquee** | Pick several in Move Points [C7]. Matrix selection with Ctrl / Shift in dialogs [C9]. "Click n Go" mode with Ctrl [C9] | Not documented | Shift for several points; Shift, bounding box or Piece Bar for several pieces [C12] | Shift-click or a drag window [C13] | Shift-click; drag a marquee (items must be fully inside) [C1][C3]; Select All Sewn Ctrl+Alt+A [C2] | Marquee [C18] | Click, then Enter [C22] |
| **Persistence and repeat** | The function repeats on the next object until OK [C7] | Not documented | Not documented | Repeats while the box is highlighted; Selection = safe mode [C13] | The selection stays until you click elsewhere [C1] | Not documented | Not documented |
| **Prompts** | Prompt line at the bottom of the screen [I] | Status Bar lesson [C15] | Live segment length next to the cursor [C10] | Status bar at the bottom [C13] | Selected items turn yellow [C3][C4] | Ctrl+H shows chord height while adjusting [C18] | Prompt at the lower left: "select one or more objects", then ENTER [C22] |
| **Arrow-key nudge** | Not documented | Not documented | Not documented | Not documented | 0.25 per press [C3]; arrow keys move patterns [C2] | Number keys change the count or position of control points [C18] | Not documented |

### 1.5 Keyboard shortcuts AccuMark users already know [C6]

| AccuMark | Function | Proposed ProwdCAD tool |
|---|---|---|
| Alt+F12 | Move Single Point | Move Point (Single) |
| Alt+F11 | Move Smooth | Move Point (Smooth) |
| Alt+F2 | Move Points | Move Point (Group delta) |
| Alt+F3 | Align 2 Points | Align |
| Alt+F1 | Delete Point | Delete |
| Ctrl+F2 | Move Line | Move Line |
| Ctrl+F3 | Move Line Anchor | Move Line (Keep length) |
| Ctrl+F11 | Make/Move Parallel | Move Line (Parallel) |
| Ctrl+F12 | Flatten Line Segment | Curve ▸ Flatten |
| Ctrl+F10 | Split | Segment ▸ Divide |
| Alt+S | Swap Line | Swap internal ⇄ perimeter |
| Shift+F2 | Move Piece | Piece Move |
| Shift+F9 | Flip Piece | Piece Flip |
| Shift+F10 | Rotate Piece | Piece Rotate |
| Shift+W | Walk Pieces | Walk |
| Ctrl+A / Ctrl+D | Select All / Clear All | the same |

Some of these keys clash with the browser. Alt+F4 (close window) and Ctrl+F4 / Ctrl+W (close tab) cannot be captured in Chrome or Edge. F11 is fullscreen. F1 opens browser help unless the page calls `preventDefault` [I]. Ctrl+D (bookmark) and Ctrl+F3 / Shift+F3 (find) can be captured with `preventDefault` [I]. ProwdCAD already uses Ctrl+D for Duplicate. Offer these keys as a switchable **"AccuMark keys"** preset in Edit ▸ Keyboard shortcuts, not as the default [P].

---

## 2. Spec: interaction rules for ProwdCAD

### 2.1 Core principles [P]

1. **Select only selects.** Moving, reshaping, rotating and flipping always happen in a named Modify tool. (The owner may choose the opt-in exception in 2.3.6.)
2. **One grab, one object.** A Move tool moves exactly the object under the cursor at mouse-down, never the rest of the selection. Moving a group is a separate, explicitly named mode ("Group delta"), as in AccuMark's Move Points [C7].
3. **The selection survives commands.** After any edit, the edited objects are still selected. Undo and redo restore the selection that was current at that step.
4. **Noun-verb and verb-noun both work.** If the current selection fits the tool's input, the tool uses it straight away. Otherwise the tool prompts for a pick (AccuMark style [C7]).
5. **Tools repeat until you leave them.** As in AccuMark and Modaris [C7][C13], a Move tool goes back to its first step after each move. Esc or V returns to Select.
6. **Every step has a prompt.** The status bar always shows: tool name · mode · step text · what right-click, Enter and Esc will do.
7. **Right-click = OK**, **Esc = Cancel**, **Backspace = undo the last pick inside the tool**. This applies to every tool.
8. **Typed values beat the mouse.** During any drag or after any pick, typing a digit opens the input box with the live values already filled in.
9. **Previews are free, commits are single.** Keep the existing preview-clone pattern: one `doc.transact` per completed operation, and Esc discards the preview.

### 2.2 Selection model (`app.ts`)

Replace `Selection { pieces; anchors }` with typed items [P]:

```ts
type SelItem =
  | { k: 'piece';    pieceId }
  | { k: 'point';    pieceId; contourId; anchorId }            // grade or curve anchor, sew or internal
  | { k: 'segment';  pieceId; contourId; fromAnchorId; toAnchorId } // grade segment, or a run
  | { k: 'internal'; pieceId; contourId }                       // whole internal line or shape
  | { k: 'notch';    pieceId; notchId }
  | { k: 'mark';     pieceId; markId }                          // drill, button, text
  | { k: 'live';     ref: LiveRef };                            // dart, pleat, fullness
interface Selection { items: SelItem[]; primary?: number /* index of the last clicked item */ }
```

- `primary` is the last item clicked. Single-item commands such as Inspector edits and Move XY use it.
- Keep helpers so existing code keeps working: `sel.pieces()`, `sel.points()`, `sel.segments()`.
- Store the selection with every undo step (`transact` meta). Undo and redo restore it.
- Drop selected items whose object no longer exists after an edit, and keep the rest.

### 2.3 The Select tool (V)

#### 2.3.1 Selection filter

A filter bar for the Select tool, docked at the top of the canvas or in the tool-options strip (2.10). It has toggle chips:

`Piece` · `Point` · `Grade pt` · `Curve pt` · `Segment` · `Internal` · `Notch` · `Drill/Text` · `Dart/Pleat`

- Hotkeys while Select is active: **1** = pieces only, **2** = points only, **3** = segments only, **4** = internals only, **5** = notches only, **0** = all (the default). Shift+digit toggles a single chip [P].
- Unchecked kinds get no hit test and no hover highlight.
- The filter is saved per session (settings), and the bar always shows which chips are on.

#### 2.3.2 Hit priority and ambiguity

- **Hover:** highlight the object that a click would take, in the selection colour at 50 % opacity (Optitex highlights the element red on hover [C12]). Show a tooltip with its kind and name, for example "Grade pt 7 · FRONT". AccuMark colours tooltips to match the piece colour [C9].
- **Priority** when several objects are inside the pick radius: point > notch > mark > segment / internal > piece interior. Within a kind, the nearest wins.
- **Ambiguity:**
  - Hold the button and press Space to cycle through the candidates under the cursor (Modaris [C13]).
  - Or hold the mouse still for 400 ms to get a small pop-up list of candidates (CLO [C1]). Release on an entry to pick it.
- **Pick radius:** a setting, 4–20 px, default 8 px (Modaris "click accuracy" [C13]).

#### 2.3.3 Mouse and keyboard semantics

| Input | Result |
|---|---|
| Click an object | Replace the selection with that object. It becomes `primary`. |
| Shift+click | Add the object. If it is already selected, remove it (toggle). |
| Ctrl+click | Remove the object only. |
| Click empty sheet | Clear the selection. This is the **only** gesture besides Esc that clears it. |
| Drag on empty sheet | **Window marquee** (left→right): selects objects fully inside. **Crossing marquee** (right→left, dashed outline): selects objects the box touches (AutoCAD convention [I]). Shift+drag adds, Ctrl+drag removes. The filter applies. |
| Drag starting on an object | **Also a marquee** (by default). Select never moves geometry. |
| Double-click a piece | Select all of the piece's points (the existing Ctrl+Shift+A). |
| Double-click a segment | Select the whole contour run between the neighbouring grade points. |
| Tab / Shift+Tab | Make the next / previous point along the contour `primary` and the only selected item. This is TUKA's "Previous / Next" idea [C15] applied to selection. |
| Ctrl+A | Select all of the current filter's kind (all pieces by default). |
| Ctrl+Shift+A | Select all points of the primary piece. |
| Esc | First press clears a marquee in progress. Second press clears the selection. |
| Arrow keys | Not a move in Select. **[P] decision:** arrows keep nudging the selection, as today and as in CLO [C3], but the nudge goes through the Move command and is labelled "Nudge" in the status bar. This is the one convenience exception. Remove it if the owner wants a strict Select. |
| Right-click on an object | Context menu for that object (2.9). |
| Delete | Delete the selection (asks for confirmation when pieces are included). |

#### 2.3.4 Display

- **Selected:** orange (existing). **Primary:** orange plus a thicker outline or a ring.
- **Selected segment:** a thick orange overlay along the run, and arrowheads that show the run direction.
- The Inspector shows the primary item. When several items are selected, it shows "N items" and lists the common fields.

#### 2.3.5 Status prompts (Select)

| State | Prompt |
|---|---|
| Idle, empty selection | `Select · [filter] · Click to select · Shift add · Ctrl remove · drag = box` |
| Idle, items selected | `Select · 3 points selected (FRONT) · M move · Alt+L length · right-click = menu · Esc clear` |
| Marquee | `Window select (inside only)` or `Crossing select (touching)` |

#### 2.3.6 The fast path, so Select does not feel hard-coded [P]

The owner's main complaint is that every move needs its own tool. ProwdCAD fixes this with **noun-then-verb**, without letting Select move geometry by accident:

1. Select something, then press a Modify key: **M** = Move (the right Move tool is chosen from the selection kind: point → Move Point, segment → Move Line, piece → Move Piece), **R** = Rotate, **F** = Flip, **C** = Curve tool.
2. The tool opens already holding the selection, with the input box focused. Typing `10 Tab 5 Enter` moves it by (10, 5). Right-click = OK. The tool then stays active on the same selection.
3. **Space taps** (press and release under 200 ms) while a Modify tool is active switch back to Select and keep the selection. A second tap returns to the last Modify tool. (Space held = pan, as today.)
4. **Optional setting** "Select ▸ Drag edits (single item)", default **off**. When it is on, dragging a point in Select moves **only that point**, with Move Point Single semantics (2.4), never the rest of the selection. Dragging a piece interior still does nothing unless "Drag moves pieces" is also on.

### 2.4 Move Point tool (key: M on a point selection; palette group "Point")

There is one tool with a **mode**, shown as a segmented control in the tool-options strip and cycled with **Tab** while the tool is idle. AccuMark users get one entry per mode in the Point ▸ Modify menu, so the familiar names still exist [C7][C6].

| Mode | AccuMark name | Behaviour |
|---|---|---|
| **Single** (default) | Move Single Point | Only the grabbed anchor moves. Its own Bézier handles (`hIn` / `hOut`) move with it rigidly. **Every other anchor, curve point and handle stays exactly where it is.** The two curve spans next to the anchor re-render through the new position. No other stored coordinate changes. |
| **Smooth** | Move Smooth | Two **tacks** (thumbtack icons) appear automatically on the nearest **grade points** before and after the grabbed point, and you can drag them to any other anchor on the contour [C7]. While you drag, the anchors between the tacks are redistributed with `moveProportional` (existing kernel op): the offset falls off with arc length toward each tack. Anchors outside the tacks never move. The tacks stay in place between moves until you change them or switch to Single. |
| **Horizontal / Vertical** | Move Pt Horiz / Vert | The same as Single or Smooth, with the motion locked to X or Y. **H** and **V** toggle the lock while idle. The input box shows only dX or only dY. Shift during any drag gives a temporary H / V / 45° lock (existing behaviour, and CLO [C1]). |
| **Along contour** | Move Pt Line/Slide | The point slides along its own contour, or along a line you pick with Alt-click first. The input box shows the distance along the contour (signed, + in the contour direction), and the readout gives the distances to the previous and next grade points. Uses the existing "Move along contour" command. |
| **Group delta** | Move Points | Every selected point moves by the same delta. **Only this mode moves more than one point**, and the status bar shows "Group: 5 points". |

**Steps and prompts**

| Step | What the user does | Prompt |
|---|---|---|
| 0 | The tool activates. If the selection has exactly one point (or several, in Group mode), skip to step 2 with it. | `Move Point · Single · Select point to move` |
| 1 | Click a point. It is selected and highlighted. (Smooth: the tacks appear.) | `Move Point · Smooth · Drag tacks to fix the range, or drag the point` |
| 2 | **Drag** the point, or **click-move-click** (AccuMark-style click to pick up, click to put down, chosen in settings [C7]). | `Move Point · dX 12.5  dY −3.0  L 12.85 · type a value · Shift H/V · right-click = type exact` |
| 3 | Release or the second click: preview committed as **one** undo step "Move point". The point **stays selected**. | `Move Point · Moved 12.5, −3.0 · Select next point · right-click OK = done` |
| — | Right-click with nothing pending: leave the tool and go back to Select, keeping the selection. Esc during a drag: cancel the drag and stay in the tool. Esc while idle: back to Select. | |

**Numeric input during or after a drag** (CLO's right-click-while-moving [C2], AccuMark's user input box [C7]):

- During a drag, pressing a digit, `-` or `.` freezes the mouse preview at its current delta and opens the **input HUD** next to the cursor. The fields are `dX`, `dY`, `L` (distance), `∠` (angle), and in Along-contour mode `S` (distance along the contour).
- Right-click during a drag (button still held, or between the clicks in click-move-click) opens the same HUD.
- **Tab** cycles the fields. Typing into dX / dY recomputes L / ∠, and the other way round.
- A **Rel / Abs** toggle (key **A** inside the HUD) switches between a relative delta and an absolute position (Move XY "absolute"). Absolute is in piece coordinates.
- Every length field accepts fractions and unit suffixes (existing parser). `12,5` in dX fills dX = 12 and dY = 5 when the decimal mark is "." [P].
- **Enter** = apply and stay in the tool. **Esc** = close the HUD and return to the mouse preview.
- **After** a move, pressing a digit while the moved point is still selected opens the HUD prefilled with the **last** delta. Enter applies it again to the current point. This is AccuMark's habit of reusing the last value [I].
- Keep the last values per mode for the next use (`rememberedDialog`).

**Per size**

- When the active size is not the base size, the move edits **only that size's grading delta** for the point. The world position shown in that size is what you drag, and the stored value is the grade delta. This matches today's Move XY and the README.
- The mode indicator turns **amber** and reads `Editing grading · size L` so nobody edits grading by accident.
- In Smooth mode on a non-base size, the redistribution applies to the grading deltas of the curve points between the tacks. Make sure `moveProportional` has a per-size variant, or block the mode with the message "Smooth on graded sizes: not available yet".
- An option in the tool strip: `Apply to: this size | this size and up | all sizes (same delta)` [P]. The default is "this size". The other two write the same delta into the following sizes' increments, like Grade ▸ Equal X/Y.
- In Nested view, dragging a nested-size point (the existing `hit.sizeId`) behaves as if that size were active.

**Curve neighbours: what exactly changes**

- **Single mode:** the only stored change is the grabbed anchor's `pos`. Its handles are stored relative to it, so they move rigidly. The neighbours keep their `pos`, `hIn` and `hOut`. If the anchor is smooth, its handle pair stays collinear (translating does not change that).
- **Curve points next to the anchor** keep their stored positions. Because ProwdCAD curve points carry no grading of their own (manual glossary), any graded size whose curve-point position follows the neighbours' grading will show the curve point moving in that size. That is expected. Write it in the help text so it is not reported as a bug.
- **Smooth mode:** point positions change only strictly between the tacks.

### 2.5 Move Line / Segment tool (palette group "Line")

Input: a segment (a grade segment, or a run between two selected points), or a whole internal line.

| Mode | AccuMark name | Behaviour |
|---|---|---|
| **Translate** (default) | Move Line | Both end anchors and all anchors between them move by the same delta. Neighbouring segments stretch to follow. Nothing else moves. On an internal line, the whole internal moves. |
| **Keep length** | Move Line Anchor | Tacks appear at the far ends of the two **neighbouring** segments [C7]. The segment moves, and the neighbouring segments rotate around their tacks so the segment keeps its length. It is solved as a rigid move that stays on the circles around the tacks. If no solution exists, the preview turns red. |
| **Parallel** | Move Offset / Move Parallel | The motion is locked to the segment's normal. The input box shows a single "Offset" field, positive outward. |
| **Rotate** | Rotate Line | Click the pivot (an end, or any point you snap to), then drag or type an angle. Option: keep the length (the existing Rotate segment keeping length). |

Prompts follow 2.4:

- `Move Line · Select segment (or 2 points) to move`
- `Move Line · Keep length · Drag tacks or drag line`
- `Move Line · Offset 6.0 · right-click = type exact`

### 2.6 Piece tool: Move / Rotate / Flip (palette group "Piece")

There is one tool with three modes, cycled with Tab. The modifier keys below work in every mode during a drag.

| Input | Behaviour |
|---|---|
| Drag a piece interior or its outline | Move it, with snapping: a piece point snaps to a point on another piece or to a guide. Shift locks H / V / 45°. |
| **R** during a drag | Rotate +90° around the grab point. **Shift+R** rotates −90° (Optitex rotates while dragging [C10]). |
| **Q / W** during a drag | Rotate 1° anticlockwise / clockwise. **A / S** rotate 10° anticlockwise / clockwise (Modaris [C13]). |
| **X / Y** during a drag | Flip about the vertical / horizontal axis through the grab point (Modaris symmetry keys [C13]). |
| Rotate mode | Click the pivot (default: the piece centre or the grain-line centre), then click a reference direction, then drag or type an angle. Ctrl snaps to 0°, 15°, 45° and 90°. The **Preset** option offers 90 / 180 CW or CCW applied with one click (AccuMark Rotate Piece preset [C7]). |
| Flip mode | Click a piece line or internal line to use as the mirror, or press **X** / **Y** for horizontal / vertical (AccuMark Flip about a symmetry line or in a direction [C7]). |
| Several pieces selected | All of them move together. The tool says so: "Move 3 pieces". |
| Typed value | The same HUD as 2.4: dX / dY / L / ∠ for a move, ∠ for a rotation. |
| Locked piece | Refused with the status message "FRONT is locked (Ctrl+L to unlock)". |

The layout transform changes only `piece.layout` (position and angle). Flips need a mirror flag in the layout (check the kernel `Piece.layout`), or a geometry flip committed as its own op. Confirm which one with the kernel contract.

### 2.7 Curve / Handle tool (key C; palette group "Line")

Input: a curve segment.

| Input | Behaviour |
|---|---|
| Drag a handle | Change the curvature. On a smooth anchor the opposite handle stays collinear, and Alt breaks the link (existing). |
| Drag the middle of a curve span (no handle) | Bend the span. Both end anchors stay fixed and both handles are solved (CLO Edit Curvature [C4], Richpeace "both endpoints fixed" [C18]). |
| Click a span | Add a curve point there (CLO Edit Curve Point [C5], Richpeace [C18]). |
| Delete, or right-click ▸ Remove on a curve point | Remove it, keeping the shape where possible (existing Points cleanup logic). |
| Shift+click an anchor | Corner ⇄ smooth (Richpeace Shift [C18], ProwdCAD Alt-click today). |
| Ctrl+click an anchor | Make the joint tangent-continuous (Richpeace Ctrl [C18]). |
| Readout | Live length of the span and the change from the start of the drag. Optional chord height / depth, as Richpeace Ctrl+H [C18]. |
| Typed value | The HUD offers `Length` (target arc length, using the existing segment-length solver) and `Depth` (sagitta). |

Handle editing **leaves Select**: today Select drags handles, and in the new model it does not. To keep this fast, while a curve segment is selected in Select, pressing C goes straight into this tool.

### 2.8 Selection persistence across commands

- Every command that takes a selection **keeps it**, updated with what was created. A new point is added to the selection. A deleted point is dropped.
- Menu commands use the current selection when it fits (for example Move XY on the primary point). Otherwise they use the existing `tools/pick.ts` pick session, then **put back** the selection that existed before the command.
- Switching tools never clears the selection. Only these do: Esc in Select, a click on empty sheet in Select, Ctrl+D or Edit ▸ Deselect all, and opening another file.
- Size switching (Ctrl+[ / Ctrl+]) keeps the selection, so you can step one point through the sizes while editing its grading.

### 2.9 Right-click, Esc, Enter, Backspace

| Context | Right-click | Enter | Esc | Backspace |
|---|---|---|---|---|
| A Modify tool with a pending pick or tack set-up | **OK**: accept the picks and go to the next step (AccuMark "right-click ▸ OK" [C7]) | The same as OK | Cancel the current operation and stay in the tool | Undo the last pick |
| A Modify tool during a drag | Open the numeric HUD (CLO [C2]) | Commit | Cancel the drag | Not applicable |
| A Modify tool, idle | **Finish**: back to Select, keep the selection | Repeat the last operation on the selection | Back to Select | Not applicable |
| Select, over an object | Context menu: OK-style actions for that kind (Move…, Rotate…, Length…, Corner type, Delete, Properties) | Open the Inspector field for the primary item | Clear the selection | Delete the selection (as Delete) |
| Select, empty sheet | Sheet menu: Paste, Select all, Fit, Grid, Snap settings | Not applicable | Clear the selection | Not applicable |

- **Long right-press** (over 350 ms), or **Ctrl+right-click**, in any Modify tool opens that tool's menu: OK · Cancel · Undo last pick · Mode ▸ · Options… · Help for this tool. This gives AccuMark users the menu they expect [C7][C9], and a quick right-click still means OK.
- **Middle button:** pan (existing). Optional setting "Middle click = undo last pick" (Modaris [C13]).

### 2.10 Tool-mode indicator and tool-options strip

- A thin **tool-options strip** under the menubar, as in Illustrator and AutoCAD contextual bars [I]. It shows, left to right:
  - tool icon and name
  - mode control (Single | Smooth | H | V | Along | Group)
  - per-size scope (2.4)
  - the tool's options (Keep length, Apply to…, snap toggles)
  - a **Repeat ⟳ / One-shot** toggle (Modaris safe mode [C13]: in One-shot the tool goes back to Select after one operation).
- This strip is ProwdCAD's version of the **AccuMark user input box**: one fixed place where options live [C7].
- **Cursor badge:** a small glyph next to the cursor shows the tool and mode, for example ↔1 for Move Single, ↔~ for Smooth, ↔H for horizontal, ⟲ for Rotate. The badge turns amber while grading of a non-base size is being edited.
- The active palette button stays highlighted the whole time the tool is active (Modaris "continues whilst the box is highlighted" [C13]).
- **Status bar:** the left side shows the step prompt (2.4–2.7), and the right side shows the shortcut hints `RMB OK · Esc cancel · Tab mode · ⌫ undo pick`.

### 2.11 Toolbar grouping and naming

Palette groups. The group names come from the AccuMark and Modaris menus [C7][C6][C13]. Each flyout remembers its last tool (the existing `groupTool`).

| Group | Tools (flyout order) | Default key |
|---|---|---|
| **Select** | Select (filter bar) | V |
| **Point** | Move Point (Single, Smooth, H/V, Along, Group), Align Points, Add Point, Delete Point | M on a point selection; Alt+M = Move XY dialog (existing) |
| **Line** | Move Line (Translate, Keep length, Parallel, Rotate), Curve / Handle, Smooth run, Set Length, Swap Line | M on a segment selection; C = Curve |
| **Piece** | Piece Move / Rotate / Flip, Walk | M on a piece selection; W = Walk |
| **Create** | Pen, Internal, Rectangle / Circle / Polygon, Trace | P, I, R, Shift+T |
| **Marks** | Notch, Drill, Text | N, D, T |
| **Construct** | Seam, Dart, Pleat, Fullness, Slash | S, Shift+D, Shift+L, Shift+U, K |
| **Measure / View** | Measure, Hand, Zoom | M is taken: **change Measure to Q**, or keep M for Measure and use **G** (grab) for Move [P]. Decide one and update the README. |

The **M** conflict needs a decision. Measure is M today. Options:

- (a) Move = **G**. Blender and Illustrator use G for grab [I]. The AccuMark preset still binds Alt+F12 and the others.
- (b) Measure = **Q**, Move = **M**.

**Recommendation: (a).** M is already in the manual and on muscle memory.

**Menus:** add `Point ▸ Modify Points ▸ Move Single Point / Move Smooth / Move Horizontal / Move Vertical / Move Along Line / Move Points`, `Segment ▸ Modify Line ▸ Move Line / Move Line Anchor / Move Parallel / Rotate Line` and `Piece ▸ Modify Piece ▸ Move / Rotate / Flip`. Each entry opens the one tool in the right mode. The names match AccuMark's so a search for them finds the entry [C7][C6][C8].

### 2.12 Snapping during moves

Extend `canvas/snap.ts` with:

- nearest point on a line
- midpoint
- intersection of two lines
- perpendicular foot from the start position
- the end point's projection onto a guide

Rules:

- Show the snap kind as a small glyph and label next to the cursor ("mid", "int", "perp").
- **Alt held** turns snapping off for that drag (existing Alt uses are in Select, which no longer drags).
- In Move Point the moved point never snaps to itself or to its own handles (the existing `exclude`).
- Snap targets **include other sizes** in Nested view, so you can align a size L point to the size M point.
- Optitex lets the point-location dialog measure "From snap point" [C10]. Copy this: if the drag ended on a snap, the HUD offers **"relative to snap"** as a third reference besides Rel and Abs.

---

## 2.13 More user-friendliness improvements (with their source)

1. **Live segment lengths at the cursor while a point moves.** Show the lengths of both adjacent segments and their change since the drag started (Optitex O/15 [C10]).
2. **Candidate picker for overlapping objects:** Space-cycle while the button is held (Modaris [C13]) or a hover-hold pop-up (CLO [C1]).
3. **Pick radius setting** (Modaris "click accuracy" [C13]).
4. **Hover pre-highlight** of what a click will take (Optitex [C12]).
5. **Thumbtacks** for every range-based move: Move Smooth, Keep-length line, Adjust length. You can drag them and they persist between moves (AccuMark [C7]).
6. **Constrain to the item's own slope** with Ctrl during a drag, besides Shift for H / V / 45° (CLO [C1][C2]).
7. **Rotate and flip pieces mid-drag** with R, Q / W, A / S and X / Y (Optitex O/15.3 [C10], Modaris [C13]).
8. **Enter on a hovered point opens its value box** with no click needed (Richpeace [C18]).
9. **Corner ⇄ curve point with one modifier-click** inside the Curve tool (Richpeace Shift [C18]).
10. **Select linked:** a context-menu entry "Select sewn / walked partners" (CLO Select All Sewn Ctrl+Alt+A [C2]). ProwdCAD already has walk and join data to drive it.
11. **Move only visible objects** in Group mode, so hidden sizes or pieces are never touched (Optitex O/15.5 Multi move [C10]).
12. **Repeat vs one-shot tool setting** (Modaris safe mode [C13]).
13. **Middle-click = undo last pick**, optional (Modaris [C13]).
14. **Prompt-driven multi-pick with Enter to finish**, used everywhere a list of objects is collected (Seamly2D [C22], already partly in ProwdCAD).
15. **Smooth repeats on every click:** each click on the Smooth run tool smooths a little more (AccuMark Smooth [C7]). It fits the existing `smoothRun` with a strength step.
16. **Tooltip colour = piece colour** when several pieces overlap (AccuMark PE release notes [C9]).
17. **An "AccuMark keys" shortcut preset** (1.5) plus a printable cheat sheet (F1).
18. **Per-size safety colour:** amber mode badge and status text whenever an edit writes grading instead of base geometry (prompted by AccuMark Edit Delta / Optitex Move Point Size being separate commands [C6][C11]) [P].
19. **Last-value recall:** each Move mode remembers its last typed delta, and pressing Enter with no other input applies it again (AccuMark repeat flow [C7] plus [I]).
20. **Click-move-click as an alternative to press-drag-release** (setting). It matches AccuMark's "left-click to pick, left-click to set" [C7] and is gentler on precision mice and tablets.

---

## 2.14 Acceptance checks for the developer

1. Select 5 points with a marquee, then switch to Move Point (Single) and drag one of them. **Only that point** changes. Undo restores it, and all 5 are still selected.
2. Select tool with default settings: press on a piece and move the mouse. **No geometry or layout changes.** A marquee is drawn.
3. Move Point Smooth: tacks appear on the nearest grade points. Drag the point: anchors outside the tacks are unchanged, bit for bit.
4. During a drag, type `1 1/8`, Tab, `-2`, Enter. The point moves by exactly (28.575, −2) mm in inch mode, and the tool is ready for the next point.
5. Active size L (not the base): Move Point changes only the L grading delta of that point. Every other size and the base are unchanged, and the badge is amber.
6. In a Modify tool, right-click with a pending pick = OK. Right-click while idle = back to Select with the selection kept. Esc during a drag = cancel with no undo entry.
7. Every step of every Modify tool shows a non-empty status prompt in the format of 2.4.
8. Move Line Keep length: the segment length before and after differs by less than 1e-6 mm, or the preview turns red and the commit is refused.
9. Piece drag with R pressed twice: the piece is rotated 180° about the grab point. Esc restores it.
10. After any command, `app.sel` holds the same objects, minus any that were deleted.

---

## 3. Sources

### Fetched and read (content used)

- [C1] CLO, *Select/Move Point/Segment*: https://support.clo3d.com/hc/en-us/articles/360000012828-Select-Move-Point-Segment
- [C2] CLO, *Select/Move/Transform Pattern*: https://support.clo3d.com/hc/en-us/articles/360000012128-Select-Move-Transform-Pattern
- [C3] CLO, *Edit Pattern* (older version: lasso, arrow keys 0.25, Moving Distance window): https://support.clo3d.com/hc/en-us/articles/115012380108-Edit-Pattern
- [C3b] CLO, *Transform Point/Segment*: https://support.clo3d.com/hc/en-us/articles/115004423068-Transform-Point-Segment
- [C4] CLO, *Edit Curvature*: https://support.clo3d.com/hc/en-us/articles/115012380008-Edit-Curvature
- [C5] CLO, *Edit Curve Point*: https://support.clo3d.com/hc/en-us/articles/115012226307-Edit-Curve-Point
- CLO, *2D Pattern Edit* section index (tool list only): https://support.clo3d.com/hc/en-us/sections/115000617868-2D-Pattern-Edit
- Marvelous Designer, *Select/Move Point/Segment* (same model as CLO): https://support.marvelousdesigner.com/hc/en-us/articles/47358216311193-Select-Move-Point-Segment
- [C6] AccuMark PDS shortcut list (Vietnamese; Move Single Point Alt+F12, Move Smooth Alt+F11, Move Line Ctrl+F2, Move Line Anchor Ctrl+F3, Move Piece Shift+F2, Flip Shift+F9, Rotate Shift+F10, Swap Line Alt+S, and more): https://www.congnghemay.info/2013/09/cac-phim-tat-su-dung-trong-gerber-accumark-pattern-design/
- [C7] *Hướng Dẫn Sử Dụng Lệnh Trong ACCUMARK Pattern Design* (step-by-step for Move Single Point, Move Points, Move Pt Line/Slide, Move Smooth with thumbtacks, Move Line, Move Line Anchor, Rotate Line, Adjust Length, Swap Line, Flip / Rotate Piece; right-click ▸ OK; right-hand input panel): https://www.slideshare.net/slideshow/hng-dn-s-dng-lnh-trong-accumark-pattern-design/229664201
- [C8] *Tác dụng các lệnh trong Gerber AccuMark 8.5* (Modify Point / Line / Piece glossary): https://www.slideshare.net/slideshow/tc-dng-cc-lnh-trong-gerber-accumark-85-229702895/229702895
- [C9] AccuMark PE release notice (snap to geometry under Move Smooth Point; Swap Line; Move Line Anchor thumbtacks; tooltip colour; "Press right mouse button or cancel functions"): https://help.pacisoft.com/wp-content/uploads/2019/10/relnot_PE.pdf, and AccuMark V16.1 What's New ("Press OK to continue", Ctrl / Shift multi-selection, Click n Go): https://www.lectra.com/sites/default/files/2023-11/AccuMark-V16.1-WhatsNew_PE-en.pdf
- [C10] Optitex 15.5 new-features list (live segment length next to the cursor in Move Point; flip and rotate pieces while dragging; "From snap point"; Multi move visible only): https://detmayfashion.blogspot.com/2016/03/optitex-155551-new-features.html
- [C12] OptiTex PDS training syllabus (Select tool via END key or right-click; red hover highlight; Space moves a piece; Ctrl+Space moves an internal): https://pdfcoffee.com/optitex-pds-basic-and-technical-designertraining-syllabus-pdf-free.html
- [C13] *Digital Pattern Cutting for Fashion with Lectra Modaris* (preview PDF: F1–F8 groups, F3 = Re-shape / Move / Stretch / Pin, Selection safe mode, mouse buttons, value arrows): https://api.pageplace.de/preview/DT0400.9781350065130_A40046587/preview-9781350065130_A40046587.pdf, and the Lectra Modaris manual V8R1 (click accuracy, Ctrl angle snap, Q / W / A / S rotation, X / Y symmetry, Space cycles ambiguous picks, Esc quits): https://pdfcoffee.com/lectramodaris-manual-v8r1-pdf-free.html
- [C14] Style3D Studio, *Edit Pattern*: https://help.style3d.com/studio/en/c2c8/5869/fc7e
- [C15] Tukatech Academy, *Getting Started with TUKAcad* (course outline: Status Bar, How to Use Tools, Previous / Next / Clockwise, Movement): https://academy.tukatech.com/p/getting-started-with-tukacad
- [C16] University of Fashion, *Operating TUKAdesign #3* (outline: Right Mouse Click Option, Movement, Points): https://www.universityoffashion.com/lessons/operating-tukadesign-2/
- [C17] *TukaTech software overview* (Scribd: "point on, move point, move proportional, move parallel"): https://www.scribd.com/document/56004764/tuka-tek-1
- [C18] Richpeace DGS + GMS manual V8 / V9 (Intelligent Pen F, Modify A, Enter = value dialog, Shift / Ctrl on points, proportional and parallel move): https://pdfcoffee.com/richpeace-dgsgms-manualv8v9-pdf-free.html
- [C19] Seamly forum, *Feature request: "Modify point" tool in Detail mode*: https://forum.seamly.io/t/feature-request-modify-point-tool-in-detail-mode/693
- [C20] Seamly forum, *Move a point*: https://forum.seamly.io/t/move-a-point/3107
- [C21] Seamly wiki, *UserManual:Tools:Operations*: https://wiki.seamly.io/wiki/UserManual:Tools:Operations
- [C22] Seamly forum, *How to move, rotate or pivot point or line*: https://forum.seamly.io/t/how-to-move-rotate-or-pivot-point-or-line/3413
- Textile Learner, *Pattern digitizing by Gerber AccuMark* (digitizer buttons only; little used): https://textilelearner.net/pattern-digitizing-by-gerber-accumark-software/

### Seen in search results only (the page could not be fetched)

The official Gerber / Lectra AccuMark help blocks automated fetching (robots, and the proxy refused the host). The Optitex help redirects to a login page. The titles still confirm the tool names used above.

- [C11] Optitex help titles: Move Point Tool https://help.optitex.com/1382687/Content/Optitex_2D/Move_Point_Tool.htm · Move Points Tool https://help.optitex.com/1382687/Content/Optitex_2D/Move_Points_Tool.htm · Move Points Proportionally Tool https://help.optitex.com/1382687/Content/Optitex_2D/Move_Points_Proportionally_Tool.htm · Move Points In Parallel Tool https://help.optitex.com/1382687/Content/Optitex_2D/Move_Points_In_Parallel_Tool.htm · Move Point Along Contour https://help.optitex.com/1382687/Content/Optitex_2D/Move_Point_Along_Contour_Tool.htm · Multi Move Tool https://help.optitex.com/1382687/Content/Optitex_2D/Multi_Move_Tool.htm · Move Point Size https://help.optitex.com/1382687/Content/Optitex_2D/Move_Point_Size.htm · Move Size Proportional https://help.optitex.com/1382687/Content/Optitex_2D/Move_Size_Proportional.htm · Smooth Tool https://help.optitex.com/1382687/Content/Optitex_2D/Smooth_Tool.htm · Toolbox: Movement https://help.optitex.com/1382687/Content/Optitex_2D/Toolbox_Movement.htm · Edit Toolbar https://help.optitex.com/1382687/Content/Optitex_2D/Intro_to_PDS/Interface/Edit_Menu_(Edit_toolbar).htm · Using the Drag Option https://help.optitex.com/Optitex_2D/Using_the_Drag_Option.htm
- AccuMark help titles: Point https://help.gerbertechnology.com/AccuMark/PDS/Function_Point.htm · Point Actions Group (Modify) https://help.gerbertechnology.com/AccuMark/PDS/Group_Point_Actions_Tab_Modify.htm · Single Point https://gerber-help.lectra.com/AccuMark/PDS/Function_Single%20Point.htm · Smooth https://help.gerbertechnology.com/AccuMark/PDS/Function_Smooth.htm · Smooth/Line https://gerber-help.lectra.com/AccuMark/PDS/Function_SmoothLine.htm · Point/Line https://help.gerbertechnology.com/AccuMark/PDS/Function_PointLine.htm · Move Line http://help.gerbertechnology.com/AccuMark/PDS/Actions_Line_Line.htm · Move Piece https://help.gerbertechnology.com/AccuMark/PDS/Actions_Piece_Move.htm · Swap Line https://help.gerbertechnology.com/AccuMark/PDS/Actions_Line_Swap.htm · Walk Pieces https://help.gerbertechnology.com/AccuMark/PDS/Function_Walk_Pieces.htm · Pattern Design 2D Getting Started https://help.gerbertechnology.com/AccuMark_3D/Pattern_Design_2D/Getting_Started_with_2D.htm
- YouTube, *Pattern Design Tip of the Day – Line Options in Move Smooth Line*: https://www.youtube.com/watch?v=zdE4gPx-bbU
- Modaris books: https://vdoc.pub/documents/pattern-cutting-for-clothing-using-cad-how-to-use-lectra-modaris-pattern-cutting-software-1bh5c02hsdb8 (redirected) · https://www.oreilly.com/library/view/pattern-cutting-for/9780857092311/xhtml/B9780857092311500066.htm (table of contents only: sections 6.4 "F3: modifying lines and points", 13.8 "Move", 13.10 "Select or choose")
- StyleCAD V7 PDS manual (Scribd, needs JavaScript, not read): https://www.scribd.com/document/654877124/StyleCAD-V7-PDS-Manual

No usable public manual was found for Gemini Pattern Editor or Audaces.

### What is inferred, not cited (check with the owner)

- That AccuMark's right-click menu contains Undo besides OK and Cancel, and that AccuMark shows a prompt line at the bottom of the screen.
- The TUKAcad specifics: right-click ends a function, the user-input dialog, and verb-then-noun order. Only the tool names and training topics are cited.
- That AccuMark reuses the last typed value.
- Window-vs-crossing marquee, G = grab, and the contextual options bar. These are general CAD and graphics conventions (AutoCAD, Blender, Illustrator), not apparel-CAD sources.
- Which browser keys can be intercepted (Chrome / Edge behaviour, from general knowledge).
