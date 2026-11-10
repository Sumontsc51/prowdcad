# ProwdCAD

Professional 2D apparel pattern-design + grading (+ marker-making, Phase 3) CAD.

**v2 (this branch):** TypeScript kernel (`packages/kernel`, unit-tested in Node) + SVG design workspace (`apps/web`).
See `docs/PHASE1.md` for what is implemented, `docs/KERNEL-CONTRACT.md` for the model, `docs/FILE-FORMATS.md` for files.

```
npm install
npm run dev      # design workspace (Vite)
npm test         # kernel test suite
npm run build    # production build → apps/web/dist
```

---

## Legacy v1 (single file)

 PRO

Browser-based 2D apparel CAD for pattern making, made-to-measure alteration and marker making. Single-file HTML app, no build step, no server.

**Current version:** v2.1 PRO (branch `v2`). v1.10.0 remains on `main`.

## Run

Open `prowdcad.html` in Chrome or Edge.

## What's new in 2.0 PRO (modelled on the TUKAdesign feature set)

| Area | Feature |
|---|---|
| Edit | Undo / Redo (Ctrl+Z / Ctrl+Y), copy/paste piece, select all, rectangle-select points |
| Measurement Chart (Shift+M) | TUKA-style `/m` `/q` point names, Measure tool (D / X / Y / contour), named sums across pieces, targets, tolerance, pass/fail, CSV |
| Point tools | Move Point (Q), Move Points by area (Ctrl+Shift+U in TUKA layout), point names (F2) |
| Alteration | Program by area (Shift+R) = Movement Programs; Auto-alter solves all programmed measurements to the order targets |
| Order | Import Neems Pattern Sheet Excel (targets, warp/weft shrink, fabric width) → Auto-alter → Postshrink → Marker in one click; export bundle |
| Piece | Scale & Shrink (Shift+Enter, proportional-to-100%), flip H/V, rotate 90°, rotate to grain, piece info |
| Import | AAMA/ASTM DXF with BLOCK-per-piece (TUKAcad, Gerber, Lectra, Optitex): names, qty, grain, notches, internals, turn/curve points, sew line → seam allowance |
| Marker | Grain-aligned bottom-left auto-nest, PLT/HPGL export, plot DXF |
| Keyboard | ProwdCAD layout or TUKAdesign layout (Tools › Keyboard) |

## Pattern-making tools (2.1)

| Tool | ProwdCAD key | TUKA layout | What it does |
|---|---|---|---|
| Draft | D | D | Draft a new piece point by point (Tab = exact length/angle); start inside a piece = internal line |
| Add Point | A | A | Insert a grade point without changing the curve; Shift = exact distance |
| Segment Length | Ctrl+Enter | Ctrl+Enter | New length with Curve / 1-2 Horizontal / Vertical / Diagonal methods |
| Compare Length | Ctrl+M | Ctrl+M | Add / subtract segments, live difference |
| Seam | E | S | Width per segment, corners: miter, square, mirror (hem fold), bevel |
| Notch / Drill | N / B | N / B | Slit, V, T, castle notches on the cut line; drill holes (DXF layer 13) |
| Cut piece | X | X | Split along a line between two outline points |
| Join pieces | J | J | Rotate piece 2 onto piece 1's edge and merge |
| Fullness | F | U | Slash & spread: parallel, pivot or both ends |
| Dart | Ctrl+D | Ctrl+D | Dart with calculated cap, leg lines, notches, drill |
| Round Corner | O | Shift+R | True circular arc |
| Create Parallel | H | C | Internal line(s) parallel to a segment |
| Align Points | I | I | Same X, same Y, or onto a line |

## Made-to-measure workflow

1. Import the closest-fit base pattern (DXF-AAMA from TUKAcad), or open a `.wptn`.
2. Once per base pattern: name the measurement points (`01 High Waist/m/q2`, …) or add measurements with the Measure tool, then set alteration rules with **Program by area**. Use the same names as the order Excel.
3. Save as `.wptn`. That's your reusable MTM block.
4. For each order: **Order › Import order Excel** → **Run order chain**, then check and fine-tune and **Export order bundle**.

## Tests

```
pip install playwright && python -m playwright install chromium
python test/e2e.py path/to/order.xlsx     # alter / shrink / nest / DXF / PLT
python test/ui.py                         # mouse + keyboard tools
python test/pattern_tools.py              # 16 geometry checks for the pattern tools
```

## Structure

Everything lives in `prowdcad.html`. External: jsPDF (PDF export) and SheetJS (Excel import) from cdnjs.

## License

Proprietary — © ProwdStudio. All rights reserved.
