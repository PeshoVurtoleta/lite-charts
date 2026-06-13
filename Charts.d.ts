/**
 * @zakkster/lite-charts -- TypeScript declarations.
 */

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export type Accessor<T> = T | (() => T);

export type DataAccessor =
    | object[]
    | { xs: Float32Array; ys: Float32Array }
    | (() => object[] | { xs: Float32Array; ys: Float32Array });

export type FieldAccessor =
    | string
    | number
    | ((row: any, index: number) => number);

export interface Scale {
    type: 'linear' | 'time';
    dMin: number;
    dMax: number;
    rMin: number;
    rMax: number;
    map(value: number): number;
    invert(pixel: number): number;
}

export interface PNGExportOptions {
    mimeType?: string;
    quality?: number;
}

// ---------------------------------------------------------------------------
// Line chart
// ---------------------------------------------------------------------------

export interface SeriesConfig {
    name?: string;
    data: DataAccessor;
    color?: string;
    lineWidth?: number;
    /** Per-series override for interpolation mode. Default inherits from chart. */
    interpolation?: InterpolationMode;
    /** Per-series override for markers. `false` disables. Default inherits from chart. */
    markers?: boolean | MarkerConfig;
}

export interface XScaleConfig {
    type?: 'linear' | 'time';
    domain?: [number, number];
}

export interface YScaleConfig {
    domain?: [number, number];
    zero?: boolean;
    nice?: boolean;
}

export interface MarginConfig {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

// ---------------------------------------------------------------------------
// Crosshair / tooltip (v1.0.0-alpha.1)
// ---------------------------------------------------------------------------

export interface CrosshairState {
    visible: boolean;
    /** Index into the primary series xs[] of the snapped sample, or -1 if hidden. */
    snapIdx: number;
    /** Domain x-value of the snapped sample (ms for time scales). */
    snapDomainX: number;
    /** Pixel x of the snapped sample (where the vertical crosshair line draws). */
    snapPixelX: number;
    /** Pixel y of the mouse cursor (not snapped to any sample). */
    mousePixelY: number;
}

export interface CrosshairConfig {
    /** CSS color of the vertical crosshair line. Default: '#666'. */
    color?: string;
    /** Dash pattern for the crosshair line. Default: [3, 3]. */
    dash?: number[];
}

export type InterpolationMode =
    | 'linear'
    | 'step'
    | 'step-after'
    | 'step-before'
    | 'step-mid'
    | 'monotone'
    | 'catmull-rom';

export type MarkerShape = 'circle' | 'square' | 'triangle' | 'diamond';

export interface MarkerConfig {
    shape?: MarkerShape;
    /** Marker size in CSS pixels (diameter for circle, side length otherwise). Default 5. */
    size?: number;
    /** Fill color. Defaults to the series color. */
    fill?: string;
    /** Stroke color. Default '#ffffff'. Pass falsy to disable. */
    stroke?: string;
    /** Stroke width. Default 1. Pass 0 to disable stroke. */
    strokeWidth?: number;
    /** Draw 1 of every N samples. Default 1. Use 5-10 for dense series to avoid visual noise. */
    everyN?: number;
}

export interface GridConfig {
    /** Show vertical gridlines at X tick positions. Default true (when grid object passed). */
    x?: boolean;
    /** Show horizontal gridlines at Y tick positions. Default true (when grid object passed). */
    y?: boolean;
    /** Gridline color. Subtle by default. Accepts hex / oklch / '--css-var' tokens. */
    color?: string;
}

export interface TooltipRow {
    color: string;
    label: string;
    value: string;
}

export interface TooltipFormatContext {
    snapIdx: number;
    snapDomainX: number;
    xScaleType: 'linear' | 'time';
    /** Default rows, one per series with data at the snap. Mutable by formatter. */
    rows: TooltipRow[];
}

export interface TooltipConfig {
    background?: string;
    border?: string;
    /**
     * Override the default rows + header. Return a string for header-only,
     * or `{ header?, rows? }` to customize both.
     */
    format?: (ctx: TooltipFormatContext) => string | { header?: string; rows?: TooltipRow[] };
}

// ---------------------------------------------------------------------------
// Legend (v1.0.0-alpha.3)
// ---------------------------------------------------------------------------

export type LegendPosition = 'top' | 'bottom' | 'left' | 'right';

export interface LegendConfig {
    position?: LegendPosition;
    /**
     * Append the legend into an existing element instead of auto-wrapping
     * the canvas. Useful for custom layouts where canvas and legend live
     * in different DOM trees.
     */
    container?: HTMLElement;
}

/** Minimal signal shape (lite-signal). Read = `sig()`, write = `sig.set(v)`. */
export interface Signal<T> {
    (): T;
    peek(): T;
    set(v: T): void;
    update(fn: (v: T) => T): void;
}

export interface LineChartConfig {
    /** Single-series shorthand. Either `data` or `series` is required. */
    data?: DataAccessor;
    /** Multi-series form. */
    series?: SeriesConfig[];

