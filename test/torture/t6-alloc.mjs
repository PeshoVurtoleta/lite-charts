/**
 * T6 -- the zero-alloc gate. The package's headline claim ("zero allocations in
 * steady-state render") made measurable.
 *
 * Four hot loops are gated at maxMajor:0 / maxPauseMs:4 / maxArrayBuffersGrowth:0
 * with `stabilize:'deep'`. The last rule is the one that matters: the chart's
 * pooled Float32Arrays are ArrayBuffer backing stores, which live OUTSIDE the V8
 * heap and are invisible to a `heapUsed` delta (the hand-rolled harness the
 * package shipped with could not see them at all). A heap gate cannot substitute
 * for a direct structural assertion either, so we also pin the pixel-pool
 * `byteLength` across each window: nothing may grow.
 *
 *   1. pure kernel     -- decimateMinMax + updateLinearScale into pre-sized pools
 *   2. redraw          -- a mounted chart re-issuing its draw effects
 *   3. pointer storm   -- pointermove (pan) + wheel (zoom) events, interleaved
 *
 * `stabilize:'deep'` is expensive per window, so the interactive paths share one
 * gate rather than one each; a per-hit pool allocation in either shows up all the
 * same.
 *
 * SCOPE: these measure the library's allocations, not the host Canvas2D renderer
 * (the mock context records calls and allocates nothing a real driver would).
 *
 * CHARTS_TORTURE_BREAK=1 injects a retained allocation into loop 1: the gate must
 * then reject the window. That is the T9 control, exercisable from here so a
 * plain `npm run torture` already proves the gate bites.
 */

import { _testHelpers, createLineChart } from '../../Charts.js';
import {
    createEventCanvas, quietCanvas, fireShared, runOpsGate, allocFailMsg,
    BREAK, check, die,
} from './harness.mjs';

const { decimateMinMax, makeLinearScale, updateLinearScale } = _testHelpers;

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

function mountedLine(n, opts) {
    const data = new Array(n);
    for (let i = 0; i < n; i++) data[i] = { x: i, y: Math.sin(i / 20) * 50 + Math.cos(i / 7) * 10 };
    const chart = createLineChart({ data, x: 'x', y: 'y', schedule: (fn) => fn(), ...opts });
    const canvas = createEventCanvas(800, 400);
    chart.mount(canvas);
    quietCanvas(canvas);
    return { chart, canvas };
}

export function run() {
    // --- 1. pure kernel: decimate + scale update, into pre-sized pools --------
    {
        const N = 1024, cols = 512;
        const pxs = new Float32Array(N), pys = new Float32Array(N);
        for (let i = 0; i < N; i++) { pxs[i] = (i * 131) % cols; pys[i] = Math.sin(i / 10) * 100; }
        const oMin = new Float32Array(cols), oMax = new Float32Array(cols), oOcc = new Uint8Array(cols);
        const s = makeLinearScale('linear');
        const hot = () => {
            updateLinearScale(s, -100, 100, 0, 800);
            decimateMinMax(pxs, pys, N, 0, cols - 1, oMin, oMax, oOcc);
            if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
        };
        const bufBefore = oMin.buffer.byteLength;
        const { report, summary } = runOpsGate(hot, { ops: 20000, warmup: 1000 });
        check(oMin.buffer.byteLength === bufBefore,
            () => `T6.kernel: decimation pool grew ${bufBefore} -> ${oMin.buffer.byteLength}`);
        if (!report.ok) {
            die(allocFailMsg('T6.kernel', report, summary) +
                (BREAK ? ' (CHARTS_TORTURE_BREAK control -- expected)' : ''));
        }
        // In BREAK mode the gate was SUPPOSED to reject; reaching here is a fault.
        if (BREAK) die('T6: CHARTS_TORTURE_BREAK injected allocations but the kernel gate passed');
    }

    // --- 2. redraw: a mounted chart re-issuing its draw effects ----------------
    {
        const { chart, canvas } = mountedLine(2000);
        const pool = chart._internal.seriesStates[0].pxs;
        const poolBefore = pool.buffer.byteLength;
        const hot = () => { chart.redraw(); };
        const { report, summary } = runOpsGate(hot, { ops: 4000, warmup: 300 });
        check(chart._internal.seriesStates[0].pxs.buffer.byteLength === poolBefore,
            () => `T6.redraw: pixel pool grew ${poolBefore} -> ${chart._internal.seriesStates[0].pxs.buffer.byteLength}`);
        if (!report.ok) die(allocFailMsg('T6.redraw', report, summary));
        void canvas;
        chart.destroy();
    }

    // --- 3. pointer storm: pan (pointermove) + zoom (wheel), interleaved -------
    {
        const { chart, canvas } = mountedLine(2000, { pan: true, zoom: true });
        fireShared(canvas, 'pointerdown', 400, 200);
        const hot = (i) => {
            fireShared(canvas, 'pointermove', 400 - (i % 120), 200 + (i % 60));
            if ((i & 7) === 0) fireShared(canvas, 'wheel', 400, 200, { deltaY: (i & 8) ? 120 : -120 });
        };
        const { report, summary } = runOpsGate(hot, { ops: 16000, warmup: 1000 });
        fireShared(canvas, 'pointerup', 300, 220);
        if (!report.ok) die(allocFailMsg('T6.pointer-storm', report, summary));
        chart.destroy();
    }
}
