# @zakkster/lite-charts

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-charts.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-charts)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-charts?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-charts)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-charts?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-charts)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-charts?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-charts)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-charts/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE.txt)

> Reactive, zero-GC chart library. Signals for data, dimensions, theme. 100k
> points at 60fps with sub-frame budget. Built on `@zakkster/lite-scene`
> (Canvas2D scene graph), `@zakkster/lite-signal` (reactive core), and
> `@zakkster/lite-axis` (tick generation). Three peer deps. ESM-only.
> ~1100 lines single file. MIT.

**Status:** v1.6.1 -- mixed-sign log-domain floor (patch). A `type: 'log'`
domain whose data spans zero (`min <= 0, max > 0`) rendered correctly but
NaN'd the view on the first pan or zoom: the pan-bounds envelope kept the raw
non-positive min while the axis floored it for drawing, so the gesture math
took `log()` of a value `<= 0`. The envelope is now floored to the same
positive part on both axes, so a mixed-sign log chart pans and zooms cleanly
instead of freezing. Fail-closed still holds: a log domain with *no* positive
extent throws at mount as before (the floor never masks it). No public API
change; the per-frame draw path is byte-unchanged. **390/390 tests pass** plus
a torture/stress gate (`npm run torture`).

**New in v1.6.1:**
- **Mixed-sign log domains pan and zoom cleanly.** When `min <= 0, max > 0`
  on a `type: 'log'` axis (x or y), the data-domain snapshot used for
  pan/zoom bounds is floored to the same positive value the render path uses,
  so the first gesture no longer produces a NaN (frozen) view. The
  no-positive-extent case still throws at mount. Symmetric on both axes; draw
  path byte-unchanged.

**New in v1.6.0:**
- **`xScale: { type: 'log' }`** -- base-10 log on the x-axis for any
  axis-kernel chart. Ticks via `lite-axis.logTicks` (decade boundaries);
  `map(x <= 0)` is NaN, so line / area break segments and markers skip.
  Pan and zoom operate in log space -- the interaction plumbing was already
  symmetric with the y-axis, so this wiring was mostly enabling what the
  kernels already supported. Fail-closed: throws at mount on a non-positive
  x-domain, and at construction on a bar (band) or time x-axis (a scale is
  one type). See "Log scale" below.

**Inherited from v1.5.0 (+ the v1.5.1 patch):**
- **`centerLabel` on `createDonutChart`** -- a number rendered in the
  donut hole as a `pointer-events:none` DOM overlay (not canvas text),
  so its font resizes itself. Font size is owned by CSS `clamp()`: the
  chart writes the hole radius and the label's digit count as custom
  properties on data/resize only (sub-Hz), and more digits shrink the
  number to stay inside the ring -- zero per-frame JS, no `measureText`.
  Accepts `boolean | string | (() => string) | { text, format, subLabel,
  color, font, minFontSize, maxFontSize }`. Fail-closed: throws on a
  chart with no hole (a pie, or `innerRadius` 0). See "Donut center
  label" below.
- **`orientation: 'horizontal'` on `createBarChart`** -- category band
  on the Y axis (category 0 at top), bars growing from the value
  baseline along X. The vertical draw path is byte-identical (horizontal
  selects a peer draw function once at setup). Fail-closed subset for
  this cut: `horizontal` combined with `pan` / `zoom` / `brush` / a value
  `grid` / a log value axis throws at construction. See "Horizontal
  orientation" below.
- **Log-scale point projection fix (v1.5.1 patch).** `scaleSeriesToPixels`
  projected `yScale: { type: 'log' }` points with linear math, throwing
  line / area / scatter / bubble points off-canvas (the axis and ticks were
  correct; only the points were wrong). The projection loop is now log-aware
  on both axes; the all-linear path is byte-identical. Present since y-log
  shipped in v1.4.1. (This is what made the v1.6.0 x-log projection correct.)

**Inherited from v1.4.0 (+ the v1.4.1 patch):**
- **`yScale: { type: 'log' }`** -- log scale on the y-axis for any
  axis-kernel chart. Base-10 log; ticks via `lite-axis.logTicks`.
  See "Log scale" below.
- **`pan: true`** + **`zoom: true`** -- pointer-drag pans
  (cursor-anchor convention); wheel zooms around the cursor.
  `chart.view` is a reactive `{ xMin, xMax, yMin, yMax }` accessor
  intentionally symmetric with `lite-camera-max`'s camera signal
  for future lite-gl drop-in. See "Pan + zoom" below.
- **`brush: true`** -- shift+drag rectangle selection. `chart.brush`
  emits `{ xMin, xMax, yMin, yMax, ids }` for cross-chart linking.
  Coexists with pan/zoom via modifier routing. See "Brushing"
  below.
- **Four allocation traps closed** (audit): heatmap quantile
  Float32Array pool; `_parseRGBLike` indexOf scan;
  `charBufToString` via `apply`; SVG path chunks for 100k+ point
  export. No public API changes; pre-existing leaks in v1.2-1.3
  code, fixed silently.
- **Log-aware pan/zoom (v1.4.1 patch).** `pan` / `zoom` on a
  `yScale: { type: 'log' }` chart now run their arithmetic in log
  space (`_applyPanLog` / `_applyZoomLog`) with a domain floor;
  before, the first gesture drove the domain wrong or negative
  (findings LC-01..LC-05). `updateLogScale` throws on a non-positive
  domain. The same log-space pan/zoom now applies to `xScale: { type:
  'log' }` as of v1.6.0 (see "New in v1.6.0" above).

**Inherited from v1.3.0:**
- **`chart.exportSVG()`** on every chart. Safe at 100k+ points
  (the SVG path-chunks audit fix above protects against
  `RangeError: Invalid string length` on big exports).

**Inherited from v1.2.0:**
- `chart.destroy()` on every kernel; terminal counterpart to
  `unmount()`. Zero residue across 30 mount+destroy cycles.
- Heatmap row + column highlights, quantile color binning, and
  auto-contrast value labels.

**Inherited from earlier alphas:**
- `createHeatmap` on the fourth kernel (alpha.3); ~11 KB minified
  on its own, the smallest of the nine bundles.
- `createScatterChart` (alpha.1); reuses the spatial-index foundation
  with `k = 1`.
- Multi-series bubble + per-point color via `colorKey`, global size
  domain across visible series (alpha.2).
- Pluggable spatial-index (`SpatialIndex` / `SpatialIndexFactory`)
  for O(log n) hit-test on dense point clouds (alpha.0).
  `@zakkster/lite-delaunay` is the intended default but optional.

**Inherited from v1.1.0:** bar layout polish -- stacked bars,
rounded corners, per-bar hover tint. All opt-in.

See [ROADMAP.md](./ROADMAP.md) for the development history and the
forward plan.

## Install

```bash
npm i @zakkster/lite-charts @zakkster/lite-signal @zakkster/lite-scene @zakkster/lite-axis
```

## Hello World

```javascript
import { signal } from '@zakkster/lite-signal';
import { createLineChart } from '@zakkster/lite-charts';

const data = signal([
    { t: new Date('2026-01-01'), v: 100 },
    { t: new Date('2026-02-01'), v: 142 },
    { t: new Date('2026-03-01'), v: 88 },
    { t: new Date('2026-04-01'), v: 175 },
]);

const chart = createLineChart({
    data,
    x: 't',
    y: 'v',
    width: 800,
    height: 400,
    color: '#3b82f6',
});

chart.mount(document.getElementById('chart-container'));

// Mutate the signal anywhere -- the chart redraws automatically.
setTimeout(() => {
    data.update((rows) => [...rows, { t: new Date('2026-05-01'), v: 210 }]);
}, 1000);
```

