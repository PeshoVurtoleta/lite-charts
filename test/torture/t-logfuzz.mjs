/**
 * T-LOG -- the log-domain fuzzer. The C0 regression net.
 *
 * HISTORY: this tier is RED on 1.4.0 and GREEN on 1.4.1. On 1.4.0 the log-axis
 * pan/zoom handler used the LINEAR `_applyPan` / `_applyZoom` (the only pair that
 * existed) and `updateLogScale` clamped a non-positive domain to 1e-10 instead of
 * throwing, so a single drag or zoom notch could walk a bound to zero or negative:
 *
 *     view {yMin: 1, yMax: 1000}, plotH 400
 *       drag  +50px  -> yMin 125.875   (log-correct: 2.371)   53x off
 *       drag -500px  -> yMin -1247.75  -> Math.log is NaN
 *       zoom  1.25x  -> yMin -123.875  -> one notch, negative domain
 *
 * C0 (v1.4.1) added `_applyPanLog` / `_applyZoomLog` (log-space math, per-axis)
 * plus a log-axis floor, and made `updateLogScale` fail closed. This fuzzer drives
 * seeded random pan/zoom gestures against those log helpers -- the SAME math the
 * chart's log-axis handler now calls -- and after every gesture asserts the
 * y-domain stays positive and finite. It passes on 1.4.1 and is wired into the
 * green `npm run torture` gate (as tier T-LOG); it is ALSO runnable standalone via
 * `npm run torture:logfuzz` for the historical before/after check.
 *
 * If the log helpers are ever removed (a C0 revert), `fuzz()` returns `ok:false`
 * with a `reason`, so both the gate tier and the standalone runner go red again.
 */

import { _testHelpers } from '../../Charts.js';
import { makePrng, SEED, die } from './harness.mjs';

// C0 wired the log-aware branch; the chart's log-axis pan/zoom handler now calls
// these. Before C0 this file imported the LINEAR `_applyPan`/`_applyZoom` (the
// only pair that existed) and went red within a gesture -- that was the finding.
const { _applyPanLog, _applyZoomLog } = _testHelpers;
const HAS_LOG_MATH = typeof _applyPanLog === 'function' && typeof _applyZoomLog === 'function';

/** The invariant a log y-axis must preserve after any gesture. */
const positiveFinite = (lo, hi) =>
    Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > 0 && hi > lo;

/**
 * Run the fuzzer. Returns { ok, gesture, seed, view } -- ok=false means a gesture
 * produced a non-positive / non-finite log domain (the LC-01..LC-04 bug).
 */
export function fuzz(iterations) {
    if (!HAS_LOG_MATH) {
        return {
            ok: false, gesture: 'n/a', seed: SEED, iteration: -1,
            view: { yMin: NaN, yMax: NaN },
            reason: 'C0 has not landed: _applyPanLog / _applyZoomLog are not exported. ' +
                'On 1.4.0 the log-axis handler uses linear math (LC-01..04) and this net is red.',
        };
    }
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

    // Linear x, log y -- the mixed case, which is where an axis-coupled shortcut
    // fails. xLog=false / yLog=true.
    for (let i = 0; i < N; i++) {
        const kind = prng() % 2;
        let gesture;
        if (kind === 0) {
            const dx = frnd(-plotW, plotW);
            const dy = frnd(-plotH, plotH);
            view = _applyPanLog(view, dx, dy, plotW, plotH, false, true);
            gesture = `pan dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`;
        } else {
            const ax = frnd(plotLeft, plotLeft + plotW);
            const ay = frnd(plotTop, plotTop + plotH);
            const z = frnd(0.5, 2);
            view = _applyZoomLog(view, ax, ay, plotLeft, plotTop, plotW, plotH, z, z, false, true);
            gesture = `zoom ax=${ax.toFixed(1)} ay=${ay.toFixed(1)} z=${z.toFixed(3)}`;
        }

        if (!positiveFinite(view.yMin, view.yMax)) {
            return { ok: false, gesture, seed: SEED, iteration: i, view: { ...view } };
        }
    }
    return { ok: true, seed: SEED, iterations: N };
}

/** Tier entry for the green gate: fail closed if any gesture invalidates the domain. */
export function run() {
    const res = fuzz(10000);
    if (!res.ok) {
        die('T-LOG: log domain went invalid at gesture ' + res.iteration +
            ' (' + res.gesture + ') -> yMin=' + res.view.yMin + ' yMax=' + res.view.yMax +
            (res.reason ? ' -- ' + res.reason : '') +
            '\n  replay: TORTURE_SEED=' + res.seed + ' node --expose-gc test/torture-logfuzz.mjs');
    }
}
