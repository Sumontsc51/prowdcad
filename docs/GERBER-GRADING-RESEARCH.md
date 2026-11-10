# Gerber AccuMark grading and Measure Line: research notes and the ProwdCAD design

Date: 2026-11-10. Owner's requests (an AccuMark expert):

3. Measure Line like AccuMark: pick any line (one segment between grade or cut points). Every line is summed until right-click OK / Cancel (L1 + L2 + L3 = total), in a table with all sizes.
4. Clicking a line on another piece while a measurement is open starts a comparison between them, with all sizes in a table.
5. All sizes as ROWS, because a style can have 1 to 80 sizes.
6. Grading the Gerber way, but friendlier, so ProwdCAD feels like its own tool.

Tags: **[S#]** = read in the source listed in §4. **[I]** = inferred (from general AccuMark knowledge or the wording of a source). Check the [I] items with the owner.

## 1. What AccuMark does

### 1.1 Rule tables, rule numbers, base size, size breaks

- **Rule table.** You create one with *New ▸ Rule Table…*. Its fields are *Size Names* (AlphaNumeric or Numeric), *Base size*, *Smallest Size* and *Next Size Breaks*: the sizes that follow the smallest one, base included. It is saved as a file [S1][S2]. It is then attached to pieces with *Grade ▸ Assign Rule Table* [S1].
- **Rule numbers on points.** You build a rule table and then "assign table and rule numbers" to the points of a pattern, which produces the graded nest [S3]. One documented scheme numbers points per garment and piece (e.g. pants 3##, front #1##); every critical point gets an X and Y rule value [S4].
- **Grading increments** are the difference in body measurement between adjacent size breaks. For example, a 1" waist change between breaks is split ÷ 4 = 0.25" per point on the Y axis [S4].
- **Size breaks** can be edited afterwards with *Edit Size Breaks* (*Add Break*, *Delete Break*). Related commands: *Copy Size Line* and *Change Base Size* [S2].
- **Display.** *View ▸ Grade ▸ Show All Sizes* (Ctrl+G), *Show Selected Sizes*, *Show Regular/Break Sizes* ("the sizes defined in the grade rule table, including break sizes"), *Stack On/Off*, *Clear Nest* [S5].
- **Grade Options…** chooses the grading method. The sources name the dialog but not its options [S2][S5]. **[I]** It holds the incremental / relative choice and the small / regular / large break handling.
- **Small / regular / large breaks.** No source that could be read describes them. **[I]** AccuMark rule tables can carry different values for small, regular and large ranges of a size line, which change at break sizes. ProwdCAD models this with per-size steps plus size breaks (Split by break).

### 1.2 Editing grading

- **Edit Delta.** Select a piece and a grade point and type the step in *Clear X / Clear Y*. *Next* / *Previous* walk the grade points clockwise. *Update* carries the first size's increment down to the sizes below. **Maintain Growths**, when ticked, means "changing the grade step in the middle sizes won't affect the others" [S2][S6].
- **Copy Grade Rule** copies from a graded point to an ungraded one, with X-only and Y-only variants. **Flip X Rule / Flip Y Rule** mirror a rule. **Change Grd Rule** with −1 removes a point's grading. **Add Grade Point** on a graded piece grades the new point from the two ends of its line [S2][S6].
- **Incremental / relative.** In a related PLM grade-rule editor, a uniform increment stops being "relative or incremental" as soon as one size is edited by hand, so the increment field is cleared [S7]. **[I]** AccuMark makes the same distinction between incremental tables (each break holds the step) and relative tables (each break holds the offset from the base).
- **[I]** In AccuMark rule tables, sizes smaller than the base usually carry their own negative step (the movement away from the base). The base row is 0 0.
- **Create / Modify Rule, Copy Table Rule, Edit Rule Delta, Create Delta, Grade Reference.** These names come from the owner and from AccuMark menu lists. No readable source described them in detail. **[I]** Create / Modify Rule edits a rule's values in the table, and every point that uses the rule follows. Copy Table Rule duplicates a rule under a new number. Grade Reference sets the point the nest is stacked on. ProwdCAD already has that as *Stack point / along line*.

### 1.3 Measure

- **Measure ▸ Line Length**: select the lines to measure, right-click OK, then right-click OK again [S2][S6].
- **Measure ▸ Line** (used while grading): select a line, right-click OK, and it is measured across all sizes [S2][S6].
- Also listed: *Distance 2 Line*, *Perimeter 2 Pt / Measure Along Piece*, *Angle* [S2]. *Match Line X / Y* changes one line's coordinate so its length matches another line, e.g. a sleeve to the bodice armhole [S6].
- **[I]** AccuMark shows the result in a measurement table with one row per size. Comparing two lines is done by measuring both and subtracting. The owner's request 4 asks for that comparison to be built in.

## 2. What ProwdCAD implements, and the twists

| AccuMark | ProwdCAD | Twist |
|---|---|---|
| Measure ▸ Line Length / Line, right-click OK | **Measure tool, Line mode** (M): click lines, labelled L1, L2, … on the sheet; right-click / Enter = OK, Esc = cancel | Hover preview with the length. Click again = remove. Backspace = last one off. Shift+click extends the run. Alt = cut line. Nested-view outlines of other sizes can be picked |
| Measurement table | **Measure window**: rows = all sizes (80 fine), columns L1 … Σ and Δ prev | Copy TSV for Excel. Kept measurements list (rename, reopen, Grade to spec) |
| Measure two lines and subtract by hand | Clicking a line on **another piece** (or Ctrl+click) starts group B: Σ A, Σ B, B − A (or A − B) | Target ease ± tolerance colours each size row pass / fail |
| Rule table with Size Names / Base / Smallest / Next Size Breaks | Rule library = rule table for a size line. Breaks are the ◆ gutter of a size row (`style.meta.sizeBreaks`) | Breaks are optional. Smart fill ▸ *Split by break* uses them |
| Rule values per break, incremental vs relative | Two views on every table: **Step into this size** / **Total from base size**. Steps use the AccuMark convention: smaller sizes carry their own step away from the base | Plain-language headers. The rows an edit moves are tinted (incremental edits ripple outward, total edits do not). *Edit L only* switches to the total view for one cell |
| Edit Delta + Maintain Growths | Grading table, rows = sizes. Step view = an incremental edit; total view = Maintain Growths | Excel paste into consecutive sizes. Arrows / Enter / Tab. Fractions |
| Update (carry the first increment down) | **Smart fill**: Equal steps / Interpolate / Repeat step / Split by break, from the rows you typed (marked with a dot) | A side of the base without typed rows keeps its values |
| Assign rule number to a point | Rule **chips**: drag onto a point, double-click = apply to the selection, or select points and **type the number** + Enter | — |
| Show Rule ID | **Rule badges** on every grade point; colour = follows rule / locally edited (`n*`) / own grading / ungraded | A grading-table edit keeps the link, so a hand edit shows as amber instead of disappearing silently |
| Create / Modify Rule, Copy Table Rule | + Rule, From values / point / contour; edit in the rule table (linked points follow); Copy rule (flip X / Y); Rename / renumber; Delete (values kept, links dropped) | Live nest preview of the rule's path while typing |
| Copy / Flip Grade Rule (X, Y) | Kept: Copy / Paste / X only / Y only / Smart paste (mirror-aware) / Flip X / Y | — |
| (no equivalent found) | **Grade by measurement**: a Measure group + the points that move + a spec column → the per-size movement is solved so the measurement hits the spec; the residual is shown per size | Exact (± 0.01 mm) on straight segments; curves report the residual; the base size is never changed and its residual flags a base pattern that is off spec |
| Show All Sizes / Regular / Break sizes | Nested view (Alt+N); the Measure window and every table cover all sizes | Nest preview strip next to the grading table |

## 3. Kernel functions (packages/kernel)

- `ops/measure.ts`: `MeasurePart`, `cutPolyline` (cut-line run between the cut corners of two sew grade points, from `cutLineForSize().cornerIndex`), `measurePart`, `matchingSize` (by size id, else by size name), `measureGroup` (rows = sizes, parts and Σ), `compareGroups` (Σ per group, diff vs group 0), `gradeByMeasurement`. The last one runs one bracket-plus-bisection root find per size on a scratch copy. Each size is an absolute edit, so sizes stay independent. Implicit curve points used as movers are made explicit first. It is one undo step and drops the rule links of the moved points.
- `ops/rules.ts`: `outwardSteps` / `totalsFromSteps` (the AccuMark step convention ⇄ totals), `affectedSizes`, `smartFill`, `sizeBreaks` / `setSizeBreaks`, `setRuleValues` (Modify Rule + `refreshRuleLinks`), `copyRule`, `renameRule`, `deleteRule`, `gradeStatus`.
- Tests: `test/measure-grade.test.ts`. L1 + L2 + L3 against the hand calculation (straight and diagonal edges), cut-line parts, comparisons across two pieces, pieces with a size subset, the grade-by-measurement solver (< 0.01 mm on straight segments, preview without a write, undo, residuals on curves, implicit curve movers), steps ⇄ totals, every Smart fill method, breaks, rule edit / copy / rename / delete, badge status.

## 4. Sources

Read (content used):

- [S1] *Tạo Bảng Size Trong Gerber Accumark* (CongNgheMay.info, 2013): rule table fields (Size Names, Base size, Smallest Size, Next Size Breaks) and Assign Rule Table. http://www.congnghemay.info/2013/08/tao-bang-size-trong-gerber-accumark/
- [S2] *ACCUMARK PATTERN DESIGN — tra cứu lệnh Gerber Accumark* (SlideShare): rule table setup, Edit Size Breaks (Add / Delete Break), Copy Size Line, Change Base Size, Edit Delta with Maintain Growths / Clear X / Clear Y / Next / Previous / Update, Copy / Flip Grade Rule, Change Grd Rule −1, Measure ▸ Line Length and Measure ▸ Line, Distance 2 Line, Perimeter 2 Pt, Angle, Grade Options. https://www.slideshare.net/slideshow/gerber-accumark-pds-tra-cu-lnh-gerber-accumark/229559419
- [S3] *Pattern Grading* (Scribd summary): grade rule table in Cartesian coordinates; assign table and rule numbers to patterns in PDS. https://www.scribd.com/document/151492294/Pattern-Grading
- [S4] JTATM Vol. 7 Issue 4 (2012), AccuMark made-to-measure study: size breaks, increments between adjacent breaks, X / Y rule values per point, point-numbering scheme, alteration rules. https://jtatm.textiles.ncsu.edu/index.php/JTATM/article/download/2465/1789/14073
- [S5] Same SlideShare, second part: View ▸ Grade (Show All Sizes, Show Selected Sizes, Show Regular/Break Sizes, Stack On/Off, Clear Nest, Grade Options). Same URL as [S2], offset 100000.
- [S6] *Tài liệu AccuMark V8.1 Nhà Bè* (SlideShare): Edit Delta / Maintain Growths, Copy Grade Rule (X / Y), Flip X / Y Rule, Measure ▸ Line Length, Measure ▸ Line across all sizes, Match Line X / Y. https://www.slideshare.net/slideshow/ti-liu-accumark-v81-nh-b/229702367
- [S7] PTC FlexPLM Help, *Grade Rules* tab of the measurements editor (incremental / relative grade rules lose their increment when edited by hand). https://support.ptc.com/help/windchill/Windchill-FHC/en/FlexPLM_Help_Center/MeasurementsEditorWorkTableEditorGradeRules.html
- AccuMark v16.0 What's New PE (multi-dimensional grade, size codes, Show Altered Sizes; no rule-table details). https://go.lectra.com/rs/448-ANF-726/images/AccuMark-v16.0-WhatsNew_PE-en.pdf

Seen but not usable:

- Gerber / Lectra AccuMark online help (*Modify Size Line*): https://help.gerbertechnology.com/AccuMark/PDS/Function_Modify_Size_Line.htm. Blocked for automated readers (robots); not read.
- Optitex *Grading Table* help: https://help.optitex.com/1382687/Content/Optitex_2D/Grading_Table.htm. Redirects to a login.
- Minerva Patterns, *Gerber AccuMark: a practical overview*: general only, no rule-table details. https://minervapatterns.com/blog/gerber-accumark-a-practical-overview-for-pattern-makers
- Fashion-Incubator, *Grading management pt. 1*: plans for a series and comments on size breaks; no CAD specifics. https://fashion-incubator.com/grading_management_pt1/
- PDS 2000 user guide (Scribd landing page only): https://www.scribd.com/document/122925259/Pds-2000-User-Guide

## 5. Open questions for the owner

1. The step convention for sizes below the base. ProwdCAD shows the step away from the base (S = −12.5 when M → L = +12.5). Is that how your AccuMark rule tables read?
2. Should *Split by break* treat a value typed at a break as the total change over the range (current behaviour in the step view) or as the per-size step from that break on?
3. Should the measurement history be saved with the style (now it lasts for the session only)? Should a kept measurement update live when the pattern changes (it does: rows are recomputed on every render)?
4. AccuMark's small / regular / large breaks: do you want separate value sets per range, beyond size breaks and per-size steps?
