/**
 * T3 -- decimation adversarial input.
 *
 * `decimateMinMax` is the downsample that keeps a 100k-point line readable at
 * pixel resolution: one [min,max] pair per pixel column. Its whole value is that
 * the RETAINED extrema equal the true extrema of the points in each column. A
 * bucketing bug (off-by-one column, a dropped edge point, min/max swapped) is
 * invisible in a smooth random scene and obvious under inputs designed to defeat
 * min/max bucketing.
 *
 * Each pattern is compared column-for-column against a naive independent scan,
 * and the naive scan is proven non-vacuous by T9's mismatch control. Patterns:
 *   - sawtooth at exactly the bucket period (aliasing bait)
 *   - a single spike per bucket (one extreme point must not be averaged away)
 *   - monotone ramp (every column's min/max are its first/last point)
 *   - all-equal (min == max, occupancy still set)
 *   - dense random (the smoke case, many points per column)
 *   - edge points exactly on colL / colR (inclusive-bound off-by-one bait)
 */

import { _testHelpers } from '../../Charts.js';
import { makePrng, SEED, check } from './harness.mjs';

const { decimateMinMax } = _testHelpers;

/** Naive reference: independent per-column min/max scan. Written from scratch. */
function oracle(pxs, pys, n, colL, colR) {
    const cols = (colR - colL + 1) | 0;
    const mn = new Float32Array(cols);
    const mx = new Float32Array(cols);
    const occ = new Uint8Array(cols);
    for (let c = 0; c < cols; c++) { mn[c] = Infinity; mx[c] = -Infinity; }
    for (let i = 0; i < n; i++) {
        const x = pxs[i];
        if (x < colL || x > colR) continue;
        const c = (x - colL) | 0;
        const y = pys[i];
        if (!occ[c]) { occ[c] = 1; mn[c] = y; mx[c] = y; }
        else { if (y < mn[c]) mn[c] = y; if (y > mx[c]) mx[c] = y; }
    }
    return { cols, mn, mx, occ };
}

/** Assert decimateMinMax matches the oracle exactly for a fixed input. */
function assertMatches(label, pxs, pys, n, colL, colR) {
    const ref = oracle(pxs, pys, n, colL, colR);
    const outMin = new Float32Array(ref.cols);
    const outMax = new Float32Array(ref.cols);
    const outOcc = new Uint8Array(ref.cols);
    const cols = decimateMinMax(pxs, pys, n, colL, colR, outMin, outMax, outOcc);
    check(cols === ref.cols, () => `T3.${label}: cols ${cols} != ${ref.cols} seed=${SEED}`);
    for (let c = 0; c < ref.cols; c++) {
        check(outOcc[c] === ref.occ[c],
            () => `T3.${label}: col ${c} occ ${outOcc[c]} != ${ref.occ[c]} seed=${SEED}`);
        if (ref.occ[c]) {
            check(outMin[c] === ref.mn[c] && outMax[c] === ref.mx[c],
                () => `T3.${label}: col ${c} [${outMin[c]},${outMax[c]}] != [${ref.mn[c]},${ref.mx[c]}] seed=${SEED}`);
        }
    }
    return { outMin, outMax, outOcc, cols };
}

