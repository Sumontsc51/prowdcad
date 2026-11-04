# ProwdCAD v2 — Phase 1 independent audit

Branch `v2`, audited 2026-11-04. The reviewer did not write this code, and no source or test file was changed.
Every number below comes from the reviewer's own checks: a fresh shape, size line, and expected value derived by hand.
The checks live in `/tmp/claude-0/-home-claude/d882fe2a-8da8-5d6c-b9ba-a8840f87e379/scratchpad/audit/`:
`*.audit.ts` run with `npx vitest run --config <that dir>/vitest.config.mjs <name>` from `packages/kernel`.
`d10.js` is the browser script, run through `../cdp.mjs`.

## 0. Build / test baseline

| Command | Result |
|---|---|
| `packages/kernel: npx vitest run` | 22 files, **232 / 232 pass** (18.2 s) |
| `packages/kernel: npx tsc --noEmit -p .` | clean |
| `apps/web: npx tsc --noEmit -p .` | clean |
| `apps/web: npm run build` | OK. 534.6 kB JS chunk; warnings about chunk size and the mixed dynamic/static import of `units-ui.ts` |
| UI ↔ kernel wiring (headless Chrome, `opStatus()`) | 243 / 243 ops wired; `setSeamWholePiece` round-trips through `ops` |

Passing tests are not evidence on their own. Several existing acceptance tests use the one shape where the bug
cannot show, or a comment claims a check that the test never asserts. See §4.

## 1. Acceptance results (re-derived)