The chart inferred the time scale from the `Date` probe, auto-fitted the
y-domain with 5% padding, and threaded a reactive signal end-to-end. No
explicit re-render needed.

## Why lite-charts

| Concern | lite-charts | Chart.js | uPlot | D3 |
|---|---|---|---|---|
| **Reactive data binding** | First-class signals | Imperative `.update()` | Imperative `.setData()` | Manual selection re-bind |
| **100k points** | 1.4 ms / 4.7 ms p95 (CPU) | Drops frames | OK | Hand-rolled |
| **Zero-GC steady state** | Yes (slab-based) | No | Mostly | No |
| **Bundle (min+gz)** | ~6 KB (alpha est.) | 78 KB | 40 KB | 70+ KB |
| **Render substrate** | Canvas2D via lite-scene | Canvas2D | Canvas2D | SVG / Canvas |
| **API style** | Vega-Lite middle ground | Imperative config | Hand-tuned | Composable primitives |
| **Twitch Extension fit** | Yes (1MB / 3s budget) | No | Yes | No |

Built specifically for performance-critical environments: dashboards that
stream telemetry, live trading interfaces, game HUDs, monitoring overlays,
Twitch Extensions. Where Chart.js works fine until you hit 5k points and a
~3MB transitive dep graph, lite-charts is engineered to scale to 100k points
in a 1MB bundle without GC pauses.

## Architecture

```mermaid
graph TD
    User[User config + data signal] --> Constructor[createLineChart]
    Constructor --> Normalize[Normalize: data shorthand -> series[]]
    Normalize --> Accessors[Build accessors x/y]
    Accessors --> InferType[Infer x-scale type]
    InferType --> StateAlloc[Allocate SeriesState slabs]

    StateAlloc --> Mount[mount(container)]
    Mount --> Scene[createScene from lite-scene]
    Scene --> Effect1[Effect: width/height -> plotBounds]
    Scene --> Effect2[Effect: data -> SoA extract -> scale -> pixels]
    Scene --> Axes[buildAxis x2 / lite-axis ticks]
    Scene --> SeriesNodes[path nodes / one per series]
    SeriesNodes --> DrawFn[makeLineDrawFn closure]

    DrawFn --> PathSelect{n > 2*cols?}
    PathSelect -->|yes| Decimate[decimateMinMax kernel<br/>lifted from lite-canvas-graph]
    PathSelect -->|no| Polyline[Direct polyline / NaN-aware]
    Decimate --> Stroke[ctx.stroke]
    Polyline --> Stroke

    Signal[Any signal write] --> LiteSignal[lite-signal sync flush]
    LiteSignal --> EffectsRun[Effects re-run]
    EffectsRun --> DirtyBridge[scaleVersion bump -> scene.markDirty]
    DirtyBridge --> SceneDraw[lite-scene drawAll / coalesced via _queued]
    SceneDraw --> DrawFn
```

The hot path (line render) is allocation-free: per-frame work is two `O(n)`
scans (extract extents, project to pixels) plus the decimation kernel
(`O(plotWidth)`) and a single `ctx.stroke()`. The axis update path allocates
a small amount per re-layout (label strings, ephemeral props objects), but
that runs only on data-domain or size changes, not every frame.

## API Reference

### `createLineChart(config) -> chart`

| Config key | Type | Default | Notes |
|---|---|---|---|
| `data` | `Row[]` &#124; `Signal<Row[]>` &#124; `() => Row[]` &#124; `{xs, ys}` SoA | -- | Either `data` or `series` required. SoA fast path is zero-copy. |
| `series` | `SeriesConfig[]` &#124; `Signal<SeriesConfig[]>` | -- | Multi-series form. `{name, data, color, lineWidth}`. |
| `x` | `string` &#124; `number` &#124; `(row, i) => number` | `'x'` | Accessor key, array index, or function. `Date` is coerced to ms. |
| `y` | `string` &#124; `number` &#124; `(row, i) => number` | `'y'` | Same. |
| `width` | `number` &#124; `Signal<number>` &#124; `() => number` | `800` | Static or reactive. |
| `height` | `number` &#124; `Signal<number>` &#124; `() => number` | `400` | Same. |
| `margin` | `{top,right,bottom,left}` | `{16,24,32,56}` | Pixel space reserved for axes. |
| `color` | `string` | `'#3b82f6'` | Hex, css var (`--my-token`), or any CSS color string. |
| `lineWidth` | `number` | `1.5` | Series stroke width in CSS pixels. |
| `background` | `string` &#124; `null` | `null` | Canvas fill before draw. |
| `dpr` | `number` | `devicePixelRatio` | Override device pixel ratio. |
| `xScale` | `{type?, domain?}` | inferred | `type: 'linear' \| 'time'`; `domain: [min, max]` to lock. |
| `yScale` | `{domain?, zero?, nice?}` | nice + pad | `zero: true` forces 0 inclusion; `nice: true` adds 5% padding. |
| `axisColor` | `string` | `'#888888'` | Axis spine + tick color. |
| `labelColor` | `string` | `'#444444'` | Tick label color. |
| `font` | `string` | `'11px sans-serif'` | Tick label font. |
| `interpolation` | `'linear'` &#124; `'step'` &#124; `'step-after'` &#124; `'step-before'` &#124; `'step-mid'` &#124; `'monotone'` &#124; `'catmull-rom'` | `'linear'` | Path interpolation mode. Per-series override via `SeriesConfig.interpolation`. |
| `markers` | `boolean` &#124; `{shape?, size?, fill?, stroke?, strokeWidth?, everyN?}` | `false` | Marker dots at each sample. `true` = circle defaults. `{everyN: 5}` for dense data. |
| `grid` | `boolean` &#124; `{x?, y?, color?}` | `false` | Gridlines through the plot rect at each tick. `true` = both axes. Object form for per-axis + color override. |
| `crosshair` | `boolean` &#124; `{color?, dash?}` | `true` | Vertical line + per-series marker dots. `false` disables. |
| `tooltip` | `boolean` &#124; `{background?, border?, format?}` | `true` | Canvas-drawn box at the snapped x. `false` disables. |
| `legend` | `boolean` &#124; `'top'`&#124;`'bottom'`&#124;`'left'`&#124;`'right'` &#124; `{position?, container?}` | `'bottom'` | DOM-rendered legend with click-to-toggle. `false` disables. |
| `schedule` | `(fn) => void` | `requestAnimationFrame` | Frame scheduler. Pass `(fn) => fn()` for sync (tests), `queueMicrotask` for headless batching. |

#### Chart methods

| Method | Returns | Notes |
|---|---|---|
| `chart.mount(target)` | `chart` | `target` is an `HTMLElement` (creates canvas inside) or `HTMLCanvasElement`. |
| `chart.unmount()` | `void` | Disposes all effects, removes canvas if owned. Idempotent. |
| `chart.exportPNG({mimeType?, quality?})` | `string` (data URL) | Calls `canvas.toDataURL`. |
| `chart.redraw()` | `void` | Force a redraw without changing data. |
| `chart.moveCrosshair(canvasX, canvasY)` | `void` | Programmatic crosshair move. Snaps to nearest sample on the primary series. |
| `chart.hideCrosshair()` | `void` | Hide crosshair + tooltip. Idempotent. |
| `chart.setSeriesVisible(idx, visible)` | `void` | Toggle a series. Out-of-range indices are safe no-ops. |
| `chart.refreshTheme()` | `void` | Re-resolve CSS-var colors and redraw. Call after a theme switch. |

