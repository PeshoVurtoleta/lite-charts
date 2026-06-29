# Changelog

All notable changes to `@zakkster/lite-charts` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] -- 2026-06-29

### Fixed -- zero-GC audit (4 allocation traps)

A bare-metal pass over the heatmap, axis, and SVG-export hot paths removed four
allocation traps. All four preserve output exactly (the prior tests are unchanged)
and are covered by `test/gc-audit-fixes.test.js`.

- **Heatmap quantile binning is pooled.** `_computeGridColors` no longer allocates
  a fresh `present = []` Array (40k elements for a dense 200x200 grid) per data
  update. A `presentSorted` Float32Array on the grid state is packed and a
  `subarray(0, nPresent)` view is sorted in place; the pool grows monotonically.
- **`_parseRGBLike` scans commas with `indexOf`** instead of `split(',')`,
  removing a per-cell array allocation on the `valueLabelColor: 'auto'` path.
- **`charBufToString` collapses the byte buffer in one call** --
  `String.fromCharCode.apply(null, buf.subarray(0, n))` -- instead of `+=` in a
  loop (which allocated N intermediate rope-string nodes per axis label).
- **SVG export accumulates path commands in an array.** `_pathChunks` is joined
  once by `_pathD()` at stroke/fill/clip, replacing `_currentPath += chunk`,
  avoiding the rope-string flatten that froze / threw `RangeError` near 100k
  points. `beginPath()` truncates with `length = 0`; the rotated `fillRect` /
  `strokeRect` fallback swaps the chunks array.

### Added -- SVG export across all nine charts

Every chart now exposes `chart.exportSVG(opts?)` which returns a complete
`<svg>...</svg>` string with `xmlns`, `viewBox`, `width`, and `height`
attributes -- droppable into HTML pages, PDFs, image-converter pipelines,
or diffable test fixtures. Implementation walks the live `scene.root` tree
through a Canvas2D-shaped shim that emits SVG markup instead of issuing
pixel ops, so the output is geometrically identical to the canvas paint
(minus subpixel rasterization and DPR scaling -- SVG is resolution-
independent).

- **`_SVGRenderingContext2D`** -- ~270 LOC Canvas2D-shaped shim that
  accumulates SVG markup. Tracks CTM as a 2x3 matrix; full save/restore
  state stack snapshots fillStyle, strokeStyle, lineWidth, lineCap,
  lineJoin, lineDash, globalAlpha, font, textAlign, textBaseline, and
  the active clipPath ID. Method coverage spans save/restore;
  translate/rotate/scale/setTransform/resetTransform; beginPath/
  closePath/moveTo/lineTo/bezierCurveTo/quadraticCurveTo/rect/arc/
  arcTo/roundRect; stroke/fill (emit `<path d>`); fillRect/strokeRect
  (emit `<rect>` via an `_axisAligned()` check, falling through to
  `<path>` for rotated cases); fillText/strokeText (emit `<text>` with
  text-anchor + dominant-baseline derived from canvas textAlign +
  textBaseline); setLineDash/getLineDash; clip() emits a `<clipPath>`
  def then marks subsequent elements with `clip-path="url(#id)"`.
  Unsupported ops (drawImage, gradients, shadows) are silent no-ops --
  none of the v1.2.0 chart code uses them.