| # | Verdict | What I ran / observed |
|---|---|---|
| D1 | **PASS** | Square at (5,7) and at (−50,20), start vertex rotated, CCW and CW, raw `offsetOutward` and `computeCutLine`. Every case gives a bbox of exactly 120.000 × 120.000, area 14400, 4 vertices, input winding kept. |
| D2 | **PARTIAL / FAIL** | Pentagon, 6 sizes; the corner moves and **both** adjacent edges change angle per size; seams 15/10. With `angled`, `boxed:next` and `turnback:next`, the stamped corner is identical on every size (shape deviation ≤ 5e-14 mm) and lies on the cut line (gap ≤ 3e-14). **With `boxed:both` it fails:** the corner polyline A→P→Q→B crosses itself at (275.20, 150.78), so `removeSelfIntersections` drops P and Q from the cut line. The stamped points end up 7.45 mm and 3.10 mm off the real cut line in every size. With Lock on, the real cut corner has 4,4,4,**3**,4,4 points across sizes, so it is not identical. The repo test only uses a 90° rectangle, where `boxed:both` happens to work. |
| D3 | **PARTIAL** | Trapezoid bodice with a straight or a curved side seam, 4 sizes, dart 24 wide and 170 deep, moved 100 % to the side seam. **Base size:** closed perimeter 1266.9303 → 1266.9303 on both shapes. **Graded sizes drift:** S −0.050, L +0.057, **XL +0.121 mm** (curved side seam: XL +0.113). That is over the 0.1 mm budget. The repo test's comment says "conserved per size", but it only asserts `pts.length > 5`. **50 %:** the angular fullness splits exactly (8.0754° → 4.0377° + 4.0377°), and the perimeter is unchanged. |
| D4 | **PASS** (caveat) | Curved stationary and moving edges, ratio 2, steps 7 + 13.5 + 30. Stationary 50.5, moving 101.000 (ratio 2.000000); my own resampling puts the moving point at 101.008. Notches dropped on a straight edge against a different, rotated, curved edge coincide after `applyTransform`, gap 0 to 7e-15 mm. *Caveat:* in non-base sizes the paired distances differ (L: 20.667/20.657, 56.833/56.806, 93.000/92.955). The proportional extrapolation is a documented assumption in `walk.ts`. |
| D5 | **PASS** | Proportional notch at 30 % on a **curved** segment. The segment was lengthened from 168.576 to 218.576 mm by bisecting the end anchor's position. The fraction stays 0.300000; arc error 1e-14 mm. |
| D6 | **PASS** | Sizes 34–42 with mixed-sign increments, grain at x=0. The target gets `dx` negated and `dy` kept for every size. Size 42 lands at source (161, 56) and target (−161, 56). |
| D7 | **PASS** | Sleeve cap is one explicit-handle cubic; armholes are straight grade polylines (exact). Kernel ease vs. my 200 k-step integration: S 23.9010/23.9105, M 19.8767/19.8863, L 15.7384/15.7481. The armholes are exact; the cap reads about 0.0096 mm short because of chord sampling (see C3). |
| D8 | **FAIL** (grain ≠ vertical) | `pctToFactor(4/7, true)` = 1.0416667 (100/96) and 1.0752688 (100/93), as required. With a vertical grain, washing the result gives back the spec anchors to 6e-14 mm in every size. **With a rotated grain the axes swap.** At a 45° grain, `yPct: 20` makes the along-grain edge 100.000 (should be 120) and the across-grain edge 120.000 (should be 100). See bug B1. The repo test only covers the default vertical grain. |
| D9 | **PASS** (narrow) / bug | Straight side seam: chest +36 → both side-seam grade anchors move +18.000. **But implicit curve points do not move** (B6). On a curved side seam, chest +40 changes the width at the chest line by **0.000** mm and the maximum width by 9.964 mm, where +20.00 is expected. |
| D10 | **PASS** | Headless Chrome, real `PointerEvent`s, dev server. (a) Internal tool: a second raw pointerdown at the same spot 30 ms later fires 0 `dblclick` events, and the line is committed as open with 2 points. (b) Broken V handles at cos 0, then one drag of hOut: hOut (40,10), hIn (−37.885, −9.471), **cos = −1**, `smooth=true`. (c) After a piece drag the layout is (60,35) and the handle offsets are byte-identical. Code: `tools/internal.ts` (`DoubleClick(450,7)`), `tools/select.ts` 140–166. |
| D11 | **PARTIAL** | AAMA and ASTM, flat+RUL and nested; a CW piece entirely at negative y, 5 sizes, V notch, grain at 20°, text at 30°. y is intact (−400 written, `yFlipped=false`); grain and text match exactly in all sizes; text angle 30 is kept; no warnings. **Flat + RUL loses notch grading** (B2): per-size distances 100/103/106/109/112 come back as 106 for every size, so the notch is 6.0 mm off in sizes 2 and 10. Nested export keeps them. A curved span in graded sizes comes back 0.058 mm off (size 2) and 0.051 mm off (size 10); straight spans and the base size are exact. |
| D16 | **PASS** | Letter landscape, margin 12, overlap 15, a 523 × 811 mm piece. 3 × 5 = 15 pages, MediaBox 792 × 612 pt exactly. I parsed every page's content stream and mapped it back to mm through tile (c, r): all 15 tiles give the **same** world polygon within 3e-5 mm. Edges measure 523.000 / 811.000 / 665.169 / 400.000 mm; the calibration square is 283.4646 pt = 100.00001 mm. |

## 2. Part A spot checks (10)

| Feature | Function | Verdict | Evidence |
|---|---|---|---|
| Half piece mirrors live | `ops/pieces.ts::setHalf` | **FAIL / metadata only** | After `setHalf` on a 150 × 300 block with the fold on x=0, the resolved cut runs x −10…160: the half piece, **with a 10 mm seam on the fold edge**. DXF export minX is −10, so only the half is exported. `openAtOutput` is never read anywhere in the kernel or the UI. Only `openHalf` (a destructive one-shot) mirrors, and it works (bbox −150…150, 6 anchors). |
| Reference Block restore | `snapshotReference` / `restoreReference` / `showReference` | PASS | After moving an anchor and adding a point, restore gives a byte-identical sew contour; overlay area 10000. |
| Point Connections global check | `globalCheckConnections` | PASS | Two internals crossing: anchor (50, 45) added to both. An endpoint 0.03 mm from the sew line snaps to (50, 0); 4 connections are made. `movePoint` +10 on the connected sew point drags the internal anchor to (60, 0). |
| Multi Darts equal spacing | `createMultiDarts` | PASS | 3 darts on a 420 mm edge: centres 315 / 210 / 105, widths 16.0000. |
| Scallop auto-solve | `solveScallops` / `shapeScallop` | PASS | Chord 437, width 50: `none` gives 9 × 48.556; `both` gives 8 × 50 plus 18.5 + 18.5 partials. Count 7 gives width 62.4286 and depth 31.214; area 98110.9 against 98113.3 for exact semicircles. |
| Stack Along Line | `stackAlongLine` | PASS | Size L: A on its base position (0,0), A→B angle 0, length kept at 110.1136. |
| Angle Grading | `angleGrading` | PASS | 30° with preserve: world position unchanged (106,108); local increment (9.1962, 3.9282) matches the hand rotation. `aim:'next'` gives 180°. |
| Grade Parallel (preserve length) | `gradeParallel` | PASS | L length 218.689277 before and after; angle 14.036243° = base. |
| Compare Length modes | `compareLengths` mode x/y/diagonal/contour | PASS | 150 / 40 / 155.2417 / 202.23 mm, all as expected. |
| Binding notch copying | `generateBinding` | PASS | Chain of 300 + 200 mm: M 500, L 520. Break notch at 300 (L 310); copied notch at 370 (L 380). |