    /** x accessor: string key, integer index, or function. Default 'x'. */
    x?: FieldAccessor;
    /** y accessor: string key, integer index, or function. Default 'y'. */
    y?: FieldAccessor;

    /** Static or reactive width in CSS pixels. Default 800. */
    width?: Accessor<number>;
    /** Static or reactive height in CSS pixels. Default 400. */
    height?: Accessor<number>;

    margin?: MarginConfig;

    color?: string;
    lineWidth?: number;
    background?: string | null;
    axisColor?: string;
    labelColor?: string;
    font?: string;

    /** Path interpolation. Default 'linear'. Per-series override via SeriesConfig.interpolation. */
    interpolation?: InterpolationMode;
    /** Marker dots at each sample point. `true` for defaults, `false` to disable, or an object. */
    markers?: boolean | MarkerConfig;
    /** Gridlines through the plot rect at each tick. Default false. `true` enables both axes. */
    grid?: boolean | GridConfig;

    dpr?: number;

    xScale?: XScaleConfig;
    yScale?: YScaleConfig;

    /** Crosshair: vertical line + per-series marker dots at the snapped x. Default true. Pass false to disable. */
    crosshair?: boolean | CrosshairConfig;
    /** Tooltip: canvas-drawn box with sample values at the snapped x. Default true. Pass false to disable. */
    tooltip?: boolean | TooltipConfig;
    /** Legend: DOM-rendered with click-to-toggle. Default 'bottom'. Pass false to disable, a position string for shorthand, or LegendConfig for full control. */
    legend?: boolean | LegendPosition | LegendConfig;

    /**
     * Frame scheduler. Default rAF in browser, synchronous in Node.
     * Pass `queueMicrotask` for headless coalesced batching.
     */
    schedule?: (fn: () => void) => void;
}

export interface SeriesConfigPublic extends SeriesConfig {}

export interface Chart {
    /** Mount into a DOM element (creates canvas inside) or directly into a canvas. */
    mount(target: HTMLElement | HTMLCanvasElement): Chart;
    /** Dispose effects and remove the owned canvas. Idempotent. */
    unmount(): void;
    /** Returns a data URL via canvas.toDataURL. Requires a real HTMLCanvasElement. */
    exportPNG(opts?: PNGExportOptions): string;
    /** Force a redraw without changing data. */
    redraw(): void;

    /**
     * Programmatically move the crosshair to a canvas-local pixel position.
     * Snaps to the nearest sample on the primary series. Used by tests and
     * for synchronizing crosshairs across small multiples.
     */
    moveCrosshair(canvasX: number, canvasY: number): void;
    /** Hide the crosshair / tooltip. Idempotent. */
    hideCrosshair(): void;
    /** Toggle a series' visibility. Out-of-range indices are safe no-ops. */
    setSeriesVisible(idx: number, visible: boolean): void;
    /**
     * Re-resolve every CSS-var-driven color against the current container's
     * computed style and trigger a redraw. Call after a theme switch (dark
     * mode, etc.). No-op if the chart isn't mounted.
     */
    refreshTheme(): void;

