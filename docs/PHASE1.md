# ProwdCAD v2 — Phase 1 report (kernel + design workspace + DXF/PDF)

Branch `v2`. Legacy single-file app `prowdcad.html` is untouched and still runs.

## Layout
```
packages/kernel   pure TypeScript geometry/document engine, no DOM — vitest (22 files, 253+ tests)
apps/web          SVG design workspace (Vite + TS, no framework), imports the kernel directly
docs/             KERNEL-CONTRACT.md · FILE-FORMATS.md · PHASE1-AUDIT.md (independent audit + fix log)
```
Run: `npm install && npm run dev` (workspace at the Vite URL) · `npm test` (kernel) · `npm run build`.

## Implemented (Part A — industrial parity, Phase-1 scope A1–A8 + IO)
**Architecture (§0)** mm float64 kernel; y-up frame; mm/cm/inch display with fraction input everywhere (`1.125 ≡ 1 1/8 ≡ 1.1/8`); snapshot undo/redo (200 steps, nested transactions = one step); 30 s auto-backup to localStorage with crash-recovery prompt; documented JSON native format `prowdcad/2` with validation + migration (legacy `.wptn` migrates).

**A1 Data model** sew-line-first dual contour (cut line always derived, never stored); grade vs curve points; centripetal Catmull-Rom α=0.5 defaults with explicit Bézier handle overrides, every span a cubic under the hood; start point; relative handles that travel with anchors; half pieces (live mirror on resolve, fold edge seam 0, `openAtOutput`); Reference Block snapshot/show/restore; Point Connections (global check/clear, intersection points added); lock piece; save/restore layout; piece versioning (`_#` suffix, Replace Old / Save Active As New, archive); merge from another style with size mapping.

**A2 Seams** per-segment values (± out/in), whole-piece, global; corner gallery miter/boxed/turnback/angled/manual (≤10 pts) + two-click trim; Lock Grading stamps base corner geometry onto every size; seam⇄internal both ways with seam inference; delete/remove/repair; true offset with miter/bevel and self-intersection cleanup (vanishing offsets → empty, narrow gaps filled, acute spikes keep full distance).

**A3 Live objects** darts (create, Fix Dart, pivot transfer by %, rotate-around-offset-centre, close/reopen, cutting + Cut All, change darts, copy/paste, remove-keep-fullness, multi darts, insert dart; cut line consumes dart caps); pleats (box/knife, tapered depth, open/close non-destructive, multi, axis-first, by angle, auto notches); fullness (rotate/parallel, multi with first/last widths, delete = exact restore; LIFO stack with pleats).

**A4 Walk** two-piece walk state machine, step/walkTo/flip, skip darts, walk ratio, drop notches both/stationary/moving, running Δ; UI tool with live moving-piece render and HUD.

**A5 Drafting** draft/pen, internal pen (CLO behaviour, manual double-click, outline snap ring, exact length/mirror on right-click), shapes, trace segments, build piece (planar region), join pieces, fold in/out (+symmetry check), slash/cut along internal/H-V/parallel/by guideline with zero-or-auto grade and seam prompt and `_1/_2` renaming, parallels + extend, arc/wave/scallop (auto-solve, partials, zigzag)/ruffle/circular skirt, point ops (add/move/along/proportional/multi-move/align/set-angle/round-corner/spline support/cleanup/start point), segment ops (set exact length with curve-blend/½H/½V/½diag, copy/paste modes, rotate preserving length, swap, divide/join, dashed, trim, global trim/join, extend), smooth tool (LSQ cubic through kept anchors), grain ops.

**A6 Notches etc.** anchored / from-prev / from-next / proportional-% notches with per-size grids (fill, extrapolate, TSV paste); slit/T/V/U/castle, draw/cut setup, corner and cross notches, Add Points for Notches, global notch grading; drills/buttons (duplicate, multi between refs, slit-contour-segment); text with min/max print size; artwork with true dimensions → placement rectangle; binding generator (chained segments across pieces, bias angle, shrink/scale, notch copy, half-fold, support notches).

**A7 Grading** size line editor (insert/append/remove/rename/set base, half-size auto-interpolation), two-axis variation tables (`grade2`, combined on request), grading table incremental⇄absolute, point tracking, drag-grade nested sizes, copy/paste/X-only/Y-only/Smart Paste/Paste Around/flip/equal/delete, stack point & along line, angle grading with auto-aim, grade parallel (adjust last, X/Y only, preserve length), grade proportionally, rule libraries (from values/point/contour, apply by number/name, on-canvas names, load sizes), graded nest (reverse grading), export size as standalone, delete invisible/ungraded, movement programs (bridge to MTM; curve points follow).

**A8 Measure & QA** measure tool (segment/XY/D/angle + per-size dX/dY), Compare Length window (+/−, four modes, edit-to-target), walking check + notch-mismatch report, Scale & Shrink (%/abs/inc, grading nest/base, seam, stamp, proportional-to-100).

**IO (C5 Phase-1 part)** DXF/AAMA/ASTM import (tolerant, layer-mapped, report, `.rul`, nested-size merge) + export (both flavours, `.rul`, graded nest, per-size notch rules); SVG in/out; PLT/HPGL in/out with device profiles; tiled 1:1 PDF (A4/Letter/A0/custom, registration crosses, glue overlap, labels, calibration square).

**A10 UI rules** manual double-click detection, no auto-pan (pointer capture + infinite sheet), large invisible hit targets, in-app dialogs only, guarded localStorage, no runtime CDN, every command keyed, customizable hotkeys + toolbar. All 243 kernel ops are wired; `Help ▸ Kernel ops status` lists them.

## Acceptance tests (D)
D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D16 — all implemented as vitest tests and independently re-derived with fresh shapes by a reviewer who had not seen the code (see `docs/PHASE1-AUDIT.md`: initial 7/12 clean, the rest fixed in the fix log). D12–D15 belong to the marker module (Phase 3).

## Stubbed / deferred
- A9 reports (Pattern Card, Measurement Chart, Summary, Piece List Excel, preview thumbnail is done) — Phase 2.
- Digitizer input, plotter/cutter drivers — Phase 5 (Tauri).
- SVG `<use>` not expanded; DXF fit-point-only splines treated as curve points; HPGL `SC` ignored (all reported in the import report).
- PDF writer is uncompressed, Helvetica only (non-ASCII → `?`).
- Walk-dropped notches in non-active sizes are placed at the same proportional position (not re-walked per size).

## Assumptions (Gerber/TUKA-standard choices where the spec was silent)
- Incremental grading convention: `inc[size_i] = abs[size_i] − abs[size_{i−1}]`, `abs[base] = 0`; curve points without own grading interpolate proportionally between neighbouring grade points.
- Undo is snapshot-based (not inverse commands).
- Auto Reseam off never caches a stale cut line; it only defers Lock-Grading snapshots/self-heal to the manual Reseam commands.
- Boxed corner default extends both sides; turnback picks the hem side by larger seam; manual corner points stored base-size and moved with the corner.
- Knife pleat inserts 2×depth, box 4×depth; dart width = chord across opening; default drill offset 12 mm.
- Walk transform aligns the moving contact to the stationary one with direction taken 1 mm ahead.
- Scale: X across grain, Y along grain, about the base bbox centre in the grain frame.
- DXF: notch lines anchored from-prev on the nearest sew segment; rule numbers as `# n` texts on vertices; files with no units and extent < 100 read as inches; corner threshold 25°.
- Piece placement on the sheet is `piece.layout`; editing happens in piece coordinates.
