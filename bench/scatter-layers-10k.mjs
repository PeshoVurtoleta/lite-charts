/**
 * @zakkster/lite-charts -- scatter injection-ladder benchmark at 10k points
 * (v1.14.0 cells -> v1.16.0 field -> v1.17.0 contours -> v1.18.0 outlines).
 *
 * Measures the per-gesture CPU cost of the four injected layers against the
 * REAL published @zakkster/lite-delaunay 1.4.0 (devDep), not a mock:
 *   (a) view change, bare scatter        -- the baseline reprojection + draw
 *   (b) view change, + cells             -- Voronoi tessellation rebuild
 *   (c) view change, + field + contours  -- barycentric resample + iso sweep
 *   (d) view change, + outlines          -- per-group alpha-shape rebuild
 *   (e) view change, ALL layers          -- the full ladder
 *   (f) redraw only, ALL layers          -- the steady-state 0 B/frame walk
 *
 * Every layer rebuilds COLD per scale change by design (pixel space is not
 * affine-stable), so a pan/zoom gesture pays the injected geometry once per
 * view write -- that cost is dominated by lite-delaunay, and this bench
 * makes it visible per layer. Same disclaimer as bench/line-100k.mjs:
 * recording mock canvas, CPU only, no GPU paint.
 *
 * Run with:  node --expose-gc bench/scatter-layers-10k.mjs
 */

import { createScatterChart } from '../Charts.js';
import { createSpatialIndex, createCellIndex, createFieldIndex, createClusterIndex } from '@zakkster/lite-delaunay';
import { createMockCanvas } from '../test/harness.js';

const N = 10_000;
const W = 1600;
const H = 800;
const ITERS = 40;
const GROUPS = 8;

const fmt = (ms) => ms.toFixed(3).padStart(8) + ' ms';
const fmtRow = (label, p) =>
    label.padEnd(46) + ' p50=' + fmt(p.p50) + '   p95=' + fmt(p.p95) + '   p99=' + fmt(p.p99);

const percentiles = (samples) => {
    const sorted = samples.slice().sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { p50: p(0.50), p95: p(0.95), p99: p(0.99) };
};

console.log('\n@zakkster/lite-charts -- scatter injection-ladder bench (10k pts)');
console.log('-----------------------------------------------------------------');
console.log('Dataset: N=' + N.toLocaleString() + ' pts, ' + GROUPS + ' groups, canvas=' + W + 'x' + H + ', iters=' + ITERS);
console.log('Node:    ' + process.version + '   geometry: @zakkster/lite-delaunay (published devDep)');
console.log('');

// Deterministic clustered cloud: GROUPS blobs + a z scalar for the field.
let seed = 20260906;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const rows = new Array(N);
for (let i = 0; i < N; i++) {
    const g = i % GROUPS;
    const cx = 100 + (g % 4) * 250;
    const cy = 100 + ((g / 4) | 0) * 300;
    rows[i] = {
        x: cx + (rnd() - 0.5) * 180,
        y: cy + (rnd() - 0.5) * 220,
        z: Math.sin(i * 0.001) * 50 + 50,
        g: 'g' + g,
    };
}

const LAYERS = {
    cells: { index: createCellIndex(N + 8), fillOpacity: 0.25 },
    field: {
        index: createFieldIndex(N),
        value: 'z',
        gridW: 64, gridH: 48,
        contours: { levels: 8 },
    },
    outlines: { index: createClusterIndex(N), groupKey: 'g', alpha: 60, fillOpacity: 0.15 },
    spatialIndex: createSpatialIndex(N),
};

const mkChart = (layerKeys) => {
    const cfg = {
        data: rows, width: W, height: H, pan: true, zoom: true,
        schedule: (fn) => queueMicrotask(fn),
    };
    for (const k of layerKeys) cfg[k] = LAYERS[k];
    const chart = createScatterChart(cfg);
    const canvas = createMockCanvas(W, H);
    chart.mount(canvas);
    canvas.getContext('2d').recordingEnabled = false;
    return chart;
};

const drainMicrotasks = () => new Promise((r) => queueMicrotask(r));

const vA = { xMin: 60, xMax: 1000, yMin: 40, yMax: 700 };
const vB = { xMin: 120, xMax: 940, yMin: 80, yMax: 660 };

const benchView = async (label, layerKeys) => {
    const chart = mkChart(layerKeys);
    for (let i = 0; i < 5; i++) {
        chart.setView(i & 1 ? vA : vB);
        await drainMicrotasks();
    }
    const samples = new Array(ITERS);
    let flip = false;
    for (let i = 0; i < ITERS; i++) {
        flip = !flip;
        const t0 = performance.now();
        chart.setView(flip ? vA : vB);
        await drainMicrotasks();
        samples[i] = performance.now() - t0;
    }
    console.log(fmtRow(label, percentiles(samples)));
    return chart;
};

(await benchView('view change: bare scatter', [])).destroy();
(await benchView('view change: + cells (Voronoi)', ['cells'])).destroy();
(await benchView('view change: + field + contours', ['field'])).destroy();
(await benchView('view change: + outlines (alpha shapes)', ['outlines'])).destroy();
const all = await benchView('view change: ALL layers', ['spatialIndex', 'cells', 'field', 'outlines']);

// (f) redraw only with everything on -- the steady-state walk.
{
    const samples = new Array(ITERS);
    for (let i = 0; i < ITERS; i++) {
        const t0 = performance.now();
        all.redraw();
        await drainMicrotasks();
        samples[i] = performance.now() - t0;
    }
    console.log(fmtRow('draw only: ALL layers (cached geometry)', percentiles(samples)));
}

console.log('');
all.destroy();
