# Changelog

All notable changes to `@zakkster/lite-charts` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.18.0] -- 2026-09

### Added

- **Cluster-outlines layer on `createScatterChart`** -- `outlines: { index,
  groupKey, alpha?, stroke?, strokeWidth?, fill?, fillOpacity?, dash? }`.
  One boundary outline per point group: the convex hull when `alpha` is
  absent, the concave alpha shape (`alpha` = a radius in pixel units,
  finite `> 0`; `Infinity` throws) when present. Fourth rung of the
  injection ladder (`spatialIndex` -> `cells` -> `field` -> `outlines`):
  geometry comes from an injected `ClusterIndexFactory` (optional peer
  `@zakkster/lite-delaunay` bumped `^1.3.0` -> `^1.4.0`,
  `createClusterIndex(maxPoints)`; `Charts.js` still imports nothing).
- Rows partition by the RAW `groupKey` value (SameValueZero,
  insertion-ordered, AoS rows only; a `== null` key value means no group).
  Per-group pixel subsets are packed cold with non-finite rows skipped; one
  handle is built per group per refresh on the `postProject` seam and
  disposed before the next build (pixel space is not affine-stable across
  anisotropic zoom). `convexHull`/`alphaShape` results land in pooled
  buffers sized to the published SAFE bounds (`3n` indices / `n` loop
  ends); boundary loops bake into flat pooled geometry.
- Draw: one scene node above the cells node, below the markers, inside the
  plot clip, walking prebuilt geometry at 0 B/frame -- per group one
  optional fill path over ALL its loops (nonzero fill rule + the mesh's
  opposite-wound hole loops carve holes out) followed by one stroke path;
  dash resets via the module-frozen empty, `getLineDash` is never called.
- Fault model: FOURTH independent fault domain -- own try/catch, own
  `outlineError` slot OR-ed into the mount door; a fault sheds only the
  outlines (markers/cells/field/contours draw on) and vice versa.
  Degenerate groups (fewer than 3 usable rows, collinear, alpha below
  every triangle) skip silently per group; more than 64 distinct groups
  is a fail-closed layer fault (silently dropping groups lies). Handle
  methods are `typeof`-probed at first refresh (prototype-resident
  methods fine); a too-small factory `maxPoints` faults the layer at
  refresh.
- Doors (construction, before any owned signal): non-object `outlines`,
  missing/non-function `index`, missing/empty/non-string `groupKey`,
  `alpha` present but not a finite number `> 0` (`== null` gated before
  any coercion; `+0`/`-0`/`NaN`/negative/`Infinity` all throw). Junk
  styles fall back: `stroke` `#7a7a7a`, `strokeWidth` 1 clamped `(0,16]`,
  `fill` defaults to the stroke, `fillOpacity` 0 clamped `[0,1]`, `dash`
  frozen copy or solid.
- `Charts.d.ts`: `ClusterIndex` + `ClusterIndexFactory` types and the
  scatter `outlines` config key.
- Tests: +13 (490 -> 503) against the REAL published lite-delaunay 1.4.0:
  independent monotone-chain hull oracle with CCW-screen orientation and a
  per-group match bijection; huge-alpha == hull vertex set; an exact
  2-loop split fixture; partition matrix incl. no-group rows; degenerate
  isolation; the 64-cap at mount (throws) and on later growth (sheds,
  never throws); the four-domain fault matrix in both directions; a
  per-group build/dispose ledger (2 per view write, books closed at
  unmount); one-fill-per-group hole winding; SVG Z-closed path parity;
  source scan (single call sites, zero delaunay imports,
  `locate`/`barycentric` still unconsumed); absent-config parity (zero
  added reactive nodes).
- Torture A24: gesture storm at 2 groups x 1000 pts vs a no-outlines
  branch-parity control -- exactly 416 builds / 416 disposes across 208
  view writes (2 per write, never per frame), zero new signal-graph
  nodes, redraw within 2 B/op of control. Five reversion proofs measured:
  group cap, packed-index space (via the oracle bijection), the dispose
  pair, the mount-door OR, and retained draw-path growth (10.167 B/op vs
  0.076 control when reverted).

### Changed

- `devDependencies`: `@zakkster/lite-delaunay` `^1.3.0` -> `^1.4.0` (the
  test suites exercise the REAL published `createClusterIndex`).
- `llms.txt` line-count claim corrected (`~6.9k` -> `~11.2k` -- it had
  gone stale over the v1.14-1.17 line).

## [1.17.0] -- 2026-09

### Added

- **Contour/isoline layer on the scatter field raster
  (`field.contours: { levels, color?, width?, dash? }`).** Iso-value lines
  drawn over the v1.16.0 interpolated heatmap, between the raster and the
  cells/markers, inside the plot clip, at 0 B/frame. The lines are computed
  COLD on the same postProject refresh as the raster by sweeping the injected
  triangulation: each triangle is tested for an iso-value crossing (strict
  `z > v` side rule -- every triangle yields exactly 0 or 2 crossings, no
  ambiguity cases) and the crossing segment's endpoints are interpolated along
  its edges. This is EXACT for the piecewise-linear interpolant: a planar
  field's contour is a perfectly straight line, which the test suite pins
  against an independent oracle. `levels` is a count (integer `1..32`; lines
  spread evenly STRICTLY INSIDE the finite sampled range, re-derived on every
  pan/zoom so a panned-out outlier never pins them -- the ramp rule, applied
  to levels) or an explicit array (validated finite, sorted, deduped;
  out-of-range values legally produce no segments at runtime). One
  `color`/`width`/`dash` for all levels; junk styles fall back (color
  `#1e293b`, width 1 clamped to `(0, 16]`, solid) rather than throwing; a
  valid `dash` is copied and frozen so the hot draw never touches caller
  memory. Segments live in a pooled grow-by-double buffer; the per-frame draw
  walks prebuilt geometry only (one `beginPath`/`stroke` per level; the dash
  reset uses a module-level frozen empty -- `getLineDash()` is never called
  because it allocates). `exportSVG` emits the stroked paths between the field
  rects and the cell polygons through the existing draw serializer.

### Design

- **Third independent fault domain.** `_scatterPostProject` now runs cells ->
  field -> contours, each with its own `try/catch` and its own renderer-ctx
  error slot (all OR-ed into the fail-closed mount door). The contour pass
  REUSES the field's mesh handle and therefore gates on the field domain: a
  field fault, a missing handle, or zero finite raster cells makes contours
  skip silently (no raster, no contours) -- it never rebuilds the handle and
  its own fault never disposes it. Consumes only `triangleCount` +
  `triangleVertices` from the injected handle; `locate`/`barycentric` remain
  unconsumed -- NO delaunay-side change was needed (peer stays `^1.3.0`).
- Fail-closed construction: bad `field.contours`/`levels` throw with exact
  messages BEFORE any owned signal (`== null` gated before any coercion); a
  field chart without `contours` adds no scene node and is byte-identical.

### Coverage

- 490/490 (+8): CT1 independent planar oracle (every segment endpoint on the
  mapped iso-line within 0.05 z-units of a 500 span) + hull confinement; CT2
  count-form levels interior/ordered + fan-outlier tracking under pan/zoom;
  CT3 11-door construction matrix at zero node delta + style-fallback pins;
  CT4 three-way fault matrix (field fault -> silent contour skip; later
  contour fault -> raster survives, handle NOT disposed; foreign handle
  without the triangle surface -> mount door fires); CT5 SVG parity + layer
  order (field rects < contour strokes < cell polygons) + no-contours
  isolation; CT6 50x retention (builds === disposes, zero node growth); CT7
  honest zeros (out-of-range levels, zero-span fields both forms, exact-tie
  levels, off-hull view via the field-domain gate); CT8 source-scan
  (`.locate(`/`.barycentric(`/`.getLineDash(` all zero call sites, one draw
  node, one refresh call site). Torture A23: 208-write view storm with a
  branch-parity no-contours control (redraw <= 16 B/op, within 2 B/op of
  control, maxMajor 0, 0 new graph nodes, one sweep per write). Five
  reversion proofs (edge-lerp sign, field-domain gate, per-level counts,
  draw offset walk, fault-catch zeroing) -- each turned exactly its predicted
  test set red and was restored byte-identical.

## [1.16.0] -- 2026-09

### Added

- **Injected field-raster layer on `createScatterChart` (`field: { index, value, ... }`).**
  The third rung of the injection ladder (`spatialIndex` -> `cells` -> `field`):
  the primary series' per-point scalar `value` is rasterized into a smooth
  barycentric-interpolated background heatmap, drawn UNDER the cells layer and
  the markers, inside the plot clip, at 0 B/frame. The triangulated mesh + the
  serpentine grid sampler arrive via an injected factory matching the
  `FieldIndexFactory` contract (e.g. `@zakkster/lite-delaunay`'s
  `createFieldIndex(N)`) -- lite-charts imports no implementation. The mesh is
  built over PIXEL-space points and re-sampled (cold) on every data / scale
  change on the same postProject seam the cells layer uses, so it stays correct
  under anisotropic pan/zoom. One `sampleField` call per refresh fills a pooled
  grow-only grid; per-cell CSS color strings are precomputed cold so the draw
  loop only walks a prebuilt array (`fillStyle`/`fillRect`, NaN cells skipped).
  `exportSVG` emits one `<rect>` per finite cell through the same serializer.
  Options: `gridW` / `gridH` (integers in `[8, 256]`, default `64 x 48`),
  `colors: [low, high]` (hex ramp, default blue-100 -> blue-900) or a
  `colorFn(v, vMin, vMax)` (extents over the FINITE cells only, so a panned-out
  point never pins the ramp), and `opacity` (default `0.5`, clamped). A scatter
  with no `field` key is byte-identical in behavior.

### Changed

- **`@zakkster/lite-delaunay` peer range bumped to `^1.3.0`** (was `^1.2.0`),
  the version that ships `createFieldIndex`. It remains an OPTIONAL peer -- only
  a chart that injects `cells` or `field` needs it; lite-charts still imports
  nothing from it.

### Design

- The `field` fault domain is fully INDEPENDENT of `cells`: `_scatterPostProject`
  runs `_scatterRefreshCells` then `_scatterRefreshField` as two separate passes,
  each with its own `try/catch`, its own `ctx` error slot (`cellError` /
  `fieldError`, both OR-ed into the mount fail-closed door), and disposing ONLY
  its own index handle. A cells fault cannot suppress the field and vice-versa,
  even when both layers are configured over the same projected points.
- The field ramp's hex parser is a minimal duplicate (`_fieldParseHex`) living in
  the axis-chart kernel region, not a reference to the grid kernel's
  `_parseHexColor`. The A5/A15 kernel-isolation source-region pins keep the grid
  kernel tree-shakeable out of a scatter-only bundle; sharing the helper would
  breach that. The duplicate runs only on the cold refresh, never per frame.
- Field construction fails closed BEFORE the first `_own(signal())`: a non-object
  `field`, a missing / non-function `index`, a missing `value`, or a
  non-integer / out-of-caps `gridW` / `gridH` all throw at construction
  (`== null` gated before any `+` so a null never masquerades as `0`).

### Testing

- **Retained-allocation gate in the torture harness.** T6's headline zero-alloc
  claims (section 1 pure kernel, section 2 mounted redraw) now also run through a
  profiler-native zero-RETENTION gate (`runAllocsGate` -> `measureAllocs` /
  `checkAllocs`, `ALLOC_RULES = { maxBytesPerCall: 0 }`). `runOpsGate` sees
  ArrayBuffer pool growth and asynchronously-delivered GC, but a loop retaining
  plain (non-ArrayBuffer) objects can slip past `maxMajor` because Node delivers
  'gc' PerformanceObserver entries after the synchronous window closes; the
  surviving-bytes channel (min-over-batches, each batch bracketed by a forced
  collection) is the binding retention gate. Section 2 additionally pins the
  signal-graph node and link deltas at exactly 0 across the redraw window. T9
  Control 9 proves the gate both ways: a retaining body (`keep[k++] = { n: i }`)
  fails, a section-1-shaped non-retaining slot-write body passes settled, and a
  drift guard pins `maxBytesPerCall` strictly below `MIN_HEAP_OBJECT_BYTES` (16).
  Test-only; the shipped module is byte-identical.

