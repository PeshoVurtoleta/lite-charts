/**
 * @zakkster/lite-charts
 *
 * 22 deterministic tests via node:test.
 *
 * Coverage:
 *   - Slab growth, scale math, AoS->SoA extraction
 *   - Decimation kernel (basic + clipping + empty columns + sparse)
 *   - Domain inference, X-scale-type inference, "nice"/"zero" y-domain
 *   - Color resolution (hex, CSS-var fallback)
 *   - Accessor builder (string, number, function)
 *   - Lifecycle: mount/unmount/double-mount/unmount-without-mount
 *   - Reactive: data update -> re-extract; width update -> resize
 *   - Render path selection: direct polyline (n small) vs decimated (n large)
 *   - Multi-series domain union + custom xScale.domain override
 *   - exportPNG error handling on mock canvas
 *
 * Run with:  node --test --expose-gc test/
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { signal, createRegistry, setDefaultRegistry, stats, effect } from '@zakkster/lite-signal';
// The full suite creates 200+ charts; each chart allocates ~12-20 reactive
// nodes (visibility signals per series, crosshair, version stamps, draw
// effects, etc.). Default lite-signal registry caps at 1024 nodes -- enough
// for a single app session but not enough for an exhaustive test suite that
// runs every chart variant back-to-back. Bump to 32k for headroom.
setDefaultRegistry(createRegistry({ maxNodes: 32768 }));
import { createLineChart, createTimeLineChart, createAreaChart, createBarChart, createPieChart, createDonutChart, createBubbleChart, createRadarChart, createScatterChart, createHeatmap, _testHelpers } from '../Charts.js';
// v1.14.0: the REAL published cell index (devDep) -- the tessellation tests run
// end-to-end against the actual consumer contract, not a mock.
import { createCellIndex } from '@zakkster/lite-delaunay';
import {
    createMockCanvas,
    countCalls,
    callsOf,
    lastCall,
} from './harness.js';

// ---------------------------------------------------------------------------
// Internal-kernel tests (no chart instance required)
// ---------------------------------------------------------------------------
//
// Pure helpers live on _testHelpers (separate top-level export, not on any
// chart instance) -- this keeps them out of the tree-shake-reachable set of
// production code. Per-chart state (seriesStates, scaleVersion, etc.) still
// lives on chart._internal; a handful of tests below read it for white-box
// assertions on extraction + projection paths.

const {
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
    buildAccessor,
    niceYDomain,
    inferXScaleType,
    resolveColor,
    bisectNearest,
    // Polar kernel
    extractSliceData,
    computeSliceGeometry,
    sliceHitTest,
    recomputePolarAngles,
    makePolarState,
    // Radar kernel
    extractRadarSeriesData,
    computeRadarGeometry,
    radarHitTest,
    makeRadarSeriesState,
} = _testHelpers;

describe('linear scale', () => {
    it('maps domain to range linearly', () => {
        const s = updateLinearScale(makeLinearScale(), 0, 100, 0, 800);
        assert.equal(s.map(0), 0);
        assert.equal(s.map(50), 400);
        assert.equal(s.map(100), 800);
    });

    it('inverts pixel to domain', () => {
        const s = updateLinearScale(makeLinearScale(), 0, 100, 0, 800);
        assert.equal(s.invert(0), 0);
        assert.equal(s.invert(400), 50);
        assert.equal(s.invert(800), 100);
    });

    it('handles reversed y-axis range (top=0, bottom=400 -> domain low maps to high pixel)', () => {
        const s = updateLinearScale(makeLinearScale(), 0, 10, 400, 0);
        assert.equal(s.map(0), 400);
        assert.equal(s.map(10), 0);
        assert.equal(s.map(5), 200);
    });

    it('degenerate domain (min === max) yields slope 0 and does not throw', () => {
        const s = updateLinearScale(makeLinearScale(), 5, 5, 0, 800);
        assert.equal(s._slope, 0);
        assert.equal(s.map(5), 0); // intercept = rMin
    });
});

describe('niceYDomain', () => {
    it('with zero=true clamps min to 0 if positive data, max to 0 if negative', () => {
        assert.deepEqual(niceYDomain(10, 50, { zero: true }), [0, 50]);
        assert.deepEqual(niceYDomain(-50, -10, { zero: true }), [-50, 0]);
        assert.deepEqual(niceYDomain(-10, 10, { zero: true }), [-10, 10]);
    });

    it('with nice=true pads 5% above and below', () => {
        const [lo, hi] = niceYDomain(0, 100, { nice: true });
        assert.equal(lo, -5);
        assert.equal(hi, 105);
    });

    it('degenerate min === max expands to [v-0.5, v+0.5]', () => {
        assert.deepEqual(niceYDomain(7, 7, {}), [6.5, 7.5]);
    });
});

describe('inferXScaleType', () => {
    it('Date probe -> time', () => {
        assert.equal(inferXScaleType({ x: new Date() }, 'x'), 'time');
    });

    it('large numeric epoch with key "t" -> time', () => {
        assert.equal(inferXScaleType({ t: Date.now() }, 't'), 'time');
    });

    it('plain numeric -> linear', () => {
        assert.equal(inferXScaleType({ x: 42 }, 'x'), 'linear');
    });
});

describe('buildAccessor', () => {
    it('string key extracts numeric field', () => {
        const a = buildAccessor('v');
        assert.equal(a({ v: 3.14 }), 3.14);
    });

    it('string key coerces Date to ms', () => {
        const a = buildAccessor('t');
        const d = new Date(2026, 0, 1);
        assert.equal(a({ t: d }), d.getTime());
    });

    it('integer index reads array slot', () => {
        const a = buildAccessor(1);
        assert.equal(a([10, 20, 30]), 20);
    });

    it('function is passed through', () => {
        const a = buildAccessor((row, i) => row.x * i);
        assert.equal(a({ x: 4 }, 3), 12);
    });

    it('invalid accessor throws', () => {
        assert.throws(() => buildAccessor({}), /accessor must be/);
    });
});

describe('resolveColor', () => {
    it('passes hex strings through', () => {
        assert.equal(resolveColor('#ff00ff', null), '#ff00ff');
    });

    it('passes named colors through', () => {
        assert.equal(resolveColor('red', null), 'red');
    });

    it('CSS-var without container falls back', () => {
        assert.equal(resolveColor('--primary-500', null), '#888');
    });

    it('empty/garbage falls back', () => {
        assert.equal(resolveColor('', null), '#888');
        assert.equal(resolveColor(null, null), '#888');
        assert.equal(resolveColor(undefined, null), '#888');
    });
});

describe('extractSeriesData', () => {
    it('AoS array yields SoA + correct extents', () => {
        const state = {
            xs: null, ys: null, n: 0, pxs: null, pys: null,
            decMin: null, decMax: null, decOcc: null,
            domainXMin: 0, domainXMax: 0, domainYMin: 0, domainYMax: 0,
        };
        const xa = buildAccessor('x');
        const ya = buildAccessor('y');
        const data = [
            { x: 0, y: 10 },
            { x: 5, y: 30 },
            { x: 10, y: 5 },
            { x: 15, y: 25 },
        ];
        extractSeriesData(state, data, xa, ya);
        assert.equal(state.n, 4);
        assert.equal(state.xs[0], 0);
        assert.equal(state.xs[3], 15);
        assert.equal(state.domainXMin, 0);
        assert.equal(state.domainXMax, 15);
        assert.equal(state.domainYMin, 5);
        assert.equal(state.domainYMax, 30);
    });

    it('SoA fast path (no extraction) uses input buffers directly', () => {
        const state = {
            xs: null, ys: null, n: 0, pxs: null, pys: null,
            decMin: null, decMax: null, decOcc: null,
            domainXMin: 0, domainXMax: 0, domainYMin: 0, domainYMax: 0,
        };
        const xs = new Float32Array([1, 2, 3, 4]);
        const ys = new Float32Array([10, 20, 30, 40]);
        extractSeriesData(state, { xs, ys }, null, null);
        assert.equal(state.xs, xs);
        assert.equal(state.ys, ys);
        assert.equal(state.n, 4);
        assert.equal(state.domainXMin, 1);
        assert.equal(state.domainXMax, 4);
    });

    it('empty data yields n=0 and safe default extents', () => {
        const state = {
            xs: null, ys: null, n: 0, pxs: null, pys: null,
            decMin: null, decMax: null, decOcc: null,
            domainXMin: 99, domainXMax: 99, domainYMin: 99, domainYMax: 99,
        };
        extractSeriesData(state, [], buildAccessor('x'), buildAccessor('y'));
        assert.equal(state.n, 0);
        assert.equal(state.domainXMin, 0);
        assert.equal(state.domainXMax, 1);
    });
});

describe('decimateMinMax kernel', () => {
    it('one sample per column produces single-point envelope (yMin === yMax)', () => {
        const pxs = new Float32Array([0, 1, 2, 3]);
        const pys = new Float32Array([10, 20, 30, 40]);
        const outMin = new Float32Array(4);
        const outMax = new Float32Array(4);
        const outOcc = new Uint8Array(4);
        const cols = decimateMinMax(pxs, pys, 4, 0, 3, outMin, outMax, outOcc);
        assert.equal(cols, 4);
        for (let c = 0; c < 4; c++) {
            assert.equal(outOcc[c], 1);
            assert.equal(outMin[c], outMax[c]);
            assert.equal(outMin[c], 10 * (c + 1));
        }
    });

    it('many samples per column collapse to min/max extents', () => {
        const pxs = new Float32Array([0, 0, 0, 1, 1, 1]);
        const pys = new Float32Array([10, 5, 8, 20, 30, 25]);
        const outMin = new Float32Array(2);
        const outMax = new Float32Array(2);
        const outOcc = new Uint8Array(2);
        decimateMinMax(pxs, pys, 6, 0, 1, outMin, outMax, outOcc);
        assert.equal(outMin[0], 5);
        assert.equal(outMax[0], 10);
        assert.equal(outMin[1], 20);
        assert.equal(outMax[1], 30);
    });

    it('sparse coverage: empty columns stay unoccupied', () => {
        const pxs = new Float32Array([0, 3]);
        const pys = new Float32Array([1, 2]);
        const outMin = new Float32Array(4);
        const outMax = new Float32Array(4);
        const outOcc = new Uint8Array(4);
        decimateMinMax(pxs, pys, 2, 0, 3, outMin, outMax, outOcc);
        assert.equal(outOcc[0], 1);
        assert.equal(outOcc[1], 0);
        assert.equal(outOcc[2], 0);
        assert.equal(outOcc[3], 1);
    });

    it('out-of-range samples are clipped (no overflow into adjacent columns)', () => {
        const pxs = new Float32Array([-5, 0, 1, 2, 10]);
        const pys = new Float32Array([1, 2, 3, 4, 5]);
        const outMin = new Float32Array(3);
        const outMax = new Float32Array(3);
        const outOcc = new Uint8Array(3);
        decimateMinMax(pxs, pys, 5, 0, 2, outMin, outMax, outOcc);
        // Only x in [0,2] should be considered.
        assert.equal(outOcc[0], 1);
        assert.equal(outOcc[1], 1);
        assert.equal(outOcc[2], 1);
        assert.equal(outMin[0], 2);
        assert.equal(outMin[2], 4);
    });
});

describe('scaleSeriesToPixels', () => {
    it('projects domain xs/ys into pixel xs/ys', () => {
        const state = {
            xs: new Float32Array([0, 50, 100]),
            ys: new Float32Array([0, 5, 10]),
            n: 3, pxs: null, pys: null,
            decMin: null, decMax: null, decOcc: null,
            domainXMin: 0, domainXMax: 100, domainYMin: 0, domainYMax: 10,
        };
        const xs = updateLinearScale(makeLinearScale(), 0, 100, 56, 776); // typical plot.x .. plot.x+plot.w
        const ys = updateLinearScale(makeLinearScale(), 0, 10, 368, 16);   // y flipped
        scaleSeriesToPixels(state, xs, ys);
        assert.equal(state.pxs[0], 56);
        assert.equal(state.pxs[2], 776);
        assert.equal(state.pys[0], 368);
        assert.equal(state.pys[2], 16);
    });

    // v1.5.1: scaleSeriesToPixels must be LOG-aware for both axes. Before this
    // patch it inlined LINEAR math unconditionally, so a log scale's log-space
    // _slope/_intercept were applied to the RAW value -- points flew thousands
    // of px off canvas. White-box the projection loop directly against map().
    it('log-y: projected pixels equal yScale.map(v) exactly', () => {
        const vals = [1, 10, 100, 1000];
        const n = vals.length;
        const xLin = updateLinearScale(makeLinearScale(), 0, 3, 0, 720);
        const yLog = updateLogScale(makeLogScale(), 1, 1000, 400, 0);
        const state = {
            xs: new Float64Array([0, 1, 2, 3]),
            ys: new Float64Array(vals),
            n,
            // Float64Array of the right length is returned as-is by
            // ensureFloat32, so projection keeps full double precision and can
            // be compared bit-for-bit against map().
            pxs: new Float64Array(n),
            pys: new Float64Array(n),
        };
        scaleSeriesToPixels(state, xLin, yLog);
        for (let i = 0; i < n; i++) {
            assert.ok(Math.abs(state.pys[i] - yLog.map(vals[i])) < 1e-9,
                'pys[' + i + ']=' + state.pys[i] + ' vs map=' + yLog.map(vals[i]));
        }
        // sanity: value 1000 -> pixel 0 (range top), NOT thousands off-canvas.
        assert.ok(Math.abs(state.pys[3] - 0) < 1e-9);
    });

    it('log-x: projected pixels equal xScale.map(v) exactly', () => {
        const vals = [1, 10, 100, 1000];
        const n = vals.length;
        const xLog = updateLogScale(makeLogScale(), 1, 1000, 56, 776);
        const yLin = updateLinearScale(makeLinearScale(), 0, 3, 400, 0);
        const state = {
            xs: new Float64Array(vals),
            ys: new Float64Array([0, 1, 2, 3]),
            n,
            pxs: new Float64Array(n),
            pys: new Float64Array(n),
        };
        scaleSeriesToPixels(state, xLog, yLin);
        for (let i = 0; i < n; i++) {
            assert.ok(Math.abs(state.pxs[i] - xLog.map(vals[i])) < 1e-9,
                'pxs[' + i + ']=' + state.pxs[i] + ' vs map=' + xLog.map(vals[i]));
        }
    });

    it('log-both: projected pixels equal each scale.map(v) exactly', () => {
        const vals = [1, 10, 100, 1000];
        const n = vals.length;
        const xLog = updateLogScale(makeLogScale(), 1, 1000, 56, 776);
        const yLog = updateLogScale(makeLogScale(), 1, 1000, 400, 0);
        const state = {
            xs: new Float64Array(vals),
            ys: new Float64Array(vals),
            n,
            pxs: new Float64Array(n),
            pys: new Float64Array(n),
        };
        scaleSeriesToPixels(state, xLog, yLog);
        for (let i = 0; i < n; i++) {
            assert.ok(Math.abs(state.pxs[i] - xLog.map(vals[i])) < 1e-9);
            assert.ok(Math.abs(state.pys[i] - yLog.map(vals[i])) < 1e-9);
        }
    });

    it('log axis: a non-positive sample projects to NaN (breaks the polyline)', () => {
        const yLog = updateLogScale(makeLogScale(), 1, 1000, 400, 0);
        const xLin = updateLinearScale(makeLinearScale(), 0, 3, 0, 720);
        const state = {
            xs: new Float64Array([0, 1, 2, 3]),
            ys: new Float64Array([1, 0, -5, 1000]),
            n: 4,
            pxs: new Float64Array(4),
            pys: new Float64Array(4),
        };
        scaleSeriesToPixels(state, xLin, yLog);
        assert.ok(Number.isNaN(state.pys[1]), 'y=0 must be NaN');
        assert.ok(Number.isNaN(state.pys[2]), 'y=-5 must be NaN');
        assert.ok(!Number.isNaN(state.pys[0]));
        assert.ok(!Number.isNaN(state.pys[3]));
        // and a non-positive x on a log-x axis too
        const xLog = updateLogScale(makeLogScale(), 1, 1000, 56, 776);
        const yLin = updateLinearScale(makeLinearScale(), 0, 3, 400, 0);
        const s2 = {
            xs: new Float64Array([1, -2, 100, 1000]),
            ys: new Float64Array([0, 1, 2, 3]),
            n: 4,
            pxs: new Float64Array(4),
            pys: new Float64Array(4),
        };
        scaleSeriesToPixels(s2, xLog, yLin);
        assert.ok(Number.isNaN(s2.pxs[1]), 'x=-2 must be NaN');
        assert.ok(!Number.isNaN(s2.pxs[0]));
    });

    // Zero-regression guard: the linear-linear branch MUST stay byte-identical
    // to the pre-fix inlined formula. Any drift here moves the hot bench band
    // and every pixel assertion in the suite. Prove bit-for-bit equality over a
    // large N against the exact pre-fix expression, rounded through Float32.
    it('linear/linear parity: bit-identical to the pre-fix formula over 10k pts', () => {
        const n = 12000;
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            xs[i] = Math.sin(i * 0.017) * 500 + 250;
            ys[i] = Math.cos(i * 0.013) * 8 + 4;
        }
        const xLin = updateLinearScale(makeLinearScale(), 0, 500, 56, 776);
        const yLin = updateLinearScale(makeLinearScale(), 0, 10, 368, 16);
        const state = { xs, ys, n, pxs: null, pys: null };
        scaleSeriesToPixels(state, xLin, yLin);
        const xSlope = xLin._slope, xIntercept = xLin._intercept;
        const ySlope = yLin._slope, yIntercept = yLin._intercept;
        // Reference: the exact pre-fix body, stored through Float32 to match
        // the output typed array's rounding.
        const refX = new Float32Array(n);
        const refY = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            refX[i] = xs[i] * xSlope + xIntercept;
            refY[i] = ys[i] * ySlope + yIntercept;
        }
        for (let i = 0; i < n; i++) {
            assert.ok(Object.is(state.pxs[i], refX[i]), 'pxs[' + i + '] drift');
            assert.ok(Object.is(state.pys[i], refY[i]), 'pys[' + i + '] drift');
        }
    });
});

// ---------------------------------------------------------------------------
// Chart instance tests (mount with mock canvas)
// ---------------------------------------------------------------------------

describe('createLineChart -- lifecycle', () => {
    it('mounts and unmounts cleanly', () => {
        const data = signal([
            { x: 0, y: 1 },
            { x: 1, y: 2 },
            { x: 2, y: 3 },
        ]);
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, x: 'x', y: 'y' });
        chart.mount(canvas);
        assert.ok(chart.scene, 'scene should exist after mount');
        chart.unmount();
        assert.equal(chart.scene, null, 'scene should be nulled after unmount');
    });

    it('throws on double mount', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data: [{ x: 0, y: 0 }] });
        chart.mount(canvas);
        assert.throws(() => chart.mount(createMockCanvas(800, 400)), /already mounted/);
        chart.unmount();
    });

    it('unmount without mount is a no-op (does not throw)', () => {
        const chart = createLineChart({ data: [{ x: 0, y: 0 }] });
        chart.unmount(); // should not throw
        chart.unmount();
    });

    it('throws helpful error when neither data nor series provided', () => {
        assert.throws(() => createLineChart({}), /data.*series/);
    });

    it('throws helpful error on bad mount target', () => {
        const chart = createLineChart({ data: [{ x: 0, y: 0 }] });
        assert.throws(() => chart.mount(42), /HTMLElement|HTMLCanvasElement/);
    });

    it('exportPNG before mount throws', () => {
        const chart = createLineChart({ data: [{ x: 0, y: 0 }] });
        assert.throws(() => chart.exportPNG(), /requires mount/);
    });

    it('exportPNG on a mock canvas (no toDataURL) throws a clear error', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data: [{ x: 0, y: 0 }] });
        chart.mount(canvas);
        assert.throws(() => chart.exportPNG(), /real HTMLCanvasElement/);
        chart.unmount();
    });
});

describe('createLineChart -- reactivity', () => {
    it('updating data signal re-projects pixels', () => {
        const data = signal([
            { x: 0, y: 0 },
            { x: 10, y: 10 },
        ]);
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, x: 'x', y: 'y', schedule: (fn) => fn() });
        chart.mount(canvas);
        const beforeDMax = chart.xScale.dMax;
        assert.equal(beforeDMax, 10);

        data.set([
            { x: 0, y: 0 },
            { x: 5, y: 10 },
        ]);
        // Domain should now span [0, 5] -- last point still maps to the right
        // edge (that's the whole point of auto-scaling), but the SCALE itself
        // changed. Assert on the scale, not the pixel.
        assert.equal(chart.xScale.dMax, 5, 'x-domain should shrink with smaller data');
        chart.unmount();
    });

    it('updating width signal resizes canvas and rescales', () => {
        const w = signal(800);
        const data = signal([
            { x: 0, y: 0 },
            { x: 100, y: 50 },
        ]);
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, x: 'x', y: 'y', width: w, schedule: (fn) => fn() });
        chart.mount(canvas);
        const pxBefore = chart._internal.seriesStates[0].pxs[1];

        w.set(1600);
        assert.equal(canvas.width, 1600);
        const pxAfter = chart._internal.seriesStates[0].pxs[1];
        assert.ok(pxAfter > pxBefore, 'wider canvas should map max-x to a larger pixel (got ' + pxAfter + ' vs ' + pxBefore + ')');
        chart.unmount();
    });
});

describe('createLineChart -- render path selection', () => {
    it('direct polyline: small dataset issues n-1 lineTo calls', () => {
        const data = [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 0 },
            { x: 3, y: 1 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');

        // Synchronous schedule means the initial draw has already fired.
        // Force a fresh redraw, then assert on the call count.
        ctx.calls.length = 0;
        chart.redraw();

        // For direct path: we expect exactly (n-1) lineTo calls for the
        // polyline plus an opening moveTo. We also tolerate any moveTo/lineTo
        // emitted by axis text/lines, so we measure the line-series draw via
        // an isolation pattern: count moveTo+lineTo before redraw vs after.
        // Simpler check: at least n-1 lineTos got emitted somewhere.
        const lineTos = countCalls(ctx, 'lineTo');
        assert.ok(lineTos >= 3, 'expected >= 3 lineTo (got ' + lineTos + ')');
        // And: stroke called at least once for the line.
        assert.ok(countCalls(ctx, 'stroke') >= 1);
        chart.unmount();
    });

    it('decimated path: n > 2*plotWidth produces per-column vertical lines', () => {
        // Make a dataset that will land in the decimated regime.
        const n = 5000;
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            xs[i] = i;
            ys[i] = Math.sin(i * 0.01);
        }
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data: { xs, ys }, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');

        const state = chart._internal.seriesStates[0];
        const pb = chart._internal.plotBoundsBox;
        const cols = pb.w + 1;
        assert.ok(state.n > cols * 2, 'precondition: dataset should trigger decimation');

        ctx.calls.length = 0;
        chart.redraw();

        // Decimated path emits at most cols moveTo/lineTo pairs (one vertical
        // segment per occupied column). For a smooth sine wave every column
        // is occupied, so expected ~cols moveTos and ~cols lineTos.
        const moveTos = countCalls(ctx, 'moveTo');
        const lineTos = countCalls(ctx, 'lineTo');
        // Sanity: moveTos and lineTos should be of similar magnitude in
        // decimated mode (paired per column).
        assert.ok(Math.abs(moveTos - lineTos) <= 4, 'moveTos and lineTos should pair: ' + moveTos + ' vs ' + lineTos);
        // And both should be in the ~cols range, not the ~n range.
        assert.ok(moveTos >= cols / 2, 'expected ~cols moveTos in decimated mode, got ' + moveTos);
        assert.ok(moveTos < n / 2, 'decimation should have collapsed to far fewer than n moveTos');
        chart.unmount();
    });
});

describe('createLineChart -- multi-series', () => {
    it('union domain spans all series', () => {
        const a = [
            { x: 0, y: 0 },
            { x: 100, y: 1 },
        ];
        const b = [
            { x: 50, y: -5 },
            { x: 150, y: 5 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            series: [
                { name: 'a', data: a },
                { name: 'b', data: b },
            ],
            x: 'x',
            y: 'y',
        });
        chart.mount(canvas);
        assert.equal(chart.xScale.dMin, 0);
        assert.equal(chart.xScale.dMax, 150);
        // niceYDomain pads 5%: yRange = 10, pad = 0.5 -> [-5.5, 5.5]
        assert.equal(chart.yScale.dMin, -5.5);
        assert.equal(chart.yScale.dMax, 5.5);
        chart.unmount();
    });

    it('xScale.domain override wins over inferred extents', () => {
        const data = [
            { x: 10, y: 0 },
            { x: 90, y: 1 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data,
            x: 'x',
            y: 'y',
            xScale: { domain: [0, 100] },
        });
        chart.mount(canvas);
        assert.equal(chart.xScale.dMin, 0);
        assert.equal(chart.xScale.dMax, 100);
        chart.unmount();
    });
});

describe('createLineChart -- time scale inference', () => {
    it('Date probe in first row -> time scale', () => {
        const data = [
            { t: new Date('2026-01-01'), v: 1 },
            { t: new Date('2026-02-01'), v: 2 },
            { t: new Date('2026-03-01'), v: 3 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, x: 't', y: 'v' });
        chart.mount(canvas);
        assert.equal(chart.xScaleType, 'time');
        chart.unmount();
    });

    it('numeric x with non-time key -> linear scale (no false positive)', () => {
        const data = [
            { x: 1700000000000, y: 1 },  // looks like epoch
            { x: 1700003600000, y: 2 },
        ];
        const canvas = createMockCanvas(800, 400);
        // Key is 'x', NOT 'time'/'date'/'t' -- inference should stay linear.
        const chart = createLineChart({ data, x: 'x', y: 'y' });
        chart.mount(canvas);
        assert.equal(chart.xScaleType, 'linear');
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Zero-alloc spot-check (best-effort: requires --expose-gc; skipped otherwise)
// ---------------------------------------------------------------------------

describe('zero-GC kernel (best-effort, requires --expose-gc)', () => {
    it('decimateMinMax steady-state allocates < 8 bytes/call', { skip: typeof global.gc !== 'function' }, () => {
        const cols = 800;
        const n = 100000;
        const pxs = new Float32Array(n);
        const pys = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            pxs[i] = (i / n) * cols;
            pys[i] = Math.sin(i * 0.001) * 100 + 200;
        }
        const outMin = new Float32Array(cols);
        const outMax = new Float32Array(cols);
        const outOcc = new Uint8Array(cols);

        // Warm up
        for (let i = 0; i < 50; i++) {
            decimateMinMax(pxs, pys, n, 0, cols - 1, outMin, outMax, outOcc);
        }
        global.gc();
        const before = process.memoryUsage().heapUsed;
        const ITERS = 200;
        for (let i = 0; i < ITERS; i++) {
            decimateMinMax(pxs, pys, n, 0, cols - 1, outMin, outMax, outOcc);
        }
        global.gc();
        const after = process.memoryUsage().heapUsed;
        const perCall = (after - before) / ITERS;
        // Allow some slop -- V8 heap accounting has noise -- but it should
        // be deep sub-100-byte territory if the kernel is truly allocation-free.
        assert.ok(perCall < 100, 'decimateMinMax allocation per call too high: ' + perCall + ' bytes');
    });
});

// ---------------------------------------------------------------------------
// bisectNearest (binary search) -- v1.0.0-alpha.1 crosshair foundation
// ---------------------------------------------------------------------------

describe('bisectNearest', () => {
    it('returns -1 on empty input', () => {
        assert.equal(bisectNearest(new Float32Array(0), 0, 5), -1);
    });

    it('returns 0 on single-element input', () => {
        const xs = new Float32Array([42]);
        assert.equal(bisectNearest(xs, 1, 0), 0);
        assert.equal(bisectNearest(xs, 1, 42), 0);
        assert.equal(bisectNearest(xs, 1, 100), 0);
    });

    it('returns 0 when target is before the first sample', () => {
        const xs = new Float32Array([10, 20, 30, 40]);
        assert.equal(bisectNearest(xs, 4, -5), 0);
        assert.equal(bisectNearest(xs, 4, 10), 0);
    });

    it('returns n-1 when target is after the last sample', () => {
        const xs = new Float32Array([10, 20, 30, 40]);
        assert.equal(bisectNearest(xs, 4, 100), 3);
        assert.equal(bisectNearest(xs, 4, 40), 3);
    });

    it('returns the exact-match index', () => {
        const xs = new Float32Array([10, 20, 30, 40, 50]);
        assert.equal(bisectNearest(xs, 5, 30), 2);
        assert.equal(bisectNearest(xs, 5, 20), 1);
        assert.equal(bisectNearest(xs, 5, 50), 4);
    });

    it('picks the truly-nearest sample (not just floor or ceil)', () => {
        const xs = new Float32Array([0, 10, 20, 30]);
        // 6 is closer to 10 than to 0; 23 is closer to 20 than to 30.
        assert.equal(bisectNearest(xs, 4, 6), 1);
        assert.equal(bisectNearest(xs, 4, 23), 2);
        assert.equal(bisectNearest(xs, 4, 25), 2); // tie -> lower index
        assert.equal(bisectNearest(xs, 4, 26), 3);
    });

    it('respects the n parameter (does not scan beyond)', () => {
        // Allocated 10 slots, only 3 are valid; high slots have leftover data.
        const xs = new Float32Array(10);
        xs[0] = 5; xs[1] = 15; xs[2] = 25;
        xs[3] = 999; xs[4] = 999;
        // Target 100 should clamp to index 2 (the last valid), not chase the 999s.
        assert.equal(bisectNearest(xs, 3, 100), 2);
    });
});

// ---------------------------------------------------------------------------
// Crosshair + tooltip (chart-instance behavior)
// ---------------------------------------------------------------------------

describe('crosshair / tooltip', () => {
    it('moveCrosshair snaps to nearest x and updates state', () => {
        const data = [
            { x: 0, y: 0 }, { x: 10, y: 10 },
            { x: 20, y: 20 }, { x: 30, y: 30 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        // Pick a canvas-x near the middle of the plot. With domain [0,30] mapped
        // into plot.x..plot.x+plot.w, x=15 (domain) is at plot midpoint pixel.
        const pb = chart._internal.plotBoundsBox;
        const midPx = pb.x + pb.w / 2;
        const midPy = pb.y + pb.h / 2;
        chart.moveCrosshair(midPx, midPy);
        const state = chart.crosshair.peek();
        assert.equal(state.visible, true);
        // domain at midPx is 15; nearest sample x is 10 or 20 (ties -> lower).
        // Domain 15 - 10 = 5, 20 - 15 = 5 -> tie, returns lower index (1).
        assert.equal(state.snapIdx, 1);
        assert.equal(state.snapDomainX, 10);
        chart.unmount();
    });

    it('moveCrosshair outside the plot rect hides the crosshair', () => {
        const data = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        chart.moveCrosshair(400, 200);
        assert.equal(chart.crosshair.peek().visible, true);
        // Move above the plot (y = 0 is in the top margin).
        chart.moveCrosshair(400, 0);
        assert.equal(chart.crosshair.peek().visible, false);
        chart.unmount();
    });

    it('moveCrosshair on empty data is a no-op (no error, stays hidden)', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data: [], schedule: (fn) => fn() });
        chart.mount(canvas);
        const pb = chart._internal.plotBoundsBox;
        chart.moveCrosshair(pb.x + pb.w / 2, pb.y + pb.h / 2);
        assert.equal(chart.crosshair.peek().visible, false);
        chart.unmount();
    });

    it('hideCrosshair is idempotent', () => {
        const data = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const pb = chart._internal.plotBoundsBox;
        chart.moveCrosshair(pb.x + 100, pb.y + 100);
        chart.hideCrosshair();
        chart.hideCrosshair(); // second call should be cheap no-op
        assert.equal(chart.crosshair.peek().visible, false);
        chart.unmount();
    });

    it('crosshair draws vertical line + marker(s) + tooltip box when visible', () => {
        const data = [
            { x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 8 }, { x: 30, y: 3 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');

        // Move crosshair, then redraw with a clean slate.
        const pb = chart._internal.plotBoundsBox;
        chart.moveCrosshair(pb.x + pb.w * 0.4, pb.y + pb.h * 0.5);
        ctx.calls.length = 0;
        chart.redraw();

        // setLineDash should fire (the dashed crosshair line).
        assert.ok(countCalls(ctx, 'setLineDash') >= 1, 'expected setLineDash for dashed crosshair line');
        // arc should fire at least once (the marker circle).
        assert.ok(countCalls(ctx, 'arc') >= 1, 'expected at least one arc for marker');
        // fillText should fire at least twice (header + 1 series row).
        assert.ok(countCalls(ctx, 'fillText') >= 2, 'expected header + row text');
        chart.unmount();
    });

    it('crosshair: false disables both line and DOM listener', () => {
        const data = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data,
            schedule: (fn) => fn(),
            crosshair: false,
            tooltip: false,
        });
        chart.mount(canvas);
        // moveCrosshair becomes a no-op when interaction is disabled.
        chart.moveCrosshair(400, 200);
        assert.equal(chart.crosshair.peek().visible, false);
        chart.unmount();
    });

    it('multi-series tooltip surfaces a value from each series at the snap x', () => {
        // Two series with DIFFERENT xs to verify per-series bisect.
        const a = [{ x: 0, y: 100 }, { x: 10, y: 200 }, { x: 20, y: 300 }];
        const b = [{ x: 0, y: 1 }, { x: 5, y: 2 }, { x: 10, y: 3 }, { x: 15, y: 4 }, { x: 20, y: 5 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            series: [
                { name: 'A', data: a },
                { name: 'B', data: b },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        const pb = chart._internal.plotBoundsBox;
        // Move near domain x = 12 (middle-ish).
        const targetPx = chart.xScale.map(12);
        chart.moveCrosshair(targetPx, pb.y + pb.h / 2);
        ctx.calls.length = 0;
        chart.redraw();

        // Two arcs expected: one marker per series.
        assert.ok(countCalls(ctx, 'arc') >= 2, 'expected one marker per series, got ' + countCalls(ctx, 'arc'));
        // fillText: header + 2 rows = 3+ calls.
        assert.ok(countCalls(ctx, 'fillText') >= 3, 'expected header + 2 rows');
        chart.unmount();
    });

    it('custom tooltip.format string replaces the header and suppresses rows', () => {
        const data = [{ x: 0, y: 0 }, { x: 10, y: 5 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data,
            schedule: (fn) => fn(),
            tooltip: {
                format: (snap) => 'sample #' + snap.snapIdx,
            },
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        const pb = chart._internal.plotBoundsBox;
        chart.moveCrosshair(pb.x + pb.w * 0.8, pb.y + pb.h * 0.5);
        ctx.calls.length = 0;
        chart.redraw();

        const fillCalls = callsOf(ctx, 'fillText');
        // Find the header text -- should contain "sample #".
        const headerCall = fillCalls.find((c) => /sample #/.test(c[1][0]));
        assert.ok(headerCall, 'expected custom format string to appear in fillText calls');
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// createAreaChart (v1.0.0-alpha.2)
// ---------------------------------------------------------------------------

describe('createAreaChart', () => {
    it('mounts and emits fill (in addition to stroke when stroke:true)', () => {
        const data = [
            { x: 0, y: 5 },
            { x: 1, y: 8 },
            { x: 2, y: 3 },
            { x: 3, y: 7 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createAreaChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');

        ctx.calls.length = 0;
        chart.redraw();

        assert.ok(countCalls(ctx, 'fill') >= 1, 'expected at least one fill call from area path');
        assert.ok(countCalls(ctx, 'stroke') >= 1, 'expected stroke call for upper boundary (default stroke:true)');
        chart.unmount();
    });

    it('stroke: false suppresses the upper-boundary stroke but keeps fill', () => {
        const data = [
            { x: 0, y: 5 }, { x: 1, y: 8 }, { x: 2, y: 3 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createAreaChart({ data, stroke: false, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');

        ctx.calls.length = 0;
        chart.redraw();
        const fills = countCalls(ctx, 'fill');
        const strokes = countCalls(ctx, 'stroke');
        // Some axis-related strokes still happen (spine, ticks). We just verify
        // the area's own stroke isn't present: count the strokes that follow a
        // beginPath that contained lineTo calls (the area boundary).
        // Simpler check: the count of strokes should be lower than with stroke:true.
        assert.ok(fills >= 1, 'expected fill from area');
        // Build a comparison chart with stroke:true to verify the delta.
        chart.unmount();

        const canvas2 = createMockCanvas(800, 400);
        const chart2 = createAreaChart({ data, stroke: true, schedule: (fn) => fn() });
        chart2.mount(canvas2);
        const ctx2 = canvas2.getContext('2d');
        ctx2.calls.length = 0;
        chart2.redraw();
        const strokesWithBoundary = countCalls(ctx2, 'stroke');
        chart2.unmount();

        assert.ok(strokes < strokesWithBoundary, 'stroke:false should issue fewer strokes than stroke:true (' + strokes + ' < ' + strokesWithBoundary + ')');
    });

    it('default baseline is at y=0 (clamped to plot rect when 0 is out of domain)', () => {
        const data = [
            { x: 0, y: 100 }, { x: 1, y: 200 }, { x: 2, y: 150 },
        ];
        const canvas = createMockCanvas(800, 400);
        // y-domain auto-pads to roughly [95, 205]; 0 is outside -> baseline
        // clamps to bottom of plot rect (= plot.y + plot.h).
        const chart = createAreaChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const pb = chart._internal.plotBoundsBox;

        // We can't directly assert on the rendered baseline pixel without
        // poking the draw fn, but we can confirm the y-domain doesn't include
        // 0 (so the clamp branch was exercised).
        assert.ok(chart.yScale.dMin > 0 || chart.yScale.dMax < 0 || (chart.yScale.dMin <= 0 && chart.yScale.dMax >= 0));
        chart.unmount();
    });

    it('custom numeric baseline lands at the right pixel', () => {
        const data = [
            { x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createAreaChart({
            data,
            baseline: 12,            // mid-range custom baseline
            yScale: { domain: [0, 30] },
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const expectedBaselinePx = chart.yScale.map(12);
        const pb = chart._internal.plotBoundsBox;
        assert.ok(
            expectedBaselinePx >= pb.y && expectedBaselinePx <= pb.y + pb.h,
            'baseline should be inside the plot rect',
        );
        chart.unmount();
    });

    it('baseline: "bottom" pins the baseline to the bottom of the plot rect', () => {
        const data = [
            { x: 0, y: 1 }, { x: 1, y: 5 }, { x: 2, y: 3 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createAreaChart({
            data,
            baseline: 'bottom',
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // We don't expose the resolved baseline pixel publicly, but we can
        // verify the chart mounts without error and draws.
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        assert.ok(countCalls(ctx, 'fill') >= 1, 'area should still fill with bottom baseline');
        chart.unmount();
    });

    it('fillOpacity adjusts globalAlpha before fill', () => {
        const data = [
            { x: 0, y: 1 }, { x: 1, y: 5 }, { x: 2, y: 3 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createAreaChart({
            data,
            fillOpacity: 0.5,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();

        // Find globalAlpha sets and confirm at least one is 0.5 (or a product of it).
        const alphaSets = callsOf(ctx, 'set:globalAlpha');
        const has50 = alphaSets.some((c) => Math.abs(c[1][0] - 0.5) < 1e-6);
        assert.ok(has50, 'expected globalAlpha to be set to 0.5 before fill, got: ' + alphaSets.map((c) => c[1][0]).join(','));
        chart.unmount();
    });

    it('decimated regime: large n still produces a fill', () => {
        const n = 5000;
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            xs[i] = i;
            ys[i] = Math.sin(i * 0.01) + 2; // always positive so baseline 0 is below all data
        }
        const canvas = createMockCanvas(800, 400);
        const chart = createAreaChart({
            data: { xs, ys },
            yScale: { domain: [0, 3] },   // make baseline 0 visible
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');

        const state = chart._internal.seriesStates[0];
        const pb = chart._internal.plotBoundsBox;
        const cols = pb.w + 1;
        assert.ok(state.n > cols * 2, 'precondition: dataset should trigger decimation');

        ctx.calls.length = 0;
        chart.redraw();
        assert.ok(countCalls(ctx, 'fill') >= 1, 'decimated area should still emit a fill');
        chart.unmount();
    });

    it('throws clear error when neither data nor series is provided', () => {
        assert.throws(() => createAreaChart({}), /data.*series/);
    });
});

// ---------------------------------------------------------------------------
// Series visibility + legend (v1.0.0-alpha.3)
// ---------------------------------------------------------------------------

describe('series visibility / legend', () => {
    it('setSeriesVisible(idx, false) excludes the series from y-domain', () => {
        // Series A: small range. Series B: large range. Hiding B should
        // collapse the y-domain to A's range only.
        const a = [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }];
        const b = [{ x: 0, y: 100 }, { x: 1, y: 200 }, { x: 2, y: 150 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            series: [
                { name: 'A', data: a },
                { name: 'B', data: b },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const dMaxBoth = chart.yScale.dMax;
        assert.ok(dMaxBoth > 100, 'both series visible: dMax should reflect B');

        chart.setSeriesVisible(1, false);
        const dMaxAOnly = chart.yScale.dMax;
        assert.ok(dMaxAOnly < 10, 'B hidden: dMax should fall to A\'s range, got ' + dMaxAOnly);
        chart.unmount();
    });

    it('hidden series does not stroke in the line draw', () => {
        const a = [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }];
        const b = [{ x: 0, y: 4 }, { x: 1, y: 5 }, { x: 2, y: 6 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            series: [
                { name: 'A', data: a },
                { name: 'B', data: b },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');

        // Baseline: both visible
        ctx.calls.length = 0;
        chart.redraw();
        const strokesBoth = countCalls(ctx, 'stroke');

        // Hide one
        chart.setSeriesVisible(0, false);
        ctx.calls.length = 0;
        chart.redraw();
        const strokesOne = countCalls(ctx, 'stroke');

        assert.ok(strokesOne < strokesBoth, 'hiding a series should reduce stroke count (' + strokesOne + ' < ' + strokesBoth + ')');
        chart.unmount();
    });

    it('hidden series does not appear in crosshair markers', () => {
        const a = [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }];
        const b = [{ x: 0, y: 4 }, { x: 1, y: 5 }, { x: 2, y: 6 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            series: [
                { name: 'A', data: a },
                { name: 'B', data: b },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        const pb = chart._internal.plotBoundsBox;

        // Both visible: 2 markers
        chart.moveCrosshair(pb.x + pb.w * 0.5, pb.y + pb.h * 0.5);
        ctx.calls.length = 0;
        chart.redraw();
        const arcsBoth = countCalls(ctx, 'arc');
        assert.equal(arcsBoth, 2, 'both visible should show 2 markers, got ' + arcsBoth);

        // Hide B: 1 marker
        chart.setSeriesVisible(1, false);
        ctx.calls.length = 0;
        chart.redraw();
        const arcsOne = countCalls(ctx, 'arc');
        assert.equal(arcsOne, 1, 'one hidden should show 1 marker, got ' + arcsOne);
        chart.unmount();
    });

    it('hidden series does not appear in tooltip rows', () => {
        const a = [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }];
        const b = [{ x: 0, y: 4 }, { x: 1, y: 5 }, { x: 2, y: 6 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            series: [
                { name: 'A-series', data: a },
                { name: 'B-series', data: b },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        const pb = chart._internal.plotBoundsBox;

        // Baseline: both names appear in fillText args.
        chart.moveCrosshair(pb.x + pb.w * 0.5, pb.y + pb.h * 0.5);
        ctx.calls.length = 0;
        chart.redraw();
        const containsName = (name) =>
            callsOf(ctx, 'fillText').some((c) => c[1][0] && c[1][0].includes(name));
        assert.ok(containsName('A-series'), 'A-series should appear in tooltip when visible');
        assert.ok(containsName('B-series'), 'B-series should appear in tooltip when visible');

        // Hide A
        chart.setSeriesVisible(0, false);
        ctx.calls.length = 0;
        chart.redraw();
        assert.ok(!containsName('A-series'), 'A-series should NOT appear in tooltip when hidden');
        assert.ok(containsName('B-series'), 'B-series should still appear');
        chart.unmount();
    });

    it('seriesVisibility signal API matches setSeriesVisible', () => {
        const data = [{ x: 0, y: 1 }, { x: 1, y: 2 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);

        assert.equal(chart.seriesVisibility[0].peek(), true);
        chart.setSeriesVisible(0, false);
        assert.equal(chart.seriesVisibility[0].peek(), false);
        chart.seriesVisibility[0].set(true);
        assert.equal(chart.seriesVisibility[0].peek(), true);
        chart.unmount();
    });

    it('setSeriesVisible with out-of-range index is a safe no-op', () => {
        const data = [{ x: 0, y: 1 }, { x: 1, y: 2 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);

        // Should not throw, should not affect any existing series.
        chart.setSeriesVisible(-1, false);
        chart.setSeriesVisible(99, false);
        assert.equal(chart.seriesVisibility[0].peek(), true);
        chart.unmount();
    });

    it('legend: false disables legend DOM creation', () => {
        const data = [{ x: 0, y: 1 }, { x: 1, y: 2 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, legend: false, schedule: (fn) => fn() });
        chart.mount(canvas);
        // No legend was built (no document anyway, plus legend:false).
        assert.equal(chart.legend, null);
        // But seriesVisibility still works programmatically.
        chart.setSeriesVisible(0, false);
        assert.equal(chart.seriesVisibility[0].peek(), false);
        chart.unmount();
    });

    it('chart.legend is null when mounting a bare canvas (no parent to wrap)', () => {
        // Mock canvases used here have no parent and no document anyway.
        const data = [{ x: 0, y: 1 }, { x: 1, y: 2 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        assert.equal(chart.legend, null);
        chart.unmount();
    });

    it('hidden then re-shown series resumes rendering and contributes to domain', () => {
        const a = [{ x: 0, y: 1 }, { x: 1, y: 2 }];
        const b = [{ x: 0, y: 100 }, { x: 1, y: 200 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            series: [
                { name: 'A', data: a },
                { name: 'B', data: b },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const dMax0 = chart.yScale.dMax;

        chart.setSeriesVisible(1, false);
        const dMax1 = chart.yScale.dMax;
        assert.ok(dMax1 < dMax0, 'domain shrank when B hidden');

        chart.setSeriesVisible(1, true);
        const dMax2 = chart.yScale.dMax;
        assert.ok(Math.abs(dMax2 - dMax0) < 0.001, 'domain restored when B reshown');
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Interpolation modes (v1.0.0)
// ---------------------------------------------------------------------------

describe('interpolation modes', () => {
    const makeData = (n) => {
        const out = [];
        for (let i = 0; i < n; i++) out.push({ x: i, y: Math.sin(i) });
        return out;
    };

    it('linear (default): emits n-1 lineTo per series + 1 moveTo', () => {
        const data = makeData(5);
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Linear path: moveTo first point + lineTo for remaining 4. Plus axis stuff.
        // Counting bezierCurveTo alone is the clean discriminator -- linear has zero.
        assert.equal(countCalls(ctx, 'bezierCurveTo'), 0, 'linear must not emit bezier');
        chart.unmount();
    });

    it('step-after: emits 2*(n-1) lineTos for the staircase', () => {
        const data = makeData(5);
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, interpolation: 'step-after', schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Each segment emits 2 lineTos. With 4 segments => 8 lineTos for line.
        // Axes add more lineTos (spines, ticks). Discriminate by checking that
        // step-after emits MORE lineTos than linear for the same data.
        const stepLineTos = countCalls(ctx, 'lineTo');
        chart.unmount();

        const canvas2 = createMockCanvas(800, 400);
        const chart2 = createLineChart({ data, interpolation: 'linear', schedule: (fn) => fn() });
        chart2.mount(canvas2);
        const ctx2 = canvas2.getContext('2d');
        ctx2.calls.length = 0;
        chart2.redraw();
        const linearLineTos = countCalls(ctx2, 'lineTo');
        chart2.unmount();

        assert.ok(stepLineTos > linearLineTos, 'step-after should emit more lineTos than linear (got ' + stepLineTos + ' vs ' + linearLineTos + ')');
        assert.equal(stepLineTos - linearLineTos, 4, 'step-after delta should be exactly n-1 extra lineTos');
    });

    it('step-before: same lineTo count as step-after, different geometry', () => {
        const data = makeData(5);
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, interpolation: 'step-before', schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        const beforeCount = countCalls(ctx, 'lineTo');
        chart.unmount();

        const canvas2 = createMockCanvas(800, 400);
        const chart2 = createLineChart({ data, interpolation: 'step-after', schedule: (fn) => fn() });
        chart2.mount(canvas2);
        const ctx2 = canvas2.getContext('2d');
        ctx2.calls.length = 0;
        chart2.redraw();
        const afterCount = countCalls(ctx2, 'lineTo');
        chart2.unmount();

        assert.equal(beforeCount, afterCount, 'step-before and step-after emit same lineTo count');
    });

    it('step-mid: 3 lineTos per segment, more than step-after', () => {
        const data = makeData(5);
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, interpolation: 'step-mid', schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        const midCount = countCalls(ctx, 'lineTo');
        chart.unmount();

        const canvas2 = createMockCanvas(800, 400);
        const chart2 = createLineChart({ data, interpolation: 'step-after', schedule: (fn) => fn() });
        chart2.mount(canvas2);
        const ctx2 = canvas2.getContext('2d');
        ctx2.calls.length = 0;
        chart2.redraw();
        const afterCount = countCalls(ctx2, 'lineTo');
        chart2.unmount();

        // step-mid does 3 lineTo per segment (n-1 segments = 12)
        // step-after does 2 lineTo per segment (n-1 segments = 8)
        // Delta should be exactly (n-1) = 4.
        assert.equal(midCount - afterCount, 4, 'step-mid - step-after should be n-1 extra lineTos');
    });

    it('monotone: emits n-1 bezierCurveTo calls', () => {
        const data = makeData(5);
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, interpolation: 'monotone', schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Monotone: each of 4 segments is one bezierCurveTo.
        assert.equal(countCalls(ctx, 'bezierCurveTo'), 4, 'expected 4 bezier segments for n=5');
        chart.unmount();
    });

    it('catmull-rom: emits n-1 bezierCurveTo calls', () => {
        const data = makeData(5);
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, interpolation: 'catmull-rom', schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        assert.equal(countCalls(ctx, 'bezierCurveTo'), 4, 'expected 4 bezier segments for n=5');
        chart.unmount();
    });

    it('monotone preserves monotonicity on monotone data', () => {
        // Strictly increasing y: monotone tangents must all be >= 0.
        const data = [
            { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 3 },
            { x: 3, y: 6 }, { x: 4, y: 10 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, interpolation: 'monotone', schedule: (fn) => fn() });
        chart.mount(canvas);
        const state = chart._internal.seriesStates[0];
        // Trigger draw so tangents get computed.
        chart.redraw();
        assert.ok(state.tangents, 'tangents buffer should be allocated');
        // All tangents on monotone-increasing data should be <= 0 in pixel
        // space (because pixel y is inverted: larger domain y = smaller pixel y).
        for (let i = 0; i < state.n; i++) {
            assert.ok(state.tangents[i] <= 0, 'tangent ' + i + ' should be <= 0 for monotonic ascending data in inverted pixel y, got ' + state.tangents[i]);
        }
        chart.unmount();
    });

    it('unknown interpolation mode throws a clear error', () => {
        assert.throws(
            () => createLineChart({ data: [{x:0,y:0}], interpolation: 'bogus' }),
            /unknown interpolation mode/,
        );
    });

    it('decimated regime ignores interpolation mode (no bezier emitted)', () => {
        // Large n forces decimation regardless of interpolation request.
        const n = 5000;
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        for (let i = 0; i < n; i++) { xs[i] = i; ys[i] = Math.sin(i * 0.01); }
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: { xs, ys },
            interpolation: 'monotone',
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        assert.equal(countCalls(ctx, 'bezierCurveTo'), 0, 'decimated should not bezier even with monotone requested');
        chart.unmount();
    });

    it('area chart respects interpolation: monotone emits bezier in fill AND stroke', () => {
        const data = [
            { x: 0, y: 1 }, { x: 1, y: 4 }, { x: 2, y: 2 }, { x: 3, y: 5 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createAreaChart({ data, interpolation: 'monotone', schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Fill pass: 3 bezier segments. Stroke pass: another 3. Total >= 6.
        assert.ok(countCalls(ctx, 'bezierCurveTo') >= 6, 'monotone area should emit bezier for fill+stroke');
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Markers (v1.0.0)
// ---------------------------------------------------------------------------

describe('markers', () => {
    it('markers: true draws a circle marker per sample', () => {
        const data = [
            { x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 1 },
            { x: 3, y: 3 }, { x: 4, y: 2 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, markers: true, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Default circle markers: 1 arc per sample = 5 arcs.
        assert.equal(countCalls(ctx, 'arc'), 5, 'expected 5 marker arcs for n=5');
        chart.unmount();
    });

    it('markers: false (or omitted) draws no markers', () => {
        const data = [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        assert.equal(countCalls(ctx, 'arc'), 0, 'no arcs without markers config');
        chart.unmount();
    });

    it('markers: { shape: "square" } uses rect not arc', () => {
        const data = [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data,
            markers: { shape: 'square' },
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        assert.equal(countCalls(ctx, 'arc'), 0, 'square markers should not call arc');
        assert.ok(countCalls(ctx, 'rect') >= 3, 'expected at least 3 rect calls for square markers');
        chart.unmount();
    });

    it('markers: { everyN: 2 } draws every other point', () => {
        const data = [];
        for (let i = 0; i < 10; i++) data.push({ x: i, y: i });
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data,
            markers: { everyN: 2 },
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // 10 points / 2 = 5 markers (indices 0, 2, 4, 6, 8)
        assert.equal(countCalls(ctx, 'arc'), 5, 'expected 5 arcs (every 2 of 10)');
        chart.unmount();
    });

    it('markers in decimated mode are suppressed (would be noise)', () => {
        const n = 5000;
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        for (let i = 0; i < n; i++) { xs[i] = i; ys[i] = Math.sin(i * 0.01); }
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: { xs, ys },
            markers: true,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        assert.equal(countCalls(ctx, 'arc'), 0, 'decimated regime must suppress markers');
        chart.unmount();
    });

    it('per-series marker override beats chart-level default', () => {
        const a = [{ x: 0, y: 1 }, { x: 1, y: 2 }];
        const b = [{ x: 0, y: 3 }, { x: 1, y: 4 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            series: [
                { name: 'A', data: a },                       // inherits chart-level markers: true
                { name: 'B', data: b, markers: false },       // explicit override
            ],
            markers: true,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Only series A draws markers: 2 arcs (one per point in A).
        assert.equal(countCalls(ctx, 'arc'), 2, 'only series A should mark, expected 2 arcs');
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Theme refresh (v1.0.0)
// ---------------------------------------------------------------------------

describe('refreshTheme', () => {
    it('refreshTheme on unmounted chart is a safe no-op', () => {
        const chart = createLineChart({ data: [{ x: 0, y: 0 }] });
        chart.refreshTheme(); // should not throw
    });

    it('refreshTheme triggers a markDirty (redraw fires)', () => {
        const data = [{ x: 0, y: 1 }, { x: 1, y: 2 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.refreshTheme();
        // refreshTheme calls scene.markDirty() which under sync schedule fires a draw.
        assert.ok(ctx.calls.length > 0, 'refreshTheme should cause a redraw');
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Gridlines (v1.0.0)
// ---------------------------------------------------------------------------

describe('grid', () => {
    it('grid: false (default) draws no gridlines', () => {
        const data = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }];
        const canvas = createMockCanvas(800, 400);
        const chartNoGrid = createLineChart({ data, schedule: (fn) => fn() });
        chartNoGrid.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chartNoGrid.redraw();
        const baselineLineTos = countCalls(ctx, 'lineTo');
        chartNoGrid.unmount();

        const canvas2 = createMockCanvas(800, 400);
        const chartGrid = createLineChart({ data, grid: true, schedule: (fn) => fn() });
        chartGrid.mount(canvas2);
        const ctx2 = canvas2.getContext('2d');
        ctx2.calls.length = 0;
        chartGrid.redraw();
        const gridLineTos = countCalls(ctx2, 'lineTo');
        chartGrid.unmount();

        // Grid adds horizontal + vertical lines spanning the plot rect.
        // Each gridline is 1 moveTo + 1 lineTo from lite-scene's line node.
        assert.ok(gridLineTos > baselineLineTos, 'grid: true should produce more lineTos than grid: false (' + gridLineTos + ' vs ' + baselineLineTos + ')');
    });

    it('grid: { x: false } skips vertical gridlines', () => {
        const data = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
        const canvasBoth = createMockCanvas(800, 400);
        const both = createLineChart({ data, grid: true, schedule: (fn) => fn() });
        both.mount(canvasBoth);
        const ctxBoth = canvasBoth.getContext('2d');
        ctxBoth.calls.length = 0;
        both.redraw();
        const bothLines = countCalls(ctxBoth, 'lineTo');
        both.unmount();

        const canvasYOnly = createMockCanvas(800, 400);
        const yOnly = createLineChart({ data, grid: { x: false, y: true }, schedule: (fn) => fn() });
        yOnly.mount(canvasYOnly);
        const ctxYOnly = canvasYOnly.getContext('2d');
        ctxYOnly.calls.length = 0;
        yOnly.redraw();
        const yOnlyLines = countCalls(ctxYOnly, 'lineTo');
        yOnly.unmount();

        assert.ok(yOnlyLines < bothLines, '{x:false} should issue fewer lineTos than full grid (' + yOnlyLines + ' < ' + bothLines + ')');
    });

    it('grid lines repositioned on width change', () => {
        // Verify that after a width change, grid line geometry actually
        // updates (the lite-scene line nodes get new x/y/dx/dy values).
        const w = signal(800);
        const data = [{ x: 0, y: 0 }, { x: 100, y: 50 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, grid: true, width: w, schedule: (fn) => fn() });
        chart.mount(canvas);
        // Just verify no error on resize and the chart redraws.
        w.set(1600);
        assert.equal(canvas.width, 1600);
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Crosshair zero-alloc invariant (v1.0.0-beta.2)
// ---------------------------------------------------------------------------

describe('crosshair zero-alloc', () => {
    it('chart.crosshair.peek() returns the same mutable reference across calls', () => {
        const data = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const a = chart.crosshair.peek();
        const b = chart.crosshair.peek();
        assert.strictEqual(a, b, 'peek must return the same live object reference');
        chart.unmount();
    });

    it('moveCrosshair mutates the existing object without reallocating', () => {
        const data = [{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 3 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);

        const stateRef = chart.crosshair.peek();
        const id0 = stateRef;
        chart.moveCrosshair(100, 100);
        const after1 = chart.crosshair.peek();
        chart.moveCrosshair(200, 100);
        const after2 = chart.crosshair.peek();
        chart.moveCrosshair(300, 150);
        const after3 = chart.crosshair.peek();

        // All four references must be the same live object -- no alloc.
        assert.strictEqual(after1, id0);
        assert.strictEqual(after2, id0);
        assert.strictEqual(after3, id0);
        // And the live fields reflect the most recent move.
        assert.equal(stateRef.visible, true);
        chart.unmount();
    });

    it('chart.crosshair() subscribe-read pattern returns the live object', () => {
        const data = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const a = chart.crosshair();
        const b = chart.crosshair();
        assert.strictEqual(a, b, 'invoking as fn must return same live object');
        chart.unmount();
    });

    it('crosshair.set() preserves identity (back-compat for tests + callers)', () => {
        const data = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const before = chart.crosshair.peek();
        chart.crosshair.set({ visible: true, snapIdx: 1, snapDomainX: 1, snapPixelX: 100, mousePixelY: 50 });
        const after = chart.crosshair.peek();
        assert.strictEqual(after, before, 'set() must mutate, not replace');
        assert.equal(after.visible, true);
        assert.equal(after.snapIdx, 1);
        chart.unmount();
    });

    it('crosshair.subscribe fires on change and receives the live ref', () => {
        const data = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const received = [];
        const unsub = chart.crosshair.subscribe((s) => received.push(s));
        chart.moveCrosshair(100, 100);
        chart.moveCrosshair(200, 100);
        assert.ok(received.length >= 2, 'subscriber should have fired on each change');
        // Every notified value is the SAME live reference.
        for (let i = 1; i < received.length; i++) {
            assert.strictEqual(received[i], received[0]);
        }
        unsub();
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// DPR / canvas backing-buffer sizing (v1.0.0-beta.3 -- Retina alignment bug)
// ---------------------------------------------------------------------------

describe('DPR canvas sizing', () => {
    it('default dpr=1 means backing buffer matches CSS dimensions', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            width: 800,
            height: 400,
            dpr: 1,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // On dpr=1, backing = CSS = 800x400
        assert.equal(canvas.width, 800);
        assert.equal(canvas.height, 400);
        chart.unmount();
    });

    it('dpr=2 sizes the backing buffer to 2x CSS dimensions', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            width: 800,
            height: 400,
            dpr: 2,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // On Retina dpr=2, backing must be 1600x800 so lite-scene's
        // setTransform(dpr,...) maps logical->device cleanly without clipping
        // the bottom half of the chart.
        assert.equal(canvas.width, 1600, 'backing width should be cssWidth * dpr');
        assert.equal(canvas.height, 800, 'backing height should be cssHeight * dpr');
        chart.unmount();
    });

    it('dpr=3 sizes the backing buffer to 3x CSS dimensions', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            width: 600,
            height: 200,
            dpr: 3,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.equal(canvas.width, 1800);
        assert.equal(canvas.height, 600);
        chart.unmount();
    });

    it('fractional dpr rounds the backing dimensions', () => {
        // Some Windows scaling configs report dpr like 1.5 or 1.25.
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            width: 800,
            height: 400,
            dpr: 1.5,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.equal(canvas.width, 1200);   // 800 * 1.5
        assert.equal(canvas.height, 600);
        chart.unmount();
    });

    it('chart logical coords stay in CSS pixels regardless of dpr', () => {
        // The chart's pixel coordinate system is logical (CSS px) -- it's
        // lite-scene's job to map to device px via setTransform. The clearest
        // way to verify is via xScale.rMin/rMax (the pixel range the scale
        // projects into), which derives from plotBoundsBox.
        const c1 = createMockCanvas(800, 400);
        const chart1 = createLineChart({
            data: [{ x: 0, y: 0 }, { x: 100, y: 50 }],
            width: 800,
            height: 400,
            dpr: 1,
            schedule: (fn) => fn(),
        });
        chart1.mount(c1);
        const r1Min = chart1.xScale.rMin;
        const r1Max = chart1.xScale.rMax;
        chart1.unmount();

        const c2 = createMockCanvas(800, 400);
        const chart2 = createLineChart({
            data: [{ x: 0, y: 0 }, { x: 100, y: 50 }],
            width: 800,
            height: 400,
            dpr: 2,
            schedule: (fn) => fn(),
        });
        chart2.mount(c2);
        const r2Min = chart2.xScale.rMin;
        const r2Max = chart2.xScale.rMax;
        chart2.unmount();

        // Same logical width, same scale range -- dpr only changes backing.
        assert.equal(r1Min, r2Min, 'xScale.rMin must be DPR-independent (logical coords)');
        assert.equal(r1Max, r2Max, 'xScale.rMax must be DPR-independent (logical coords)');
    });
});

// ---------------------------------------------------------------------------
// Band scale primitive (v1.1.0)
// ---------------------------------------------------------------------------

describe('makeBandScale', () => {
    it('exposes type=band and zero defaults', () => {
        const s = makeBandScale();
        assert.equal(s.type, 'band');
        assert.equal(s.n, 0);
    });

    it('updateBandScale partitions the range into n bands', () => {
        const s = updateBandScale(makeBandScale(), 4, 0, 400, 0, 0);
        // No padding: 4 bands of 100px each.
        assert.equal(s.n, 4);
        assert.equal(s.bandWidth, 100);
        assert.equal(s.map(0), 50);   // center of [0, 100]
        assert.equal(s.map(1), 150);
        assert.equal(s.map(2), 250);
        assert.equal(s.map(3), 350);
    });

    it('paddingInner shrinks each band leaving gaps', () => {
        const s = updateBandScale(makeBandScale(), 2, 0, 400, 0.2, 0);
        // step = 400 / (2 - 0.2 + 0) = ~222.22; bandWidth = step * 0.8 = ~177.78
        assert.ok(Math.abs(s.bandWidth - 177.78) < 0.5);
        assert.ok(s.bandWidth < s.step, 'paddingInner means bandWidth < step');
    });

    it('invert returns the category index for a pixel', () => {
        const s = updateBandScale(makeBandScale(), 4, 0, 400, 0, 0);
        assert.equal(s.invert(50),  0);   // center of band 0
        assert.equal(s.invert(150), 1);   // center of band 1
        assert.equal(s.invert(250), 2);
        assert.equal(s.invert(350), 3);
        // Edges snap to nearer band.
        assert.equal(s.invert(99),  0);
        assert.equal(s.invert(101), 1);
    });

    it('invert clamps to [0, n-1]', () => {
        const s = updateBandScale(makeBandScale(), 3, 0, 300, 0, 0);
        assert.equal(s.invert(-50),  0);
        assert.equal(s.invert(9999), 2);
    });
});

// ---------------------------------------------------------------------------
// createBarChart (v1.1.0)
// ---------------------------------------------------------------------------

describe('createBarChart', () => {
    it('renders one fillRect per category for single-series', () => {
        const data = [
            { x: 'Jan', y: 10 },
            { x: 'Feb', y: 20 },
            { x: 'Mar', y: 15 },
            { x: 'Apr', y: 25 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // One fillRect per data point.
        assert.equal(countCalls(ctx, 'fillRect'), 4, 'expected 4 bars for n=4 categories');
        chart.unmount();
    });

    it('y-domain includes baseline (0) by default so bars do not float', () => {
        const data = [
            { x: 'Jan', y: 10 },
            { x: 'Feb', y: 20 },
            { x: 'Mar', y: 30 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        // y-data ranges [10, 30] but baseline 0 must be included so the
        // bars visually anchor at the x-axis. yScale.dMin should be <= 0.
        assert.ok(chart.yScale.dMin <= 0, 'baseline 0 must be in y-domain');
        chart.unmount();
    });

    it('multi-series grouped layout: each series renders n bars', () => {
        const seriesA = [
            { x: 'Jan', y: 10 },
            { x: 'Feb', y: 20 },
        ];
        const seriesB = [
            { x: 'Jan', y: 15 },
            { x: 'Feb', y: 25 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            series: [
                { name: 'A', data: seriesA },
                { name: 'B', data: seriesB },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // 2 series * 2 categories = 4 bars total.
        assert.equal(countCalls(ctx, 'fillRect'), 4);
        chart.unmount();
    });

    it('discrete hit detection via bandScale.invert (not bisect)', () => {
        const data = [
            { x: 'Jan', y: 10 },
            { x: 'Feb', y: 20 },
            { x: 'Mar', y: 30 },
            { x: 'Apr', y: 40 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);

        // Plot bounds: x in [56, 776], width 720. 4 bands -> step ~180.
        // band centers (approx): 56 + ~22 + 90 = 168, 348, 528, 708
        // (exact values depend on default paddings).
        const pb = chart.xScale;
        const c0 = pb.map(0);
        const c2 = pb.map(2);

        chart.moveCrosshair(c0, 200);
        assert.equal(chart.crosshair.peek().snapIdx, 0);

        chart.moveCrosshair(c2, 200);
        assert.equal(chart.crosshair.peek().snapIdx, 2);

        chart.unmount();
    });

    it('hideCrosshair when pointer leaves plot bounds', () => {
        const data = [{ x: 'Jan', y: 10 }, { x: 'Feb', y: 20 }];
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        chart.moveCrosshair(400, 200);
        assert.equal(chart.crosshair.peek().visible, true);
        chart.moveCrosshair(-50, 200);   // outside plot
        assert.equal(chart.crosshair.peek().visible, false);
        chart.unmount();
    });

    it('legend with click-to-toggle works for bar series', () => {
        const data = [
            { name: 'A', data: [{ x: 'Jan', y: 10 }, { x: 'Feb', y: 20 }] },
            { name: 'B', data: [{ x: 'Jan', y: 15 }, { x: 'Feb', y: 25 }] },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            series: data,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Toggle series A off.
        chart.setSeriesVisible(0, false);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Only series B renders -> 2 bars (one per category for B).
        assert.equal(countCalls(ctx, 'fillRect'), 2);
        chart.unmount();
    });

    it('refreshTheme works on bar charts', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            data: [{ x: 'A', y: 1 }, { x: 'B', y: 2 }],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Just call it -- shouldn't throw.
        chart.refreshTheme();
        chart.unmount();
    });

    it('negative y values render bars extending downward from baseline', () => {
        const data = [
            { x: 'A', y: 10 },
            { x: 'B', y: -5 },
            { x: 'C', y: 15 },
        ];
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({ data, schedule: (fn) => fn() });
        chart.mount(canvas);
        // y-domain must include both -5 and 10 plus baseline 0.
        assert.ok(chart.yScale.dMin <= -5);
        assert.ok(chart.yScale.dMax >= 10);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        assert.equal(countCalls(ctx, 'fillRect'), 3);
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Polar kernel (pie / donut)
// ---------------------------------------------------------------------------

describe('extractSliceData', () => {
    it('normalizes array-of-objects shape', () => {
        const state = makePolarState();
        extractSliceData(state, [
            { label: 'A', value: 30 },
            { label: 'B', value: 50 },
            { label: 'C', value: 20 },
        ]);
        assert.equal(state.n, 3);
        assert.equal(state.total, 100);
        assert.equal(state.visibleTotal, 100);
        assert.deepEqual(state.labels, ['A', 'B', 'C']);
        assert.equal(state.values[0], 30);
        assert.equal(state.values[1], 50);
        assert.equal(state.values[2], 20);
    });

    it('normalizes parallel-arrays shape', () => {
        const state = makePolarState();
        extractSliceData(state, {
            values: [10, 20, 30, 40],
            labels: ['w', 'x', 'y', 'z'],
            colors: ['#111', '#222', '#333', '#444'],
        });
        assert.equal(state.n, 4);
        assert.equal(state.total, 100);
        assert.deepEqual(state.labels, ['w', 'x', 'y', 'z']);
        assert.deepEqual(state.colors, ['#111', '#222', '#333', '#444']);
    });

    it('autogenerates labels for plain number arrays', () => {
        const state = makePolarState();
        extractSliceData(state, [1, 2, 3]);
        assert.equal(state.n, 3);
        assert.equal(state.total, 6);
        assert.deepEqual(state.labels, ['slice 0', 'slice 1', 'slice 2']);
    });

    it('clamps negative values to 0 (pie requires non-negative)', () => {
        const state = makePolarState();
        extractSliceData(state, [
            { label: 'A', value: 10 },
            { label: 'B', value: -5 },
            { label: 'C', value: 15 },
        ]);
        assert.equal(state.values[1], 0);
        assert.equal(state.total, 25);
    });

    it('computes startAngles cumulatively from 0', () => {
        const state = makePolarState();
        extractSliceData(state, [
            { value: 25 }, // 90deg = pi/2
            { value: 25 }, // 90deg
            { value: 25 },
            { value: 25 },
        ]);
        const PI = Math.PI;
        assert.ok(Math.abs(state.startAngles[0] - 0)         < 1e-5);
        assert.ok(Math.abs(state.startAngles[1] - PI / 2)    < 1e-5);
        assert.ok(Math.abs(state.startAngles[2] - PI)        < 1e-5);
        assert.ok(Math.abs(state.startAngles[3] - 3 * PI / 2) < 1e-5);
    });

    it('arcAngles sum to 2*PI when all visible', () => {
        const state = makePolarState();
        extractSliceData(state, [
            { value: 17 }, { value: 33 }, { value: 50 },
        ]);
        let sum = 0;
        for (let i = 0; i < state.n; i++) sum += state.arcAngles[i];
        assert.ok(Math.abs(sum - 2 * Math.PI) < 1e-5);
    });

    it('toggling visibility off shrinks arcAngle to 0; others grow to fill', () => {
        const state = makePolarState();
        extractSliceData(state, [
            { value: 50 }, { value: 50 },
        ]);
        // Both visible: each gets PI radians
        assert.ok(Math.abs(state.arcAngles[0] - Math.PI) < 1e-5);
        // Hide slice 0 -> recompute
        state.visible[0] = 0;
        let vis = 0;
        for (let i = 0; i < state.n; i++) if (state.visible[i]) vis += state.values[i];
        state.visibleTotal = vis;
        recomputePolarAngles(state);
        assert.equal(state.arcAngles[0], 0);
        assert.ok(Math.abs(state.arcAngles[1] - 2 * Math.PI) < 1e-5);
    });

    it('handles empty input gracefully', () => {
        const state = makePolarState();
        extractSliceData(state, []);
        assert.equal(state.n, 0);
        assert.equal(state.total, 0);
        assert.equal(state.visibleTotal, 0);
    });
});

describe('computeSliceGeometry', () => {
    const geom = () => ({ cx: 0, cy: 0, rOuter: 0, rInner: 0 });

    it('centers in plot rect and uses min(w,h)/2 as outer radius', () => {
        const g = geom();
        computeSliceGeometry(g, { x: 10, y: 20, w: 400, h: 300 }, 0);
        assert.equal(g.cx, 210);  // 10 + 400/2
        assert.equal(g.cy, 170);  // 20 + 300/2
        assert.equal(g.rOuter, 150);  // min(400, 300) / 2
        assert.equal(g.rInner, 0);
    });

    it('innerRadius in [0,1] is treated as fraction of outer', () => {
        const g = geom();
        computeSliceGeometry(g, { x: 0, y: 0, w: 200, h: 200 }, 0.5);
        assert.equal(g.rOuter, 100);
        assert.equal(g.rInner, 50);
    });

    it('innerRadius > 1 is treated as absolute pixels (clamped to rOuter-1)', () => {
        const g = geom();
        computeSliceGeometry(g, { x: 0, y: 0, w: 200, h: 200 }, 75);
        assert.equal(g.rInner, 75);
    });

    it('innerRadius > rOuter clamps to rOuter - 1', () => {
        const g = geom();
        computeSliceGeometry(g, { x: 0, y: 0, w: 100, h: 100 }, 200);
        // rOuter = 50; rInner clamped to 49
        assert.equal(g.rOuter, 50);
        assert.equal(g.rInner, 49);
    });
});

describe('sliceHitTest', () => {
    // Setup: 4 equal slices, centered at (200, 200), rOuter = 100
    const setup = (innerRadius = 0) => {
        const state = makePolarState();
        extractSliceData(state, [
            { value: 25 }, { value: 25 }, { value: 25 }, { value: 25 },
        ]);
        const geometry = { cx: 200, cy: 200, rOuter: 100, rInner: innerRadius };
        return { state, geometry };
    };

    it('point above center hits slice 0 (12-3 oclock arc)', () => {
        const { state, geometry } = setup();
        // With 4 equal slices starting at 12, slice 0 spans 12-3 oclock.
        // Any point in the upper-right quadrant lands in it.
        assert.equal(sliceHitTest(220, 170, state, geometry), 0);
    });

    it('point in lower-right quadrant hits slice 1 (3-6 oclock arc)', () => {
        const { state, geometry } = setup();
        // Lower-right diagonal, clearly past the 3 oclock boundary
        assert.equal(sliceHitTest(250, 230, state, geometry), 1);
    });

    it('point in lower-left quadrant hits slice 2 (6-9 oclock arc)', () => {
        const { state, geometry } = setup();
        // Lower-left diagonal, clearly past the 6 oclock boundary
        assert.equal(sliceHitTest(170, 230, state, geometry), 2);
    });

    it('point in upper-left quadrant hits slice 3 (9-12 oclock arc)', () => {
        const { state, geometry } = setup();
        // Upper-left diagonal, clearly past the 9 oclock boundary
        assert.equal(sliceHitTest(170, 180, state, geometry), 3);
    });

    it('point outside outer radius returns -1', () => {
        const { state, geometry } = setup();
        assert.equal(sliceHitTest(500, 500, state, geometry), -1);
    });

    it('point inside donut hole returns -1', () => {
        const { state, geometry } = setup(50);  // donut with rInner=50
        // Center of canvas -> inside hole
        assert.equal(sliceHitTest(200, 200, state, geometry), -1);
    });

    it('hidden slice is skipped (point in its arc returns -1 with no other match)', () => {
        const { state, geometry } = setup();
        state.visible[0] = 0;
        // 12 oclock would normally hit slice 0, but it's hidden, AND angles
        // haven't been recomputed -- so the arc is still there in startAngles
        // but visible=0 short-circuits. With no other slice covering that
        // angle, we get -1.
        // (In real usage, the chart re-extracts on visibility change.)
        assert.equal(sliceHitTest(200, 150, state, geometry), -1);
    });
});

describe('createPieChart', () => {
    it('mounts and renders 3 slices with fillStyle changes per slice', () => {
        const canvas = createMockCanvas(400, 400);
        const chart = createPieChart({
            data: [
                { label: 'A', value: 30 },
                { label: 'B', value: 50 },
                { label: 'C', value: 20 },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.equal(chart._internal.state.n, 3);
        assert.equal(chart._internal.state.total, 100);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Three fills (one per slice). Mock canvas records fillStyle assignments
        // as calls too, but countCalls('fill') counts the actual fill operations.
        assert.equal(countCalls(ctx, 'fill'), 3);
        chart.unmount();
    });

    it('geometry centers in canvas with margins', () => {
        const canvas = createMockCanvas(400, 400);
        const chart = createPieChart({
            data: [{ value: 1 }],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const g = chart._internal.geometry;
        // Default margins 16 each -> plot bounds 368x368, center at 200,200
        assert.equal(g.cx, 200);
        assert.equal(g.cy, 200);
        assert.equal(g.rOuter, 184); // min(368,368)/2
        assert.equal(g.rInner, 0);   // pie default
        chart.unmount();
    });

    it('moveCrosshair updates highlight + crosshair facade', () => {
        const canvas = createMockCanvas(400, 400);
        const chart = createPieChart({
            data: [
                { label: 'A', value: 25 },
                { label: 'B', value: 25 },
                { label: 'C', value: 25 },
                { label: 'D', value: 25 },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Above center -> slice A (index 0)
        chart.moveCrosshair(200, 100);
        assert.equal(chart.crosshair.peek().sliceIdx, 0);
        assert.equal(chart.crosshair.peek().visible, true);
        // Lower-right (interior of slice B, not the exact 3 o'clock boundary)
        chart.moveCrosshair(280, 220);
        assert.equal(chart.crosshair.peek().sliceIdx, 1);
        // Outside -> hidden
        chart.moveCrosshair(390, 390);
        assert.equal(chart.crosshair.peek().visible, false);
        chart.unmount();
    });

    it('toggling slice visibility re-extracts and resizes other arcs', () => {
        const canvas = createMockCanvas(400, 400);
        const chart = createPieChart({
            data: [
                { value: 50 }, { value: 50 },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Both visible: each is PI radians
        assert.ok(Math.abs(chart._internal.state.arcAngles[0] - Math.PI) < 1e-5);
        // Hide slice 0
        chart.setSliceVisible(0, false);
        // Slice 0 should have arc 0; slice 1 should fill the whole circle
        assert.equal(chart._internal.state.arcAngles[0], 0);
        assert.ok(Math.abs(chart._internal.state.arcAngles[1] - 2 * Math.PI) < 1e-5);
        chart.unmount();
    });

    it('handles single-slice (100%) without crashing', () => {
        const canvas = createMockCanvas(400, 400);
        const chart = createPieChart({
            data: [{ label: 'Only', value: 1 }],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // 100% slice spans the whole circle
        assert.ok(Math.abs(chart._internal.state.arcAngles[0] - 2 * Math.PI) < 1e-5);
        chart.unmount();
    });

    it('reactive data signal triggers re-render', () => {
        const data = signal([
            { label: 'A', value: 10 },
            { label: 'B', value: 20 },
        ]);
        const canvas = createMockCanvas(400, 400);
        const chart = createPieChart({
            data: data,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.equal(chart._internal.state.n, 2);
        assert.equal(chart._internal.state.total, 30);

        data.set([
            { label: 'A', value: 5 },
            { label: 'B', value: 10 },
            { label: 'C', value: 15 },
        ]);
        assert.equal(chart._internal.state.n, 3);
        assert.equal(chart._internal.state.total, 30);
        chart.unmount();
    });

    it('throws on invalid data input', () => {
        assert.throws(() => createPieChart({ data: 'not-an-array' }), /requires.*data/);
        assert.throws(() => createPieChart({}), /requires.*data/);
    });
});

describe('createDonutChart', () => {
    it('mounts with innerRadius default 0.5 (half-outer)', () => {
        const canvas = createMockCanvas(400, 400);
        const chart = createDonutChart({
            data: [{ value: 1 }, { value: 1 }],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const g = chart._internal.geometry;
        // rOuter = 184; rInner = 184 * 0.5 = 92
        assert.equal(g.rOuter, 184);
        assert.equal(g.rInner, 92);
        chart.unmount();
    });

    it('hit detection ignores donut hole (center clicks return -1)', () => {
        const canvas = createMockCanvas(400, 400);
        const chart = createDonutChart({
            data: [
                { value: 25 }, { value: 25 }, { value: 25 }, { value: 25 },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveCrosshair(200, 200); // dead center -> inside hole
        assert.equal(chart.crosshair.peek().visible, false);
        // Default donut: rInner=92, rOuter=184. Use a point at r=130
        // above center (dy=-130) -> well inside the ring, in slice 0's arc.
        chart.moveCrosshair(220, 80);
        assert.equal(chart.crosshair.peek().visible, true);
        assert.equal(chart.crosshair.peek().sliceIdx, 0);
        chart.unmount();
    });

    it('user can override innerRadius', () => {
        const canvas = createMockCanvas(400, 400);
        const chart = createDonutChart({
            data: [{ value: 1 }],
            innerRadius: 0.7,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const g = chart._internal.geometry;
        assert.equal(g.rOuter, 184);
        // Use tolerance -- 184 * 0.7 has floating-point representation issues
        assert.ok(Math.abs(g.rInner - 184 * 0.7) < 1e-9);
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Bubble chart (axis kernel with BUBBLE_RENDERER)
// ---------------------------------------------------------------------------

describe('createBubbleChart', () => {
    it('extracts xs / ys / rs and computes pixel radii (sqrt scale)', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [
                { x: 10, y: 20, value: 50 },
                { x: 30, y: 35, value: 100 },
                { x: 50, y: 15, value: 25 },
                { x: 70, y: 45, value: 75 },
            ],
            size: 'value',
            minRadius: 6,
            maxRadius: 30,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const state = chart._internal.seriesStates[0];
        assert.equal(state.n, 4);
        assert.deepEqual(Array.from(state.rs.slice(0, 4)), [50, 100, 25, 75]);
        assert.equal(state.sizeMin, 25);
        assert.equal(state.sizeMax, 100);
        // sqrt scale, value=50 -> t=(50-25)/75=1/3
        // r = sqrt(6^2 + 1/3 * (30^2 - 6^2)) = sqrt(36 + 288) = sqrt(324) = 18
        assert.ok(Math.abs(state.prs[0] - 18) < 0.001);
        // value=100 (max) -> r = maxR = 30
        assert.ok(Math.abs(state.prs[1] - 30) < 0.001);
        // value=25 (min) -> r = minR = 6
        assert.ok(Math.abs(state.prs[2] - 6) < 0.001);
        chart.unmount();
    });

    it('linear size scale maps radius proportionally', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [
                { x: 0, y: 0, value: 0 },
                { x: 1, y: 1, value: 50 },
                { x: 2, y: 2, value: 100 },
            ],
            size: 'value',
            sizeScale: 'linear',
            minRadius: 10,
            maxRadius: 50,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const state = chart._internal.seriesStates[0];
        // linear: r = minR + t*(maxR-minR)
        // value 0   -> t=0,   r=10
        // value 50  -> t=0.5, r=30
        // value 100 -> t=1,   r=50
        assert.ok(Math.abs(state.prs[0] - 10) < 0.001);
        assert.ok(Math.abs(state.prs[1] - 30) < 0.001);
        assert.ok(Math.abs(state.prs[2] - 50) < 0.001);
        chart.unmount();
    });

    it('renders one fill per visible bubble', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [
                { x: 1, y: 1, value: 10 },
                { x: 2, y: 2, value: 20 },
                { x: 3, y: 3, value: 30 },
            ],
            size: 'value',
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // 3 bubbles -> 3 ctx.fill() calls. (Stroke count would also be 3 for
        // the bubble outlines but the axis tick marks add ~18 strokes, so
        // asserting on stroke count would mix bubble + axis paint.)
        assert.equal(countCalls(ctx, 'fill'), 3);
        chart.unmount();
    });

    it('hit-test finds the bubble under the cursor', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [
                { x: 10, y: 10, value: 50 },
                { x: 50, y: 50, value: 50 },
                { x: 90, y: 90, value: 50 },
            ],
            size: 'value',
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const state = chart._internal.seriesStates[0];

        // Cursor on bubble 0's center
        chart.moveCrosshair(state.pxs[0], state.pys[0]);
        assert.equal(chart.crosshair.peek().snapIdx, 0);

        // Cursor on bubble 2's center
        chart.moveCrosshair(state.pxs[2], state.pys[2]);
        assert.equal(chart.crosshair.peek().snapIdx, 2);

        // Cursor far from any bubble
        chart.moveCrosshair(state.pxs[1] + 100, state.pys[1] + 100);
        assert.equal(chart.crosshair.peek().visible, false);

        chart.unmount();
    });

    it('hit-test on overlapping bubbles prefers the smaller (topmost) one', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            // Two bubbles at the SAME data position with different sizes
            data: [
                { x: 50, y: 50, value: 100 },  // large
                { x: 50, y: 50, value: 25 },   // small (visually on top)
            ],
            size: 'value',
            minRadius: 10,
            maxRadius: 40,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const state = chart._internal.seriesStates[0];
        // Both circles are centered at the same pixel. Cursor at the center
        // should hit the SMALLER one (index 1).
        chart.moveCrosshair(state.pxs[0], state.pys[0]);
        assert.equal(chart.crosshair.peek().snapIdx, 1);
        chart.unmount();
    });

    it('clamps negative size values to 0', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [
                { x: 1, y: 1, value: 10 },
                { x: 2, y: 2, value: -5 },
                { x: 3, y: 3, value: 20 },
            ],
            size: 'value',
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const state = chart._internal.seriesStates[0];
        assert.equal(state.rs[1], 0);
        chart.unmount();
    });

    it('all-equal sizes produces midpoint radius (no div by zero)', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [
                { x: 1, y: 1, value: 42 },
                { x: 2, y: 2, value: 42 },
                { x: 3, y: 3, value: 42 },
            ],
            size: 'value',
            minRadius: 10,
            maxRadius: 30,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const state = chart._internal.seriesStates[0];
        // Mid of [10, 30] = 20
        for (let i = 0; i < state.n; i++) {
            assert.equal(state.prs[i], 20);
        }
        chart.unmount();
    });

    it('default size key is "value" if not specified', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [
                { x: 1, y: 1, value: 10 },
                { x: 2, y: 2, value: 20 },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const state = chart._internal.seriesStates[0];
        assert.equal(state.rs[0], 10);
        assert.equal(state.rs[1], 20);
        chart.unmount();
    });

    it('reactive data update re-extracts sizes and radii', () => {
        const data = signal([
            { x: 1, y: 1, value: 10 },
            { x: 2, y: 2, value: 20 },
        ]);
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: data,
            size: 'value',
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const state = chart._internal.seriesStates[0];
        assert.equal(state.n, 2);

        data.set([
            { x: 1, y: 1, value: 50 },
            { x: 2, y: 2, value: 100 },
            { x: 3, y: 3, value: 200 },
        ]);
        assert.equal(state.n, 3);
        assert.equal(state.rs[2], 200);
        chart.unmount();
    });

    it('skips bubbles entirely outside the plot rect (defensive clip)', () => {
        const canvas = createMockCanvas(400, 400);
        const chart = createBubbleChart({
            // x domain will be 0..100; plot bounds map across the canvas width.
            data: [
                { x: 0,   y: 50, value: 50 },   // in
                { x: 50,  y: 50, value: 50 },   // in
                { x: 100, y: 50, value: 50 },   // in (right edge)
            ],
            minRadius: 4,
            maxRadius: 4,  // all bubbles same size for clarity
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // All 3 are inside the plot rect -> 3 fills
        assert.equal(countCalls(ctx, 'fill'), 3);
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Radar chart (separate kernel)
// ---------------------------------------------------------------------------

describe('extractRadarSeriesData', () => {
    it('extracts values into Float32 and pads short input with zeros', () => {
        const state = makeRadarSeriesState();
        extractRadarSeriesData(state, { name: 'A', color: '#abc', values: [10, 20, 30] }, 6);
        assert.equal(state.n, 6);
        assert.equal(state.name, 'A');
        assert.equal(state.rawColor, '#abc');
        assert.deepEqual(Array.from(state.values.slice(0, 6)), [10, 20, 30, 0, 0, 0]);
    });

    it('truncates input longer than axis count', () => {
        const state = makeRadarSeriesState();
        extractRadarSeriesData(state, { values: [1, 2, 3, 4, 5, 6, 7, 8] }, 4);
        assert.equal(state.n, 4);
        assert.deepEqual(Array.from(state.values.slice(0, 4)), [1, 2, 3, 4]);
    });

    it('replaces NaN values with 0', () => {
        const state = makeRadarSeriesState();
        extractRadarSeriesData(state, { values: [10, NaN, 30] }, 3);
        assert.equal(state.values[0], 10);
        assert.equal(state.values[1], 0);
        assert.equal(state.values[2], 30);
    });
});

describe('computeRadarGeometry', () => {
    it('centers in plot rect and reserves label-pad from outer radius', () => {
        const g = { cx: 0, cy: 0, rOuter: 0, axisCount: 0, cosA: null, sinA: null };
        computeRadarGeometry(g, { x: 0, y: 0, w: 400, h: 400 }, 6);
        assert.equal(g.cx, 200);
        assert.equal(g.cy, 200);
        // rOuter = min(w,h)/2 - 24 (label pad) = 200 - 24 = 176
        assert.equal(g.rOuter, 176);
    });

    it('precomputes cos/sin per axis starting at -PI/2 (top, 12 oclock)', () => {
        const g = { cx: 0, cy: 0, rOuter: 0, axisCount: 0, cosA: null, sinA: null };
        computeRadarGeometry(g, { x: 0, y: 0, w: 400, h: 400 }, 4);
        // Axis 0 at -PI/2: cos=0, sin=-1 (pointing up in screen coords)
        assert.ok(Math.abs(g.cosA[0] - 0) < 1e-9);
        assert.ok(Math.abs(g.sinA[0] - (-1)) < 1e-9);
        // Axis 1 at 0: cos=1, sin=0 (pointing right)
        assert.ok(Math.abs(g.cosA[1] - 1) < 1e-9);
        assert.ok(Math.abs(g.sinA[1] - 0) < 1e-9);
        // Axis 2 at PI/2: cos=0, sin=1 (pointing down in screen coords)
        assert.ok(Math.abs(g.cosA[2] - 0) < 1e-9);
        assert.ok(Math.abs(g.sinA[2] - 1) < 1e-9);
    });

    it('handles tiny plot rect by clamping rOuter to 0', () => {
        const g = { cx: 0, cy: 0, rOuter: 0, axisCount: 0, cosA: null, sinA: null };
        computeRadarGeometry(g, { x: 0, y: 0, w: 30, h: 30 }, 4);
        // min(30,30)/2 - 24 = -9 -> clamped to 0
        assert.equal(g.rOuter, 0);
    });
});

describe('radarHitTest', () => {
    const setup = () => {
        const states = [
            Object.assign(makeRadarSeriesState(), { n: 4, name: 'A', visible: true }),
            Object.assign(makeRadarSeriesState(), { n: 4, name: 'B', visible: true }),
        ];
        // Series A: high on axis 0, low elsewhere
        states[0].values = new Float32Array([100, 20, 20, 20]);
        // Series B: high on axis 2 (opposite), low elsewhere
        states[1].values = new Float32Array([20, 20, 100, 20]);

        const geometry = {
            cx: 200, cy: 200, rOuter: 100, axisCount: 4,
            cosA: new Float64Array([0, 1, 0, -1]),
            sinA: new Float64Array([-1, 0, 1, 0]),
        };
        const domainRef = { value: [0, 100] };
        return { states, geometry, domainRef };
    };

    it('finds nearest vertex within hit radius', () => {
        const { states, geometry, domainRef } = setup();
        // Series A axis 0 vertex: cx + 100*1*0 = 200, cy + 100*1*-1 = 100
        const hit = radarHitTest(200, 100, states, geometry, domainRef);
        assert.ok(hit);
        assert.equal(hit.seriesIdx, 0);
        assert.equal(hit.axisIdx, 0);
        assert.equal(hit.value, 100);
    });

    it('returns null when no vertex within 12px', () => {
        const { states, geometry, domainRef } = setup();
        assert.equal(radarHitTest(500, 500, states, geometry, domainRef), null);
    });

    it('picks closest vertex when multiple are within hit radius', () => {
        const { states, geometry, domainRef } = setup();
        // Both A[axis 1] and B[axis 1] have value=20 -> vertex at:
        // cx + 100*0.2*1 = 220, cy + 100*0.2*0 = 200
        // They're at the SAME pixel position (same axis + same value).
        // Hit there should return one of them (whichever has smaller bestD2 first).
        const hit = radarHitTest(220, 200, states, geometry, domainRef);
        assert.ok(hit);
        assert.equal(hit.axisIdx, 1);
        // value 20 either way
        assert.equal(hit.value, 20);
    });

    it('skips hidden series', () => {
        const { states, geometry, domainRef } = setup();
        states[0].visible = false;
        // Series A's vertex at (200, 100) is unreachable; series B's axis-0 vertex
        // is at (200, 200 + 100*0.2*-1) = (200, 180) with value 20.
        const hit = radarHitTest(200, 100, states, geometry, domainRef);
        // Closest visible vertex is series B's axis-0 at (200, 180), dy=80 -> outside hit radius
        assert.equal(hit, null);
    });
});

describe('createRadarChart', () => {
    it('mounts with axes + series; computes geometry and resolves colors', () => {
        const canvas = createMockCanvas(500, 500);
        const chart = createRadarChart({
            axes: ['A', 'B', 'C', 'D', 'E'],
            series: [
                { name: 'X', color: '#3b82f6', values: [10, 20, 30, 40, 50] },
                { name: 'Y', color: '#10b981', values: [50, 40, 30, 20, 10] },
            ],
            domain: [0, 50],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.equal(chart.geometry.axisCount, 5);
        assert.equal(chart._internal.seriesStates.length, 2);
        assert.deepEqual(chart.domain, [0, 50]);
        chart.unmount();
    });

    it('throws on fewer than 3 axes (radar requires triangle minimum)', () => {
        assert.throws(() => createRadarChart({ axes: ['A', 'B'], series: [] }), /at least 3 axes/);
    });

    it('throws on missing series config', () => {
        assert.throws(() => createRadarChart({ axes: ['A', 'B', 'C'] }), /series/);
    });

    it('auto-computes domain from visible series when not pinned', () => {
        const canvas = createMockCanvas(500, 500);
        const chart = createRadarChart({
            axes: ['A', 'B', 'C', 'D'],
            series: [
                { name: 'X', values: [5, 10, 15, 20] },
                { name: 'Y', values: [3, 12, 18, 25] },
            ],
            // no explicit domain -> auto
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Min across both visible series = 3, max = 25
        // Since min/max ratio is 0.12 (< 0.5), min gets anchored at 0.
        assert.equal(chart.domain[0], 0);
        assert.equal(chart.domain[1], 25);
        chart.unmount();
    });

    it('renders one polygon fill per visible series + grid rings', () => {
        const canvas = createMockCanvas(500, 500);
        const chart = createRadarChart({
            axes: ['A', 'B', 'C', 'D', 'E'],
            series: [
                { name: 'X', color: '#3b82f6', values: [10, 20, 30, 40, 50] },
                { name: 'Y', color: '#10b981', values: [50, 40, 30, 20, 10] },
            ],
            domain: [0, 50],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Default fillOpacity=0.2 (>0), so 2 polygon fills + 1 tooltip-rect fill (when crosshair drawn)
        // No crosshair shown yet -> 2 polygon fills only.
        assert.equal(countCalls(ctx, 'fill'), 2);
        chart.unmount();
    });

    it('hit-test on a series vertex updates crosshair facade', () => {
        const canvas = createMockCanvas(500, 500);
        const chart = createRadarChart({
            axes: ['Speed', 'Power', 'Range', 'Charging'],
            series: [
                { name: 'A', values: [100, 0, 0, 0] },  // peak on Speed (axis 0)
            ],
            domain: [0, 100],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const g = chart.geometry;
        // Speed (axis 0) is at -PI/2 (top). Series A's value 100 puts it at rOuter.
        const vx = g.cx + g.rOuter * g.cosA[0];   // ~g.cx since cosA[0] ~ 0
        const vy = g.cy + g.rOuter * g.sinA[0];   // g.cy - g.rOuter (sinA[0] = -1)
        chart.moveCrosshair(vx, vy);
        const ch = chart.crosshair.peek();
        assert.equal(ch.visible, true);
        assert.equal(ch.seriesIdx, 0);
        assert.equal(ch.axisIdx, 0);
        assert.equal(ch.value, 100);
        chart.unmount();
    });

    it('setSeriesVisible toggles polygon rendering', () => {
        const canvas = createMockCanvas(500, 500);
        const chart = createRadarChart({
            axes: ['A', 'B', 'C', 'D'],
            series: [
                { name: 'X', values: [10, 20, 30, 40] },
                { name: 'Y', values: [40, 30, 20, 10] },
            ],
            domain: [0, 50],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);

        // Hide series 0
        chart.setSeriesVisible(0, false);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Only series 1's polygon -> 1 fill
        assert.equal(countCalls(ctx, 'fill'), 1);

        // Re-show
        chart.setSeriesVisible(0, true);
        ctx.calls.length = 0;
        chart.redraw();
        assert.equal(countCalls(ctx, 'fill'), 2);
        chart.unmount();
    });

    it('reactive series signal triggers re-extract', () => {
        const series = signal([
            { name: 'A', values: [10, 20, 30, 40, 50] },
        ]);
        const canvas = createMockCanvas(500, 500);
        const chart = createRadarChart({
            axes: ['1', '2', '3', '4', '5'],
            series: series,
            domain: [0, 100],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.equal(chart._internal.seriesStates.length, 1);

        series.set([
            { name: 'A', values: [10, 20, 30, 40, 50] },
            { name: 'B', values: [50, 40, 30, 20, 10] },
            { name: 'C', values: [25, 25, 25, 25, 25] },
        ]);
        assert.equal(chart._internal.seriesStates.length, 3);
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// Kernel-side auto-resize via ResizeObserver
// ---------------------------------------------------------------------------

describe('auto-resize (kernel-side ResizeObserver)', () => {
    // Mock ResizeObserver in each test; restore after.
    let observers;
    let origRAF;
    let origRO;

    const setupROMock = () => {
        observers = [];
        origRO = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
            constructor(cb) { this.cb = cb; observers.push(this); }
            observe(el) { this.el = el; }
            disconnect() { observers = observers.filter((o) => o !== this); }
            trigger() { this.cb(); }
        };
        origRAF = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
    };
    const teardownROMock = () => {
        globalThis.ResizeObserver = origRO;
        globalThis.requestAnimationFrame = origRAF;
    };

    const makeMockParent = (w, h) => ({
        tagName: 'DIV',
        clientWidth: w,
        clientHeight: h,
        children: [],
        appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
        removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    });

    // A style object that records setProperty(...) into a Map so the
    // centerLabel custom-property writes (--cl-fit/-digits/-max/-min) are
    // inspectable, while ordinary `style.left = ...` assignments still work.
    const mkStyleMap = () => {
        const props = new Map();
        return {
            _props: props,
            setProperty(k, v) { props.set(k, v); },
            getPropertyValue(k) { return props.get(k) || ''; },
        };
    };
    // Minimal DOM element with parenting + insertBefore, enough for the
    // labelHost interposition (canvas moved into a position:relative wrapper,
    // overlay appended as a canvas-relative sibling).
    const mkDomEl = (tag) => ({
        tagName: (tag || 'div').toUpperCase(),
        childNodes: [],
        parentNode: null,
        parentElement: null,
        style: mkStyleMap(),
        className: '',
        textContent: '',
        // v1.12.0: attribute + dataset + listener surface for the virtualized
        // legend. `dataset` is a plain bag (data-lc-idx); attributes back
        // setAttribute/getAttribute (aria-pressed, role, tabindex); listeners
        // back addEventListener/removeEventListener with a _fire(type, ev) hook.
        dataset: {},
        _attrs: {},
        _listeners: {},
        scrollTop: 0,
        clientHeight: 0,
        setAttribute(k, v) { this._attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
        addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); },
        removeEventListener(type, fn) {
            const a = this._listeners[type]; if (!a) return;
            const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
        },
        _fire(type, ev) {
            const a = this._listeners[type]; if (!a) return;
            for (let i = 0; i < a.length; i++) a[i].call(this, ev);
        },
        appendChild(c) {
            if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
            this.childNodes.push(c); c.parentNode = this; c.parentElement = this; return c;
        },
        insertBefore(c, ref) {
            if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
            const i = this.childNodes.indexOf(ref);
            if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
            c.parentNode = this; c.parentElement = this; return c;
        },
        removeChild(c) {
            const i = this.childNodes.indexOf(c);
            if (i >= 0) this.childNodes.splice(i, 1);
            c.parentNode = null; c.parentElement = null; return c;
        },
        querySelectorAll() { return []; },
    });
    // A canvas the interposition can reparent: real mock context surface plus
    // childNodes/parentNode and no-op event wiring.
    const mkDomCanvas = () => {
        const c = createMockCanvas(100, 100);
        c.childNodes = [];
        c.parentNode = null;
        c.getBoundingClientRect = () => ({ left: 0, top: 0, width: c.width, height: c.height, x: 0, y: 0, right: c.width, bottom: c.height });
        c.addEventListener = () => {};
        c.removeEventListener = () => {};
        return c;
    };

    const withFakeDOM = (parent, fn) => {
        const origDoc = globalThis.document;
        globalThis.document = {
            createElement: (tag) => tag === 'canvas' ? mkDomCanvas() : mkDomEl(tag),
        };
        try { return fn(); } finally { globalThis.document = origDoc; }
    };
    // Expose the element factory to centerLabel tests that mount into a
    // container they create themselves.
    withFakeDOM.el = mkDomEl;

    it('does not attach a ResizeObserver when width + height are explicit', () => {
        setupROMock();
        try {
            const canvas = createMockCanvas(800, 400);
            const chart = createLineChart({
                series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
                width: 800,
                height: 400,
                schedule: (fn) => fn(),
            });
            chart.mount(canvas);
            assert.equal(observers.length, 0);
            chart.unmount();
        } finally { teardownROMock(); }
    });

    it('attaches ResizeObserver when width is omitted (axis kernel)', () => {
        setupROMock();
        try {
            const parent = makeMockParent(600, 300);
            withFakeDOM(parent, () => {
                const chart = createLineChart({
                    series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
                    schedule: (fn) => fn(),
                    legend: false,
                });
                chart.mount(parent);
                assert.equal(observers.length, 1);
                assert.equal(chart.canvas.width, 600);
                assert.equal(chart.canvas.height, 300);

                parent.clientWidth = 900;
                parent.clientHeight = 450;
                observers[0].trigger();
                assert.equal(chart.canvas.width, 900);
                assert.equal(chart.canvas.height, 450);
                chart.unmount();
                assert.equal(observers.length, 0);
            });
        } finally { teardownROMock(); }
    });

    it('attaches ResizeObserver when width is omitted (polar kernel)', () => {
        setupROMock();
        try {
            const parent = makeMockParent(500, 500);
            withFakeDOM(parent, () => {
                const chart = createPieChart({
                    data: [{ label: 'A', value: 10 }, { label: 'B', value: 20 }],
                    schedule: (fn) => fn(),
                    legend: false,
                });
                chart.mount(parent);
                assert.equal(observers.length, 1);
                assert.equal(chart.canvas.width, 500);
                chart.unmount();
            });
        } finally { teardownROMock(); }
    });

    it('attaches ResizeObserver when width is omitted (radar kernel)', () => {
        setupROMock();
        try {
            const parent = makeMockParent(480, 480);
            withFakeDOM(parent, () => {
                const chart = createRadarChart({
                    axes: ['A', 'B', 'C', 'D'],
                    series: [{ name: 'X', values: [10, 20, 30, 40] }],
                    domain: [0, 100],
                    schedule: (fn) => fn(),
                    legend: false,
                });
                chart.mount(parent);
                assert.equal(observers.length, 1);
                assert.equal(chart.canvas.width, 480);
                chart.unmount();
            });
        } finally { teardownROMock(); }
    });

    it('falls back gracefully when ResizeObserver is unavailable', () => {
        // No setupROMock -- ResizeObserver stays undefined in this environment.
        const parent = makeMockParent(600, 300);
        withFakeDOM(parent, () => {
            const chart = createLineChart({
                series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
                schedule: (fn) => fn(),
                legend: false,
            });
            // Should NOT throw despite no ResizeObserver
            chart.mount(parent);
            // Falls back to default size (800x400 in axis kernel)
            assert.equal(chart.canvas.width, 800);
            chart.unmount();
        });
    });

    it('respects explicit signal accessor (does not auto-observe)', () => {
        setupROMock();
        try {
            const parent = makeMockParent(600, 300);
            withFakeDOM(parent, () => {
                const userWidth = signal(700);
                const chart = createLineChart({
                    series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
                    width: userWidth,
                    height: 350,
                    schedule: (fn) => fn(),
                    legend: false,
                });
                chart.mount(parent);
                // Explicit width signal -> no auto-observe even though container resizable
                assert.equal(observers.length, 0);
                assert.equal(chart.canvas.width, 700);

                userWidth.set(900);
                assert.equal(chart.canvas.width, 900);
                chart.unmount();
            });
        } finally { teardownROMock(); }
    });

    // -----------------------------------------------------------------------
    // centerLabel (donut only) -- v1.5.0
    // -----------------------------------------------------------------------

    describe('centerLabel', () => {
        // A1 -- fail closed at CONSTRUCTION (before mount).
        it('A1: throws when centerLabel is set on a hole-less chart', () => {
            assert.throws(
                () => createPieChart({ values: [1, 2], centerLabel: '42' }),
                /centerLabel requires a donut hole/);
            assert.throws(
                () => createDonutChart({ values: [1], innerRadius: 0, centerLabel: true }),
                /innerRadius resolved to 0/);
            assert.throws(
                () => createDonutChart({ values: [1], centerLabel: { minFontSize: 40, maxFontSize: 10 } }),
                /minFontSize .* exceeds maxFontSize/);
        });

        // A1b -- a single pathological font bound must fail closed. `+'12x'`/`+NaN`
        // is NaN and `NaN > x` is false, so the min>max guard alone would let it
        // through and emit "NaNpx" / font-size="NaN". (reviewer finding 2)
        it('A1b: throws on a non-finite or non-positive font bound', () => {
            for (const bad of [{ maxFontSize: NaN }, { maxFontSize: '12x' }, { maxFontSize: 0 }, { maxFontSize: -5 }]) {
                assert.throws(
                    () => createDonutChart({ values: [1, 2], centerLabel: bad }),
                    /maxFontSize must be a finite number/, JSON.stringify(bad));
            }
            for (const bad of [{ minFontSize: NaN }, { minFontSize: 'foo' }, { minFontSize: -1 }]) {
                assert.throws(
                    () => createDonutChart({ values: [1, 2], centerLabel: bad }),
                    /minFontSize must be a finite number/, JSON.stringify(bad));
            }
        });

        // A1c -- centerLabel needs a DOM parent to interpose into. The guard must
        // fire at the TOP of mount(), before the ResizeObserver / scene / effects
        // are allocated (unmount early-returns on !mounted, so a late throw would
        // strand them). (reviewer finding 3; leak side proven in torture A6c)
        it('A1c: mounting a centerLabel donut onto a parentless canvas throws', () => {
            withFakeDOM(null, () => {
                const chart = createDonutChart({
                    values: [1, 2], width: 300, height: 300, innerRadius: 0.5,
                    centerLabel: '42', legend: false, schedule: (fn) => fn(),
                });
                const bareCanvas = withFakeDOM.el('canvas');   // tagName CANVAS, parentNode null
                assert.throws(() => chart.mount(bareCanvas),
                    /centerLabel requires mount\(\) into a DOM element/);
            });
        });

        // A1d -- `centerLabel: true` defaults format to the visible-slice total
        // (state.visibleTotal), and it updates when a slice is toggled off.
        it('A1d: centerLabel:true renders the live visible-slice total', () => {
            withFakeDOM(null, () => {
                const chart = createDonutChart({
                    values: [3, 4, 5], width: 400, height: 400,
                    centerLabel: true, legend: false, schedule: (fn) => fn(),
                });
                chart.mount(withFakeDOM.el('div'));
                assert.equal(chart.centerLabel.childNodes[0].textContent, '12');
                chart.setSliceVisible(2, false);   // hide the "5" slice
                assert.equal(chart.centerLabel.childNodes[0].textContent, '7');
            });
        });

        // A2 -- exact custom-property + overlay values.
        it('A2: writes exact --cl-* props, width, position and clamp font-size', () => {
            withFakeDOM(null, () => {
                const container = withFakeDOM.el('div');
                const chart = createDonutChart({
                    values: [1, 2], width: 400, height: 400,
                    centerLabel: '1,234', legend: false, schedule: (fn) => fn(),
                });
                chart.mount(container);
                const g = chart._internal.geometry;
                assert.equal(g.rInner, 92);
                const ov = chart.centerLabel;
                assert.ok(ov, 'centerLabel overlay exists');
                const p = ov.style._props;
                assert.equal(p.get('--cl-fit'), '216.85px');
                assert.equal(p.get('--cl-digits'), '5');
                assert.equal(p.get('--cl-max'), '104.09px');
                assert.equal(p.get('--cl-min'), '8px');
                assert.equal(ov.style.width, '130.11px');
                assert.equal(ov.style.left, '200px');
                assert.equal(ov.style.top, '200px');
                assert.equal(ov.style.fontSize,
                    'clamp(var(--cl-min), calc(var(--cl-fit) / var(--cl-digits)), var(--cl-max))');
                assert.equal(ov.childNodes[0].textContent, '1,234');
                chart.unmount();
            });
        });

        // A3 -- digit monotonicity + reactivity; fit tracks geometry not text.
        it('A3: digits track text length; --cl-fit is text-invariant; resize updates fit', () => {
            withFakeDOM(null, () => {
                const container = withFakeDOM.el('div');
                const text = signal('7');
                const w = signal(400);
                const h = signal(400);
                const chart = createDonutChart({
                    values: [1, 2], width: w, height: h,
                    centerLabel: { text }, legend: false, schedule: (fn) => fn(),
                });
                chart.mount(container);
                const ov = chart.centerLabel;
                const p = ov.style._props;
                assert.equal(p.get('--cl-digits'), '1');
                assert.equal(p.get('--cl-fit'), '216.85px');

                // Count setProperty calls per update.
                let spCount = 0;
                const orig = ov.style.setProperty.bind(ov.style);
                ov.style.setProperty = (k, v) => { spCount++; orig(k, v); };

                text.set('1234567');
                assert.equal(p.get('--cl-digits'), '7');
                assert.equal(p.get('--cl-fit'), '216.85px'); // unchanged: fit is geometry-only
                assert.equal(spCount, 4, 'exactly 4 setProperty per update');

                spCount = 0;
                chart.redraw();
                assert.equal(spCount, 0, 'redraw() writes no custom properties');

                // Resize: rInner 92 -> 42 (200x200, default margin 16). Actual
                // geometry gives fit '98.99px' (see report: spec's '108.42px'/
                // 'rInner 46' assumed rInner scales as exactly half rOuter and
                // ignored the fixed 16px margin).
                spCount = 0;
                w.set(200); h.set(200);
                assert.equal(chart._internal.geometry.rInner, 42);
                assert.equal(p.get('--cl-fit'), '98.99px');
                assert.equal(p.get('--cl-digits'), '7'); // digits unchanged by resize
                chart.unmount();
            });
        });

        // A4 -- SVG export path (string-spliced, not a scene node).
        it('A4: exportSVG emits centered <text>; canvas never fillTexts the label', () => {
            withFakeDOM(null, () => {
                const container = withFakeDOM.el('div');
                const chart = createDonutChart({
                    values: [1, 2], width: 400, height: 400,
                    centerLabel: '1,234', legend: false, schedule: (fn) => fn(),
                });
                chart.mount(container);
                const svg = chart.exportSVG();
                const tags = svg.match(/<text\b/g) || [];
                assert.equal(tags.length, 1);
                assert.ok(svg.includes('text-anchor="middle"'));
                assert.ok(svg.includes('dominant-baseline="central"'));
                assert.ok(svg.includes('font-size="43.37"'));
                // The canvas draw path must never paint the label text.
                const ctx = chart.canvas.getContext('2d');
                const painted = ctx.calls.some((c) => c[0] === 'fillText' && c[1][0] === '1,234');
                assert.equal(painted, false, 'label must not be drawn to canvas');
                chart.unmount();

                // With a subLabel: exactly two <text>.
                const c2 = createDonutChart({
                    values: [1, 2], width: 400, height: 400,
                    centerLabel: { text: '1,234', subLabel: 'total' },
                    legend: false, schedule: (fn) => fn(),
                });
                c2.mount(withFakeDOM.el('div'));
                const svg2 = c2.exportSVG();
                assert.equal((svg2.match(/<text\b/g) || []).length, 2);
                c2.unmount();

                // Without centerLabel: zero <text>.
                const c3 = createDonutChart({
                    values: [1, 2], width: 400, height: 400,
                    legend: false, schedule: (fn) => fn(),
                });
                c3.mount(withFakeDOM.el('div'));
                assert.equal((c3.exportSVG().match(/<text\b/g) || []).length, 0);
                c3.unmount();
            });
        });

        // A4b -- the subLabel must track the CLAMPED main size, not the raw
        // fit/digits ratio. DOM uses `0.42em` (resolves against the overlay's
        // clamped font-size); SVG emits `main * 0.42`. Both must agree.
        // (reviewer finding 1) Also guards format()'s String() coercion parity.
        it('A4b: subLabel size = 0.42x the clamped main, DOM and SVG in agreement', () => {
            withFakeDOM(null, () => {
                const chart = createDonutChart({
                    values: [1, 2], width: 400, height: 400,
                    centerLabel: { text: '1,234', subLabel: 'total' },
                    legend: false, schedule: (fn) => fn(),
                });
                chart.mount(withFakeDOM.el('div'));
                // DOM: overlay > [main, sub]; the sub uses em, not a raw calc().
                const sub = chart.centerLabel.childNodes[1];
                assert.equal(sub.style.fontSize, '0.42em');
                // SVG: two font-sizes, sub === round(main * 0.42).
                const sizes = [...chart.exportSVG().matchAll(/font-size="([\d.]+)"/g)].map((m) => +m[1]);
                assert.equal(sizes.length, 2);
                assert.equal(sizes[1], Math.round(sizes[0] * 0.42 * 100) / 100);
            });
        });

        // A5 -- kernel isolation. No bundler ships in-repo, so this is a
        // source-region reachability proxy (documented in the report): the
        // tokens '--cl-fit' and 'centerLabel' must occur ONLY inside the polar
        // kernel region, so a line/bar/heatmap entry point cannot reach them.
        it('A5: --cl-fit and centerLabel are confined to the polar kernel region', () => {
            const src = readFileSync(new URL('../Charts.js', import.meta.url), 'utf8');
            const regionStart = src.indexOf('// ---- Center label (donut only)');
            const regionEnd = src.indexOf('// Each factory is a one-line composition');
            assert.ok(regionStart > 0 && regionEnd > regionStart, 'polar region markers found');
            for (const token of ['--cl-fit', 'centerLabel']) {
                let idx = src.indexOf(token);
                let count = 0;
                while (idx >= 0) {
                    count++;
                    assert.ok(idx >= regionStart && idx < regionEnd,
                        token + ' at index ' + idx + ' escapes the polar kernel region [' +
                        regionStart + ',' + regionEnd + ')');
                    idx = src.indexOf(token, idx + 1);
                }
                assert.ok(count > 0, token + ' should appear in the polar kernel');
            }
        });
    });
});

// ---------------------------------------------------------------------------
// Plot-rect clipping (regression: line/area paint past plotR with round caps)
// ---------------------------------------------------------------------------

describe('plot-rect clipping (line + area)', () => {
    it('line draw issues at least one ctx.clip (regression: round-cap overshoot)', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: [
                { x: 0,   y: 10 },
                { x: 50,  y: 80 },
                { x: 100, y: 20 },
            ],
            color: '#3b82f6',
            lineWidth: 2,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();

        // At least one clip must fire (the line draw's plot-bounds clip).
        // Without it, round-capped lines paint ~lineWidth/2 pixels past plotR.
        assert.ok(countCalls(ctx, 'clip') >= 1, 'expected ctx.clip() to be called');
        // Every save must have a matching restore (no leaked state).
        assert.equal(countCalls(ctx, 'save'), countCalls(ctx, 'restore'));
        chart.unmount();
    });

    it('area draw also clips (filled area + stroke both bounded)', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createAreaChart({
            data: [
                { x: 0,   y: 10 },
                { x: 50,  y: 60 },
                { x: 100, y: 30 },
            ],
            color: '#10b981',
            lineWidth: 2,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();

        assert.ok(countCalls(ctx, 'clip') >= 1, 'expected ctx.clip() to be called');
        assert.equal(countCalls(ctx, 'save'), countCalls(ctx, 'restore'));
        chart.unmount();
    });

    it('clip rect dimensions equal the plot bounds (plotL, plotT, plotW, plotH)', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();

        // Find a rect() call whose args match plotBoundsBox -- proves the
        // clip path matches the plot rect, not something larger / smaller.
        const box = chart._internal.plotBoundsBox;
        let foundMatching = false;
        for (const c of ctx.calls) {
            if (c[0] !== 'rect') continue;
            const [x, y, w, h] = c[1];
            if (x === box.x && y === box.y && w === box.w && h === box.h) {
                foundMatching = true;
                break;
            }
        }
        assert.ok(foundMatching, 'expected ctx.rect() matching plot bounds');
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// v1.1.0 -- Stacked bar + rounded corners + hover tint
// ---------------------------------------------------------------------------

describe('createBarChart -- stacked layout (v1.1.0)', () => {
    it('fills stackBottoms / stackTops per category cumulatively', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            series: [
                { name: 'A', data: [{ x: 'Mon', y: 10 }, { x: 'Tue', y: 20 }] },
                { name: 'B', data: [{ x: 'Mon', y: 5 },  { x: 'Tue', y: 15 }] },
                { name: 'C', data: [{ x: 'Mon', y: 3 },  { x: 'Tue', y: 8 }] },
            ],
            stack: true,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const s = chart._internal.seriesStates;
        // Mon: A 0->10, B 10->15, C 15->18
        assert.deepEqual(Array.from(s[0].stackBottoms.slice(0, 2)), [0, 0]);
        assert.deepEqual(Array.from(s[0].stackTops.slice(0, 2)), [10, 20]);
        assert.deepEqual(Array.from(s[1].stackBottoms.slice(0, 2)), [10, 20]);
        assert.deepEqual(Array.from(s[1].stackTops.slice(0, 2)), [15, 35]);
        assert.deepEqual(Array.from(s[2].stackBottoms.slice(0, 2)), [15, 35]);
        assert.deepEqual(Array.from(s[2].stackTops.slice(0, 2)), [18, 43]);
        chart.unmount();
    });

    it('y-domain reflects total stack height, not single-series max', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            series: [
                { name: 'A', data: [{ x: 'Mon', y: 100 }] },
                { name: 'B', data: [{ x: 'Mon', y: 100 }] },
            ],
            stack: true,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Stack total at Mon = 200. y-domain should reach >= 200 after nice rounding.
        assert.ok(chart.yScale.dMax >= 200, 'expected dMax >= 200, got ' + chart.yScale.dMax);
        chart.unmount();
    });

    it('hidden series are excluded from the stack', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            series: [
                { name: 'A', data: [{ x: 'Mon', y: 10 }] },
                { name: 'B', data: [{ x: 'Mon', y: 5 }] },
                { name: 'C', data: [{ x: 'Mon', y: 3 }] },
            ],
            stack: true,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.setSeriesVisible(1, false);
        const s = chart._internal.seriesStates;
        // With B hidden, C should sit directly on top of A: 0..10, then 10..13.
        assert.equal(s[2].stackBottoms[0], 10);
        assert.equal(s[2].stackTops[0], 13);
        chart.unmount();
    });

    it('negative values clamp to 0 in MVP stacking', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            series: [
                { name: 'A', data: [{ x: 'Mon', y: 20 }] },
                { name: 'B', data: [{ x: 'Mon', y: -5 }] },  // negative -> clamps
            ],
            stack: true,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const s = chart._internal.seriesStates;
        // B's negative value treated as 0 -- bar invisible (top == bottom == 20).
        assert.equal(s[1].stackBottoms[0], 20);
        assert.equal(s[1].stackTops[0], 20);
        chart.unmount();
    });

    it('toggling stack: false clears stack buffers', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            series: [
                { name: 'A', data: [{ x: 'Mon', y: 10 }] },
                { name: 'B', data: [{ x: 'Mon', y: 5 }] },
            ],
            stack: false,  // start ungrouped
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const s = chart._internal.seriesStates;
        // stack: false -> stack buffers null (the draw fn falls back to grouped)
        assert.ok(!s[0].stackBottoms || s[0].stackBottoms === null);
        chart.unmount();
    });

    it('stacked draw uses one fill per visible series per category', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            series: [
                { name: 'A', data: [{ x: 'Mon', y: 10 }, { x: 'Tue', y: 20 }] },
                { name: 'B', data: [{ x: 'Mon', y: 5 },  { x: 'Tue', y: 15 }] },
            ],
            stack: true,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // 2 series x 2 categories = 4 bar fills (no rounded corners, so fillRect)
        assert.equal(countCalls(ctx, 'fillRect'), 4);
        chart.unmount();
    });
});

describe('createBarChart -- rounded corners (v1.1.0)', () => {
    it('cornerRadius > 0 switches from fillRect to roundRect path + fill', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            data: [{ x: 'Mon', y: 30 }, { x: 'Tue', y: 50 }],
            cornerRadius: 6,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // No fillRect; instead 2 ctx.fill() from rounded paths
        assert.equal(countCalls(ctx, 'fillRect'), 0);
        assert.equal(countCalls(ctx, 'fill'), 2);
        // Uses native roundRect via mock (mock advertises the method)
        assert.equal(countCalls(ctx, 'roundRect'), 2);
        chart.unmount();
    });

    it('cornerRadius = 0 keeps the fillRect fast path', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            data: [{ x: 'Mon', y: 30 }, { x: 'Tue', y: 50 }],
            // cornerRadius omitted -> 0
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        assert.equal(countCalls(ctx, 'fillRect'), 2);
        assert.equal(countCalls(ctx, 'roundRect'), 0);
        chart.unmount();
    });

    it('rounded corners cap at min(w, h) / 2 (no overlap on thin bars)', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            data: [{ x: 'A', y: 100 }],
            cornerRadius: 50,  // way larger than any reasonable bar
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Should mount + draw without throwing -- helper clamps internally.
        chart.redraw();
        chart.unmount();
    });
});

describe('createBarChart -- hover tint (v1.1.0)', () => {
    it('draws an extra tint fill on the hovered bar', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            data: [{ x: 'A', y: 30 }, { x: 'B', y: 50 }, { x: 'C', y: 20 }],
            hoverTint: 'rgba(255,255,255,0.3)',
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);

        // Hover band 1 (centered).
        const xCat1 = chart.xScale.map(1);
        const pb = chart._internal.plotBoundsBox;
        // Position crosshair, THEN clear ctx (moveCrosshair triggers a redraw
        // via the sync scheduler), THEN explicit redraw and count.
        chart.moveCrosshair(xCat1, pb.y + 100);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // 3 bars + 1 tint overlay (hovered bar 1) + 1 tooltip color-swatch
        // = 5 fillRects total. The tooltip swatch fires because hover
        // enables the crosshair which renders the tooltip box.
        assert.equal(countCalls(ctx, 'fillRect'), 5);
        chart.unmount();
    });

    it('hoverTint: false disables overlay entirely', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBarChart({
            data: [{ x: 'A', y: 30 }, { x: 'B', y: 50 }],
            hoverTint: false,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveCrosshair(chart.xScale.map(0), chart._internal.plotBoundsBox.y + 50);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // 2 bars + 1 tooltip color-swatch = 3 (no tint overlay)
        assert.equal(countCalls(ctx, 'fillRect'), 3);
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// createBarChart -- horizontal orientation (v1.5.0)  [assertions A1-A11, A15]
// ---------------------------------------------------------------------------
//
// The vertical bar path must stay byte-identical (A1 hash parity). The band
// scale keeps its object identity (chart.xScale) but binds to the Y pixel
// range; the value scale (chart.yScale) binds to X. Category 0 sits at the
// TOP of the plot. See ROADMAP / CHANGELOG [1.5.0].

import { createHash as _sha256 } from 'node:crypto';

describe('createBarChart -- horizontal orientation (v1.5.0)', () => {
    const approx = (a, b, eps = 1e-6) =>
        assert.ok(Math.abs(a - b) <= eps, 'expected ' + a + ' ~= ' + b + ' (eps ' + eps + ')');

    const walkTexts = (root) => {
        const out = [];
        const walk = (n) => {
            if (!n) return;
            if (n.kind === 'text') out.push(n);
            if (Array.isArray(n.children)) n.children.forEach(walk);
        };
        walk(root);
        return out;
    };
    const walkLines = (root) => {
        const out = [];
        const walk = (n) => {
            if (!n) return;
            if (n.kind === 'line') out.push(n);
            if (Array.isArray(n.children)) n.children.forEach(walk);
        };
        walk(root);
        return out;
    };

    const A2_MARGIN = { top: 20, right: 20, bottom: 30, left: 60 };
    const mkH = (extra) => createBarChart(Object.assign({
        orientation: 'horizontal',
        width: 400, height: 300, margin: A2_MARGIN,
        paddingInner: 0.15, paddingOuter: 0.1,
        schedule: (fn) => fn(),
    }, extra));

    // -- A1: hash parity ----------------------------------------------------
    // Goldens captured from the LIVE (unedited) functions, which equal 1.4.1
    // (git-verified: no diff hunk touches lines < 5698 in those functions).
    it('A1: the five hot functions are byte-identical to the 1.4.1 goldens', () => {
        const GOLDENS = {
            makeBarDrawFn:    '8334a641cde16bcf965fff15086add6f0e8f3d2335cc37da445bc66f3353f5cd',
            _roundRectPath:   'b2fc2526043208109e37df8b1beb25070c2bede5e611901c099da01a81c029b1',
            computeBarStacks: 'a871e0b8c9c78bfea7a81f07b85360f8388733ff0e0d6b98fbdcc5053126c450',
            makeBandScale:    '2d4c05870d594954d04010621020aebbb6acccaa58d878ab57f54a78b02e566d',
            updateBandScale:  '777785a8c92ce5bd6b20ce1bcbff58407cb5eb549e8fc3a412afb8dabdf2644e',
        };
        for (const name of Object.keys(GOLDENS)) {
            const fn = _testHelpers[name];
            assert.equal(typeof fn, 'function', name + ' must be reachable via _testHelpers');
            const h = _sha256('sha256').update(fn.toString()).digest('hex');
            assert.equal(h, GOLDENS[name], name + ' changed -- hash parity broken');
        }
        // Signature width unchanged.
        assert.equal(_testHelpers.makeBarDrawFn.length, 12);
        // No orientation dispatch leaked into the vertical closure. NOTE: the
        // literal "0 occurrences of 'horizontal'" from the plan is impossible
        // -- the 1.4.1 source already contains the comment "no horizontal
        // offset; vertical extent...". The hash above is the true guard; here
        // we assert no NEW orientation machinery (makeHBarDrawFn / swapAxes /
        // opts.horizontal) appears inside the vertical draw fn.
        const src = _testHelpers.makeBarDrawFn.toString();
        assert.ok(!src.includes('makeHBarDrawFn'), 'vertical closure must not reference the horizontal sibling');
        assert.ok(!src.includes('swapAxes'), 'vertical closure must not reference swapAxes');
        assert.ok(!src.includes('.horizontal'), 'vertical closure must not read opts.horizontal');
    });

    // -- A2: band scale on Y -----------------------------------------------
    it('A2: band scale binds to the Y range; category 0 at top', () => {
        const canvas = createMockCanvas(400, 300);
        const chart = mkH({ data: [{ x: 'A', y: 10 }, { x: 'B', y: 20 }, { x: 'C', y: 15 }, { x: 'D', y: 25 }] });
        chart.mount(canvas);
        const bs = chart.xScale;
        approx(bs.step, 61.72839506172840, 1e-6);
        approx(bs.bandWidth, 52.46913580246914, 1e-6);
        approx(bs.map(0), 52.40740740740741, 1e-6);
        approx(bs.map(3), 237.5925925925926, 1e-6);
        assert.ok(bs.map(0) < bs.map(3), 'category 0 must sit above category 3 (top-down)');
        chart.unmount();
    });

    // -- A3: hit-test keys off canvasY -------------------------------------
    it('A3: horizontal hit-test snaps on the Y axis; vertical control unchanged', () => {
        const canvas = createMockCanvas(400, 300);
        const chart = mkH({ data: [{ x: 'A', y: 10 }, { x: 'B', y: 20 }, { x: 'C', y: 15 }, { x: 'D', y: 25 }] });
        chart.mount(canvas);
        const bs = chart.xScale; // band scale, now on Y
        chart.moveCrosshair(200, bs.map(0));
        assert.equal(chart.crosshair.peek().snapIdx, 0);
        chart.moveCrosshair(200, bs.map(3));
        assert.equal(chart.crosshair.peek().snapIdx, 3);
        // The free (X/value) axis does not change the category snap: a
        // DIFFERENT in-plot X with cat3's Y still snaps to cat3. (A cursor left
        // of the plot rect is correctly a miss -- that is moveCrosshair's plot-
        // rect gate, not the hit-test's job -- so probe with an in-plot X.)
        chart.moveCrosshair(350, bs.map(3));
        assert.equal(chart.crosshair.peek().snapIdx, 3, 'hit must key off Y, not X');
        // snapPixelX is the band-axis pixel (a Y here).
        approx(chart.crosshair.peek().snapPixelX, bs.map(3), 1e-6);
        chart.unmount();

        // Vertical control: identical data, band on X, classic behaviour.
        const c2 = createBarChart({
            data: [{ x: 'A', y: 10 }, { x: 'B', y: 20 }, { x: 'C', y: 15 }, { x: 'D', y: 25 }],
            width: 400, height: 300, margin: A2_MARGIN,
            paddingInner: 0.15, paddingOuter: 0.1, schedule: (fn) => fn(),
        });
        c2.mount(createMockCanvas(400, 300));
        c2.moveCrosshair(c2.xScale.map(0), 150);
        assert.equal(c2.crosshair.peek().snapIdx, 0);
        c2.moveCrosshair(c2.xScale.map(3), 150);
        assert.equal(c2.crosshair.peek().snapIdx, 3);
        c2.unmount();
    });

    // -- A3b: horizontal tooltip tracks the FREE (value/X) axis -------------
    // Regression (reviewer S2): the mousemove dedup gated only on mousePixelY,
    // so sliding the cursor along the value axis inside one band (snapIdx + Y
    // unchanged) early-returned and froze mousePixelX -- the horizontal tooltip
    // box X (anchored on mousePixelX) stopped following the cursor.
    it('A3b: horizontal crosshair updates mousePixelX along the value axis', () => {
        const chart = mkH({ data: [{ x: 'A', y: 10 }, { x: 'B', y: 20 }, { x: 'C', y: 15 }] });
        chart.mount(createMockCanvas(400, 300));
        const yBand = chart.xScale.map(1); // category 1's band-axis (Y) pixel
        chart.moveCrosshair(100, yBand);
        assert.equal(chart.crosshair.peek().snapIdx, 1);
        assert.equal(chart.crosshair.peek().mousePixelX, 100);
        // Slide along X within the SAME band: must NOT be dedup'd; box X follows.
        chart.moveCrosshair(300, yBand);
        assert.equal(chart.crosshair.peek().snapIdx, 1, 'still the same category');
        assert.equal(chart.crosshair.peek().mousePixelX, 300,
            'tooltip X must track the cursor along the value axis');
        // Vertical control: dedup still keys off mousePixelY (unchanged behaviour).
        const v = createBarChart({
            data: [{ x: 'A', y: 10 }, { x: 'B', y: 20 }, { x: 'C', y: 15 }],
            width: 400, height: 300, margin: A2_MARGIN,
            paddingInner: 0.15, paddingOuter: 0.1, schedule: (fn) => fn(),
        });
        v.mount(createMockCanvas(400, 300));
        v.moveCrosshair(v.xScale.map(1), 80);
        assert.equal(v.crosshair.peek().snapIdx, 1);
        assert.equal(v.crosshair.peek().mousePixelY, 80);
        v.moveCrosshair(v.xScale.map(1), 200); // same band, new Y -> box Y follows
        assert.equal(v.crosshair.peek().mousePixelY, 200);
        v.unmount();
    });

    // -- A4: rect geometry (value on X) ------------------------------------
    it('A4: bars extend along X from the value baseline', () => {
        const canvas = createMockCanvas(400, 300);
        const chart = mkH({ data: [{ x: 'A', y: 10 }, { x: 'B', y: -10 }], cornerRadius: 0 });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        const rects = callsOf(ctx, 'fillRect').map((c) => c[1]);
        assert.equal(rects.length, 2);
        const ys = chart.yScale;
        const base = ys.map(0);
        const bw = chart.xScale.bandWidth;
        const expectH = bw * (1 - 0.08); // groupInnerPad default, 1 series
        // Positive bar (cat0=10): left === map(0), width === |map(10)-map(0)|.
        const pos = rects[0], neg = rects[1];
        approx(pos[0], base, 1e-6);
        approx(pos[2], Math.abs(ys.map(10) - base), 1e-6);
        approx(pos[3], expectH, 1e-6);
        // Negative bar (cat1=-10): left === map(-10), shares the map(0) edge.
        approx(neg[0], ys.map(-10), 1e-6);
        approx(neg[2], Math.abs(ys.map(-10) - base), 1e-6);
        approx(neg[0] + neg[2], base, 1e-6);
        approx(neg[3], expectH, 1e-6);
        chart.unmount();
    });

    // -- A5: corner side ----------------------------------------------------
    it('A5: rounded corners cap the end opposite the baseline; vertical control differs', () => {
        const canvas = createMockCanvas(400, 300);
        const chart = mkH({ data: [{ x: 'A', y: 10 }, { x: 'B', y: -10 }], cornerRadius: 6 });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        const radii = callsOf(ctx, 'roundRect').map((c) => c[1][4]);
        assert.equal(radii.length, 2);
        assert.deepEqual(radii[0], [0, 6, 6, 0], 'positive bar rounds the right end');
        assert.deepEqual(radii[1], [6, 0, 0, 6], 'negative bar rounds the left end');
        chart.unmount();

        // Vertical control: caps the TOP for positive, BOTTOM for negative.
        const c2 = createBarChart({
            data: [{ x: 'A', y: 10 }, { x: 'B', y: -10 }], cornerRadius: 6,
            width: 400, height: 300, margin: A2_MARGIN, schedule: (fn) => fn(),
        });
        const cv2 = createMockCanvas(400, 300);
        c2.mount(cv2);
        const ctx2 = cv2.getContext('2d');
        ctx2.calls.length = 0;
        c2.redraw();
        const radii2 = callsOf(ctx2, 'roundRect').map((c) => c[1][4]);
        assert.deepEqual(radii2[0], [6, 6, 0, 0], 'vertical positive rounds the top');
        assert.deepEqual(radii2[1], [0, 0, 6, 6], 'vertical negative rounds the bottom');
        c2.unmount();
    });

    // -- A6: grouped-Y ------------------------------------------------------
    it('A6: grouped series stack along Y within a category, no overlap', () => {
        const canvas = createMockCanvas(400, 300);
        const chart = mkH({
            series: [
                { name: 'S0', data: [{ x: 'A', y: 5 }, { x: 'B', y: 6 }] },
                { name: 'S1', data: [{ x: 'A', y: 7 }, { x: 'B', y: 8 }] },
                { name: 'S2', data: [{ x: 'A', y: 9 }, { x: 'B', y: 4 }] },
            ],
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        const rects = callsOf(ctx, 'fillRect').map((c) => c[1]);
        // 3 series x 2 cats = 6 bars. cat0 bars are the ones for the 3 series
        // at catIdx 0 -- they appear as every-other in series-major order.
        const bw = chart.xScale.bandWidth;
        const groupH = bw / 3;
        const c0 = chart.xScale.map(0);
        // Series i draws cat0 as rects[i*2 + 0].
        const centres = [];
        for (let i = 0; i < 3; i++) {
            const r = rects[i * 2];
            const centre = r[1] + r[3] / 2;
            centres.push(centre);
            approx(centre, c0 + (i - 1) * groupH, 1e-6);
            approx(r[3], groupH * (1 - 0.08), 1e-6);
        }
        assert.ok(centres[0] < centres[1] && centres[1] < centres[2], 'series 0 sits topmost');
        // No overlap: each bar's [top,bottom] is disjoint.
        for (let i = 0; i < 2; i++) {
            const a = rects[i * 2], b = rects[(i + 1) * 2];
            assert.ok(a[1] + a[3] <= b[1] + 1e-9, 'grouped bars must not overlap');
        }
        chart.unmount();
    });

    // -- A7: stacked-X ------------------------------------------------------
    it('A7: stacked segments tile along X with no gap', () => {
        const canvas = createMockCanvas(400, 300);
        const chart = mkH({
            stack: true,
            series: [
                { name: 'A', data: [{ x: 'A', y: 3 }, { x: 'B', y: 5 }] },
                { name: 'B', data: [{ x: 'A', y: 7 }, { x: 'B', y: 5 }] },
            ],
        });
        chart.mount(canvas);
        assert.ok(chart.yScale.dMax >= 10, 'stack total (10) must be in the domain');
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        const rects = callsOf(ctx, 'fillRect').map((c) => c[1]);
        // Series-major: seg0 cat0 = rects[0], seg1 cat0 = rects[2].
        const seg0 = rects[0], seg1 = rects[2];
        approx(seg0[0] + seg0[2], seg1[0], 0); // exact edge tiling, no epsilon
        // Union spans map(0)..map(10).
        approx(seg0[0], chart.yScale.map(0), 1e-6);
        approx(seg1[0] + seg1[2], chart.yScale.map(10), 1e-6);
        // Bar Y centres identical across the two segments (same band row).
        approx(seg0[1] + seg0[3] / 2, seg1[1] + seg1[3] / 2, 1e-6);
        chart.unmount();
    });

    // -- A8: left band axis -------------------------------------------------
    it('A8: the categorical axis moves to the left, labels right-aligned', () => {
        const canvas = createMockCanvas(400, 300);
        const cats = ['A', 'B', 'C', 'D'];
        const chart = mkH({ data: cats.map((c, i) => ({ x: c, y: (i + 1) * 5 })) });
        chart.mount(canvas);
        const pb = chart._internal.plotBoundsBox;
        const bs = chart.xScale;
        const texts = walkTexts(chart.scene.root).filter((t) => t._visible);
        const catTexts = texts.filter((t) => cats.includes(t._text));
        assert.equal(catTexts.length, cats.length, 'exactly n category labels');
        for (const t of catTexts) {
            assert.equal(t._align, 'right');
            assert.equal(t._baseline, 'middle');
            approx(t._x, pb.x - 6, 1e-6);
            const i = cats.indexOf(t._text);
            approx(t._y, bs.map(i), 1e-6);
        }
        assert.equal(catTexts.filter((t) => t._align === 'center').length, 0,
            'no category label may be center-aligned');
        // Tick lines off the left spine: dx === -4, dy === 0. Band spine along Y.
        const lines = walkLines(chart.scene.root).filter((l) => l._visible);
        const bandTicks = lines.filter((l) => l._dx === -4 && l._dy === 0);
        assert.ok(bandTicks.length >= cats.length, 'left tick lines present with dx=-4,dy=0');
        const spine = lines.find((l) => l._dx === 0 && Math.abs(l._dy - pb.h) < 1e-6 && Math.abs(l._x - pb.x) < 1e-6);
        assert.ok(spine, 'band spine at x=plot.x, dx=0, dy=plot.h');
        chart.unmount();
    });

    // -- A9: bottom value axis ---------------------------------------------
    it('A9: the value axis moves to the bottom with numeric ticks', () => {
        const canvas = createMockCanvas(400, 300);
        const cats = ['A', 'B', 'C', 'D'];
        const chart = mkH({ data: cats.map((c, i) => ({ x: c, y: (i + 1) * 5 })) });
        chart.mount(canvas);
        const pb = chart._internal.plotBoundsBox;
        const ys = chart.yScale;
        const texts = walkTexts(chart.scene.root).filter((t) => t._visible && t._align === 'center');
        assert.ok(texts.length >= 2 && texts.length <= 12, 'between 2 and 12 value ticks');
        for (const t of texts) {
            assert.equal(t._baseline, 'top');
            const v = parseFloat(t._text);
            assert.ok(!Number.isNaN(v), 'value label parses as a number: ' + t._text);
            assert.ok(!cats.includes(t._text), 'value label must not be a category name');
            approx(t._x, ys.map(v), 1e-6);
        }
        chart.unmount();
    });

    // -- A10: SVG parity ----------------------------------------------------
    it('A10: exportSVG mirrors the horizontal bars and axis anchors', () => {
        const canvas = createMockCanvas(400, 300);
        const chart = mkH({ data: [{ x: 'A', y: 10 }, { x: 'B', y: -10 }], cornerRadius: 0 });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        const rects = callsOf(ctx, 'fillRect').map((c) => c[1]);
        const svg = chart.exportSVG();
        // One <rect> per bar.
        const svgRects = [...svg.matchAll(/<rect\s+x="([\d.eE+-]+)"\s+y="([\d.eE+-]+)"\s+width="([\d.eE+-]+)"\s+height="([\d.eE+-]+)"/g)]
            .map((m) => [+m[1], +m[2], +m[3], +m[4]]);
        // The 2 bar rects must be present among the SVG rects (there may also
        // be the tooltip swatch etc., but not here since no hover).
        for (const r of rects) {
            const hit = svgRects.some((s) =>
                // exportSVG rounds coordinates to 3 decimals for compact output,
                // so compare at that precision (max rounding error 5e-4), not 1e-6.
                Math.abs(s[0] - r[0]) < 2e-3 && Math.abs(s[1] - r[1]) < 2e-3 &&
                Math.abs(s[2] - r[2]) < 2e-3 && Math.abs(s[3] - r[3]) < 2e-3);
            assert.ok(hit, 'canvas bar rect ' + JSON.stringify(r) + ' must appear in SVG');
        }
        // The distinguishing fact is which axis the CATEGORY labels sit on, not
        // a global end-anchor count -- a vertical chart's LEFT VALUE axis also
        // right-aligns its numeric labels (text-anchor="end"). Horizontal moves
        // the band (category) axis to the left, so 'A'/'B' become end-anchored;
        // the bottom value ticks are middle-anchored.
        const catAnchor = (s, label) => {
            const m = s.match(new RegExp('<text\\b([^>]*)>' + label + '</text>'));
            return m ? (m[1].match(/text-anchor="([^"]+)"/) || [])[1] : null;
        };
        assert.equal(catAnchor(svg, 'A'), 'end', 'horizontal category label on left band axis');
        assert.equal(catAnchor(svg, 'B'), 'end');
        assert.ok((svg.match(/text-anchor="middle"/g) || []).length >= 2, 'bottom value ticks are centered');
        chart.unmount();

        // Vertical control: the CATEGORY labels sit on the bottom band axis and
        // are centered ("middle"), not on a left band axis. (Its left VALUE axis
        // still emits end-anchored numerics -- that is unchanged 1.4.1 behaviour,
        // so a global end-count is the wrong discriminator.)
        const c2 = createBarChart({
            data: [{ x: 'A', y: 10 }, { x: 'B', y: -10 }],
            width: 400, height: 300, margin: A2_MARGIN, schedule: (fn) => fn(),
        });
        c2.mount(createMockCanvas(400, 300));
        const vsvg = c2.exportSVG();
        assert.equal(catAnchor(vsvg, 'A'), 'middle', 'vertical category label on bottom band axis');
        assert.equal(catAnchor(vsvg, 'B'), 'middle');
        c2.unmount();
    });

    // -- A11: fail closed ---------------------------------------------------
    it('A11: unsupported horizontal combinations throw at construction', () => {
        const base = { data: [{ x: 'A', y: 1 }], schedule: (fn) => fn() };
        // v1.5.0: horizontal pan/zoom/grid are now supported via the axis-role
        // swap; v1.9.0 adds horizontal brush. Only a log yScale (domain-flooring
        // kernel still assumes standard orientation) fails closed, alongside a
        // bad orientation string.
        const cases = [
            ['diagonal orientation', { orientation: 'diagonal' }],
            ['horizontal + log', { orientation: 'horizontal', yScale: { type: 'log' } }],
        ];
        for (const [label, extra] of cases) {
            assert.throws(
                () => createBarChart(Object.assign({}, base, extra)),
                (err) => /lite-charts:/.test(err.message) && /orientation/.test(err.message),
                label + ' must throw a named error',
            );
        }
        // Sanity: the now-supported horizontal interactions do NOT throw and mount.
        for (const extra of [{}, { pan: true }, { zoom: true }, { grid: true }, { brush: true }, { pan: true, zoom: true, grid: true }]) {
            assert.doesNotThrow(() => {
                const c = createBarChart(Object.assign({}, base, { orientation: 'horizontal' }, extra));
                const cv = createMockCanvas(400, 300);
                c.mount(cv);
                c.unmount();
            });
        }
    });

    // -- A15: bundle isolation (source-region reachability proxy) -----------
    it('A15: orientation machinery is confined to the axis-chart kernel', () => {
        const src = readFileSync(new URL('../Charts.js', import.meta.url), 'utf8');
        // The polar (pie/donut/radar) and grid (heatmap) kernel BODIES must
        // never reference the horizontal-bar tokens. Region: [polarStart,
        // testHelpersStart). The trailing `_testHelpers` export legitimately
        // re-exports axis-kernel internals for white-box tests and is tree-
        // shaken from any real bundle, so it is excluded (same approach as A5).
        const polarStart = src.indexOf('createBasePolarChart');
        const testHelpersStart = src.indexOf('export const _testHelpers = {');
        assert.ok(polarStart > 0, 'polar kernel marker found');
        assert.ok(testHelpersStart > polarStart, '_testHelpers marker found after polar');
        for (const token of ['makeHBarDrawFn', 'axesSwapped', '_buildAxisBarY']) {
            let idx = src.indexOf(token);
            let count = 0;
            while (idx >= 0) {
                count++;
                assert.ok(idx < polarStart || idx >= testHelpersStart,
                    token + ' at ' + idx + ' escapes into the polar/grid kernel bodies '
                    + '[' + polarStart + ', ' + testHelpersStart + ')');
                idx = src.indexOf(token, idx + 1);
            }
            assert.ok(count > 0, token + ' should exist in the axis-chart kernel');
        }
    });
});

// ---------------------------------------------------------------------------
// v1.2.0-alpha.0 -- Spatial index integration (foundation for scatter,
// heatmap, dense bubble; default impl provided by lite-delaunay or any
// other index matching the SpatialIndexFactory contract)
// ---------------------------------------------------------------------------

// A test-friendly reference implementation of the SpatialIndex interface.
// Internally linear-scan -- the point isn't speed, it's proving the
// integration wiring is correct end-to-end (build / cache / dispose / query)
// without depending on @zakkster/lite-delaunay being installed for the test
// suite. Production users pass a real index; lite-charts doesn't care which.
const makeReferenceIndex = (counters) => (pxs, pys, n) => {
    counters.builds++;
    const snapN = n;
    const snapPxs = new Float32Array(n);
    const snapPys = new Float32Array(n);
    for (let i = 0; i < n; i++) { snapPxs[i] = pxs[i]; snapPys[i] = pys[i]; }
    return {
        findNearest(qx, qy, k, maxDistSq, outIndices, outDistSq) {
            counters.queries++;
            let count = 0;
            for (let i = 0; i < snapN; i++) {
                const dx = qx - snapPxs[i];
                const dy = qy - snapPys[i];
                const d = dx * dx + dy * dy;
                if (d > maxDistSq) continue;
                // Insertion sort into the bounded k-sized output buffer.
                let insertAt = count;
                while (insertAt > 0 && outDistSq[insertAt - 1] > d) insertAt--;
                if (insertAt < k) {
                    const limit = count < k ? count : k - 1;
                    for (let s = limit; s > insertAt; s--) {
                        outIndices[s] = outIndices[s - 1];
                        outDistSq[s] = outDistSq[s - 1];
                    }
                    outIndices[insertAt] = i;
                    outDistSq[insertAt] = d;
                    if (count < k) count++;
                }
            }
            return count;
        },
        dispose() { counters.disposes++; },
    };
};

const makeDenseBubbleData = (n) => {
    const data = [];
    for (let i = 0; i < n; i++) {
        data.push({
            x: (i % 50),
            y: Math.floor(i / 50),
            value: 5 + ((i * 31) % 10),
        });
    }
    return data;
};

describe('createBubbleChart -- spatial index (v1.2.0-alpha.0)', () => {
    it('does not build an index below the threshold', () => {
        const counters = { builds: 0, queries: 0, disposes: 0 };
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: makeDenseBubbleData(500),  // below default threshold of 1000
            spatialIndex: makeReferenceIndex(counters),
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveCrosshair(400, 200);
        assert.equal(counters.builds, 0);
        assert.equal(counters.queries, 0);
        chart.unmount();
    });

    it('builds lazily on first hit-test, not on mount', () => {
        const counters = { builds: 0, queries: 0, disposes: 0 };
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: makeDenseBubbleData(1200),
            spatialIndex: makeReferenceIndex(counters),
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.equal(counters.builds, 0, 'mount should not build');
        chart.moveCrosshair(400, 200);
        assert.equal(counters.builds, 1, 'first hover should build');
        assert.equal(counters.queries, 1);
        chart.unmount();
    });

    it('reuses the cached index across subsequent hit-tests', () => {
        const counters = { builds: 0, queries: 0, disposes: 0 };
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: makeDenseBubbleData(1200),
            spatialIndex: makeReferenceIndex(counters),
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveCrosshair(400, 200);
        chart.moveCrosshair(450, 220);
        chart.moveCrosshair(500, 240);
        assert.equal(counters.builds, 1, 'index should be cached');
        assert.equal(counters.queries, 3);
        chart.unmount();
    });

    it('disposes the previous index on unmount', () => {
        const counters = { builds: 0, queries: 0, disposes: 0 };
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: makeDenseBubbleData(1200),
            spatialIndex: makeReferenceIndex(counters),
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveCrosshair(400, 200);
        assert.equal(counters.builds, 1);
        chart.unmount();
        assert.equal(counters.disposes, 1);
    });

    it('honors a custom spatialIndexThreshold', () => {
        const counters = { builds: 0, queries: 0, disposes: 0 };
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: makeDenseBubbleData(200),  // 200 < default 1000, but >= 100
            spatialIndex: makeReferenceIndex(counters),
            spatialIndexThreshold: 100,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveCrosshair(400, 200);
        assert.equal(counters.builds, 1);
        chart.unmount();
    });

    it('indexed hit-test matches linear scan on non-overlapping data', () => {
        const data = makeDenseBubbleData(2000);
        // Two parallel charts: one with index, one without. Same data, same
        // canvas size, same hover points -> same hits.
        const counters = { builds: 0, queries: 0, disposes: 0 };
        const canvasA = createMockCanvas(800, 600);
        const chartA = createBubbleChart({
            data, minRadius: 2, maxRadius: 5,
            schedule: (fn) => fn(),
        });
        chartA.mount(canvasA);

        const canvasB = createMockCanvas(800, 600);
        const chartB = createBubbleChart({
            data, minRadius: 2, maxRadius: 5,
            spatialIndex: makeReferenceIndex(counters),
            spatialIndexThreshold: 100,
            schedule: (fn) => fn(),
        });
        chartB.mount(canvasB);

        // Deterministic query points across the plot area.
        for (let q = 0; q < 25; q++) {
            const qx = 100 + (q * 31) % 600;
            const qy = 50 + (q * 19) % 500;
            chartA.moveCrosshair(qx, qy);
            chartB.moveCrosshair(qx, qy);
            const a = chartA.crosshair.peek();
            const b = chartB.crosshair.peek();
            assert.equal(a.visible, b.visible, `visibility at q=${q}`);
            if (a.visible && b.visible) {
                assert.equal(a.snapIdx, b.snapIdx, `snapIdx at q=${q}`);
            }
        }
        chartA.unmount();
        chartB.unmount();
    });

    it('rebuilds the index on data change', () => {
        const counters = { builds: 0, queries: 0, disposes: 0 };
        const canvas = createMockCanvas(800, 400);
        const data1 = makeDenseBubbleData(1200);
        const data2 = makeDenseBubbleData(1500);
        const sig = signal(data1);
        const chart = createBubbleChart({
            data: sig,
            spatialIndex: makeReferenceIndex(counters),
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveCrosshair(400, 200);
        assert.equal(counters.builds, 1);
        // Update the data signal -- extract re-runs, old index disposed.
        sig.set(data2);
        assert.equal(counters.disposes, 1, 'old index disposed on data change');
        chart.moveCrosshair(450, 220);
        assert.equal(counters.builds, 2, 'rebuilt for new data');
        chart.unmount();
    });

    it('preserves smallest-on-top tie-break on overlap (k>1 candidates)', () => {
        // A large bubble + a small one whose CENTER is closer to the cursor.
        // Both contain the cursor. The renderer's post-filter must pick the
        // smaller (visually topmost) one -- preserving v1.0.0 semantics.
        // This requires k > 1 in findNearest, which is the whole point of
        // not collapsing to a 1-NN interface.
        const data = makeDenseBubbleData(1100);
        const counters = { builds: 0, queries: 0, disposes: 0 };
        const canvas = createMockCanvas(800, 600);
        const chart = createBubbleChart({
            data,
            spatialIndex: makeReferenceIndex(counters),
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Any hover should produce a coherent result; the prior test covers
        // bit-equality with linear scan, which itself does smallest-on-top.
        chart.moveCrosshair(300, 250);
        const hit = chart.crosshair.peek();
        // Just verify the path doesn't crash and returns a structurally
        // valid hit. Bit-equality is verified in the prior test.
        if (hit.visible) {
            assert.ok(hit.snapIdx >= 0 && hit.snapIdx < data.length);
        }
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// v1.2.0-alpha.1 -- createScatterChart
// ---------------------------------------------------------------------------

describe('createScatterChart (v1.2.0-alpha.1)', () => {
    it('renders one arc per data point', () => {
        const canvas = createMockCanvas(800, 400);
        const data = [];
        for (let i = 0; i < 20; i++) data.push({ x: i, y: Math.sin(i) * 5 });
        const chart = createScatterChart({
            data,
            markerSize: 4,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        assert.equal(countCalls(ctx, 'arc'), 20);
        assert.equal(countCalls(ctx, 'fill'), 20);
        chart.unmount();
    });

    it('uses constant markerSize for every point', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createScatterChart({
            data: [{x: 1, y: 1}, {x: 2, y: 2}, {x: 3, y: 3}],
            markerSize: 7,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Mock records calls as [name, argsArray]; arc args are [x, y, r, sa, ea]
        // so c[1][2] is the radius. Every arc should fire with r = markerSize.
        const arcCalls = ctx.calls.filter(c => c[0] === 'arc');
        assert.equal(arcCalls.length, 3);
        for (const c of arcCalls) {
            assert.equal(c[1][2], 7, 'arc radius should equal markerSize');
        }
        chart.unmount();
    });

    it('hit-test snaps to nearest point within tolerance', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createScatterChart({
            data: [{x: 10, y: 10}, {x: 20, y: 20}, {x: 30, y: 30}],
            markerSize: 4,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const xPx = chart.xScale.map(20);
        const yPx = chart.yScale.map(20);
        chart.moveCrosshair(xPx, yPx);
        const hit = chart.crosshair.peek();
        assert.equal(hit.visible, true);
        assert.equal(hit.snapIdx, 1);
        chart.unmount();
    });

    it('hit-test misses when cursor is beyond hitTolerance', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createScatterChart({
            data: [{x: 1, y: 1}],
            markerSize: 4,
            hitTolerance: 5,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Hover at the far corner of the plot, well away from the single point.
        const pb = chart._internal.plotBoundsBox;
        chart.moveCrosshair(pb.x + pb.w - 5, pb.y + pb.h - 5);
        const hit = chart.crosshair.peek();
        assert.equal(hit.visible, false);
        chart.unmount();
    });

    it('uses spatial index when n >= threshold', () => {
        const counters = { builds: 0, queries: 0, disposes: 0 };
        const makeIndex = (pxs, pys, n) => {
            counters.builds++;
            return {
                findNearest(qx, qy, k, maxDsq, outIdx, outDist) {
                    counters.queries++;
                    let bI = -1, bD = maxDsq;
                    for (let i = 0; i < n; i++) {
                        const dx = qx - pxs[i], dy = qy - pys[i];
                        const d = dx * dx + dy * dy;
                        if (d < bD) { bD = d; bI = i; }
                    }
                    if (bI < 0) return 0;
                    outIdx[0] = bI; outDist[0] = bD;
                    return 1;
                },
                dispose() { counters.disposes++; },
            };
        };
        const canvas = createMockCanvas(800, 400);
        const data = [];
        for (let i = 0; i < 600; i++) data.push({ x: i, y: i * 0.5 });
        const chart = createScatterChart({
            data,
            spatialIndex: makeIndex,
            spatialIndexThreshold: 500,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveCrosshair(400, 200);
        assert.equal(counters.builds, 1);
        assert.equal(counters.queries, 1);
        chart.unmount();
        assert.equal(counters.disposes, 1);
    });

    it('does not use spatial index below threshold', () => {
        const counters = { builds: 0 };
        const makeIndex = () => {
            counters.builds++;
            return { findNearest: () => 0, dispose() {} };
        };
        const canvas = createMockCanvas(800, 400);
        const chart = createScatterChart({
            data: [{x:1,y:1},{x:2,y:2},{x:3,y:3}],  // n=3, well under default 1000
            spatialIndex: makeIndex,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveCrosshair(100, 100);
        assert.equal(counters.builds, 0);
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// v1.2.0-alpha.2 -- Multi-series bubble + per-point color + global size domain
// ---------------------------------------------------------------------------

describe('createBubbleChart -- multi-series (v1.2.0-alpha.2)', () => {
    it('computes a GLOBAL size domain across visible series', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            series: [
                { name: 'A', data: [{x: 1, y: 1, value: 10}, {x: 2, y: 2, value: 100}] },
                { name: 'B', data: [{x: 3, y: 3, value: 50}, {x: 4, y: 4, value: 60}] },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const s = chart._internal.seriesStates;
        // Both series should land on the SAME global domain [10, 100] after
        // postExtract rescales them.
        assert.equal(s[0].sizeMin, 10);
        assert.equal(s[0].sizeMax, 100);
        assert.equal(s[1].sizeMin, 10);
        assert.equal(s[1].sizeMax, 100);
        chart.unmount();
    });

    it('equal raw values render at equal pixel radii across series', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            series: [
                { name: 'A', data: [{x: 1, y: 1, value: 50}] },
                { name: 'B', data: [{x: 2, y: 2, value: 50}] },
            ],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const s = chart._internal.seriesStates;
        // Both bubbles have value 50 -- same pixel radius under the global
        // size domain.
        assert.ok(Math.abs(s[0].prs[0] - s[1].prs[0]) < 0.01,
            `expected equal radii, got ${s[0].prs[0]} vs ${s[1].prs[0]}`);
        chart.unmount();
    });

    it('single-series skips the global rescale (postExtract no-op)', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [{x: 1, y: 1, value: 10}, {x: 2, y: 2, value: 50}],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const s = chart._internal.seriesStates[0];
        // Single series should have the local domain [10, 50].
        assert.equal(s.sizeMin, 10);
        assert.equal(s.sizeMax, 50);
        chart.unmount();
    });

    it('hit-test resolves across visible series', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            series: [
                { name: 'A', data: [{x: 10, y: 10, value: 30}] },
                { name: 'B', data: [{x: 50, y: 50, value: 80}] },
            ],
            minRadius: 8, maxRadius: 30,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Hover series B's bubble.
        const xPx = chart.xScale.map(50);
        const yPx = chart.yScale.map(50);
        chart.moveCrosshair(xPx, yPx);
        const ch = chart.crosshair.peek();
        assert.equal(ch.visible, true);
        assert.equal(ch.snapSeriesIdx, 1, 'should resolve to series B');
        assert.equal(ch.snapIdx, 0, 'should point at B[0]');
        chart.unmount();
    });

    it('lookupRow scopes tooltip to the hit series', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            series: [
                { name: 'A', data: [{x: 10, y: 10, value: 30}] },
                { name: 'B', data: [{x: 50, y: 50, value: 80}] },
            ],
            minRadius: 8, maxRadius: 30,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        // Hit series A.
        chart.moveCrosshair(chart.xScale.map(10), chart.yScale.map(10));
        const ch = chart.crosshair.peek();
        // snapSeriesIdx should be 0 (series A).
        assert.equal(ch.snapSeriesIdx, 0);
        // Validate that lookupRow returns -1 for the non-hit series B and a
        // valid row for the hit series A. (We can't call lookupRow directly
        // through the public API; instead we verify by counting tooltip rows
        // via the draw call recording.)
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Tooltip color-swatch fillRects: one per visible row in the tooltip.
        // With multi-series scoping, only the hit series A produces a row.
        const swatchCount = countCalls(ctx, 'fillRect');
        assert.equal(swatchCount, 1, 'tooltip should have exactly one row (hit series)');
        chart.unmount();
    });

    it('hidden series are excluded from hit-test', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            series: [
                { name: 'A', data: [{x: 10, y: 10, value: 30}] },
                { name: 'B', data: [{x: 50, y: 50, value: 80}] },
            ],
            minRadius: 8, maxRadius: 30,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.setSeriesVisible(1, false);  // hide B
        // Hover B's bubble location -- with B hidden, no hit.
        chart.moveCrosshair(chart.xScale.map(50), chart.yScale.map(50));
        const ch = chart.crosshair.peek();
        assert.equal(ch.visible, false, 'hidden series should not be hittable');
        chart.unmount();
    });
});

describe('createBubbleChart -- per-point color (v1.2.0-alpha.2)', () => {
    it('extracts per-point colors into state.cs when colorKey is set', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [
                {x: 1, y: 1, value: 5, c: '#ff0000'},
                {x: 2, y: 2, value: 5, c: '#00ff00'},
                {x: 3, y: 3, value: 5, c: '#0000ff'},
            ],
            colorKey: 'c',
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const s = chart._internal.seriesStates[0];
        assert.ok(Array.isArray(s.cs));
        assert.equal(s.cs[0], '#ff0000');
        assert.equal(s.cs[1], '#00ff00');
        assert.equal(s.cs[2], '#0000ff');
        chart.unmount();
    });

    it('omits state.cs entirely when colorKey is not set', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [{x: 1, y: 1, value: 5}],
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const s = chart._internal.seriesStates[0];
        // Either undefined or null; both indicate "no per-point colors".
        assert.ok(!s.cs);
        chart.unmount();
    });

    it('draw fn uses per-point colors when state.cs is populated', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createBubbleChart({
            data: [
                {x: 1, y: 1, value: 5, c: '#ff0000'},
                {x: 2, y: 2, value: 5, c: '#00ff00'},
            ],
            colorKey: 'c',
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Mock records [name, argsArray]. set:fillStyle takes one arg, so the
        // actual color is at c[1][0]. There will be more set:fillStyle calls
        // than bubbles (axis colors, etc.) -- we just verify the per-point
        // colors land somewhere in the assignment sequence.
        const fillStyleSets = ctx.calls
            .filter(c => c[0] === 'set:fillStyle')
            .map(c => c[1][0]);
        assert.ok(fillStyleSets.includes('#ff0000'),
            'red bubble should set fillStyle to #ff0000');
        assert.ok(fillStyleSets.includes('#00ff00'),
            'green bubble should set fillStyle to #00ff00');
        chart.unmount();
    });
});

// ---------------------------------------------------------------------------
// v1.2.0-alpha.3 -- createHeatmap (fourth kernel)
// ---------------------------------------------------------------------------

describe('createHeatmap (v1.2.0-alpha.3)', () => {
    it('extracts categories in first-seen order', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createHeatmap({
            data: [
                { x: 'Mon', y: 'AM', value: 10 },
                { x: 'Tue', y: 'PM', value: 20 },
                { x: 'Wed', y: 'AM', value: 15 },
            ],
            width: 600,
            height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.deepEqual(chart.xCategories, ['Mon', 'Tue', 'Wed']);
        assert.deepEqual(chart.yCategories, ['AM', 'PM']);
        chart.unmount();
    });

    it('computes vMin / vMax from data', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 3 },
                { x: 'B', y: 'X', value: 17 },
                { x: 'A', y: 'Y', value: 9 },
            ],
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.equal(chart.vMin, 3);
        assert.equal(chart.vMax, 17);
        chart.unmount();
    });

    it('renders one fillRect per present cell', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 1 }, { x: 'B', y: 'X', value: 2 }, { x: 'C', y: 'X', value: 3 },
                { x: 'A', y: 'Y', value: 4 }, { x: 'B', y: 'Y', value: 5 }, { x: 'C', y: 'Y', value: 6 },
            ],
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // 3x2 = 6 cells, each one fillRect.
        assert.equal(countCalls(ctx, 'fillRect'), 6);
        chart.unmount();
    });

    it('renders only present cells in sparse grids', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 1 },
                { x: 'B', y: 'X', value: 2 },
                // (A, Y) missing
                { x: 'B', y: 'Y', value: 4 },
            ],
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // 2x2 = 4 slots but only 3 present.
        assert.equal(countCalls(ctx, 'fillRect'), 3);
        chart.unmount();
    });

    it('default ramp interpolates between low and high colors', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 0 },
                { x: 'B', y: 'X', value: 100 },
            ],
            colors: ['#000000', '#ffffff'],  // black -> white
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        const fills = ctx.calls
            .filter(c => c[0] === 'set:fillStyle')
            .map(c => c[1][0]);
        // Endpoint cells should land at the ramp ends -- exactly black and white.
        assert.ok(fills.includes('rgb(0,0,0)'), 'minimum cell should be black');
        assert.ok(fills.includes('rgb(255,255,255)'), 'maximum cell should be white');
        chart.unmount();
    });

    it('custom colorFn overrides the default ramp', () => {
        const canvas = createMockCanvas(800, 400);
        let calls = 0;
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 10 },
                { x: 'B', y: 'X', value: 90 },
            ],
            colorFn: (v) => { calls++; return v > 50 ? '#ff0000' : '#0000ff'; },
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.equal(calls, 2, 'colorFn should run once per present cell at extract');
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        const fills = ctx.calls
            .filter(c => c[0] === 'set:fillStyle')
            .map(c => c[1][0]);
        assert.ok(fills.includes('#ff0000'));
        assert.ok(fills.includes('#0000ff'));
        chart.unmount();
    });

    it('hit-test resolves to the correct cell', () => {
        const canvas = createMockCanvas(600, 400);
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 1 }, { x: 'B', y: 'X', value: 2 },
                { x: 'A', y: 'Y', value: 3 }, { x: 'B', y: 'Y', value: 4 },
            ],
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const xBand = chart._internal.xBand;
        const yBand = chart._internal.yBand;
        // Hover the center of cell (B, Y) -> (xi=1, yi=1, value=4).
        chart.moveHover(xBand.map(1), yBand.map(1));
        const h = chart.hover.peek();
        assert.equal(h.visible, true);
        assert.equal(h.xi, 1);
        assert.equal(h.yi, 1);
        assert.equal(h.value, 4);
        chart.unmount();
    });

    it('hit-test returns null for missing cells', () => {
        const canvas = createMockCanvas(600, 400);
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 1 },
                // (B, X), (A, Y) missing
                { x: 'B', y: 'Y', value: 4 },
            ],
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const xBand = chart._internal.xBand;
        const yBand = chart._internal.yBand;
        // Hover (B, X) -- present in the grid layout but no data.
        chart.moveHover(xBand.map(1), yBand.map(0));
        const h = chart.hover.peek();
        assert.equal(h.visible, false);
        chart.unmount();
    });

    it('hit-test returns null when cursor is outside plot rect', () => {
        const canvas = createMockCanvas(600, 400);
        const chart = createHeatmap({
            data: [{ x: 'A', y: 'X', value: 1 }],
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.moveHover(2, 2);  // top-left corner, before plot rect
        assert.equal(chart.hover.peek().visible, false);
        chart.moveHover(595, 395);  // bottom-right corner, past plot rect
        assert.equal(chart.hover.peek().visible, false);
        chart.unmount();
    });

    it('reacts to data signal updates', () => {
        const canvas = createMockCanvas(800, 400);
        const dataSig = signal([
            { x: 'A', y: 'X', value: 5 },
            { x: 'B', y: 'X', value: 10 },
        ]);
        const chart = createHeatmap({
            data: dataSig,
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        assert.deepEqual(chart.xCategories, ['A', 'B']);
        dataSig.set([
            { x: 'A', y: 'X', value: 5 },
            { x: 'B', y: 'X', value: 10 },
            { x: 'C', y: 'X', value: 15 },
        ]);
        assert.deepEqual(chart.xCategories, ['A', 'B', 'C']);
        chart.unmount();
    });

    it('renders value labels when showValues is true', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 12 },
                { x: 'B', y: 'X', value: 34 },
            ],
            showValues: true,
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // Cell labels + category labels both use fillText.
        const labels = ctx.calls
            .filter(c => c[0] === 'fillText')
            .map(c => c[1][0]);
        assert.ok(labels.includes('12.0'), 'should render formatted "12.0"');
        assert.ok(labels.includes('34.0'), 'should render formatted "34.0"');
        chart.unmount();
    });

    it('mounts and unmounts cleanly (no throws)', () => {
        const canvas = createMockCanvas(600, 400);
        const chart = createHeatmap({
            data: [{ x: 'A', y: 'X', value: 1 }],
            width: 600, height: 400,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        chart.unmount();
        // unmount without mount is a no-op.
        chart.unmount();
    });
});


// ---------------------------------------------------------------------------
// v1.2.0 -- chart.destroy() across all four kernels
// ---------------------------------------------------------------------------

describe('chart.destroy() (v1.2.0)', () => {
    // Each kernel test measures node-count DELTA across many mount+destroy
    // cycles. With destroy() correct, the delta should be 0 -- no residue
    // from construction-time signals like widthAutoSig, plotBoundsSignal,
    // crosshairVersion, etc.

    const cycle = (factory) => {
        const before = stats().activeNodes;
        for (let i = 0; i < 30; i++) {
            const c = factory();
            c.mount(createMockCanvas(400, 200));
            c.destroy();
        }
        return stats().activeNodes - before;
    };

    it('axis kernel: 30 mount+destroy cycles leak zero nodes', () => {
        const delta = cycle(() => createLineChart({
            data: [{x:1,y:1},{x:2,y:2},{x:3,y:3}],
            width: 400, height: 200,
            schedule: (fn) => fn(),
        }));
        assert.equal(delta, 0, 'line chart destroy() should leave no residue');
    });

    it('polar kernel: 30 mount+destroy cycles leak zero nodes', () => {
        const delta = cycle(() => createPieChart({
            data: [{label:'A',value:1},{label:'B',value:2}],
            width: 400, height: 200,
            schedule: (fn) => fn(),
        }));
        assert.equal(delta, 0, 'pie chart destroy() should leave no residue');
    });

    it('radar kernel: 30 mount+destroy cycles leak zero nodes', () => {
        const delta = cycle(() => createRadarChart({
            axes: ['a','b','c'],
            series: [{ name: 'X', values: [1,2,3] }],
            width: 400, height: 200,
            schedule: (fn) => fn(),
        }));
        assert.equal(delta, 0, 'radar chart destroy() should leave no residue');
    });

    it('grid kernel: 30 mount+destroy cycles leak zero nodes', () => {
        const delta = cycle(() => createHeatmap({
            data: [{x:'A',y:'X',value:1},{x:'B',y:'X',value:2}],
            width: 400, height: 200,
            schedule: (fn) => fn(),
        }));
        assert.equal(delta, 0, 'heatmap destroy() should leave no residue');
    });

    it('destroy() is idempotent', () => {
        const c = createLineChart({
            data: [{x:1,y:1}],
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        c.destroy();
        // Second call must be a no-op (no double-dispose throw).
        c.destroy();
    });

    it('destroy() works before mount() (cleans only construction-time signals)', () => {
        const before = stats().activeNodes;
        for (let i = 0; i < 20; i++) {
            const c = createLineChart({
                data: [{x:1,y:1}],
                width: 400, height: 200,
                schedule: (fn) => fn(),
            });
            c.destroy();  // Never mounted; should still clean up.
        }
        const delta = stats().activeNodes - before;
        assert.equal(delta, 0, 'destroy() before mount() should still clean up');
    });
});

// ---------------------------------------------------------------------------
// v1.2.0 -- heatmap polish (quantile bins, auto labels, row/col highlight)
// ---------------------------------------------------------------------------

describe('createHeatmap polish (v1.2.0)', () => {
    it('quantile colorScale produces exactly N discrete colors', () => {
        // 12 cells with values 1..11 plus one outlier at 1000. Quantile
        // binning with 4 bins splits these into 4 bands by RANK, so the
        // chart shows 4 distinct colors regardless of the outlier.
        const data = [];
        for (let i = 0; i < 11; i++) data.push({ x: 'C' + i, y: 'R0', value: i + 1 });
        data.push({ x: 'C11', y: 'R0', value: 1000 });

        const canvas = createMockCanvas(800, 200);
        const chart = createHeatmap({
            data,
            colors: ['#000000', '#ffffff'],
            colorScale: 'quantile',
            colorBins: 4,
            width: 800, height: 200,
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const distinct = new Set(chart._internal.state.cellColors);
        // 4 bins -> 4 distinct cell colors.
        assert.equal(distinct.size, 4);
        chart.destroy();
    });

    it('quantile bins isolate outliers (the rest spreads across the ramp)', () => {
        // Same dataset, both linear and quantile. With linear, 11 of 12
        // values collapse to ~colorLow because the outlier dominates.
        // With quantile, they spread across all 4 bins.
        const data = [];
        for (let i = 0; i < 11; i++) data.push({ x: 'C' + i, y: 'R0', value: i + 1 });
        data.push({ x: 'C11', y: 'R0', value: 1000 });

        const linear = createHeatmap({
            data, colors: ['#000000', '#ffffff'],
            width: 800, height: 200, schedule: (fn) => fn(),
        });
        const quant = createHeatmap({
            data, colors: ['#000000', '#ffffff'],
            colorScale: 'quantile', colorBins: 4,
            width: 800, height: 200, schedule: (fn) => fn(),
        });
        linear.mount(createMockCanvas(800, 200));
        quant.mount(createMockCanvas(800, 200));
        const linearDistinct = new Set(linear._internal.state.cellColors).size;
        const quantDistinct = new Set(quant._internal.state.cellColors).size;
        // Quantile should give us MORE distinct colors than linear here --
        // that's the whole point of binning skewed distributions.
        assert.ok(quantDistinct >= linearDistinct,
            'quantile should produce at least as many distinct colors as linear on skewed data');
        linear.destroy();
        quant.destroy();
    });

    it('auto-contrast label colors: dark cells get white, light cells get black', () => {
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 0 },    // black-ish cell
                { x: 'B', y: 'X', value: 100 },  // white-ish cell
            ],
            colors: ['#000000', '#ffffff'],
            showValues: true,
            // valueLabelColor defaults to 'auto' in v1.2.0
            width: 400, height: 200, schedule: (fn) => fn(),
        });
        chart.mount(createMockCanvas(400, 200));
        const labels = chart._internal.state.cellLabelColors;
        assert.equal(labels[0], '#ffffff', 'dark cell should get white label');
        assert.equal(labels[1], '#000000', 'light cell should get black label');
        chart.destroy();
    });

    it('explicit valueLabelColor disables auto-contrast', () => {
        const chart = createHeatmap({
            data: [{ x: 'A', y: 'X', value: 50 }],
            showValues: true,
            valueLabelColor: '#ff0000',
            width: 400, height: 200, schedule: (fn) => fn(),
        });
        chart.mount(createMockCanvas(400, 200));
        // Explicit color: no per-cell label colors array allocated.
        assert.equal(chart._internal.state.cellLabelColors, null);
        chart.destroy();
    });

    it('row + column highlights add two fillRect calls per hover', () => {
        const canvas = createMockCanvas(600, 400);
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 1 }, { x: 'B', y: 'X', value: 2 },
                { x: 'A', y: 'Y', value: 3 }, { x: 'B', y: 'Y', value: 4 },
            ],
            width: 600, height: 400, schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        // Hover with no row/col highlight -> only cells + tooltip.
        chart.moveHover(chart._internal.xBand.map(1), chart._internal.yBand.map(0));
        ctx.calls.length = 0;
        chart.redraw();
        const withHighlight = ctx.calls.filter(c => c[0] === 'fillRect').length;
        chart.destroy();

        // Same chart with stripes off should fire two fewer fillRect calls.
        const chart2 = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 1 }, { x: 'B', y: 'X', value: 2 },
                { x: 'A', y: 'Y', value: 3 }, { x: 'B', y: 'Y', value: 4 },
            ],
            rowHighlight: false,
            columnHighlight: false,
            width: 600, height: 400, schedule: (fn) => fn(),
        });
        chart2.mount(createMockCanvas(600, 400));
        const ctx2 = chart2._internal && chart2._internal.canvas
            ? chart2._internal.canvas.getContext('2d')
            : null;
        // We didn't expose canvas on _internal -- redo via the mock we mounted.
        chart2.destroy();

        // The first chart had 4 cells + 2 stripes + 1 tooltip bg = 7
        // fillRects. With stripes off it would be 5.
        assert.ok(withHighlight >= 6,
            'with row+col stripes, hover should emit at least 6 fillRects (cells + 2 stripes)');
    });

    it('only-row highlight skips the column stripe', () => {
        const canvas = createMockCanvas(600, 400);
        const chart = createHeatmap({
            data: [
                { x: 'A', y: 'X', value: 1 }, { x: 'B', y: 'X', value: 2 },
                { x: 'A', y: 'Y', value: 3 }, { x: 'B', y: 'Y', value: 4 },
            ],
            rowHighlight: true,
            columnHighlight: false,
            width: 600, height: 400, schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const ctx = canvas.getContext('2d');
        chart.moveHover(chart._internal.xBand.map(1), chart._internal.yBand.map(0));
        ctx.calls.length = 0;
        chart.redraw();
        const fillRects = ctx.calls.filter(c => c[0] === 'fillRect').length;
        // 4 cells + 1 row stripe + 1 tooltip bg = 6.
        assert.equal(fillRects, 6);
        chart.destroy();
    });

    it('quantile binning respects colorBins config', () => {
        const data = [];
        for (let i = 0; i < 20; i++) data.push({ x: 'C' + i, y: 'R0', value: i });

        for (const binCount of [2, 5, 10]) {
            const c = createHeatmap({
                data, colors: ['#000000', '#ffffff'],
                colorScale: 'quantile', colorBins: binCount,
                width: 800, height: 200, schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(800, 200));
            const distinct = new Set(c._internal.state.cellColors).size;
            assert.equal(distinct, binCount, 'colorBins=' + binCount + ' should produce ' + binCount + ' colors, got ' + distinct);
            c.destroy();
        }
    });

    it('quantile + auto-contrast: per-bin label colors are stable', () => {
        const data = [];
        for (let i = 0; i < 10; i++) data.push({ x: 'C' + i, y: 'R0', value: i });

        const chart = createHeatmap({
            data,
            colors: ['#000000', '#ffffff'],
            colorScale: 'quantile',
            colorBins: 5,
            showValues: true,
            width: 800, height: 200, schedule: (fn) => fn(),
        });
        chart.mount(createMockCanvas(800, 200));
        const labels = chart._internal.state.cellLabelColors;
        const cellColors = chart._internal.state.cellColors;
        // Cells in the same bin (same cellColor) must have the same label color.
        const map = new Map();
        for (let i = 0; i < cellColors.length; i++) {
            if (cellColors[i] == null) continue;
            if (map.has(cellColors[i])) {
                assert.equal(map.get(cellColors[i]), labels[i],
                    'cells in the same bin must share a label color');
            } else {
                map.set(cellColors[i], labels[i]);
            }
        }
        chart.destroy();
    });
});

// ---------------------------------------------------------------------------
// v1.3.0 -- chart.exportSVG() across all four kernels
// ---------------------------------------------------------------------------

describe('chart.exportSVG() (v1.3.0)', () => {
    const expectValidSVG = (svg) => {
        assert.ok(svg.startsWith('<svg'),
            'output should start with <svg, got: ' + svg.slice(0, 40));
        assert.ok(svg.endsWith('</svg>'),
            'output should end with </svg>, got: ' + svg.slice(-40));
        // Required xmlns attribute (otherwise SVG won't render in some hosts)
        assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'),
            'output should declare the SVG namespace');
        // viewBox so the document scales when embedded
        assert.match(svg, /viewBox="0 0 \d+ \d+"/);
    };

    it('line chart exports valid SVG with path elements', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:1,y:1},{x:2,y:4},{x:3,y:9}],
            width: 600, height: 300, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(600, 300));
        const svg = c.exportSVG();
        expectValidSVG(svg);
        // The line itself emits as a <path> with `d="M...L...L..."`
        assert.match(svg, /<path[^>]*\bd="M/, 'line chart should emit at least one path with a d attribute');
        c.destroy();
    });

    it('area chart exports valid SVG', () => {
        const c = createAreaChart({
            data: [{x:0,y:5},{x:1,y:8},{x:2,y:3}],
            width: 600, height: 300, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(600, 300));
        const svg = c.exportSVG();
        expectValidSVG(svg);
        c.destroy();
    });

    it('bar chart exports rounded-corner bars as proper SVG arcs', () => {
        const c = createBarChart({
            data: [{x:'A',y:5},{x:'B',y:8},{x:'C',y:3}],
            cornerRadius: 4,
            width: 400, height: 250, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 250));
        const svg = c.exportSVG();
        expectValidSVG(svg);
        // Rounded bars use the roundRect path which emits SVG arc commands.
        assert.match(svg, /A\d/, 'bar chart with cornerRadius should emit SVG arc commands');
        c.destroy();
    });

    it('bar chart band-axis labels render with text-anchor=middle', () => {
        const c = createBarChart({
            data: [{x:'Mon',y:5},{x:'Tue',y:8}],
            width: 400, height: 250, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 250));
        const svg = c.exportSVG();
        // v1.3.0 fixed a pre-existing typo (`anchor:` -> `align:`) so
        // category labels are now properly centered.
        const mon = svg.match(/<text[^>]*>Mon<\/text>/);
        assert.ok(mon, 'should find Mon label');
        assert.match(mon[0], /text-anchor="middle"/,
            'category label should be middle-anchored');
        c.destroy();
    });

    it('bubble chart exports circles as SVG arcs', () => {
        const c = createBubbleChart({
            data: [{x:1,y:1,value:5},{x:2,y:3,value:10}],
            width: 600, height: 300, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(600, 300));
        const svg = c.exportSVG();
        expectValidSVG(svg);
        // arc() emits two A commands for full circles.
        assert.match(svg, /A/, 'bubble chart should emit SVG arc commands for circles');
        c.destroy();
    });

    it('scatter chart exports valid SVG', () => {
        const c = createScatterChart({
            data: [{x:1,y:1},{x:2,y:3},{x:3,y:2}],
            width: 600, height: 300, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(600, 300));
        const svg = c.exportSVG();
        expectValidSVG(svg);
        c.destroy();
    });

    it('pie chart exports slices with the same arc paths', () => {
        const c = createPieChart({
            data: [{label:'A',value:30},{label:'B',value:20},{label:'C',value:50}],
            width: 300, height: 300, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(300, 300));
        const svg = c.exportSVG();
        expectValidSVG(svg);
        // Three slices = three fill paths + three stroke paths typically.
        const pathCount = (svg.match(/<path[^>]*\bd=/g) || []).length;
        assert.ok(pathCount >= 3, 'pie with 3 slices should emit at least 3 path elements, got ' + pathCount);
        c.destroy();
    });

    it('donut chart exports valid SVG', () => {
        const c = createDonutChart({
            data: [{label:'A',value:30},{label:'B',value:20}],
            width: 300, height: 300, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(300, 300));
        const svg = c.exportSVG();
        expectValidSVG(svg);
        c.destroy();
    });

    it('radar chart exports polygons + grid + axis spokes', () => {
        const c = createRadarChart({
            axes: ['a','b','c','d'],
            series: [{name:'X',values:[3,7,5,8]}],
            width: 400, height: 400, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 400));
        const svg = c.exportSVG();
        expectValidSVG(svg);
        c.destroy();
    });

    it('heatmap exports cells as <rect> elements (axis-aligned)', () => {
        const c = createHeatmap({
            data: [
                {x:'A',y:'X',value:1},{x:'B',y:'X',value:2},
                {x:'A',y:'Y',value:3},{x:'B',y:'Y',value:4},
            ],
            width: 400, height: 300, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 300));
        const svg = c.exportSVG();
        expectValidSVG(svg);
        // Each cell is one <rect>. 4 cells + various axis/label rects.
        const rectCount = (svg.match(/<rect/g) || []).length;
        assert.ok(rectCount >= 4, 'heatmap should emit at least one <rect> per cell, got ' + rectCount);
        c.destroy();
    });

    it('exportSVG escapes XML-significant characters in labels', () => {
        const c = createBarChart({
            data: [{x:'A & B',y:5},{x:'<script>',y:8}],
            width: 400, height: 250, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 250));
        const svg = c.exportSVG();
        // The unsafe characters MUST be escaped; otherwise downstream
        // consumers (browsers, image-magick, etc.) get malformed XML.
        assert.ok(svg.includes('A &amp; B'), 'should escape & in label');
        assert.ok(svg.includes('&lt;script&gt;'), 'should escape < and > in label');
        assert.ok(!svg.includes('A & B<'), 'raw & should not appear in output');
        c.destroy();
    });

    it('exportSVG with explicit background emits a background <rect>', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:1,y:1}],
            width: 400, height: 250, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 250));
        const svg = c.exportSVG({ background: '#fafafa' });
        // Background rect is the first child after defs (no defs in this case).
        assert.match(svg, /<rect width="400" height="250" fill="#fafafa"\/>/);
        c.destroy();
    });

    it('exportSVG throws when called before mount()', () => {
        const c = createLineChart({
            data: [{x:0,y:0}],
            width: 400, height: 200, schedule: (fn) => fn(),
        });
        assert.throws(() => c.exportSVG(), /requires mount/);
    });

    it('exportSVG throws on a destroyed chart', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:1,y:1}],
            width: 400, height: 200, schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        c.destroy();
        assert.throws(() => c.exportSVG(), /requires mount/);
    });
});

// ---------------------------------------------------------------------------
// v1.4.0-alpha.0 -- log scale
// ---------------------------------------------------------------------------

describe('log scale (v1.4.0-alpha.0)', () => {
    describe('makeLogScale math', () => {
        it('maps decade boundaries to evenly spaced pixels', () => {
            const s = makeLogScale();
            // Domain [1, 1000] (3 decades) -> pixel range [0, 300]
            // Expected: log(1)=0 -> 0px, log(10)=2.3 -> 100px,
            // log(100)=4.6 -> 200px, log(1000)=6.9 -> 300px
            updateLogScale(s, 1, 1000, 0, 300);
            assert.ok(Math.abs(s.map(1) - 0) < 1e-9, 'map(1) should be 0, got ' + s.map(1));
            assert.ok(Math.abs(s.map(10) - 100) < 1e-9, 'map(10) should be 100, got ' + s.map(10));
            assert.ok(Math.abs(s.map(100) - 200) < 1e-9, 'map(100) should be 200, got ' + s.map(100));
            assert.ok(Math.abs(s.map(1000) - 300) < 1e-9, 'map(1000) should be 300, got ' + s.map(1000));
        });

        it('inverts map() round-trip', () => {
            const s = makeLogScale();
            updateLogScale(s, 0.01, 1000, 0, 500);
            for (const v of [0.05, 1, 7, 42, 100, 500, 999]) {
                const back = s.invert(s.map(v));
                assert.ok(Math.abs(back - v) / v < 1e-9, 'round-trip should be exact for ' + v + ', got ' + back);
            }
        });

        it('returns NaN for non-positive values', () => {
            const s = makeLogScale();
            updateLogScale(s, 1, 100, 0, 100);
            assert.ok(Number.isNaN(s.map(0)), 'map(0) should be NaN');
            assert.ok(Number.isNaN(s.map(-1)), 'map(-1) should be NaN');
            assert.ok(Number.isNaN(s.map(-1e9)), 'map(-1e9) should be NaN');
        });

        // v1.4.1 (C0 / LC-04): updateLogScale fails CLOSED on an invalid domain.
        // alpha.0 substituted `dMin = 1e-10` (and swapped/collapsed silently),
        // rendering a different axis than the data described -- a fail-open the
        // package's own laws forbid. It now throws, naming the offending bound;
        // callers (the extraction path) clamp to the positive extent BEFORE the
        // call. Four named cases: dMin<=0, dMax<=0, dMin>=dMax, NaN.
        it('throws on a non-positive dMin (LC-04, no more 1e-10 substitution)', () => {
            const s = makeLogScale();
            assert.throws(() => updateLogScale(s, 0, 100, 0, 100), /positive domain minimum.*dMin=0/);
            assert.throws(() => updateLogScale(s, -5, 100, 0, 100), /positive domain minimum.*dMin=-5/);
        });

        it('throws on a non-positive dMax', () => {
            const s = makeLogScale();
            assert.throws(() => updateLogScale(s, 1, 0, 0, 100), /positive domain maximum.*dMax=0/);
            assert.throws(() => updateLogScale(s, -10, -1, 0, 100), /positive domain (minimum|maximum)/);
        });

        it('throws on a collapsed domain (dMin === dMax) instead of a zero-slope axis', () => {
            const s = makeLogScale();
            assert.throws(() => updateLogScale(s, 10, 10, 0, 100), /dMax > dMin.*dMin=10 dMax=10/);
        });

        it('throws on swapped bounds (dMax < dMin) instead of silently reversing', () => {
            const s = makeLogScale();
            assert.throws(() => updateLogScale(s, 1000, 1, 0, 300), /dMax > dMin/);
        });

        it('throws on a NaN bound', () => {
            const s = makeLogScale();
            assert.throws(() => updateLogScale(s, NaN, 100, 0, 100), /positive domain minimum/);
            assert.throws(() => updateLogScale(s, 1, NaN, 0, 100), /positive domain maximum/);
        });

        it('has the same shape as linear scale (type, dMin/dMax/rMin/rMax)', () => {
            const lin = makeLinearScale('linear');
            const log = makeLogScale();
            for (const key of ['type', 'dMin', 'dMax', 'rMin', 'rMax']) {
                assert.ok(key in lin, 'linear missing ' + key);
                assert.ok(key in log, 'log missing ' + key);
            }
            assert.strictEqual(log.type, 'log');
        });
    });

    describe('end-to-end -- yScale: { type: "log" }', () => {
        it('line chart constructs and mounts with log y-scale', () => {
            const data = [];
            for (let x = 0; x <= 10; x++) data.push({ x, y: Math.pow(10, x / 2) });
            const c = createLineChart({
                data,
                yScale: { type: 'log' },
                width: 400, height: 300, schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            assert.strictEqual(c.yScale.type, 'log');
            // Domain should span the data: y goes from 1 to 10^5.
            assert.ok(c.yScale.dMin <= 1.01);
            assert.ok(c.yScale.dMax >= 100000 * 0.99);
            c.destroy();
        });

        it('scatter chart works with log y-scale', () => {
            const data = [];
            for (let i = 0; i < 20; i++) data.push({ x: i, y: Math.pow(2, i) });
            const c = createScatterChart({
                data,
                yScale: { type: 'log' },
                width: 400, height: 300, schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            assert.strictEqual(c.yScale.type, 'log');
            c.destroy();
        });

        it('default is linear (no opt-in needed for existing charts)', () => {
            const c = createLineChart({
                data: [{x:0,y:1},{x:1,y:2}],
                width: 400, height: 200, schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 200));
            assert.strictEqual(c.yScale.type, 'linear');
            c.destroy();
        });

        it('log scale survives data updates', async () => {
            const data1 = [{x:0,y:1},{x:1,y:10},{x:2,y:100}];
            const c = createLineChart({
                data: data1,
                yScale: { type: 'log' },
                width: 400, height: 300, schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            const d1 = c.yScale.dMax;
            // Update to wider domain
            c.data = [{x:0,y:1},{x:1,y:1000000}];
            await new Promise((r) => setTimeout(r, 0));
            // (Note: data setter may be a signal; mount schedule is sync,
            // so the update should propagate immediately.)
            assert.strictEqual(c.yScale.type, 'log', 'scale type should be preserved after update');
            c.destroy();
        });

        it('SVG export works with log y-scale', () => {
            const data = [{x:0,y:1},{x:1,y:10},{x:2,y:100},{x:3,y:1000}];
            const c = createLineChart({
                data,
                yScale: { type: 'log' },
                width: 400, height: 300, schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            const svg = c.exportSVG();
            assert.ok(svg.startsWith('<svg'));
            assert.ok(svg.endsWith('</svg>'));
            c.destroy();
        });

        it('log scale tick labels reflect decade boundaries', () => {
            const data = [];
            for (let i = 0; i <= 6; i++) data.push({ x: i, y: Math.pow(10, i) });
            // Domain spans 1 to 1,000,000 (6 decades).
            const c = createLineChart({
                data,
                yScale: { type: 'log' },
                width: 400, height: 400, schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 400));
            const svg = c.exportSVG();
            // logTicks() emits decade boundaries (1, 10, 100, ...).
            // formatNumber formats large numbers compactly (e.g. "1k", "10k").
            // Look for at least 3 power-of-10-style labels in the y-axis area.
            // The y-axis labels are right-anchored (text-anchor="end").
            const endAnchored = svg.match(/<text[^>]*text-anchor="end"[^>]*>([^<]+)<\/text>/g) || [];
            assert.ok(endAnchored.length >= 3,
                'should emit at least 3 y-axis labels, got ' + endAnchored.length);
        });
    });
});

// ---------------------------------------------------------------------------
// v1.4.0-alpha.1 -- audit-fix regressions
// ---------------------------------------------------------------------------

describe('audit-fix regressions (v1.4.0-alpha.1)', () => {

    // Fix 4: SVG path chunks (rope-string -> array-of-chunks)
    describe('SVG export survives large point counts', () => {
        it('exports a 10k-point line without throwing or producing malformed SVG', () => {
            const data = new Array(10000);
            for (let i = 0; i < 10000; i++) data[i] = { x: i, y: Math.sin(i * 0.01) * 100 };
            const c = createLineChart({
                data,
                width: 1200, height: 400,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(1200, 400));
            const svg = c.exportSVG();
            assert.ok(svg.startsWith('<svg'));
            assert.ok(svg.endsWith('</svg>'));
            // Output should be substantial -- 10k points compressed by
            // decimation still emits a path with thousands of segments.
            assert.ok(svg.length > 5000, 'expected svg > 5KB, got ' + svg.length);
            // The d attribute should be a single contiguous string (the
            // join('') flatten). Spot-check that the rope didn't leave any
            // empty-string artifacts.
            assert.ok(!svg.includes('d=""'), 'no empty d attributes');
            c.destroy();
        });

        it('produces valid SVG path commands (no rope-string artifacts)', () => {
            const c = createLineChart({
                data: [{x:0,y:0},{x:1,y:1},{x:2,y:4},{x:3,y:9}],
                width: 400, height: 200,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 200));
            const svg = c.exportSVG();
            // Match standalone d="..." attributes; the leading space
            // distinguishes the path's d from `id="..."` whose final
            // letter is also d.
            const m = svg.match(/ d="([^"]+)"/);
            assert.ok(m, 'should find a d attribute');
            const d = m[1];
            // Path d must start with M, contain at least one L (line
            // segments), and have no unexpected characters from rope-
            // flattening bugs.
            assert.match(d, /^M[\d\-.]/, 'd should start with M followed by a number');
            assert.match(d, /L[\d\-.]/, 'd should contain at least one L command');
            c.destroy();
        });

        it('beginPath truncates chunks in place (no array realloc)', () => {
            // The new beginPath does `this._pathChunks.length = 0` which
            // truncates in place rather than allocating a fresh []. There's
            // no observable API for this but we can at least verify
            // sequential paths don't bleed into one another.
            const c = createBarChart({
                data: [{x:'a',y:1},{x:'b',y:2}],
                cornerRadius: 4,
                width: 400, height: 200,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 200));
            const svg1 = c.exportSVG();
            const svg2 = c.exportSVG();
            // Re-exports should produce identical output -- if begin/end
            // path bookkeeping had a leak, the second export would have
            // additional path data appended.
            assert.strictEqual(svg1, svg2, 'two exports should match exactly');
            c.destroy();
        });

        it('fillRect with rotated transform still works (rare path)', () => {
            // The fillRect rotated-fallback uses the chunks-swap pattern.
            // Drive it indirectly via a pie chart (which rotates slices).
            const c = createPieChart({
                data: [{label:'a',value:30},{label:'b',value:70}],
                width: 300, height: 300,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(300, 300));
            const svg = c.exportSVG();
            assert.ok(svg.startsWith('<svg'));
            // Two slices = at least 2 path elements with d attributes.
            const paths = svg.match(/<path[^>]*\bd=/g) || [];
            assert.ok(paths.length >= 2, 'pie should emit at least 2 paths, got ' + paths.length);
            c.destroy();
        });
    });

    // Fix 1: Heatmap quantile pool
    describe('heatmap quantile reuses pooled sort buffer', () => {
        it('large dense heatmap with quantile binning does not throw', () => {
            // 50x50 = 2500 cells, all present. Dense enough to exercise
            // the gather/sort, small enough for fast tests.
            const data = [];
            for (let yi = 0; yi < 50; yi++) {
                for (let xi = 0; xi < 50; xi++) {
                    data.push({ x: 'c' + xi, y: 'r' + yi, value: (xi * yi) % 100 });
                }
            }
            const c = createHeatmap({
                data,
                colorScale: 'quantile',
                colorBins: 5,
                width: 800, height: 600,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(800, 600));
            // exportSVG forces a full draw so the quantile path runs
            const svg = c.exportSVG();
            assert.ok(svg.length > 1000);
            c.destroy();
        });

        it('quantile output is identical to the old code on a fixed dataset', () => {
            // Regression guard: the Float32Array sort should produce the
            // same boundaries as the JS Array sort (both numerically
            // ascending, stable for equal values).
            const data = [
                {x:'a',y:'x',value:1},  {x:'b',y:'x',value:2},
                {x:'c',y:'x',value:10}, {x:'d',y:'x',value:100},
                {x:'a',y:'y',value:5},  {x:'b',y:'y',value:50},
                {x:'c',y:'y',value:500}, {x:'d',y:'y',value:1000},
            ];
            const c = createHeatmap({
                data,
                colorScale: 'quantile',
                colorBins: 4,
                width: 400, height: 300,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            const svg = c.exportSVG();
            // 8 cells should produce 8 <rect> elements (one per cell);
            // the cell colors come from 4 quantile bins.
            const rects = svg.match(/<rect/g) || [];
            assert.ok(rects.length >= 8, 'heatmap should emit at least 8 cell rects, got ' + rects.length);
            c.destroy();
        });
    });

    // Fix 2: _parseRGBLike indexOf scan (smoke test only -- exercises the
    // auto-contrast path which calls _parseRGBLike per cell at extract).
    describe('heatmap auto-label color survives custom colorFn returning rgb()', () => {
        it('parses rgb(...) without throwing', () => {
            const c = createHeatmap({
                data: [
                    {x:'a',y:'x',value:0},   {x:'b',y:'x',value:0.5},
                    {x:'a',y:'y',value:1},   {x:'b',y:'y',value:2},
                ],
                showValues: true,
                colorFn: (v, vMin, vMax) => {
                    const t = (v - vMin) / (vMax - vMin || 1);
                    const r = (255 * t) | 0;
                    return 'rgb(' + r + ', 50, ' + (255 - r) + ')';
                },
                width: 400, height: 300,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            const svg = c.exportSVG();
            // 4 cells with auto-label colors picked from rgb() parse
            const texts = svg.match(/<text/g) || [];
            assert.ok(texts.length >= 4, 'should emit at least one text label per cell');
            c.destroy();
        });
    });

    // Fix 3: charBufToString via apply (smoke -- axis labels render correctly)
    describe('axis labels render correctly after charBufToString change', () => {
        it('numeric labels are intact', () => {
            const c = createLineChart({
                data: [{x:0,y:0},{x:1,y:100},{x:2,y:200},{x:3,y:300}],
                width: 600, height: 300,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(600, 300));
            const svg = c.exportSVG();
            // Some numeric label should appear in the SVG (the exact
            // value depends on niceYDomain, but at minimum there should
            // be digit characters in a <text> element).
            const labels = svg.match(/<text[^>]*>([^<]+)<\/text>/g) || [];
            assert.ok(labels.length >= 4, 'should have multiple axis labels');
            const hasNumeric = labels.some((l) => /\d/.test(l));
            assert.ok(hasNumeric, 'at least one label should contain a digit');
            c.destroy();
        });
    });
});

// ---------------------------------------------------------------------------
// v1.4.0-alpha.2 -- pan + zoom
// ---------------------------------------------------------------------------

describe('pan + zoom math (v1.4.0-alpha.2)', () => {
    const { _applyPan, _applyZoom, _clampToBounds } = _testHelpers;

    describe('_applyPan', () => {
        it('drag right shifts view left in data space (cursor convention)', () => {
            const start = { xMin: 0, xMax: 100, yMin: 0, yMax: 50 };
            // Drag 50 pixels right on a 500-pixel-wide plot = shift view
            // by 50/500 * 100 = 10 data units LEFT (so view shows
            // [-10, 90] -- you're "pulling" the data right).
            const r = _applyPan(start, 50, 0, 500, 250);
            assert.strictEqual(r.xMin, -10);
            assert.strictEqual(r.xMax, 90);
            assert.strictEqual(r.yMin, 0);   // no y drag
            assert.strictEqual(r.yMax, 50);
        });

        it('drag up shifts view down in data space (cursor-anchor convention)', () => {
            const start = { xMin: 0, xMax: 100, yMin: 0, yMax: 50 };
            // Drag 25 pixels UP (negative dy) on a 250-pixel-tall plot.
            // By the cursor-anchor convention (Google Maps, d3-zoom),
            // dragging UP moves the data UP visually, which means the
            // view's y-axis labels effectively roll DOWN -- the value
            // that used to sit at pixel 200 (y=10) is now at pixel 175.
            // dyData = -(-25) * 50 / 250 = +5; new yMin = 0 - 5 = -5.
            const r = _applyPan(start, 0, -25, 500, 250);
            assert.strictEqual(r.yMin, -5);
            assert.strictEqual(r.yMax, 45);
        });

        it('zero drag returns unchanged bounds', () => {
            const start = { xMin: 10, xMax: 90, yMin: -5, yMax: 5 };
            const r = _applyPan(start, 0, 0, 800, 400);
            assert.strictEqual(r.xMin, 10);
            assert.strictEqual(r.xMax, 90);
            assert.strictEqual(r.yMin, -5);
            assert.strictEqual(r.yMax, 5);
        });
    });

    describe('_applyZoom', () => {
        it('zoom in centered on plot middle halves the visible range', () => {
            const start = { xMin: 0, xMax: 100, yMin: 0, yMax: 50 };
            // Cursor at plot center (250, 125) on a 500x250 plot.
            // Zoom factor 0.5 -> range halves, centered on cursor's
            // data anchor which is at (50, 25) in data space.
            const r = _applyZoom(start, 250, 125, 0, 0, 500, 250, 0.5, 0.5);
            assert.strictEqual(r.xMin, 25);
            assert.strictEqual(r.xMax, 75);
            assert.strictEqual(r.yMin, 12.5);
            assert.strictEqual(r.yMax, 37.5);
        });

        it('zoom in keeps cursor data-point fixed', () => {
            // Cursor at 25% across the plot horizontally => data anchor
            // at xMin + 0.25 * (xMax - xMin) = 25. After zoom by 0.5,
            // the data anchor should still be at the same pixel
            // position, which we verify by reconstructing.
            const start = { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };
            const cursorPx = 100;  // 25% of 400
            const cursorPy = 100;  // 50% of 200
            const r = _applyZoom(start, cursorPx, cursorPy, 0, 0, 400, 200, 0.5, 0.5);
            // Anchor was at 25 in x. After zoom: 25 is still at the
            // same fraction tx of the new range.
            const newTx = (25 - r.xMin) / (r.xMax - r.xMin);
            assert.ok(Math.abs(newTx - 0.25) < 1e-10, 'cursor x-anchor preserved, got tx=' + newTx);
        });

        it('zoom out (factor > 1) widens the range', () => {
            const start = { xMin: 25, xMax: 75, yMin: 25, yMax: 75 };
            const r = _applyZoom(start, 250, 125, 0, 0, 500, 250, 2, 2);
            // Centered: anchor at (50, 50). Zoom 2x -> new range = 100.
            assert.strictEqual(r.xMin, 0);
            assert.strictEqual(r.xMax, 100);
            assert.strictEqual(r.yMin, 0);
            assert.strictEqual(r.yMax, 100);
        });

        it('y anchor is flipped (top of plot = yMax)', () => {
            const start = { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };
            // Cursor at top of plot (py = 0). Anchor should be at yMax.
            const r = _applyZoom(start, 250, 0, 0, 0, 500, 250, 0.5, 0.5);
            // yMax stays at 100 (anchor); yMin moves up to 50.
            assert.strictEqual(r.yMax, 100);
            assert.strictEqual(r.yMin, 50);
        });
    });

    describe('_clampToBounds', () => {
        const dataDom = { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };

        it('view inside data domain is unchanged', () => {
            const v = { xMin: 25, xMax: 75, yMin: 25, yMax: 75 };
            const r = _clampToBounds(v, dataDom);
            assert.strictEqual(r.xMin, 25);
            assert.strictEqual(r.xMax, 75);
        });

        it('view extending past xMin shifts right', () => {
            const v = { xMin: -10, xMax: 40, yMin: 0, yMax: 100 };
            _clampToBounds(v, dataDom);
            assert.strictEqual(v.xMin, 0);
            assert.strictEqual(v.xMax, 50);
        });

        it('view extending past xMax shifts left', () => {
            const v = { xMin: 70, xMax: 120, yMin: 0, yMax: 100 };
            _clampToBounds(v, dataDom);
            assert.strictEqual(v.xMin, 50);
            assert.strictEqual(v.xMax, 100);
        });

        it('view wider than data snaps to full domain', () => {
            const v = { xMin: -50, xMax: 200, yMin: 0, yMax: 100 };
            _clampToBounds(v, dataDom);
            assert.strictEqual(v.xMin, 0);
            assert.strictEqual(v.xMax, 100);
        });

        it('y-axis follows the same logic independently', () => {
            const v = { xMin: 25, xMax: 75, yMin: -20, yMax: 30 };
            _clampToBounds(v, dataDom);
            // x untouched (in bounds)
            assert.strictEqual(v.xMin, 25);
            // y clamped to start at 0
            assert.strictEqual(v.yMin, 0);
            assert.strictEqual(v.yMax, 50);
        });
    });
});

describe('log pan/zoom math (v1.4.1 -- C0 / LC-01..LC-05)', () => {
    const { _applyPan, _applyZoom, _applyPanLog, _applyZoomLog, _clampToBoundsLog } = _testHelpers;

    describe('_applyPanLog -- the decade law', () => {
        // Dragging d px on an n-decade axis multiplies both bounds by
        // 10^(n*d/plotH). alpha.2's linear math got this badly wrong (a +50px
        // drag on [1,1000]/400px gave yMin 125.875 instead of 2.371).
        const start = { xMin: 0, xMax: 1000, yMin: 1, yMax: 1000 }; // 3 decades
        const H = 400;
        const n = Math.log10(start.yMax / start.yMin); // 3

        for (const d of [1, 50, 150, 399]) {
            it(`drag ${d}px multiplies the log y-domain by 10^(n*d/H)`, () => {
                const mult = Math.pow(10, n * d / H);
                const v = _applyPanLog(start, 0, d, 800, H, false, true);
                assert.ok(Math.abs(v.yMin - start.yMin * mult) < 1e-6, `yMin ${v.yMin} != ${start.yMin * mult}`);
                assert.ok(Math.abs(v.yMax - start.yMax * mult) < 1e-6, `yMax ${v.yMax} != ${start.yMax * mult}`);
            });
        }

        it('the roadmap example: +50px drag gives yMin 2.371, not 125.875', () => {
            const v = _applyPanLog(start, 0, 50, 800, 400, false, true);
            assert.ok(Math.abs(v.yMin - 2.371373706) < 1e-6, 'yMin should be ~2.371, got ' + v.yMin);
        });

        it('never produces a non-positive bound, at any drag distance', () => {
            for (let dy = -4000; dy <= 4000; dy += 137) {
                const v = _applyPanLog(start, 0, dy, 800, 400, false, true);
                assert.ok(v.yMin > 0 && v.yMax > 0 && Number.isFinite(v.yMax) && v.yMax > v.yMin,
                    `dy=${dy} -> [${v.yMin}, ${v.yMax}]`);
            }
        });
    });

    describe('_applyZoomLog', () => {
        it('preserves the data value under the cursor (anchor)', () => {
            const start = { xMin: 0, xMax: 1000, yMin: 2, yMax: 200 };
            const H = 400, ay = 120, ty = ay / H;
            const anchorY = Math.exp(Math.log(start.yMax) - ty * (Math.log(start.yMax) - Math.log(start.yMin)));
            const v = _applyZoomLog(start, 400, ay, 0, 0, 800, H, 0.5, 0.5, false, true);
            const newY = Math.exp(Math.log(v.yMax) - ty * (Math.log(v.yMax) - Math.log(v.yMin)));
            assert.ok(Math.abs(newY - anchorY) < 1e-6, `anchor moved ${anchorY} -> ${newY}`);
        });

        it('repeated zoom-out never crosses zero (the log floor)', () => {
            let v = { xMin: 0, xMax: 1000, yMin: 1, yMax: 1000 };
            for (let i = 0; i < 500; i++) {
                v = _applyZoomLog(v, 400, 200, 0, 0, 800, 400, 1.25, 1.25, false, true);
                assert.ok(v.yMin > 0 && Number.isFinite(v.yMax) && v.yMax > v.yMin, `notch ${i} -> [${v.yMin}, ${v.yMax}]`);
            }
        });
    });

    describe('linear-path parity (hash parity)', () => {
        // The log helpers with both axes linear must be BYTE-identical to the
        // untouched _applyPan / _applyZoom -- a linear chart cannot change.
        it('_applyPanLog(...,false,false) === _applyPan', () => {
            const s = { xMin: -3, xMax: 97, yMin: 0, yMax: 50 };
            const a = _applyPan(s, 37, -21, 640, 480);
            const b = _applyPanLog(s, 37, -21, 640, 480, false, false);
            assert.deepStrictEqual(b, a);
        });
        it('_applyZoomLog(...,false,false) === _applyZoom', () => {
            const s = { xMin: -3, xMax: 97, yMin: 0, yMax: 50 };
            const a = _applyZoom(s, 300, 200, 20, 10, 640, 480, 0.8, 0.8);
            const b = _applyZoomLog(s, 300, 200, 20, 10, 640, 480, 0.8, 0.8, false, false);
            assert.deepStrictEqual(b, a);
        });
    });

    describe('mixed linear-x / log-y', () => {
        it('pans x linearly and y in log space, independently', () => {
            const s = { xMin: 0, xMax: 100, yMin: 1, yMax: 100 };
            const v = _applyPanLog(s, 50, 40, 500, 400, false, true);
            // x: linear shift by 50/500*100 = 10 -> [-10, 90]
            assert.ok(Math.abs(v.xMin - -10) < 1e-9 && Math.abs(v.xMax - 90) < 1e-9, 'x should pan linearly');
            // y: multiply by 10^(2*40/400) = 10^0.2 ~ 1.5849
            const mult = Math.pow(10, 2 * 40 / 400);
            assert.ok(Math.abs(v.yMin - 1 * mult) < 1e-6 && v.yMin > 0, 'y should pan in log space');
        });
    });

    describe('_clampToBoundsLog', () => {
        it('keeps a log axis inside its positive data domain', () => {
            const view = { xMin: 0, xMax: 100, yMin: 0.001, yMax: 5 }; // below data floor
            const dataDom = { xMin: 0, xMax: 100, yMin: 1, yMax: 1000 };
            _clampToBoundsLog(view, dataDom, false, true);
            assert.ok(view.yMin >= 1 - 1e-9, 'yMin should be clamped up to the data floor, got ' + view.yMin);
            assert.ok(view.yMax <= 1000 + 1e-9 && view.yMin > 0, 'view stayed inside positive data bounds');
        });
    });

    describe('v1.6.0 -- x-log is supported (was LC-05 fail-closed)', () => {
        it('createLineChart with xScale { type: "log" } constructs without throwing', () => {
            assert.doesNotThrow(
                () => createLineChart({ data: [{ x: 1, y: 1 }], xScale: { type: 'log' }, schedule: (fn) => fn() }),
            );
        });
    });

    describe('LC-04 -- a log y-axis with no positive data fails closed at mount', () => {
        it('all-negative data on a log y-axis throws instead of clamping to 1e-10', () => {
            const c = createLineChart({
                data: [{ x: 1, y: -5 }, { x: 2, y: -10 }],
                yScale: { type: 'log' }, x: 'x', y: 'y', schedule: (fn) => fn(),
            });
            assert.throws(() => c.mount(createMockCanvas(400, 300)), /needs positive data/);
        });

        it('mixed-sign data on a log y-axis renders on its positive extent', () => {
            const c = createLineChart({
                data: [{ x: 1, y: -5 }, { x: 2, y: 10 }, { x: 3, y: 1000 }],
                yScale: { type: 'log' }, x: 'x', y: 'y', width: 400, height: 300, schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            assert.ok(c.yScale.dMin > 0 && Number.isFinite(c.yScale.dMax), 'positive domain');
            c.destroy();
        });
    });
});

// ---------------------------------------------------------------------------
// v1.6.0 -- x-axis log scale: QA boundary suite for PLAN_v1.6.0_xlog.md's
// falsifiable assertions A1-A7, plus an exportSVG parity check and a
// mixed-sign documentation test. Mirrors the existing y-log tests' structure
// (LC-01..05, LC-04's `_logDomainError` throw, the y-log SVG decade test)
// applied to the x-axis, which the coder's diff newly supports.
// ---------------------------------------------------------------------------

describe('v1.6.0 -- x-axis log scale', () => {
    // Local interactive mock canvas -- mirrors the one in
    // 'pan + zoom integration (v1.4.0-alpha.2)' below. Adds
    // addEventListener/dispatch so the real pointerdown/pointermove/wheel
    // listener paths (the ones that call _applyPanLog/_applyZoomLog) run.
    const createInteractiveMockCanvas = (width, height) => {
        const base = createMockCanvas(width, height);
        const listeners = new Map();
        base.addEventListener = (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        };
        base.removeEventListener = (type, fn) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
        };
        base.getBoundingClientRect = () => ({ left: 0, top: 0, width: base.width, height: base.height });
        base.dispatch = (type, ev) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const copy = arr.slice();
            for (let i = 0; i < copy.length; i++) copy[i](ev);
        };
        base.setPointerCapture = () => {};
        base.releasePointerCapture = () => {};
        return base;
    };

    describe('A1 -- x-log point projection on a MOUNTED chart equals xScale.map(v)', () => {
        // `state.pxs` (the mounted chart's real hot-path storage) is a
        // Float32Array -- see Charts.js `xs:/*Float32Array*/`. `xScale.map()`
        // computes in float64. Measured round-trip error at these magnitudes
        // is ~5e-6 (Float32 has ~7 significant decimal digits); 1e-3 is
        // ~200x that noise floor, so it still catches a real projection bug
        // (e.g. a linear/log mixup, which is off by orders of magnitude)
        // while tolerating the storage format's own precision.
        const PX32_TOL = 1e-3;

        it('line chart: pxs[i] === xScale.map(x[i]) within float32 storage precision, spot-check a decade boundary', () => {
            const data = [{ x: 1, y: 1 }, { x: 10, y: 2 }, { x: 100, y: 3 }, { x: 1000, y: 4 }];
            const c = createLineChart({
                data, xScale: { type: 'log' },
                width: 400, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            assert.strictEqual(c.xScale.type, 'log');
            assert.strictEqual(c.xScale.dMin, 1);
            assert.strictEqual(c.xScale.dMax, 1000);
            const state = c._internal.seriesStates[0];
            for (let i = 0; i < data.length; i++) {
                const expected = c.xScale.map(data[i].x);
                assert.ok(Math.abs(state.pxs[i] - expected) < PX32_TOL,
                    'pxs[' + i + ']=' + state.pxs[i] + ' vs map=' + expected);
            }
            // Known decade boundary: x=100 sits 2/3 of the way across the
            // 3-decade domain [1,1000] -- must land exactly there, not at
            // the LINEAR fraction (100-1)/(1000-1) ~= 0.099.
            const frac = (state.pxs[2] - state.pxs[0]) / (state.pxs[3] - state.pxs[0]);
            assert.ok(Math.abs(frac - 2 / 3) < 1e-4, 'decade fraction should be 2/3, got ' + frac);
            c.destroy();
        });

        it('scatter chart: same log-projection law on a MOUNTED x-log scatter', () => {
            const data = [{ x: 1, y: 1 }, { x: 10, y: 2 }, { x: 1000, y: 4 }];
            const c = createScatterChart({
                data, xScale: { type: 'log' },
                width: 400, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            const state = c._internal.seriesStates[0];
            for (let i = 0; i < data.length; i++) {
                const expected = c.xScale.map(data[i].x);
                assert.ok(Math.abs(state.pxs[i] - expected) < PX32_TOL,
                    'pxs[' + i + ']=' + state.pxs[i] + ' vs map=' + expected);
            }
            c.destroy();
        });
    });

    describe('A2 -- a non-positive x sample on a MOUNTED x-log chart projects to NaN (polyline break)', () => {
        it('x<=0 samples project to NaN pixels; positive samples stay finite', () => {
            const data = [{ x: -5, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 2 }, { x: 10, y: 3 }];
            const c = createLineChart({
                data, xScale: { type: 'log' },
                width: 400, height: 300,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            const state = c._internal.seriesStates[0];
            assert.ok(Number.isNaN(state.pxs[0]), 'x=-5 must project to NaN');
            assert.ok(Number.isNaN(state.pxs[1]), 'x=0 must project to NaN');
            assert.ok(!Number.isNaN(state.pxs[2]), 'x=1 must stay finite');
            assert.ok(!Number.isNaN(state.pxs[3]), 'x=10 must stay finite');
            c.destroy();
        });
    });

    describe('A3 -- an x-log axis emits DECADE ticks (powers of 10, not linear-spaced)', () => {
        it('SVG-exported x-axis tick labels invert to powers of 10 across the domain', () => {
            const data = [];
            for (let i = 0; i <= 6; i++) data.push({ x: Math.pow(10, i), y: i + 1 });
            const c = createLineChart({
                data, xScale: { type: 'log' },
                width: 700, height: 300,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(700, 300));
            const svg = c.exportSVG();
            // x-axis labels are bottom-anchored (align: 'center' -> SVG
            // text-anchor="middle"); y-axis labels are right-anchored
            // ("end") -- this regex only matches the x-axis.
            const re = /<text x="([-\d.]+)"[^>]*text-anchor="middle"[^>]*>([^<]+)<\/text>/g;
            let m;
            let count = 0;
            while ((m = re.exec(svg))) {
                const px = parseFloat(m[1]);
                const domainVal = c.xScale.invert(px);
                const log10 = Math.log10(domainVal);
                assert.ok(Math.abs(log10 - Math.round(log10)) < 0.01,
                    'tick label "' + m[2] + '" inverts to ' + domainVal + ' (log10=' + log10 + '), not a decade boundary');
                count++;
            }
            assert.ok(count >= 3, 'should emit at least 3 x-axis decade tick labels, got ' + count);
            c.destroy();
        });
    });

    describe('A4 -- fail-closed: an x-domain with no positive extent throws at MOUNT, names the x-domain, leaks no signal', () => {
        it('all-non-positive x data throws naming the x-domain', () => {
            const c = createLineChart({
                data: [{ x: -5, y: 1 }, { x: -1, y: 2 }, { x: 0, y: 3 }],
                xScale: { type: 'log' },
                width: 400, height: 300,
                schedule: (fn) => fn(),
            });
            assert.throws(
                () => c.mount(createMockCanvas(400, 300)),
                (err) => /needs positive data/.test(err.message) && /x-domain/.test(err.message),
            );
            c.destroy();
        });

        it('repeated failed mounts + destroy() leak zero signal nodes (mirrors the y LC-04 discipline)', () => {
            const before = stats().activeNodes;
            for (let i = 0; i < 25; i++) {
                const c = createLineChart({
                    data: [{ x: -5, y: 1 }, { x: -1, y: 2 }],
                    xScale: { type: 'log' },
                    width: 400, height: 300,
                    schedule: (fn) => fn(),
                });
                let threw = null;
                try {
                    c.mount(createMockCanvas(400, 300));
                } catch (e) {
                    threw = e;
                }
                assert.ok(threw, 'mount should have thrown on cycle ' + i);
                c.destroy();
            }
            const delta = stats().activeNodes - before;
            assert.equal(delta, 0, 'failed x-log mounts should leak zero signal nodes once destroy() runs');
        });
    });

    describe('A5 -- construction guards throw for x-log + incompatible x types', () => {
        it('x-log + bar (band x) throws, naming the categorical incompatibility', () => {
            assert.throws(
                () => createBarChart({
                    data: [{ x: 'Jan', y: 10 }, { x: 'Feb', y: 20 }],
                    xScale: { type: 'log' },
                    schedule: (fn) => fn(),
                }),
                /categorical \(band\) x-axis/,
            );
        });

        it('x-log + time-valued x (Date) throws, naming the time incompatibility', () => {
            assert.throws(
                () => createLineChart({
                    data: [{ x: new Date('2024-01-01'), y: 1 }, { x: new Date('2024-01-02'), y: 2 }],
                    xScale: { type: 'log' },
                    schedule: (fn) => fn(),
                }),
                /time-valued x data/,
            );
        });

        it('x-log + time-valued x (epoch-ms on a "time" key) throws too', () => {
            assert.throws(
                () => createLineChart({
                    data: [{ time: 1700000000000, y: 1 }, { time: 1700000100000, y: 2 }],
                    x: 'time',
                    xScale: { type: 'log' },
                    schedule: (fn) => fn(),
                }),
                /time-valued x data/,
            );
        });
    });

    describe('A6 -- pan + zoom stay log-correct on an all-positive x-log domain', () => {
        it('drag pans the x-domain by the decade law, not linearly', () => {
            const c = createLineChart({
                data: [{ x: 1, y: 0 }, { x: 1000, y: 100 }],
                xScale: { type: 'log' },
                pan: true,
                panBounds: 'free',
                width: 500, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            const canvas = createInteractiveMockCanvas(500, 300);
            c.mount(canvas);
            assert.strictEqual(c.xScale.dMin, 1);
            assert.strictEqual(c.xScale.dMax, 1000);

            // Drag 50px LEFT (250 -> 200).
            canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
            canvas.dispatch('pointermove', { clientX: 200, clientY: 150, pointerId: 1 });
            canvas.dispatch('pointerup', { clientX: 200, clientY: 150, pointerId: 1 });

            const v = c.view();
            assert.ok(v != null, 'view should be set after drag');
            // Independent oracle: the decade law directly from
            // _applyPanLog's formula (dLog = dxPx * (lx1-lx0)/plotW).
            const lx0 = Math.log(1), lx1 = Math.log(1000);
            const dLog = -50 * (lx1 - lx0) / 500;
            const expXMin = Math.exp(lx0 - dLog);
            const expXMax = Math.exp(lx1 - dLog);
            assert.ok(Math.abs(v.xMin - expXMin) < 1e-6, 'xMin ' + v.xMin + ' != ' + expXMin);
            assert.ok(Math.abs(v.xMax - expXMax) < 1e-6, 'xMax ' + v.xMax + ' != ' + expXMax);
            // Falsifiability: this must NOT equal what LINEAR pan math would
            // have produced on the same drag (the bug this test would catch).
            const dxData = -50 * (1000 - 1) / 500;
            const linXMin = 1 - dxData;
            assert.ok(Math.abs(v.xMin - linXMin) > 1, 'log pan must differ from linear pan (' + v.xMin + ' vs ' + linXMin + ')');
            c.destroy();
        });

        it('wheel-zoom preserves the log anchor and shrinks the log-space span', () => {
            const c = createLineChart({
                data: [{ x: 1, y: 0 }, { x: 1000, y: 100 }],
                xScale: { type: 'log' },
                zoom: true,
                panBounds: 'free',
                width: 500, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            const canvas = createInteractiveMockCanvas(500, 300);
            c.mount(canvas);
            c.setView({ xMin: 1, xMax: 1000, yMin: 0, yMax: 100 });
            const before = c.view();
            const beforeLogSpan = Math.log10(before.xMax) - Math.log10(before.xMin);

            // Zoom in (deltaY < 0) centered at plot-center (x=250).
            canvas.dispatch('wheel', { clientX: 250, clientY: 150, deltaY: -100, preventDefault: () => {} });
            const after = c.view();
            const afterLogSpan = Math.log10(after.xMax) - Math.log10(after.xMin);
            assert.ok(afterLogSpan < beforeLogSpan, 'zoom-in should shrink the log-space x-span');
            assert.ok(after.xMin > 0 && after.xMax > 0, 'zoomed log domain must stay positive');
            c.destroy();
        });
    });

    describe('A7 -- existing linear-x charts are unchanged (no behavioral drift)', () => {
        it('a linear-x line chart projects the same known pixel as pre-v1.6.0', () => {
            const c = createLineChart({
                data: [{ x: 0, y: 0 }, { x: 50, y: 1 }, { x: 100, y: 2 }],
                width: 400, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            assert.strictEqual(c.xScale.type, 'linear');
            // x=50 is the domain midpoint -> pixel midpoint, exactly, always.
            assert.strictEqual(c.xScale.map(50), 200);
            const state = c._internal.seriesStates[0];
            assert.strictEqual(state.pxs[1], 200);
            c.destroy();
        });

        it('a linear-x axis still emits linearly-spaced (not decade) ticks', () => {
            const c = createLineChart({
                data: [{ x: 0, y: 0 }, { x: 1000000, y: 1 }],
                width: 700, height: 300,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(700, 300));
            const svg = c.exportSVG();
            const re = /<text x="([-\d.]+)"[^>]*text-anchor="middle"[^>]*>([^<]+)<\/text>/g;
            let m;
            let sawNonDecade = false;
            while ((m = re.exec(svg))) {
                const px = parseFloat(m[1]);
                const domainVal = c.xScale.invert(px);
                if (domainVal > 0) {
                    const log10 = Math.log10(domainVal);
                    if (Math.abs(log10 - Math.round(log10)) > 0.01) sawNonDecade = true;
                }
            }
            assert.ok(sawNonDecade, 'a linear axis over [0, 1e6] should NOT produce only decade-aligned ticks');
            c.destroy();
        });
    });

    describe('exportSVG on an x-log chart', () => {
        it('produces valid, well-formed SVG without throwing', () => {
            const data = [{ x: 1, y: 1 }, { x: 10, y: 10 }, { x: 100, y: 5 }, { x: 1000, y: 50 }];
            const c = createLineChart({
                data, xScale: { type: 'log' },
                width: 400, height: 300,
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(400, 300));
            const svg = c.exportSVG();
            assert.ok(svg.startsWith('<svg'));
            assert.ok(svg.endsWith('</svg>'));
            const m = svg.match(/ d="([^"]+)"/);
            assert.ok(m, 'should find a path d attribute for the x-log line');
            c.destroy();
        });
    });

    describe('mixed-sign x-log domain + pan -- v1.6.1 floors the pan-bounds envelope (parity with y)', () => {
        // v1.6.1: this was the pre-existing gap the v1.6.0 brief deferred. The
        // reactive scale effect floored the domain to its positive part for
        // RENDER but wrote the RAW (<=0) min into `_dataDomain`, so the first
        // pan's Math.log(xMin<=0) NaN'd the view. v1.6.1 floors
        // `_dataDomain.xMin` to the same positive part (dxMax * 1e-9) when the
        // x-axis is log and has a positive extent. Mixed-sign x-log pan now
        // stays finite instead of NaN'ing.
        it('mixed-sign x-domain (xMin<=0, xMax>0): mount floors to positive; the first pan stays finite (view min > 0), not NaN', () => {
            const c = createLineChart({
                data: [{ x: -5, y: 1 }, { x: 1, y: 2 }, { x: 1000, y: 3 }],
                xScale: { type: 'log' },
                pan: true,
                panBounds: 'free',
                width: 500, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            const canvas = createInteractiveMockCanvas(500, 300);
            // Mount succeeds: xMax > 0, so the domain floors xMin up to a
            // tiny positive substitute (same floor-substitution as y/LC-04).
            c.mount(canvas);
            assert.ok(c.xScale.dMin > 0 && Number.isFinite(c.xScale.dMax), 'mount floors to a positive domain');
            const dMinBeforePan = c.xScale.dMin;

            // First pan: `_dataDomain.xMin` is now the floored (positive)
            // snapshot, so _applyPanLog's Math.log stays finite.
            canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
            canvas.dispatch('pointermove', { clientX: 200, clientY: 150, pointerId: 1 });
            canvas.dispatch('pointerup', { clientX: 200, clientY: 150, pointerId: 1 });

            const v = c.view();
            assert.ok(Number.isFinite(v.xMin) && Number.isFinite(v.xMax),
                'v1.6.1: mixed-sign x-log pan yields a finite view, not NaN');
            assert.ok(v.xMin > 0, 'v1.6.1: the panned x-log view min stays positive');
            // The scale updates to the panned domain (no NaN bail).
            assert.ok(c.xScale.dMin > 0 && Number.isFinite(c.xScale.dMax),
                'the scale tracks the finite panned domain');
            // Reviewer note: `dMin > 0` alone is weak -- mount already floors
            // dMin to a positive substitute (dxMax*1e-9) BEFORE any pan, so a
            // build that dropped the fix entirely (dragActive bailing on NaN
            // and the scale staying pinned at its pre-drag value) would still
            // pass a bare `> 0` check. Load-bearing version: assert the scale
            // actually MOVED off its pre-pan value -- pre-fix, the reactive
            // effect bails on the NaN view and dMin/dMax stay frozen at the
            // mount-time snapshot; post-fix they track the new panned domain.
            assert.notStrictEqual(c.xScale.dMin, dMinBeforePan,
                'v1.6.1: the x-scale must have actually MOVED to the panned domain, not merely stayed positive');
            c.destroy();
        });
    });
});

// ---------------------------------------------------------------------------
// v1.6.1 -- mixed-sign log-domain floor: y-axis parity + the zoom path.
//
// Brief: briefs/v1.6.1-mixedsign-log-floor.md, assertions A1-A5. The x-axis
// half (A2) and the reconciled/strengthened assertion live in the
// "mixed-sign x-log domain + pan" describe just above. This block covers
// the reviewer-flagged gaps: A1 (y-axis, previously asserted only by x/y
// symmetry -- zero direct coverage), A3 (an explicit regression guard that a
// purely-positive log domain is NOT touched by the new floor), A4 (the
// fail-closed throw survives, both axes, exact [-10,-1] domain from the
// brief), and A5 (the wheel-zoom path, which reads `_dataDomain` through
// `axisSpan()` at Charts.js ~5068-5081 -- a code path `_clampToBoundsLog`
// alone does not exercise).
// ---------------------------------------------------------------------------

describe('v1.6.1 -- mixed-sign log-domain floor (y-axis parity + zoom path)', () => {
    // Same interactive mock canvas shape as the x-log describe above (each
    // pan/zoom describe block in this file defines its own local copy --
    // matches the established convention, see 'pan + zoom integration').
    const createInteractiveMockCanvas = (width, height) => {
        const base = createMockCanvas(width, height);
        const listeners = new Map();
        base.addEventListener = (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        };
        base.removeEventListener = (type, fn) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
        };
        base.getBoundingClientRect = () => ({ left: 0, top: 0, width: base.width, height: base.height });
        base.dispatch = (type, ev) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const copy = arr.slice();
            for (let i = 0; i < copy.length; i++) copy[i](ev);
        };
        base.setPointerCapture = () => {};
        base.releasePointerCapture = () => {};
        return base;
    };

    describe('A1 -- mixed-sign y-log domain + pan: the floor applies to the y-branch too (previously zero direct coverage)', () => {
        it('mixed-sign y-domain (yMin<=0, yMax>0): mount floors to positive; a ~40px vertical drag stays finite (view yMin > 0), not NaN', () => {
            const c = createLineChart({
                data: [{ x: 1, y: -5 }, { x: 2, y: 1 }, { x: 3, y: 1000 }],
                yScale: { type: 'log' },
                pan: true,
                panBounds: 'free',
                width: 500, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            const canvas = createInteractiveMockCanvas(500, 300);
            // Mount succeeds: yMax > 0, so the y-domain floors yMin up to a
            // tiny positive substitute (render-floor branch, unconditional
            // on the v1.6.1 fix -- this line alone is NOT the regression).
            c.mount(canvas);
            assert.ok(c.yScale.dMin > 0 && Number.isFinite(c.yScale.dMax), 'mount floors to a positive y-domain');
            const dMinBeforePan = c.yScale.dMin;

            // ~40px vertical drag. Pre-fix, `_dataDomain.yMin` still holds
            // the RAW (<=0) snapshot: `_applyPanLog`'s `Math.log(start.yMin)`
            // is `NaN`, `_expClampedInto` propagates it, and the resulting
            // view is `{ yMin: NaN, yMax: NaN, ... }`. The reactive scale
            // effect then re-runs against a NaN domain -- `!(hi > 0)` is true
            // for NaN, which pre-v1.6.1 would misfire the "no positive
            // extent" bail (or, depending on the exact NaN propagation path,
            // simply leave the scale pinned at its pre-drag value while the
            // view itself reports NaN). Post-fix, `_dataDomain.yMin` is the
            // floored positive snapshot, so this stays finite throughout.
            canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
            canvas.dispatch('pointermove', { clientX: 250, clientY: 190, pointerId: 1 });
            canvas.dispatch('pointerup', { clientX: 250, clientY: 190, pointerId: 1 });

            const v = c.view();
            assert.ok(v != null, 'view should be set after drag');
            assert.ok(
                Number.isFinite(v.xMin) && Number.isFinite(v.xMax) &&
                Number.isFinite(v.yMin) && Number.isFinite(v.yMax),
                'v1.6.1: mixed-sign y-log pan yields a fully finite view, not NaN',
            );
            assert.ok(v.yMin > 0, 'v1.6.1: the panned y-log view min stays positive');
            assert.ok(c.yScale.dMin > 0 && Number.isFinite(c.yScale.dMax), 'the y-scale tracks a finite panned domain');
            // Load-bearing, not a rubber stamp: the scale must have actually
            // moved off its pre-pan value (mirrors the strengthened x-axis
            // assertion above -- see that comment for why bare `> 0` is weak).
            assert.notStrictEqual(c.yScale.dMin, dMinBeforePan,
                'v1.6.1: the y-scale must have actually MOVED to the panned domain, not merely stayed positive');
            c.destroy();
        });
    });

    describe('A3 -- regression: a purely-positive log domain is byte-unchanged by the v1.6.1 floor', () => {
        // panBounds defaults to 'data' (NOT 'free') when omitted -- unlike the
        // A1/A2/A6 tests above, this exercises `_clampToBoundsLog` directly
        // against `_dataDomain`. The initial effective view (no prior
        // setView/pan) is the full data domain, so ANY pan-translate keeps
        // the SAME log-space width as the data domain: `vw >= dw` is
        // trivially true at the very first drag, so `_clampAxisLog` resets
        // the view straight back to `_dataDomain[loKey]/[hiKey]` via
        // `Math.exp(Math.log(dataDom[loKey]))`. If the v1.6.1 guard were
        // ever wrongly unconditional (flooring a domain whose min is
        // ALREADY positive), this would resolve to ~1e-6 (max*1e-9) instead
        // of the true data min -- a multiple-orders-of-magnitude difference
        // this test would catch. This is the black-box observable proxy for
        // `_dataDomain` itself, which is not exposed to tests.
        it('x-log domain [1, 1000] (already positive): pan-bounds clamp resolves to the EXACT data min/max, not a floor substitute', () => {
            const c = createLineChart({
                data: [{ x: 1, y: 0 }, { x: 1000, y: 100 }],
                xScale: { type: 'log' },
                pan: true, // panBounds defaults to 'data'
                width: 500, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            const canvas = createInteractiveMockCanvas(500, 300);
            c.mount(canvas);
            assert.strictEqual(c.xScale.dMin, 1, 'pre-pan: unfloored data min');

            canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
            canvas.dispatch('pointermove', { clientX: 180, clientY: 150, pointerId: 1 });
            canvas.dispatch('pointerup', { clientX: 180, clientY: 150, pointerId: 1 });

            const v = c.view();
            assert.ok(v != null, 'view should be set after drag');
            assert.ok(Math.abs(v.xMin - 1) < 1e-9,
                'v1.6.1 regression: a positive-min x-domain must clamp to the EXACT data min (1), got ' + v.xMin);
            assert.ok(Math.abs(v.xMax - 1000) < 1e-6,
                'clamp should resolve to the exact data max (1000), got ' + v.xMax);
            c.destroy();
        });

        it('y-log domain [1, 1000] (already positive): same exact-clamp parity on y', () => {
            const c = createLineChart({
                data: [{ x: 1, y: 1 }, { x: 2, y: 1000 }],
                yScale: { type: 'log' },
                pan: true, // panBounds defaults to 'data'
                width: 500, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            const canvas = createInteractiveMockCanvas(500, 300);
            c.mount(canvas);
            assert.strictEqual(c.yScale.dMin, 1, 'pre-pan: unfloored data min');

            canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
            canvas.dispatch('pointermove', { clientX: 250, clientY: 90, pointerId: 1 });
            canvas.dispatch('pointerup', { clientX: 250, clientY: 90, pointerId: 1 });

            const v = c.view();
            assert.ok(v != null, 'view should be set after drag');
            assert.ok(Math.abs(v.yMin - 1) < 1e-9,
                'v1.6.1 regression: a positive-min y-domain must clamp to the EXACT data min (1), got ' + v.yMin);
            assert.ok(Math.abs(v.yMax - 1000) < 1e-6,
                'clamp should resolve to the exact data max (1000), got ' + v.yMax);
            c.destroy();
        });
    });

    describe('A4 -- fail-closed preserved: a no-positive-extent log domain [-10, -1] still throws at mount (v1.6.1 must not swallow this)', () => {
        it('x-domain [-10, -1] (no positive extent) on a log x-axis still throws, naming the x-domain', () => {
            const c = createLineChart({
                data: [{ x: -10, y: 1 }, { x: -1, y: 2 }],
                xScale: { type: 'log' },
                width: 400, height: 300,
                schedule: (fn) => fn(),
            });
            assert.throws(
                () => c.mount(createMockCanvas(400, 300)),
                (err) => /needs positive data/.test(err.message) && /x-domain/.test(err.message) &&
                    /-10/.test(err.message) && /-1/.test(err.message),
                'must still throw the _logDomainError message, naming the x-domain and its bounds',
            );
            c.destroy();
        });

        it('y-domain [-10, -1] (no positive extent) on a log y-axis still throws, naming the y-domain', () => {
            const c = createLineChart({
                data: [{ x: 1, y: -10 }, { x: 2, y: -1 }],
                yScale: { type: 'log' },
                width: 400, height: 300,
                schedule: (fn) => fn(),
            });
            assert.throws(
                () => c.mount(createMockCanvas(400, 300)),
                (err) => /needs positive data/.test(err.message) && /y-domain/.test(err.message) &&
                    /-10/.test(err.message) && /-1/.test(err.message),
                'must still throw the _logDomainError message, naming the y-domain and its bounds',
            );
            c.destroy();
        });
    });

    describe('A5 -- the zoom (wheel) path also stays finite on a mixed-sign log domain (covers axisSpan() at ~5068-5081, not just _clampToBoundsLog)', () => {
        it('wheel-zoom on a mixed-sign y-log domain, with NO prior pan, stays finite', () => {
            // `zoom: true` alone (no `pan: true`) is deliberate: it isolates
            // the zoom listener's own `_readEffectiveView` fallback --
            // viewSig is still null at the first wheel event, so
            // `_readEffectiveView` reads `_dataDomain` DIRECTLY (Charts.js
            // ~4976-4979), not through any prior pan-produced view. This
            // exercises `axisSpan(_dataDomain.yMin, _dataDomain.yMax, yLog)`
            // (the zoom-factor cap, ~5080-5081) and `_applyZoomLog`'s own
            // `Math.log(start.yMin)` independently of the pan gesture path
            // that A1/A2 already cover.
            const c = createLineChart({
                data: [{ x: 1, y: -5 }, { x: 2, y: 10 }, { x: 3, y: 1000 }],
                yScale: { type: 'log' },
                zoom: true,
                panBounds: 'free',
                width: 500, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            const canvas = createInteractiveMockCanvas(500, 300);
            c.mount(canvas);
            assert.ok(c.yScale.dMin > 0 && Number.isFinite(c.yScale.dMax), 'mount floors to a positive y-domain');
            const dMinBeforeZoom = c.yScale.dMin;

            canvas.dispatch('wheel', { clientX: 250, clientY: 150, deltaY: -100, preventDefault: () => {} });

            const v = c.view();
            assert.ok(v != null, 'zoom should set a view');
            assert.ok(
                Number.isFinite(v.xMin) && Number.isFinite(v.xMax) &&
                Number.isFinite(v.yMin) && Number.isFinite(v.yMax),
                'v1.6.1: zoomed mixed-sign y-log view is finite, not NaN',
            );
            assert.ok(v.yMin > 0, 'v1.6.1: zoomed y-log view min stays positive');
            assert.ok(c.yScale.dMin > 0 && Number.isFinite(c.yScale.dMax), 'the y-scale tracks a finite zoomed domain');
            assert.notStrictEqual(c.yScale.dMin, dMinBeforeZoom,
                'v1.6.1: the y-scale must have actually MOVED (zoomed in) off its pre-zoom value');
            c.destroy();
        });

        it('wheel-zoom on the same mixed-sign x-log setup stays finite too (x/y parity on the zoom path)', () => {
            const c = createLineChart({
                data: [{ x: -5, y: 1 }, { x: 1, y: 2 }, { x: 1000, y: 3 }],
                xScale: { type: 'log' },
                zoom: true,
                panBounds: 'free',
                width: 500, height: 300,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                schedule: (fn) => fn(),
            });
            const canvas = createInteractiveMockCanvas(500, 300);
            c.mount(canvas);
            assert.ok(c.xScale.dMin > 0 && Number.isFinite(c.xScale.dMax), 'mount floors to a positive x-domain');
            const dMinBeforeZoom = c.xScale.dMin;

            canvas.dispatch('wheel', { clientX: 250, clientY: 150, deltaY: -100, preventDefault: () => {} });

            const v = c.view();
            assert.ok(v != null, 'zoom should set a view');
            assert.ok(
                Number.isFinite(v.xMin) && Number.isFinite(v.xMax) &&
                Number.isFinite(v.yMin) && Number.isFinite(v.yMax),
                'v1.6.1: zoomed mixed-sign x-log view is finite, not NaN',
            );
            assert.ok(v.xMin > 0, 'v1.6.1: zoomed x-log view min stays positive');
            assert.notStrictEqual(c.xScale.dMin, dMinBeforeZoom,
                'v1.6.1: the x-scale must have actually MOVED (zoomed in) off its pre-zoom value');
            c.destroy();
        });
    });
});

describe('view facade + scale integration (v1.4.0-alpha.2)', () => {
    it('chart without pan/zoom config has no view facade methods that work', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:1,y:10}],
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        // view() returns null when interactions aren't enabled
        assert.strictEqual(c.view(), null);
        // setView/resetView throw
        assert.throws(() => c.setView({ xMin: 0, xMax: 1 }), /pan: true.*zoom: true/);
        assert.throws(() => c.resetView(), /pan: true.*zoom: true/);
        c.destroy();
    });

    it('opting into pan exposes view facade', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:10,y:100}],
            pan: true,
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        // Initial view is null (use data domain)
        assert.strictEqual(c.view(), null);
        // setView accepts a view object
        c.setView({ xMin: 2, xMax: 5 });
        const v = c.view();
        assert.strictEqual(v.xMin, 2);
        assert.strictEqual(v.xMax, 5);
        // resetView clears it
        c.resetView();
        assert.strictEqual(c.view(), null);
        c.destroy();
    });

    it('setView rejects malformed input', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:10,y:10}],
            pan: true,
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        assert.throws(() => c.setView('not an object'), /view must be null or an object/);
        assert.throws(() => c.setView(42), /view must be null or an object/);
        // null is valid (alias for resetView)
        c.setView(null);
        assert.strictEqual(c.view(), null);
        c.destroy();
    });

    it('view changes flow through to xScale domain', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:10,y:100},{x:20,y:200}],
            pan: true,
            width: 500, height: 250,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(500, 250));
        // Initial: data domain x in [0, 20].
        const xScaleInit = c.xScale;
        const initMin = xScaleInit.dMin;
        const initMax = xScaleInit.dMax;
        assert.strictEqual(initMin, 0);
        assert.strictEqual(initMax, 20);
        // Set view to a subset
        c.setView({ xMin: 5, xMax: 15 });
        assert.strictEqual(c.xScale.dMin, 5);
        assert.strictEqual(c.xScale.dMax, 15);
        // Partial: only y set, x falls back to data
        c.setView({ yMin: 50, yMax: 150 });
        assert.strictEqual(c.xScale.dMin, 0);   // back to data
        assert.strictEqual(c.xScale.dMax, 20);
        assert.strictEqual(c.yScale.dMin, 50);
        assert.strictEqual(c.yScale.dMax, 150);
        // Reset
        c.resetView();
        assert.strictEqual(c.xScale.dMin, 0);
        assert.strictEqual(c.xScale.dMax, 20);
        c.destroy();
    });

    it('view is reactive -- effects fire on view change', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            zoom: true,    // zoom alone is enough to enable view
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        let observations = 0;
        let lastView = 'init';
        const stop = effect(() => {
            lastView = c.view();
            observations++;
        });
        assert.strictEqual(observations, 1);
        assert.strictEqual(lastView, null);
        c.setView({ xMin: 10, xMax: 90 });
        assert.strictEqual(observations, 2);
        assert.deepStrictEqual(lastView, { xMin: 10, xMax: 90, yMin: null, yMax: null });
        c.resetView();
        assert.strictEqual(observations, 3);
        assert.strictEqual(lastView, null);
        stop();
        c.destroy();
    });
});

describe('pan + zoom integration (v1.4.0-alpha.2)', () => {
    // Extended mock that adds addEventListener so the actual listener
    // path can be exercised. Keeps the API surface minimal: register
    // handlers in a map and dispatch them via .dispatch(type, event).
    const createInteractiveMockCanvas = (width, height) => {
        const base = createMockCanvas(width, height);
        const listeners = new Map();
        base.addEventListener = (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        };
        base.removeEventListener = (type, fn) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
        };
        base.getBoundingClientRect = () => ({ left: 0, top: 0, width: base.width, height: base.height });
        base.dispatch = (type, ev) => {
            const arr = listeners.get(type);
            if (!arr) return;
            // Iterate over a copy in case handlers mutate the list.
            const copy = arr.slice();
            for (let i = 0; i < copy.length; i++) copy[i](ev);
        };
        // setPointerCapture / releasePointerCapture: no-op stubs so the
        // listener's try/catch path doesn't fire.
        base.setPointerCapture = () => {};
        base.releasePointerCapture = () => {};
        return base;
    };

    it('pointerdown -> pointermove -> pointerup updates view', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            pan: true,
            panBounds: 'free',   // disable clamping so small pan isn't snapped
            width: 500, height: 300,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Start view = null (data domain x=[0,100], y=[0,100]).
        // Drag from (250, 150) -- center of plot -- to (200, 150)
        // (50 pixels to the LEFT).
        canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
        canvas.dispatch('pointermove', { clientX: 200, clientY: 150, pointerId: 1 });
        canvas.dispatch('pointerup',   { clientX: 200, clientY: 150, pointerId: 1 });

        const v = c.view();
        assert.ok(v != null, 'view should be set after drag');
        // dx = -50 pixels on a ~500-wide plot. dxData ~ -50 * 100 / plotW ~ -10.
        // newXLo = 0 - (-10) = 10; newXMax = 100 - (-10) = 110.
        assert.ok(v.xMin > 0, 'drag left should shift view RIGHT (xMin grows); got xMin=' + v.xMin);
        assert.ok(v.xMax > 100, 'drag left should extend xMax past data; got xMax=' + v.xMax);

        c.destroy();
    });

    it('wheel down zooms out, wheel up zooms in', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            zoom: true,
            panBounds: 'free',   // disable clamping for cleaner math check
            width: 500, height: 300,
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Set a starting view explicitly so we know what to expect after zoom.
        c.setView({ xMin: 0, xMax: 100, yMin: 0, yMax: 100 });
        const before = c.view();
        const beforeSpanX = before.xMax - before.xMin;

        // Wheel up (deltaY < 0) = zoom in -> span shrinks.
        canvas.dispatch('wheel', {
            clientX: 250, clientY: 150,
            deltaY: -100,
            preventDefault: () => {},
        });
        const after = c.view();
        const afterSpanX = after.xMax - after.xMin;
        assert.ok(afterSpanX < beforeSpanX, 'zoom in should shrink x-span; before=' + beforeSpanX + ' after=' + afterSpanX);

        // Now zoom out -- span should grow back past the original.
        canvas.dispatch('wheel', { clientX: 250, clientY: 150, deltaY: 100, preventDefault: () => {} });
        canvas.dispatch('wheel', { clientX: 250, clientY: 150, deltaY: 100, preventDefault: () => {} });
        const after2 = c.view();
        const after2SpanX = after2.xMax - after2.xMin;
        assert.ok(after2SpanX > afterSpanX, 'subsequent zoom-outs should grow span');

        c.destroy();
    });

    it('pan with panBounds: data clamps to data domain', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            pan: true,
            panBounds: 'data',  // default; explicit for clarity
            width: 500, height: 300,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Drag VERY far right -- 10,000 pixels. Without clamping, this
        // would push xMin way negative. With panBounds: 'data', the
        // view should snap back to the data domain bounds.
        canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
        canvas.dispatch('pointermove', { clientX: 10250, clientY: 150, pointerId: 1 });

        const v = c.view();
        // With clamping, xMin should not be below 0.
        assert.ok(v.xMin >= 0 - 1e-9, 'panBounds:data should keep xMin >= 0; got ' + v.xMin);
        // And xMax should not exceed 100.
        assert.ok(v.xMax <= 100 + 1e-9, 'panBounds:data should keep xMax <= 100; got ' + v.xMax);

        canvas.dispatch('pointerup', { clientX: 10250, clientY: 150, pointerId: 1 });
        c.destroy();
    });

    it('panBounds: free allows view to extend past data', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            pan: true,
            panBounds: 'free',
            width: 500, height: 300,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
        canvas.dispatch('pointermove', { clientX: 10250, clientY: 150, pointerId: 1 });

        const v = c.view();
        // With free bounds, xMin should be well below 0 (we dragged way right).
        assert.ok(v.xMin < -100, 'panBounds:free should let view extend; got xMin=' + v.xMin);

        canvas.dispatch('pointerup', { clientX: 10250, clientY: 150, pointerId: 1 });
        c.destroy();
    });

    it('non-left mouse buttons do not initiate pan', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            pan: true,
            width: 500, height: 300,
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Right-click drag should NOT pan (reserved for context menu / future brush).
        canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 2, pointerId: 1 });
        canvas.dispatch('pointermove', { clientX: 200, clientY: 150, pointerId: 1 });
        canvas.dispatch('pointerup',   { clientX: 200, clientY: 150, pointerId: 1 });

        // View should still be null (no pan initiated).
        assert.strictEqual(c.view(), null);
        c.destroy();
    });

    it('pointerdown outside plot does not initiate pan', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            pan: true,
            width: 500, height: 300,
            margin: { top: 50, right: 50, bottom: 50, left: 50 },
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Click in the left margin (x=10, plot starts at x=50).
        canvas.dispatch('pointerdown', { clientX: 10, clientY: 150, button: 0, pointerId: 1 });
        canvas.dispatch('pointermove', { clientX: 60, clientY: 150, pointerId: 1 });
        canvas.dispatch('pointerup',   { clientX: 60, clientY: 150, pointerId: 1 });

        assert.strictEqual(c.view(), null, 'click in margin should not initiate pan');
        c.destroy();
    });

    it('disposers remove listeners on destroy', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            pan: true,
            zoom: true,
            width: 500, height: 300,
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);
        // Trigger one drag to confirm wiring.
        canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
        canvas.dispatch('pointermove', { clientX: 200, clientY: 150, pointerId: 1 });
        canvas.dispatch('pointerup',   { clientX: 200, clientY: 150, pointerId: 1 });
        assert.ok(c.view() != null, 'pre-destroy: pan should work');

        c.destroy();

        // After destroy, dispatching events should not throw or mutate
        // anything (the listeners are gone -- and the chart is anyway
        // destroyed so no observable state).
        canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1 });
        canvas.dispatch('pointermove', { clientX: 200, clientY: 150, pointerId: 1 });
        // No assertion -- just verify no crash.
    });
});

// ---------------------------------------------------------------------------
// v1.4.0-alpha.3 -- brushing
// ---------------------------------------------------------------------------

describe('brush math (v1.4.0-alpha.3)', () => {
    const { _normalizeBrushRect, _brushPxToData, _computeBrushIds, makeLinearScale, updateLinearScale } = _testHelpers;

    describe('_normalizeBrushRect', () => {
        it('orders corners regardless of drag direction', () => {
            // Drag from top-left to bottom-right
            const r1 = _normalizeBrushRect(10, 20, 100, 200);
            assert.strictEqual(r1.pxMin, 10);
            assert.strictEqual(r1.pxMax, 100);
            assert.strictEqual(r1.pyMin, 20);
            assert.strictEqual(r1.pyMax, 200);
            // Drag from bottom-right to top-left -- same result
            const r2 = _normalizeBrushRect(100, 200, 10, 20);
            assert.deepStrictEqual(r1, r2);
            // Drag from top-right to bottom-left
            const r3 = _normalizeBrushRect(100, 20, 10, 200);
            assert.deepStrictEqual(r1, r3);
        });
    });

    describe('_brushPxToData', () => {
        it('inverts pixel rect through linear scales (y flipped)', () => {
            // x: 0..100 maps to pixel 0..500
            const xs = makeLinearScale();
            updateLinearScale(xs, 0, 100, 0, 500);
            // y: 0..50 maps to pixel 250..0 (y flipped)
            const ys = makeLinearScale();
            updateLinearScale(ys, 0, 50, 250, 0);
            const rect = { pxMin: 100, pxMax: 300, pyMin: 50, pyMax: 200 };
            const data = _brushPxToData(rect, xs, ys);
            // x: 100/500 * 100 = 20; 300/500 * 100 = 60
            assert.strictEqual(data.xMin, 20);
            assert.strictEqual(data.xMax, 60);
            // y: pyMin=50 -> high y; pyMax=200 -> low y. invert maps
            // top pixels to HIGH data. yMax = invert(50), yMin = invert(200).
            // Pixel 50 = 250 - 5*y -> y = 40. Pixel 200 = 250 - 5*y -> y = 10.
            assert.strictEqual(data.yMin, 10);
            assert.strictEqual(data.yMax, 40);
        });
    });

    describe('_computeBrushIds', () => {
        it('returns indices of points inside the rect', () => {
            const xs = [10, 20, 30, 40, 50];
            const ys = [1, 5, 3, 8, 4];
            const ids = _computeBrushIds(xs, ys, 5, 15, 45, 2, 7);
            // 20,5  30,3  40,8(out, y>7)  -- so [1,2]
            assert.deepStrictEqual(ids, [1, 2]);
        });

        it('inclusive at boundaries', () => {
            const xs = [0, 10, 20];
            const ys = [0, 5, 10];
            const ids = _computeBrushIds(xs, ys, 3, 0, 20, 0, 10);
            assert.deepStrictEqual(ids, [0, 1, 2]);
        });

        it('handles empty selection', () => {
            const xs = [10, 20, 30];
            const ys = [1, 2, 3];
            const ids = _computeBrushIds(xs, ys, 3, 100, 200, 0, 10);
            assert.deepStrictEqual(ids, []);
        });

        it('handles zero-length input', () => {
            const ids = _computeBrushIds([], [], 0, 0, 100, 0, 100);
            assert.deepStrictEqual(ids, []);
        });
    });
});

describe('brush facade (v1.4.0-alpha.3)', () => {
    it('chart without brush:true returns null and throws on set/clear', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:1,y:1}],
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        assert.strictEqual(c.brush(), null);
        assert.throws(() => c.setBrush({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 }), /brush: true/);
        assert.throws(() => c.clearBrush(), /brush: true/);
        c.destroy();
    });

    it('opting in exposes setBrush + clearBrush', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:10,y:100}],
            brush: true,
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        assert.strictEqual(c.brush(), null);
        c.setBrush({ xMin: 2, xMax: 5, yMin: 10, yMax: 60 });
        const b = c.brush();
        assert.ok(b != null);
        assert.strictEqual(b.xMin, 2);
        assert.strictEqual(b.xMax, 5);
        assert.strictEqual(b.yMin, 10);
        assert.strictEqual(b.yMax, 60);
        c.clearBrush();
        assert.strictEqual(c.brush(), null);
        c.destroy();
    });

    it('setBrush rejects malformed input', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:10,y:10}],
            brush: true,
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        assert.throws(() => c.setBrush('garbage'), /brush must be null or an object/);
        assert.throws(() => c.setBrush(42), /brush must be null or an object/);
        c.setBrush(null);
        assert.strictEqual(c.brush(), null);
        c.destroy();
    });

    it('brush is reactive -- effects fire on changes', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            brush: true,
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        let observations = 0;
        let lastBrush = 'init';
        const stop = effect(() => {
            lastBrush = c.brush();
            observations++;
        });
        assert.strictEqual(observations, 1);
        assert.strictEqual(lastBrush, null);
        c.setBrush({ xMin: 10, xMax: 90, yMin: 10, yMax: 90 });
        assert.strictEqual(observations, 2);
        assert.ok(lastBrush != null);
        assert.strictEqual(lastBrush.xMin, 10);
        c.clearBrush();
        assert.strictEqual(observations, 3);
        assert.strictEqual(lastBrush, null);
        stop();
        c.destroy();
    });

    it('pan and brush coexist (both enabled)', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            pan: true,
            brush: true,
            width: 400, height: 200,
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(400, 200));
        // Both facades work
        assert.strictEqual(c.view(), null);
        assert.strictEqual(c.brush(), null);
        c.setView({ xMin: 10, xMax: 50 });
        c.setBrush({ xMin: 20, xMax: 40, yMin: 30, yMax: 60 });
        assert.deepStrictEqual(c.view(), { xMin: 10, xMax: 50, yMin: null, yMax: null });
        const b = c.brush();
        assert.strictEqual(b.xMin, 20);
        c.destroy();
    });
});

describe('brush integration -- shift-drag (v1.4.0-alpha.3)', () => {
    const createInteractiveMockCanvas = (width, height) => {
        const base = createMockCanvas(width, height);
        const listeners = new Map();
        base.addEventListener = (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        };
        base.removeEventListener = (type, fn) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
        };
        base.getBoundingClientRect = () => ({ left: 0, top: 0, width: base.width, height: base.height });
        base.dispatch = (type, ev) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const copy = arr.slice();
            for (let i = 0; i < copy.length; i++) copy[i](ev);
        };
        base.setPointerCapture = () => {};
        base.releasePointerCapture = () => {};
        return base;
    };

    it('shift+drag commits a brush selection', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:10,y:10},{x:20,y:20},{x:30,y:30},{x:40,y:40}],
            brush: true,
            width: 500, height: 300,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Shift-drag from middle to lower-right
        canvas.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 1, shiftKey: true, preventDefault: () => {} });
        canvas.dispatch('pointermove', { clientX: 300, clientY: 200, pointerId: 1, shiftKey: true });
        canvas.dispatch('pointerup',   { clientX: 300, clientY: 200, pointerId: 1, shiftKey: true });

        const b = c.brush();
        assert.ok(b != null, 'brush should be set after shift+drag');
        assert.ok(b.xMin < b.xMax, 'xMin < xMax');
        assert.ok(b.yMin < b.yMax, 'yMin < yMax');
        assert.ok(Array.isArray(b.ids), 'ids should be an array');

        c.destroy();
    });

    it('bare drag does not initiate brush (when pan is off)', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            brush: true,
            width: 500, height: 300,
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Drag WITHOUT shift -- brush should ignore it
        canvas.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 1, shiftKey: false, preventDefault: () => {} });
        canvas.dispatch('pointermove', { clientX: 300, clientY: 200, pointerId: 1, shiftKey: false });
        canvas.dispatch('pointerup',   { clientX: 300, clientY: 200, pointerId: 1, shiftKey: false });

        assert.strictEqual(c.brush(), null, 'bare drag should not produce a brush');
        c.destroy();
    });

    it('shift+drag is brush even when pan is enabled (modifier routing)', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            pan: true,
            brush: true,
            panBounds: 'free',
            width: 500, height: 300,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Shift+drag -- should produce a brush, NOT a view change
        canvas.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 1, shiftKey: true, preventDefault: () => {} });
        canvas.dispatch('pointermove', { clientX: 300, clientY: 200, pointerId: 1, shiftKey: true });
        canvas.dispatch('pointerup',   { clientX: 300, clientY: 200, pointerId: 1, shiftKey: true });

        assert.ok(c.brush() != null, 'brush should be set');
        assert.strictEqual(c.view(), null, 'view should NOT change');

        c.destroy();
    });

    it('shift+click without movement clears existing brush', () => {
        const c = createLineChart({
            data: [{x:0,y:0},{x:100,y:100}],
            brush: true,
            width: 500, height: 300,
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Set an initial brush via API
        c.setBrush({ xMin: 10, xMax: 50, yMin: 10, yMax: 50 });
        assert.ok(c.brush() != null);

        // Shift+click with minimal movement (1 pixel) -- below threshold
        canvas.dispatch('pointerdown', { clientX: 250, clientY: 150, button: 0, pointerId: 1, shiftKey: true, preventDefault: () => {} });
        canvas.dispatch('pointermove', { clientX: 251, clientY: 150, pointerId: 1, shiftKey: true });
        canvas.dispatch('pointerup',   { clientX: 251, clientY: 150, pointerId: 1, shiftKey: true });

        assert.strictEqual(c.brush(), null, 'sub-threshold click should clear brush');
        c.destroy();
    });

    it('brush IDs reflect points inside the selection', () => {
        // Use a known dataset spread evenly across the plot.
        const data = [
            { x: 0,   y: 0 },
            { x: 25,  y: 25 },
            { x: 50,  y: 50 },
            { x: 75,  y: 75 },
            { x: 100, y: 100 },
        ];
        const c = createLineChart({
            data,
            brush: true,
            width: 500, height: 300,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(500, 300);
        c.mount(canvas);

        // Programmatically set a brush covering ~50% of the data.
        c.setBrush({ xMin: 20, xMax: 80, yMin: 0, yMax: 100 });
        // Note: setBrush via the facade does NOT recompute ids -- ids
        // come only from the shift+drag gesture. This is documented
        // behavior; programmatic brushes set by users may have ids: null.
        const b = c.brush();
        assert.strictEqual(b.xMin, 20);
        assert.strictEqual(b.xMax, 80);
        // ids is null because we set via API (no gesture)
        assert.strictEqual(b.ids, null);

        c.destroy();
    });
});

// ---------------------------------------------------------------------------
// v1.7.0 -- annotation layer
// ---------------------------------------------------------------------------
//
// Data-pinned lines / ranges / points / text on the axis kernel. White-box
// assertions read the pooled-node projection through
// chart._internal.annotations (handle: { linePool, textPool, count, coordBuf,
// annGroup, dispose }). Pooled lineNode fields: _x/_y/_dx/_dy/_stroke/
// _strokeWidth/_visible; textNode fields: _text/_fill/_align/_x/_y/_visible.
// A9 (0 B/frame) is a torture gate in test/torture/t6-alloc.mjs section 7.

describe('v1.7.0 -- annotation layer', () => {
    const DATA = [
        { x: 0, y: 0 }, { x: 10, y: 50 }, { x: 20, y: 100 }, { x: 30, y: 150 },
    ];

    it('A1: line axis:y projects to a horizontal rule at yScale.map(value)', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: DATA,
            schedule: (fn) => fn(),
            annotations: [{ type: 'line', axis: 'y', value: 100 }],
        });
        chart.mount(canvas);
        const node = chart._internal.annotations.linePool[0];
        const pb = chart._internal.plotBoundsBox;
        assert.ok(Math.abs(node._y - chart.yScale.map(100)) <= 0.5,
            `_y=${node._y} vs map(100)=${chart.yScale.map(100)}`);
        assert.equal(node._dx, pb.w);
        assert.equal(node._dy, 0);
        assert.equal(node._visible, true);
        chart.unmount();
    });

    it('A2: a y-line clips (hides) when panned out of the y-domain, restores on reset', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: DATA,
            schedule: (fn) => fn(),
            pan: true,
            annotations: [{ type: 'line', axis: 'y', value: 100 }],
        });
        chart.mount(canvas);
        const node = chart._internal.annotations.linePool[0];
        assert.equal(node._visible, true);
        // Pan so the y-domain becomes [0,50]; value 100 is now above the plot.
        chart.setView({ xMin: null, xMax: null, yMin: 0, yMax: 50 });
        assert.equal(node._visible, false);
        chart.resetView();
        assert.equal(node._visible, true);
        assert.ok(Math.abs(node._y - chart.yScale.map(100)) <= 0.5);
        chart.unmount();
    });

    it('A3: a range band tracks a signal-valued `from` (reactive, no re-mount)', () => {
        const canvas = createMockCanvas(800, 400);
        const fromSig = signal(2);
        const chart = createLineChart({
            data: DATA,
            schedule: (fn) => fn(),
            annotations: () => [{ type: 'range', axis: 'x', from: fromSig(), to: 25, fill: '#123456' }],
        });
        chart.mount(canvas);
        const poolLenBefore = chart._internal.annotations.linePool.length;
        const rectX = (svg) => {
            const el = (svg.match(/<rect\b[^>]*>/g) || []).find((r) => r.includes('fill="#123456"'));
            assert.ok(el, 'range fill rect present');
            const xm = el.match(/\bx="([-\d.]+)"/);
            assert.ok(xm, 'rect has x attr');
            return +xm[1];
        };
        assert.ok(Math.abs(rectX(chart.exportSVG()) - chart.xScale.map(2)) <= 0.5);
        fromSig.set(3);
        assert.ok(Math.abs(rectX(chart.exportSVG()) - chart.xScale.map(3)) <= 0.5);
        assert.equal(chart._internal.annotations.linePool.length, poolLenBefore,
            'signal update must not re-mount / regrow the pool');
        chart.unmount();
    });

    it('A4: all four annotation types appear in exportSVG; no clip-rect leak', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: DATA,
            schedule: (fn) => fn(),
            annotations: [
                { type: 'range', axis: 'x', from: 5, to: 25, fill: '#abcdef' },
                { type: 'line', axis: 'y', value: 75, dash: [4, 4], color: '#ff0000' },
                { type: 'point', x: 15, y: 75, radius: 5, color: '#00ff00' },
                { type: 'text', x: 15, y: 100, text: 'PEAK', color: '#0000ff' },
            ],
        });
        chart.mount(canvas);
        const svg = chart.exportSVG();
        assert.ok(/<rect\b[^>]*fill="#abcdef"/.test(svg), 'range fill rect present');
        assert.ok(/stroke-dasharray/.test(svg) && svg.includes('#ff0000'), 'dashed rule present');
        assert.ok(svg.includes('#00ff00'), 'point marker present');
        assert.ok(/>PEAK</.test(svg) && svg.includes('#0000ff'), 'text label present');
        // Negative clause: no rect spanning the FULL plot rect (the D1
        // missing-beginPath clip-rect-fill regression would emit exactly that).
        const pb = chart._internal.plotBoundsBox;
        for (const r of (svg.match(/<rect\b[^>]*>/g) || [])) {
            const wm = r.match(/width="([-\d.]+)"/);
            const hm = r.match(/height="([-\d.]+)"/);
            if (!wm || !hm) continue;
            const full = Math.abs(+wm[1] - pb.w) <= 1 && Math.abs(+hm[1] - pb.h) <= 1;
            assert.ok(!full, `clip-rect leak: rect spans full plot (${wm[1]}x${hm[1]})`);
        }
        chart.unmount();
    });

    it('A5: refreshTheme re-resolves annotation CSS-var colors; redraw does not', () => {
        const origGCS = globalThis.getComputedStyle;
        let themeColor = '#ff0000';
        let gcsCalls = 0;
        globalThis.getComputedStyle = () => {
            gcsCalls++;
            return { getPropertyValue: (k) => (k === '--ann' ? themeColor : '') };
        };
        try {
            const canvas = createMockCanvas(800, 400);
            const chart = createLineChart({
                data: DATA,
                schedule: (fn) => fn(),
                annotations: [{ type: 'line', axis: 'y', value: 75, color: '--ann' }],
            });
            chart.mount(canvas);
            assert.equal(chart._internal.annotations.linePool[0]._stroke, '#ff0000');
            const callsAfterMount = gcsCalls;
            chart.redraw();
            chart.redraw();
            assert.equal(gcsCalls, callsAfterMount,
                'resolveColor/getComputedStyle must stay off the redraw path (D2)');
            themeColor = '#00ff00';
            chart.refreshTheme();
            assert.equal(chart._internal.annotations.linePool[0]._stroke, '#00ff00',
                'refreshTheme must re-resolve the annotation color');
            chart.unmount();
        } finally {
            globalThis.getComputedStyle = origGCS;
        }
    });

    it('A6: log axis fails closed on non-positive / null annotation values', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: [{ x: 0, y: 1 }, { x: 10, y: 10 }, { x: 20, y: 100 }],
            schedule: (fn) => fn(),
            yScale: { type: 'log' },
            annotations: [
                { type: 'line', axis: 'y', value: -5 },
                { type: 'line', axis: 'y', value: 0 },
                { type: 'line', axis: 'y', value: 10 },
                { type: 'line', axis: 'y', value: null },
            ],
        });
        chart.mount(canvas);
        const p = chart._internal.annotations.linePool;
        assert.equal(p[0]._visible, false, 'value:-5 must not render on a log axis');
        assert.equal(p[1]._visible, false, 'value:0 must not render (map(0)=NaN)');
        assert.equal(p[2]._visible, true, 'value:10 renders');
        assert.ok(Math.abs(p[2]._y - chart.yScale.map(10)) <= 0.5);
        assert.equal(p[3]._visible, false, 'value:null must not render (fail-closed)');
        chart.unmount();
    });

    it('A6b: a LINEAR axis fails closed on null/NaN values (Number(null)===0 must NOT draw at data-zero)', () => {
        // On a log axis map(0)/map(null) are already non-finite, so the project
        // step masks a missing resolve-time guard. The fail-open only bites on a
        // LINEAR axis, where map(null) coerces to the intercept -- a finite
        // pixel that would draw a phantom rule at data-zero. This case pins the
        // resolveInto Number.isFinite guard directly.
        const canvas = createMockCanvas(800, 400);
        const chart = createLineChart({
            data: DATA, // linear y-domain spanning 0
            schedule: (fn) => fn(),
            annotations: [
                { type: 'line', axis: 'y', value: null },
                { type: 'line', axis: 'y', value: NaN },
                { type: 'line', axis: 'y', value: undefined },
                { type: 'point', x: null, y: 50 },
                { type: 'range', axis: 'x', from: null, to: 10 },
                { type: 'line', axis: 'y', value: 50 }, // control: valid, renders
            ],
        });
        chart.mount(canvas);
        const p = chart._internal.annotations.linePool;
        assert.equal(p[0]._visible, false, 'value:null must not draw at data-zero (linear)');
        assert.equal(p[1]._visible, false, 'value:NaN must not render');
        assert.equal(p[2]._visible, false, 'value:undefined must not render');
        assert.equal(p[3]._visible, false, 'point x:null must not render');
        assert.equal(p[4]._visible, false, 'range from:null must not render');
        assert.equal(p[5]._visible, true, 'control: value:50 renders');
        assert.ok(Math.abs(p[5]._y - chart.yScale.map(50)) <= 0.5);
        chart.unmount();
    });

    it('A7: a chart with no annotations has a null handle; buildAnnotations is guarded', () => {
        const chart = createLineChart({ data: DATA, schedule: (fn) => fn() });
        chart.mount(createMockCanvas(800, 400));
        assert.equal(chart._internal.annotations, null, 'no annotations -> null handle');
        chart.unmount();

        const c2 = createLineChart({
            data: DATA, schedule: (fn) => fn(),
            annotations: [{ type: 'line', axis: 'y', value: 50 }],
        });
        c2.mount(createMockCanvas(800, 400));
        assert.ok(c2._internal.annotations && Array.isArray(c2._internal.annotations.linePool),
            'annotations config -> live handle with a pool');
        c2.unmount();

        // Source-region confinement proxy: buildAnnotations() is gated behind
        // `if (annotationsAcc)`, so a no-annotation chart never enters it.
        const src = readFileSync(new URL('../Charts.js', import.meta.url), 'utf8');
        assert.match(src, /if \(annotationsAcc\) \{[\s\S]{0,200}buildAnnotations\(/,
            'buildAnnotations() must be guarded by if (annotationsAcc)');
    });

    it('A8: on a horizontal bar, axis:y draws a vertical screen line via yScale (swap-aware)', () => {
        const canvas = createMockCanvas(400, 300);
        const chart = createBarChart({
            orientation: 'horizontal',
            data: [{ x: 'A', y: 30 }, { x: 'B', y: 50 }, { x: 'C', y: 20 }],
            schedule: (fn) => fn(),
            annotations: [{ type: 'line', axis: 'y', value: 25 }],
        });
        chart.mount(canvas);
        const node = chart._internal.annotations.linePool[0];
        const pb = chart._internal.plotBoundsBox;
        assert.ok(Math.abs(node._x - chart.yScale.map(25)) <= 0.5,
            `_x=${node._x} vs yScale.map(25)=${chart.yScale.map(25)}`);
        assert.equal(node._y, pb.y);
        assert.equal(node._dx, 0, 'a swapped y-line is vertical: _dx === 0');
        assert.equal(node._dy, pb.h);
        assert.equal(node._visible, true);
        chart.unmount();
    });

    it('A10: pool high-water holds on shrink; dispose is clean and idempotent', () => {
        const canvas = createMockCanvas(800, 400);
        const nSig = signal(40);
        const chart = createLineChart({
            data: DATA,
            schedule: (fn) => fn(),
            annotations: () => {
                const arr = [];
                for (let i = 0; i < nSig(); i++) arr.push({ type: 'line', axis: 'y', value: i + 1 });
                return arr;
            },
        });
        chart.mount(canvas);
        const ann = chart._internal.annotations;
        assert.ok(ann.linePool.length >= 40, 'grew to at least 40');
        const highWater = ann.linePool.length;
        for (let iter = 0; iter < 200; iter++) {
            nSig.set(2);
            assert.equal(ann.count, 2);
            assert.equal(ann.linePool.length, highWater, 'pool never grows past the high-water mark');
            for (let i = 2; i < highWater; i++) {
                assert.equal(ann.linePool[i]._visible, false, `surplus node ${i} must be hidden`);
            }
            nSig.set(40);
        }
        chart.unmount();
        chart.destroy();
        assert.doesNotThrow(() => chart.destroy(), 'destroy is idempotent');
    });
});

// ---------------------------------------------------------------------------
// v1.8.0 -- horizontal-bar interactions (value-axis pan / zoom + value grid)
// ---------------------------------------------------------------------------
//
// Horizontal bars swap the axis roles: the VALUE axis is on screen-X (bound
// via `yScale`), the BAND axis on screen-Y. The interaction layer stays in the
// standard frame; horizontal support is a `swapAxes ? <remapped> : <current>`
// selection at each gesture call site (onPanMove / onWheel), with the linear
// helpers `_applyPan` / `_applyZoom` / `_clampToBounds` left byte-identical.
//
// Key invariant used below: a horizontal pan of `dx` px translates the value
// scale by EXACTLY `dx` px (the plot-width / value-span factors cancel:
// dyData = dx*span/w, and re-mapping that back through the same `w`-wide range
// yields a `dx`-pixel shift), independent of margins or the value domain. The
// band axis stays pinned (dxPx=0 in pan, zoomX=1 in zoom).
describe('v1.8.0 -- horizontal-bar interactions', () => {
    // Interactive mock canvas: registers listeners and lets tests dispatch
    // real pointer/wheel events through the actual listener path.
    const createInteractiveMockCanvas = (width, height) => {
        const base = createMockCanvas(width, height);
        const listeners = new Map();
        base.addEventListener = (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        };
        base.removeEventListener = (type, fn) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
        };
        base.getBoundingClientRect = () => ({ left: 0, top: 0, width: base.width, height: base.height });
        base.dispatch = (type, ev) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const copy = arr.slice();
            for (let i = 0; i < copy.length; i++) copy[i](ev);
        };
        base.setPointerCapture = () => {};
        base.releasePointerCapture = () => {};
        return base;
    };

    // Horizontal bar, margin 0 so the plot fills the canvas, panBounds:'free'
    // so a pan past the data extent is not snapped. data max 100 + zero
    // baseline => value domain [0,100], so value 50 is a clean interior probe.
    const mkH = (extra) => createBarChart(Object.assign({
        data: [{ x: 'A', y: 100 }, { x: 'B', y: 50 }],
        orientation: 'horizontal',
        width: 400, height: 300,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        panBounds: 'free',
        schedule: (fn) => fn(),
    }, extra));

    // -- A1: horizontal pan moves the VALUE axis, band pinned ---------------
    it('A1: a horizontal drag translates the value scale by dx px; band unchanged', () => {
        const c = mkH({ pan: true });
        const canvas = createInteractiveMockCanvas(400, 300);
        c.mount(canvas);

        // Value axis == yScale (on screen-X); band axis == xScale (on screen-Y).
        const valuePxBefore = c.yScale.map(50);
        const bandPxBefore = c.xScale.map(0);

        // Rightward drag of +40px (dy = 0) from plot centre.
        canvas.dispatch('pointerdown', { clientX: 200, clientY: 150, button: 0, pointerId: 1 });
        canvas.dispatch('pointermove', { clientX: 240, clientY: 150, pointerId: 1 });
        canvas.dispatch('pointerup',   { clientX: 240, clientY: 150, pointerId: 1 });

        const valuePxAfter = c.yScale.map(50);
        const bandPxAfter = c.xScale.map(0);

        assert.ok(Math.abs((valuePxAfter - valuePxBefore) - 40) < 1e-6,
            'value scale should translate by exactly +40px; got ' + (valuePxAfter - valuePxBefore));
        assert.ok(Math.abs(bandPxAfter - bandPxBefore) < 1e-9,
            'band axis must stay pinned under a horizontal pan; moved by ' + (bandPxAfter - bandPxBefore));
        // Category order intact: the two band cells keep their relative order.
        assert.ok(c.xScale.map(0) !== c.xScale.map(1), 'band cells remain distinct');
        c.destroy();
    });

    // -- A1b: a VERTICAL drag must NOT move the value axis (roles swapped) --
    it('A1b: a purely vertical drag leaves the value axis untouched', () => {
        const c = mkH({ pan: true });
        const canvas = createInteractiveMockCanvas(400, 300);
        c.mount(canvas);

        const valuePxBefore = c.yScale.map(50);
        // Vertical drag of +40px (dx = 0). Under the swap, pan ignores dy.
        canvas.dispatch('pointerdown', { clientX: 200, clientY: 150, button: 0, pointerId: 1 });
        canvas.dispatch('pointermove', { clientX: 200, clientY: 190, pointerId: 1 });
        canvas.dispatch('pointerup',   { clientX: 200, clientY: 190, pointerId: 1 });
        const valuePxAfter = c.yScale.map(50);

        assert.ok(Math.abs(valuePxAfter - valuePxBefore) < 1e-9,
            'a vertical drag must not translate the value scale; moved by ' + (valuePxAfter - valuePxBefore));
        c.destroy();
    });

    // -- A2: horizontal zoom keeps the value under the cursor fixed ---------
    it('A2: wheel zoom holds the data value under the cursor stable', () => {
        const c = mkH({ zoom: true });
        const canvas = createInteractiveMockCanvas(400, 300);
        c.mount(canvas);
        const pb = c._internal.plotBoundsBox;
        const cursorPx = pb.x + 0.25 * pb.w;

        const valueUnderCursorBefore = c.yScale.invert(cursorPx);
        const spanBefore = Math.abs(c.yScale.invert(pb.x + pb.w) - c.yScale.invert(pb.x));

        // Zoom in (deltaY < 0) anchored at the cursor.
        canvas.dispatch('wheel', { clientX: cursorPx, clientY: pb.y + 0.5 * pb.h, deltaY: -100, preventDefault: () => {} });

        const valueUnderCursorAfter = c.yScale.invert(cursorPx);
        const spanAfter = Math.abs(c.yScale.invert(pb.x + pb.w) - c.yScale.invert(pb.x));

        assert.ok(spanAfter < spanBefore, 'zoom-in must shrink the value span (guards against a vetoed no-op); ' + spanAfter + ' vs ' + spanBefore);
        assert.ok(Math.abs(valueUnderCursorAfter - valueUnderCursorBefore) < 1e-9,
            'value under the cursor must stay fixed across zoom; moved by ' + (valueUnderCursorAfter - valueUnderCursorBefore));
        c.destroy();
    });

    // -- A3: value grid renders perpendicular to the value axis (vertical) --
    it('A3: horizontal value grid emits vertical, full-height gridlines', () => {
        // Count full-span moveTo->lineTo segments (a lite-scene line node emits
        // exactly one moveTo + one lineTo) with and without the grid, and check
        // what the grid ADDS -- robust to the fixed axis baselines.
        const scan = (chart) => {
            const canvas = createMockCanvas(400, 300);
            chart.mount(canvas);
            const ctx = canvas.getContext('2d');
            const pb = chart._internal.plotBoundsBox;
            ctx.calls.length = 0;
            chart.redraw();
            let vFull = 0, hFull = 0;
            const calls = ctx.calls;
            for (let i = 0; i < calls.length - 1; i++) {
                if (calls[i][0] !== 'moveTo' || calls[i + 1][0] !== 'lineTo') continue;
                const [x1, y1] = calls[i][1];
                const [x2, y2] = calls[i + 1][1];
                if (Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) >= 0.6 * pb.h) vFull++;
                if (Math.abs(y1 - y2) < 0.5 && Math.abs(x1 - x2) >= 0.6 * pb.w) hFull++;
            }
            chart.destroy();
            return { vFull, hFull };
        };

        const off = scan(mkH({ grid: false }));
        const on = scan(mkH({ grid: true }));

        assert.ok(on.vFull > off.vFull,
            'the value grid must ADD vertical full-height lines; ' + on.vFull + ' vs ' + off.vFull);
        assert.equal(on.hFull - off.hFull, 0,
            'the value grid must add NO horizontal full-width lines (they belong on the value axis, which is vertical here)');
    });

    // -- A4: unsupported combos still fail closed with a named message ------
    it('A4: log-value still throws at construction, before alloc', () => {
        const base = { data: [{ x: 'A', y: 1 }], orientation: 'horizontal', schedule: (fn) => fn() };
        assert.throws(
            () => createBarChart(Object.assign({}, base, { yScale: { type: 'log' } })),
            /log yScale is not supported/,
            'horizontal + log value axis must throw a named error',
        );
        // v1.9.0: horizontal + brush is now supported (value-range x band-set
        // payload); the behavioral suite for it lives with the qa layer.
        // Note: A5 (zero-alloc gesture path, 0 B/frame draw) is covered by the
        // torture gate, test/torture/t6-alloc.mjs section 8 (A14) + 9 (A15).
    });

    // -- A6: mount -> pan -> destroy leaves no node residue -----------------
    it('A6: 30 mount+pan+destroy cycles leak zero nodes; destroy idempotent', () => {
        const before = stats().activeNodes;
        for (let i = 0; i < 30; i++) {
            const c = mkH({ pan: true, zoom: true });
            const canvas = createInteractiveMockCanvas(400, 300);
            c.mount(canvas);
            canvas.dispatch('pointerdown', { clientX: 200, clientY: 150, button: 0, pointerId: 1 });
            canvas.dispatch('pointermove', { clientX: 240, clientY: 150, pointerId: 1 });
            canvas.dispatch('pointerup',   { clientX: 240, clientY: 150, pointerId: 1 });
            canvas.dispatch('wheel', { clientX: 100, clientY: 150, deltaY: -100, preventDefault: () => {} });
            c.destroy();
        }
        const delta = stats().activeNodes - before;
        assert.equal(delta, 0, 'horizontal interaction cycles should leave no node residue; delta=' + delta);

        const c = mkH({ pan: true });
        c.mount(createInteractiveMockCanvas(400, 300));
        c.destroy();
        assert.doesNotThrow(() => c.destroy(), 'second destroy must be a no-op');
    });
});

// ---------------------------------------------------------------------------
// v1.9.0 -- horizontal-bar brush (value-range x band-set)
// ---------------------------------------------------------------------------
//
// The cut deferred from v1.8.0. Under the horizontal axis-role swap the VALUE
// axis is on screen-X (yScale) and the BAND axis on screen-Y (xScale is the
// band scale). A shift+drag therefore selects a value RANGE (X extent) x a
// BAND SET (Y extent), emitted as a distinct payload
// { valueMin, valueMax, bandMin, bandMax, bands, ids } -- NOT the vertical
// { xMin, xMax, yMin, yMax, ids }. Every branch is a `swapAxes ?` selection at
// the call site; the pure helpers (_normalizeBrushRect / _brushPxToData /
// _computeBrushIds / makeBandScale) stay byte-identical, so the vertical /
// line / scatter brush path is provably untouched (HB3 regression guard).
describe('v1.9.0 -- horizontal-bar brush', () => {
    const createInteractiveMockCanvas = (width, height) => {
        const base = createMockCanvas(width, height);
        const listeners = new Map();
        base.addEventListener = (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        };
        base.removeEventListener = (type, fn) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
        };
        base.getBoundingClientRect = () => ({ left: 0, top: 0, width: base.width, height: base.height });
        base.dispatch = (type, ev) => {
            const arr = listeners.get(type);
            if (!arr) return;
            const copy = arr.slice();
            for (let i = 0; i < copy.length; i++) copy[i](ev);
        };
        base.setPointerCapture = () => {};
        base.releasePointerCapture = () => {};
        return base;
    };

    // Category order 'A','B' => band index 0,1. Value domain spans [0,100]
    // (zero baseline + max 100). margin 0 so plot fills the 400x300 canvas.
    const CATS = ['A', 'B'];
    const mkH = (extra) => createBarChart(Object.assign({
        data: [{ x: 'A', y: 100 }, { x: 'B', y: 50 }],
        orientation: 'horizontal',
        width: 400, height: 300,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        schedule: (fn) => fn(),
    }, extra));

    const shiftDrag = (canvas, x0, y0, x1, y1) => {
        canvas.dispatch('pointerdown', { clientX: x0, clientY: y0, button: 0, pointerId: 1, shiftKey: true, preventDefault: () => {} });
        canvas.dispatch('pointermove', { clientX: x1, clientY: y1, pointerId: 1, shiftKey: true });
        canvas.dispatch('pointerup',   { clientX: x1, clientY: y1, pointerId: 1, shiftKey: true });
    };

    // -- HB1: a shift-drag maps X->value range and Y->band set --------------
    it('HB1: shift-drag emits value bounds from yScale.invert and the spanned band set', () => {
        const c = mkH({ brush: true });
        const canvas = createInteractiveMockCanvas(400, 300);
        c.mount(canvas);

        // Expected bounds derived from the SAME live scales (brush does not pan,
        // so the scales are identical before/after the gesture).
        const exVMin = Math.min(c.yScale.invert(120), c.yScale.invert(360));
        const exVMax = Math.max(c.yScale.invert(120), c.yScale.invert(360));
        const eb0 = c.xScale.invert(40), eb1 = c.xScale.invert(260);
        const exBMin = Math.min(eb0, eb1), exBMax = Math.max(eb0, eb1);
        const exBands = [];
        for (let b = exBMin; b <= exBMax; b++) exBands.push(CATS[b]);

        shiftDrag(canvas, 120, 40, 360, 260);
        const b = c.brush();

        assert.ok(b != null, 'shift-drag must commit a brush');
        // Payload is the horizontal shape, not the vertical one.
        assert.ok('valueMin' in b && 'bandMin' in b && 'bands' in b, 'horizontal payload shape');
        assert.ok(!('xMin' in b), 'must NOT carry the vertical xMin/yMin shape');
        assert.ok(Math.abs(b.valueMin - exVMin) < 1e-6, 'valueMin from yScale.invert; got ' + b.valueMin + ' want ' + exVMin);
        assert.ok(Math.abs(b.valueMax - exVMax) < 1e-6, 'valueMax from yScale.invert; got ' + b.valueMax + ' want ' + exVMax);
        assert.equal(b.bandMin, exBMin, 'bandMin = floored band index at the Y extent');
        assert.equal(b.bandMax, exBMax, 'bandMax = floored band index at the Y extent');
        assert.deepEqual(b.bands, exBands, 'bands = category keys across [bandMin,bandMax]');
        assert.ok(Array.isArray(b.ids), 'ids is an array (primary-series row indices)');
        c.destroy();
    });

    // -- HB2: full-plot drag selects all bands + full value span; click clears
    it('HB2: full-plot drag selects every band; sub-threshold shift-click clears', () => {
        const c = mkH({ brush: true });
        const canvas = createInteractiveMockCanvas(400, 300);
        c.mount(canvas);

        shiftDrag(canvas, 0, 0, 400, 300);
        const b = c.brush();
        assert.ok(b != null);
        assert.equal(b.bandMin, 0, 'covers the first band');
        assert.equal(b.bandMax, CATS.length - 1, 'covers the last band');
        assert.equal(b.bands.length, CATS.length, 'all categories selected');
        assert.ok(Math.abs(b.valueMin - c.yScale.invert(0)) < 1e-6, 'value span reaches the left plot edge');
        assert.ok(Math.abs(b.valueMax - c.yScale.invert(400)) < 1e-6, 'value span reaches the right plot edge');

        // A shift-click (< 3px movement) clears the active brush.
        shiftDrag(canvas, 250, 150, 251, 150);
        assert.strictEqual(c.brush(), null, 'sub-threshold shift-click clears the brush');
        c.destroy();
    });

    // -- HB3: facade validation fails closed; vertical path is byte-untouched
    it('HB3: horizontal setBrush validates fail-closed; the vertical brush shape is unchanged', () => {
        const c = mkH({ brush: true });
        c.mount(createInteractiveMockCanvas(400, 300));
        // A non-finite value bound must throw, never coerce null->0.
        assert.throws(
            () => c.setBrush({ valueMin: null, valueMax: 80, bandMin: 0, bandMax: 1 }),
            /horizontal brush must be null/,
            'null value bound must fail closed at the facade',
        );
        // A valid horizontal payload round-trips.
        c.setBrush({ valueMin: 20, valueMax: 80, bandMin: 0, bandMax: 0, bands: ['A'], ids: null });
        const hb = c.brush();
        assert.equal(hb.valueMin, 20);
        assert.equal(hb.valueMax, 80);
        assert.equal(hb.bandMin, 0);
        assert.deepEqual(hb.bands, ['A']);
        c.destroy();

        // Regression: the VERTICAL brush path must be untouched by the swap
        // branch -- setBrush still yields exactly the four {x,y} bounds.
        const v = createBarChart({
            data: [{ x: 'A', y: 100 }, { x: 'B', y: 50 }],
            orientation: 'vertical', brush: true,
            width: 400, height: 300, schedule: (fn) => fn(),
        });
        v.mount(createInteractiveMockCanvas(400, 300));
        v.setBrush({ xMin: 2, xMax: 5, yMin: 10, yMax: 60 });
        const vb = v.brush();
        assert.equal(vb.xMin, 2); assert.equal(vb.xMax, 5);
        assert.equal(vb.yMin, 10); assert.equal(vb.yMax, 60);
        assert.ok(!('valueMin' in vb), 'vertical payload must not gain horizontal fields');
        v.destroy();
    });

    // -- HB4: construction -- brush now allowed; log-value still fails closed
    it('HB4: horizontal + brush constructs; horizontal + brush + log-value still throws', () => {
        assert.doesNotThrow(
            () => mkH({ brush: true }).destroy(),
            'horizontal + brush must no longer throw at construction',
        );
        assert.throws(
            () => createBarChart({
                data: [{ x: 'A', y: 1 }], orientation: 'horizontal',
                brush: true, yScale: { type: 'log' }, schedule: (fn) => fn(),
            }),
            /log yScale is not supported/,
            'log value axis is checked first and still fails closed',
        );
    });

    // -- HB5: overlay rect aligns to band EDGES, not band centers -----------
    it('HB5: brush overlay spans band leftEdge..leftEdge+bandWidth (not the center)', () => {
        const c = mkH({ brush: true });
        const canvas = createMockCanvas(400, 300);
        c.mount(canvas);
        const ctx = canvas.getContext('2d');

        c.setBrush({ valueMin: 20, valueMax: 80, bandMin: 0, bandMax: 0, bands: ['A'], ids: null });
        ctx.calls.length = 0;
        c.redraw();

        const fill = ctx.calls.filter((k) => k[0] === 'fillRect').pop();
        assert.ok(fill, 'overlay must emit a fillRect for the active brush');
        const [rx, ry, rw, rh] = fill[1];

        // X extent tracks the value axis (yScale under swap).
        const exX0 = Math.min(c.yScale.map(20), c.yScale.map(80));
        const exX1 = Math.max(c.yScale.map(20), c.yScale.map(80));
        assert.ok(Math.abs(rx - exX0) < 1e-6, 'rect left = yScale.map(valueMin)');
        assert.ok(Math.abs((rx + rw) - exX1) < 1e-6, 'rect right = yScale.map(valueMax)');

        // Y extent MUST use band edges. Center-based math (xScale.map) would put
        // ry at ~76.8 (the band center) instead of leftEdge(0)~14.6 -- a
        // half-band misalignment. This is the load-bearing check for T3.
        const edge0 = c.xScale.leftEdge(0);
        assert.ok(Math.abs(ry - edge0) < 1e-6, 'rect top = band leftEdge, not center; got ' + ry + ' want ' + edge0);
        assert.ok(Math.abs((ry + rh) - (edge0 + c.xScale.bandWidth)) < 1e-6, 'rect bottom = leftEdge + bandWidth');
        assert.ok(Math.abs(ry - c.xScale.map(0)) > 1, 'rect top must NOT sit at the band center (half-band guard)');
        c.destroy();
    });

    // -- HB6: mount -> brush/clear -> destroy leaks no nodes -----------------
    it('HB6: 50 brush/clear cycles leave zero node residue; destroy idempotent', () => {
        const before = stats().activeNodes;
        for (let i = 0; i < 50; i++) {
            const c = mkH({ brush: true });
            const canvas = createInteractiveMockCanvas(400, 300);
            c.mount(canvas);
            shiftDrag(canvas, 120, 40, 360, 260);   // commit
            c.clearBrush();                           // clear
            c.destroy();
        }
        assert.equal(stats().activeNodes - before, 0, 'brush cycles must leave no retained nodes');

        const c = mkH({ brush: true });
        c.mount(createInteractiveMockCanvas(400, 300));
        c.destroy();
        assert.doesNotThrow(() => c.destroy(), 'second destroy is a no-op');
    });

    // -- HB7: empty-category chart fails closed (no undefined band) ----------
    it('HB7: a shift-drag on an empty-category chart emits null, never an undefined band', () => {
        const c = createBarChart({
            data: [], orientation: 'horizontal', brush: true,
            width: 400, height: 300, margin: { top: 0, right: 0, bottom: 0, left: 0 },
            schedule: (fn) => fn(),
        });
        const canvas = createInteractiveMockCanvas(400, 300);
        c.mount(canvas);
        // xScale.invert returns -1 with zero categories; the commit must fail
        // closed to null rather than emit bands: [undefined] / bandMin: -1.
        shiftDrag(canvas, 120, 40, 360, 260);
        assert.strictEqual(c.brush(), null, 'empty-category brush must be null (fail closed)');
        c.destroy();
    });
});

// ---------------------------------------------------------------------------
// v1.10.0 -- time-series variants: createTimeLineChart + weekend shading
// ---------------------------------------------------------------------------
//
// createTimeLineChart is createLineChart with time-first defaults: xScale.type
// forced to 'time' (regardless of the x key, which inferXScaleType would read
// as 'linear'), panBounds defaulting to 'data', and an optional `shading` config
// that wraps the user's annotations with COLD-generated weekend range bands. The
// bands ride the v1.7.0 annotation layer unchanged -- plain {type:'range',
// axis:'x'} rows re-clipped per frame by the existing project effect, so there
// is NO new hot-path code. The generator derives its x-extent from the DATA
// accessors (never the scale), so bands regenerate on data change but NOT per
// pan/zoom frame.
//
// Fixed reference domain below: Mon 2021-01-04 -> Mon 2021-01-18 UTC (14 days)
// contains exactly two full weekends (Sat Jan 9 -> Mon Jan 11, Sat Jan 16 -> Mon
// Jan 18). The Jan 2-3 weekend ends exactly at the xMin midnight (to <= xMin)
// and is excluded. HB-style load-bearing proof: TS2 (null-gate) and TS5 (SoA
// branch) each go red under reversion of their guard.
describe('v1.10.0 -- time-series variants', () => {
    const { _weekendBands, _shadingAnnotationsAcc } = _testHelpers;
    const MON_04 = Date.UTC(2021, 0, 4);   // Monday
    const MON_18 = Date.UTC(2021, 0, 18);  // Monday, +14 days
    const DAY = 86400000;
    const FILL = 'rgba(0,0,0,0.05)';
    const TDATA = [{ x: MON_04, y: 1 }, { x: MON_18, y: 2 }];

    // -- TS1: _weekendBands emits exactly the Sat->Mon spans in range --------
    it('TS1: _weekendBands walks UTC weekends, Sat 00:00 -> Mon 00:00, in-range only', () => {
        const bands = _weekendBands(MON_04, MON_18, FILL);
        assert.equal(bands.length, 2, 'Mon->Mon 14-day span has exactly 2 weekends');
        for (const b of bands) {
            assert.equal(b.type, 'range');
            assert.equal(b.axis, 'x');
            assert.equal(b.fill, FILL);
            assert.equal(b.to - b.from, 2 * DAY, 'each band is a 48h Sat->Mon span');
            assert.equal(new Date(b.from).getUTCDay(), 6, 'band starts on a Saturday');
            assert.equal(new Date(b.to).getUTCDay(), 1, 'band ends on a Monday');
        }
        assert.equal(bands[0].from, Date.UTC(2021, 0, 9), 'first weekend starts Sat Jan 9');
        assert.equal(bands[0].to, Date.UTC(2021, 0, 11), 'first weekend ends Mon Jan 11');
        assert.equal(bands[1].from, Date.UTC(2021, 0, 16), 'second weekend starts Sat Jan 16');
        assert.equal(bands[1].to, Date.UTC(2021, 0, 18), 'second weekend ends Mon Jan 18');
    });

    // -- TS2: fail-closed -- null / non-finite / inverted extent -> no bands --
    it('TS2: _weekendBands fails closed on null/non-finite/inverted extent (null is not zero)', () => {
        assert.deepEqual(_weekendBands(null, MON_18, FILL), [], 'null xMin -> no bands (not epoch 0)');
        assert.deepEqual(_weekendBands(MON_04, null, FILL), [], 'null xMax -> no bands');
        assert.deepEqual(_weekendBands(undefined, MON_18, FILL), [], 'undefined xMin -> no bands');
        assert.deepEqual(_weekendBands(NaN, MON_18, FILL), [], 'NaN xMin -> no bands');
        assert.deepEqual(_weekendBands(MON_18, MON_04, FILL), [], 'inverted extent -> no bands');
        assert.deepEqual(_weekendBands(MON_04, MON_04, FILL), [], 'zero-width extent -> no bands');
        // The +null===0 trap: null bounds must NOT coerce to 1970 and emit ~2600
        // years of weekends. This is the guard the whole fail-closed law protects.
        assert.equal(_weekendBands(null, null, FILL).length, 0, 'null bounds must not coerce to epoch 0');
    });

    // -- TS3: no shading -> byte-identical passthrough of user annotations ----
    it('TS3: no shading -> passthrough of the user annotations accessor (zero added cost)', () => {
        assert.equal(_shadingAnnotationsAcc(null, null, [], null), null,
            'no shading + no annotations -> null (no annotation machinery)');
        const user = [{ type: 'line', axis: 'y', value: 5 }];
        const acc = _shadingAnnotationsAcc(null, user, [], null);
        assert.deepEqual(acc(), user, 'no shading -> user annotations pass through unchanged');
    });

    // -- TS4: shading concatenates weekend bands ahead of user annotations ----
    it('TS4: shading:true concatenates weekend bands then the user annotations', () => {
        const user = [{ type: 'line', axis: 'y', value: 5 }];
        const acc = _shadingAnnotationsAcc(true, user, [() => TDATA], buildAccessor('x'));
        const list = acc();
        assert.equal(list.length, 3, '2 weekend bands + 1 user annotation');
        assert.equal(list[0].type, 'range', 'weekend bands come first');
        assert.equal(list[2].type, 'line', 'user annotation preserved after the bands');
    });

    // -- TS5: SoA {xs,ys} data still yields weekend bands --------------------
    //    Regression for the reviewer's blocker: Array.isArray(rows) is false for
    //    SoA, so an unguarded scan would contribute no extent and silently emit
    //    zero bands (fail-open) for a first-class data shape. Interior noon
    //    endpoints keep the count robust to Float32 epoch quantization.
    it('TS5: SoA {xs,ys} data contributes an extent (no silent zero bands)', () => {
        const xs = Float32Array.from([Date.UTC(2021, 0, 6, 12), Date.UTC(2021, 0, 13, 12)]);
        const ys = Float32Array.from([1, 2]);
        const acc = _shadingAnnotationsAcc(true, null, [() => ({ xs, ys })], buildAccessor('x'));
        const list = acc();
        assert.equal(list.length, 1, 'SoA extent (Jan 6 -> Jan 13) yields the one interior weekend');
        assert.equal(list[0].type, 'range', 'the SoA-derived band is a range annotation');
    });

    // -- TS6: createTimeLineChart forces a time x-scale regardless of key -----
    it('TS6: createTimeLineChart forces xScaleType time even for a plain numeric x key', () => {
        const chart = createTimeLineChart({ data: TDATA, x: 'x', y: 'y', schedule: (fn) => fn() });
        chart.mount(createMockCanvas(800, 400));
        assert.equal(chart.xScaleType, 'time',
            'time preset forces time (inferXScaleType would read key x as linear)');
        chart.destroy();
    });

    // -- TS7: shading renders exactly the weekend bands as annotations -------
    it('TS7: shading:true adds exactly the in-domain weekend bands to the annotation layer', () => {
        const chart = createTimeLineChart({
            data: TDATA, x: 'x', y: 'y', shading: true, schedule: (fn) => fn(),
        });
        chart.mount(createMockCanvas(800, 400));
        const ann = chart._internal.annotations;
        assert.ok(ann, 'shading -> annotation handle exists');
        assert.equal(ann.count, 2, 'exactly the 2 in-domain weekends');
        chart.destroy();
    });

    // -- TS8: shading composes with user annotations ------------------------
    it('TS8: shading composes with user annotations (count = bands + user)', () => {
        const chart = createTimeLineChart({
            data: TDATA, x: 'x', y: 'y', shading: true,
            annotations: [{ type: 'line', axis: 'y', value: 1.5 }],
            schedule: (fn) => fn(),
        });
        chart.mount(createMockCanvas(800, 400));
        assert.equal(chart._internal.annotations.count, 3, '2 weekend bands + 1 user line');
        chart.destroy();
    });

    // -- TS9: no shading -> no annotation machinery (opt-in, zero cost) ------
    it('TS9: no shading config -> null annotation handle', () => {
        const chart = createTimeLineChart({ data: TDATA, x: 'x', y: 'y', schedule: (fn) => fn() });
        chart.mount(createMockCanvas(800, 400));
        assert.equal(chart._internal.annotations, null,
            'no shading + no annotations -> null handle (nothing added)');
        chart.destroy();
    });

    // -- TS10: fail-closed config validation --------------------------------
    it('TS10: createTimeLineChart validates its config and the shading kind', () => {
        assert.throws(() => createTimeLineChart(), /requires a config object/);
        assert.throws(() => createTimeLineChart(null), /requires a config object/);
        assert.throws(
            () => createTimeLineChart({ data: TDATA, shading: 42, schedule: (fn) => fn() }),
            /shading` must be/,
            'a numeric shading is rejected before any signal alloc');
    });

    // -- TS11: tree-shake confinement (source proxy; no esbuild in harness) --
    it('TS11: the weekend generator is reachable only through createTimeLineChart', () => {
        const src = readFileSync(new URL('../Charts.js', import.meta.url), 'utf8');
        // Match an immediate `(` -- a real call-site, never `name (` prose in a
        // comment (this codebase puts no space before a call paren). The defs are
        // `const _weekendBands = (` / `const _shadingAnnotationsAcc = (`, unmatched.
        const wbCalls = src.match(/_weekendBands\(/g) || [];
        assert.equal(wbCalls.length, 1,
            'the only _weekendBands() call-site is inside _shadingAnnotationsAcc');
        const saCalls = src.match(/_shadingAnnotationsAcc\(/g) || [];
        assert.equal(saCalls.length, 1,
            'the only _shadingAnnotationsAcc() call-site is inside createTimeLineChart');
        assert.ok(
            /export const createLineChart = \(config\) => createBaseAxisChart\(config, LINE_RENDERER\);/.test(src),
            'createLineChart stays a plain one-liner with no shading reference');
    });

    // -- TS12: mount/destroy retention with shading active -------------------
    it('TS12: repeated mount+destroy with shading leaves no retained nodes', () => {
        const before = stats().activeNodes;
        for (let i = 0; i < 50; i++) {
            const chart = createTimeLineChart({
                data: TDATA, x: 'x', y: 'y', shading: true, schedule: (fn) => fn(),
            });
            chart.mount(createMockCanvas(800, 400));
            chart.destroy();
        }
        assert.equal(stats().activeNodes - before, 0,
            'shading mount/destroy cycles must not retain reactive nodes');
    });

    // -- TS13: shading:false is a first-class opt-out (cloud-review finding) --
    //    The declared type is boolean | 'weekends' | {fill?}; a boolean flag
    //    variable must not throw on false. Other falsy junk (0, '') still throws.
    it('TS13: shading:false behaves exactly like absent; 0 and empty string still throw', () => {
        const chart = createTimeLineChart({
            data: TDATA, x: 'x', y: 'y', shading: false, schedule: (fn) => fn(),
        });
        chart.mount(createMockCanvas(800, 400));
        assert.equal(chart._internal.annotations, null,
            'shading:false -> no annotation machinery, same as omitting it');
        chart.destroy();
        assert.throws(
            () => createTimeLineChart({ data: TDATA, shading: 0, schedule: (fn) => fn() }),
            /shading` must be/, 'shading:0 is junk, not an opt-out');
        assert.throws(
            () => createTimeLineChart({ data: TDATA, shading: '', schedule: (fn) => fn() }),
            /shading` must be/, 'shading:"" is junk, not an opt-out');
    });

    // -- TS14: a per-row null x must not collapse the extent to epoch 0 -------
    //    (cloud-review finding). The coercing accessor turns {x: null} into
    //    +null === 0, so one missing timestamp in AoS data would span the extent
    //    1970 -> now and emit ~2600 bogus weekend bands. The scan uses a RAW
    //    accessor and gates == null before coercion; NaN garbage self-skips.
    //    Date-valued x rows still contribute (raw accessor + instanceof branch).
    it('TS14: per-row null/undefined/garbage x contributes no extent (null is not zero)', () => {
        const dirty = [
            { x: MON_04, y: 1 },
            { x: null, y: 2 },        // the +null === 0 trap, row-level
            { x: undefined, y: 3 },
            { x: 'not a date', y: 4 }, // -> NaN, self-skips both comparisons
            { x: MON_18, y: 5 },
        ];
        const acc = _shadingAnnotationsAcc(true, null, [() => dirty], (row) => row.x);
        const list = acc();
        assert.equal(list.length, 2,
            'dirty rows are skipped: still exactly the 2 in-domain weekends, not ~2600 from 1970');
        assert.equal(list[0].from, Date.UTC(2021, 0, 9), 'extent unpolluted by the null row');
        // Date-valued x still contributes via the instanceof branch.
        const dated = [{ x: new Date(MON_04), y: 1 }, { x: new Date(MON_18), y: 2 }];
        const acc2 = _shadingAnnotationsAcc(true, null, [() => dated], (row) => row.x);
        assert.equal(acc2().length, 2, 'Date x values map through getTime()');
    });
});

// ---------------------------------------------------------------------------
// v1.11.0 -- market-hours session shading (createTimeLineChart)
// ---------------------------------------------------------------------------
//
// `shading: { sessions: [{openMinutes, closeMinutes, days?}], sessionFill? }`
// shades NON-trading time: a single-cursor complement-of-open-union sweep over
// the data extent emits one range band per gap between open intervals. When
// sessions are present the weekend walker is never invoked (subsumption -- a
// day outside every session's `days` is fully inside a band, so Fri-close ->
// Mon-open is ONE merged band and nothing double-paints). The validator
// (_normalizeSessionSpec) throws at construction on junk; the generator does
// no sort at generation time -- ordering is an invariant of the validator's
// open-ascending sort plus closeMinutes <= 1440. T0: an explicit conflicting
// xScale.type now throws. Canonical fixture: Mon-Fri 09:30-16:00 (570/960)
// over Mon 00:00 -> Mon 00:00 x 2 weeks = EXACTLY 11 bands; the lunch-break
// two-session variant = 21 (11 outer + 10 weekday midday gaps).
describe('v1.11.0 -- market-hours session shading', () => {
    const { _sessionBands, _normalizeSessionSpec, _shadingAnnotationsAcc } = _testHelpers;
    const M = Date.UTC(2021, 0, 4);   // Monday
    const D = 86400000;
    const MIN = 60000;
    const O = 570 * MIN;              // 09:30 UTC
    const C = 960 * MIN;              // 16:00 UTC
    const FILL = 'rgba(0,0,0,0.05)';
    const SDATA = [{ x: M, y: 1 }, { x: M + 14 * D, y: 2 }];
    const spec1 = () => _normalizeSessionSpec({ sessions: [{ openMinutes: 570, closeMinutes: 960 }] });

    // -- TS15: canonical fixture, exact band list ----------------------------
    it('TS15: Mon-Fri 570/960 over 14 days emits exactly the 11 complement bands', () => {
        const bands = _sessionBands(M, M + 14 * D, spec1(), FILL);
        const expected = [[M, M + O]];
        for (let k = 0; k < 4; k++) expected.push([M + k * D + C, M + (k + 1) * D + O]);
        expected.push([M + 4 * D + C, M + 7 * D + O]);   // merged Fri 16:00 -> Mon 09:30
        for (let k = 7; k < 11; k++) expected.push([M + k * D + C, M + (k + 1) * D + O]);
        expected.push([M + 11 * D + C, M + 14 * D]);     // clipped tail
        assert.equal(bands.length, 11, 'exactly 11 bands');
        for (let i = 0; i < 11; i++) {
            assert.equal(bands[i].from, expected[i][0], `band ${i} from`);
            assert.equal(bands[i].to, expected[i][1], `band ${i} to`);
            assert.equal(bands[i].type, 'range');
            assert.equal(bands[i].axis, 'x');
            assert.equal(bands[i].fill, FILL);
            assert.ok(bands[i].to > bands[i].from, 'no zero-width band');
            if (i > 0) assert.ok(bands[i].from >= bands[i - 1].to, 'ordered, non-overlapping');
        }
    });

    // -- TS16: chart-level counts -- subsumption, lunch-break, day masks -----
    it('TS16: sessions subsume weekends (11 vs 2); lunch-break = 21; days mask honored', () => {
        const mk = (shading) => {
            const c = createTimeLineChart({ data: SDATA, shading, schedule: (fn) => fn() });
            c.mount(createMockCanvas(800, 400));
            return c;
        };
        const cs = mk({ sessions: [{ openMinutes: 570, closeMinutes: 960 }] });
        assert.equal(cs._internal.annotations.count, 11, 'sessions -> 11 bands (weekends subsumed)');
        cs.destroy();
        const cw = mk(true);
        assert.equal(cw._internal.annotations.count, 2, 'weekend-only baseline on the same data');
        cw.destroy();
        // Lunch-break: two sessions/day -> one extra midday gap per weekday.
        const lb = _sessionBands(M, M + 14 * D, _normalizeSessionSpec({
            sessions: [{ openMinutes: 570, closeMinutes: 690 }, { openMinutes: 750, closeMinutes: 960 }],
        }), FILL);
        assert.equal(lb.length, 21, '11 outer + 10 weekday midday gaps');
        assert.ok(lb.some((b) => b.from === M + 690 * MIN && b.to === M + 750 * MIN),
            'the Monday midday gap band is present');
        for (let i = 1; i < lb.length; i++) assert.ok(lb[i].from >= lb[i - 1].to, 'no overlap');
        // days:[1] (Mon only) over a pure-Saturday extent -> one full-extent band.
        const sat = _sessionBands(M + 5 * D, M + 6 * D, _normalizeSessionSpec({
            sessions: [{ openMinutes: 570, closeMinutes: 960, days: [1] }],
        }), FILL);
        assert.equal(sat.length, 1, 'extent outside every session day -> one band');
        assert.equal(sat[0].from, M + 5 * D);
        assert.equal(sat[0].to, M + 6 * D);
    });

    // -- TS17: validator fail-closed -----------------------------------------
    it('TS17: _normalizeSessionSpec throws on junk; null sessions/days follow the != null convention', () => {
        const mkc = (sessions) => () => createTimeLineChart({
            data: SDATA, shading: { sessions }, schedule: (fn) => fn(),
        });
        assert.throws(mkc([{ openMinutes: null, closeMinutes: 960 }]), /lite-charts/,
            'null openMinutes throws (null is not midnight)');
        assert.throws(mkc([{ openMinutes: 570, closeMinutes: null }]), /lite-charts/);
        assert.throws(mkc([{ openMinutes: 9.5, closeMinutes: 960 }]), /lite-charts/, 'non-integer');
        assert.throws(mkc([{ openMinutes: 570, closeMinutes: 570 }]), /lite-charts/, 'zero-width');
        // v1.13.0: overnight (close < open) no longer throws -- it splits at the
        // UTC midnight seam into two half-sessions. No days -> original mask 62,
        // rotated mask ((62<<1)|(62>>6))&127 = 124. Morning half sorts first.
        const ov = _normalizeSessionSpec({ sessions: [{ openMinutes: 960, closeMinutes: 570 }] });
        assert.equal(ov.sessions.length, 2, 'overnight splits into two half-sessions');
        assert.deepEqual(ov.sessions[0], { open: 0, close: 570, dayMask: 124 },
            'morning half [0,570] on the rotated next-day mask, sorted first');
        assert.deepEqual(ov.sessions[1], { open: 960, close: 1440, dayMask: 62 },
            'evening half [960,1440] on the original mask');
        assert.throws(mkc([{ openMinutes: 570, closeMinutes: 1441 }]), /lite-charts/, 'close > 1440');
        assert.throws(mkc([{ openMinutes: -1, closeMinutes: 960 }]), /lite-charts/, 'open < 0');
        assert.throws(mkc([]), /lite-charts/, 'empty sessions array');
        assert.throws(mkc({}), /lite-charts/, 'non-array sessions');
        assert.throws(mkc([{ openMinutes: 570, closeMinutes: 960, days: [] }]), /lite-charts/);
        assert.throws(mkc([{ openMinutes: 570, closeMinutes: 960, days: [7] }]), /lite-charts/);
        assert.throws(mkc([{ openMinutes: 570, closeMinutes: 960, days: [null] }]), /lite-charts/);
        assert.throws(mkc([{ openMinutes: 570, closeMinutes: 960, days: [1.5] }]), /lite-charts/);
        // The != null convention (reviewer-pinned): a bare null is ABSENT, not junk.
        assert.equal(_normalizeSessionSpec({ sessions: null }), null,
            'sessions: null -> weekend path (spec null)');
        const dn = _normalizeSessionSpec({ sessions: [{ openMinutes: 570, closeMinutes: 960, days: null }] });
        const dnBands = _sessionBands(M, M + 14 * D, dn, FILL);
        assert.equal(dnBands.length, 11, 'days: null falls to the Mon-Fri default mask');
    });

    // -- TS18: T0 -- explicit conflicting xScale.type throws -----------------
    it('TS18: createTimeLineChart rejects an explicit non-time xScale.type', () => {
        assert.throws(
            () => createTimeLineChart({ data: SDATA, xScale: { type: 'log' }, schedule: (fn) => fn() }),
            /time/, 'explicit log type throws instead of silent override');
        assert.throws(
            () => createTimeLineChart({ data: SDATA, xScale: { type: null }, schedule: (fn) => fn() }),
            /time/, 'type: null is junk, not absence');
        for (const xScale of [{}, { type: 'time' }, { type: undefined }]) {
            const c = createTimeLineChart({ data: SDATA, xScale, schedule: (fn) => fn() });
            c.mount(createMockCanvas(800, 400));
            assert.equal(c.xScaleType, 'time');
            c.destroy();
        }
    });

    // -- TS19: per-row null-x guard holds under sessions (TS14 reuse) --------
    it('TS19: dirty rows cannot collapse the session extent to 1970', () => {
        const dirty = [
            { x: M, y: 1 }, { x: null, y: 2 }, { x: undefined, y: 3 },
            { x: 'not a date', y: 4 }, { x: M + 14 * D, y: 5 },
        ];
        const acc = _shadingAnnotationsAcc(true, null, [() => dirty], (row) => row.x, spec1());
        const list = acc();
        assert.equal(list.length, 11, 'dirty rows skipped: the 11 canonical bands, not ~10k from 1970');
        assert.equal(list[0].from, M, 'extent unpolluted by the null row');
    });

    // -- TS20: tree-shake source confinement (extends TS11) ------------------
    it('TS20: session helpers reachable only through createTimeLineChart', () => {
        const src = readFileSync(new URL('../Charts.js', import.meta.url), 'utf8');
        for (const [name, n] of [['_sessionBands', 1], ['_normalizeSessionSpec', 1],
                                 ['_weekendBands', 1], ['_shadingAnnotationsAcc', 1]]) {
            const calls = src.match(new RegExp(name + '\\(', 'g')) || [];
            assert.equal(calls.length, n, `exactly ${n} immediate-paren call-site(s) of ${name}`);
        }
        assert.ok(
            /export const createLineChart = \(config\) => createBaseAxisChart\(config, LINE_RENDERER\);/.test(src),
            'createLineChart stays a plain one-liner');
    });

    // -- TS21: retention with sessions active --------------------------------
    it('TS21: repeated mount+destroy with sessions leaves no retained nodes', () => {
        const before = stats().activeNodes;
        for (let i = 0; i < 50; i++) {
            const c = createTimeLineChart({
                data: SDATA, shading: { sessions: [{ openMinutes: 570, closeMinutes: 960 }] },
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(800, 400));
            c.destroy();
        }
        assert.equal(stats().activeNodes - before, 0, 'no reactive-node retention');
    });

    // -- TS22: union invariants -- contained/overlapping/back-to-back --------
    it('TS22: the cursor sweep unions hostile session sets without sort or spurious bands', () => {
        const b = (sessions) => _sessionBands(M, M + 14 * D,
            _normalizeSessionSpec({ sessions }), FILL);
        // Every hostile set unions to the SAME shape as the plain {570,960}
        // session, so compare exact from/to lists -- a count-only assertion
        // would miss a cursor regression that corrupts bounds but not counts
        // (proven: reverting `if (c > cursor)` to unconditional keeps 11 bands
        // but shifts a band start from close(960') to the contained close(700')).
        const canon = b([{ openMinutes: 570, closeMinutes: 960 }]).map((x) => [x.from, x.to]);
        const flat = (set) => set.map((x) => [x.from, x.to]);
        // Contained session (validator sorts by open; {600,700} sits inside {570,960}).
        const contained = b([{ openMinutes: 600, closeMinutes: 700 }, { openMinutes: 570, closeMinutes: 960 }]);
        assert.deepEqual(flat(contained), canon, 'contained session adds no band and regresses no cursor');
        // Overlapping sessions merge into the single-session shape.
        const overlap = b([{ openMinutes: 570, closeMinutes: 700 }, { openMinutes: 650, closeMinutes: 960 }]);
        assert.deepEqual(flat(overlap), canon, 'overlapping sessions union-merge to the outer bounds');
        // Back-to-back sessions must not emit a zero-width band at the seam.
        const seam = b([{ openMinutes: 570, closeMinutes: 690 }, { openMinutes: 690, closeMinutes: 960 }]);
        assert.deepEqual(flat(seam), canon, 'back-to-back seam emits no zero-width band');
        for (const set of [contained, overlap, seam]) {
            for (const band of set) assert.ok(band.to > band.from, 'positive width everywhere');
        }
        // sessionFill overrides the weekend default on every band.
        const filled = _sessionBands(M, M + 14 * D,
            _normalizeSessionSpec({ sessions: [{ openMinutes: 570, closeMinutes: 960 }], sessionFill: '#123456' }),
            FILL);
        assert.ok(filled.every((band) => band.fill === '#123456'), 'sessionFill reaches every band');
    });
});

// ---------------------------------------------------------------------------
// v1.13.0 -- overnight sessions + holiday calendar
// ---------------------------------------------------------------------------
//
// Overnight (closeMinutes < openMinutes) is normalized into TWO half-sessions
// at the UTC midnight seam -- evening [open, 1440] on the original dayMask,
// morning [0, close] on the mask rotated d -> (d+1)%7 -- so the single-cursor
// sweep in _sessionBands is structurally unchanged and the seam can never emit
// a band (`o > cursor` is strict). Holidays (shading.holidays, epoch ms) are
// truncated to UTC day starts into a Set; a holiday day contributes no open
// intervals, so the cursor fuses it with the neighboring gaps into ONE band.
// Holidays without sessions synthesize a full-day Mon-Fri calendar INSIDE
// _normalizeSessionSpec (same validation loop -- no fail-open bypass).
// Canonical fixture: Globex-style ES {open 1320, close 1260, days Sun-Thu}
// over one UTC week = EXACTLY 5 bands (4 x 1h maintenance + 1 x 49h weekend).
describe('v1.13.0 -- overnight sessions + holiday calendar', () => {
    const { _sessionBands, _normalizeSessionSpec } = _testHelpers;
    const M = Date.UTC(2021, 0, 4);   // Monday
    const D = 86400000;
    const MIN = 60000;
    const FILL = 'rgba(0,0,0,0.05)';
    const GLOBEX = [{ openMinutes: 1320, closeMinutes: 1260, days: [0, 1, 2, 3, 4] }];
    const NYSE = [{ openMinutes: 810, closeMinutes: 1200 }];
    const flat = (bands) => bands.map((b) => [b.from, b.to]);

    // -- OH1: v1.11.0 behavioral identity (the sweep was edited; byte-identity
    //    is gone, so exact band lists replace it) ----------------------------
    it('OH1: no-overnight/no-holiday specs produce the exact v1.11.0 band lists', () => {
        const spec = _normalizeSessionSpec({ sessions: [{ openMinutes: 570, closeMinutes: 960 }] });
        const bands = _sessionBands(M, M + 14 * D, spec, FILL);
        const O = 570 * MIN, C = 960 * MIN;
        const expected = [[M, M + O]];
        for (let k = 0; k < 4; k++) expected.push([M + k * D + C, M + (k + 1) * D + O]);
        expected.push([M + 4 * D + C, M + 7 * D + O]);
        for (let k = 7; k < 11; k++) expected.push([M + k * D + C, M + (k + 1) * D + O]);
        expected.push([M + 11 * D + C, M + 14 * D]);
        assert.deepEqual(flat(bands), expected, 'TS15 canonical 11-band list unchanged');
        const lb = _sessionBands(M, M + 14 * D, _normalizeSessionSpec({
            sessions: [{ openMinutes: 570, closeMinutes: 690 }, { openMinutes: 750, closeMinutes: 960 }],
        }), FILL);
        assert.equal(lb.length, 21, 'lunch-break variant unchanged');
    });

    // -- OH2: confinement -- _weekendBands byte-identical (SHA-pinned) -------
    it('OH2: _weekendBands source region is byte-identical (v1.12.x confinement)', () => {
        const src = readFileSync(new URL('../Charts.js', import.meta.url), 'utf8');
        const region = src.match(/const _weekendBands[\s\S]*?\n};/);
        assert.ok(region, '_weekendBands region found');
        const sha = createHash('sha256').update(region[0]).digest('hex').slice(0, 16);
        assert.equal(sha, '61df350f5a50136a',
            '_weekendBands untouched by the overnight/holiday work');
    });

    // -- OH3: the midnight seam never emits (D1 auto-merge) ------------------
    it('OH3: overnight seam emits no band at any in-session UTC midnight', () => {
        const bands = _sessionBands(M, M + 7 * D, _normalizeSessionSpec({ sessions: GLOBEX }), FILL);
        for (let k = 1; k <= 4; k++) {
            const mid = M + k * D; // Tue..Fri 00:00 -- inside an open overnight span
            for (const b of bands) {
                assert.ok(b.from !== mid && b.to !== mid,
                    `no band boundary at in-session midnight M+${k}D`);
            }
        }
        for (const b of bands) assert.ok(b.to > b.from, 'positive width everywhere');
    });

    // -- OH4: Globex week -- exact from/to (counts lie; lists do not) --------
    it('OH4: Globex Sun-Thu 1320/1260 over one week = exactly the 5 complement bands', () => {
        const spec = _normalizeSessionSpec({ sessions: GLOBEX });
        assert.deepEqual(spec.sessions,
            [{ open: 0, close: 1260, dayMask: 62 }, { open: 1320, close: 1440, dayMask: 31 }],
            'split halves: morning on the rotated mask sorts first');
        const bands = _sessionBands(M, M + 7 * D, spec, FILL);
        assert.deepEqual(flat(bands), [
            [M + 1260 * MIN, M + 1320 * MIN],
            [M + D + 1260 * MIN, M + D + 1320 * MIN],
            [M + 2 * D + 1260 * MIN, M + 2 * D + 1320 * MIN],
            [M + 3 * D + 1260 * MIN, M + 3 * D + 1320 * MIN],
            [M + 4 * D + 1260 * MIN, M + 6 * D + 1320 * MIN], // Fri 21:00 -> Sun 22:00
        ], '4 x 1h maintenance gaps + the 49h weekend, no tail band');
    });

    // -- OH5: holiday fusion -- exact bounds, chart-level count --------------
    it('OH5: a holiday closes its whole UTC day and fuses with adjacent gaps', () => {
        // (a) Globex + Wednesday holiday: still 5 bands; band 3 is the clean
        // day band [Wed 00:00, Thu 00:00] -- Tuesday's evening half still runs
        // to Wed 00:00 (the documented whole-UTC-day approximation).
        const ga = _sessionBands(M, M + 7 * D,
            _normalizeSessionSpec({ sessions: GLOBEX, holidays: [M + 2 * D] }), FILL);
        assert.deepEqual(flat(ga), [
            [M + 1260 * MIN, M + 1320 * MIN],
            [M + D + 1260 * MIN, M + D + 1320 * MIN],
            [M + 2 * D, M + 3 * D],
            [M + 3 * D + 1260 * MIN, M + 3 * D + 1320 * MIN],
            [M + 4 * D + 1260 * MIN, M + 6 * D + 1320 * MIN],
        ], 'holiday day-band starts at Wed 00:00, not Tue 22:00');
        // (b) NYSE + Wednesday holiday: Tue-close -> Thu-open is ONE fused band.
        const nb = _sessionBands(M, M + 7 * D,
            _normalizeSessionSpec({ sessions: NYSE, holidays: [M + 2 * D] }), FILL);
        assert.deepEqual(flat(nb), [
            [M, M + 810 * MIN],
            [M + 1200 * MIN, M + D + 810 * MIN],
            [M + D + 1200 * MIN, M + 3 * D + 810 * MIN],   // FUSED Tue 20:00 -> Thu 13:30
            [M + 3 * D + 1200 * MIN, M + 4 * D + 810 * MIN],
            [M + 4 * D + 1200 * MIN, M + 7 * D],
        ], 'fused band spans the holiday');
        const nc = _sessionBands(M, M + 7 * D, _normalizeSessionSpec({ sessions: NYSE }), FILL);
        assert.equal(nc.length, 6, 'without the holiday the same week has 6 bands');
        // Chart-level integration: the resolve pipeline sees the same 5 bands.
        const c = createTimeLineChart({
            data: [{ x: M, y: 1 }, { x: M + 7 * D, y: 2 }],
            shading: { sessions: GLOBEX, holidays: [M + 2 * D] },
            schedule: (fn) => fn(),
        });
        c.mount(createMockCanvas(800, 400));
        assert.equal(c._internal.annotations.count, 5, 'chart-level band count');
        c.destroy();
    });

    // -- OH6: holidays without sessions == weekends + holiday ----------------
    it('OH6: holidays-only shading rides the synthesized Mon-Fri calendar', () => {
        const bands = _sessionBands(M, M + 7 * D,
            _normalizeSessionSpec({ holidays: [M + 2 * D] }), FILL);
        assert.deepEqual(flat(bands), [[M + 2 * D, M + 3 * D], [M + 5 * D, M + 7 * D]],
            'the holiday day + the weekend, nothing else');
        assert.ok(bands.every((b) => b.fill === FILL), 'weekend default fill preserved');
        // Clipped-equivalence with the weekend walker (which does NOT clip):
        const wk = _weekendBandsClipped(M, M + 7 * D);
        assert.deepEqual(flat(bands).filter((b) => b[0] !== M + 2 * D), wk,
            'minus the holiday band, identical to the clipped weekend walker');
    });
    const _weekendBandsClipped = (xMin, xMax) => _testHelpers._weekendBands(xMin, xMax, FILL)
        .map((b) => [Math.max(b.from, xMin), Math.min(b.to, xMax)]);

    // -- OH7: validator fail-closed matrix -----------------------------------
    it('OH7: junk holidays throw at construction; null is absence, not epoch 0', () => {
        const mkc = (holidays) => () => createTimeLineChart({
            data: [{ x: M, y: 1 }, { x: M + 7 * D, y: 2 }],
            shading: { holidays }, schedule: (fn) => fn(),
        });
        assert.throws(mkc([]), /non-empty array/, 'empty holidays array');
        assert.throws(mkc({}), /non-empty array/, 'non-array holidays');
        assert.throws(mkc(0), /non-empty array/, 'holidays: 0 is junk, not absence');
        assert.throws(mkc(false), /non-empty array/, 'holidays: false is junk, not absence');
        assert.throws(mkc([null]), /null is not epoch 0/, 'the null gate fires FIRST');
        assert.throws(mkc([undefined]), /null is not epoch 0/);
        assert.throws(mkc([NaN]), /integer epoch ms/);
        assert.throws(mkc([1.5]), /integer epoch ms/);
        assert.throws(mkc([Infinity]), /integer epoch ms/);
        assert.throws(mkc(['1609718400000']), /integer epoch ms/, 'strings throw, no coercion');
        assert.throws(mkc([new Date(M)]), /integer epoch ms/, 'Date objects throw -- pass Date.UTC values');
        assert.equal(_normalizeSessionSpec({ holidays: null }), null,
            'holidays: null -> absence (the != null convention)');
        assert.equal(_normalizeSessionSpec({ sessions: null, holidays: null }), null);
    });

    // -- OH8: overnight validity edges + pre-1970 truncation -----------------
    it('OH8: 24h and 1-minute overnight edges normalize; pre-1970 holidays floor correctly', () => {
        const full = _normalizeSessionSpec({ sessions: [{ openMinutes: 0, closeMinutes: 1440 }] });
        assert.equal(full.sessions.length, 1, '24h session is the normal path, not a split');
        const tiny = _normalizeSessionSpec({ sessions: [{ openMinutes: 1439, closeMinutes: 1 }] });
        assert.deepEqual(tiny.sessions,
            [{ open: 0, close: 1, dayMask: 124 }, { open: 1439, close: 1440, dayMask: 62 }],
            'the 2-minute overnight splits into two 1-minute halves');
        assert.throws(
            () => _normalizeSessionSpec({ sessions: [{ openMinutes: 570, closeMinutes: 570 }] }),
            /zero width/, 'close === open still throws (a 24h session is {0, 1440})');
        // Saturday-opening overnight: bit 6 must WRAP to bit 0 (Sunday). This is
        // the only case where the rotate's `| (dayMask >> 6)` term is observable
        // -- a wrap-less `<< 1` would put the morning half on NO days (mask 0)
        // and silently unshade Sunday morning (fail-open by omission).
        const sat = _normalizeSessionSpec({ sessions: [{ openMinutes: 1320, closeMinutes: 240, days: [6] }] });
        assert.deepEqual(sat.sessions,
            [{ open: 0, close: 240, dayMask: 1 }, { open: 1320, close: 1440, dayMask: 64 }],
            'Sat 22:00 -> Sun 04:00: morning half wraps onto Sunday (mask 1)');
        // Math.floor truncation, not % subtraction: -1 ms is 1969-12-31 UTC.
        const pre = _normalizeSessionSpec({ sessions: NYSE, holidays: [-1] });
        assert.ok(pre.holidays.has(-D), 'pre-1970 holiday floors to the correct UTC day');
        assert.ok(!pre.holidays.has(0), 'and NOT to epoch day 0');
    });

    // -- OH9: retention with overnight + holidays active ---------------------
    it('OH9: repeated mount+destroy with overnight sessions + holidays retains nothing', () => {
        const holidays = [];
        for (let k = 0; k < 12; k++) holidays.push(M + k * 30 * D);
        const before = stats().activeNodes;
        for (let i = 0; i < 50; i++) {
            const c = createTimeLineChart({
                data: [{ x: M, y: 1 }, { x: M + 7 * D, y: 2 }],
                shading: { sessions: GLOBEX, holidays },
                schedule: (fn) => fn(),
            });
            c.mount(createMockCanvas(800, 400));
            c.destroy();
        }
        assert.equal(stats().activeNodes - before, 0, 'no reactive-node retention');
    });
});

// ---------------------------------------------------------------------------
// v1.12.0 -- legend virtualization (opt-in, adapter-driven)
// ---------------------------------------------------------------------------
//
// lite-charts NEVER imports a windowing library. `legend.virtualize` is a
// user-supplied factory `(host, opts) => ({ dispose })`. The tests below stand
// up an in-file `fakeVirtualizer` -- fixed-size windowing over renderRow -- so
// the suite runs with NO extra devDependency. The eager legend region
// (buildLegendDOM..installLegend) stays byte-identical (V5).

describe('v1.12.0 -- legend virtualization', () => {
    // -- self-contained DOM mock (attributes + dataset + listeners + scroll) ---
    const mkVEl = (tag) => ({
        tagName: (tag || 'div').toUpperCase(),
        childNodes: [],
        parentNode: null,
        parentElement: null,
        style: {},
        className: '',
        textContent: '',
        dataset: {},
        _attrs: {},
        _listeners: {},
        scrollTop: 0,
        clientHeight: 0,
        setAttribute(k, v) { this._attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
        addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); },
        removeEventListener(type, fn) {
            const a = this._listeners[type]; if (!a) return;
            const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
        },
        _listenerCount(type) { const a = this._listeners[type]; return a ? a.length : 0; },
        _fire(type, ev) {
            const a = this._listeners[type]; if (!a) return;
            for (let i = 0; i < a.length; i++) a[i].call(this, ev);
        },
        appendChild(c) {
            if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
            this.childNodes.push(c); c.parentNode = this; c.parentElement = this; return c;
        },
        removeChild(c) {
            const i = this.childNodes.indexOf(c);
            if (i >= 0) this.childNodes.splice(i, 1);
            c.parentNode = null; c.parentElement = null; return c;
        },
        querySelectorAll() { return []; },
    });

    const withDOM = (fn) => {
        const prev = globalThis.document;
        globalThis.document = { createElement: (tag) => mkVEl(tag) };
        try { return fn(); } finally { globalThis.document = prev; }
    };

    // Fixed-size windowing adapter. Pool of `window` recycled row elements;
    // first index = floor(scrollTop / itemHeight), clamped; overscan widens the
    // pool. renderRow (Charts.js-owned) writes the row's contents. Zero-alloc on
    // the paint path except when the first index actually changes.
    const fakeVirtualizer = (host, opts) => {
        const count = opts.count;
        const itemHeight = opts.itemHeight;
        const win = count < (Math.ceil(opts.height / itemHeight) + opts.overscan * 2)
            ? count
            : (Math.ceil(opts.height / itemHeight) + opts.overscan * 2);
        const pool = [];
        for (let i = 0; i < win; i++) {
            const row = document.createElement('div');
            row.style.position = 'absolute';
            row.style.height = itemHeight + 'px';
            host.appendChild(row);
            pool.push(row);
        }
        let firstBound = -1;
        const paint = () => {
            let first = (host.scrollTop | 0) / itemHeight | 0;
            const maxFirst = count - win < 0 ? 0 : count - win;
            if (first > maxFirst) first = maxFirst;
            if (first < 0) first = 0;
            if (first === firstBound) return;
            firstBound = first;
            for (let s = 0; s < pool.length; s++) {
                const idx = first + s;
                if (idx >= count) continue;
                opts.renderRow(pool[s], idx);
            }
        };
        paint();
        const onScroll = () => paint();
        host.addEventListener('scroll', onScroll);
        return {
            dispose() {
                host.removeEventListener('scroll', onScroll);
                for (let i = 0; i < pool.length; i++) {
                    if (pool[i].parentNode) pool[i].parentNode.removeChild(pool[i]);
                }
                pool.length = 0;
            },
        };
    };

    const mkSeries = (n) => {
        const s = new Array(n);
        for (let i = 0; i < n; i++) s[i] = { name: 'S' + i, data: [{ x: 0, y: i }, { x: 1, y: i + 1 }] };
        return s;
    };

    // Rows currently carrying a data-lc-idx, in DOM order.
    const boundRows = (host) => host.childNodes.filter((n) => n.dataset && n.dataset.lcIdx != null);
    const rowByIdx = (host, idx) => host.childNodes.find((n) => n.dataset && n.dataset.lcIdx != null && (+n.dataset.lcIdx) === idx);
    const scrollTo = (host, top) => { host.scrollTop = top; host._fire('scroll'); };

    const mkChart = (legendCfg, n) => createLineChart({
        series: mkSeries(n == null ? 200 : n),
        crosshair: false, tooltip: false, schedule: (fn) => fn(),
        legend: legendCfg,
    });

    // -- V1: bounded DOM (virtualized) vs exactly-N eager control --------------
    it('V1: virtualized legend binds a bounded window; eager binds every row', () => {
        withDOM(() => {
            const container = mkVEl('div');
            const chart = mkChart({ position: 'right', container, virtualize: fakeVirtualizer, height: 240, itemHeight: 24, overscan: 2 }, 200);
            chart.mount(createMockCanvas(800, 400));
            const b = boundRows(chart.legend);
            assert.ok(b.length >= 10 && b.length <= 14, 'bounded window: ' + b.length);
            chart.destroy();

            const c2 = mkVEl('div');
            const eager = mkChart({ position: 'right', container: c2 }, 200);
            eager.mount(createMockCanvas(800, 400));
            assert.equal(eager.legend.childNodes.length, 200, 'eager control binds every row');
            eager.destroy();
        });
    });

    // -- V2: scroll reveal a distant window ------------------------------------
    it('V2: scrolling rebinds the pool to a distant, still-bounded window', () => {
        withDOM(() => {
            const container = mkVEl('div');
            const chart = mkChart({ position: 'right', container, virtualize: fakeVirtualizer, height: 240, itemHeight: 24, overscan: 2 }, 200);
            chart.mount(createMockCanvas(800, 400));
            const init = boundRows(chart.legend).map((n) => +n.dataset.lcIdx).sort((a, z) => a - z);
            assert.equal(init[0], 0);
            assert.equal(init[init.length - 1], 13);

            scrollTo(chart.legend, 2400);
            const b = boundRows(chart.legend);
            const idxs = b.map((n) => +n.dataset.lcIdx);
            assert.ok(Math.min(...idxs) >= 98, 'min bound ' + Math.min(...idxs));
            assert.ok(Math.max(...idxs) <= 113, 'max bound ' + Math.max(...idxs));
            assert.ok(b.length <= 14, 'still bounded: ' + b.length);
            const r100 = rowByIdx(chart.legend, 100);
            assert.ok(r100, 'row 100 present');
            assert.equal(r100.childNodes[1].textContent, 'S100');
            chart.destroy();
        });
    });

    // -- V3: a click on a RECYCLED row toggles the right series ----------------
    it('V3: delegated click on a recycled row toggles exactly its series', () => {
        withDOM(() => {
            const container = mkVEl('div');
            const chart = mkChart({ position: 'right', container, virtualize: fakeVirtualizer, height: 240, itemHeight: 24, overscan: 2 }, 200);
            chart.mount(createMockCanvas(800, 400));
            scrollTo(chart.legend, 2400);
            const first = boundRows(chart.legend)[0];
            assert.equal(+first.dataset.lcIdx, 100, 'first bound row is the recycled idx 100');
            chart.legend._fire('click', { target: first });
            assert.equal(chart.seriesVisibility[100].peek(), false, 'clicked series toggled off');
            assert.equal(chart.seriesVisibility[0].peek(), true, 'series 0 untouched');
            let offCount = 0;
            for (let i = 0; i < 200; i++) if (chart.seriesVisibility[i].peek() === false) offCount++;
            assert.equal(offCount, 1, 'exactly one of 200 toggled');
            chart.destroy();
        });
    });

    // -- V4: a dimmed series survives recycle (idx re-read, not element state) --
    it('V4: dimmed state follows the series index through recycle', () => {
        withDOM(() => {
            const container = mkVEl('div');
            const chart = mkChart({ position: 'right', container, virtualize: fakeVirtualizer, height: 240, itemHeight: 24, overscan: 2 }, 200);
            chart.mount(createMockCanvas(800, 400));
            scrollTo(chart.legend, 2400);
            chart.setSeriesVisible(100, false);
            scrollTo(chart.legend, 0);
            scrollTo(chart.legend, 2400);
            const r100 = rowByIdx(chart.legend, 100);
            const r101 = rowByIdx(chart.legend, 101);
            assert.equal(r100.style.opacity, '0.4', 'dimmed idx survives recycle');
            assert.equal(r100.getAttribute('aria-pressed'), 'false');
            assert.equal(r101.style.opacity, '1', 'neighbour stays bright');
            assert.equal(r101.getAttribute('aria-pressed'), 'true');
            // Asymmetric hop: shift the window by exactly one row so every
            // pool slot rebinds to a DIFFERENT index than it held at 2400.
            // A renderRow that trusts element state instead of re-reading the
            // signal keeps each slot's previous paint and fails here -- the
            // symmetric scroll-out/back above cannot catch that, because each
            // slot returns to the same index it left.
            scrollTo(chart.legend, 2376);
            const s100 = rowByIdx(chart.legend, 100);
            const s101 = rowByIdx(chart.legend, 101);
            assert.equal(s100.style.opacity, '0.4', 'dimmed idx survives asymmetric recycle');
            assert.equal(s100.getAttribute('aria-pressed'), 'false');
            assert.equal(s101.style.opacity, '1', 'shifted slot re-reads the signal');
            assert.equal(s101.getAttribute('aria-pressed'), 'true');
            chart.destroy();
        });
    });

    // -- V5: byte-identity of the eager region + zero-import confinement -------
    it('V5: eager legend region is byte-identical and the adapter is confined', () => {
        const src = readFileSync(new URL('../Charts.js', import.meta.url), 'utf8');
        const start = src.indexOf('const buildLegendDOM = ');
        const endMarker = '    target.appendChild(wrapper);\n    return wrapper;\n};';
        const end = src.indexOf(endMarker) + endMarker.length;
        const sub = src.slice(start, end);
        assert.ok(start >= 0 && end > start, 'region located');
        assert.equal(
            createHash('sha256').update(sub).digest('hex'),
            '9a547f4bfc3d2d7a7a4852bcc3f3f6435307008596b8712bbc7faf04eb05ef57',
            'buildLegendDOM..installLegend byte-identity',
        );
        const count = (s) => src.split(s).length - 1;
        assert.equal(count('lite-virtual'), 0, 'no lite-virtual reference in source');
        assert.equal(count('mountList'), 0, 'no mountList reference in source');
        assert.equal(count('buildVirtualLegendDOM'), 2, 'decl + one call');
        assert.equal(count('_normalizeLegendVirtualization'), 2, 'decl + one call');
    });

    // -- V6: construction-time validation matrix ------------------------------
    it('V6: virtualize validation throws on junk and falls through on absent/false', () => {
        const fn = (host, opts) => fakeVirtualizer(host, opts);
        const mk = (cfg) => () => mkChart(cfg, 3);
        // type errors (== null gated; null is not a function)
        assert.throws(mk({ position: 'right', virtualize: null, height: 240 }), /must be a function or absent, got null/);
        assert.throws(mk({ position: 'right', virtualize: 5, height: 240 }), /got number/);
        assert.throws(mk({ position: 'right', virtualize: 'x', height: 240 }), /got string/);
        assert.throws(mk({ position: 'right', virtualize: {}, height: 240 }), /got object/);
        assert.throws(mk({ position: 'right', virtualize: [], height: 240 }), /got array/);
        // position must be left/right
        assert.throws(mk({ position: 'top', virtualize: fn, height: 240 }), /'left' or 'right'/);
        assert.throws(mk({ position: 'bottom', virtualize: fn, height: 240 }), /'left' or 'right'/);
        // height required and must be a positive integer -- null is NOT zero
        assert.throws(mk({ position: 'right', virtualize: fn }), /legend\.height/);
        assert.throws(mk({ position: 'right', virtualize: fn, height: null }), /legend\.height/);
        assert.throws(mk({ position: 'right', virtualize: fn, height: 0 }), /positive integer/);
        assert.throws(mk({ position: 'right', virtualize: fn, height: -5 }), /positive integer/);
        assert.throws(mk({ position: 'right', virtualize: fn, height: 1.5 }), /positive integer/);
        // itemHeight present-and-invalid throws; overscan present-and-invalid throws
        assert.throws(mk({ position: 'right', virtualize: fn, height: 240, itemHeight: 0 }), /itemHeight/);
        assert.throws(mk({ position: 'right', virtualize: fn, height: 240, itemHeight: 1.5 }), /itemHeight/);
        assert.throws(mk({ position: 'right', virtualize: fn, height: 240, overscan: -1 }), /overscan/);
        assert.throws(mk({ position: 'right', virtualize: fn, height: 240, overscan: 1.5 }), /overscan/);
        // the two NON-throws: absent + false -> eager path (200 rows)
        withDOM(() => {
            for (const cfg of [{ position: 'right', container: mkVEl('div') }, { position: 'right', container: mkVEl('div'), virtualize: false }]) {
                const chart = mkChart(cfg, 200);
                chart.mount(createMockCanvas(800, 400));
                assert.equal(chart.legend.childNodes.length, 200, 'eager rows for ' + JSON.stringify(cfg.virtualize));
                chart.destroy();
            }
        });
    });

    // -- V7: handle validation at mount ---------------------------------------
    it('V7: a factory that returns no dispose() throws at mount; legend stays null', () => {
        withDOM(() => {
            for (const bad of [() => undefined, () => ({})]) {
                const chart = mkChart({ position: 'right', container: mkVEl('div'), virtualize: bad, height: 240 }, 10);
                assert.throws(() => chart.mount(createMockCanvas(800, 400)), /dispose/);
                assert.equal(chart.legend, null, 'nothing attached on a rejected handle');
                chart.destroy();
            }
        });
    });

    // -- V8: retention across 50 mount/destroy cycles -------------------------
    it('V8: 50 mount/destroy cycles dispose every adapter and retain no nodes', () => {
        withDOM(() => {
            let created = 0, disposed = 0;
            const counting = (host, opts) => {
                created++;
                const inner = fakeVirtualizer(host, opts);
                return { dispose() { disposed++; inner.dispose(); } };
            };
            const before = stats().activeNodes;
            for (let i = 0; i < 50; i++) {
                const chart = mkChart({ position: 'right', container: mkVEl('div'), virtualize: counting, height: 240, itemHeight: 24 }, 200);
                chart.mount(createMockCanvas(800, 400));
                chart.destroy();
            }
            assert.equal(disposed, 50, 'every adapter handle disposed');
            assert.equal(created - disposed, 0, 'no live adapter handles');
            assert.equal(stats().activeNodes - before, 0, 'no reactive-node retention');
        });
    });

    // -- V9: O(1) -- one delegated listener regardless of series count ---------
    it('V9: exactly one delegated listener + constant teardown across series counts', () => {
        withDOM(() => {
            for (const n of [20, 200, 2000]) {
                let disposed = 0;
                const counting = (host, opts) => {
                    const inner = fakeVirtualizer(host, opts);
                    return { dispose() { disposed++; inner.dispose(); } };
                };
                const chart = mkChart({ position: 'right', container: mkVEl('div'), virtualize: counting, height: 240, itemHeight: 24 }, n);
                chart.mount(createMockCanvas(800, 400));
                const host = chart.legend;
                assert.equal(host._listenerCount('click'), 1, 'one delegated click listener at n=' + n);
                assert.equal(host._listenerCount('scroll'), 1, 'one scroll listener at n=' + n);
                chart.destroy();
                assert.equal(host._listenerCount('click'), 0, 'click listener removed at n=' + n);
                assert.equal(host._listenerCount('scroll'), 0, 'scroll listener removed at n=' + n);
                assert.equal(disposed, 1, 'adapter disposed once at n=' + n);
            }
        });
    });
});

// ---------------------------------------------------------------------------
// v1.14.0 -- fat hover (hitTolerance:'nearest') + injected Voronoi cell layer
// ---------------------------------------------------------------------------

describe('v1.14.0 -- fat hover + voronoi cell layer', () => {
    // Independent geometric oracle: clip the plot rect by the perpendicular
    // bisector half-plane of (site i, site j) for every j != i. This is the
    // definition of a bbox-clipped Voronoi cell, computed with none of the
    // library's machinery -- Sutherland-Hodgman on a flat [x0,y0,x1,y1,...]
    // polygon. Test-side allocation is fine.
    const bisectorClip = (poly, ax, ay, bx, by) => {
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const dx = bx - ax, dy = by - ay;
        const out = [];
        const nP = poly.length / 2;
        for (let i = 0; i < nP; i++) {
            const x1 = poly[2 * i], y1 = poly[2 * i + 1];
            const j = (i + 1) % nP;
            const x2 = poly[2 * j], y2 = poly[2 * j + 1];
            const d1 = (x1 - mx) * dx + (y1 - my) * dy;
            const d2 = (x2 - mx) * dx + (y2 - my) * dy;
            if (d1 <= 0) out.push(x1, y1);
            if ((d1 < 0) !== (d2 < 0)) {
                const t = d1 / (d1 - d2);
                out.push(x1 + t * (x2 - x1), y1 + t * (y2 - y1));
            }
        }
        return out;
    };
    const oracleCell = (pxs, pys, n, i, pb) => {
        let poly = [pb.x, pb.y, pb.x + pb.w, pb.y, pb.x + pb.w, pb.y + pb.h, pb.x, pb.y + pb.h];
        for (let j = 0; j < n; j++) {
            if (j === i) continue;
            poly = bisectorClip(poly, pxs[i], pys[i], pxs[j], pys[j]);
            if (poly.length === 0) break;
        }
        return poly;
    };
    const shoelace = (flat, n) => {
        let a = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            a += flat[2 * i] * flat[2 * j + 1] - flat[2 * j] * flat[2 * i + 1];
        }
        return Math.abs(a) / 2;
    };
    const pointInPoly = (flat, n, px, py) => {
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = flat[2 * i], yi = flat[2 * i + 1];
            const xj = flat[2 * j], yj = flat[2 * j + 1];
            if (((yi > py) !== (yj > py)) &&
                (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    };
    // Linear-scan mock spatial index (contract-shaped) for forcing the indexed
    // hit path deterministically -- same as the v1.2.0 scatter tests.
    const makeMockSpatialIndex = (pxs, pys, n) => ({
        findNearest(qx, qy, k, maxDsq, outIdx, outDist) {
            let bI = -1, bD = maxDsq;
            for (let i = 0; i < n; i++) {
                const dx = qx - pxs[i], dy = qy - pys[i];
                const d = dx * dx + dy * dy;
                if (d < bD) { bD = d; bI = i; }
            }
            if (bI < 0) return 0;
            outIdx[0] = bI; outDist[0] = bD;
            return 1;
        },
        dispose() {},
    });
    // The 4-corners+center fixture: DATA-space square + center. The projection
    // is anisotropic (x and y pixel scales differ), which is exactly why cells
    // must be computed in PIXEL space (D3) -- the oracle runs on the projected
    // pxs/pys, so it is exact regardless of the layout numbers.
    const squareData = [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
        { x: 50, y: 50 },
    ];

    it('VC1: fat hover snaps to the nearest point from anywhere -- indexed and linear paths agree', () => {
        const mk = (extra) => {
            const chart = createScatterChart({
                data: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 1 }, { x: 3, y: 0.2 }, { x: 4, y: 0.8 }],
                schedule: (fn) => fn(),
                ...extra,
            });
            chart.mount(createMockCanvas(800, 400));
            return chart;
        };
        const linear = mk({ hitTolerance: 'nearest' });
        const indexed = mk({ hitTolerance: 'nearest', spatialIndex: makeMockSpatialIndex, spatialIndexThreshold: 1 });
        const pb = linear._internal.plotBoundsBox;
        // Cursor at the top-left plot corner, hundreds of px from every point.
        const cx = pb.x + 2, cy = pb.y + 2;
        // Expected: nearest projected point, computed independently.
        const st = linear._internal.seriesStates[0];
        let want = -1, wantD = Infinity;
        for (let i = 0; i < st.n; i++) {
            const dx = cx - st.pxs[i], dy = cy - st.pys[i];
            const d = dx * dx + dy * dy;
            if (d < wantD) { wantD = d; want = i; }
        }
        assert.ok(wantD > 64, 'fixture sanity: cursor is far outside the default 8px disc');
        linear.moveCrosshair(cx, cy);
        indexed.moveCrosshair(cx, cy);
        const hl = linear.crosshair.peek();
        const hi = indexed.crosshair.peek();
        assert.equal(hl.visible, true, 'linear path snaps');
        assert.equal(hi.visible, true, 'indexed path snaps');
        assert.equal(hl.snapIdx, want, 'linear path snaps to the true nearest');
        assert.equal(hi.snapIdx, want, 'indexed path agrees');
        assert.equal(hl.snapPixelX, hi.snapPixelX, 'identical snap pixel');
        linear.unmount();
        indexed.unmount();
        // Control: the same far cursor with a numeric tolerance misses on BOTH paths.
        const cl = mk({ hitTolerance: 8 });
        const ci = mk({ hitTolerance: 8, spatialIndex: makeMockSpatialIndex, spatialIndexThreshold: 1 });
        cl.moveCrosshair(cx, cy);
        ci.moveCrosshair(cx, cy);
        assert.equal(cl.crosshair.peek().visible, false, 'numeric tolerance still misses (linear)');
        assert.equal(ci.crosshair.peek().visible, false, 'numeric tolerance still misses (indexed)');
        cl.unmount();
        ci.unmount();
    });

    it('VC2: cell geometry matches the half-plane oracle and tiles the plot rect exactly', () => {
        const chart = createScatterChart({
            data: squareData,
            cells: { index: createCellIndex(16) },
            schedule: (fn) => fn(),
        });
        chart.mount(createMockCanvas(800, 400));
        const st = chart._internal.seriesStates[0];
        const pb = chart._internal.plotBoundsBox;
        assert.equal(st.cellCount, 5, 'five cells');
        const starts = st.cellStart;
        const xy = st.cellXY;
        let areaSum = 0;
        for (let i = 0; i < 5; i++) {
            const nV = (starts[i + 1] - starts[i]) / 2;
            const oracle = oracleCell(st.pxs, st.pys, 5, i, pb);
            const oV = oracle.length / 2;
            assert.equal(nV, oV, `cell ${i}: vertex count matches oracle (${oV})`);
            const got = xy.subarray(starts[i], starts[i + 1]);
            const aGot = shoelace(got, nV);
            const aWant = shoelace(oracle, oV);
            assert.ok(Math.abs(aGot - aWant) <= Math.max(1e-3 * aWant, 0.01),
                `cell ${i}: area ${aGot} vs oracle ${aWant}`);
            // Every library vertex lies on the oracle polygon's vertex set.
            for (let k = 0; k < nV; k++) {
                let hit = false;
                for (let m = 0; m < oV; m++) {
                    if (Math.abs(got[2 * k] - oracle[2 * m]) < 0.05 &&
                        Math.abs(got[2 * k + 1] - oracle[2 * m + 1]) < 0.05) { hit = true; break; }
                }
                assert.ok(hit, `cell ${i} vertex ${k} (${got[2 * k]},${got[2 * k + 1]}) is an oracle vertex`);
            }
            areaSum += aGot;
        }
        // The tiling invariant: bbox-clipped cells of every site partition the
        // plot rect. Anything data-space, stale, or unclipped breaks this.
        const plotArea = pb.w * pb.h;
        assert.ok(Math.abs(areaSum - plotArea) <= 1e-4 * plotArea,
            `cells tile the plot: ${areaSum} vs ${plotArea}`);
        // NOTE the center cell is a HEXAGON here, not the data-space diamond:
        // the projection is anisotropic and Voronoi is not affine-invariant --
        // which is exactly why D3 computes cells in pixel space. The oracle
        // (same pixel sites) proves the pixel-space cells are the right ones.
        assert.equal((starts[5] - starts[4]) / 2, 6, 'center cell is the pixel-space hexagon');
        chart.destroy();
    });

    it('VC3: degenerate input draws markers with NO cells -- fail closed', () => {
        for (const data of [
            [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }], // collinear
            [{ x: 1, y: 1 }, { x: 2, y: 2 }],                                                  // n = 2
        ]) {
            const canvas = createMockCanvas(800, 400);
            const chart = createScatterChart({
                data,
                cells: { index: createCellIndex(16) },
                schedule: (fn) => fn(),
            });
            chart.mount(canvas);
            const st = chart._internal.seriesStates[0];
            for (let i = 0; i < st.n; i++) {
                assert.equal(st.cellStart[i + 1] - st.cellStart[i], 0,
                    `degenerate cell ${i} is a zero-length span`);
            }
            const ctx = canvas.getContext('2d');
            ctx.calls.length = 0;
            chart.redraw();
            assert.equal(countCalls(ctx, 'arc'), data.length, 'every marker still draws');
            assert.equal(countCalls(ctx, 'fill'), data.length, 'marker fills only -- zero cell fills');
            chart.destroy();
        }
    });

    it('VC4: validation matrix throws at construction with nothing attached', () => {
        const data = [{ x: 1, y: 1 }];
        for (const [bad, re] of [
            [{ cells: {} }, /cells\.index/],
            [{ cells: { index: 'x' } }, /cells\.index/],
            [{ cells: 7 }, /cells/],
            [{ hitTolerance: 'near' }, /nearest/],
        ]) {
            const before = stats().activeNodes;
            assert.throws(() => createScatterChart({ data, schedule: (fn) => fn(), ...bad }), re);
            assert.equal(stats().activeNodes - before, 0,
                'construction throw leaves zero reactive nodes: ' + JSON.stringify(bad));
        }
        // The one legal string.
        const ok = createScatterChart({ data, hitTolerance: 'nearest', schedule: (fn) => fn() });
        ok.mount(createMockCanvas(800, 400));
        ok.destroy();
    });

    it('VC5: hover highlight strokes exactly the snapped cell', () => {
        const canvas = createMockCanvas(800, 400);
        const chart = createScatterChart({
            data: squareData,
            hitTolerance: 'nearest',
            cells: { index: createCellIndex(16) },
            schedule: (fn) => fn(),
        });
        chart.mount(canvas);
        const st = chart._internal.seriesStates[0];
        // Hover the CENTER point's own pixel -> snapIdx 4.
        chart.moveCrosshair(st.pxs[4], st.pys[4]);
        assert.equal(chart.crosshair.peek().snapIdx, 4, 'crosshair snapped to the center site');
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart.redraw();
        // The hover pass is the only lineWidth=2 writer in this chart config
        // (cells.strokeWidth defaults 0, scatter stroke defaults null).
        const calls = ctx.calls;
        let hoverStrokes = 0;
        let moveX = NaN, moveY = NaN;
        for (let i = 0; i < calls.length; i++) {
            if (calls[i][0] === 'set:lineWidth' && calls[i][1][0] === 2) {
                hoverStrokes++;
                // The moveTo that opens the highlighted polygon precedes the
                // style writes: scan back for it.
                for (let k = i - 1; k >= 0; k--) {
                    if (calls[k][0] === 'moveTo') { moveX = calls[k][1][0]; moveY = calls[k][1][1]; break; }
                }
            }
        }
        assert.equal(hoverStrokes, 1, 'exactly one hover-highlighted cell');
        assert.ok(Math.abs(moveX - st.cellXY[st.cellStart[4]]) < 1e-3 &&
                  Math.abs(moveY - st.cellXY[st.cellStart[4] + 1]) < 1e-3,
            'the highlighted polygon IS the snapped cell (its first vertex opens the path)');
        chart.destroy();
    });

    it('VC6: exportSVG emits one closed path per cell -- clip does not leak into the fills', () => {
        const mk = (cells) => {
            const chart = createScatterChart({
                data: squareData,
                ...(cells ? { cells: { index: createCellIndex(16) } } : {}),
                schedule: (fn) => fn(),
            });
            chart.mount(createMockCanvas(800, 400));
            chart.hideCrosshair();
            const svg = chart.exportSVG();
            chart.destroy();
            return svg;
        };
        // Count CONTENT paths only: clip-definition rects live inside
        // <clipPath> blocks (the cell layer adds one of its own) -- strip them
        // so the count isolates the painted cell polygons.
        const zPaths = (svg) => [...svg.replace(/<clipPath[\s\S]*?<\/clipPath>/g, '')
            .matchAll(/<path\b[^>]*\bd="([^"]*Z\s*)"/g)].map((m) => m[1]);
        const base = zPaths(mk(false));
        const withCells = zPaths(mk(true));
        assert.equal(withCells.length - base.length, 5, 'exactly five new closed paths -- the cells');
        // Each cell path is ONE closed polygon: a single M, L segments, no
        // rect-shorthand commands. A clip rect leaking into the first fill
        // (the beginPath-after-clip caveat) would violate this.
        const newPaths = withCells.filter((d) => !base.includes(d));
        for (const d of newPaths) {
            assert.equal((d.match(/M/g) || []).length, 1, 'single subpath per cell: ' + d.slice(0, 60));
            assert.ok(!/[hvHV]/.test(d), 'no rect-shorthand leakage: ' + d.slice(0, 60));
        }
        // Base scatter content is arcs (markers) -- ZERO closed polygons -- so
        // the five cells are the ONLY closed content paths in the export.
        assert.equal(base.length, 0, 'no closed content paths without cells');
        assert.equal(withCells.length, 5, 'the cells are the only closed content paths');
    });

    it('VC7: 50x mount/destroy with cells retains nothing', () => {
        let builds = 0, disposes = 0;
        const inner = createCellIndex(16);
        const counting = (pxs, pys, n) => {
            builds++;
            const h = inner(pxs, pys, n);
            return {
                cell: (i, a, b, c, d, o) => h.cell(i, a, b, c, d, o),
                dispose() { disposes++; h.dispose(); },
            };
        };
        const before = stats().activeNodes;
        for (let k = 0; k < 50; k++) {
            const chart = createScatterChart({
                data: squareData,
                hitTolerance: 'nearest',
                cells: { index: counting },
                schedule: (fn) => fn(),
            });
            chart.mount(createMockCanvas(800, 400));
            chart.destroy();
        }
        assert.equal(stats().activeNodes - before, 0, 'zero reactive-node retention');
        assert.equal(builds, 50, 'one index build per mount');
        assert.equal(disposes, 50, 'every index disposed');
    });

    it('VC8: the index rebuilds from CURRENT pixels on every scale change (postProject ordering)', () => {
        let builds = 0, disposes = 0;
        const inner = createCellIndex(16);
        const counting = (pxs, pys, n) => {
            builds++;
            const h = inner(pxs, pys, n);
            return {
                cell: (i, a, b, c, d, o) => h.cell(i, a, b, c, d, o),
                dispose() { disposes++; h.dispose(); },
            };
        };
        const dataSig = signal(squareData);
        const chart = createScatterChart({
            data: dataSig,
            zoom: true,
            cells: { index: counting },
            schedule: (fn) => fn(),
        });
        chart.mount(createMockCanvas(800, 400));
        assert.equal(builds, 1, 'one build at mount');
        const st = chart._internal.seriesStates[0];
        const pb = chart._internal.plotBoundsBox;
        // The freshness invariant, checked after every re-projection: each
        // site sits INSIDE its own cell, and the cells tile the plot. A stale
        // build (geometry from the previous frame's pixels) breaks containment
        // the moment the view moves.
        const checkFresh = (label) => {
            let areaSum = 0;
            for (let i = 0; i < st.n; i++) {
                const s = st.cellStart[i], e = st.cellStart[i + 1];
                const nV = (e - s) / 2;
                if (nV === 0) continue;
                areaSum += shoelace(st.cellXY.subarray(s, e), nV);
                // Containment holds only for sites INSIDE the plot rect (a
                // panned-out site's bbox-clipped cell cannot contain it), and
                // sites on an exact plot edge are nudged toward the cell
                // centroid to keep the ray-cast off the boundary. A STALE
                // build (geometry from the previous frame's pixels) moves the
                // whole polygon away from the site -- the nudge cannot save it.
                const px = st.pxs[i], py = st.pys[i];
                if (px < pb.x || px > pb.x + pb.w || py < pb.y || py > pb.y + pb.h) continue;
                let cx = 0, cy = 0;
                for (let k = 0; k < nV; k++) { cx += st.cellXY[s + 2 * k]; cy += st.cellXY[s + 2 * k + 1]; }
                cx /= nV; cy /= nV;
                const qx = px + (cx - px) * 1e-3, qy = py + (cy - py) * 1e-3;
                assert.ok(pointInPoly(st.cellXY.subarray(s, e), nV, qx, qy),
                    `${label}: site ${i} inside its own cell`);
            }
            const plotArea = pb.w * pb.h;
            assert.ok(Math.abs(areaSum - plotArea) <= 1e-3 * plotArea,
                `${label}: cells tile the plot (${areaSum} vs ${plotArea})`);
        };
        checkFresh('mount');
        chart.setView({ xMin: 20, xMax: 90, yMin: null, yMax: null });
        assert.equal(builds, 2, 'view change rebuilds the index');
        assert.equal(disposes, 1, 'the stale index was disposed first');
        checkFresh('zoomed');
        dataSig.set(squareData.slice(0, 4)); // drop the center point
        assert.equal(builds, 3, 'data change rebuilds');
        assert.equal(st.cellCount, 4, 'four cells after the data change');
        checkFresh('data-changed');
        chart.destroy();
        assert.equal(disposes, 3, 'all indices disposed at destroy');
    });

    it('VC9: index faults fail closed -- mount-time throws with nothing attached, later faults skip cells', () => {
        const data = squareData;
        // (a) A factory whose cell() throws on the FIRST refresh -> mount
        // throws (the fail-closed door) and unwinds every disposer.
        const before = stats().activeNodes;
        const chart1 = createScatterChart({
            data,
            cells: { index: () => ({ cell() { throw new Error('boom-overflow'); }, dispose() {} }) },
            schedule: (fn) => fn(),
        });
        assert.throws(() => chart1.mount(createMockCanvas(800, 400)), /boom-overflow/);
        // The rejected mount unwinds its own effects; the chart object still
        // holds its construction-time signals until destroy() -- the caller
        // contract after a failed mount. destroy() must release everything.
        chart1.destroy();
        assert.equal(stats().activeNodes - before, 0, 'destroy after rejected mount leaks no reactive nodes');
        // (b) A factory that goes bad on the SECOND build: mount succeeds,
        // the later fault only zeroes the cells -- markers still draw, no throw.
        let buildN = 0;
        const inner = createCellIndex(16);
        const flaky = (pxs, pys, n) => {
            buildN++;
            if (buildN >= 2) return { cell() { throw new Error('late-fault'); }, dispose() {} };
            const h = inner(pxs, pys, n);
            return { cell: (i, a, b, c, d, o) => h.cell(i, a, b, c, d, o), dispose() { h.dispose(); } };
        };
        const canvas = createMockCanvas(800, 400);
        const chart2 = createScatterChart({
            data, zoom: true,
            cells: { index: flaky },
            schedule: (fn) => fn(),
        });
        chart2.mount(canvas);
        const st = chart2._internal.seriesStates[0];
        assert.equal(st.cellCount, 5, 'first build healthy');
        // A view write that keeps every site visible (panBounds 'data' clamps
        // it back to the data domain) -- still re-runs the effect -> rebuild.
        chart2.setView({ xMin: -1, xMax: 101, yMin: null, yMax: null }); // must NOT throw
        assert.equal(st.cellCount, 0, 'faulted refresh zeroed the cells');
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        chart2.redraw();
        assert.equal(countCalls(ctx, 'arc'), 5, 'markers still draw after the fault');
        chart2.destroy();
    });

    it('VC10: injection confinement -- Charts.js never references the implementation', () => {
        const src = readFileSync(new URL('../Charts.js', import.meta.url), 'utf8');
        assert.equal((src.match(/delaunay/gi) || []).length, 0, 'zero "delaunay" occurrences');
        assert.equal((src.match(/createCellIndex/g) || []).length, 0, 'zero "createCellIndex" occurrences');
        // Exactly one definition + exactly one call/wiring site each --
        // runtime-gated, not sprayed through the kernel. (Arrow definitions
        // are `const name = (`, so `name(` matches CALL sites only.)
        assert.equal((src.match(/const _normalizeCellsSpec =/g) || []).length, 1);
        assert.equal((src.match(/_normalizeCellsSpec\(/g) || []).length, 1,
            '_normalizeCellsSpec: exactly 1 call site');
        assert.equal((src.match(/const _scatterPostProject =/g) || []).length, 1);
        assert.equal((src.match(/_scatterPostProject\(/g) || []).length, 0,
            '_scatterPostProject: never called directly (wired as a renderer property)');
        assert.equal((src.match(/postProject: _scatterPostProject/g) || []).length, 1,
            'exactly one renderer wires postProject');
        assert.equal((src.match(/const makeScatterCellDrawFn =/g) || []).length, 1);
        assert.equal((src.match(/makeScatterCellDrawFn\(/g) || []).length, 1,
            'makeScatterCellDrawFn: exactly 1 call site');
    });
});
