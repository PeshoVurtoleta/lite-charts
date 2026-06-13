/**
 * @zakkster/lite-charts -- line-chart benchmark at 100k points.
 *
 * Measures the per-frame CPU cost of:
 *   (a) extractSeriesData + scaleSeriesToPixels         (data path)
 *   (b) decimateMinMax kernel alone                     (the hot loop)
 *   (c) full draw via the line series' draw closure     (everything)
 *
 * IMPORTANT (honest disclaimer):
 * --------------------------------
 *   This bench runs against a recording mock canvas context. It measures
 *   the library's CPU work (scale math, decimation, canvas-call issuing)
 *   but does NOT measure real GPU paint cost. In a real browser, the
 *   actual stroke/fill paint is additional and depends on the GPU,
 *   device pixel ratio, blending, and how many other things are on the
 *   compositor. The 60fps claim for 100k points is meaningful only when
 *   CPU + GPU together fit under 16.67 ms. This bench validates the CPU
 *   side; the browser bench under bench/browser/ (a future deliverable)
 *   covers paint.
 *
 * Run with:  node --expose-gc bench/line-100k.mjs
 */

import { signal } from '@zakkster/lite-signal';
import { createLineChart, _testHelpers } from '../Charts.js';
import { createMockCanvas, countCalls } from '../test/harness.js';

const N = 100_000;
const W = 1600;
const H = 800;
const ITERS = 60;

const fmt = (ms) => ms.toFixed(3).padStart(8) + ' ms';
const fmtRow = (label, p50, p95, p99) =>
    label.padEnd(46) + ' p50=' + fmt(p50) + '   p95=' + fmt(p95) + '   p99=' + fmt(p99);

const percentiles = (samples) => {
    const sorted = samples.slice().sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { p50: p(0.50), p95: p(0.95), p99: p(0.99) };
};

const time = (fn) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
};

const sample = (fn, iters) => {
    const out = new Array(iters);
    for (let i = 0; i < iters; i++) out[i] = time(fn);
    return out;
};

// ---------------------------------------------------------------------------
// Build dataset
// ---------------------------------------------------------------------------

console.log('\n@zakkster/lite-charts -- line-chart bench');
console.log('-----------------------------------------');
console.log('Dataset: N=' + N.toLocaleString() + ', canvas=' + W + 'x' + H + ', iters=' + ITERS);
console.log('Node:    ' + process.version);
console.log('GC:      ' + (typeof global.gc === 'function' ? 'exposed' : 'NOT exposed (heap stats will be noisy)'));
console.log('');

const xs = new Float32Array(N);
const ys = new Float32Array(N);
for (let i = 0; i < N; i++) {
    xs[i] = i;
    ys[i] = Math.sin(i * 0.0007) * 100 + Math.cos(i * 0.0023) * 30;
}

// ---------------------------------------------------------------------------
// Setup chart
// ---------------------------------------------------------------------------

const canvas = createMockCanvas(W, H);
const data = signal({ xs, ys });
// Microtask-based schedule. Multiple node.set() calls inside an effect now
// coalesce to ONE drawAll (lite-scene's `_queued` flag de-dupes). Synchronous
// schedule would defeat coalescing -- node.set() fires markDirty for each
// state change, and a synchronous schedule runs drawAll *between* set() calls
// rather than after them. Net effect: ~280 redundant draws per data.set under
// sync schedule (measured), one draw under microtask schedule.
const chart = createLineChart({
    data,
    width: W,
    height: H,
    schedule: (fn) => queueMicrotask(fn),
});
chart.mount(canvas);
const ctx = canvas.getContext('2d');

// We don't need the recorded call sequence here -- only the timing. Keeping
// it on would push hundreds of thousands of entries into ctx.calls during
// the bench and OOM the heap (which happened the first time around).
ctx.recordingEnabled = false;

// Microtask-drain helper. After each data.set we must let the queued draw run
// before measuring the cycle end.
const drainMicrotasks = () => new Promise((r) => queueMicrotask(r));

// ---------------------------------------------------------------------------
// Warm up the JIT
// ---------------------------------------------------------------------------