## 3. Bugs (with repros)

All repros use the kernel's public API (`packages/kernel/src/index.ts`).

**B1 — Scale & Shrink applies the factors in the wrong grain frame (D8). Severity: high.**
`ops/scale.ts`: the off-diagonal terms of `M = R·diag(fx,fy)·R⁻¹` are written `c*s*(fy − fx)`. The correct term is `c*s*(fx − fy)`. As written, it scales about the mirrored axis.
```ts
const r = 100/Math.SQRT2;
const c = makeContour([gradePoint(0,0), gradePoint(r,r), gradePoint(0,2*r), gradePoint(-r,r)]);
p.grain = { a:{x:0,y:0}, b:{x:50,y:50}, ... };      // grain along (1,1)
scalePiece(doc, p.id, { yPct: 20 });
// edge (0,0)→(r,r) along grain: 100.0000 (expected 120); edge across grain: 120.0000 (expected 100)
```
The same matrix is applied to seam allowances (`MinvT`) and to grade increments, so all three are wrong for any grain that is not 0° or 90°.

**B2 — Flat DXF + RUL export drops per-size notch distances (D11). Severity: high.** A `fromPrev` notch with
`dist = {2:100, 4:103, 6:106, 8:109, 10:112}` re-imports as 106 in every size, so the notch is 6.0 mm off in the extreme sizes. Nested export is fine. The repo test uses `dist = 80` in every size, so it cannot catch this. Repro: `d11.audit.ts` / `d11b.audit.ts`.

**B3 — Half pieces are not live (spec A: "half pieces mirror live"). Severity: high.** `piece.half` is only stored.
`resolvePiece`, `computeCutLine`, every exporter and the PDF never mirror it. The fold edge gets a full seam allowance, and `HalfSpec.openAtOutput` is dead.

**B4 — Offset: an inward collapse leaves a "ghost" polygon. Severity: medium-high (cut lines, `cutParallel`, shrink).**
```ts
offsetOutward(square100, -60)  // → (60,60)(40,60)(40,40)(60,40): a 20×20 square, same winding; expected: empty
offsetOutward(square100, -50)  // → single point (50,50)
offsetOutward(L_shape_arms30, -16)  // → (16,16)(84,16)(84,14)(14,14)(14,84)(16,84): sliver, expected: empty
```
The miter of a fully inverted shape keeps its orientation, so the "keep the loop with the original orientation" rule in
`removeSelfIntersections` cannot detect it. The test `foundation.test.ts › removes inverted loops` asserts `area > 0` for −16 and so **encodes this bug**.
Suggested check: drop output edges whose direction is opposite to their source edge, or reject any output vertex closer than |d| − ε to the input.

**B5 — Offset: an outward offset does not fill a concavity narrower than 2d. Severity: medium.** U-slot 10 mm wide with seam 10:
`offsetOutward` and `computeCutLine` give area 15000 instead of 14400. The cut line still dips into the slot, (45,110)(45,50)(55,50)(55,110), and touches the sew line (minimum distance 0). The two slot walls cross over as collinear, overlapping edges, which `segIntersect` returns as `null` (parallel), so the loop is never removed. Pockets, plackets, and darts narrower than twice the seam allowance are affected.