export function run() {
    const prng = makePrng(SEED);
    const colL = 0, colR = 255, cols = 256;

    // --- sawtooth at exactly the bucket period --------------------------------
    // One rising then falling sample per column: aliasing bait. Every column must
    // still report the true local peak/trough.
    {
        const n = cols * 2;
        const pxs = new Float32Array(n), pys = new Float32Array(n);
        for (let c = 0; c < cols; c++) {
            pxs[2 * c] = c; pys[2 * c] = (c % 2 === 0) ? 100 : -100;
            pxs[2 * c + 1] = c; pys[2 * c + 1] = (c % 2 === 0) ? -50 : 50;
        }
        assertMatches('sawtooth', pxs, pys, n, colL, colR);
    }

    // --- a single spike per bucket, surrounded by flat noise ------------------
    // The spike is the one point a lossy downsample would drop; min/max must keep it.
    {
        const perCol = 8;
        const n = cols * perCol;
        const pxs = new Float32Array(n), pys = new Float32Array(n);
        let i = 0;
        for (let c = 0; c < cols; c++) {
            for (let k = 0; k < perCol; k++) {
                pxs[i] = c;
                pys[i] = (k === 3) ? 9999 : (prng() / 0xffffffff) * 2 - 1; // one spike, rest flat
                i++;
            }
        }
        const r = assertMatches('single-spike', pxs, pys, n, colL, colR);
        for (let c = 0; c < cols; c++) {
            check(r.outMax[c] === 9999,
                () => `T3.single-spike: col ${c} lost its spike (max ${r.outMax[c]}) seed=${SEED}`);
        }
    }

    // --- monotone ramp --------------------------------------------------------
    // With multiple ascending samples per column, min is the first, max the last.
    {
        const perCol = 4;
        const n = cols * perCol;
        const pxs = new Float32Array(n), pys = new Float32Array(n);
        let i = 0, y = 0;
        for (let c = 0; c < cols; c++) {
            for (let k = 0; k < perCol; k++) { pxs[i] = c; pys[i] = y++; i++; }
        }
        const r = assertMatches('monotone', pxs, pys, n, colL, colR);
        for (let c = 0; c < cols; c++) {
            check(r.outMin[c] === c * perCol && r.outMax[c] === c * perCol + perCol - 1,
                () => `T3.monotone: col ${c} extrema wrong seed=${SEED}`);
        }
    }

    // --- all-equal ------------------------------------------------------------
    // min === max, occupancy still set. A downsample that special-cases equal
    // values (skips, NaNs) breaks here.
    {
        const n = cols * 3;
        const pxs = new Float32Array(n), pys = new Float32Array(n);
        for (let i = 0; i < n; i++) { pxs[i] = (i / 3) | 0; pys[i] = 42; }
        const r = assertMatches('all-equal', pxs, pys, n, colL, colR);
        for (let c = 0; c < cols; c++) {
            check(r.outOcc[c] === 1 && r.outMin[c] === 42 && r.outMax[c] === 42,
                () => `T3.all-equal: col ${c} not [42,42] seed=${SEED}`);
        }
    }

    // --- edge points exactly on colL and colR (inclusive-bound bait) ----------
    // The bounds are inclusive (x < colL || x > colR skips). A point AT colL or
    // colR must land in the first / last column, and one just outside must not.
    {
        const n = 6;
        const pxs = Float32Array.of(colL, colR, colL - 1, colR + 1, colL, colR);
        const pys = Float32Array.of(1, 2, 3, 4, -1, -2);
        const r = assertMatches('edges', pxs, pys, n, colL, colR);
        check(r.outOcc[0] === 1 && r.outMin[0] === -1 && r.outMax[0] === 1,
            () => `T3.edges: colL bucket wrong [${r.outMin[0]},${r.outMax[0]}] seed=${SEED}`);
        check(r.outOcc[cols - 1] === 1 && r.outMin[cols - 1] === -2 && r.outMax[cols - 1] === 2,
            () => `T3.edges: colR bucket wrong seed=${SEED}`);
    }

    // --- dense random, many periods (the differential smoke) ------------------
    {
        const n = 4096;
        const pxs = new Float32Array(n), pys = new Float32Array(n);
        for (let round = 0; round < 40; round++) {
            for (let i = 0; i < n; i++) {
                pxs[i] = (prng() % (cols + 40)) - 20; // straddle both edges
                pys[i] = (prng() / 0xffffffff) * 2000 - 1000;
            }
            assertMatches('dense-' + round, pxs, pys, n, colL, colR);
        }
    }
}
