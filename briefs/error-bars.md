# Brief #18 -- Error bars / confidence bands (v1.21.0 candidate)

Status: EXECUTED 2026-09-08 as the v1.21.0 candidate (queue position 2 of 7).
Full pipeline: the planner agent stalled at its turn limit (open-ended
reading), so the lead finished the grounding + re-emitted the plan (all cites
verified, three open decisions resolved: per-series config is clean at the
:6313 normalize map, band ships with whiskers, one translucent-over group) ->
coder (landed T1-T7 + the .d.ts type before its 40-turn limit; lead added the
A27 torture case) -> reviewer APPROVED zero blockers (two nits fixed: whisker
plot-rect clip + a comment overclaim) -> qa=lead. 552/552 tests (+9), torture
ok with new A27, three reversion proofs (null gate, band run-split, cold/hot
isolation), Charts.js restored byte-for-byte after each. Docs folded. Awaiting
/release 1.21.0. Predecessor #17 (Brush v2) SHIPPED as v1.20.0.

AS-EXECUTED deltas vs this brief: (1) DECISION C settled as one translucent-
over group (band + whiskers over the line, ~0.15 alpha ribbon) rather than a
strictly-behind band -- one attach point, one dispose, the buildAnnotations
shape; strictly-behind is a named follow-up. (2) The whisker draw self-clips
to the plot rect (reviewer nit -- a tall whisker must not paint into the
axis/title margin), matching the band/line/area idiom. (3) Colors resolve in
the cold effect (theme-aware) from a deferred colorSpec/bandFillSpec, not at
normalize time. Everything else landed as planned.

The first **statistical series** cut, and per the ROADMAP the cheapest one:
per-point `lo`/`hi` accessors projected through the existing y-scale, drawn
as whiskers (error bars) and/or a filled ribbon (confidence band) on the
cold-resolve / hot-project 0-B/frame idiom the annotation layer already
uses. NO new chart kernel -- this DECORATES the existing continuous-x
renderers (line / area / scatter). Size: M (S-M whiskers, M with the band
fill + multi-series plumbing).