**B6 — Movement programs do not carry implicit curve points (D9). Severity: medium.** `applyMoves` writes only the moved
anchor's base x/y. Curve points between two moved grade anchors keep their absolute base position. Repro: side seam
`gradePoint(240,0) – curvePoint(250,200) – gradePoint(235,420)`, chest program dx 0.5 on both grade points, +40 mm. The grade points move +20, but the curve point moves 0.000 and the chest-line width changes by 0.

**B7 — `boxed:'both'` corners are only right for 90° corners (D2). Severity: medium.** `boxedCorner` extends A along tIn by
|dNext| and B back by |dPrev|. At other angles the segments A→P and Q→B cross each other, and the cut line loses the corner. Repro: `d2c.audit.ts`, pentagon corner (260,150), seams 15/10. Corner self-intersects at (275.195, 150.779).

**B8 — Dart transfer does not conserve the closed perimeter in graded sizes (D3). Severity: medium-low.** XL +0.121 mm, S −0.050 mm, base exact. Likely cause (not confirmed): the rotated region's grade vectors are rotated rigidly (`xfGrade`), while the split anchor at the target gets interpolated grading, so the graded legs are not a rigid image of each other.

**B9 — `resolveContour` crashes on open contours that start with curve points (non-base size). Severity: medium.**
```ts
makeContour([curvePoint(0,0), curvePoint(50,30), gradePoint(100,0,{grade:{[L]:{dx:10,dy:5}}}), gradePoint(150,0)], {closed:false})
resolveContour(c, line, L)  // TypeError: Cannot read properties of undefined (reading 'x')
```
In `anchorPositions`, when `prev < 0` it sets `prev = next`, and then the `dPrev` walk steps through `j-1 < 0`. The internal-line tool forces the ends to grade points, but imports and segment ops can still produce such contours.

**B10 — A zero-length grade segment notches the cut line. Severity: low-medium.** Duplicate grade points (100,0)(100,0) on a 100² square give a cut of area 14300 and the vertices `(100,-10)(100,0)(110,0)`: the cut touches the sew corner. In `seam.ts::build`, a segment with `sew.length < 2` is given the un-offset point as its "offset".

**B11 — Acute points get almost no allowance. Severity: low-medium.** A 5° spike with seam 10 leaves **0.25 mm** at the tip, because the bevel fallback after the miter limit joins the two raw offset endpoints. Collar points and narrow straps are affected. Use a square cap at distance d along the bisector.

**B12 — Arc-length precision. Severity: low.** Sampling with `tol=0.05` underestimates curve lengths: a 600 mm radius quarter reads 942.6054 against 942.6100, and a sleeve cap reads −0.0096 mm short. Compare Length sums three curves, so the error is right at the 0.01 mm reporting resolution. Use Gauss–Legendre on the Bézier spans.

**Minor:** `tools/select.ts:163` sets `a.smooth = true`, and the next line overwrites it with `a.smooth = !broken` (dead code). DXF re-import of a graded curve deviates 0.05–0.06 mm (see D11).

## 4. Tests that over-claim

- `foundation.test.ts` "removes inverted loops": asserts `area(o2) > 0` for a shape that should collapse (encodes B4).
- `darts.test.ts` D3: the comment says the closed perimeter is conserved per size, but the only per-size assertion is `pts.length > 5` (hides B8).
- `seam.test.ts` D2: only a rectangle, so `boxed:both` is never exercised off 90° (hides B7).
- `scale.test.ts` D8: only the default vertical grain (hides B1).
- `io.test.ts` D11: the notch distance is the same in every size, and grading of curved spans is mild (hides B2).
- `movement.test.ts` D9: a rectangle with no curve points (hides B6).

## 5. Gaps vs. spec (observed)

- **Live half pieces**: not implemented (B3). `openAtOutput` is unused.
- **Polygon offset**: no general clipper. Collapse and narrow-gap handling are wrong (B4, B5), and the acute-tip allowance is inadequate (B11). The common case is robust: a 300-case random star-polygon property test (both windings, ±2–22 mm) showed 0 self-intersections, 0 winding flips, and 0 points closer than |d|.
- Edge cases that work: zero-length edges and collinear points in raw `offsetPolyline`, CW winding everywhere tested, a closed contour with a single grade point, coincident points (no NaN).
- I did not review the full spec text: only the condensed acceptance list was available to this auditor. Coverage of Part A beyond the 10 features above is unverified.

