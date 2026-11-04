# ProwdCAD file formats

Kernel module: `packages/kernel/src/io/` (`native.ts`, `dxf.ts`, `svg.ts`, `plt.ts`, `pdf.ts`, shared helpers in `common.ts`).
All importers return an `ImportReport`. All exporters work from a `Document` and write at 1:1 scale.

## 1. Native format: `prowdcad/2` JSON

| | |
|---|---|
| Extension | `.prowd` (`NATIVE_EXTENSION`) |
| MIME | `application/vnd.prowdcad+json` |
| Encoding | UTF-8 JSON. The root object is the kernel `Style` (`packages/kernel/src/model/types.ts`) |
| API | `saveNative(docOrStyle, {pretty?})`, `loadNative(jsonOrObject) → {style, migratedFrom?, warnings}`, `openNative()`, `validateStyle()`, `registerMigration({from,to,migrate})` |

### Conventions

* **Units:** every length is a float64 in **millimetres**. `Style.units` (`mm`/`cm`/`in`) only sets how lengths are displayed.
* **Frame:** **y points up** (mathematical frame), the same as DXF and HPGL. SVG and the legacy `.wptn` are y-down, so their importers negate y.
* **Base size plus increments:** each graded entity stores its **base-size** coordinates plus `grade: Record<SizeId, {dx,dy}>`. Each value is the **incremental** step `inc[size_i] = abs[size_i] − abs[size_{i−1}]`, taken in size-line order, with `abs[base] = 0`. A missing entry counts as `{0,0}`. Curve anchors with an empty `grade` are graded in proportion between the grade anchors on either side of them.
* **Piece master:** `piece.sew` is the master. The cut line is derived from it with `seamDefault` and the per-segment `Anchor.seamAfter`, unless `cutMode:'manual'` (then `manualCut` is used) or `noSeam:true` (then cut = sew).
* **Live objects:** darts, pleats and notches point at anchor **ids**. Ids must be unique inside a piece, and the validator checks this.
* **Handles:** `hIn`/`hOut` are **relative** offsets. When a handle is absent, centripetal Catmull-Rom supplies the tangent.

### Top-level shape (abridged)

```jsonc
{
  "schema": "prowdcad/2", "id": "…", "name": "Style", "units": "mm", "fractionDenominator": 8,
  "sizeTables": [{ "id": "st…", "name": "Default", "axis1": { "id": "sl…", "name": "Sizes", "baseSizeId": "s…", "sizes": [{ "id": "s…", "name": "S" }, …] } }],
  "activeSizeTableId": "st…",
  "pieces": [{
    "id": "pc…", "name": "FRONT", "sizeTableId": "st…",
    "sew": { "id": "c…", "type": "perimeter", "closed": true,
             "points": [{ "id": "p…", "x": 0, "y": 0, "kind": "grade", "smooth": false, "grade": { "s…": { "dx": 10, "dy": 0 } }, "seamAfter": 20, "flags": {} }, …] },
    "seamDefault": 10, "noSeam": false, "cutMode": "auto", "manualCut": null,
    "internals": [], "darts": [], "pleats": [],
    "notches": [{ "id": "n…", "contourId": "c…", "type": "slit", "depth": 5, "width": 0, "angleDeg": 0,
                  "placement": { "kind": "fromPrev", "anchorId": "p…", "dist": { "s…": 80 } } }],
    "drills": [], "texts": [], "artwork": [],
    "grain": { "a": {…}, "b": {…}, "gradeA": {}, "gradeB": {} },
    "order": { "material": "SELF", "qtyPerBundle": 1, … }, …
  }],
  "ruleLibraries": [], "movementPrograms": [], "measurementSets": [], "pieceArchive": [], "layouts": {},
  "settings": { … }, "meta": { … }, "createdAt": "ISO", "updatedAt": "ISO"
}
```

### Loading pipeline

1. **Parse.** Invalid JSON raises a `NativeFormatError`.
2. **Detect and migrate.** `detectSchema()` reads `schema`. The loader then applies registered migrations one after another until it reaches `prowdcad/2`. Each step adds a warning. An unknown schema raises an error.
   * Built-in migration: legacy single-HTML `.wptn` → `prowdcad/2`. It negates y, turns absolute handles into relative ones, maps notches `{seg,t}` to `fromPrev` at that arc length, maps `internals` lines to open internal contours (`kind:'drill'` becomes a Drill), and turns `annotations` into texts. Measurement-driven grading is **not** carried over.
3. **Normalise.** Fills in optional collections that older writers left out.
4. **Validate.** `validateStyle()` checks structure, size-table references, anchor-id uniqueness, notch, dart and anchor references, and `cutMode`/`manualCut` consistency. Any problem raises a `NativeFormatError` whose `.problems[]` lists the issues.