### Coverage

- 9 new tests (473 -> 482), run against the REAL published lite-delaunay
  1.3.0 (devDep). FR1 is an independent planar oracle: z = 2x+3y+1 is planar
  in data space and pixel space is its affine image, so every painted cell's
  color must equal the ramp of the formula evaluated at the cell's inverted
  pixel center (+-2/channel) -- and a diamond-hull cloud proves NaN
  confinement (plot-corner cells outside the hull stay unpainted). FR2 pins
  orientation (z = data y -> top rows hotter; row 0 = plot top, NO flip).
  FR3 walks the 10-case construction-door matrix at a zero reactive-node
  delta and pins the colors/colorFn junk fallback as heatmap ramp-vocabulary
  parity. FR4 proves the independent fault domains: a cells rebuild fault
  leaves the field painting and vice versa, each side disposing exactly its
  own handles; a FIRST-build field fault throws at mount and destroy releases
  everything. FR5 pins SVG parity (exactly one <rect> per painted cell,
  clipPath defs stripped) and document-order layering (field raster before
  the cell polygons). FR6: 50 mount/destroy cycles, builds === disposes for
  BOTH injected layers, zero retention. FR7 pins the lifecycle (view change
  and data change each rebuild + resample EXACTLY once, redraws never) and
  the finite-only ramp (a 1e6 outlier panned outside the view cannot pin
  vMin/vMax). FR8 covers the SoA data.zs channel and pins the documented
  footgun (SoA without zs + a string key fails CLOSED to no field, markers
  intact). FR9 is the source-scan confinement (zero delaunay references,
  each mechanism wired exactly once, interpolate never called).
- Torture A22: a 208-write pan/zoom storm rebuilds + resamples exactly once
  per scale change (208/208 after warm-up, one sampleField per build, zero
  new signal-graph nodes), and the raster redraw stays <= 16 B/op with
  maxMajor:0, within 2 B/op of a no-field control.
- Five mechanisms proven load-bearing by reversion, each turning an exact
  test set red: the field draw-node gate (FR1/2/3/4/5/7/8), the finite-only
  vMin/vMax scan (FR1 + FR7), the no-flip row mapping (FR1 + FR2), the
  field-local catch (FR4), and the extract-time dispose (FR7).

## [1.15.0] -- 2026-09

Horizontal legend virtualization for top/bottom legends, early-close holidays
for the market-hours session calendar, and an earlier fail-closed point for bad
legend config. A chart using none of these is byte-identical.

### Added

- **Horizontal legend virtualization.** A virtualized legend at
  `position: 'top' | 'bottom'` now windows a single non-wrapping row that
  scrolls along X. Supply `legend.width` (viewport) and `legend.itemWidth`
  (fixed row width, both positive integers); the adapter receives
  `{ count, itemWidth, width, overscan, renderRow, horizontal: true }`. The
  size keys are orientation-EXCLUSIVE: `height` / `itemHeight` on a top/bottom
  legend, or `width` / `itemWidth` on a left/right legend, throw at construction
  (no silent reinterpretation). Left/right virtualization is unchanged and its
  adapter opts + DOM path are byte-identical.
- **Early-close holidays.** `shading.holidays` entries may now be
  `{ ts, closeMinutes }` (in addition to a whole-day epoch-ms number). On that
  UTC day every session is clamped to close at `closeMinutes` (1..1439) instead
  of its normal close, and the trailing closed time fuses forward like a
  whole-day holiday's band. Doors that throw at construction: an object without
  `ts`; a `ts` that fails the epoch-ms rules; a `closeMinutes` that is null,
  non-integer, or outside 1..1439; a duplicate UTC day across ALL entries; an
  early close on a UTC weekday with no open session; and an early close on a day
  carrying an overnight evening session. Whole-day (number) entries are
  byte-identical to v1.14.0.

### Design

- Bad legend config now throws with ZERO owned signals allocated: the legend
  position/container validation and `virtualize` normalization are hoisted above
  the first `_own(signal(...))` in `createBaseAxisChart`, matching the
  construction-time fail-closed discipline already used for `renderer.initOpts`.
  When BOTH the chart-type options and the legend are invalid, the `initOpts`
  error wins (it runs one line earlier) -- the same precedence as the v1.14.0
  hoist.
- The early-close clamp is a single cold-path addition to `_sessionBands`
  (`c = c0 < cutMs ? c0 : cutMs; if (o >= c) continue;`); non-early days keep
  `cutMs = Infinity`, so `c === c0` and the emitted bands are byte-identical to
  v1.14.0. Session masks (`openMask` / `eveMask`) that back the early-close doors
  are built once at construction, never on any draw path.

### Coverage

- 10 new tests (463 -> 473). HL1 pins the exact six-key horizontal adapter
  contract (`{ count, itemWidth, width, overscan, renderRow, horizontal: true }`,
  no height keys), host styling, bounded windowing on `scrollLeft`, recycle-fresh
  a11y/content, and the delegated click + effect repaint. HL2 walks the
  11-case orientation-exclusive door matrix with a zero reactive-node delta.
  HL3 proves one delegated listener at 200 series and 50 mount/destroy cycles
  disposing every adapter with zero retention. HL4 pins the factory-without-
  dispose mount throw (nothing attached, `chart.legend` null, destroy safe).
  HL5 pins the throw precedence (initOpts wins when both configs are bad).
  EC1-EC5 pin exact band lists for a mid-session cut, cut-before-open ==
  whole-day closure, mixed number/object arrays, cut-at-open, a between-sessions
  cut on a lunch-break market (afternoon suppressed, no boundary at the cut),
  a mid-second-session cut, cut-after-close as a no-op, and the synthesized
  holidays-only calendar; EC3 walks the 13-door construction matrix (including
  the openMask/eveMask refusals) at a zero node delta.
- Torture A21: a 50000-step horizontal scroll storm (top position, 24px steps,
  redraw interleaved) gated at <= 1.5 B/op absolute, maxMajor:0, zero new
  signal-graph nodes, and <= 0.5 B/op against a VERTICAL virtualized storm
  driving the identical workload -- a branch-parity control (per-process probes
  put the true horizontal-vs-vertical delta at 0.000 B/op; a legend-absent
  redraw control this late in the tier measures heap warm-up, not the branch).
- Five mechanisms proven load-bearing by reversion, each turning an exact test
  set red: the `o >= c` cursor guard (EC1+EC4), the `cutMs` clamp itself
  (EC1/2/4/5, with v1.11-v1.13 suites staying green -- the clamp is the entire
  early-close mechanism), `horizontal: true` in the adapter opts (HL1), the
  top/bottom `height` door (HL2 + the retargeted V6), and the eveMask overnight
  refusal (EC3).

## [1.14.0] -- 2026-09

Fat hover and an injected Voronoi cell (tessellation) layer for
`createScatterChart`. A scatter using neither is byte-identical (both features
gate behind their opts fields).

### Added

- **Fat hover.** `hitTolerance: 'nearest'` (scatter only) snaps the hover to
  the closest point regardless of distance -- the whole plot becomes the
  point's Voronoi hit region, ideal for sparse scatters. The query is capped
  at the plot diagonal squared (a finite bound, re-read per query), so it is
  semantically "everywhere" inside the plot yet always terminates the injected
  spatial index's grid walk. Works identically on the linear and indexed
  paths. Numbers keep today's disc behavior; any other string throws at
  construction.
- **Cell (Voronoi) layer.** `cells: { index, colorKey?, fillOpacity?, stroke?,
  strokeWidth? }` on `createScatterChart`. Every primary-series point owns a
  bbox-clipped Voronoi polygon, drawn UNDER the markers inside the plot clip,
  with a free hover-cell highlight off the crosshair's `snapIdx`. The polygon
  geometry comes from an injected `CellIndexFactory` (an optional peer such as
  `@zakkster/lite-delaunay`'s `createCellIndex(N)`) -- lite-charts imports no
  implementation, mirroring the `spatialIndex` injection contract. Cells are
  PIXEL-space and rebuilt (cold) with the projection through the same
  data/scale lifecycle as the spatial index, so anisotropic pan/zoom never
  serves a stale or affine-wrong cell. The per-frame draw walks prebuilt
  packed arrays at 0 B. SVG export parity via the annotation-layer clip idiom.

### Changed

- `@zakkster/lite-delaunay` peer bumped to `^1.2.0` (stays optional) -- the
  version that ships `createCellIndex`.

### Design

- Cell geometry is rebuilt at a NEW `postProject` renderer seam (after the
  projection loop, before `scaleVersion`), not at extract time: the extract
  hook runs BEFORE pixels are re-projected, so it would index stale
  coordinates. Dead for every other renderer, exactly like `postExtract`.
- Fail closed: a degenerate cloud (collinear/coincident -> 0-vertex cells)
  draws markers with no cells. A cell that overflows the caller-owned scratch
  throws out of `cell()` during the cold refresh only; the refresh catches it,
  zeroes the spans (markers draw), and surfaces the message at mount on the
  first run (the `_logDomainError` fail-closed door), never mid-paint.
- Primary series only (D6): a multi-series tessellation is ill-posed (whose
  cell owns the pixel?). Bubble is out -- disc containment is the feature there.
- A construction-time throw (bad `cells` or `hitTolerance`) now fires BEFORE
  the auto-size signals are allocated: `renderer.initOpts` was hoisted above
  the first owned `signal()`, so a rejected construction leaves zero reactive
  nodes (this also hardens the pre-existing horizontal+log throw for free).

### Coverage

- 463 tests (453 -> 463): VC1-VC10 -- fat hover indexed/linear agreement +
  numeric-tolerance control, cell geometry vs an independent half-plane
  Sutherland-Hodgman oracle (per-cell vertex sets, areas, and an exact
  plot-tiling invariant), degenerate fail-close, construction validation with
  zero-node throws, hover-highlight cell identity, SVG parity (clipPath
  isolated from content paths), 50x mount/destroy retention, postProject
  freshness (site-in-own-cell containment across zoom + data change), index
  fault doors (mount-time throw + later-run cells-skip), and source-scan
  injection confinement. Five mechanisms proven load-bearing by measured
  reversion: the nearest-cap ternary, the postProject-after-projection
  ordering, the hover snapIdx coupling, the per-cell `beginPath()` (the
  post-clip one is defensive -- proven NOT load-bearing and its comment
  corrected), and the extract-time cell-index dispose.
- Torture A20: 2000-point tessellation storm against the real
  `@zakkster/lite-delaunay` `createCellIndex` -- 208-write pan/zoom storm
  rebuilds exactly once per scale change (209 builds / 208 disposes, zero new
  signal-graph nodes), cells redraw inside the standard <=16 B/op budget with
  maxMajor:0 and within 2 B/op of a no-cells control, and `'nearest'` hover
  within 2 B/op of a numeric-tolerance control over the same cursor storm.

## [1.13.0] -- 2026-09

Overnight sessions and a holiday calendar for `createTimeLineChart` shading.
Both ride the v1.11.0 session machinery; a chart using neither is unchanged
(no-overnight/no-holiday specs produce identical band lists, asserted by test).

### Added

- **Overnight sessions.** `shading.sessions` entries with
  `closeMinutes < openMinutes` are now legal: the session is split at the UTC
  midnight seam into an evening half `[open, 1440]` on the original day mask
  and a morning half `[0, close]` on the mask rotated one weekday forward, so
  the single-cursor complement sweep is structurally unchanged and the seam
  cannot emit a band (the gap at the boundary is zero-width and the emit test
  is strict). `days` names the UTC weekday the session OPENS; a default
  Mon-Fri overnight spec has its morning halves on Tue-Sat.
- **`shading.holidays: number[]`.** Epoch-ms timestamps, each truncated to
  its UTC day start (`Math.floor` division, so pre-1970 dates floor to the
  correct day). A holiday day contributes no open intervals, so the whole UTC
  day is shaded and fuses with the adjacent gaps into one band. Holidays
  without `sessions` synthesize a full-day Mon-Fri calendar internally
  (complement = weekends + holidays) through the same validation loop.

### Changed

- `shading.sessions` with `closeMinutes < openMinutes` no longer throws
  (v1.11.0-v1.12.0 rejected it as unsupported). `closeMinutes === openMinutes`
  still throws; a 24-hour session is `{ openMinutes: 0, closeMinutes: 1440 }`.

### Design

- No per-holiday fill: distinct fills would prevent fusing a holiday with its
  neighboring gaps into one band. Overlay an `annotations` range for a
  visually distinct holiday.
- Whole-UTC-day closure: the holiday closes exactly its own UTC day. A real
  exchange usually also skips the prior evening's open before a holiday --
  early-close support is out of scope for this release.
- `_weekendBands`, `_shadingAnnotationsAcc`, and `createTimeLineChart` are
  byte-identical to v1.12.0 (the weekend generator is SHA-pinned in the
  suite); every edit lands in `_normalizeSessionSpec` (construction) and
  `_sessionBands` (cold band generator).

### Coverage

- 453 tests (9 new), each of the four load-bearing mechanisms proven by
  measured reversion: dropping the rotate's wrap term (only observable for a
  Saturday-opening session -- fixture added for exactly that), removing the
  midnight split, deleting the holiday day-skip, and swapping the floor
  truncation for `%`-subtraction each turn their assertions red and nothing
  else.
