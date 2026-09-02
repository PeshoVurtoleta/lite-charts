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

/**
 * v1.3.0: options for `chart.exportSVG()`.
 *
 * The chart's canvas-time `background` config is used by default; passing
 * `background` here overrides it (use `null` to disable the background
 * rect explicitly even when the chart was constructed with one).
 */
export interface SVGExportOptions {
    /**
     * SVG background color. If set, an opaque `<rect>` covering the full
     * viewBox is emitted before the chart contents. Default is the
     * `background` value the chart was constructed with (typically null,
     * which produces a transparent SVG).
     */
    background?: string | null;
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

// ---------------------------------------------------------------------------
// View (v1.4.0-alpha.2 -- pan + zoom)
// ---------------------------------------------------------------------------

/**
 * The view domain currently rendered by the chart. Each field may be
 * `null` (or omitted on `setView`) to fall back to the data-derived
 * domain on that axis. Shape is intentionally symmetric with
 * `lite-camera-max`'s camera signal so the same value drops into a
 * lite-gl `project()` function unchanged.
 */
export interface View {
    xMin: number | null;
    xMax: number | null;
    yMin: number | null;
    yMax: number | null;
}

/**
 * Pan/zoom configuration (v1.4.0-alpha.2). Both default to `false`;
 * neither set = no view signal, no listeners, zero cost. Setting EITHER
 * enables the view signal and the `chart.view` / `setView` / `resetView`
 * facade.
 */
export interface PanZoomConfig {
    /** Enable mouse-drag-to-pan. Default false. */
    pan?: boolean;
    /** Enable wheel-to-zoom. Default false. */
    zoom?: boolean;
    /**
     * Bounds policy for both pan and zoom.
     * - `'data'` (default): view shifts to stay within the data domain.
     *   If a zoom would make the view wider than data, it snaps to the
     *   full domain.
     * - `'free'`: any view allowed (extend past data, invert axes, etc.).
     */
    panBounds?: 'data' | 'free';
    /**
     * Minimum zoom factor expressed as a ratio of visible-span to
     * data-span. `0.01` = zoom in until the visible range is 1% of the
     * data range. Default `0.01`.
     */
    zoomMin?: number;
    /**
     * Maximum zoom factor expressed as a ratio of visible-span to
     * data-span. `1000` = zoom out until the visible range is 1000x
     * the data range. Default `1000`.
     */
    zoomMax?: number;
    /**
     * Wheel ratio per tick. `1.15` = each wheel notch zooms by 15%.
     * Default `1.15`. Clamped to `>= 1.001`.
     */
    zoomStep?: number;
}

// ---------------------------------------------------------------------------
// Brush (v1.4.0-alpha.3)
// ---------------------------------------------------------------------------

/**
 * Brush selection. Data-space bounds + indices into the primary series
 * (the first series in `series[]`, or the single-series `data` when
 * that shorthand is used). `ids` is `null` when the brush was set
 * programmatically via `chart.setBrush()` (the API doesn't recompute
 * ids -- the user controls the value); when set by a shift+drag
 * gesture it's freshly allocated each commit.
 */
export interface BrushSelection {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    ids: number[] | null;
}

/**
 * Horizontal-bar brush selection (v1.9.0). On a `createBarChart({ orientation:
 * 'horizontal' })` the value axis is on screen-X and the category band on
 * screen-Y, so a shift-drag selects a value RANGE crossed with a BAND SET. This
 * shape -- not `BrushSelection` -- is what `chart.brush()` returns for a
 * horizontal bar. `bands` is the selected category keys; `bandMin` / `bandMax`
 * the inclusive band-index span; `ids` the primary-series row indices inside the
 * selection (`null` when set programmatically via `setBrush`).
 */
export interface HorizontalBarBrushSelection {
    valueMin: number;
    valueMax: number;
    bandMin: number;
    bandMax: number;
    bands: Array<string | number>;
    ids: number[] | null;
}

/**
 * Brush visual style. Defaults: translucent accent fill with a dashed
 * accent outline. Set `lineDash: []` for a solid outline.
 */
export interface BrushStyleConfig {
    /** Fill color for the brush rect. Default 'rgba(99, 102, 241, 0.15)'. */
    fill?: string;
    /** Stroke color for the brush outline. Default 'rgba(99, 102, 241, 0.7)'. */
    stroke?: string;
    /** Stroke dash pattern. Default [4, 4]. Empty array for solid. */
    lineDash?: number[];
    /** Stroke width. Default 1. */
    lineWidth?: number;
}

/**
 * Brush configuration (v1.4.0-alpha.3). Default `false`; setting
 * `brush: true` enables shift+drag-to-select on the chart. Coexists
 * with pan/zoom -- no modifier routes to pan, shift routes to brush.
 */
export interface BrushConfig {
    /** Enable shift+drag brushing. Default false. */
    brush?: boolean;
    /** Visual style for the brush rect overlay. */
    brushStyle?: BrushStyleConfig;
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

/**
 * Annotation pinned to DATA coordinates on an axis-kernel chart
 * (line / area / bar / bubble / scatter). `color` / `fill` accept a literal
 * (hex, rgb(), oklch(), named) or a `--css-var` token resolved against the
 * container. `axis` names the DATA axis; the screen orientation follows the
 * chart (a horizontal bar flips it). Any entry with a non-finite coordinate
 * renders nothing and throws nothing (fail-closed).
 */
export type Annotation =
    /** Rule across the plot at `value` on the named data axis. */
    | { type: 'line'; axis: 'x' | 'y'; value: number; color?: string; dash?: number[]; width?: number; label?: string }
    /** Filled band between `from` and `to` on the named data axis. */
    | { type: 'range'; axis: 'x' | 'y'; from: number; to: number; fill?: string; label?: string }
    /** Marker dot at data point (`x`, `y`). */
    | { type: 'point'; x: number; y: number; color?: string; radius?: number; label?: string }
    /** Text label anchored at data point (`x`, `y`). */
    | { type: 'text'; x: number; y: number; text: string; color?: string; anchor?: 'start' | 'middle' | 'end' };

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

/**
 * Options handed to a `LegendVirtualizer` factory, allocated ONCE per mount.
 * The adapter owns row creation/position/height; `renderRow` (supplied here)
 * writes the row's contents.
 */
export interface LegendVirtualizerOpts {
    /** Total series count (>= 0); equals the normalized series length. */
    count: number;
    /** Fixed row height in CSS px (> 0 integer). */
    itemHeight: number;
    /** Viewport height in CSS px (> 0 integer). */
    height: number;
    /** Extra rows rendered beyond the viewport on each edge (>= 0 integer). */
    overscan: number;
    /**
     * Bind (or re-bind) a pooled row element to a series index. Synchronous,
     * void, allocation-free after the first bind of each element. MAY be called
     * on an element previously bound to a different index (recycle): it re-reads
     * both the series color and visibility on every call.
     */
    renderRow: (rowEl: HTMLElement, idx: number) => void;
}

/** Handle returned by a `LegendVirtualizer`. `dispose()` is called on unmount. */
export interface LegendVirtualHandle {
    dispose: () => void;
}

/**
 * User-supplied windowing adapter for a very tall legend. lite-charts NEVER
 * imports a windowing library; you pass the factory. It receives the scroll
 * host and the options above, and must return a `{ dispose }` handle (else
 * mount throws). Requires `position: 'left' | 'right'` and a numeric
 * `legend.height`.
 */
export type LegendVirtualizer = (
    host: HTMLElement,
    opts: LegendVirtualizerOpts,
) => LegendVirtualHandle;

export interface LegendConfig {
    position?: LegendPosition;
    /**
     * Append the legend into an existing element instead of auto-wrapping
     * the canvas. Useful for custom layouts where canvas and legend live
     * in different DOM trees.
     */
    container?: HTMLElement;
    /**
     * Opt-in legend virtualization (v1.12.0). A factory that windows the row
     * list, so a legend with hundreds of series keeps only a bounded set of
     * rows in layout. `false` (or absent) uses the eager path. Requires
     * `position: 'left' | 'right'` and a numeric `height`. All invalid config
     * throws at construction.
     */
    virtualize?: LegendVirtualizer | false;
    /** Scroll-viewport height in CSS px. REQUIRED when `virtualize` is set. */
    height?: number;
    /** Fixed row height in CSS px. Default 28. Only used when virtualized. */
    itemHeight?: number;
    /** Rows rendered beyond each viewport edge. Default 2. Only used when virtualized. */
    overscan?: number;
}

/** Minimal signal shape (lite-signal). Read = `sig()`, write = `sig.set(v)`. */
export interface Signal<T> {
    (): T;
    peek(): T;
    set(v: T): void;
    update(fn: (v: T) => T): void;
}

export interface LineChartConfig extends PanZoomConfig, BrushConfig {
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

