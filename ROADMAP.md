# Roadmap

This file tracks both the forward plan and the development history that
preceded the v1.0.0 publish.

---

## v1.4.0 (current)

Three new interaction primitives on axis-kernel charts (log scale, pan +
zoom, brushing) plus four pre-existing allocation traps closed during a
bare-metal audit. See CHANGELOG.md for the full v1.4 details across the
alpha line; the entries below track v1.3.0 and earlier.

---

## v1.3.0

Every chart now exports as a static SVG. `chart.exportSVG(opts?)` walks
the live `scene.root` through a Canvas2D-shaped shim that emits SVG
markup instead of issuing pixel ops -- the chart's draw callbacks don't
know they're rendering to SVG, so the geometry is identical to the
canvas paint (minus subpixel rasterization and DPR scaling).

**New in this cut:**

- **`chart.exportSVG(opts?)` on every chart.** Returns a complete
  `<svg>...</svg>` string with `xmlns`, `viewBox`, `width`, `height`
  -- droppable into HTML pages, PDFs, image-converter pipelines, or
  diffable test fixtures. The chart must be mounted; mock canvases
  work fine (SVG export doesn't read pixel data).
- **`SVGExportOptions.background`.** Defaults to the chart's
  construction-time `background`; passing `null` explicitly produces
  a transparent SVG even when the chart was constructed with a fill.
- **Bar category-label centering bug fixed.** The band-axis builder
  passed `anchor: 'center'` to a lite-scene `textNode` that expects
  `align:`. The wrong key was silently dropped, leaving `_align`
  at its default `'left'`. Single-character labels masked the issue;
  multi-character category names were offset right by half a glyph
  width. Found while wiring SVG export -- the canvas visual mostly
  hid it, but SVG's explicit `text-anchor` attribute made it
  obvious. Fix is a one-key change; both canvas and SVG output
  benefit.

**Bundle deltas (vs v1.2.0):** every chart picks up ~8.9 KB of SVG
infrastructure (the shim class implements enough of Canvas2D to
cover everything lite-scene's draw walker calls). The shim, the
scene walker, and the `_exportSceneToSVG` entry point are bundled
into every chart that exposes `exportSVG` (which is all of them).
The all-nine bundle grows by only ~9.6 KB (not 9 x 8.9) because
the SVG helpers are shared module-level functions deduplicated by
the bundler when more than one kernel is imported.

| Chart | Kernel | Bundle (min) | v1.2.0 |
|---|---|---|---|
| `createLineChart`    | axis kernel  | ~32.5 KB | 23.6 |
| `createAreaChart`    | axis kernel  | ~33.8 KB | 24.9 |
| `createBarChart`     | axis kernel  | ~33.8 KB | 24.9 |
| `createBubbleChart`  | axis kernel  | ~33.6 KB | 24.8 |
| `createScatterChart` | axis kernel  | ~30.8 KB | 21.9 |
| `createPieChart`     | polar slice  | ~22.1 KB | 13.3 |
| `createDonutChart`   | polar slice  | ~22.1 KB | 13.3 |
| `createRadarChart`   | radar kernel | ~22.0 KB | 13.1 |
| `createHeatmap`      | grid kernel  | ~21.6 KB | 12.7 |
| **all nine**         |              | **~82.4 KB** | **72.8** |

Cross-kernel isolation remains clean since the SVG helpers are shared
module-level functions, not kernel-specific. Verified with esbuild
tree-shake: heatmap pulls zero axis/polar/radar code, and no other
chart pulls grid-kernel code.

---

## v1.2.0

The grid kernel ships with full polish, and a terminal-teardown
`chart.destroy()` lands across all four kernels.

**Highlights:**

- `chart.destroy()` on all four kernels. Zero residue across 30
  mount+destroy cycles per kernel.
- Heatmap row + column highlight stripes on hover.
- Quantile color binning (`colorScale: 'quantile'`, `colorBins`).
- Auto-contrast value labels (`valueLabelColor: 'auto'`).

---

## v1.2.0-alpha.3

Fourth kernel. `createHeatmap` rides a brand-new `createBaseGridChart`
that knows nothing about the axis, polar, or radar kernels. Verified
via esbuild tree-shake: heatmap bundle is **10.5 KB** -- the smallest
of the nine -- and pulls zero code from the other three kernels.

The grid kernel itself:
- Two band scales (x + y) reuse `makeBandScale` math; +y-down so
  `yBand.leftEdge(0)` is the topmost cell.
- Flat `Float32Array` for cell values, indexed `yIdx * nx + xIdx`.
- `Uint8Array` `presentMask` for sparse data -- missing cells render
  as empty space, hit-test returns null for them.
- Per-cell colors precomputed at extract time into a `string[]` so
  the draw loop is just `fillStyle = cellColors[i]; fillRect(...)` --
  zero allocation per cell.
- Hit-test is O(1): one `xBand.invert` + one `yBand.invert` + a
  mask check.

Default color ramp is linear RGB interpolation between two endpoint
hex colors. Pass `colorFn(value, vMin, vMax) -> css` for custom
mappings: OKLCH ramps, quantile binning, diverging schemes, etc.

| Chart | Kernel | Bundle (min) |
|---|---|---|
| `createLineChart`    | axis kernel  | ~23 KB |
| `createAreaChart`    | axis kernel  | ~25 KB |
| `createBarChart`     | axis kernel  | ~25 KB |
| `createBubbleChart`  | axis kernel  | ~25 KB |
| `createScatterChart` | axis kernel  | ~22 KB |
| `createPieChart`     | polar slice  | ~13 KB |
| `createDonutChart`   | polar slice  | ~13 KB |
| `createRadarChart`   | radar kernel | ~13 KB |
| `createHeatmap`      | **grid kernel** | **~10.5 KB** |
| **all nine**         |              | **~70 KB** |

Nine chart types across **four** strictly-independent kernels. Three
peer deps required (`lite-signal`, `lite-scene`, `lite-axis`);
`lite-delaunay` remains optional.

---

## v1.2.0-alpha.2

Two new chart types riding the spatial-index foundation from alpha.0,
plus per-point color encoding for bubble.

**`createScatterChart`** -- bubble's simpler sibling on the axis kernel.
No size dimension; every marker the same pixel radius. The spatial-
index integration works here too with `k = 1` (no overlap concerns).
Hit-test snaps to the nearest point within a configurable
`hitTolerance` disc. Renderer adds ~1.1 KB to the scatter bundle.

**Multi-series bubble + global size domain.** `createBubbleChart`
now accepts `series: [{name, data, color}, ...]` shape (in addition
to the v1.0.0 `data` shape). The new `postExtract` hook on
`BUBBLE_RENDERER` computes a GLOBAL size domain across visible
series, so equal raw values render at equal pixel radii regardless
of which series they belong to. Toggling visibility via the legend
recomputes the domain from surviving series and resizes the bubbles.
The single-series path stays the v1.0.0 fast path (postExtract no-op
when only one series is visible).

**Multi-series hit-test.** `_bubbleHitTest` now iterates all visible
series rather than only `primary`. The kernel passes
`ctx.seriesStates` so the renderer can scan every series' bubbles +
per-series spatial index. New `snapSeriesIdx` field on the hit
result + crosshair state identifies which series got hit; the
bubble's `lookupRow` uses it to scope the tooltip to just that
series.

**Per-point color (`colorKey`).** When set, each row carries its own
fill color. The extract step resolves CSS-var values to concrete
strings once, then the draw fn reads `state.cs[i]` per bubble --
no per-frame parsing. Omit `colorKey` and the v1.0.0 single-color
path stays in effect.

| Chart | Kernel | Bundle (min) | Notes |
|---|---|---|---|
| `createLineChart`    | axis kernel  | ~23 KB | |
| `createAreaChart`    | axis kernel  | ~25 KB | |
| `createBarChart`     | axis kernel  | ~25 KB | v1.1.0 stack / rounded / hover |
| `createBubbleChart`  | axis kernel  | ~24 KB | + spatial-index hook (alpha.0), + multi-series + per-point color (alpha.2) |
| `createScatterChart` | axis kernel  | ~24 KB | v1.2.0-alpha.1 |
| `createPieChart`     | polar slice  | ~14 KB | |
| `createDonutChart`   | polar slice  | ~14 KB | |
| `createRadarChart`   | radar kernel | ~13 KB | |
| **all eight**        |              | **~60 KB** | |

Eight chart types now ship across three independent kernels. Three
peer deps required (`lite-signal`, `lite-scene`, `lite-axis`);
`lite-delaunay` remains an optional fourth for charts that opt into
the O(log n) hit-test.

---

## v1.2.0-alpha.0

Spatial-index foundation -- the plumbing for O(log n) hit-test on dense
point clouds. Bubble was the first consumer; scatter joined it in
alpha.1. lite-charts defines the contract, the consumer plugs in the
implementation (`@zakkster/lite-delaunay`, k-d tree, uniform grid, etc.).

```ts
type SpatialIndexFactory = (pxs: Float32Array, pys: Float32Array, n: number) => SpatialIndex;

interface SpatialIndex {
    findNearest(qx, qy, k, maxDistSq, outIndices, outDistSq): number;
    dispose(): void;
}
```

The contract is deliberately small. `findNearest` writes into caller-
owned output buffers (no allocation per query). `k > 1` matters for
bubble specifically: when bubbles overlap, the point with the nearest
center may not be the one whose disc contains the cursor; the renderer
asks for K candidates and post-filters, preserving v1.0.0's "smallest-
on-top wins on overlap" semantics. For scatter / heatmap, the same
interface works with `k = 1`.

| Chart | Kernel | Bundle (min) | Notes |
|---|---|---|---|
| `createLineChart`    | axis kernel  | ~23 KB | |
| `createAreaChart`    | axis kernel  | ~25 KB | |
| `createBarChart`     | axis kernel  | ~25 KB | v1.1.0 stack / rounded / hover |
| `createBubbleChart`  | axis kernel  | ~23 KB | + spatial-index hook (v1.2.0-alpha.0) |
| `createPieChart`     | polar slice  | ~14 KB | |
| `createDonutChart`   | polar slice  | ~14 KB | |
| `createRadarChart`   | radar kernel | ~13 KB | |
| **all seven**        |              | **~58 KB** | |

Spatial-index code is bubble-bundle-only: the integration adds ~0.9 KB
to the bubble bundle and zero to line / area / bar / pie / donut /
radar (verified via esbuild). The kernel-side cleanup hook routes
through `renderer.cleanup` so the disposal helper doesn't get pulled
into non-bubble bundles.

`@zakkster/lite-delaunay` is now an **optional** peer dep -- users
who don't need O(log n) hit-test skip the install entirely. The
reference implementation in the demo (inline linear scan) proves the
contract without requiring the dep.

---

## v1.1.0

Bar layout polish: stacked bars + rounded corners + per-bar hover
tint. All three are opt-in; defaults match v1.0.0 exactly. See dev
history below for details.

---

## Forward plan

### v1.4.0 (next) -- Interaction primitives

Will ship in alphas before a combined release.

- **v1.4.0-alpha.0 -- Log scale.** `yScale: { type: 'log' }` (and
  `xScale` for time-series with exponential x). Adds a sibling to
  `makeLinearScale` whose `map`/`invert` use `Math.log` /
  `Math.exp`. Tick generation routes to `lite-axis`'s already-shipped
  `logTicks` (decade boundaries plus optional 2x / 5x sub-ticks
  per decade). Domain handling: non-positive data is the caller's
  responsibility -- chart will draw what it can if any positive
  values exist and warn-and-fallback to linear otherwise.
- **v1.4.0-alpha.1 -- Pan + zoom.** Mouse-drag pans, wheel zooms.
  Driven by a new `view` signal carrying `{ xMin, xMax, yMin, yMax }`
  so a bounded-history undo/redo is one signal snapshot away.
  Constrains to the data domain by default; `panBounds: 'free'`
  opts out. The view signal becomes the chart-side analog of
  `lite-camera-max`'s camera signal -- shape is intentionally
  symmetric so users can drop the chart's view-signal into a
  lite-gl `project` function unchanged (see lite-gl track below).
- **v1.4.0-alpha.2 -- Brushing.** Modifier-key drag (shift) selects
  a region; emits a `brushSignal` carrying `{ x: [min, max], y: [min,
  max], ids: number[] }` that downstream code can subscribe to for
  cross-chart filtering. Coexists with pan/zoom (no modifier = pan,
  shift = brush).

### Companion track -- `@zakkster/lite-charts-gl` (post-v1.4.0)

The GPU sibling for chart types currently bottlenecked by point count.
A separate package -- lite-charts proper stays canvas-only and ASCII-
disciplined.

**Why a companion package and not a renderer switch:** lite-gl is
browser-only (WebGL2). Adding a `renderer: 'canvas' | 'webgl'` switch
inside lite-charts would double the test surface for every chart
(mock WebGL2 contexts, browser-only paths, conditional code branches).
Splitting at the package boundary keeps lite-charts node-testable end-
to-end while letting lite-charts-gl own the WebGL2 testing pattern that
lite-gl already established (mock-WebGL2-context unit tests, real GPU
in Playwright).

**Initial scope:**

- **`createScatterChartGL`** -- biggest immediate win. Scatter is
  point-count-limited (one `ctx.beginPath + arc + fill` per point
  in Canvas2D); the lite-gl POINT pipeline maps 1:1 (8 floats per
  point: `x, y, size, r, g, b, a, +1 pad`). Spatial-index hit-test
  stays on CPU (where it belongs -- `gl.readPixels` is a frame killer).
- **`createBubbleChartGL`** -- same kernel, the `size` field in
  the POINT layout makes per-point radius a free attribute.
- **`createDensityChart`** -- a tenth chart type, optimized for the
  100k-1M point range where scatter loses to overdraw. Aggregates
  into hex-bin or grid-cell counts; renders the cells via lite-gl
  (still allocation-free since cell-count is bounded).

**What's reused from lite-charts:** the axis kernel's tick builder
(canvas overlay for axes -- they're cheap and GL would be overkill
for tick text), the scale builders (`makeLinearScale`,
`makeBandScale`, the new `makeLogScale`), the configuration shape,
the lifecycle API (mount/unmount/destroy/exportSVG).

**Bench target:** 1M scatter points at 60fps with pan/zoom driving
re-projection. lite-gl's README claims it; the integration test
proves it.

### v1.5.0 -- Scale + polish

- **Time-series specialized variants** -- `createTimeLineChart` etc.
  with built-in date tick generation, weekday/weekend shading,
  market-hours awareness for finance dashboards.
- **Legend virtualization** -- via `@zakkster/lite-virtual` for charts
  with 100+ series (real-time monitoring dashboards). Renders only
  visible legend rows.
- **Annotation layer** -- arbitrary lines, ranges, and text labels
  pinned to data coordinates. Reactive, theme-aware.

### v2.0.0 -- (possible)

- **Renderer-agnostic kernel refactor.** If the lite-charts-gl
  companion proves out, fold the renderer choice into the lite-charts
  core. Big lift -- the kernel pattern would need to abstract
  scene-tree drawing from primitive-stream drawing.
- **Deeper SSR support** -- server-render to inline SVG via the same
  draw fns; client hydrates without re-extraction.

---

## Development history

Internal development went through staged alpha cuts to validate the
kernel-pattern architecture before publish. Public consumers see only
v1.0.0+; this section is reference for future maintainers who want
to understand why the kernels are split the way they are.

### Initial -- single-file ESM, line + area only

- 871-line `Charts.js`, monolithic `_createChartImpl`
- 78 tests, oscilloscope-themed 4-scene demo
- Honest benchmarks vs alien-signals on the MUX scenario
- `llms.txt` + Mermaid-diagrammed README from day one

### alpha.0 -- architectural refactor

- Extracted `_createChartImpl` into `createBaseAxisChart(config, renderer)`
- Renderer-object pattern: LINE_RENDERER, AREA_RENDERER, BAR_RENDERER each
  parameterize the kernel with `buildXAccessor`, `extractData`,
  `makeDrawFn`, `hitTest`, etc.
- This refactor was the precondition for everything that followed --
  tree-shaking only works when the kernel doesn't mention renderer names
  by string.

### alpha.1 -- pie + donut on a separate kernel

- `createBasePolarChart(config, renderer)` + `SLICE_RENDERER`
- Polar state struct: Float64 angles (Float32(PI/2) widens enough to
  misclassify exact-boundary hits)
- O(n) atan2 hit-test (n typically 3-12, binary search overkill)
- Per-slice legend with click-to-toggle visibility
- Pie + donut share `SLICE_RENDERER`; only `innerRadius` default differs
- Pie bundle = 13 KB minified (no axis kernel pulled in); verified

### alpha.2 -- slice color resolution bug fix

- `makeSliceDrawFn` was passing raw `state.colors[i]` (e.g.
  `'--c-primary'`) into `ctx.fillStyle`. Canvas silently ignores invalid
  color strings -> every slice rendered with the previous fill style
  (white in practice).
- Fix: stable `resolvedColors` array reference, mutated in place by
  `refreshResolvedColors` so theme changes propagate without recreating
  the draw fn.
- Demo: added `responsiveWidth(containerId, fallback)` ResizeObserver
  helper (later subsumed by kernel-side auto-resize in v1.0.0).

### alpha.3 -- bubble chart

- `BUBBLE_RENDERER` on the existing axis kernel
- Each point gets a circle whose AREA scales with a third value
- Default sqrt scale: `r = sqrt(rMin^2 + t * (rMax^2 - rMin^2))`
  (Tukey 1977 convention -- equal pixel area per equal magnitude)
- New state fields `state.rs` (raw sizes) and `state.prs` (pixel radii) --
  both null on non-bubble series, zero memory cost
- Hit-test signature extended on the axis kernel from
  `hitTest(canvasX, primary, xScale, ctx)` to
  `hitTest(canvasX, canvasY, primary, xScale, ctx)`. Existing line/area/
  bar tests ignore canvasY; bubble uses both for circle-containment.
- Smallest-on-top tie-breaking on overlap

### alpha.4 -- radar chart

- Third independent kernel (`createRadarChart` directly, no renderer
  indirection until a second variant exists)
- `computeRadarGeometry` precomputes cos/sin per axis into Float64
  tables (~96 bytes per chart). Polygons, grid rings, and spokes share
  them -- zero per-frame trig.
- Auto-domain anchors at 0 when min/max ratio < 0.5 (scored-radar
  convention)
- `radarHitTest` is nearest-vertex within 12 px across visible series
  (O(series x axes), typical < 70 distance comparisons per mousemove)
- Spoke labels auto-align based on angular position
- 18 new tests, 176 total

### v1.0.0 -- kernel-side auto-resize + publish

- `_wireAutoSize(container, widthAutoSig, heightAutoSig, disposers)`
  shared helper across all three kernels
- Three modes per dimension: explicit static, explicit reactive
  (signal/fn), or implicit (omitted -> auto-observe container)
- Synchronous initial read avoids the size "pop" on first frame
- rAF-throttled updates coalesce burst resize events into one re-extract
- Falls back gracefully when ResizeObserver isn't available (Node,
  ancient browsers) -- keeps default size instead of throwing
- Bundles grew ~400 bytes per chart for the shared helper; final sizes
  in the table above
- 6 new auto-resize tests, 182 total

### v1.1.0 -- bar polish (stacked + rounded + hover)

- New `postExtract(states, ctx)` hook on the renderer interface. Default
  none; the kernel calls it after the per-series extract loop and
  re-aggregates y-domain afterward. Bar uses it for stacking; other
  renderers don't define it and pay only a single null-check.
- `computeBarStacks(states, visibility, categoriesRef)` walks categories
  and accumulates cumulative y across visible series in declaration order.
  Per-series `state.stackBottoms` / `state.stackTops` Float32Arrays are
  lazy-allocated via `ensureFloat32` -- null on non-stacked series so
  the cost is zero when stacking is off.
- Visibility-aware: hidden series are excluded from the accumulator;
  toggling the legend rebuilds the stack with surviving segments
  snapping down. Each series' `domainYMax` is overwritten with the
  global stack max so the kernel's existing y-domain union picks up
  the total stack height -- the kernel stays stacking-agnostic.
- Negative values clamp to 0 in MVP. Diverging stacks (positive +
  negative around a baseline) deferred.
- `_roundRectPath(ctx, x, y, w, h, rTL, rTR, rBR, rBL)` per-corner
  helper. Uses native `ctx.roundRect` where available (Chrome 99+,
  Firefox 113+, Safari 16+), falls back to hand-traced `arcTo` path.
  Each corner radius clamped to `min(w, h) / 2` so thin bars never
  have overlapping arcs.
- Rounded corners apply to the END opposite the baseline so bars look
  anchored: top for positive, bottom for negative. Stacked middle
  segments are positive but their top corners get visually capped by
  the segment above; only the topmost segment's rounding is visible.
- Per-bar hover tint via a CSS-color overlay (default low-alpha white)
  keyed on the chart's `crosshairDataRef.snapIdx`. No color parsing --
  the tint is fixed and works against any series color. Opt out with
  `hoverTint: false`.
- Bar bundle grew from ~23 KB to ~25 KB (1.6 KB for the new code).
  Line / area / bubble bundles each gained ~300 bytes for the kernel's
  null-check on the `postExtract` hook. Pie / donut / radar unchanged
  (different kernels).
- Tree-shake verified: `dist-line.js`, `dist-pie.js`, `dist-radar.js`,
  `dist-bubble.js` contain no references to `computeBarStacks`,
  `stackBottoms`, `_roundRectPath`, or `arcTo`.
- 11 new tests covering: cumulative per category, y-domain total,
  visibility-aware re-stacking, negative clamp, stack-off buffer
  clearing, fill count for stacked draw, `cornerRadius > 0` switching
  to `roundRect` path, `cornerRadius = 0` keeping the `fillRect` fast
  path, oversized radius clamping, hover tint adding an extra fill,
  `hoverTint: false` disabling the overlay. 196 total.

### v1.2.0-alpha.0 -- spatial-index foundation

- Defined `SpatialIndex` / `SpatialIndexFactory` contract as a public
  interface in `Charts.d.ts`. Two methods on the index: `findNearest`
  with caller-owned output buffers (zero alloc), `dispose`. The
  factory builds from `(pxs, pys, n)` typed arrays.
- Wired into `BUBBLE_RENDERER`. Config gains `spatialIndex` (factory)
  and `spatialIndexThreshold` (default 1000). Below threshold, the
  v1.0.0 linear scan stays the path -- on small clouds the build
  cost would exceed the query savings.
- Lazy build: extract disposes any existing index (data / scale change
  invalidates it); the next hit-test rebuilds. No build cost if the
  user never hovers.
- `k > 1` in `findNearest` matters for bubble: when discs overlap, the
  point with the nearest center may not be the one whose disc contains
  the cursor. The renderer asks for `K = 8` candidates and post-filters
  by disc containment + smallest-r tie-break, preserving v1.0.0
  "visually-topmost wins on overlap" semantics. Scatter / heatmap will
  use the same interface with `k = 1`.
- New `cleanup(states)` hook on the renderer interface (symmetric with
  v1.1.0's `postExtract`). `BUBBLE_RENDERER.cleanup` disposes spatial
  indices on chart unmount; line / area / bar don't define it, so the
  disposal helper is not pulled into their bundles.
- Cached `state.prMaxSq` (max pixel-radius squared) at extract time so
  hit-test passes the spatial index a tight upper bound. Cached
  `state._hitIndices` (Int32Array(8)) and `state._hitDistSq`
  (Float32Array(8)) as the output buffers -- stable refs, zero alloc
  on hot path.
- Bubble bundle grew from ~22 KB to ~23 KB. Line / area / bar / pie /
  donut / radar bundles unchanged from v1.1.0. Tree-shake verified:
  no spatial-index symbols leak into non-bubble bundles.
- `@zakkster/lite-delaunay` added as **optional** peer dep (via
  `peerDependenciesMeta.optional`). Users who don't need O(log n) hit-
  test skip the install entirely.
- 8 new tests covering: no build below threshold, lazy build on first
  hit-test, cached across queries, disposal on unmount, custom
  threshold honored, indexed-result matches linear-scan, rebuild on
  data change, smallest-on-top tie-break with k > 1. 204 total.
- Demo: new "Dense bubble" section with N = 2000 points and an inline
  reference SpatialIndex implementation (linear scan) -- proves the
  integration end-to-end without requiring `@zakkster/lite-delaunay`
  to be installed.

### v1.2.0-alpha.1 -- createScatterChart

- New `SCATTER_RENDERER` on the axis kernel. ~120 LOC including helpers.
  Eighth chart type ships; same three-kernels-strictly-independent
  architecture holds.
- Config: `markerSize` (pixel radius, default 4) and `hitTolerance`
  (default `markerSize + 4`). Hit-test snaps to the nearest point
  within the tolerance disc.
- Spatial-index integration with `k = 1` (no overlap concerns). Below
  threshold (default 1000) linear scan stays the path.
- `_extractScatterData` disposes any existing spatial index per-extract
  so the index rebuilds lazily on data / scale change.
- `_scatterCleanup` symmetric with bubble's: disposes indices on
  unmount.
- Scatter bundle ~24 KB. Adds nothing to line / area / bar / bubble /
  pie / donut / radar bundles (verified).
- 6 new tests: arc-per-point render, constant markerSize, in-tolerance
  hit, out-of-tolerance miss, spatial-index above threshold, no index
  below threshold.

### v1.2.0-alpha.2 -- multi-series bubble + per-point color

- `BUBBLE_RENDERER` gains a `postExtract` hook (`_bubblePostExtract`)
  that computes a GLOBAL size domain across visible series and
  re-runs `computeBubbleRadii` on every state. Single-series charts
  short-circuit -- the v1.0.0 fast path stays in effect when only
  one series is visible.
- Per-series state gets `state._stateIdx = i` at construction so the
  bubble's `lookupRow` can tell which series got hit and scope the
  tooltip to that series. Crosshair state gains `snapSeriesIdx`
  (default -1 -- non-bubble charts never set it).
- `_bubbleHitTest` iterates `ctx.seriesStates` rather than checking
  only `primary`. Each visible series' bubbles get tested (linear
  scan or spatial index, per its threshold). Returns
  `snapSeriesIdx` along with `snapIdx`.
- `_initBubbleOpts` gains `colorKey` (string / number / fn). Set this
  to enable per-point color encoding. The accessor uses
  `buildRawAccessor` (not `buildAccessor`) so color strings like
  `'#ff0000'` are not `+v`-coerced to NaN.
- `extractBubbleData` extracts per-point colors into `state.cs`
  (plain string Array, lazy-allocated). Colors resolve once via
  `resolveColor` at extract time -- CSS-var values like
  `'--c-emerald'` become concrete strings the draw fn writes to
  `ctx.fillStyle` directly.
- Bubble draw fn picks `state.cs[i]` per row when set, falling back
  to the series fill otherwise. Zero hot-path cost when `colorKey`
  is unset.
- Bubble bundle grew from ~23 KB to ~24 KB (per-point color +
  multi-series hit-test + postExtract for global size domain).
- Test infrastructure: bumped the lite-signal default registry to
  `maxNodes: 32768` so the test suite's 200+ chart-creations don't
  exhaust the default 1024-node arena.
- 9 new tests: global size domain, equal radii across series,
  single-series skips rescale, cross-series hit, lookupRow scopes
  to hit series, hidden series excluded from hit, per-point colors
  extracted, colorKey omitted means no state.cs, draw fn uses
  per-point colors. 219 total.

### v1.2.0-alpha.3 -- createHeatmap + fourth kernel

- New `createBaseGridChart(config, renderer)` kernel. Strictly
  independent from axis / polar / radar kernels -- no cross-kernel
  imports either direction. Verified via esbuild tree-shake:
  heatmap bundle contains no `createBaseAxisChart` /
  `createBasePolarChart` / `createRadarChart` / `BUBBLE_RENDERER`
  / `SLICE_RENDERER` / etc.; the existing axis bundles contain no
  `createBaseGridChart` / `HEATMAP_RENDERER` / `_parseHexColor` /
  `_lerpRGBString` / `_gridHitTest`.
- Two band scales (x + y) reuse the existing `makeBandScale` math.
  The y band scale uses the same +y-down pixel convention, so
  `yBand.leftEdge(0)` is the topmost cell.
- Cell storage: flat `Float32Array` indexed `yIdx * nx + xIdx`;
  `Uint8Array` `presentMask` for sparse data (missing cells render
  as empty space, hit-test returns null for them). Grow once per
  data change; never shrink (next extract reuses the capacity).
- Color computation: per-cell color strings precomputed at extract
  time into `state.cellColors: string[]`. The draw loop just
  reads `cellColors[i]` per cell -- zero allocation per frame.
  Default ramp is linear RGB interpolation between two endpoint
  hex colors via `_parseHexColor` + `_lerpRGBString`. The
  `colorFn(v, vMin, vMax) -> css` config overrides entirely for
  OKLCH ramps, quantile binning, diverging schemes, etc.
- Hit-test: O(1) -- one `xBand.invert` + one `yBand.invert` + a
  presence-mask check. Returns `{xi, yi, value}` or null.
- Chart API: `chart.hover` is a reactive accessor (signal-style
  with a `.peek()` escape hatch, matching the bubble crosshair
  shape). Mouse events on the canvas drive `moveHover` /
  `hideHover` automatically; tests can drive them manually too.
- Axis labels render inline (no lite-axis dep for the grid kernel
  since categories are arbitrary strings, not numeric ticks).
  Bottom-aligned x labels, right-aligned y labels.
- Hover highlight: a stroke around the hovered cell + a simple
  inline tooltip. `tooltipFormat` for custom text;
  `highlightStroke` / `highlightStrokeWidth` for the outline style.
- Heatmap bundle: 10.5 KB minified -- the smallest of the nine,
  because the grid kernel has none of the axes / interpolation /
  decimation / markers / multi-series / scale-math weight of the
  axis kernel. All-nine total: ~70 KB.
- Test infra: added `strokeRect` to the mock-canvas method list
  (the heatmap's hover highlight is the first lite-charts code
  path that calls it).
- 12 new tests: category first-seen order, vMin/vMax computation,
  one fillRect per cell, sparse data, default ramp interpolation
  hits exact endpoints, custom colorFn overrides, hit-test resolves
  to the correct cell, hit-test null on missing cells, hit-test
  null outside plot, reacts to data signal updates, showValues
  renders labels, clean mount + unmount. 231 total.

### v1.2.0 -- destroy() + heatmap polish

- **`chart.destroy()` across all four kernels.** Each kernel tracks
  every signal it creates at construction time in a per-instance
  `_ownedSignals` array (via a small `_own(s)` helper); `destroy()`
  calls `unmount()` first if mounted, then iterates the array and
  calls lite-signal's `dispose()` on each. The visibility-growth
  paths in polar (`ensureVisibilitySignals`) and radar
  (`ensureSeriesSlots`) push new signals through `_own` too so the
  array stays in sync as series counts change. Verified zero
  residue across 30 mount+destroy cycles on every kernel; idempotent;
  works before `mount()` (signals exist before mount, so they need
  cleanup even if the chart was never displayed).
- **Heatmap quantile binning** (`colorScale: 'quantile'`,
  `colorBins`). Collect present values, sort ascending, place N-1
  internal boundaries at the i/N percentiles. Pre-compute one
  color per bin from the same lo/hi ramp; per-cell assignment is a
  linear scan through the boundaries (typically 4-19 comparisons).
  Faster than a binary search at this size and zero-alloc on the
  per-cell path. Outliers no longer dominate the ramp: with 11
  values in [1,11] plus one at 1000, the linear path collapses 11
  of 12 cells to nearly the lowest ramp color, while quantile bins
  spread them evenly across the chart.
- **Heatmap row + column highlights.** On hover, fill stripes the
  full plot width (row) and full plot height (column) at the band
  width of the hovered cell before the cell stroke. Both default on;
  either can be disabled via `rowHighlight: false` /
  `columnHighlight: false`. Stripe color (`rowColumnHighlightFill`,
  default `rgba(0,0,0,0.10)`) is resolved against the container at
  mount time so CSS-vars work.
- **Auto-contrast value labels.** `valueLabelColor` default changed
  from `'#ffffff'` to `'auto'` for `showValues: true`. Per-cell:
  NTSC luminance (`0.299R + 0.587G + 0.114B`) picks `#000000` /
  `#ffffff` so labels stay readable across the ramp. Computed at
  extract time alongside the cell color (no extra pass), stored in
  `state.cellLabelColors`. For custom `colorFn` outputs, the
  `_parseRGBLike` helper handles `rgb(...)` and hex strings;
  unparseable returns (named colors, `oklch()`, `rgba()`) fall
  through to `#ffffff`. Explicit `valueLabelColor` (any non-
  `'auto'` value) skips the per-cell allocation entirely.
- Helpers added: `_pickContrastColor(rgb) -> '#000'|'#fff'`,
  `_parseRGBLike(css) -> [r,g,b]|null`.
  Helper removed: `_lerpRGBString` (the linear and quantile paths
  now inline the lerp because they need access to the integer R/G/B
  triple for `_pickContrastColor`).
- Test infra: added 14 new tests across two suites
  (`chart.destroy()` and `createHeatmap polish`). 245 total.
- All ASCII clean except for the U+00D7 (`x`) glyph already
  whitelisted in the source-style rule.

### v1.3.0 -- chart.exportSVG() across all four kernels

- **`_SVGRenderingContext2D` Canvas2D shim** (~270 LOC in Charts.js,
  inserted between `resolveColor` and the renderer-objects boundary).
  Tracks CTM as a 2x3 matrix `[a, b, c, d, e, f]`; full save/restore
  state stack snapshots `ctm`, `fillStyle`, `strokeStyle`, `lineWidth`,
  `lineCap`, `lineJoin`, `lineDash`, `globalAlpha`, `font`, `textAlign`,
  `textBaseline`, `clipPathId`. Method coverage spans:
  `save`/`restore`; `translate`/`rotate`/`scale`/`setTransform`/
  `resetTransform`; `beginPath`/`closePath`/`moveTo`/`lineTo`/
  `bezierCurveTo`/`quadraticCurveTo`/`rect`/`arc`/`arcTo`/`roundRect`;
  `stroke`/`fill` emit `<path d="...">` elements; `fillRect`/`strokeRect`
  emit `<rect>` via an `_axisAligned()` check (CTM has no rotation/skew
  -> direct rect; otherwise falls through to a path); `fillText`/
  `strokeText` emit `<text>` with `text-anchor` + `dominant-baseline`
  derived from canvas `textAlign`/`textBaseline`; `setLineDash`/
  `getLineDash`; `clip()` emits a `<clipPath id="...">` def then marks
  subsequent emissions with `clip-path="url(#id)"`; `toSVG(background)`
  wraps the buffer with `<svg xmlns viewBox width height>` + optional
  background `<rect>`. `measureText` returns `{ width: text.length *
  size * 0.55 }` -- a Latin-text approximation that's good enough for
  layout heuristics since the chart was typically laid out against a
  real canvas first. `drawImage` + gradients are silent no-ops (none
  of the v1.3.0 chart code touches them).
- **`_drawNodeToSVG` + `_drawSelfToSVG` walker.** Structural mirror of
  lite-scene's `drawNode`/`drawSelf` that walks the live `scene.root`
  through the shim. Handles every node kind lite-scene supports:
  `rect` (with `_radius` -> shim's `roundRect`), `circle` (-> `arc`),
  `line` (-> `moveTo` + `lineTo` + `stroke`), `text` (-> `font`/`align`
  /`baseline` + `fillText`/`strokeText`), `path` (delegates to the
  node's `_draw(ctx, n)` callback), `group` with optional `_clip`
  function. Kept in sync structurally with lite-scene's drawNode at
  v1.x; any new node kind or transform property there needs a matching
  branch here.
- **`_exportSceneToSVG(scene, width, height, background)`** entry
  point. Each kernel's `chart.exportSVG(opts?)` calls this with its
  current dimension signals and the resolved background:
  ```js
  const exportSVG = (opts) => {
      if (!mounted || !scene) throw new Error('lite-charts: exportSVG() requires mount() first');
      const w = +widthAcc() | 0 || 800;
      const h = +heightAcc() | 0 || 400;
      const bg = (opts && opts.background !== undefined)
          ? opts.background
          : (config.background != null ? config.background : null);
      return _exportSceneToSVG(scene, w, h, bg);
  };
  ```
  Axis kernel binds `exportSVG` in the chart object literal next to
  `exportPNG`. Polar / radar use inline `exportSVG: (opts) => {...}`.
  Grid kernel binds via `chart.exportSVG = exportSVG` next to the
  `destroy` bind.
- **Pre-existing bar-label centering bug fixed** at Charts.js line
  1329. The band-axis builder passed `anchor: 'center'` to a lite-scene
  `textNode` that expects `align:`. The wrong key was silently dropped,
  leaving `_align` at its default `'left'`. Canvas's
  `ctx.textAlign = 'left'` masked it for single-character labels
  ("A", "B", "C") since each glyph was narrow; multi-character names
  ("Mon", "Tue", "Wed") were visibly offset right by half a glyph
  width. Surfaced by SVG export -- canvas paint sometimes hides
  alignment errors visually, but SVG's explicit `text-anchor`
  attribute makes them unmissable. Fix: one-key change. Both canvas
  and SVG output benefit going forward.
- **Why a context shim, not nine per-kernel exporters.** Two reasons.
  First, the shim guarantees pixel parity since the same projection
  math runs whether the output is canvas or SVG. Second, the shim
  ships in one place and works for every chart automatically -- nine
  per-kernel `exportSVG` methods would each need their own draw-call
  enumeration and would drift from canvas behavior over time. The
  trade-off is less semantic SVG output (everything is `<path>` /
  `<rect>` / `<text>` instead of, say, one `<rect>` per heatmap cell
  with `data-row`/`data-col` attributes). A future v1.3.x or v1.4
  could opt-in to richer per-chart semantics; for v1.3.0 the
  pixel-parity approach is the right call.
- **Why `_axisAligned()` for fillRect / strokeRect**. Most chart code
  draws axis-aligned filled rects (heatmap cells, bar fills, axis
  spines). For those, emitting `<rect x y width height>` is smaller
  and more semantic than `<path d="M.. L.. L.. L.. Z">`. The
  check is `m[1] === 0 && m[2] === 0` -- a one-line guard that
  covers the 99% case. Rotated rects fall through to path emission.
- **Tests:** 14 new tests under `describe('chart.exportSVG()
  (v1.3.0)')`. Coverage: valid `<svg>` envelope per chart type
  (line, area, bar, bubble, scatter, pie, donut, radar, heatmap);
  rounded-corner arcs on bars (verifies `roundRect` -> SVG arc
  commands); fixed `text-anchor="middle"` on bar labels
  (regression guard for the band-axis fix); XML escaping of
  `&`/`<`/`>` in label text; `background` option emits a
  background `<rect>`; throws when called before mount; throws
  after destroy. 259 total.
- **Types:** `SVGExportOptions` interface added; `Chart.exportSVG()`,
  `RadarChart.exportSVG()`, `PolarChart.exportSVG()` all declared.
  `RadarChart` and `PolarChart` also picked up the v1.2.0 `destroy()`
  that was missing from their specialized interfaces.
- All ASCII clean.

---

## Architectural constraints (in force)

These have been load-bearing since alpha.0 and shouldn't change without
a major-version bump:

- **Four kernels, strictly independent.** No cross-kernel imports.
  Axis kernel knows nothing about polar slices, radar polygons, or
  the grid kernel -- and vice versa. The tree-shake property depends
  on this and is verified with esbuild in CI.
- **Renderer-object pattern within a kernel.** Adding a chart type that
  fits an existing kernel = one renderer object + factory line.
- **Float64 for angles.** Float32(PI/2) is far enough from the IEEE-754
  representation of PI/2 that exact-boundary hits land in the wrong
  slice / wrong angular bucket.
- **Hot-path zero-allocation.** The render fn never allocates. Float32
  arrays for hot data, stable object references mutated in place
  (`plotBoundsBox`, `domainRef`, `resolvedColors`), `ensureFloat32`
  growth pattern for resizable buffers.
- **ASCII-only source.** The two exceptions in code: U+00D7 (`x` for
  multiplication, in comments only) and U+00B5 (`u`, for "microseconds"
  in bench output).
- **Single PascalCase ESM file.** `Charts.js`, no build step required
  to consume.
- **`node:test`, not vitest.** No dev-dep on test framework.
- **Copyright "Zahary Shinikchiev" everywhere.** Never "Karadjov".
