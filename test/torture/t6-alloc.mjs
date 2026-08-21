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

import { _testHelpers, createLineChart, createDonutChart, createBarChart } from '../../Charts.js';
import { signal } from '@zakkster/lite-signal';
import {
    createEventCanvas, quietCanvas, fireShared, runOpsGate, allocFailMsg,
    installCenterLabelDOM, BREAK, check, die,
} from './harness.mjs';

const {
    decimateMinMax, makeLinearScale, updateLinearScale,
    makeLogScale, updateLogScale, scaleSeriesToPixels,
} = _testHelpers;

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

    // --- 4. centerLabel redraw budget (A7) + text-write budget (A8) -----------
    // A7: a mounted donut WITH centerLabel re-issuing draws allocates no more
    // than the SAME donut WITHOUT it -- the overlay is not on the draw path.
    // A8: a text-signal write drives the cold DOM update; it must stay within a
    // small per-op budget. Both keep maxMajor:0.
    {
        const dom = installCenterLabelDOM();
        try {
            // A7 -- redraw with the label mounted vs. a plain donut.
            const withCL = createDonutChart({
                data: [{ value: 1 }, { value: 2 }], width: 400, height: 400,
                centerLabel: { text: () => '1234' }, legend: false, schedule: (fn) => fn(),
            });
            const h1 = dom.canvasInContainer(400, 400);
            withCL.mount(h1.canvas);
            quietCanvas(h1.canvas);

            const plain = createDonutChart({
                data: [{ value: 1 }, { value: 2 }], width: 400, height: 400,
                legend: false, schedule: (fn) => fn(),
            });
            const h2 = dom.canvasInContainer(400, 400);
            plain.mount(h2.canvas);
            quietCanvas(h2.canvas);

            // 50k-op window: at 10k the fixed heapUsed sampling quantum (~15 KB)
            // dominates bytesPerOp -- even a NO-LABEL donut floats to 2-4 B/op
            // there, so an absolute 1 B/op floor gates sampling noise, not the
            // label. A larger window amortizes the quantum below 1 B/op.
            const gCL = runOpsGate(() => { withCL.redraw(); }, { ops: 50000, warmup: 500 });
            const gPlain = runOpsGate(() => { plain.redraw(); }, { ops: 50000, warmup: 500 });
            if (!gCL.report.ok) die(allocFailMsg('A7.redraw', gCL.report, gCL.summary));
            check(gCL.summary.gc.maxMs <= 2.0,
                () => `A7: redraw pause ${gCL.summary.gc.maxMs.toFixed(3)}ms > 2.0`);
            // The structural zero-alloc proof is report.ok (maxMajor:0 /
            // maxArrayBuffersGrowth:0) -- the same gate the plain-redraw loop
            // above trusts. The label-SPECIFIC claim -- the overlay is not on the
            // draw path -- is the differential: a labelled redraw costs the same
            // as an unlabelled one within sampling noise. A loose absolute ceiling
            // still catches a gross per-frame regression (a real one would be
            // tens-to-hundreds of B/op, far above the sub-1 B/op noise floor).
            check(gCL.bytesPerOp <= 16.0,
                () => `A7: centerLabel redraw allocated ${gCL.bytesPerOp.toFixed(3)} B/op > 16`);
            check(Math.abs(gCL.bytesPerOp - gPlain.bytesPerOp) <= 2.0,
                () => `A7: label redraw ${gCL.bytesPerOp.toFixed(3)} B/op vs plain ${gPlain.bytesPerOp.toFixed(3)} B/op (delta > 2.0)`);
            withCL.destroy();
            plain.destroy();

            // A8 -- text-signal write budget. Each write fires Effect 5 -> the
            // cold DOM writer (four setProperty + textContent). <=512 B/op.
            const text = signal('1');
            const upd = createDonutChart({
                data: [{ value: 1 }, { value: 2 }], width: 400, height: 400,
                centerLabel: { text }, legend: false, schedule: (fn) => fn(),
            });
            const h3 = dom.canvasInContainer(400, 400);
            upd.mount(h3.canvas);
            quietCanvas(h3.canvas);
            const gUpd = runOpsGate((i) => { text.set(String(i & 1023)); }, { ops: 4096, warmup: 256 });
            if (!gUpd.report.ok) die(allocFailMsg('A8.text-write', gUpd.report, gUpd.summary));
            check(gUpd.bytesPerOp <= 512,
                () => `A8: text-write allocated ${gUpd.bytesPerOp} B/op > 512`);
            upd.destroy();
        } finally {
            dom.uninstall();
        }
    }

    // --- 5. horizontal bar redraw budget (A12) --------------------------------
    // A horizontal-bar redraw must allocate no more than the vertical one on the
    // identical dataset -- makeHBarDrawFn is a peer of makeBarDrawFn with the same
    // scalar-only profile. 50k-op window amortizes the fixed heapUsed sampling
    // quantum (see A7); the structural proof is report.ok, the orientation-
    // specific claim is the vertical/horizontal differential.
    {
        const mk = (horizontal) => {
            const c = createBarChart({
                series: [
                    { name: 'a', data: Array.from({ length: 100 }, (_, i) => ({ x: 'c' + i, y: (i % 13) - 6 })) },
                    { name: 'b', data: Array.from({ length: 100 }, (_, i) => ({ x: 'c' + i, y: (i % 5) + 1 })) },
                    { name: 'd', data: Array.from({ length: 100 }, (_, i) => ({ x: 'c' + i, y: (i % 8) })) },
                ],
                width: 600, height: 400, orientation: horizontal ? 'horizontal' : 'vertical',
                cornerRadius: 4, hoverTint: 'rgba(255,255,255,0.2)', schedule: (fn) => fn(),
            });
            const cv = createEventCanvas(600, 400);
            c.mount(cv);
            quietCanvas(cv);
            return c;
        };
        const hz = mk(true), vt = mk(false);
        const gH = runOpsGate(() => { hz.redraw(); }, { ops: 50000, warmup: 500 });
        const gV = runOpsGate(() => { vt.redraw(); }, { ops: 50000, warmup: 500 });
        if (!gH.report.ok) die(allocFailMsg('A12.hbar-redraw', gH.report, gH.summary));
        check(gH.bytesPerOp <= 16.0,
            () => `A12: horizontal redraw allocated ${gH.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gH.bytesPerOp - gV.bytesPerOp) <= 2.0,
            () => `A12: horizontal ${gH.bytesPerOp.toFixed(3)} B/op vs vertical ${gV.bytesPerOp.toFixed(3)} B/op (delta > 2.0)`);
        hz.destroy();
        vt.destroy();
    }

    // --- 6. y-log projection-loop budget (A13, v1.5.1) ------------------------
    // scaleSeriesToPixels is now log-aware: a log axis takes a Math.log branch
    // with no per-iteration type test and no allocation. This gate runs THAT loop
    // directly -- the same pure-kernel shape as section 1's decimateMinMax gate --
    // because it is the only way to bound the projection cost itself: `redraw()`
    // never re-projects (it just marks the scene dirty), and driving re-projection
    // through the reactive Effect 2 drags in that effect's own per-run allocation
    // (a `niceYDomain` [lo,hi] array), which swamps the branch cost in sampling
    // noise. Called with real domain-spanning positive data and pre-sized pools,
    // the op fn allocates nothing at the harness level, so the absolute <=16 B/op
    // ceiling and maxMajor:0 bound the projection loop, not harness garbage.
    //
    // The LINEAR-y projection (linear-linear branch) is driven by the IDENTICAL
    // call on the SAME data with a linear y-scale, so any fixed overhead cancels
    // and the differential isolates the log branch's cost. Structural proof is
    // report.ok (maxMajor:0 / maxArrayBuffersGrowth:0) plus a pixel-pool
    // byteLength pin; the log-SPECIFIC claim is the <=2.0 B/op differential (the
    // same shape as A7/A12).
    {
        const N = 2000;
        const xs = new Float32Array(N);
        const ys = new Float32Array(N);
        // y in [1, 1000]: three decades, strictly positive so the log branch takes
        // the Math.log path for every sample (never the NaN guard).
        for (let i = 0; i < N; i++) {
            xs[i] = i;
            ys[i] = (Math.sin(i / 20) * 0.5 + 0.5) * 990 + 1;
        }
        const state = { xs, ys, n: N, pxs: new Float32Array(N), pys: new Float32Array(N) };
        const xLin = updateLinearScale(makeLinearScale('linear'), 0, N, 56, 776);
        const yLog = updateLogScale(makeLogScale(), 1, 1000, 400, 0);
        const yLin = updateLinearScale(makeLinearScale('linear'), 1, 1000, 400, 0);
        const poolBefore = state.pys.buffer.byteLength;
        const hotLog = () => { scaleSeriesToPixels(state, xLin, yLog); };
        const hotLin = () => { scaleSeriesToPixels(state, xLin, yLin); };
        const gLog = runOpsGate(hotLog, { ops: 40000, warmup: 1000 });
        const gLin = runOpsGate(hotLin, { ops: 40000, warmup: 1000 });
        check(state.pys.buffer.byteLength === poolBefore,
            () => `A13: y-log pixel pool grew ${poolBefore} -> ${state.pys.buffer.byteLength}`);
        if (!gLog.report.ok) die(allocFailMsg('A13.ylog-project', gLog.report, gLog.summary));
        check(gLog.bytesPerOp <= 16.0,
            () => `A13: y-log projection allocated ${gLog.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gLog.bytesPerOp - gLin.bytesPerOp) <= 2.0,
            () => `A13: y-log ${gLog.bytesPerOp.toFixed(3)} B/op vs linear-y ${gLin.bytesPerOp.toFixed(3)} B/op (delta > 2.0)`);

        // v1.6.0: the MIRROR hot body -- (xLog && !yLog). x-log is a distinct
        // branch in scaleSeriesToPixels from y-log; now that x-log is a user-
        // facing scale it gets the same absolute <=16 B/op + differential-vs-
        // linear-x proof. x in [1, 1000]: three positive decades, so the log-x
        // branch takes the Math.log path every sample (never the NaN guard).
        const xsPos = new Float32Array(N);
        for (let i = 0; i < N; i++) xsPos[i] = (i / N) * 999 + 1;
        const stateX = { xs: xsPos, ys, n: N, pxs: new Float32Array(N), pys: new Float32Array(N) };
        const xLog = updateLogScale(makeLogScale(), 1, 1000, 56, 776);
        const xLinPos = updateLinearScale(makeLinearScale('linear'), 1, 1000, 56, 776);
        const poolBeforeX = stateX.pxs.buffer.byteLength;
        const hotXLog = () => { scaleSeriesToPixels(stateX, xLog, yLin); };
        const hotXLin = () => { scaleSeriesToPixels(stateX, xLinPos, yLin); };
        const gXLog = runOpsGate(hotXLog, { ops: 40000, warmup: 1000 });
        const gXLin = runOpsGate(hotXLin, { ops: 40000, warmup: 1000 });
        check(stateX.pxs.buffer.byteLength === poolBeforeX,
            () => `A13: x-log pixel pool grew ${poolBeforeX} -> ${stateX.pxs.buffer.byteLength}`);
        if (!gXLog.report.ok) die(allocFailMsg('A13.xlog-project', gXLog.report, gXLog.summary));
        check(gXLog.bytesPerOp <= 16.0,
            () => `A13: x-log projection allocated ${gXLog.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gXLog.bytesPerOp - gXLin.bytesPerOp) <= 2.0,
            () => `A13: x-log ${gXLog.bytesPerOp.toFixed(3)} B/op vs linear-x ${gXLin.bytesPerOp.toFixed(3)} B/op (delta > 2.0)`);
    }

    // --- 7. annotation project-step budget (A9, v1.7.0) -----------------------
    // The annotation project step subscribes to scaleVersion, which the domain
    // effect bumps EVERY pan/zoom frame (Risk 1). It must add ZERO per-frame
    // allocation: it writes pooled node underscore fields DIRECTLY (n._x = px),
    // never node.set({...}) (an object literal per call). This gate drives a
    // real pointermove pan-drag on a mounted 8-annotation line chart -- the
    // exact hot path Risk 1 warns about.
    //
    // Two DETERMINISTIC proofs: (1) report.ok -- maxMajor:0 / maxArrayBuffers
    // Growth:0 across the window; (2) a pin on the annotation Float64Array
    // buffer.byteLength (64 slots = 512 B) -- nothing may grow on the hot path.
    //
    // The absolute bytesPerOp ceiling is LOOSE (<=16, same as A7/A12/A13) rather
    // than ===0. It cannot be ===0: the shared pan pipeline (Effect 2's
    // niceYDomain [lo,hi] array, unchanged by this feature) already floats to
    // ~1-6 B/op of heapUsed-sampling noise REGARDLESS of annotations, so an
    // absolute floor would gate the pan baseline, not this feature. A real
    // per-frame annotation regression -- reinstating node.set({...}) -- is 8
    // object literals PER FRAME, tens-to-hundreds of B/op, far above the noise
    // floor and caught by both the ceiling and report.ok.
    {
        const data = new Array(2000);
        for (let i = 0; i < 2000; i++) {
            data[i] = { x: i, y: Math.sin(i / 20) * 50 + Math.cos(i / 7) * 10 };
        }
        const anns = new Array(8);
        for (let k = 0; k < 8; k++) anns[k] = { type: 'line', axis: 'y', value: -40 + k * 12, color: '#f00' };
        const chart = createLineChart({ data, x: 'x', y: 'y', schedule: (fn) => fn(), pan: true, annotations: anns });
        const canvas = createEventCanvas(800, 400);
        chart.mount(canvas);
        quietCanvas(canvas);
        const bufBefore = chart._internal.annotations.coordBuf.buffer.byteLength;
        check(bufBefore === 512,
            () => `A9: annotation coord buffer is ${bufBefore} B, expected 512 (64 slots)`);
        fireShared(canvas, 'pointerdown', 400, 200);
        const hot = (i) => { fireShared(canvas, 'pointermove', 400 - (i % 120), 200 + (i % 60)); };
        const { report, summary, bytesPerOp } = runOpsGate(hot, { ops: 20000, warmup: 1000 });
        fireShared(canvas, 'pointerup', 300, 220);
        const bufAfter = chart._internal.annotations.coordBuf.buffer.byteLength;
        check(bufAfter === 512,
            () => `A9: annotation coord buffer grew ${bufBefore} -> ${bufAfter} during a pan-drag`);
        if (!report.ok) die(allocFailMsg('A9.annotation-pan', report, summary));
        check(bytesPerOp <= 16.0,
            () => `A9: pan-drag with 8 annotations allocated ${bytesPerOp.toFixed(3)} B/op > 16`);
        chart.destroy();
    }

    // --- 8. horizontal-bar pan + zoom storm (A14, v1.5.0) ---------------------
    // Horizontal pan/zoom remaps the linear kernels at the gesture boundary: the
    // pointermove/wheel handlers select swapAxes ? <remapped _applyPan/_applyZoom>
    // : <current>. The remap must NOT add a second per-event allocation beyond the
    // one `newView` literal the vertical path already spends (the axisSpan closure
    // in onWheel is the existing precedent). This gate drives an interleaved
    // pan-drag + wheel-zoom storm on a mounted horizontal bar with pan+zoom and
    // grid all enabled -- the exact hot path the swap branches sit on -- and pins
    // maxMajor:0 / maxArrayBuffersGrowth:0. The <=16 B/op ceiling matches the
    // vertical pointer-storm budget (section 3), so a per-event swap-branch
    // regression shows up the same as a per-hit pool allocation would.
    {
        const c = createBarChart({
            series: [
                { name: 'a', data: Array.from({ length: 100 }, (_, i) => ({ x: 'c' + i, y: (i % 13) - 6 })) },
                { name: 'b', data: Array.from({ length: 100 }, (_, i) => ({ x: 'c' + i, y: (i % 5) + 1 })) },
            ],
            width: 600, height: 400, orientation: 'horizontal',
            pan: true, zoom: true, grid: true, schedule: (fn) => fn(),
        });
        const cv = createEventCanvas(600, 400);
        c.mount(cv);
        quietCanvas(cv);
        fireShared(cv, 'pointerdown', 300, 200);
        const hot = (i) => {
            fireShared(cv, 'pointermove', 300 - (i % 120), 200 + (i % 60));
            if ((i & 7) === 0) fireShared(cv, 'wheel', 300, 200, { deltaY: (i & 8) ? 120 : -120 });
        };
        const { report, summary, bytesPerOp } = runOpsGate(hot, { ops: 16000, warmup: 1000 });
        fireShared(cv, 'pointerup', 280, 220);
        if (!report.ok) die(allocFailMsg('A14.hbar-panzoom', report, summary));
        check(bytesPerOp <= 16.0,
            () => `A14: horizontal pan+zoom storm allocated ${bytesPerOp.toFixed(3)} B/op > 16`);
        c.destroy();
    }
}
