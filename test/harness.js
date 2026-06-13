/**
 * Recording mock canvas + 2D context for headless tests.
 *
 * The mock records every assignment and every method call into a flat
 * `calls` array. Tests assert on the call sequence to verify what was
 * drawn, in what order, with which state. No DOM required.
 *
 * The surface area mirrors exactly what @zakkster/lite-scene plus
 * lite-charts use:
 *   methods:  save, restore, beginPath, moveTo, lineTo, stroke, fill,
 *             fillRect, clearRect, fillText, strokeText, arc, rect, clip,
 *             setTransform, translate, rotate, scale, drawImage,
 *             measureText, setLineDash
 *   props:    fillStyle, strokeStyle, lineWidth, lineJoin, lineCap, font,
 *             textAlign, textBaseline, globalAlpha
 */

const METHODS = [
    'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'stroke', 'fill',
    'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'arc', 'rect',
    'clip', 'setTransform', 'translate', 'rotate', 'scale', 'drawImage',
    'setLineDash',
    // Curve emitters used by the monotone + catmull-rom interpolation modes
    // (Charts.js: _traceMonotone, _traceCatmullRom). Without these the mock
    // throws "ctx.bezierCurveTo is not a function" the moment a non-linear
    // line chart draws, which breaks the interpolation test sub-suite.
    'bezierCurveTo', 'quadraticCurveTo',
    // Defensive: present in Canvas2D and likely to be reached if anyone
    // adds rounded bars / curved tooltips in v1.1.
    'arcTo', 'ellipse', 'roundRect',
];

const PROPS = [
    'fillStyle', 'strokeStyle', 'lineWidth', 'lineJoin', 'lineCap', 'font',
    'textAlign', 'textBaseline', 'globalAlpha',
];

export const createMockContext = () => {
    const ctx = {
        calls: [],
        recordingEnabled: true, // set false in benches to avoid unbounded growth
        // Initial property values matching default canvas state.
        fillStyle: '#000000',
        strokeStyle: '#000000',
        lineWidth: 1,
        lineJoin: 'miter',
        lineCap: 'butt',
        font: '10px sans-serif',
        textAlign: 'start',
        textBaseline: 'alphabetic',
        globalAlpha: 1,
        // measureText returns a synthetic width based on string length.
        measureText(s) {
            return { width: (s || '').length * 6 };
        },
    };
    // Wrap methods.
    for (let i = 0; i < METHODS.length; i++) {
        const name = METHODS[i];
        ctx[name] = function () {
            if (!ctx.recordingEnabled) return;
            // Copy args to a plain array so callers can inspect.
            const n = arguments.length;
            const args = new Array(n);
            for (let j = 0; j < n; j++) args[j] = arguments[j];
            ctx.calls.push([name, args]);
        };
    }
    // Wrap props: record assignments. We use Object.defineProperty so the
    // property looks plain to consumer code but every write is logged.
    for (let i = 0; i < PROPS.length; i++) {
        const name = PROPS[i];
        let value = ctx[name];
        Object.defineProperty(ctx, name, {
            configurable: true,
            enumerable: true,
            get() { return value; },
            set(v) {
                value = v;
                if (ctx.recordingEnabled) {
                    ctx.calls.push(['set:' + name, [v]]);
                }
            },
        });
    }
    return ctx;
};

export const createMockCanvas = (width, height) => {
    let _w = width || 800;
    let _h = height || 400;
    let _ctx = null;
    const canvas = {
        // Mark with tagName so lite-charts mount() recognizes it as canvas.
        tagName: 'CANVAS',
        get width() { return _w; },
        set width(v) {
            _w = v | 0;
            if (_ctx) _ctx.calls.push(['set:canvas.width', [_w]]);
        },
        get height() { return _h; },
        set height(v) {
            _h = v | 0;
            if (_ctx) _ctx.calls.push(['set:canvas.height', [_h]]);
        },
        getContext(type) {
            if (type !== '2d') return null;
            if (!_ctx) _ctx = createMockContext();
            return _ctx;
        },
        // No-op DOM container shim so resolveColor doesn't error.
        parentElement: null,
    };
    return canvas;
};

/**
 * Tally helpers for assertions.
 */
export const countCalls = (ctx, name) => {
    let n = 0;
    const calls = ctx.calls;
    for (let i = 0; i < calls.length; i++) {
        if (calls[i][0] === name) n++;
    }
    return n;
};

export const lastCall = (ctx, name) => {
    const calls = ctx.calls;
    for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i][0] === name) return calls[i];
    }
    return null;
};

export const callsOf = (ctx, name) => {
    const out = [];
    const calls = ctx.calls;
    for (let i = 0; i < calls.length; i++) {
        if (calls[i][0] === name) out.push(calls[i]);
    }
    return out;
};

/**
 * Allocation harness. Requires --expose-gc.
 *
 * Forces a GC, samples heap, runs fn iters times, samples again.
 * Returns delta bytes. Useful for the zero-GC assertion in tests.
 */
export const measureAllocPerCall = (fn, iters) => {
    if (typeof global.gc !== 'function') {
        return -1; // signal: not measurable without --expose-gc
    }
    // Warm up
    for (let i = 0; i < Math.min(iters, 100); i++) fn();
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < iters; i++) fn();
    global.gc();
    const after = process.memoryUsage().heapUsed;
    return (after - before) / iters;
};