- New torture case A19: overnight + 12-holiday band-regeneration storm over
  200 data-signal changes; 0 major GC, 0 new signal-graph nodes, bands
  regenerate on data change only.

## [1.12.0] -- 2026-09

Opt-in legend virtualization: a legend with hundreds of series can hand its row
windowing to an external adapter WITHOUT lite-charts importing one. Additive and
fully confined -- the eager legend path (`buildLegendDOM`..`installLegend`) is
byte-identical, and a chart that does not set `legend.virtualize` is unchanged.

### Added -- legend virtualization

- **`legend.virtualize`.** A user-supplied factory
  `(host, opts) => ({ dispose })` that windows the legend rows, so only a bounded
  set of DOM rows is ever in layout (e.g. wire it to `@zakkster/lite-virtual`'s
  `mountList` -- YOUR import; lite-charts never imports it). Charts.js owns row
  *contents* (children, `data-lc-idx`, `role`/`aria-pressed`/`tabindex`, swatch
  colour, label text) and one shared visibility effect + one delegated click
  listener; the adapter owns row creation, position, and height.
- **`legend.height` / `legend.itemHeight` / `legend.overscan`.** Viewport height
  (REQUIRED when virtualized -- `null` is not 0, it throws), fixed row height
  (default 28), and off-viewport overscan rows (default 2).
- **Fail closed.** Every invalid config throws at construction (before any signal
  is allocated): a non-function `virtualize`, `position: 'top' | 'bottom'`, a
  missing/`null`/non-positive-integer `height`, or an invalid `itemHeight` /
  `overscan`. A factory that returns no `dispose()` throws at mount with nothing
  attached (`chart.legend === null`).
- **`@zakkster/lite-virtual`** added as an OPTIONAL peer dependency (mirrors
  `lite-delaunay`); it is never imported by `Charts.js`.

### Notes

- Zero chart-side allocation on the scroll hot path: `renderRow` re-reads
  visibility via `signal.peek()` (no `untrack` thunk) and writes only pooled DOM
  fields. Gated by torture case A18 (`<= 1.5 B/op`, `<= 0.5 B/op` vs a
  virtualize-absent control, zero new signal-graph nodes during a scroll storm).
- Keyboard focus does not survive a row scrolling out of the window (rows are
  pooled and recycled) -- a documented trade-off of virtualization.

## [1.11.0] -- 2026-09

Market-hours session shading on `createTimeLineChart`, plus a fail-closed
tightening of the time preset's `xScale` handling. Additive: one new config
field and one new construction-time throw; every existing factory, the shared
kernel, and the v1.10.0 weekend path are byte-unchanged.

### Added -- session calendar shading

- **`shading.sessions`.** `shading: { sessions: [{ openMinutes, closeMinutes,
  days? }], sessionFill? }` shades NON-trading time. Minutes are UTC
  minutes-from-midnight (`open` 0..1439, `close` 1..1440, `close > open`);
  `days` is UTC weekday ints 0-6, default Mon-Fri. Bands are the complement of
  the union of open intervals over the data extent: Fri close -> Mon open is
  one contiguous band (weekends are subsumed -- the weekend walker is not
  invoked when `sessions` is present, so nothing double-paints), and multiple
  sessions per day (lunch-break markets) produce the midday gap bands
  naturally. Data-driven: no exchange, timezone, or holiday table is built in.

### Changed

- **Explicit conflicting `xScale.type` now throws.** `createTimeLineChart({
  xScale: { type: 'log' } })` previously forced `'time'` silently; an explicit
  non-`'time'` type (including `null`) now throws at construction, before any
  signal allocation. `type` omitted, `undefined`, or `'time'` is unchanged.
  `TimeLineChartConfig.xScale` narrowed to match.

### Design

- **Single-cursor sweep, no sort at generation.** The generator walks UTC days
  once with a forward-only cursor; ordering is an invariant of the validator's
  open-ascending sort plus `closeMinutes <= 1440` (a comment marks that
  overnight support would require a real merge). Contained, overlapping, and
  back-to-back sessions union correctly -- verified against exact band lists.
- **Same cold/hot split as v1.10.0.** Bands are generated cold in the
  annotation resolve effect and re-clipped per frame at 0 B by the existing
  project effect; `_weekendBands` and the extent scan (raw accessor, per-row
  null gate, SoA branch) are byte-identical -- the accessor changed by exactly
  one generator-selection line.

### Fixed

- Overnight sessions (`closeMinutes < openMinutes`) throw with a message
  naming them unsupported rather than producing silently wrong bands;
  zero-width sessions throw; a `null` minute bound throws (`== null` gated
  before any arithmetic -- null is not midnight).

### Coverage

- 8 new tests (427 -> 435): exact 11-band canonical fixture, subsumption
  (11 vs 2 on the same data), 21-band lunch-break fixture, day-mask handling,
  the full validator throw matrix, the `xScale.type` throw, per-row null-x
  reuse under sessions, tree-shake source confinement, retention, and
  exact-bounds union invariants for contained/overlapping/back-to-back
  session sets. TS18 and TS22 proven load-bearing by measured reversion --
  including a strengthened TS22 after the count-only version stayed green
  under a cursor-regression reversion. One 0-B session-shading redraw torture
  case (A17: 1.065 B/op vs 0.861 weekend control, delta 0.204, 44 bands).
  torture ok, ASCII clean.

## [1.10.0] -- 2026-09

`createTimeLineChart` -- a time-series line preset over the axis kernel, plus
opt-in weekend background shading. Additive: a new factory and a new config
field; every existing factory and the shared kernel are byte-unchanged.

### Added -- time-series line preset + weekend shading

- **`createTimeLineChart(config)`.** `createLineChart` with three time-first
  defaults: (1) `xScale.type` is forced to `'time'` regardless of the x key or
  data probe (plain `createLineChart` infers `'linear'` for a numeric `x` key);
  (2) `panBounds` defaults to `'data'`, so the reachable view equals the data
  domain; (3) an optional `shading` config adds weekend bands.
- **`shading: true | 'weekends' | { fill? }`.** Shades every Sat 00:00 -> Mon
  00:00 UTC span within the data domain. Bands are plain `{ type: 'range',
  axis: 'x' }` annotation rows, so they compose with any `annotations` you
  supply (bands first) and export through `exportSVG`. Omit `shading` for a
  plain time line at zero added cost. Default fill `rgba(0,0,0,0.05)`.

### Design

- **Rides the v1.7.0 annotation layer, zero per-frame cost.** Weekend bands are
  generated cold, inside the annotation resolve effect, and re-clipped each
  frame by the existing project effect at 0 B -- no new draw-path code.
- **Extent from data, not scale.** The band set is derived from the series data
  extent (epoch ms, UTC), never `xScale.dMin/dMax`. The annotation resolve
  effect tracks `themeVersion` + the annotations accessor but not `scaleVersion`,
  so reading the scale would re-allocate bands every pan/zoom frame; reading the
  data accessors regenerates them only on data change. Timezone-agnostic (epoch
  ms in; caller formats). Market-hours / session calendars are out of scope.
- **Tree-shake isolated.** `createTimeLineChart` is the only referent of the
  weekend-shading helpers; a `createLineChart`-only bundle drops them.

### Fixed

- **SoA data no longer silently unshaded.** The weekend-extent scan now handles
  the `{ xs, ys }` typed-array shape (mirroring `extractSeriesData`); previously
  an `Array.isArray` gate skipped SoA input and emitted zero bands with no error.
- **Fail-closed band bounds.** A `null` extent bound is gated (`== null`) before
  any unary `+`, so it becomes `NaN`, not epoch 0 (`+null === 0`); a non-finite
  or inverted extent emits no bands.
- **Fail-closed per-row x.** The extent scan reads x through a raw (uncoerced)
  accessor and gates `== null` per row; the coercing accessor would turn a
  single `{ x: null }` row into `+null === 0` and collapse the extent to
  epoch 1970 (~2600 bogus bands). Non-numeric garbage coerces to `NaN` and
  self-skips; `Date` x values map through `getTime()`.
- **`shading: false` is a first-class opt-out.** It behaves exactly like
  omitting `shading` (matching the declared `boolean` type); previously it
  threw at construction. Other falsy junk (`0`, `''`) still throws.

### Coverage

- 14 new tests (413 -> 427): weekend-walk boundaries, null/non-finite/inverted
  fail-close, no-shading passthrough, band + user-annotation composition, the
  SoA regression, forced time scale, annotation-count integration, opt-in null
  handle, config validation, tree-shake source confinement, mount/destroy
  retention, the `shading: false` opt-out, and the per-row null-x guard.
  TS2 (null-gate), TS5 (SoA), TS13 (false opt-out) and TS14 (row-level null)
  proven load-bearing by reversion. One 0-B weekend-shading redraw torture case
  (A16). torture ok, ASCII clean.

## [1.9.0] -- 2026-08

Horizontal-bar `brush` -- shift-drag selection on
`createBarChart({ orientation: 'horizontal', brush: true })`. Completes the
horizontal interaction set; the deferred slice from v1.8.0. Additive; the
vertical / line / scatter brush path stays byte-unchanged.

### Added -- brush on horizontal bars

- **`brush` on `orientation: 'horizontal'`.** A shift-drag selects a value
  range (screen-X, the value axis under the swap) crossed with a band set
  (screen-Y). It emits through `chart.brush` a distinct payload
  `{ valueMin, valueMax, bandMin, bandMax, bands, ids }` -- `bands` is the
  selected category keys, `bandMin` / `bandMax` the inclusive band-index span,
  `ids` the matching primary-series row indices. The vertical brush keeps its
  `{ xMin, xMax, yMin, yMax, ids }` shape. Previously threw at construction.

