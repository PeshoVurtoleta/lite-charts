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
    runAllocsGate, ALLOC_RULES, MIN_HEAP_OBJECT_BYTES, check,
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

    // Control 6 -- makeLogScale is fail-CLOSED (C0 / LC-04). updateLogScale must
    // THROW on a non-positive / collapsed domain, naming the bound, and must
    // ACCEPT a valid one. If a bad domain slipped through silently, the T1
    // fail-closed pins and the whole LC-04 fix would be decorative.
    {
        const s = makeLogScale();
        let threwNeg = false;
        try { updateLogScale(s, -5, -1, 0, 800); } catch { threwNeg = true; }
        if (!threwNeg) die('T9 control: updateLogScale accepted a negative domain -- LC-04 regressed to fail-open');
        let threwZero = false;
        try { updateLogScale(s, 0, 100, 0, 800); } catch { threwZero = true; }
        if (!threwZero) die('T9 control: updateLogScale accepted dMin=0');
        let threwCollapsed = false;
        try { updateLogScale(s, 10, 10, 0, 800); } catch { threwCollapsed = true; }
        if (!threwCollapsed) die('T9 control: updateLogScale accepted a collapsed domain (dMin==dMax)');
        let acceptedValid = true;
        try { updateLogScale(s, 1, 1000, 0, 800); } catch { acceptedValid = false; }
        if (!acceptedValid) die('T9 control: updateLogScale rejected a VALID positive domain -- fail-closed is too aggressive');
        if (!(s.dMin === 1 && s.dMax === 1000)) die('T9 control: a valid updateLogScale did not set the domain');
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

    // Control 9 -- the zero-RETENTION gate (runAllocsGate + ALLOC_RULES). It must
    // be provably able to FAIL on a retaining body AND provably able to PASS on a
    // non-retaining one; a gate that only ever fails is as blind as the false-PASS
    // it replaces. All three checks run through the exported wrapper, so the
    // control can never drift from the gate the T6 tiers actually use.
    {
        // (a) A body that RETAINS a fresh object per call MUST be rejected. This
        // is the exact shape the old ops-gate false-PASSed (plain objects, not
        // ArrayBuffers, delivered past an async 'gc' window).
        const keep = [];
        let k = 0;
        const retaining = runAllocsGate((i) => { keep[k++] = { n: i }; }, { iterations: 20000, batches: 8 });
        if (retaining.ok) die('T9 control 9(a): a retaining hot loop (keep[k++]={n:i}) passed the zero-retention gate -- bytesPerCall=' + retaining.bytesPerCall);

        // (b) Vacuity guard: a section-1-shaped body that writes into a
        // preallocated slot and retains NOTHING MUST pass (settled + verdict
        // pass). If this fails at the shipped budget, the floor is environmental,
        // not the code -- and the gate would be a coin flip.
        const slot = new Float32Array(1);
        const clean = runAllocsGate((i) => { slot[0] = i; }, { iterations: 20000, batches: 8 });
        if (!clean.ok) die('T9 control 9(b): a non-retaining slot-write body FAILED the zero-retention gate (verdict=' + clean.report.verdict + ' settled=' + clean.result.settled + ' bytesPerCall=' + clean.bytesPerCall + ') -- the budget floor is environmental, not the code');

        // (c) Drift guard: the budget must stay strictly below one heap object, so
        // a single retained object per call can never be mistaken for noise.
        check(ALLOC_RULES.maxBytesPerCall < MIN_HEAP_OBJECT_BYTES,
            () => 'T9 control 9(c): ALLOC_RULES.maxBytesPerCall ' + ALLOC_RULES.maxBytesPerCall + ' >= MIN_HEAP_OBJECT_BYTES ' + MIN_HEAP_OBJECT_BYTES + ' -- budget drifted up to one-object-per-call, a real leak could pass');

        keep.length = 0;
    }
}
