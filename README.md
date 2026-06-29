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

**Status:** v1.2.0 -- **nine** chart types across **four** independent
kernels, every one of them now also a static SVG via
`chart.exportSVG()`. **263/263 tests pass.**

**New in v1.2.0:**
- **`chart.exportSVG()`** on every chart. Returns a complete
  `<svg>...</svg>` string with `xmlns`, `viewBox`, `width`, `height` --
  droppable into any HTML page, PDF, or static asset pipeline.
  Implementation walks the live `scene.root` tree through a
  Canvas2D-shaped shim that emits SVG markup instead of pixels, so
  the output is geometrically identical to the canvas paint (minus
  DPR scaling -- SVG is resolution-independent).
- **Bar category labels are now correctly centered.** Pre-existing
  typo in the band-axis builder passed `anchor:` instead of `align:`
  to a `textNode`, leaving `_align` at its `'left'` default. Single-
  character labels masked the issue; multi-character names were
  offset right by half a glyph width. Found during SVG work; both
  canvas AND SVG output benefit.

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

**Hit detection is discrete.** Unlike line/area which uses `bisectNearest`
(O(log n) over the x array), bar uses `bandScale.invert(canvasX)` which is
a single floor-division: `Math.floor((px - origin) / step)`. The user is
either inside a band or in a gap that snaps to the nearest band. O(1)
regardless of category count.

**Y-domain includes the baseline by default** so bars don't visually float.
Override with `yScale: { domain: [...] }` if you need a fixed window.

**Stacked layout** ships in v1.1.1. The current beta only supports grouped
multi-series (which is the right default -- stacked introduces design
choices around shared y-domain and tooltip ordering that are worth a
dedicated session).

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
// v1.2.0 -- pie family (no axes, polar coordinates)
const createBasePolarChart = (config, renderer) => { /* polar scaffold */ };
export const createPieChart   = (c) => createBasePolarChart(c, PIE_RENDERER);
export const createDonutChart = (c) => createBasePolarChart(c, DONUT_RENDERER);
export const createRadarChart = (c) => createBasePolarChart(c, RADAR_RENDERER);

// v1.2.0 -- scatter family (extends axis chart with size dimension)
export const createBubbleChart = (c) => createBaseAxisChart(c, BUBBLE_RENDERER);

// v1.4.0 -- heatmap (2D categorical grid)
const createBaseGridChart = (config, renderer) => { /* grid scaffold */ };
export const createHeatmap = (c) => createBaseGridChart(c, HEATMAP_RENDERER);
```

Each chart type added to the library costs nothing for users who don't
import it. A dashboard that only needs line and bar charts gets a ~30 KB
bundle even after pie, donut, radar, bubble, and heatmap ship.

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

## SVG export (v1.2.0)

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
  uses them in v1.2.0.

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
| **v1.2.0** (this) | Heatmap polish (row + column highlight, quantile binning, auto-contrast value labels); `chart.destroy()` terminal teardown on every kernel; `chart.exportSVG()` across all nine charts via a Canvas2D-shim that walks the live scene tree (pixel-identical to canvas paint, minus DPR scaling); a zero-GC audit pass fixing four allocation traps. 263 tests. |
| v1.4.0 | Log scale; pan + zoom; brushing primitives |
| v1.5.0 | Time-series specialized variants; legend virtualization via `lite-virtual`; annotation layer |

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