    /**
     * Annotations pinned to data coordinates: lines, ranges, points, text.
     * A static array or a `() => Annotation[]` thunk (re-runs reactively when
     * the signals it reads change). Omit for none.
     */
    annotations?: Annotation[] | (() => Annotation[]);

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
    /**
     * Dispose effects and remove the owned canvas. Construction-time signals
     * (auto-size, plot bounds, crosshair version, series visibility) survive
     * so the chart can be remounted. Idempotent.
     */
    unmount(): void;
    /**
     * Terminal teardown (v1.2.0). Calls `unmount()` first if mounted, then
     * disposes every signal lite-charts created at construction time so
     * their `lite-signal` arena slots are freed. Use this for apps that
     * create and destroy many charts dynamically (dashboard tabs, design
     * builders) where the ~4-node residue from `unmount()` alone would
     * accumulate. Subsequent `mount()` calls will fail; subsequent
     * `destroy()` calls are no-ops.
     */
    destroy(): void;
    /** Returns a data URL via canvas.toDataURL. Requires a real HTMLCanvasElement. */
    exportPNG(opts?: PNGExportOptions): string;
    /**
     * v1.3.0: returns a standalone SVG string of the chart's current
     * frame. Works against the live scene tree -- the chart must be
     * mounted, but the canvas does NOT need to be a real
     * HTMLCanvasElement (mock canvases work too, since SVG export
     * doesn't read pixel data). The output is a complete `<svg>...
     * </svg>` document with `xmlns`, `viewBox`, `width`, `height`
     * attributes -- droppable into any HTML page, PDF, or static
     * asset pipeline.
     */
    exportSVG(opts?: SVGExportOptions): string;
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
    /**
     * View signal (v1.4.0-alpha.2). Read returns the currently-set view
     * or `null` (view follows the data domain). `.peek()` reads without
     * subscribing, `.set(v)` writes (null clears), `.reset()` clears.
     * Shape `{ xMin, xMax, yMin, yMax }` is intentionally symmetric with
     * `lite-camera-max`'s camera signal so the same value drops into a
     * lite-gl `project()` function unchanged when the lite-charts-gl
     * companion package lands. Any field may be `null` to fall back to
     * the data-derived domain on that axis. Set/reset throw if neither
     * `pan` nor `zoom` was enabled at construction.
     */
    readonly view: (() => View | null) & {
        peek(): View | null;
        set(v: View | null): void;
        reset(): void;
    };
    /** Alias for `chart.view.set(v)`. Throws if pan/zoom not enabled. */
    readonly setView: (v: View | null) => void;
    /** Alias for `chart.view.reset()`. Throws if pan/zoom not enabled. */
    readonly resetView: () => void;
    /**
     * Brush facade (v1.4.0-alpha.3). `chart.brush()` reads (tracked),
     * `.peek()` reads untracked, `.set(v)` writes, `.clear()` clears.
     * `chart.setBrush(v)` and `chart.clearBrush()` are imperative
     * aliases. Set/clear throw if `brush: true` was not in config.
     * Programmatic `setBrush()` does NOT recompute ids -- pass `ids`
     * yourself if you want them; gesture-driven brushes always
     * populate ids from the primary series.
     *
     * A horizontal bar chart (`orientation: 'horizontal'`) uses the
     * `HorizontalBarBrushSelection` shape instead of `BrushSelection` (v1.9.0).
     */
    readonly brush: (() => BrushSelection | HorizontalBarBrushSelection | null) & {
        peek(): BrushSelection | HorizontalBarBrushSelection | null;
        set(v: BrushSelection | HorizontalBarBrushSelection | null): void;
        clear(): void;
    };
    /** Alias for `chart.brush.set(v)`. Throws if `brush: true` not in config. */
    readonly setBrush: (v: BrushSelection | HorizontalBarBrushSelection | null) => void;
    /** Alias for `chart.brush.clear()`. Throws if `brush: true` not in config. */
    readonly clearBrush: () => void;
    /** One signal per series. Read in a reactive context to bind external UI; write to toggle. */
    readonly seriesVisibility: Signal<boolean>[];
    /** The legend DOM element, or null if legend was disabled / mounted into a bare canvas. */
    readonly legend: HTMLElement | null;
}

export function createLineChart(config: LineChartConfig): Chart;

// ---------------------------------------------------------------------------
// Time-series line chart (v1.10.0)
// ---------------------------------------------------------------------------
//
// createTimeLineChart is createLineChart with three time-first defaults baked
// in: (1) xScale.type is forced to 'time' regardless of the x key or data probe
// (inferXScaleType only infers time for a Date probe or a {time,date,t} key with
// value >= 1e11); (2) panBounds defaults to 'data', so the reachable view equals
// the data domain; (3) an optional `shading` config wraps the chart's annotations
// with cold-generated weekend range bands. The bands ride the v1.7.0 annotation
// layer unchanged (plain {type:'range',axis:'x'} rows), so there is zero
// per-frame draw cost; the band set is derived from the DATA extent (epoch ms,
// UTC), not the live scale, so it regenerates on data change but not per frame.
// The chart stays timezone-agnostic. v1.11.0 adds an optional market-hours
// session calendar (shading.sessions): supply trading windows and the chart
// shades the NON-trading time (the complement of the open-interval union), so
// weekends and after-hours merge into one band per gap. See SessionSpec.

/**
 * One market-trading window, in UTC minutes-from-midnight. The chart shades the
 * complement (non-trading time), so you describe when the market is OPEN.
 */
export interface SessionSpec {
    /** Session open, UTC minutes from midnight. Integer 0..1439. */
    openMinutes: number;
    /**
     * Session close, UTC minutes from midnight. Integer 1..1440, MUST be greater
     * than openMinutes. Overnight sessions (close < open) are not supported in
     * v1.11.0 and throw at construction.
     */
    closeMinutes: number;
    /**
     * UTC weekdays the session runs (0=Sun .. 6=Sat). Non-empty, integers 0..6.
     * Default [1,2,3,4,5] (Mon-Fri).
     */
    days?: number[];
}

export interface TimeShadingConfig {
    /**
     * Fill for the weekend bands. Any Canvas2D fillStyle string; a CSS custom
     * property (var(--x)) resolves via the theme like other chart colors.
     * Default 'rgba(0,0,0,0.05)'.
     */
    fill?: string;
    /**
     * v1.11.0 -- market-hours session calendar. When present, the chart shades
     * the NON-trading time (the complement of the union of these windows) instead
     * of weekends: after-hours and weekends merge into one band per gap, and any
     * day matched by no session is fully shaded. Sessions are validated at
     * construction (integer minutes, close > open, days 0..6); junk throws.
     */
    sessions?: SessionSpec[];
    /**
     * v1.11.0 -- fill for the non-trading (session) bands. Defaults to `fill` (or
     * the weekend default when neither is set). Any Canvas2D fillStyle string.
     */
    sessionFill?: string;
}

export interface TimeLineChartConfig extends LineChartConfig {
    /**
     * createTimeLineChart forces a time x-scale. `type` must be omitted or
     * 'time'; an explicit conflicting type throws at construction (v1.11.0).
     */
    xScale?: Omit<XScaleConfig, 'type'> & { type?: 'time' };
    /**
     * Weekend background shading. Opt-in: omit (or pass `false`, which behaves
     * identically) for a plain time line at zero added cost. `true` or
     * 'weekends' shades every Sat 00:00 -> Mon 00:00 UTC span within the data
     * domain with the default fill; an object overrides the fill. Supply
     * `sessions` (v1.11.0) for a market-hours calendar that shades non-trading
     * time instead. Bands compose with any `annotations` you supply (bands first).
     */
    shading?: boolean | 'weekends' | TimeShadingConfig;
}

export function createTimeLineChart(config: TimeLineChartConfig): Chart;

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
    /**
     * v1.5.0: bar orientation. `'vertical'` (default) draws category bands
     * along X with bars growing up/down from the value baseline. `'horizontal'`
     * draws category bands along Y (category 0 at the TOP) with bars growing
     * left/right from the value baseline; the value axis moves to the bottom
     * and category labels to the left.
     *
     * v1.8.0: horizontal now supports `pan`, `zoom`, and `grid` -- the linear
     * pan/zoom kernels are remapped at each gesture boundary and grid emits
     * vertical value rules. Under horizontal the value axis is Y, so
     * `view.yMin`/`view.yMax` address the VALUE axis (x holds the band domain
     * and pans/zooms as an identity). Combining horizontal with `brush` or a
     * log `yScale` still throws at construction (those still assume the
     * standard axis roles). When horizontal, the reactive
     * `crosshair().snapPixelX` holds the BAND-axis pixel (a Y coordinate),
     * consistent with the vertical convention that snapPixelX is always the
     * category-axis pixel.
     */
    orientation?: 'vertical' | 'horizontal';
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

export interface BubbleChartConfig extends PanZoomConfig, BrushConfig {
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
    yScale?: { type?: 'linear' | 'log'; domain?: [number, number]; nice?: boolean; zero?: boolean };