#### Chart properties

| Prop | Type | Notes |
|---|---|---|
| `chart.scene` | `Scene` &#124; `null` | The underlying `lite-scene` instance. |
| `chart.canvas` | `HTMLCanvasElement` &#124; `null` | The canvas being drawn into. |
| `chart.xScale` | `Scale` | `{type, dMin, dMax, rMin, rMax, map(v), invert(px)}`. |
| `chart.yScale` | `Scale` | Same shape. |
| `chart.xScaleType` | `'linear'` &#124; `'time'` | Resolved at construction. |
| `chart.plotBounds` | `Signal<number>` | A version-counter signal; subscribe to react to size changes. |
| `chart.crosshair` | `Signal<CrosshairState>` | Live `{visible, snapIdx, snapDomainX, snapPixelX, mousePixelY}`. Subscribe for synchronized small-multiples. |
| `chart.seriesVisibility` | `Signal<boolean>[]` | One signal per series. Read in a reactive context to bind external UI; write to toggle. |
| `chart.legend` | `HTMLElement` &#124; `null` | The legend container, or null if `legend: false` or mounted into a bare canvas. |

## Reactivity

Every config value (`width`, `height`, `data`, future `color`, etc.) accepts
either a static value or a signal accessor. A signal is just a function:

```javascript
const w = signal(800);
const chart = createLineChart({ data, width: w, height: 400 });
chart.mount(el);

// Later:
w.set(1200);  // chart resizes and rescales -- no manual redraw call
```

Internally, lite-charts wraps statics in constant accessors via a tiny
helper, so the engine only ever calls functions. Zero overhead for static
config; full reactivity for signal config. Same pattern as `unref` in Vue,
`toValue` in Solid, etc.

### Bring-your-own scheduling

The default schedule is `requestAnimationFrame`. In Node (tests, headless
benches, SSR-adjacent workflows), pass an explicit schedule:

```javascript
// Synchronous -- assertions can read ctx.calls immediately. Best for tests.
const chart = createLineChart({ ..., schedule: (fn) => fn() });

// Microtask-coalesced -- draws batch within a tick. Best for headless benches.
const chart = createLineChart({ ..., schedule: (fn) => queueMicrotask(fn) });
```

## Tooltip + crosshair

On by default in v1.0.0-alpha.1. The crosshair vertical line snaps to the
nearest sample on the primary series (binary search on sorted xs); markers
on each additional series snap independently at the same domain x. The
tooltip is canvas-drawn (no DOM overlay), so it remains headless-testable.

```javascript
createLineChart({
    data,
    crosshair: { color: '#666', dash: [3, 3] },
    tooltip: {
        // String form: replaces the header, suppresses rows.
        format: (snap) => 'sample #' + snap.snapIdx,
        // Object form: customize both -- snap.rows is pre-filled with one row per series.
        // format: (snap) => ({ header: 'custom', rows: snap.rows }),
    },
});

// Disable per-feature
createLineChart({ data, crosshair: false });  // tooltip stays on
createLineChart({ data, tooltip: false });    // crosshair stays on
createLineChart({ data, crosshair: false, tooltip: false }); // no DOM listener attached
```

### Synchronized crosshairs across small multiples

The `chart.crosshair` signal exposes live state. To synchronize the
crosshair across multiple charts sharing an x-axis, write to one and
forward to the others:

```javascript
const c1 = createLineChart({ data: a, x: 't', y: 'cpu' });
const c2 = createLineChart({ data: b, x: 't', y: 'mem' });
c1.mount(el1); c2.mount(el2);

c1.crosshair.subscribe((state) => {
    if (state.visible) c2.moveCrosshair(state.snapPixelX, /* y irrelevant for sync */ 0);
    else c2.hideCrosshair();
});
```

### Programmatic + testing API

`chart.moveCrosshair(canvasX, canvasY)` and `chart.hideCrosshair()` drive
the same path as the DOM mousemove handler. Tests use these directly
against the mock canvas (no event simulation needed). The mock canvas in
`test/harness.js` doesn't implement `addEventListener`, so the DOM listener
is skipped in headless contexts -- the programmatic API is the only way in.

## Area chart (v1.0.0-alpha.2)

`createAreaChart(config)` shares everything with `createLineChart` -- same
data shape, same accessors, same scales, same reactivity, same crosshair
and tooltip -- and adds three options:

| Config key | Type | Default | Notes |
|---|---|---|---|
| `baseline` | `number` &#124; `'bottom'` | `0` | Domain y value to close the area to. `'bottom'` pins to the bottom edge of the plot rect regardless of domain. Numeric baselines clamp to plot rect if outside. |
| `stroke` | `boolean` | `true` | Whether to stroke the upper boundary of the fill. |
| `fillOpacity` | `number` | `0.3` | Multiplied into `globalAlpha` before fill. The stroke draws at full alpha. |

```javascript
import { createAreaChart } from '@zakkster/lite-charts';

const chart = createAreaChart({
    data: timeseries,
    x: 't', y: 'cpu',
    color: '#3b82f6',
    baseline: 0,        // fills from data line down to y=0
    fillOpacity: 0.25,
    stroke: true,       // crisp blue line on top of soft fill
});
```

Both render paths from line chart carry over: direct polyline-with-close
for sparse data, decimated per-column for dense. The decimated path fills
to the column's upper envelope (max), matching d3-area's default behavior;
ribbon-style min-max area is a separate primitive in v1.1+.

## Legend (v1.0.0-alpha.3)

Rendered as a DOM element (sibling of the canvas, inside an auto-created
flex wrapper), so it's keyboard-accessible (each row is a `<button>` with
`aria-pressed`), CSS-themable (`.lite-charts-legend` class on the
container), and ready to drop a virtualizer into when v1.2 ships the
`lite-virtual` integration. Click-to-toggle is wired by default.

```javascript
createLineChart({
    series: [
        { name: 'CPU',  data: cpuRows },
        { name: 'Memory', data: memRows },
        { name: 'Disk', data: diskRows },
    ],
    x: 't', y: 'pct',
    legend: 'bottom',           // 'top' | 'bottom' | 'left' | 'right' | false
});
```

Position controls the auto-wrapper's flex direction:

- `'bottom'` / `'top'` -> column wrapper (canvas above/below legend)
- `'left'` / `'right'` -> row wrapper (canvas beside legend)

For custom DOM placement, pass an existing element via
`legend: { container: someEl }` -- the legend appends into your element and
the canvas stays put.

### Series visibility

Each series has a `Signal<boolean>` exposed on `chart.seriesVisibility[i]`.
Toggling it has three effects:

1. The series stops rendering (line/area, crosshair marker, tooltip row).
2. The y-domain rescales to fit only the visible series (matching
   Chart.js convention -- toggle reveals detail in the remaining data).
   Pass an explicit `yScale: { domain: [...] }` to lock the scale.
3. The legend swatch + label dim (`opacity: 0.4`, `aria-pressed=false`).

You can toggle programmatically via `chart.setSeriesVisible(idx, bool)` or
write directly to the signal:

```javascript
chart.setSeriesVisible(0, false);
// or
chart.seriesVisibility[0].set(false);
// or
chart.seriesVisibility[0].update((v) => !v);
```

For a "show only this" pattern (alt-click), iterate:

```javascript
const showOnly = (idx) => {
    chart.seriesVisibility.forEach((sig, i) => sig.set(i === idx));
};
```

## Path interpolation (v1.0.0)

