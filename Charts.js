/**
 * @zakkster/lite-charts -- Reactive, zero-GC charts built on lite-scene.
 *
 * v1.4.0 ships nine chart types on four independent kernels
 * (line/area/bar/bubble/scatter, pie/donut, radar, heatmap) plus three
 * interaction primitives on the axis kernel (log scale, pan + zoom,
 * brushing) and SVG export on every chart. See CHANGELOG.md for the
 * full release history.
 *
 * Author:  Zahary Shinikchiev <shinikchiev@yahoo.com>
 * License: MIT
 */

import {
    signal,
    computed,
    effect,
    untrack,
    onCleanup,
    dispose,
} from '@zakkster/lite-signal';
import {
    createScene,
    group,
    line as lineNode,
    text as textNode,
    path as pathNode,
} from '@zakkster/lite-scene';
import {
    linearTicks,
    logTicks,
    timeTicks,
    thinLabels,
    formatNumber,
    formatTime,
    TIME_UNIT,
} from '@zakkster/lite-axis';

// ---------------------------------------------------------------------------
// Static-or-signal helpers
// ---------------------------------------------------------------------------

/** Wrap a static value as a constant accessor; pass functions through. */
const asAccessor = (x) => (typeof x === 'function' ? x : () => x);

// ---------------------------------------------------------------------------
// Color resolution
// ---------------------------------------------------------------------------
//
// Accepts:
//   * hex / rgb() / rgba() / hsl() / oklch() / named color   -> passthrough
//   * '--my-token'                                            -> reads getComputedStyle(container)
//   * anything else                                           -> '#888' fallback
//
// Reading CSS custom properties on the container at mount-time is the only
// DOM dependency in the color path; in headless tests (no `container`,
// no `getComputedStyle`) we fall back to '#888' so render code never throws.

const resolveColor = (spec, container) => {
    if (typeof spec !== 'string' || spec.length === 0) return '#888';
    if (spec.charCodeAt(0) === 45 && spec.charCodeAt(1) === 45) {
        if (container && typeof getComputedStyle === 'function') {
            const v = getComputedStyle(container).getPropertyValue(spec).trim();
            return v.length > 0 ? v : '#888';
        }
        return '#888';
    }
    return spec;
};

// ---------------------------------------------------------------------------
// Float32 slab allocator
// ---------------------------------------------------------------------------

const nextPow2 = (n) => {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
};

/**
 * Ensure `arr` has length >= needed. Grow by power-of-two doubling and
 * preserve existing content. Returns the (possibly new) array.
 */
const ensureFloat32 = (arr, needed) => {
    if (arr && arr.length >= needed) return arr;
    const cap = nextPow2(needed > 0 ? needed : 1);
    const next = new Float32Array(cap);
    if (arr) next.set(arr.subarray(0, Math.min(arr.length, cap)));
    return next;
};

const ensureUint8 = (arr, needed) => {
    if (arr && arr.length >= needed) return arr;
    return new Uint8Array(nextPow2(needed > 0 ? needed : 1));
};

// ---------------------------------------------------------------------------
// Decimation kernel
// ---------------------------------------------------------------------------
//
// Lifted from @zakkster/lite-canvas-graph. Per-column min/max envelope; when
// the number of samples within the plot rect exceeds 2x the column count,
// we collapse each column to its [yMin, yMax] extents. Preserves spike
// visibility that naive subsampling would lose. Assumes pixel-x is already
// sorted ascending (the line-chart invariant).

/**
 * Decimate to per-column [min, max] envelope.
 *
 * @param {Float32Array} pxs    pixel-x for each sample (sorted ascending)
 * @param {Float32Array} pys    pixel-y for each sample
 * @param {number}       n      number of samples to consider
 * @param {number}       colL   leftmost pixel column (inclusive)
 * @param {number}       colR   rightmost pixel column (inclusive)
 * @param {Float32Array} outMin length >= (colR - colL + 1); per-column yMin
 * @param {Float32Array} outMax length >= (colR - colL + 1); per-column yMax
 * @param {Uint8Array}   outOcc length >= (colR - colL + 1); 1=column has data
 * @returns {number} columns processed (colR - colL + 1)
 */
const decimateMinMax = (pxs, pys, n, colL, colR, outMin, outMax, outOcc) => {
    const cols = (colR - colL + 1) | 0;
    for (let c = 0; c < cols; c++) outOcc[c] = 0;
    for (let i = 0; i < n; i++) {
        const x = pxs[i];
        if (x < colL || x > colR) continue;
        const c = (x - colL) | 0;
        const y = pys[i];
        if (outOcc[c] === 0) {
            outMin[c] = y;
            outMax[c] = y;
            outOcc[c] = 1;
        } else {
            if (y < outMin[c]) outMin[c] = y;
            if (y > outMax[c]) outMax[c] = y;
        }
    }
    return cols;
};

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

const buildAccessor = (a) => {
    if (typeof a === 'function') return a;
    if (typeof a === 'string') {
        const key = a;
        return (row) => {
            const v = row[key];
            if (v instanceof Date) return v.getTime();
            return +v;
        };
    }
    if (typeof a === 'number') {
        const idx = a;
        return (row) => {
            const v = row[idx];
            if (v instanceof Date) return v.getTime();
            return +v;
        };
    }
    throw new Error('lite-charts: accessor must be a string key, integer index, or function');
};

// Raw accessor that returns the original value WITHOUT numeric coercion.
// Used by bar charts where x is categorical (string or arbitrary key) --
// `+row.x` would map 'Jan' to NaN, collapsing every category to a single
// 'NaN' bucket. For numeric categories (1, 2, 3) this still works since
// they round-trip through String() cleanly.
const buildRawAccessor = (a) => {
    if (typeof a === 'function') return a;
    if (typeof a === 'string') {
        const key = a;
        return (row) => row[key];
    }
    if (typeof a === 'number') {
        const idx = a;
        return (row) => row[idx];
    }
    throw new Error('lite-charts: accessor must be a string key, integer index, or function');
};

// ---------------------------------------------------------------------------
// Scales (linear; time is linear over ms)
// ---------------------------------------------------------------------------
//
// Each scale is a plain object whose fields are mutated in place to avoid
// allocation churn. Caller-supplied data updates trigger `updateLinearScale`
// which recomputes slope/intercept and bumps the chart's `scaleVersion`
// signal -- downstream axis + render effects re-fire.

const makeLinearScale = (type) => ({
    type: type || 'linear',
    dMin: 0,
    dMax: 1,
    rMin: 0,
    rMax: 1,
    _slope: 1,
    _intercept: 0,
    _invSlope: 1,
    map(v) {
        return v * this._slope + this._intercept;
    },
    invert(px) {
        return (px - this._intercept) * this._invSlope;
    },
});

const updateLinearScale = (s, dMin, dMax, rMin, rMax) => {
    s.dMin = dMin;
    s.dMax = dMax;
    s.rMin = rMin;
    s.rMax = rMax;
    const dRange = dMax - dMin;
    s._slope = dRange !== 0 ? (rMax - rMin) / dRange : 0;
    s._intercept = rMin - dMin * s._slope;
    s._invSlope = s._slope !== 0 ? 1 / s._slope : 0;
    return s;
};

// ---------------------------------------------------------------------------
// Log scale (v1.4.0-alpha.0)
// ---------------------------------------------------------------------------
//
// Base-10 logarithmic mapping. Same shape as the linear scale (dMin/dMax,
// rMin/rMax, cached _slope/_intercept/_invSlope) but `map` does
// `log(v) * slope + intercept` and `invert` does `exp(...)`.
//
// Non-positive values:
//   - `map(v)` returns NaN for v <= 0. Draw fns are expected to skip
//     NaN positions (line/area break the segment; markers skip).
//   - `updateLogScale` clamps `dMin` to a tiny epsilon (1e-10) if a
//     non-positive bound is passed -- a safety net so a degenerate
//     domain doesn't bring the whole chart down. Callers should
//     ideally filter non-positive values from the extracted domain
//     before getting here.
//
// Bench note: `Math.log` is ~3-5 ns per call on modern V8. The current
// tick-pixel loop runs maybe 12 ticks per axis at sub-1 Hz update rate
// (resize / data change), so the log path adds negligible cost
// compared to the linear inlined-multiply path.

const makeLogScale = () => ({
    type: 'log',
    dMin: 1,
    dMax: 10,
    rMin: 0,
    rMax: 1,
    _slope: 1,
    _intercept: 0,
    _invSlope: 1,
    _logDMin: 0,
    _logDMax: Math.log(10),
    map(v) {
        // v <= 0: outside the domain of log; return NaN so draw code can
        // break/skip. Math.log(0) is -Infinity which would propagate to
        // -Infinity * slope = NaN anyway, but explicit is clearer.
        if (v <= 0) return NaN;
        return Math.log(v) * this._slope + this._intercept;
    },
    invert(px) {
        return Math.exp((px - this._intercept) * this._invSlope);
    },
});

const updateLogScale = (s, dMin, dMax, rMin, rMax) => {
    // v1.4.1 (C0 / LC-04): fail CLOSED on an invalid domain. alpha.0 silently
    // substituted `dMin = 1e-10` (and `dMax = dMin*10`), so a computed
    // non-positive domain rendered a DIFFERENT axis rather than reporting the
    // problem -- a fail-open on unverified state the package's own laws forbid.
    // A log domain must be finite, strictly positive, and ordered; anything else
    // is a bug at the caller, which now must clamp/filter BEFORE calling (the
    // extraction path does exactly that for a log axis). The message names the
    // offending bound and its value.
    if (!(dMin > 0)) {
        throw new Error('lite-charts: log scale needs a positive domain minimum, got dMin=' + dMin);
    }
    if (!(dMax > 0)) {
        throw new Error('lite-charts: log scale needs a positive domain maximum, got dMax=' + dMax);
    }
    if (!(dMax > dMin)) {
        throw new Error('lite-charts: log scale needs dMax > dMin, got dMin=' + dMin + ' dMax=' + dMax);
    }
    s.dMin = dMin;
    s.dMax = dMax;
    s.rMin = rMin;
    s.rMax = rMax;
    const logMin = Math.log(dMin);
    const logMax = Math.log(dMax);
    s._logDMin = logMin;
    s._logDMax = logMax;
    const logRange = logMax - logMin;
    s._slope = logRange !== 0 ? (rMax - rMin) / logRange : 0;
    s._intercept = rMin - logMin * s._slope;
    s._invSlope = s._slope !== 0 ? 1 / s._slope : 0;
    return s;
};

// ---------------------------------------------------------------------------
// Band scale (v1.1.0 -- for bar charts)
// ---------------------------------------------------------------------------
//
// Maps an integer category index in [0, n) to a pixel band within a pixel
// range. Follows d3-scaleBand conventions: `paddingInner` is the fraction of
// step taken up by the gap BETWEEN bands, `paddingOuter` is the fraction at
// each END of the range. Both default to small positive values so bars don't
// touch each other or the axis spine.
//
//   step      = range / (n - paddingInner + paddingOuter * 2)
//   bandWidth = step * (1 - paddingInner)
//   leftEdge(i) = rMin + step * paddingOuter + step * i
//   center(i)   = leftEdge(i) + bandWidth / 2
//
// `invert(px)` returns the nearest category index (clamped to [0, n-1]),
// the discrete equivalent of bisectNearest -- it's what makes hit detection
// for bar charts O(1) instead of O(log n).

const makeBandScale = () => ({
    type: 'band',
    n: 0,
    rMin: 0,
    rMax: 1,
    step: 1,
    bandWidth: 1,
    paddingInner: 0,
    paddingOuter: 0,
    _origin: 0,
    _halfBand: 0.5,
    map(i) {
        // Returns CENTER pixel of band i.
        return this._origin + this.step * i + this._halfBand;
    },
    leftEdge(i) {
        return this._origin + this.step * i;
    },
    invert(px) {
        // Floor-division hit detection: which category does this pixel
        // belong to? Pixels in the gap between bands snap to the nearer.
        if (this.n === 0) return -1;
        if (this.step <= 0) return 0;
        const idx = Math.floor((px - this._origin) / this.step);
        if (idx < 0) return 0;
        if (idx >= this.n) return this.n - 1;
        return idx;
    },
});

const updateBandScale = (s, n, rMin, rMax, paddingInner, paddingOuter) => {
    s.n = n;
    s.rMin = rMin;
    s.rMax = rMax;
    s.paddingInner = paddingInner;
    s.paddingOuter = paddingOuter;
    const range = rMax - rMin;
    const divisor = Math.max(1, n - paddingInner + paddingOuter * 2);
    s.step = range / divisor;
    s.bandWidth = s.step * (1 - paddingInner);
    s._origin = rMin + s.step * paddingOuter;
    s._halfBand = s.bandWidth / 2;
    return s;
};

// ---------------------------------------------------------------------------
// Binary search for nearest sample
// ---------------------------------------------------------------------------
//
// Used by the crosshair / tooltip path. Line-chart invariant guarantees xs
// is sorted ascending, so we use a standard log-N bisect.

/**
 * Return the index of the sample in xs[0..n) whose value is nearest to
 * `target`. n=0 returns -1. Ties go to the lower index.
 *
 * @param {Float32Array} xs   sorted ascending
 * @param {number}       n    valid sample count (<= xs.length)
 * @param {number}       target
 * @returns {number}
 */
const bisectNearest = (xs, n, target) => {
    if (n === 0) return -1;
    if (n === 1) return 0;
    if (target <= xs[0]) return 0;
    if (target >= xs[n - 1]) return n - 1;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (xs[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    // `lo` is the lowest index with xs[lo] >= target. Compare with lo-1.
    if (lo === 0) return 0;
    if (lo >= n) return n - 1;
    const d1 = target - xs[lo - 1];
    const d2 = xs[lo] - target;
    return d1 <= d2 ? lo - 1 : lo;
};

// ---------------------------------------------------------------------------
// Series state -- one per series, mutated in place
// ---------------------------------------------------------------------------

const createSeriesState = () => ({
    xs: null, // domain xs (Float32Array)
    ys: null, // domain ys
    n: 0,
    pxs: null, // pixel xs (after scale)
    pys: null,
    decMin: null, // per-column decimation buffers
    decMax: null,
    decOcc: null,
    tangents: null, // lazy-alloc for monotone interpolation
    domainXMin: 0,
    domainXMax: 1,
    domainYMin: 0,
    domainYMax: 1,
});

/**
 * Extract data from accessor result into series-state SoA buffers and
 * compute per-series domain extents. Returns true (callers ignore; reserved
 * for future "no-change" short-circuit).
 *
 * Accepts either:
 *   - { xs: Float32Array, ys: Float32Array }  (zero-copy SoA fast path)
 *   - Array<Row>                              (AoS extraction via accessors)
 */
const extractSeriesData = (state, data, xAccessor, yAccessor) => {
    if (data && data.xs && data.ys && typeof data.xs.length === 'number') {
        state.xs = data.xs;
        state.ys = data.ys;
        state.n = Math.min(data.xs.length, data.ys.length);
    } else if (Array.isArray(data)) {
        const n = data.length;
        state.xs = ensureFloat32(state.xs, n);
        state.ys = ensureFloat32(state.ys, n);
        state.n = n;
        const xs = state.xs;
        const ys = state.ys;
        for (let i = 0; i < n; i++) {
            xs[i] = xAccessor(data[i], i);
            ys[i] = yAccessor(data[i], i);
        }
    } else {
        state.n = 0;
    }

    const n = state.n;
    if (n === 0) {
        state.domainXMin = 0;
        state.domainXMax = 1;
        state.domainYMin = 0;
        state.domainYMax = 1;
        return true;
    }
    const xs = state.xs;
    const ys = state.ys;
    let xMin = xs[0];
    let xMax = xs[0];
    let yMin = ys[0];
    let yMax = ys[0];
    for (let i = 1; i < n; i++) {
        const xv = xs[i];
        const yv = ys[i];
        if (xv < xMin) xMin = xv;
        else if (xv > xMax) xMax = xv;
        if (yv < yMin) yMin = yv;
        else if (yv > yMax) yMax = yv;
    }
    state.domainXMin = xMin;
    state.domainXMax = xMax;
    state.domainYMin = yMin;
    state.domainYMax = yMax;
    return true;
};

/**
 * Bar-chart data extraction. Treats x as a category identifier (string or
 * stringified-number), looking it up in the shared `categories` array (or
 * appending). state.xs ends up as Float32Array of category indices, state.ys
 * as the values. domainYMin/Max include 0 by convention so bars don't float.
 *
 * @param {Object}   state
 * @param {any}      data         array of {x, y} or SoA {xs, ys}
 * @param {Function} xAccessor
 * @param {Function} yAccessor
 * @param {string[]} categories   shared, mutable; new categories appended
 */
const extractBarSeriesData = (state, data, xAccessor, yAccessor, categories) => {
    let n;
    let getX;
    let getY;
    if (data && data.xs && data.ys && typeof data.xs.length === 'number') {
        n = Math.min(data.xs.length, data.ys.length);
        getX = (i) => data.xs[i];
        getY = (i) => data.ys[i];
    } else if (Array.isArray(data)) {
        n = data.length;
        getX = (i) => xAccessor(data[i], i);
        getY = (i) => yAccessor(data[i], i);
    } else {
        state.n = 0;
        state.domainXMin = 0;
        state.domainXMax = 1;
        state.domainYMin = 0;
        state.domainYMax = 1;
        return true;
    }

    state.xs = ensureFloat32(state.xs, n);
    state.ys = ensureFloat32(state.ys, n);
    state.n = n;

    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < n; i++) {
        const rawX = getX(i);
        const v = getY(i);
        const catName = rawX == null ? '' : String(rawX);
        let idx = -1;
        // Linear scan -- categories arrays are small (typically < 30). A
        // hash map adds setup cost that beats scan only beyond ~1000.
        for (let c = 0; c < categories.length; c++) {
            if (categories[c] === catName) { idx = c; break; }
        }
        if (idx < 0) {
            idx = categories.length;
            categories.push(catName);
        }
        state.xs[i] = idx;
        state.ys[i] = v;
        if (v === v) {
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
        }
    }
    state.domainXMin = 0;
    state.domainXMax = Math.max(0, categories.length - 1);
    state.domainYMin = yMin === Infinity ? 0 : yMin;
    state.domainYMax = yMax === -Infinity ? 1 : yMax;
    return true;
};

/**
 * Re-project domain xs/ys into pixel space using the current scales.
 * Log-aware for BOTH axes: the scale kind is hoisted ONCE and one of four
 * flat loops is picked by a cold if/else, so there is no per-iteration type
 * test. For a linear scale the body inlines `v * _slope + _intercept`; for a
 * log scale the body is `v > 0 ? Math.log(v) * _slope + _intercept : NaN`
 * (the `_slope`/`_intercept` are already log-space, and a non-positive sample
 * emits NaN so the polyline/markers break -- matching `map()` at 255-261).
 * ~3x throughput vs calling .map() on the linear-linear path.
 */
const scaleSeriesToPixels = (state, xScale, yScale) => {
    const n = state.n;
    if (n === 0) return;
    state.pxs = ensureFloat32(state.pxs, n);
    state.pys = ensureFloat32(state.pys, n);
    const xs = state.xs;
    const ys = state.ys;
    const pxs = state.pxs;
    const pys = state.pys;
    const xSlope = xScale._slope;
    const xIntercept = xScale._intercept;
    const ySlope = yScale._slope;
    const yIntercept = yScale._intercept;
    const xLog = xScale.type === 'log';
    const yLog = yScale.type === 'log';
    if (!xLog && !yLog) {
        for (let i = 0; i < n; i++) {
            pxs[i] = xs[i] * xSlope + xIntercept;
            pys[i] = ys[i] * ySlope + yIntercept;
        }
    } else if (xLog && !yLog) {
        for (let i = 0; i < n; i++) {
            const vx = xs[i];
            pxs[i] = vx > 0 ? Math.log(vx) * xSlope + xIntercept : NaN;
            pys[i] = ys[i] * ySlope + yIntercept;
        }
    } else if (!xLog && yLog) {
        for (let i = 0; i < n; i++) {
            pxs[i] = xs[i] * xSlope + xIntercept;
            const vy = ys[i];
            pys[i] = vy > 0 ? Math.log(vy) * ySlope + yIntercept : NaN;
        }
    } else {
        for (let i = 0; i < n; i++) {
            const vx = xs[i];
            const vy = ys[i];
            pxs[i] = vx > 0 ? Math.log(vx) * xSlope + xIntercept : NaN;
            pys[i] = vy > 0 ? Math.log(vy) * ySlope + yIntercept : NaN;
        }
    }
};

// ---------------------------------------------------------------------------
// Path interpolation modes (v1.0.0)
// ---------------------------------------------------------------------------
//
// Direct-path-only. Decimation collapses to per-column min/max envelopes; at
// that density, smoothing the envelope is visually misleading, so the
// decimated branch always renders straight vertical bars regardless of mode.
//
// Smoothing modes (monotone, catmull-rom) assume contiguous data within a
// series. Linear and step modes are NaN-aware (gaps split into independent
// runs) because each segment is independent of its neighbors.

const INTERP_LINEAR = 0;
const INTERP_STEP_AFTER = 1;
const INTERP_STEP_BEFORE = 2;
const INTERP_STEP_MID = 3;
const INTERP_MONOTONE = 4;
const INTERP_CATMULL_ROM = 5;

const _resolveInterpolation = (s) => {
    if (s == null || s === 'linear') return INTERP_LINEAR;
    if (s === 'step' || s === 'step-after') return INTERP_STEP_AFTER;
    if (s === 'step-before') return INTERP_STEP_BEFORE;
    if (s === 'step-mid') return INTERP_STEP_MID;
    if (s === 'monotone') return INTERP_MONOTONE;
    if (s === 'catmull-rom') return INTERP_CATMULL_ROM;
    throw new Error('lite-charts: unknown interpolation mode: ' + s);
};

const _supportsNaNSplit = (mode) =>
    mode === INTERP_LINEAR
    || mode === INTERP_STEP_AFTER
    || mode === INTERP_STEP_BEFORE
    || mode === INTERP_STEP_MID;

// Each tracer assumes ctx is already at (pxs[startIdx], pys[startIdx]) and
// emits segment commands through (pxs[endIdx], pys[endIdx]). They do not
// call beginPath, moveTo for the first point, or stroke -- callers wrap.

const _traceLinear = (ctx, pxs, pys, startIdx, endIdx) => {
    for (let i = startIdx + 1; i <= endIdx; i++) {
        ctx.lineTo(pxs[i], pys[i]);
    }
};

const _traceStepAfter = (ctx, pxs, pys, startIdx, endIdx) => {
    // step-after: hold y_i from x_i to x_{i+1}, then jump to y_{i+1} at x_{i+1}.
    // 2 lineTo per segment.
    for (let i = startIdx; i < endIdx; i++) {
        ctx.lineTo(pxs[i + 1], pys[i]);
        ctx.lineTo(pxs[i + 1], pys[i + 1]);
    }
};

const _traceStepBefore = (ctx, pxs, pys, startIdx, endIdx) => {
    // step-before: jump to y_{i+1} at x_i, then hold until x_{i+1}.
    for (let i = startIdx; i < endIdx; i++) {
        ctx.lineTo(pxs[i], pys[i + 1]);
        ctx.lineTo(pxs[i + 1], pys[i + 1]);
    }
};

const _traceStepMid = (ctx, pxs, pys, startIdx, endIdx) => {
    // step-mid: step at midpoint of x_i and x_{i+1}.
    for (let i = startIdx; i < endIdx; i++) {
        const mx = (pxs[i] + pxs[i + 1]) * 0.5;
        ctx.lineTo(mx, pys[i]);
        ctx.lineTo(mx, pys[i + 1]);
        ctx.lineTo(pxs[i + 1], pys[i + 1]);
    }
};

// Fritsch-Carlson monotone cubic Hermite. Computes tangents into outTan
// such that the resulting cubic Bezier preserves monotonicity of the input
// (no overshoot through a local extremum). Same algorithm as d3-shape's
// monotoneX. Writes outTan[startIdx..endIdx] inclusive.
const _computeMonotoneTangents = (pxs, pys, startIdx, endIdx, outTan) => {
    const n = endIdx - startIdx + 1;
    if (n < 2) return;
    for (let i = startIdx; i <= endIdx; i++) {
        let tan;
        if (i === startIdx) {
            const dx = pxs[i + 1] - pxs[i];
            tan = dx !== 0 ? (pys[i + 1] - pys[i]) / dx : 0;
        } else if (i === endIdx) {
            const dx = pxs[i] - pxs[i - 1];
            tan = dx !== 0 ? (pys[i] - pys[i - 1]) / dx : 0;
        } else {
            const dxL = pxs[i] - pxs[i - 1];
            const dxR = pxs[i + 1] - pxs[i];
            const slopeL = dxL !== 0 ? (pys[i] - pys[i - 1]) / dxL : 0;
            const slopeR = dxR !== 0 ? (pys[i + 1] - pys[i]) / dxR : 0;
            // Fritsch-Carlson: if signs differ (local extremum) or either
            // slope is zero, tangent must be zero to preserve monotonicity.
            const sL = slopeL > 0 ? 1 : (slopeL < 0 ? -1 : 0);
            const sR = slopeR > 0 ? 1 : (slopeR < 0 ? -1 : 0);
            if (sL !== sR || sL === 0) {
                tan = 0;
            } else {
                // Weighted harmonic mean of adjacent slopes.
                const w1 = 2 * dxR + dxL;
                const w2 = dxR + 2 * dxL;
                tan = (w1 + w2) / (w1 / slopeL + w2 / slopeR);
            }
        }
        outTan[i] = tan;
    }
};

const _traceMonotone = (ctx, pxs, pys, startIdx, endIdx, tangents) => {
    for (let i = startIdx; i < endIdx; i++) {
        const dx = pxs[i + 1] - pxs[i];
        const cp1x = pxs[i] + dx / 3;
        const cp1y = pys[i] + dx * tangents[i] / 3;
        const cp2x = pxs[i + 1] - dx / 3;
        const cp2y = pys[i + 1] - dx * tangents[i + 1] / 3;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, pxs[i + 1], pys[i + 1]);
    }
};

// Uniform Catmull-Rom (alpha=0). Centripetal (alpha=0.5) is the d3 default
// for tighter curves with no self-intersection on irregular data; we'll add
// it as an alpha option in v1.1 if anyone hits a uniform-curve overshoot.
const _traceCatmullRom = (ctx, pxs, pys, startIdx, endIdx) => {
    for (let i = startIdx; i < endIdx; i++) {
        // P0..P3 with phantom endpoints replicated.
        const p0x = i > startIdx ? pxs[i - 1] : pxs[i];
        const p0y = i > startIdx ? pys[i - 1] : pys[i];
        const p1x = pxs[i];
        const p1y = pys[i];
        const p2x = pxs[i + 1];
        const p2y = pys[i + 1];
        const p3x = (i + 2) <= endIdx ? pxs[i + 2] : p2x;
        const p3y = (i + 2) <= endIdx ? pys[i + 2] : p2y;
        const cp1x = p1x + (p2x - p0x) / 6;
        const cp1y = p1y + (p2y - p0y) / 6;
        const cp2x = p2x - (p3x - p1x) / 6;
        const cp2y = p2y - (p3y - p1y) / 6;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2x, p2y);
    }
};

const _tracePath = (ctx, pxs, pys, startIdx, endIdx, mode, tangentBuf) => {
    if (startIdx >= endIdx) return;
    switch (mode) {
        case INTERP_LINEAR:
            _traceLinear(ctx, pxs, pys, startIdx, endIdx);
            return;
        case INTERP_STEP_AFTER:
            _traceStepAfter(ctx, pxs, pys, startIdx, endIdx);
            return;
        case INTERP_STEP_BEFORE:
            _traceStepBefore(ctx, pxs, pys, startIdx, endIdx);
            return;
        case INTERP_STEP_MID:
            _traceStepMid(ctx, pxs, pys, startIdx, endIdx);
            return;
        case INTERP_MONOTONE:
            _computeMonotoneTangents(pxs, pys, startIdx, endIdx, tangentBuf);
            _traceMonotone(ctx, pxs, pys, startIdx, endIdx, tangentBuf);
            return;
        case INTERP_CATMULL_ROM:
            _traceCatmullRom(ctx, pxs, pys, startIdx, endIdx);
            return;
    }
};

// ---------------------------------------------------------------------------
// Marker shapes (v1.0.0)
// ---------------------------------------------------------------------------

const SHAPE_CIRCLE = 0;
const SHAPE_SQUARE = 1;
const SHAPE_TRIANGLE = 2;
const SHAPE_DIAMOND = 3;

const _resolveShape = (s) => {
    if (s === 'square') return SHAPE_SQUARE;
    if (s === 'triangle') return SHAPE_TRIANGLE;
    if (s === 'diamond') return SHAPE_DIAMOND;
    return SHAPE_CIRCLE;
};

const _resolveMarkers = (m, defaultColor) => {
    if (m == null || m === false) return null;
    if (m === true) {
        return {
            shape: SHAPE_CIRCLE,
            size: 5,
            fill: defaultColor,
            stroke: '#ffffff',
            strokeWidth: 1,
            everyN: 1,
        };
    }
    return {
        shape: _resolveShape(m.shape),
        size: m.size != null ? m.size : 5,
        fill: m.fill != null ? m.fill : defaultColor,
        stroke: m.stroke != null ? m.stroke : '#ffffff',
        strokeWidth: m.strokeWidth != null ? m.strokeWidth : 1,
        everyN: m.everyN != null ? Math.max(1, m.everyN | 0) : 1,
    };
};

// Draws markers at every Nth sample point. Skipped in decimated mode (would
// be visual noise) and skipped when refs.markersRef.value is null.
const _drawMarkers = (ctx, state, refs, plotBoundsBox) => {
    const opts = refs.markersRef.value;
    if (!opts) return;
    const n = state.n;
    if (n === 0) return;
    const pxs = state.pxs;
    const pys = state.pys;
    const pb = plotBoundsBox;
    const plotL = pb.x;
    const plotR = pb.x + pb.w;
    const plotT = pb.y;
    const plotB = pb.y + pb.h;
    const size = opts.size;
    const half = size * 0.5;
    const shape = opts.shape;
    const everyN = opts.everyN;
    const hasStroke = opts.strokeWidth > 0 && opts.stroke;

    ctx.fillStyle = opts.fill;
    if (hasStroke) {
        ctx.strokeStyle = opts.stroke;
        ctx.lineWidth = opts.strokeWidth;
    }
    for (let i = 0; i < n; i += everyN) {
        const x = pxs[i];
        const y = pys[i];
        if (x !== x || y !== y) continue;
        if (x < plotL - half || x > plotR + half) continue;
        if (y < plotT - half || y > plotB + half) continue;
        ctx.beginPath();
        if (shape === SHAPE_CIRCLE) {
            ctx.arc(x, y, half, 0, _TWO_PI);
        } else if (shape === SHAPE_SQUARE) {
            ctx.rect(x - half, y - half, size, size);
        } else if (shape === SHAPE_TRIANGLE) {
            ctx.moveTo(x, y - half);
            ctx.lineTo(x + half, y + half);
            ctx.lineTo(x - half, y + half);
            ctx.closePath();
        } else if (shape === SHAPE_DIAMOND) {
            ctx.moveTo(x, y - half);
            ctx.lineTo(x + half, y);
            ctx.lineTo(x, y + half);
            ctx.lineTo(x - half, y);
            ctx.closePath();
        }
        ctx.fill();
        if (hasStroke) ctx.stroke();
    }
};

// ---------------------------------------------------------------------------
// Line series draw function (the hot path)
// ---------------------------------------------------------------------------
//
// Returned function is passed as `draw` to a lite-scene `path` node. lite-scene
// invokes it on every dirty redraw with a ctx already saved + transformed for
// the node's local space (node at 0,0 so we draw with absolute pixel coords).
//
// Allocation-free. Reads pixel xs/ys from series state; reads color/lineWidth
// from caller-owned refs (so the draw closure stays static).

const makeLineDrawFn = (state, refs, plotBoundsBox) => (ctx) => {
    if (!refs.visibleRef.value) return;
    const n = state.n;
    if (n < 2) return;
    const pxs = state.pxs;
    const pys = state.pys;
    const pb = plotBoundsBox;
    const plotL = pb.x;
    const plotR = pb.x + pb.w;
    const plotT = pb.y;
    const plotB = pb.y + pb.h;
    const cols = (plotR - plotL + 1) | 0;
    if (cols < 2) return;

    const mode = refs.interpolationRef.value;

    // Clip to plot rect. Without this, lineCap: 'round' and lineWidth > 1
    // produce a ~lineWidth/2 pixel overshoot past plotR (visible at the
    // right edge in dense charts: line ends at xScale.map(lastX) = plotR
    // exactly, but the rounded cap extends past it). Interp control
    // points and decimation per-column writes are already bounded, but
    // the clip is the durable fix that holds for future renderers too.
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotL, plotT, plotR - plotL, plotB - plotT);
    ctx.clip();

    ctx.strokeStyle = refs.colorRef.value;
    ctx.lineWidth = refs.lineWidthRef.value;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (n > cols * 2) {
        // Decimated: per-column vertical min/max line. Interpolation mode is
        // ignored here -- smoothing a min/max envelope is misleading.
        state.decMin = ensureFloat32(state.decMin, cols);
        state.decMax = ensureFloat32(state.decMax, cols);
        state.decOcc = ensureUint8(state.decOcc, cols);
        decimateMinMax(pxs, pys, n, plotL, plotR, state.decMin, state.decMax, state.decOcc);

        ctx.beginPath();
        const decMin = state.decMin;
        const decMax = state.decMax;
        const decOcc = state.decOcc;
        for (let c = 0; c < cols; c++) {
            if (decOcc[c] === 0) continue;
            const x = plotL + c;
            let yMin = decMin[c];
            let yMax = decMax[c];
            if (yMin < plotT) yMin = plotT;
            if (yMax > plotB) yMax = plotB;
            if (yMax < plotT || yMin > plotB) continue;
            ctx.moveTo(x, yMin);
            ctx.lineTo(x, yMax);
        }
        ctx.stroke();
        // Markers skipped in decimated regime (would be visual noise).
        ctx.restore();
        return;
    }

    // Direct path: respect interpolation mode.
    ctx.beginPath();
    if (_supportsNaNSplit(mode)) {
        // Linear / step modes: NaN-aware, split into runs.
        let i = 0;
        while (i < n && (pxs[i] !== pxs[i] || pys[i] !== pys[i])) i++;
        while (i < n) {
            const runStart = i;
            ctx.moveTo(pxs[runStart], pys[runStart]);
            let j = runStart;
            while (j + 1 < n && pxs[j + 1] === pxs[j + 1] && pys[j + 1] === pys[j + 1]) j++;
            const runEnd = j;
            _tracePath(ctx, pxs, pys, runStart, runEnd, mode, null);
            i = j + 1;
            while (i < n && (pxs[i] !== pxs[i] || pys[i] !== pys[i])) i++;
        }
    } else {
        // Monotone / catmull-rom: assume contiguous data. Tangents buffer
        // is allocated lazily on the series state.
        state.tangents = ensureFloat32(state.tangents, n);
        ctx.moveTo(pxs[0], pys[0]);
        _tracePath(ctx, pxs, pys, 0, n - 1, mode, state.tangents);
    }
    ctx.stroke();

    // Markers (drawn AFTER stroke so they sit visually on top of the line).
    // Markers DO need the clip too: per-series markers near the right edge
    // would otherwise paint half-circles past plotR.
    _drawMarkers(ctx, state, refs, plotBoundsBox);

    ctx.restore();
};

// ---------------------------------------------------------------------------
// Area series draw function
// ---------------------------------------------------------------------------
//
// Visual: fill from a baseline up to the data line, optionally stroked on top.
// Mathematically a line chart that closes to a baseline before fill. Shares
// the direct vs decimated path split with the line draw fn.
//
// Allocation-free. Baseline is resolved per-draw from yScale + plotBounds so
// it stays correct as the y-domain shifts.

const _resolveBaselinePx = (baselineConfig, yScale, pb) => {
    if (baselineConfig === 'bottom') return pb.y + pb.h;
    const v = typeof baselineConfig === 'number' ? baselineConfig : 0;
    let px = yScale.map(v);
    if (px < pb.y) px = pb.y;
    if (px > pb.y + pb.h) px = pb.y + pb.h;
    return px;
};

const makeAreaDrawFn = (state, refs, plotBoundsBox, yScale, opts) => (ctx) => {
    if (!refs.visibleRef.value) return;
    const n = state.n;
    if (n < 2) return;
    const pxs = state.pxs;
    const pys = state.pys;
    const pb = plotBoundsBox;
    const plotL = pb.x;
    const plotR = pb.x + pb.w;
    const plotT = pb.y;
    const plotB = pb.y + pb.h;
    const cols = (plotR - plotL + 1) | 0;
    if (cols < 2) return;

    const color = refs.colorRef.value;
    const fillOpacity = opts.fillOpacityRef.value;
    const lineWidth = refs.lineWidthRef.value;
    const baselinePx = _resolveBaselinePx(opts.baseline, yScale, pb);
    const strokeEnabled = opts.stroke;
    const mode = refs.interpolationRef.value;
    const savedAlpha = ctx.globalAlpha;

    // Clip to plot rect -- same rationale as makeLineDrawFn (cap/stroke
    // overshoot at plotR, plus filled area path that closes to baseline
    // at the rightmost point but whose stroke may overshoot half a line
    // width).
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotL, plotT, plotR - plotL, plotB - plotT);
    ctx.clip();

    if (n > cols * 2) {
        // Decimated branch unchanged from alpha.2 -- interpolation ignored
        // here (smoothing a min/max envelope is misleading).
        state.decMin = ensureFloat32(state.decMin, cols);
        state.decMax = ensureFloat32(state.decMax, cols);
        state.decOcc = ensureUint8(state.decOcc, cols);
        decimateMinMax(pxs, pys, n, plotL, plotR, state.decMin, state.decMax, state.decOcc);
        const decMin = state.decMin;
        const decOcc = state.decOcc;

        let firstC = -1;
        let lastC = -1;
        for (let c = 0; c < cols; c++) {
            if (decOcc[c] === 0) continue;
            if (firstC === -1) firstC = c;
            lastC = c;
        }
        if (firstC < 0) {
            ctx.globalAlpha = savedAlpha;
            ctx.restore();
            return;
        }
        ctx.beginPath();
        ctx.moveTo(plotL + firstC, baselinePx);
        for (let c = firstC; c <= lastC; c++) {
            if (decOcc[c] === 0) continue;
            let y = decMin[c];
            if (y < plotT) y = plotT;
            if (y > plotB) y = plotB;
            ctx.lineTo(plotL + c, y);
        }
        ctx.lineTo(plotL + lastC, baselinePx);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = savedAlpha * fillOpacity;
        ctx.fill();
        ctx.globalAlpha = savedAlpha;

        if (strokeEnabled) {
            ctx.beginPath();
            let firstDrawn = false;
            for (let c = firstC; c <= lastC; c++) {
                if (decOcc[c] === 0) continue;
                let y = decMin[c];
                if (y < plotT) y = plotT;
                if (y > plotB) y = plotB;
                if (!firstDrawn) {
                    ctx.moveTo(plotL + c, y);
                    firstDrawn = true;
                } else {
                    ctx.lineTo(plotL + c, y);
                }
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();
        }
        ctx.restore();
        return;
    }

    // Direct path with interpolation.
    ctx.fillStyle = color;
    ctx.globalAlpha = savedAlpha * fillOpacity;

    if (_supportsNaNSplit(mode)) {
        // NaN-aware fill: each contiguous run becomes a separate filled subarea.
        let i = 0;
        while (i < n && (pxs[i] !== pxs[i] || pys[i] !== pys[i])) i++;
        while (i < n) {
            const runStart = i;
            let j = runStart;
            while (j + 1 < n && pxs[j + 1] === pxs[j + 1] && pys[j + 1] === pys[j + 1]) j++;
            const runEnd = j;
            ctx.beginPath();
            ctx.moveTo(pxs[runStart], baselinePx);
            ctx.lineTo(pxs[runStart], pys[runStart]);
            _tracePath(ctx, pxs, pys, runStart, runEnd, mode, null);
            ctx.lineTo(pxs[runEnd], baselinePx);
            ctx.closePath();
            ctx.fill();
            i = j + 1;
            while (i < n && (pxs[i] !== pxs[i] || pys[i] !== pys[i])) i++;
        }
        ctx.globalAlpha = savedAlpha;
        if (strokeEnabled) {
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            // Walk runs again for stroke -- one stroke pass per run.
            let k = 0;
            while (k < n && (pxs[k] !== pxs[k] || pys[k] !== pys[k])) k++;
            while (k < n) {
                const runStart = k;
                let m = runStart;
                while (m + 1 < n && pxs[m + 1] === pxs[m + 1] && pys[m + 1] === pys[m + 1]) m++;
                const runEnd = m;
                ctx.beginPath();
                ctx.moveTo(pxs[runStart], pys[runStart]);
                _tracePath(ctx, pxs, pys, runStart, runEnd, mode, null);
                ctx.stroke();
                k = m + 1;
                while (k < n && (pxs[k] !== pxs[k] || pys[k] !== pys[k])) k++;
            }
        }
    } else {
        // Smoothing modes: contiguous data assumed.
        state.tangents = ensureFloat32(state.tangents, n);
        ctx.beginPath();
        ctx.moveTo(pxs[0], baselinePx);
        ctx.lineTo(pxs[0], pys[0]);
        _tracePath(ctx, pxs, pys, 0, n - 1, mode, state.tangents);
        ctx.lineTo(pxs[n - 1], baselinePx);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = savedAlpha;
        if (strokeEnabled) {
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(pxs[0], pys[0]);
            _tracePath(ctx, pxs, pys, 0, n - 1, mode, state.tangents);
            ctx.stroke();
        }
    }

    // Markers on top.
    _drawMarkers(ctx, state, refs, plotBoundsBox);

    ctx.restore();
};

// ---------------------------------------------------------------------------
// Rounded-rect path helper (v1.1.0)
// ---------------------------------------------------------------------------
//
// Uses ctx.roundRect natively where available (Chrome 99+, Firefox 113+,
// Safari 16+). Falls back to a hand-traced path with arc corners on older
// engines. Per-corner radii (top-left / top-right / bottom-right / bottom-
// left) so bar charts can round only the END opposite the baseline: top
// for positive bars, bottom for negative bars, neither for stacked
// middle segments (handled by passing radii of 0 where flatness is wanted).
//
// Each radius is clamped to half the shorter side so corners never overlap
// on very thin bars -- the rect stays a valid path even at 1px wide.

const _roundRectPath = (ctx, x, y, w, h, rTL, rTR, rBR, rBL) => {
    if (w <= 0 || h <= 0) return;
    const maxR = Math.min(w, h) * 0.5;
    if (rTL > maxR) rTL = maxR;
    if (rTR > maxR) rTR = maxR;
    if (rBR > maxR) rBR = maxR;
    if (rBL > maxR) rBL = maxR;
    if (rTL < 0) rTL = 0;
    if (rTR < 0) rTR = 0;
    if (rBR < 0) rBR = 0;
    if (rBL < 0) rBL = 0;
    // Fast path: native roundRect (uniform args = all corners share radius,
    // but the canvas spec accepts an array of 4 values for per-corner).
    if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, [rTL, rTR, rBR, rBL]);
        return;
    }
    // Hand-traced fallback. arcTo per corner; degrades to lineTo when r=0.
    ctx.beginPath();
    ctx.moveTo(x + rTL, y);
    ctx.lineTo(x + w - rTR, y);
    if (rTR > 0) ctx.arcTo(x + w, y, x + w, y + rTR, rTR);
    ctx.lineTo(x + w, y + h - rBR);
    if (rBR > 0) ctx.arcTo(x + w, y + h, x + w - rBR, y + h, rBR);
    ctx.lineTo(x + rBL, y + h);
    if (rBL > 0) ctx.arcTo(x, y + h, x, y + h - rBL, rBL);
    ctx.lineTo(x, y + rTL);
    if (rTL > 0) ctx.arcTo(x, y, x + rTL, y, rTL);
    ctx.closePath();
};

// ---------------------------------------------------------------------------
// Bar stack pass (v1.1.0)
// ---------------------------------------------------------------------------
//
// When `stack: true`, each visible series contributes to a cumulative
// per-category stack instead of getting a horizontal slot. The kernel
// calls renderer.postExtract after all series are extracted; the bar
// renderer routes that to computeBarStacks, which walks categories and
// fills state.stackBottoms / state.stackTops per visible series. The
// values are in data space (not pixel) so the y-scale's domain math
// still works against them.
//
// MVP: positive values only. Negative values get clamped to 0 in the
// stack (their bars effectively vanish). Diverging stacks (positive
// AND negative around a baseline) land in a future cut.
//
// Each series' domainYMax is overwritten with the max of its OWN
// stackTops -- so the kernel's existing y-domain union picks up the
// total stack height (the last visible series' max stackTop). This
// avoids a special-case in the kernel: stacking is opaque from the
// kernel's perspective, the renderer just pre-cooks the y-domain.

const computeBarStacks = (states, visibility, categoriesRef) => {
    const nCats = categoriesRef.value.length;
    if (nCats === 0) return;

    // Lazy-allocate stack buffers per state. ensureFloat32 grows in place.
    for (let s = 0; s < states.length; s++) {
        const st = states[s];
        st.stackBottoms = ensureFloat32(st.stackBottoms, nCats);
        st.stackTops    = ensureFloat32(st.stackTops, nCats);
        // Zero-fill to handle categories where this series has no row.
        for (let c = 0; c < nCats; c++) {
            st.stackBottoms[c] = 0;
            st.stackTops[c] = 0;
        }
    }

    // Cumulative accumulator per category. Walks series in declaration
    // order -- the user controls stack order by series order, matching
    // every other charting library's convention.
    for (let c = 0; c < nCats; c++) {
        let acc = 0;
        for (let s = 0; s < states.length; s++) {
            const visible = visibility[s] ? !!visibility[s]() : true;
            if (!visible) continue;
            const st = states[s];
            // Find this series' value at category c (linear scan; nCats
            // is small and st.n <= nCats so this stays O(nCats^2) in the
            // worst case -- fine for the typical 5-30 category range).
            let v = 0;
            for (let r = 0; r < st.n; r++) {
                if ((st.xs[r] | 0) === c) { v = st.ys[r]; break; }
            }
            if (v !== v || v < 0) v = 0;  // NaN guard + clamp negatives
            st.stackBottoms[c] = acc;
            st.stackTops[c] = acc + v;
            acc += v;
        }
    }

    // Overwrite each visible series' y-domain with the GLOBAL stack max
    // (so the kernel's union picks the cumulative total, not per-series
    // values).
    let globalMax = 0;
    for (let s = 0; s < states.length; s++) {
        for (let c = 0; c < nCats; c++) {
            if (states[s].stackTops[c] > globalMax) globalMax = states[s].stackTops[c];
        }
    }
    if (globalMax <= 0) globalMax = 1;
    for (let s = 0; s < states.length; s++) {
        states[s].domainYMin = 0;
        states[s].domainYMax = globalMax;
    }
};

// Reset stack buffers when stacking is disabled mid-session (avoids stale
// state.stackBottoms making the draw fn think stacking is still on).
const _clearBarStacks = (states) => {
    for (let s = 0; s < states.length; s++) {
        states[s].stackBottoms = null;
        states[s].stackTops = null;
    }
};

// ---------------------------------------------------------------------------
// Bar series draw function (v1.1.0)
// ---------------------------------------------------------------------------
//
// One filled rect per category. Three layouts, picked at draw time from
// state shape + opts:
//   (a) Single series  -- offsetX = 0, full bandwidth (minus innerPad)
//   (b) Grouped        -- offsetX symmetric around band center,
//                         barWidth = bandwidth/totalSeries
//   (c) Stacked        -- offsetX = 0, full bandwidth, vertical extent
//                         driven by state.stackBottoms[cat] / .stackTops[cat]
//
// Rounded corners apply to the END opposite the baseline so the bar
// looks anchored: positive bars round top, negative bars round bottom,
// stacked middle segments stay flat (the top segment's top corners
// are still rounded -- segments below get visually capped by the
// segment above).
//
// Hover tint: when the chart's crosshair is visible AND its snapIdx
// matches the bar's category, an overlay rect is drawn on top with
// the configured tint color. Crosshair read is a plain field access
// on a mutable singleton -- no signal subscription needed since the
// kernel's scene.markDirty path already redraws on crosshair change.

const makeBarDrawFn = (state, refs, plotBoundsBox, xBandScale, yScale, seriesIdx, totalSeries, baseline, innerPadFrac, cornerRadius, hoverTintRef, crosshairDataRef) => (ctx) => {
    if (!refs.visibleRef.value) return;
    const n = state.n;
    if (n === 0) return;

    const xs = state.xs;     // category indices (Float32, integer values)
    const ys = state.ys;     // values
    const pb = plotBoundsBox;
    const plotT = pb.y;
    const plotB = pb.y + pb.h;

    // Stacked mode? Detected by presence of pre-computed stackTops on the
    // series state -- the postExtract pass populates them iff opts.stack
    // is true. Stacked bars use full bandwidth (minus innerPadFrac), no
    // horizontal offset; vertical extent comes from stackBottoms/stackTops
    // in data space.
    const stacked = state.stackBottoms !== null && state.stackTops !== null
                 && state.stackBottoms !== undefined && state.stackTops !== undefined;

    const baselinePx = yScale.map(baseline);
    let barW, offsetX;
    if (stacked) {
        // Full bandwidth (minus innerPadFrac as a small visual gap between
        // adjacent categories, mirroring the grouped-layout convention).
        barW = xBandScale.bandWidth * (1 - innerPadFrac);
        offsetX = 0;
    } else {
        const groupWidth = xBandScale.bandWidth / totalSeries;
        offsetX = (seriesIdx - (totalSeries - 1) / 2) * groupWidth;
        barW = groupWidth * (1 - innerPadFrac);
    }

    ctx.fillStyle = refs.colorRef.value;

    const tintColor = hoverTintRef && hoverTintRef.value ? hoverTintRef.value : null;
    const hoveredCat = (crosshairDataRef && crosshairDataRef.visible)
        ? (crosshairDataRef.snapIdx | 0)
        : -1;

    const useRound = cornerRadius > 0;

    for (let i = 0; i < n; i++) {
        const y = ys[i];
        if (y !== y) continue; // skip NaN
        const catIdx = xs[i] | 0;

        let top, h;
        if (stacked) {
            const sb = state.stackBottoms[catIdx];
            const stt = state.stackTops[catIdx];
            if (stt <= sb) continue;  // zero-height segment (e.g. value <= 0)
            const yPxBottom = yScale.map(sb);
            const yPxTop = yScale.map(stt);
            top = yPxTop;
            h = yPxBottom - yPxTop;
        } else {
            const yPx = yScale.map(y);
            top = yPx < baselinePx ? yPx : baselinePx;
            h = Math.abs(yPx - baselinePx);
        }

        // Clamp to plot rect.
        if (top < plotT) { h -= (plotT - top); top = plotT; }
        if (top + h > plotB) { h = plotB - top; }
        if (h <= 0) continue;

        const barX = xBandScale.map(catIdx) + offsetX - barW / 2;

        // Decide per-corner radii. Round the end OPPOSITE the baseline so
        // bars look anchored. For stacked, that's always the top (we only
        // stack positive values in MVP); the topmost segment's top corners
        // will be the visible rounded ones (lower segments get capped by
        // the segment above, hiding their unrounded bottoms by adjacency).
        let rTL = 0, rTR = 0, rBR = 0, rBL = 0;
        if (useRound) {
            const isPositive = stacked || y >= baseline;
            if (isPositive) { rTL = cornerRadius; rTR = cornerRadius; }
            else            { rBR = cornerRadius; rBL = cornerRadius; }
        }

        if (useRound) {
            _roundRectPath(ctx, barX, top, barW, h, rTL, rTR, rBR, rBL);
            ctx.fill();
        } else {
            ctx.fillRect(barX, top, barW, h);
        }

        // Hover tint overlay -- drawn on top of the bar fill with the same
        // shape. Uses an explicit fillStyle assignment so we don't pollute
        // the outer-loop fillStyle. Fixed color (no per-bar color math
        // until v1.2.0 lite-color integration).
        if (hoveredCat === catIdx && tintColor) {
            ctx.fillStyle = tintColor;
            if (useRound) {
                _roundRectPath(ctx, barX, top, barW, h, rTL, rTR, rBR, rBL);
                ctx.fill();
            } else {
                ctx.fillRect(barX, top, barW, h);
            }
            ctx.fillStyle = refs.colorRef.value;  // restore for next bar
        }
    }
};

// ---------------------------------------------------------------------------
// Horizontal bar draw (v1.5.0)
// ---------------------------------------------------------------------------
//
// Sibling of makeBarDrawFn with the two axes exchanged: the band scale
// (xBandScale) is bound to the Y pixel range and the value scale (yScale) to
// the X pixel range. Selected ONCE at mount by _makeBarDraw, so the vertical
// closure never gains a byte and this closure never evaluates a vertical
// branch. Scalar-only locals; fillStyle set once outside the loop; shared
// _roundRectPath; same 12-arg signature. Category 0 sits at the TOP of the
// plot (band range runs top-down, matching heatmap / reading order).
const makeHBarDrawFn = (state, refs, plotBoundsBox, xBandScale, yScale, seriesIdx, totalSeries, baseline, innerPadFrac, cornerRadius, hoverTintRef, crosshairDataRef) => (ctx) => {
    if (!refs.visibleRef.value) return;
    const n = state.n;
    if (n === 0) return;

    const xs = state.xs;     // category indices (Float32, integer values)
    const ys = state.ys;     // values
    const pb = plotBoundsBox;
    const plotL = pb.x;
    const plotR = pb.x + pb.w;

    const stacked = state.stackBottoms !== null && state.stackTops !== null
                 && state.stackBottoms !== undefined && state.stackTops !== undefined;

    // yScale is the VALUE scale (bound to X pixels here), so baselinePx is an X.
    const baselinePx = yScale.map(baseline);
    let barH, offsetY;
    if (stacked) {
        barH = xBandScale.bandWidth * (1 - innerPadFrac);
        offsetY = 0;
    } else {
        const groupHeight = xBandScale.bandWidth / totalSeries;
        offsetY = (seriesIdx - (totalSeries - 1) / 2) * groupHeight;
        barH = groupHeight * (1 - innerPadFrac);
    }

    ctx.fillStyle = refs.colorRef.value;

    const tintColor = hoverTintRef && hoverTintRef.value ? hoverTintRef.value : null;
    const hoveredCat = (crosshairDataRef && crosshairDataRef.visible)
        ? (crosshairDataRef.snapIdx | 0)
        : -1;

    const useRound = cornerRadius > 0;

    for (let i = 0; i < n; i++) {
        const y = ys[i];
        if (y !== y) continue; // skip NaN
        const catIdx = xs[i] | 0;

        let left, w;
        if (stacked) {
            const sb = state.stackBottoms[catIdx];
            const stt = state.stackTops[catIdx];
            if (stt <= sb) continue;  // zero-width segment (e.g. value <= 0)
            const xL = yScale.map(sb);
            const xR = yScale.map(stt);
            left = xL;
            w = xR - xL;
        } else {
            const xPx = yScale.map(y);
            left = xPx < baselinePx ? xPx : baselinePx;
            w = Math.abs(xPx - baselinePx);
        }

        // Clamp to plot rect (X axis).
        if (left < plotL) { w -= (plotL - left); left = plotL; }
        if (left + w > plotR) { w = plotR - left; }
        if (w <= 0) continue;

        const barY = xBandScale.map(catIdx) + offsetY - barH / 2;

        // Round the end OPPOSITE the baseline. Positive bars grow rightward so
        // the right corners (rTR/rBR) round; negative bars round the left.
        let rTL = 0, rTR = 0, rBR = 0, rBL = 0;
        if (useRound) {
            const isPositive = stacked || y >= baseline;
            if (isPositive) { rTR = cornerRadius; rBR = cornerRadius; }
            else            { rTL = cornerRadius; rBL = cornerRadius; }
        }

        if (useRound) {
            _roundRectPath(ctx, left, barY, w, barH, rTL, rTR, rBR, rBL);
            ctx.fill();
        } else {
            ctx.fillRect(left, barY, w, barH);
        }

        if (hoveredCat === catIdx && tintColor) {
            ctx.fillStyle = tintColor;
            if (useRound) {
                _roundRectPath(ctx, left, barY, w, barH, rTL, rTR, rBR, rBL);
                ctx.fill();
            } else {
                ctx.fillRect(left, barY, w, barH);
            }
            ctx.fillStyle = refs.colorRef.value;  // restore for next bar
        }
    }
};

// ---------------------------------------------------------------------------
// Bar x-axis (v1.1.0): categorical labels at band centers
// ---------------------------------------------------------------------------
//
// Unlike buildAxis which numerically generates ticks via lite-axis, the bar
// x-axis has one label per category. For dense categories (>20), every Nth
// is labeled to keep the axis readable.

const buildBarAxis = (parent, opts) => {
    // opts: {
    //   xBandScale, plotBoundsBox, plotBoundsSignal, scaleVersion,
    //   tickColor (ref), labelColor (ref), font, categoriesRef,
    //   side: 'bottom' (default, vertical bars) | 'left' (horizontal bars)
    // }
    // v1.5.0: a 'left' side draws the same categorical axis rotated onto the Y
    // range for horizontal bars. Per-side constants are hoisted above the
    // rebuild loop (cold path); the loop picks one coordinate pair per flag.
    const isLeft = opts.side === 'left';
    const axisGroup = parent.add(group({}));
    const spineNode = axisGroup.add(lineNode({
        stroke: opts.tickColor,
        strokeWidth: 1,
    }));
    const tickPool = [];   // small tick lines off the spine
    const labelPool = [];

    const ensurePools = (count) => {
        while (tickPool.length < count) {
            tickPool.push(axisGroup.add(lineNode({
                stroke: opts.tickColor,
                strokeWidth: 1,
            })));
        }
        while (labelPool.length < count) {
            labelPool.push(axisGroup.add(textNode({
                fill: opts.labelColor,
                font: opts.font,
                // v1.3.0: this was previously `anchor: 'center'` -- lite-scene's
                // text node uses `align`, not `anchor`, so the prop was silently
                // dropped and `_align` defaulted to 'left'. The canvas visual
                // looked "close enough" with single-character labels, but
                // multi-character category names were offset right by half a
                // glyph width. Found while wiring SVG export (which surfaces
                // the alignment via `text-anchor`).
                align: isLeft ? 'right' : 'center',
                baseline: isLeft ? 'middle' : 'top',
            })));
        }
    };

    const rebuild = () => {
        opts.scaleVersion();
        opts.plotBoundsSignal();
        const pb = opts.plotBoundsBox;
        const bs = opts.xBandScale;
        const cats = opts.categoriesRef.value;
        const n = cats.length;

        if (isLeft) {
            spineNode.set({ visible: true, x: pb.x, y: pb.y, dx: 0, dy: pb.h });
        } else {
            spineNode.set({ visible: true, x: pb.x, y: pb.y + pb.h, dx: pb.w, dy: 0 });
        }

        ensurePools(n);

        // Adaptive label step: budget per available span along the band axis.
        const maxLabels = Math.max(2, ((isLeft ? pb.h / 24 : pb.w / 80)) | 0);
        const labelStep = n <= maxLabels ? 1 : Math.ceil(n / maxLabels);

        for (let i = 0; i < n; i++) {
            const c = bs.map(i);  // band center: an X for bottom, a Y for left
            if (isLeft) {
                tickPool[i].set({ visible: true, x: pb.x, y: c, dx: -4, dy: 0 });
            } else {
                tickPool[i].set({ visible: true, x: c, y: pb.y + pb.h, dx: 0, dy: 4 });
            }
            if (i % labelStep === 0) {
                if (isLeft) {
                    labelPool[i].set({ visible: true, x: pb.x - 6, y: c, text: cats[i] });
                } else {
                    labelPool[i].set({ visible: true, x: c, y: pb.y + pb.h + 6, text: cats[i] });
                }
            } else {
                labelPool[i].set({ visible: false });
            }
        }
        for (let i = n; i < tickPool.length; i++) {
            tickPool[i].set({ visible: false });
            labelPool[i].set({ visible: false });
        }
    };

    const dispose = effect(rebuild);
    return { axisGroup, dispose };
};



const _charBuf = new Uint8Array(32);

const formatTickValue = (v, axisFormat, timeUnit) => {
    if (axisFormat === 'time') {
        const n = formatTime(v, timeUnit, _charBuf, 0);
        return charBufToString(_charBuf, n);
    }
    const n = formatNumber(v, _decimalsFor(v), _charBuf, 0);
    return charBufToString(_charBuf, n);
};

const _decimalsFor = (v) => {
    const a = Math.abs(v);
    if (a === 0) return 0;
    if (a >= 1000) return 0;
    if (a >= 10) return 1;
    if (a >= 1) return 2;
    return 3;
};

const charBufToString = (buf, n) => {
    // Slow path (axis update only, not per-frame): build a JS string.
    //
    // v1.4.0-alpha.1 (audit fix): was `let s = ''; for (...) s +=
    // String.fromCharCode(buf[i])` which allocates N intermediate
    // strings as V8 walks the rope. For an axis with ~20 ticks at
    // ~10 chars each that's ~200 string allocations per axis update.
    // `String.fromCharCode.apply(null, view)` does it in one call.
    // `buf.subarray(0, n)` is a zero-alloc view onto the existing
    // Uint8Array. The arg-count limit (~64k on V8) is far above the
    // TICK_BUF_SIZE * max-label-chars budget here.
    return String.fromCharCode.apply(null, buf.subarray(0, n));
};

// ---------------------------------------------------------------------------
// Axis builder
// ---------------------------------------------------------------------------
//
// Builds a tick + label group for one axis (X or Y). The axis effect fires
// whenever scaleVersion or plotBoundsSignal changes; ticks are pooled and
// re-positioned in place (set() calls do allocate small props objects, but
// the axis-update path is not per-frame -- it fires on resize / domain
// change, not on every paint).

const TICK_BUF_SIZE = 64;

const buildAxis = (parent, opts) => {
    // opts: {
    //   orientation: 'x' | 'y',
    //   scale,
    //   plotBoundsBox, plotBoundsSignal, scaleVersion,
    //   tickColor, labelColor, font, format ('number'|'time')
    // }

    const isX = opts.orientation === 'x';
    const tickBuf = new Float64Array(TICK_BUF_SIZE);
    const pixelBuf = new Float64Array(TICK_BUF_SIZE);
    const keepBuf = new Int32Array(TICK_BUF_SIZE);

    const axisGroup = parent.add(group({}));

    // Spine (the axis line itself).
    const spine = axisGroup.add(lineNode({
        stroke: opts.tickColor,
        strokeWidth: 1,
    }));

    const ticksGroup = axisGroup.add(group({}));
    const tickPool = []; // [{ tickLine, label }]

    const updateSpine = () => {
        const pb = opts.plotBoundsBox;
        if (isX) {
            spine.set({ x: pb.x, y: pb.y + pb.h, dx: pb.w, dy: 0 });
        } else {
            spine.set({ x: pb.x, y: pb.y, dx: 0, dy: pb.h });
        }
    };

    const ensurePoolSize = (n) => {
        while (tickPool.length < n) {
            const t = ticksGroup.add(lineNode({
                stroke: opts.tickColor,
                strokeWidth: 1,
                dx: isX ? 0 : -5,
                dy: isX ? 5 : 0,
            }));
            const l = ticksGroup.add(textNode({
                font: opts.font,
                fill: opts.labelColor,
                align: isX ? 'center' : 'right',
                baseline: isX ? 'top' : 'middle',
            }));
            tickPool.push({ tickLine: t, label: l });
        }
    };

    const rebuild = () => {
        opts.scaleVersion();
        opts.plotBoundsSignal();
        updateSpine();

        const pb = opts.plotBoundsBox;
        const s = opts.scale;
        const span = isX ? pb.w : pb.h;
        const target = Math.max(2, Math.min(12, (span / (isX ? 80 : 40)) | 0));

        let count;
        let timeUnit = 0;
        if (opts.format === 'time') {
            const res = timeTicks(s.dMin, s.dMax, target, tickBuf);
            count = res.count;
            timeUnit = res.unit;
        } else if (s.type === 'log') {
            // v1.4.0-alpha.0: decade boundaries (1, 10, 100, ...). The
            // `minor` flag for 2x/5x sub-ticks is currently off; we may
            // expose it via `tickSubdivisions: 'major' | 'all'` in a
            // later cut.
            count = logTicks(s.dMin, s.dMax, target, tickBuf, false);
        } else {
            count = linearTicks(s.dMin, s.dMax, target, tickBuf);
        }
        if (count > TICK_BUF_SIZE) count = TICK_BUF_SIZE;

        // v1.4.0-alpha.0: use the scale's `map` method (was an inlined
        // `tickBuf[i] * slope + intercept`). This is the once-per-resize
        // tick projection path -- the method-call overhead is ~12 calls
        // per axis update and not on the per-frame draw path. The change
        // lets log-scale ticks project correctly through `Math.log` *
        // slope + intercept without a parallel code path.
        for (let i = 0; i < count; i++) {
            pixelBuf[i] = s.map(tickBuf[i]);
        }
        const minPx = opts.format === 'time' ? 70 : 40;
        const kept = thinLabels(tickBuf, count, pixelBuf, minPx, keepBuf);

        ensurePoolSize(count);

        // Sorted pointer walk over keepBuf (no Set, no allocation).
        let kptPtr = 0;
        for (let i = 0; i < tickPool.length; i++) {
            const pair = tickPool[i];
            if (i >= count) {
                pair.tickLine.set({ visible: false });
                pair.label.set({ visible: false });
                continue;
            }
            const px = pixelBuf[i];
            if (isX) {
                pair.tickLine.set({
                    visible: true,
                    x: px,
                    y: pb.y + pb.h,
                    dx: 0,
                    dy: 5,
                });
            } else {
                pair.tickLine.set({
                    visible: true,
                    x: pb.x,
                    y: px,
                    dx: -5,
                    dy: 0,
                });
            }
            const isKept = kptPtr < kept && keepBuf[kptPtr] === i;
            if (isKept) {
                kptPtr++;
                const labelStr = formatTickValue(tickBuf[i], opts.format, timeUnit);
                if (isX) {
                    pair.label.set({
                        visible: true,
                        x: px,
                        y: pb.y + pb.h + 8,
                        text: labelStr,
                    });
                } else {
                    pair.label.set({
                        visible: true,
                        x: pb.x - 8,
                        y: px,
                        text: labelStr,
                    });
                }
            } else {
                pair.label.set({ visible: false });
            }
        }
    };

    const dispose = effect(rebuild);

    return { axisGroup, dispose };
};

// ---------------------------------------------------------------------------
// Gridlines (v1.0.0)
// ---------------------------------------------------------------------------
//
// Draws long horizontal + vertical lines through the plot rect at each X/Y
// tick position. Pooled `lite-scene` line nodes, repositioned in place on
// scale/plot-bounds changes (same pattern as buildAxis tick lines). Drawn
// behind axes and data because the grid group is added to scene.root first.

const buildGrid = (parent, opts) => {
    // opts: {
    //   xScale, yScale, plotBoundsBox, plotBoundsSignal, scaleVersion,
    //   color (accessor), xFormat ('time'|'number'), enableX (bool), enableY (bool),
    //   swapAxes (bool, default false)
    // }
    // v1.5.0: under swap the yScale holds the VALUE domain but ranges over x
    // pixels, so value gridlines run VERTICALLY. Read once here (setup closure)
    // -- never per rebuild-line, never per frame. Default false leaves every
    // existing caller's grid output byte-identical.
    const swap = opts.swapAxes === true;
    const xTickBuf = new Float64Array(TICK_BUF_SIZE);
    const yTickBuf = new Float64Array(TICK_BUF_SIZE);
    const xPixelBuf = new Float64Array(TICK_BUF_SIZE);
    const yPixelBuf = new Float64Array(TICK_BUF_SIZE);

    const gridGroup = parent.add(group({}));
    const linePool = [];

    const ensurePool = (n) => {
        while (linePool.length < n) {
            linePool.push(gridGroup.add(lineNode({
                stroke: opts.color,
                strokeWidth: 1,
            })));
        }
    };

    const rebuild = () => {
        opts.scaleVersion();
        opts.plotBoundsSignal();
        const pb = opts.plotBoundsBox;
        const xS = opts.xScale;
        const yS = opts.yScale;

        let xCount = 0;
        if (opts.enableX) {
            const xTarget = Math.max(2, Math.min(12, (pb.w / 80) | 0));
            if (opts.xFormat === 'time') {
                xCount = timeTicks(xS.dMin, xS.dMax, xTarget, xTickBuf).count;
            } else if (xS.type === 'log') {
                xCount = logTicks(xS.dMin, xS.dMax, xTarget, xTickBuf, false);
            } else {
                xCount = linearTicks(xS.dMin, xS.dMax, xTarget, xTickBuf);
            }
            if (xCount > TICK_BUF_SIZE) xCount = TICK_BUF_SIZE;
            for (let i = 0; i < xCount; i++) {
                xPixelBuf[i] = xS.map(xTickBuf[i]);
            }
        }

        let yCount = 0;
        if (opts.enableY) {
            const yTarget = Math.max(2, Math.min(12, ((swap ? pb.w : pb.h) / 40) | 0));
            if (yS.type === 'log') {
                yCount = logTicks(yS.dMin, yS.dMax, yTarget, yTickBuf, false);
            } else {
                yCount = linearTicks(yS.dMin, yS.dMax, yTarget, yTickBuf);
            }
            if (yCount > TICK_BUF_SIZE) yCount = TICK_BUF_SIZE;
            for (let i = 0; i < yCount; i++) {
                yPixelBuf[i] = yS.map(yTickBuf[i]);
            }
        }

        const total = xCount + yCount;
        ensurePool(total);

        // X gridlines: vertical lines spanning plot height at each x tick.
        for (let i = 0; i < xCount; i++) {
            linePool[i].set({
                visible: true,
                x: xPixelBuf[i],
                y: pb.y,
                dx: 0,
                dy: pb.h,
            });
        }
        // Y gridlines: horizontal lines spanning plot width at each y tick.
        // Under swap the value axis is horizontal, so these become VERTICAL
        // lines at each value pixel (yPixelBuf holds x pixels) spanning height.
        for (let i = 0; i < yCount; i++) {
            linePool[xCount + i].set(swap ? {
                visible: true,
                x: yPixelBuf[i],
                y: pb.y,
                dx: 0,
                dy: pb.h,
            } : {
                visible: true,
                x: pb.x,
                y: yPixelBuf[i],
                dx: pb.w,
                dy: 0,
            });
        }
        // Hide unused pool entries.
        for (let i = total; i < linePool.length; i++) {
            linePool[i].set({ visible: false });
        }
    };

    const dispose = effect(rebuild);
    return { gridGroup, dispose };
};

// ---------------------------------------------------------------------------
// Annotation layer (v1.7.0)
// ---------------------------------------------------------------------------
//
// Arbitrary lines / ranges / points / text labels pinned to DATA coordinates
// on the axis kernel (line / area / bar / bubble / scatter). Two-effect split:
//
//   resolve  -- tracks themeVersion + the annotations accessor. Validates each
//               entry (fail-closed: Number.isFinite, never truthiness), sizes
//               the pools, and resolves CSS-var colors ONCE into a stable string
//               array. getComputedStyle lives here only, never per frame.
//   project  -- tracks scaleVersion + plotBoundsSignal (bumped EVERY pan/zoom
//               frame). Maps data -> pixels and writes pooled node underscore
//               fields DIRECTLY (no `.set({...})` object literals). Zero alloc.
//
// Solid rules use a pooled `lineNode`; ranges, point markers, and DASHED rules
// draw through a single `annFillPath` (SVG-exportable). Labels drive a pooled
// `textNode`. `dispose` detaches annGroup so scene.dispose() releases the tree.

const ANN_BUF_SIZE = 64;
const ANN_DEAD = 0;
const ANN_LINE = 1;
const ANN_RANGE = 2;
const ANN_POINT = 3;
const ANN_TEXT = 4;
const DEFAULT_ANN_COLOR = '#888888';
const DEFAULT_ANN_FILL = 'rgba(136,136,136,0.15)';
const DEFAULT_ANN_LABEL_COLOR = '#444444';

const buildAnnotations = (parent, opts) => {
    // opts: {
    //   xScale, yScale, plotBoundsBox, plotBoundsSignal, scaleVersion,
    //   annotationsAcc, themeVersion, swapAxes, container, font, markDirty
    // }
    let cap = ANN_BUF_SIZE;
    let kindBuf = new Int32Array(cap);   // ANN_* code (0 = dead)
    let axisBuf = new Int32Array(cap);   // 0 = x-axis, 1 = y-axis
    let dashBuf = new Int32Array(cap);   // 1 = dashed rule
    let visBuf = new Int32Array(cap);    // 1 = visible (project writes)
    let d0Buf = new Float64Array(cap);   // value / from / x
    let d1Buf = new Float64Array(cap);   // to / y
    let wBuf = new Float64Array(cap);    // stroke width / marker radius
    let sxBuf = new Float64Array(cap);   // screen primary x
    let syBuf = new Float64Array(cap);   // screen primary y
    let sx1Buf = new Float64Array(cap);  // screen secondary x
    let sy1Buf = new Float64Array(cap);  // screen secondary y
    // Stable resolved strings/dashes, rebuilt in the (cold) resolve step.
    const colorArr = [];
    const labelArr = [];
    const dashArr = [];
    const alignArr = [];
    let annCount = 0;

    const annGroup = parent.add(group({}));

    const linePool = [];
    const textPool = [];

    const ensurePools = (n) => {
        while (linePool.length < n) {
            linePool.push(annGroup.add(lineNode({
                stroke: DEFAULT_ANN_COLOR,
                strokeWidth: 1,
            })));
        }
        while (textPool.length < n) {
            textPool.push(annGroup.add(textNode({
                font: opts.font(),
                fill: DEFAULT_ANN_LABEL_COLOR,
                align: 'left',
                baseline: 'alphabetic',
            })));
        }
    };

    // D1: the SVG clip idiom leaves the clip rect in the path chunk buffer, so
    // beginPath() MUST be called AGAIN before the first fill/arc or the clip
    // rect fills as a giant colored block in the export. Runs on every paint;
    // reads pre-computed buffers only -- no allocation.
    const annDraw = (ctx) => {
        const pb = opts.plotBoundsBox;
        const plotL = pb.x;
        const plotT = pb.y;
        const plotR = pb.x + pb.w;
        const plotB = pb.y + pb.h;
        ctx.save();
        ctx.beginPath();
        ctx.rect(plotL, plotT, plotR - plotL, plotB - plotT);
        ctx.clip();
        ctx.beginPath(); // D1 caveat: clear the clip rect from the chunk buffer.

        // Range fills (behind rules).
        for (let i = 0; i < annCount; i++) {
            if (visBuf[i] !== 1 || kindBuf[i] !== ANN_RANGE) continue;
            const horizontal = axisBuf[i] === 1 ? !opts.swapAxes : opts.swapAxes;
            ctx.fillStyle = colorArr[i];
            if (horizontal) {
                const y0 = syBuf[i] < sy1Buf[i] ? syBuf[i] : sy1Buf[i];
                ctx.fillRect(plotL, y0, plotR - plotL, Math.abs(sy1Buf[i] - syBuf[i]));
            } else {
                const x0 = sxBuf[i] < sx1Buf[i] ? sxBuf[i] : sx1Buf[i];
                ctx.fillRect(x0, plotT, Math.abs(sx1Buf[i] - sxBuf[i]), plotB - plotT);
            }
        }
        // Dashed rules.
        for (let i = 0; i < annCount; i++) {
            if (visBuf[i] !== 1 || kindBuf[i] !== ANN_LINE || dashBuf[i] !== 1) continue;
            ctx.strokeStyle = colorArr[i];
            ctx.lineWidth = wBuf[i];
            ctx.setLineDash(dashArr[i]);
            ctx.beginPath();
            ctx.moveTo(sxBuf[i], syBuf[i]);
            ctx.lineTo(sx1Buf[i], sy1Buf[i]);
            ctx.stroke();
            ctx.setLineDash(_EMPTY_DASH);
        }
        // Point markers (one beginPath/fill each -- colors differ).
        for (let i = 0; i < annCount; i++) {
            if (visBuf[i] !== 1 || kindBuf[i] !== ANN_POINT) continue;
            ctx.beginPath();
            ctx.fillStyle = colorArr[i];
            ctx.arc(sxBuf[i], syBuf[i], wBuf[i], 0, _TWO_PI);
            ctx.fill();
        }
        ctx.restore();
    };

    // Fill / marker / dashed-rule node, added FIRST (child 0 of annGroup) so it
    // renders BEHIND the solid-rule lineNodes and label textNodes. Created after
    // annDraw is defined -- a sync scheduler paints on add(), invoking the draw.
    const annFillPath = annGroup.add(pathNode({ draw: (ctx) => annDraw(ctx) }));
    void annFillPath;

    // Data -> pixels. Reads NO signals (the projectEffect wrapper tracks them),
    // so resolve() can call it synchronously without leaking scale-version deps
    // into the resolve effect (keeping resolveColor off the per-frame path).
    const project = () => {
        const pb = opts.plotBoundsBox;
        const plotL = pb.x;
        const plotT = pb.y;
        const plotR = pb.x + pb.w;
        const plotB = pb.y + pb.h;
        const xS = opts.xScale;
        const yS = opts.yScale;
        const swap = opts.swapAxes;

        for (let i = 0; i < annCount; i++) {
            const k = kindBuf[i];
            const ln = linePool[i];
            const tn = textPool[i];
            if (k === ANN_LINE) {
                const axisY = axisBuf[i] === 1;
                const p = (axisY ? yS : xS).map(d0Buf[i]);
                const vertical = axisY ? swap : !swap;
                let vis;
                if (!Number.isFinite(p)) {
                    vis = 0;
                } else if (vertical) {
                    vis = (p >= plotL && p <= plotR) ? 1 : 0;
                    sxBuf[i] = p; syBuf[i] = plotT;
                    sx1Buf[i] = p; sy1Buf[i] = plotB;
                } else {
                    vis = (p >= plotT && p <= plotB) ? 1 : 0;
                    sxBuf[i] = plotL; syBuf[i] = p;
                    sx1Buf[i] = plotR; sy1Buf[i] = p;
                }
                visBuf[i] = vis;
                if (vis === 1 && dashBuf[i] === 0) {
                    ln._visible = true;
                    ln._stroke = colorArr[i];
                    ln._strokeWidth = wBuf[i];
                    if (vertical) {
                        ln._x = p; ln._y = plotT; ln._dx = 0; ln._dy = plotB - plotT;
                    } else {
                        ln._x = plotL; ln._y = p; ln._dx = plotR - plotL; ln._dy = 0;
                    }
                } else {
                    ln._visible = false;
                }
            } else if (k === ANN_RANGE) {
                const axisY = axisBuf[i] === 1;
                const s = axisY ? yS : xS;
                const p0 = s.map(d0Buf[i]);
                const p1 = s.map(d1Buf[i]);
                visBuf[i] = (Number.isFinite(p0) && Number.isFinite(p1)) ? 1 : 0;
                const horizontal = axisY ? !swap : swap;
                if (horizontal) {
                    syBuf[i] = p0; sy1Buf[i] = p1;
                } else {
                    sxBuf[i] = p0; sx1Buf[i] = p1;
                }
                ln._visible = false;
            } else if (k === ANN_POINT || k === ANN_TEXT) {
                const px = swap ? yS.map(d1Buf[i]) : xS.map(d0Buf[i]);
                const py = swap ? xS.map(d0Buf[i]) : yS.map(d1Buf[i]);
                let vis = Number.isFinite(px) && Number.isFinite(py);
                if (vis && k === ANN_POINT) {
                    vis = px >= plotL && px <= plotR && py >= plotT && py <= plotB;
                }
                visBuf[i] = vis ? 1 : 0;
                sxBuf[i] = px; syBuf[i] = py;
                ln._visible = false;
            } else {
                visBuf[i] = 0;
                ln._visible = false;
            }

            // Labels / text-type annotations.
            if (visBuf[i] === 1 && labelArr[i].length > 0) {
                tn._visible = true;
                tn._text = labelArr[i];
                tn._fill = colorArr[i];
                tn._align = alignArr[i];
                if (k === ANN_RANGE) {
                    tn._x = plotL + 4; tn._y = plotT + 12;
                } else if (k === ANN_LINE) {
                    tn._x = sxBuf[i] + 4; tn._y = syBuf[i] + 12;
                } else {
                    tn._x = sxBuf[i]; tn._y = syBuf[i];
                }
            } else {
                tn._visible = false;
            }
        }
        // Hide surplus pool entries beyond the live count.
        for (let i = annCount; i < linePool.length; i++) linePool[i]._visible = false;
        for (let i = annCount; i < textPool.length; i++) textPool[i]._visible = false;
        opts.markDirty();
    };

    const resolveInto = (raw, n) => {
        if (n > cap) {
            let nc = cap;
            while (nc < n) nc <<= 1;
            kindBuf = new Int32Array(nc);
            axisBuf = new Int32Array(nc);
            dashBuf = new Int32Array(nc);
            visBuf = new Int32Array(nc);
            d0Buf = new Float64Array(nc);
            d1Buf = new Float64Array(nc);
            wBuf = new Float64Array(nc);
            sxBuf = new Float64Array(nc);
            syBuf = new Float64Array(nc);
            sx1Buf = new Float64Array(nc);
            sy1Buf = new Float64Array(nc);
            cap = nc;
        }
        for (let i = 0; i < n; i++) {
            const a = raw[i];
            kindBuf[i] = ANN_DEAD;
            axisBuf[i] = 0;
            dashBuf[i] = 0;
            wBuf[i] = 1;
            colorArr[i] = DEFAULT_ANN_COLOR;
            labelArr[i] = '';
            dashArr[i] = _EMPTY_DASH;
            alignArr[i] = 'left';
            if (!a || typeof a !== 'object') continue;
            const t = a.type;
            if (t === 'line') {
                if (a.axis !== 'x' && a.axis !== 'y') continue;
                if (!Number.isFinite(a.value)) continue;
                kindBuf[i] = ANN_LINE;
                axisBuf[i] = a.axis === 'y' ? 1 : 0;
                d0Buf[i] = a.value;
                wBuf[i] = Number.isFinite(a.width) ? a.width : 1;
                colorArr[i] = resolveColor(a.color != null ? a.color : DEFAULT_ANN_COLOR, opts.container);
                if (Array.isArray(a.dash) && a.dash.length > 0) {
                    dashBuf[i] = 1;
                    dashArr[i] = a.dash;
                }
                if (typeof a.label === 'string') labelArr[i] = a.label;
            } else if (t === 'range') {
                if (a.axis !== 'x' && a.axis !== 'y') continue;
                if (!Number.isFinite(a.from) || !Number.isFinite(a.to)) continue;
                kindBuf[i] = ANN_RANGE;
                axisBuf[i] = a.axis === 'y' ? 1 : 0;
                d0Buf[i] = a.from;
                d1Buf[i] = a.to;
                colorArr[i] = resolveColor(a.fill != null ? a.fill : DEFAULT_ANN_FILL, opts.container);
                if (typeof a.label === 'string') labelArr[i] = a.label;
            } else if (t === 'point') {
                if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
                kindBuf[i] = ANN_POINT;
                d0Buf[i] = a.x;
                d1Buf[i] = a.y;
                wBuf[i] = Number.isFinite(a.radius) ? a.radius : 3;
                colorArr[i] = resolveColor(a.color != null ? a.color : DEFAULT_ANN_COLOR, opts.container);
                if (typeof a.label === 'string') labelArr[i] = a.label;
            } else if (t === 'text') {
                if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
                if (typeof a.text !== 'string') continue;
                kindBuf[i] = ANN_TEXT;
                d0Buf[i] = a.x;
                d1Buf[i] = a.y;
                labelArr[i] = a.text;
                colorArr[i] = resolveColor(a.color != null ? a.color : DEFAULT_ANN_LABEL_COLOR, opts.container);
                if (a.anchor === 'middle') alignArr[i] = 'center';
                else if (a.anchor === 'end') alignArr[i] = 'right';
                else alignArr[i] = 'left';
            }
            // Unknown type: slot stays ANN_DEAD (fail-closed).
        }
        annCount = n;
        colorArr.length = n;
        labelArr.length = n;
        dashArr.length = n;
        alignArr.length = n;
        ensurePools(n);
    };

    // Resolve step (cold): structure + color. Tracks themeVersion + the
    // annotations accessor only. project() reads no signals, so calling it here
    // does not leak scaleVersion into this effect.
    const disposeResolve = effect(() => {
        opts.themeVersion();
        const list = opts.annotationsAcc();
        const raw = Array.isArray(list) ? list : null;
        resolveInto(raw, raw ? raw.length : 0);
        project();
    });

    // Project step (hot): re-maps to pixels every pan/zoom frame. Zero alloc.
    const disposeProject = effect(() => {
        opts.scaleVersion();
        opts.plotBoundsSignal();
        project();
    });

    const dispose = () => {
        disposeResolve();
        disposeProject();
        annGroup.remove(); // Risk 4: detach so scene.dispose() frees the subtree.
    };

    return {
        annGroup,
        dispose,
        linePool,
        textPool,
        get coordBuf() { return d0Buf; },
        get count() { return annCount; },
    };
};

// ---------------------------------------------------------------------------
// Default margins / config
// ---------------------------------------------------------------------------

const DEFAULT_MARGIN = { top: 16, right: 24, bottom: 32, left: 56 };
const DEFAULT_AXIS_COLOR = '#888888';
const DEFAULT_LABEL_COLOR = '#444444';
const DEFAULT_LINE_COLOR = '#3b82f6';
const DEFAULT_FONT = '11px sans-serif';
const DEFAULT_CROSSHAIR_COLOR = '#666666';
const DEFAULT_TOOLTIP_BG = 'rgba(255,255,255,0.96)';
const DEFAULT_TOOLTIP_BORDER = '#cccccc';
const DEFAULT_TOOLTIP_MARKER_STROKE = '#ffffff';
const DEFAULT_LEGEND_POSITION = 'bottom';
const DEFAULT_GRID_COLOR = 'rgba(0,0,0,0.08)';
const VALID_LEGEND_POSITIONS = { top: 1, bottom: 1, left: 1, right: 1 };

// Pre-allocated constants used by the crosshair draw fn. Avoids `[]` /
// `Math.PI * 2` allocations on every mousemove redraw.
const _EMPTY_DASH = Object.freeze([]);
const _TWO_PI = Math.PI * 2;

// v1.5.0: crosshair guide line, factored into two orientation-specific
// helpers so drawCrosshair is a single branch-free call per frame. The kernel
// selects one at setup (_guide). Both take the band-axis pixel as the second
// arg: an X for the vertical guide, a Y for the horizontal guide.
const _strokeGuideV = (ctx, x, pb, color, dash) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x, pb.y);
    ctx.lineTo(x, pb.y + pb.h);
    ctx.stroke();
    ctx.setLineDash(_EMPTY_DASH);
};
const _strokeGuideH = (ctx, y, pb, color, dash) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(pb.x, y);
    ctx.lineTo(pb.x + pb.w, y);
    ctx.stroke();
    ctx.setLineDash(_EMPTY_DASH);
};

// ---------------------------------------------------------------------------
// Tooltip / crosshair text formatters
// ---------------------------------------------------------------------------
//
// Allocate strings -- tooltip update fires at mousemove rate, not per-frame.

const formatTooltipHeader = (domainX, xType) => {
    if (xType === 'time') {
        // ISO-like YYYY-MM-DD HH:MM:SS. Allocates 2 strings; fine off the
        // per-frame path.
        const d = new Date(domainX);
        return d.toISOString().slice(0, 19).replace('T', ' ');
    }
    const n = formatNumber(domainX, _decimalsFor(domainX), _charBuf, 0);
    return charBufToString(_charBuf, n);
};

const formatTooltipValue = (v) => {
    const n = formatNumber(v, _decimalsFor(v) + 1, _charBuf, 0);
    return charBufToString(_charBuf, n);
};

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

const niceYDomain = (yMin, yMax, opts) => {
    let lo = yMin;
    let hi = yMax;
    if (opts && opts.zero) {
        if (lo > 0) lo = 0;
        if (hi < 0) hi = 0;
    }
    if (opts && opts.nice) {
        const pad = (hi - lo) * 0.05;
        lo -= pad;
        hi += pad;
    }
    if (lo === hi) {
        lo -= 0.5;
        hi += 0.5;
    }
    return [lo, hi];
};

// v1.4.0-alpha.2 -- pan + zoom math.
//
// All three helpers are pure functions of their arguments (no closure
// over chart state), defined module-level so `_testHelpers` can export
// them for white-box unit tests without pinning the entire chart kernel
// in the reachable set. The chart constructor uses them inside its
// pointer/wheel listeners; tests exercise them directly.
//
// Convention:
//   - `start` / `view` / `dataDom` are { xMin, xMax, yMin, yMax } records.
//   - Pixel space is in CSS (logical) pixels; lite-scene's setTransform
//     handles the logical->device mapping at draw time, so we don't
//     touch DPR here.
//   - The y-axis is flipped (canvas y grows downward). Pan negates dyPx;
//     zoom mirrors the anchor fraction via `1 - ty` to keep "data
//     point under cursor stays under cursor" intact.
//
// alpha.2 implements LINEAR arithmetic on the data domain. For log
// scales the math is technically wrong (it adds/scales in data space
// rather than log space) -- the chart still renders, but pan magnitude
// won't feel right and zoom centered on a log scale will skew. A
// log-aware path is a small follow-up; we want the API and the
// linear-case behavior stable first.
const _applyPan = (start, dxPx, dyPx, plotW, plotH) => {
    const dxData = dxPx * (start.xMax - start.xMin) / plotW;
    const dyData = -dyPx * (start.yMax - start.yMin) / plotH;
    return {
        xMin: start.xMin - dxData,
        xMax: start.xMax - dxData,
        yMin: start.yMin - dyData,
        yMax: start.yMax - dyData,
    };
};

const _applyZoom = (start, anchorPx, anchorPy, plotLeft, plotTop, plotW, plotH, zoomX, zoomY) => {
    // Convert anchor pixel to data via the START domain (the scale
    // we're zooming around). zoomX/zoomY < 1 means zoom in (range
    // shrinks); > 1 means zoom out.
    const tx = plotW > 0 ? (anchorPx - plotLeft) / plotW : 0.5;
    const ty = plotH > 0 ? (anchorPy - plotTop) / plotH : 0.5;
    const anchorDataX = start.xMin + tx * (start.xMax - start.xMin);
    // y is flipped: top of plot = yMax, bottom = yMin.
    const anchorDataY = start.yMax - ty * (start.yMax - start.yMin);
    return {
        xMin: anchorDataX - (anchorDataX - start.xMin) * zoomX,
        xMax: anchorDataX + (start.xMax - anchorDataX) * zoomX,
        yMin: anchorDataY - (anchorDataY - start.yMin) * zoomY,
        yMax: anchorDataY + (start.yMax - anchorDataY) * zoomY,
    };
};

const _clampToBounds = (view, dataDom) => {
    // Width and height of the proposed view.
    const vw = view.xMax - view.xMin;
    const vh = view.yMax - view.yMin;
    const dw = dataDom.xMax - dataDom.xMin;
    const dh = dataDom.yMax - dataDom.yMin;
    // x-axis: if view wider than data, snap to full data domain; else
    // shift to keep within [dataXMin, dataXMax].
    if (vw >= dw) {
        view.xMin = dataDom.xMin;
        view.xMax = dataDom.xMax;
    } else if (view.xMin < dataDom.xMin) {
        view.xMax += dataDom.xMin - view.xMin;
        view.xMin = dataDom.xMin;
    } else if (view.xMax > dataDom.xMax) {
        view.xMin -= view.xMax - dataDom.xMax;
        view.xMax = dataDom.xMax;
    }
    // y-axis: same pattern.
    if (vh >= dh) {
        view.yMin = dataDom.yMin;
        view.yMax = dataDom.yMax;
    } else if (view.yMin < dataDom.yMin) {
        view.yMax += dataDom.yMin - view.yMin;
        view.yMin = dataDom.yMin;
    } else if (view.yMax > dataDom.yMax) {
        view.yMin -= view.yMax - dataDom.yMax;
        view.yMax = dataDom.yMax;
    }
    return view;
};

// v1.4.1 (C0) -- log-aware pan / zoom.
//
// alpha.2's `_applyPan` / `_applyZoom` do LINEAR arithmetic on the data domain.
// On a log axis that is wrong: it adds/scales in DATA space, so a drag feels the
// wrong magnitude and -- worse -- a large drag or one zoom-out notch can walk a
// bound to zero or negative, at which point `Math.log` is NaN and the axis dies
// (findings LC-01..LC-03). The fix operates in LOG space: transform the bounds
// with `Math.log`, apply the SAME pixel arithmetic there, then `Math.exp` back.
// exp() is always positive, so no gesture can produce a non-positive bound.
//
// Base is irrelevant to correctness (log then its own inverse), so we use the
// natural log to match `makeLogScale`'s kernel. The decade law still holds:
// dragging d px on an n-decade axis multiplies both bounds by 10^(n*d/plotH).
//
// Per-axis flags (`xLog` / `yLog`): each axis is handled independently, so a
// linear-x / log-y chart pans correctly on both. When a flag is false the axis
// uses the EXACT linear formula from `_applyPan` / `_applyZoom`, so a mixed chart
// is byte-identical to the linear path on its linear axis. The all-linear callers
// still use `_applyPan` / `_applyZoom` unchanged (hash-parity: a linear chart's
// behaviour and cost must not move in a patch).
// The log-axis floor. A log axis "has no bottom" (LC-05 rationale), so a free
// (unbounded) pan or a long zoom-out could otherwise drift the log-space bounds
// until `Math.exp` underflows to 0 or overflows to Infinity -- re-introducing a
// non-positive / non-finite domain by a different route. exp() over
// [-690, 690] stays strictly inside [~1e-300, 1e300], so we keep both log bounds
// in that band, shifting the window to preserve its width where it fits and
// pinning to the band only when the width exceeds ~600 decades. Results go into
// module scratch to keep the pointer hot path allocation-free.
const _LOG_FLOOR = -690, _LOG_CEIL = 690;
let _expLo = 0, _expHi = 0;
const _expClampedInto = (logLo, logHi) => {
    if (!(logHi > logLo)) logHi = logLo + 1e-9;      // degenerate-width guard
    if (logLo < _LOG_FLOOR) { logHi += _LOG_FLOOR - logLo; logLo = _LOG_FLOOR; }
    if (logHi > _LOG_CEIL) { logLo -= logHi - _LOG_CEIL; logHi = _LOG_CEIL; }
    if (logLo < _LOG_FLOOR) logLo = _LOG_FLOOR;      // width > band: pin to it
    _expLo = Math.exp(logLo);
    _expHi = Math.exp(logHi);
};

const _applyPanLog = (start, dxPx, dyPx, plotW, plotH, xLog, yLog) => {
    let xMin, xMax, yMin, yMax;
    if (xLog) {
        const lx0 = Math.log(start.xMin), lx1 = Math.log(start.xMax);
        const dLog = dxPx * (lx1 - lx0) / plotW;
        _expClampedInto(lx0 - dLog, lx1 - dLog);
        xMin = _expLo; xMax = _expHi;
    } else {
        const dxData = dxPx * (start.xMax - start.xMin) / plotW;
        xMin = start.xMin - dxData;
        xMax = start.xMax - dxData;
    }
    if (yLog) {
        const ly0 = Math.log(start.yMin), ly1 = Math.log(start.yMax);
        const dLog = -dyPx * (ly1 - ly0) / plotH;
        _expClampedInto(ly0 - dLog, ly1 - dLog);
        yMin = _expLo; yMax = _expHi;
    } else {
        const dyData = -dyPx * (start.yMax - start.yMin) / plotH;
        yMin = start.yMin - dyData;
        yMax = start.yMax - dyData;
    }
    return { xMin, xMax, yMin, yMax };
};

const _applyZoomLog = (start, anchorPx, anchorPy, plotLeft, plotTop, plotW, plotH, zoomX, zoomY, xLog, yLog) => {
    const tx = plotW > 0 ? (anchorPx - plotLeft) / plotW : 0.5;
    const ty = plotH > 0 ? (anchorPy - plotTop) / plotH : 0.5;
    let xMin, xMax, yMin, yMax;
    if (xLog) {
        const lx0 = Math.log(start.xMin), lx1 = Math.log(start.xMax);
        const aLog = lx0 + tx * (lx1 - lx0);
        _expClampedInto(aLog - (aLog - lx0) * zoomX, aLog + (lx1 - aLog) * zoomX);
        xMin = _expLo; xMax = _expHi;
    } else {
        const aX = start.xMin + tx * (start.xMax - start.xMin);
        xMin = aX - (aX - start.xMin) * zoomX;
        xMax = aX + (start.xMax - aX) * zoomX;
    }
    if (yLog) {
        // y is flipped: top of plot = yMax, bottom = yMin (same as linear).
        const ly0 = Math.log(start.yMin), ly1 = Math.log(start.yMax);
        const aLog = ly1 - ty * (ly1 - ly0);
        _expClampedInto(aLog - (aLog - ly0) * zoomY, aLog + (ly1 - aLog) * zoomY);
        yMin = _expLo; yMax = _expHi;
    } else {
        const aY = start.yMax - ty * (start.yMax - start.yMin);
        yMin = aY - (aY - start.yMin) * zoomY;
        yMax = aY + (start.yMax - aY) * zoomY;
    }
    return { xMin, xMax, yMin, yMax };
};

// Log-aware clamp. `_clampToBounds` compares/shifts in DATA space; on a log axis
// that both feels wrong and cannot express a log-correct floor. This clamps each
// log axis in LOG space (snap-if-wider, else shift to keep the log-width inside
// [log(dataMin), log(dataMax)]) and leaves a linear axis to the identical linear
// logic. It is the "log-aware floor" that stops a drag walking the domain to zero
// even under a free (unbounded) pan mode.
const _clampToBoundsLog = (view, dataDom, xLog, yLog) => {
    if (xLog) {
        _clampAxisLog(view, dataDom, 'xMin', 'xMax');
    } else {
        _clampAxisLinear(view, dataDom, 'xMin', 'xMax');
    }
    if (yLog) {
        _clampAxisLog(view, dataDom, 'yMin', 'yMax');
    } else {
        _clampAxisLinear(view, dataDom, 'yMin', 'yMax');
    }
    return view;
};

const _clampAxisLinear = (view, dataDom, loKey, hiKey) => {
    const v = view[hiKey] - view[loKey];
    const d = dataDom[hiKey] - dataDom[loKey];
    if (v >= d) {
        view[loKey] = dataDom[loKey];
        view[hiKey] = dataDom[hiKey];
    } else if (view[loKey] < dataDom[loKey]) {
        view[hiKey] += dataDom[loKey] - view[loKey];
        view[loKey] = dataDom[loKey];
    } else if (view[hiKey] > dataDom[hiKey]) {
        view[loKey] -= view[hiKey] - dataDom[hiKey];
        view[hiKey] = dataDom[hiKey];
    }
};

const _clampAxisLog = (view, dataDom, loKey, hiKey) => {
    // A non-positive data bound has no log; nothing to clamp against. Leave the
    // (log-math-positive) view untouched rather than fabricate a bound.
    if (!(dataDom[loKey] > 0) || !(dataDom[hiKey] > 0)) return;
    let vLo = Math.log(view[loKey]);
    let vHi = Math.log(view[hiKey]);
    const dLo = Math.log(dataDom[loKey]);
    const dHi = Math.log(dataDom[hiKey]);
    const vw = vHi - vLo;
    const dw = dHi - dLo;
    if (vw >= dw) {
        vLo = dLo; vHi = dHi;
    } else if (vLo < dLo) {
        vHi += dLo - vLo; vLo = dLo;
    } else if (vHi > dHi) {
        vLo -= vHi - dHi; vHi = dHi;
    }
    view[loKey] = Math.exp(vLo);
    view[hiKey] = Math.exp(vHi);
};

// v1.4.0-alpha.3 -- brush math.
//
// Pure module-level helpers, exported via _testHelpers. _normalizeBrushRect
// orders a (px0, py0)-(px1, py1) drag rectangle into min/max corners.
// _brushPxToData converts a pixel-space rect to data-space bounds via
// the scale's invert. _computeBrushIds scans series xs/ys arrays for
// points falling inside the data-space rect. ids are returned in a
// freshly allocated array (not pooled -- aliasing across brushes would
// surprise users); brushing is sub-Hz, the allocation cost is in the
// noise band.
const _normalizeBrushRect = (px0, py0, px1, py1) => ({
    pxMin: Math.min(px0, px1),
    pxMax: Math.max(px0, px1),
    pyMin: Math.min(py0, py1),
    pyMax: Math.max(py0, py1),
});

const _brushPxToData = (rect, xScale, yScale) => {
    // y is flipped: pyMin (smaller pixel) maps to yMax (larger data).
    const xMin = xScale.invert(rect.pxMin);
    const xMax = xScale.invert(rect.pxMax);
    const yMax = yScale.invert(rect.pyMin);
    const yMin = yScale.invert(rect.pyMax);
    return {
        xMin: Math.min(xMin, xMax),
        xMax: Math.max(xMin, xMax),
        yMin: Math.min(yMin, yMax),
        yMax: Math.max(yMin, yMax),
    };
};

const _computeBrushIds = (xs, ys, n, xMin, xMax, yMin, yMax) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        if (x >= xMin && x <= xMax && y >= yMin && y <= yMax) {
            ids.push(i);
        }
    }
    return ids;
};

const inferXScaleType = (firstRow, xKey) => {
    if (firstRow == null) return 'linear';
    let probe;
    if (typeof xKey === 'string' || typeof xKey === 'number') {
        probe = firstRow[xKey];
    }
    if (probe instanceof Date) return 'time';
    if (typeof probe === 'number') {
        if ((xKey === 'time' || xKey === 'date' || xKey === 't') && probe >= 1e11) {
            return 'time';
        }
    }
    return 'linear';
};

// ---------------------------------------------------------------------------
// Public API: createLineChart
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Legend (DOM element, not canvas-drawn)
// ---------------------------------------------------------------------------
//
// Lives in a sibling DOM node next to the canvas. Subscribes to per-series
// visibility signals so the swatch + label dim on toggle. Click handlers
// flip the signal, which fires the domain + draw effects.
//
// Why DOM and not canvas: legend rows are interactive (click targets) and
// will eventually want accessibility (aria-pressed, keyboard nav), CSS
// theming, and -- opt-in -- windowed scrolling for series counts in
// the hundreds. All four are awkward on canvas, natural in DOM.
//
// Skipped in headless contexts (no `document`). Tests verify the visibility
// flow programmatically via chart.setSeriesVisible(idx, bool).

const buildLegendDOM = (legendOpts, normalized, seriesVisibility, seriesRefs, font, labelColor, disposers) => {
    if (typeof document === 'undefined') return null;

    const legendEl = document.createElement('div');
    legendEl.className = 'lite-charts-legend';
    legendEl.style.display = 'flex';
    legendEl.style.flexWrap = 'wrap';
    legendEl.style.gap = '12px';
    legendEl.style.padding = '8px 0';
    legendEl.style.font = font;
    legendEl.style.color = labelColor;
    legendEl.style.lineHeight = '1.4';
    legendEl.style.alignItems = 'center';

    for (let i = 0; i < normalized.length; i++) {
        const idx = i; // capture for closure

        const row = document.createElement('button');
        row.type = 'button';
        row.setAttribute('aria-pressed', 'true');
        row.style.display = 'inline-flex';
        row.style.alignItems = 'center';
        row.style.gap = '6px';
        row.style.cursor = 'pointer';
        row.style.background = 'none';
        row.style.border = 'none';
        row.style.padding = '4px 6px';
        row.style.font = 'inherit';
        row.style.color = 'inherit';
        row.style.borderRadius = '4px';

        const swatch = document.createElement('span');
        swatch.style.display = 'inline-block';
        swatch.style.width = '12px';
        swatch.style.height = '12px';
        swatch.style.borderRadius = '2px';
        swatch.style.background = seriesRefs[idx].colorRef.value;
        swatch.style.flexShrink = '0';

        const label = document.createElement('span');
        label.textContent = normalized[idx].name;

        row.appendChild(swatch);
        row.appendChild(label);

        const onClick = () => {
            seriesVisibility[idx].update((v) => !v);
        };
        row.addEventListener('click', onClick);
        disposers.push(() => row.removeEventListener('click', onClick));

        // Reactive: subscribe to the visibility signal so swatch+label dim
        // when the series is toggled off (by us, by other listeners, or
        // programmatically via chart.setSeriesVisible).
        const visDispose = effect(() => {
            const visible = seriesVisibility[idx]();
            row.setAttribute('aria-pressed', visible ? 'true' : 'false');
            row.style.opacity = visible ? '1' : '0.4';
        });
        disposers.push(visDispose);

        legendEl.appendChild(row);
    }

    return legendEl;
};

const installLegend = (target, canvas, legendEl, position) => {
    // Wrap canvas + legend in a flex container so the position controls
    // layout. We append the wrapper to the user's target (not replace it),
    // and the original target keeps the user's own classes/styles intact.
    if (typeof document === 'undefined') return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'lite-charts-wrapper';
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = position === 'top' || position === 'bottom'
        ? 'stretch'
        : 'flex-start';
    wrapper.style.flexDirection =
        position === 'top' ? 'column-reverse' :
        position === 'bottom' ? 'column' :
        position === 'left' ? 'row-reverse' :
        'row';
    wrapper.style.gap = '4px';

    // Move canvas into wrapper (it's currently a child of target).
    if (canvas.parentNode === target) target.removeChild(canvas);
    wrapper.appendChild(canvas);
    wrapper.appendChild(legendEl);
    target.appendChild(wrapper);
    return wrapper;
};

// ---------------------------------------------------------------------------
// Legend virtualization (v1.12.0) -- opt-in, adapter-driven
// ---------------------------------------------------------------------------
//
// A very tall legend (hundreds of series) puts one DOM node per series into
// layout. `legend.virtualize` hands windowing off to an external windowing
// adapter WITHOUT lite-charts importing or depending on one: the caller
// supplies a factory `(host, opts) => ({ dispose })`. Charts.js owns row
// *contents* (children, dataset, aria, color, label); the adapter owns row
// creation, positioning and height. Fail closed: every junk config THROWS at
// construction (before any signal is allocated), never a silent draw-time zero.
// null is not zero -- `legend.height: null` must NOT coerce to 0, so the
// `== null` gate is BEFORE any unary +.

const _normalizeLegendVirtualization = (legendConfigObj, legendPosition) => {
    // Only the object form of `legend` can carry `virtualize`. String / false /
    // absent forms fall through to the eager path untouched.
    if (legendConfigObj == null || typeof legendConfigObj !== 'object') return null;
    const v = legendConfigObj.virtualize;
    // Absent -> eager. `false` mirrors `shading: false` -> eager.
    if (v === undefined || v === false) return null;
    if (typeof v !== 'function') {
        const t = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
        throw new Error('lite-charts: legend.virtualize must be a function or absent, got ' + t);
    }
    let overscan = 2;
    const os = legendConfigObj.overscan;
    if (os != null) {
        if (!Number.isInteger(os) || os < 0) {
            throw new Error('lite-charts: legend.overscan must be a non-negative integer, got ' + os);
        }
        overscan = os;
    }
    // v1.15.0: top/bottom virtualize horizontally (width + itemWidth); left/right
    // vertically (height + itemHeight). The size keys are orientation-EXCLUSIVE:
    // a key belonging to the other axis is a config error (silent reinterpretation
    // would scroll the wrong way), so it THROWS -- no default, no coercion. null is
    // not zero: every == null gate is BEFORE any unary +.
    if (legendPosition === 'top' || legendPosition === 'bottom') {
        if (legendConfigObj.height != null) {
            throw new Error("lite-charts: legend.height is for position 'left'/'right'; a top/bottom legend uses legend.width");
        }
        if (legendConfigObj.itemHeight != null) {
            throw new Error("lite-charts: legend.itemHeight is for position 'left'/'right'; a top/bottom legend uses legend.itemWidth");
        }
        const w = legendConfigObj.width;
        if (w == null) {
            throw new Error('lite-charts: virtualized top/bottom legend requires a numeric legend.width');
        }
        if (!Number.isInteger(w) || w <= 0) {
            throw new Error('lite-charts: legend.width must be a positive integer, got ' + w);
        }
        const iw = legendConfigObj.itemWidth;
        if (iw == null) {
            throw new Error('lite-charts: virtualized top/bottom legend requires a numeric legend.itemWidth');
        }
        if (!Number.isInteger(iw) || iw <= 0) {
            throw new Error('lite-charts: legend.itemWidth must be a positive integer, got ' + iw);
        }
        return { orientation: 'horizontal', itemWidth: iw, width: w, overscan, factory: v };
    }
    if (legendConfigObj.width != null) {
        throw new Error("lite-charts: legend.width is for position 'top'/'bottom'; a left/right legend uses legend.height");
    }
    if (legendConfigObj.itemWidth != null) {
        throw new Error("lite-charts: legend.itemWidth is for position 'top'/'bottom'; a left/right legend uses legend.itemHeight");
    }
    // Height is REQUIRED (the scroll viewport needs a fixed box). null is not
    // zero: gate == null BEFORE any unary + so `height: null` cannot become 0.
    const h = legendConfigObj.height;
    if (h == null) {
        throw new Error('lite-charts: virtualized legend requires a numeric legend.height');
    }
    if (!Number.isInteger(h) || h <= 0) {
        throw new Error('lite-charts: legend.height must be a positive integer, got ' + h);
    }
    let itemHeight = 28;
    const ih = legendConfigObj.itemHeight;
    if (ih != null) {
        if (!Number.isInteger(ih) || ih <= 0) {
            throw new Error('lite-charts: legend.itemHeight must be a positive integer, got ' + ih);
        }
        itemHeight = ih;
    }
    return { orientation: 'vertical', itemHeight, height: h, overscan, factory: v };
};

// Builds the virtualized legend host + wires the adapter. Returns
// { legendEl, handle, repaint } or null when there is no `document`. The
// adapter calls `renderRow(rowEl, idx)` for each visible/pooled row; that
// callback re-reads BOTH color and visibility UNTRACKED every time (an element
// pooled/recycled onto a different idx must not carry stale state). ONE shared
// effect subscribes to EVERY series-visibility signal (so any writer, including
// a direct .set, triggers a repaint) and repaints only the currently-bound
// rows -- a bounded array, O(window) not O(series). ONE delegated click
// listener walks up to the element carrying data-lc-idx. Exactly 4 disposers
// are added regardless of series count.
const buildVirtualLegendDOM = (legendOpts, vspec, normalized, seriesVisibility, seriesRefs, font, labelColor, disposers) => {
    if (typeof document === 'undefined') return null;

    const legendEl = document.createElement('div');
    legendEl.className = 'lite-charts-legend lite-charts-legend-virtual';
    if (vspec.orientation === 'horizontal') {
        // Top/bottom: scroll along X, single non-wrapping row of items, fixed width.
        legendEl.style.display = 'block';
        legendEl.style.overflowX = 'auto';
        legendEl.style.overflowY = 'hidden';
        legendEl.style.whiteSpace = 'nowrap';
        legendEl.style.width = vspec.width + 'px';
        legendEl.style.position = 'relative';
        legendEl.style.padding = '0 8px';
        legendEl.style.font = font;
        legendEl.style.color = labelColor;
        legendEl.style.lineHeight = '1.4';
    } else {
        legendEl.style.display = 'block';
        legendEl.style.overflowY = 'auto';
        legendEl.style.overflowX = 'hidden';
        legendEl.style.height = vspec.height + 'px';
        legendEl.style.position = 'relative';
        legendEl.style.padding = '8px 0';
        legendEl.style.font = font;
        legendEl.style.color = labelColor;
        legendEl.style.lineHeight = '1.4';
    }

    // Bounded set of currently-rendered rows. The adapter recycles pooled
    // elements, so this length tracks the window (+overscan), never the series
    // count. First bind of an element registers it here; recycled elements
    // keep their identity and stay registered.
    const boundRows = [];

    // renderRow: adapter owns row creation/position/height; we write children
    // (once), dataset, aria, opacity, swatch bg, label text. Recycle-safe: BOTH
    // reads (visibility + color) happen UNTRACKED on every call.
    const _paintRow = (rowEl, idx) => {
        if (rowEl.childNodes.length === 0) {
            const swatch = document.createElement('span');
            swatch.style.display = 'inline-block';
            swatch.style.width = '12px';
            swatch.style.height = '12px';
            swatch.style.borderRadius = '2px';
            swatch.style.flexShrink = '0';
            const label = document.createElement('span');
            rowEl.appendChild(swatch);
            rowEl.appendChild(label);
            boundRows.push(rowEl);
        }
        rowEl.dataset.lcIdx = idx;
        rowEl.setAttribute('role', 'button');
        rowEl.setAttribute('tabindex', '0');
        // .peek() is an UNTRACKED read with no closure allocation -- an element
        // recycled onto a different idx must not carry stale visibility, and the
        // scroll hot path must not allocate a per-row untrack thunk.
        const visible = seriesVisibility[idx].peek();
        rowEl.setAttribute('aria-pressed', visible ? 'true' : 'false');
        rowEl.style.opacity = visible ? '1' : '0.4';
        rowEl.childNodes[0].style.background = seriesRefs[idx].colorRef.value;
        rowEl.childNodes[1].textContent = normalized[idx].name;
    };

    // Repaint currently-bound rows from their own data-lc-idx. Shared by the
    // visibility effect and by refreshTheme (swatch bg). Reads UNTRACKED so it
    // never adds subscriptions -- the effect owns subscription.
    const repaint = () => {
        for (let i = 0; i < boundRows.length; i++) {
            const rowEl = boundRows[i];
            const raw = rowEl.dataset.lcIdx;
            if (raw == null) continue; // null is not 0: gate before unary +
            const idx = +raw;
            if (!Number.isInteger(idx) || idx < 0 || idx >= seriesVisibility.length) continue;
            const visible = seriesVisibility[idx].peek();
            rowEl.setAttribute('aria-pressed', visible ? 'true' : 'false');
            rowEl.style.opacity = visible ? '1' : '0.4';
            rowEl.childNodes[0].style.background = seriesRefs[idx].colorRef.value;
        }
    };

    // ONE delegated click listener. Walk up to the element carrying
    // data-lc-idx; gate raw == null BEFORE +raw; require a valid integer index.
    const onClick = (ev) => {
        let node = ev.target;
        while (node && node !== legendEl) {
            if (node.dataset && node.dataset.lcIdx != null) break;
            node = node.parentNode;
        }
        if (!node || node === legendEl || !node.dataset) return;
        const raw = node.dataset.lcIdx;
        if (raw == null) return;
        const i = +raw;
        if (!Number.isInteger(i) || i < 0 || i >= seriesVisibility.length) return;
        seriesVisibility[i].update((x) => !x);
    };
    legendEl.addEventListener('click', onClick);
    const removeClick = () => legendEl.removeEventListener('click', onClick);

    // ONE shared visibility effect: subscribe to EVERY series so any writer
    // triggers a repaint, then repaint only the bound rows. Body runs sub-Hz
    // (only on a toggle), never on the scroll hot path.
    const visEffect = effect(() => {
        for (let i = 0; i < seriesVisibility.length; i++) seriesVisibility[i]();
        repaint();
    });

    const optsObj = vspec.orientation === 'horizontal'
        ? { count: normalized.length, itemWidth: vspec.itemWidth, width: vspec.width, overscan: vspec.overscan, renderRow: _paintRow, horizontal: true }
        : {
            count: normalized.length,
            itemHeight: vspec.itemHeight,
            height: vspec.height,
            overscan: vspec.overscan,
            renderRow: _paintRow,
        };
    let handle;
    try {
        handle = vspec.factory(legendEl, optsObj);
    } catch (e) {
        removeClick();
        visEffect();
        throw e;
    }
    if (!handle || typeof handle.dispose !== 'function') {
        removeClick();
        visEffect();
        throw new Error('lite-charts: legend.virtualize factory must return { dispose: function }');
    }
    disposers.push(removeClick);
    disposers.push(visEffect);
    disposers.push(() => handle.dispose());
    disposers.push(() => { boundRows.length = 0; });

    return { legendEl, handle, repaint };
};

// ---------------------------------------------------------------------------
// _wireAutoSize -- kernel-side auto-resize via ResizeObserver
// ---------------------------------------------------------------------------
//
// When the user omits `width` / `height` from config, the kernel creates
// internal signals (`widthAutoSig` / `heightAutoSig`) and wires them to a
// ResizeObserver on the mount container. The chart's size effect already
// tracks those signals, so resize updates propagate through the existing
// reactive graph -- no special-case code in the per-kernel mount logic.
//
// Three modes for each dimension:
//   1. Explicit static    -- `width: 800`                  -> fixed
//   2. Explicit reactive  -- `width: someSignal` or
//                            `width: () => container.x`     -> reactive
//   3. Implicit           -- omitted                       -> auto-observe
//
// Falls back gracefully when ResizeObserver isn't available (Node, ancient
// browsers): the signal keeps its default value and the chart stays at
// the fallback dimensions instead of throwing.
//
// Throttled via rAF so a single layout pass that fires ResizeObserver many
// times only triggers one re-extract. Synchronous initial read happens
// BEFORE this returns so the chart paints at the correct size on first
// frame (avoids the size "pop" of mounting at 600x400 then snapping).

const _wireAutoSize = (container, widthAutoSig, heightAutoSig, disposers) => {
    if (typeof ResizeObserver === 'undefined') return;
    if (!container) return;

    const readSize = () => {
        const w = container.clientWidth | 0;
        const h = container.clientHeight | 0;
        if (widthAutoSig && w > 0) widthAutoSig.set(w);
        if (heightAutoSig && h > 0) heightAutoSig.set(h);
    };
    readSize();  // synchronous initial read so the first paint has the right size

    let scheduled = false;
    const ro = new ResizeObserver(() => {
        if (scheduled) return;
        scheduled = true;
        const update = () => { scheduled = false; readSize(); };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(update);
        else update();
    });
    ro.observe(container);
    disposers.push(() => ro.disconnect());
};


// ===========================================================================
// SVG export (v1.3.0)
// ===========================================================================
//
// `chart.exportSVG()` mirrors what the chart paints to canvas as a static
// SVG string. The implementation uses a Canvas2D-shaped shim that records
// SVG markup instead of issuing pixel ops, then walks the existing
// `scene.root` tree the same way lite-scene's `drawNode`/`drawSelf` would
// -- so the exported SVG is geometrically identical to the canvas paint,
// minus subpixel rasterization and DPR scaling (SVG is resolution-
// independent).
//
// Design notes worth surfacing:
//   - The shim is internal; consumers only see the string returned by
//     `chart.exportSVG()`. Future versions may expose more direct access
//     for embedding in larger SVG documents, but for now a string is the
//     stable contract.
//   - The shim does NOT replay reactive state; it walks whatever's in
//     `scene.root` at call time. Effects must have flushed -- which they
//     have by the time `mount()` returns under any reasonable schedule
//     (synchronous or rAF + microtask).
//   - Text width estimation in `measureText` is approximate (~0.55 em per
//     char). Layout heuristics that rely on exact widths (e.g. some
//     tooltips) will look the same as canvas if the chart was already
//     rendered to a real canvas first; otherwise text positioning falls
//     back to the approximation.

// Format a number for SVG output. Trims trailing zeros from non-integer
// values so the output stays compact. 1.5KB savings on a typical chart.
const _emitNumber = (n) => {
    if (n === (n | 0)) return String(n | 0);
    return n.toFixed(3).replace(/\.?0+$/, '');
};

// Escape attribute / text content. Charts never produce `<`, `>`, `&` in
// user data, but defensive escaping is cheap and prevents broken SVG if a
// label happens to contain HTML-significant characters.
const _escapeXML = (s) => {
    s = String(s);
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 38) out += '&amp;';
        else if (c === 60) out += '&lt;';
        else if (c === 62) out += '&gt;';
        else if (c === 34) out += '&quot;';
        else out += s.charAt(i);
    }
    return out;
};

// Canvas2D-shaped shim that builds an SVG body. Methods/properties cover
// the subset of Canvas2D that lite-scene's `drawSelf` and the charts'
// pathNode draw callbacks actually use. Unsupported ops (drawImage,
// gradients, shadows) are silent no-ops -- none of the chart code uses
// them in v1.3.0.
class _SVGRenderingContext2D {
    constructor(width, height) {
        this._w = width;
        this._h = height;
        this._svg = '';
        this._defs = '';
        this._clipCounter = 0;
        // v1.4.0-alpha.1 (audit fix): was `this._currentPath = ''` with
        // `_currentPath += chunk` accumulating into a rope string. For a
        // 100k-point line chart the rope would balloon then flatten on
        // the `<path d="...">` attribute read in stroke()/fill(),
        // potentially hitting `RangeError: Invalid string length`.
        // Array-of-chunks + `.join('')` is the textbook fix: arrays grow
        // amortized O(1), the join flattens to a single contiguous string
        // exactly once.
        this._pathChunks = [];
        this._ctm = [1, 0, 0, 1, 0, 0];
        this.fillStyle = '#000';
        this.strokeStyle = '#000';
        this.lineWidth = 1;
        this.lineCap = 'butt';
        this.lineJoin = 'miter';
        this._lineDash = [];
        this.globalAlpha = 1;
        this.font = '10px sans-serif';
        this.textAlign = 'start';
        this.textBaseline = 'alphabetic';
        this._clipPathId = null;
        this._stack = [];
    }

    // ---- State stack -------------------------------------------------
    save() {
        this._stack.push({
            ctm: this._ctm.slice(),
            fillStyle: this.fillStyle,
            strokeStyle: this.strokeStyle,
            lineWidth: this.lineWidth,
            lineCap: this.lineCap,
            lineJoin: this.lineJoin,
            lineDash: this._lineDash.slice(),
            globalAlpha: this.globalAlpha,
            font: this.font,
            textAlign: this.textAlign,
            textBaseline: this.textBaseline,
            clipPathId: this._clipPathId,
        });
    }
    restore() {
        const s = this._stack.pop();
        if (!s) return;
        this._ctm = s.ctm;
        this.fillStyle = s.fillStyle;
        this.strokeStyle = s.strokeStyle;
        this.lineWidth = s.lineWidth;
        this.lineCap = s.lineCap;
        this.lineJoin = s.lineJoin;
        this._lineDash = s.lineDash;
        this.globalAlpha = s.globalAlpha;
        this.font = s.font;
        this.textAlign = s.textAlign;
        this.textBaseline = s.textBaseline;
        this._clipPathId = s.clipPathId;
    }

    // ---- Transforms (CTM tracking, not emitted per-element) ----------
    _t(x, y) {
        const m = this._ctm;
        return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }
    translate(dx, dy) {
        const m = this._ctm;
        m[4] += m[0] * dx + m[2] * dy;
        m[5] += m[1] * dx + m[3] * dy;
    }
    scale(sx, sy) {
        const m = this._ctm;
        m[0] *= sx; m[1] *= sx;
        m[2] *= sy; m[3] *= sy;
    }
    rotate(theta) {
        const m = this._ctm;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const a =  m[0] * cos + m[2] * sin;
        const b =  m[1] * cos + m[3] * sin;
        const c = -m[0] * sin + m[2] * cos;
        const d = -m[1] * sin + m[3] * cos;
        m[0] = a; m[1] = b; m[2] = c; m[3] = d;
    }
    setTransform(a, b, c, d, e, f) { this._ctm = [a, b, c, d, e, f]; }
    resetTransform() { this._ctm = [1, 0, 0, 1, 0, 0]; }

    // ---- Paths -------------------------------------------------------
    // v1.4.0-alpha.1 (audit fix): every path command pushes into the
    // shared `_pathChunks` array. `_pathD()` joins exactly once when
    // stroke/fill/clip needs the d-attribute string. beginPath() resets
    // by truncating the array length (in-place; no realloc).
    _pathD() { return this._pathChunks.join(''); }
    beginPath() { this._pathChunks.length = 0; }
    closePath() { this._pathChunks.push('Z'); }
    moveTo(x, y) {
        const [px, py] = this._t(x, y);
        this._pathChunks.push('M', _emitNumber(px), ' ', _emitNumber(py));
    }
    lineTo(x, y) {
        const [px, py] = this._t(x, y);
        this._pathChunks.push('L', _emitNumber(px), ' ', _emitNumber(py));
    }
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
        const [a, b] = this._t(c1x, c1y);
        const [c, d] = this._t(c2x, c2y);
        const [e, f] = this._t(x, y);
        this._pathChunks.push('C',
            _emitNumber(a), ' ', _emitNumber(b), ' ',
            _emitNumber(c), ' ', _emitNumber(d), ' ',
            _emitNumber(e), ' ', _emitNumber(f));
    }
    quadraticCurveTo(cx, cy, x, y) {
        const [a, b] = this._t(cx, cy);
        const [c, d] = this._t(x, y);
        this._pathChunks.push('Q',
            _emitNumber(a), ' ', _emitNumber(b), ' ',
            _emitNumber(c), ' ', _emitNumber(d));
    }
    rect(x, y, w, h) {
        // Path-form rect (the form drawSelf's "rect" kind uses before fill/stroke)
        const [a, b] = this._t(x, y);
        const [c, d] = this._t(x + w, y);
        const [e, f] = this._t(x + w, y + h);
        const [g, hh] = this._t(x, y + h);
        this._pathChunks.push(
            'M', _emitNumber(a), ' ', _emitNumber(b),
            'L', _emitNumber(c), ' ', _emitNumber(d),
            'L', _emitNumber(e), ' ', _emitNumber(f),
            'L', _emitNumber(g), ' ', _emitNumber(hh),
            'Z');
    }
    arc(cx, cy, r, startAngle, endAngle, anticlockwise) {
        // Approximate uniform scale (no skew) for the radius. All chart code
        // satisfies this; lite-scene's transforms are translate / rotate /
        // uniform-or-axis-aligned-scale only.
        const m = this._ctm;
        const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
        const sy = Math.sqrt(m[2] * m[2] + m[3] * m[3]);
        const rxs = r * sx;
        const rys = r * sy;
        const delta = endAngle - startAngle;
        if (Math.abs(delta) >= 2 * Math.PI - 1e-6) {
            // Full circle: two half arcs since SVG can't draw 360 with one A.
            const [sX, sY] = this._t(cx + r * Math.cos(startAngle), cy + r * Math.sin(startAngle));
            const [eX, eY] = this._t(cx + r * Math.cos(startAngle + Math.PI), cy + r * Math.sin(startAngle + Math.PI));
            this._pathChunks.push(
                'M', _emitNumber(sX), ' ', _emitNumber(sY),
                'A', _emitNumber(rxs), ' ', _emitNumber(rys), ' 0 1 1 ', _emitNumber(eX), ' ', _emitNumber(eY),
                'A', _emitNumber(rxs), ' ', _emitNumber(rys), ' 0 1 1 ', _emitNumber(sX), ' ', _emitNumber(sY));
        } else {
            const [sX, sY] = this._t(cx + r * Math.cos(startAngle), cy + r * Math.sin(startAngle));
            const [eX, eY] = this._t(cx + r * Math.cos(endAngle), cy + r * Math.sin(endAngle));
            const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
            const sweep = anticlockwise ? 0 : 1;
            // Continuation vs fresh sub-path: if path is empty, this is the
            // start point (M); otherwise the arc continues from the previous
            // endpoint (L bridges to the arc's start).
            if (this._pathChunks.length === 0) {
                this._pathChunks.push('M', _emitNumber(sX), ' ', _emitNumber(sY));
            } else {
                this._pathChunks.push('L', _emitNumber(sX), ' ', _emitNumber(sY));
            }
            this._pathChunks.push('A',
                _emitNumber(rxs), ' ', _emitNumber(rys), ' 0 ',
                String(largeArc), ' ', String(sweep), ' ',
                _emitNumber(eX), ' ', _emitNumber(eY));
        }
    }
    arcTo(x1, y1, x2, y2, _r) {
        // Approximate: lineTo each point. The arcTo fallback in bar's
        // rounded-corner code only invokes this with small r, so the visual
        // difference between an arc and two short line segments is invisible
        // at typical bar widths. Bar's primary path uses `roundRect`, not
        // `arcTo`, so this only matters for canvas backends without
        // native `roundRect`.
        const [p1x, p1y] = this._t(x1, y1);
        const [p2x, p2y] = this._t(x2, y2);
        this._pathChunks.push(
            'L', _emitNumber(p1x), ' ', _emitNumber(p1y),
            'L', _emitNumber(p2x), ' ', _emitNumber(p2y));
    }
    roundRect(x, y, w, h, r) {
        let rTL, rTR, rBR, rBL;
        if (Array.isArray(r)) {
            rTL = +r[0] || 0; rTR = +r[1] || 0; rBR = +r[2] || 0; rBL = +r[3] || 0;
        } else {
            rTL = rTR = rBR = rBL = +r || 0;
        }
        const maxR = Math.min(w, h) / 2;
        if (rTL > maxR) rTL = maxR;
        if (rTR > maxR) rTR = maxR;
        if (rBR > maxR) rBR = maxR;
        if (rBL > maxR) rBL = maxR;
        // Approximate scale factor for the arc radii after CTM.
        const m = this._ctm;
        const scl = Math.sqrt(m[0] * m[0] + m[1] * m[1]);
        const chunks = this._pathChunks;
        // Inline point emission (was a closure; pushed straight into chunks
        // here so rounded-rect emission stays alloc-light even on bars with
        // hundreds of rounded corners).
        const pushP = (px, py) => {
            const [a, b] = this._t(px, py);
            chunks.push(_emitNumber(a), ' ', _emitNumber(b));
        };
        chunks.push('M'); pushP(x + rTL, y);
        chunks.push('L'); pushP(x + w - rTR, y);
        if (rTR > 0) {
            chunks.push('A', _emitNumber(rTR * scl), ' ', _emitNumber(rTR * scl), ' 0 0 1 ');
            pushP(x + w, y + rTR);
        }
        chunks.push('L'); pushP(x + w, y + h - rBR);
        if (rBR > 0) {
            chunks.push('A', _emitNumber(rBR * scl), ' ', _emitNumber(rBR * scl), ' 0 0 1 ');
            pushP(x + w - rBR, y + h);
        }
        chunks.push('L'); pushP(x + rBL, y + h);
        if (rBL > 0) {
            chunks.push('A', _emitNumber(rBL * scl), ' ', _emitNumber(rBL * scl), ' 0 0 1 ');
            pushP(x, y + h - rBL);
        }
        chunks.push('L'); pushP(x, y + rTL);
        if (rTL > 0) {
            chunks.push('A', _emitNumber(rTL * scl), ' ', _emitNumber(rTL * scl), ' 0 0 1 ');
            pushP(x + rTL, y);
        }
        chunks.push('Z');
    }

    // ---- Stroke / fill (path-based) ----------------------------------
    _commonAttrs() {
        let s = '';
        if (this.globalAlpha < 1) s += ' opacity="' + _emitNumber(this.globalAlpha) + '"';
        if (this._clipPathId) s += ' clip-path="url(#' + this._clipPathId + ')"';
        return s;
    }
    stroke() {
        if (this._pathChunks.length === 0) return;
        const d = this._pathD();
        let attrs = ' d="' + d + '" fill="none"';
        attrs += ' stroke="' + _escapeXML(this.strokeStyle) + '"';
        attrs += ' stroke-width="' + _emitNumber(this.lineWidth) + '"';
        if (this.lineCap !== 'butt') attrs += ' stroke-linecap="' + this.lineCap + '"';
        if (this.lineJoin !== 'miter') attrs += ' stroke-linejoin="' + this.lineJoin + '"';
        if (this._lineDash.length) attrs += ' stroke-dasharray="' + this._lineDash.join(',') + '"';
        attrs += this._commonAttrs();
        this._svg += '<path' + attrs + '/>';
    }
    fill() {
        if (this._pathChunks.length === 0) return;
        const d = this._pathD();
        let attrs = ' d="' + d + '" stroke="none"';
        attrs += ' fill="' + _escapeXML(this.fillStyle) + '"';
        attrs += this._commonAttrs();
        this._svg += '<path' + attrs + '/>';
    }

    // ---- Direct rect/text emission -----------------------------------
    // For axis-aligned transforms we emit `<rect>` and `<text>` directly
    // instead of going through path -- smaller output, slightly easier
    // for downstream tooling to interpret.
    _axisAligned() {
        const m = this._ctm;
        // CTM has no rotation/skew if (m[1] === 0 && m[2] === 0).
        return m[1] === 0 && m[2] === 0;
    }
    fillRect(x, y, w, h) {
        if (this._axisAligned()) {
            const [px, py] = this._t(x, y);
            const [px2, py2] = this._t(x + w, y + h);
            const rx = Math.min(px, px2), ry = Math.min(py, py2);
            const rw = Math.abs(px2 - px), rh = Math.abs(py2 - py);
            let attrs = ' x="' + _emitNumber(rx) + '" y="' + _emitNumber(ry) + '"';
            attrs += ' width="' + _emitNumber(rw) + '" height="' + _emitNumber(rh) + '"';
            attrs += ' fill="' + _escapeXML(this.fillStyle) + '"';
            attrs += this._commonAttrs();
            this._svg += '<rect' + attrs + '/>';
        } else {
            // Rotated transform: emit as <path>. Swap chunks arrays so the
            // rect path doesn't pollute whatever path the caller had been
            // building. The fresh `[]` is a small allocation but this branch
            // is rare (chart code only rotates pie slices + radar polygons,
            // not rects).
            const saved = this._pathChunks;
            this._pathChunks = [];
            this.rect(x, y, w, h);
            this.fill();
            this._pathChunks = saved;
        }
    }
    strokeRect(x, y, w, h) {
        if (this._axisAligned()) {
            const [px, py] = this._t(x, y);
            const [px2, py2] = this._t(x + w, y + h);
            const rx = Math.min(px, px2), ry = Math.min(py, py2);
            const rw = Math.abs(px2 - px), rh = Math.abs(py2 - py);
            let attrs = ' x="' + _emitNumber(rx) + '" y="' + _emitNumber(ry) + '"';
            attrs += ' width="' + _emitNumber(rw) + '" height="' + _emitNumber(rh) + '" fill="none"';
            attrs += ' stroke="' + _escapeXML(this.strokeStyle) + '" stroke-width="' + _emitNumber(this.lineWidth) + '"';
            if (this._lineDash.length) attrs += ' stroke-dasharray="' + this._lineDash.join(',') + '"';
            attrs += this._commonAttrs();
            this._svg += '<rect' + attrs + '/>';
        } else {
            const saved = this._pathChunks;
            this._pathChunks = [];
            this.rect(x, y, w, h);
            this.stroke();
            this._pathChunks = saved;
        }
    }
    clearRect() { /* SVG default is transparent; no-op */ }

    // ---- Text --------------------------------------------------------
    fillText(text, x, y) { this._emitText(text, x, y, false); }
    strokeText(text, x, y) { this._emitText(text, x, y, true); }
    _emitText(text, x, y, stroke) {
        const [px, py] = this._t(x, y);
        const [size, family] = this._parseFont(this.font);
        const anchor = this._textAnchor();
        const baseline = this._textBaseline();
        let attrs = ' x="' + _emitNumber(px) + '" y="' + _emitNumber(py) + '"';
        attrs += ' font-family="' + _escapeXML(family) + '"';
        attrs += ' font-size="' + size + '"';
        if (stroke) {
            attrs += ' fill="none" stroke="' + _escapeXML(this.strokeStyle) + '"';
            attrs += ' stroke-width="' + _emitNumber(this.lineWidth) + '"';
        } else {
            attrs += ' fill="' + _escapeXML(this.fillStyle) + '"';
        }
        attrs += ' text-anchor="' + anchor + '"';
        attrs += ' dominant-baseline="' + baseline + '"';
        attrs += this._commonAttrs();
        this._svg += '<text' + attrs + '>' + _escapeXML(text) + '</text>';
    }
    measureText(text) {
        const [size] = this._parseFont(this.font);
        return { width: text.length * size * 0.55 };
    }
    _parseFont(font) {
        // "13px sans-serif" or "bold 12px 'Helvetica Neue', sans-serif"
        const m = font.match(/(\d+(?:\.\d+)?)px\s+(.+)/);
        if (m) return [+m[1], m[2]];
        return [10, font];
    }
    _textAnchor() {
        switch (this.textAlign) {
            case 'right': case 'end': return 'end';
            case 'center': return 'middle';
        }
        return 'start';
    }
    _textBaseline() {
        switch (this.textBaseline) {
            case 'top': case 'hanging': return 'hanging';
            case 'middle': return 'central';
            case 'bottom': case 'ideographic': return 'text-after-edge';
        }
        return 'alphabetic';
    }

    // ---- Line dash ---------------------------------------------------
    setLineDash(dash) { this._lineDash = Array.isArray(dash) ? dash.slice() : []; }
    getLineDash() { return this._lineDash.slice(); }

    // ---- Clipping ----------------------------------------------------
    clip() {
        if (this._pathChunks.length === 0) return;
        const id = '_lc-clip' + (++this._clipCounter);
        this._defs += '<clipPath id="' + id + '"><path d="' + this._pathD() + '"/></clipPath>';
        this._clipPathId = id;
    }

    // ---- No-op stubs -------------------------------------------------
    drawImage() { /* not used by any chart in v1.3.0 */ }
    createLinearGradient() { return this.strokeStyle; }
    createRadialGradient() { return this.strokeStyle; }

    // ---- Output ------------------------------------------------------
    toSVG(background) {
        const bg = background
            ? '<rect width="' + this._w + '" height="' + this._h + '" fill="' + _escapeXML(background) + '"/>'
            : '';
        const defs = this._defs ? '<defs>' + this._defs + '</defs>' : '';
        return '<svg xmlns="http://www.w3.org/2000/svg" '
            + 'width="' + this._w + '" height="' + this._h + '" '
            + 'viewBox="0 0 ' + this._w + ' ' + this._h + '">'
            + defs + bg + this._svg + '</svg>';
    }
}

// Mirror of lite-scene's `drawNode` walker, using the same Canvas2D
// surface so the shim above transparently produces SVG instead of pixels.
// Kept in sync structurally with lite-scene's drawNode at v1.x; any
// change there (new node kind, new transform property) needs a matching
// branch here.
const _drawNodeToSVG = (ctx, n) => {
    if (!n._visible || n._opacity === 0) return;
    ctx.save();
    if (n._x !== 0 || n._y !== 0) ctx.translate(n._x, n._y);
    if (n._rotation !== 0) ctx.rotate(n._rotation);
    if (n._scaleX !== 1 || n._scaleY !== 1) ctx.scale(n._scaleX, n._scaleY);
    if (n._opacity !== 1) ctx.globalAlpha *= n._opacity;

    if (n.kind === 'group' && n._clip) {
        ctx.beginPath();
        if (typeof n._clip === 'function') n._clip(ctx, n);
        else ctx.rect(0, 0, n._width, n._height);
        ctx.clip();
    }

    _drawSelfToSVG(ctx, n);
    const cs = n.children;
    for (let i = 0; i < cs.length; i++) _drawNodeToSVG(ctx, cs[i]);
    ctx.restore();
};

const _drawSelfToSVG = (ctx, n) => {
    switch (n.kind) {
        case 'rect': {
            ctx.beginPath();
            if (n._radius > 0 && ctx.roundRect) {
                const r = Math.min(n._radius, n._width / 2, n._height / 2);
                ctx.roundRect(0, 0, n._width, n._height, r);
            } else {
                ctx.rect(0, 0, n._width, n._height);
            }
            if (n._fill)   { ctx.fillStyle = n._fill;   ctx.fill(); }
            if (n._stroke) { ctx.strokeStyle = n._stroke; ctx.lineWidth = n._strokeWidth; ctx.stroke(); }
            return;
        }
        case 'circle': {
            if (n._radius <= 0) return;
            ctx.beginPath();
            ctx.arc(0, 0, n._radius, 0, Math.PI * 2);
            if (n._fill)   { ctx.fillStyle = n._fill;   ctx.fill(); }
            if (n._stroke) { ctx.strokeStyle = n._stroke; ctx.lineWidth = n._strokeWidth; ctx.stroke(); }
            return;
        }
        case 'line': {
            if (!n._stroke) return;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(n._dx, n._dy);
            ctx.strokeStyle = n._stroke;
            ctx.lineWidth = n._strokeWidth;
            ctx.stroke();
            return;
        }
        case 'text': {
            ctx.font = n._font;
            ctx.textAlign = n._align;
            ctx.textBaseline = n._baseline;
            if (n._fill)   { ctx.fillStyle = n._fill;   ctx.fillText(n._text, 0, 0); }
            if (n._stroke) { ctx.strokeStyle = n._stroke; ctx.lineWidth = n._strokeWidth; ctx.strokeText(n._text, 0, 0); }
            return;
        }
        case 'path': {
            if (n._draw) n._draw(ctx, n);
            return;
        }
        // group / image: no self-draw (image not supported in SVG export v1.3.0)
    }
};

// Entry point shared by every kernel's `chart.exportSVG()`. Takes the live
// scene + the chart's logical width/height (canvas-space, not DPR-scaled)
// and an optional background color.
const _exportSceneToSVG = (scene, width, height, background) => {
    if (!scene || !scene.root) {
        throw new Error('lite-charts: exportSVG() requires a mounted chart');
    }
    const ctx = new _SVGRenderingContext2D(width, height);
    _drawNodeToSVG(ctx, scene.root);
    return ctx.toSVG(background);
};


// ===========================================================================
// Renderer objects -- the tree-shake boundary
// ===========================================================================
//
// Each chart factory is `(config) => createBaseAxisChart(config, RENDERER)`.
// The base implementation calls renderer methods polymorphically and never
// references any specific renderer by name, so the bundler can statically
// prove which renderers are reachable from the entry import and drop the
// rest.
//
// Concretely: `import { createLineChart }` results in a bundle that
// contains LINE_RENDERER and all helpers it transitively references
// (makeLineDrawFn, _tracePath family, decimateMinMax, bisectNearest, axes,
// grid, etc.) but NOT BAR_RENDERER, makeBarDrawFn, makeBandScale, or
// buildBarAxis. Tree-shaking only works if:
//   1. Every renderer is a separate top-level `const`
//   2. Shared methods are top-level `const`s (not closures inside a renderer)
//   3. Renderer objects don't reference each other (no spread inheritance --
//      `{...LINE_RENDERER, makeDrawFn: ...}` would pin LINE_RENDERER's
//      method references in AREA_RENDERER's transitive closure)
//   4. package.json declares `"sideEffects": false`
//
// Renderer interface (see RENDERER_DOC below for full contract):
//   buildXAccessor(xKey)                                 -> Function
//   forceXType                                            -> string | null
//   createXScale(resolvedXType)                          -> Scale
//   initOpts(config)                                      -> opts | null
//   extractData(state, data, xAcc, yAcc, ctx)             -> void
//   yDefaults                                             -> { nice?, zero? }
//   updateXScale(xScale, dxMin, dxMax, rMin, rMax, ctx)   -> void
//   projectToPixels                                       -> bool
//   enableXGrid                                            -> bool
//   buildXAxis(parent, opts, ctx)                         -> { dispose }
//   makeDrawFn(state, refs, plotBoundsBox, seriesIdx, totalSeries, ctx) -> (ctx2D) => void
//   hitTest(canvasX, canvasY, primary, xScale, ctx)      -> {snapIdx, snapDomainX, snapPixelX} | null
//   drawPerSeriesMarkers                                   -> bool
//   lookupRow(state, snapIdx, snapDomainX, ctx)           -> number
//   formatTooltipHeader(snapIdx, snapDomainX, xScaleType, ctx) -> string
//
// The `ctx` parameter is a singleton object held by createBaseAxisChart;
// fields: xScale, yScale, opts, categoriesRef. Mutated in place, never
// reallocated -- safe to pass through the hot path (hitTest, lookupRow).

// Shared method implementations -- referenced by multiple renderers but
// hoisted to top level so the bundler can deduplicate them.

const _bisectHitTest = (canvasX, /*canvasY*/_cy, primary, xScale /*, ctx*/) => {
    const domainX = xScale.invert(canvasX);
    const idx = bisectNearest(primary.xs, primary.n, domainX);
    if (idx < 0) return null;
    return {
        snapIdx: idx,
        snapDomainX: primary.xs[idx],
        snapPixelX: primary.pxs[idx],
    };
};

const _bisectLookupRow = (state, snapIdx, snapDomainX /*, ctx*/) =>
    bisectNearest(state.xs, state.n, snapDomainX);

const _numericTooltipHeader = (snapIdx, snapDomainX, xScaleType /*, ctx*/) =>
    formatTooltipHeader(snapDomainX, xScaleType);

const _buildAxisX = (parent, opts /*, ctx*/) =>
    buildAxis(parent, { orientation: 'x', ...opts });

const _extractLineData = (state, data, xAcc, yAcc /*, ctx*/) =>
    extractSeriesData(state, data, xAcc, yAcc);

const _updateXScaleLinear = (xScale, dxMin, dxMax, rMin, rMax /*, ctx*/) =>
    updateLinearScale(xScale, dxMin, dxMax, rMin, rMax);

const _makeLineDraw = (state, refs, plotBoundsBox, seriesIdx, totalSeries, ctx) =>
    makeLineDrawFn(state, refs, plotBoundsBox);

const _makeAreaDraw = (state, refs, plotBoundsBox, seriesIdx, totalSeries, ctx) =>
    makeAreaDrawFn(state, refs, plotBoundsBox, ctx.yScale, ctx.opts);

const _initAreaOpts = (config) => ({
    baseline: config.baseline != null ? config.baseline : 0,
    stroke: config.stroke !== false,
    fillOpacityRef: { value: config.fillOpacity != null ? config.fillOpacity : 0.3 },
});

// Line renderer: numeric x, polyline draw, bisect hit detection, markers on snap.
const LINE_RENDERER = {
    buildXAccessor: buildAccessor,
    forceXType: null,
    createXScale: makeLinearScale,
    initOpts: null,
    extractData: _extractLineData,
    yDefaults: { nice: true },
    updateXScale: _updateXScaleLinear,
    projectToPixels: true,
    enableXGrid: true,
    buildXAxis: _buildAxisX,
    makeDrawFn: _makeLineDraw,
    hitTest: _bisectHitTest,
    drawPerSeriesMarkers: true,
    lookupRow: _bisectLookupRow,
    formatTooltipHeader: _numericTooltipHeader,
};

// Area renderer: same as line but with filled draw and area-specific opts.
const AREA_RENDERER = {
    buildXAccessor: buildAccessor,
    forceXType: null,
    createXScale: makeLinearScale,
    initOpts: _initAreaOpts,
    extractData: _extractLineData,
    yDefaults: { nice: true },
    updateXScale: _updateXScaleLinear,
    projectToPixels: true,
    enableXGrid: true,
    buildXAxis: _buildAxisX,
    makeDrawFn: _makeAreaDraw,
    hitTest: _bisectHitTest,
    drawPerSeriesMarkers: true,
    lookupRow: _bisectLookupRow,
    formatTooltipHeader: _numericTooltipHeader,
};

// Bar-specific renderer methods. None of these are referenced by line/area
// renderers, so they're tree-shaken when only line or area is imported.

const _initBarOpts = (config) => {
    // hoverTint: false to disable, true for default white-overlay, or an
    // explicit CSS color string. Default is a low-alpha white that reads
    // as a brightening overlay against any series color (parsing-free).
    let hoverTintValue;
    if (config.hoverTint === false || config.hoverTint === null) {
        hoverTintValue = null;
    } else if (typeof config.hoverTint === 'string') {
        hoverTintValue = config.hoverTint;
    } else {
        hoverTintValue = 'rgba(255,255,255,0.18)';
    }
    // v1.5.0: orientation. 'vertical' (default) keeps the band axis on X and
    // the value axis on Y; 'horizontal' swaps them. Resolved ONCE here into a
    // boolean the kernel reads at setup -- the per-frame draw closures never
    // consult it. Any third value fails closed at construction.
    let horizontal;
    if (config.orientation == null || config.orientation === 'vertical') {
        horizontal = false;
    } else if (config.orientation === 'horizontal') {
        horizontal = true;
    } else {
        throw new Error("lite-charts: orientation must be 'vertical' or 'horizontal', got " +
            JSON.stringify(config.orientation));
    }
    return {
        horizontal,
        baseline: config.baseline != null ? config.baseline : 0,
        paddingInner: config.paddingInner != null ? config.paddingInner : 0.15,
        paddingOuter: config.paddingOuter != null ? config.paddingOuter : 0.1,
        groupInnerPad: config.groupInnerPad != null ? config.groupInnerPad : 0.08,
        // v1.1.0
        stack: config.stack === true,
        cornerRadius: config.cornerRadius != null ? Math.max(0, +config.cornerRadius) : 0,
        hoverTintRef: { value: hoverTintValue },
    };
};

const _extractBarData = (state, data, xAcc, yAcc, ctx) =>
    extractBarSeriesData(state, data, xAcc, yAcc, ctx.categoriesRef.value);

// v1.1.0 stack pass: called by the kernel after every series has been
// extracted, before y-domain aggregation. When stacking is on, it
// computes per-series cumulative stackBottoms / stackTops and overrides
// each series' domainYMax so the y-scale ranges over the total stack.
// When stacking is off, it clears any prior stack buffers so re-renders
// after a `stack: true -> false` config flip don't keep using stale state.
const _barPostExtract = (states, ctx) => {
    if (ctx.opts.stack) {
        computeBarStacks(states, ctx.seriesVisibility, ctx.categoriesRef);
    } else {
        _clearBarStacks(states);
    }
};

const _updateXScaleBand = (xScale, dxMin, dxMax, rMin, rMax, ctx) =>
    updateBandScale(xScale, ctx.categoriesRef.value.length, rMin, rMax,
                    ctx.opts.paddingInner, ctx.opts.paddingOuter);

// The X-axis builder. Vertical bars get the categorical band axis along the
// bottom; horizontal bars get the numeric VALUE axis along the bottom (the
// band axis moves to the left, built by _buildAxisBarY). buildAxis with
// orientation:'x' already centers bottom labels.
const _buildAxisBar = (parent, opts, ctx) => {
    if (ctx.opts.horizontal) {
        return buildAxis(parent, {
            orientation: 'x',
            scale: ctx.yScale,
            plotBoundsBox: opts.plotBoundsBox,
            plotBoundsSignal: opts.plotBoundsSignal,
            scaleVersion: opts.scaleVersion,
            tickColor: opts.tickColor,
            labelColor: opts.labelColor,
            font: opts.font,
            format: 'number',
        });
    }
    return buildBarAxis(parent, {
        xBandScale: opts.scale,
        plotBoundsBox: opts.plotBoundsBox,
        plotBoundsSignal: opts.plotBoundsSignal,
        scaleVersion: opts.scaleVersion,
        tickColor: opts.tickColor,
        labelColor: opts.labelColor,
        font: opts.font,
        categoriesRef: ctx.categoriesRef,
        side: 'bottom',
    });
};

// The Y-axis builder (kernel seam renderer.buildYAxis). Vertical bars keep the
// numeric value axis (buildAxis verbatim); horizontal bars put the categorical
// band axis on the left. buildAxis ignores the 3rd (ctx) arg, so wiring this
// as buildYAxis leaves line/area/scatter/bubble untouched.
const _buildAxisBarY = (parent, opts, ctx) => {
    if (!ctx.opts.horizontal) return buildAxis(parent, opts);
    return buildBarAxis(parent, {
        xBandScale: ctx.xScale,
        plotBoundsBox: opts.plotBoundsBox,
        plotBoundsSignal: opts.plotBoundsSignal,
        scaleVersion: opts.scaleVersion,
        tickColor: opts.tickColor,
        labelColor: opts.labelColor,
        font: opts.font,
        categoriesRef: ctx.categoriesRef,
        side: 'left',
    });
};

const _makeBarDraw = (state, refs, plotBoundsBox, seriesIdx, totalSeries, ctx) =>
    (ctx.opts.horizontal ? makeHBarDrawFn : makeBarDrawFn)(state, refs, plotBoundsBox,
                  ctx.xScale, ctx.yScale,
                  seriesIdx, totalSeries,
                  ctx.opts.baseline, ctx.opts.groupInnerPad,
                  ctx.opts.cornerRadius, ctx.opts.hoverTintRef,
                  ctx.crosshairDataRef);

const _bandHitTest = (canvasX, canvasY, primary, xScale, ctx) => {
    if (ctx.categoriesRef.value.length === 0) return null;
    const idx = xScale.invert(ctx.opts.horizontal ? canvasY : canvasX);
    if (idx < 0) return null;
    return {
        snapIdx: idx,
        snapDomainX: idx,
        snapPixelX: xScale.map(idx),
    };
};

const _barLookupRow = (state, snapIdx /*, snapDomainX, ctx*/) => {
    // Scan because a series may declare a subset of the union'd categories.
    for (let r = 0; r < state.n; r++) {
        if ((state.xs[r] | 0) === snapIdx) return r;
    }
    return -1;
};

const _barTooltipHeader = (snapIdx, snapDomainX, xScaleType, ctx) =>
    snapIdx >= 0 && snapIdx < ctx.categoriesRef.value.length
        ? ctx.categoriesRef.value[snapIdx]
        : formatTooltipHeader(snapDomainX, xScaleType);

const BAR_RENDERER = {
    buildXAccessor: buildRawAccessor,
    forceXType: 'band',
    createXScale: makeBandScale,
    initOpts: _initBarOpts,
    extractData: _extractBarData,
    postExtract: _barPostExtract,  // v1.1.0: stack pass
    yDefaults: { nice: true, zero: true },
    updateXScale: _updateXScaleBand,
    projectToPixels: false,
    enableXGrid: false,
    axesSwapped: (o) => o.horizontal,   // v1.5.0: horizontal orientation
    buildXAxis: _buildAxisBar,
    buildYAxis: _buildAxisBarY,         // v1.5.0: band axis moves left when horizontal
    makeDrawFn: _makeBarDraw,
    hitTest: _bandHitTest,
    drawPerSeriesMarkers: false,
    lookupRow: _barLookupRow,
    formatTooltipHeader: _barTooltipHeader,
};

// ---------------------------------------------------------------------------
// Hit-test signature note
// ---------------------------------------------------------------------------
//
// Originally renderer.hitTest was (canvasX, primary, xScale, ctx) -- line,
// area, and bar all snap on x alone (nearest x via bisect for continuous,
// floor-divide for band). Bubble needs canvasY too (find which circle the
// cursor is inside, not which column it's nearest to). The signature is
// now (canvasX, canvasY, primary, xScale, ctx); axis-chart hit-tests that
// don't need y ignore the second argument. Kernel updated to pass canvasY.

// Hoisted hit-test helpers were defined earlier; updating their signatures
// here means a tiny rewrite. Done inline at each definition above; this
// section just declares bubble's helpers and renderer.

const _bisectHitTest_canvasY = null; // sentinel for grep -- see _bisectHitTest definition

// ---------------------------------------------------------------------------
// Bubble-specific renderer helpers
// ---------------------------------------------------------------------------
//
// Bubble lives on the axis kernel -- x and y are linear scales, plus a size
// dimension that's mapped to pixel radii. Each point is independent (no
// polyline connection), drawn as a circle whose area is proportional to the
// size value (sqrt scale, the convention from Tukey 1977 forward).
//
// State extensions on the existing seriesState struct:
//   state.rs  : Float32Array, raw size values (data units)
//   state.prs : Float32Array, pixel radii after sizeScale.map
//   state.sizeMin / state.sizeMax : value-domain bounds for this series
// These fields stay null on non-bubble series, costing zero extra memory.

// ---------------------------------------------------------------------------
// Spatial index integration (v1.2.0-alpha.0)
// ---------------------------------------------------------------------------
//
// For charts with dense point clouds (bubble, future scatter / heatmap), the
// linear-scan hit-test becomes the bottleneck once point counts pass ~1000.
// lite-charts defines a small, allocation-free interface that any spatial
// index can implement -- an injected peer, a k-d tree, a uniform grid, etc.
// The interface stays in lite-charts (so the renderers depend on nothing
// extra); the implementation is wired by the consumer via config.
//
//   type SpatialIndexFactory = (pxs, pys, n) -> SpatialIndex
//
//   interface SpatialIndex {
//     // Write up to `k` nearest indices (by pixel distance from qx, qy) into
//     // outIndices / outDistSq, filtered to points within maxDistSq.
//     // Return the count actually written (may be 0 .. k).
//     // Both output arrays are caller-owned, stable refs -- zero alloc.
//     findNearest(qx, qy, k, maxDistSq, outIndices, outDistSq) -> number
//     dispose() -> void
//   }
//
// The renderer:
//   - calls factory(pxs, pys, n) at extract time when n >= threshold;
//   - disposes the previous index before rebuilding;
//   - falls back to linear scan when n < threshold OR no factory provided.
//
// k > 1 matters for bubble specifically: with overlapping discs, the point
// whose CENTER is nearest the cursor may not be the one whose DISC contains
// the cursor (a small bubble can sit inside a large one). The renderer
// asks for the K nearest by center distance, then post-filters by disc
// containment + smallest-r tie-break -- preserving v1.0.0 visual semantics.
//
// For non-overlapping charts (scatter, heatmap cells), the same interface
// works with k = 1.

const SPATIAL_INDEX_DEFAULT_THRESHOLD = 1000;
const SPATIAL_INDEX_HIT_BUFFER_SIZE = 8;  // k for findNearest; balances
                                          //  overlap-correctness vs work

// Allocate per-state output buffers for findNearest. Sized once; reused
// across hit-tests. Called lazily at the first hit-test where an index
// exists, so non-indexed series pay nothing.
const _ensureHitBuffers = (state) => {
    if (!state._hitIndices) {
        state._hitIndices = new Int32Array(SPATIAL_INDEX_HIT_BUFFER_SIZE);
        state._hitDistSq  = new Float32Array(SPATIAL_INDEX_HIT_BUFFER_SIZE);
    }
};

// Dispose helper -- defensive against indices that don't implement dispose().
const _disposeSpatialIndex = (state) => {
    if (state.spatialIndex) {
        if (typeof state.spatialIndex.dispose === 'function') {
            state.spatialIndex.dispose();
        }
        state.spatialIndex = null;
    }
};

// ---------------------------------------------------------------------------
// Cell (Voronoi tessellation) layer integration (v1.14.0)
// ---------------------------------------------------------------------------
//
// Scatter-only. Like the spatial index, the polygon geometry is produced by an
// injected factory matching the CellIndex contract below -- lite-charts imports
// nothing. Each primary-series point owns a bbox-clipped cell; the draw layer
// walks the prebuilt packed geometry at 0 B/frame, and that geometry is rebuilt
// (cold) on every data / scale change through the same lifecycle as the index.
//
//   type CellIndexFactory = (pxs, pys, n) -> CellIndex
//
//   interface CellIndex {
//     // Write cell i's polygon, CLIPPED to the axis-aligned bbox, into outXY
//     // as interleaved [x0,y0,x1,y1,...]; return the vertex count written.
//     // 0 => absent cell (NaN site, degenerate / collinear input, or no bbox
//     // intersection). THROWS if the clipped cell needs more room than outXY
//     // holds -- never truncates. Zero allocation per call.
//     cell(i, bx0, by0, bx1, by1, outXY) -> number
//     dispose() -> void
//   }
//
// A bbox-clipped cell has at most degree+4 vertices for an interior site and
// degree+5 for a hull site; the 2 * 64-float scratch below covers every
// non-adversarial cloud, and the throw is the loud escape (surfaced fail-closed
// at mount by the cold refresh, never during paint).

// Dispose helper -- mirrors _disposeSpatialIndex; defensive against a factory
// whose facade omits dispose().
const _disposeCellIndex = (state) => {
    if (state.cellIndex) {
        if (typeof state.cellIndex.dispose === 'function') {
            state.cellIndex.dispose();
        }
        state.cellIndex = null;
    }
};

// v1.16.0: field-index disposal -- byte-identical shape to _disposeCellIndex.
// Separate handle so a cells fault and a field fault never touch each other's
// resource (the two layers build from the same pxs/pys but own distinct
// indices, distinct faults, distinct disposal).
const _disposeFieldIndex = (state) => {
    if (state.fieldIndex) {
        if (typeof state.fieldIndex.dispose === 'function') {
            state.fieldIndex.dispose();
        }
        state.fieldIndex = null;
    }
};

// Construction-time validator + one-time scratch. Returns null when no cells
// config was supplied (every downstream branch stays dead). Fails closed on a
// non-object or a missing index factory.
const _normalizeCellsSpec = (cells) => {
    if (cells == null) return null;
    if (typeof cells !== 'object') {
        throw new Error('lite-charts: cells must be an object with an index factory');
    }
    if (typeof cells.index !== 'function') {
        throw new Error('lite-charts: cells.index must be a CellIndex factory');
    }
    const colorKey = cells.colorKey != null ? cells.colorKey : null;
    return {
        index: cells.index,
        // RAW accessor -- per-point color strings (`'#ff0000'`, `'--zone-a'`,
        // `'oklch(...)'`) must not be `+v`-coerced to NaN (bubble colorKey
        // precedent). Null when omitted -> the series-fill fallback path.
        colorAccessor: colorKey != null ? buildRawAccessor(colorKey) : null,
        fillOpacity: cells.fillOpacity != null ? +cells.fillOpacity : 0.35,
        stroke: cells.stroke != null ? cells.stroke : null,
        strokeWidth: cells.strokeWidth != null ? +cells.strokeWidth : 0,
        // Caller-owned interleaved scratch, allocated ONCE here (construction,
        // cold), owned by the opts object -- never per-frame or per-cell. 2 * 64
        // floats = the documented degree+5 hull bound; cell() throws past it.
        outXY: new Float32Array(128),
    };
};

// v1.16.0 field-raster layer support.
//
// Minimal hex parser DUPLICATED into the axis kernel. The shipped
// `_parseHexColor` lives in the grid-kernel region (createBaseGridChart body),
// which the A5/A15 kernel-isolation source-region pins keep tree-shakeable out
// of a scatter-only bundle; referencing it from here would drag the whole grid
// kernel into that bundle. This ramp is built COLD (once per data/scale change
// in _scatterPostProject), never per frame, so a tiny local copy is the correct
// trade -- kernel isolation over a shared byte. Returns [r,g,b] or null.
const _fieldParseHex = (hex) => {
    if (typeof hex !== 'string' || hex.length === 0 || hex.charCodeAt(0) !== 35) return null;
    let r, g, b;
    if (hex.length === 7) {
        r = parseInt(hex.slice(1, 3), 16);
        g = parseInt(hex.slice(3, 5), 16);
        b = parseInt(hex.slice(5, 7), 16);
    } else if (hex.length === 4) {
        r = parseInt(hex.charAt(1) + hex.charAt(1), 16);
        g = parseInt(hex.charAt(2) + hex.charAt(2), 16);
        b = parseInt(hex.charAt(3) + hex.charAt(3), 16);
    } else {
        return null;
    }
    if (r !== r || g !== g || b !== b) return null;  // NaN guards
    return [r, g, b];
};

// Grid caps (brief D5): their bench measures a 64x64 grid at ~0.55 ms/sample
// on 100k points; a 256x256 grid is ~16x that. Cap the configurable grid so a
// pathological gridW/gridH cannot turn the cold sampler into a stall.
const FIELD_GRID_MIN = 8;
const FIELD_GRID_MAX = 256;
const FIELD_GRID_DEFAULT_W = 64;
const FIELD_GRID_DEFAULT_H = 48;

// v1.17.0 contour/isoline layer support.
//
// Construction-time validator for the nested `field.contours` spec. Returns null
// when absent (every downstream branch stays dead). Fires from _normalizeFieldSpec
// (pre-signal) so every throw is a construction fault, same guarantee as fieldSpec.
// Levels: a count (k levels resolved COLD strictly inside the range) or an
// explicit ascending Float64Array. Style guards fall back (never throw); a valid
// dash is copied + frozen so the hot draw never touches caller memory. Cap 32.
const _CONTOUR_MAX_LEVELS = 32;
const _normalizeContoursSpec = (contours) => {
    if (contours == null) return null;
    if (typeof contours !== 'object') {
        throw new Error('lite-charts: field.contours must be an object');
    }
    const levels = contours.levels;
    if (levels == null) {
        throw new Error('lite-charts: field.contours.levels is required (a count or an array of values)');
    }
    let levelCount = null;
    let levelValues = null;
    if (typeof levels === 'number') {
        if (!Number.isInteger(levels) || levels < 1 || levels > _CONTOUR_MAX_LEVELS) {
            throw new Error('lite-charts: field.contours.levels count must be an integer in [1, 32]');
        }
        levelCount = levels;
    } else if (Array.isArray(levels)) {
        if (levels.length === 0) {
            throw new Error('lite-charts: field.contours.levels array must not be empty');
        }
        if (levels.length > _CONTOUR_MAX_LEVELS) {
            throw new Error('lite-charts: field.contours.levels array must hold at most 32 levels');
        }
        // Validate (== null gated BEFORE any coercion), sort ascending, drop
        // exact duplicates, into a Float64Array. Out-of-range values are legal:
        // they simply produce 0 segments at runtime as the view pans.
        const sorted = new Float64Array(levels.length);
        for (let i = 0; i < levels.length; i++) {
            const e = levels[i];
            if (e == null || typeof e !== 'number' || !Number.isFinite(e)) {
                throw new Error('lite-charts: field.contours.levels entries must be finite numbers');
            }
            sorted[i] = e;
        }
        sorted.sort();
        let w = 0;
        for (let i = 0; i < sorted.length; i++) {
            if (w === 0 || sorted[i] !== sorted[w - 1]) sorted[w++] = sorted[i];
        }
        levelValues = w === sorted.length ? sorted : sorted.slice(0, w);
    } else {
        throw new Error('lite-charts: field.contours.levels must be a count or an array of numbers');
    }
    // Style fallbacks (FR3 ramp-fallback precedent -- never a throw).
    const color = typeof contours.color === 'string' ? contours.color : '#1e293b';
    let width = 1;
    if (contours.width != null) {
        const w = +contours.width;
        width = !(w > 0) ? 1 : (w > 16 ? 16 : w);
    }
    let dash = null;
    if (Array.isArray(contours.dash) && contours.dash.length > 0) {
        let valid = true;
        for (let i = 0; i < contours.dash.length; i++) {
            const d = contours.dash[i];
            if (d == null || typeof d !== 'number' || !Number.isFinite(d) || !(d > 0)) {
                valid = false;
                break;
            }
        }
        if (valid) dash = Object.freeze(contours.dash.slice());
    }
    return { levelCount, levelValues, color, width, dash };
};

// Construction-time validator + one-time scratch grid. Returns null when no
// field config was supplied (every downstream branch stays dead). Fails closed
// on a non-object spec, a missing/non-function index factory, a missing value
// source, or an out-of-caps / non-integer grid dimension. Every guard gates
// `== null` BEFORE any `+` or coercion so a null never sneaks through as 0.
const _normalizeFieldSpec = (field) => {
    if (field == null) return null;
    if (typeof field !== 'object') {
        throw new Error('lite-charts: field must be an object with an index factory');
    }
    if (typeof field.index !== 'function') {
        throw new Error('lite-charts: field.index must be a FieldIndex factory');
    }
    // value: REQUIRED numeric source (key / index / accessor). Gated == null
    // BEFORE buildAccessor so an omitted value throws loud, never resolves to a
    // silent 0. A NaN result marks a missing point -- their SoA-NaN compaction
    // drops it from the triangulation and hull.
    if (field.value == null) {
        throw new Error('lite-charts: field.value is required (a numeric key, index, or accessor)');
    }
    // gridW / gridH: == null gated FIRST (so +null === 0 never masquerades as a
    // valid tiny grid), then integer + cap check. Defaults 64 x 48.
    let gridW = FIELD_GRID_DEFAULT_W;
    let gridH = FIELD_GRID_DEFAULT_H;
    if (field.gridW != null) {
        const w = field.gridW;
        if (!Number.isInteger(w) || w < FIELD_GRID_MIN || w > FIELD_GRID_MAX) {
            throw new Error('lite-charts: field.gridW must be an integer in [8, 256]');
        }
        gridW = w;
    }
    if (field.gridH != null) {
        const h = field.gridH;
        if (!Number.isInteger(h) || h < FIELD_GRID_MIN || h > FIELD_GRID_MAX) {
            throw new Error('lite-charts: field.gridH must be an integer in [8, 256]');
        }
        gridH = h;
    }
    // Ramp: `colors: [low, high]` hex endpoints (the grid-heatmap default ramp),
    // parsed COLD to [r,g,b]; optional `colorFn(v, vMin, vMax) -> CSS string`
    // wins when supplied. Endpoints that don't parse fall back to blue-100 /
    // blue-900, matching _computeGridColors.
    const colors = Array.isArray(field.colors) ? field.colors : null;
    const lo = (colors && _fieldParseHex(colors[0])) || [219, 234, 254];  // blue-100
    const hi = (colors && _fieldParseHex(colors[1])) || [30, 58, 138];    // blue-900
    const colorFn = typeof field.colorFn === 'function' ? field.colorFn : null;
    // opacity: == null gated, default 0.5, clamped to [0, 1]; a NaN opacity
    // falls back to the default rather than poisoning globalAlpha.
    let opacity = 0.5;
    if (field.opacity != null) {
        const o = +field.opacity;
        opacity = o !== o ? 0.5 : (o < 0 ? 0 : (o > 1 ? 1 : o));
    }
    return {
        index: field.index,
        // Numeric accessor (buildAccessor: `+v`, Date -> ms, NaN passthrough).
        valueAccessor: buildAccessor(field.value),
        gridW,
        gridH,
        lo,
        hi,
        colorFn,
        opacity,
        // v1.17.0: nested contour/isoline spec (null when absent). Validated
        // here (pre-signal) so a bad contours config throws at construction.
        contours: _normalizeContoursSpec(field.contours),
    };
};


const _initBubbleOpts = (config) => {
    const sizeKey = config.size != null ? config.size : 'value';
    // v1.2.0-alpha.2: per-point color. When `colorKey` is set, each row's
    // color overrides the series fill. Null when omitted -> series color
    // path stays the v1.0.0 fast path.
    const colorKey = config.colorKey != null ? config.colorKey : null;
    return {
        sizeKey,
        sizeAccessor: buildAccessor(sizeKey),
        colorKey,
        // Use the RAW accessor here -- color strings (`'#ff0000'`, CSS vars
        // like `'--c-emerald'`, or `'oklch(...)'`) must not be `+v`-coerced
        // to NaN. buildRawAccessor returns the value untouched.
        colorAccessor: colorKey != null ? buildRawAccessor(colorKey) : null,
        minRadius: config.minRadius != null ? +config.minRadius : 4,
        maxRadius: config.maxRadius != null ? +config.maxRadius : 40,
        // 'sqrt' (default): area-proportional, eye-correct per Tukey.
        // 'linear': radius-proportional; useful when the size dimension is
        // already a radius/length quantity rather than a magnitude.
        sizeScaleType: config.sizeScale === 'linear' ? 'linear' : 'sqrt',
        strokeRef: { value: config.stroke != null ? config.stroke : '#ffffff' },
        strokeWidthRef: { value: config.strokeWidth != null ? +config.strokeWidth : 1 },
        fillOpacityRef: { value: config.fillOpacity != null ? +config.fillOpacity : 0.6 },
        // v1.2.0-alpha.0: spatial-index integration. Pass a factory matching
        // the SpatialIndexFactory contract (see notes above) to enable
        // O(log n) hit-test on dense bubble clouds. Threshold defaults to
        // 1000 -- below that, linear scan is faster than index build + query.
        spatialIndexFactory: typeof config.spatialIndex === 'function'
            ? config.spatialIndex
            : null,
        spatialIndexThreshold: config.spatialIndexThreshold != null
            ? +config.spatialIndexThreshold
            : SPATIAL_INDEX_DEFAULT_THRESHOLD,
    };
};

// Compute pixel radii from raw sizes. Area-proportional uses
// r = sqrt(rMin^2 + t * (rMax^2 - rMin^2)) -- the textbook formula
// derived from a = aMin + t*(aMax - aMin) with a = pi*r^2 (the pi cancels).
// Linear is r = rMin + t*(rMax - rMin), the simpler one-pass mapping.

const computeBubbleRadii = (state, minR, maxR, scaleType) => {
    const n = state.n;
    if (n === 0) return;
    state.prs = ensureFloat32(state.prs, n);  // handles undefined / null / undersized
    const vMin = state.sizeMin;
    const vMax = state.sizeMax;
    const span = vMax - vMin;
    const rs = state.rs;
    const prs = state.prs;
    if (span <= 0) {
        // All sizes equal -> midpoint radius (avoid div-by-zero + the visual
        // boredom of a single dot if everything's the same value).
        const mid = (minR + maxR) * 0.5;
        for (let i = 0; i < n; i++) prs[i] = mid;
        return;
    }
    if (scaleType === 'sqrt') {
        const r2Min = minR * minR;
        const r2Span = maxR * maxR - r2Min;
        for (let i = 0; i < n; i++) {
            const t = (rs[i] - vMin) / span;
            prs[i] = Math.sqrt(r2Min + t * r2Span);
        }
    } else {
        const rSpan = maxR - minR;
        for (let i = 0; i < n; i++) {
            const t = (rs[i] - vMin) / span;
            prs[i] = minR + t * rSpan;
        }
    }
};

// extractBubbleData fills state.xs / state.ys via extractSeriesData, then
// extracts the size dimension into state.rs and computes state.prs.
//
// NOTE: prs is computed per series using THAT series' own [sizeMin, sizeMax]
// domain. For consistent bubble sizing across multiple bubble series (so a
// value of 100 in series A renders the same size as in series B), the kernel
// would need a post-extract pass to unify the domain. MVP is single-series;
// see the roadmap for multi-series bubble.

const extractBubbleData = (state, data, xAcc, yAcc, ctx) => {
    extractSeriesData(state, data, xAcc, yAcc);
    if (state.n === 0) {
        state.sizeMin = 0;
        state.sizeMax = 1;
        return;
    }
    const opts = ctx.opts;
    const sizeAcc = opts.sizeAccessor;
    const n = state.n;
    state.rs = ensureFloat32(state.rs, n);

    let vMin = Infinity;
    let vMax = -Infinity;
    if (data && data.xs && data.ys && data.rs && typeof data.rs.length === 'number') {
        // SoA form with parallel size array
        const dr = data.rs;
        for (let i = 0; i < n; i++) {
            const v = +dr[i];
            const clean = v >= 0 ? v : 0;
            state.rs[i] = clean;
            if (clean < vMin) vMin = clean;
            if (clean > vMax) vMax = clean;
        }
    } else if (Array.isArray(data)) {
        for (let i = 0; i < n; i++) {
            const v = +sizeAcc(data[i], i);
            const clean = v >= 0 ? v : 0;
            state.rs[i] = clean;
            if (clean < vMin) vMin = clean;
            if (clean > vMax) vMax = clean;
        }
    } else {
        // No size data: treat as constant 1.
        for (let i = 0; i < n; i++) state.rs[i] = 1;
        vMin = 1;
        vMax = 1;
    }
    state.sizeMin = vMin === Infinity ? 0 : vMin;
    state.sizeMax = vMax === -Infinity ? 1 : vMax;

    computeBubbleRadii(state, opts.minRadius, opts.maxRadius, opts.sizeScaleType);

    // v1.2.0-alpha.2: per-point color extraction. When opts.colorAccessor
    // is set, walk the data and resolve each row's color to a concrete
    // CSS string so the draw fn can use it directly. state.cs is a plain
    // string array (no typed-array equivalent for strings) lazily allocated.
    // Skip the work entirely when colorAccessor is null -- the draw fn
    // falls back to the series fill via refs.colorRef.
    if (opts.colorAccessor && Array.isArray(data)) {
        if (!state.cs || state.cs.length < n) state.cs = new Array(n);
        const colorAcc = opts.colorAccessor;
        for (let i = 0; i < n; i++) {
            const raw = colorAcc(data[i], i);
            // resolveColor handles CSS-var (--foo) -> resolved value AND
            // returns plain colors unchanged. null / undefined preserve the
            // series-fill fallback (draw fn checks for falsy per-row).
            state.cs[i] = raw != null ? resolveColor(raw) : null;
        }
    } else if (state.cs) {
        // Drop stale per-point colors if colorKey was removed mid-session.
        state.cs = null;
    }

    // v1.2.0-alpha.0: invalidate the spatial index whenever extract runs.
    // The kernel re-projects pxs/pys AFTER this returns, so any pre-built
    // index is stale by definition. We defer the rebuild until the next
    // hit-test (lazy) -- no rebuild if the user never hovers.
    _disposeSpatialIndex(state);

    // Cache max pixel radius squared. The spatial index needs an upper
    // bound on the query distance (no bubble can contain the cursor if
    // its CENTER is more than maxR pixels away).
    let prMax = 0;
    const prs = state.prs;
    for (let i = 0; i < n; i++) {
        const r = prs[i];
        if (r > prMax) prMax = r;
    }
    state.prMaxSq = prMax * prMax;
};

// Bubble draw fn: one ctx.arc per visible point. Defensive clipping skips
// circles entirely outside the plot rect (cheap AABB test). globalAlpha is
// used for fill opacity so the stroke stays at full opacity (visual anchor
// at high bubble density).

const makeBubbleDrawFn = (state, refs, plotBoundsBox, opts) => (ctx) => {
    if (!refs.visibleRef.value) return;
    const n = state.n;
    if (n === 0) return;
    if (state.pxs === null || state.pys === null || state.prs === null) return;
    const xs = state.pxs;
    const ys = state.pys;
    const rs = state.prs;
    const cs = state.cs;  // null when colorKey unset; per-point color array otherwise
    const pb = plotBoundsBox;
    const plotL = pb.x, plotR = pb.x + pb.w;
    const plotT = pb.y, plotB = pb.y + pb.h;

    const fillColor = refs.colorRef.value;
    const strokeColor = opts.strokeRef.value;
    const strokeWidth = opts.strokeWidthRef.value;
    const fillAlpha = opts.fillOpacityRef.value;
    const doStroke = strokeWidth > 0;

    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        const r = rs[i];
        if (x !== x || y !== y || r !== r) continue;          // NaN guards
        if (x + r < plotL || x - r > plotR) continue;          // off-screen X
        if (y + r < plotT || y - r > plotB) continue;          // off-screen Y

        ctx.beginPath();
        ctx.arc(x, y, r, 0, _TWO_PI);
        ctx.globalAlpha = fillAlpha;
        // v1.2.0-alpha.2: per-point color when state.cs is populated and the
        // specific row has a color; otherwise series fill (v1.0.0 path).
        ctx.fillStyle = (cs && cs[i]) ? cs[i] : fillColor;
        ctx.fill();
        if (doStroke) {
            ctx.globalAlpha = 1;
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = strokeWidth;
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1;  // reset
};

// Bubble hit-test: smallest enclosing circle wins (in case of overlap, the
// topmost-drawn bubble at the cursor takes the hit). O(n) scan; for large
// point clouds the v1.2.0-alpha.3+ plan is to plug in @zakkster/lite-bvh
// for O(log n) lookup, but until n > ~1000 the linear scan is faster
// (cache-friendly, no tree overhead).

const _bubbleHitTest = (canvasX, canvasY, primary, /*xScale*/_xs, ctx) => {
    // v1.2.0-alpha.2: iterate all visible series, not just primary. Each
    // series has its own bubbles at different (x, y) so cross-series hit-
    // test must consider every visible state. With its own spatial index
    // per series (if applicable). The `primary` arg is kept in the signature
    // for compatibility but is no longer the only series checked.
    const states = ctx.seriesStates;
    const visibility = ctx.seriesVisibility;
    const opts = ctx.opts;
    if (!states || !visibility) {
        // Defensive fallback: ctx wiring missing for some reason. Use the
        // primary-only path (v1.0.0 behavior).
        return _bubbleHitTestSingle(canvasX, canvasY, primary, opts);
    }

    let bestIdx = -1;
    let bestSeriesIdx = -1;
    let bestR = Infinity;

    for (let s = 0; s < states.length; s++) {
        if (!visibility[s]()) continue;
        const state = states[s];
        const n = state.n;
        if (n === 0) continue;
        if (state.pxs === null || state.pys === null || state.prs === null) continue;
        const xs = state.pxs, ys = state.pys, rs = state.prs;

        if (opts.spatialIndexFactory && n >= opts.spatialIndexThreshold) {
            if (!state.spatialIndex) {
                state.spatialIndex = opts.spatialIndexFactory(xs, ys, n);
            }
            _ensureHitBuffers(state);
            const k = state.spatialIndex.findNearest(
                canvasX, canvasY,
                SPATIAL_INDEX_HIT_BUFFER_SIZE,
                state.prMaxSq,
                state._hitIndices, state._hitDistSq);
            const hitIdx = state._hitIndices;
            const hitDistSq = state._hitDistSq;
            for (let j = 0; j < k; j++) {
                const i = hitIdx[j];
                const r = rs[i];
                if (r !== r) continue;
                if (hitDistSq[j] <= r * r && r < bestR) {
                    bestR = r;
                    bestIdx = i;
                    bestSeriesIdx = s;
                }
            }
        } else {
            for (let i = 0; i < n; i++) {
                const x = xs[i], y = ys[i], r = rs[i];
                if (x !== x || y !== y || r !== r) continue;
                const dx = canvasX - x;
                const dy = canvasY - y;
                if (dx * dx + dy * dy <= r * r) {
                    if (r < bestR) {
                        bestR = r;
                        bestIdx = i;
                        bestSeriesIdx = s;
                    }
                }
            }
        }
    }

    if (bestIdx < 0) return null;
    const hitState = states[bestSeriesIdx];
    return {
        snapIdx: bestIdx,
        snapDomainX: hitState.xs[bestIdx],
        snapPixelX: hitState.pxs[bestIdx],
        snapSeriesIdx: bestSeriesIdx,
    };
};

// Single-series fallback (kept for the defensive ctx-missing path; should
// not normally execute since rendererCtx is always wired in createBaseAxisChart).
const _bubbleHitTestSingle = (canvasX, canvasY, primary, opts) => {
    const n = primary.n;
    if (n === 0) return null;
    if (primary.pxs === null || primary.pys === null || primary.prs === null) return null;
    const xs = primary.pxs, ys = primary.pys, rs = primary.prs;
    let bestIdx = -1;
    let bestR = Infinity;
    if (opts.spatialIndexFactory && n >= opts.spatialIndexThreshold) {
        if (!primary.spatialIndex) {
            primary.spatialIndex = opts.spatialIndexFactory(xs, ys, n);
        }
        _ensureHitBuffers(primary);
        const k = primary.spatialIndex.findNearest(
            canvasX, canvasY,
            SPATIAL_INDEX_HIT_BUFFER_SIZE,
            primary.prMaxSq,
            primary._hitIndices, primary._hitDistSq);
        for (let j = 0; j < k; j++) {
            const i = primary._hitIndices[j];
            const r = rs[i];
            if (r !== r) continue;
            if (primary._hitDistSq[j] <= r * r && r < bestR) {
                bestR = r;
                bestIdx = i;
            }
        }
    } else {
        for (let i = 0; i < n; i++) {
            const x = xs[i], y = ys[i], r = rs[i];
            if (x !== x || y !== y || r !== r) continue;
            const dx = canvasX - x;
            const dy = canvasY - y;
            if (dx * dx + dy * dy <= r * r) {
                if (r < bestR) { bestR = r; bestIdx = i; }
            }
        }
    }
    if (bestIdx < 0) return null;
    return {
        snapIdx: bestIdx,
        snapDomainX: primary.xs[bestIdx],
        snapPixelX: primary.pxs[bestIdx],
    };
};

// Bubble lookup is identity -- the hit-test already returned the exact row
// index for this series. (Unlike line where the cursor may be between
// points and we bisect to the nearest x.)
// v1.2.0-alpha.2: for multi-series, only the hit series produces a tooltip
// row. The crosshair's snapSeriesIdx tells us which one was hit; other
// states return -1 (excluded from the tooltip).
const _bubbleLookupRow = (state, snapIdx, _snapDomainX, ctx) => {
    const cd = ctx.crosshairDataRef;
    if (cd && cd.snapSeriesIdx >= 0 && state._stateIdx !== cd.snapSeriesIdx) {
        return -1;
    }
    return snapIdx >= 0 && snapIdx < state.n ? snapIdx : -1;
};

const _makeBubbleDraw = (state, refs, plotBoundsBox, seriesIdx, totalSeries, ctx) =>
    makeBubbleDrawFn(state, refs, plotBoundsBox, ctx.opts);

const _extractBubbleData = (state, data, xAcc, yAcc, ctx) =>
    extractBubbleData(state, data, xAcc, yAcc, ctx);

const _bubbleCleanup = (states) => {
    for (let i = 0; i < states.length; i++) {
        _disposeSpatialIndex(states[i]);
    }
};

// v1.2.0-alpha.2: global size domain across visible series. Bubble's per-
// series extract sets state.sizeMin / state.sizeMax to the SERIES's range,
// so two series with different value ranges would scale independently and
// equal raw values would render at different pixel sizes. This hook stamps
// the global (visible-series) range onto every state and re-runs
// computeBubbleRadii so equal values render equal-area regardless of which
// series. Single-series charts skip the rescale (the original computation
// is already correct).
const _bubblePostExtract = (states, ctx) => {
    const visibility = ctx.seriesVisibility;
    let visCount = 0;
    let globalMin = Infinity;
    let globalMax = -Infinity;
    for (let s = 0; s < states.length; s++) {
        if (!visibility || !visibility[s]()) continue;
        const st = states[s];
        if (st.n === 0) continue;
        visCount++;
        if (st.sizeMin < globalMin) globalMin = st.sizeMin;
        if (st.sizeMax > globalMax) globalMax = st.sizeMax;
    }
    if (visCount < 2 || globalMin === Infinity) return;

    const opts = ctx.opts;
    for (let s = 0; s < states.length; s++) {
        const st = states[s];
        if (st.n === 0) continue;
        st.sizeMin = globalMin;
        st.sizeMax = globalMax;
        computeBubbleRadii(st, opts.minRadius, opts.maxRadius, opts.sizeScaleType);
        // Recompute prMaxSq with the new radii. The spatial index was
        // already invalidated by extract; no extra dispose needed here.
        let prMax = 0;
        const prs = st.prs;
        for (let i = 0; i < st.n; i++) {
            const r = prs[i];
            if (r > prMax) prMax = r;
        }
        st.prMaxSq = prMax * prMax;
    }
};

const BUBBLE_RENDERER = {
    buildXAccessor: buildAccessor,
    forceXType: null,
    createXScale: makeLinearScale,
    initOpts: _initBubbleOpts,
    extractData: _extractBubbleData,
    postExtract: _bubblePostExtract,  // v1.2.0-alpha.2: global size domain
    yDefaults: { nice: true },
    updateXScale: _updateXScaleLinear,
    projectToPixels: true,           // x/y projection; size projection happens in extractData
    enableXGrid: true,
    buildXAxis: _buildAxisX,
    makeDrawFn: _makeBubbleDraw,
    hitTest: _bubbleHitTest,
    drawPerSeriesMarkers: false,     // the bubbles ARE the markers
    lookupRow: _bubbleLookupRow,
    formatTooltipHeader: _numericTooltipHeader,
    cleanup: _bubbleCleanup,         // v1.2.0-alpha.0: dispose spatial indices
};

// ---------------------------------------------------------------------------
// Scatter renderer (v1.2.0-alpha.1)
// ---------------------------------------------------------------------------
//
// createScatterChart is bubble's simpler sibling: every point gets the SAME
// marker size, the data has no size dimension, and the hit-test radius is a
// configurable threshold around the marker. Shares the axis kernel with
// line / area / bar / bubble; shares the spatial-index foundation from
// v1.2.0-alpha.0 (with k = 1 since scatter has no overlap concerns).
//
// What scatter does NOT do (intentionally; bubble already covers it):
//   - per-point size from data
//   - sqrt or linear size scaling
//   - smallest-on-top tie-break on overlap

const _initScatterOpts = (config) => {
    // markerSize is the pixel radius; default 4 (small enough to feel like
    // a "dot", large enough to click reliably). hitTolerance extends the
    // hit-test radius beyond the marker for easier targeting; default is
    // markerSize + 4px (caller can override).
    const markerSize = config.markerSize != null ? +config.markerSize : 4;
    // v1.14.0: hitTolerance is a number (px radius) OR the string 'nearest'
    // (fat hover -- snap to the closest point regardless of distance, capped
    // per-query at the plot diagonal in _scatterHitTest). Gate == null first
    // (+null === 0 is a finite radius, not "unset"); any other string throws.
    let hitNearest = false;
    let hitToleranceSq;
    if (config.hitTolerance == null) {
        const t = markerSize + 4;
        hitToleranceSq = t * t;
    } else if (typeof config.hitTolerance === 'string') {
        if (config.hitTolerance !== 'nearest') {
            throw new Error("lite-charts: hitTolerance must be a number or 'nearest'");
        }
        hitNearest = true;
        hitToleranceSq = 0;
    } else {
        const t = +config.hitTolerance;
        hitToleranceSq = t * t;
    }
    return {
        markerSize,
        hitNearest,
        hitToleranceSq,
        // v1.14.0: optional injected Voronoi cell layer (null when absent, so
        // every downstream branch -- draw node, refresh, extract -- is dead).
        cellsSpec: _normalizeCellsSpec(config.cells),
        // v1.16.0: optional injected interpolated field-raster layer (null when
        // absent -> every downstream branch dead). Normalized here so a bad
        // spec throws at construction, BEFORE the first _own(signal()).
        fieldSpec: _normalizeFieldSpec(config.field),
        strokeRef: { value: config.stroke != null ? config.stroke : null },
        strokeWidthRef: { value: config.strokeWidth != null ? +config.strokeWidth : 0 },
        fillOpacityRef: { value: config.fillOpacity != null ? +config.fillOpacity : 1 },
        // v1.2.0-alpha.0: same spatial-index plumbing as bubble. k = 1 in
        // findNearest because scatter has no overlap; the single nearest
        // point either is or isn't inside the hit-tolerance disc.
        spatialIndexFactory: typeof config.spatialIndex === 'function'
            ? config.spatialIndex
            : null,
        spatialIndexThreshold: config.spatialIndexThreshold != null
            ? +config.spatialIndexThreshold
            : SPATIAL_INDEX_DEFAULT_THRESHOLD,
    };
};

// Scatter extract is just extractSeriesData -- no size column to process.
// The spatial index gets disposed here on every data / scale change for the
// same lazy-rebuild reason as bubble.
const _extractScatterData = (state, data, xAcc, yAcc, ctx) => {
    extractSeriesData(state, data, xAcc, yAcc);
    _disposeSpatialIndex(state);
    // v1.14.0: the cell index rides the identical data/scale lifecycle -- the
    // kernel re-projects pxs/pys after this returns, so any prior tessellation
    // is stale. _scatterPostProject rebuilds it (cold) on the same run.
    _disposeCellIndex(state);
    // v1.16.0: the field index rides the same lifecycle and disposes here for
    // the same reason -- separate handle, so a cells refresh and a field
    // refresh never share a disposal.
    _disposeFieldIndex(state);

    // v1.14.0: per-point cell colors. When cells.colorKey is set, resolve each
    // primary-series row's color to a concrete CSS string so the cell draw can
    // use it directly (mirrors bubble's per-point color path). Null preserves
    // the series-fill fallback. Skip entirely when no colorAccessor.
    const spec = ctx.opts && ctx.opts.cellsSpec;
    if (spec && spec.colorAccessor && Array.isArray(data)) {
        const n = state.n;
        if (!state.cellColors || state.cellColors.length < n) state.cellColors = new Array(n);
        const colorAcc = spec.colorAccessor;
        for (let i = 0; i < n; i++) {
            const raw = colorAcc(data[i], i);
            state.cellColors[i] = raw != null ? resolveColor(raw) : null;
        }
    } else if (state.cellColors) {
        state.cellColors = null;
    }

    // v1.16.0: pack the field's per-point scalar values into state.zs
    // (grow-only, ORIGINAL-indexed) so the cold postProject sampler reads one
    // contiguous channel. AoS -> the value accessor per row. SoA -> a parallel
    // `data.zs` channel when present (zero-copy semantics like bubble's
    // data.rs), else the accessor against the SoA object as the row view. NaN
    // passes through untouched: their SoA-NaN compaction drops a NaN site from
    // the triangulation/hull, so a NaN z simply vanishes from the field rather
    // than pinning it to 0.
    const fspec = ctx.opts && ctx.opts.fieldSpec;
    if (fspec) {
        const n = state.n;
        state.zs = ensureFloat32(state.zs, n);
        const zs = state.zs;
        const vAcc = fspec.valueAccessor;
        if (data && data.xs && data.ys && typeof data.xs.length === 'number') {
            if (data.zs && typeof data.zs.length === 'number') {
                const dz = data.zs;
                for (let i = 0; i < n; i++) zs[i] = +dz[i];
            } else {
                for (let i = 0; i < n; i++) zs[i] = vAcc(data, i);
            }
        } else if (Array.isArray(data)) {
            for (let i = 0; i < n; i++) zs[i] = vAcc(data[i], i);
        }
    }
};

const makeScatterDrawFn = (state, refs, plotBoundsBox, opts) => (ctx) => {
    if (!refs.visibleRef.value) return;
    const n = state.n;
    if (n === 0) return;
    if (state.pxs === null || state.pys === null) return;
    const xs = state.pxs;
    const ys = state.pys;
    const pb = plotBoundsBox;
    const plotL = pb.x, plotR = pb.x + pb.w;
    const plotT = pb.y, plotB = pb.y + pb.h;
    const r = opts.markerSize;
    const r2 = r;  // used as AABB margin

    ctx.fillStyle = refs.colorRef.value;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = opts.fillOpacityRef.value;

    const strokeW = opts.strokeWidthRef.value;
    const strokeColor = strokeW > 0 && opts.strokeRef.value ? opts.strokeRef.value : null;

    for (let i = 0; i < n; i++) {
        const x = xs[i], y = ys[i];
        if (x !== x || y !== y) continue;
        // Defensive AABB clip -- skip points whose bounding square sits
        // entirely outside the plot rect.
        if (x + r2 < plotL || x - r2 > plotR || y + r2 < plotT || y - r2 > plotB) continue;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (strokeColor) {
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = strokeW;
            ctx.stroke();
        }
    }
    ctx.globalAlpha = prevAlpha;
};

// v1.14.0: cell (Voronoi) layer draw. One node per chart, UNDER the markers,
// inside the plot clip. Walks prebuilt packed geometry (state.cellStart offsets
// into state.cellXY) at 0 B/frame -- no allocation, no try/catch here (the
// overflow escape lives in the cold refresh; this body only reads arrays).
const makeScatterCellDrawFn = (state, refs, opts, ctx) => (c) => {
    if (!refs.visibleRef.value) return;
    const count = state.cellCount | 0;
    if (count === 0) return;
    const spec = opts.cellsSpec;
    const starts = state.cellStart;
    const xy = state.cellXY;
    const colors = state.cellColors;
    const pb = ctx.plotBoundsBox;
    const plotL = pb.x, plotT = pb.y;
    const plotR = pb.x + pb.w, plotB = pb.y + pb.h;

    // Plot clip. Each cell fill below opens its OWN path (that per-cell
    // beginPath is the load-bearing guard against the clip rect leaking into
    // the first fill -- proven by reversion in VC6); the beginPath here is
    // defensive only, so a future single-path batching of the fill loop
    // cannot resurrect the annotation-layer D1 SVG caveat.
    c.save();
    c.beginPath();
    c.rect(plotL, plotT, plotR - plotL, plotB - plotT);
    c.clip();
    c.beginPath();

    // Fill pass. globalAlpha carries fill opacity; per-point color when a
    // colorKey resolved one, else the series fill.
    const prevAlpha = c.globalAlpha;
    c.globalAlpha = spec.fillOpacity;
    const fallback = refs.colorRef.value;
    for (let i = 0; i < count; i++) {
        const s = starts[i];
        const e = starts[i + 1];
        if (e - s < 6) continue;  // < 3 vertices: absent / degenerate cell
        c.beginPath();
        c.moveTo(xy[s], xy[s + 1]);
        for (let k = s + 2; k < e; k += 2) c.lineTo(xy[k], xy[k + 1]);
        c.closePath();
        c.fillStyle = (colors && colors[i]) || fallback;
        c.fill();
    }
    c.globalAlpha = prevAlpha;

    // Optional boundary stroke pass (uniform color/width -- one style set).
    const sw = spec.strokeWidth;
    if (sw > 0 && spec.stroke) {
        c.strokeStyle = spec.stroke;
        c.lineWidth = sw;
        for (let i = 0; i < count; i++) {
            const s = starts[i];
            const e = starts[i + 1];
            if (e - s < 6) continue;
            c.beginPath();
            c.moveTo(xy[s], xy[s + 1]);
            for (let k = s + 2; k < e; k += 2) c.lineTo(xy[k], xy[k + 1]);
            c.closePath();
            c.stroke();
        }
    }

    // Hover highlight (D5): stroke the single cell whose index the crosshair
    // snapped to, in its own color at 2px. Free -- the crosshair version signal
    // already schedules the redraw.
    const cd = ctx.crosshairDataRef;
    if (cd && cd.visible) {
        const hi = cd.snapIdx;
        if (hi >= 0 && hi < count) {
            const s = starts[hi];
            const e = starts[hi + 1];
            if (e - s >= 6) {
                c.beginPath();
                c.moveTo(xy[s], xy[s + 1]);
                for (let k = s + 2; k < e; k += 2) c.lineTo(xy[k], xy[k + 1]);
                c.closePath();
                c.strokeStyle = (colors && colors[hi]) || fallback;
                c.lineWidth = 2;
                c.stroke();
            }
        }
    }
    c.restore();
};

// v1.16.0: field (interpolated raster) layer draw. One node per chart, UNDER
// the cells node (added before it) and the markers, inside the plot clip. Walks
// the prebuilt per-cell color-string array at 0 B/frame -- every string is
// precomputed cold in _scatterRefreshField; the loop only sets fillStyle and
// calls fillRect, skipping NaN cells (null color). exportSVG rides the same
// fillRect -> <rect> serializer the mock canvas uses, so parity is free.
const makeScatterFieldDrawFn = (state, refs, opts, ctx) => (c) => {
    if (!refs.visibleRef.value) return;
    // 0 finite cells (or no build) -> draw nothing; never trust a stale grid.
    if ((state.fieldFiniteCount | 0) === 0) return;
    const colors = state.fieldColors;
    if (colors == null) return;
    const spec = opts.fieldSpec;
    const gw = spec.gridW, gh = spec.gridH;
    const pb = ctx.plotBoundsBox;
    const plotL = pb.x, plotT = pb.y;
    const plotW = pb.w, plotH = pb.h;
    if (plotW <= 0 || plotH <= 0) return;
    // Cell -> pixel rect mapping is 1:1 (grid built over the plot rect in
    // pixels). Row 0 = top row (NO flip -- see _scatterRefreshField).
    const cw = plotW / gw;
    const ch = plotH / gh;

    // Plot clip, identical idiom to the cells layer.
    c.save();
    c.beginPath();
    c.rect(plotL, plotT, plotW, plotH);
    c.clip();
    c.beginPath();

    const prevAlpha = c.globalAlpha;
    c.globalAlpha = spec.opacity;
    for (let row = 0; row < gh; row++) {
        const base = row * gw;
        const y = plotT + row * ch;
        for (let col = 0; col < gw; col++) {
            const color = colors[base + col];
            if (color == null) continue;  // NaN / outside-hull cell: paint nothing
            c.fillStyle = color;
            c.fillRect(plotL + col * cw, y, cw, ch);
        }
    }
    c.globalAlpha = prevAlpha;
    c.restore();
};

// v1.14.0: cold cell-geometry refresh. Called from Effect 2 after projection
// (postProject seam), so pxs/pys are current. Lazily builds the injected index
// (extract disposed the prior one), then packs each point's bbox-clipped cell
// into state.cellXY with state.cellStart prefix offsets (a 0-vertex return
// writes a zero-length span -> markers, no cell). Overflow throws out of cell()
// during this cold pass; caught here, it zeroes the spans (markers draw, no
// cells -- bit-identical to the degenerate path) and records the message on ctx
// for mount()-time fail-closed surfacing. Never re-throws from the effect.
const _scatterRefreshCells = (states, ctx) => {
    const opts = ctx.opts;
    const spec = opts.cellsSpec;
    if (spec == null) return;
    ctx.cellError = null;
    // D6: primary series only (a multi-series tessellation is ill-posed).
    const primary = states[0];
    if (primary == null || primary.n === 0) {
        if (primary) primary.cellCount = 0;
        return;
    }
    const n = primary.n;
    const pxs = primary.pxs;
    const pys = primary.pys;
    if (pxs === null || pys === null) { primary.cellCount = 0; return; }

    if (!primary.cellStart || primary.cellStart.length < n + 1) {
        primary.cellStart = new Int32Array(n + 1);
    }
    if (!primary.cellXY) primary.cellXY = new Float32Array(2 * n * 8 || 64);

    const pb = ctx.plotBoundsBox;
    const bx0 = pb.x, by0 = pb.y, bx1 = pb.x + pb.w, by1 = pb.y + pb.h;
    const out = spec.outXY;
    const starts = primary.cellStart;
    let off = 0;
    try {
        if (!primary.cellIndex) primary.cellIndex = spec.index(pxs, pys, n);
        const idx = primary.cellIndex;
        for (let i = 0; i < n; i++) {
            starts[i] = off;
            const floats = idx.cell(i, bx0, by0, bx1, by1, out) * 2;
            if (floats > 0) {
                let xy = primary.cellXY;
                if (off + floats > xy.length) {
                    // Cold grow-by-double; never on the paint path.
                    let cap = xy.length || 64;
                    while (cap < off + floats) cap = cap * 2;
                    const grown = new Float32Array(cap);
                    grown.set(xy);
                    primary.cellXY = grown;
                    xy = grown;
                }
                for (let k = 0; k < floats; k++) xy[off + k] = out[k];
                off += floats;
            }
        }
        starts[n] = off;
        primary.cellCount = n;
    } catch (err) {
        // Overflow (cell() needed more than outXY holds) or any index fault:
        // fail closed to markers-only and surface at mount.
        primary.cellCount = 0;
        ctx.cellError = err && err.message
            ? err.message
            : 'lite-charts: cell index refresh failed';
    }
};

// v1.16.0: cold field (interpolated raster) refresh. Its OWN try/catch and
// ctx.fieldError so a cells fault cannot kill the field and a field fault
// cannot kill the cells -- each disposes ONLY its own handle. Lazily builds the
// injected field index (extract disposed the prior one), then ONE sampleField
// into the pooled grow-only grid, computes vMin/vMax over FINITE cells only
// (brief D4 -- a panned-out point must not pin the ramp), and precomputes the
// per-cell CSS color-string array (NaN cell -> null, painted never). NEVER
// calls interpolate. First-build faults surface at mount; later faults skip
// the field for this pass (markers/cells still draw).
const _scatterRefreshField = (states, ctx) => {
    const opts = ctx.opts;
    const spec = opts.fieldSpec;
    if (spec == null) return;
    ctx.fieldError = null;
    // D6: primary series only (a multi-series interpolation is ill-posed).
    const primary = states[0];
    if (primary == null || primary.n === 0) {
        if (primary) { primary.fieldFiniteCount = 0; primary.fieldVMin = NaN; primary.fieldVMax = NaN; }
        return;
    }
    const n = primary.n;
    const pxs = primary.pxs;
    const pys = primary.pys;
    const zs = primary.zs;
    if (pxs === null || pys === null || zs == null) {
        primary.fieldFiniteCount = 0;
        primary.fieldVMin = NaN;
        primary.fieldVMax = NaN;
        return;
    }

    const gw = spec.gridW, gh = spec.gridH;
    const total = gw * gh;
    // Pooled grow-only grid + color-string array (grid dims are fixed at
    // construction, so this allocates once and never grows in practice; the
    // >= guard keeps the pool contract uniform with the cells layer).
    if (!primary.fieldGrid || primary.fieldGrid.length < total) {
        primary.fieldGrid = new Float32Array(total);
    }
    if (!primary.fieldColors || primary.fieldColors.length < total) {
        primary.fieldColors = new Array(total);
    }
    const grid = primary.fieldGrid;
    const colors = primary.fieldColors;

    const pb = ctx.plotBoundsBox;
    // PIXEL space is y-DOWN: by0 = plotTop (the SMALLER pixel y). sampleField's
    // contract "row 0 = by0" therefore places row 0 at the TOP row -- so NO row
    // flip is needed here (the brief's +y-up flip does NOT apply: these bounds
    // are already screen-oriented and by0 < by1 holds because top < bottom).
    const bx0 = pb.x, by0 = pb.y, bx1 = pb.x + pb.w, by1 = pb.y + pb.h;
    try {
        if (!primary.fieldIndex) primary.fieldIndex = spec.index(pxs, pys, n);
        const idx = primary.fieldIndex;
        // ONE serpentine sampler pass -- never point-by-point interpolate.
        const finite = idx.sampleField(zs, gw, gh, bx0, by0, bx1, by1, grid) | 0;
        primary.fieldFiniteCount = finite;
        if (finite <= 0) {  // 0 finite cells -> draw nothing this pass
            primary.fieldVMin = NaN;
            primary.fieldVMax = NaN;
            return;
        }

        // vMin/vMax over FINITE cells only.
        let vMin = Infinity, vMax = -Infinity;
        for (let k = 0; k < total; k++) {
            const v = grid[k];
            if (v === v && v !== Infinity && v !== -Infinity) {
                if (v < vMin) vMin = v;
                if (v > vMax) vMax = v;
            }
        }
        // v1.17.0: hoisted for the contour pass (count-form level resolve reads
        // them). NaN sentinel = "no range"; the resolve guards span > 0.
        primary.fieldVMin = vMin;
        primary.fieldVMax = vMax;
        const span = vMax - vMin;
        const colorFn = spec.colorFn;
        const lo = spec.lo, hi = spec.hi;
        const lr = lo[0], lg = lo[1], lb = lo[2];
        const hr = hi[0], hg = hi[1], hb = hi[2];
        for (let k = 0; k < total; k++) {
            const v = grid[k];
            if (!(v === v) || v === Infinity || v === -Infinity) {
                colors[k] = null;  // NaN / outside-hull: painted never
                continue;
            }
            if (colorFn) {
                colors[k] = colorFn(v, vMin, vMax);
            } else {
                const t = span > 0 ? (v - vMin) / span : 0;
                const r = (lr + t * (hr - lr)) | 0;
                const g = (lg + t * (hg - lg)) | 0;
                const b = (lb + t * (hb - lb)) | 0;
                colors[k] = 'rgb(' + r + ',' + g + ',' + b + ')';
            }
        }
    } catch (err) {
        // Any field-index / sample fault: fail closed to no-field (markers and
        // cells still draw) and surface at mount. Dispose ONLY the field handle.
        primary.fieldFiniteCount = 0;
        primary.fieldVMin = NaN;
        primary.fieldVMax = NaN;
        _disposeFieldIndex(primary);
        ctx.fieldError = err && err.message
            ? err.message
            : 'lite-charts: field index refresh failed';
    }
};

// v1.17.0: cold contour/isoline refresh. A THIRD independent fault domain with
// its own try/catch + ctx.contourError. It REUSES primary.fieldIndex (the same
// TIN the field raster sampled) and therefore GATES on the field pass: a field
// fault, a null handle, or 0 finite cells SKIPS silently (contourSegTotal = 0,
// no error, no rebuild) -- rebuilding would resurrect a handle the field pass
// deliberately disposed on fault, splitting truth. The sweep is EXACT for the
// piecewise-linear TIN interpolant: for each level v, walk every triangle once,
// classify vertices by strict `z > v`, and lerp the two crossing edges into a
// per-level contiguous run in the pooled contourXY. NEVER calls interpolate.
const _scatterRefreshContours = (states, ctx) => {
    const opts = ctx.opts;
    const spec = opts.fieldSpec;
    if (spec == null || spec.contours == null) return;
    ctx.contourError = null;
    const primary = states[0];
    if (primary == null || primary.n === 0) {
        if (primary) primary.contourSegTotal = 0;
        return;
    }
    // Field-domain gate (C4): reuse the field handle, never rebuild it. A field
    // fault / null handle / 0 finite cells zeroes and returns -- no error.
    if (ctx.fieldError != null || !primary.fieldIndex || (primary.fieldFiniteCount | 0) === 0) {
        primary.contourSegTotal = 0;
        return;
    }
    const cs = spec.contours;
    // Pools: allocated once, grown never (counts/scratch) or grown-by-double
    // (contourXY). contourCounts holds per-level segment counts (32 cap).
    if (!primary.contourTriIdx) primary.contourTriIdx = new Int32Array(3);
    if (!primary.contourCounts) primary.contourCounts = new Int32Array(_CONTOUR_MAX_LEVELS);
    if (!primary.contourXY) primary.contourXY = new Float32Array(256);
    try {
        // Level resolve. Array form: normalized Float64Array as-is. Count form:
        // k levels strictly inside (fieldVMin, fieldVMax); a NaN/zero span (no
        // range) emits nothing (span > 0 guard) rather than a NaN level.
        let levelVals, levelN;
        if (cs.levelValues) {
            levelVals = cs.levelValues;
            levelN = levelVals.length;
        } else {
            const vMin = primary.fieldVMin, vMax = primary.fieldVMax;
            const span = vMax - vMin;
            if (!(span > 0)) {
                primary.contourLevelCount = 0;
                primary.contourSegTotal = 0;
                return;
            }
            const k = cs.levelCount;
            if (!primary.contourLevels) primary.contourLevels = new Float64Array(_CONTOUR_MAX_LEVELS);
            const s = primary.contourLevels;
            for (let i = 0; i < k; i++) s[i] = vMin + (i + 1) * span / (k + 1);
            levelVals = s;
            levelN = k;
        }
        const idx = primary.fieldIndex;
        const T = idx.triangleCount() | 0;
        const pxs = primary.pxs, pys = primary.pys, zs = primary.zs;
        const tri = primary.contourTriIdx;
        const counts = primary.contourCounts;
        let xy = primary.contourXY;
        let off = 0;      // float offset into contourXY (4 floats per segment)
        let segTotal = 0;
        for (let li = 0; li < levelN; li++) {
            const v = levelVals[li];
            let segCount = 0;
            for (let t = 0; t < T; t++) {
                idx.triangleVertices(t, tri);
                const ia = tri[0], ib = tri[1], ic = tri[2];
                const za = zs[ia], zb = zs[ib], zc = zs[ic];
                // Strict side rule: a vertex with z exactly v is "not above",
                // so every triangle yields exactly 0 or 2 edge crossings.
                const sa = za > v, sb = zb > v, sc = zc > v;
                if (sa === sb && sb === sc) continue;  // no crossing
                // Two edges cross (those with differing endpoint sides). Lerp is
                // safe: crossing endpoints are on strict opposite sides so the
                // denominator is never 0.
                let x0 = 0, y0 = 0, x1 = 0, y1 = 0, have = 0;
                if (sa !== sb) {
                    const tt = (v - za) / (zb - za);
                    const px = pxs[ia] + tt * (pxs[ib] - pxs[ia]);
                    const py = pys[ia] + tt * (pys[ib] - pys[ia]);
                    x0 = px; y0 = py; have = 1;
                }
                if (sb !== sc) {
                    const tt = (v - zb) / (zc - zb);
                    const px = pxs[ib] + tt * (pxs[ic] - pxs[ib]);
                    const py = pys[ib] + tt * (pys[ic] - pys[ib]);
                    if (have === 0) { x0 = px; y0 = py; have = 1; }
                    else { x1 = px; y1 = py; have = 2; }
                }
                if (have < 2 && sc !== sa) {
                    const tt = (v - zc) / (za - zc);
                    const px = pxs[ic] + tt * (pxs[ia] - pxs[ic]);
                    const py = pys[ic] + tt * (pys[ia] - pys[ic]);
                    x1 = px; y1 = py; have = 2;
                }
                if (have !== 2) continue;
                if (off + 4 > xy.length) {
                    let cap = xy.length || 256;
                    while (cap < off + 4) cap = cap * 2;
                    const grown = new Float32Array(cap);
                    grown.set(xy);
                    primary.contourXY = grown;
                    xy = grown;
                }
                xy[off] = x0; xy[off + 1] = y0; xy[off + 2] = x1; xy[off + 3] = y1;
                off += 4;
                segCount++;
            }
            counts[li] = segCount;
            segTotal += segCount;
        }
        primary.contourLevelCount = levelN;
        primary.contourSegTotal = segTotal;
    } catch (err) {
        // A contour-pass fault zeroes segments + records the message; it disposes
        // NOTHING (the field handle belongs to the field domain).
        primary.contourSegTotal = 0;
        ctx.contourError = err && err.message
            ? err.message
            : 'lite-charts: contour refresh failed';
    }
};

// Module-level frozen empty dash -- solid stroke without a per-frame `[]` alloc.
// getLineDash() ALLOCATES, so the draw never reads ambient dash: it sets its own
// and resets to this after (no layer relies on ambient dash state).
const _CONTOUR_NO_DASH = Object.freeze([]);

// v1.17.0: contour/isoline draw. One node per chart, added AFTER the field node
// and BEFORE the cells node, inside the plot clip. Walks the prebuilt per-level
// segment runs at 0 B/frame: one beginPath/stroke per level, moveTo/lineTo per
// segment. ONE color/width/dash for all levels. exportSVG parity rides the same
// moveTo/lineTo/stroke serializer the mock canvas + SVG shim use.
const makeScatterContourDrawFn = (state, refs, opts, ctx) => (c) => {
    if (!refs.visibleRef.value) return;
    if ((state.contourSegTotal | 0) === 0) return;
    const xy = state.contourXY;
    if (xy == null) return;
    const counts = state.contourCounts;
    const levelCount = state.contourLevelCount | 0;
    const spec = opts.fieldSpec.contours;
    const pb = ctx.plotBoundsBox;
    const plotL = pb.x, plotT = pb.y, plotW = pb.w, plotH = pb.h;
    if (plotW <= 0 || plotH <= 0) return;

    // Plot clip, identical idiom to the field/cells layers.
    c.save();
    c.beginPath();
    c.rect(plotL, plotT, plotW, plotH);
    c.clip();

    const prevStroke = c.strokeStyle;
    const prevWidth = c.lineWidth;
    c.strokeStyle = spec.color;
    c.lineWidth = spec.width;
    c.setLineDash(spec.dash || _CONTOUR_NO_DASH);

    let off = 0;
    for (let li = 0; li < levelCount; li++) {
        const segs = counts[li];
        if (segs === 0) continue;
        c.beginPath();
        for (let s = 0; s < segs; s++) {
            c.moveTo(xy[off], xy[off + 1]);
            c.lineTo(xy[off + 2], xy[off + 3]);
            off += 4;
        }
        c.stroke();
    }

    c.setLineDash(_CONTOUR_NO_DASH);
    c.strokeStyle = prevStroke;
    c.lineWidth = prevWidth;
    c.restore();
};

// v1.14.0 + v1.16.0 + v1.17.0: cold post-projection pass. Refreshes the cells
// layer, the field layer, then the contour layer as INDEPENDENT fault domains --
// each has its own try/catch, its own ctx error slot, and disposes only its own
// handle, so a fault in one can never suppress or corrupt the others. The
// contour pass runs AFTER the field pass so fieldVMin/fieldVMax + fieldIndex are
// current before it reads them (structural ordering, C5).
const _scatterPostProject = (states, ctx) => {
    _scatterRefreshCells(states, ctx);
    _scatterRefreshField(states, ctx);
    _scatterRefreshContours(states, ctx);
};

const _scatterHitTest = (canvasX, canvasY, primary, /*xScale*/_xs, ctx) => {
    const n = primary.n;
    if (n === 0) return null;
    if (primary.pxs === null || primary.pys === null) return null;
    const xs = primary.pxs;
    const ys = primary.pys;
    const opts = ctx.opts;
    // v1.14.0: fat hover ('nearest') caps the query at the plot diagonal
    // squared -- a finite bound that is semantically "everywhere" inside the
    // plot yet always terminates the injected index's grid walk.
    const pb = ctx.plotBoundsBox;
    const toleranceSq = opts.hitNearest ? (pb.w * pb.w + pb.h * pb.h) : opts.hitToleranceSq;

    // Spatial-index fast path -- k = 1 is enough since scatter has no
    // overlap semantics. The nearest point either is or isn't within the
    // hit-tolerance disc.
    if (opts.spatialIndexFactory && n >= opts.spatialIndexThreshold) {
        if (!primary.spatialIndex) {
            primary.spatialIndex = opts.spatialIndexFactory(xs, ys, n);
        }
        _ensureHitBuffers(primary);
        const k = primary.spatialIndex.findNearest(
            canvasX, canvasY, 1, toleranceSq,
            primary._hitIndices, primary._hitDistSq);
        if (k === 0) return null;
        const idx = primary._hitIndices[0];
        return {
            snapIdx: idx,
            snapDomainX: primary.xs[idx],
            snapPixelX: xs[idx],
        };
    }

    // Linear scan fallback. Tracks the closest point within tolerance.
    let bestIdx = -1;
    let bestDsq = toleranceSq;  // strict-less below tightens this
    for (let i = 0; i < n; i++) {
        const x = xs[i], y = ys[i];
        if (x !== x || y !== y) continue;
        const dx = canvasX - x;
        const dy = canvasY - y;
        const d = dx * dx + dy * dy;
        if (d < bestDsq) {
            bestDsq = d;
            bestIdx = i;
        }
    }
    if (bestIdx < 0) return null;
    return {
        snapIdx: bestIdx,
        snapDomainX: primary.xs[bestIdx],
        snapPixelX: xs[bestIdx],
    };
};

const _scatterLookupRow = (state, snapIdx /*, snapDomainX, ctx*/) =>
    snapIdx >= 0 && snapIdx < state.n ? snapIdx : -1;

const _makeScatterDraw = (state, refs, plotBoundsBox, /*seriesIdx*/_si, /*totalSeries*/_ts, ctx) =>
    makeScatterDrawFn(state, refs, plotBoundsBox, ctx.opts);

const _scatterCleanup = (states) => {
    // Same as bubble -- dispose spatial indices on unmount. Defensively
    // guards against indices that hold external resources. v1.14.0: cell
    // indices ride the same disposal.
    for (let i = 0; i < states.length; i++) {
        _disposeSpatialIndex(states[i]);
        _disposeCellIndex(states[i]);
        // v1.16.0: dispose the field handle + release its pooled arrays so
        // nothing outlives the chart. Separate handle from cells.
        _disposeFieldIndex(states[i]);
        states[i].fieldColors = null;
        states[i].fieldGrid = null;
        // v1.17.0: release the contour pools (they reuse the field handle, so
        // there is no separate handle to dispose -- just drop the geometry).
        states[i].contourXY = null;
        states[i].contourTriIdx = null;
        states[i].contourCounts = null;
        states[i].contourLevels = null;
    }
};

const SCATTER_RENDERER = {
    buildXAccessor: buildAccessor,
    forceXType: null,
    createXScale: makeLinearScale,
    initOpts: _initScatterOpts,
    extractData: _extractScatterData,
    postProject: _scatterPostProject,  // v1.14.0: cold cell-geometry refresh
    yDefaults: { nice: true },
    updateXScale: _updateXScaleLinear,
    projectToPixels: true,
    enableXGrid: true,
    buildXAxis: _buildAxisX,
    makeDrawFn: _makeScatterDraw,
    hitTest: _scatterHitTest,
    drawPerSeriesMarkers: false,
    lookupRow: _scatterLookupRow,
    formatTooltipHeader: _numericTooltipHeader,
    cleanup: _scatterCleanup,
};


// ===========================================================================
// Base x/y axis chart kernel
// ===========================================================================
//
// `createBaseAxisChart(config, renderer)` -- the shared scaffolding for any
// chart with X and Y axes. The line / area / bar / bubble factories pass a
// renderer object that specializes scale type, data extraction, draw fn,
// axis builder, and hit detection. Polymorphic by indirection; tree-shakeable
// because nothing here mentions specific renderers by name.

const createBaseAxisChart = (config, renderer) => {
    if (!config || typeof config !== 'object') {
        throw new Error('lite-charts: chart factories require a config object');
    }

    // v1.6.0: x-axis log scale is wired end-to-end (projection, ticks, pan/zoom,
    // draw/hit all branch on `xScale.type === 'log'`). The blanket fail-closed
    // guard from v1.4.1/C0 is gone; the narrower mutual-exclusion guards a log
    // x-scale genuinely needs (log + band x, log + time x) sit just below, after
    // accessors resolve but before any signal is allocated, so a rejected config
    // still leaks nothing.

    // -- Normalize series shape (data shorthand -> single-element series array) --
    // We pre-resolve interpolation here so an invalid mode throws at chart
    // construction, not mount. Markers stay deferred to mount because their
    // `defaultColor` field depends on the resolved CSS-var color.
    let normalized;
    if (config.series != null) {
        if (!Array.isArray(config.series)) {
            throw new Error('lite-charts: `series` must be an array');
        }
        normalized = config.series.map((s, i) => ({
            name: s.name != null ? s.name : 'series ' + i,
            dataAccessor: asAccessor(s.data),
            color: s.color != null ? s.color : (config.color != null ? config.color : DEFAULT_LINE_COLOR),
            lineWidth: s.lineWidth != null ? s.lineWidth : (config.lineWidth != null ? config.lineWidth : 1.5),
            interpolation: _resolveInterpolation(s.interpolation != null ? s.interpolation : config.interpolation),
            markers: s.markers !== undefined ? s.markers : config.markers,
        }));
    } else if (config.data != null) {
        normalized = [{
            name: config.name != null ? config.name : 'series 0',
            dataAccessor: asAccessor(config.data),
            color: config.color != null ? config.color : DEFAULT_LINE_COLOR,
            lineWidth: config.lineWidth != null ? config.lineWidth : 1.5,
            interpolation: _resolveInterpolation(config.interpolation),
            markers: config.markers,
        }];
    } else {
        throw new Error('lite-charts: chart factory requires `data` or `series`');
    }

    // -- Accessors --
    const xKey = config.x != null ? config.x : 'x';
    const yKey = config.y != null ? config.y : 'y';
    const xAccessor = renderer.buildXAccessor(xKey);
    const yAccessor = buildAccessor(yKey);

    // v1.6.0: x-log mutual-exclusion guards. A log x-scale is only meaningful on
    // a continuous numeric axis. Two combinations are contradictions, not
    // configurations, so they fail CLOSED here -- after accessors resolve (the
    // time guard probes data) but BEFORE any signal is allocated, so a rejected
    // config leaks no arena slot. (Same discipline as the y-log / horizontal
    // guards further down.)
    const _xLogRequested = !!(config.xScale && config.xScale.type === 'log');
    if (_xLogRequested) {
        // (1) band x (bar charts): x is categorical, there is no numeric domain
        // to take a logarithm of. renderer.forceXType === 'band' identifies a
        // bar renderer regardless of what the data would otherwise infer.
        if (renderer.forceXType === 'band') {
            throw new Error('lite-charts: xScale { type: \'log\' } is not compatible with a ' +
                'categorical (band) x-axis -- bar charts have no continuous x-domain; ' +
                'put the log scale on the value axis (yScale) instead');
        }
        // (2) time x: a scale is one type. If the x data is time-valued (Date or
        // an epoch-ms field), a log request contradicts the declared/inferred
        // time nature. Probe the first non-empty series, mirroring the inference
        // loop below.
        let _xLogInferred = null;
        for (let i = 0; i < normalized.length && !_xLogInferred; i++) {
            const d = untrack(normalized[i].dataAccessor);
            if (Array.isArray(d) && d.length > 0) {
                _xLogInferred = inferXScaleType(d[0], xKey);
            }
        }
        if (_xLogInferred === 'time') {
            throw new Error('lite-charts: xScale { type: \'log\' } is not compatible with ' +
                'time-valued x data -- a scale is one type; use a linear or time x-scale');
        }
    }

    // -- Dimensions (static, signal, or auto-observed from container) --
    // If width/height are omitted from config, the kernel creates internal
    // signals and wires them to a ResizeObserver on the container at mount
    // time. Explicit values (number or signal/fn) bypass auto-observation.
    const widthExplicit = config.width != null;
    const heightExplicit = config.height != null;
    // v1.2.0: signals lite-charts creates at construction time are tracked
    // in _ownedSignals; `chart.destroy()` disposes them so apps that create
    // and destroy many charts don't leak arena slots. User-supplied signals
    // (config.data, config.width when reactive, etc.) are owned by the user
    // and NEVER pushed here.
    const _ownedSignals = [];
    const _own = (s) => { _ownedSignals.push(s); return s; };

    // Chart-type-specific options bag. `null` for line; structured config for
    // area / bar / scatter / future renderers. Resolved HERE -- before the first
    // `_own(signal(...))` below -- so a construction-time validation throw (bad
    // `cells` / `hitTolerance`, etc.) fires with NOTHING attached: no owned
    // signal exists yet, so a failed construction leaks no arena slots (the
    // caller gets no chart object to destroy). Every initOpts reads only
    // `config`; chartOpts is first used at the horizontal+log check below.
    const chartOpts = renderer.initOpts ? renderer.initOpts(config) : null;

    // -- Legend config --
    // `legend: false` disables. `legend: 'top'|'bottom'|'left'|'right'` is
    // a shorthand for `{position}`. `legend: {position?, container?}` is the
    // full form. Default: bottom.
    //
    // v1.15.0: hoisted ABOVE the first `_own(signal(...))` below so a bad legend
    // config (virtualize junk, orientation-exclusive size key) throws with ZERO
    // owned signals allocated -- same fail-closed discipline as chartOpts above.
    // Precedence is deliberate: `renderer.initOpts` (chartOpts, one line up) runs
    // FIRST, so when BOTH the chart-type options and the legend are invalid the
    // initOpts error wins -- matching the v1.14.0 hoist precedent.
    let legendEnabled = config.legend !== false;
    let legendPosition = DEFAULT_LEGEND_POSITION;
    let legendContainer = null;
    if (typeof config.legend === 'string') {
        if (VALID_LEGEND_POSITIONS[config.legend]) {
            legendPosition = config.legend;
        }
    } else if (config.legend && typeof config.legend === 'object') {
        if (config.legend.position && VALID_LEGEND_POSITIONS[config.legend.position]) {
            legendPosition = config.legend.position;
        }
        if (config.legend.container) {
            legendContainer = config.legend.container;
        }
    }
    // v1.12.0: opt-in legend virtualization. Cold validator; every junk config
    // THROWS here (before any signal alloc), null (absent/false) -> eager path.
    const legendVSpec = _normalizeLegendVirtualization(config.legend, legendPosition);

    const widthAutoSig = widthExplicit ? null : _own(signal(800));
    const heightAutoSig = heightExplicit ? null : _own(signal(400));
    const widthAcc = widthExplicit ? asAccessor(config.width) : widthAutoSig;
    const heightAcc = heightExplicit ? asAccessor(config.height) : heightAutoSig;

    // -- Margins --
    const m = config.margin || DEFAULT_MARGIN;
    const marginTop = m.top != null ? m.top : DEFAULT_MARGIN.top;
    const marginRight = m.right != null ? m.right : DEFAULT_MARGIN.right;
    const marginBottom = m.bottom != null ? m.bottom : DEFAULT_MARGIN.bottom;
    const marginLeft = m.left != null ? m.left : DEFAULT_MARGIN.left;

    // -- Series state --
    // Tag each state with its position in the array. The multi-series bubble
    // hit-test (v1.2.0-alpha.2) uses this so lookupRow can check whether
    // a given state is the one that actually got hit; line / area / bar /
    // scatter ignore it.
    const seriesStates = normalized.map((_, i) => {
        const s = createSeriesState();
        s._stateIdx = i;
        return s;
    });

    // -- Scales: created once, fields mutated in place --
    // Resolve x scale type: explicit > inferred from first non-empty series.
    let resolvedXType = (config.xScale && config.xScale.type) || null;
    if (!resolvedXType) {
        for (let i = 0; i < normalized.length && !resolvedXType; i++) {
            const d = untrack(normalized[i].dataAccessor);
            if (Array.isArray(d) && d.length > 0) {
                resolvedXType = inferXScaleType(d[0], xKey);
            }
        }
        if (!resolvedXType) resolvedXType = 'linear';
    }
    // For bar charts, x is categorical -- override the inferred type to 'band'.
    if (renderer.forceXType) resolvedXType = renderer.forceXType;
    // v1.6.0: a log x-scale uses the shared log kernel (same shape as log-y), the
    // same allocation-free `map`/`invert`/`updateLogScale` the y-axis already
    // proves. renderer.forceXType (bar -> 'band') has already won above, so band
    // is never log; every other renderer builds its normal linear/time scale.
    const xScale = resolvedXType === 'log' ? makeLogScale() : renderer.createXScale(resolvedXType);

    // v1.4.0-alpha.0: y-scale type. `yScale: { type: 'log' }` opts in to a
    // base-10 log scale; default is linear. Log y is supported on every
    // axis-kernel chart (line/area/bar/bubble/scatter); convention says
    // log + bar is rarely meaningful, but the chart will render whatever
    // the user opts into.
    const yScaleType = (config.yScale && config.yScale.type === 'log') ? 'log' : 'linear';
    const yScale = yScaleType === 'log' ? makeLogScale() : makeLinearScale('linear');

    // Bar-chart shared state: the union of category names across all visible
    // series, in first-seen order. Mutated in place by extractBarSeriesData
    // during data extraction; bar axis + bandScale read .value. Always
    // allocated (cheap) -- non-bar renderers simply never reference it.
    const categoriesRef = { value: [] };

    // v1.8.0: horizontal bar charts support pan, zoom, and grid via the
    // axis-role swap (the linear kernels are remapped at each gesture boundary,
    // buildGrid emits vertical value rules). v1.9.0 adds horizontal brush (a
    // value-range x band-set payload committed at the gesture boundary). One
    // combination still fails CLOSED at construction, naming the combination: a
    // log yScale (domain-flooring kernel still assumes standard orientation).
    // This reads `config` directly and fires BEFORE any signal alloc -- before
    // swapAxes resolution below, before viewSig/brushSig, before _dataDomain --
    // because the derived pan/zoom/grid flags are resolved further down.
    if (chartOpts && chartOpts.horizontal) {
        if (yScaleType === 'log') {
            throw new Error('lite-charts: horizontal orientation with a log yScale ' +
                'is not supported (planned)');
        }
    }

    // v1.5.0: one setup-time boolean drives the axis-role swap at three cold
    // sites (updateXScale range, value-scale range, buildYAxis seam) plus the
    // crosshair/tooltip anchor. Non-swapping renderers never define
    // axesSwapped, so this is `false` and every downstream branch is dead.
    const swapAxes = renderer.axesSwapped ? renderer.axesSwapped(chartOpts) : false;
    // Crosshair guide selected once here; drawCrosshair calls it per frame with
    // zero branch.
    const _guide = swapAxes ? _strokeGuideH : _strokeGuideV;

    // Singleton ctx passed to all renderer methods. Mutated in place so the
    // hot path (hitTest, lookupRow on every mousemove) doesn't allocate.
    const rendererCtx = {
        xScale,
        yScale,
        opts: chartOpts,
        categoriesRef,
        // v1.1.0: stack pass + hover tint need access to per-series
        // visibility signals and the live crosshair state. Both are
        // assigned below once the kernel has constructed them (after
        // chart() is set up).
        seriesVisibility: null,
        crosshairDataRef: null,
        // v1.2.0-alpha.2: multi-series bubble hit-test iterates all visible
        // series' state arrays to find the best hit across series.
        seriesStates: null,
        // v1.14.0: scatter fat-hover reads the live plot rect to cap the
        // 'nearest' tolerance at the plot diagonal; the cell layer reads it as
        // the tessellation bbox. Assigned once below (plotBoundsBox is declared
        // after this literal in source order).
        plotBoundsBox: null,
        // v1.14.0: cold cell-geometry refresh records an overflow message here
        // for mount()-time fail-closed surfacing (see _scatterPostProject).
        cellError: null,
        // v1.16.0: the field-raster refresh records a first-build fault here,
        // surfaced at mount alongside cellError (independent fault domain).
        fieldError: null,
        // v1.17.0: the contour refresh records a first-build fault here,
        // surfaced at mount alongside field/cellError (third fault domain).
        contourError: null,
    };
    // seriesStates is declared above rendererCtx in source order; assign it
    // here now that rendererCtx exists.
    rendererCtx.seriesStates = seriesStates;

    const scaleVersion = _own(signal(0));

    // -- Plot bounds: a single mutable box + a signal that publishes "the box changed" --
    const plotBoundsBox = { x: 0, y: 0, w: 0, h: 0 };
    // plotBoundsBox identity is stable (mutated in place); wire it onto the
    // shared ctx now that it exists, mirroring the seriesStates late-assign.
    rendererCtx.plotBoundsBox = plotBoundsBox;
    const plotBoundsSignal = _own(signal(0));

    // -- Annotation layer (v1.7.0) --
    // `annotations` accessor (static array or a () => Annotation[] signal thunk);
    // null leaves every downstream branch dead. annThemeVersion re-fires the
    // annotation resolve/color step on refreshTheme() (bumped at 5600).
    // annotationsAcc is declared here (before annThemeVersion, which reads it)
    // rather than beside the crosshair/tooltip config -- the theme signal needs
    // it in scope.
    const annotationsAcc = config.annotations != null ? asAccessor(config.annotations) : null;
    const annThemeVersion = annotationsAcc ? _own(signal(0)) : null;
    // Assigned in mount() when the layer is built; exposed on _internal so
    // white-box tests read pool lengths / visibility. null when disabled.
    let annHandle = null;

    // -- Refs that the draw closures read (mutated by an effect) --
    // visibleRef mirrors a public-facing `seriesVisibility[i]` signal so the
    // draw fns (which run outside a reactive context) can read synchronously
    // without going through signal-call overhead.
    const seriesRefs = normalized.map((s) => ({
        colorRef: { value: '#888' },
        lineWidthRef: { value: s.lineWidth },
        visibleRef: { value: true },
        interpolationRef: { value: INTERP_LINEAR },
        markersRef: { value: null },
    }));

    // -- Public series-visibility signals. Used by the legend click handler,
    // by chart.setSeriesVisible(), and tracked by the domain + draw effects so
    // toggling rescales the y-domain and triggers redraw.
    const seriesVisibility = normalized.map(() => _own(signal(true)));
    rendererCtx.seriesVisibility = seriesVisibility;

    // -- Axis-render styling refs --
    const axisStyleRefs = {
        tickColor: { value: DEFAULT_AXIS_COLOR },
        labelColor: { value: DEFAULT_LABEL_COLOR },
        font: { value: config.font != null ? config.font : DEFAULT_FONT },
    };

    // (areaOpts and barOpts have been replaced by chartOpts -- a unified
    // bag returned by renderer.initOpts(config), passed to renderer methods
    // via rendererCtx.opts.)

    // -- Grid config (v1.0.0) --
    // `grid: true` enables both axes' gridlines. `false` (default) draws no
    // grid. `{ x?, y?, color? }` for per-axis enable + custom color.
    let gridEnableX = false;
    let gridEnableY = false;
    let gridColorSpec = DEFAULT_GRID_COLOR;
    if (config.grid === true) {
        gridEnableX = true;
        gridEnableY = true;
    } else if (config.grid && typeof config.grid === 'object') {
        gridEnableX = config.grid.x !== false; // default both on if object passed
        gridEnableY = config.grid.y !== false;
        if (config.grid.color) gridColorSpec = config.grid.color;
    }
    const gridColorRef = { value: gridColorSpec };

    // -- Crosshair / tooltip config --
    // Defaults (true) are alpha.1 milestones. Disable with `crosshair: false`
    // or `tooltip: false`. If both are false, no DOM listener is attached.
    const crosshairOpts = config.crosshair === false
        ? null
        : (typeof config.crosshair === 'object' ? config.crosshair : {});
    const tooltipOpts = config.tooltip === false
        ? null
        : (typeof config.tooltip === 'object' ? config.tooltip : {});
    const interactionEnabled = !!(crosshairOpts || tooltipOpts);
    // Store raw specs + resolved refs. refreshTheme() re-resolves the specs
    // against the current computed style so CSS-var tokens track theme changes.
    const crosshairColorSpec = crosshairOpts && crosshairOpts.color
        ? crosshairOpts.color
        : DEFAULT_CROSSHAIR_COLOR;
    const crosshairColorRef = { value: crosshairColorSpec };
    const crosshairDash = crosshairOpts && crosshairOpts.dash ? crosshairOpts.dash : [3, 3];
    const tooltipBgSpec = tooltipOpts && tooltipOpts.background
        ? tooltipOpts.background
        : DEFAULT_TOOLTIP_BG;
    const tooltipBorderSpec = tooltipOpts && tooltipOpts.border
        ? tooltipOpts.border
        : DEFAULT_TOOLTIP_BORDER;
    const tooltipBgRef = { value: tooltipBgSpec };
    const tooltipBorderRef = { value: tooltipBorderSpec };
    const tooltipFormatter = tooltipOpts && typeof tooltipOpts.format === 'function'
        ? tooltipOpts.format
        : null;

    // Crosshair state. Hot path = pointermove, which fires at the mouse
    // hardware polling rate (125 Hz - 1 kHz on gaming mice). To avoid
    // per-mousemove allocation we keep a single mutable data object that we
    // mutate in place, and a separate integer version counter signal that
    // we bump to fire reactivity. The public `chart.crosshair` is a facade
    // exposing `()` (subscribe + return live ref), `.peek()`, `.set()`,
    // `.subscribe()` -- callers see the same external API as a plain signal.
    //
    // API contract: the object returned from `()` / `.peek()` / `.subscribe`
    // callbacks IS the live mutable reference. Subscribers MUST read fields
    // eagerly when notified; do not keep the reference and re-read later
    // expecting stable values. This is the trade-off for zero-GC on the
    // hot path.
    const crosshairData = {
        visible: false,
        snapIdx: -1,
        snapDomainX: 0,
        snapPixelX: 0,
        // v1.5.0: free-axis cursor pixel on both axes. mousePixelY anchors the
        // tooltip box for vertical charts; mousePixelX anchors it (box X) for
        // horizontal charts where snapPixelX is the band-axis Y.
        mousePixelX: 0,
        mousePixelY: 0,
        // v1.2.0-alpha.2: which series the hit belongs to. -1 means
        // "not series-scoped" (line / area / bar / scatter never set this).
        // Multi-series bubble's hit-test sets it so lookupRow can scope the
        // tooltip to just the hit series.
        snapSeriesIdx: -1,
    };
    rendererCtx.crosshairDataRef = crosshairData;
    const crosshairVersion = _own(signal(0));
    const crosshairFacade = function () {
        crosshairVersion();
        return crosshairData;
    };
    crosshairFacade.peek = () => crosshairData;
    crosshairFacade.set = (v) => {
        if (v == null || typeof v !== 'object') return;
        crosshairData.visible = !!v.visible;
        crosshairData.snapIdx = v.snapIdx != null ? v.snapIdx : -1;
        crosshairData.snapDomainX = v.snapDomainX != null ? v.snapDomainX : 0;
        crosshairData.snapPixelX = v.snapPixelX != null ? v.snapPixelX : 0;
        crosshairData.mousePixelX = v.mousePixelX != null ? v.mousePixelX : 0;
        crosshairData.mousePixelY = v.mousePixelY != null ? v.mousePixelY : 0;
        crosshairVersion.update((x) => (x + 1) | 0);
    };
    crosshairFacade.subscribe = (fn) =>
        crosshairVersion.subscribe(() => fn(crosshairData));

    // -- Lifecycle --
    let scene = null;
    let canvas = null;
    let container = null;
    let ownedCanvas = false;
    let legendEl = null;          // DOM element if a legend was created
    let legendWrapper = null;     // wrapper around canvas+legend if we created one
    let legendVHandle = null;     // adapter handle when the legend is virtualized
    let legendVRepaint = null;    // closure-captured repaint for the virtual path
    const disposers = [];
    let mounted = false;

    // v1.4.0-alpha.2: opt-in pan + zoom. View signal carries the
    // currently-visible domain as { xMin, xMax, yMin, yMax }; any field
    // can be null to fall back to the data-derived domain. Shape is
    // intentionally symmetric with `lite-camera-max`'s camera signal so
    // the same value drops into a lite-gl `project()` function unchanged
    // when the lite-charts-gl companion package lands.
    //
    // Opt-in: both `pan` and `zoom` default to false. When neither is
    // set, the view signal isn't allocated and no listeners attach --
    // zero cost for charts that don't want interactions.
    const panEnabled = !!config.pan;
    const zoomEnabled = !!config.zoom;
    // v1.4.0-alpha.3: brush -- shift+drag selects a rect, emits the
    // resulting selection through `chart.brush`. Independent of pan/zoom
    // but the same `interactionsEnabled` flag controls allocation of
    // viewSig + _dataDomain + listener attachment, so flipping `brush`
    // on alone is sufficient to wire up the listener cluster.
    const brushEnabled = !!config.brush;
    const interactionsEnabled = panEnabled || zoomEnabled || brushEnabled;
    const viewSig = (panEnabled || zoomEnabled) ? _own(signal(null)) : null;
    const brushSig = brushEnabled ? _own(signal(null)) : null;
    const panBoundsMode = config.panBounds === 'free' ? 'free' : 'data';
    // Zoom range expressed as a multiplier on the data domain. Default
    // [0.01, 1000] -- zoom out to 100x the data span, zoom in to 1/1000
    // of it. zoomMin === zoomMax disables zoom even if `zoom: true`.
    const zoomMinFactor = config.zoomMin != null ? Math.max(1e-6, +config.zoomMin) : 0.01;
    const zoomMaxFactor = config.zoomMax != null ? Math.max(zoomMinFactor, +config.zoomMax) : 1000;
    // Wheel ratio per tick. 1.1 means each wheel notch zooms in by
    // 1.1x (or out by 1/1.1x). Configurable for users who want finer or
    // coarser zoom granularity.
    const zoomWheelStep = config.zoomStep != null ? Math.max(1.001, +config.zoomStep) : 1.15;

    // Data-derived domain snapshot. The scale-update effect populates this
    // every time it runs; pan/zoom math reads from it to compute bounds.
    // Kept as a plain object (no signal, not reactive) so the listeners
    // can read without triggering effects.
    const _dataDomain = interactionsEnabled
        ? { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }
        : null;

    // Reactive view facade mirroring the crosshair facade pattern: `view()`
    // reads (tracked), `view.peek()` reads (untracked), `view.set(v)` writes,
    // `view.reset()` clears to null. Always defined; throws on set/reset if
    // interactions are not enabled (signals the user they need `pan: true`
    // or `zoom: true`).
    const viewFacade = function () {
        return viewSig ? viewSig() : null;
    };
    viewFacade.peek = () => viewSig ? untrack(() => viewSig()) : null;
    viewFacade.set = (v) => {
        if (!viewSig) throw new Error('lite-charts: setView() requires `pan: true` or `zoom: true` in config');
        if (v === null) {
            viewSig.set(null);
            return;
        }
        if (typeof v !== 'object') {
            throw new Error('lite-charts: view must be null or an object {xMin?, xMax?, yMin?, yMax?}');
        }
        viewSig.set({
            xMin: v.xMin != null ? +v.xMin : null,
            xMax: v.xMax != null ? +v.xMax : null,
            yMin: v.yMin != null ? +v.yMin : null,
            yMax: v.yMax != null ? +v.yMax : null,
        });
    };
    viewFacade.reset = () => {
        if (!viewSig) throw new Error('lite-charts: resetView() requires `pan: true` or `zoom: true` in config');
        viewSig.set(null);
    };

    // v1.4.0-alpha.3: brush facade. Same shape pattern as viewFacade
    // (callable for reactive read; .peek / .set / .clear methods). The
    // brush selection shape is { xMin, xMax, yMin, yMax, ids } with
    // `ids` being indices into the primary series. ids is freshly
    // allocated each emit -- not pooled to avoid aliasing bugs across
    // brushes; brushing is a user-driven gesture (sub-Hz), not a hot
    // path, so the allocation is acceptable.
    const brushFacade = function () {
        return brushSig ? brushSig() : null;
    };
    brushFacade.peek = () => brushSig ? untrack(() => brushSig()) : null;
    brushFacade.set = (v) => {
        if (!brushSig) throw new Error('lite-charts: setBrush() requires `brush: true` in config');
        if (v === null) {
            brushSig.set(null);
            return;
        }
        if (typeof v !== 'object') {
            throw new Error('lite-charts: brush must be null or an object {xMin, xMax, yMin, yMax, ids?}');
        }
        if (swapAxes) {
            // Horizontal brush: a value-range x band-set payload. Validate the
            // four numeric bounds fail-closed (Number.isFinite, never
            // Number(null)===0) and re-derive `bands` (category keys) from the
            // band index span so the emitted shape matches the commit path.
            // null/undefined coerce to 0/NaN under unary + -- force them to NaN
            // FIRST so a null bound fails closed (null is not zero) instead of
            // slipping through Number.isFinite as a silent 0.
            const valueMin = v.valueMin == null ? NaN : +v.valueMin;
            const valueMax = v.valueMax == null ? NaN : +v.valueMax;
            const bandMin = v.bandMin == null ? NaN : +v.bandMin;
            const bandMax = v.bandMax == null ? NaN : +v.bandMax;
            if (!Number.isFinite(valueMin) || !Number.isFinite(valueMax)
                || !Number.isFinite(bandMin) || !Number.isFinite(bandMax)) {
                throw new Error('lite-charts: horizontal brush must be null or an object ' +
                    '{valueMin, valueMax, bandMin, bandMax, bands?, ids?}');
            }
            let bands;
            if (Array.isArray(v.bands)) {
                bands = v.bands;
            } else {
                const cats = categoriesRef.value;
                const lo = Math.max(0, Math.min(cats.length, Math.floor(bandMin)));
                const hi = Math.min(cats.length - 1, Math.floor(bandMax));
                bands = [];
                for (let b = lo; b <= hi; b++) bands.push(cats[b]);
            }
            brushSig.set({
                valueMin,
                valueMax,
                bandMin,
                bandMax,
                bands,
                ids: Array.isArray(v.ids) ? v.ids : null,
            });
            return;
        }
        brushSig.set({
            xMin: +v.xMin,
            xMax: +v.xMax,
            yMin: +v.yMin,
            yMax: +v.yMax,
            ids: Array.isArray(v.ids) ? v.ids : null,
        });
    };
    brushFacade.clear = () => {
        if (!brushSig) throw new Error('lite-charts: clearBrush() requires `brush: true` in config');
        brushSig.set(null);
    };

    // Brush visual style. Defaults: translucent accent fill + dashed
    // outline. All overridable via config.brushStyle.
    const brushStyleCfg = config.brushStyle || {};
    const brushFill = brushStyleCfg.fill != null ? brushStyleCfg.fill : 'rgba(99, 102, 241, 0.15)';
    const brushStroke = brushStyleCfg.stroke != null ? brushStyleCfg.stroke : 'rgba(99, 102, 241, 0.7)';
    const brushDash = Array.isArray(brushStyleCfg.lineDash) ? brushStyleCfg.lineDash : [4, 4];
    const brushLineWidth = brushStyleCfg.lineWidth != null ? +brushStyleCfg.lineWidth : 1;
    // Click-to-clear threshold (pixel distance below which a "brush"
    // is treated as a click and clears the existing selection). 3px
    // matches d3-brush's default.
    const brushClickThreshold = 3;

    // Pan/zoom math helpers are module-level (defined above the kernel)
    // so `_testHelpers` can export them for white-box unit tests without
    // pinning the entire chart kernel in the reachable set.

    const mount = (target) => {
        if (mounted) throw new Error('lite-charts: chart already mounted');
        if (!target) throw new Error('lite-charts: mount() requires an HTMLElement or HTMLCanvasElement');

        // Resolve target -> canvas + container.
        if (target.tagName === 'CANVAS') {
            canvas = target;
            container = target.parentElement || target;
            ownedCanvas = false;
        } else if (typeof target.appendChild === 'function') {
            if (typeof document === 'undefined') {
                throw new Error('lite-charts: mount() needs a real document to create a canvas');
            }
            canvas = document.createElement('canvas');
            target.appendChild(canvas);
            container = target;
            ownedCanvas = true;
        } else if (typeof target.getContext === 'function') {
            // Mock canvas (no `tagName`); duck-type via getContext.
            canvas = target;
            container = null;
            ownedCanvas = false;
        } else {
            throw new Error('lite-charts: mount() target must be an HTMLElement or HTMLCanvasElement');
        }

        // Auto-resize wire-up: if width/height were omitted, observe the
        // container. Done BEFORE the initial sizing read so the first paint
        // uses the container's actual dimensions instead of the 800x400
        // fallback. Disposers list is populated below at mount-effect setup;
        // we rely on it being the same array referenced by mount/unmount.
        if (widthAutoSig || heightAutoSig) {
            _wireAutoSize(container, widthAutoSig, heightAutoSig, disposers);
        }

        // Initial sizing.
        const w0 = (+untrack(widthAcc) | 0) || 800;
        const h0 = (+untrack(heightAcc) | 0) || 400;
        canvas.width = w0;
        canvas.height = h0;

        // Resolve colors against container (one-time at mount; refreshTheme()
        // re-runs this on demand).
        for (let i = 0; i < normalized.length; i++) {
            const resolvedColor = resolveColor(normalized[i].color, container);
            seriesRefs[i].colorRef.value = resolvedColor;
            seriesRefs[i].lineWidthRef.value = normalized[i].lineWidth;
            seriesRefs[i].interpolationRef.value = normalized[i].interpolation;
            seriesRefs[i].markersRef.value = _resolveMarkers(normalized[i].markers, resolvedColor);
        }
        axisStyleRefs.tickColor.value = resolveColor(config.axisColor || DEFAULT_AXIS_COLOR, container);
        axisStyleRefs.labelColor.value = resolveColor(config.labelColor || DEFAULT_LABEL_COLOR, container);
        gridColorRef.value = resolveColor(gridColorSpec, container);
        crosshairColorRef.value = resolveColor(crosshairColorSpec, container);
        tooltipBgRef.value = resolveColor(tooltipBgSpec, container);
        tooltipBorderRef.value = resolveColor(tooltipBorderSpec, container);

        // Schedule: browser default is rAF; in Node (tests, SSR-adjacent
        // workflows) fall back to synchronous so initial draws don't throw
        // on `requestAnimationFrame is not defined`. Callers can override
        // explicitly via config.schedule.
        const schedule = config.schedule
            || (typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (fn) => fn());

        scene = createScene(canvas, {
            background: config.background != null ? config.background : null,
            autoResize: false,
            dpr: config.dpr != null ? config.dpr : (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1),
            schedule,
        });

        // Resolve dpr once. We own the DPR coordination explicitly (rather
        // than letting lite-scene's syncSize() drive it) because we want
        // signal-reactive width/height to update both the backing buffer
        // AND the CSS display size atomically. lite-scene still applies
        // `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` per draw, so all chart
        // drawing happens in CSS-pixel logical coords -- plotBoundsBox,
        // pixel buffers, mouse-handler coords are all CSS px.
        const resolvedDpr = config.dpr != null
            ? config.dpr
            : (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);

        // Effect 1: size + plot-bounds.
        disposers.push(effect(() => {
            const w = (+widthAcc() | 0) || 800;
            const h = (+heightAcc() | 0) || 400;
            // Backing buffer = CSS px * dpr (so Retina renders crisp).
            // CSS dimensions = the layout size the user sees.
            const wBacking = Math.max(1, Math.round(w * resolvedDpr));
            const hBacking = Math.max(1, Math.round(h * resolvedDpr));
            if (canvas.width !== wBacking) canvas.width = wBacking;
            if (canvas.height !== hBacking) canvas.height = hBacking;
            if (typeof canvas.style !== 'undefined') {
                canvas.style.width = w + 'px';
                canvas.style.height = h + 'px';
            }
            plotBoundsBox.x = marginLeft;
            plotBoundsBox.y = marginTop;
            plotBoundsBox.w = Math.max(0, w - marginLeft - marginRight);
            plotBoundsBox.h = Math.max(0, h - marginTop - marginBottom);
            scaleVersion.update((v) => (v + 1) | 0);
            plotBoundsSignal.update((v) => (v + 1) | 0);
            if (scene) scene.markDirty();
        }));

        // Effect 2: extract data + compute domain + project to pixels.
        // Tracks both the data accessors AND plotBoundsSignal AND each
        // visibility signal -- toggling a series visible re-rescales the
        // y-domain to fit the remaining visible data (Chart.js convention,
        // useful default that surfaces detail in the un-hidden series).
        //
        // C0: a log axis with no positive data is a fail-closed error. The effect
        // must NOT `throw` on its first (synchronous) run -- that would escape
        // `effect(...)` before its disposer is captured by `disposers.push`, so
        // the effect node would leak on the failed mount. Instead it records the
        // message here and mount() re-throws AFTER the disposer is registered, so
        // the caller's error path (and destroy()) unwinds cleanly. A later re-run
        // that goes invalid just skips the frame (fail-safe), like map(v<=0).
        let _logDomainError = null;
        disposers.push(effect(() => {
            _logDomainError = null;
            plotBoundsSignal(); // dep: rerun on size change
            let xMin = Infinity;
            let xMax = -Infinity;
            let yMin = Infinity;
            let yMax = -Infinity;
            let anyData = false;

            // For renderers that maintain a shared categories list (bar),
            // reset it before extraction. The categoriesRef object identity
            // is stable; only its `.value.length` changes structure.
            if (renderer.forceXType === 'band') {
                categoriesRef.value.length = 0;
            }

            for (let i = 0; i < normalized.length; i++) {
                const visible = seriesVisibility[i](); // dep: per-series visibility
                const data = normalized[i].dataAccessor();
                renderer.extractData(seriesStates[i], data, xAccessor, yAccessor, rendererCtx);
                if (visible && seriesStates[i].n > 0) {
                    anyData = true;
                    if (seriesStates[i].domainXMin < xMin) xMin = seriesStates[i].domainXMin;
                    if (seriesStates[i].domainXMax > xMax) xMax = seriesStates[i].domainXMax;
                    if (seriesStates[i].domainYMin < yMin) yMin = seriesStates[i].domainYMin;
                    if (seriesStates[i].domainYMax > yMax) yMax = seriesStates[i].domainYMax;
                }
            }

            // v1.1.0: optional post-extract pass. Bar's stack pass uses this
            // to fill stackBottoms/stackTops per series AND overwrite each
            // series' domainYMax with the total-stack-height global max. We
            // re-aggregate y-domain after the hook to pick up those updates.
            if (renderer.postExtract) {
                renderer.postExtract(seriesStates, rendererCtx);
                yMin = Infinity;
                yMax = -Infinity;
                for (let i = 0; i < normalized.length; i++) {
                    if (seriesVisibility[i]() && seriesStates[i].n > 0) {
                        if (seriesStates[i].domainYMin < yMin) yMin = seriesStates[i].domainYMin;
                        if (seriesStates[i].domainYMax > yMax) yMax = seriesStates[i].domainYMax;
                    }
                }
                if (yMin === Infinity) yMin = 0;
                if (yMax === -Infinity) yMax = 1;
            }

            if (!anyData) {
                xMin = 0; xMax = 1; yMin = 0; yMax = 1;
            }
            if (xMin === xMax) xMax = xMin + 1;

            // Bar / future "zero-anchored" renderers want their baseline in
            // the y-domain so bars don't visually float. Honoured via the
            // renderer's yDefaults.zero flag, applied here before niceYDomain.
            if (renderer.yDefaults && renderer.yDefaults.zero && chartOpts && chartOpts.baseline != null) {
                if (chartOpts.baseline < yMin) yMin = chartOpts.baseline;
                if (chartOpts.baseline > yMax) yMax = chartOpts.baseline;
            }
            if (yMin === yMax) yMax = yMin + 1;

            const xConf = config.xScale;
            const yConf = config.yScale;
            const dxMin = xConf && xConf.domain ? xConf.domain[0] : xMin;
            const dxMax = xConf && xConf.domain ? xConf.domain[1] : xMax;
            const yBase = yConf && yConf.domain
                ? [yConf.domain[0], yConf.domain[1]]
                : niceYDomain(yMin, yMax, yConf || renderer.yDefaults);

            // v1.4.0-alpha.2: snapshot data-derived domain for pan/zoom
            // bounds math. The view-override layer below reads viewSig()
            // (tracked); we want to write _dataDomain in untrack so this
            // ref-write doesn't add a spurious dependency.
            // v1.8.0: under swap (horizontal bar) the x fields hold the BAND
            // domain and the value bounds live in yMin/yMax. Pan/zoom pins the
            // band axis (dxPx=0 / zoomX=1), so _clampToBounds snaps x to itself
            // -- an intentional identity, no swap-specific code here. The log
            // flooring branches below stay unreachable on horizontal: a log
            // yScale throws at construction (guard above) and log-x + swapped is
            // rejected at the render seam (see resolvedXType note below).
            if (_dataDomain) {
                _dataDomain.xMin = dxMin;
                _dataDomain.xMax = dxMax;
                _dataDomain.yMin = yBase[0];
                _dataDomain.yMax = yBase[1];
                // v1.6.1: a log axis pans in log space; its data-domain bound
                // must be positive or log10() NaNs the first gesture. Floor min
                // to the same positive part the render path uses (hi * 1e-9 with
                // the same `> 0` predicate), computed from the DATA extent -- not
                // the view-overridden xLo/yLo below -- and only when that axis has
                // a positive extent. No-positive-extent still throws at mount.
                if (resolvedXType === 'log' && dxMax > 0 && !(dxMin > 0)) {
                    _dataDomain.xMin = dxMax * 1e-9;
                }
                if (yScaleType === 'log' && yBase[1] > 0 && !(yBase[0] > 0)) {
                    _dataDomain.yMin = yBase[1] * 1e-9;
                }
            }

            // v1.4.0-alpha.2: view-override layer. If pan/zoom is enabled
            // AND the view signal has been set (non-null), use the view's
            // bounds. Any null field on the view falls back to the data
            // domain so partial-axis pan ("only x is panned") works.
            // Tracking viewSig() here makes this effect re-run when the
            // user pans or zooms, which is exactly the data-flow we want.
            let xLo = dxMin, xHi = dxMax, yLo = yBase[0], yHi = yBase[1];
            if (viewSig) {
                const view = viewSig();
                if (view) {
                    if (view.xMin != null) xLo = +view.xMin;
                    if (view.xMax != null) xHi = +view.xMax;
                    if (view.yMin != null) yLo = +view.yMin;
                    if (view.yMax != null) yHi = +view.yMax;
                }
            }

            // v1.6.0: a log x-scale takes the same fail-closed domain-floor as
            // log-y, applied to the X pixel range (left -> right, NOT flipped like
            // y's bottom -> top). x-log + band and x-log + swapped are rejected at
            // construction, so this branch is never band and never swapped; the
            // linear/time/band renderers keep the unchanged updateXScale seam.
            if (resolvedXType === 'log') {
                let xlo = xLo, xhi = xHi;
                if (!(xhi > 0)) {
                    // No positive extent: flag and bail this run (mount() throws).
                    _logDomainError = 'lite-charts: a log x-axis needs positive data, but the x-domain [' +
                        xLo + ', ' + xHi + '] has no positive values';
                    return;
                }
                if (!(xlo > 0)) xlo = xhi * 1e-9;
                if (!(xhi > xlo)) xhi = xlo * 10;
                updateLogScale(xScale, xlo, xhi, plotBoundsBox.x, plotBoundsBox.x + plotBoundsBox.w);
            } else {
                // v1.5.0: when the axes are swapped (horizontal bars) the band
                // scale is bound to the Y pixel range instead of X. The scale
                // OBJECT is unchanged -- only the pixel range it maps into swaps.
                renderer.updateXScale(
                    xScale,
                    xLo, xHi,
                    swapAxes ? plotBoundsBox.y : plotBoundsBox.x,
                    swapAxes ? plotBoundsBox.y + plotBoundsBox.h : plotBoundsBox.x + plotBoundsBox.w,
                    rendererCtx,
                );
            }
            if (yScaleType === 'log') {
                // C0 (LC-04): `updateLogScale` now fails closed, so the domain is
                // made valid HERE rather than substituted inside it. Non-positive
                // values are outside a log axis anyway (`map(v<=0)` is NaN, drawn
                // as a break), so we floor the domain to the positive part: if the
                // top is positive, clamp the bottom up to it spanning at most ~9
                // decades. Only a domain with NO positive extent (yHi <= 0) is
                // genuinely un-plottable on a log axis -- that throws, naming the
                // domain, instead of drawing a fabricated 1..10.
                let lo = yLo, hi = yHi;
                if (!(hi > 0)) {
                    // No positive extent: flag and bail this run (mount() throws).
                    _logDomainError = 'lite-charts: a log y-axis needs positive data, but the y-domain [' +
                        yLo + ', ' + yHi + '] has no positive values';
                    return;
                }
                if (!(lo > 0)) lo = hi * 1e-9;
                if (!(hi > lo)) hi = lo * 10;
                updateLogScale(yScale, lo, hi, plotBoundsBox.y + plotBoundsBox.h, plotBoundsBox.y);
            } else if (swapAxes) {
                // v1.5.0: horizontal bars bind the value scale to the X pixel
                // range (lo -> left plot edge, hi -> right; not flipped).
                // horizontal + log is rejected at construction, so the log
                // branch above never runs swapped.
                updateLinearScale(yScale, yLo, yHi, plotBoundsBox.x, plotBoundsBox.x + plotBoundsBox.w);
            } else {
                updateLinearScale(yScale, yLo, yHi, plotBoundsBox.y + plotBoundsBox.h, plotBoundsBox.y);
            }

            // Renderers that use pre-projected pixel arrays in their draw fn
            // (line / area) request projection; renderers that compute pixels
            // on the fly (bar) opt out.
            if (renderer.projectToPixels) {
                for (let i = 0; i < seriesStates.length; i++) {
                    if (seriesStates[i].n > 0) scaleSeriesToPixels(seriesStates[i], xScale, yScale);
                }
            }
            // v1.14.0: optional post-projection pass. Scatter's cell layer uses
            // this to rebuild pixel-space tessellation geometry now that pxs/pys
            // are current (data OR scale change). Dead for every other renderer,
            // exactly like postExtract. Fail-closed: a refresh overflow records
            // ctx.cellError (surfaced at mount below), never throws here.
            if (renderer.postProject) renderer.postProject(seriesStates, rendererCtx);
            scaleVersion.update((v) => (v + 1) | 0);
            if (scene) scene.markDirty();
        }));
        // C0: fail the mount CLOSED with nothing left behind. `mounted` is not set
        // until the end of mount(), so destroy() would skip cleanup on a mid-mount
        // throw; run the disposers created so far (the effects + any observers) and
        // clear them, so no signal node leaks on the rejected mount.
        // v1.14.0: a cell-refresh overflow on the first sync run surfaces here
        // too (same unwind), mirroring the log fail-closed door. A later invalid
        // run only skips its cells (markers still draw); this check runs once.
        const _mountError = _logDomainError || rendererCtx.cellError || rendererCtx.fieldError || rendererCtx.contourError;
        if (_mountError) {
            for (let i = disposers.length - 1; i >= 0; i--) {
                try { disposers[i](); } catch (_) { /* best-effort unwind */ }
            }
            disposers.length = 0;
            throw new Error(_mountError);
        }

        // Effect 2b: mirror visibility signals into the synchronous refs the
        // draw closures read. Also serves as the dirty bridge for visibility
        // toggles that don't change the y-domain (e.g. when a fixed yScale
        // is set or only-x toggled). Effect 2 catches the domain case; this
        // catches the rest.
        disposers.push(effect(() => {
            for (let i = 0; i < normalized.length; i++) {
                seriesRefs[i].visibleRef.value = seriesVisibility[i]();
            }
            if (scene) scene.markDirty();
        }));

        // Build grid first so it renders BEHIND axes and data (scene draws
        // children in tree order). gridEnabled is false by default; both
        // enableX / enableY are tracked separately so users can have one-axis
        // grids if they want.
        if (gridEnableX || gridEnableY) {
            const grid = buildGrid(scene.root, {
                xScale,
                yScale,
                plotBoundsBox,
                plotBoundsSignal,
                scaleVersion,
                color: () => gridColorRef.value,
                xFormat: resolvedXType === 'time' ? 'time' : 'number',
                // Renderers that don't want vertical gridlines (e.g. bar:
                // gridlines on band centers duplicate the tick marks)
                // suppress them via renderer.enableXGrid = false.
                enableX: renderer.enableXGrid ? gridEnableX : false,
                enableY: gridEnableY,
                // v1.8.0: horizontal bar flips value gridlines to vertical.
                swapAxes,
            });
            disposers.push(grid.dispose);
        }

        // Build axes. X-axis is renderer-specific (numeric / time / band).
        // Y-axis is always numeric (true for line, area, bar; pie / radar
        // won't go through createBaseAxisChart at all).
        const xAxis = renderer.buildXAxis(scene.root, {
            scale: xScale,
            plotBoundsBox,
            plotBoundsSignal,
            scaleVersion,
            tickColor: () => axisStyleRefs.tickColor.value,
            labelColor: () => axisStyleRefs.labelColor.value,
            font: () => axisStyleRefs.font.value,
            format: resolvedXType === 'time' ? 'time' : 'number',
        }, rendererCtx);
        // v1.5.0: Y-axis via an optional renderer seam. buildAxis ignores the
        // 3rd (ctx) arg, so line/area/scatter/bubble are untouched; the bar
        // renderer's _buildAxisBarY puts the band axis on the left when the
        // orientation is horizontal.
        const yAxis = (renderer.buildYAxis || buildAxis)(scene.root, {
            orientation: 'y',
            scale: yScale,
            plotBoundsBox,
            plotBoundsSignal,
            scaleVersion,
            tickColor: () => axisStyleRefs.tickColor.value,
            labelColor: () => axisStyleRefs.labelColor.value,
            font: () => axisStyleRefs.font.value,
            format: 'number',
        }, rendererCtx);
        disposers.push(xAxis.dispose);
        disposers.push(yAxis.dispose);

        // v1.16.0: field (interpolated raster) layer. One node per chart, added
        // BEFORE the cells node (so it renders UNDER cells, which render under
        // markers -- scene draws in tree order), inside the plot clip. fieldSpec
        // is a scatter-only opts field. Primary series only (D6). Gated on its
        // OWN spec, independent of the cells node.
        if (chartOpts && chartOpts.fieldSpec) {
            const fieldDraw = makeScatterFieldDrawFn(
                seriesStates[0], seriesRefs[0], chartOpts, rendererCtx);
            scene.root.add(pathNode({ draw: (ctx) => fieldDraw(ctx) }));
        }

        // v1.17.0: contour/isoline layer. One node per chart, added AFTER the
        // field node (so isolines render OVER the raster) and BEFORE the cells
        // node, inside the plot clip. Gated on its OWN nested spec; a chart with
        // `field` but no `contours` adds NO node and stays byte-identical.
        if (chartOpts && chartOpts.fieldSpec && chartOpts.fieldSpec.contours) {
            const contourDraw = makeScatterContourDrawFn(
                seriesStates[0], seriesRefs[0], chartOpts, rendererCtx);
            scene.root.add(pathNode({ draw: (ctx) => contourDraw(ctx) }));
        }

        // v1.14.0: cell (Voronoi) layer. One node per chart, added BEFORE the
        // series marker nodes so it renders UNDERNEATH them (scene draws in tree
        // order), inside the plot clip. cellsSpec is a scatter-only opts field,
        // so no other renderer reaches this branch. Primary series only (D6).
        if (chartOpts && chartOpts.cellsSpec) {
            const cellDraw = makeScatterCellDrawFn(
                seriesStates[0], seriesRefs[0], chartOpts, rendererCtx);
            scene.root.add(pathNode({ draw: (ctx) => cellDraw(ctx) }));
        }

        // One path node per series. Draw fn is renderer-specific; the same
        // (state, refs, plotBoundsBox, seriesIdx, totalSeries, ctx) signature
        // covers line / area / bar. Polar / grid families use their own bases.
        const seriesNodes = [];
        for (let i = 0; i < normalized.length; i++) {
            const drawFn = renderer.makeDrawFn(
                seriesStates[i],
                seriesRefs[i],
                plotBoundsBox,
                i,                      // seriesIdx (grouped bar layout)
                normalized.length,      // totalSeries
                rendererCtx,
            );
            const node = scene.root.add(pathNode({
                draw: (ctx) => drawFn(ctx),
            }));
            seriesNodes.push(node);
        }

        // -- Annotation layer (v1.7.0) --
        // Added above the series nodes' peers but below the crosshair overlay so
        // rules/ranges sit over the data yet under the interactive crosshair.
        // Runtime-isolated: skipped entirely when no `annotations` config exists.
        if (annotationsAcc) {
            const ann = buildAnnotations(scene.root, {
                xScale,
                yScale,
                plotBoundsBox,
                plotBoundsSignal,
                scaleVersion,
                annotationsAcc,
                themeVersion: annThemeVersion,
                swapAxes,
                container,
                font: () => axisStyleRefs.font.value,
                markDirty: () => { if (scene) scene.markDirty(); },
            });
            annHandle = ann;
            disposers.push(ann.dispose);
        }

        // Effect 3: scale/plot changes -> markDirty (path node has no reactive
        // props of its own; this is the dirty bridge).
        disposers.push(effect(() => {
            scaleVersion();
            plotBoundsSignal();
            if (scene) scene.markDirty();
        }));

        // -- Crosshair + tooltip --
        if (interactionEnabled) {
            // Single path node draws vertical line + markers + tooltip box. We
            // keep it as ONE node (rather than one node per visual) because all
            // pieces share the same gate (crosshair visibility), so coalescing
            // them avoids redundant scene traversal cost.
            const crosshairNode = scene.root.add(pathNode({
                draw: (ctx) => drawCrosshair(ctx),
            }));

            // Dirty bridge: crosshair state changes -> markDirty. The path
            // node's draw is RAW, so it doesn't auto-track.
            disposers.push(effect(() => {
                crosshairVersion();
                if (scene) scene.markDirty();
            }));

            // DOM mousemove / mouseleave (only if the canvas supports
            // addEventListener -- mock canvases used in tests don't, and
            // tests drive crosshair via chart.moveCrosshair() directly).
            if (typeof canvas.addEventListener === 'function') {
                const onMove = (ev) => {
                    const rect = typeof canvas.getBoundingClientRect === 'function'
                        ? canvas.getBoundingClientRect()
                        : { left: 0, top: 0, width: canvas.width, height: canvas.height };
                    // CSS pixels relative to canvas top-left. moveCrosshair
                    // expects logical (CSS-pixel) coords because plotBoundsBox,
                    // pixel buffers, and xScale.invert all operate in logical
                    // coords -- lite-scene's setTransform(dpr) handles the
                    // logical->device mapping at draw time.
                    moveCrosshair(ev.clientX - rect.left, ev.clientY - rect.top);
                };
                const onLeave = () => hideCrosshair();
                canvas.addEventListener('mousemove', onMove);
                canvas.addEventListener('mouseleave', onLeave);
                disposers.push(() => {
                    canvas.removeEventListener('mousemove', onMove);
                    canvas.removeEventListener('mouseleave', onLeave);
                });
            }
        }

        // -- Brush overlay (v1.4.0-alpha.3) --
        // Translucent rect drawn over the plot when a brush is active.
        // Added AFTER the crosshair node so the rect renders on top.
        // The draw fn reads the brush signal untracked; the dirty bridge
        // below tracks it and bumps the scene.
        if (brushEnabled) {
            const drawBrushOverlay = (ctx) => {
                const b = brushFacade.peek();
                if (!b) return;
                // Convert data-space bounds back to pixels via the live
                // scales. y is flipped: data yMax sits at the SMALLER
                // pixel (top of plot).
                let px1, px2, py1, py2;
                if (swapAxes) {
                    // Horizontal: value axis on screen-X (yScale, no flip);
                    // band extent on screen-Y from the BAND geometry. xScale.map
                    // returns a band CENTER, so span the rect with leftEdge to
                    // keep it half-a-band aligned with the drawn bars.
                    px1 = yScale.map(b.valueMin);
                    px2 = yScale.map(b.valueMax);
                    py1 = xScale.leftEdge(b.bandMin);
                    py2 = xScale.leftEdge(b.bandMax) + xScale.bandWidth;
                } else {
                    px1 = xScale.map(b.xMin);
                    px2 = xScale.map(b.xMax);
                    py1 = yScale.map(b.yMax);
                    py2 = yScale.map(b.yMin);
                }
                if (!isFinite(px1) || !isFinite(px2) || !isFinite(py1) || !isFinite(py2)) return;
                const rx = Math.min(px1, px2);
                const ry = Math.min(py1, py2);
                const rw = Math.abs(px2 - px1);
                const rh = Math.abs(py2 - py1);
                if (rw < 1 && rh < 1) return;   // degenerate; skip draw
                ctx.fillStyle = brushFill;
                ctx.fillRect(rx, ry, rw, rh);
                ctx.strokeStyle = brushStroke;
                ctx.lineWidth = brushLineWidth;
                if (brushDash.length) ctx.setLineDash(brushDash);
                ctx.strokeRect(rx, ry, rw, rh);
                if (brushDash.length) ctx.setLineDash([]);
            };
            scene.root.add(pathNode({ draw: drawBrushOverlay }));

            // Dirty bridge: brush signal changes -> markDirty. Both
            // user-driven (shift+drag) and programmatic (setBrush) paths
            // run through this.
            disposers.push(effect(() => {
                brushSig();
                if (scene) scene.markDirty();
            }));
        }

        // -- Pan + zoom (v1.4.0-alpha.2) --
        // Opt-in via `pan: true` and/or `zoom: true` in config. Listeners
        // only attach if interactionsEnabled AND the canvas supports
        // addEventListener (mock canvases in tests don't; the math is
        // exercised directly via _testHelpers + the view facade in those
        // tests).
        if (interactionsEnabled && typeof canvas.addEventListener === 'function') {
            // Drag state. We capture the start view + start pointer on
            // pointerdown, recompute the new view on every pointermove,
            // release on pointerup / pointerleave / pointercancel.
            //
            // The chunked structure avoids closure-over-loop traps: each
            // gesture is a single pointer interaction with stable refs.
            let dragActive = false;
            let dragStartX = 0, dragStartY = 0;
            const dragStartView = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
            const dragPlotBounds = { left: 0, top: 0, width: 1, height: 1 };

            // Read the current effective view (either user-set view OR
            // data domain). Untracked because this runs inside event
            // handlers, not reactive effects.
            const _readEffectiveView = (out) => {
                const v = viewFacade.peek();
                out.xMin = (v && v.xMin != null) ? v.xMin : _dataDomain.xMin;
                out.xMax = (v && v.xMax != null) ? v.xMax : _dataDomain.xMax;
                out.yMin = (v && v.yMin != null) ? v.yMin : _dataDomain.yMin;
                out.yMax = (v && v.yMax != null) ? v.yMax : _dataDomain.yMax;
            };

            const _canvasPx = (ev) => {
                const rect = typeof canvas.getBoundingClientRect === 'function'
                    ? canvas.getBoundingClientRect()
                    : { left: 0, top: 0 };
                return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
            };

            const _inPlot = (px, py) => (
                px >= plotBoundsBox.x && px <= plotBoundsBox.x + plotBoundsBox.w &&
                py >= plotBoundsBox.y && py <= plotBoundsBox.y + plotBoundsBox.h
            );

            const onPanDown = panEnabled ? (ev) => {
                // Left button only (button === 0). Touches send pointerdown
                // without a button; allow those too (button === 0 on pen,
                // -1 on some touch implementations).
                if (ev.button != null && ev.button > 0) return;
                // v1.4.0-alpha.3: shift-modifier reserved for brushing.
                // If brush is also enabled, shift+drag routes there
                // instead of pan. If brush is NOT enabled, shift-drag
                // still falls through to pan -- the modifier-key
                // contract is documented as "shift = brush WHEN brush
                // is enabled".
                if (brushEnabled && ev.shiftKey) return;
                const p = _canvasPx(ev);
                if (!_inPlot(p.x, p.y)) return;
                dragActive = true;
                dragStartX = p.x;
                dragStartY = p.y;
                _readEffectiveView(dragStartView);
                // Snapshot plot bounds at gesture start. They could change
                // mid-drag if the container resizes; the gesture is
                // anchored to the start geometry to keep the math stable.
                dragPlotBounds.left = plotBoundsBox.x;
                dragPlotBounds.top = plotBoundsBox.y;
                dragPlotBounds.width = plotBoundsBox.w;
                dragPlotBounds.height = plotBoundsBox.h;
                // Suppress crosshair-hover during active drag (hide and
                // gate further moves below). Resumed on pointerup.
                if (typeof hideCrosshair === 'function') hideCrosshair();
                if (typeof canvas.setPointerCapture === 'function' && ev.pointerId != null) {
                    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* swallow */ }
                }
            } : null;

            const onPanMove = panEnabled ? (ev) => {
                if (!dragActive) return;
                const p = _canvasPx(ev);
                const dx = p.x - dragStartX;
                const dy = p.y - dragStartY;
                const w = dragPlotBounds.width || 1;
                const h = dragPlotBounds.height || 1;
                // C0: branch per axis. `xScale.type` / `yScale.type` are consulted
                // independently so a linear-x / log-y chart pans with log math on y
                // and linear math on x. An all-linear chart takes the byte-identical
                // `_applyPan` / `_clampToBounds` path (hash parity).
                const xLog = xScale.type === 'log';
                const yLog = yScale.type === 'log';
                const newView = (xLog || yLog)
                    ? _applyPanLog(dragStartView, dx, dy, w, h, xLog, yLog)
                    // v1.8.0: horizontal bar swaps axis roles. A rightward drag of
                    // `dx`px over plot width `w` shifts the value domain (now on y)
                    // left by dx*span/w: pass dxPx=0 (band axis pinned), dyPx=-dx,
                    // plotH=w. The band axis (x) stays untouched.
                    : (swapAxes
                        ? _applyPan(dragStartView, 0, -dx, w, w)
                        : _applyPan(dragStartView, dx, dy, w, h));
                if (panBoundsMode === 'data' && _dataDomain) {
                    if (xLog || yLog) _clampToBoundsLog(newView, _dataDomain, xLog, yLog);
                    else _clampToBounds(newView, _dataDomain);
                }
                viewSig.set(newView);
            } : null;

            const onPanUp = panEnabled ? (ev) => {
                if (!dragActive) return;
                dragActive = false;
                if (typeof canvas.releasePointerCapture === 'function' && ev && ev.pointerId != null) {
                    try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* swallow */ }
                }
            } : null;

            const onWheel = zoomEnabled ? (ev) => {
                const p = _canvasPx(ev);
                if (!_inPlot(p.x, p.y)) return;
                // preventDefault: stop the page scrolling while the cursor
                // is over the chart. Passive: false is required for this
                // to take effect on modern browsers; we set it below.
                if (typeof ev.preventDefault === 'function') ev.preventDefault();
                // deltaY > 0 = scroll down = zoom out; < 0 = zoom in.
                const zoomFactor = ev.deltaY > 0 ? zoomWheelStep : (1 / zoomWheelStep);
                const start = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
                _readEffectiveView(start);
                // Zoom-factor cap: the data-domain ratio of the proposed
                // new view must stay within [zoomMinFactor, zoomMaxFactor].
                // (zoomMinFactor < 1 means "zoomed in"; > 1 means
                // "zoomed out".) The factor we check is newSpan / dataSpan.
                // C0: the span ratios are measured in the axis's OWN space so the
                // zoom cap means the same thing on a log axis. A log span is the
                // decade count (log(hi)-log(lo)); a linear span is hi-lo.
                const xLog = xScale.type === 'log';
                const yLog = yScale.type === 'log';
                const axisSpan = (lo, hi, isLog) =>
                    isLog ? (Math.log(hi) - Math.log(lo)) : (hi - lo);
                const dataXSpan = axisSpan(_dataDomain.xMin, _dataDomain.xMax, xLog);
                const dataYSpan = axisSpan(_dataDomain.yMin, _dataDomain.yMax, yLog);
                const proposedXSpan = axisSpan(start.xMin, start.xMax, xLog) * zoomFactor;
                const proposedYSpan = axisSpan(start.yMin, start.yMax, yLog) * zoomFactor;
                // v1.8.0: under swap the band axis (x) is pinned (zoomX=1), so its
                // ratio is always 1 -- force it here so the x-ratio veto below can
                // never wrongly block a legit value-axis (y) zoom.
                const proposedXRatio = swapAxes ? 1 : (dataXSpan > 0 ? proposedXSpan / dataXSpan : 1);
                const proposedYRatio = dataYSpan > 0 ? proposedYSpan / dataYSpan : 1;
                // Block the zoom if either axis would exceed bounds. We
                // could split the factor per axis but symmetric zoom is
                // the convention; refusing here keeps interaction predictable.
                if (proposedXRatio < zoomMinFactor || proposedYRatio < zoomMinFactor) return;
                if (proposedXRatio > zoomMaxFactor || proposedYRatio > zoomMaxFactor) return;
                const newView = (xLog || yLog)
                    ? _applyZoomLog(
                        start,
                        p.x, p.y,
                        plotBoundsBox.x, plotBoundsBox.y, plotBoundsBox.w, plotBoundsBox.h,
                        zoomFactor, zoomFactor, xLog, yLog,
                    )
                    // v1.8.0: horizontal bar swaps axis roles. Keep the value under
                    // the cursor fixed by mapping anchorPy = pb.w-(p.x-pb.x) (ty=1-tx)
                    // and pinning the band axis with zoomX=1.
                    : (swapAxes
                        ? _applyZoom(
                            start,
                            p.x, plotBoundsBox.w - (p.x - plotBoundsBox.x),
                            plotBoundsBox.x, 0, plotBoundsBox.w, plotBoundsBox.w,
                            1, zoomFactor,
                        )
                        : _applyZoom(
                            start,
                            p.x, p.y,
                            plotBoundsBox.x, plotBoundsBox.y, plotBoundsBox.w, plotBoundsBox.h,
                            zoomFactor, zoomFactor,
                        ));
                if (panBoundsMode === 'data' && _dataDomain) {
                    if (xLog || yLog) _clampToBoundsLog(newView, _dataDomain, xLog, yLog);
                    else _clampToBounds(newView, _dataDomain);
                }
                viewSig.set(newView);
            } : null;

            if (panEnabled) {
                canvas.addEventListener('pointerdown', onPanDown);
                canvas.addEventListener('pointermove', onPanMove);
                canvas.addEventListener('pointerup', onPanUp);
                canvas.addEventListener('pointercancel', onPanUp);
                canvas.addEventListener('pointerleave', onPanUp);
                disposers.push(() => {
                    canvas.removeEventListener('pointerdown', onPanDown);
                    canvas.removeEventListener('pointermove', onPanMove);
                    canvas.removeEventListener('pointerup', onPanUp);
                    canvas.removeEventListener('pointercancel', onPanUp);
                    canvas.removeEventListener('pointerleave', onPanUp);
                });
            }
            if (zoomEnabled) {
                // passive:false so preventDefault stops page scroll.
                canvas.addEventListener('wheel', onWheel, { passive: false });
                disposers.push(() => canvas.removeEventListener('wheel', onWheel));
            }

            // v1.4.0-alpha.3: brush gesture handlers. Independent of
            // pan/zoom state (separate flag, separate active bit). Same
            // pointer-event family so they coexist with the pan
            // listeners on the same canvas; routing happens in
            // pointerdown via ev.shiftKey.
            if (brushEnabled) {
                let brushActive = false;
                let brushStartX = 0, brushStartY = 0;
                let brushCurrentX = 0, brushCurrentY = 0;

                const onBrushDown = (ev) => {
                    if (ev.button != null && ev.button > 0) return;
                    if (!ev.shiftKey) return;       // bare drag = pan; shift = brush
                    const p = _canvasPx(ev);
                    if (!_inPlot(p.x, p.y)) return;
                    brushActive = true;
                    brushStartX = brushCurrentX = p.x;
                    brushStartY = brushCurrentY = p.y;
                    // Hide crosshair during brush (matches pan behavior).
                    if (typeof hideCrosshair === 'function') hideCrosshair();
                    if (typeof canvas.setPointerCapture === 'function' && ev.pointerId != null) {
                        try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* swallow */ }
                    }
                    if (typeof ev.preventDefault === 'function') ev.preventDefault();
                };

                const _commitBrush = () => {
                    // Compute data-space bounds from the current pixel
                    // rect using the live scales. ids come from the
                    // primary series (idx 0); multi-series filtering is
                    // the caller's responsibility (the brush bounds are
                    // the universal hook for that).
                    const rect = _normalizeBrushRect(brushStartX, brushStartY, brushCurrentX, brushCurrentY);
                    if (swapAxes) {
                        // Horizontal bars: value axis on screen-X (yScale, no
                        // y-flip); band axis on screen-Y (xScale is the band
                        // scale under swap). xScale.invert floors a pixel to a
                        // band INDEX clamped to [0, n-1]. state.xs holds the band
                        // index and state.ys the value, so _computeBrushIds runs
                        // byte-identical with swapped args.
                        const v0 = yScale.invert(rect.pxMin);
                        const v1 = yScale.invert(rect.pxMax);
                        const valueMin = Math.min(v0, v1);
                        const valueMax = Math.max(v0, v1);
                        if (!Number.isFinite(valueMin) || !Number.isFinite(valueMax)) {
                            brushSig.set(null);
                            return;
                        }
                        const b0 = xScale.invert(rect.pyMin);
                        const b1 = xScale.invert(rect.pyMax);
                        const bandMin = Math.min(b0, b1);
                        const bandMax = Math.max(b0, b1);
                        if (bandMin < 0) {          // no categories -- fail closed
                            brushSig.set(null);
                            return;
                        }
                        const cats = categoriesRef.value;
                        const bands = [];
                        for (let b = bandMin; b <= bandMax; b++) bands.push(cats[b]);
                        let ids = null;
                        if (seriesStates.length > 0 && seriesStates[0].n > 0) {
                            ids = _computeBrushIds(
                                seriesStates[0].xs,
                                seriesStates[0].ys,
                                seriesStates[0].n,
                                bandMin, bandMax,
                                valueMin, valueMax,
                            );
                        }
                        brushSig.set({ valueMin, valueMax, bandMin, bandMax, bands, ids });
                        return;
                    }
                    const dataBounds = _brushPxToData(rect, xScale, yScale);
                    let ids = null;
                    if (seriesStates.length > 0 && seriesStates[0].n > 0) {
                        ids = _computeBrushIds(
                            seriesStates[0].xs,
                            seriesStates[0].ys,
                            seriesStates[0].n,
                            dataBounds.xMin, dataBounds.xMax,
                            dataBounds.yMin, dataBounds.yMax,
                        );
                    }
                    brushSig.set({
                        xMin: dataBounds.xMin,
                        xMax: dataBounds.xMax,
                        yMin: dataBounds.yMin,
                        yMax: dataBounds.yMax,
                        ids,
                    });
                };

                const onBrushMove = (ev) => {
                    if (!brushActive) return;
                    const p = _canvasPx(ev);
                    brushCurrentX = p.x;
                    brushCurrentY = p.y;
                    _commitBrush();
                };

                const onBrushUp = (ev) => {
                    if (!brushActive) return;
                    brushActive = false;
                    // Click-to-clear: if total drag distance is below
                    // threshold, treat as a click and clear the brush.
                    const dx = brushCurrentX - brushStartX;
                    const dy = brushCurrentY - brushStartY;
                    const dist2 = dx * dx + dy * dy;
                    if (dist2 < brushClickThreshold * brushClickThreshold) {
                        brushSig.set(null);
                    } else {
                        // Final commit (in case the last move was missed).
                        _commitBrush();
                    }
                    if (typeof canvas.releasePointerCapture === 'function' && ev && ev.pointerId != null) {
                        try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* swallow */ }
                    }
                };

                canvas.addEventListener('pointerdown', onBrushDown);
                canvas.addEventListener('pointermove', onBrushMove);
                canvas.addEventListener('pointerup', onBrushUp);
                canvas.addEventListener('pointercancel', onBrushUp);
                canvas.addEventListener('pointerleave', onBrushUp);
                disposers.push(() => {
                    canvas.removeEventListener('pointerdown', onBrushDown);
                    canvas.removeEventListener('pointermove', onBrushMove);
                    canvas.removeEventListener('pointerup', onBrushUp);
                    canvas.removeEventListener('pointercancel', onBrushUp);
                    canvas.removeEventListener('pointerleave', onBrushUp);
                });
            }
        }

        // -- Legend (DOM) --
        // Built only when (a) the chart owns its canvas (mounted into an
        // element, not a bare canvas), (b) `document` is available, and
        // (c) `legend !== false`. Tests that mount mock canvases skip this
        // path; they verify visibility via chart.setSeriesVisible() directly.
        if (legendEnabled) {
            const fontResolved = config.font != null ? config.font : DEFAULT_FONT;
            const labelColorResolved = resolveColor(config.labelColor || DEFAULT_LABEL_COLOR, container);
            if (legendVSpec) {
                // v1.12.0: virtualized legend. Adapter owns row windowing; we
                // own row contents + the shared visibility effect. Same
                // attach/wrapper logic as the eager path (installLegend
                // unchanged), same fail-closed gates (no document / bare canvas
                // -> chart.legend stays null, adapter never called).
                const vbuilt = buildVirtualLegendDOM(
                    { position: legendPosition, container: legendContainer },
                    legendVSpec,
                    normalized,
                    seriesVisibility,
                    seriesRefs,
                    fontResolved,
                    labelColorResolved,
                    disposers,
                );
                if (vbuilt) {
                    legendEl = vbuilt.legendEl;
                    legendVHandle = vbuilt.handle;
                    legendVRepaint = vbuilt.repaint;
                }
            } else {
                legendEl = buildLegendDOM(
                    { position: legendPosition, container: legendContainer },
                    normalized,
                    seriesVisibility,
                    seriesRefs,
                    fontResolved,
                    labelColorResolved,
                    disposers,
                );
            }
            if (legendEl) {
                if (legendContainer) {
                    // User-provided container: append directly, don't wrap canvas.
                    legendContainer.appendChild(legendEl);
                } else if (ownedCanvas && container) {
                    // Wrap canvas + legend so position controls layout.
                    legendWrapper = installLegend(container, canvas, legendEl, legendPosition);
                }
                // If neither condition fires (bare canvas mount, no container
                // override), legendEl is built but not attached -- it would
                // dangle. Drop it.
                if (!legendContainer && !legendWrapper) {
                    legendEl = null;
                    legendVHandle = null;
                    legendVRepaint = null;
                }
            }
        }

        mounted = true;
        return chart;
    };

    const unmount = () => {
        if (!mounted) return;
        for (let i = 0; i < disposers.length; i++) {
            try { disposers[i](); } catch (_) { /* swallow */ }
        }
        disposers.length = 0;
        // v1.2.0-alpha.0: per-renderer state cleanup hook. Bubble uses it to
        // dispose spatial indices (which may hold external resources); other
        // renderers don't define it and pay only a null-check. Moving the
        // hook here -- vs an unconditional loop -- keeps the spatial-index
        // helper out of line / area / bar bundles entirely.
        if (renderer.cleanup) {
            try { renderer.cleanup(seriesStates); } catch (_) { /* swallow */ }
        }
        if (scene) {
            try { scene.dispose(); } catch (_) { /* swallow */ }
            scene = null;
        }
        // Legend tear-down: remove whichever DOM we owned.
        if (legendWrapper && legendWrapper.parentNode) {
            legendWrapper.parentNode.removeChild(legendWrapper);
        } else if (legendEl && legendEl.parentNode) {
            // User-provided container case: remove the legend we appended.
            legendEl.parentNode.removeChild(legendEl);
        } else if (ownedCanvas && container && canvas && canvas.parentNode === container) {
            // No legend, no wrapper, owned canvas directly under container.
            container.removeChild(canvas);
        }
        legendEl = null;
        legendWrapper = null;
        // v1.12.0: adapter dispose rides the disposers loop above; just drop refs.
        legendVHandle = null;
        legendVRepaint = null;
        canvas = null;
        container = null;
        mounted = false;
    };

    // v1.2.0: terminal teardown. `unmount()` keeps construction-time signals
    // alive so the chart can be remounted; `destroy()` disposes them too,
    // freeing their lite-signal arena slots. Use this for apps that create
    // and destroy many charts dynamically (dashboard tabs, design builders)
    // where the residue from `unmount()` would otherwise accumulate.
    let destroyed = false;
    const destroy = () => {
        if (destroyed) return;
        if (mounted) unmount();
        for (let i = 0; i < _ownedSignals.length; i++) {
            try { dispose(_ownedSignals[i]); } catch (_) { /* swallow */ }
        }
        _ownedSignals.length = 0;
        destroyed = true;
    };

    const exportPNG = (opts) => {
        if (!mounted || !canvas) {
            throw new Error('lite-charts: exportPNG() requires mount() first');
        }
        if (typeof canvas.toDataURL !== 'function') {
            throw new Error('lite-charts: exportPNG() requires a real HTMLCanvasElement');
        }
        const mime = (opts && opts.mimeType) || 'image/png';
        const quality = (opts && opts.quality != null) ? opts.quality : 0.92;
        return canvas.toDataURL(mime, quality);
    };

    // v1.3.0: SVG export. Resolution-independent, embeddable in PDFs and
    // static HTML. Walks the live scene tree through a Canvas2D-shim;
    // the chart code doesn't need to know it's rendering to SVG.
    const exportSVG = (opts) => {
        if (!mounted || !scene) {
            throw new Error('lite-charts: exportSVG() requires mount() first');
        }
        const w = +widthAcc() | 0 || 800;
        const h = +heightAcc() | 0 || 400;
        const bg = (opts && opts.background !== undefined)
            ? opts.background
            : (config.background != null ? config.background : null);
        return _exportSceneToSVG(scene, w, h, bg);
    };

    const redraw = () => {
        if (scene) scene.markDirty();
    };

    // -- Crosshair / tooltip helpers --
    // These are defined at the chart-instance scope (not inside mount) so they
    // capture the same xScale/seriesStates/plotBoundsBox refs the mount
    // effects use. They become no-ops if interaction is disabled or if the
    // chart isn't mounted.

    const moveCrosshair = (canvasX, canvasY) => {
        if (!interactionEnabled || !mounted) return;
        const pb = plotBoundsBox;
        // Outside the plot rect -> hide.
        if (canvasX < pb.x || canvasX > pb.x + pb.w
            || canvasY < pb.y || canvasY > pb.y + pb.h) {
            hideCrosshair();
            return;
        }

        // Renderer decides how to snap: bisect (line/area) or floor-divide
        // (bar). Returns null when nothing's in range -> hide.
        const primary = seriesStates[0];
        if (!primary || primary.n === 0) {
            hideCrosshair();
            return;
        }
        const hit = renderer.hitTest(canvasX, canvasY, primary, xScale, rendererCtx);
        if (!hit) {
            hideCrosshair();
            return;
        }

        // Zero-alloc dedup + mutate. crosshairData is the live mutable
        // reference; we read its current fields, decide whether anything
        // actually changed, and either bail or mutate-and-bump-version.
        // v1.2.0-alpha.2: snapSeriesIdx participates in dedup so a hover
        // that moves from series A's point to series B's point (same row
        // index, different series) still re-renders the tooltip.
        const hitSeriesIdx = hit.snapSeriesIdx != null ? hit.snapSeriesIdx : -1;
        // Dedup on the FREE axis's cursor pixel: vertical anchors the tooltip
        // box Y on mousePixelY (box X is snapPixelX, fixed per snap), horizontal
        // anchors box X on mousePixelX (box Y is snapPixelX). Checking only
        // mousePixelY would freeze a horizontal tooltip as the cursor slides
        // along the value axis inside one band (snapIdx + Y unchanged).
        if (crosshairData.visible
            && crosshairData.snapIdx === hit.snapIdx
            && crosshairData.snapSeriesIdx === hitSeriesIdx
            && (swapAxes ? crosshairData.mousePixelX === canvasX
                         : crosshairData.mousePixelY === canvasY)) return;
        crosshairData.visible = true;
        crosshairData.snapIdx = hit.snapIdx;
        crosshairData.snapDomainX = hit.snapDomainX;
        crosshairData.snapPixelX = hit.snapPixelX;
        crosshairData.snapSeriesIdx = hitSeriesIdx;
        crosshairData.mousePixelX = canvasX;
        crosshairData.mousePixelY = canvasY;
        crosshairVersion.update((x) => (x + 1) | 0);
    };

    const hideCrosshair = () => {
        if (!interactionEnabled) return;
        if (!crosshairData.visible) return;
        crosshairData.visible = false;
        crosshairData.snapIdx = -1;
        crosshairData.snapDomainX = 0;
        crosshairData.snapPixelX = 0;
        crosshairData.snapSeriesIdx = -1;
        crosshairData.mousePixelX = 0;
        crosshairData.mousePixelY = 0;
        crosshairVersion.update((x) => (x + 1) | 0);
    };

    // Renders the crosshair vertical line, per-series marker circles, and the
    // tooltip box. Called via the scene's `path` node `draw` raw prop. All
    // signal reads are direct field reads on the mutable crosshairData; the
    // dirty bridge subscribes to crosshairVersion and handles markDirty.
    const drawCrosshair = (ctx) => {
        const state = crosshairData;
        if (!state.visible) return;
        const pb = plotBoundsBox;
        const x = state.snapPixelX;

        // --- Crosshair guide line ---
        // _guide is selected once at setup: a vertical line for standard
        // orientation, a horizontal line when the axes are swapped. `x` is the
        // band-axis pixel either way (an X normally, a Y when horizontal).
        if (crosshairOpts) {
            _guide(ctx, x, pb, crosshairColorRef.value, crosshairDash);
        }

        // --- Per-series marker circles ---
        // Renderers that prefer to self-highlight (e.g. bar -- the bars are
        // their own visual hit target) opt out via drawPerSeriesMarkers=false.
        if (crosshairOpts && renderer.drawPerSeriesMarkers) {
            for (let i = 0; i < seriesStates.length; i++) {
                if (!seriesRefs[i].visibleRef.value) continue;
                const s = seriesStates[i];
                if (s.n === 0) continue;
                // Snap each series at the primary's domain x (multi-series with
                // misaligned xs still line up at the cursor).
                const myIdx = renderer.lookupRow(s, state.snapIdx, state.snapDomainX, rendererCtx);
                if (myIdx < 0) continue;
                const mx = s.pxs[myIdx];
                const my = s.pys[myIdx];
                if (mx < pb.x || mx > pb.x + pb.w) continue;
                ctx.fillStyle = seriesRefs[i].colorRef.value;
                ctx.strokeStyle = DEFAULT_TOOLTIP_MARKER_STROKE;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(mx, my, 4, 0, _TWO_PI);
                ctx.fill();
                ctx.stroke();
            }
        }

        // --- Tooltip box ---
        if (tooltipOpts) drawTooltip(ctx, state);
    };

    const drawTooltip = (ctx, state) => {
        const pb = plotBoundsBox;
        const padding = 8;
        const swatch = 8;
        const lineHeight = 14;
        const gap = 12;

        // Build rows. ALLOCATES, but this fires at mousemove rate, not per-frame.
        const rows = [];
        for (let i = 0; i < seriesStates.length; i++) {
            if (!seriesRefs[i].visibleRef.value) continue;
            const s = seriesStates[i];
            if (s.n === 0) continue;
            const myIdx = renderer.lookupRow(s, state.snapIdx, state.snapDomainX, rendererCtx);
            if (myIdx < 0) continue;
            rows.push({
                color: seriesRefs[i].colorRef.value,
                label: normalized[i].name,
                value: formatTooltipValue(s.ys[myIdx]),
            });
        }
        if (rows.length === 0) return;

        // Tooltip header: renderer picks the format (category name for bar,
        // formatted number/date for line/area).
        const defaultHeaderText = renderer.formatTooltipHeader(
            state.snapIdx, state.snapDomainX, resolvedXType, rendererCtx,
        );

        // Custom formatter override: replace the whole row set + header.
        // `category` is preserved for the tooltipFormatter contract -- bar
        // tooltips pass it; line/area pass null. Use the header text the
        // renderer produced as the default when the formatter doesn't supply one.
        const barCategoryName = renderer.forceXType === 'band'
            && state.snapIdx >= 0
            && state.snapIdx < categoriesRef.value.length
            ? categoriesRef.value[state.snapIdx]
            : null;
        let headerText;
        if (tooltipFormatter) {
            const out = tooltipFormatter({
                snapIdx: state.snapIdx,
                snapDomainX: state.snapDomainX,
                xScaleType: resolvedXType,
                category: barCategoryName,
                rows,
            });
            if (typeof out === 'string') {
                headerText = out;
                rows.length = 0;
            } else if (out && typeof out === 'object') {
                headerText = out.header != null ? out.header : defaultHeaderText;
                if (Array.isArray(out.rows)) {
                    rows.length = 0;
                    for (let i = 0; i < out.rows.length; i++) rows.push(out.rows[i]);
                }
            } else {
                headerText = defaultHeaderText;
            }
        } else {
            headerText = defaultHeaderText;
        }

        // Measure widths.
        ctx.font = axisStyleRefs.font.value;
        let maxRowWidth = ctx.measureText(headerText).width;
        for (let i = 0; i < rows.length; i++) {
            const w = swatch + 6 + ctx.measureText(rows[i].label + ': ' + rows[i].value).width;
            if (w > maxRowWidth) maxRowWidth = w;
        }
        const boxW = maxRowWidth + padding * 2;
        const boxH = (rows.length + 1) * lineHeight + padding;

        // Position: right of the crosshair, flip left if the box would clip
        // the right plot edge. Vertically centered on the cursor, clamped to
        // the plot rect. v1.5.0: when the axes are swapped, the box X anchors
        // on the free-axis cursor (mousePixelX) and the box Y centres on the
        // band-axis pixel (snapPixelX, a Y here).
        const anchorX = swapAxes ? state.mousePixelX : state.snapPixelX;
        const anchorY = swapAxes ? state.snapPixelX : state.mousePixelY;
        let boxX = anchorX + gap;
        if (boxX + boxW > pb.x + pb.w) boxX = anchorX - gap - boxW;
        if (boxX < pb.x) boxX = pb.x;
        let boxY = anchorY - boxH / 2;
        if (boxY < pb.y) boxY = pb.y;
        if (boxY + boxH > pb.y + pb.h) boxY = pb.y + pb.h - boxH;

        // Background.
        ctx.fillStyle = tooltipBgRef.value;
        ctx.strokeStyle = tooltipBorderRef.value;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(boxX, boxY, boxW, boxH);
        ctx.fill();
        ctx.stroke();

        // Header.
        ctx.fillStyle = axisStyleRefs.labelColor.value;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(headerText, boxX + padding, boxY + padding);

        // Rows.
        for (let i = 0; i < rows.length; i++) {
            const rowY = boxY + padding + (i + 1) * lineHeight;
            ctx.fillStyle = rows[i].color;
            ctx.fillRect(boxX + padding, rowY + 2, swatch, swatch);
            ctx.fillStyle = axisStyleRefs.labelColor.value;
            ctx.fillText(rows[i].label + ': ' + rows[i].value, boxX + padding + swatch + 6, rowY);
        }
    };

    const setSeriesVisible = (idx, visible) => {
        if (idx < 0 || idx >= seriesVisibility.length) return;
        seriesVisibility[idx].set(!!visible);
    };

    // Re-resolves every CSS-var-driven color against the current container's
    // computed style. Call after a theme switch (dark mode, etc.) to update
    // colors that were specified as '--var-name' tokens. Hex / oklch / named
    // colors pass through unchanged. No-op if not mounted.
    const refreshTheme = () => {
        if (!mounted) return;
        for (let i = 0; i < normalized.length; i++) {
            const resolvedColor = resolveColor(normalized[i].color, container);
            seriesRefs[i].colorRef.value = resolvedColor;
            // Markers default to series color; re-resolve so they track too.
            // (If user specified an explicit markers.fill, _resolveMarkers
            // captured that fixed value -- we re-resolve from the same input,
            // which yields the same explicit fill.)
            seriesRefs[i].markersRef.value = _resolveMarkers(normalized[i].markers, resolvedColor);
        }
        axisStyleRefs.tickColor.value = resolveColor(config.axisColor || DEFAULT_AXIS_COLOR, container);
        axisStyleRefs.labelColor.value = resolveColor(config.labelColor || DEFAULT_LABEL_COLOR, container);
        gridColorRef.value = resolveColor(gridColorSpec, container);
        crosshairColorRef.value = resolveColor(crosshairColorSpec, container);
        tooltipBgRef.value = resolveColor(tooltipBgSpec, container);
        tooltipBorderRef.value = resolveColor(tooltipBorderSpec, container);
        // Re-fire the annotation resolve/color step so CSS-var-driven rule /
        // fill / label colors track the theme. The markDirty below repaints.
        if (annThemeVersion) annThemeVersion.update((v) => (v + 1) | 0);
        // Update legend swatches too -- they were styled from colorRef at build time.
        // v1.12.0: the virtualized legend has no positional span:first-child map
        // (rows are pooled/recycled), so repaint the bound rows by index instead.
        if (legendVRepaint) {
            legendVRepaint();
        } else if (legendEl) {
            const swatches = legendEl.querySelectorAll('span:first-child');
            for (let i = 0; i < swatches.length && i < seriesRefs.length; i++) {
                swatches[i].style.background = seriesRefs[i].colorRef.value;
            }
        }
        if (scene) scene.markDirty();
    };

    const chart = {
        mount,
        unmount,
        destroy,
        exportPNG,
        exportSVG,
        redraw,
        moveCrosshair,
        hideCrosshair,
        setSeriesVisible,
        refreshTheme,
        get scene() { return scene; },
        get canvas() { return canvas; },
        get xScale() { return xScale; },
        get yScale() { return yScale; },
        get xScaleType() { return resolvedXType; },
        get legend() { return legendEl; },
        plotBounds: plotBoundsSignal,
        crosshair: crosshairFacade,
        // v1.4.0-alpha.2: pan/zoom view accessor. `chart.view()` reads
        // reactively (tracks); `chart.view.peek()` reads untracked;
        // `chart.view.set(v)` and `chart.view.reset()` write.
        // `chart.setView` / `chart.resetView` are convenience aliases.
        // All three throw if neither `pan: true` nor `zoom: true` was
        // set at construction (signals the user they need to opt in).
        view: viewFacade,
        setView: viewFacade.set,
        resetView: viewFacade.reset,
        // v1.4.0-alpha.3: brush reactive accessor + imperative aliases.
        // brushFacade always exists; calls into set/clear throw if
        // `brush: true` was not in config (matches view's pattern).
        brush: brushFacade,
        setBrush: brushFacade.set,
        clearBrush: brushFacade.clear,
        seriesVisibility,
        // Test/debug introspection -- per-chart state ONLY. Pure helpers
        // (decimateMinMax, makeBandScale, etc.) used to live here for white-
        // box tests, but that pinned every helper in the reachable set of
        // every chart instance, defeating tree-shaking. Pure helpers now
        // live in `_testHelpers` (separate top-level export) -- normal
        // production code never imports it, so bundlers drop everything
        // unused. Tests destructure from `_testHelpers` instead.
        _internal: {
            seriesStates,
            seriesRefs,
            scaleVersion,
            plotBoundsBox,
            categoriesRef,
            // v1.7.0: the annotation layer handle (pools/buffers/dispose), or
            // null when no `annotations` config. A getter because annHandle is
            // assigned in mount(), after this object is built.
            get annotations() { return annHandle; },
        },
    };

    return chart;
};

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------
//
// White-box access to pure helpers for unit testing. NOT part of the stable
// public API; the leading underscore signals private. Critically, this is a
// SEPARATE export from any chart factory -- normal user code that does
// `import { createLineChart }` never references it, so the bundler drops it
// and (transitively) drops every helper that's only reachable through it.
//
// To verify: build `import { createLineChart } from '...'` and grep for
// makeBandScale / extractBarSeriesData / updateBandScale. They should NOT
// appear. If they do, something inside createBaseAxisChart or LINE_RENDERER
// is referencing them (a leak) and needs to be untangled.

// Forward declarations -- the real _testHelpers export lives AFTER the
// polar kernel so it can reference slice helpers (TDZ otherwise). For
// readers: see `_testHelpers` near the bottom of the file.

// ===========================================================================
// Polar chart kernel -- pie / donut (radar follows in v1.2.0-alpha.2)
// ===========================================================================
//
// Independent kernel from createBaseAxisChart. Tree-shake boundary holds the
// same shape as before: importing only `createPieChart` does NOT pull in
// xScale/yScale/axes/decimation/interpolation/bisect/bar code -- and
// importing only axis charts does NOT pull in slice geometry / polar hit
// detection / arc rendering. The two kernels share only chart-type-agnostic
// helpers at module level (asAccessor, resolveColor, ensureFloat32, scene
// nodes, installLegend) which are leaf utilities that don't reach back into
// either kernel's specialized code paths.

// ---- Polar state ----------------------------------------------------------
//
// One chart instance = one slice list. Parallel arrays for tight cache
// locality. `total` is the sum of ALL values; `visibleTotal` is the sum of
// currently-visible slices (drives the angle factor so hidden slices give
// up their wedge to visible neighbours).

const makePolarState = () => ({
    values: null,         // Float32Array (parallel to labels/colors/visible)
    labels: null,         // string[] (NOT pooled -- strings aren't SoA-friendly)
    colors: null,         // string[] (raw color specs; resolved each frame via resolveColor)
    visible: null,        // Uint8Array (1 = visible, 0 = hidden)
    startAngles: null,    // Float64Array (cumulative offsets, 0..2*PI; needs F64 precision at boundaries)
    arcAngles: null,      // Float64Array (per-slice arc length in radians)
    n: 0,
    total: 0,             // sum of values (all slices)
    visibleTotal: 0,      // sum of values (visible slices only)
});

// Normalize input into the polar state. Accepts:
//   1. Array of { label?, value, color? } objects
//   2. { values: number[], labels?: string[], colors?: string[] }
//   3. Plain number array (labels auto-generated as "slice 0", "slice 1", ...)
// Negative values clamp to 0 (pie/donut requires non-negative input).

const extractSliceData = (state, input) => {
    let n = 0;
    let getValue, getLabel, getColor;

    if (Array.isArray(input)) {
        n = input.length;
        const isObjShape = n > 0 && input[0] !== null && typeof input[0] === 'object';
        if (isObjShape) {
            getValue = (i) => +input[i].value;
            getLabel = (i) => input[i].label != null ? String(input[i].label) : ('slice ' + i);
            getColor = (i) => input[i].color != null ? input[i].color : null;
        } else {
            // Plain number array
            getValue = (i) => +input[i];
            getLabel = (i) => 'slice ' + i;
            getColor = () => null;
        }
    } else if (input && Array.isArray(input.values)) {
        n = input.values.length;
        const labelsArr = Array.isArray(input.labels) ? input.labels : null;
        const colorsArr = Array.isArray(input.colors) ? input.colors : null;
        getValue = (i) => +input.values[i];
        getLabel = (i) => labelsArr && labelsArr[i] != null ? String(labelsArr[i]) : ('slice ' + i);
        getColor = (i) => colorsArr && colorsArr[i] != null ? colorsArr[i] : null;
    } else {
        state.n = 0;
        state.total = 0;
        state.visibleTotal = 0;
        return;
    }

    state.values      = ensureFloat32(state.values,      n);

    // Angles need Float64 precision: Float32(PI/2) = 1.5707963705..., which
    // is SLIGHTLY larger than the Float64 PI/2 = 1.5707963267... that
    // Math.atan2 produces at 3 o'clock. With Float32 storage, an input
    // exactly at a slice boundary would fall into the wrong slice due to
    // the asymmetric rounding. Float64 keeps the boundary exact.
    if (state.startAngles === null || state.startAngles.length < n) {
        state.startAngles = new Float64Array(Math.max(n, 4));
    }
    if (state.arcAngles === null || state.arcAngles.length < n) {
        state.arcAngles = new Float64Array(Math.max(n, 4));
    }

    // Resize non-typed parallel arrays. Strings can't pack into typed buffers
    // so we accept the per-slice JS heap object overhead.
    if (state.labels === null || state.labels.length !== n) {
        const next = new Array(n);
        if (state.labels) {
            const carry = Math.min(state.labels.length, n);
            for (let i = 0; i < carry; i++) next[i] = state.labels[i];
        }
        state.labels = next;
    }
    if (state.colors === null || state.colors.length !== n) {
        const next = new Array(n);
        if (state.colors) {
            const carry = Math.min(state.colors.length, n);
            for (let i = 0; i < carry; i++) next[i] = state.colors[i];
        }
        state.colors = next;
    }
    // Visibility: preserve existing flags where indices match; default new
    // slots to 1 (visible). Tracking visibility separately from values means
    // toggling a slice off doesn't lose its value when toggled back on.
    if (state.visible === null || state.visible.length < n) {
        const next = new Uint8Array(Math.max(n, 4));
        const carry = state.visible ? Math.min(state.visible.length, n) : 0;
        for (let i = 0; i < carry; i++) next[i] = state.visible[i];
        for (let i = carry; i < next.length; i++) next[i] = 1;
        state.visible = next;
    }

    let total = 0;
    let visibleTotal = 0;
    for (let i = 0; i < n; i++) {
        const v = getValue(i);
        const clean = v >= 0 ? v : 0;   // reject negatives + NaN
        state.values[i] = clean;
        state.labels[i] = getLabel(i);
        state.colors[i] = getColor(i);
        total += clean;
        if (state.visible[i]) visibleTotal += clean;
    }
    state.n = n;
    state.total = total;
    state.visibleTotal = visibleTotal;

    recomputePolarAngles(state);
};

// Recompute per-slice startAngle + arcAngle from values + visibility.
// Called after extraction OR after a visibility toggle (which doesn't
// re-extract data but does change visibleTotal).

const recomputePolarAngles = (state) => {
    let cum = 0;
    const factor = state.visibleTotal > 0 ? _TWO_PI / state.visibleTotal : 0;
    for (let i = 0; i < state.n; i++) {
        state.startAngles[i] = cum;
        const arc = state.visible[i] ? state.values[i] * factor : 0;
        state.arcAngles[i] = arc;
        cum += arc;
    }
};

// ---- Geometry -------------------------------------------------------------
//
// `innerRadius` config interpretation:
//   - number in [0, 1]: fraction of outer radius (0 = pie, 0.5 = donut)
//   - number > 1:       absolute pixel value (clamped to <= rOuter - 1)
//   - anything else:    0
// The geometry object is the SAME object across renders -- mutated in place,
// readers grab field values eagerly. Same zero-alloc discipline as plot
// bounds in the axis kernel.

const computeSliceGeometry = (geometry, plotBoundsBox, innerRadiusConfig) => {
    const cx = plotBoundsBox.x + plotBoundsBox.w / 2;
    const cy = plotBoundsBox.y + plotBoundsBox.h / 2;
    const maxR = Math.min(plotBoundsBox.w, plotBoundsBox.h) / 2;
    const rOuter = maxR > 0 ? maxR : 0;
    let rInner;
    if (typeof innerRadiusConfig === 'number' && innerRadiusConfig > 0) {
        if (innerRadiusConfig <= 1) {
            rInner = rOuter * innerRadiusConfig;
        } else {
            rInner = innerRadiusConfig < rOuter - 1 ? innerRadiusConfig : rOuter - 1;
            if (rInner < 0) rInner = 0;
        }
    } else {
        rInner = 0;
    }
    geometry.cx = cx;
    geometry.cy = cy;
    geometry.rOuter = rOuter;
    geometry.rInner = rInner;
    return geometry;
};

// ---- Slice draw fn factory ------------------------------------------------
//
// Draws each visible slice as a wedge (pie) or arc-ring (donut). All slices
// share a single draw call (no per-slice scene node), batched by colour to
// minimize state changes on the 2D context. Inner stroke is drawn on top of
// fills to avoid colour bleed between adjacent slices.

const SLICE_START_OFFSET = -Math.PI / 2;   // begin at 12-o'clock
const SLICE_HOVER_EXPAND = 4;              // px outward growth on hover

// `colorsRef` is a stable array reference held by createBasePolarChart and
// mutated in place by refreshResolvedColors. The draw fn reads it on every
// frame, so theme changes show up without recreating the fn. CRITICAL: the
// raw `state.colors[i]` strings may be CSS variable names like '--c-primary'
// -- canvas's fillStyle silently ignores invalid colour strings (keeps the
// previous value), so passing them directly would render every slice white.
// Always read from the resolved array.

const makeSliceDrawFn = (state, geometry, colorsRef, sliceStrokeRef, sliceStrokeWidthRef, highlightRef) => (ctx) => {
    if (state.n === 0) return;
    const cx = geometry.cx;
    const cy = geometry.cy;
    const rOuterMax = geometry.rOuter;
    const rInner = geometry.rInner;
    if (rOuterMax <= 0) return;
    // Reserve room for the hover-expand so a highlighted slice doesn't paint
    // outside the plot rect. Base radius is shrunk by SLICE_HOVER_EXPAND
    // (clamped so we never go negative for tiny charts).
    const rOuterBase = rOuterMax > SLICE_HOVER_EXPAND ? rOuterMax - SLICE_HOVER_EXPAND : rOuterMax;
    const sw = sliceStrokeWidthRef.value;
    const stroke = sw > 0 ? sliceStrokeRef.value : null;
    const highlightIdx = highlightRef ? highlightRef.value : -1;
    const colors = colorsRef;  // stable reference; values may have changed since last frame

    for (let i = 0; i < state.n; i++) {
        if (!state.visible[i]) continue;
        const arc = state.arcAngles[i];
        if (arc <= 0) continue;
        const a0 = state.startAngles[i] + SLICE_START_OFFSET;
        const a1 = a0 + arc;
        const ro = i === highlightIdx ? rOuterMax : rOuterBase;
        const fill = colors[i] || DEFAULT_SLICE_PALETTE[i % DEFAULT_SLICE_PALETTE.length];

        ctx.fillStyle = fill;
        ctx.beginPath();
        if (rInner > 0) {
            ctx.arc(cx, cy, ro,     a0, a1);
            ctx.arc(cx, cy, rInner, a1, a0, true);
            ctx.closePath();
        } else {
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, ro, a0, a1);
            ctx.closePath();
        }
        ctx.fill();
        if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = sw;
            ctx.stroke();
        }
    }
};

// ---- Hit detection --------------------------------------------------------
//
// O(n) linear scan over slices. n is typically small (3-12 slices in
// practice); a binary search on cumulative angles would be faster
// asymptotically but the constant-factor overhead isn't worth it below ~50
// slices. Atan2 returns (-PI, PI]; we shift by +PI/2 so angle 0 points up.
// Hidden slices are skipped (their arcAngle is 0, so the range check fails
// naturally, but we exit early on visible=0 to avoid the comparison).

const sliceHitTest = (canvasX, canvasY, state, geometry) => {
    const rOuter = geometry.rOuter;
    const rInner = geometry.rInner;
    if (rOuter <= 0) return -1;
    const dx = canvasX - geometry.cx;
    const dy = canvasY - geometry.cy;
    const r2 = dx * dx + dy * dy;
    if (r2 > rOuter * rOuter || r2 < rInner * rInner) return -1;

    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += _TWO_PI;

    for (let i = 0; i < state.n; i++) {
        if (!state.visible[i]) continue;
        const a0 = state.startAngles[i];
        const a1 = a0 + state.arcAngles[i];
        if (angle >= a0 && angle < a1) return i;
    }
    return -1;
};

// ---- Polar legend DOM ----------------------------------------------------
//
// Per-slice rows (not per-series like the axis chart legend). Each row
// renders { swatch, label, value/percent } and supports click-to-toggle
// visibility. The visibility signal is the polar chart's sliceVisibility[i],
// which the chart's effect picks up and triggers a re-extract (recomputes
// visibleTotal and angles).

const buildPolarLegendDOM = (state, sliceVisibility, font, labelColor, disposers) => {
    if (typeof document === 'undefined') return null;
    const legendEl = document.createElement('div');
    legendEl.className = 'lite-charts-legend lite-charts-polar-legend';
    legendEl.style.display = 'flex';
    legendEl.style.flexWrap = 'wrap';
    legendEl.style.gap = '12px';
    legendEl.style.padding = '8px 0';
    legendEl.style.font = font;
    legendEl.style.color = labelColor;
    legendEl.style.lineHeight = '1.4';
    legendEl.style.alignItems = 'center';
    return { legendEl, refresh: null }; // populated below; refresh defined in mount
};

// Populate the legend element with one row per slice. Called after the
// initial data extraction (we don't know n before that). Reactive: rebuilds
// if the slice count changes.

const populatePolarLegend = (legendEl, state, sliceVisibility, resolvedColors, disposers) => {
    // Clear existing children + their listeners
    while (legendEl.firstChild) legendEl.removeChild(legendEl.firstChild);

    for (let i = 0; i < state.n; i++) {
        const idx = i;
        const row = document.createElement('button');
        row.type = 'button';
        row.setAttribute('aria-pressed', state.visible[idx] ? 'true' : 'false');
        row.style.display = 'inline-flex';
        row.style.alignItems = 'center';
        row.style.gap = '6px';
        row.style.cursor = 'pointer';
        row.style.background = 'none';
        row.style.border = 'none';
        row.style.padding = '4px 6px';
        row.style.font = 'inherit';
        row.style.color = 'inherit';
        row.style.borderRadius = '4px';

        const swatch = document.createElement('span');
        swatch.style.display = 'inline-block';
        swatch.style.width = '12px';
        swatch.style.height = '12px';
        swatch.style.borderRadius = '2px';
        swatch.style.background = resolvedColors[idx];
        swatch.style.flexShrink = '0';

        const label = document.createElement('span');
        label.textContent = state.labels[idx];

        row.appendChild(swatch);
        row.appendChild(label);

        const onClick = () => {
            sliceVisibility[idx].update((v) => !v);
        };
        row.addEventListener('click', onClick);
        disposers.push(() => row.removeEventListener('click', onClick));

        const visDispose = effect(() => {
            const visible = sliceVisibility[idx]();
            row.setAttribute('aria-pressed', visible ? 'true' : 'false');
            row.style.opacity = visible ? '1' : '0.4';
        });
        disposers.push(visDispose);

        legendEl.appendChild(row);
    }
};

// ---- Center label (donut only) -------------------------------------------
//
// A DOM overlay centered in the donut hole. It is NOT a scene node -- it never
// enters the per-frame draw path. `makeSliceDrawFn` and the scene walk gain
// ZERO bytes: the only writer is Effect 5, created solely when centerLabel is
// configured. Font size is done by CSS `clamp()` reading four custom
// properties the kernel writes only on mount / resize / data change.
//
// The polar kernel interposes its OWN position:relative `labelHost` wrapper
// (never the shared `installLegend`, which axis/bar/heatmap kernels also use)
// so the overlay's absolute coordinates are canvas-relative regardless of
// legend position -- no offsetLeft reads, no DPR term (geometry is logical px).
//
// Everything below is reachable ONLY from createBasePolarChart: the line/bar/
// heatmap bundles never pull `--cl-fit` / centerLabel in.

const CL_SQRT2 = 1.4142135623730951;  // inscribed-square side = rInner * SQRT2
const CL_ADV = 0.6;                    // nominal glyph advance (em) for fit sizing
const CL_HEIGHT_FRAC = 0.8;            // cap = fraction of hole height, no subLabel
const CL_HEIGHT_FRAC_SUB = 0.45;       // cap fraction when a subLabel is present
const CL_DEFAULT_MIN = 8;              // px floor default
const CL_FONT_SIZE =
    'clamp(var(--cl-min), calc(var(--cl-fit) / var(--cl-digits)), var(--cl-max))';
// 0.42em resolves against the overlay's COMPUTED (clamped) font-size, matching
// the SVG path's `size * 0.42` where size is already clamped. Using the raw
// `--cl-fit / --cl-digits` ratio here would ignore the clamp and render the sub
// larger than a capped main -- and diverge from the SVG export.
const CL_SUB_FONT_SIZE = '0.42em';

// Round to 2 decimals + 'px'. The only allocations on the cold update path.
const _clEmitPx = (v) => Math.round(v * 100) / 100 + 'px';

// Normalize config.centerLabel into a frozen options shape, or null when
// falsy. FAIL CLOSED: centerLabel on a chart with no hole is a configuration
// error, thrown at CONSTRUCTION (before mount). `null` is not zero.
const _normalizeCenterLabel = (raw, innerRadiusConfig) => {
    if (!raw) return null;
    if (!(typeof innerRadiusConfig === 'number' && innerRadiusConfig > 0)) {
        throw new Error(
            'lite-charts: centerLabel requires a donut hole -- innerRadius resolved to 0 ' +
            '(a pie has no hole). Use createDonutChart or set innerRadius > 0.');
    }
    let opts;
    if (typeof raw === 'string' || typeof raw === 'function') {
        opts = { text: raw };
    } else if (typeof raw === 'object') {
        opts = raw;
    } else {
        opts = {};   // centerLabel: true
    }
    const hasText = opts.text != null;
    const textAcc = asAccessor(hasText ? opts.text : '');
    const subAcc = opts.subLabel != null ? asAccessor(opts.subLabel) : null;
    let format = typeof opts.format === 'function' ? opts.format : null;
    // `centerLabel: true` (or {}): default to the total of visible slices.
    if (!format && !hasText) format = (state) => String(state.visibleTotal);
    const minFontSize = opts.minFontSize != null ? +opts.minFontSize : CL_DEFAULT_MIN;
    const maxFontSize = opts.maxFontSize != null ? +opts.maxFontSize : Infinity;
    // FAIL CLOSED on a pathological single bound: `+'12x'` / `+NaN` is NaN, and
    // `NaN > x` is false, so the min>max check below would silently pass and we
    // would emit "NaNpx" / font-size="NaN". Reject each supplied bound up front.
    if (opts.minFontSize != null && !(Number.isFinite(minFontSize) && minFontSize >= 0)) {
        throw new Error(
            'lite-charts: centerLabel minFontSize must be a finite number >= 0 (got ' +
            opts.minFontSize + ')');
    }
    if (opts.maxFontSize != null && !(Number.isFinite(maxFontSize) && maxFontSize > 0)) {
        throw new Error(
            'lite-charts: centerLabel maxFontSize must be a finite number > 0 (got ' +
            opts.maxFontSize + ')');
    }
    if (opts.minFontSize != null && opts.maxFontSize != null && minFontSize > maxFontSize) {
        throw new Error(
            'lite-charts: centerLabel minFontSize (' + minFontSize +
            ') exceeds maxFontSize (' + maxFontSize + ')');
    }
    return Object.freeze({
        textAcc,
        subAcc,
        format,
        color: opts.color != null ? opts.color : null,
        font: opts.font != null ? opts.font : null,
        minFontSize,
        maxFontSize,
    });
};

// Build the labelHost wrapper + overlay + main (+ optional sub) elements.
// Every STATIC style (including the clamp() font-size) is set once here.
// Returns null when there is no document (headless): the caller then skips
// the whole overlay path. Color is resolved and applied at mount.
const _buildCenterLabelDOM = (opts) => {
    if (typeof document === 'undefined') return null;
    const labelHost = document.createElement('div');
    labelHost.className = 'lite-charts-label-host';
    labelHost.style.position = 'relative';
    labelHost.style.display = 'block';
    labelHost.style.lineHeight = '0';

    const overlay = document.createElement('div');
    overlay.className = 'lite-charts-center-label';
    const s = overlay.style;
    s.position = 'absolute';
    s.pointerEvents = 'none';
    s.transform = 'translate(-50%,-50%)';
    s.overflow = 'hidden';
    s.textAlign = 'center';
    s.lineHeight = '1.1';
    s.whiteSpace = 'nowrap';
    if (opts.font) s.font = opts.font;   // family/weight only; size wins below
    s.fontSize = CL_FONT_SIZE;

    const main = document.createElement('div');
    main.className = 'lite-charts-center-label-main';
    overlay.appendChild(main);

    let sub = null;
    if (opts.subAcc) {
        sub = document.createElement('div');
        sub.className = 'lite-charts-center-label-sub';
        sub.style.fontSize = CL_SUB_FONT_SIZE;
        overlay.appendChild(sub);
    }
    return { labelHost, overlay, main, sub };
};

// Cold DOM writer: position/size the overlay and set the four sizing custom
// properties + text. Exactly four setProperty calls. Skips (hides) when the
// hole has collapsed -- an inverted geometry is unverified state.
const _updateCenterLabel = (els, text, subText, geometry, opts) => {
    const overlay = els.overlay;
    const rInner = geometry.rInner;
    if (!(rInner > 0)) { overlay.style.display = 'none'; return; }
    const st = overlay.style;
    st.display = 'block';
    const inscribed = rInner * CL_SQRT2;
    const fit = inscribed / CL_ADV;
    const digits = Math.max(1, String(text).length);
    const hf = els.sub ? CL_HEIGHT_FRAC_SUB : CL_HEIGHT_FRAC;
    const maxCap = Math.min(opts.maxFontSize, inscribed * hf);
    const minCap = Math.min(opts.minFontSize, maxCap);   // clamp the floor to the cap
    st.left = _clEmitPx(geometry.cx);
    st.top = _clEmitPx(geometry.cy);
    st.width = _clEmitPx(inscribed);
    st.maxWidth = _clEmitPx(inscribed);
    st.setProperty('--cl-fit', _clEmitPx(fit));
    st.setProperty('--cl-digits', String(digits));
    st.setProperty('--cl-max', _clEmitPx(maxCap));
    st.setProperty('--cl-min', _clEmitPx(minCap));
    els.main.textContent = text;
    if (els.sub) els.sub.textContent = subText != null ? subText : '';
};

// Cold export helper: emit the center label as SVG <text> (+ a second <text>
// for the subLabel). NOT a scene node -- exportSVG string-splices this in so
// the canvas draw walker never paints it. Font-size uses the SAME clamp math
// as the DOM path, resolved to a concrete px number (SVG has no custom props).
const _centerLabelToSVG = (text, subText, geometry, opts, fill) => {
    const rInner = geometry.rInner;
    if (!(rInner > 0)) return '';
    const inscribed = rInner * CL_SQRT2;
    const fit = inscribed / CL_ADV;
    const digits = Math.max(1, String(text).length);
    const hf = subText != null ? CL_HEIGHT_FRAC_SUB : CL_HEIGHT_FRAC;
    const maxCap = Math.min(opts.maxFontSize, inscribed * hf);
    const minCap = Math.min(opts.minFontSize, maxCap);
    const raw = fit / digits;
    const size = Math.round((raw < minCap ? minCap : raw > maxCap ? maxCap : raw) * 100) / 100;
    fill = fill || '#111111';
    let out = '<text x="' + _emitNumber(geometry.cx) + '" y="' + _emitNumber(geometry.cy) +
        '" text-anchor="middle" dominant-baseline="central" font-size="' + size +
        '" fill="' + _escapeXML(fill) + '">' + _escapeXML(text) + '</text>';
    if (subText != null) {
        const subSize = Math.round(size * 0.42 * 100) / 100;
        const dy = Math.round(size * 1.25 * 100) / 100;
        out += '<text x="' + _emitNumber(geometry.cx) + '" y="' + _emitNumber(geometry.cy + dy) +
            '" text-anchor="middle" dominant-baseline="central" font-size="' + subSize +
            '" fill="' + _escapeXML(fill) + '">' + _escapeXML(subText) + '</text>';
    }
    return out;
};

// ---- SLICE_RENDERER (used by both PIE and DONUT factories) ---------------
//
// Pie and donut share the same renderer -- the only difference is the
// `innerRadius` config default, applied by the factory wrapper. Future
// renderers (e.g. SEMICIRCLE_RENDERER for half-pie charts) would slot in
// here without touching the kernel.

const SLICE_RENDERER = {
    extractData: extractSliceData,
    computeGeometry: computeSliceGeometry,
    makeDrawFn: makeSliceDrawFn,
    hitTest: sliceHitTest,
    recomputeAngles: recomputePolarAngles,
};

// ===========================================================================
// createBasePolarChart -- the shared scaffold for slice-based polar charts
// ===========================================================================

const DEFAULT_PIE_MARGIN = { top: 16, right: 16, bottom: 16, left: 16 };
// Default palette for slices when the user doesn't supply per-slice colors.
// Eight-slot tableau-style cycle; resolvable as raw hex (no CSS-var lookup).
const DEFAULT_SLICE_PALETTE = [
    '#3b82f6', '#f59e0b', '#10b981', '#ef4444',
    '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
];

const createBasePolarChart = (config, renderer) => {
    if (!config || typeof config !== 'object') {
        throw new Error('lite-charts: chart factories require a config object');
    }

    // ---- Data source --------------------------------------------------
    // Accept config.data (array OR function) OR config.values (parallel
    // arrays form). Normalize to a single accessor that returns the input
    // shape extractSliceData understands.
    let dataSource;
    if (typeof config.data === 'function') {
        dataSource = config.data;
    } else if (Array.isArray(config.data)) {
        const arr = config.data;
        dataSource = () => arr;
    } else if (config.data && typeof config.data === 'object' && Array.isArray(config.data.values)) {
        const obj = config.data;
        dataSource = () => obj;
    } else if (Array.isArray(config.values)) {
        const parallel = {
            values: config.values,
            labels: config.labels,
            colors: config.colors,
        };
        dataSource = () => parallel;
    } else {
        throw new Error('lite-charts: polar chart requires `data` (array of {label,value,color}) or `values` (number[])');
    }

    const innerRadiusConfig = config.innerRadius != null ? config.innerRadius : 0;

    // ---- Center label (donut only) ------------------------------------
    // Normalized ONCE at construction. The fail-closed throws (no hole /
    // inverted font bounds) fire HERE -- before any signal is allocated below
    // -- so a rejected config leaks nothing into the registry (cf. C0/LC-05:
    // a construction throw after `_own(signal())` orphans those nodes).
    const centerLabelOpts = _normalizeCenterLabel(config.centerLabel, innerRadiusConfig);

    // Dimensions: explicit (number or signal) or auto-observed at mount.
    const widthExplicit = config.width != null;
    const heightExplicit = config.height != null;
    // v1.2.0: track signals lite-charts creates so `chart.destroy()` can
    // dispose them. See axis kernel for the rationale.
    const _ownedSignals = [];
    const _own = (s) => { _ownedSignals.push(s); return s; };
    const widthAutoSig = widthExplicit ? null : _own(signal(400));
    const heightAutoSig = heightExplicit ? null : _own(signal(400));
    const widthSig = widthExplicit ? asAccessor(config.width) : widthAutoSig;
    const heightSig = heightExplicit ? asAccessor(config.height) : heightAutoSig;

    const margin = config.margin || DEFAULT_PIE_MARGIN;
    const marginTop    = margin.top    != null ? margin.top    : DEFAULT_PIE_MARGIN.top;
    const marginRight  = margin.right  != null ? margin.right  : DEFAULT_PIE_MARGIN.right;
    const marginBottom = margin.bottom != null ? margin.bottom : DEFAULT_PIE_MARGIN.bottom;
    const marginLeft   = margin.left   != null ? margin.left   : DEFAULT_PIE_MARGIN.left;


    // ---- Chart state --------------------------------------------------
    const state = makePolarState();
    const geometry = { cx: 0, cy: 0, rOuter: 0, rInner: 0 };
    const plotBoundsBox = { x: 0, y: 0, w: 0, h: 0 };
    const plotBoundsSignal = _own(signal(0));
    const dataVersion = _own(signal(0));            // bumps on data / visibility change

    // Resolved colors -- parallel to state.colors[]. CRITICAL: this is a
    // STABLE array reference, mutated in place by refreshResolvedColors.
    // makeSliceDrawFn and populatePolarLegend hold the reference; reassigning
    // it (e.g. `resolvedColors = new Array(n)`) would orphan their captures
    // and slices would render with stale colours after data changes.
    const resolvedColors = [];

    // Per-slice visibility signals. Array grows on data extraction; never
    // shrinks (we just stop iterating past state.n). Each signal is a
    // standalone reactive flag the legend writes to.
    const sliceVisibility = [];
    const ensureVisibilitySignals = (n) => {
        while (sliceVisibility.length < n) {
            sliceVisibility.push(_own(signal(true)));
        }
    };

    // ---- Style refs (theme-reactive) ----------------------------------
    const sliceStrokeRef      = { value: '#ffffff' };
    const sliceStrokeWidthRef = { value: config.sliceStrokeWidth != null ? +config.sliceStrokeWidth : 1 };
    const labelColorRef       = { value: '#444444' };
    const fontRef             = { value: config.font != null ? config.font : '11px sans-serif' };
    const tooltipBgRef        = { value: 'rgba(255,255,255,0.96)' };
    const tooltipBorderRef    = { value: '#cccccc' };
    const centerLabelColorRef = { value: '#111111' };
    // Highlight: index of slice under cursor; -1 = none. Read on every
    // draw; mutated by mouse handler.
    const highlightRef        = { value: -1 };

    // ---- Crosshair facade (highlight + tooltip) -----------------------
    // For polar charts the "crosshair" is just a slice highlight + tooltip.
    // No vertical line. Same mutable-data + version-counter pattern as the
    // axis kernel so callers can sync small multiples.
    const crosshairData = {
        visible: false,
        sliceIdx: -1,
        mousePixelX: 0,
        mousePixelY: 0,
    };
    const crosshairVersion = _own(signal(0));
    const crosshairFacade = function () { crosshairVersion(); return crosshairData; };
    crosshairFacade.peek = () => crosshairData;
    crosshairFacade.set = (s) => {
        if (!s || typeof s !== 'object') return;
        crosshairData.visible = !!s.visible;
        crosshairData.sliceIdx = s.sliceIdx != null ? s.sliceIdx : -1;
        crosshairData.mousePixelX = s.mousePixelX != null ? s.mousePixelX : 0;
        crosshairData.mousePixelY = s.mousePixelY != null ? s.mousePixelY : 0;
        crosshairVersion.update((x) => (x + 1) | 0);
    };
    crosshairFacade.subscribe = (cb) => crosshairVersion.subscribe(() => cb(crosshairData));

    // ---- Interaction config -------------------------------------------
    const tooltipOpts = config.tooltip === false ? null
        : (typeof config.tooltip === 'object' ? config.tooltip : {});
    const tooltipFormatter = tooltipOpts && typeof tooltipOpts.format === 'function' ? tooltipOpts.format : null;
    const interactionEnabled = !!tooltipOpts;

    // ---- Legend config ------------------------------------------------
    const legendEnabled = config.legend !== false;
    let legendPosition = 'bottom';
    let legendContainer = null;
    if (typeof config.legend === 'string') {
        if (config.legend === 'top' || config.legend === 'bottom' || config.legend === 'left' || config.legend === 'right') {
            legendPosition = config.legend;
        }
    } else if (config.legend && typeof config.legend === 'object') {
        if (config.legend.position) legendPosition = config.legend.position;
        if (config.legend.container) legendContainer = config.legend.container;
    }

    // ---- Lifecycle state ---------------------------------------------
    let scene = null;
    let canvas = null;
    let container = null;
    let canvasCreated = false;
    let legendEl = null;
    let legendWrapper = null;
    let labelHost = null;        // centerLabel: interposed position:relative wrapper
    let centerLabelEls = null;   // { labelHost, overlay, main, sub } or null
    let disposers = [];
    let mounted = false;

    const resolveSliceColor = (i) => {
        const raw = state.colors[i];
        if (raw) return resolveColor(raw, container);
        // Fall back to palette cycle
        return resolveColor(DEFAULT_SLICE_PALETTE[i % DEFAULT_SLICE_PALETTE.length], container);
    };

    const refreshResolvedColors = () => {
        // Mutate the existing array (resize then overwrite) so consumers that
        // hold the reference (slice draw fn, legend populator) see the new
        // values without needing to be re-handed a new array.
        resolvedColors.length = state.n;
        for (let i = 0; i < state.n; i++) resolvedColors[i] = resolveSliceColor(i);
    };

    // ---- Mount --------------------------------------------------------
    const mount = (target) => {
        if (mounted) throw new Error('lite-charts: chart already mounted');
        if (!target) throw new Error('lite-charts: mount() requires an HTMLElement or HTMLCanvasElement');

        if (target.tagName === 'CANVAS') {
            canvas = target;
            container = target.parentElement || target;
            canvasCreated = false;
        } else if (typeof target.appendChild === 'function') {
            if (typeof document === 'undefined') {
                throw new Error('lite-charts: mount() needs a real document to create a canvas');
            }
            canvas = document.createElement('canvas');
            target.appendChild(canvas);
            container = target;
            canvasCreated = true;
        } else if (typeof target.getContext === 'function') {
            canvas = target;
            container = null;
            canvasCreated = false;
        } else {
            throw new Error('lite-charts: mount() target must be an HTMLElement or HTMLCanvasElement');
        }

        // FAIL CLOSED before any allocation: a centerLabel needs a DOM parent to
        // interpose the overlay host into. Check it HERE -- before _wireAutoSize,
        // createScene, and the effects below -- so a rejected mount strands no
        // ResizeObserver / scene / effect (unmount early-returns on !mounted, so a
        // late throw would leak them; same LC-05 class as the construction guard).
        if (centerLabelOpts && (typeof document === 'undefined' || !canvas.parentNode)) {
            throw new Error(
                'lite-charts: centerLabel requires mount() into a DOM element ' +
                '(no parent node to host the overlay)');
        }

        // Auto-resize wire-up: if width/height were omitted, observe the
        // container so the chart tracks parent dimensions.
        if (widthAutoSig || heightAutoSig) {
            _wireAutoSize(container, widthAutoSig, heightAutoSig, disposers);
        }

        const w0 = (+untrack(widthSig) | 0) || 400;
        const h0 = (+untrack(heightSig) | 0) || 400;
        canvas.width = w0;
        canvas.height = h0;

        // Resolve theme colors first so the first draw is correct.
        sliceStrokeRef.value      = resolveColor(config.sliceStroke != null ? config.sliceStroke : '#ffffff', container);
        labelColorRef.value       = resolveColor(config.labelColor != null ? config.labelColor : '#444444', container);
        tooltipBgRef.value        = resolveColor(tooltipOpts && tooltipOpts.background ? tooltipOpts.background : 'rgba(255,255,255,0.96)', container);
        tooltipBorderRef.value    = resolveColor(tooltipOpts && tooltipOpts.border ? tooltipOpts.border : '#cccccc', container);

        const schedule = config.schedule || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => cb());
        scene = createScene(canvas, {
            background: config.background != null ? config.background : null,
            autoResize: false,
            dpr: config.dpr != null ? config.dpr : (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1),
            schedule,
        });

        const resolvedDpr = config.dpr != null ? config.dpr : (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);

        // Effect 1: width / height -> canvas size (with DPR) + plot bounds
        disposers.push(effect(() => {
            const w = +widthSig() | 0 || 400;
            const h = +heightSig() | 0 || 400;
            const wBacking = Math.max(1, Math.round(w * resolvedDpr));
            const hBacking = Math.max(1, Math.round(h * resolvedDpr));
            if (canvas.width  !== wBacking) canvas.width  = wBacking;
            if (canvas.height !== hBacking) canvas.height = hBacking;
            if (typeof canvas.style !== 'undefined') {
                canvas.style.width  = w + 'px';
                canvas.style.height = h + 'px';
            }
            plotBoundsBox.x = marginLeft;
            plotBoundsBox.y = marginTop;
            plotBoundsBox.w = Math.max(0, w - marginLeft - marginRight);
            plotBoundsBox.h = Math.max(0, h - marginTop - marginBottom);
            computeSliceGeometry(geometry, plotBoundsBox, innerRadiusConfig);
            plotBoundsSignal.update((v) => (v + 1) | 0);
            if (scene) scene.markDirty();
        }));

        // Effect 2: data + visibility -> re-extract, recompute angles, resolve colors
        disposers.push(effect(() => {
            const input = dataSource();

            renderer.extractData(state, input);
            ensureVisibilitySignals(state.n);

            // Subscribe to all visibility signals AFTER they exist, so toggling
            // any of them re-runs this effect. Reading them inside an effect
            // automatically tracks them as dependencies of this effect.
            for (let i = 0; i < state.n; i++) {
                state.visible[i] = sliceVisibility[i]() ? 1 : 0;
            }
            // Recompute visibleTotal + angles based on current visibility flags.
            let vis = 0;
            for (let i = 0; i < state.n; i++) if (state.visible[i]) vis += state.values[i];
            state.visibleTotal = vis;
            renderer.recomputeAngles(state);

            refreshResolvedColors();

            // Rebuild legend rows (slice count may have changed)
            if (legendEl) {
                populatePolarLegend(legendEl, state, sliceVisibility, resolvedColors, disposers);
            }

            dataVersion.update((v) => (v + 1) | 0);
            if (scene) scene.markDirty();
        }));

        // Effect 3: geometry recompute on plotBounds change
        disposers.push(effect(() => {
            plotBoundsSignal();
            computeSliceGeometry(geometry, plotBoundsBox, innerRadiusConfig);
            if (scene) scene.markDirty();
        }));

        // ---- Slice draw node -------------------------------------------
        const sliceDrawFn = renderer.makeDrawFn(state, geometry, resolvedColors, sliceStrokeRef, sliceStrokeWidthRef, highlightRef);
        const sliceNode = scene.root.add(pathNode({ draw: (ctx) => sliceDrawFn(ctx) }));

        // Effect 4: dirty bridge for data/geometry changes
        disposers.push(effect(() => {
            dataVersion();
            plotBoundsSignal();
            if (scene) scene.markDirty();
        }));

        // ---- Crosshair / tooltip (slice highlight + box) --------------
        if (interactionEnabled) {
            const crosshairNode = scene.root.add(pathNode({ draw: (ctx) => drawCrosshair(ctx) }));
            disposers.push(effect(() => {
                crosshairVersion();
                if (scene) scene.markDirty();
            }));

            if (typeof canvas.addEventListener === 'function') {
                const onMove = (e) => {
                    const rect = typeof canvas.getBoundingClientRect === 'function'
                        ? canvas.getBoundingClientRect()
                        : { left: 0, top: 0, width: canvas.width, height: canvas.height };
                    moveCrosshair(e.clientX - rect.left, e.clientY - rect.top);
                };
                const onLeave = () => hideCrosshair();
                canvas.addEventListener('mousemove', onMove);
                canvas.addEventListener('mouseleave', onLeave);
                disposers.push(() => {
                    canvas.removeEventListener('mousemove', onMove);
                    canvas.removeEventListener('mouseleave', onLeave);
                });
            }
        }

        // ---- Legend ----------------------------------------------------
        if (legendEnabled) {
            const font = config.font != null ? config.font : '11px sans-serif';
            const labelColor = resolveColor(config.labelColor != null ? config.labelColor : '#444444', container);
            const built = buildPolarLegendDOM(state, sliceVisibility, font, labelColor, disposers);
            if (built) {
                legendEl = built.legendEl;
                // Initial populate happens via the data effect; in tests with
                // synchronous schedule, that's already run by now.
                populatePolarLegend(legendEl, state, sliceVisibility, resolvedColors, disposers);
                if (legendContainer) {
                    legendContainer.appendChild(legendEl);
                } else if (canvasCreated && container) {
                    legendWrapper = installLegend(container, canvas, legendEl, legendPosition);
                }
                if (!legendContainer && !legendWrapper) legendEl = null;
            }
        }

        // ---- Center label (donut only) --------------------------------
        // Interpose a position:relative labelHost between canvas and its
        // current parent (container OR legend wrapper), move the canvas in,
        // append the overlay as a canvas-relative sibling. Built ONLY when
        // centerLabel was configured. Effect 5 is the sole writer.
        if (centerLabelOpts) {
            // Availability already fail-closed at the top of mount(); parent is
            // guaranteed non-null here.
            const parent = canvas.parentNode;
            const built = _buildCenterLabelDOM(centerLabelOpts);
            if (built) {
                labelHost = built.labelHost;
                centerLabelEls = built;
                parent.insertBefore(labelHost, canvas);
                labelHost.appendChild(canvas);
                labelHost.appendChild(built.overlay);
                centerLabelColorRef.value = resolveColor(
                    centerLabelOpts.color != null ? centerLabelOpts.color : '#111111', container);
                built.overlay.style.color = centerLabelColorRef.value;

                // Effect 5: text/subLabel + dataVersion + plotBounds -> overlay.
                // Never touches the scene. Fires only on mount / resize
                // (rAF-throttled) / data-visibility change / text-signal write.
                disposers.push(effect(() => {
                    dataVersion();
                    plotBoundsSignal();
                    const t = centerLabelOpts.format
                        ? String(centerLabelOpts.format(state))
                        : String(centerLabelOpts.textAcc());
                    const sub = centerLabelOpts.subAcc ? String(centerLabelOpts.subAcc()) : null;
                    _updateCenterLabel(centerLabelEls, t, sub, geometry, centerLabelOpts);
                }));
            }
        }

        mounted = true;
        return chart;
    };

    const unmount = () => {
        if (!mounted) return;
        for (let i = 0; i < disposers.length; i++) {
            try { disposers[i](); } catch (e) { /* swallow */ }
        }
        disposers.length = 0;
        if (scene) {
            try { scene.dispose(); } catch (e) { /* swallow */ }
            scene = null;
        }
        // Un-interpose the labelHost FIRST so the canvas is restored to its
        // pre-mount parent -- the existing legend/canvas removal below then
        // fires exactly as it did before centerLabel existed.
        if (labelHost && labelHost.parentNode && canvas) {
            const host = labelHost.parentNode;
            if (centerLabelEls && centerLabelEls.overlay && centerLabelEls.overlay.parentNode === labelHost) {
                labelHost.removeChild(centerLabelEls.overlay);
            }
            host.insertBefore(canvas, labelHost);
            host.removeChild(labelHost);
        }
        labelHost = null;
        centerLabelEls = null;
        if (legendWrapper && legendWrapper.parentNode) {
            legendWrapper.parentNode.removeChild(legendWrapper);
        } else if (legendEl && legendEl.parentNode) {
            legendEl.parentNode.removeChild(legendEl);
        } else if (canvasCreated && container && canvas && canvas.parentNode === container) {
            container.removeChild(canvas);
        }
        legendEl = null;
        legendWrapper = null;
        canvas = null;
        container = null;
        mounted = false;
    };

    // v1.2.0: terminal teardown -- see axis kernel for rationale.
    let destroyed = false;
    const destroy = () => {
        if (destroyed) return;
        if (mounted) unmount();
        for (let i = 0; i < _ownedSignals.length; i++) {
            try { dispose(_ownedSignals[i]); } catch (_) { /* swallow */ }
        }
        _ownedSignals.length = 0;
        destroyed = true;
    };

    // ---- Mouse handling / hit detection -------------------------------
    const moveCrosshair = (canvasX, canvasY) => {
        if (!interactionEnabled || !mounted) return;
        const idx = renderer.hitTest(canvasX, canvasY, state, geometry);
        if (idx < 0) {
            hideCrosshair();
            return;
        }
        if (crosshairData.visible
            && crosshairData.sliceIdx === idx
            && crosshairData.mousePixelX === canvasX
            && crosshairData.mousePixelY === canvasY) return;
        crosshairData.visible = true;
        crosshairData.sliceIdx = idx;
        crosshairData.mousePixelX = canvasX;
        crosshairData.mousePixelY = canvasY;
        highlightRef.value = idx;
        crosshairVersion.update((x) => (x + 1) | 0);
    };

    const hideCrosshair = () => {
        if (!interactionEnabled) return;
        if (!crosshairData.visible) return;
        crosshairData.visible = false;
        crosshairData.sliceIdx = -1;
        crosshairData.mousePixelX = 0;
        crosshairData.mousePixelY = 0;
        highlightRef.value = -1;
        crosshairVersion.update((x) => (x + 1) | 0);
    };

    // ---- Tooltip render ----------------------------------------------
    const drawCrosshair = (ctx) => {
        if (!crosshairData.visible) return;
        const idx = crosshairData.sliceIdx;
        if (idx < 0 || idx >= state.n) return;
        if (!tooltipOpts) return;
        drawPolarTooltip(ctx, idx);
    };

    const drawPolarTooltip = (ctx, idx) => {
        const pb = plotBoundsBox;
        const padding = 8;
        const swatch = 8;
        const lineHeight = 14;

        const label = state.labels[idx];
        const value = state.values[idx];
        const pct = state.total > 0 ? (value / state.total) * 100 : 0;
        const headerText = label;
        const valueText = formatTooltipValue(value) + ' (' + pct.toFixed(1) + '%)';

        let header = headerText;
        let rowText = valueText;
        let rowColor = resolvedColors[idx];

        if (tooltipFormatter) {
            const out = tooltipFormatter({
                sliceIdx: idx,
                label: state.labels[idx],
                value: state.values[idx],
                total: state.total,
                percent: pct,
            });
            if (typeof out === 'string') { header = out; rowText = ''; }
            else if (out && typeof out === 'object') {
                if (out.header != null) header = out.header;
                if (out.value != null) rowText = out.value;
            }
        }

        ctx.font = fontRef.value;
        let maxW = ctx.measureText(header).width;
        if (rowText) {
            const w = swatch + 6 + ctx.measureText(rowText).width;
            if (w > maxW) maxW = w;
        }
        const boxW = maxW + padding * 2;
        const boxH = (rowText ? 2 : 1) * lineHeight + padding;

        let bx = crosshairData.mousePixelX + 12;
        if (bx + boxW > pb.x + pb.w) bx = crosshairData.mousePixelX - 12 - boxW;
        if (bx < pb.x) bx = pb.x;
        let by = crosshairData.mousePixelY - boxH / 2;
        if (by < pb.y) by = pb.y;
        if (by + boxH > pb.y + pb.h) by = pb.y + pb.h - boxH;

        ctx.fillStyle = tooltipBgRef.value;
        ctx.strokeStyle = tooltipBorderRef.value;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bx, by, boxW, boxH);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = labelColorRef.value;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(header, bx + padding, by + padding);

        if (rowText) {
            const ry = by + padding + lineHeight;
            ctx.fillStyle = rowColor;
            ctx.fillRect(bx + padding, ry + 2, swatch, swatch);
            ctx.fillStyle = labelColorRef.value;
            ctx.fillText(rowText, bx + padding + swatch + 6, ry);
        }
    };

    // ---- Public chart object -----------------------------------------
    const chart = {
        mount,
        unmount,
        destroy,
        exportPNG: (opts) => {
            if (!mounted || !canvas) throw new Error('lite-charts: exportPNG() requires mount() first');
            if (typeof canvas.toDataURL !== 'function') {
                throw new Error('lite-charts: exportPNG() requires a real HTMLCanvasElement');
            }
            const mt = opts && opts.mimeType || 'image/png';
            const q = opts && opts.quality != null ? opts.quality : 0.92;
            return canvas.toDataURL(mt, q);
        },
        exportSVG: (opts) => {
            if (!mounted || !scene) throw new Error('lite-charts: exportSVG() requires mount() first');
            const w = +widthSig() | 0 || 400;
            const h = +heightSig() | 0 || 400;
            const bg = (opts && opts.background !== undefined)
                ? opts.background
                : (config.background != null ? config.background : null);
            const svg = _exportSceneToSVG(scene, w, h, bg);
            // Center label is a DOM overlay, not a scene node -- splice it into
            // the SVG string (export-only) so the canvas draw walker never
            // paints it. Zero cost on the draw path.
            if (centerLabelOpts) {
                const t = centerLabelOpts.format
                    ? String(centerLabelOpts.format(state))
                    : String(centerLabelOpts.textAcc());
                const sub = centerLabelOpts.subAcc ? String(centerLabelOpts.subAcc()) : null;
                const frag = _centerLabelToSVG(t, sub, geometry, centerLabelOpts, centerLabelColorRef.value);
                if (frag) return svg.slice(0, -6) + frag + '</svg>';
            }
            return svg;
        },
        redraw: () => { if (scene) scene.markDirty(); },
        moveCrosshair,
        hideCrosshair,
        setSliceVisible: (idx, visible) => {
            if (idx < 0 || idx >= sliceVisibility.length) return;
            sliceVisibility[idx].set(!!visible);
        },
        refreshTheme: () => {
            if (!mounted) return;
            sliceStrokeRef.value   = resolveColor(config.sliceStroke != null ? config.sliceStroke : '#ffffff', container);
            labelColorRef.value    = resolveColor(config.labelColor  != null ? config.labelColor  : '#444444', container);
            tooltipBgRef.value     = resolveColor(tooltipOpts && tooltipOpts.background ? tooltipOpts.background : 'rgba(255,255,255,0.96)', container);
            tooltipBorderRef.value = resolveColor(tooltipOpts && tooltipOpts.border     ? tooltipOpts.border     : '#cccccc', container);
            refreshResolvedColors();
            // Re-paint legend swatches
            if (legendEl) {
                const swatches = legendEl.querySelectorAll('span:first-child');
                for (let i = 0; i < swatches.length && i < resolvedColors.length; i++) {
                    swatches[i].style.background = resolvedColors[i];
                }
            }
            // Re-resolve the center label color against the (possibly retheme'd)
            // container and repaint the overlay.
            if (centerLabelOpts && centerLabelEls) {
                centerLabelColorRef.value = resolveColor(
                    centerLabelOpts.color != null ? centerLabelOpts.color : '#111111', container);
                centerLabelEls.overlay.style.color = centerLabelColorRef.value;
            }
            if (scene) scene.markDirty();
        },
        get scene() { return scene; },
        get canvas() { return canvas; },
        get geometry() { return geometry; },
        get legend() { return legendEl; },
        get centerLabel() { return centerLabelEls ? centerLabelEls.overlay : null; },
        plotBounds: plotBoundsSignal,
        crosshair: crosshairFacade,
        sliceVisibility,
        _internal: {
            state,
            geometry,
            plotBoundsBox,
            sliceVisibility,
            dataVersion,
            centerLabelOpts,
        },
    };

    return chart;
};
//
// Each factory is a one-line composition: the chart kernel
// (createBaseAxisChart) parameterized by a renderer constant. This is the
// tree-shake boundary -- a bundle that imports only `createLineChart` keeps
// LINE_RENDERER and its transitive references but drops AREA_RENDERER,
// BAR_RENDERER, makeBandScale, makeBarDrawFn, buildBarAxis, and the rest.
// Verified empirically; see TREE_SHAKING.md (or the bundle-size table in
// README) for measurements.

// ===========================================================================
// Radar chart kernel -- multi-axis spoke layout
// ===========================================================================
//
// Independent from createBaseAxisChart AND createBasePolarChart. Radar is
// "polar" geometrically (concentric structure, angle-driven layout) but the
// graph it produces is fundamentally different from pie/donut: each series
// is a POLYGON connecting one value-per-axis vertex, not a slice. Trying
// to share createBasePolarChart would force one or both chart families to
// carry the other's code paths, defeating tree-shake.
//
// Tree-shake boundary: importing only createRadarChart drops every axis-
// chart helper (xScale, yScale, decimation, bisect, interp, bandScale,
// makeLineDrawFn, makeBarDrawFn, all axis-builder code) AND every polar-
// slice helper (extractSliceData, sliceHitTest, computeSliceGeometry,
// makeSliceDrawFn). Verified with esbuild in the bundle-size table.
//
// NOTE on renderer pattern: pie/donut share SLICE_RENDERER and line/area/
// bar share their respective renderers, but radar currently has only one
// concrete variation. Skipping the renderer indirection for now -- when a
// second variant lands (e.g. smoothed-curve radar, or per-axis-scale radar)
// the kernel will get extracted into createBaseRadarChart(config, renderer)
// without breaking the public surface.

// ---- Per-series state ----------------------------------------------------
//
// One radar series = one polygon. values[i] is the data value on axis i.
// Parallel to colors/names from the input config. Visibility is a separate
// signal (legend can toggle without re-extracting).

const makeRadarSeriesState = () => ({
    values: null,         // Float32Array, length = axisCount
    n: 0,                 // number of axes (== values.length)
    name: '',
    rawColor: '#888',     // unresolved spec; resolveColor at theme time
    visible: true,
});

const extractRadarSeriesData = (state, seriesInput, axisCount) => {
    state.values = ensureFloat32(state.values, axisCount);
    state.n = axisCount;
    state.name = seriesInput.name != null ? String(seriesInput.name) : '';
    state.rawColor = seriesInput.color != null ? seriesInput.color : '#3b82f6';
    const src = Array.isArray(seriesInput.values) ? seriesInput.values : [];
    for (let i = 0; i < axisCount; i++) {
        const v = i < src.length ? +src[i] : 0;
        state.values[i] = v === v ? v : 0;  // NaN -> 0
    }
};

// ---- Geometry ------------------------------------------------------------
//
// Center in plot rect; rOuter = min(w,h)/2 minus labelPad so axis labels
// don't paint outside the canvas. Axis angles are precomputed:
// angle[i] = startAngle + i * (2*PI / axisCount). Default startAngle = -PI/2
// (12 o'clock), going clockwise -- same convention as pie/donut.
//
// Precomputing cos/sin per axis (Float64; ~8 axes typical so 64 bytes total)
// saves trig in the per-frame draw fn -- polygons + grid rings + spokes all
// iterate the same angle list.

const RADAR_LABEL_PAD = 24;   // pixel margin for axis labels around the perimeter
const RADAR_START_OFFSET = -Math.PI / 2;

const computeRadarGeometry = (geometry, plotBoundsBox, axisCount) => {
    const cx = plotBoundsBox.x + plotBoundsBox.w / 2;
    const cy = plotBoundsBox.y + plotBoundsBox.h / 2;
    const maxR = Math.min(plotBoundsBox.w, plotBoundsBox.h) / 2 - RADAR_LABEL_PAD;
    const rOuter = maxR > 0 ? maxR : 0;
    geometry.cx = cx;
    geometry.cy = cy;
    geometry.rOuter = rOuter;
    geometry.axisCount = axisCount;
    // Resize cos/sin tables if axis count changed (cheap; ~8 axes typical).
    if (!geometry.cosA || geometry.cosA.length < axisCount) {
        geometry.cosA = new Float64Array(Math.max(axisCount, 4));
        geometry.sinA = new Float64Array(Math.max(axisCount, 4));
    }
    if (axisCount > 0) {
        const step = _TWO_PI / axisCount;
        for (let i = 0; i < axisCount; i++) {
            const a = RADAR_START_OFFSET + i * step;
            geometry.cosA[i] = Math.cos(a);
            geometry.sinA[i] = Math.sin(a);
        }
    }
    return geometry;
};

// ---- Draw functions ------------------------------------------------------
//
// Three scene nodes per chart, drawn in z-order: grid (bottom), polygons
// (middle), spokes+labels (top). Each draw fn closes over geometry +
// state, all reads happen at frame time so reactivity + theme changes
// propagate without recreating closures.

// Convert a (value, axisIdx) pair to a pixel point on the chart. Domain is
// [vMin, vMax] (shared across all axes -- MVP radar uses one domain;
// per-axis domains can land in v1.3 with the multi-scale infrastructure).
const _radarPoint = (geometry, axisIdx, value, vMin, vSpan) => {
    const t = vSpan > 0 ? (value - vMin) / vSpan : 0;
    const tClamp = t < 0 ? 0 : t > 1 ? 1 : t;
    const r = geometry.rOuter * tClamp;
    return {
        x: geometry.cx + r * geometry.cosA[axisIdx],
        y: geometry.cy + r * geometry.sinA[axisIdx],
    };
};

// Polygon draw: one fill (alpha) + one stroke per visible series.
// All series share the same geometry + value domain.
const makeRadarPolygonDrawFn = (states, resolvedColors, geometry, domainRef, fillOpacityRef, strokeWidthRef) => (ctx) => {
    const axisCount = geometry.axisCount;
    if (axisCount < 3 || geometry.rOuter <= 0) return;
    const cx = geometry.cx, cy = geometry.cy;
    const vMin = domainRef.value[0];
    const vSpan = domainRef.value[1] - vMin;
    const fillAlpha = fillOpacityRef.value;
    const lw = strokeWidthRef.value;

    for (let s = 0; s < states.length; s++) {
        const state = states[s];
        if (!state.visible) continue;
        if (state.n !== axisCount) continue;        // schema mismatch: skip safely

        const color = resolvedColors[s];
        ctx.beginPath();
        for (let i = 0; i < axisCount; i++) {
            const t = vSpan > 0 ? (state.values[i] - vMin) / vSpan : 0;
            const tClamp = t < 0 ? 0 : t > 1 ? 1 : t;
            const r = geometry.rOuter * tClamp;
            const x = cx + r * geometry.cosA[i];
            const y = cy + r * geometry.sinA[i];
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();

        if (fillAlpha > 0) {
            ctx.globalAlpha = fillAlpha;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        if (lw > 0) {
            ctx.strokeStyle = color;
            ctx.lineWidth = lw;
            ctx.stroke();
        }
    }
};

// Grid: concentric polygons at the tick values. Standard pattern is 4 rings
// at 25/50/75/100% of the domain. Stroked, no fill.
const makeRadarGridDrawFn = (geometry, tickCount, gridColorRef) => (ctx) => {
    const axisCount = geometry.axisCount;
    if (axisCount < 3 || geometry.rOuter <= 0) return;
    const cx = geometry.cx, cy = geometry.cy;
    ctx.strokeStyle = gridColorRef.value;
    ctx.lineWidth = 1;
    for (let t = 1; t <= tickCount; t++) {
        const r = geometry.rOuter * (t / tickCount);
        ctx.beginPath();
        for (let i = 0; i < axisCount; i++) {
            const x = cx + r * geometry.cosA[i];
            const y = cy + r * geometry.sinA[i];
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
    }
};

// Spokes: lines from center to perimeter + axis label at outer end.
// Labels are aligned based on their angular position: right of vertical
// gets textAlign='left', left of vertical gets 'right', near-vertical gets
// 'center'. Saves the user from positioning text by hand.
const makeRadarSpokesDrawFn = (geometry, axisLabelsRef, axisColorRef, labelColorRef, fontRef) => (ctx) => {
    const axisCount = geometry.axisCount;
    if (axisCount < 3 || geometry.rOuter <= 0) return;
    const cx = geometry.cx, cy = geometry.cy;
    const rOuter = geometry.rOuter;
    const labels = axisLabelsRef.value;

    // Spokes
    ctx.strokeStyle = axisColorRef.value;
    ctx.lineWidth = 1;
    for (let i = 0; i < axisCount; i++) {
        const x = cx + rOuter * geometry.cosA[i];
        const y = cy + rOuter * geometry.sinA[i];
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();
    }

    // Labels
    ctx.font = fontRef.value;
    ctx.fillStyle = labelColorRef.value;
    ctx.textBaseline = 'middle';
    const labelR = rOuter + 12;
    for (let i = 0; i < axisCount; i++) {
        const lx = cx + labelR * geometry.cosA[i];
        const ly = cy + labelR * geometry.sinA[i];
        const cosA = geometry.cosA[i];
        // |cosA| < 0.2 means the angle is within ~12 deg of vertical (top
        // or bottom); center those labels. Otherwise pick the side based
        // on sign of cosA: positive = right of center -> left-align, etc.
        let align;
        if (cosA > 0.2) align = 'left';
        else if (cosA < -0.2) align = 'right';
        else align = 'center';
        ctx.textAlign = align;
        const lbl = i < labels.length ? labels[i] : '';
        if (lbl) ctx.fillText(String(lbl), lx, ly);
    }
};

// ---- Hit detection -------------------------------------------------------
//
// Find the nearest vertex across all visible series within hitRadius pixels.
// Returns {seriesIdx, axisIdx, value} or null. O(series * axes), but in
// practice series <= ~6 and axes <= ~12 so this is ~70 distance comparisons
// per mousemove -- trivially within budget.

const RADAR_HIT_RADIUS = 12;  // px

const radarHitTest = (canvasX, canvasY, states, geometry, domainRef) => {
    const axisCount = geometry.axisCount;
    if (axisCount < 3 || geometry.rOuter <= 0) return null;
    const cx = geometry.cx, cy = geometry.cy;
    const vMin = domainRef.value[0];
    const vSpan = domainRef.value[1] - vMin;
    const hitR2 = RADAR_HIT_RADIUS * RADAR_HIT_RADIUS;
    let bestS = -1, bestA = -1;
    let bestD2 = hitR2 + 1;
    for (let s = 0; s < states.length; s++) {
        const state = states[s];
        if (!state.visible) continue;
        if (state.n !== axisCount) continue;
        for (let i = 0; i < axisCount; i++) {
            const t = vSpan > 0 ? (state.values[i] - vMin) / vSpan : 0;
            const tClamp = t < 0 ? 0 : t > 1 ? 1 : t;
            const r = geometry.rOuter * tClamp;
            const x = cx + r * geometry.cosA[i];
            const y = cy + r * geometry.sinA[i];
            const dx = canvasX - x;
            const dy = canvasY - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                bestS = s;
                bestA = i;
            }
        }
    }
    if (bestS < 0) return null;
    return {
        seriesIdx: bestS,
        axisIdx: bestA,
        value: states[bestS].values[bestA],
    };
};

// ===========================================================================
// createRadarChart -- the kernel + factory in one
// ===========================================================================

const DEFAULT_RADAR_MARGIN = { top: 24, right: 24, bottom: 24, left: 24 };

export const createRadarChart = (config) => {
    if (!config || typeof config !== 'object') {
        throw new Error('lite-charts: createRadarChart requires a config object');
    }

    // ---- Config + accessors ------------------------------------------
    const axisLabelsInitial = Array.isArray(config.axes) ? config.axes.slice() : [];
    if (axisLabelsInitial.length < 3) {
        throw new Error('lite-charts: createRadarChart requires at least 3 axes');
    }
    const axisCount = axisLabelsInitial.length;
    const axisLabelsRef = { value: axisLabelsInitial };

    // Series input: either a function returning array (reactive) or an
    // array directly. Each series: { name, color, values: [N] }.
    let seriesSource;
    if (typeof config.series === 'function') {
        seriesSource = config.series;
    } else if (Array.isArray(config.series)) {
        const arr = config.series;
        seriesSource = () => arr;
    } else {
        throw new Error('lite-charts: createRadarChart requires `series` array (or function returning one)');
    }

    // Dimensions: explicit (number or signal) or auto-observed at mount.
    const widthExplicit = config.width != null;
    const heightExplicit = config.height != null;
    // v1.2.0: track signals lite-charts creates so `chart.destroy()` can
    // dispose them. See axis kernel for the rationale.
    const _ownedSignals = [];
    const _own = (s) => { _ownedSignals.push(s); return s; };
    const widthAutoSig = widthExplicit ? null : _own(signal(400));
    const heightAutoSig = heightExplicit ? null : _own(signal(400));
    const widthSig = widthExplicit ? asAccessor(config.width) : widthAutoSig;
    const heightSig = heightExplicit ? asAccessor(config.height) : heightAutoSig;

    const margin = config.margin || DEFAULT_RADAR_MARGIN;
    const marginTop    = margin.top    != null ? margin.top    : DEFAULT_RADAR_MARGIN.top;
    const marginRight  = margin.right  != null ? margin.right  : DEFAULT_RADAR_MARGIN.right;
    const marginBottom = margin.bottom != null ? margin.bottom : DEFAULT_RADAR_MARGIN.bottom;
    const marginLeft   = margin.left   != null ? margin.left   : DEFAULT_RADAR_MARGIN.left;

    const gridTicks = config.gridTicks != null ? Math.max(1, +config.gridTicks | 0) : 4;

    // Domain: explicit [vMin, vMax] OR auto-computed from data extremes.
    // domainRef is a stable object reference; mutated in place by the data
    // effect so draw fns always see fresh values.
    const explicitDomain = Array.isArray(config.domain) ? [+config.domain[0], +config.domain[1]] : null;
    const domainRef = { value: explicitDomain ? explicitDomain : [0, 1] };

    // ---- State (per-series) ------------------------------------------
    const seriesStates = [];               // array of RadarSeriesState
    const seriesVisibility = [];           // array of signals (one per series)
    let resolvedColors = [];               // parallel to seriesStates; mutated in place

    const ensureSeriesSlots = (count) => {
        while (seriesStates.length < count) seriesStates.push(makeRadarSeriesState());
        while (seriesVisibility.length < count) seriesVisibility.push(_own(signal(true)));
    };

    // Geometry: stable object, mutated by the size effect.
    const geometry = {
        cx: 0, cy: 0, rOuter: 0, axisCount,
        cosA: new Float64Array(Math.max(axisCount, 4)),
        sinA: new Float64Array(Math.max(axisCount, 4)),
    };
    const plotBoundsBox = { x: 0, y: 0, w: 0, h: 0 };
    const plotBoundsSignal = _own(signal(0));
    const dataVersion = _own(signal(0));

    // ---- Style refs --------------------------------------------------
    const axisColorRef       = { value: '#cccccc' };
    const gridColorRef       = { value: '#e6e6e6' };
    const labelColorRef      = { value: '#444444' };
    const fontRef            = { value: config.font != null ? config.font : '11px sans-serif' };
    const fillOpacityRef     = { value: config.fillOpacity != null ? +config.fillOpacity : 0.2 };
    const strokeWidthRef     = { value: config.strokeWidth != null ? +config.strokeWidth : 2 };
    const tooltipBgRef       = { value: 'rgba(255,255,255,0.96)' };
    const tooltipBorderRef   = { value: '#cccccc' };

    // ---- Crosshair facade --------------------------------------------
    const crosshairData = {
        visible: false,
        seriesIdx: -1,
        axisIdx: -1,
        value: 0,
        mousePixelX: 0,
        mousePixelY: 0,
    };
    const crosshairVersion = _own(signal(0));
    const crosshairFacade = function () { crosshairVersion(); return crosshairData; };
    crosshairFacade.peek = () => crosshairData;
    crosshairFacade.subscribe = (cb) => crosshairVersion.subscribe(() => cb(crosshairData));

    const tooltipOpts = config.tooltip === false ? null
        : (typeof config.tooltip === 'object' ? config.tooltip : {});
    const tooltipFormatter = tooltipOpts && typeof tooltipOpts.format === 'function' ? tooltipOpts.format : null;
    const interactionEnabled = !!tooltipOpts;

    const legendEnabled = config.legend !== false;
    let legendPosition = 'bottom';
    let legendContainer = null;
    if (typeof config.legend === 'string') {
        if (config.legend === 'top' || config.legend === 'bottom' || config.legend === 'left' || config.legend === 'right') {
            legendPosition = config.legend;
        }
    } else if (config.legend && typeof config.legend === 'object') {
        if (config.legend.position) legendPosition = config.legend.position;
        if (config.legend.container) legendContainer = config.legend.container;
    }

    // ---- Mount lifecycle --------------------------------------------
    let scene = null;
    let canvas = null;
    let container = null;
    let canvasCreated = false;
    let legendEl = null;
    let legendWrapper = null;
    let disposers = [];
    let mounted = false;

    const refreshResolvedColors = () => {
        resolvedColors.length = seriesStates.length;
        for (let s = 0; s < seriesStates.length; s++) {
            resolvedColors[s] = resolveColor(seriesStates[s].rawColor, container);
        }
    };

    const mount = (target) => {
        if (mounted) throw new Error('lite-charts: chart already mounted');
        if (!target) throw new Error('lite-charts: mount() requires an HTMLElement or HTMLCanvasElement');

        if (target.tagName === 'CANVAS') {
            canvas = target;
            container = target.parentElement || target;
            canvasCreated = false;
        } else if (typeof target.appendChild === 'function') {
            if (typeof document === 'undefined') {
                throw new Error('lite-charts: mount() needs a real document to create a canvas');
            }
            canvas = document.createElement('canvas');
            target.appendChild(canvas);
            container = target;
            canvasCreated = true;
        } else if (typeof target.getContext === 'function') {
            canvas = target;
            container = null;
            canvasCreated = false;
        } else {
            throw new Error('lite-charts: mount() target must be an HTMLElement or HTMLCanvasElement');
        }

        // Auto-resize wire-up: if width/height were omitted, observe the
        // container so the chart tracks parent dimensions.
        if (widthAutoSig || heightAutoSig) {
            _wireAutoSize(container, widthAutoSig, heightAutoSig, disposers);
        }

        const w0 = (+untrack(widthSig) | 0) || 400;
        const h0 = (+untrack(heightSig) | 0) || 400;
        canvas.width = w0;
        canvas.height = h0;

        axisColorRef.value      = resolveColor(config.axisColor   != null ? config.axisColor   : '#cccccc', container);
        gridColorRef.value      = resolveColor(config.gridColor   != null ? config.gridColor   : '#e6e6e6', container);
        labelColorRef.value     = resolveColor(config.labelColor  != null ? config.labelColor  : '#444444', container);
        tooltipBgRef.value      = resolveColor(tooltipOpts && tooltipOpts.background ? tooltipOpts.background : 'rgba(255,255,255,0.96)', container);
        tooltipBorderRef.value  = resolveColor(tooltipOpts && tooltipOpts.border     ? tooltipOpts.border     : '#cccccc', container);

        const schedule = config.schedule || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => cb());
        scene = createScene(canvas, {
            background: config.background != null ? config.background : null,
            autoResize: false,
            dpr: config.dpr != null ? config.dpr : (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1),
            schedule,
        });
        const resolvedDpr = config.dpr != null ? config.dpr : (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);

        // Effect 1: dimensions -> canvas backing buffer + plot bounds + geometry
        disposers.push(effect(() => {
            const w = +widthSig() | 0 || 400;
            const h = +heightSig() | 0 || 400;
            const wBacking = Math.max(1, Math.round(w * resolvedDpr));
            const hBacking = Math.max(1, Math.round(h * resolvedDpr));
            if (canvas.width  !== wBacking) canvas.width  = wBacking;
            if (canvas.height !== hBacking) canvas.height = hBacking;
            if (typeof canvas.style !== 'undefined') {
                canvas.style.width  = w + 'px';
                canvas.style.height = h + 'px';
            }
            plotBoundsBox.x = marginLeft;
            plotBoundsBox.y = marginTop;
            plotBoundsBox.w = Math.max(0, w - marginLeft - marginRight);
            plotBoundsBox.h = Math.max(0, h - marginTop - marginBottom);
            computeRadarGeometry(geometry, plotBoundsBox, axisCount);
            plotBoundsSignal.update((v) => (v + 1) | 0);
            if (scene) scene.markDirty();
        }));

        // Effect 2: series data + visibility -> extract per series, recompute domain
        disposers.push(effect(() => {
            const series = seriesSource();
            const count = Array.isArray(series) ? series.length : 0;
            ensureSeriesSlots(count);

            // Subscribe to all visibility signals after they exist.
            for (let s = 0; s < count; s++) seriesVisibility[s]();

            for (let s = 0; s < count; s++) {
                extractRadarSeriesData(seriesStates[s], series[s], axisCount);
                seriesStates[s].visible = !!untrack(seriesVisibility[s]);
            }
            // Trim trailing states if series count shrank.
            for (let s = count; s < seriesStates.length; s++) {
                seriesStates[s].n = 0;
                seriesStates[s].visible = false;
            }

            // Auto-domain unless user pinned it.
            if (!explicitDomain) {
                let vMin = Infinity, vMax = -Infinity, anyData = false;
                for (let s = 0; s < count; s++) {
                    if (!seriesStates[s].visible) continue;
                    for (let i = 0; i < axisCount; i++) {
                        const v = seriesStates[s].values[i];
                        if (v < vMin) vMin = v;
                        if (v > vMax) vMax = v;
                        anyData = true;
                    }
                }
                if (!anyData) { vMin = 0; vMax = 1; }
                if (vMin === vMax) vMax = vMin + 1;
                // Anchor at 0 if everything's non-negative (the conventional radar look).
                if (vMin > 0 && vMin / vMax < 0.5) vMin = 0;
                domainRef.value[0] = vMin;
                domainRef.value[1] = vMax;
            }

            refreshResolvedColors();

            // Rebuild legend if shape changed.
            if (legendEl) populateRadarLegend();

            dataVersion.update((v) => (v + 1) | 0);
            if (scene) scene.markDirty();
        }));

        // Effect 3: geometry recompute on plotBounds change
        disposers.push(effect(() => {
            plotBoundsSignal();
            computeRadarGeometry(geometry, plotBoundsBox, axisCount);
            if (scene) scene.markDirty();
        }));

        // Scene nodes (z-ordered): grid -> polygons -> spokes+labels -> crosshair
        const gridDrawFn     = makeRadarGridDrawFn(geometry, gridTicks, gridColorRef);
        const polygonDrawFn  = makeRadarPolygonDrawFn(seriesStates, resolvedColors, geometry, domainRef, fillOpacityRef, strokeWidthRef);
        const spokesDrawFn   = makeRadarSpokesDrawFn(geometry, axisLabelsRef, axisColorRef, labelColorRef, fontRef);

        scene.root.add(pathNode({ draw: (ctx) => gridDrawFn(ctx) }));
        scene.root.add(pathNode({ draw: (ctx) => polygonDrawFn(ctx) }));
        scene.root.add(pathNode({ draw: (ctx) => spokesDrawFn(ctx) }));

        // Dirty bridge: data + plotBounds -> markDirty
        disposers.push(effect(() => {
            dataVersion();
            plotBoundsSignal();
            if (scene) scene.markDirty();
        }));

        // Crosshair / tooltip
        if (interactionEnabled) {
            scene.root.add(pathNode({ draw: (ctx) => drawCrosshair(ctx) }));
            disposers.push(effect(() => {
                crosshairVersion();
                if (scene) scene.markDirty();
            }));
            if (typeof canvas.addEventListener === 'function') {
                const onMove = (e) => {
                    const rect = typeof canvas.getBoundingClientRect === 'function'
                        ? canvas.getBoundingClientRect()
                        : { left: 0, top: 0, width: canvas.width, height: canvas.height };
                    moveCrosshair(e.clientX - rect.left, e.clientY - rect.top);
                };
                const onLeave = () => hideCrosshair();
                canvas.addEventListener('mousemove', onMove);
                canvas.addEventListener('mouseleave', onLeave);
                disposers.push(() => {
                    canvas.removeEventListener('mousemove', onMove);
                    canvas.removeEventListener('mouseleave', onLeave);
                });
            }
        }

        // Legend (per series, click-to-toggle visibility)
        if (legendEnabled && typeof document !== 'undefined') {
            legendEl = document.createElement('div');
            legendEl.className = 'lite-charts-legend lite-charts-radar-legend';
            legendEl.style.display = 'flex';
            legendEl.style.flexWrap = 'wrap';
            legendEl.style.gap = '12px';
            legendEl.style.padding = '8px 0';
            legendEl.style.font = fontRef.value;
            legendEl.style.color = labelColorRef.value;
            legendEl.style.alignItems = 'center';
            populateRadarLegend();
            if (legendContainer) {
                legendContainer.appendChild(legendEl);
            } else if (canvasCreated && container) {
                legendWrapper = installLegend(container, canvas, legendEl, legendPosition);
            }
            if (!legendContainer && !legendWrapper) legendEl = null;
        }

        mounted = true;
        return chart;
    };

    const populateRadarLegend = () => {
        if (!legendEl) return;
        while (legendEl.firstChild) legendEl.removeChild(legendEl.firstChild);
        for (let s = 0; s < seriesStates.length; s++) {
            const idx = s;
            const state = seriesStates[idx];
            if (state.n === 0) continue;   // skip trimmed slots
            const row = document.createElement('button');
            row.type = 'button';
            row.style.display = 'inline-flex';
            row.style.alignItems = 'center';
            row.style.gap = '6px';
            row.style.cursor = 'pointer';
            row.style.background = 'none';
            row.style.border = 'none';
            row.style.padding = '4px 6px';
            row.style.font = 'inherit';
            row.style.color = 'inherit';
            row.style.borderRadius = '4px';

            const swatch = document.createElement('span');
            swatch.style.display = 'inline-block';
            swatch.style.width = '12px';
            swatch.style.height = '12px';
            swatch.style.borderRadius = '2px';
            swatch.style.background = resolvedColors[idx] || '#888';
            swatch.style.flexShrink = '0';

            const label = document.createElement('span');
            label.textContent = state.name || ('series ' + idx);

            row.appendChild(swatch);
            row.appendChild(label);

            const onClick = () => seriesVisibility[idx].update((v) => !v);
            row.addEventListener('click', onClick);
            disposers.push(() => row.removeEventListener('click', onClick));

            const visDispose = effect(() => {
                const v = seriesVisibility[idx]();
                row.style.opacity = v ? '1' : '0.4';
            });
            disposers.push(visDispose);

            legendEl.appendChild(row);
        }
    };

    const unmount = () => {
        if (!mounted) return;
        for (let i = 0; i < disposers.length; i++) {
            try { disposers[i](); } catch (e) { /* swallow */ }
        }
        disposers.length = 0;
        if (scene) {
            try { scene.dispose(); } catch (e) { /* swallow */ }
            scene = null;
        }
        if (legendWrapper && legendWrapper.parentNode) {
            legendWrapper.parentNode.removeChild(legendWrapper);
        } else if (legendEl && legendEl.parentNode) {
            legendEl.parentNode.removeChild(legendEl);
        } else if (canvasCreated && container && canvas && canvas.parentNode === container) {
            container.removeChild(canvas);
        }
        legendEl = null;
        legendWrapper = null;
        canvas = null;
        container = null;
        mounted = false;
    };

    // v1.2.0: terminal teardown -- see axis kernel for rationale.
    let destroyed = false;
    const destroy = () => {
        if (destroyed) return;
        if (mounted) unmount();
        for (let i = 0; i < _ownedSignals.length; i++) {
            try { dispose(_ownedSignals[i]); } catch (_) { /* swallow */ }
        }
        _ownedSignals.length = 0;
        destroyed = true;
    };

    // ---- Hit + tooltip ------------------------------------------------
    const moveCrosshair = (canvasX, canvasY) => {
        if (!interactionEnabled || !mounted) return;
        const hit = radarHitTest(canvasX, canvasY, seriesStates, geometry, domainRef);
        if (!hit) { hideCrosshair(); return; }
        if (crosshairData.visible
            && crosshairData.seriesIdx === hit.seriesIdx
            && crosshairData.axisIdx === hit.axisIdx
            && crosshairData.mousePixelX === canvasX
            && crosshairData.mousePixelY === canvasY) return;
        crosshairData.visible = true;
        crosshairData.seriesIdx = hit.seriesIdx;
        crosshairData.axisIdx = hit.axisIdx;
        crosshairData.value = hit.value;
        crosshairData.mousePixelX = canvasX;
        crosshairData.mousePixelY = canvasY;
        crosshairVersion.update((x) => (x + 1) | 0);
    };

    const hideCrosshair = () => {
        if (!interactionEnabled) return;
        if (!crosshairData.visible) return;
        crosshairData.visible = false;
        crosshairData.seriesIdx = -1;
        crosshairData.axisIdx = -1;
        crosshairData.value = 0;
        crosshairData.mousePixelX = 0;
        crosshairData.mousePixelY = 0;
        crosshairVersion.update((x) => (x + 1) | 0);
    };

    const drawCrosshair = (ctx) => {
        if (!crosshairData.visible) return;
        if (!tooltipOpts) return;
        drawRadarTooltip(ctx);
    };

    const drawRadarTooltip = (ctx) => {
        const aIdx = crosshairData.axisIdx;
        if (aIdx < 0) return;
        const axisLabel = aIdx < axisLabelsRef.value.length ? String(axisLabelsRef.value[aIdx]) : ('axis ' + aIdx);

        // Build rows: one per visible series, showing that series' value at this axis.
        const rows = [];
        for (let s = 0; s < seriesStates.length; s++) {
            const st = seriesStates[s];
            if (!st.visible || st.n === 0) continue;
            rows.push({
                color: resolvedColors[s] || '#888',
                label: st.name || ('series ' + s),
                value: formatTooltipValue(st.values[aIdx]),
            });
        }

        let header = axisLabel;
        if (tooltipFormatter) {
            const out = tooltipFormatter({
                axisIdx: aIdx,
                axisLabel,
                seriesIdx: crosshairData.seriesIdx,
                value: crosshairData.value,
                rows,
            });
            if (typeof out === 'string') { header = out; rows.length = 0; }
            else if (out && typeof out === 'object') {
                if (out.header != null) header = out.header;
                if (Array.isArray(out.rows)) { rows.length = 0; for (let i = 0; i < out.rows.length; i++) rows.push(out.rows[i]); }
            }
        }

        if (rows.length === 0 && !header) return;

        ctx.font = fontRef.value;
        const padding = 8;
        const swatch = 8;
        const lineHeight = 14;
        let maxW = ctx.measureText(header).width;
        for (let i = 0; i < rows.length; i++) {
            const w = swatch + 6 + ctx.measureText(rows[i].label + '  ' + rows[i].value).width;
            if (w > maxW) maxW = w;
        }
        const boxW = maxW + padding * 2;
        const boxH = (rows.length + 1) * lineHeight + padding;

        const pb = plotBoundsBox;
        let bx = crosshairData.mousePixelX + 12;
        if (bx + boxW > pb.x + pb.w) bx = crosshairData.mousePixelX - 12 - boxW;
        if (bx < pb.x) bx = pb.x;
        let by = crosshairData.mousePixelY - boxH / 2;
        if (by < pb.y) by = pb.y;
        if (by + boxH > pb.y + pb.h) by = pb.y + pb.h - boxH;

        ctx.fillStyle = tooltipBgRef.value;
        ctx.strokeStyle = tooltipBorderRef.value;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bx, by, boxW, boxH);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = labelColorRef.value;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(header, bx + padding, by + padding);
        for (let i = 0; i < rows.length; i++) {
            const ry = by + padding + (i + 1) * lineHeight;
            ctx.fillStyle = rows[i].color;
            ctx.fillRect(bx + padding, ry + 2, swatch, swatch);
            ctx.fillStyle = labelColorRef.value;
            ctx.fillText(rows[i].label + '  ' + rows[i].value, bx + padding + swatch + 6, ry);
        }
    };

    const chart = {
        mount,
        unmount,
        destroy,
        exportPNG: (opts) => {
            if (!mounted || !canvas) throw new Error('lite-charts: exportPNG() requires mount() first');
            if (typeof canvas.toDataURL !== 'function') {
                throw new Error('lite-charts: exportPNG() requires a real HTMLCanvasElement');
            }
            const mt = opts && opts.mimeType || 'image/png';
            const q = opts && opts.quality != null ? opts.quality : 0.92;
            return canvas.toDataURL(mt, q);
        },
        exportSVG: (opts) => {
            if (!mounted || !scene) throw new Error('lite-charts: exportSVG() requires mount() first');
            const w = +widthSig() | 0 || 400;
            const h = +heightSig() | 0 || 400;
            const bg = (opts && opts.background !== undefined)
                ? opts.background
                : (config.background != null ? config.background : null);
            return _exportSceneToSVG(scene, w, h, bg);
        },
        redraw: () => { if (scene) scene.markDirty(); },
        moveCrosshair,
        hideCrosshair,
        setSeriesVisible: (idx, visible) => {
            if (idx < 0 || idx >= seriesVisibility.length) return;
            seriesVisibility[idx].set(!!visible);
        },
        refreshTheme: () => {
            if (!mounted) return;
            axisColorRef.value     = resolveColor(config.axisColor   != null ? config.axisColor   : '#cccccc', container);
            gridColorRef.value     = resolveColor(config.gridColor   != null ? config.gridColor   : '#e6e6e6', container);
            labelColorRef.value    = resolveColor(config.labelColor  != null ? config.labelColor  : '#444444', container);
            tooltipBgRef.value     = resolveColor(tooltipOpts && tooltipOpts.background ? tooltipOpts.background : 'rgba(255,255,255,0.96)', container);
            tooltipBorderRef.value = resolveColor(tooltipOpts && tooltipOpts.border     ? tooltipOpts.border     : '#cccccc', container);
            refreshResolvedColors();
            if (legendEl) populateRadarLegend();
            if (scene) scene.markDirty();
        },
        get scene() { return scene; },
        get canvas() { return canvas; },
        get geometry() { return geometry; },
        get domain() { return domainRef.value.slice(); },
        get legend() { return legendEl; },
        plotBounds: plotBoundsSignal,
        crosshair: crosshairFacade,
        seriesVisibility,
        _internal: {
            seriesStates,
            geometry,
            plotBoundsBox,
            domainRef,
            seriesVisibility,
            dataVersion,
        },
    };

    return chart;
};

// ---------------------------------------------------------------------------
// Test-only export (NOT part of the stable public API)
// ---------------------------------------------------------------------------
//
// White-box access to pure helpers for unit testing. NOT part of the stable
// public API; the leading underscore signals private. Critically, this is a
// SEPARATE export from any chart factory -- normal user code that does
// `import { createLineChart }` never references it, so the bundler drops it
// and (transitively) drops every helper that's only reachable through it.

// ---------------------------------------------------------------------------
// v1.10.0 -- weekend shading helpers (used only by createTimeLineChart)
// ---------------------------------------------------------------------------
// Defined here (above _testHelpers, below createBaseAxisChart) so they are out
// of the shared axis kernel's source region -- the tree-shake confinement the
// v1.7.0 annotation split established. See createTimeLineChart for wiring.

const _DAY_MS = 86400000;   // 24h in ms -- a UTC day is exactly this (no DST)
const _WEEK_MS = 604800000; // 7 * _DAY_MS
const DEFAULT_WEEKEND_FILL = 'rgba(0,0,0,0.05)';

// v1.11.0 -- market-hours session shading. COLD, construction-time validator,
// called ONCE from createTimeLineChart (never inside the accessor). Returns null
// unless `shading` is an object carrying `sessions` OR `holidays` -- the v1.10.0
// weekend forms (true / 'weekends' / {fill?}) fall through to _weekendBands
// untouched. Otherwise it validates the calendar and returns a normalized,
// open-sorted spec. Fail closed: EVERY junk config THROWS here (a config error,
// at build time, not a silent draw-time zero). null is not zero -- an openMinutes
// of null must NOT coerce to midnight, so the `== null` gate is BEFORE any unary
// +. `dayMask` is a bitfield over UTC weekdays (bit d = weekday d); absent `days`
// -> 62 (Mon-Fri, bits 1..5). `days` names the UTC weekday the session OPENS.
// v1.13.0 -- overnight sessions (close < open) are SPLIT at the UTC midnight seam
// into an evening half [open, 1440] today and a morning half [0, close] on the
// NEXT UTC day (weekday bits rotated d -> (d+1)%7), so a Mon-Fri overnight spec
// has its morning halves on Tue-Sat. Both halves keep close <= 1440, so the
// complement walker in _sessionBands still assumes close <= 1440. Holidays
// (shading.holidays) are epoch ms truncated to their UTC day start into a Set;
// _sessionBands closes the whole UTC day (fuses with adjacent gap bands).
const _normalizeSessionSpec = (shading) => {
    if (!(typeof shading === 'object' && shading !== null && (shading.sessions != null || shading.holidays != null))) {
        return null;
    }
    // Holidays without sessions: synthesize a full-day Mon-Fri calendar so the
    // complement (weekends + holidays) rides the SAME validation loop and sweep.
    const raw = shading.sessions != null ? shading.sessions : [{ openMinutes: 0, closeMinutes: 1440, days: [1, 2, 3, 4, 5] }];
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('lite-charts: createTimeLineChart `shading.sessions` must be a non-empty array');
    }
    const sessions = [];
    // v1.15.0: masks over UTC weekdays (bit d = weekday d), consumed ONLY by the
    // early-close holiday doors below. openMask = any weekday that opens a session
    // (regular, overnight evening OR overnight morning half); eveMask = weekdays
    // carrying an overnight EVENING half (which runs to next-day 00:00, so an
    // early close on that day is a contradiction, not a configuration).
    let openMask = 0;
    let eveMask = 0;
    for (let i = 0; i < raw.length; i++) {
        const s = raw[i];
        if (typeof s !== 'object' || s === null || Array.isArray(s)) {
            throw new Error('lite-charts: createTimeLineChart session must be a plain object { openMinutes, closeMinutes, days? }');
        }
        // null is not zero: gate BEFORE any unary + (+null === 0 would become midnight).
        if (s.openMinutes == null || s.closeMinutes == null) {
            throw new Error('lite-charts: createTimeLineChart session requires numeric openMinutes and closeMinutes');
        }
        const open = s.openMinutes;
        const close = s.closeMinutes;
        if (!Number.isInteger(open) || !Number.isInteger(close)) {
            throw new Error('lite-charts: createTimeLineChart session openMinutes/closeMinutes must be integers');
        }
        if (open < 0 || open > 1439) {
            throw new Error('lite-charts: createTimeLineChart session openMinutes must be in 0..1439');
        }
        if (close < 1 || close > 1440) {
            throw new Error('lite-charts: createTimeLineChart session closeMinutes must be in 1..1440');
        }
        if (close === open) {
            throw new Error('lite-charts: createTimeLineChart session has zero width (closeMinutes === openMinutes)');
        }
        let dayMask = 62; // default Mon-Fri (bits 1..5): 2+4+8+16+32
        if (s.days != null) {
            if (!Array.isArray(s.days) || s.days.length === 0) {
                throw new Error('lite-charts: createTimeLineChart session `days` must be a non-empty array of UTC weekday integers 0..6');
            }
            dayMask = 0;
            for (let j = 0; j < s.days.length; j++) {
                const d = s.days[j];
                if (!Number.isInteger(d) || d < 0 || d > 6) {
                    throw new Error('lite-charts: createTimeLineChart session `days` must be integers 0..6');
                }
                dayMask |= (1 << d);
            }
        }
        if (close < open) {
            // Overnight: split at the UTC midnight seam. Evening half [open, 1440]
            // fires today; morning half [0, close] fires on the NEXT UTC day, its
            // weekday bits rotated d -> (d+1)%7. Both halves keep close <= 1440, so
            // the sweep's single-cursor invariant (ascending starts, every interval
            // ends within its own day) survives. The seam emits NO band: the evening
            // half closes at exactly next-day 00:00 and the morning half opens at 0
            // (sorts first within its day), so `o > cursor` is strict -- no sliver.
            const morningMask = ((dayMask << 1) | (dayMask >> 6)) & 127;
            sessions.push({ open, close: 1440, dayMask });
            sessions.push({ open: 0, close, dayMask: morningMask });
            eveMask |= dayMask;
            openMask |= dayMask | morningMask;
        } else {
            sessions.push({ open, close, dayMask });
            openMask |= dayMask;
        }
    }
    // Ascending by open: the single-cursor sweep in _sessionBands relies on this
    // (with every close <= 1440) to emit the complement in one forward pass.
    sessions.sort((a, b) => a.open - b.open);
    // Holiday calendar (COLD, MAY allocate): each epoch-ms entry truncated to its
    // UTC day start (Math.floor, NOT `h % _DAY_MS` -- subtraction truncates toward
    // zero and lands pre-1970 dates on the wrong UTC day). null is not epoch 0, so
    // the `== null` gate is BEFORE Number.isInteger (which also rejects Date, NaN,
    // Infinity, strings, 1.5). _sessionBands closes each holiday's whole UTC day.
    // A holiday entry is EITHER a number (whole-day close, byte-identical to
    // v1.14.0) OR an object { ts, closeMinutes } (v1.15.0 early close). Foreign
    // objects (Date, {}, []) carry neither `ts` nor `closeMinutes`, so they land
    // on the scalar path and throw the same 'integer epoch ms' rule as v1.14.0.
    // `seen` rejects a duplicate truncated UTC day across ALL entries (both forms).
    let hol = null;
    let early = null;
    if (shading.holidays != null) {
        const rawHol = shading.holidays;
        if (!Array.isArray(rawHol) || rawHol.length === 0) {
            throw new Error('lite-charts: createTimeLineChart `shading.holidays` must be a non-empty array');
        }
        hol = new Set();
        const seen = new Set();
        for (let i = 0; i < rawHol.length; i++) {
            const h = rawHol[i];
            if (h == null) {
                throw new Error('lite-charts: createTimeLineChart `shading.holidays` entries must be numeric epoch ms (null is not epoch 0)');
            }
            // Early-close object form: recognized only when it carries `ts` or
            // `closeMinutes`. null is not zero -- gate == null BEFORE any unary +.
            if (typeof h === 'object' && (h.ts != null || h.closeMinutes != null)) {
                const ts = h.ts;
                if (ts == null) {
                    throw new Error('lite-charts: createTimeLineChart early-close holiday requires numeric `ts` (null is not epoch 0)');
                }
                if (!Number.isInteger(ts)) {
                    throw new Error('lite-charts: createTimeLineChart `shading.holidays` entries must be integer epoch ms');
                }
                const cm = h.closeMinutes;
                if (cm == null) {
                    throw new Error('lite-charts: createTimeLineChart early-close holiday requires numeric `closeMinutes` (null is not zero)');
                }
                if (!Number.isInteger(cm) || cm < 1 || cm > 1439) {
                    throw new Error('lite-charts: createTimeLineChart early-close holiday `closeMinutes` must be an integer in 1..1439');
                }
                const dayStart = Math.floor(ts / _DAY_MS) * _DAY_MS;
                if (seen.has(dayStart)) {
                    throw new Error('lite-charts: createTimeLineChart `shading.holidays` has a duplicate UTC day');
                }
                seen.add(dayStart);
                const dow = new Date(dayStart).getUTCDay();
                if (!(openMask & (1 << dow))) {
                    throw new Error('lite-charts: createTimeLineChart early-close holiday falls on a UTC weekday with no open session');
                }
                if (eveMask & (1 << dow)) {
                    throw new Error('lite-charts: createTimeLineChart early-close holiday falls on a UTC weekday carrying an overnight evening session');
                }
                if (early === null) early = new Map();
                early.set(dayStart, cm);
            } else {
                if (!Number.isInteger(h)) {
                    throw new Error('lite-charts: createTimeLineChart `shading.holidays` entries must be integer epoch ms');
                }
                const dayStart = Math.floor(h / _DAY_MS) * _DAY_MS;
                if (seen.has(dayStart)) {
                    throw new Error('lite-charts: createTimeLineChart `shading.holidays` has a duplicate UTC day');
                }
                seen.add(dayStart);
                hol.add(dayStart);
            }
        }
    }
    return { fill: shading.sessionFill != null ? shading.sessionFill : null, sessions, holidays: hol, earlyClose: early };
};

// v1.11.0 -- COLD session-band generator, sibling of _weekendBands. Runs ONLY
// inside the annotation resolve effect (sub-Hz, data-tracked), so it MAY allocate.
// It emits the COMPLEMENT of the open-interval union: for each UTC day in the data
// extent it opens the day's active sessions ([dayStart+open, dayStart+close]) and
// pushes one range band per GAP between them, clipped to [xMin, xMax]. Fail closed:
// the prologue is byte-identical to _weekendBands (null gated BEFORE any unary +,
// non-finite/inverted extent -> no bands). v1.13.0 -- a holiday day (spec.holidays
// Set) contributes no open intervals, so the cursor swallows the whole UTC day and
// fuses it with the neighboring gaps into one band.
const _sessionBands = (xMinRaw, xMaxRaw, spec, fill) => {
    const out = [];
    if (xMinRaw == null || xMaxRaw == null) return out; // null is not zero
    const xMin = +xMinRaw;
    const xMax = +xMaxRaw;
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !(xMax > xMin)) return out;
    const f = spec.fill != null ? spec.fill : fill;
    const hol = spec.holidays;
    const early = spec.earlyClose;
    let cursor = xMin;
    const d = new Date(xMin);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    // Seed one day early so the prior day's evening overnight half (which closes at
    // exactly this day's 00:00, never past it) is visited before its seam.
    const first = dayStart - _DAY_MS;
    // No sort/merge pass here: sessions are open-sorted (T1) and every close reaches
    // the day boundary exactly (evening overnight halves close at next-day 00:00)
    // but never past it, so a single forward cursor yields the complement.
    for (let day = first; day < xMax; day += _DAY_MS) {
        // Holiday: skip the day's sessions entirely. `day` is a true UTC midnight
        // (seeded from Date.UTC parts, stepped by _DAY_MS -- UTC has no DST), so it
        // matches the Set keys. The cursor advances over the whole closed day.
        if (hol !== null && hol.has(day)) continue;
        // Early close: clamp every session's close to dayStart + closeMinutes so
        // the trailing gap fuses forward exactly like a whole-day holiday's band.
        // Whole-day (number) holidays and non-early days keep cutMs = Infinity, so
        // c === c0 and the band output stays byte-identical to v1.14.0.
        let cutMs = Infinity;
        if (early !== null) {
            const cm = early.get(day);
            if (cm !== undefined) cutMs = day + cm * 60000;
        }
        const dow = new Date(day).getUTCDay();
        for (let j = 0; j < spec.sessions.length; j++) {
            const s = spec.sessions[j];
            if (!(s.dayMask & (1 << dow))) continue;
            const o = day + s.open * 60000;
            const c0 = day + s.close * 60000;
            const c = c0 < cutMs ? c0 : cutMs;
            if (o >= c) continue;
            if (o > cursor && cursor < xMax) out.push({ type: 'range', axis: 'x', from: cursor, to: o < xMax ? o : xMax, fill: f });
            if (c > cursor) cursor = c;
        }
    }
    if (cursor < xMax) out.push({ type: 'range', axis: 'x', from: cursor, to: xMax, fill: f });
    return out;
};

// COLD band generator. Runs ONLY inside the annotation resolve effect (sub-Hz,
// data-tracked) -- never on the per-frame draw path -- so it MAY allocate. It
// walks UTC weeks over the DATA x-extent (epoch ms) and emits one range
// annotation per weekend, the natural unit being Sat 00:00 UTC -> Mon 00:00 UTC
// (a 48h span). Fail closed: a null bound is gated BEFORE any unary + (recall
// +null === 0 is a finite epoch -- a null bound must become NaN, not 1970), and
// a non-finite or inverted extent emits NO bands.
const _weekendBands = (xMinRaw, xMaxRaw, fill) => {
    const out = [];
    if (xMinRaw == null || xMaxRaw == null) return out; // null is not zero
    const xMin = +xMinRaw;
    const xMax = +xMaxRaw;
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !(xMax > xMin)) return out;
    // Midnight UTC of xMin's day, then step back to the most recent Saturday.
    const d = new Date(xMin);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dow = new Date(dayStart).getUTCDay(); // 0=Sun .. 6=Sat
    const daysSinceSat = (dow + 1) % 7;         // days from `dow` back to Saturday
    const satStart = dayStart - daysSinceSat * _DAY_MS;
    for (let t = satStart; t < xMax; t += _WEEK_MS) {
        const to = t + 2 * _DAY_MS; // Mon 00:00 UTC
        if (to <= xMin) continue;   // weekend ends at/before the domain -> skip
        out.push({ type: 'range', axis: 'x', from: t, to, fill });
    }
    return out;
};

// Returns the annotations accessor createBaseAxisChart will consume. When
// `shading` is ABSENT this is a byte-identical passthrough of the user's
// annotations (their accessor, or null) -- zero added cost, _weekendBands never
// referenced at runtime. When PRESENT it returns an accessor that concatenates
// generated weekend bands with the user's annotations (static array or thunk).
//
// CRITICAL: the extent is derived from the raw series DATA accessors -- the same
// source that BUILDS the scale domain -- NOT xScale.dMin/dMax (which is
// scaleVersion and moves with pan/zoom). This accessor is invoked inside the
// annotation resolve effect (the effect that tracks annotationsAcc()); reading
// the data accessors makes THAT effect track DATA, so bands regenerate only when
// data changes -- never per pan/zoom frame. Reading a scale signal here would
// transitively couple resolve to scaleVersion and re-allocate bands every frame,
// the exact coupling the annotation layer was built to avoid.
const _shadingAnnotationsAcc = (shading, annotations, dataAccs, xAccessor, sessionSpec) => {
    if (shading == null) {
        return annotations != null ? asAccessor(annotations) : null;
    }
    const fill = (typeof shading === 'object' && shading.fill != null)
        ? shading.fill
        : DEFAULT_WEEKEND_FILL;
    const userAcc = annotations != null ? asAccessor(annotations) : null;
    return () => {
        let xMin = Infinity;
        let xMax = -Infinity;
        for (let s = 0; s < dataAccs.length; s++) {
            const rows = dataAccs[s](); // tracked -> DATA reactivity (not scale)
            if (rows && rows.xs && rows.ys && typeof rows.xs.length === 'number') {
                // SoA fast path -- x lives in rows.xs directly (mirrors
                // extractSeriesData's shape check); no accessor. Handling it here
                // is load-bearing: SoA is a first-class data shape, so skipping it
                // would silently emit zero bands for valid input (fail-open).
                const xs = rows.xs;
                const n = xs.length < rows.ys.length ? xs.length : rows.ys.length;
                for (let i = 0; i < n; i++) {
                    const x = xs[i];
                    if (x < xMin) xMin = x;
                    if (x > xMax) xMax = x;
                }
            } else if (Array.isArray(rows)) {
                for (let i = 0; i < rows.length; i++) {
                    // xAccessor is a RAW accessor (no numeric coercion), so a
                    // per-row null/undefined x is gated BEFORE any unary + --
                    // the coercing accessor would turn {x: null} into +null === 0
                    // and collapse xMin to epoch 1970, emitting ~2600 bogus
                    // weekend bands from one missing timestamp (null is not
                    // zero, at row level too). A NaN after coercion self-skips:
                    // both comparisons below are false for NaN.
                    const raw = xAccessor(rows[i]);
                    if (raw == null) continue;
                    const x = raw instanceof Date ? raw.getTime() : +raw;
                    if (x < xMin) xMin = x;
                    if (x > xMax) xMax = x;
                }
            }
            // else: neither AoS nor SoA -> contributes no extent; an all-empty
            // scan leaves xMin/xMax at +/-Infinity, which _weekendBands rejects
            // via !(xMax > xMin) (fail-closed: no bands, never wrong bands).
        }
        const bands = sessionSpec ? _sessionBands(xMin, xMax, sessionSpec, fill) : _weekendBands(xMin, xMax, fill);
        if (userAcc) {
            const user = userAcc();
            if (Array.isArray(user)) {
                for (let i = 0; i < user.length; i++) bands.push(user[i]);
            }
        }
        return bands;
    };
};

export const _testHelpers = {
    // Axis-chart kernel helpers
    decimateMinMax,
    updateLinearScale,
    extractSeriesData,
    extractBarSeriesData,
    scaleSeriesToPixels,
    makeLinearScale,
    makeLogScale,
    updateLogScale,
    makeBandScale,
    updateBandScale,
    // v1.5.0: exposed for the hash-parity guard (A1). The horizontal-bar work
    // must leave these five byte-identical to 1.4.1.
    makeBarDrawFn,
    makeHBarDrawFn,
    _roundRectPath,
    computeBarStacks,
    buildAccessor,
    buildRawAccessor,
    niceYDomain,
    inferXScaleType,
    // v1.4.0-alpha.2 pan/zoom math helpers
    _applyPan,
    _applyZoom,
    _clampToBounds,
    // v1.4.1 (C0) log-aware pan/zoom + clamp
    _applyPanLog,
    _applyZoomLog,
    _clampToBoundsLog,
    // v1.4.0-alpha.3 brush math helpers
    _normalizeBrushRect,
    _brushPxToData,
    _computeBrushIds,
    resolveColor,
    bisectNearest,
    // Bubble-specific (axis kernel + size dimension)
    extractBubbleData,
    computeBubbleRadii,
    // Polar (pie/donut) kernel helpers -- separate kernel, tree-shaken
    // independently from the axis-chart helpers above.
    extractSliceData,
    computeSliceGeometry,
    sliceHitTest,
    recomputePolarAngles,
    makePolarState,
    // Radar kernel helpers
    extractRadarSeriesData,
    computeRadarGeometry,
    radarHitTest,
    makeRadarSeriesState,
    // v1.10.0: time-series preset internals (weekend shading)
    _weekendBands,
    _shadingAnnotationsAcc,
    // v1.11.0: market-hours session shading internals
    _sessionBands,
    _normalizeSessionSpec,
};

export const createLineChart = (config) => createBaseAxisChart(config, LINE_RENDERER);

// ---------------------------------------------------------------------------
// v1.10.0 -- time-series variants: createTimeLineChart + weekend shading
// ---------------------------------------------------------------------------
//
// createTimeLineChart is createLineChart with three time-first defaults baked
// in: (1) xScale.type is FORCED to 'time' regardless of the x key or the data
// probe (bypassing inferXScaleType, which only infers time for a Date probe or
// a {time,date,t} key whose value is >= 1e11); (2) panBounds defaults to 'data'
// so the reachable view equals the data domain; (3) an optional `shading`
// config wraps the user's annotations with cold-generated weekend bands.
//
// Tree-shake: _weekendBands + _shadingAnnotationsAcc (defined just above the
// _testHelpers export) are referenced ONLY from createTimeLineChart. A bundle
// importing createLineChart (or any non-time factory) never names
// createTimeLineChart, so the bundler drops both helpers and
// DEFAULT_WEEKEND_FILL. The shading wrap is applied HERE, at the preset
// call-site, NOT inside the shared createBaseAxisChart kernel, precisely so the
// kernel (and every other axis factory) stays free of it.

// v1.10.0: time-series preset. See _weekendBands / _shadingAnnotationsAcc.
export const createTimeLineChart = (config) => {
    if (!config || typeof config !== 'object') {
        throw new Error('lite-charts: createTimeLineChart requires a config object');
    }
    // (1) force a time x-scale, preserving any other xScale fields (domain, etc.).
    // Fail closed on a conflicting explicit request: `type` absent (undefined) or
    // 'time' is fine, but an explicit other type (e.g. 'log') would be silently
    // overridden -- throw instead. `{type:null}` is an explicit non-time -> throws.
    if (config.xScale && config.xScale.type !== undefined && config.xScale.type !== 'time') {
        throw new Error('lite-charts: createTimeLineChart forces a time x-scale; ' +
            'xScale.type must be omitted or \'time\'');
    }
    const xScale = config.xScale
        ? Object.assign({}, config.xScale, { type: 'time' })
        : { type: 'time' };
    // (2) default panBounds to 'data' (reachable view == data domain)
    const panBounds = config.panBounds != null ? config.panBounds : 'data';
    // (3) optional weekend shading, wrapped over the user's annotations.
    // `false` is a first-class opt-out (the declared type is boolean |
    // 'weekends' | {fill?}), treated exactly like absent; other falsy junk
    // (0, '') still throws below.
    let annotations = config.annotations;
    if (config.shading != null && config.shading !== false) {
        const sh = config.shading;
        if (sh !== true && sh !== 'weekends' && typeof sh !== 'object') {
            throw new Error('lite-charts: createTimeLineChart `shading` must be a boolean, ' +
                '\'weekends\', or a config object { fill? } -- got ' + typeof sh);
        }
        const xKey = config.x != null ? config.x : 'x';
        // RAW accessor: the extent scan gates a per-row null BEFORE coercion
        // (buildAccessor's `+v` would turn a null x into epoch 0).
        const xAccessor = buildRawAccessor(xKey);
        const dataAccs = Array.isArray(config.series)
            ? config.series.map((sr) => asAccessor(sr.data))
            : [asAccessor(config.data)];
        // v1.11.0: normalize a market-hours session calendar ONCE at construction
        // (never inside the accessor). When present the session walker subsumes the
        // weekend walker (a day in no session is fully banded), so no double paint.
        const sessionSpec = _normalizeSessionSpec(sh);
        annotations = _shadingAnnotationsAcc(sh, config.annotations, dataAccs, xAccessor, sessionSpec);
    }
    const merged = Object.assign({}, config, { xScale, panBounds, annotations });
    return createBaseAxisChart(merged, LINE_RENDERER);
};

export const createAreaChart = (config) => createBaseAxisChart(config, AREA_RENDERER);

export const createBarChart = (config) => createBaseAxisChart(config, BAR_RENDERER);

// Bubble lives on the axis kernel via BUBBLE_RENDERER. Each point gets a
// circle whose AREA is proportional to a third dimension by default
// (Tukey-style sqrt scale, configurable to linear). Tree-shake check is
// the same as line/area/bar: importing only `createBubbleChart` drops the
// polar kernel entirely and the line/area/bar renderers as expected.

export const createBubbleChart = (config) => createBaseAxisChart(config, BUBBLE_RENDERER);

// Polar slice charts -- pie and donut share the SLICE_RENDERER. The only
// per-factory difference is the innerRadius default (0 for pie, 0.5 for
// donut), applied by the factory so the user can still override via config.
// Both go through createBasePolarChart (a completely separate kernel from
// createBaseAxisChart -- importing only createPieChart drops all axis-chart
// code: xScale/yScale/axes/grid/decimation/bisect/interp/bar helpers).

export const createPieChart = (config) =>
    createBasePolarChart({ innerRadius: 0, ...(config || {}) }, SLICE_RENDERER);

export const createDonutChart = (config) =>
    createBasePolarChart({ innerRadius: 0.5, ...(config || {}) }, SLICE_RENDERER);

// v1.2.0-alpha.1: scatter is bubble's simpler sibling on the axis kernel.
// Same kernel, simpler renderer (no size dimension, constant marker).
export const createScatterChart = (config) => createBaseAxisChart(config, SCATTER_RENDERER);

// ===========================================================================
// createBaseGridChart -- 2D categorical grid kernel (v1.2.0-alpha.3)
// ===========================================================================
//
// A FOURTH independent kernel. Used by heatmap; future grid-shaped charts
// (correlation matrix, calendar heatmap, dot-matrix) would ride here too.
// Stays strictly separate from the axis kernel (no x-axis ticks, no
// numeric y-scale, no decimation, no markers, no series in the line/bar
// sense) and from the polar/radar kernels.
//
// The data model is a 2D grid of cells indexed by (x-category, y-category).
// Each cell has at most one value; sparse data is supported (missing cells
// render as empty space, the hit-test returns null for them).
//
// Key design points:
//   - Two band scales (x + y) share the math from `makeBandScale`. The
//     y band scale uses pixel coords with the same +y-down convention,
//     so leftEdge(0) is the TOPMOST cell.
//   - Cells are stored as a flat Float32Array indexed `yIdx * nx + xIdx`,
//     matched by a Uint8Array `presentMask` for sparse data.
//   - Per-cell colors are precomputed at extract time into a string Array
//     (`state.cellColors`), so the draw loop is just
//     `fillStyle = cellColors[i]; fillRect(...)` -- zero alloc per cell.
//   - Hit-test is O(1) (one xBand.invert + one yBand.invert + mask check).
//   - The default color ramp linearly interpolates between two endpoint
//     hex colors at extract time; `colorFn` overrides for custom (OKLCH,
//     quantile, diverging) mappings.

const _DEFAULT_GRID_MARGIN = { top: 20, right: 24, bottom: 56, left: 80 };

// Parse '#rgb' or '#rrggbb'. Returns [r, g, b] or null.
const _parseHexColor = (hex) => {
    if (typeof hex !== 'string' || hex.length === 0 || hex.charCodeAt(0) !== 35) return null;
    let r, g, b;
    if (hex.length === 7) {
        r = parseInt(hex.slice(1, 3), 16);
        g = parseInt(hex.slice(3, 5), 16);
        b = parseInt(hex.slice(5, 7), 16);
    } else if (hex.length === 4) {
        r = parseInt(hex.charAt(1) + hex.charAt(1), 16);
        g = parseInt(hex.charAt(2) + hex.charAt(2), 16);
        b = parseInt(hex.charAt(3) + hex.charAt(3), 16);
    } else {
        return null;
    }
    if (r !== r || g !== g || b !== b) return null;  // NaN guards
    return [r, g, b];
};

const _makeGridState = () => ({
    cells: null,            // Float32Array | null; length = nx * ny
    presentMask: null,      // Uint8Array | null
    cellColors: null,       // Array<string|null> | null
    cellLabelColors: null,  // Array<string|null> | null  (only for showValues + auto-contrast)
    presentSorted: null,    // v1.4.0-alpha.1: Float32Array | null; pooled
                            // scratch buffer for quantile boundary computation.
                            // Grows monotonically as nx*ny climbs; subarray()
                            // slices a view for in-place sort without alloc.
    xCategories: [],        // string[]
    yCategories: [],        // string[]
    nx: 0,
    ny: 0,
    vMin: 0,
    vMax: 1,
});

const _extractGridData = (state, data, opts) => {
    if (!Array.isArray(data) || data.length === 0) {
        state.cells = null;
        state.presentMask = null;
        state.cellColors = null;
        state.xCategories = [];
        state.yCategories = [];
        state.nx = 0;
        state.ny = 0;
        state.vMin = 0;
        state.vMax = 1;
        return;
    }

    const xAcc = opts.xAccessor;
    const yAcc = opts.yAccessor;
    const vAcc = opts.valueAccessor;

    // Pass 1: collect unique categories in first-seen order.
    const xCats = [];
    const yCats = [];
    const xMap = new Map();
    const yMap = new Map();
    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const xv = String(xAcc(row, i));
        const yv = String(yAcc(row, i));
        if (!xMap.has(xv)) { xMap.set(xv, xCats.length); xCats.push(xv); }
        if (!yMap.has(yv)) { yMap.set(yv, yCats.length); yCats.push(yv); }
    }
    const nx = xCats.length;
    const ny = yCats.length;
    const total = nx * ny;

    state.xCategories = xCats;
    state.yCategories = yCats;
    state.nx = nx;
    state.ny = ny;

    // Grow buffers if needed (typed arrays don't shrink; that's fine -- the
    // extra capacity is reusable on the next extract if the grid shrinks).
    if (!state.cells || state.cells.length < total) state.cells = new Float32Array(total);
    if (!state.presentMask || state.presentMask.length < total) state.presentMask = new Uint8Array(total);

    // Zero the active region (presentMask = 0 means "missing cell").
    for (let i = 0; i < total; i++) {
        state.cells[i] = 0;
        state.presentMask[i] = 0;
    }

    // Pass 2: fill cells, track value extents.
    let vMin = Infinity;
    let vMax = -Infinity;
    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const xv = String(xAcc(row, i));
        const yv = String(yAcc(row, i));
        const v = +vAcc(row, i);
        if (v !== v) continue;  // NaN -> skip; cell stays "missing"
        const xIdx = xMap.get(xv);
        const yIdx = yMap.get(yv);
        const cellIdx = yIdx * nx + xIdx;
        state.cells[cellIdx] = v;
        state.presentMask[cellIdx] = 1;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
    }
    state.vMin = vMin === Infinity ? 0 : vMin;
    state.vMax = vMax === -Infinity ? 1 : vMax;
};

// Pre-compute the per-cell color string. Called once per extract; the
// per-frame draw loop reads from state.cellColors[i] without allocating.
// Pick a contrast color (#000 or #fff) for text drawn on top of `rgb`.
// Uses NTSC relative luminance (0.299 R + 0.587 G + 0.114 B); threshold at
// half-max (128). Called once per cell at extract time, so it's not on the
// hot path even though it allocates nothing per call.
const _pickContrastColor = (rgb) => {
    const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    return lum > 128 ? '#000000' : '#ffffff';
};

// Approximate parser for `rgb(r, g, b)` strings produced by the linear /
// quantile ramps AND for `#rrggbb` / `#rgb` (delegates to _parseHexColor). Returns null for
// anything more exotic (named colors, oklch(), rgba(), CSS-vars after
// resolve). Used only by the auto-label-color path so colorFn outputs that
// can't be parsed simply fall through to the configured label color.
//
// v1.4.0-alpha.1 (audit fix): was `css.slice(open+1, close).split(',')`
// which on a 10k-cell heatmap allocates 10k Arrays + 30k substring
// objects at extract time. The indexOf scan below uses three substring
// slices total (V8 may sliced-string them; even if materialized they're
// tiny) and never instantiates an intermediate array.
const _parseRGBLike = (css) => {
    if (typeof css !== 'string' || css.length === 0) return null;
    if (css.charCodeAt(0) === 35) return _parseHexColor(css);
    // 'rgb(r,g,b)' or 'rgb(r, g, b)' -- scan commas manually to avoid
    // `split(',')`'s array allocation.
    if (css.length > 4 && css.charCodeAt(0) === 114 && css.charCodeAt(1) === 103 && css.charCodeAt(2) === 98) {
        const open = css.indexOf('(');
        const close = css.indexOf(')', open + 1);
        if (open < 0 || close < 0) return null;
        const c1 = css.indexOf(',', open + 1);
        if (c1 < 0 || c1 > close) return null;
        const c2 = css.indexOf(',', c1 + 1);
        if (c2 < 0 || c2 > close) return null;
        const r = +css.slice(open + 1, c1) | 0;
        const g = +css.slice(c1 + 1, c2) | 0;
        const b = +css.slice(c2 + 1, close) | 0;
        if (r !== r || g !== g || b !== b) return null;
        return [r, g, b];
    }
    return null;
};

const _computeGridColors = (state, opts) => {
    const total = state.nx * state.ny;
    if (total === 0) {
        state.cellColors = null;
        state.cellLabelColors = null;
        return;
    }
    if (!state.cellColors || state.cellColors.length < total) state.cellColors = new Array(total);

    const autoLabels = !!(opts.showValues && opts.valueLabelColor === 'auto');
    if (autoLabels) {
        if (!state.cellLabelColors || state.cellLabelColors.length < total) {
            state.cellLabelColors = new Array(total);
        }
    } else {
        state.cellLabelColors = null;
    }

    const vMin = state.vMin;
    const vMax = state.vMax;
    const span = vMax - vMin;
    const colorFn = opts.colorFn;

    // Custom colorFn path: the function is opaque to us, so for the auto-
    // label-color case we have to parse its return string. Anything we
    // can't parse (named colors, oklch(), rgba()) falls back to #ffffff.
    if (colorFn) {
        for (let i = 0; i < total; i++) {
            if (!state.presentMask[i]) {
                state.cellColors[i] = null;
                if (autoLabels) state.cellLabelColors[i] = null;
                continue;
            }
            const css = colorFn(state.cells[i], vMin, vMax);
            state.cellColors[i] = css;
            if (autoLabels) {
                const rgb = _parseRGBLike(css);
                state.cellLabelColors[i] = rgb ? _pickContrastColor(rgb) : '#ffffff';
            }
        }
        return;
    }

    const lo = _parseHexColor(opts.colorLow)  || [219, 234, 254];  // blue-100
    const hi = _parseHexColor(opts.colorHigh) || [30, 58, 138];    // blue-900

    // ---- Quantile path -------------------------------------------------
    // Sort present values; pick N-1 internal bin boundaries; map each cell
    // to its bin's pre-computed color. Bin colors are evenly spaced along
    // the same lo->hi ramp so the quantile path looks like a discretized
    // version of the linear path. Outliers cluster at the high bin without
    // washing out the rest of the chart.
    if (opts.colorScale === 'quantile' && total > 0) {
        const binCount = Math.max(2, Math.min(20, opts.colorBins | 0 || 5));

        // v1.4.0-alpha.1 (audit fix): was `const present = []; ... .push(); ... .sort(cmp)`
        // which on a 200x200 dense heatmap allocates a 40k-element JS
        // Array on every data update, then throws it away after finding
        // the boundaries. Pool a Float32Array on state, pack present
        // values into a prefix, sort a subarray view in place. The pool
        // grows monotonically with chart size; steady state is zero-alloc.
        // `Float32Array.prototype.sort()` without args sorts numerically
        // (no string-coercion trap, no comparator allocation).
        if (!state.presentSorted || state.presentSorted.length < total) {
            state.presentSorted = new Float32Array(total);
        }
        const presentSorted = state.presentSorted;
        let nPresent = 0;
        for (let i = 0; i < total; i++) {
            if (state.presentMask[i]) presentSorted[nPresent++] = state.cells[i];
        }
        const presentView = presentSorted.subarray(0, nPresent);
        presentView.sort();
        const present = presentView;

        // Pre-compute the bin colors (and RGB triples for auto-label).
        const binColors = new Array(binCount);
        const binRGB = autoLabels ? new Array(binCount) : null;
        const binLabelColors = autoLabels ? new Array(binCount) : null;
        for (let b = 0; b < binCount; b++) {
            const t = binCount === 1 ? 0 : b / (binCount - 1);
            const r = (lo[0] + t * (hi[0] - lo[0])) | 0;
            const g = (lo[1] + t * (hi[1] - lo[1])) | 0;
            const bl = (lo[2] + t * (hi[2] - lo[2])) | 0;
            binColors[b] = 'rgb(' + r + ',' + g + ',' + bl + ')';
            if (autoLabels) {
                binRGB[b] = [r, g, bl];
                binLabelColors[b] = _pickContrastColor(binRGB[b]);
            }
        }

        // Internal boundary values: bin b ends just above present[idx]
        // where idx = floor((b+1) * nPresent / binCount). N-1 boundaries.
        const boundaries = new Float64Array(binCount - 1);
        for (let b = 0; b < binCount - 1; b++) {
            const idx = Math.min(nPresent - 1, Math.floor(((b + 1) * nPresent) / binCount));
            boundaries[b] = nPresent === 0 ? 0 : present[idx];
        }

        for (let i = 0; i < total; i++) {
            if (!state.presentMask[i]) {
                state.cellColors[i] = null;
                if (autoLabels) state.cellLabelColors[i] = null;
                continue;
            }
            const v = state.cells[i];
            // Linear scan through boundaries -- N-1 comparisons, typically
            // 4-19. Faster than a binary search at this size and avoids
            // the per-cell allocation a bsearch helper would imply.
            let b = 0;
            while (b < binCount - 1 && v > boundaries[b]) b++;
            state.cellColors[i] = binColors[b];
            if (autoLabels) state.cellLabelColors[i] = binLabelColors[b];
        }
        return;
    }

    // ---- Linear path (default) -----------------------------------------
    for (let i = 0; i < total; i++) {
        if (!state.presentMask[i]) {
            state.cellColors[i] = null;
            if (autoLabels) state.cellLabelColors[i] = null;
            continue;
        }
        const t = span > 0 ? (state.cells[i] - vMin) / span : 0;
        const r = (lo[0] + t * (hi[0] - lo[0])) | 0;
        const g = (lo[1] + t * (hi[1] - lo[1])) | 0;
        const bl = (lo[2] + t * (hi[2] - lo[2])) | 0;
        state.cellColors[i] = 'rgb(' + r + ',' + g + ',' + bl + ')';
        if (autoLabels) state.cellLabelColors[i] = _pickContrastColor([r, g, bl]);
    }
};

const _makeGridDrawFn = (state, xBand, yBand, opts) => (ctx) => {
    const nx = state.nx;
    const ny = state.ny;
    if (nx === 0 || ny === 0 || !state.cells || !state.cellColors) return;

    const cellW = xBand.bandWidth;
    const cellH = yBand.bandWidth;
    const present = state.presentMask;
    const colors = state.cellColors;

    // Cells.
    for (let yi = 0; yi < ny; yi++) {
        const cy = yBand.leftEdge(yi);
        for (let xi = 0; xi < nx; xi++) {
            const idx = yi * nx + xi;
            if (!present[idx]) continue;
            ctx.fillStyle = colors[idx];
            ctx.fillRect(xBand.leftEdge(xi), cy, cellW, cellH);
        }
    }

    // Optional value labels. Drawn after all cells so labels sit on top.
    if (opts.showValues) {
        const cells = state.cells;
        const cellLabelColors = state.cellLabelColors;  // present iff auto-contrast
        const fmt = opts.valueFormat || ((v) => v.toFixed(1));
        ctx.font = opts.valueLabelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (!cellLabelColors) ctx.fillStyle = opts.valueLabelColor;
        for (let yi = 0; yi < ny; yi++) {
            const cy = yBand.map(yi);
            for (let xi = 0; xi < nx; xi++) {
                const idx = yi * nx + xi;
                if (!present[idx]) continue;
                if (cellLabelColors) ctx.fillStyle = cellLabelColors[idx];
                ctx.fillText(fmt(cells[idx], xi, yi), xBand.map(xi), cy);
            }
        }
    }
};

const _gridHitTest = (canvasX, canvasY, xBand, yBand, state, pb) => {
    if (state.nx === 0 || state.ny === 0) return null;
    if (canvasX < pb.x || canvasX > pb.x + pb.w) return null;
    if (canvasY < pb.y || canvasY > pb.y + pb.h) return null;
    const xi = xBand.invert(canvasX);
    const yi = yBand.invert(canvasY);
    if (xi < 0 || yi < 0 || xi >= state.nx || yi >= state.ny) return null;
    const idx = yi * state.nx + xi;
    if (!state.presentMask[idx]) return null;
    return { xi, yi, value: state.cells[idx] };
};

// ---- HEATMAP_RENDERER ----------------------------------------------------

const _initHeatmapOpts = (config) => {
    const xKey = config.x != null ? config.x : 'x';
    const yKey = config.y != null ? config.y : 'y';
    const valueKey = config.value != null ? config.value : 'value';
    const colors = Array.isArray(config.colors) ? config.colors : null;
    return {
        xAccessor: buildRawAccessor(xKey),
        yAccessor: buildRawAccessor(yKey),
        valueAccessor: buildAccessor(valueKey),
        // Default ramp: pale-to-dark blue. Override via `colors: ['#low', '#high']`.
        colorLow: colors && colors[0] ? colors[0] : '#dbeafe',
        colorHigh: colors && colors[1] ? colors[1] : '#1e3a8a',
        // v1.2.0: 'linear' (default) interpolates the ramp continuously;
        // 'quantile' bins values by rank into `colorBins` discrete colors,
        // which keeps a few outliers from washing out the rest of the chart.
        colorScale: config.colorScale === 'quantile' ? 'quantile' : 'linear',
        colorBins: config.colorBins != null ? Math.max(2, Math.min(20, config.colorBins | 0)) : 5,
        // colorFn(v, vMin, vMax) -> 'css color'. Overrides BOTH the linear-
        // and quantile-interp defaults entirely; use this for OKLCH ramps,
        // custom binning, diverging schemes, etc.
        colorFn: typeof config.colorFn === 'function' ? config.colorFn : null,
        showValues: config.showValues === true,
        valueFormat: typeof config.valueFormat === 'function' ? config.valueFormat : null,
        valueLabelFont: config.valueLabelFont != null ? config.valueLabelFont : '11px sans-serif',
        // v1.2.0: 'auto' (default when showValues is on) picks #000 or #fff
        // per cell from its background luminance so labels stay readable
        // across the ramp. Explicit colors (hex / CSS-var / 'rgb(...)' /
        // named color) override the auto pick chart-wide.
        valueLabelColor: config.valueLabelColor != null ? config.valueLabelColor : 'auto',
        cellGap: config.cellGap != null ? Math.max(0, Math.min(0.5, +config.cellGap)) : 0.04,
        highlightStroke: config.highlightStroke != null ? config.highlightStroke : '#111111',
        highlightStrokeWidth: config.highlightStrokeWidth != null ? +config.highlightStrokeWidth : 2,
        // v1.2.0: per-row + per-column highlight on hover. Two translucent
        // stripes (row across the plot width, column across the plot
        // height) drawn under the cell stroke. Either can be disabled.
        rowHighlight: config.rowHighlight === false ? false : true,
        columnHighlight: config.columnHighlight === false ? false : true,
        rowColumnHighlightFill: config.rowColumnHighlightFill != null
            ? config.rowColumnHighlightFill
            : 'rgba(0,0,0,0.10)',
        tooltipFormat: typeof config.tooltipFormat === 'function' ? config.tooltipFormat : null,
        labelColor: config.labelColor != null ? config.labelColor : '#444444',
        labelFont: config.labelFont != null ? config.labelFont : '12px sans-serif',
    };
};

const HEATMAP_RENDERER = {
    initOpts: _initHeatmapOpts,
    extractData: _extractGridData,
    computeColors: _computeGridColors,
    makeDrawFn: _makeGridDrawFn,
    hitTest: _gridHitTest,
};

// ---- createBaseGridChart ------------------------------------------------

const createBaseGridChart = (config, renderer) => {
    if (!config || typeof config !== 'object') {
        throw new Error('lite-charts: createHeatmap requires a config object');
    }

    // -- Reactive data source --
    let dataSource;
    if (typeof config.data === 'function') {
        dataSource = config.data;
    } else if (Array.isArray(config.data)) {
        const arr = config.data;
        dataSource = () => arr;
    } else {
        throw new Error('lite-charts: createHeatmap requires `data` array or accessor function');
    }

    // -- Dimensions: explicit or auto-observed at mount --
    const widthExplicit = config.width != null;
    const heightExplicit = config.height != null;
    // v1.2.0: track signals lite-charts creates so `chart.destroy()` can
    // dispose them. See axis kernel for the rationale.
    const _ownedSignals = [];
    const _own = (s) => { _ownedSignals.push(s); return s; };
    const widthAutoSig = widthExplicit ? null : _own(signal(600));
    const heightAutoSig = heightExplicit ? null : _own(signal(400));
    const widthSig = widthExplicit ? asAccessor(config.width) : widthAutoSig;
    const heightSig = heightExplicit ? asAccessor(config.height) : heightAutoSig;

    // -- Margins --
    const m = config.margin || _DEFAULT_GRID_MARGIN;
    const marginTop    = m.top    != null ? m.top    : _DEFAULT_GRID_MARGIN.top;
    const marginRight  = m.right  != null ? m.right  : _DEFAULT_GRID_MARGIN.right;
    const marginBottom = m.bottom != null ? m.bottom : _DEFAULT_GRID_MARGIN.bottom;
    const marginLeft   = m.left   != null ? m.left   : _DEFAULT_GRID_MARGIN.left;

    // -- State + scales + opts --
    const state = _makeGridState();
    const opts = renderer.initOpts(config);
    const xBand = makeBandScale();
    const yBand = makeBandScale();
    const plotBoundsBox = { x: 0, y: 0, w: 0, h: 0 };
    const plotBoundsSignal = _own(signal(0));

    // -- Crosshair / hover state --
    const hoverData = { visible: false, xi: -1, yi: -1, value: 0, mouseX: 0, mouseY: 0 };
    const hoverVersion = _own(signal(0));

    // -- Mount-time resources --
    let canvas = null;
    let container = null;
    let ownedCanvas = false;
    let scene = null;
    const disposers = [];
    let mounted = false;

    // -- Chart object (built before mount; some fields populated then) --
    const chart = {
        mount: null,         // assigned below
        unmount: null,
        redraw: () => { if (scene) scene.markDirty(); },
        // Read-only state introspection for tests / debug. _internal NOT
        // public API; do not depend on shape across minor versions.
        _internal: { state, xBand, yBand, plotBoundsBox },
        get xCategories() { return state.xCategories.slice(); },
        get yCategories() { return state.yCategories.slice(); },
        get vMin() { return state.vMin; },
        get vMax() { return state.vMax; },
        // moveCrosshair / hover info, useful from tests + custom interactivity.
        moveHover(canvasX, canvasY) {
            const hit = renderer.hitTest(canvasX, canvasY, xBand, yBand, state, plotBoundsBox);
            if (!hit) {
                if (!hoverData.visible) return;
                hoverData.visible = false;
                hoverData.xi = -1;
                hoverData.yi = -1;
                hoverVersion.update((v) => (v + 1) | 0);
                return;
            }
            if (hoverData.visible
                && hoverData.xi === hit.xi
                && hoverData.yi === hit.yi
                && hoverData.mouseX === canvasX
                && hoverData.mouseY === canvasY) return;
            hoverData.visible = true;
            hoverData.xi = hit.xi;
            hoverData.yi = hit.yi;
            hoverData.value = hit.value;
            hoverData.mouseX = canvasX;
            hoverData.mouseY = canvasY;
            hoverVersion.update((v) => (v + 1) | 0);
        },
        hideHover() {
            if (!hoverData.visible) return;
            hoverData.visible = false;
            hoverData.xi = -1;
            hoverData.yi = -1;
            hoverVersion.update((v) => (v + 1) | 0);
        },
        hover: Object.assign(() => { hoverVersion(); return hoverData; }, {
            peek: () => hoverData,
        }),
    };

    const mount = (target) => {
        if (mounted) throw new Error('lite-charts: chart already mounted');
        if (!target) throw new Error('lite-charts: mount() requires an HTMLElement or HTMLCanvasElement');

        if (target.tagName === 'CANVAS') {
            canvas = target;
            container = target.parentElement || target;
            ownedCanvas = false;
        } else if (typeof target.appendChild === 'function') {
            if (typeof document === 'undefined') {
                throw new Error('lite-charts: mount() needs a real document to create a canvas');
            }
            canvas = document.createElement('canvas');
            target.appendChild(canvas);
            container = target;
            ownedCanvas = true;
        } else if (typeof target.getContext === 'function') {
            canvas = target;
            container = null;
            ownedCanvas = false;
        } else {
            throw new Error('lite-charts: mount() target must be an HTMLElement or HTMLCanvasElement');
        }

        // Auto-resize wire-up before the initial size effect runs.
        if (widthAutoSig || heightAutoSig) {
            _wireAutoSize(container, widthAutoSig, heightAutoSig, disposers);
        }

        // Resolve theme-affected colors (CSS-vars -> concrete strings).
        opts.colorLow              = resolveColor(opts.colorLow, container);
        opts.colorHigh             = resolveColor(opts.colorHigh, container);
        opts.labelColor            = resolveColor(opts.labelColor, container);
        opts.highlightStroke       = resolveColor(opts.highlightStroke, container);
        opts.rowColumnHighlightFill= resolveColor(opts.rowColumnHighlightFill, container);
        opts.valueLabelColor       = resolveColor(opts.valueLabelColor, container);

        const schedule = config.schedule || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => cb());
        scene = createScene(canvas, {
            background: config.background != null ? config.background : null,
            autoResize: false,
            dpr: config.dpr != null ? config.dpr : (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1),
            schedule,
        });
        const resolvedDpr = config.dpr != null ? config.dpr : (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);

        // Effect 1: dimensions -> backing buffer + plot bounds + band scales.
        disposers.push(effect(() => {
            const w = +widthSig() | 0 || 600;
            const h = +heightSig() | 0 || 400;
            const wBacking = Math.max(1, Math.round(w * resolvedDpr));
            const hBacking = Math.max(1, Math.round(h * resolvedDpr));
            if (canvas.width  !== wBacking) canvas.width  = wBacking;
            if (canvas.height !== hBacking) canvas.height = hBacking;
            if (typeof canvas.style !== 'undefined') {
                canvas.style.width  = w + 'px';
                canvas.style.height = h + 'px';
            }
            plotBoundsBox.x = marginLeft;
            plotBoundsBox.y = marginTop;
            plotBoundsBox.w = Math.max(0, w - marginLeft - marginRight);
            plotBoundsBox.h = Math.max(0, h - marginTop - marginBottom);
            // Band scales re-stamped after data extract knows nx/ny.
            updateBandScale(xBand, state.nx, plotBoundsBox.x, plotBoundsBox.x + plotBoundsBox.w, opts.cellGap, opts.cellGap / 2);
            updateBandScale(yBand, state.ny, plotBoundsBox.y, plotBoundsBox.y + plotBoundsBox.h, opts.cellGap, opts.cellGap / 2);
            plotBoundsSignal.update((v) => (v + 1) | 0);
            if (scene) scene.markDirty();
        }));

        // Effect 2: data -> extract + color compute + band-scale category count.
        disposers.push(effect(() => {
            const data = dataSource();
            renderer.extractData(state, data, opts);
            renderer.computeColors(state, opts);
            updateBandScale(xBand, state.nx, plotBoundsBox.x, plotBoundsBox.x + plotBoundsBox.w, opts.cellGap, opts.cellGap / 2);
            updateBandScale(yBand, state.ny, plotBoundsBox.y, plotBoundsBox.y + plotBoundsBox.h, opts.cellGap, opts.cellGap / 2);
            if (scene) scene.markDirty();
        }));

        // Effect 3: hover -> redraw (cell highlight + tooltip).
        disposers.push(effect(() => {
            hoverVersion();
            if (scene) scene.markDirty();
        }));

        // --- Scene nodes (drawn in this order) ---
        const cellsDrawFn = renderer.makeDrawFn(state, xBand, yBand, opts);
        scene.root.add(pathNode({ draw: (ctx) => cellsDrawFn(ctx) }));

        // Axis labels (x below, y to the left). Inline -- no lite-axis dep
        // since heatmap categories are arbitrary strings, not numeric ticks.
        scene.root.add(pathNode({ draw: (ctx) => {
            const nx = state.nx;
            const ny = state.ny;
            if (nx === 0 && ny === 0) return;
            ctx.fillStyle = opts.labelColor;
            ctx.font = opts.labelFont;

            // X labels (bottom).
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const xLabelsY = plotBoundsBox.y + plotBoundsBox.h + 8;
            for (let xi = 0; xi < nx; xi++) {
                ctx.fillText(state.xCategories[xi], xBand.map(xi), xLabelsY);
            }

            // Y labels (left).
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            const yLabelsX = plotBoundsBox.x - 8;
            for (let yi = 0; yi < ny; yi++) {
                ctx.fillText(state.yCategories[yi], yLabelsX, yBand.map(yi));
            }
        }}));

        // Hover highlight + tooltip.
        scene.root.add(pathNode({ draw: (ctx) => {
            if (!hoverData.visible) return;
            const { xi, yi, value, mouseX, mouseY } = hoverData;

            // v1.2.0: per-row + per-column highlight stripes. Each is a
            // translucent rect spanning the plot in one axis and the
            // hovered cell's band in the other. Drawn BEFORE the cell
            // stroke so the stroke sits on top.
            if (opts.rowHighlight) {
                ctx.fillStyle = opts.rowColumnHighlightFill;
                ctx.fillRect(
                    plotBoundsBox.x,
                    yBand.leftEdge(yi),
                    plotBoundsBox.w,
                    yBand.bandWidth,
                );
            }
            if (opts.columnHighlight) {
                ctx.fillStyle = opts.rowColumnHighlightFill;
                ctx.fillRect(
                    xBand.leftEdge(xi),
                    plotBoundsBox.y,
                    xBand.bandWidth,
                    plotBoundsBox.h,
                );
            }

            // Stroke the hovered cell on top of the stripes.
            ctx.strokeStyle = opts.highlightStroke;
            ctx.lineWidth = opts.highlightStrokeWidth;
            ctx.strokeRect(
                xBand.leftEdge(xi),
                yBand.leftEdge(yi),
                xBand.bandWidth,
                yBand.bandWidth,
            );

            // Tooltip: simple label "xLabel x yLabel: value" near the cursor.
            const fmt = opts.tooltipFormat;
            const text = fmt
                ? fmt({ xi, yi, value, xLabel: state.xCategories[xi], yLabel: state.yCategories[yi] })
                : (state.xCategories[xi] + ' \u00d7 ' + state.yCategories[yi] + ': ' + (Math.round(value * 100) / 100));
            ctx.font = opts.labelFont;
            const metrics = ctx.measureText(text);
            const tw = (metrics && metrics.width) || (text.length * 7);
            const th = 18;
            const pad = 6;
            // Anchor above-right of the cursor; clamp inside plot rect.
            let tx = mouseX + 12;
            let ty = mouseY - th - 6;
            if (tx + tw + pad * 2 > plotBoundsBox.x + plotBoundsBox.w) {
                tx = mouseX - tw - pad * 2 - 12;
            }
            if (ty < plotBoundsBox.y) ty = mouseY + 12;
            ctx.fillStyle = 'rgba(20, 20, 20, 0.92)';
            ctx.fillRect(tx, ty, tw + pad * 2, th);
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, tx + pad, ty + th / 2);
        }}));

        // Mouse listeners (if mounted to a real canvas).
        if (canvas && typeof canvas.addEventListener === 'function') {
            const onMove = (ev) => {
                const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
                const cx = ev.clientX - rect.left;
                const cy = ev.clientY - rect.top;
                chart.moveHover(cx, cy);
            };
            const onLeave = () => chart.hideHover();
            canvas.addEventListener('mousemove', onMove);
            canvas.addEventListener('mouseleave', onLeave);
            disposers.push(() => canvas.removeEventListener('mousemove', onMove));
            disposers.push(() => canvas.removeEventListener('mouseleave', onLeave));
        }

        mounted = true;
        return chart;
    };

    const unmount = () => {
        if (!mounted) return;
        for (let i = 0; i < disposers.length; i++) {
            try { disposers[i](); } catch (_) { /* swallow */ }
        }
        disposers.length = 0;
        if (scene) {
            try { scene.dispose(); } catch (_) { /* swallow */ }
            scene = null;
        }
        if (ownedCanvas && container && canvas && canvas.parentNode === container) {
            container.removeChild(canvas);
        }
        canvas = null;
        container = null;
        ownedCanvas = false;
        mounted = false;
    };

    // v1.2.0: terminal teardown -- see axis kernel for rationale.
    let destroyed = false;
    const destroy = () => {
        if (destroyed) return;
        if (mounted) unmount();
        for (let i = 0; i < _ownedSignals.length; i++) {
            try { dispose(_ownedSignals[i]); } catch (_) { /* swallow */ }
        }
        _ownedSignals.length = 0;
        destroyed = true;
    };

    // v1.3.0: SVG export -- see axis kernel for rationale.
    const exportSVG = (opts) => {
        if (!mounted || !scene) {
            throw new Error('lite-charts: exportSVG() requires mount() first');
        }
        const w = +widthSig() | 0 || 600;
        const h = +heightSig() | 0 || 400;
        const bg = (opts && opts.background !== undefined)
            ? opts.background
            : (config.background != null ? config.background : null);
        return _exportSceneToSVG(scene, w, h, bg);
    };

    chart.mount = mount;
    chart.unmount = unmount;
    chart.destroy = destroy;
    chart.exportSVG = exportSVG;
    return chart;
};

// v1.2.0-alpha.3: heatmap rides the grid kernel. Currently the only consumer;
// future grid charts (correlation matrix, calendar heatmap, dot matrix) would
// fit the same kernel by supplying a different RENDERER.
export const createHeatmap = (config) => createBaseGridChart(config, HEATMAP_RENDERER);