### `exportSizeAsStandalone(doc, pieceId, sizeId) → Style`

Builds a new Style with one size line that holds only that size (same name). The piece's geometry at that size becomes its base:

* Anchors, the manual cut and internals are resolved at that size.
* Drills, texts, artwork, grain, dart apexes and pleat axes are offset to that size.
* Notches keep their anchor (re-mapped to the new id) and take that size's `dist`.
* Locked per-size corners are written as `manualPoints`.
* All `grade` maps are emptied, `ruleId` is removed, and every id is fresh.

## 2. DXF / AAMA / ASTM D6673 (`dxf.ts`)

### Layer map (import and export)

| Layer | Role | Import | Export |
|---|---|---|---|
| 1 | piece boundary (**cut line**) | closed polyline; the largest one is the cut, extra closed ones become internal cut-outs | cut polygon |
| 2 | turn points (POINT) | marks a vertex as a **grade** point | one POINT per sew-line grade anchor |
| 3 | curve points (POINT) | marks a vertex as a **curve** point | one POINT per sampled sew vertex that is not an anchor |
| 4 | notch (slit) | LINE (outer end → inner end) or POINT → `Notch` | LINE from the cut line, `depth` long, pointing inward |
| 80 / 81 / 82 / 83 | T / castle / V / U notch | same as layer 4, with that type | written by notch type |
| 5 | grade reference line | internal `guide` | — |
| 6, 86 | mirror line | internal `mirror` | mirror contours and `piece.half` |
| 7 | grain line | first LINE → `piece.grain` | grain LINE |
| 8 | internal lines | open or closed internal contours | internals (LINE when 2 points, otherwise POLYLINE) |
| 9 / 10 | stripe / plaid reference | internal `guide` | — |
| 11 | internal cut-outs | closed internal with `mode:'cut'` | closed internals with `mode:'cut'` |
| 13 | drill holes | POINT, plus an optional CIRCLE whose diameter is used | POINT, plus a CIRCLE when the diameter is above 0 |
| 14 | **sew line** | closed polyline → `piece.sew` | sew polygon (only when the piece has seams) |
| 84 | sew line (legacy ProwdCAD ASTM files) | treated like 14 | — |
| 15 | annotation text | TEXT/MTEXT → `TextAnnotation` | piece texts |
| 85 | grade-rule tables | `# n` texts that apply to any entity of the piece | — (rules are written on the entity's own layer) |
| 87 | alternate grade reference | internal `guide` | — |

You can override or add layer names with `importDXF(text, {layerMap})`. The importer also accepts names that end in a number, such as `L14` or `AAMA_14`.

### Pieces

* **ASTM** (`flavor:'astm'`, the default): one `BLOCK` per piece, placed by an `INSERT` at (0,0) so that coordinates stay those of the drafting frame. Piece attributes are `TEXT`s on layer 1 of the form `Key: value`: `Piece Name`, `Size`, `Quantity`, `Material`, `Category` and `Rule Table`, plus `Sample Size` in nested exports. The importer also reads `ATTRIB`/`ATTDEF` with the same tags.
* **AAMA** (`flavor:'aama'`): flat layers in `ENTITIES` and the same per-piece attribute texts. On import, entities are grouped by the containing (smallest) boundary. Notches go to the nearest boundary. Flat outlines made of LINE/ARC pieces are chained back together, and a boundary inside another boundary is an internal cut-out.
* **Import of sew and cut:**
  * **Layers 1 and 14 both present:** sew = layer 14. Seam allowances are **inferred** per grade segment by measuring cut-to-sew at each segment's midpoint; the most common value becomes `seamDefault` and the others become `seamAfter`. The importer then re-derives the cut line. If it deviates from layer 1 by at most `seamInferTol` (0.1 mm), the piece stays `cutMode:'auto'`. Otherwise it becomes `cutMode:'manual'` with `manualCut` = layer 1, and the report flags it. Use `seamMode:'manual'` to always keep the boundary as a manual cut.
  * **Only layer 1 present:** sew = layer 1, `noSeam:true`, and the report says so.
* **Point kinds:** layer 2/3 markers decide where present. When a piece has markers, unmarked vertices are curve points. Without markers:
  * A vertex whose turning angle is at least `cornerAngleDeg` (25°) becomes a corner grade point.
  * A vertex that carries a rule number becomes a grade point.
  * Every other vertex becomes a smooth curve point. A vertex counts as smooth only if its two neighbouring edges are of similar length (ratio below 4); otherwise it stays a corner, so a straight edge next to a curve is not bowed.
  * Vertices sampled from a bulge, arc or spline are curve points.
* **Entities:** POLYLINE (with VERTEX/SEQEND and bulges; spline-frame vertices are skipped), LWPOLYLINE (bulges are sampled to ≤ 0.01 mm chord error), LINE, ARC, CIRCLE, ELLIPSE, SPLINE (control points are sampled with rational de Boor, and fit points are used when there are no control points), POINT, TEXT/MTEXT/ATTRIB, and INSERT with nested blocks, scale and rotation. Anything else is listed under "unsupported" in the report.
* **Units:** a forced `units` option wins. Otherwise the importer uses `$INSUNITS` (1 = in, 4 = mm, 5 = cm), then a `Units: METRIC|ENGLISH` text, then `$MEASUREMENT` = 0 (inches). As a last resort it assumes inches when the drawing extent is under 100, and mm otherwise; the report gives the source of the units.
* **y** is kept as is (DXF is y-up). `flipY:true` negates it for files from y-down systems, and `yFlipped` in the report records the choice.

### Grading: `.rul` companion file

* **Rule numbers on vertices** are written as `TEXT "# n"` (height 1) at exactly the graded point, on the same layer as the entity it grades: sew, cut, internal, grain end, drill or text. On import, a rule text snaps to any vertex within `snapTol` (0.01 mm).
* **Rule numbering:** each distinct per-size increment set gets one rule number. Rule 1 is always the zero rule. Ungraded points get no rule text.
* **Rule file** (`writeRUL` / `parseRUL`), AAMA/ASTM DELTA format:
  ```
  ASTM/D6673/RUL
  UNITS: METRIC                 (ENGLISH = inches)
  GRADE RULE TABLE: <name>
  NUMBER OF SIZES: 4
  SIZE LIST: S M L XL
  SAMPLE SIZE: M
  RULE: DELTA 2
  0.0000,0.0000,10.0000,0.0000,10.0000,0.0000,15.0000,0.0000
  END
  ```
  Each rule line holds one `dx,dy` pair per size in size-list order, as **incremental** deltas, the same convention as the kernel. Precision is 4 decimals in mm and 8 in inches. The parser accepts values wrapped over several lines and size lists that run onto the next line.
* **On import with a `.rul`:** the size line is built from `SIZE LIST` and `SAMPLE SIZE`, and each vertex with rule *n* gets `grade` = rule *n*. Rule numbers missing from the table appear in `report.unresolvedRules`. The table is also returned as `report.ruleLibrary`. Rule numbers without a `.rul` produce a warning and no grading.
* **Graded nest export** (`nested:true`): one BLOCK per piece per size (`FRONT_S`, `FRONT_M`, …), each with a `Size:` attribute and `Sample Size:`. No `.rul` is written. On import, blocks with the same `Piece Name` and different `Size` values are merged back into one graded piece. Vertices are matched by index when the point counts agree. Otherwise only grade points are matched, by grade index, and curve points follow the proportional rule.
* `addImportToDocument(doc, report)` adds the pieces to a document. It reuses a size table with the same size names or adds the imported one, and it remaps every grading key.

### Export options

`exportDXF(doc, {flavor, units:'mm'|'in', pieceIds, nested, sizes, layout:'none'|'pack', pointMarkers, precision, ruleTableName})` returns `{dxf, rul?, rules}`. Coordinates are written with up to 6 decimals in mm and 8 in inches, y intact, and a header with `$ACADVER AC1009`, `$INSUNITS` and `$MEASUREMENT`. Lines end with CRLF.

## 3. SVG (`svg.ts`)

* **Import**
  * **Parsing:** the module has its own XML tokenizer, so no DOM is needed. It reads `path` (M L H V C S Q T A Z, relative and absolute; arcs use the exact endpoint-to-centre conversion and are sampled to 0.02 mm), plus `rect` (including rounded corners), `circle`, `ellipse`, `line`, `polyline`, `polygon` and `text`.
  * **Transforms:** nested `transform`s (matrix/translate/scale/rotate/skew) are composed.
  * **Units:** a physical `width`/`height` (mm, cm, in, pt) combined with a `viewBox` gives the mm per user unit. Otherwise user units are treated as px at `dpi` (96 by default), or as mm with `unitsAreMm`. The viewBox origin is ignored, so CAD coordinates are kept. y is negated (`yFlipped:true`).
  * **Roles** come from `data-role`, then `class`/`id`/`inkscape:label` keywords (cut, sew/seam, notch, grain, drill, text, mirror, internal). Groups marked `class="piece"` or `data-piece` form one piece each, named by `data-name`.
  * **Files without that structure:** the largest closed outlines become pieces. An inner closed outline parallel to its piece becomes the sew line, and small inner circles become drills. Open strokes no longer than `maxNotchLength` (15 mm) that touch an outline become notches; other open strokes become internals.
* **Export**
  * Scale is 1:1 mm: `width`/`height` are in `mm` and the `viewBox` is in mm, so 1 user unit = 1 mm. y is negated.
  * Each piece gets one `<g class="piece" data-piece data-name>`, which holds one `<g class="size" data-size>` per size. Inside are sub-groups with `data-role` = cut, sew, internal, notch, grain (line + arrowheads), drill and text. The piece label has `data-role="label"` and is ignored on import.
  * Sew lines and internals are written as exact cubic Béziers from the anchor handles (`curves:false` writes polylines instead).
  * With `sizes:[…]` the export becomes a per-size nest: every size's cut line, each in its own colour.

## 4. PLT / HPGL (`plt.ts`)

* **Device profile** `{unitsPerMm (40 = 0.025 mm), frameWidth, notchCode:'line'|'spike'|'none', pens:{cut,sew,internal,notch,grain,text,drill}, textHeight, sew, decimals}`.
* **Import**
  * **Commands understood:** `IN DF PU PD PA PR SP LB DT SI CI AA AR PE`. `SC` is reported and ignored.
  * **Frame:** y is kept as is, since HPGL is y-up.
  * **Contours:** a closed pen-down run (ends within 0.5 mm) is a contour. The largest outer contours are pieces. An inner closed run on the sew pen, or one parallel to its piece, is the sew line.
  * **Notches** are found two ways. A "spike" (out-and-back within a contour, at most `maxNotchDepth` = 12 mm) is removed from the outline and recorded. A separate 2-point stroke of that length or less starting on an outline is also a notch.
  * **Other strokes:** two crossed strokes on the drill pen become a drill. On the grain pen, 3-point arrowheads are dropped and the 2-point stroke becomes the grain line. `LB Piece Name: X` names the piece, and other labels become texts.
* **Export**
  * Each contour is written as one `PU` move plus one `PD` run. `SP` switches pens.
  * Notches are written as separate strokes (`line`) or as spikes in the cut path (`spike`).
  * Each piece gets an `LB` label with its name, plus its texts (terminator `\x03`).
  * Grain is drawn with arrowheads, and drills as crosses.
  * With `layout:'pack'` or a `frameWidth`, pieces are laid out along x within the frame, and content that does not fit raises an error.

## 5. Tiled PDF (`pdf.ts`)

* The module has its own PDF 1.4 writer: no dependencies, uncompressed content streams, Helvetica.
* **Scale is exactly 1:1:** coordinates are in points, 1 pt = 25.4/72 mm (`PT_PER_MM = 72/25.4`).
* **Page sizes:** A4/A3/A2/A1/A0/Letter/Legal/Tabloid or a custom `{w,h}` in mm, with orientation, `margin` (10 mm by default) and `overlap` (glue strip, 10 mm by default).
* **Tiling:** the printable area is (page − 2·margin), and tiles step by (printable − overlap).
* **Page furniture:** each page has registration crosses with circles at the four corners of the printable area. Labels follow a column-letter + row-number grid (A1, B1, … A2 …), with "glue B1 here" hints and dashed glue lines on the overlap strips.
* **Content:** cut, sew (dashed), internals, notches, grain with arrows, drills, the piece name with its size(s), and texts.
* **Sizes:** `sizes:[…]` with `mode:'nested'` overlays the cut lines of all sizes in colour; `mode:'single'` lays out each size separately.
* **Calibration:** by default the page includes a 100 × 100 mm calibration square. It is drawn as `re` with 283.4646 pt sides, which the tests check.

## 6. Assumptions (where the standards are silent)

* **Notch direction:** a notch LINE runs from its end nearest the cut line inward. The notch is anchored `fromPrev` on the sew grade segment where the line's extension meets the sew line. Its angle is measured from the inward normal.
* **Rule numbers on vertices:** ASTM D6673 links rule numbers to boundary points through the layer-1 "turn point" POINTs plus a rule-number text. ProwdCAD writes the `# n` text on the entity's own layer (as Gerber and TUKA do) and also accepts layer-85 rule texts.
* **Rule 1 is the zero rule.** Increments are per-size deltas in size-list order, the same as the kernel convention.
* **Unknown units:** with no units in the file, an extent under 100 means inches.
* **Point kinds without markers:** a turning angle of at least 25° makes a grade point.
* **Nested sizes without a `.rul`:** the base size comes from the `Sample Size` attribute, otherwise the middle size.