    readonly scene: unknown | null;            // lite-scene Scene type
    readonly canvas: HTMLCanvasElement | null;
    readonly xScale: Scale;
    readonly yScale: Scale;
    readonly xScaleType: 'linear' | 'time';
    /** Version-counter signal; read to subscribe to plot-bounds changes. */
    readonly plotBounds: () => number;
    /**
     * Crosshair state. Behaves like a signal: callable to subscribe-and-read,
     * `.peek()` to read without subscribing, `.set()` to write, `.subscribe()`
     * to register a callback. As of v1.0.0-beta.2 the returned `CrosshairState`
     * is the SAME mutable reference on every read -- this eliminates the
     * per-mousemove allocation that hardware polling rates would otherwise
     * generate. Read fields eagerly when notified; do not retain the reference
     * and re-read later expecting stable values.
     */
    readonly crosshair: (() => CrosshairState) & {
        peek(): CrosshairState;
        set(v: CrosshairState): void;
        subscribe(fn: (s: CrosshairState) => void): () => void;
    };
    /** One signal per series. Read in a reactive context to bind external UI; write to toggle. */
    readonly seriesVisibility: Signal<boolean>[];
    /** The legend DOM element, or null if legend was disabled / mounted into a bare canvas. */
    readonly legend: HTMLElement | null;
}

export function createLineChart(config: LineChartConfig): Chart;

// ---------------------------------------------------------------------------
// Area chart (v1.0.0-alpha.2)
// ---------------------------------------------------------------------------
//
// Same data + scale + reactivity contract as the line chart, plus a baseline
// to fill to. Renders fill + optional upper-boundary stroke.

export interface AreaChartConfig extends LineChartConfig {
    /**
     * Where to close the area to. Number = domain y value (default 0); 'bottom'
     * pins to the bottom edge of the plot rect regardless of domain.
     */
    baseline?: number | 'bottom';
    /** Whether to stroke the upper boundary. Default true. */
    stroke?: boolean;
    /** Fill opacity multiplied into globalAlpha before fill. Default 0.3. */
    fillOpacity?: number;
}

export function createAreaChart(config: AreaChartConfig): Chart;

// ---------------------------------------------------------------------------
// Bar chart (v1.1.0)
// ---------------------------------------------------------------------------
//
// Categorical x-axis (band scale) with linear y. Multi-series renders grouped
// side-by-side by default; each series occupies a slice of the band centered
// on its series index. Stacked layout ships in v1.1.1.

export interface BarChartConfig extends Omit<LineChartConfig, 'interpolation' | 'markers' | 'xScale'> {
    /**
     * Y value at which bars start. Default 0. Negative bars extend downward
     * from this baseline; positive bars extend upward.
     */
    baseline?: number;
    /**
     * Fraction of step taken up by the gap BETWEEN bands. d3-scaleBand
     * convention; in [0, 1). Default 0.15.
     */
    paddingInner?: number;
    /**
     * Fraction of step at each END of the range. d3-scaleBand convention;
     * in [0, 1). Default 0.1.
     */
    paddingOuter?: number;
    /**
     * For grouped layout: fraction of group-slot width left as gap between
     * adjacent grouped bars within the same category. Default 0.08.
     */
    groupInnerPad?: number;
    /**
     * v1.1.0: when true, series stack cumulatively per category instead of
     * sitting side-by-side. The y-domain expands to the total stack height.
     * Hidden series (via legend toggle) are excluded from the stack. MVP
     * supports positive values only; negative values clamp to 0 in the
     * stack. Default false.
     */
    stack?: boolean;
    /**
     * v1.1.0: corner radius in pixels for the top of each bar (positive)
     * or bottom (negative). Default 0 (square corners). Capped at
     * min(barWidth, barHeight) / 2 internally so very small bars never
     * have overlapping corner arcs.
     */
    cornerRadius?: number;
    /**
     * v1.1.0: overlay color drawn on top of the hovered bar. Pass a CSS
     * color string, `true` for the default low-alpha white, or `false`
     * to disable. Default: `'rgba(255,255,255,0.18)'`.
     */
    hoverTint?: string | boolean;
    /**
     * X-scale overrides. Bar charts always use a band scale; only `domain`
     * (an explicit categories array) is honoured here -- the inferred type
     * is forced to 'band'.
     */
    xScale?: { domain?: string[] };
}

export function createBarChart(config: BarChartConfig): Chart;

// ---------------------------------------------------------------------------
// Bubble chart (axis kernel with size dimension, v1.2.0-alpha.3)
// ---------------------------------------------------------------------------

export interface BubbleSeriesInput {
    /** Single-series data: array of points or accessor function. */
    data: Array<{ [k: string]: unknown }> | (() => Array<{ [k: string]: unknown }>);
    name?: string;
    color?: string;
    stroke?: string;
    strokeWidth?: number;
    fillOpacity?: number;
}

export interface BubbleChartConfig {
    /** Single-series data shape. */
    data?: Array<{ [k: string]: unknown }> | (() => Array<{ [k: string]: unknown }>);
    /**
     * Multi-series shape (v1.2.0-alpha.2). Each series gets its own `data`,
     * `name`, and optional `color`. The size dimension is shared across
     * series via a GLOBAL size domain computed in `postExtract`, so equal
     * raw values render at equal pixel radii regardless of which series.
     */
    series?: BubbleSeriesInput[];