Seven modes. Default is `'linear'` (the polyline). Three step variants for
discrete data (telemetry, state machines, financial OHLC). Two smoothing
modes for continuous data.

```javascript
createLineChart({ data, interpolation: 'monotone' });
```

| Mode | Visual | When to use |
|---|---|---|
| `'linear'` | Straight segments between samples | Default; honest about data resolution |
| `'step'` / `'step-after'` | Horizontal then vertical | Sample held until the next reading (sensor readouts) |
| `'step-before'` | Vertical then horizontal | Sample took effect at the prior x (event-triggered transitions) |
| `'step-mid'` | Step at the midpoint of each segment | Symmetric staircase; useful for histogram-like data |
| `'monotone'` | Fritsch-Carlson cubic Hermite | Smooth without overshooting between samples. Best for noisy time-series. |
| `'catmull-rom'` | Uniform Catmull-Rom spline | Smooth through all samples. Aesthetic; can overshoot on irregular data. |

Per-series override:

```javascript
createLineChart({
    series: [
        { name: 'CPU',    data: cpu,    interpolation: 'monotone' },
        { name: 'Events', data: events, interpolation: 'step-after' },
    ],
});
```

**Decimation interaction:** when `n > 2 * plotWidth` and the decimated
render path activates, interpolation is ignored -- smoothing the per-column
min/max envelope would be visually misleading. Interpolation only changes
the direct path.

**NaN handling:** linear and step modes split on NaN (each contiguous run
renders independently). Smoothing modes assume contiguous data; if you need
gaps, use linear or step.

## Markers (v1.0.0)

Marker dots at each sample point. Distinct from crosshair markers (those
appear only on hover).

```javascript
createLineChart({ data, markers: true });   // circle defaults

createLineChart({
    data,
    markers: {
        shape: 'diamond',
        size: 6,
        fill: '#3b82f6',
        stroke: '#ffffff',
        strokeWidth: 2,
        everyN: 1,
    },
});
```

Use `everyN` for dense series:

```javascript
// 500-point series with markers every 10th sample -- legible without noise.
createLineChart({ data: dense, markers: { everyN: 10 } });
```

**Decimation interaction:** markers are suppressed when the decimated path
runs (>2x plot width). They'd be unreadable.

## Theme reactivity (v1.0.0)

Colors passed as `'--token-name'` get resolved against the container's
computed style at mount. When you switch themes (dark mode, brand swap),
call `chart.refreshTheme()` to re-resolve every CSS-var-driven color and
trigger a redraw.

```javascript
const chart = createLineChart({
    data,
    color: '--my-brand-primary',
    axisColor: '--my-text-muted',
});
chart.mount(el);

// On theme change:
document.documentElement.setAttribute('data-theme', 'dark');
chart.refreshTheme();
```

Hex / oklch / named colors pass through unchanged; only CSS-var tokens
re-resolve. Legend swatches update too.

> **MutationObserver auto-detection** is deliberately not bundled in v1.0.0.
> Which element to observe (container? `<html>`? `<body>`?), which
> attributes (class? data-theme? both?), and how to debounce all depend on
> the host app's theming convention. Wire your own observer to call
> `chart.refreshTheme()`, or pair it with whatever theme-change event your
> framework emits.

## Bar chart (v1.1.0-alpha.0)

```javascript
import { createBarChart } from '@zakkster/lite-charts';

// Single series:
const chart = createBarChart({
    data: [
        { x: 'Q1', y: 42 },
        { x: 'Q2', y: 58 },
        { x: 'Q3', y: 65 },
        { x: 'Q4', y: 78 },
    ],
    color: '--c-primary',
});
chart.mount(document.getElementById('chart'));
```

Multi-series renders **grouped** side-by-side at each category. Each bar
takes a slice of the band centered on its series index
(`offsetX = (i - (count - 1)/2) * groupWidth`):

```javascript
createBarChart({
    series: [
        { name: 'Revenue',  data: [{x:'Q1',y:42}, {x:'Q2',y:58}, ...], color: '--c-primary' },
        { name: 'Expenses', data: [{x:'Q1',y:30}, {x:'Q2',y:35}, ...], color: '--c-amber' },
        { name: 'Profit',   data: [{x:'Q1',y:12}, {x:'Q2',y:23}, ...], color: '--c-cyan' },
    ],
});
```

| Config | Type | Default | Notes |
|---|---|---|---|
| `baseline` | `number` | `0` | Y value where bars anchor. Negatives extend downward. |
| `paddingInner` | `number` | `0.15` | Gap between bands as fraction of step. d3 convention. |
| `paddingOuter` | `number` | `0.1` | Padding at each end of the range as fraction of step. |
| `groupInnerPad` | `number` | `0.08` | Inner gap between bars within a grouped slot. |
| `orientation` | `'vertical' \| 'horizontal'` | `'vertical'` | `'horizontal'` puts the category band on Y (v1.5.0). Any other value throws. |

**Hit detection is discrete.** Unlike line/area which uses `bisectNearest`
(O(log n) over the x array), bar uses `bandScale.invert(canvasX)` which is
a single floor-division: `Math.floor((px - origin) / step)`. The user is
either inside a band or in a gap that snaps to the nearest band. O(1)
regardless of category count.

**Y-domain includes the baseline by default** so bars don't visually float.
Override with `yScale: { domain: [...] }` if you need a fixed window.

**Stacked layout** (v1.1.0) flips the grouped layout with `stack: true`;
each series gets per-category `stackBottoms` / `stackTops` in data space
from a `postExtract` hook, and the y-domain rolls up to the cumulative
total.

### Horizontal orientation (v1.5.0)

```javascript
createBarChart({
    orientation: 'horizontal',
    series: [{ name: 'Downloads', color: '--c-primary', data: [
        { x: 'TypeScript', y: 1840 },
        { x: 'Python',     y: 1620 },
        { x: 'Rust',       y: 940  },
    ]}],
});
```

`orientation: 'horizontal'` swaps the category band onto the **Y axis**
(category 0 at top, reusing the heatmap y-band convention) and grows each
bar from the value baseline along **X**; the value axis moves to the
bottom and category labels sit right-aligned on the left. Rankings and
long category labels read better this way than rotated under a vertical
axis.

The **vertical draw path is byte-identical to v1.4.1** -- horizontal
selects a peer draw function (`makeHBarDrawFn`) and a pixel-range swap
once at setup, so there is no per-frame branch and a vertical chart pays
nothing. Proven by a SHA-256 hash-parity test over the five hot draw
functions.

**Fail-closed subset for this cut.** `orientation: 'horizontal'` combined
with `pan`, `zoom`, `brush`, a value-axis `grid`, or a log value axis
throws at construction rather than half-wiring the interaction (those
land in a later 1.5.x). `crosshair().snapPixelX` reports the band-axis
pixel when horizontal.

## Tree-shakeable architecture (v1.2.0)

`lite-charts` is built on a tiny shared kernel that's parameterized by a
**renderer object** per chart type:

```javascript
const createBaseAxisChart = (config, renderer) => { /* shared scaffold */ };

const LINE_RENDERER = { extractData, makeDrawFn, hitTest, buildXAxis, ... };
const AREA_RENDERER = { ...AREA_specific };
const BAR_RENDERER  = { ...BAR_specific };

export const createLineChart = (config) => createBaseAxisChart(config, LINE_RENDERER);
export const createAreaChart = (config) => createBaseAxisChart(config, AREA_RENDERER);
export const createBarChart  = (config) => createBaseAxisChart(config, BAR_RENDERER);
```

