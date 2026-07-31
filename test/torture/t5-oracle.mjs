/**
 * T5 -- differential oracle. Chart state after N operations must equal a chart
 * rebuilt from scratch with the same FINAL inputs: same scales, same view, same
 * pixels (exportSVG is the pixel witness -- it walks the live scene tree, so
 * byte-identical SVG means byte-identical paint).
 *
 * Two properties, over a seeded corpus of random gestures:
 *
 *   1. Path independence. A chart driven to a final view V by a random walk of
 *      setView calls must be indistinguishable from a chart given only V. History
 *      must leave NO residue in the scales or the scene.
 *   2. Reset idempotence. A chart put through an arbitrary walk and then
 *      resetView()'d must equal a pristine chart -- the domain returns exactly to
 *      the data extents, no drift.
 *
 * Because the oracle is a from-scratch rebuild, "driven == rebuilt" is exactly
 * the guarantee an app relies on when it restores a saved view or resets a zoom.
 * On divergence the seed and op index print for replay.
 */

import { createLineChart } from '../../Charts.js';
import { createEventCanvas, makePrng, SEED, check } from './harness.mjs';

const SYNC = { schedule: (fn) => fn() };
const N = 200;

function makeData() {
    const d = new Array(N);
    for (let i = 0; i < N; i++) d[i] = { x: i, y: Math.sin(i / 9) * 40 + Math.cos(i / 4) * 12 };
    return d;
}

function build(data) {
    const chart = createLineChart({ data, x: 'x', y: 'y', pan: true, zoom: true, ...SYNC });
    chart.mount(createEventCanvas(800, 400));
    return chart;
}

export function run() {
    const prng = makePrng(SEED);
    const frnd = (lo, hi) => lo + (prng() / 0xffffffff) * (hi - lo);
    const data = makeData();

    // A random view within a comfortable envelope around the data domain.
    const randomView = () => {
        const x0 = frnd(-20, 180), x1 = x0 + frnd(1, 120);
        const y0 = frnd(-80, 40), y1 = y0 + frnd(1, 120);
        return { xMin: x0, xMax: x1, yMin: y0, yMax: y1 };
    };

    for (let trial = 0; trial < 300; trial++) {
        const finalV = randomView();

        // 1. Path independence: walk to finalV vs jump to finalV.
        const walked = build(data);
        const walkLen = 1 + (prng() % 6);
        for (let k = 0; k < walkLen; k++) walked.setView(randomView());
        walked.setView(finalV);

        const jumped = build(data);
        jumped.setView(finalV);

        check(walked.xScale.dMin === jumped.xScale.dMin && walked.xScale.dMax === jumped.xScale.dMax,
            () => `T5.path: trial ${trial} xScale diverged walked[${walked.xScale.dMin},${walked.xScale.dMax}] jumped[${jumped.xScale.dMin},${jumped.xScale.dMax}] seed=${SEED}`);
        check(walked.yScale.dMin === jumped.yScale.dMin && walked.yScale.dMax === jumped.yScale.dMax,
            () => `T5.path: trial ${trial} yScale diverged seed=${SEED}`);
        check(walked.exportSVG() === jumped.exportSVG(),
            () => `T5.path: trial ${trial} exportSVG diverged for identical final view seed=${SEED}`);

        walked.destroy();
        jumped.destroy();

        // 2. Reset idempotence: walk + resetView == pristine.
        const churned = build(data);
        const churnLen = 1 + (prng() % 8);
        for (let k = 0; k < churnLen; k++) churned.setView(randomView());
        churned.resetView();

        const pristine = build(data);

        check(churned.xScale.dMin === pristine.xScale.dMin && churned.xScale.dMax === pristine.xScale.dMax &&
              churned.yScale.dMin === pristine.yScale.dMin && churned.yScale.dMax === pristine.yScale.dMax,
            () => `T5.reset: trial ${trial} scales did not return to data domain after resetView seed=${SEED}`);
        check(churned.exportSVG() === pristine.exportSVG(),
            () => `T5.reset: trial ${trial} resetView did not restore the pristine scene seed=${SEED}`);

        churned.destroy();
        pristine.destroy();
    }
}