    /** Key (or index) for x values. Default 'x'. */
    x?: string | number | ((row: unknown, i: number) => number);
    /** Key (or index) for y values. Default 'y'. */
    y?: string | number | ((row: unknown, i: number) => number);
    /** Key (or index) for the size dimension. Default 'value'. */
    size?: string | number | ((row: unknown, i: number) => number);
    /**
     * v1.2.0-alpha.2: per-point color. When set, each row's color overrides
     * the series fill. Accepts CSS-var (`'--c-red'`), hex (`'#ff0000'`), or
     * any other CSS color value. Returning null/undefined falls back to the
     * series fill for that row.
     */
    colorKey?: string | number | ((row: unknown, i: number) => string | null | undefined);

    /** Minimum pixel radius. Default 4. */
    minRadius?: number;
    /** Maximum pixel radius. Default 40. */
    maxRadius?: number;
    /**
     * 'sqrt' (default) is area-proportional and eye-correct (Tukey
     * convention). 'linear' is radius-proportional; use when the size
     * dimension is already a length/radius rather than a magnitude.
     */
    sizeScale?: 'sqrt' | 'linear';

    color?: string;
    stroke?: string;
    strokeWidth?: number;
    /** Bubble fill alpha. Default 0.6. */
    fillOpacity?: number;

    width?: number | (() => number);
    height?: number | (() => number);
    margin?: { top?: number; right?: number; bottom?: number; left?: number };

    xScale?: { type?: 'linear' | 'time'; domain?: [number, number] };
    yScale?: { type?: 'linear'; domain?: [number, number]; nice?: boolean; zero?: boolean };

    grid?: boolean | { x?: boolean; y?: boolean; color?: string };

    crosshair?: false | { color?: string; dash?: [number, number] };
    tooltip?: false | {
        background?: string;
        border?: string;
        format?: (info: {
            snapIdx: number;
            snapDomainX: number;
            xScaleType: string;
            category: string | null;
            rows: Array<{ color: string; label: string; value: string }>;
        }) => string | { header?: string; rows?: Array<{ color: string; label: string; value: string }> };
    };