### Design

- **Map at the gesture boundary.** Every change is a `swapAxes ? <remapped> :
  <current>` selection at a call site (`_commitBrush`, `drawBrushOverlay`,
  `brushFacade.set`). The pure helpers `_normalizeBrushRect` / `_brushPxToData` /
  `_computeBrushIds` / `makeBandScale` stay byte-identical -- `_computeBrushIds`
  applies unchanged because a bar stores its band index in `state.xs` and its
  value in `state.ys`. Value bounds come from `yScale.invert`; the band set from
  `xScale.invert` (a pixel floored to a band index). The overlay rect spans
  `xScale.leftEdge(bandMin)` .. `leftEdge(bandMax) + bandWidth` (band edges, not
  the center). Per-frame draw stays 0 B; the commit allocates only at gesture
  rate (sub-Hz), matching the existing brush precedent.
- **Fail-closed.** An empty-category chart (`xScale.invert` -> -1) commits
  `null`, never a `bands: [undefined]` payload. Horizontal + a `log` value axis
  still throws at construction (checked before `brush`).

### Fixed

- **`setBrush` no longer treats a `null` bound as zero.** The horizontal facade
  validated with `Number.isFinite(+v.valueMin)`, but `+null === 0` is finite, so
  a `null` value bound silently became value 0. Bounds are now forced to `NaN`
  before the finite check (`v.field == null ? NaN : +v.field`), so a `null`
  bound fails closed with a thrown error. Numeric coercion of real values is
  unchanged.

### Coverage

- 7 new tests (406 -> 413): value-range + band-set mapping from a shift-drag,
  full-plot select, sub-threshold click-to-clear, fail-closed facade validation,
  a vertical-brush regression guard, band-edge overlay alignment, brush/clear
  retention, and the empty-category fail-closed path. HB1 / HB3 / HB5 / HB7 each
  proven load-bearing by measured reversion. Plus a 0-B/frame horizontal-brush
  overlay torture case (A15). Torture green, ASCII clean.

## [1.8.0] -- 2026-08

Horizontal-bar interactions -- `pan`, `zoom`, and a value `grid` on
`createBarChart({ orientation: 'horizontal' })`. Additive; no public API change
beyond enabling existing flags on a new orientation. The per-frame draw path and
the vertical path stay byte-unchanged.

### Added -- interactions on horizontal bars

- **`pan` / `zoom` on `orientation: 'horizontal'`.** Under the axis-role swap
  the value axis is on screen-X, so a horizontal drag pans the value domain and
  the wheel zooms it around the cursor value; the band (category) axis stays
  pinned. `view.yMin` / `view.yMax` address the value axis (the `x` fields hold
  the band domain and pan/zoom as an identity).
- **Value `grid` on `orientation: 'horizontal'`.** Value gridlines render
  vertically (perpendicular to the value axis). Previously threw at construction.

### Design

- **Map at the gesture boundary.** The linear `_applyPan` / `_applyZoom` /
  `_clampToBounds` kernels are byte-identical to the vertical path. Horizontal
  support is a `swapAxes ? <remapped> : <current>` selection at each gesture call
  site: `onPanMove` passes `_applyPan(view, 0, -dx, w, w)` (band pinned via
  `dxPx = 0`); `onWheel` passes `_applyZoom(..., pb.w - (p.x - pb.x), ..., 1,
  zoomFactor)` (`ty = 1 - tx`, band pinned via `zoomX = 1`) and forces
  `proposedXRatio = 1` so the band veto can't block a value-axis zoom.
  `swapAxes` is true only for the bar renderer, so every other chart family is
  untouched.
- **One shared-core edit.** `buildGrid` gained a `swapAxes` option (default
  `false`, resolved once at setup, one call site) that flips value gridlines to
  vertical. All other families pass `false` and are byte-identical.
- **Fail-closed.** Horizontal + `brush` (a value-range + band-ids payload is a
  separate future cut) and horizontal + a `log` value axis still throw at
  construction, naming the combination, before any signal is allocated.

### Coverage

- 6 new tests (400 -> 406): value-axis pan (a horizontal drag translates the
  value scale by exactly `dx` px), a vertical-drag control (no value move),
  cursor-anchored zoom (value under the cursor stable to 1e-9), a vertical value
  grid, the fail-closed throws, and mount/pan/destroy retention. Each behavioral
  test proven load-bearing by measured reversion of the corresponding change.
- A new horizontal-interaction 0-B/frame case in the torture gate. Torture
  green, ASCII clean, per-frame draw path byte-unchanged.

## [1.7.0] -- 2026-08

Annotation layer -- data-pinned overlays on any axis-kernel chart. Additive; no
public API change beyond the new `annotations` config. The per-frame draw path
stays 0 B/frame.

### Added -- `annotations` on axis-kernel charts

- **`annotations: Annotation[] | (() => Annotation[])`** on line / area / bar /
  bubble / scatter. Four shapes, each pinned to DATA coordinates:
  - `{ type: 'line', axis: 'x'|'y', value, color?, dash?, width?, label? }` -- a
    full-width / full-height rule at a data value (thresholds, targets).
  - `{ type: 'range', axis: 'x'|'y', from, to, fill?, label? }` -- a shaded band
    between two values on one axis (windows, SLA bands, confidence regions).
  - `{ type: 'point', x, y, color?, radius?, label? }` -- a marker at a point.
  - `{ type: 'text', x, y, text, color?, anchor?: 'start'|'middle'|'end' }` -- a
    pinned label.
- **Live projection.** Marks re-map through the live `xScale` / `yScale` on every
  scale change, so they track `pan` / `zoom` and render correctly on `type:
  'log'` axes. A mark that maps off-scale (a `log` value `<= 0`, or one panned
  out of view) is clipped to the plot rect -- never painted over the axes.
- **Reactive + theme-aware.** A signal-valued `annotations` accessor re-runs on
  signal change; `color` / `fill` accept `--css-var` tokens, resolved at mount
  and re-resolved on `refreshTheme()`.
- **Z-order + export.** Rendered above the series and below the crosshair / brush
  overlay; emitted by `chart.exportSVG()`.
- **Swap-aware.** `axis` names the *data* axis; on an `orientation: 'horizontal'`
  bar an `axis: 'y'` rule draws as a vertical screen line.

### Design -- zero-allocation, fail-closed

- **Two-step reactivity.** A cold resolve step (tracks a theme signal + the
  annotations accessor) sizes pooled scene nodes and resolves colors via
  `getComputedStyle`; a hot project step (tracks `scaleVersion` +
  `plotBoundsSignal`, re-runs every pan frame) writes pooled-node fields
  directly -- no `node.set`, no literals, no `resolveColor` -- keeping the
  per-frame path at 0 B. Color resolution never touches the hot path.
- **Fail-closed.** A non-finite `value` / `from` / `to` / `x` / `y`
  (`null` / `undefined` / `NaN`) draws nothing (`Number.isFinite`, never
  coerced to `0`); an unknown `type` is ignored.
- **Runtime-isolated.** With no `annotations`, no nodes are created and the
  handle is `null`; `buildAnnotations` is gated behind `if (annotationsAcc)`.

### Coverage

- 10 new tests (390 -> 400): projection, pan-clip, reactive range,
  `exportSVG` parity, theme re-resolve (plus `resolveColor` proven off the redraw
  path), log **and** linear fail-closed (the linear case is load-bearing -- a log
  axis masks `Number(null) === 0` because `map(0)` is already non-finite),
  runtime isolation, horizontal-bar swap, pool retention / high-water. Each
  proven load-bearing by measured reversion. Plus a 0-B/frame annotation torture
  case. `npm run torture` -> `ok`.

## [1.6.1] -- 2026-08

A correctness patch closing the mixed-sign log-domain gap that 1.6.0 shipped as
known/deferred. No public API change; the per-frame draw path is byte-unchanged.

### Fixed -- mixed-sign log domain NaN'd the first pan/zoom

- **A `type: 'log'` domain spanning zero (`min <= 0, max > 0`) drew correctly
  but froze on the first gesture.** The reactive scale effect floored the domain
  to its positive part for *rendering* (in locals `xlo/xhi`, `lo/hi`) but wrote
  the raw, possibly non-positive min into `_dataDomain` -- the snapshot the
  pan/zoom bounds math reads. `_clampToBoundsLog` / `axisSpan` then took `log()`
  of a value `<= 0`, producing a NaN view that the reactive effect refused to
  apply. Fix: floor `_dataDomain.xMin` / `.yMin` to the same positive part the
  render path uses (`dxMax * 1e-9` / `yBase[1] * 1e-9`), with the same `> 0`
  predicate, computed from the *data* extent (not the view-overridden bounds),
  and only when that axis is log with a positive extent. Two cold `if`s in the
  scale effect; symmetric on x and y.
- **Fail-closed preserved.** A log domain with *no* positive extent still throws
  at mount, naming the domain. The floor is guarded on `max > 0`, so it never
  runs on -- and never masks -- the no-positive-extent case; that throw is
  upstream and fires first.
- **Zero cost elsewhere.** The linear/time path only gains branches that are
  never taken on a non-log axis; the per-frame draw path is untouched.

### Coverage

- 7 new boundary tests (383 -> 390): a mixed-sign y-axis pan (the y branch had
  been asserted only by x/y symmetry), x and y positive-domain regression guards
  (a purely-positive domain must clamp to its *exact* data min/max, not a floor
  substitute), x and y no-positive-extent throws (the floor must not swallow
  them), and the wheel-zoom path on both axes (`axisSpan`, which the pan tests
  do not exercise). The pre-existing x-pan characterization test was reconciled
  from "documents a NaN view" to asserting the finite, moved (`min > 0`) view.
- Load-bearing verified by reverting the fix: without it, exactly those 4
  gesture tests fail and the 2 regression + 2 throw guards stay green.
- Torture gate (T6.A13) unchanged and green.

## [1.6.0] -- 2026-08

X-axis log scale. Additive; no public API change beyond enabling the config.

### Added -- `xScale: { type: 'log' }`

- **Base-10 log on the x-axis** for the continuous axis-kernel charts (line,
  area, scatter, bubble). Symmetric with the y-axis log scale that shipped in
  1.4.0: decade ticks via `lite-axis.logTicks`, `map(x <= 0) = NaN` so line /
  area break segments and markers skip, and log-space pan/zoom
  (`_applyPanLog` / `_applyZoomLog` / `_clampToBoundsLog` already accepted an
  `xLog` flag). Point projection was made log-aware for x in the 1.5.1 patch,
  so this release is mostly construction + the reactive domain wiring.
- **Fail-closed on every unverified state.** A log x-domain with no positive
  extent throws at mount, naming the domain (mirrors the y `_logDomainError`
  path; leaks no signal on the rejected mount). `xScale: { type: 'log' }`
  combined with a categorical (bar / band) or time x-axis throws at
  construction, before any signal is allocated -- a scale is one type.
- **The common linear-x path is byte-unchanged.** The x-log branch is a single
  cold `if (resolvedXType === 'log')` in the reactive scale effect; every
  linear-x chart projects and ticks exactly as before.

### Coverage

- 15 new boundary tests (368 -> 383): mounted-chart projection == `xScale.map`,
  non-positive -> NaN, decade ticks, fail-closed no-positive-extent (throws +
  zero signal leak), the two construction guards (bar, time), log-correct pan
  and zoom, a linear-x regression guard, exportSVG parity, and a documentation
  test pinning the known pre-existing mixed-sign-domain behavior.
- The T6.A13 torture gate gained an `xLog && !yLog` projection body mirror
  (`<= 16 B/op` absolute, `<= 2.0 B/op` differential vs linear-x, `maxMajor: 0`).

### Known / deferred