## 6. Prioritised fix list

1. **B1 scale grain frame**: a one-term sign fix in `ops/scale.ts`, plus a test with grain at 30° and 45° checking that washed = spec.
2. **B2 DXF flat export of notch grading**: write per-size notch positions, either as graded notch vertices with rules or as a size-tagged notch layer. Add a test where notch distances differ per size.
3. **B3 live half pieces**: mirror in `resolvePiece` (sew, cut, internals, notches, drills, texts) when `half` is set; zero seam on the fold edge; mirror at export when `openAtOutput`.
4. **B4 / B5 offset robustness**: replace `removeSelfIntersections` with a proper union, or a winding-number cleanup that handles collinear overlaps. Reject inverted edges. Fix the foundation test.
5. **B6 movement programs**: move implicit curve points proportionally, or materialise them before moving.
6. **B7 boxed:both** for non-right corners: extend each allowance to the other offset line, not by a fixed width.
7. **B9 crash** in `anchorPositions` (guard the `dPrev` / `dNext` walks on open contours).
8. **B8 dart transfer grading**: rotate the graded geometry per size, or re-derive the target-leg grading so the graded legs stay equal.
9. **B10 zero-length segments** (skip them in `build` and merge their seams); **B11** square-cap bevel at acute tips.
10. **B12** analytic arc length. Tighten the D4 non-base-size notch pairing and the precision of graded-curve DXF re-import.

## 7. Fix log (2026-11-04)

Kernel only (`packages/kernel`); `ops/seam.ts` and `apps/web` were not touched. Every item has a regression test
built from the audit repro and asserting the corrected numbers. After the fixes: `npx vitest run` gives 22 files and 253/253 tests (seam tests unchanged and passing), `npx tsc --noEmit -p .` is clean in the kernel, and `apps/web` tsc is clean too.

