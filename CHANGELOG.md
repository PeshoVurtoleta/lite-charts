# Changelog

All notable changes to `@zakkster/lite-charts` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-06

### Added — bar-chart layout polish

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

### Added — bonus features present in this release

These were originally scoped for v1.2.0 alphas but landed in this build
and are tested + documented:

- **Spatial-index foundation** for bubble + scatter hit-tests
  (`SpatialIndex` / `SpatialIndexFactory` contract). Auto-engages at
  ~1000 points, falling back to O(n) below threshold.
- **`createScatterChart`** — bubble's simpler sibling on the same axis
  kernel; constant marker size, no third dimension.
- **Multi-series bubble** with a global size domain (so a 30-radius
  point in series A and series B render at the same pixel radius) and
  per-point color via `colorKey`. Cross-series hit-test via
  `snapSeriesIdx`.
- **`createHeatmap`** on a new `createBaseGridChart` kernel — categorical
  rows × columns, default linear color ramp, custom `colorFn(v, vMin,
  vMax)` for any mapping; sparse grids draw only present cells.

### Internals

- Charts now report `chart.plotBounds` as a version-counter signal —
  subscribe to react to size changes without dragging in DOM observers.
- DPR-aware canvas sizing reproduces the same backing-buffer math whether
  mounted onto a real `<canvas>` or a test mock with explicit `width` /
  `height`.
- `_testHelpers` export kept at the same surface for white-box tests
  (decimation kernel, scale builders, accessor factory).

### Performance contract

Empirical, sampled under `--expose-gc` (`node --expose-gc bench/line-100k.mjs`):

- **`chart.redraw()` steady-state**: 0.54 B/call — true zero-allocation
  (sub-8-byte noise floor).
- **`data.set(reused) + redraw`**: ~89 B/call (signal mechanics + draw).
- **Full live cycle** (object literal + `await drainMicrotasks`): ~65 B/cycle
  (the 32 B literal + ~33 B Promise/await overhead are the call-site cost,
  not the library).
- **100k-point line chart** full update cycle: **p95 = 5.68 ms** (193 fps
  ceiling) on Node 22; fits in 60fps and 120fps budgets.
- **Canvas calls per draw** (decimated mode): ~3393 — bounded by occupied
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

- Mock test harness was missing `strokeRect` — added (heatmap calls it).
- Test file forgot to import `createScatterChart` + `createHeatmap` from
  `Charts.js` — added (18 false failures resolved).
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
