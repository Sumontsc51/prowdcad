# ProwdCAD

Browser-based 2D apparel pattern-making and marker-making CAD. Single-file HTML app — no build step, no server.

**Current version:** v1.10.0

## Run

Open `prowdcad.html` in a modern browser (Chrome/Edge recommended). That's it.

## Features

- **Drawing** — Bézier pen tools (standard and Curvature / Illustrator-style), shape tools with flyout groups, SMOOTH tool
- **Line styles** — four-type system: Perimeter, Internal, Grain, Seam
- **Internals** — CLO-style internal polygon / line flow
- **Import** — DXF (AAMA / ASTM), PLT / HPGL, SVG
- **Export** — PDF output via jsPDF

## Structure

Everything lives in `prowdcad.html`: styles, markup and application logic in one document. External dependency is jsPDF, loaded from CDN.

## License

Proprietary — © ProwdStudio. All rights reserved.