| # | Status | What changed | Test |
|---|---|---|---|
| B1 scale grain frame | **Fixed** | `ops/scale.ts`: off-diagonal is now `c·s·(fx−fy)`. The same `M` drives seam scaling (`M⁻ᵀ`) and grading, so both are fixed as well. Also, in `nest` mode with fx≠fy, implicit curve-point grading is materialised (×M) before scaling, because proportional interpolation is not invariant under non-uniform scale. Washed anchors now match spec to ~1e-13 in every size on a curved piece. | `scale.test.ts` › B1 45° (along 120 / across 100, seam 10/12, grade 12/10); B1 30° 4/7 % washes back in S/M/L |
| B2 DXF flat+RUL notch grading | **Fixed** | Export: each sew-line notch's outer end carries a `# n` rule (per-size displacement of that endpoint). Import: per size, the end is moved by its rule, cast onto that size's sew line, and `dist[size] = d + Δs`. Nested export already worked and now has a test. The encoding is documented in `FILE-FORMATS.md` § Grading. | `io.test.ts` › B2 ASTM/AAMA × straight/curved: 100/103/106/109/112 back exactly (Δpos < 1e-5); B2 nested |
| B3 live half pieces | **Fixed** | `model/contour.ts::halfOpenedPiece` derives the full piece on the fly and never stores it. Mirrored anchors get ids `<id>~m` and `flags.derived`. The fold edge becomes interior, so it has no seam. It mirrors seams (allowance carried over), corners (boxed/turnback side swapped), sew notches (fromPrev↔fromNext, pct→100−pct, angle negated, fold-edge notches dropped), internals, sew-line darts, drills, texts and artwork, and it mirrors exactly per size across that size's fold edge. `Document.effectivePiece` / `resolvePiece(…, {output})` use it. With `openAtOutput:false` the half is shown as authored and only exporters (`drawPiece`) open it. `setHalf` rotates the sew contour so the fold edge closes it, which keeps authored indices stable. `openHalf` materialises the live result with fresh ids. `deleteHalf` drops the spec. | `pieces.test.ts` › live half pieces (B3): perimeter = 2·half − 2·fold in S/M/L, cut symmetric with no fold seam, notches ±40/50/60, drills/internals mirrored, openAtOutput false, DXF minX −170, openHalf ≡ live |
| B4 inward collapse | **Fixed** | `geom/poly.ts`: (a) a closed offset whose shifted edge would run backwards between two concave miters routes its joins through the original vertex (Clipper-style), and (b) `removeSelfIntersections(closed)` is now a winding-number cleanup that keeps the positive-winding region, handles collinear overlaps, keeps the largest piece and returns `[]` when nothing is left. Square −60 / −50 and L −16 → `[]`; the dumbbell keeps a 70×70 lobe. | `foundation.test.ts` › B4 + corrected "removes inverted loops" |
| B5 narrow slot | **Fixed** | Same mechanism. The U slot 10 wide at seam 10 now gives area 14400.000 with min distance 10.000, both through `offsetOutward` and `computeCutLine`. A slot of 30 stays open. | `foundation.test.ts` › B5 |
| B10 zero-length segment | **Fixed (outside seam.ts)** | Raw offset: zero-length edges are dropped with their distances kept aligned. Cut line: the real cause is `seam.ts::build` (it gives a segment with `sew.length<2` its un-offset point), and that file is owned elsewhere. As a workaround, `contour.ts::withoutZeroSegments` drops a grade anchor that coincides with the next one, but only for the cut-line computation; it is used by `resolvePiece`, `notches.ts` and `sizes.ts`. The cut area is now 14400 with min distance 10. **Follow-up for the seam.ts owner:** skip `sew.length<2` segments in `build` and merge their seam; then the workaround can go. Callers of `computeCutLine` that use it directly (seam.ts internals, `io/common.ts` seam inference) still see the raw behaviour. | `foundation.test.ts` › B10 |
| B11 acute tip | **Fixed** | Past the miter limit, the 'miter' and 'bevel' joins use a square cap at distance d along the bisector. 'round' is circumscribed, so it never comes closer than d. A 180° spike also gets a square cap. A 5° spike keeps 10.000 mm (was 0.25). Note: `seam.ts::miterCorner` has its own bevel fallback for the cut line's grade corners and still joins A→B there; that is a seam.ts change, not done. | `foundation.test.ts` › B11 (miter/bevel/round) |
| Fuzz | **Added** | The audit's 300-case random star test at miter limits 1e9 and 4: 0 self-crossings, winding kept, all output on the correct side, min distance ≥ 0.999·|d|. | `foundation.test.ts` › random star polygons |
| B9 open contour crash | **Fixed** | `anchorPositions`: on open contours, curve points before the first or after the last grade point follow their only grade neighbour rigidly, and the walks are bounded. | `foundation.test.ts` › B9 |
| B12 arc length | **Fixed** | `geom/curve.ts::sampleBezier` estimates the per-span length error from one doubling (E ≈ C/n²) and raises n so the error is ≤ 2e-4 mm per span. Lengths are within 0.001 mm of a tol=0.001 reference; the 600 mm quarter now reads 942.6098 (was 942.6054), and the D7 cap error drops from 0.0096 to 0.0002. Suite runtime is unchanged. Gauss–Legendre was not used, because every length consumer reads the sampled polyline. | `foundation.test.ts` › B12 |
| B6 movement curves | **Fixed** | `applyMoves` now carries the program's implicit curve points by interpolating the moved grade anchors' displacements (pre-move base chord distance, same rule as grading). Ends of open contours move rigidly, and curve points moved explicitly are left alone. Chest +40 → +20.000 at the chest line (was 0) and at max width (was 9.964). | `movement.test.ts` › B6 |
| B8 dart transfer grading | **Fixed (straight) / within budget (curved)** | `dartTransferRaw` rotates the wedge per size about that size's pivot by that size's dart angle and stores the result as explicit grading on the rotated anchors. When the graded legs differ (apex grade = mean of the leg offsets), the pivot is the point on the legs' perpendicular bisector nearest the apex. Straight side seam: drift is 0 in every size (was XL +0.121). Curved: ≤ 0.0154 mm (was 0.113), because explicit Bézier handles created by the target split are ungraded and rotate by the base angle. | `darts.test.ts` › B8 ×2; D3 now asserts per-size conservation |
| §4 over-claiming tests | **Corrected** | `foundation` "removes inverted loops" now asserts `[]`/area 0 at −16 and the exact area at −12. `darts` D3 asserts per-size perimeter conservation. `scale` gained rotated-grain cases, `io` per-size notch distances, and `movement` a curved side seam. `seam.test.ts` D2 (`boxed:both` off 90°) was not touched (seam.ts is not owned here). | — |
| B7 boxed:both | **Deferred** | The fix lives in `ops/seam.ts::boxedCorner`, which is owned by the concurrent seam work. | — |
| D4 non-base notch pairing, graded-curve DXF re-import 0.05 mm | **Deferred** | Not in this task's list. | — |