`createBaseAxisChart` calls renderer methods **polymorphically** -- it
never references any specific renderer by name. The bundler can statically
prove which renderers are reachable from the entry import and drop the
rest, along with all their renderer-specific helpers.

**Measured bundle sizes** (esbuild --bundle --minify, peer deps externalized):

| Entry | Bundle size | What's included |
|---|---|---|
| `import { createLineChart }`    | **24 KB** | Line renderer + interp helpers + decimation + shared axis kernel + auto-resize |
| `import { createAreaChart }`    | **25 KB** | Area renderer + interp helpers + decimation + shared axis kernel + auto-resize |
| `import { createBarChart }`     | **25 KB** | Bar renderer + bandScale + bar helpers + shared axis kernel + auto-resize + **stack / rounded / hover (v1.1.0)** |
| `import { createBubbleChart }`  | **25 KB** | Bubble renderer + sqrt size scale + distance hit-test + axis kernel + auto-resize + **spatial-index hook (v1.2.0-alpha.0)** + **multi-series + per-point color (v1.2.0-alpha.2)** |
| `import { createScatterChart }` | **22 KB** | Scatter renderer + axis kernel + spatial-index hook (v1.2.0-alpha.1) |
| `import { createPieChart }`     | **13 KB** | Slice renderer + polar kernel (no axes / scales / interp / decimation) + auto-resize |
| `import { createDonutChart }`   | **13 KB** | Same as pie (shared renderer; only innerRadius default differs) |
| `import { createRadarChart }`   | **13 KB** | Radar kernel (cos/sin tables, polygon draw, spokes, grid rings, vertex hit-test) -- zero axis/polar code |
| `import { createHeatmap }`      | **10.5 KB** | **Grid kernel (v1.2.0-alpha.3)** -- two band scales, Float32 cells, Uint8 presentMask, precomputed cell colors. Zero axis / polar / radar code. |
| All nine together               | **~70 KB** | Four kernels deduplicated; all renderers; shared utilities (resolveColor, ensureFloat32, mount/DPR, legend, auto-resize) shared once |

The v1.1.0 bar features (stacked layout, rounded corners, hover tint)
add ~1.6 KB to the bar bundle (`computeBarStacks`, `_roundRectPath`,
the per-bar tint overlay path). The kernel-level `postExtract` hook is
a single null-check that minifies to a few dozen bytes; line / area /
bubble bundles each pick up ~300 bytes for it. Pie / donut / radar are
on different kernels and unaffected.

**Auto-resize:** omit `width` / `height` from the config and the chart
observes its mount container, updating dimensions on container resize
through the existing reactive graph:

```js
// Reactive to container size, no demo helpers needed
createLineChart({ series: [...] }).mount(document.getElementById('chart'));

// Explicit static -- bypasses auto-observation
createLineChart({ series: [...], width: 800, height: 400 }).mount(canvas);

// Explicit reactive -- user-provided signal
createLineChart({ series: [...], width: mySignal }).mount(div);
```

Falls back gracefully (keeps default size) when `ResizeObserver` is
unavailable. rAF-throttled so burst resize events coalesce into one
re-extract per frame.

**What gets dropped from the radar bundle:** every axis-chart helper
(xScale, yScale, axes, grid, decimation, interp, bisect, bandScale,
makeLineDrawFn, makeBarDrawFn, makeBubbleDrawFn) and every polar-slice
helper (extractSliceData, sliceHitTest, computeSliceGeometry,
makeSliceDrawFn). What's *kept*: the precomputed cos/sin tables, polygon
draw, spoke renderer with angle-aware label alignment, and 12-px
nearest-vertex hit-test.

**Requirements for tree-shaking to work** (already in place):
1. `"sideEffects": false` in package.json
2. Every renderer is a separate top-level `const`
3. Renderers don't reference each other (no spread inheritance -- shared
   methods are top-level `const`s)
4. Pure test helpers live on a separate `_testHelpers` export, not on
   chart instance `_internal` -- production code never references it, so
   it gets dropped along with everything it transitively references

The same architecture extends to upcoming chart families:

```javascript
// v1.3.0 -- pie family (no axes, polar coordinates)
const createBasePolarChart = (config, renderer) => { /* polar scaffold */ };
export const createPieChart   = (c) => createBasePolarChart(c, PIE_RENDERER);
export const createDonutChart = (c) => createBasePolarChart(c, DONUT_RENDERER);
export const createRadarChart = (c) => createBasePolarChart(c, RADAR_RENDERER);

// v1.3.0 -- scatter family (extends axis chart with size dimension)
export const createBubbleChart = (c) => createBaseAxisChart(c, BUBBLE_RENDERER);

// v1.4.0 -- heatmap (2D categorical grid)
const createBaseGridChart = (config, renderer) => { /* grid scaffold */ };
export const createHeatmap = (c) => createBaseGridChart(c, HEATMAP_RENDERER);
```

Each chart type added to the library costs nothing for users who don't
import it. A dashboard that only needs line and bar charts gets a ~30 KB
bundle even after pie, donut, radar, bubble, and heatmap ship.

## Donut center label (v1.5.0)

A number in the donut hole, rendered as a `pointer-events:none` DOM
overlay (a sibling of the canvas, **not** canvas text or a scene node) so
it resizes itself and never touches the per-frame slice draw:

```javascript
import { signal, createDonutChart } from '...';

const data = signal([
    { label: 'Search', value: 4200 },
    { label: 'Direct', value: 2800 },
]);

createDonutChart({
    data,
    innerRadius: 0.55,
    centerLabel: {
        text: () => data().reduce((s, d) => s + d.value, 0).toLocaleString(),
        subLabel: 'Total',
    },
});
```

- **Config:** `boolean | string | (() => string) | { text, format,
  subLabel, color, font, minFontSize, maxFontSize }`. `centerLabel: true`
  defaults `format` to the total of visible slices; a string or accessor
  is shorthand for `{ text }`. `text` and `subLabel` are static-or-signal
  -- an accessor makes the label reactive.
- **Font size is owned by CSS.** The overlay is fixed at mount to
  `font-size: clamp(var(--cl-min), calc(var(--cl-fit) / var(--cl-digits)),
  var(--cl-max))`. On data/resize only (sub-Hz) the chart writes
  `--cl-fit` (hole radius), `--cl-digits` (label length), and the
  min/max floor and cap. More digits shrink the number; it tracks the
  donut as it resizes; there is **zero per-frame JS and no
  `measureText`**. The overlay box is constrained to the hole's inscribed
  square so text cannot overflow the ring.
- **Fail-closed.** Throws at construction on a chart with no hole (a pie,
  or a resolved `innerRadius` of 0), and if `minFontSize > maxFontSize`.
- **SVG export parity.** `chart.exportSVG()` emits an equivalent centered
  `<text>` from the same fit formula (plus a second `<text>` for the
  sub-label). `exportPNG` does **not** include the overlay -- it is a
  `toDataURL` of the canvas only, by design. `chart.centerLabel` exposes
  the overlay element (null when not configured).
- **Requires a mount target with a parent** (the overlay is absolutely
  positioned against the chart container); a plain donut without
  `centerLabel` still mounts anywhere.

## Performance

All numbers are from `bench/line-100k.mjs` running on Node 22 against a
mock canvas (so the GPU paint cost is not included -- see disclaimer below).
Dataset is 100,000 points; canvas is 1600x800.

```
full update cycle (data -> draw)     p50 = 1.39 ms    p95 = 4.66 ms    p99 = 5.11 ms
decimation kernel only               p50 = 0.52 ms    p95 = 0.56 ms    p99 = 0.65 ms
draw only (cached data + scales)     p50 = 0.48 ms    p95 = 0.58 ms    p99 = 3.90 ms
```