    legend?: boolean | 'top' | 'bottom' | 'left' | 'right' | {
        position?: 'top' | 'bottom' | 'left' | 'right';
        container?: HTMLElement;
    };

    font?: string;
    labelColor?: string;
    axisColor?: string;
    background?: string;
    dpr?: number;
    schedule?: (cb: () => void) => unknown;

    /**
     * v1.2.0-alpha.0: spatial-index factory for O(log n) hit-test on dense
     * bubble clouds. Pass any function matching `SpatialIndexFactory` --
     * `@zakkster/lite-delaunay` is the intended default, but a k-d tree or
     * uniform-grid implementation works just as well. Omit to use linear
     * scan (the v1.0.0 behavior, faster below ~1000 points).
     */
    spatialIndex?: SpatialIndexFactory;
    /**
     * v1.2.0-alpha.0: minimum point count before the spatial index is
     * built and queried. Below this, the linear scan is used (it's faster
     * for small clouds because the index has build cost). Default 1000.
     */
    spatialIndexThreshold?: number;
}

export function createBubbleChart(config: BubbleChartConfig): Chart;

// ---------------------------------------------------------------------------
// Spatial index interface (v1.2.0-alpha.0)
// ---------------------------------------------------------------------------
// A pluggable nearest-neighbor index for dense point clouds. lite-charts
// defines the contract; the implementation is supplied by the consumer
// (`@zakkster/lite-delaunay`, a k-d tree, etc.). Used by bubble (v1.2.0)
// and the future scatter / heatmap renderers.

export interface SpatialIndex {
    /**
     * Find up to `k` points closest to (qx, qy) in pixel space, filtered to
     * those with squared distance <= maxDistSq. Writes indices into
     * `outIndices` and squared distances into `outDistSq`. Both buffers are
     * caller-owned, stable refs -- the index MUST NOT keep references to
     * them between calls, and MUST NOT allocate per call (this is the
     * zero-GC contract). Returns the count actually written, in [0, k].
     */
    findNearest(
        qx: number,
        qy: number,
        k: number,
        maxDistSq: number,
        outIndices: Int32Array,
        outDistSq: Float32Array,
    ): number;

    /**
     * Release any resources held by the index. Pure-JS implementations may
     * make this a no-op; WebGL / WASM-backed indices should free buffers.
     * Called by lite-charts on data change and on chart unmount.
     */
    dispose(): void;
}

/**
 * Build a SpatialIndex over the given pixel-space coordinates. `n` is the
 * number of valid entries (the typed arrays may be larger due to growth-
 * allocation). The index MAY snapshot the inputs or hold the references --
 * lite-charts guarantees the data won't mutate before dispose() is called.
 */
export type SpatialIndexFactory = (
    pxs: Float32Array,
    pys: Float32Array,
    n: number,
) => SpatialIndex;

// ---------------------------------------------------------------------------
// Radar chart (separate kernel, v1.2.0-alpha.4)
// ---------------------------------------------------------------------------

export interface RadarSeriesInput {
    name?: string;
    color?: string;
    values: number[];   // one value per axis, parallel to config.axes
}

export interface RadarChartConfig {
    /** Axis labels. Length determines axis count; minimum 3 (triangle). */
    axes: string[];
    /** Series, each with values parallel to `axes`. */
    series: RadarSeriesInput[] | (() => RadarSeriesInput[]);

    /** Shared [min, max] across all axes. If omitted, auto-computed from data. */
    domain?: [number, number];
    /** Number of concentric grid rings. Default 4. */
    gridTicks?: number;
    /** Polygon fill alpha [0..1]. Default 0.2. */
    fillOpacity?: number;
    /** Polygon stroke width. Default 2. */
    strokeWidth?: number;

    width?: number | (() => number);
    height?: number | (() => number);
    margin?: { top?: number; right?: number; bottom?: number; left?: number };