### Fix log: seam module (2026-11-04, second pass)

Only `ops/seam.ts` and `test/seam.test.ts` changed, plus the removal of the B10 workaround's three call sites. After the fixes, `packages/kernel: npx vitest run` gives 22 files and **262/262** (253 before, plus 9 new seam tests). `npx tsc --noEmit -p .` is clean in the kernel, and `apps/web` tsc is clean too.

| # | Status | What changed | Test (`seam.test.ts`) |
|---|---|---|---|
| B10 zero-length segment | **Fixed in `seam.ts::build`** | A grade segment whose sew span dedupes to < 2 points is marked dead and gets no offset. Its coincident end corners merge into one corner, built from the nearest live segments on either side. The anchor whose outgoing segment is live carries the geometry, and the other duplicates alias to its first point (so `cornerIndex` still has one entry per grade anchor). A corner spec on a merged duplicate carries over when the carrier has none. Lock Grading stamps only corners that are real in both the base size and this size. The un-offset point can no longer reach the cut line. **Workaround removed:** `doc.ts::resolvePiece`, `notches.ts::cutFresh` and `sizes.ts` call `computeCutLine` directly again. `contour.ts::withoutZeroSegments` is now unused, but it is still exported through `index.ts`, so it was left in place for the contour owner to delete. `io/common.ts` and the seam internals now get the fix too. | B10 ×3: duplicates give exactly (−10,−10)(110,−10)(110,110)(−10,110), area 14400, boundary distance 10.000, `cornerIndex` [0,1,1,2,3]. A triplicate on CW with `boxed:prev` on the first duplicate and a bottom seam of 20 gives area 120×130. Duplicates only in base, graded apart in L: every size has area 14400 and distance 10. `foundation` B10 still passes through `resolvePiece`. |
| B11 on the cut line (`miterCorner`) | **Fixed** | Past `SEAM_MITER_LIMIT`, a convex grade corner no longer bevels A→B. It now gets a square cap perpendicular to the sew-corner→miter direction, at the larger allowance R from the sew corner, clipped to the two offset lines. | 5° spike, seam 10, CCW and CW: cap at x = 310.000 (tip + 10) between the two offset lines. The whole cut is at boundary distance 10.000 from the sew line (before: 0.436, from the A→B bevel). No self-crossings. The trapezoid miter is unchanged. |
| B7 boxed:both | **Fixed** | `boxedBoth`: each allowance is a strip of its own width along its own edge, run past the corner by the other seam's width along its own direction and squared off. The corner is the outer boundary of the union of the two strips (taken with `removeSelfIntersections`), from A to B. At 90° this is A→(110,−15)→B, the same as before. At acute angles the incoming end squares up and steps out along the outgoing strip's squared end. At obtuse angles the outgoing strip's squared end stands proud of the incoming cut line. The audit's crossing point (275.195, 150.779) is now a real concave vertex on both cut lines, so nothing is lost to loop removal. If either allowance is ≤ 0, or one strip's far end lies inside the other strip, it falls back to miter. | 60°/90°/120° with seams 15/10: exact closed-form corner points, 0 self-crossings, the corner span on the cut line equals the corner geometry, boundary distance 10.000. D2c pentagon, 6 sizes, Lock Grading: the stamped corner is identical in the corner-local frame (1e-9), every size has 5 corner points on the cut line (before: 4,4,4,3,4,4), 0 crossings. The old trapezoid assertion (7 points, P=(110,−10)) was replaced with the new exact 8-point geometry. |

The D2 `boxed:both` over-claim in §4 is resolved by the 60/120 and pentagon tests above.