    grid?: boolean | { x?: boolean; y?: boolean; color?: string };

    /** Annotations pinned to data coordinates. See {@link Annotation}. */
    annotations?: Annotation[] | (() => Annotation[]);

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

    legend?: boolean | LegendPosition | LegendConfig;

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

    legend?: boolean | LegendPosition | LegendConfig;

    dpr?: number;
    schedule?: (cb: () => void) => unknown;
}

export interface RadarChart {
    mount(target: HTMLElement | HTMLCanvasElement): RadarChart;
    unmount(): void;
    destroy(): void;
    exportPNG(opts?: { mimeType?: string; quality?: number }): string;
    exportSVG(opts?: SVGExportOptions): string;
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

    legend?: boolean | LegendPosition | LegendConfig;

    dpr?: number;
    schedule?: (cb: () => void) => unknown;
}

/** Slice state passed to a `centerLabel.format` callback. */
export interface CenterLabelState {
    /** Sum of ALL slice values (visible + hidden). */
    total: number;
    /** Sum of VISIBLE slice values -- what the default label shows. */
    visibleTotal: number;
    /** Per-slice values, parallel to `labels` / `colors`. */
    values: Float32Array;
    labels: string[];
    colors: string[];
    /** Per-slice visibility (driven by legend toggles). */
    visible: boolean[];
}

/**
 * v1.5.0: donut center label. A number rendered in the donut hole as a
 * `pointer-events:none` DOM overlay (NOT canvas text), so its font resizes
 * itself: the font-size is fixed to
 * `clamp(minFontSize, hole-radius / digit-count, maxFontSize)` and the chart
 * writes those custom properties on data/resize only. More digits shrink the
 * number; there is no per-frame JS and no `measureText`.
 *
 * Fail-closed: passing `centerLabel` to a chart with no hole (a pie, or a
 * resolved `innerRadius` of 0) throws at construction, as does
 * `minFontSize > maxFontSize`. `exportSVG()` emits an equivalent centered
 * `<text>`; `exportPNG` does NOT include the overlay.
 */
export interface CenterLabelConfig {
    /** The main text. String for static, `() => string` / signal for reactive. */
    text?: string | (() => string);
    /**
     * Derive the label from slice state. Defaults to the total of visible
     * slices (used when `centerLabel: true`). Ignored when `text` is set.
     */
    format?: (state: CenterLabelState) => string;
    /** Smaller line beneath the number. String or reactive accessor. */
    subLabel?: string | (() => string);
    /** Text color (hex, or a CSS-var token resolved against the container). */
    color?: string;
    font?: string;
    /** clamp() floor / cap in px. `minFontSize > maxFontSize` throws. */
    minFontSize?: number;
    maxFontSize?: number;
}

/** createDonutChart accepts the same config as createPieChart, with a 0.5
 *  innerRadius default instead of 0 (overridable), plus the v1.5.0
 *  `centerLabel`. `centerLabel` on a pie (no hole) throws at construction. */
export interface DonutChartConfig extends PieChartConfig {
    /**
     * v1.5.0: a number in the donut hole. `true` shows the total of visible
     * slices; a string / accessor is shorthand for `{ text }`; the object form
     * gives full control. Requires a hole -- throws on `innerRadius` 0.
     */
    centerLabel?: boolean | string | (() => string) | CenterLabelConfig;
}

export interface PolarChart {
    mount(target: HTMLElement | HTMLCanvasElement): PolarChart;
    unmount(): void;
    destroy(): void;
    exportPNG(opts?: { mimeType?: string; quality?: number }): string;
    exportSVG(opts?: SVGExportOptions): string;
    redraw(): void;
    moveCrosshair(canvasX: number, canvasY: number): void;
    hideCrosshair(): void;
    setSliceVisible(idx: number, visible: boolean): void;
    refreshTheme(): void;
    readonly scene: unknown;
    readonly canvas: HTMLCanvasElement | null;
    readonly geometry: { cx: number; cy: number; rOuter: number; rInner: number };
    readonly legend: HTMLElement | null;
    /** v1.5.0: the donut center-label overlay element, or null when not configured. */
    readonly centerLabel: HTMLElement | null;
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

export interface ScatterChartConfig extends PanZoomConfig, BrushConfig {
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
    yScale?: { type?: 'linear' | 'log'; domain?: [number, number]; nice?: boolean; zero?: boolean };

