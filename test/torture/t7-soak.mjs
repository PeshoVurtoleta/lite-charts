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
    installCenterLabelDOM,
} from './harness.mjs';

const CYCLES = 4096;
const SYNC = { schedule: (fn) => fn() };
const NOOP = function () {};

/** The nine chart types, each with a small valid dataset and interactions on. */
const BUILDERS = [
    () => createLineChart({ data: [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }], x: 'x', y: 'y', pan: true, zoom: true, brush: true, ...SYNC }),
    () => createAreaChart({ data: [{ x: 0, y: 1 }, { x: 1, y: 3 }], x: 'x', y: 'y', pan: true, ...SYNC }),
    () => createBarChart({ data: [{ x: 'A', y: 1 }, { x: 'B', y: 3 }], ...SYNC }),
    // A13: horizontal orientation in the retention matrix (grouped, negatives,
    // rounded corners) -- must return the graph + listeners to zero every cycle.
    () => createBarChart({ series: [{ name: 'r', data: [{ x: 'A', y: 1 }, { x: 'B', y: 3 }, { x: 'C', y: -2 }] }, { name: 's', data: [{ x: 'A', y: 2 }, { x: 'B', y: 1 }, { x: 'C', y: 4 }] }], orientation: 'horizontal', cornerRadius: 4, ...SYNC }),
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

    // A6 -- centerLabel interposition retention (v1.5.0). The shared bare-canvas
    // mount has no DOM parent to host the overlay, so this donut path gets its
    // own DOM-backed loop rather than a BUILDERS entry. Each cycle must undo the
    // interposition fully: the labelHost detaches and the canvas is restored to
    // its container. A dedicated tracker witnesses the JS-object side; graphDelta
    // witnesses the signal side (centerLabel adds exactly one effect, disposed on
    // destroy).
    {
        const clTracker = createLeakTracker({ name: 'charts-centerlabel' });
        const dom = installCenterLabelDOM();
        try {
            for (let cyc = 0; cyc < CYCLES; cyc++) {
                const before = graphSnapshot();
                const { container, canvas } = dom.canvasInContainer(400, 400);
                const chart = createDonutChart({
                    data: [{ value: 1 }, { value: 2 }],
                    width: 400, height: 400,
                    centerLabel: { text: () => '1234', subLabel: 'total' },
                    legend: false, ...SYNC,
                });
                chart.mount(canvas);
                const labelHost = canvas.parentNode;    // interposed host
                const h = clTracker.track({ cycle: cyc }, NOOP, cyc);

                check(chart.centerLabel != null,
                    () => `A6: cycle ${cyc} centerLabel overlay missing`);
                check(labelHost !== container,
                    () => `A6: cycle ${cyc} labelHost was not interposed`);
                chart.redraw();
                if (typeof chart.exportSVG === 'function') chart.exportSVG();

                chart.destroy();
                clTracker.untrack(h);

                check(labelHost.parentNode === null,
                    () => `A6: cycle ${cyc} labelHost still attached after destroy`);
                check(canvas.parentNode === container,
                    () => `A6: cycle ${cyc} canvas not restored to its container`);
                const d = graphDelta(before);
                check(d.nodes === 0, () => `A6: cycle ${cyc} leaked ${d.nodes} signal nodes`);
                check(d.links === 0, () => `A6: cycle ${cyc} leaked ${d.links} signal links`);
            }
            check(clTracker.size() === 0,
                () => `A6: centerLabel tracker leaked ${clTracker.size()} resources`);
        } finally {
            dom.uninstall();
        }
    }

    // A6b -- the fail-closed centerLabel throw must leak ZERO signal nodes.
    // A rejected config throws at CONSTRUCTION, before mount, so destroy() is
    // never called; if the throw fired AFTER a `_own(signal())` (e.g. the
    // auto-size signals) those nodes would orphan in the registry. This is the
    // C0/LC-05 failure family. Auto-size mode (no width/height) is the case that
    // allocates signals earliest, so exercise exactly that.
    {
        for (let cyc = 0; cyc < 256; cyc++) {
            const before = graphSnapshot();
            let threw = false;
            try {
                // pie has no hole -> centerLabel must throw; no width/height ->
                // auto-size signals would be allocated first if the throw were late.
                createPieChart({ data: [{ value: 1 }, { value: 2 }], centerLabel: '42' });
            } catch (e) {
                threw = true;
            }
            check(threw, () => `A6b: cycle ${cyc} centerLabel-on-pie did not throw`);
            const d = graphDelta(before);
            check(d.nodes === 0,
                () => `A6b: cycle ${cyc} rejected centerLabel config leaked ${d.nodes} signal nodes`);
            check(d.links === 0,
                () => `A6b: cycle ${cyc} rejected centerLabel config leaked ${d.links} signal links`);
        }
    }

    // A6c -- the mount-time DOM-availability throw (centerLabel needs a parent to
    // interpose the overlay into) must fire at the TOP of mount(), BEFORE the
    // ResizeObserver / scene / Effects 1-5 are allocated. unmount() early-returns
    // on !mounted, so a late throw would strand all of them. Construction
    // succeeds; only mount() throws. Snapshot AFTER construction so the delta is
    // the mount attempt alone; destroy() disposes the construction signals
    // (supported pre-mount). (reviewer finding 3)
    {
        const dom = installCenterLabelDOM();   // makes globalThis.document defined
        try {
            for (let cyc = 0; cyc < 256; cyc++) {
                const chart = createDonutChart({
                    data: [{ value: 1 }, { value: 2 }], width: 300, height: 300,
                    innerRadius: 0.5, centerLabel: '42', legend: false, ...SYNC,
                });
                const before = graphSnapshot();   // AFTER construction
                let threw = false;
                try {
                    // tagName CANVAS + no parentNode -> nothing to host the overlay.
                    chart.mount({ tagName: 'CANVAS', parentNode: null });
                } catch (e) {
                    threw = true;
                }
                check(threw, () => `A6c: cycle ${cyc} parentless centerLabel mount did not throw`);
                const d = graphDelta(before);
                check(d.nodes === 0,
                    () => `A6c: cycle ${cyc} failed mount stranded ${d.nodes} signal nodes`);
                check(d.links === 0,
                    () => `A6c: cycle ${cyc} failed mount stranded ${d.links} signal links`);
                chart.destroy();   // dispose the construction signals (never mounted)
            }
        } finally {
            dom.uninstall();
        }
    }

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
