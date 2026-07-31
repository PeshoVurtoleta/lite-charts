/**
 * T8 -- export bound + resize storm.
 *
 * TWO charts-native stress properties:
 *
 * 1. exportSVG size bound. `exportSVG` is synchronous string building, so the
 *    roadmap's worry is a 1M-point export being an allocation bomb "by
 *    construction". The executable answer: decimation caps the exported markup at
 *    PIXEL-COLUMN resolution, so the output size is bounded by canvas WIDTH, not
 *    point count. We pin two committed facts -- an absolute ceiling, and the
 *    non-scaling property (100k and 1M points export no larger than ~1k points).
 *    A regression that started emitting one path segment per raw point would blow
 *    both and is otherwise invisible.
 *
 * 2. Resize storm. 10k ResizeObserver callbacks -- including zero-width,
 *    sub-pixel, and rapid oscillation between two sizes -- the case a chart in a
 *    flex layout receives in the wild. Assert: no observer accumulation (exactly
 *    one stays connected), no re-entrant throw, the signal graph returns to
 *    baseline on destroy, and arrayBuffers is flat across the storm.
 */

import { createLineChart } from '../../Charts.js';
import {
    createEventCanvas, quietCanvas, installResizeObserver, graphSnapshot, graphDelta, check, die,
} from './harness.mjs';

const SYNC = { schedule: (fn) => fn() };

/** Committed absolute ceiling for a default-width (800px) line-chart export. */
const SVG_CEIL = 32000;

export function run() {
    // --- 1. exportSVG size bound ---------------------------------------------
    // Columnar (typed) data so 1M points is ~8 MB of Float64, not an array of a
    // million objects (which OOMs the default heap before exportSVG is reached).
    // A 1M-point telemetry series arrives columnar in the wild anyway.
    const lenAt = (n) => {
        const xs = new Float64Array(n), ys = new Float64Array(n);
        for (let i = 0; i < n; i++) { xs[i] = i; ys[i] = Math.sin(i / 50) * 100; }
        const chart = createLineChart({ data: { xs, ys }, width: 800, height: 400, ...SYNC });
        chart.mount(createEventCanvas(800, 400));
        const len = chart.exportSVG().length;
        chart.destroy();
        return len;
    };
    const l1k = lenAt(1000);
    const l100k = lenAt(100000);
    const l1m = lenAt(1000000);

    check(l1k < SVG_CEIL && l100k < SVG_CEIL && l1m < SVG_CEIL,
        () => `T8.svg-ceil: export exceeded ${SVG_CEIL} (1k=${l1k}, 100k=${l100k}, 1M=${l1m})`);
    // The load-bearing property: output does NOT scale with point count. If it
    // did, 1M points would dwarf 1k. Allow generous slack for axis/tick variance.
    check(l100k <= l1k * 1.5 && l1m <= l1k * 1.5,
        () => `T8.svg-scaling: export grew with point count (1k=${l1k}, 100k=${l100k}, 1M=${l1m}) -- decimation bypassed?`);

    // --- 2. resize storm ------------------------------------------------------
    const ro = installResizeObserver();
    try {
        const before = graphSnapshot();
        // Omit width/height so _wireAutoSize observes the container.
        const canvas = createEventCanvas(400, 300);
        const chart = createLineChart({ data: [{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 2 }, { x: 3, y: 8 }], x: 'x', y: 'y', ...SYNC });
        chart.mount(canvas);
        // 10k resizes each re-draw; a recording context would grow `calls`
        // without bound and OOM. Silence it -- this tier gates buffers, not calls.
        quietCanvas(canvas);

        check(ro.liveCount() === 1,
            () => `T8.resize: expected exactly 1 ResizeObserver after mount, got ${ro.liveCount()}`);

        globalThis.gc();
        const abBefore = process.memoryUsage().arrayBuffers;

        const container = canvas._container;
        for (let i = 0; i < 10000; i++) {
            // Adversarial size stream: oscillation, zero-width, sub-pixel.
            const m = i % 4;
            if (m === 0) { container.clientWidth = 640; container.clientHeight = 480; }
            else if (m === 1) { container.clientWidth = 320; container.clientHeight = 240; }
            else if (m === 2) { container.clientWidth = 0; container.clientHeight = 0; }       // zero -> ignored
            else { container.clientWidth = 500.5; container.clientHeight = 300.25; }            // sub-pixel
            ro.fire();
            check(ro.liveCount() === 1,
                () => `T8.resize: observer accumulation at fire ${i} -- ${ro.liveCount()} live`);
        }

        globalThis.gc();
        const abKB = (process.memoryUsage().arrayBuffers - abBefore) / 1024;
        check(abKB < 128, () => `T8.resize: arrayBuffers grew ${abKB.toFixed(1)} KB over 10k resizes`);

        chart.destroy();
        check(ro.liveCount() === 0, () => `T8.resize: destroy() left ${ro.liveCount()} observers connected`);
        check(canvas._listenerCount() === 0, () => `T8.resize: destroy() left ${canvas._listenerCount()} listeners`);
        const d = graphDelta(before);
        check(d.nodes === 0 && d.links === 0,
            () => `T8.resize: destroy() leaked ${d.nodes} nodes / ${d.links} links after the storm`);
    } catch (err) {
        ro.uninstall();
        if (/^torture:/.test(String(err))) throw err;
        die('T8.resize: uncontrolled throw during resize storm -- ' + (err && err.stack || err));
    }
    ro.uninstall();
}
