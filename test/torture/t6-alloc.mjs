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

import { _testHelpers, createLineChart, createTimeLineChart, createDonutChart, createBarChart, createScatterChart, createCandlestickChart } from '../../Charts.js';
import { signal } from '@zakkster/lite-signal';
// v1.14.0: the REAL published cell index (devDep) -- A20 gates the injected
// tessellation end-to-end, not against a mock.
import { createCellIndex, createFieldIndex, createClusterIndex } from '@zakkster/lite-delaunay';
import {
    createEventCanvas, quietCanvas, fireShared, runOpsGate, allocFailMsg,
    runAllocsGate, allocsFailMsg, graphDelta,
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
        // Zero-RETENTION gate over the SAME `hot` kernel closure. runOpsGate sees
        // pool growth and async GC; this sees plain-object survivors that a
        // retaining kernel would leave on the heap (invisible to maxMajor alone).
        const kg = runAllocsGate(hot, { iterations: 20000, batches: 8 });
        if (!kg.ok) die(allocsFailMsg('T6.kernel', kg));
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
        // Zero-RETENTION gate over the SAME redraw, wrapped in a signal-graph
        // snapshot: a redraw that leaked a reactive node/link per frame would
        // slip past the async-GC ops gate but climb here (heap survivors) and in
        // the node/link deltas (which must be EXACTLY 0 across the window).
        const rdBefore = graphSnapshot();
        const rg = runAllocsGate(() => { chart.redraw(); }, { iterations: 2000, batches: 6 });
        const rdDelta = graphDelta(rdBefore);
        if (!rg.ok) die(allocsFailMsg('T6.redraw', rg));
        check(rdDelta.nodes === 0 && rdDelta.links === 0,
            () => `T6.redraw: signal graph grew across redraw window -- nodes ${rdDelta.nodes}, links ${rdDelta.links}`);
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

    // --- 15. HORIZONTAL legend scroll-storm budget (A21, v1.15.0) --------------
    // v1.15.0 opens the top/bottom door on legend.virtualize: the adapter windows
    // on scrollLeft with itemWidth/width, and Charts.js hands it the six-key
    // horizontal opts literal ({..., horizontal: true}). The chart-side hot path
    // is the SAME _paintRow/repaint machinery as A18 (peek() reads, pooled DOM
    // writes), so the claim this gate pins is BRANCH PARITY: a top-position
    // scroll storm must cost what the A18-shaped right-position storm costs.
    // The control is therefore a VERTICAL virtualized legend (A18's exact
    // config) driving the identical 50000-step 24px storm interleaved with
    // redraw -- NOT a legend-absent chart (that isolation is A18's job; a
    // redraw-only control also sits in a differently-warmed measurement context
    // this late in the tier, which is noise, not signal -- per-process probes
    // put the true horizontal-vs-vertical delta at 0.000 B/op). Pins: <=1.5
    // B/op absolute, <=0.5 B/op differential vs the vertical storm, and ZERO
    // new signal-graph nodes across BOTH storms (peek() never subscribes).
    {
        const mkVEl = (tag) => ({
            tagName: (tag || 'div').toUpperCase(),
            childNodes: [], parentNode: null, parentElement: null,
            style: {}, className: '', textContent: '',
            dataset: {}, _attrs: {}, _listeners: {},
            scrollTop: 0, clientHeight: 0, scrollLeft: 0, clientWidth: 0,
            setAttribute(k, v) { this._attrs[k] = v; },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
            addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); },
            removeEventListener(t, fn) { const a = this._listeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
            _fire(t) { const a = this._listeners[t]; if (!a) return; for (let i = 0; i < a.length; i++) a[i].call(this); },
            appendChild(c) { if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c); this.childNodes.push(c); c.parentNode = this; c.parentElement = this; return c; },
            removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; c.parentElement = null; return c; },
            querySelectorAll() { return []; },
        });
        const fakeHVirtualizer = (host, opts) => {
            const count = opts.count, itemWidth = opts.itemWidth;
            const full = Math.ceil(opts.width / itemWidth) + opts.overscan * 2;
            const win = count < full ? count : full;
            const pool = [];
            for (let i = 0; i < win; i++) { const r = document.createElement('div'); host.appendChild(r); pool.push(r); }
            let firstBound = -1;
            const paint = () => {
                let first = (host.scrollLeft | 0) / itemWidth | 0;
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
            // Vertical control adapter: A18's exact windowing shape.
            const fakeVVirtualizer = (host, opts) => {
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
            const mk = (horizontal) => {
                const cfg = { series: mkSeries(200), x: 'x', y: 'y', width: 800, height: 400, crosshair: false, tooltip: false, schedule: (fn) => fn() };
                cfg.legend = horizontal
                    ? { position: 'top', container: mkVEl('div'), virtualize: fakeHVirtualizer, width: 240, itemWidth: 24, overscan: 2 }
                    : { position: 'right', container: mkVEl('div'), virtualize: fakeVVirtualizer, height: 240, itemHeight: 24, overscan: 2 };
                const c = createLineChart(cfg);
                const cv = createEventCanvas(800, 400);
                c.mount(cv);
                quietCanvas(cv);
                return c;
            };
            const vc = mk(true);
            const ctrl = mk(false);
            const host = vc.legend;
            const hostC = ctrl.legend;
            // Sanity: bounded window (ceil(240/24) + 2*2 = 14) -- the SAME pool size
            // as A18's vertical baseline, so the differential gate compares the
            // horizontal BRANCH, not a larger window.
            let bound = 0;
            for (let i = 0; i < host.childNodes.length; i++) { const n = host.childNodes[i]; if (n.dataset && n.dataset.lcIdx != null) bound++; }
            check(bound >= 10 && bound <= 14,
                () => `A21: expected a bounded 10..14-row window, got ${bound}`);
            const maxScroll = 200 * 24 - 240; // 4560px of scrollable range (matches A18)
            const before = graphSnapshot();
            const hotV = (i) => { host.scrollLeft = (i * 24) % maxScroll; host._fire('scroll'); vc.redraw(); };
            const hotC = (i) => { hostC.scrollTop = (i * 24) % maxScroll; hostC._fire('scroll'); ctrl.redraw(); };
            const gV = runOpsGate(hotV, { ops: 50000, warmup: 500 });
            const gC = runOpsGate(hotC, { ops: 50000, warmup: 500 });
            const after = graphSnapshot();
            if (!gV.report.ok) die(allocFailMsg('A21.hlegend-scroll', gV.report, gV.summary));
            check(after.nodes - before.nodes === 0,
                () => `A21: ${after.nodes - before.nodes} new signal-graph nodes during the horizontal scroll storm (expected 0)`);
            check(gV.bytesPerOp <= 1.5,
                () => `A21: horizontal scroll storm allocated ${gV.bytesPerOp.toFixed(3)} B/op > 1.5`);
            check(Math.abs(gV.bytesPerOp - gC.bytesPerOp) <= 0.5,
                () => `A21: horizontal storm ${gV.bytesPerOp.toFixed(3)} B/op vs vertical storm ${gC.bytesPerOp.toFixed(3)} B/op (branch parity delta > 0.5)`);
            vc.destroy();
            ctrl.destroy();
        } finally {
            globalThis.document = prevDoc;
        }
    }

    // --- 16. field-raster storm (A22, v1.16.0) ---------------------------------
    // v1.16.0 adds the injected field layer (field.index -> createFieldIndex,
    // ONE sampleField per cold refresh into a pooled grid, per-cell color
    // strings precomputed; drawn as a fillRect walk UNDER cells/markers).
    // Structural claims: (1) a pan/zoom storm rebuilds + resamples exactly once
    // per scale change -- never per frame, never per redraw -- and adds zero
    // signal-graph nodes; (2) the per-frame raster DRAW walks prebuilt color
    // strings: redraw with a live 64x48 raster stays inside the standard
    // <=16 B/op budget with maxMajor:0, within 2 B/op of a no-field control;
    // (3) interpolate is NEVER called (the counting handle exposes none, so a
    // pointwise regression would throw, not silently allocate).
    {
        const N = 2000;
        const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
        let seed = 7654321;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let i = 0; i < N; i++) {
            xs[i] = rnd() * 1000; ys[i] = rnd() * 500;
            zs[i] = 2 * xs[i] + 3 * ys[i] + 1;
        }
        let builds = 0, disposes = 0, samples = 0;
        const inner = createFieldIndex(N);
        const counting = (pxs, pys, n) => {
            builds++;
            const h = inner(pxs, pys, n);
            return {
                sampleField: (z, gw, gh, a, b, c2, d, o) => { samples++; return h.sampleField(z, gw, gh, a, b, c2, d, o); },
                dispose() { disposes++; h.dispose(); },
            };
        };
        const mkScatter = (field) => {
            const c = createScatterChart({
                data: { xs, ys, zs },
                zoom: true,
                ...(field ? { field: { index: counting, value: 'z', opacity: 0.4 } } : {}),
                width: 800, height: 400, schedule: (fn) => fn(),
            });
            const cv = createEventCanvas(800, 400);
            c.mount(cv);
            quietCanvas(cv);
            return c;
        };
        const c = mkScatter(true);
        const ctrl = mkScatter(false);
        check(builds === 1, () => `A22: expected 1 field build at mount, got ${builds}`);
        check(samples === 1, () => `A22: expected 1 sampleField at mount, got ${samples}`);

        // View storm: 208 writes alternating two zoomed views. Every write is a
        // scale change -> exactly one dispose+rebuild+resample each; a redraw
        // between writes must add nothing.
        const vA = { xMin: 100, xMax: 900, yMin: 50, yMax: 450 };
        const vB = { xMin: 200, xMax: 800, yMin: 100, yMax: 400 };
        // Warm-up (the A19 precedent): the first writes settle one-time lazy
        // registrations/disposals; the gated storm must then be EXACTLY flat.
        for (let i = 0; i < 8; i++) c.setView(i & 1 ? vA : vB);
        const b0 = builds, d0 = disposes;
        const before = graphSnapshot();
        for (let i = 0; i < 208; i++) {
            c.setView(i & 1 ? vA : vB);
            c.redraw();
        }
        const after = graphSnapshot();
        check(after.nodes - before.nodes === 0,
            () => `A22: ${after.nodes - before.nodes} new signal-graph nodes across the view storm (expected 0)`);
        check(builds - b0 === 208 && disposes - d0 === 208,
            () => `A22: expected exactly 208 builds / 208 disposes across 208 view writes, got ${builds - b0}/${disposes - d0}`);
        check(samples === builds,
            () => `A22: expected one sampleField per build, got ${samples} samples / ${builds} builds`);

        // Redraw budget: raster walk vs no-field control.
        const bBefore = builds;
        const gField = runOpsGate(() => { c.redraw(); }, { ops: 4000, warmup: 300 });
        const gCtrl = runOpsGate(() => { ctrl.redraw(); }, { ops: 4000, warmup: 300 });
        check(builds === bBefore, () => `A22: redraw storm rebuilt the field index (${builds - bBefore}x)`);
        if (!gField.report.ok) die(allocFailMsg('A22.field-redraw', gField.report, gField.summary));
        check(gField.bytesPerOp <= 16,
            () => `A22: field redraw ${gField.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gField.bytesPerOp - gCtrl.bytesPerOp) <= 2.0,
            () => `A22: field redraw ${gField.bytesPerOp.toFixed(3)} B/op vs no-field control ${gCtrl.bytesPerOp.toFixed(3)} B/op (delta > 2)`);
        ctrl.destroy();
        c.destroy();
        check(disposes === builds, () => `A22: ${builds - disposes} field handle(s) never disposed`);
    }

    // --- 17. contour/isoline storm (A23, v1.17.0) ------------------------------
    // v1.17.0 adds the contour layer: an EXACT TIN sweep REUSING the field
    // handle (never rebuilds it), swept COLD once per scale/data change into a
    // per-level pooled segment run; drawn as a per-level moveTo/lineTo/stroke
    // walk OVER the raster. Structural claims mirror A22 with the contour lens:
    // (1) a pan/zoom storm sweeps EXACTLY once per scale change -- never per
    // frame, never per redraw -- and adds zero graph nodes; (2) the per-frame
    // isoline DRAW walks the prebuilt segment pool: redraw with 6 live levels on
    // a 2000-pt planar field stays inside <=16 B/op with maxMajor:0, within
    // 2 B/op of a BRANCH-PARITY control (identical field WITHOUT contours -- the
    // A21 lesson: the contour node must add ~0 B on the hot path); (3) the sweep
    // reuses the field index (builds/disposes stay 1:1 with the view writes).
    {
        const N = 2000;
        const xs = new Float32Array(N), ys = new Float32Array(N), zs = new Float32Array(N);
        let seed = 20250905;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let i = 0; i < N; i++) {
            xs[i] = rnd() * 1000; ys[i] = rnd() * 500;
            zs[i] = 2 * xs[i] + 3 * ys[i] + 1;  // planar oracle
        }
        let builds = 0, disposes = 0, sweeps = 0;
        const inner = createFieldIndex(N);
        // Counting handle: passes through the field sampler AND the two TIN
        // methods the contour sweep consumes; triangleCount is called ONCE per
        // sweep, so it is an exact sweep-entry probe.
        const counting = (pxs, pys, n) => {
            builds++;
            const h = inner(pxs, pys, n);
            return {
                sampleField: (z, gw, gh, a, b, c2, d, o) => h.sampleField(z, gw, gh, a, b, c2, d, o),
                triangleCount: () => { sweeps++; return h.triangleCount(); },
                triangleVertices: (t, o) => h.triangleVertices(t, o),
                dispose() { disposes++; h.dispose(); },
            };
        };
        const mkScatter = (withContours, indexFactory) => {
            const c = createScatterChart({
                data: { xs, ys, zs },
                zoom: true,
                field: {
                    index: indexFactory, value: 'z', opacity: 0.4,
                    ...(withContours ? { contours: { levels: 6, color: '#1e293b', width: 1 } } : {}),
                },
                width: 800, height: 400, schedule: (fn) => fn(),
            });
            const cv = createEventCanvas(800, 400);
            c.mount(cv);
            quietCanvas(cv);
            return c;
        };
        const c = mkScatter(true, counting);
        const ctrl = mkScatter(false, createFieldIndex(N));
        check(builds === 1, () => `A23: expected 1 field build at mount, got ${builds}`);
        check(sweeps === 1, () => `A23: expected 1 contour sweep at mount, got ${sweeps}`);

        // View storm: every write is a scale change -> exactly one
        // dispose+rebuild of the field handle and exactly one contour sweep.
        const vA = { xMin: 100, xMax: 900, yMin: 50, yMax: 450 };
        const vB = { xMin: 200, xMax: 800, yMin: 100, yMax: 400 };
        for (let i = 0; i < 8; i++) c.setView(i & 1 ? vA : vB);
        const b0 = builds, d0 = disposes, s0 = sweeps;
        const before = graphSnapshot();
        for (let i = 0; i < 208; i++) {
            c.setView(i & 1 ? vA : vB);
            c.redraw();
        }
        const after = graphSnapshot();
        check(after.nodes - before.nodes === 0,
            () => `A23: ${after.nodes - before.nodes} new signal-graph nodes across the view storm (expected 0)`);
        check(builds - b0 === 208 && disposes - d0 === 208,
            () => `A23: expected exactly 208 builds / 208 disposes across 208 view writes, got ${builds - b0}/${disposes - d0}`);
        check(sweeps - s0 === 208,
            () => `A23: expected exactly 208 contour sweeps (one per write, never per redraw), got ${sweeps - s0}`);

        // Redraw budget: isoline walk vs no-contour control.
        const sBefore = sweeps;
        // 20000 ops (vs A22's 4000): the isoline draw's true per-op alloc is ~0,
        // so the branch-parity delta must be read at a heap-step granularity fine
        // enough that two near-zero field-bearing charts converge -- 4000 ops
        // leaves a single ~20KB heap step straddling the 2 B/op tolerance.
        const gContour = runOpsGate(() => { c.redraw(); }, { ops: 20000, warmup: 1000 });
        const gCtrl = runOpsGate(() => { ctrl.redraw(); }, { ops: 20000, warmup: 1000 });
        check(sweeps === sBefore, () => `A23: redraw storm re-swept the contour layer (${sweeps - sBefore}x)`);
        if (!gContour.report.ok) die(allocFailMsg('A23.contour-redraw', gContour.report, gContour.summary));
        check(gContour.bytesPerOp <= 16,
            () => `A23: contour redraw ${gContour.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gContour.bytesPerOp - gCtrl.bytesPerOp) <= 2.0,
            () => `A23: contour redraw ${gContour.bytesPerOp.toFixed(3)} B/op vs no-contour control ${gCtrl.bytesPerOp.toFixed(3)} B/op (delta > 2)`);
        ctrl.destroy();
        c.destroy();
        check(disposes === builds, () => `A23: ${builds - disposes} field handle(s) never disposed`);
    }

    // --- 18. cluster-outline storm (A24, v1.18.0) ------------------------------
    // v1.18.0 adds the outlines layer: per-group cluster handles built COLD once
    // per scale/data change (2 groups -> 2 builds per view write, never per
    // frame), boundary loops baked into pooled flat geometry, drawn as a
    // per-group moveTo/lineTo/closePath walk. Structural claims mirror A23 with
    // the outline lens: (1) a gesture storm rebuilds EXACTLY one handle per
    // group per scale change and adds zero graph nodes; (2) the per-frame draw
    // walks prebuilt geometry only: redraw with 2 groups x 1000 pts under a
    // concave alpha stays inside <=16 B/op with maxMajor:0, within 2 B/op of a
    // BRANCH-PARITY control (identical scatter WITHOUT outlines -- the A21
    // lesson); (3) builds === disposes at destroy (per-group handle hygiene).
    {
        const N = 2000;  // 2 groups x 1000 pts (brief gate size)
        const rows = new Array(N);
        let seed = 20260905;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let i = 0; i < N; i++) {
            const g = i & 1;
            rows[i] = {
                x: (g ? 550 : 50) + rnd() * 400,   // two overlapping-x blobs
                y: 50 + rnd() * 400,
                g: g ? 'right' : 'left',
            };
        }
        let builds = 0, disposes = 0, queries = 0;
        const inner = createClusterIndex(2048);
        const counting = (pxs, pys, n) => {
            builds++;
            const h = inner(pxs, pys, n);
            return {
                convexHull: (o) => { queries++; return h.convexHull(o); },
                alphaShape: (a, o, e) => { queries++; return h.alphaShape(a, o, e); },
                dispose() { disposes++; h.dispose(); },
            };
        };
        const mkScatter = (withOutlines) => {
            const c = createScatterChart({
                data: rows,
                zoom: true,
                ...(withOutlines ? {
                    outlines: { index: counting, groupKey: 'g', alpha: 60, fillOpacity: 0.2, stroke: '#7a7a7a' },
                } : {}),
                width: 800, height: 400, schedule: (fn) => fn(),
            });
            const cv = createEventCanvas(800, 400);
            c.mount(cv);
            quietCanvas(cv);
            return c;
        };
        const c = mkScatter(true);
        const ctrl = mkScatter(false);
        check(builds === 2, () => `A24: expected 2 handle builds at mount (one per group), got ${builds}`);
        check(queries === 2, () => `A24: expected 2 boundary queries at mount, got ${queries}`);

        // Gesture storm: every write is a scale change -> exactly one
        // dispose+rebuild PER GROUP, never per frame.
        const vA = { xMin: 100, xMax: 900, yMin: 50, yMax: 450 };
        const vB = { xMin: 200, xMax: 800, yMin: 100, yMax: 400 };
        for (let i = 0; i < 8; i++) c.setView(i & 1 ? vA : vB);
        const b0 = builds, d0 = disposes;
        const before = graphSnapshot();
        for (let i = 0; i < 208; i++) {
            c.setView(i & 1 ? vA : vB);
            c.redraw();
        }
        const after = graphSnapshot();
        check(after.nodes - before.nodes === 0,
            () => `A24: ${after.nodes - before.nodes} new signal-graph nodes across the gesture storm (expected 0)`);
        check(builds - b0 === 416 && disposes - d0 === 416,
            () => `A24: expected exactly 416 builds / 416 disposes (2 groups x 208 writes), got ${builds - b0}/${disposes - d0}`);

        // Redraw budget: prebuilt-geometry walk vs no-outlines control (20000
        // ops -- the A23 granularity lesson: tighten ops, never thresholds).
        const bBefore = builds;
        const gOutline = runOpsGate(() => { c.redraw(); }, { ops: 20000, warmup: 1000 });
        const gCtrl = runOpsGate(() => { ctrl.redraw(); }, { ops: 20000, warmup: 1000 });
        check(builds === bBefore, () => `A24: redraw storm rebuilt cluster handles (${builds - bBefore}x)`);
        if (!gOutline.report.ok) die(allocFailMsg('A24.outline-redraw', gOutline.report, gOutline.summary));
        check(gOutline.bytesPerOp <= 16,
            () => `A24: outline redraw ${gOutline.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gOutline.bytesPerOp - gCtrl.bytesPerOp) <= 2.0,
            () => `A24: outline redraw ${gOutline.bytesPerOp.toFixed(3)} B/op vs no-outlines control ${gCtrl.bytesPerOp.toFixed(3)} B/op (delta > 2)`);
        ctrl.destroy();
        c.destroy();
        check(disposes === builds, () => `A24: ${builds - disposes} cluster handle(s) never disposed`);
    }

    // --- 19. candlestick storm (A25, v1.19.0) ---------------------------------
    // The tenth renderer: per-value o/h/l/c pixel projection + median slot width
    // are COLD (postProject, per data/scale change); the draw closure walks
    // prebuilt Float64 pools (two style passes, fillRect bodies + one stroked
    // wick path) at 0 B/frame. Claims: (1) a 208-write gesture storm adds zero
    // signal-graph nodes; (2) redraw at 1k candles stays <=16 B/op and within
    // 2 B/op of a BRANCH-PARITY control (createTimeLineChart, same rows, closes
    // as the line y -- the A21 lesson); (3) redraw at 10k candles holds the same
    // absolute budget (no decimation regime exists for candles -- every candle
    // draws); (4) 50 create/mount/destroy cycles retain zero graph nodes.
    // Fixture ts are REAL epoch ms at minute granularity: state.xs is Float32
    // (house-wide), so this pins the raw-double medianDt/domain path -- a
    // Float32-derived medianDt would quantize 60000ms deltas to 0 and clamp
    // every body to 1px (invisible to an alloc gate, load-bearing for qa).
    {
        const mkRows = (n) => {
            const rows = new Array(n);
            let seed = 20260906;
            const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
            const t0 = Date.UTC(2026, 0, 5);   // Mon 2026-01-05 00:00 UTC
            let price = 100;
            for (let i = 0; i < n; i++) {
                const o = price;
                const c = o + (rnd() - 0.5) * 4;
                const h = (o > c ? o : c) + rnd() * 2;
                const l = (o < c ? o : c) - rnd() * 2;
                rows[i] = { ts: t0 + i * 60000, o, h, l, c };
                price = c;
            }
            return rows;
        };
        const mount = (chart) => {
            const cv = createEventCanvas(800, 400);
            chart.mount(cv);
            quietCanvas(cv);
            return chart;
        };
        const rows1k = mkRows(1000);
        const c1k = mount(createCandlestickChart({
            data: rows1k, zoom: true, width: 800, height: 400, schedule: (fn) => fn(),
        }));
        const ctrl = mount(createTimeLineChart({
            data: rows1k, x: 'ts', y: 'c', zoom: true, width: 800, height: 400,
            schedule: (fn) => fn(),
        }));

        // Gesture storm: every write is a scale change (cold re-projection of
        // 4 pools + slot recompute) -- zero new graph nodes.
        const t0 = Date.UTC(2026, 0, 5);
        const vA = { xMin: t0 + 100 * 60000, xMax: t0 + 900 * 60000, yMin: 60, yMax: 140 };
        const vB = { xMin: t0 + 200 * 60000, xMax: t0 + 800 * 60000, yMin: 70, yMax: 130 };
        for (let i = 0; i < 8; i++) c1k.setView(i & 1 ? vA : vB);
        const before = graphSnapshot();
        for (let i = 0; i < 208; i++) {
            c1k.setView(i & 1 ? vA : vB);
            c1k.redraw();
        }
        const after = graphSnapshot();
        check(after.nodes - before.nodes === 0,
            () => `A25: ${after.nodes - before.nodes} new signal-graph nodes across the gesture storm (expected 0)`);

        // Redraw budget at 1k vs the branch-parity time-line control.
        const gCandle = runOpsGate(() => { c1k.redraw(); }, { ops: 20000, warmup: 1000 });
        const gCtrl = runOpsGate(() => { ctrl.redraw(); }, { ops: 20000, warmup: 1000 });
        if (!gCandle.report.ok) die(allocFailMsg('A25.candle-redraw', gCandle.report, gCandle.summary));
        check(gCandle.bytesPerOp <= 16,
            () => `A25: candle redraw ${gCandle.bytesPerOp.toFixed(3)} B/op > 16`);
        check(Math.abs(gCandle.bytesPerOp - gCtrl.bytesPerOp) <= 2.0,
            () => `A25: candle redraw ${gCandle.bytesPerOp.toFixed(3)} B/op vs time-line control ${gCtrl.bytesPerOp.toFixed(3)} B/op (delta > 2)`);
        ctrl.destroy();
        c1k.destroy();

        // 10k candles: absolute budget only (fewer ops -- the walk is 10x).
        const c10k = mount(createCandlestickChart({
            data: mkRows(10000), zoom: true, width: 800, height: 400, schedule: (fn) => fn(),
        }));
        const g10k = runOpsGate(() => { c10k.redraw(); }, { ops: 4000, warmup: 400 });
        if (!g10k.report.ok) die(allocFailMsg('A25.candle-10k-redraw', g10k.report, g10k.summary));
        check(g10k.bytesPerOp <= 16,
            () => `A25: 10k-candle redraw ${g10k.bytesPerOp.toFixed(3)} B/op > 16`);
        c10k.destroy();

        // Create/mount/destroy retention: 50 cycles, zero retained graph nodes.
        const rowsR = mkRows(200);
        const rBefore = graphSnapshot();
        for (let i = 0; i < 50; i++) {
            const c = mount(createCandlestickChart({
                data: rowsR, width: 800, height: 400, schedule: (fn) => fn(),
            }));
            c.destroy();
        }
        const rAfter = graphSnapshot();
        check(rAfter.nodes - rBefore.nodes === 0,
            () => `A25: ${rAfter.nodes - rBefore.nodes} signal-graph nodes retained across 50 create/destroy cycles`);
    }
}