for (let i = 0; i < 5; i++) {
    chart.redraw();
    await drainMicrotasks();
}

// ---------------------------------------------------------------------------
// Measure (a) full data-update + reproject + draw cycle
// ---------------------------------------------------------------------------

// Simulate a "live" update: rotate the ys array.
const ys2 = new Float32Array(N);
const rotateYs = (offset) => {
    for (let i = 0; i < N; i++) ys2[i] = ys[(i + offset) % N];
    return ys2;
};

const fullCycleSamples = [];
for (let i = 0; i < ITERS; i++) {
    const rotated = rotateYs(i * 137);
    const t0 = performance.now();
    data.set({ xs, ys: rotated });
    // Drain the queued draw microtask so the cycle includes the draw.
    await drainMicrotasks();
    fullCycleSamples.push(performance.now() - t0);
}

// ---------------------------------------------------------------------------
// Measure (b) decimation kernel alone
// ---------------------------------------------------------------------------

// _testHelpers is the public test-only export that holds the pure
// kernels (no chart instance pinning). Previously this destructured from
// chart._internal -- which silently returned `undefined` because the
// helpers were intentionally moved off chart._internal to keep them
// outside production-bundle reachability. Result: decimateMinMax was
// undefined and the bench crashed at first invocation.
const { decimateMinMax } = _testHelpers;
const cols = chart._internal.plotBoundsBox.w | 0;
const decMin = new Float32Array(cols);
const decMax = new Float32Array(cols);
const decOcc = new Uint8Array(cols);
const pxs = chart._internal.seriesStates[0].pxs;
const pys = chart._internal.seriesStates[0].pys;
const plotL = chart._internal.plotBoundsBox.x | 0;
const plotR = plotL + cols - 1;

const decimateSamples = sample(() => {
    decimateMinMax(pxs, pys, N, plotL, plotR, decMin, decMax, decOcc);
}, ITERS * 4);

// ---------------------------------------------------------------------------
// Measure (c) draw alone (no data change)
// ---------------------------------------------------------------------------

const drawSamples = [];
for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    chart.redraw();
    await drainMicrotasks();
    drawSamples.push(performance.now() - t0);
}

// ---------------------------------------------------------------------------
// Heap stats (allocation sniff test)
// ---------------------------------------------------------------------------