- A mixed-sign log domain (min `<= 0`, max `> 0`) floors to positive for
  rendering but leaves `_dataDomain` min unfloored, so the first pan/zoom
  gesture produces a NaN (fail-closed) view. This is pre-existing and identical
  on the y-axis; a future patch floors both axes together.

## [1.5.1] -- 2026-08

A correctness patch. One hot function; no public API change.

### Fixed -- log-scale point projection (line / area / scatter / bubble)

- **`yScale: { type: 'log' }` projected data points with linear math, throwing
  them off-canvas.** `scaleSeriesToPixels` -- the per-extract hot loop that maps
  domain values to pixels for every `projectToPixels` renderer -- inlined
  `v * slope + intercept` for both axes. On a log scale, `slope`/`intercept` are
  computed in log space (`map(v)` is `log(v) * slope + intercept`), so the loop
  applied the log-space slope to the raw value without taking `log` first. A
  y-log line drew its axis and ticks correctly, then placed every point at the
  wrong pixel -- on a `[1, 1000]` domain the top decade landed tens of thousands
  of pixels above a 400px canvas. Present since the y-log scale shipped in 1.4.1;
  the axis, domain fail-closed, and pan/zoom math were all correct -- only the
  point projection was wrong, and no test asserted a projected pixel.
- **Fix:** the loop is now log-aware for both axes. `xLog`/`yLog` are resolved
  once above the loop, which branches cold into one of four flat bodies
  (linear/linear, log-x, log-y, log-both); a log axis applies
  `v > 0 ? log(v) * slope + intercept : NaN` so non-positive samples break the
  polyline exactly as `map()` does. No per-point type test, no allocation. The
  linear/linear body is byte-identical to before -- the all-linear hot path is
  bit-for-bit unchanged (proven by a 12k-point `Object.is` parity gate).
- **Coverage.** New tests assert projection equals `scale.map(v)` within 1e-9 for
  log-x, log-y, and log-both, and that non-positive samples (including `-0`)
  project to `NaN`. A pure-kernel torture gate (T6.A13) bounds the log branch at
  `maxMajor: 0` with a `<= 2.0 B/op` differential against the identical
  linear-scale projection, and is proven to exercise the log path (one `log()`
  per sample per op) rather than no-op through the paint path.
- **Scope.** Bars are unaffected (`projectToPixels: false` -- bar series are
  never projected through this loop). `xScale: { type: 'log' }` still threw at
  construction as of this release; x-axis log is a separate feature, wired in
  1.6.0.

## [1.5.0] -- 2026-08

A presentation cut. Additive only; no public API breaks vs 1.4.1.

### Added -- donut center label (DOM overlay, CSS-clamped)

- **`centerLabel` on `createDonutChart`.** Renders a number in the donut hole as
  a `pointer-events:none` DOM overlay centered on the ring's inner circle -- NOT
  canvas text, so the font resizes itself. Accepts
  `boolean | string | (() => string) | { text, format, subLabel, color, font,
  minFontSize, maxFontSize }`. `text` and `subLabel` are static-or-signal (an
  accessor makes the label reactive); `format(state) => string` derives the label
  from slice state (defaults to the total of visible slices when `centerLabel:
  true`); an optional `subLabel` renders a smaller line beneath.
- **Font size is owned by CSS `clamp()`.** The overlay's font-size is fixed at
  mount to `clamp(var(--cl-min), calc(var(--cl-fit) / var(--cl-digits)),
  var(--cl-max))`; on data/resize only (sub-Hz) the chart writes the four custom
  properties -- `--cl-fit` from the hole radius, `--cl-digits` from the label
  length, `--cl-min`/`--cl-max` as the floor/cap. More digits shrink the number;
  it tracks the donut as it resizes; there is no per-frame JS and no
  `measureText`. The overlay box is constrained to the hole's inscribed square so
  text cannot overflow the ring.
- **Fail-closed.** `centerLabel` on a chart with no hole (a pie, or a resolved
  `innerRadius` of 0) throws at construction, naming the reason. `minFontSize >
  maxFontSize` also throws.
- **SVG export parity.** `chart.exportSVG()` emits an equivalent centered
  `<text>` (font-size from the same fit formula, plus a second `<text>` for the
  sub-label) so canvas and SVG match. `exportPNG` does NOT include the overlay --
  it is a `toDataURL` of the canvas only; this is intentional and documented.

### Added -- horizontal bar orientation

- **`orientation: 'horizontal'` on `createBarChart`.** Puts the category band on
  the Y axis (category 0 at top, reusing the heatmap y-band convention) and grows
  each bar from the value baseline along X; the value axis moves to the bottom and
  category labels sit right-aligned on the left. Defaults to `'vertical'`; any
  other value throws at construction.
- **The vertical path is byte-identical.** Horizontal selects a peer draw
  function (`makeHBarDrawFn`) once at setup rather than branching per frame, so a
  vertical bar chart draws exactly as it did in 1.4.1. Proven by a SHA-256
  hash-parity test over the five hot draw functions and a differential torture
  redraw (horizontal allocates the same as vertical within sampling noise).
- **Fail-closed subset.** The v1.5.0 cut is a static ranking chart.
  `orientation: 'horizontal'` combined with `pan`, `zoom`, `brush`, a value-axis
  `grid`, or a log value axis throws at construction, naming the reason, rather
  than half-wiring the interaction. Those combinations are planned for a later
  1.5.x. `crosshair().snapPixelX` reports the band-axis pixel when horizontal.

### Performance / bundle

- **Zero hot-path cost.** The overlay is a DOM sibling of the canvas, never a
  scene node, so `makeSliceDrawFn` and the per-frame scene walk gain zero bytes
  and zero branches; a plain donut pays one construction-time null check. Proven
  by the torture gate: a labelled-donut redraw allocates the same as an
  unlabelled one within sampling noise (`report.ok`, `maxMajor:0`), and 4096
  text-signal writes stay within a small per-op budget.
- **Horizontal bars add no per-frame branch.** The orientation is resolved to a
  peer draw function and a pixel-range swap at setup; the per-bar draw loop is
  unchanged, and vertical output is byte-identical to 1.4.1.
- **Kernel isolation preserved.** The center label lives entirely in the polar
  kernel and horizontal bars entirely in the axis kernel; the `line` / `heatmap`
  bundles are byte-identical to 1.4.1 and contain neither `centerLabel` /
  `--cl-fit` nor `makeHBarDrawFn`.

### Demo

- **`demo/index.html` showcases all three v1.5.0 surfaces.** A horizontal-bar
  ranking section; a dynamic donut `centerLabel` (live total in the hole with a
  "scale x100" toggle that visibly steps the clamp font down as the digit count
  grows); and a log-y chart with `pan` + `zoom` enabled -- the v1.4.1 C0 proof,
  previously absent from the demo. Demo version strings bumped to v1.5.0.

## [1.4.1] -- 2026-07

A correctness patch: **a log-scale chart could not be panned or zoomed**. v1.4
shipped log scale, pan, and zoom as independent opt-ins, but enabling log plus
either interaction ran the pan/zoom arithmetic in DATA space on a LOG axis --
the first gesture produced a wrong or invalid domain (findings LC-01..LC-05).
No public API changes; the fix is in the interaction math and scale validation.

### Fixed -- C0: log-axis pan/zoom is correct and fail-closed (LC-01..LC-05)

- **Log-aware pan/zoom math** (`_applyPanLog` / `_applyZoomLog`, exported via
  `_testHelpers` alongside the linear pair). They operate in LOG space --
  `Math.log` the bounds, apply the pixel delta there, `Math.exp` back -- so a
  drag of `d` px on an `n`-decade axis multiplies both bounds by `10^(n*d/plotH)`
  (LC-01/LC-02) and no gesture can drive a bound to zero or negative (LC-03). A
  `+50px` drag on `[1, 1000]` / 400px now yields `yMin = 2.371`, not `125.875`.
- **Per-axis branching.** The pan and zoom handlers consult `xScale.type` and
  `yScale.type` independently, so a linear-x / log-y chart pans with log math on
  y and linear math on x. The all-linear path still calls the untouched
  `_applyPan` / `_applyZoom` and is byte-identical (asserted by a parity test) --
  a linear chart's behaviour and cost do not move in this patch.
- **A log-axis floor.** exp() over a bounded log range keeps a free (unbounded)
  pan or a long zoom-out from drifting the domain to `0` / `Infinity` -- "a log
  axis has no bottom", so it stops at a representable floor instead.
- **`updateLogScale` fails closed (LC-04).** It now THROWS on a non-positive,
  collapsed, or NaN domain, naming the offending bound, instead of silently
  substituting `dMin = 1e-10`. The domain-extraction caller floors the domain to
  its positive extent BEFORE the call; a log y-axis with NO positive data throws
  at mount ("needs positive data") rather than drawing a fabricated `1..10`. The
  failed mount is atomic -- it disposes what it created, leaking no signal node.
- **x-log is fail-closed until v1.5.0 (LC-05).** `xScale: { type: 'log' }` now
  throws at construction. It was half-wired (the x-scale is always linear while a
  few paths branched on `xScale.type === 'log'`), which would pan and label an
  x-log chart with linear math -- worse than unsupported.

### Added -- torture / stress suite (tests only; no shipped-code change)

A LiteBvh-style torture gate under `test/torture/`, run with
`npm run torture` (`node --expose-gc test/torture.mjs`, prints `ok`).
Modelled on the ecosystem's zero-GC discipline: a seeded xorshift32 PRNG
with `TORTURE_SEED` replay, thunk-only assertions, and an
`@zakkster/lite-gc-profiler` gate at `maxArrayBuffersGrowth: 0` with
`stabilize: 'deep'` -- the rule that finally sees the SoA pixel pools
(ArrayBuffer backing stores are invisible to a `heapUsed` delta). Tiers:

- **T0 laws** -- scale round-trips, monotonicity, endpoint pinning,
  decimation extrema preservation, pan invertibility, zoom anchor
  preservation, `_clampToBounds` containment.
- **T1 degenerate** -- every chart type x {empty, single, identical, NaN,
  +/-Infinity, 1e-300, 1e300, unsorted x, duplicate x, all-negative-on-log},
  each with a pinned answer; the +/-Infinity, 1e300 and log-clamp cases pin
  the shipped **fail-open** behaviour (LC-04 family) so a later fail-closed
  fix flips the pin loudly.
- **T3 decimation** -- `decimateMinMax` vs a naive oracle under sawtooth,
  single-spike, monotone, all-equal, edge-inclusive and dense-random inputs.
- **T5 oracle** -- differential: a chart driven by a random view walk equals
  one built with only the final view (path independence), and `resetView()`
  restores a pristine chart (idempotence); `exportSVG()` is the pixel witness.
- **T6 alloc** -- the zero-alloc gate over the decimation/scale kernel, a
  `redraw()` loop, and a pointer+wheel event storm; pins pool `byteLength`.
- **T7 soak** -- 4096 create/mount/destroy cycles across all nine chart
  types; `destroy()` returns `activeNodes` / `activeLinks` (lite-signal
  `stats()`) and canvas listeners to baseline every cycle, with an
  `@zakkster/lite-leak` second witness and flat `arrayBuffers`.
- **T8 export + resize** -- `exportSVG` size stays bounded and does NOT scale
  with point count (decimation caps it at pixel-column resolution) at
  1k/100k/1M points; a 10k-callback `ResizeObserver` storm (zero-width,
  sub-pixel, oscillating) accumulates no observers and stays buffer-flat.
- **T9 controls** -- every gate is proven able to fail (alloc gate, observer
  gate, listener gate, decimation comparator, log-domain predicate, the
  LC-04 clamp, the SVG ceiling, RO accumulation).

