/**
 * T-LOG -- the log-domain fuzzer. The C0 regression net.
 *
 * *** THIS TIER IS RED ON 1.4.0 BY DESIGN. It is NOT wired into `npm run torture`
 * (that gate must print "ok"); it runs via `npm run torture:logfuzz`. Per the
 * roadmap it must FAIL on 1.4.0 and PASS on 1.4.1 (finding C0 / LC-01..LC-04). ***
 *
 * On 1.4.0, `_applyPan` / `_applyZoom` do LINEAR arithmetic on the data domain
 * even for a log axis (see the comment above `_applyPan` in Charts.js), and
 * `updateLogScale` CLAMPS a non-positive domain to 1e-10 instead of throwing. So
 * a single drag or zoom notch on a log axis can walk a bound to zero or negative:
 *
 *     view {yMin: 1, yMax: 1000}, plotH 400
 *       drag  +50px  -> yMin 125.875   (log-correct: 2.371)   53x off
 *       drag -500px  -> yMin -1247.75  -> Math.log10 is NaN
 *       zoom  1.25x  -> yMin -123.875  -> one notch, negative domain
 *
 * This fuzzer drives seeded random pan/zoom gestures against the SAME math the
 * chart's pointer handlers call, and after every gesture asserts the resulting
 * y-domain is positive and finite -- the property a log axis must preserve. On
 * 1.4.0 it fails within a handful of gestures and prints the offending seed +
 * gesture so C0 can replay it; after C0 wires the log-aware branch it passes.
 *
 * Exit code: 0 = the invariant held (C0 has landed). Non-zero = a gesture
 * produced an invalid log domain (expected on 1.4.0). The runner reports which.
 */

import { _testHelpers } from '../../Charts.js';
import { makePrng, SEED } from './harness.mjs';

const { _applyPan, _applyZoom } = _testHelpers;

/** The invariant a log y-axis must preserve after any gesture. */
const positiveFinite = (lo, hi) =>
    Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > 0 && hi > lo;

/**
 * Run the fuzzer. Returns { ok, gesture, seed, view } -- ok=false means a gesture
 * produced a non-positive / non-finite log domain (the LC-01..LC-04 bug).
 */
export function fuzz(iterations) {
    const prng = makePrng(SEED);
    const frnd = (lo, hi) => lo + (prng() / 0xffffffff) * (hi - lo);
    const N = iterations || 10000;

    const plotW = 800, plotH = 400, plotLeft = 40, plotTop = 20;

    // A log y-axis spanning three decades; x is linear. Modelled with
    // `panBounds: 'free'` (a supported config), so no data-space clamp runs after
    // each gesture -- exactly the path in which the roadmap's `-1247.75 -> NaN`
    // occurs. Each post-gesture view is what the chart would feed straight to
    // `updateLogScale`, so "positive & finite here" == "makeLogScale never sees an
    // invalid domain". A log-AWARE pan/zoom (C0) operates in log-space and cannot
    // cross zero; the linear-space 1.4.0 math can, within a few gestures.
    let view = { xMin: 0, xMax: 1000, yMin: 1, yMax: 1000 };

    for (let i = 0; i < N; i++) {
        const kind = prng() % 2;
        let gesture;
        if (kind === 0) {
            const dx = frnd(-plotW, plotW);
            const dy = frnd(-plotH, plotH);
            view = _applyPan(view, dx, dy, plotW, plotH);
            gesture = `pan dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`;
        } else {
            const ax = frnd(plotLeft, plotLeft + plotW);
            const ay = frnd(plotTop, plotTop + plotH);
            const z = frnd(0.5, 2);
            view = _applyZoom(view, ax, ay, plotLeft, plotTop, plotW, plotH, z, z);
            gesture = `zoom ax=${ax.toFixed(1)} ay=${ay.toFixed(1)} z=${z.toFixed(3)}`;
        }

        if (!positiveFinite(view.yMin, view.yMax)) {
            return { ok: false, gesture, seed: SEED, iteration: i, view: { ...view } };
        }
    }
    return { ok: true, seed: SEED, iterations: N };
}