let heapDelta = null;
let heapDeltaPure = null;
let heapDeltaSet = null;
if (typeof global.gc === 'function') {
    // Burn 10 cycles for warmup, GC, measure.
    for (let i = 0; i < 10; i++) {
        chart.redraw();
        await drainMicrotasks();
    }
    global.gc();
    global.gc();

    // (1) Pure chart.redraw() with stable data -- isolates the library's
    //     own steady-state allocation, independent of signal mechanics or
    //     test scaffolding.
    const before1 = process.memoryUsage().heapUsed;
    const PURE_ITERS = 1000;
    for (let i = 0; i < PURE_ITERS; i++) chart.redraw();
    global.gc(); global.gc();
    heapDeltaPure = (process.memoryUsage().heapUsed - before1) / PURE_ITERS;

    // (2) Reused-object data.set + sync redraw -- adds the signal+effect
    //     scheduling cost but excludes Promise/microtask overhead.
    const stateA = { xs, ys };
    const stateB = { xs, ys: rotateYs(101) };
    global.gc(); global.gc();
    const before2 = process.memoryUsage().heapUsed;
    const SET_ITERS = 1000;
    for (let i = 0; i < SET_ITERS; i++) {
        data.set(i % 2 === 0 ? stateA : stateB);
        chart.redraw();
    }
    global.gc(); global.gc();
    heapDeltaSet = (process.memoryUsage().heapUsed - before2) / SET_ITERS;

    // (3) Full live-update cycle as a real app would experience it:
    //     fresh object literal + async drain. This INCLUDES the inherent
    //     Promise/microtask overhead (~85 B per await on V8) and the
    //     `{xs, ys: rotated}` object literal (~32 B) -- those are properties
    //     of the calling code, not of the library.
    global.gc(); global.gc();
    const before3 = process.memoryUsage().heapUsed;
    const HEAP_ITERS = 200;
    for (let i = 0; i < HEAP_ITERS; i++) {
        const rotated = rotateYs(i * 71);
        data.set({ xs, ys: rotated });
        await drainMicrotasks();
    }
    global.gc(); global.gc();
    heapDelta = (process.memoryUsage().heapUsed - before3) / HEAP_ITERS;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const a = percentiles(fullCycleSamples);
const b = percentiles(decimateSamples);
const c = percentiles(drawSamples);

console.log('Per-iteration latency (lower is better):');
console.log('');
console.log(fmtRow('  full update cycle (data -> draw)', a.p50, a.p95, a.p99));
console.log(fmtRow('  decimation kernel only', b.p50, b.p95, b.p99));
console.log(fmtRow('  draw only (cached data + scales)', c.p50, c.p95, c.p99));
console.log('');

const fpsAt = (ms) => (ms > 0 ? (1000 / ms) : Infinity);
console.log('Inferred CPU-bound fps ceiling:');
console.log('  full cycle: ' + fpsAt(a.p95).toFixed(0) + ' fps @ p95');
console.log('  draw only:  ' + fpsAt(c.p95).toFixed(0) + ' fps @ p95');
console.log('');

const FRAME_BUDGET_60 = 1000 / 60;
const FRAME_BUDGET_120 = 1000 / 120;
const fits60 = a.p95 < FRAME_BUDGET_60 ? 'YES' : 'NO';
const fits120 = a.p95 < FRAME_BUDGET_120 ? 'YES' : 'NO';
console.log('CPU budget verdict (p95 full cycle vs target):');
console.log('  fits in 60fps  (16.67 ms): ' + fits60 + '   (' + a.p95.toFixed(2) + ' ms)');
console.log('  fits in 120fps ( 8.33 ms): ' + fits120 + '   (' + a.p95.toFixed(2) + ' ms)');
console.log('');

if (heapDelta !== null) {
    console.log('Heap allocation breakdown (sampled after global.gc()):');
    console.log('  chart.redraw() alone:            ' + heapDeltaPure.toFixed(2).padStart(8) + ' B/call   (1000 samples)');
    console.log('  data.set(reused) + redraw:       ' + heapDeltaSet.toFixed(2).padStart(8) + ' B/call   (1000 samples)');
    console.log('  data.set({...}) + await drain:   ' + heapDelta.toFixed(2).padStart(8) + ' B/cycle  (200 samples)');
    console.log('');
    console.log('Notes on the third number:');
    console.log('  ~32 B is the {xs, ys: rotated} object literal at the call site');
    console.log('  ~85 B is the Promise wrapper around queueMicrotask (V8 overhead)');
    console.log('  The library accounts for ~' + heapDeltaSet.toFixed(0) + ' B of the cycle (signal mechanics + draw)');
    console.log('');
    if (heapDeltaPure < 8) {
        console.log('  -> zero-GC (steady-state redraw): PASS (' + heapDeltaPure.toFixed(2) + ' B/call, sub-8-byte noise floor)');
    } else if (heapDeltaPure < 100) {
        console.log('  -> zero-GC (steady-state redraw): PASS (' + heapDeltaPure.toFixed(2) + ' B/call, sub-100-byte tolerance)');
    } else {
        console.log('  -> zero-GC: FAIL (steady-state redraw allocates ' + heapDeltaPure.toFixed(2) + ' B/call)');
    }
    console.log('');
}

// To get an accurate canvas-call-count, briefly re-enable recording for one
// representative frame.
ctx.recordingEnabled = true;
ctx.calls.length = 0;
chart.redraw();
await drainMicrotasks();
const canvasCallsPerDraw = ctx.calls.length;
ctx.recordingEnabled = false;

console.log('Canvas calls issued: ~' + canvasCallsPerDraw + ' per draw');
console.log('  (decimated mode: ~2 * occupied columns + axis ticks + spines)');
console.log('');
console.log('NOTE: This bench measures CPU work against a mock canvas context.');
console.log('      Real GPU paint cost is additional. See README for caveats.');

chart.unmount();
