/**
 * @zakkster/lite-charts -- candlestick benchmark at 10k candles (v1.19.0).
 *
 * Measures the per-frame CPU cost of the tenth renderer:
 *   (a) full data-update cycle (extract: OHLC validation + median sort ->
 *       per-value o/h/l/c projection -> draw)
 *   (b) view change (pan/zoom): cold postProject only -- 4-pool per-value
 *       re-projection + median-slot recompute + draw (no re-extract)
 *   (c) redraw only (cached pools -- the 0 B/frame walk)
 *
 * Same honest disclaimer as bench/line-100k.mjs: this runs against a
 * recording mock canvas with recording disabled, so it measures the
 * library's CPU work (validation, projection, canvas-call issuing), NOT
 * real GPU paint.
 *
 * Run with:  node --expose-gc bench/candle-10k.mjs
 */

import { signal } from '@zakkster/lite-signal';
import { createCandlestickChart } from '../Charts.js';
import { createMockCanvas } from '../test/harness.js';

const N = 10_000;
const W = 1600;
const H = 800;
const ITERS = 60;

const fmt = (ms) => ms.toFixed(3).padStart(8) + ' ms';
const fmtRow = (label, p) =>
    label.padEnd(46) + ' p50=' + fmt(p.p50) + '   p95=' + fmt(p.p95) + '   p99=' + fmt(p.p99);

const percentiles = (samples) => {
    const sorted = samples.slice().sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { p50: p(0.50), p95: p(0.95), p99: p(0.99) };
};

console.log('\n@zakkster/lite-charts -- candlestick bench (v1.19.0)');
console.log('----------------------------------------------------');
console.log('Dataset: N=' + N.toLocaleString() + ' candles (minute bars), canvas=' + W + 'x' + H + ', iters=' + ITERS);
console.log('Node:    ' + process.version);
console.log('');

// Minute bars at a 2026 epoch -- the raw-double timestamp path is exactly
// what this granularity exercises.
const T0 = Date.UTC(2026, 0, 5);
const mkRows = (seedOffset) => {
    const rows = new Array(N);
    let price = 100 + seedOffset;
    for (let i = 0; i < N; i++) {
        const o = price;
        const c = o + Math.sin((i + seedOffset) * 0.0013) * 2 + 0.1;
        const h = Math.max(o, c) + Math.abs(Math.cos(i * 0.002)) + 0.2;
        const l = Math.min(o, c) - Math.abs(Math.sin(i * 0.0031)) - 0.2;
        rows[i] = { ts: T0 + i * 60000, o, h, l, c };
        price = c;
    }
    return rows;
};
const rowsA = mkRows(0);
const rowsB = mkRows(7);

const canvas = createMockCanvas(W, H);
const data = signal(rowsA);
const chart = createCandlestickChart({
    data,
    width: W,
    height: H,
    pan: true,
    zoom: true,
    schedule: (fn) => queueMicrotask(fn),
});
chart.mount(canvas);
canvas.getContext('2d').recordingEnabled = false;

const drainMicrotasks = () => new Promise((r) => queueMicrotask(r));

for (let i = 0; i < 5; i++) {
    chart.redraw();
    await drainMicrotasks();
}

// (a) full data-update cycle: alternate two prebuilt row arrays so the
// caller-side row construction is NOT in the measurement.
{
    let flip = false;
    const samples = new Array(ITERS);
    for (let i = 0; i < ITERS; i++) {
        flip = !flip;
        const next = flip ? rowsB : rowsA;
        const t0 = performance.now();
        data.set(next);
        await drainMicrotasks();
        samples[i] = performance.now() - t0;
    }
    console.log(fmtRow('full update (validate+median+project+draw)', percentiles(samples)));
}

// (b) view change: the cold postProject path (4-pool per-value projection +
// slot recompute + draw) without a re-extract.
{
    const span = N * 60000;
    const vA = { xMin: T0 + span * 0.1, xMax: T0 + span * 0.9, yMin: 40, yMax: 200 };
    const vB = { xMin: T0 + span * 0.2, xMax: T0 + span * 0.8, yMin: 50, yMax: 190 };
    let flip = false;
    const samples = new Array(ITERS);
    for (let i = 0; i < ITERS; i++) {
        flip = !flip;
        const t0 = performance.now();
        chart.setView(flip ? vA : vB);
        await drainMicrotasks();
        samples[i] = performance.now() - t0;
    }
    console.log(fmtRow('view change (postProject: 4 pools + slot)', percentiles(samples)));
}

// (c) redraw only: the steady-state 0 B/frame walk. The microtask schedule
// means redraw() only queues -- the drain must sit INSIDE the timing window.
{
    const samples = new Array(ITERS);
    for (let i = 0; i < ITERS; i++) {
        const t0 = performance.now();
        chart.redraw();
        await drainMicrotasks();
        samples[i] = performance.now() - t0;
    }
    console.log(fmtRow('draw only (cached pools)', percentiles(samples)));
}

console.log('');
chart.destroy();