CPU-bound fps ceiling at p95:
- full cycle: **214 fps**
- draw only: **1735 fps**

Both 60fps (16.67ms) and 120fps (8.33ms) frame budgets fit with material
headroom on the CPU side.

**Honest disclaimer.** The bench runs against a recording mock canvas
context (see `test/harness.js`). This measures the library's CPU work
(scale math, decimation, canvas-call issuing) but does NOT measure real GPU
paint cost. In a real browser, paint is additional and depends on GPU, DPR,
blending, and what else is on the compositor. The 60fps-at-100k claim is
meaningful only when CPU + GPU together fit under 16.67ms. This bench
validates the CPU side. The browser bench (`bench/browser/`, coming in
v1.0.1) measures real paint.

### Zero-GC discipline

Hot-path allocations target: <100 bytes/cycle. Currently measured at ~270
bytes/cycle, attributable to:

- `{xs, ys}` object literal allocated by the test rotor (~16 B)
- `niceYDomain` returning a fresh `[lo, hi]` tuple (~40 B; fix in v1.0.1)
- Axis label string concatenation via `String.fromCharCode` (~120 B for 20
  labels; fix by switching to a shared `Uint8Array` and only stringifying
  when text actually changes)
- Promise allocations from `queueMicrotask`-based draining

None of these touch the per-frame line render -- they're in the data/axis
update path that fires only on actual changes. The line draw closure
itself is fully allocation-free in steady state (verified by the
`decimateMinMax` zero-GC test in `test/charts.test.js`).

### What's measured, what isn't

| | Measured | Notes |
|---|---|---|
| Per-frame CPU work | YES | Bench p95 |
| Decimation kernel zero-alloc | YES | Test asserts <100 bytes/call |
| GPU paint cost | NO | Browser bench coming v1.0.1 |
| Cold-start overhead | NO | Single-figure ms; not yet measured |
| Bundle size min+gz | NO | Single-file ESM, ~6 KB estimated; not yet minified |

## Brushing (v1.4.0-alpha.3)

Opt in with `brush: true` on any axis-kernel chart. Shift+drag
selects a rectangle; the chart emits `{ xMin, xMax, yMin, yMax, ids }`
via `chart.brush`:

```js
const chart = createLineChart({
    data: [...],
    brush: true,
    // optional visual override:
    brushStyle: {
        fill: 'rgba(255, 99, 0, 0.18)',
        stroke: 'rgba(255, 99, 0, 0.8)',
        lineDash: [6, 4],
        lineWidth: 1.5,
    },
});
chart.mount(target);
```

### `chart.brush` -- reactive selection accessor

```js
chart.brush();                                    // reactive read
chart.brush.peek();                               // untracked read
chart.brush.set({ xMin: 0, xMax: 50,
                  yMin: 0, yMax: 100 });          // imperative set
chart.brush.clear();                              // clear selection

// Aliases:
chart.setBrush({ ... });
chart.clearBrush();
```

The selection shape is `{ xMin, xMax, yMin, yMax, ids }`:

- `xMin/xMax/yMin/yMax` are data-space bounds.
- `ids` is an array of indices into the **primary series** (the
  first series in `series[]`, or the single-series `data`). It's
  freshly allocated each time the user releases a brush gesture.
- Programmatic `setBrush()` does NOT recompute `ids` -- if you set
  the brush imperatively, `ids` stays as whatever you pass (or null).
  Pass your own array if you want them; or compute from the bounds
  yourself.

`setBrush` / `clearBrush` throw if `brush: true` was not in config --
the throw is intentional, it tells the caller to opt in.

### Cross-chart linking

The standard d3-brush use case -- brush a subset on chart A,
filter/highlight matching data on chart B -- works directly via
the reactive facade:

```js
import { effect } from '@zakkster/lite-signal';

// User brushes on chartA; chartB filters in response.
effect(() => {
    const b = chartA.brush();
    if (b && b.ids) {
        chartB.highlightIds(b.ids);  // or any other side effect
    } else {
        chartB.clearHighlight();
    }
});
```

The brush signal updates on every `pointermove` while the gesture is
active, so the cross-chart effect runs live during the drag. Debounce
in user code if needed for very large datasets.

### Modifier routing -- coexists with pan/zoom

Bare drag = pan (when `pan: true`). Shift+drag = brush (when
`brush: true`). Wheel = zoom (when `zoom: true`, regardless of
modifier). The pointerdown handler checks `ev.shiftKey` and routes
the gesture accordingly; pan exits early when shift is held AND
brush is enabled. If brush is NOT enabled, the modifier is ignored
and shift+drag falls through to pan.

Click-to-clear: a shift+click with total drag distance under 3
pixels is treated as a click and clears the existing brush. This
matches d3-brush's default.

### Visual

A translucent rect overlay renders on top of the chart's data and
crosshair. Defaults to a translucent accent fill with a dashed
accent outline. Override via `brushStyle`:

| Field | Default | Notes |
|---|---|---|
| `fill` | `'rgba(99, 102, 241, 0.15)'` | Translucent indigo. Pass any CSS color. |
| `stroke` | `'rgba(99, 102, 241, 0.7)'` | Outline color. |
| `lineDash` | `[4, 4]` | Pass `[]` for a solid outline. |
| `lineWidth` | `1` | Stroke width. |

### Caveats (alpha.3)

- **IDs from primary series only.** Multi-series filtering is up to
  the caller -- the brush bounds are the universal hook; compute
  your own per-series indices from them.
- **Fixed modifier.** alpha.3 ships with shift as the modifier; a
  configurable modifier is a follow-up.
- **No bar / polar / radar / heatmap.** Brushing is on axis-kernel
  charts only. Different interaction models -- pie has no x/y
  rect to select; heatmap selection would be cell-based, not
  bounds-based.

## Pan + zoom (v1.4.0-alpha.2)

Opt in with `pan: true` and/or `zoom: true` on any axis-kernel chart
(line, area, bubble, scatter):

```js
const chart = createLineChart({
    data: [...],
    pan: true,           // pointer-drag pans
    zoom: true,          // wheel zooms around cursor
    panBounds: 'data',   // 'data' (default) clamps; 'free' allows past data
    zoomMin: 0.001,      // can zoom in until visible = 0.1% of data span
    zoomMax: 100,        // can zoom out until visible = 100x data span
    zoomStep: 1.15,      // wheel ratio per tick (default 1.15)
});
chart.mount(target);
```

### `chart.view` -- reactive view accessor

Mirrors the `chart.crosshair` facade pattern:

```js
chart.view();                          // reactive read (tracks in effects)
chart.view.peek();                     // untracked read
chart.view.set({ xMin: 10, xMax: 50 }); // write (partial views supported)
chart.view.reset();                    // back to null (follow data domain)

// Imperative aliases:
chart.setView({ xMin: 0, xMax: 100 });
chart.resetView();
```

The view shape is `{ xMin, xMax, yMin, yMax }`, each field optionally
`null` to fall back to the data-derived domain on that axis. This
shape is intentionally symmetric with `lite-camera-max`'s camera
signal so the same value drops into a future lite-gl `project()`
function unchanged when the `@zakkster/lite-charts-gl` companion
package lands.

`setView` / `resetView` throw if neither `pan` nor `zoom` was set at
construction -- the throw is intentional, it tells the caller to
opt in.

### Interaction model

**Pan**: pointer-drag with the left button. The cursor-anchor
convention (d3-zoom, Plotly, Google Maps) is used throughout -- the
data point under the cursor at pointerdown stays under the cursor as
it moves. Concretely:

- Drag right -> view shifts left in data space (xMin decreases).
  You see more of the data that was previously off-screen to the left.
- Drag up -> view shifts down in data space (yMin decreases). The
  content rolls up with the cursor; the y-axis labels effectively
  scroll down.

**Zoom**: wheel up zooms in, wheel down zooms out. Each tick scales
the range by `zoomStep` (default 1.15). The data point under the
cursor stays at the same screen pixel through the zoom -- this is
what makes zoom-on-detail feel intuitive.

**Modifier keys**: shift is reserved for alpha.3 brushing. alpha.2
uses no modifiers -- bare drag pans, bare wheel zooms.

### Bounds

`panBounds: 'data'` (the default) keeps the view within the data
domain. Pan or zoom into territory past the data -> the view shifts
back so the data edge sits at the plot edge. Zoom out wider than
data -> the view snaps to the full data domain.

`panBounds: 'free'` allows any view (extend past data on either axis,
zoom out arbitrarily). Useful for showing context space around the
data, or for charts where the "data domain" doesn't have a fixed
extent in the relevant axis.

### Caveats worth knowing

- **Log-aware pan/zoom (fixed in v1.4.1).** Through v1.4.0 the pan/zoom
  math added and scaled in data space even on a `yScale: { type: 'log' }`
  chart, so pan magnitude was wrong and a large gesture could drive the
  domain non-positive. v1.4.1 (finding C0) operates in log space: a drag
  of `d` px on an `n`-decade axis multiplies both bounds by `10^(n*d/plotH)`
  and no gesture can produce a non-positive domain. As of v1.6.0 the same
  log-space pan/zoom math applies to `xScale: { type: 'log' }` on the x-axis.
- **Bar charts** inherit pan/zoom typing via `Omit<LineChartConfig,
  ...>` but their band x-axis isn't ideal for panning. Visually
  weird; not documented as supported in alpha.2.
- **Polar / radar / heatmap kernels** don't get pan/zoom in alpha.2.
  Different interaction models -- pie has no x/y space; heatmap uses
  band scales on both axes.

## Log scale (y: v1.4.0-alpha.0; x: v1.6.0)

Opt in with `yScale: { type: 'log' }` on any axis-kernel chart
(line, area, bar, bubble, scatter). As of v1.6.0 the same option
works on the x-axis via `xScale: { type: 'log' }` for the continuous
kernels (line, area, scatter, bubble -- not the categorical bar):

```js
const chart = createLineChart({
    data: [{x:0,y:1},{x:1,y:10},{x:2,y:100},{x:3,y:1000}],
    yScale: { type: 'log' },
    width: 600, height: 300,
});
chart.mount(target);
```

Base-10 logarithm. Tick generation routes through
`@zakkster/lite-axis`'s `logTicks` -- decade boundaries (1, 10, 100,
...) with the major-only mode for v1.4.0-alpha.0. The `map` /
`invert` path uses `Math.log` / `Math.exp` with cached slope and
intercept so per-point projection stays a single multiply-add after
one log call.

**Non-positive values.** `map(v <= 0)` returns NaN. Line and area
draw fns break the segment on NaN positions; markers (bubble,
scatter) skip them. Callers are responsible for whatever upstream
filtering policy they want -- the chart will render whatever subset
of the data has positive y values.

**Caveats worth knowing.**

- **Log + bar.** Convention is "don't" -- bars represent magnitude
  from zero, and log has no meaningful zero. The library doesn't
  block the combination, but the visual won't be what most readers
  expect.
- **Log on x-axis (v1.6.0).** `xScale: { type: 'log' }` enables base-10
  log on the x-axis for the continuous kernels (line, area, scatter,
  bubble). Same decade ticks, same `map(x <= 0) = NaN` segment-break
  behavior, and log-space pan/zoom. Fail-closed: a non-positive x-domain
  throws at mount (naming the domain); x-log combined with a categorical
  (bar / band) or time x-axis throws at construction -- a scale is one
  type. Log + bar stays a y-axis-only notion since bar x is categorical.

## SVG export (v1.3.0)

Every chart exposes `chart.exportSVG(opts?)` which returns a complete
SVG string of the chart's current frame:

```js
const chart = createBarChart({
    data: [{x:'Mon',y:5},{x:'Tue',y:8},{x:'Wed',y:3}],
    cornerRadius: 4,
    width: 400, height: 250,
});
chart.mount(document.getElementById('chart'));

const svg = chart.exportSVG();
// '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250" ...'
```

The output is droppable into any HTML page, embeddable in a PDF or
Word document, or postable to an image-converter pipeline. Use cases
that motivated the feature: static reports, email attachments, screen-
reader-friendly artifacts, and the kind of automated regression
suites that diff rendered output frame-by-frame.

**How it works.** A Canvas2D-shaped shim
(`_SVGRenderingContext2D`) accumulates SVG markup instead of issuing
pixel ops. The same `drawNode`/`drawSelf` recursion lite-scene uses
to render to canvas walks the live `scene.root` tree through this
shim. The chart's draw callbacks don't know they're rendering to SVG
-- they just call the canvas API as always. Geometric output is
identical to the canvas paint (minus subpixel rasterization and DPR
scaling -- SVG is resolution-independent by design).

**Configuration.**

```ts
interface SVGExportOptions {
    /**
     * If set, an opaque <rect> covering the viewBox is emitted before
     * the chart contents. Default is the `background` value the chart
     * was constructed with (typically null = transparent SVG).
     */
    background?: string | null;
}
```

**Notes worth keeping in mind:**

- The chart must be `mount()`ed. `exportSVG()` throws if the chart
  isn't displayed or has been `destroy()`ed.
