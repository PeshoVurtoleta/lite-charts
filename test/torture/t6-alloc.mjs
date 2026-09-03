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

import { _testHelpers, createLineChart, createTimeLineChart, createDonutChart, createBarChart, createScatterChart } from '../../Charts.js';
import { signal } from '@zakkster/lite-signal';
// v1.14.0: the REAL published cell index (devDep) -- A20 gates the injected
// tessellation end-to-end, not against a mock.
import { createCellIndex } from '@zakkster/lite-delaunay';
import {
    createEventCanvas, quietCanvas, fireShared, runOpsGate, allocFailMsg,
    installCenterLabelDOM, graphSnapshot, BREAK, check, die,
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

    // --- 9. horizontal-bar brush overlay redraw budget (A15, v1.9.0) ----------
    // The horizontal brush commits a value-range x band-set payload (sub-Hz,
    // allocates its bands/ids arrays by the _computeBrushIds precedent), but the
    // OVERLAY DRAW that re-runs every frame must stay 0 B: it re-derives pixels
    // via yScale.map(valueMin/valueMax) + xScale.leftEdge(bandMin/bandMax) with no
    // per-frame allocation. This gate mounts a horizontal bar with an ACTIVE
    // brush, then drives a redraw storm through drawBrushOverlay -- the same shape
    // as the A12 redraw gate -- pinning maxMajor:0 / maxArrayBuffersGrowth:0. The
    // <=16 B/op ceiling matches A7/A12/A14; the swap-branch-specific claim is the
    // <=2 B/op differential against a VERTICAL-brush control on the same dataset,
    // so a per-frame overlay regression on the horizontal branch shows up the same
    // as a pooled-buffer leak would.
    {
        const mk = (horizontal) => {
            const c = createBarChart({
                series: [
                    { name: 'a', data: Array.from({ length: 100 }, (_, i) => ({ x: 'c' + i, y: (i % 13) - 6 })) },
                    { name: 'b', data: Array.from({ length: 100 }, (_, i) => ({ x: 'c' + i, y: (i % 5) + 1 })) },
                ],
                width: 600, height: 400, orientation: horizontal ? 'horizontal' : 'vertical',
                brush: true, schedule: (fn) => fn(),
            });
            const cv = createEventCanvas(600, 400);
            c.mount(cv);
            if (horizontal) {
                c.setBrush({ valueMin: -3, valueMax: 4, bandMin: 10, bandMax: 60 });
            } else {
                c.setBrush({ xMin: 10, xMax: 60, yMin: -3, yMax: 4 });
            }
            quietCanvas(cv);
            return c;
        };
        const hz = mk(true), vt = mk(false);
        const gH = runOpsGate(() => { hz.redraw(); }, { ops: 50000, warmup: 500 });
        const gV = runOpsGate(() => { vt.redraw(); }, { ops: 50000, warmup: 500 });
        if (!gH.report.ok) die(allocFailMsg('A15.hbrush-redraw', gH.report, gH.summary));
        check(gH.bytesPerOp <= 16.0,
            () => `A15: horizontal brush redraw allocated ${gH.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gH.bytesPerOp - gV.bytesPerOp) <= 2.0,
            () => `A15: horizontal ${gH.bytesPerOp.toFixed(3)} B/op vs vertical ${gV.bytesPerOp.toFixed(3)} B/op (delta > 2.0)`);
        hz.destroy();
        vt.destroy();
    }

    // --- 10. time-series weekend-shading redraw budget (A16, v1.10.0) ---------
    // createTimeLineChart's weekend bands are COLD-generated (inside the annotation
    // resolve effect, off the draw path) but they ride the annotation layer as
    // range rows, so the per-frame OVERLAY re-clip must stay 0 B -- the same
    // guarantee A9 pins for user annotations, here for the generated bands. This
    // gate mounts a time line with shading active over a ~2-month domain (~8
    // weekend bands) and drives a redraw storm, pinning maxMajor:0 /
    // maxArrayBuffersGrowth:0. The <=16 B/op ceiling matches A9/A15; the
    // shading-specific claim is the <=2 B/op differential against an identical
    // time line WITHOUT shading, so a per-frame regression in the generated-band
    // projection shows up the same as a pooled-buffer leak would.
    {
        const DAY = 86400000;
        const BASE = Date.UTC(2021, 0, 4); // Monday
        const mkT = (shading) => {
            const data = Array.from({ length: 60 }, (_, i) => ({
                x: BASE + i * DAY, y: Math.sin(i / 5) * 40 + 50,
            }));
            const cfg = { data, x: 'x', y: 'y', width: 800, height: 400, schedule: (fn) => fn() };
            if (shading) cfg.shading = true;
            const c = createTimeLineChart(cfg);
            const cv = createEventCanvas(800, 400);
            c.mount(cv);
            quietCanvas(cv);
            return c;
        };
        const sh = mkT(true), plain = mkT(false);
        // Sanity: shading actually produced bands (else the differential is vacuous).
        const nBands = sh._internal.annotations ? sh._internal.annotations.count : 0;
        check(nBands >= 6,
            () => `A16: expected >=6 weekend bands over a 2-month domain, got ${nBands}`);
        const gS = runOpsGate(() => { sh.redraw(); }, { ops: 50000, warmup: 500 });
        const gP = runOpsGate(() => { plain.redraw(); }, { ops: 50000, warmup: 500 });
        if (!gS.report.ok) die(allocFailMsg('A16.shading-redraw', gS.report, gS.summary));
        check(gS.bytesPerOp <= 16.0,
            () => `A16: weekend-shading redraw allocated ${gS.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gS.bytesPerOp - gP.bytesPerOp) <= 2.0,
            () => `A16: shaded ${gS.bytesPerOp.toFixed(3)} B/op vs plain ${gP.bytesPerOp.toFixed(3)} B/op (delta > 2.0)`);
        sh.destroy();
        plain.destroy();
    }

    // --- 11. time-series market-hours session shading redraw budget (A17, v1.11.0) --
    // v1.11.0 shades NON-trading time from a session calendar (shading.sessions):
    // the complement-of-union walker (_sessionBands) generates one range band per
    // gap (after-hours + weekends merged). Like weekend bands (A16) they are
    // COLD-generated in the annotation resolve effect but ride the annotation layer
    // as range rows, so the per-frame OVERLAY re-clip must stay 0 B. This gate
    // mounts a time line with an active session calendar over a 60-day domain
    // (>=40 session bands) and drives a redraw storm, pinning maxMajor:0 /
    // maxArrayBuffersGrowth:0. The <=16 B/op ceiling matches A9/A15/A16; the
    // session-specific claim is the <=2 B/op differential against the weekend-only
    // control (A16's shading:true), so a per-frame regression in the many-more
    // session bands' projection shows up the same as a pooled-buffer leak would.
    {
        const DAY = 86400000;
        const BASE = Date.UTC(2021, 0, 4); // Monday
        const mkT = (shading) => {
            const data = Array.from({ length: 60 }, (_, i) => ({
                x: BASE + i * DAY, y: Math.sin(i / 5) * 40 + 50,
            }));
            const cfg = { data, x: 'x', y: 'y', width: 800, height: 400, schedule: (fn) => fn() };
            if (shading) cfg.shading = shading;
            const c = createTimeLineChart(cfg);
            const cv = createEventCanvas(800, 400);
            c.mount(cv);
            quietCanvas(cv);
            return c;
        };
        // Session chart: Mon-Fri 09:30-16:00 (570/960). Control: weekend-only.
        const sess = mkT({ sessions: [{ openMinutes: 570, closeMinutes: 960 }] });
        const wknd = mkT(true);
        // Sanity: the session calendar actually produced many bands (>=40 over 60
        // days -- one per overnight/weekend gap); else the differential is vacuous.
        const nBands = sess._internal.annotations ? sess._internal.annotations.count : 0;
        check(nBands >= 40,
            () => `A17: expected >=40 session bands over a 60-day domain, got ${nBands}`);
        const gS = runOpsGate(() => { sess.redraw(); }, { ops: 50000, warmup: 500 });
        const gW = runOpsGate(() => { wknd.redraw(); }, { ops: 50000, warmup: 500 });
        if (!gS.report.ok) die(allocFailMsg('A17.session-redraw', gS.report, gS.summary));
        check(gS.bytesPerOp <= 16.0,
            () => `A17: session-shading redraw allocated ${gS.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gS.bytesPerOp - gW.bytesPerOp) <= 2.0,
            () => `A17: session ${gS.bytesPerOp.toFixed(3)} B/op vs weekend ${gW.bytesPerOp.toFixed(3)} B/op (delta > 2.0)`);
        sess.destroy();
        wknd.destroy();
    }

    // --- 12. virtualized legend scroll-storm budget (A18, v1.12.0) ------------
    // A tall legend virtualized through a user adapter must keep the CHART side
    // zero-alloc on the scroll hot path. Charts.js owns renderRow (row contents)
    // and one shared visibility effect; the scroll storm rebinds the pooled rows
    // ~every step (24px == itemHeight), calling _paintRow for the whole window on
    // each op. That path reads visibility via signal.peek() (no untrack thunk)
    // and writes only pooled DOM fields -- no per-row allocation. This gate mounts
    // a 200-series line with a virtualized legend, drives 5000 scroll steps of
    // 24px interleaved with redraw, and pins maxMajor:0 / maxArrayBuffersGrowth:0.
    // The <=1.5 B/op absolute bounds the chart-side scroll cost; the <=0.5 B/op
    // differential against a virtualize-ABSENT control (same 200-series redraw,
    // no scroll) isolates the scroll storm; and a graph-node delta of ZERO proves
    // no effect is (re-)registered during the storm -- peek() never subscribes.
    {
        const mkVEl = (tag) => ({
            tagName: (tag || 'div').toUpperCase(),
            childNodes: [], parentNode: null, parentElement: null,
            style: {}, className: '', textContent: '',
            dataset: {}, _attrs: {}, _listeners: {}, scrollTop: 0, clientHeight: 0,
            setAttribute(k, v) { this._attrs[k] = v; },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
            addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); },
            removeEventListener(t, fn) { const a = this._listeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
            _fire(t) { const a = this._listeners[t]; if (!a) return; for (let i = 0; i < a.length; i++) a[i].call(this); },
            appendChild(c) { if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c); this.childNodes.push(c); c.parentNode = this; c.parentElement = this; return c; },
            removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; c.parentElement = null; return c; },
            querySelectorAll() { return []; },
        });
        const fakeVirtualizer = (host, opts) => {
            const count = opts.count, itemHeight = opts.itemHeight;
            const full = Math.ceil(opts.height / itemHeight) + opts.overscan * 2;
            const win = count < full ? count : full;
            const pool = [];
            for (let i = 0; i < win; i++) { const r = document.createElement('div'); host.appendChild(r); pool.push(r); }
            let firstBound = -1;
            const paint = () => {
                let first = (host.scrollTop | 0) / itemHeight | 0;
                const maxFirst = count - win < 0 ? 0 : count - win;
                if (first > maxFirst) first = maxFirst;
                if (first < 0) first = 0;
                if (first === firstBound) return;
                firstBound = first;
                for (let s = 0; s < pool.length; s++) { const idx = first + s; if (idx < count) opts.renderRow(pool[s], idx); }
            };
            paint();
            const onScroll = () => paint();
            host.addEventListener('scroll', onScroll);
            return { dispose() { host.removeEventListener('scroll', onScroll); for (let i = 0; i < pool.length; i++) if (pool[i].parentNode) pool[i].parentNode.removeChild(pool[i]); pool.length = 0; } };
        };
        const prevDoc = globalThis.document;
        globalThis.document = { createElement: (t) => mkVEl(t) };
        try {
            const mkSeries = (n) => { const s = new Array(n); for (let i = 0; i < n; i++) s[i] = { name: 'S' + i, data: [{ x: 0, y: i }, { x: 1, y: i + 1 }] }; return s; };
            const mk = (virtualized) => {
                const cfg = { series: mkSeries(200), x: 'x', y: 'y', width: 800, height: 400, crosshair: false, tooltip: false, schedule: (fn) => fn() };
                cfg.legend = virtualized
                    ? { position: 'right', container: mkVEl('div'), virtualize: fakeVirtualizer, height: 240, itemHeight: 24, overscan: 2 }
                    : false;
                const c = createLineChart(cfg);
                const cv = createEventCanvas(800, 400);
                c.mount(cv);
                quietCanvas(cv);
                return c;
            };
            const vc = mk(true);
            const ctrl = mk(false);
            const host = vc.legend;
            // Sanity: the window is bounded (not one node per series).
            let bound = 0;
            for (let i = 0; i < host.childNodes.length; i++) { const n = host.childNodes[i]; if (n.dataset && n.dataset.lcIdx != null) bound++; }
            check(bound >= 10 && bound <= 14,
                () => `A18: expected a bounded 10..14-row window, got ${bound}`);
            const maxScroll = 200 * 24 - 240; // 4560px of scrollable range
            const before = graphSnapshot();
            const hotV = (i) => { host.scrollTop = (i * 24) % maxScroll; host._fire('scroll'); vc.redraw(); };
            const hotC = () => { ctrl.redraw(); };
            const gV = runOpsGate(hotV, { ops: 50000, warmup: 500 });
            const gC = runOpsGate(hotC, { ops: 50000, warmup: 500 });
            const after = graphSnapshot();
            if (!gV.report.ok) die(allocFailMsg('A18.legend-scroll', gV.report, gV.summary));
            check(after.nodes - before.nodes === 0,
                () => `A18: ${after.nodes - before.nodes} new signal-graph nodes during the scroll storm (expected 0)`);
            check(gV.bytesPerOp <= 1.5,
                () => `A18: virtualized scroll storm allocated ${gV.bytesPerOp.toFixed(3)} B/op > 1.5`);
            check(Math.abs(gV.bytesPerOp - gC.bytesPerOp) <= 0.5,
                () => `A18: scroll ${gV.bytesPerOp.toFixed(3)} B/op vs no-legend control ${gC.bytesPerOp.toFixed(3)} B/op (delta > 0.5)`);
            vc.destroy();
            ctrl.destroy();
        } finally {
            globalThis.document = prevDoc;
        }
    }

    // --- 13. overnight + holiday band-regeneration storm (A19, v1.13.0) --------
    // v1.13.0 adds overnight sessions (close < open, split at the UTC midnight seam
    // into two half-sessions at normalize time) and a holiday calendar (whole UTC
    // days closed, fused with adjacent gaps). Both are COLD: the split happens once
    // in _normalizeSessionSpec at construction, the holiday day-skip lives in the
    // sub-Hz data-tracked resolve effect (_sessionBands). This gate drives a
    // data-change storm on a time line carrying an overnight Globex-style calendar
    // + a 12-entry holiday array, alternating the data signal between two prebuilt
    // arrays (same 60-day UTC domain, different y -- so bands regenerate every set
    // without the set() itself allocating a fresh array). Two structural claims:
    // (1) the resolve effect only RECOMPUTES on data change, never registering new
    // signal-graph nodes (delta 0 across the storm); (2) the per-frame redraw path
    // is byte-unchanged from A17 -- overnight/holiday bands ride the annotation
    // layer as plain range rows, so redraw stays <=16 B/op with maxMajor:0.
    {
        const DAY = 86400000;
        const BASE = Date.UTC(2021, 0, 4); // Monday
        const N = 60;
        const mkData = (phase) => {
            const arr = new Array(N);
            for (let i = 0; i < N; i++) arr[i] = { x: BASE + i * DAY, y: Math.sin((i + phase) / 5) * 40 + 50 };
            return arr;
        };
        const dataA = mkData(0);
        const dataB = mkData(1);
        // 12 holidays scattered across the domain, each a true UTC midnight.
        const holidays = [];
        for (let k = 3; holidays.length < 12; k += 4) holidays.push(BASE + k * DAY);
        // Globex-style overnight: opens Sun-Thu 22:00 UTC, closes 21:00 next day.
        const shading = {
            sessions: [{ openMinutes: 1320, closeMinutes: 1260, days: [0, 1, 2, 3, 4] }],
            holidays,
        };
        const data = signal(dataA);
        const c = createTimeLineChart({
            data, x: 'x', y: 'y', width: 800, height: 400, shading, schedule: (fn) => fn(),
        });
        const cv = createEventCanvas(800, 400);
        c.mount(cv);
        quietCanvas(cv);
        // Sanity: overnight + holidays actually produced a non-trivial band set.
        const nBands = c._internal.annotations ? c._internal.annotations.count : 0;
        check(nBands >= 20,
            () => `A19: expected >=20 bands from the overnight+holiday calendar, got ${nBands}`);
        // Warmup the data-change path, THEN pin the graph. ~200 alternating sets:
        // each fires the resolve effect (band regen) but must add zero graph nodes.
        for (let i = 0; i < 8; i++) data.set(i & 1 ? dataA : dataB);
        const before = graphSnapshot();
        for (let i = 0; i < 200; i++) data.set(i & 1 ? dataA : dataB);
        const after = graphSnapshot();
        check(after.nodes - before.nodes === 0,
            () => `A19: ${after.nodes - before.nodes} new signal-graph nodes across the data-change storm (expected 0)`);
        // Per-frame redraw budget: the overnight/holiday bands are plain range rows,
        // so the draw path matches A17's <=16 B/op with maxMajor:0.
        const gR = runOpsGate(() => { c.redraw(); }, { ops: 50000, warmup: 500 });
        if (!gR.report.ok) die(allocFailMsg('A19.overnight-holiday-redraw', gR.report, gR.summary));
        check(gR.bytesPerOp <= 16.0,
            () => `A19: overnight+holiday redraw allocated ${gR.bytesPerOp.toFixed(3)} B/op > 16`);
        c.destroy();
    }

    // --- 14. voronoi cells + fat hover storm (A20, v1.14.0) --------------------
    // v1.14.0 adds an injected cell layer (cells.index -> bbox-clipped Voronoi
    // polygons rebuilt COLD in the postProject seam on every data/scale change)
    // and hitTolerance:'nearest' (a per-query plot-diagonal cap, pure arithmetic
    // on the existing hit path). Structural claims: (1) a pan/zoom storm rebuilds
    // the index exactly once per scale change -- never per frame -- and adds zero
    // signal-graph nodes; (2) the per-frame cell DRAW walks prebuilt packed
    // arrays: redraw with 2000 live cells stays inside the standard <=16 B/op
    // budget with maxMajor:0, within 2 B/op of a no-cells control; (3) fat hover
    // adds nothing to the hit path (the pre-existing pointer-rate hit literal is
    // the accepted cost, identical under 'nearest' and numeric tolerance).
    {
        const N = 2000;
        const xs = new Float32Array(N), ys = new Float32Array(N);
        let seed = 1234567;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let i = 0; i < N; i++) { xs[i] = rnd() * 1000; ys[i] = rnd() * 500; }
        let builds = 0, disposes = 0;
        const inner = createCellIndex(N);
        const counting = (pxs, pys, n) => {
            builds++;
            const h = inner(pxs, pys, n);
            return {
                cell: (i, a, b, c2, d, o) => h.cell(i, a, b, c2, d, o),
                dispose() { disposes++; h.dispose(); },
            };
        };
        const mkScatter = (cells) => {
            const c = createScatterChart({
                data: { xs, ys },
                zoom: true,
                hitTolerance: 'nearest',
                ...(cells ? { cells: { index: counting, fillOpacity: 0.3 } } : {}),
                width: 800, height: 400, schedule: (fn) => fn(),
            });
            const cv = createEventCanvas(800, 400);
            c.mount(cv);
            quietCanvas(cv);
            return { c, cv };
        };
        const { c } = mkScatter(true);
        check(builds === 1, () => `A20: expected 1 index build at mount, got ${builds}`);
        // Pan/zoom storm: 200 alternating view writes. Every write re-runs the
        // extract/project effect -> dispose + rebuild (cold), but must register
        // ZERO new signal-graph nodes once warmed.
        const vA = { xMin: 100, xMax: 900, yMin: null, yMax: null };
        const vB = { xMin: 50, xMax: 950, yMin: null, yMax: null };
        for (let i = 0; i < 8; i++) c.setView(i & 1 ? vA : vB);
        const before = graphSnapshot();
        for (let i = 0; i < 200; i++) c.setView(i & 1 ? vA : vB);
        const after = graphSnapshot();
        check(after.nodes - before.nodes === 0,
            () => `A20: ${after.nodes - before.nodes} new signal-graph nodes across the view storm (expected 0)`);
        check(builds === 209 && disposes === 208,
            () => `A20: expected 209 builds / 208 disposes after 208 view writes, got ${builds}/${disposes}`);
        // Per-frame draw: 2000 live cells, prebuilt geometry only. Standard
        // redraw budget; the index must NOT rebuild at frame rate.
        const buildsBeforeRedraw = builds;
        const gCells = runOpsGate(() => { c.redraw(); }, { ops: 4000, warmup: 300 });
        if (!gCells.report.ok) die(allocFailMsg('A20.cells-redraw', gCells.report, gCells.summary));
        check(gCells.bytesPerOp <= 16.0,
            () => `A20: cells redraw allocated ${gCells.bytesPerOp.toFixed(3)} B/op > 16`);
        check(builds === buildsBeforeRedraw,
            () => `A20: redraw storm rebuilt the index (${builds - buildsBeforeRedraw} extra builds -- must be scale-rate, not frame-rate)`);
        // Control: identical chart, no cells. The cell layer's own draw cost
        // must sit within 2 B/op of the bare scatter.
        const { c: ctrl } = mkScatter(false);
        const gCtrl = runOpsGate(() => { ctrl.redraw(); }, { ops: 4000, warmup: 300 });
        if (!gCtrl.report.ok) die(allocFailMsg('A20.control-redraw', gCtrl.report, gCtrl.summary));
        check(Math.abs(gCells.bytesPerOp - gCtrl.bytesPerOp) <= 2.0,
            () => `A20: cells redraw ${gCells.bytesPerOp.toFixed(3)} B/op vs no-cells control ${gCtrl.bytesPerOp.toFixed(3)} B/op (delta > 2)`);
        // Fat hover: 'nearest' vs numeric tolerance over the same alternating
        // cursor pair (both positions hit -- the pointer-rate hit literal is
        // identical on both paths, so the DELTA isolates the 'nearest' cap).
        const ctrlHit = createScatterChart({
            data: { xs, ys }, zoom: true, hitTolerance: 1e6,
            width: 800, height: 400, schedule: (fn) => fn(),
        });
        const cvH = createEventCanvas(800, 400);
        ctrlHit.mount(cvH);
        quietCanvas(cvH);
        const gHoverN = runOpsGate((i) => { c.moveCrosshair(i & 1 ? 300 : 500, i & 1 ? 100 : 300); },
            { ops: 20000, warmup: 1000 });
        if (!gHoverN.report.ok) die(allocFailMsg('A20.hover-nearest', gHoverN.report, gHoverN.summary));
        const gHoverT = runOpsGate((i) => { ctrlHit.moveCrosshair(i & 1 ? 300 : 500, i & 1 ? 100 : 300); },
            { ops: 20000, warmup: 1000 });
        if (!gHoverT.report.ok) die(allocFailMsg('A20.hover-tolerance', gHoverT.report, gHoverT.summary));
        check(Math.abs(gHoverN.bytesPerOp - gHoverT.bytesPerOp) <= 2.0,
            () => `A20: 'nearest' hover ${gHoverN.bytesPerOp.toFixed(3)} B/op vs numeric-tolerance ${gHoverT.bytesPerOp.toFixed(3)} B/op (delta > 2)`);
        ctrlHit.destroy();
        ctrl.destroy();
        c.destroy();
        check(disposes === builds, () => `A20: ${builds - disposes} cell index(es) never disposed`);
    }
}