    axisColor?: string;
    gridColor?: string;
    labelColor?: string;
    font?: string;
    background?: string;

    tooltip?: false | {
        background?: string;
        border?: string;
        format?: (info: {
            axisIdx: number;
            axisLabel: string;
            seriesIdx: number;
            value: number;
            rows: Array<{ color: string; label: string; value: string }>;
        }) => string | { header?: string; rows?: Array<{ color: string; label: string; value: string }> };
    };

    legend?: boolean | 'top' | 'bottom' | 'left' | 'right' | {
        position?: 'top' | 'bottom' | 'left' | 'right';
        container?: HTMLElement;
    };

    dpr?: number;
    schedule?: (cb: () => void) => unknown;
}

export interface RadarChart {
    mount(target: HTMLElement | HTMLCanvasElement): RadarChart;
    unmount(): void;
    exportPNG(opts?: { mimeType?: string; quality?: number }): string;
    redraw(): void;
    moveCrosshair(canvasX: number, canvasY: number): void;
    hideCrosshair(): void;
    setSeriesVisible(idx: number, visible: boolean): void;
    refreshTheme(): void;
    readonly scene: unknown;
    readonly canvas: HTMLCanvasElement | null;
    readonly geometry: { cx: number; cy: number; rOuter: number; axisCount: number };
    readonly domain: [number, number];
    readonly legend: HTMLElement | null;
    plotBounds: unknown;
    crosshair: unknown;
    seriesVisibility: Array<unknown>;
}

export function createRadarChart(config: RadarChartConfig): RadarChart;

// ---------------------------------------------------------------------------
// Polar slice charts -- pie / donut (v1.2.0-alpha.1)
// ---------------------------------------------------------------------------

export interface SliceInput {
    label?: string;
    value: number;
    color?: string;
}

export interface PieChartConfig {
    /** Slices, as objects with {label, value, color} OR a function returning them. */
    data?: SliceInput[] | (() => SliceInput[]) | { values: number[]; labels?: string[]; colors?: string[] };
    /** Parallel-arrays form: provided alongside data, or instead of it. */
    values?: number[];
    labels?: string[];
    colors?: string[];

    width?: number | (() => number);
    height?: number | (() => number);
    margin?: { top?: number; right?: number; bottom?: number; left?: number };

    /**
     * Inner radius: 0 = pie, 0..1 = fraction of outer, >1 = absolute pixels.
     * createPieChart defaults to 0; createDonutChart defaults to 0.5.
     */
    innerRadius?: number;

    sliceStroke?: string;
    sliceStrokeWidth?: number;
    labelColor?: string;
    font?: string;
    background?: string;

    tooltip?: boolean | {
        background?: string;
        border?: string;
        format?: (info: {
            sliceIdx: number;
            label: string;
            value: number;
            total: number;
            percent: number;
        }) => string | { header?: string; value?: string };
    };

    legend?: boolean | 'top' | 'bottom' | 'left' | 'right' | {
        position?: 'top' | 'bottom' | 'left' | 'right';
        container?: HTMLElement;
    };