This brief hands the planner grounded seams, a recommended design, and the
explicit open decisions. The planner RE-GROUNDS every line number (the
standing v1.7.0 lesson: releases shift lines -- this one is written against
Charts.js @ v1.20.0, 11,890 lines, and #17 already moved things).

## Grounding (2026-09-08, Charts.js @ v1.20.0, 11,890 lines)

- **Per-point extra columns already have a precedent: candlestick.**
  `_extractCandleData` (:6032) fills raw double columns `state.os/hs/ls/cs`
  (`ensureFloat64`, :6048-6049) via RAW accessors; the projection block
  (:6160-6176) maps each to a pixel column `state.pos/phs/pls/pcs` with
  `yScale.map(...)` once per frame; `_makeCandleDraw` (:6203) walks the
  projected columns at 0 B/frame, guarding `pos === null || ...` first.
  `lo`/`hi` are structurally IDENTICAL to `l`/`h` -- two extra columns,
  projected through the SAME y-scale, drawn as vertical geometry per point.
- **The draw idiom the ROADMAP names: annotation cold/hot split.**
  `buildAnnotations` (:1977) builds one `annGroup` under `scene.root` with a
  single SVG-exportable `annFillPath` (:2078) plus pooled `lineNode`/
  `textNode`. Two effects: `disposeResolve` (:2262) tracks `themeVersion()`
  + `annotationsAcc()` ONLY and rebuilds structure + colors cold; the hot
  `disposeProject` (:2271) tracks `scaleVersion()` + `plotBoundsSignal()`
  and re-maps to pixels every pan/zoom frame at zero alloc. `dispose`
  (:2277) tears both effects + detaches the group. THIS is the template:
  structure/accessors/colors resolved cold, pixels projected hot, geometry
  emitted straight to ctx (no per-frame array).
- **Series extraction + projection.** `extractSeriesData` (:458) fills
  `state.xs/ys` (SoA passthrough when `data.xs && data.ys`, else AoS via
  `xAccessor`/`yAccessor` into `ensureFloat32` pools) and the domain
  min/max. `scaleSeriesToPixels` (:584) fills `state.pxs/pys` with the
  cold-hoisted log-aware flat loops (linear body `v*_slope+_intercept`; log
  body `v>0 ? Math.log(v)*_slope+_intercept : NaN` -- a non-positive sample
  SELF-SKIPS via NaN, the polyline/marker break). A whisker column reuses
  exactly this: `pxs[i]` for the x (shared with the point), and `yScale`
  applied to `lo[i]`/`hi[i]` for the two y ends.
- **Renderers are config objects.** `LINE_RENDERER` (:3719) /
  `AREA_RENDERER` (:3738) expose `extractData`, `makeDrawFn`,
  `drawPerSeriesMarkers`, `projectToPixels`, etc. The per-series draw fn is
  the marker/line precedent for emitting geometry to ctx. An error-bar pass
  is analogous to the marker pass -- per raw point, straight ctx ops.
- **Accessor + null discipline.** `buildAccessor` (:157) does `+v` (Date ->
  ms, NaN passthrough); `buildRawAccessor` (:183) returns untouched. The
  house trap [[null-coercion-failopen]]: `+null === 0`, so EVERY lo/hi
  accessor application must gate `raw == null` BEFORE `+`, or a `{lo:null}`
  row anchors a whisker at value 0 (the exact v1.10.0 buildAccessor row-null
  defect, and the v1.20.0 vertical-setBrush fix -- same class).
- **Theme two-step.** Annotation colors resolve via a `themeVersion` signal
  bumped in `refreshTheme` (:8433, `annThemeVersion.update`); error-bar
  stroke/fill colors follow the same CSS-var-through-a-version-signal path.
- **Decimation.** Line/area decimate via `decimateMinMax` (:133, min/max
  envelope) at high N. Error bars per raw point are meaningful only at low
  N; see Risk 1.

## Design -- recommended (planner may overturn any labeled decision)

### Config surface

Per-series, on each series config object, with a chart-level default:

```
errorBars: {
  lo, hi,            // accessor|key -> absolute lower/upper value per row
                     //   (AoS); OR parallel los/his typed arrays (SoA)
  // -- OR the symmetric sugar, resolved cold to lo=y-e / hi=y+e:
  value,             // accessor|key -> +/- magnitude (mutually exclusive
                     //   with lo/hi; supplying both THROWS)
  color,             // stroke; default = the series color
  width,             // stroke width px; default 1, clamp (0,8]
  capWidth,          // cap half-extent px; default 3, clamp [0,32]; 0 = no caps
  band              // false (default) whiskers | true filled ribbon | 'both'
}
```

- **DECISION A (config placement):** RECOMMENDED per-series
  (`series:[{name,data,errorBars:{...}}]`) so a multi-series line can carry
  bars on one series only, falling back to a chart-level `errorBars`. The
  alternative (chart-level, primary series only) is simpler but blocks the
  obvious multi-series use. Planner grounds the per-series config plumbing
  (the normalized series map ~:6459 and how per-series opts reach the
  renderer draw today).
- **DECISION B (absolute vs symmetric):** RECOMMENDED ship BOTH -- `lo`/`hi`
  absolute is the primitive; `value` symmetric is cold sugar. If the diff
  bloats, `value` sugar is the cut to defer (it is pure cold arithmetic over
  the primitive), NOT the band.

### Two draw modes, one lo/hi projection

- **Whiskers (error bars):** per point `i`, a vertical segment from
  `(pxs[i], yScale.map(lo[i]))` to `(pxs[i], yScale.map(hi[i]))`, plus two
  horizontal caps of `capWidth` half-extent at each end. Emitted straight to
  ctx in ONE pooled `pathNode`. A point whose lo OR hi is null/NaN, or whose
  projection is non-finite (log of non-positive), draws NO whisker -- it
  self-skips, exactly like the polyline gap. NEVER anchors at 0.
- **Confidence band (ribbon):** one filled path tracing the hi-polyline
  left->right then the lo-polyline right->left, closed. A NaN/null gap
  SPLITS the ribbon into runs (mirror the polyline gap handling -- a run is
  a maximal span of finite lo AND hi). One pooled `pathNode`, fill under the
  series line. `'both'` draws band THEN whiskers.
- **Draw order (DECISION C):** RECOMMENDED band fill UNDER the series
  line/markers (a translucent ribbon behind the trend), whiskers OVER the
  markers (caps visible). Placed via the layer-group child order, the
  annotation z-order precedent.

### Lifecycle -- the annotation split, verbatim

Build one error-bar group once (per series that opts in, or one shared group
keyed by series -- planner's call). COLD resolve tracks the data accessor +
`themeVersion` -> refills `los`/`his` pools (`ensureFloat32`/`64`,
grow-only) and resolves colors. HOT project tracks `scaleVersion` +
`plotBoundsSignal` -> refills `plos`/`phis` via `yScale.map` and re-emits.
The x reuses the series' own `pxs` (already projected by
`scaleSeriesToPixels` on the same hot tick) -- do NOT re-derive x. **THE
LEAK TRAP (v1.10.0 TS lesson):** the cold resolve must read lo/hi from the
DATA accessors only; reading any scale signal there makes the cold effect
transitively track `scaleVersion` and reallocate every frame. Assert it.

### Fail-closed (construction, pre-signal)

Junk `errorBars` (non-object; both `value` and `lo`/`hi` present; missing
all of lo/hi/value; non-function/non-key accessor; bad width/capWidth/band)
THROWS at construction with a `lite-charts:` message, BEFORE any owned
signal alloc, zero node delta. Per-row null/NaN is NOT a throw -- it is a
silent per-point skip (data is dirty, not misconfigured).

### exportSVG + tree-shake

- `exportSVG` emits the whisker/band paths (the annotation-layer clip idiom
  -- a mock canvas walks the same pooled pathNode).
- A chart WITHOUT `errorBars` is byte-identical: the layer builds only when
  the config is present (the injection-ladder precedent -- source-scan
  assert that the build site sits behind an `errorBars != null` gate).

## Scope

- **IN:** line / area / scatter (continuous x, one x per point). Whiskers +
  band + symmetric sugar. Multi-series (per-series config). Log y (lo/hi
  through the log body, non-positive self-skips). exportSVG. Theme colors.
- **OUT (named refusals, not gaps):**
  1. **Bar error bars** -- grouped/stacked bars offset each series within a
     category band; a whisker must sit at the BAR center, not the category
     center, which needs the bar-layout offset math. Deferred with a named
     trigger (a consumer wanting bars-with-error). Real work, own cut.
  2. **Decimated whiskers** -- see Risk 1; v1 draws per raw point, intended
     for low-N series. A decimation-aware envelope whisker is a separate
     trigger.
  3. **Horizontal error bars** (whiskers along x on horizontal bars / a
     value-on-x layout) -- the swapAxes projection variant; defer.
  4. **Box plot / stacked area** -- the NEXT statistical cuts per the
     ROADMAP, explicitly after this one.
  5. **Asymmetric caps / arbitrary marker glyphs at the ends** -- caps are a
     horizontal tick; anything richer is scope creep.

## Assertion seeds (qa = me; the agent produces zero tests -- plan for it)

- **Projection:** whisker top/bottom pixels equal `yScale.map(hi[i])` /
  `yScale.map(lo[i])` exactly, on linear AND log y; x equals the point's
  `pxs[i]`.
- **Null gate (load-bearing):** a `{lo:null}` (and `{hi:null}`) row draws NO
  whisker for that point; REVERSION -- drop the `== null` gate -> whisker
  anchors at the value-0 pixel -> red. NaN row self-skips likewise.
- **Symmetric sugar:** `value: e` yields lo=y-e / hi=y+e; supplying `value`
  AND `lo` throws at construction, zero node delta.
- **Band runs:** a NaN in the middle SPLITS the ribbon into two closed runs
  (op-log parser counts two fill subpaths); a fully-finite series is ONE
  run; reversion of the run-split guard -> one run bridging the gap -> red.
- **Cold/hot isolation (the leak trap):** a pan/zoom gesture storm
  reprojects whiskers WITHOUT re-running the cold resolve (spy the resolve
  count, the A20/A24 precedent) -- proves no scaleVersion leak into cold.
- **Multi-series:** bars on series 1 only leave series 0 undecorated;
  per-series color defaults to each series color.
- **exportSVG:** emits the whisker segments + band path; mock-canvas parity.
- **Construction throws:** the full junk matrix, each zero-node-delta
  (destroy-first if mounted -- the stats().activeNodes idiom).
- **Tree-shake / parity:** a no-errorBars chart is byte-identical (source
  region confinement + `errorBars != null` build gate, the field/outlines
  proxy).
- **Torture (new A27):** whisker + band gesture storm B/op within 2 B/op of
  a no-errorBars control; cold resolve fires once per data/theme change, not
  per frame; the differential retained gate the A24/A26 precedent.
- **Reversion discipline:** every guard proven load-bearing by measured
  reversion, Charts.js restored byte-for-byte each time (the TS22/V4/CS4
  lesson -- watch for a test that stays green when the guard dies).

## Risks

1. **Decimation vs per-point whiskers.** At 100k points the line decimates
   to a min/max envelope; drawing a whisker per raw point there is both
   meaningless and a draw-cost cliff. RECOMMENDED v1: draw per raw point,
   document "intended for <~1k-point series," NO decimation coupling; a
   decimation-aware whisker is a named future trigger. The planner should
   confirm the draw simply iterates raw points and does not fight the
   envelope path.
2. **The `+null===0` trap at row level** (Risk 1's sibling): gating the
   aggregate is not enough -- EVERY per-row lo/hi coercion is its own null
   site (the v1.10.0 buildAccessor lesson). Gate each application.
3. **Cold/hot leak** (Design lifecycle): reading a scale signal in the cold
   resolve reallocates every frame. The single most important invariant;
   A27 + the resolve-count spy guard it.
4. **Doc + type churn:** a new per-series config surface touches README (new
   section + New-in block + changelog row), llms.txt (current block),
   Charts.d.ts (ErrorBarsConfig on the series/chart config types), and the
   catalog card -- budget a full docs pass, grep-verified (the v1.19.0
   stale-row lesson: verify claimed edits).
5. **Per-series config plumbing** may not exist cleanly today for arbitrary
   renderer opts -- the planner grounds whether per-series `errorBars`
   reaches the draw path, or whether v1 starts chart-level (primary series)
   with per-series as a fast-follow. Either is a releasable v1.21.0; name
   the choice.
