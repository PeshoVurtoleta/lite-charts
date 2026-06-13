# Roadmap

This file tracks both the forward plan and the development history that
preceded the v1.0.0 publish.

---

## v1.2.0-alpha.3 (current)

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

### v1.2.0 -- Heatmap + dense bubble + scatter

- **`@zakkster/lite-delaunay` integration** *(shipped in alpha.0)* --
  sweepline Delaunay -> half-edge mesh -> Voronoi-dual walk for the
  cursor's enclosing cell. Pre-allocated arena (no per-frame `new`).
  alpha.0 shipped the integration layer + reference implementation
  in the demo; the actual Delaunay-backed factory lives in
  `@zakkster/lite-delaunay` itself and users wire it through
  `spatialIndex: createDelaunayIndex`.
- **`createScatterChart`** *(shipped in alpha.1)* -- bubble's simpler
  sibling, no size dimension. Reuses the spatial-index foundation
  with `k = 1`.
- **Multi-series bubble + per-point color encoding**
  *(shipped in alpha.2)* -- `BUBBLE_RENDERER` gained `colorKey` config
  (per-point color from data field) and the `series: [...]` shape.
  Global size domain across visible series so equal values render
  equal-area regardless of which series.
- **`createHeatmap`** *(shipped in alpha.3)* -- new
  `createBaseGridChart` kernel. Two band scales (x + y), flat
  Float32Array cell storage, Uint8 presentMask for sparse data,
  per-cell color strings precomputed at extract. Default linear-RGB
  interp ramp; `colorFn` for custom mappings. Hit-test is O(1).
  Bundle ~10.5 KB -- the smallest of the nine. Per-row /
  per-column highlight on hover and value labels (`showValues`) are
  planned for v1.2.0-final.

### v1.3.0 -- SVG export

- **`chart.exportSVG()`** across all seven chart types. Mirrors every
  draw fn through SVG path commands (`M`/`L`/`C`/`A`) instead of
  `ctx.moveTo`/`lineTo`/`bezierCurveTo`/`arc`. Reuses every
  projection function (scale.map, computeRadarGeometry, etc.) so the
  output is pixel-identical to the canvas. Stand-alone string,
  embeddable in `<img>` / downloadable / paste-into-Figma.
- Internal refactor: each `make*DrawFn` factory will get a sibling
  `make*SvgEmitter` that takes a path-emitter object instead of
  `ctx`. Path emitters are tiny (~10 LOC each); the heavy lifting
  stays in the per-renderer geometry helpers.

### v1.4.0 -- Interaction primitives

- **Log scale** -- `xScale: { type: 'log', base: 10 }` and same for y.
  Affects axis tick generation, scale.map, scale.invert. Bisect
  hit-test stays in data space so behavior is unchanged for users.
- **Pan + zoom** -- mouse-drag pans, wheel zooms. Driven by signals so
  bounded-history undo/redo is one signal-snapshot call away. Constrains
  to data domain by default; `panBounds: 'free'` opts out.
- **Brushing** -- click-drag selects a region; emits a `brushSignal`
  that downstream code can subscribe to for cross-chart filtering.

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

- **WebGPU rendering path** -- compute-shader projection for
  multi-million-point scatter, instanced bar rendering. Optional;
  the canvas path stays the default.
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