    dpr?: number;
    schedule?: (cb: () => void) => unknown;
}

/** createDonutChart accepts the same config as createPieChart, with a 0.5
 *  innerRadius default instead of 0. The user can still override
 *  innerRadius (e.g. 0.7 for a thinner donut). */
export type DonutChartConfig = PieChartConfig;

export interface PolarChart {
    mount(target: HTMLElement | HTMLCanvasElement): PolarChart;
    unmount(): void;
    exportPNG(opts?: { mimeType?: string; quality?: number }): string;
    redraw(): void;
    moveCrosshair(canvasX: number, canvasY: number): void;
    hideCrosshair(): void;
    setSliceVisible(idx: number, visible: boolean): void;
    refreshTheme(): void;
    readonly scene: unknown;
    readonly canvas: HTMLCanvasElement | null;
    readonly geometry: { cx: number; cy: number; rOuter: number; rInner: number };
    readonly legend: HTMLElement | null;
    plotBounds: unknown;
    crosshair: unknown;
    sliceVisibility: Array<unknown>;
}

export function createPieChart(config: PieChartConfig): PolarChart;
export function createDonutChart(config: DonutChartConfig): PolarChart;

// ---------------------------------------------------------------------------
// Stubs for subsequent versions -- throw at runtime.
// ---------------------------------------------------------------------------
//
// Each will be a thin composition over a base kernel:
//   createHeatmap = createBaseGridChart(config, HEATMAP_RENDERER)

// ---------------------------------------------------------------------------
// createScatterChart (v1.2.0-alpha.1)
// ---------------------------------------------------------------------------
//
// Scatter is bubble's simpler sibling. Same axis kernel, same spatial-index
// foundation -- but no size dimension, no sqrt scaling, no smallest-on-top
// tie-break (scatter has no overlap concerns). Every point renders at the
// SAME pixel radius (`markerSize`); the hit-test uses a configurable
// tolerance disc around each point.

export interface ScatterChartConfig {
    /** Single-series data shape. */
    data?: Array<{ [k: string]: unknown }> | (() => Array<{ [k: string]: unknown }>);
    /** Multi-series shape. Each series gets its own data + color. */
    series?: Array<{ name?: string; data: unknown; color?: string }>;

    /** Key (or index) for x values. Default 'x'. */
    x?: string | number | ((row: unknown, i: number) => number);
    /** Key (or index) for y values. Default 'y'. */
    y?: string | number | ((row: unknown, i: number) => number);

    /** Pixel radius of every marker. Default 4. */
    markerSize?: number;
    /**
     * Pixel radius around each marker that counts as a hit. Default
     * `markerSize + 4`. Increase for easier targeting at small marker
     * sizes, decrease for crowded plots where neighboring points should
     * not steal hits.
     */
    hitTolerance?: number;

    color?: string;
    stroke?: string;
    strokeWidth?: number;
    /** Marker fill alpha. Default 1 (opaque). */
    fillOpacity?: number;

    width?: number | (() => number);
    height?: number | (() => number);
    margin?: { top?: number; right?: number; bottom?: number; left?: number };

    xScale?: { type?: 'linear' | 'time'; domain?: [number, number] };
    yScale?: { type?: 'linear'; domain?: [number, number]; nice?: boolean; zero?: boolean };

    grid?: boolean | { x?: boolean; y?: boolean; color?: string };
    crosshair?: false | { color?: string; dash?: [number, number] };
    tooltip?: BubbleChartConfig['tooltip'];
    legend?: BubbleChartConfig['legend'];

    font?: string;
    labelColor?: string;
    axisColor?: string;
    background?: string;
    dpr?: number;
    schedule?: (cb: () => void) => unknown;

    /** v1.2.0-alpha.0: same spatial-index integration as bubble. k = 1. */
    spatialIndex?: SpatialIndexFactory;
    spatialIndexThreshold?: number;
}

export function createScatterChart(config: ScatterChartConfig): Chart;

// ---------------------------------------------------------------------------
// createHeatmap (v1.2.0-alpha.3) -- fourth kernel
// ---------------------------------------------------------------------------
//
// 2D categorical grid. Cells indexed by (xCategory, yCategory); each cell
// has at most one value. Sparse data is supported. Color mapping defaults
// to linear RGB interpolation between two endpoint hex colors -- pass
// `colorFn` for custom mappings (OKLCH, quantile, diverging, etc.).
//
// Rides on createBaseGridChart, an independent kernel that knows nothing
// about the axis / polar / radar kernels. Verified via esbuild tree-shake:
// importing only `createHeatmap` pulls ~10.5 KB minified -- no axes, no
// scales, no slice math, no radar geometry.

export interface HeatmapConfig {
    /**
     * Long-form data: one row per cell. Categories are auto-extracted from
     * the x / y accessors in first-seen order. Missing (x, y) combinations
     * render as empty space and return null from the hit-test.
     */
    data: Array<{ [k: string]: unknown }> | (() => Array<{ [k: string]: unknown }>);