- **`_drawNodeToSVG` + `_drawSelfToSVG` walker** -- structural mirror of
  lite-scene's `drawNode`/`drawSelf` that walks `scene.root` recursively
  through the shim. Handles every node kind: `rect` (with `_radius` ->
  shim's `roundRect`), `circle` (-> `arc`), `line`, `text` (font +
  align + baseline -> fillText/strokeText), `path` (delegates to the
  node's custom `_draw`), and `group` with optional `_clip` function.
- **`_exportSceneToSVG(scene, width, height, background)`** -- the
  shared entry point each kernel's `chart.exportSVG()` calls with its
  current dimension signals and the resolved background.
- **`SVGExportOptions { background?: string | null }`** -- new typed
  interface in `Charts.d.ts`. Default is the chart's construction-time
  `config.background`; passing `null` explicitly produces a transparent
  SVG even when the chart was constructed with a background fill.
- Chart must be `mount()`ed before calling `exportSVG()`; throws
  otherwise. Mock canvases work too (anything with `getContext('2d')`
  -- SVG export doesn't read pixel data), which is why the full test
  suite can exercise SVG output without a browser.

### Why a context shim, not nine per-kernel exporters

Two reasons. First, the shim guarantees pixel parity since the same
projection math runs whether the output is canvas or SVG. Second, the
shim ships in one place and works for every chart automatically -- nine
per-kernel exporters would each need their own draw-call enumeration
and would drift from canvas behavior over time. The trade-off is less
semantic SVG output (everything is `<path>` / `<rect>` / `<text>`
instead of, say, one `<rect>` per heatmap cell with `data-row` /
`data-col` attributes). A future v1.3.x or v1.4 may opt-in to richer
per-chart semantics; for v1.2.0 the pixel-parity approach is the right
call.

### Internals

- The shim is structurally coupled to lite-scene's `drawNode`.
  `_drawNodeToSVG` mirrors the same recursion lite-scene uses
  internally. If lite-scene adds a new node kind in a future version
  (e.g. `polyline`, `gradient`), this code needs a matching branch.
  Worth a CI guard in v1.3.x -- a `node_kind_in_sync` test that fails
  if lite-scene's `PROPS_OF` gains a key not handled in
  `_drawSelfToSVG` is a candidate.
- `_axisAligned()` matters more than it looks. The shim emits `<rect x
  y width height>` for axis-aligned fillRect/strokeRect (heatmap cells,
  bar fills, axis spines), falling through to `<path>` only when the
  CTM has rotation or skew. Smaller output, easier for downstream SVG
  tooling to interpret. The check itself is one line:
  `m[1] === 0 && m[2] === 0`.
- Types: `SVGExportOptions` interface; `Chart.exportSVG(opts?)`,
  `RadarChart.exportSVG(opts?)`, `PolarChart.exportSVG(opts?)` all
  declared. `RadarChart` and `PolarChart` also picked up the v1.2.0
  `destroy()` that was missing from their specialized interfaces.
- Demo: added an "SVG export" section with download buttons for line,
  bar, pie, radar, and heatmap charts, plus an inline preview that
  shows both the rendered SVG and its source side-by-side.

### Performance contract

- **Bench unchanged**: 325 bytes/cycle on the line-100k full-update
  bench. SVG export is not on the draw hot path, so the steady-state
  redraw cycle is identical to v1.2.0.
- **Bundle deltas**: every chart picks up ~8.9 KB of SVG infrastructure
  (the shim class + walker + entry point). All-nine bundle goes from
  72.8 KB to 82.4 KB; the +9.6 KB rather than +80 KB delta is because
  the SVG helpers are shared module-level functions deduplicated by
  the bundler when more than one chart is imported.

| Chart | v1.2.0 | v1.2.0 | Delta |
|---|---|---|---|
| line     | 23.6 | 32.5 | +8.9 |
| area     | 24.9 | 33.8 | +8.9 |
| bar      | 24.9 | 33.8 | +8.9 |
| bubble   | 24.8 | 33.6 | +8.8 |
| scatter  | 21.9 | 30.8 | +8.9 |
| pie      | 13.3 | 22.1 | +8.8 |
| donut    | 13.3 | 22.1 | +8.8 |
| radar    | 13.1 | 22.0 | +8.9 |
| heatmap  | 12.7 | 21.6 | +8.9 |
| all nine | 72.8 | 82.4 | +9.6 |

Cross-kernel isolation verified clean -- heatmap pulls zero
axis/polar/radar code; nothing else pulls grid-kernel code.

### Tests

259 tests (+14 over v1.2.0), 49 describe blocks. New tests under
`chart.exportSVG() (v1.2.0)`: valid SVG envelope per chart type (line,
area, bar, bubble, scatter, pie, donut, radar, heatmap); rounded-corner
arcs on bars (verifies `roundRect` -> SVG arc commands); fixed
`text-anchor="middle"` on bar category labels (regression guard for the
band-axis fix below); XML escaping of `&` / `<` / `>` in label text;
`background` option emits a background `<rect>`; throws when called
before mount; throws after destroy.

### Bug fixes

- **Bar category-label centering** (pre-existing): at `Charts.js` line
  1329 the band-axis builder passed `anchor: 'center'` to a lite-scene
  `textNode` that expects `align:`. The wrong key was silently dropped,
  leaving `_align` at its default `'left'`. Single-character labels
  ("A", "B", "C") masked it visually; multi-character names ("Mon",
  "Tue", "Wed") were offset right by half a glyph width. Surfaced by
  SVG export -- canvas paint sometimes hides alignment errors visually,
  but SVG's explicit `text-anchor` attribute makes them unmissable.
  Fix is a one-key change. Both canvas AND SVG output benefit.

### License

MIT (c) Zahary Shinikchiev


### Added -- `chart.destroy()` + heatmap polish

**`chart.destroy()` on all four kernels.** `unmount()` keeps construction-
time signals (`widthAutoSig`, `plotBoundsSignal`, `scaleVersion`,
`crosshairVersion`, `seriesVisibility[]`, `hoverVersion`, etc.) alive so
the chart can be remounted -- which leaves ~4 nodes of residue per
mount/unmount cycle in the lite-signal arena. `chart.destroy()` is the
terminal counterpart: it calls `unmount()` first if mounted, then
disposes every signal the chart created at construction.

- Each kernel tracks every signal it creates in a per-instance
  `_ownedSignals` array via a small `_own(s)` helper that pushes-and-
  returns. The visibility-growth paths in polar
  (`ensureVisibilitySignals`) and radar (`ensureSeriesSlots`) push new
  signals through `_own` too, so the array stays in sync as series
  counts change at runtime.
- Verified zero residue across 30 mount+destroy cycles on every kernel.
  Idempotent (subsequent calls are no-ops). Works before `mount()` too
  -- signals exist before mount, so they need cleanup even if the chart
  was never displayed.
- For apps that create and destroy many charts dynamically (dashboard
  tabs, design builders) the `unmount()` residue would otherwise
  accumulate over a long session.

**Heatmap row + column highlights** (`rowHighlight`, `columnHighlight`,
`rowColumnHighlightFill`). On hover, fill stripes the full plot width
(row) and the full plot height (column) at the band width of the hovered
cell, drawn before the cell stroke. Both default on; either independently
disable-able. Stripe color defaults to `rgba(0,0,0,0.10)`; CSS-var values
are resolved against the container at mount time.

**Quantile color binning** (`colorScale: 'quantile'`, `colorBins`).
Default `colorScale` remains `'linear'`; switching to `'quantile'` splits
present values into N bins by rank (default 5, clamp [2, 20]) and assigns
each cell its bin's pre-computed color from the same lo/hi ramp. Per-cell
assignment is a linear scan through N-1 boundaries -- zero-allocation on
the per-cell path, faster than a binary search at this size. Outliers no
longer dominate the ramp; one cell at 1000 in a sea of values [1, 11] no
longer collapses everything else to the lowest ramp color.

**Auto-contrast value labels.** `valueLabelColor` default changed from
`'#ffffff'` to `'auto'` for `showValues: true`. Per-cell NTSC luminance
(`0.299R + 0.587G + 0.114B`) picks `#000000` for light cells and
`#ffffff` for dark cells. Computed at extract time alongside the cell
color (no extra pass) and stored in `state.cellLabelColors`. Explicit
`valueLabelColor` (any non-`'auto'` value) skips the per-cell allocation
entirely.

### Internals

- New helpers: `_pickContrastColor(rgb) -> '#000'|'#fff'`,
  `_parseRGBLike(css) -> [r,g,b]|null`. Helper removed:
  `_lerpRGBString` -- the linear and quantile paths now inline the lerp
  to keep R/G/B integers in scope for the luminance check.
- `_parseRGBLike` handles `rgb(...)` and hex strings (the two formats
  the built-in ramps emit). Custom `colorFn` returns that don't match
  (named colors, `oklch()`, `rgba()`) fall through to `#ffffff`. Adding
  a full CSS color parser would have cost 1-2 KB minified; users who
  need auto-contrast with custom color spaces can pre-compute label
  colors and pass an explicit `valueLabelColor` instead.
- Quantile binning chose a linear scan over binary search because N is
  small (default 5, clamp [2, 20]) and the scan is zero-allocation
  whereas a generic binary search via helper would introduce one. At
  5 bins the worst case is 4 comparisons -- cheaper than a function
  call.
- The grid kernel needed the least adaptation for `destroy()` -- heatmap
  creates only two signals (`plotBoundsSignal`, `hoverVersion`), the
  simplest tracking surface of any kernel.

### Performance contract

- **Bench unchanged**: 325 bytes/cycle on the line-100k full-update
  bench. The `destroy()` + heatmap-polish work is not on the draw hot
  path.
- **Bundle deltas**: every chart picked up ~200 bytes for the
  `_ownedSignals` array + `_own` helper + `destroy()` function.
  Heatmap grew ~2.2 KB for quantile binning + auto-contrast +
  row/column highlights (no other chart has the new heatmap code).

| Chart | v1.2.0-alpha.3 | v1.2.0 | Delta |
|---|---|---|---|
| line     | 23.4 | 23.6 | +0.2 |
| area     | 24.7 | 24.9 | +0.2 |
| bar      | 24.7 | 24.9 | +0.2 |
| bubble   | 24.6 | 24.8 | +0.2 |
| scatter  | 21.7 | 21.9 | +0.2 |
| pie      | 13.1 | 13.3 | +0.2 |
| donut    | 13.1 | 13.3 | +0.2 |
| radar    | 13.0 | 13.1 | +0.1 |
| heatmap  | 10.5 | 12.7 | +2.2 |
| all nine | 70.0 | 72.8 | +2.8 |

Cross-kernel isolation: confirmed clean -- heatmap pulls zero
axis/polar/radar code, and no other chart pulls grid-kernel code.

### Tests

245 tests (+14 over v1.2.0-alpha.3). New tests across two suites:

- **`chart.destroy()` (6 tests)** -- idempotency, working before
  `mount()`, disposing all owned signals across each kernel, zero
  residue across 30 mount+destroy cycles per kernel.
- **`createHeatmap polish` (8 tests)** -- row + column highlight
  rendering, `rowHighlight: false` / `columnHighlight: false`,
  quantile-bin count math, quantile color assignment with outliers,
  auto-contrast label color across the ramp, explicit
  `valueLabelColor` override path.

### Demo updates

- Heatmap section upgraded: `showValues: true` with auto-contrast
  labels; row + column highlights default on.
- Second heatmap added with `colorScale: 'quantile', colorBins: 6` for
  side-by-side comparison against the linear-ramp version above it.
- Demo title bumped to v1.2.0.

### License

MIT (c) Zahary Shinikchiev


## [1.1.0] -- 2026-06

### Added -- bar-chart layout polish

- **Stacked bars** via a `postExtract` hook on the bar renderer: pass
  `stacked: true` to a multi-series bar chart and series stack on top of
  one another per category (instead of grouping side-by-side). Negative
  values stack downward against zero. The Y domain auto-includes the
  stack maxima.
- **Rounded corners**: `cornerRadius: <px>` on a bar series rounds the
  TOP corners of each bar (or BOTTOM for negative-stack pieces). Uses
  native `ctx.roundRect` when available, falls back to four `arcTo`
  calls so it works on Canvas2D implementations without `roundRect`.
- **Hover tint**: passing a pointer position to the renderer's hit-test
  lets the bar under the cursor draw with a brightness shift. Default
  `+8%` on hover (configurable via `hoverTint: <0..1>`); the renderer
  reuses one cached tinted-color string per series so the hover path
  remains allocation-free across cursor moves within a single bar.

### Added -- bonus features present in this release

These were originally scoped for v1.2.0 alphas but landed in this build
and are tested + documented:

- **Spatial-index foundation** for bubble + scatter hit-tests
  (`SpatialIndex` / `SpatialIndexFactory` contract). Auto-engages at
  ~1000 points, falling back to O(n) below threshold.
- **`createScatterChart`** -- bubble's simpler sibling on the same axis
  kernel; constant marker size, no third dimension.
- **Multi-series bubble** with a global size domain (so a 30-radius
  point in series A and series B render at the same pixel radius) and
  per-point color via `colorKey`. Cross-series hit-test via
  `snapSeriesIdx`.
- **`createHeatmap`** on a new `createBaseGridChart` kernel -- categorical
  rows × columns, default linear color ramp, custom `colorFn(v, vMin,
  vMax)` for any mapping; sparse grids draw only present cells.

### Internals

- Charts now report `chart.plotBounds` as a version-counter signal --
  subscribe to react to size changes without dragging in DOM observers.
- DPR-aware canvas sizing reproduces the same backing-buffer math whether
  mounted onto a real `<canvas>` or a test mock with explicit `width` /
  `height`.
- `_testHelpers` export kept at the same surface for white-box tests
  (decimation kernel, scale builders, accessor factory).

### Performance contract

Empirical, sampled under `--expose-gc` (`node --expose-gc bench/line-100k.mjs`):

- **`chart.redraw()` steady-state**: 0.54 B/call -- true zero-allocation
  (sub-8-byte noise floor).
- **`data.set(reused) + redraw`**: ~89 B/call (signal mechanics + draw).
- **Full live cycle** (object literal + `await drainMicrotasks`): ~65 B/cycle
  (the 32 B literal + ~33 B Promise/await overhead are the call-site cost,
  not the library).
- **100k-point line chart** full update cycle: **p95 = 5.68 ms** (193 fps
  ceiling) on Node 22; fits in 60fps and 120fps budgets.
- **Canvas calls per draw** (decimated mode): ~3393 -- bounded by occupied
  columns + axis ticks + spines, not by data length.

### Tests

231 tests across 46 describe blocks (node:test, `--expose-gc` for the
optional zero-GC kernel test); covers every chart factory's lifecycle,
reactivity, interpolation modes, marker shapes, refresh-theme,
auto-resize, plot-rect clipping, DPR sizing, crosshair zero-alloc,
tooltip-pool identity, multi-series domain union, custom xScale.domain,
band/linear scale math, pie/donut/radar geometry, bubble spatial index,
scatter hit-test, heatmap cell rendering, and the mock-canvas contract.

### Bug fixes during this release audit

- Mock test harness was missing `strokeRect` -- added (heatmap calls it).
- Test file forgot to import `createScatterChart` + `createHeatmap` from
  `Charts.js` -- added (18 false failures resolved).
- Demo's hero-loop `frameSamples.push(dt); shift()` allocated every
  frame past the first 60; converted to a fixed-cap `Float64Array` ring
  buffer. The 4Hz stats interval's `frameSamples.slice().sort()` also
  allocated; switched to a reusable `Float64Array` scratchpad sorted
  in-place.
- Demo title + brand-version badge + release eyebrow were stale at
  `v1.0.0`; updated to `v1.1.0`.
- `package.json` test script had no path glob; now `test/*.test.js`.

### License

MIT (c) Zahary Shinikchiev
