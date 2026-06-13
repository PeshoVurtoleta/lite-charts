/**
 * @zakkster/lite-charts -- Reactive, zero-GC charts built on lite-scene.
 *
 * v1.0.0-alpha.0 ships createLineChart only. Bar/area/scatter/pie follow
 * in subsequent releases on the same substrate.
 *
 * Author:  Zahary Shinikchiev
 * License: MIT
 */

import {
    signal,
    computed,
    effect,
    untrack,
    onCleanup,
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
 * Inlines the linear-scale math for ~3x throughput vs calling .map().
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
    for (let i = 0; i < n; i++) {
        pxs[i] = xs[i] * xSlope + xIntercept;
        pys[i] = ys[i] * ySlope + yIntercept;
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
// Bar x-axis (v1.1.0): categorical labels at band centers
// ---------------------------------------------------------------------------
//
// Unlike buildAxis which numerically generates ticks via lite-axis, the bar
// x-axis has one label per category. For dense categories (>20), every Nth
// is labeled to keep the axis readable.

const buildBarAxis = (parent, opts) => {
    // opts: {
    //   xBandScale, plotBoundsBox, plotBoundsSignal, scaleVersion,
    //   tickColor (ref), labelColor (ref), font, categoriesRef
    // }
    const axisGroup = parent.add(group({}));
    const spineNode = axisGroup.add(lineNode({
        stroke: opts.tickColor,
        strokeWidth: 1,
    }));
    const tickPool = [];   // small vertical tick lines under spine
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
                anchor: 'center',
                baseline: 'top',
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

        const yLine = pb.y + pb.h;
        spineNode.set({
            visible: true,
            x: pb.x,
            y: yLine,
            dx: pb.w,
            dy: 0,
        });

        ensurePools(n);

        // Adaptive label step: target ~6 labels per 480px of plot width.
        const maxLabels = Math.max(2, (pb.w / 80) | 0);
        const labelStep = n <= maxLabels ? 1 : Math.ceil(n / maxLabels);

        for (let i = 0; i < n; i++) {
            const cx = bs.map(i);
            tickPool[i].set({
                visible: true,
                x: cx,
                y: yLine,
                dx: 0,
                dy: 4,
            });
            if (i % labelStep === 0) {
                labelPool[i].set({
                    visible: true,
                    x: cx,
                    y: yLine + 6,
                    text: cats[i],
                });
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
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(buf[i]);
    return s;
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
        } else {
            count = linearTicks(s.dMin, s.dMax, target, tickBuf);
        }
        if (count > TICK_BUF_SIZE) count = TICK_BUF_SIZE;

        const slope = s._slope;
        const intercept = s._intercept;
        for (let i = 0; i < count; i++) {
            pixelBuf[i] = tickBuf[i] * slope + intercept;
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
    //   color (accessor), xFormat ('time'|'number'), enableX (bool), enableY (bool)
    // }
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
            } else {
                xCount = linearTicks(xS.dMin, xS.dMax, xTarget, xTickBuf);
            }
            if (xCount > TICK_BUF_SIZE) xCount = TICK_BUF_SIZE;
            const xSlope = xS._slope;
            const xIntercept = xS._intercept;
            for (let i = 0; i < xCount; i++) {
                xPixelBuf[i] = xTickBuf[i] * xSlope + xIntercept;
            }
        }

        let yCount = 0;
        if (opts.enableY) {
            const yTarget = Math.max(2, Math.min(12, (pb.h / 40) | 0));
            yCount = linearTicks(yS.dMin, yS.dMax, yTarget, yTickBuf);
            if (yCount > TICK_BUF_SIZE) yCount = TICK_BUF_SIZE;
            const ySlope = yS._slope;
            const yIntercept = yS._intercept;
            for (let i = 0; i < yCount; i++) {
                yPixelBuf[i] = yTickBuf[i] * ySlope + yIntercept;
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
        for (let i = 0; i < yCount; i++) {
            linePool[xCount + i].set({
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
// theming, and -- in v1.2 -- lite-virtual scrolling for series counts in
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
    return {
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

const _buildAxisBar = (parent, opts, ctx) =>
    buildBarAxis(parent, {
        xBandScale: opts.scale,
        plotBoundsBox: opts.plotBoundsBox,
        plotBoundsSignal: opts.plotBoundsSignal,
        scaleVersion: opts.scaleVersion,
        tickColor: opts.tickColor,
        labelColor: opts.labelColor,
        font: opts.font,
        categoriesRef: ctx.categoriesRef,
    });

const _makeBarDraw = (state, refs, plotBoundsBox, seriesIdx, totalSeries, ctx) =>
    makeBarDrawFn(state, refs, plotBoundsBox,
                  ctx.xScale, ctx.yScale,
                  seriesIdx, totalSeries,
                  ctx.opts.baseline, ctx.opts.groupInnerPad,
                  ctx.opts.cornerRadius, ctx.opts.hoverTintRef,
                  ctx.crosshairDataRef);

const _bandHitTest = (canvasX, /*canvasY*/_cy, primary, xScale, ctx) => {
    if (ctx.categoriesRef.value.length === 0) return null;
    const idx = xScale.invert(canvasX);
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
    buildXAxis: _buildAxisBar,
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
// index can implement -- @zakkster/lite-delaunay, a k-d tree, a uniform
// grid, etc. The interface stays in lite-charts (so the renderers depend on
// nothing extra); the implementation is wired by the consumer via config.
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
    const hitTolerance = config.hitTolerance != null
        ? +config.hitTolerance
        : markerSize + 4;
    return {
        markerSize,
        hitToleranceSq: hitTolerance * hitTolerance,
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

const _scatterHitTest = (canvasX, canvasY, primary, /*xScale*/_xs, ctx) => {
    const n = primary.n;
    if (n === 0) return null;
    if (primary.pxs === null || primary.pys === null) return null;
    const xs = primary.pxs;
    const ys = primary.pys;
    const opts = ctx.opts;
    const toleranceSq = opts.hitToleranceSq;

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
    // guards against indices that hold external resources.
    for (let i = 0; i < states.length; i++) {
        _disposeSpatialIndex(states[i]);
    }
};

const SCATTER_RENDERER = {
    buildXAccessor: buildAccessor,
    forceXType: null,
    createXScale: makeLinearScale,
    initOpts: _initScatterOpts,
    extractData: _extractScatterData,
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

    // -- Dimensions (static, signal, or auto-observed from container) --
    // If width/height are omitted from config, the kernel creates internal
    // signals and wires them to a ResizeObserver on the container at mount
    // time. Explicit values (number or signal/fn) bypass auto-observation.
    const widthExplicit = config.width != null;
    const heightExplicit = config.height != null;
    const widthAutoSig = widthExplicit ? null : signal(800);
    const heightAutoSig = heightExplicit ? null : signal(400);
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
    const xScale = renderer.createXScale(resolvedXType);
    const yScale = makeLinearScale('linear');

    // Bar-chart shared state: the union of category names across all visible
    // series, in first-seen order. Mutated in place by extractBarSeriesData
    // during data extraction; bar axis + bandScale read .value. Always
    // allocated (cheap) -- non-bar renderers simply never reference it.
    const categoriesRef = { value: [] };

    // Chart-type-specific options bag. `null` for line; structured config
    // for area / bar / future renderers.
    const chartOpts = renderer.initOpts ? renderer.initOpts(config) : null;

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
    };
    // seriesStates is declared above rendererCtx in source order; assign it
    // here now that rendererCtx exists.
    rendererCtx.seriesStates = seriesStates;

    const scaleVersion = signal(0);

    // -- Plot bounds: a single mutable box + a signal that publishes "the box changed" --
    const plotBoundsBox = { x: 0, y: 0, w: 0, h: 0 };
    const plotBoundsSignal = signal(0);

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
    const seriesVisibility = normalized.map(() => signal(true));
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

    // -- Legend config --
    // `legend: false` disables. `legend: 'top'|'bottom'|'left'|'right'` is
    // a shorthand for `{position}`. `legend: {position?, container?}` is the
    // full form. Default: bottom.
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
        mousePixelY: 0,
        // v1.2.0-alpha.2: which series the hit belongs to. -1 means
        // "not series-scoped" (line / area / bar / scatter never set this).
        // Multi-series bubble's hit-test sets it so lookupRow can scope the
        // tooltip to just the hit series.
        snapSeriesIdx: -1,
    };
    rendererCtx.crosshairDataRef = crosshairData;
    const crosshairVersion = signal(0);
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
    const disposers = [];
    let mounted = false;

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
        disposers.push(effect(() => {
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

            renderer.updateXScale(
                xScale,
                dxMin, dxMax,
                plotBoundsBox.x, plotBoundsBox.x + plotBoundsBox.w,
                rendererCtx,
            );
            updateLinearScale(yScale, yBase[0], yBase[1], plotBoundsBox.y + plotBoundsBox.h, plotBoundsBox.y);

            // Renderers that use pre-projected pixel arrays in their draw fn
            // (line / area) request projection; renderers that compute pixels
            // on the fly (bar) opt out.
            if (renderer.projectToPixels) {
                for (let i = 0; i < seriesStates.length; i++) {
                    if (seriesStates[i].n > 0) scaleSeriesToPixels(seriesStates[i], xScale, yScale);
                }
            }
            scaleVersion.update((v) => (v + 1) | 0);
            if (scene) scene.markDirty();
        }));

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
        const yAxis = buildAxis(scene.root, {
            orientation: 'y',
            scale: yScale,
            plotBoundsBox,
            plotBoundsSignal,
            scaleVersion,
            tickColor: () => axisStyleRefs.tickColor.value,
            labelColor: () => axisStyleRefs.labelColor.value,
            font: () => axisStyleRefs.font.value,
            format: 'number',
        });
        disposers.push(xAxis.dispose);
        disposers.push(yAxis.dispose);

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

        // -- Legend (DOM) --
        // Built only when (a) the chart owns its canvas (mounted into an
        // element, not a bare canvas), (b) `document` is available, and
        // (c) `legend !== false`. Tests that mount mock canvases skip this
        // path; they verify visibility via chart.setSeriesVisible() directly.
        if (legendEnabled) {
            const fontResolved = config.font != null ? config.font : DEFAULT_FONT;
            const labelColorResolved = resolveColor(config.labelColor || DEFAULT_LABEL_COLOR, container);
            legendEl = buildLegendDOM(
                { position: legendPosition, container: legendContainer },
                normalized,
                seriesVisibility,
                seriesRefs,
                fontResolved,
                labelColorResolved,
                disposers,
            );
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
        canvas = null;
        container = null;
        mounted = false;
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
        if (crosshairData.visible
            && crosshairData.snapIdx === hit.snapIdx
            && crosshairData.snapSeriesIdx === hitSeriesIdx
            && crosshairData.mousePixelY === canvasY) return;
        crosshairData.visible = true;
        crosshairData.snapIdx = hit.snapIdx;
        crosshairData.snapDomainX = hit.snapDomainX;
        crosshairData.snapPixelX = hit.snapPixelX;
        crosshairData.snapSeriesIdx = hitSeriesIdx;
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

        // --- Vertical crosshair line ---
        if (crosshairOpts) {
            ctx.strokeStyle = crosshairColorRef.value;
            ctx.lineWidth = 1;
            ctx.setLineDash(crosshairDash);
            ctx.beginPath();
            ctx.moveTo(x, pb.y);
            ctx.lineTo(x, pb.y + pb.h);
            ctx.stroke();
            ctx.setLineDash(_EMPTY_DASH);
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
        // the plot rect.
        let boxX = state.snapPixelX + gap;
        if (boxX + boxW > pb.x + pb.w) boxX = state.snapPixelX - gap - boxW;
        if (boxX < pb.x) boxX = pb.x;
        let boxY = state.mousePixelY - boxH / 2;
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
        // Update legend swatches too -- they were styled from colorRef at build time.
        if (legendEl) {
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
        exportPNG,
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

    // Dimensions: explicit (number or signal) or auto-observed at mount.
    const widthExplicit = config.width != null;
    const heightExplicit = config.height != null;
    const widthAutoSig = widthExplicit ? null : signal(400);
    const heightAutoSig = heightExplicit ? null : signal(400);
    const widthSig = widthExplicit ? asAccessor(config.width) : widthAutoSig;
    const heightSig = heightExplicit ? asAccessor(config.height) : heightAutoSig;

    const margin = config.margin || DEFAULT_PIE_MARGIN;
    const marginTop    = margin.top    != null ? margin.top    : DEFAULT_PIE_MARGIN.top;
    const marginRight  = margin.right  != null ? margin.right  : DEFAULT_PIE_MARGIN.right;
    const marginBottom = margin.bottom != null ? margin.bottom : DEFAULT_PIE_MARGIN.bottom;
    const marginLeft   = margin.left   != null ? margin.left   : DEFAULT_PIE_MARGIN.left;

    const innerRadiusConfig = config.innerRadius != null ? config.innerRadius : 0;

    // ---- Chart state --------------------------------------------------
    const state = makePolarState();
    const geometry = { cx: 0, cy: 0, rOuter: 0, rInner: 0 };
    const plotBoundsBox = { x: 0, y: 0, w: 0, h: 0 };
    const plotBoundsSignal = signal(0);
    const dataVersion = signal(0);            // bumps on data / visibility change

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
            sliceVisibility.push(signal(true));
        }
    };

    // ---- Style refs (theme-reactive) ----------------------------------
    const sliceStrokeRef      = { value: '#ffffff' };
    const sliceStrokeWidthRef = { value: config.sliceStrokeWidth != null ? +config.sliceStrokeWidth : 1 };
    const labelColorRef       = { value: '#444444' };
    const fontRef             = { value: config.font != null ? config.font : '11px sans-serif' };
    const tooltipBgRef        = { value: 'rgba(255,255,255,0.96)' };
    const tooltipBorderRef    = { value: '#cccccc' };
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
    const crosshairVersion = signal(0);
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
        exportPNG: (opts) => {
            if (!mounted || !canvas) throw new Error('lite-charts: exportPNG() requires mount() first');
            if (typeof canvas.toDataURL !== 'function') {
                throw new Error('lite-charts: exportPNG() requires a real HTMLCanvasElement');
            }
            const mt = opts && opts.mimeType || 'image/png';
            const q = opts && opts.quality != null ? opts.quality : 0.92;
            return canvas.toDataURL(mt, q);
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
            if (scene) scene.markDirty();
        },
        get scene() { return scene; },
        get canvas() { return canvas; },
        get geometry() { return geometry; },
        get legend() { return legendEl; },
        plotBounds: plotBoundsSignal,
        crosshair: crosshairFacade,
        sliceVisibility,
        _internal: {
            state,
            geometry,
            plotBoundsBox,
            sliceVisibility,
            dataVersion,
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
    const widthAutoSig = widthExplicit ? null : signal(400);
    const heightAutoSig = heightExplicit ? null : signal(400);
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
        while (seriesVisibility.length < count) seriesVisibility.push(signal(true));
    };

    // Geometry: stable object, mutated by the size effect.
    const geometry = {
        cx: 0, cy: 0, rOuter: 0, axisCount,
        cosA: new Float64Array(Math.max(axisCount, 4)),
        sinA: new Float64Array(Math.max(axisCount, 4)),
    };
    const plotBoundsBox = { x: 0, y: 0, w: 0, h: 0 };
    const plotBoundsSignal = signal(0);
    const dataVersion = signal(0);

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
    const crosshairVersion = signal(0);
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
        exportPNG: (opts) => {
            if (!mounted || !canvas) throw new Error('lite-charts: exportPNG() requires mount() first');
            if (typeof canvas.toDataURL !== 'function') {
                throw new Error('lite-charts: exportPNG() requires a real HTMLCanvasElement');
            }
            const mt = opts && opts.mimeType || 'image/png';
            const q = opts && opts.quality != null ? opts.quality : 0.92;
            return canvas.toDataURL(mt, q);
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

export const _testHelpers = {
    // Axis-chart kernel helpers
    decimateMinMax,
    updateLinearScale,
    extractSeriesData,
    extractBarSeriesData,
    scaleSeriesToPixels,
    makeLinearScale,
    makeBandScale,
    updateBandScale,
    buildAccessor,
    buildRawAccessor,
    niceYDomain,
    inferXScaleType,
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
};

/**
 * Create a line chart. Reactive in `data`, `width`, `height`, `series`;
 * driven by signal-native data + axis kernel + decimation hot path.
 *
 * Steady-state `chart.redraw()` is allocation-free (~0 B/call measured).
 * For >2k visible points the renderer switches to a per-column min/max
 * decimation pass that scales sub-linearly with N; under 2k it draws
 * direct polylines.
 *
 * @param {import("./Charts.d.ts").LineChartConfig} config
 * @returns {import("./Charts.d.ts").Chart}
 * @throws {TypeError} If `config.canvas` is missing and no `mount(host)` is called.
 *
 * @example
 *   const data = signal({ xs: [0,1,2,3,4], ys: [10,20,15,25,30] });
 *   const chart = createLineChart({ canvas, data, width: 800, height: 400 });
 *   data.set({ xs, ys: newYs });   // triggers a re-extraction + decimation + redraw
 *   chart.unmount();
 */
export const createLineChart = (config) => createBaseAxisChart(config, LINE_RENDERER);

/**
 * Create an area chart. Same kernel as the line chart; renders the area
 * below each series as a filled path plus the upper stroke. `baseline` may
 * be a numeric Y value or `"bottom"`.
 *
 * @param {import("./Charts.d.ts").AreaChartConfig} config
 * @returns {import("./Charts.d.ts").Chart}
 */
export const createAreaChart = (config) => createBaseAxisChart(config, AREA_RENDERER);

/**
 * Create a bar chart. Single or grouped multi-series with a band X scale;
 * supports stacked layout, rounded corners (via `roundRect` with `arcTo`
 * fallback for older Canvas2D), and per-bar hover tint.
 *
 * @param {import("./Charts.d.ts").BarChartConfig} config
 * @returns {import("./Charts.d.ts").Chart}
 */
export const createBarChart = (config) => createBaseAxisChart(config, BAR_RENDERER);

// Bubble lives on the axis kernel via BUBBLE_RENDERER. Each point gets a
// circle whose AREA is proportional to a third dimension by default
// (Tukey-style sqrt scale, configurable to linear). Tree-shake check is
// the same as line/area/bar: importing only `createBubbleChart` drops the
// polar kernel entirely and the line/area/bar renderers as expected.

/**
 * Create a bubble chart. Each point is a circle whose area encodes a
 * third dimension by default (Tukey-style sqrt scale, switchable to
 * linear). Multi-series supported; hit-test uses a spatial index when the
 * point count crosses an internal threshold.
 *
 * @param {import("./Charts.d.ts").BubbleChartConfig} config
 * @returns {import("./Charts.d.ts").Chart}
 */
export const createBubbleChart = (config) => createBaseAxisChart(config, BUBBLE_RENDERER);

// Polar slice charts -- pie and donut share the SLICE_RENDERER. The only
// per-factory difference is the innerRadius default (0 for pie, 0.5 for
// donut), applied by the factory so the user can still override via config.
// Both go through createBasePolarChart (a completely separate kernel from
// createBaseAxisChart -- importing only createPieChart drops all axis-chart
// code: xScale/yScale/axes/grid/decimation/bisect/interp/bar helpers).

/**
 * Create a pie chart. Renders one slice per data point; hit-test uses an
 * `atan2` lookup. Lives on the polar kernel (`createBasePolarChart`) --
 * tree-shaking `createPieChart` alone drops all axis-chart code paths
 * (xScale/yScale/axes/grid/decimation/bisect/interp/bar helpers).
 *
 * @param {import("./Charts.d.ts").PieChartConfig} config
 * @returns {import("./Charts.d.ts").PolarChart}
 */
export const createPieChart = (config) =>
    createBasePolarChart({ innerRadius: 0, ...(config || {}) }, SLICE_RENDERER);

/**
 * Create a donut chart. Same renderer as the pie chart with a default
 * `innerRadius` of 0.5; pass any value in [0, 1) to override (still in
 * the pie-chart factory's overridable space).
 *
 * @param {import("./Charts.d.ts").DonutChartConfig} config
 * @returns {import("./Charts.d.ts").PolarChart}
 */
export const createDonutChart = (config) =>
    createBasePolarChart({ innerRadius: 0.5, ...(config || {}) }, SLICE_RENDERER);

/**
 * Create a scatter chart. Bubble's simpler sibling on the axis kernel:
 * same data + projection + hit-test path, constant marker size, no third
 * dimension. Spatial index kicks in at the same N threshold as bubble.
 *
 * @param {import("./Charts.d.ts").ScatterChartConfig} config
 * @returns {import("./Charts.d.ts").Chart}
 */
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

// Linear RGB interp -> 'rgb(r,g,b)' string. `lo` / `hi` are [r,g,b] arrays.
// Allocates a string per call; called at extract time only (not in the
// per-frame draw loop), so this is acceptable.
const _lerpRGBString = (lo, hi, t) => {
    const r = (lo[0] + t * (hi[0] - lo[0])) | 0;
    const g = (lo[1] + t * (hi[1] - lo[1])) | 0;
    const b = (lo[2] + t * (hi[2] - lo[2])) | 0;
    return 'rgb(' + r + ',' + g + ',' + b + ')';
};

const _makeGridState = () => ({
    cells: null,         // Float32Array | null; length = nx * ny
    presentMask: null,   // Uint8Array | null
    cellColors: null,    // Array<string|null> | null
    xCategories: [],     // string[]
    yCategories: [],     // string[]
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
const _computeGridColors = (state, opts) => {
    const total = state.nx * state.ny;
    if (total === 0) { state.cellColors = null; return; }
    if (!state.cellColors || state.cellColors.length < total) state.cellColors = new Array(total);

    const vMin = state.vMin;
    const vMax = state.vMax;
    const span = vMax - vMin;
    const colorFn = opts.colorFn;

    if (colorFn) {
        for (let i = 0; i < total; i++) {
            state.cellColors[i] = state.presentMask[i] ? colorFn(state.cells[i], vMin, vMax) : null;
        }
        return;
    }

    // Default: linear RGB interp between opts.colorLow and opts.colorHigh.
    // Fall back to a safe blue ramp if hex parsing fails (CSS-vars, named
    // colors, oklch() etc. would otherwise produce NaN channels).
    const lo = _parseHexColor(opts.colorLow)  || [219, 234, 254];  // blue-100
    const hi = _parseHexColor(opts.colorHigh) || [30, 58, 138];    // blue-900
    for (let i = 0; i < total; i++) {
        if (!state.presentMask[i]) { state.cellColors[i] = null; continue; }
        const t = span > 0 ? (state.cells[i] - vMin) / span : 0;
        state.cellColors[i] = _lerpRGBString(lo, hi, t);
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
        const fmt = opts.valueFormat || ((v) => v.toFixed(1));
        ctx.font = opts.valueLabelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = opts.valueLabelColor;
        for (let yi = 0; yi < ny; yi++) {
            const cy = yBand.map(yi);
            for (let xi = 0; xi < nx; xi++) {
                const idx = yi * nx + xi;
                if (!present[idx]) continue;
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
        // colorFn(v, vMin, vMax) -> 'css color'. Overrides the linear-interp
        // default entirely; use this for OKLCH ramps, quantile binning,
        // diverging schemes, etc.
        colorFn: typeof config.colorFn === 'function' ? config.colorFn : null,
        showValues: config.showValues === true,
        valueFormat: typeof config.valueFormat === 'function' ? config.valueFormat : null,
        valueLabelFont: config.valueLabelFont != null ? config.valueLabelFont : '11px sans-serif',
        valueLabelColor: config.valueLabelColor != null ? config.valueLabelColor : '#ffffff',
        cellGap: config.cellGap != null ? Math.max(0, Math.min(0.5, +config.cellGap)) : 0.04,
        highlightStroke: config.highlightStroke != null ? config.highlightStroke : '#111111',
        highlightStrokeWidth: config.highlightStrokeWidth != null ? +config.highlightStrokeWidth : 2,
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
    const widthAutoSig = widthExplicit ? null : signal(600);
    const heightAutoSig = heightExplicit ? null : signal(400);
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
    const plotBoundsSignal = signal(0);

    // -- Crosshair / hover state --
    const hoverData = { visible: false, xi: -1, yi: -1, value: 0, mouseX: 0, mouseY: 0 };
    const hoverVersion = signal(0);

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
        opts.colorLow         = resolveColor(opts.colorLow, container);
        opts.colorHigh        = resolveColor(opts.colorHigh, container);
        opts.labelColor       = resolveColor(opts.labelColor, container);
        opts.highlightStroke  = resolveColor(opts.highlightStroke, container);
        opts.valueLabelColor  = resolveColor(opts.valueLabelColor, container);

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

            // Stroke the hovered cell.
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

    chart.mount = mount;
    chart.unmount = unmount;
    return chart;
};

// v1.2.0-alpha.3: heatmap rides the grid kernel. Currently the only consumer;
// future grid charts (correlation matrix, calendar heatmap, dot matrix) would
// fit the same kernel by supplying a different RENDERER.

/**
 * Create a 2D heatmap. Categorical rows × columns; each cell colored by a
 * numeric value via a default linear ramp (`colorLow` -> `colorHigh`) or
 * a custom `colorFn(v, vMin, vMax)`. Sparse grids draw only present cells.
 *
 * Rides a third kernel (`createBaseGridChart`) -- importing only
 * `createHeatmap` tree-shakes the axis-chart and polar-chart code paths.
 *
 * @param {import("./Charts.d.ts").HeatmapConfig} config
 * @returns {import("./Charts.d.ts").Chart}
 * @throws {Error} If `config` is missing or `data` is not an array / accessor.
 *
 * @example
 *   const chart = createHeatmap({
 *       canvas,
 *       data: [
 *           { row: "Mon", col: "9am", value: 12 },
 *           { row: "Mon", col: "10am", value: 8 },
 *           // ...
 *       ],
 *       width: 600, height: 400
 *   });
 */
export const createHeatmap = (config) => createBaseGridChart(config, HEATMAP_RENDERER);
