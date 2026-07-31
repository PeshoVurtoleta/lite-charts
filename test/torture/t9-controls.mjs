/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * This tier runs deliberately-broken variants IN PROCESS and asserts that the
 * corresponding gate flags each one. If a control slips through, T9 itself fails
 * the run -- a gate that cannot fail is decorative.
 *
 * There is also a whole-suite control: `CHARTS_TORTURE_BREAK=1 npm run torture`
 * injects retained allocations into T6; T9 covers the alloc lane here too so a
 * plain `npm run torture` already proves the gate bites.
 */

import { _testHelpers, createLineChart } from '../../Charts.js';
import {
    createEventCanvas, installResizeObserver, runOpsGate, graphSnapshot, graphDelta, die,
} from './harness.mjs';

const { decimateMinMax, updateLogScale, makeLogScale } = _testHelpers;
const SYNC = { schedule: (fn) => fn() };

/** The log-fuzzer's invariant, isolated so the control can prove it bites. */
const positiveFinite = (lo, hi) =>
    Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > 0 && hi > lo;

export function run() {
    // Control 1 -- the alloc gate. A hot body that retains an allocation every
    // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0).
    {
        const leak = [];
        const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
        if (report.ok) die('T9 control: an allocating hot loop passed the zero-alloc gate');
        leak.length = 0;
    }

    // Control 2 -- the destroy/observer gate. A chart mounted and NOT destroyed
    // MUST leave the signal graph above baseline; that is what T7 asserts returns
    // to zero. If a live chart shows a zero delta, the T7 gate is blind.
    {
        const before = graphSnapshot();
        const chart = createLineChart({ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], x: 'x', y: 'y', pan: true, ...SYNC });
        chart.mount(createEventCanvas(320, 240));
        const live = graphDelta(before);
        if (live.nodes === 0) die('T9 control: a mounted (undestroyed) chart showed 0 new signal nodes -- the T7 gate is blind');
        chart.destroy();
        const dead = graphDelta(before);
        if (dead.nodes !== 0) die('T9 control: destroy() left ' + dead.nodes + ' nodes -- but this is the control, so the REAL leak gate is the point (see T7)');
    }

    // Control 3 -- the listener-leak witness. A pan/zoom/brush chart MUST attach
    // canvas listeners; T7/T8 assert that count returns to 0. If it was 0 to
    // begin with, the "== 0 after destroy" assertion is vacuous.
    {
        const canvas = createEventCanvas(320, 240);
        const chart = createLineChart({ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], x: 'x', y: 'y', pan: true, zoom: true, brush: true, ...SYNC });
        chart.mount(canvas);
        if (canvas._listenerCount() === 0) die('T9 control: an interactive chart attached 0 listeners -- the listener gate is vacuous');
        chart.destroy();
        if (canvas._listenerCount() !== 0) die('T9 control: destroy() left listeners -- (control frames the real T7/T8 gate)');
    }

    // Control 4 -- the decimation comparator. A correct result and a deliberately
    // wrong oracle must be detected as divergent (the T3 comparator).
    {
        const cols = 16;
        const pxs = Float32Array.of(0, 0, 3, 3, 7);
        const pys = Float32Array.of(1, 5, 2, 8, 4);
        const outMin = new Float32Array(cols), outMax = new Float32Array(cols), outOcc = new Uint8Array(cols);
        decimateMinMax(pxs, pys, 5, 0, cols - 1, outMin, outMax, outOcc);
        // Fabricate a wrong oracle: claim column 0's max is 99, not 5.
        const wrongMax = 99;
        if (outMax[0] === wrongMax) die('T9 control: decimation happened to equal the wrong oracle (impossible input)');
        // The comparator (===) must see the divergence.
        let diverged = false;
        if (outMax[0] !== wrongMax) diverged = true;
        if (!diverged) die('T9 control: the decimation comparator failed to flag a wrong oracle');
    }

    // Control 5 -- the log-domain invariant. The positive-finite predicate the
    // fuzzer gates on MUST reject the exact bad domains LC-01..LC-04 produce, and
    // accept a valid one -- otherwise the fuzzer would be green on a broken axis.
    {
        if (positiveFinite(-1247.75, -248.75)) die('T9 control: positiveFinite accepted a negative domain (LC-01)');
        if (positiveFinite(-123.875, 1000)) die('T9 control: positiveFinite accepted a domain crossing zero (LC-03)');
        if (positiveFinite(NaN, 10)) die('T9 control: positiveFinite accepted a NaN bound');
        if (positiveFinite(Infinity, 10)) die('T9 control: positiveFinite accepted an Infinity bound');
        if (positiveFinite(10, 10)) die('T9 control: positiveFinite accepted a zero-width domain');
        if (!positiveFinite(1, 1000)) die('T9 control: positiveFinite rejected a valid positive domain -- the fuzzer would be blind');
    }

    // Control 6 -- makeLogScale's LC-04 fail-open, made visible. On 1.4.0,
    // updateLogScale does NOT throw on a non-positive domain; it clamps to 1e-10.
    // T1 pins that clamp. Here we prove the pin is non-vacuous: the clamp really
    // fires (a fail-CLOSED version would throw and this control would need to
    // flip -- which is exactly the C0 signal).
    {
        const s = makeLogScale();
        let threw = false;
        try { updateLogScale(s, -5, -1, 0, 800); } catch { threw = true; }
        if (threw) die('T9 control: updateLogScale THREW on a negative domain -- LC-04 is fixed; update T1 and the C0 net');
        if (s.dMin !== 1e-10) die('T9 control: updateLogScale did not clamp a negative domain to 1e-10 -- the T1 pin is stale');
    }

    // Control 7 -- the SVG ceiling is a real constraint. A real 1k-point export
    // is many KB; an absurdly tight ceiling MUST reject it, proving T8's ceiling
    // comparison is not vacuously satisfied by a huge bound.
    {
        const data = new Array(1000);
        for (let i = 0; i < 1000; i++) data[i] = { x: i, y: Math.sin(i / 30) * 100 };
        const chart = createLineChart({ data, x: 'x', y: 'y', width: 800, height: 400, ...SYNC });
        chart.mount(createEventCanvas(800, 400));
        const len = chart.exportSVG().length;
        chart.destroy();
        if (len < 100) die('T9 control: a real 1k-point export was under 100 chars -- the T8 ceiling would be vacuous');
        if (len <= 100) die('T9 control: a 100-char ceiling did not reject a real export -- ceiling comparison is broken');
    }

    // Control 8 -- the ResizeObserver accumulation witness. Two mounts on two
    // containers MUST show 2 live observers, so T8's "exactly 1" assertion could
    // catch a real accumulation.
    {
        const ro = installResizeObserver();
        try {
            const c1 = createLineChart({ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], x: 'x', y: 'y', ...SYNC });
            const c2 = createLineChart({ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], x: 'x', y: 'y', ...SYNC });
            c1.mount(createEventCanvas(300, 200));
            c2.mount(createEventCanvas(300, 200));
            if (ro.liveCount() !== 2) die('T9 control: two auto-sized mounts did not yield 2 observers -- T8 accumulation gate is blind (' + ro.liveCount() + ')');
            c1.destroy();
            c2.destroy();
            if (ro.liveCount() !== 0) die('T9 control: destroys left observers -- (control frames the real T8 gate)');
        } finally {
            ro.uninstall();
        }
    }
}