    /** Key (or function) for the x-axis category. Default 'x'. */
    x?: string | number | ((row: unknown, i: number) => string);
    /** Key (or function) for the y-axis category. Default 'y'. */
    y?: string | number | ((row: unknown, i: number) => string);
    /** Key (or function) for the numeric cell value. Default 'value'. */
    value?: string | number | ((row: unknown, i: number) => number);

    /**
     * Two-stop linear color ramp `[low, high]`. Default `['#dbeafe', '#1e3a8a']`
     * (blue-100 to blue-900). Accepts hex strings; CSS-vars are resolved
     * against the mount container.
     */
    colors?: [string, string];

    /**
     * Custom color function. Receives `(value, vMin, vMax)`; returns a CSS
     * color string. Overrides `colors` entirely. Use this for OKLCH ramps,
     * quantile binning, diverging schemes, etc.
     */
    colorFn?: (value: number, vMin: number, vMax: number) => string;

    /** Render the numeric value inside each cell. Default false. */
    showValues?: boolean;
    /** Format the cell value when `showValues` is true. */
    valueFormat?: (value: number, xi: number, yi: number) => string;
    /** Font for in-cell value labels. */
    valueLabelFont?: string;
    /** Color for in-cell value labels. */
    valueLabelColor?: string;

    /**
     * Fraction of band-width used as the gap between adjacent cells.
     * Default 0.04 (4%); set to 0 for a continuous grid.
     */
    cellGap?: number;

    /** Stroke color for the hovered cell highlight. Default '#111111'. */
    highlightStroke?: string;
    /** Stroke width for the hovered cell highlight in pixels. Default 2. */
    highlightStrokeWidth?: number;

    /** Custom tooltip text formatter. */
    tooltipFormat?: (info: { xi: number; yi: number; xLabel: string; yLabel: string; value: number }) => string;

    /** Axis label color. Default '#444444'. */
    labelColor?: string;
    /** Axis label font. Default '12px sans-serif'. */
    labelFont?: string;

    width?: number | (() => number);
    height?: number | (() => number);
    margin?: { top?: number; right?: number; bottom?: number; left?: number };

    background?: string;
    dpr?: number;
    schedule?: (cb: () => void) => unknown;
}

export function createHeatmap(config: HeatmapConfig): Chart;

// ---------------------------------------------------------------------------
// Test-only export (NOT part of the stable public API)
// ---------------------------------------------------------------------------
//
// Pure helpers for white-box unit testing. The leading underscore signals
// private; this lives on a separate top-level export so production code that
// imports only chart factories never pins these symbols into its bundle.

export const _testHelpers: {
    // Axis-chart kernel
    decimateMinMax: Function;
    updateLinearScale: Function;
    extractSeriesData: Function;
    extractBarSeriesData: Function;
    scaleSeriesToPixels: Function;
    makeLinearScale: Function;
    makeBandScale: Function;
    updateBandScale: Function;
    buildAccessor: Function;
    buildRawAccessor: Function;
    niceYDomain: Function;
    inferXScaleType: Function;
    resolveColor: Function;
    bisectNearest: Function;
    // Bubble-specific
    extractBubbleData: Function;
    computeBubbleRadii: Function;
    // Polar (pie/donut) kernel
    extractSliceData: Function;
    computeSliceGeometry: Function;
    sliceHitTest: Function;
    recomputePolarAngles: Function;
    makePolarState: Function;
    // Radar kernel
    extractRadarSeriesData: Function;
    computeRadarGeometry: Function;
    radarHitTest: Function;
    makeRadarSeriesState: Function;
};