Whole-suite control: `CHARTS_TORTURE_BREAK=1 npm run torture` injects
retained allocations into T6 and must exit non-zero.

The **C0 regression net** (tier `T-LOG`, also runnable standalone via
`npm run torture:logfuzz`): seeded pan/zoom gestures on a log axis, asserting
the y-domain stays positive and finite. It was RED on 1.4.0 (the finding: linear
math on a log domain) and is GREEN as of this release's log-aware branch, so it
now runs inside the green `npm run torture` gate.

Adds `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak` (plus the four
runtime peers) as `devDependencies` for local test resolution. Ships nothing:
the `files` allowlist still publishes only `Charts.js` and its docs.

## [1.4.0] -- 2026-06

The v1.4 release. Three new interaction primitives on axis-kernel
charts (log scale, pan + zoom, brushing) plus four pre-existing
allocation traps closed during a bare-metal audit. No public API
breaks vs v1.3.0; the new features are all opt-in.

Same code as v1.4.0-alpha.3 -- this is the curated rollup. The four
alpha entries below remain as the detailed historical record.

### Added -- interaction primitives

- **Log scale on the y-axis.** Opt in with
  `yScale: { type: 'log' }` on any axis-kernel chart (line, area,
  bar, bubble, scatter). Base-10 log; ticks route through
  `@zakkster/lite-axis`'s `logTicks` (decade boundaries 1, 10, 100,
  ...). `map(v <= 0)` returns NaN -- line / area break the segment,
  markers skip. Polymorphic `s.map()` in tick projection handles
  linear and log uniformly without a parallel code path.
- **Pan + zoom.** Opt in with `pan: true` and/or `zoom: true`.
  Pointer-drag pans (cursor-anchor convention, d3-zoom / Plotly /
  Google Maps style: the data point under the cursor stays under
  the cursor). Wheel zooms around the cursor. `chart.view` is a
  reactive accessor mirroring the crosshair facade: `view()`
  reads (tracked), `.peek()` reads untracked, `.set(v)` writes,
  `.reset()` clears. Imperative aliases `chart.setView(v)` and
  `chart.resetView()`. View shape `{ xMin, xMax, yMin, yMax }`
  (each field nullable for "fall back to data domain") is
  intentionally symmetric with `lite-camera-max`'s camera signal
  so the same value drops into a lite-gl `project()` function
  unchanged when the `@zakkster/lite-charts-gl` companion package
  lands. Configuration: `panBounds: 'data' | 'free'` (default
  'data' clamps to data domain; 'free' allows past), `zoomMin` /
  `zoomMax` as visible-span / data-span ratios (defaults
  0.01 / 1000), `zoomStep` wheel ratio per tick (default 1.15).
- **Brushing.** Opt in with `brush: true`. Shift+drag selects a
  rectangle; `chart.brush` emits
  `BrushSelection { xMin, xMax, yMin, yMax, ids }` -- data-space
  bounds plus indices into the primary series. Same reactive facade
  shape as `chart.view`. Modifier routing: bare drag = pan (when
  `pan: true`), shift+drag = brush (when `brush: true`), wheel = zoom
  regardless of modifier. Click-to-clear: shift+click with total
  drag distance under 3 px clears the brush (matches d3-brush).
  Live updates per pointermove so cross-chart linking via `effect()`
  reflects the drag in real time. Visual: translucent rect overlay
  rendered after the crosshair node so it sits on top; defaults to
  indigo accent fill + dashed outline, overridable via
  `brushStyle: { fill, stroke, lineDash, lineWidth }`.

### Fixed -- four allocation traps closed (audit)

A bare-metal review surfaced four allocation traps inherited from
v1.2-1.3 code. All four are fixed without any public API change.

- **Heatmap quantile gather/sort.** Was `const present = []` +
  `push()` + `sort(cmp)` -- on a 200x200 dense heatmap that's a
  40k-element JS Array allocated per data update. Now: pooled
  `Float32Array` on `state.presentSorted`, pack values into a
  prefix, sort an in-place `subarray(0, n)` view via
  `Float32Array.prototype.sort()` (no comparator, sorts numerically,
  zero alloc).
- **`_parseRGBLike` per-cell split.** `css.slice(...).split(',')`
  per cell at extract -- 10k cells = 10k Arrays + 30k substrings.
  Now: `indexOf` scan with three substring slices total.