    grid?: boolean | { x?: boolean; y?: boolean; color?: string };
    /** Annotations pinned to data coordinates. See {@link Annotation}. */
    annotations?: Annotation[] | (() => Annotation[]);
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
     * v1.2.0: how `colors` is sampled.
     * - `'linear'` (default): continuous interpolation between low and high.
     * - `'quantile'`: split present values into `colorBins` equally-sized
     *   bins by rank; each bin gets one discrete color. Use this when a
     *   few outliers would otherwise wash the rest of the chart toward
     *   the low end of the ramp.
     */
    colorScale?: 'linear' | 'quantile';

    /**
     * v1.2.0: bin count for `colorScale: 'quantile'`. Default 5; clamped
     * to [2, 20]. Ignored when `colorScale` is `'linear'` or when
     * `colorFn` is set.
     */
    colorBins?: number;

    /**
     * Custom color function. Receives `(value, vMin, vMax)`; returns a CSS
     * color string. Overrides BOTH the linear and quantile defaults
     * entirely. Use this for OKLCH ramps, custom binning, diverging
     * schemes, etc.
     */
    colorFn?: (value: number, vMin: number, vMax: number) => string;

    /** Render the numeric value inside each cell. Default false. */
    showValues?: boolean;
    /** Format the cell value when `showValues` is true. */
    valueFormat?: (value: number, xi: number, yi: number) => string;
    /** Font for in-cell value labels. */
    valueLabelFont?: string;
    /**
     * Color for in-cell value labels. Default `'auto'` (v1.2.0) which
     * picks `'#000000'` or `'#ffffff'` per cell from the cell's
     * background luminance so labels stay readable across the ramp.
     * Any explicit CSS color disables the auto pick chart-wide.
     */
    valueLabelColor?: string | 'auto';

    /**
     * Fraction of band-width used as the gap between adjacent cells.
     * Default 0.04 (4%); set to 0 for a continuous grid.
     */
    cellGap?: number;

    /** Stroke color for the hovered cell highlight. Default '#111111'. */
    highlightStroke?: string;
    /** Stroke width for the hovered cell highlight in pixels. Default 2. */
    highlightStrokeWidth?: number;

    /**
     * v1.2.0: highlight the hovered cell's full row with a translucent
     * stripe. Default true.
     */
    rowHighlight?: boolean;
    /**
     * v1.2.0: highlight the hovered cell's full column with a translucent
     * stripe. Default true.
     */
    columnHighlight?: boolean;
    /**
     * v1.2.0: fill color for the row + column highlight stripes.
     * Default `'rgba(0,0,0,0.10)'`. CSS-vars are resolved at mount.
     */
    rowColumnHighlightFill?: string;

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