- Mock canvases work too (anything with `getContext('2d')` -- SVG
  export doesn't read pixel data), which is why the entire test
  suite can exercise SVG output without a browser.
- Text width estimation is approximate (~0.55 em per character).
  Layout heuristics that depend on exact text width will still
  produce the same SVG IF the chart was already painted to a real
  canvas first (the position values are computed against the canvas
  context that originally laid out the labels).
- Unsupported Canvas2D ops (gradients, shadows, drawImage) are
  silent no-ops in the shim -- none of the built-in chart code
  uses them in v1.3.0.

## Capacity considerations

lite-charts builds on `@zakkster/lite-signal`, which pre-allocates a
fixed-size arena for its reactive nodes (signals + effects). The default
capacity is **1024 nodes**, which fits a typical app with a few charts
but can be exhausted on dashboards or demos with many simultaneous
charts. If you see a `CapacityError: nodes capacity (1024) exceeded`,
this is the cause.

**Per-chart active node footprint** (measured against the v1.2.0-alpha.3
implementation, on a chart with default options at typical sizes):

| Chart | Active nodes |
|---|---|
| `createLineChart`    | ~43 |
| `createAreaChart`    | ~43 |
| `createBarChart`     | ~60 (3 series x 10 cats) |
| `createBubbleChart`  | ~46 |
| `createScatterChart` | ~46 |
| `createPieChart`     | ~25 |
| `createDonutChart`   | ~25 |
| `createRadarChart`   | ~50 |
| `createHeatmap`      | ~5 |

The dominant cost on axis-kernel charts is the per-axis tick pool:
each tick allocates a `lineNode` and a `textNode` (the label), each of
which creates one lite-scene effect. At max tick count (12 per axis)
that's ~24 effect nodes per axis x 2 axes = ~48 per chart. Heatmap is
unusually cheap because the grid kernel renders cells through a single
`pathNode`-per-layer rather than per-cell scene nodes.

**Rule of thumb**: the default 1024-node arena fits ~15-20 axis-kernel
charts on a single page. Multiply by the headroom you want for safety.

**Bumping the arena** -- call `setDefaultRegistry` BEFORE constructing
any chart:

```js
import { createRegistry, setDefaultRegistry } from '@zakkster/lite-signal';

// 32k nodes -- comfortable headroom for dashboards or demos. The arena
// is a few tens of KB of memory, so this is cheap.
setDefaultRegistry(createRegistry({ maxNodes: 32768 }));

// ... THEN construct your charts:
import { createLineChart } from '@zakkster/lite-charts';
const chart = createLineChart({ /* ... */ });
```

Order matters: charts read the *current* default registry at
construction time. Bumping after charts are already created doesn't
help those charts. The lite-charts demo (`demo/index.html`) bumps to
32768 at the very top for this reason.

**Mount/unmount/destroy** (v1.2.0): `unmount()` disposes the scene and
all draw effects but keeps construction-time signals (`widthAutoSig`,
`plotBoundsSignal`, `scaleVersion`, `crosshairVersion`,
`seriesVisibility[]`, `hoverVersion`, etc.) alive so the chart can be
remounted -- which leaves ~4 nodes of residue per cycle in the
lite-signal arena. `chart.destroy()` is the terminal counterpart:
it calls `unmount()` first if mounted, then disposes every signal the
chart created at construction. After `destroy()` the chart cannot be
remounted; subsequent `destroy()` calls are no-ops. Use it for apps
that create and destroy many charts dynamically (dashboard tabs,
design builders) where the `unmount()` residue would otherwise
accumulate.

## Roadmap

v1.0.0 ships seven chart types on three independent kernels with
kernel-side auto-resize. See [ROADMAP.md](./ROADMAP.md) for the full
forward plan and the development history that led here. Headlines:

| Version | Scope |
|---|---|
| **v1.0.0** | Seven chart types, three kernels, auto-resize, 182 tests, full tree-shake verification |
| **v1.1.0** | Stacked bar layout via `postExtract` hook; rounded bar corners (native `roundRect` + `arcTo` fallback); per-bar hover tint. 196 tests. |
| **v1.2.0-alpha.0** | Spatial-index foundation: `SpatialIndex` / `SpatialIndexFactory` contract; wired into `createBubbleChart` for O(log n) hit-test on dense clouds. 204 tests. |
| **v1.2.0-alpha.1** | `createScatterChart` (eighth chart type); reuses the spatial-index foundation with `k = 1`. 210 tests. |
| **v1.2.0-alpha.2** | Multi-series bubble + global size domain via bubble's `postExtract`; per-point color via `colorKey`; cross-series hit-test with `snapSeriesIdx`. 219 tests. |
| **v1.2.0-alpha.3** | `createHeatmap` on a new `createBaseGridChart` kernel (the fourth). 231 tests. |
| **v1.2.0** | Heatmap polish (row + column highlight, quantile binning, auto-contrast value labels); `chart.destroy()` terminal teardown on every kernel. 245 tests. |
| **v1.3.0** | `chart.exportSVG()` across all nine charts via a Canvas2D-shim that walks the live scene tree. Pixel-identical to canvas paint (minus DPR scaling). Pre-existing bar-label centering bug found and fixed. 259 tests. |
| **v1.4.0** | Three interaction primitives on axis-kernel charts: log scale on y (`yScale: { type: 'log' }`), pan + zoom (`pan` / `zoom`, `chart.view`), brushing (`brush`, `chart.brush`). Plus four pre-existing allocation traps closed during a bare-metal audit. 320 tests. Shipped across alphas .0-.3; see CHANGELOG for the per-alpha breakdown. |
| **v1.4.1** | Correctness patch: log-aware pan/zoom math (`_applyPanLog` / `_applyZoomLog`, log-space arithmetic + a domain floor), per-axis branching, and fail-closed scale validation -- a log chart could not be panned or zoomed before (findings LC-01..LC-05). `updateLogScale` throws on an invalid domain; `xScale: { type: 'log' }` still threw at this point (wired in v1.6.0). 341 tests + a torture/stress gate (`npm run torture`). |
| **v1.5.0** | Presentation cut. Donut `centerLabel` -- a number in the hole as a CSS-`clamp()`-sized DOM overlay (digit count drives the font; zero per-frame JS). Horizontal bar `orientation` -- category band on Y, byte-identical vertical draw path, fail-closed vs `pan` / `zoom` / `brush` / value `grid` / log axis. Additive, no public API breaks vs 1.4.1. 363 tests + torture gate. |
| **v1.5.1** | Correctness patch. `scaleSeriesToPixels` -- the hot per-extract projection loop for every `projectToPixels` renderer (line / area / scatter / bubble) -- inlined linear `v * slope + intercept` for both axes, so a `yScale: { type: 'log' }` chart drew its axis and ticks correctly but placed every point at the wrong pixel (present since y-log shipped in 1.4.1). The loop is now log-aware on both axes via four cold-selected flat bodies; the all-linear path is byte-identical (proven by a 12k-point `Object.is` parity gate). Bars unaffected (`projectToPixels: false`); `xScale: { type: 'log' }` still threw. 368 tests + a pure-kernel torture gate (T6.A13). |
| **companion** | `@zakkster/lite-charts-gl` v0.1.0+ -- separate WebGL2 package built on `@zakkster/lite-gl`. Scatter / bubble / density charts targeting the 100k-1M point range. lite-charts core stays canvas-only and node-testable. |
| **v1.6.0** | X-axis log scale. `xScale: { type: 'log' }` now works on the continuous axis-kernel charts (line / area / scatter / bubble): base-10 log projection, decade ticks via `logTicks`, and log-space pan/zoom -- symmetric with the y-axis, built on the v1.5.1 projection fix. Fail-closed: a non-positive x-domain throws at mount naming the domain; x-log on a categorical (bar / band) or time x-axis throws at construction. Common linear-x path byte-unchanged. 383 tests + the T6.A13 torture gate extended to the x-log projection body. |
| **v1.6.1** (this) | Correctness patch. A mixed-sign log domain (`min <= 0, max > 0`) floored to positive for drawing but kept the raw non-positive min in the pan/zoom bounds snapshot (`_dataDomain`), so the first gesture took `log()` of a value `<= 0` and NaN'd the view. `_dataDomain`'s min is now floored to the same positive part the render path uses, on both x and y. The no-positive-extent case still throws at mount (the floor cannot mask it); the linear/time path and the per-frame draw are byte-unchanged. 390 tests (7 new: y-pan, x/y positive-domain regression, x/y fail-closed throw, x/y zoom-path) + the T6.A13 torture gate. |
| v1.6.x / v1.7.0 (candidates) | horizontal bars with `pan` / `zoom` / `brush` / value grid; configurable brush modifier; brush IDs across all visible series; time-series variants; annotation layer; legend virtualization via `lite-virtual`. |

## Ecosystem

Part of the `@zakkster/*` zero-GC stack:

- `@zakkster/lite-signal` -- reactive core (peer)
- `@zakkster/lite-scene` -- Canvas2D scene graph (peer)
- `@zakkster/lite-axis` -- tick generation (peer)
- `@zakkster/lite-canvas-graph` -- the decimation kernel was lifted from here
- `@zakkster/lite-bvh` / `lite-aabb` -- spatial tooltip backend for v1.2 scatter
- `@zakkster/lite-virtual` -- legend virtualization for v1.2

## License

MIT (c) Zahary Shinikchiev