- **`charBufToString` rope walk.** `let s = ''; for (...) s +=
  String.fromCharCode(buf[i])` allocated N intermediate strings
  via V8's rope walk. Now: `String.fromCharCode.apply(null,
  buf.subarray(0, n))` -- one call, one allocation.
- **SVG-export rope-string limit (most consequential).**
  `this._currentPath += chunk` on every path command could hit
  V8's max rope length at 100k+ points and throw `RangeError:
  Invalid string length`, or stall the main thread for seconds
  during the rope flatten. Now: array-of-chunks; every path
  command pushes into `this._pathChunks`, `_pathD()` joins
  exactly once at stroke/fill/clip. 50,000-point scatter chart
  now exports to a 5.2 MB SVG with 50,021 path elements in
  165 ms; pre-fix this would have either crashed or stalled.

### Tests

320 tests (vs 1.3.0's 259, +61 across the alpha line). New suites:
log scale math + end-to-end (alpha.0); audit-fix regressions
(alpha.1); pan/zoom math + view-facade + integration (alpha.2);
brush math + facade + integration (alpha.3).

### Performance

- **Bench unchanged through the entire alpha line.** All four
  features target paths that fire on data-update, gesture, or
  export -- not on the per-frame draw. Steady-state bench is in
  the same 161-167 bytes/cycle noise band as v1.3.0's 161.
- **Bundle deltas vs v1.3.0** (axis-kernel charts grew; non-axis
  kernels essentially unchanged):

  | Chart | v1.3.0 | v1.4.0 | Delta |
  |---|---|---|---|
  | line | 32.5 KB | 39.9 KB | +7.4 |
  | area | 33.8 KB | 41.2 KB | +7.4 |
  | bar | 33.8 KB | 41.2 KB | +7.4 |
  | bubble | 33.6 KB | 41.0 KB | +7.4 |
  | scatter | 30.8 KB | 38.2 KB | +7.4 |
  | pie | 22.1 KB | 22.3 KB | +0.2 |
  | donut | 22.1 KB | 22.3 KB | +0.2 |
  | radar | 22.0 KB | 22.2 KB | +0.2 |
  | heatmap | 21.6 KB | 22.0 KB | +0.4 |
  | **all-nine** | **82.4 KB** | **90.2 KB** | **+7.8** |

  ~7.4 KB per axis-kernel chart: ~0.7 from log scale, ~0.1 from
  audit fixes, ~3.7 from pan/zoom, ~2.9 from brushing. Heatmap's
  +0.4 KB is the new `presentSorted` state field from the quantile
  audit fix. Cross-kernel isolation verified at every alpha:
  heatmap, pie, donut, radar bundles contain none of the
  axis-kernel interaction code.

### Types

Three new interfaces in Charts.d.ts: `View`, `PanZoomConfig`,
`BrushConfig` + supporting `BrushSelection`, `BrushStyleConfig`.
`LineChartConfig`, `BubbleChartConfig`, `ScatterChartConfig` extend
`PanZoomConfig` and `BrushConfig`. Bar inherits via the existing
`Omit<LineChartConfig, ...>` chain. `Chart` interface gains `view`,
`setView`, `resetView`, `brush`, `setBrush`, `clearBrush`.
`yScale.type` accepts `'linear' | 'log'` (was `'linear'` only).

### Scope of the interaction primitives

- **Axis-kernel charts** (line, area, bubble, scatter) are the
  primary targets and get full support.
- **Bar** inherits typing for pan/zoom/brush but its band x-axis
  isn't ideal -- panning a band domain produces visually weird
  results. Not documented as supported in v1.4.
- **Polar (pie/donut), radar, heatmap** don't get pan/zoom/brush.
  Different interaction models (pie has no x/y space; heatmap
  uses band scales on both axes).
- **Log + pan/zoom**: linear arithmetic is used on the data domain
  regardless of scale type. The chart still renders, but pan
  magnitude on a log chart won't feel right and zoom centered on
  log will skew. Log-aware pan/zoom math is a future enhancement.

### Forward plan

The view-signal shape `{ xMin, xMax, yMin, yMax }` was chosen
specifically to drop unchanged into a future `@zakkster/lite-charts-gl`
companion package (separate npm package built on `@zakkster/lite-gl`).
That work is the post-v1.4 track; lite-charts core stays canvas-only
and node-testable. See ROADMAP.md for the full picture.

### License

MIT (c) Zahary Shinikchiev


## [1.4.0-alpha.3] -- 2026-06

Brushing lands as the final v1.4 alpha. Shift+drag selects a
rectangular region; the chart emits the data-space bounds plus
indices into the primary series via `chart.brush`. Coexists with
pan/zoom: no modifier routes to pan, shift routes to brush, wheel
zooms regardless. A `v1.4.0` combined release follows next.

### Added -- shift+drag brushing

- **`brush: true`** -- enables shift+drag rectangle selection on any
  axis-kernel chart (line, area, bubble, scatter; bar inherits typing
  but the band x-axis caveat from alpha.2 applies). When neither
  `pan`, `zoom`, nor `brush` is set, no listeners attach and no
  signal is allocated -- zero cost. Setting any one of the three
  enables the listener cluster.
- **`chart.brush`** -- reactive facade mirroring `chart.view`. Reads
  `BrushSelection | null` (with tracking), `.peek()` reads untracked,
  `.set(v)` writes (null clears), `.clear()` clears. Imperative
  aliases `chart.setBrush(v)` and `chart.clearBrush()` available too.
  All three throw if `brush: true` was not in config -- intentional,
  signals the opt-in requirement.
- **`BrushSelection`** shape `{ xMin, xMax, yMin, yMax, ids }` --
  data-space bounds plus indices into the primary series. `ids` is
  freshly allocated on every gesture commit (not pooled; brushing is
  sub-Hz so the allocation is acceptable; pooling would alias across
  brushes). Programmatic `setBrush()` leaves `ids` as null unless
  you pass them yourself -- the API never recomputes ids on your
  behalf when you set the brush imperatively.
- **`brushStyle: { fill, stroke, lineDash, lineWidth }`** -- visual
  override for the rect overlay. Defaults to translucent accent fill
  (`rgba(99, 102, 241, 0.15)`) with a dashed accent outline
  (`rgba(99, 102, 241, 0.7)`, `[4, 4]` dash, 1px). Pass `lineDash: []`
  for a solid outline.

### Interaction model

- **Modifier routing.** Pointerdown checks `ev.shiftKey`. If brush is
  enabled AND shift is held, the pan listener returns early -- the
  brush listener takes the gesture. If brush is enabled but shift is
  NOT held, pan handles the drag (when pan is enabled) or nothing
  happens. If brush is NOT enabled, the modifier is ignored.
- **Click-to-clear.** A shift+click with total drag distance under
  3 pixels is treated as a click and clears the existing brush.
  Matches d3-brush's default behavior.
- **Live updates.** Brush signal updates on every `pointermove`
  while the gesture is active -- cross-chart linking via `effect()`
  reflects the user's drag in real time. Final commit fires on
  `pointerup`. Subscribers can debounce in user code if needed.
- **Crosshair suppression.** Pointerdown hides the crosshair once;
  it resumes naturally on next mousemove after pointerup (same
  pattern as pan).
- **Visual.** A translucent rect overlay renders on top of the
  crosshair (added to scene root after the crosshair node) when a
  brush is set. The overlay reads brush data untracked; a dirty
  bridge effect tracks `brushSig()` and marks the scene dirty.

### Architecture

- **Math helpers are pure module-level.** `_normalizeBrushRect(px0,
  py0, px1, py1)` orders a drag rect into min/max corners.
  `_brushPxToData(rect, xScale, yScale)` converts pixel space to
  data space via the live scales (y-axis flipped so `pyMin` -> `yMax`,
  `pyMax` -> `yMin`). `_computeBrushIds(xs, ys, n, xMin, xMax, yMin,
  yMax)` scans a series for points inside the rect. All three
  exported via `_testHelpers`; tree-shaken away in builds that don't
  use brush.
- **Coexistence with pan/zoom.** The brush state machine
  (`brushActive`, `brushStartX/Y`, `brushCurrentX/Y`) is fully
  independent of pan's drag state. Both can be in-flight only if
  the user starts a gesture with shift held; otherwise the modifier
  routing in pointerdown ensures exclusivity. The pointer-event
  family used by pan and brush is identical (pointerdown/move/up/
  cancel/leave), so they share the same setPointerCapture flow.
- **IDs from primary series.** `seriesStates[0]` -- the first series
  in `series[]`, or the single-series `data` when that shorthand is
  used. Multi-series filtering is the caller's responsibility; the
  brush bounds are the universal hook (they can compute their own
  per-series ids from the bounds).

### Tests

320 tests (+16 over alpha.2), 69 describe blocks.

- `brush math (v1.4.0-alpha.3)` -- 6 tests.
  `_normalizeBrushRect` orders corners regardless of drag direction
  (top-left -> bottom-right, bottom-right -> top-left, mixed).
  `_brushPxToData` correctly inverts the rect through linear scales
  with y-flip (pyMin pixel -> yMax data, pyMax pixel -> yMin data).
  `_computeBrushIds` returns indices inside the rect, inclusive at
  boundaries, handles empty selection, handles zero-length input.
- `brush facade (v1.4.0-alpha.3)` -- 5 tests. Chart without
  `brush: true` returns null and throws on set/clear (matches view's
  pattern). Opting in exposes a working facade. setBrush rejects
  malformed input. Brush is reactive -- a `lite-signal` `effect()`
  fires on every set/clear. Pan + brush coexist (both enabled, both
  facades work independently).
- `brush integration -- shift-drag (v1.4.0-alpha.3)` -- 5 tests
  using the extended mock canvas from alpha.2. shift+drag commits
  a brush; bare drag (no shift) does NOT initiate brush when pan
  is off; shift+drag is brush even when pan is enabled (modifier
  routing); shift+click without movement clears existing brush
  (sub-3px threshold); programmatic setBrush leaves ids as null
  (documented behavior).

### Performance

- **Bench unchanged**: 164.0 bytes/cycle (vs alpha.2's 164.7 --
  noise band). Brush listeners only fire on pointer events; the
  per-frame draw budget is untouched.
- **Bundle deltas vs alpha.2**: line +2.9 KB, bar +2.9 KB, bubble
  +2.8 KB, scatter +2.9 KB. Heatmap, pie, radar UNCHANGED (kernel
  isolation verified -- no `_normalizeBrushRect` / `_brushPxToData`
  / `_computeBrushIds` / `brushFacade` strings in those bundles).
  All-nine bundle: 87.3 -> 90.2 KB (+2.9 KB; the brush helpers are
  shared module-level, deduplicated by the bundler).

### Documentation

- Charts.d.ts: `BrushSelection`, `BrushStyleConfig`, `BrushConfig`
  interfaces; `Chart` gains `brush`, `setBrush`, `clearBrush`;
  `LineChartConfig`, `BubbleChartConfig`, `ScatterChartConfig`
  extend `BrushConfig`. Bar inherits via the existing Omit chain.

### Scope (unchanged from alpha.2)

- **Axis-kernel charts only.** Polar (pie/donut), radar, and grid
  (heatmap) kernels don't get brushing. Different interaction
  models -- pie has no x/y rect to select; heatmap selection
  would be cell-based, not bounds-based.
- **Linear math.** For `yScale: { type: 'log' }` charts, brush
  bounds are still in data space (the chart's invert handles log
  internally) -- the brush rect maps correctly. But points "inside"
  a log-brushed region are still computed via simple bound checks
  on the data values, which is correct in either scale type.
- **No keyboard modifiers other than shift.** alpha.3 ships with
  fixed shift binding; configurable modifier is a follow-up.

### v1.4.0 next

The v1.4 alpha line is complete: alpha.0 log scale, alpha.1 audit
fixes, alpha.2 pan + zoom, alpha.3 brushing. The combined v1.4.0
release follows -- same code as alpha.3 plus a clean release-notes
rollup, no further API or behavior changes.

### License

MIT (c) Zahary Shinikchiev


## [1.4.0-alpha.2] -- 2026-06

Pan + zoom on axis-kernel charts. Opt-in via `pan: true` and/or
`zoom: true`. View signal `{ xMin, xMax, yMin, yMax }` is intentionally
symmetric with `lite-camera-max`'s camera signal so the same value
drops into a lite-gl `project()` function unchanged when the
`@zakkster/lite-charts-gl` companion package lands. Brushing
(originally alpha.2) shifts to alpha.3.

### Added -- mouse-drag pan + wheel zoom

- **`pan: true`** -- pointer-drag (left button) pans the visible
  domain. The data point under the cursor at pointerdown stays
  under the cursor as it moves -- the cursor-anchor convention used
  by d3-zoom, Plotly, and Google Maps. Drag right shifts view LEFT
  in data space (you see more leftward data); drag up shifts view
  DOWN in data space (content rolls up with the cursor). pointer
  events (`pointerdown`/`move`/`up`/`cancel`/`leave`) are used
  uniformly so pen, touch, and mouse all work. Uses
  `setPointerCapture` when available so a drag that escapes the
  canvas still completes correctly.
- **`zoom: true`** -- mouse wheel zooms around the cursor. The data
  point under the cursor stays at the same screen pixel; range
  scales by `zoomStep` per wheel notch (default 1.15 = 15% per
  tick). `wheel` listener is registered with `passive: false` and
  calls `preventDefault()` so page-scroll doesn't fight the zoom.
- **`chart.view`** -- reactive view accessor mirroring the
  crosshair-facade pattern: `chart.view()` reads (tracks), `.peek()`
  reads untracked, `.set(v)` writes, `.reset()` clears.
  `chart.setView(v)` and `chart.resetView()` are imperative
  aliases. Setting `null` (or passing `null` to setView) returns
  the chart to following the data-derived domain. Partial views
  work: `setView({ xMin: 0, xMax: 100 })` overrides x and leaves y
  to auto-fit from data. View shape symmetric with
  `lite-camera-max`'s camera signal for future lite-gl drop-in.
- **`panBounds: 'data' | 'free'`** -- bounds policy. Default
  `'data'` clamps the view to the data domain; if a zoom would
  make the view wider than data, it snaps to the full domain.
  `'free'` allows any view (extends past data, useful for
  showing context around the data range).
- **`zoomMin`, `zoomMax`** -- minimum and maximum zoom factor
  expressed as a ratio of visible-span to data-span. Defaults
  `0.01` and `1000` (zoom in until visible is 1% of data; zoom
  out until visible is 1000x of data). Setting both equal
  disables wheel zoom while keeping the math configuration
  consistent.
- **`zoomStep`** -- wheel ratio per tick. Default `1.15`; clamped
  to `>= 1.001`.

### Architecture

- **Opt-in is zero-cost.** When neither `pan` nor `zoom` is set,
  no view signal is allocated and no listeners attach. Charts that
  don't want interactions pay exactly nothing extra over v1.4.0-
  alpha.1.
- **View-override layer.** Sits between data-domain extraction and
  the scale-update calls. Reads `viewSig()` (tracked) and
  overrides `dxMin/dxMax/yBase[0]/yBase[1]` with the view's
  non-null fields. The scale-update effect already runs whenever
  data, plot bounds, or visibility change; adding view as a
  dependency means a single `chart.setView()` triggers a full
  re-project + redraw via the existing reactive plumbing.
- **`_dataDomain` snapshot.** Plain object (not a signal) populated
  by the scale-update effect every time it runs. Listeners read
  it inside event handlers for bounds clamping without touching
  the reactive graph. Allocated only when `interactionsEnabled`.
- **Math helpers are module-level + pure.** `_applyPan`,
  `_applyZoom`, `_clampToBounds` are exported via `_testHelpers`
  so scale math can be unit-tested without standing up a full
  chart. Pulling them out of the kernel closure also means tree-
  shaking can drop them in builds that don't use pan/zoom (they
  reach the chart only through the listener closures, which are
  only constructed when `interactionsEnabled`).
- **Crosshair suppression.** During an active drag the listener
  calls `hideCrosshair()` once on pointerdown. Resumes naturally
  on next mousemove after pointerup. The pan and crosshair
  systems share the canvas but don't share state.

### Scope

- **Axis-kernel charts only**: line, area, bubble, scatter inherit
  the typing via `LineChartConfig extends PanZoomConfig` (and
  bubble/scatter directly). Bar inherits via the existing
  `Omit<LineChartConfig, ...>` chain but its band x-axis is
  best-effort -- the math assumes a linear/time x and panning a
  band domain produces visually weird results. Bar pan/zoom is
  a future-proper-fix cut.
- **Linear arithmetic.** alpha.2 implements linear pan + zoom math.
  For `yScale: { type: 'log' }` (from alpha.0) the math is
  technically wrong (it adds and scales in data space rather than
  log space) -- the chart still renders, but pan magnitude won't
  feel right and zoom centered on a log scale will skew. A log-
  aware path is a small follow-up; we wanted the API and the
  linear-case behavior stable first.
- **Polar / radar / heatmap** kernels don't get pan/zoom in
  alpha.2 (different interaction models -- pie has no x/y space;
  heatmap uses band scales on both axes).

### Tests

304 tests (+24 over alpha.1), 63 describe blocks. New suites:

- `pan + zoom math (v1.4.0-alpha.2)` -- 10 tests. `_applyPan`:
  drag-right shifts view left (cursor convention), drag-up shifts
  view down (y-flip), zero drag is identity. `_applyZoom`: zoom-in
  centered on plot middle halves the range, zoom-in preserves the
  cursor's data anchor at the same pixel, zoom-out widens, y
  anchor is flipped (top of plot = yMax). `_clampToBounds`: view
  inside data is unchanged; view extending past xMin shifts right;
  view extending past xMax shifts left; view wider than data snaps
  to full domain; x and y clamp independently.
- `view facade + scale integration (v1.4.0-alpha.2)` -- 5 tests.
  Charts without pan/zoom return `view() === null` and throw on
  set/reset (signals the opt-in requirement). Opting in exposes a
  working facade. setView rejects non-object inputs. View changes
  flow through to `xScale.dMin` / `dMax` and partial views fall
  back to data on unset axes. View is reactive -- a `lite-signal`
  `effect()` subscribed to `chart.view()` fires on every set/reset.
- `pan + zoom integration (v1.4.0-alpha.2)` -- 7 tests using an
  extended mock canvas with `addEventListener`. pointerdown +
  move + up updates view in the expected direction. wheel down
  zooms out, wheel up zooms in (cumulative wheel events compound).
  `panBounds: 'data'` clamps a far drag to the data domain;
  `panBounds: 'free'` lets it extend past. Right-click drag does
  not initiate pan (`button > 0` is rejected). Pointerdown in
  the chart margin (outside the plot rect) is rejected.
  `chart.destroy()` removes all listeners (post-destroy dispatch
  doesn't throw or mutate).

### Performance

- **Bench unchanged**: pan/zoom doesn't touch the per-frame draw
  path. View overrides happen once per scale update (the same
  cadence as data changes and resizes), and the math helpers are
  invoked only on pointer/wheel events (sub-Hz under normal use).
- **Bundle deltas**: line +3.7 KB, area +3.9 KB, bar +3.7 KB, bubble
  +3.9 KB, scatter +3.7 KB vs alpha.1 -- the listener cluster
  (pointerdown/move/up/cancel/leave + wheel + their disposers), the
  viewFacade construction, and the closure-captured math helpers
  together add up. Larger than the "~1.2 KB" I'd estimated mid-build;
  reporting actuals here. Heatmap unchanged (grid kernel doesn't pull
  pan/zoom code); pie/donut +0.1 KB and radar +0.2 KB (shared module-
  level code touched). All-nine bundle: 83.1 -> 87.3 KB (+4.2 KB).
  Cross-kernel isolation verified: heatmap, pie, donut, and radar
  bundles contain no `_applyPan` / `_applyZoom` / `_clampToBounds` /
  `viewFacade` strings.
- **Allocations per gesture**: pointerdown allocates one stable
  refs object (`dragStartView`, `dragPlotBounds`) and one
  `_dataDomain` read into a stack `start` object on wheel; per-
  move allocates the new view object passed to `viewSig.set()`.
  This is the natural cost of a value-signal API (set takes a
  fresh object); not on a per-frame budget.

### Documentation

- Charts.d.ts gains `View` and `PanZoomConfig` interfaces;
  `LineChartConfig`, `BubbleChartConfig`, `ScatterChartConfig`
  extend `PanZoomConfig`. `Chart` interface gains `view`,
  `setView`, `resetView`.

### Roadmap shift

- v1.4.0-alpha.3 = brushing (was alpha.2). Modifier-key drag
  emits `brushSignal` for cross-chart filtering. Will coexist
  with pan/zoom (no modifier = pan, shift = brush).
- v1.4.0 = combined release.

### License

MIT (c) Zahary Shinikchiev


## [1.4.0-alpha.1] -- 2026-06

Audit-fix-only release. Four allocation traps inherited from v1.2-1.3
code surfaced in a bare-metal review; all four are fixed here without
changing any public API. The v1.4 interaction-primitives work
(pan + zoom in alpha.2; brushing in alpha.3) is shifted one alpha slot
forward to keep this cut tightly scoped.

### Fixed -- four allocation traps on the data-update + export paths

- **Heatmap quantile JS Array.** `_computeGridColors` collected present
  cell values into `const present = []` then `present.push(...)` then
  `present.sort(cmp)`. On a 200x200 dense heatmap that was a 40k-element
  JS Array allocated and thrown away on every data update. Replaced with
  a `Float32Array` pooled on `state.presentSorted` -- pack values into
  a prefix, sort an in-place `subarray(0, n)` view via
  `Float32Array.prototype.sort()` (which without args sorts numerically
  and allocates nothing). Pool grows monotonically with chart size;
  steady-state is zero-alloc.
- **Heatmap `_parseRGBLike` per-cell split.** When `colorFn` returned an
  `rgb(...)` string and `valueLabelColor === 'auto'`, the parse called
  `css.slice(open + 1, close).split(',')` -- per cell, at extract time.
  10k cells = 10k Arrays + 30k substring objects allocated and tossed.
  Replaced with an `indexOf` scan: three substring slices total, no
  intermediate array. V8 may sliced-string the substrings (zero-alloc);
  even if materialized they're tiny (3-4 chars each).
- **`charBufToString` rope walk.** The axis-formatting helper built its
  label string by `let s = ''; for (...) s += String.fromCharCode(buf[i])`,
  which allocates N intermediate strings as V8 walks the rope. For an
  axis with ~20 ticks at ~10 chars each that's ~200 string allocations
  per axis update. Replaced with
  `String.fromCharCode.apply(null, buf.subarray(0, n))` -- one call,
  one allocation, well within V8's arg-count limit at our buffer size.
- **SVG export rope-string limit.** This was the most consequential.
  `_SVGRenderingContext2D` accumulated path commands by
  `this._currentPath += chunk` for every `moveTo` / `lineTo` / etc.
  At 100k points the rope walk on the `<path d="...">` attribute read
  in `stroke()` / `fill()` could hit `RangeError: Invalid string length`
  or stall the main thread for seconds during the rope flatten.
  Replaced with an array-of-chunks: every path command pushes into
  `this._pathChunks`; `_pathD()` does `this._pathChunks.join('')`
  once when stroke/fill/clip needs the d-attribute. Arrays grow
  amortized O(1); join flattens to a single contiguous string exactly
  once. `beginPath()` truncates by `length = 0` (no realloc); the
  `fillRect` / `strokeRect` rotated-fallback path saves and restores
  the chunks array (rare branch -- chart code only hits it on pie
  slice transforms).

### Verified

- **272 + 8 = 280 tests pass.** New regression suite
  `audit-fix regressions (v1.4.0-alpha.1)` covers: 10k-point line
  export produces valid SVG; path d-attribute starts with `M<num>`
  and contains `L<num>` (no rope-flatten artifacts); two consecutive
  exports produce byte-identical output (catches begin/end path
  bookkeeping leaks); pie chart rotated-rect fallback still works;
  50x50 quantile-binned heatmap doesn't throw; quantile output is
  stable on a fixed dataset (Float32Array sort numerically equivalent
  to JS Array sort); auto-label color survives custom `colorFn`
  returning `rgb(...)`; axis labels render correctly after the
  `charBufToString` rewrite.
- **Real-world stress test:** 50,000-point scatter chart exports to
  a 5.2 MB SVG with 50,021 `<path>` elements in 165 ms. No error,
  no main-thread stall. Pre-alpha.1 this would have either crashed
  with `RangeError: Invalid string length` or eaten gobs of memory
  during the rope walk.
- **Bench unchanged**: 166 bytes/cycle (within the natural variance
  of the 161 baseline from alpha.0). All four fixes target paths
  that fire on data-update or export, not on the per-frame draw.
- **Bundles**: line +0.1 KB, bar +0.2 KB, scatter +0.1 KB,
  heatmap +0.4 KB vs alpha.0. The heatmap delta is the new
  `presentSorted: null` field on grid state plus the chunk-style
  comments; everything else is comments and minor structural
  changes.
- **ASCII clean** across all source files (whitelisted U+00D7 only).

### Credits

The audit was provided by the user; the fixes match the recommended
patterns exactly (Float32Array pool + in-place sort, `indexOf` scan,
`String.fromCharCode.apply`, array-of-chunks + `join`). Each fix
landed with a code comment naming the trap it closes so future
readers don't accidentally reintroduce the pattern.

### License

MIT (c) Zahary Shinikchiev


## [1.4.0-alpha.0] -- 2026-06

First alpha of the v1.4 interaction-primitives line. Pan + zoom (alpha.1)
and brushing (alpha.2) follow before a combined v1.4.0 release.

### Added -- log scale on the y-axis

Opt in with `yScale: { type: 'log' }` on any axis-kernel chart (line,
area, bar, bubble, scatter). Log scale is base-10; tick generation
routes through `@zakkster/lite-axis`'s already-shipped `logTicks`
(decade boundaries 1, 10, 100, ...).

- **`makeLogScale()` + `updateLogScale(s, dMin, dMax, rMin, rMax)`** --
  new scale builders alongside the linear and band ones. Same shape
  as `makeLinearScale` (`type`, `dMin/dMax/rMin/rMax`, cached
  `_slope/_intercept/_invSlope`) but `map(v)` does
  `Math.log(v) * slope + intercept` and `invert(px)` does
  `Math.exp((px - intercept) * invSlope)`.
- **`map(v <= 0)` returns NaN.** Line and area draw fns already break
  the segment on NaN; markers (bubble, scatter) skip non-finite
  positions. Callers responsible for filtering non-positive values
  from the upstream data if they want a different policy.
- **`updateLogScale` clamps `dMin <= 0`** to `1e-10` as a safety net
  so a degenerate domain doesn't break the chart -- ideally the
  chart's domain extraction filters non-positive values first, but
  this catches the case where it doesn't.
- **`yScale.type` now accepts `'linear' | 'log'`** in `Charts.d.ts`
  (was `'linear'` only). The existing `domain`, `nice`, `zero`
  options remain.

### Internals

- **Polymorphic `s.map()` in tick projection.** Was an inlined
  `tickBuf[i] * slope + intercept` in both the main axis builder and
  the grid-extras builder. Switched to `s.map(tickBuf[i])` so the same
  loop handles linear and log without a parallel code path. Cost: one
  method call per tick. This is the once-per-resize tick projection,
  ~12 calls per axis update, sub-Hz update rate -- perf-irrelevant
  trade for code clarity. Hot draw paths (per-frame point projection)
  remain untouched.
- **Tick switch.** Both axis builders gained an `else if (s.type ===
  'log')` branch alongside the existing `'time'` branch:
  `count = logTicks(s.dMin, s.dMax, target, tickBuf, false)`. The
  `minor` flag (5x/2x sub-ticks per decade) is off for v1.4.0-alpha.0;
  may be exposed via `tickSubdivisions: 'major' | 'all'` in a later
  cut.
- **`_testHelpers` exports `makeLogScale` and `updateLogScale`** so
  scale math can be unit-tested without standing up a full chart.

### Tests

272 tests (+13 over v1.3.0), 52 describe blocks. New under `log scale
(v1.4.0-alpha.0)`:

- `makeLogScale math` (7 tests): decade boundaries map to evenly-
  spaced pixels; `invert(map(v))` round-trips to within 1e-9
  relative error across [0.01, 1000]; `map(v <= 0)` returns NaN;
  `updateLogScale` clamps non-positive bounds; degenerate domain
  (`dMin === dMax`) collapses cleanly without throwing; swapped
  bounds (`dMax < dMin`) are reversed; the scale object has the
  same shape as the linear scale (same keys present).
- `end-to-end -- yScale: { type: 'log' }` (6 tests): line chart
  constructs and mounts; scatter chart constructs and mounts;
  default remains `'linear'` when no opt-in (back-compat);
  scale type survives data updates; SVG export works with log
  y-scale; tick labels reflect decade boundaries.

### Performance contract

- **Bench unchanged**: 325 bytes/cycle on the line-100k full-update
  bench. The log-scale path isn't on the per-frame draw; the
  `s.map()` switch in tick projection is once-per-resize.
- **Bundle deltas**: scale builders + tick switch + `logTicks` import
  add ~600 bytes per axis-kernel chart. The grid kernel (heatmap) is
  untouched -- heatmap uses band scales on both axes and doesn't
  pull the linear/log code.

### Demo

- Side-by-side log-scale comparison section: same exponential dataset
  (`y = 10^(x/8)`, x in [0, 40], y in [1, 1e5]) rendered with linear
  y on the left and log y on the right. The linear panel crushes the
  first ~80% of x against the axis; the log panel renders a clean
  straight line (because `log(10^(x/8)) = x/8`).

### Roadmap

- ROADMAP.md, README.md, llms.txt updated with a refined v1.4 alpha
  breakdown (alpha.0 log, alpha.1 pan+zoom, alpha.2 brushing) and a
  new `@zakkster/lite-charts-gl` companion-package track for the
  post-v1.4 timeline. lite-charts core stays canvas-only and node-
  testable; the GPU sibling lives in its own package built on
  `@zakkster/lite-gl`. v2.0 WebGPU speculation replaced with concrete
  "renderer-agnostic kernel refactor if lite-charts-gl proves out".

### License

MIT (c) Zahary Shinikchiev


## [1.3.0] -- 2026-06

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
  none of the v1.3.0 chart code uses them.
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
per-chart semantics; for v1.3.0 the pixel-parity approach is the right
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

| Chart | v1.2.0 | v1.3.0 | Delta |
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
`chart.exportSVG() (v1.3.0)`: valid SVG envelope per chart type (line,
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


## [1.2.0] -- 2026-06

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
