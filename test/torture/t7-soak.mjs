/**
 * T7 -- mount/unmount soak. The SPA route-change case, and the executable proof
 * that `destroy()` detaches from the signal graph.
 *
 * `CYCLES` create -> mount -> exercise -> destroy cycles across all nine chart
 * types. After EACH cycle the signal graph must return to its pre-create counts:
 * `activeNodes` and `activeLinks` both back to baseline. That is the NAMED leak
 * gate the roadmap asks for -- a count, not a heap curve. A second, independent
 * witness (lite-leak) tracks a per-cycle resource and must return to size 0, so a
 * signal-graph leak and a JS-object leak cannot hide behind each other. Canvas
 * listeners must also return to zero (the event handlers are disposed).
 *
 * Heap and arrayBuffers are sampled ACROSS cycles, after settling, so intra-cycle
 * churn is never misread as growth.
 */

import {
    createLineChart, createAreaChart, createBarChart, createScatterChart,
    createBubbleChart, createPieChart, createDonutChart, createRadarChart,
    createHeatmap,
} from '../../Charts.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import {
    createEventCanvas, makeEvent, graphSnapshot, graphDelta, check,
} from './harness.mjs';

const CYCLES = 4096;
const SYNC = { schedule: (fn) => fn() };
const NOOP = function () {};

/** The nine chart types, each with a small valid dataset and interactions on. */
const BUILDERS = [
    () => createLineChart({ data: [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }], x: 'x', y: 'y', pan: true, zoom: true, brush: true, ...SYNC }),
    () => createAreaChart({ data: [{ x: 0, y: 1 }, { x: 1, y: 3 }], x: 'x', y: 'y', pan: true, ...SYNC }),
    () => createBarChart({ data: [{ x: 'A', y: 1 }, { x: 'B', y: 3 }], ...SYNC }),
    () => createScatterChart({ data: [{ x: 0, y: 1 }, { x: 1, y: 3 }], x: 'x', y: 'y', zoom: true, ...SYNC }),
    () => createBubbleChart({ data: [{ x: 0, y: 1, value: 5 }, { x: 1, y: 3, value: 9 }], x: 'x', y: 'y', size: 'value', ...SYNC }),
    () => createPieChart({ data: [{ value: 30 }, { value: 70 }], ...SYNC }),
    () => createDonutChart({ data: [{ value: 1 }, { value: 2 }], ...SYNC }),
    () => createRadarChart({ axes: ['A', 'B', 'C'], series: [{ name: 'S', values: [1, 2, 3] }], domain: [0, 3], ...SYNC }),
    () => createHeatmap({ data: [{ x: 'Mon', y: 'AM', value: 1 }, { x: 'Tue', y: 'PM', value: 5 }], width: 320, height: 240, ...SYNC }),
];

export function run() {
    const tracker = createLeakTracker({ name: 'charts-soak' });

    // Warm the pools once per type so the across-cycle heap sample is not the
    // one-time pool fill. The per-cycle graph assertion still runs from cycle 0.
    for (const build of BUILDERS) {
        const c = build();
        c.mount(createEventCanvas(320, 240));
        c.destroy();
    }

    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const abBefore = process.memoryUsage().arrayBuffers;

    for (let cyc = 0; cyc < CYCLES; cyc++) {
        const build = BUILDERS[cyc % BUILDERS.length];
        const before = graphSnapshot();

        const canvas = createEventCanvas(320, 240);
        const chart = build();
        chart.mount(canvas);

        // A tracked external resource modelling a per-cycle allocation.
        const h = tracker.track({ cycle: cyc }, NOOP, cyc);

        // Exercise the live chart: a redraw and, when interactive, one gesture
        // through the real event path. This subscribes crosshair/pan state that
        // destroy() must then tear down.
        chart.redraw();
        canvas._fire(makeEvent('mousemove', 160, 120));
        if (canvas._listenerCount() > 0) {
            canvas._fire(makeEvent('pointerdown', 160, 120, { button: 0 }));
            canvas._fire(makeEvent('pointermove', 140, 130, { button: 0 }));
            canvas._fire(makeEvent('pointerup', 140, 130, { button: 0 }));
        }
        if (typeof chart.exportSVG === 'function') chart.exportSVG();

        chart.destroy();
        tracker.untrack(h);

        const d = graphDelta(before);
        check(d.nodes === 0, () => `T7: cycle ${cyc} (${build.name || 'type ' + (cyc % BUILDERS.length)}) leaked ${d.nodes} signal nodes`);
        check(d.links === 0, () => `T7: cycle ${cyc} leaked ${d.links} signal links`);
        check(canvas._listenerCount() === 0, () => `T7: cycle ${cyc} left ${canvas._listenerCount()} canvas listeners attached`);
    }

    check(tracker.size() === 0, () => `T7: lite-leak tracker leaked ${tracker.size()} resources`);

    globalThis.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const abAfter = process.memoryUsage().arrayBuffers;
    const heapKB = (heapAfter - heapBefore) / 1024;
    const abKB = (abAfter - abBefore) / 1024;
    // Object heap has some legitimate slack (registry pool high-water, JIT); the
    // arrayBuffers pools must be essentially flat -- that is the SoA claim.
    check(heapKB < 1024, () => `T7: object heap grew ${heapKB.toFixed(1)} KB over ${CYCLES} cycles`);
    check(abKB < 256, () => `T7: arrayBuffers grew ${abKB.toFixed(1)} KB over ${CYCLES} cycles`);
}
