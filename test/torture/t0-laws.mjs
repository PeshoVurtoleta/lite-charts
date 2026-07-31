/**
 * T0 -- metamorphic laws for the chart kernels.
 *
 * Properties that must hold for ANY inputs, checked over a seeded corpus. These
 * are the axis-kernel invariants a renderer relies on but never re-checks:
 * scales round-trip, they are monotone and endpoint-pinned, decimation preserves
 * the extrema a min/max downsample exists to keep, the pan/zoom math is
 * invertible and anchor-preserving, and `_clampToBounds` keeps a view inside its
 * data domain. A break here is a wrong pixel, silently.
 *
 * Pure `_testHelpers` math -- no chart instance, no canvas. On failure the seed
 * prints so the exact corpus replays with `TORTURE_SEED=... npm run torture`.
 */

import { _testHelpers } from '../../Charts.js';
import { makePrng, SEED, check } from './harness.mjs';

const {
    makeLinearScale, updateLinearScale,
    makeLogScale, updateLogScale,
    decimateMinMax, _clampToBounds, _applyPan, _applyZoom, niceYDomain,
    _applyPanLog, _applyZoomLog,
} = _testHelpers;

const REL = 1e-9;   // relative epsilon for float round-trips
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6) * (1 + Math.abs(a) + Math.abs(b));

export function run() {
    const prng = makePrng(SEED);
    const frnd = (lo, hi) => lo + (prng() / 0xffffffff) * (hi - lo);

    // --- Law 1: linear scale round-trips. invert(map(v)) == v -----------------
    {
        const s = makeLinearScale('linear');
        for (let t = 0; t < 4000; t++) {
            const dMin = frnd(-1e4, 1e4);
            const dMax = dMin + frnd(1e-3, 1e4); // strictly > dMin
            updateLinearScale(s, dMin, dMax, 0, frnd(1, 2000));
            const v = frnd(dMin, dMax);
            const back = s.invert(s.map(v));
            check(near(back, v, REL),
                () => `T0.linear-roundtrip: v=${v} -> ${back} (dom [${dMin},${dMax}]) seed=${SEED}`);
        }
    }

    // --- Law 2: linear scale is monotone and endpoint-pinned ------------------
    {
        const s = makeLinearScale('linear');
        for (let t = 0; t < 2000; t++) {
            const dMin = frnd(-1e3, 1e3);
            const dMax = dMin + frnd(1e-2, 1e3);
            const rMin = 0, rMax = frnd(1, 1000);
            updateLinearScale(s, dMin, dMax, rMin, rMax);
            check(near(s.map(dMin), rMin) && near(s.map(dMax), rMax),
                () => `T0.linear-endpoints: map(dMin)=${s.map(dMin)} rMin=${rMin} seed=${SEED}`);
            const a = frnd(dMin, dMax), b = frnd(dMin, dMax);
            const lo = Math.min(a, b), hi = Math.max(a, b);
            check(s.map(lo) <= s.map(hi) + 1e-6,
                () => `T0.linear-monotone: map not monotone at [${lo},${hi}] seed=${SEED}`);
        }
    }

    // --- Law 3: log scale round-trips for v > 0 -------------------------------
    {
        const s = makeLogScale();
        for (let t = 0; t < 4000; t++) {
            const dMin = frnd(1e-6, 1e3);
            const dMax = dMin * frnd(1.001, 1e6); // positive, > dMin, spanning decades
            updateLogScale(s, dMin, dMax, 0, frnd(1, 2000));
            const v = Math.exp(frnd(Math.log(dMin), Math.log(dMax)));
            const back = s.invert(s.map(v));
            check(near(back, v, 1e-6),
                () => `T0.log-roundtrip: v=${v} -> ${back} (dom [${dMin},${dMax}]) seed=${SEED}`);
            // map(v) is NaN for v <= 0 (documented contract, not -Infinity leaking).
            check(Number.isNaN(s.map(0)) && Number.isNaN(s.map(-v)),
                () => `T0.log-nonpositive: map(<=0) must be NaN, got ${s.map(0)}/${s.map(-v)} seed=${SEED}`);
        }
    }

    // --- Law 4: decimateMinMax preserves the global extrema -------------------
    // A min/max downsample exists to keep the per-column peaks. The overall min
    // and max y among in-range points MUST survive into some column, and every
    // column's [min,max] must bound exactly the points that fall in it. A naive
    // independent scan is the oracle.
    {
        const N = 512;
        const pxs = new Float32Array(N);
        const pys = new Float32Array(N);
        for (let t = 0; t < 200; t++) {
            const colL = (frnd(0, 100)) | 0;
            const cols = 1 + ((frnd(1, 300)) | 0);
            const colR = colL + cols - 1;
            for (let i = 0; i < N; i++) {
                pxs[i] = (frnd(colL - 20, colR + 20)) | 0; // some out of range
                pys[i] = frnd(-1000, 1000);
            }
            const outMin = new Float32Array(cols);
            const outMax = new Float32Array(cols);
            const outOcc = new Uint8Array(cols);
            const got = decimateMinMax(pxs, pys, N, colL, colR, outMin, outMax, outOcc);
            check(got === cols, () => `T0.decimate-cols: got ${got} expected ${cols} seed=${SEED}`);

            // Oracle: independent per-column scan.
            let gMin = Infinity, gMax = -Infinity, inRange = 0;
            for (let c = 0; c < cols; c++) {
                let mn = Infinity, mx = -Infinity, occ = 0;
                for (let i = 0; i < N; i++) {
                    const x = pxs[i];
                    if (x < colL || x > colR) continue;
                    if (((x - colL) | 0) !== c) continue;
                    occ = 1;
                    if (pys[i] < mn) mn = pys[i];
                    if (pys[i] > mx) mx = pys[i];
                }
                check((outOcc[c] === 1) === (occ === 1),
                    () => `T0.decimate-occ: col ${c} occ ${outOcc[c]} != oracle ${occ} seed=${SEED}`);
                if (occ) {
                    check(outMin[c] === mn && outMax[c] === mx,
                        () => `T0.decimate-extrema: col ${c} [${outMin[c]},${outMax[c]}] != [${mn},${mx}] seed=${SEED}`);
                    if (mn < gMin) gMin = mn;
                    if (mx > gMax) gMax = mx;
                    inRange++;
                }
            }
            if (inRange > 0) {
                // The global extrema must appear somewhere in the retained set.
                let sawMin = false, sawMax = false;
                for (let c = 0; c < cols; c++) {
                    if (outOcc[c] && outMin[c] === gMin) sawMin = true;
                    if (outOcc[c] && outMax[c] === gMax) sawMax = true;
                }
                check(sawMin && sawMax,
                    () => `T0.decimate-global: global extrema [${gMin},${gMax}] not retained seed=${SEED}`);
            }
        }
    }

    // --- Law 5: pan is invertible. pan by +d then -d returns the view ---------
    {
        for (let t = 0; t < 4000; t++) {
            const start = {
                xMin: frnd(-1e4, 1e4), xMax: 0, yMin: frnd(-1e4, 1e4), yMax: 0,
            };
            start.xMax = start.xMin + frnd(1, 1e4);
            start.yMax = start.yMin + frnd(1, 1e4);
            const W = frnd(50, 2000), H = frnd(50, 2000);
            const dx = frnd(-3000, 3000), dy = frnd(-3000, 3000);
            const mid = _applyPan(start, dx, dy, W, H);
            const back = _applyPan(mid, -dx, -dy, W, H);
            check(near(back.xMin, start.xMin, 1e-6) && near(back.xMax, start.xMax, 1e-6) &&
                  near(back.yMin, start.yMin, 1e-6) && near(back.yMax, start.yMax, 1e-6),
                () => `T0.pan-inverse: +d then -d did not return (seed=${SEED})`);
        }
    }

    // --- Law 6: zoom preserves the anchor. The data value under the cursor ----
    // pixel is unchanged after zooming (the property users actually notice).
    {
        for (let t = 0; t < 4000; t++) {
            const start = { xMin: frnd(-1e3, 1e3), xMax: 0, yMin: frnd(-1e3, 1e3), yMax: 0 };
            start.xMax = start.xMin + frnd(1, 1e3);
            start.yMax = start.yMin + frnd(1, 1e3);
            const W = frnd(50, 2000), H = frnd(50, 2000);
            const ax = frnd(0, W), ay = frnd(0, H);
            const z = frnd(0.1, 10);
            const tx = ax / W, ty = ay / H;
            const anchorX = start.xMin + tx * (start.xMax - start.xMin);
            const anchorY = start.yMax - ty * (start.yMax - start.yMin);
            const v = _applyZoom(start, ax, ay, 0, 0, W, H, z, z);
            const newX = v.xMin + tx * (v.xMax - v.xMin);
            const newY = v.yMax - ty * (v.yMax - v.yMin);
            check(near(newX, anchorX, 1e-6) && near(newY, anchorY, 1e-6),
                () => `T0.zoom-anchor: anchor moved x ${anchorX}->${newX} y ${anchorY}->${newY} seed=${SEED}`);
        }
    }

    // --- Law 7: _clampToBounds keeps a view inside its data domain ------------
    {
        for (let t = 0; t < 4000; t++) {
            const dataDom = { xMin: frnd(-1e3, 0), xMax: frnd(1, 1e3), yMin: frnd(-1e3, 0), yMax: frnd(1, 1e3) };
            const view = {
                xMin: frnd(-2e3, 2e3), xMax: 0, yMin: frnd(-2e3, 2e3), yMax: 0,
            };
            view.xMax = view.xMin + frnd(1, 3e3);
            view.yMax = view.yMin + frnd(1, 3e3);
            const vwBefore = view.xMax - view.xMin;
            const vhBefore = view.yMax - view.yMin;
            const dw = dataDom.xMax - dataDom.xMin;
            const dh = dataDom.yMax - dataDom.yMin;
            _clampToBounds(view, dataDom);
            const EPS = 1e-4 * (1 + dw + dh);
            if (vwBefore >= dw) {
                check(near(view.xMin, dataDom.xMin, 1e-4) && near(view.xMax, dataDom.xMax, 1e-4),
                    () => `T0.clamp-x-snap: wide view not snapped to data x seed=${SEED}`);
            } else {
                check(view.xMin >= dataDom.xMin - EPS && view.xMax <= dataDom.xMax + EPS,
                    () => `T0.clamp-x-inside: view [${view.xMin},${view.xMax}] escaped data x [${dataDom.xMin},${dataDom.xMax}] seed=${SEED}`);
                check(near(view.xMax - view.xMin, vwBefore, 1e-4),
                    () => `T0.clamp-x-width: clamp changed x width ${vwBefore}->${view.xMax - view.xMin} seed=${SEED}`);
            }
            if (vhBefore >= dh) {
                check(near(view.yMin, dataDom.yMin, 1e-4) && near(view.yMax, dataDom.yMax, 1e-4),
                    () => `T0.clamp-y-snap: wide view not snapped to data y seed=${SEED}`);
            } else {
                check(view.yMin >= dataDom.yMin - EPS && view.yMax <= dataDom.yMax + EPS,
                    () => `T0.clamp-y-inside: view escaped data y seed=${SEED}`);
                check(near(view.yMax - view.yMin, vhBefore, 1e-4),
                    () => `T0.clamp-y-width: clamp changed y width seed=${SEED}`);
            }
        }
    }

    // --- Law 8: niceYDomain always contains its input range -------------------
    {
        for (let t = 0; t < 2000; t++) {
            const a = frnd(-1e3, 1e3), b = frnd(-1e3, 1e3);
            const lo = Math.min(a, b), hi = Math.max(a, b);
            const [nlo, nhi] = niceYDomain(lo, hi, { nice: true });
            check(nlo <= lo + 1e-6 && nhi >= hi - 1e-6,
                () => `T0.nice-contains: [${nlo},${nhi}] does not contain [${lo},${hi}] seed=${SEED}`);
            // zero option pulls the baseline in when the range is one-sided.
            const [zlo, zhi] = niceYDomain(lo, hi, { zero: true });
            if (lo > 0) check(zlo <= 0 + 1e-9, () => `T0.nice-zero: positive range did not include 0 seed=${SEED}`);
            if (hi < 0) check(zhi >= 0 - 1e-9, () => `T0.nice-zero: negative range did not include 0 seed=${SEED}`);
        }
    }

    // === C0 log-aware pan/zoom laws ==========================================

    // --- Law 9: linear-path equivalence (hash parity). The log helpers with ---
    // both axes linear must be BYTE-identical to _applyPan / _applyZoom, so a
    // linear chart's behaviour cannot move now that a log branch exists.
    {
        for (let t = 0; t < 4000; t++) {
            const s = { xMin: frnd(-1e3, 1e3), xMax: 0, yMin: frnd(-1e3, 1e3), yMax: 0 };
            s.xMax = s.xMin + frnd(1, 1e3);
            s.yMax = s.yMin + frnd(1, 1e3);
            const W = frnd(50, 2000), H = frnd(50, 2000);
            const dx = frnd(-1e3, 1e3), dy = frnd(-1e3, 1e3);
            const a = _applyPan(s, dx, dy, W, H);
            const b = _applyPanLog(s, dx, dy, W, H, false, false);
            check(a.xMin === b.xMin && a.xMax === b.xMax && a.yMin === b.yMin && a.yMax === b.yMax,
                () => `T0.linear-parity-pan: _applyPanLog(...,false,false) != _applyPan seed=${SEED}`);
            const ax = frnd(0, W), ay = frnd(0, H), z = frnd(0.2, 5);
            const c = _applyZoom(s, ax, ay, 0, 0, W, H, z, z);
            const d = _applyZoomLog(s, ax, ay, 0, 0, W, H, z, z, false, false);
            check(c.xMin === d.xMin && c.xMax === d.xMax && c.yMin === d.yMin && c.yMax === d.yMax,
                () => `T0.linear-parity-zoom: _applyZoomLog(...,false,false) != _applyZoom seed=${SEED}`);
        }
    }

    // --- Law 10: log pan is invertible in log space (away from the floor) -----
    {
        for (let t = 0; t < 4000; t++) {
            const yMin = Math.exp(frnd(-6, 4));
            const yMax = yMin * Math.exp(frnd(0.5, 6)); // positive, spans decades
            const start = { xMin: 0, xMax: 1000, yMin, yMax };
            const W = frnd(100, 1500), H = frnd(100, 1500);
            const dy = frnd(-H * 0.4, H * 0.4); // moderate: never near the 1e300 floor
            const mid = _applyPanLog(start, 0, dy, W, H, false, true);
            const back = _applyPanLog(mid, 0, -dy, W, H, false, true);
            check(near(back.yMin, start.yMin, 1e-6) && near(back.yMax, start.yMax, 1e-6),
                () => `T0.log-pan-inverse: +d then -d did not return (yMin ${start.yMin} -> ${back.yMin}) seed=${SEED}`);
            // ... and every intermediate bound is strictly positive & finite.
            check(mid.yMin > 0 && mid.yMax > 0 && Number.isFinite(mid.yMax) && mid.yMax > mid.yMin,
                () => `T0.log-pan-positive: log pan produced [${mid.yMin},${mid.yMax}] seed=${SEED}`);
        }
    }

    // --- Law 11: log zoom preserves the anchor (in DATA space) ----------------
    {
        for (let t = 0; t < 4000; t++) {
            const yMin = Math.exp(frnd(-4, 2));
            const yMax = yMin * Math.exp(frnd(0.5, 5));
            const start = { xMin: 0, xMax: 1000, yMin, yMax };
            const W = 800, H = frnd(100, 1000);
            const ay = frnd(0, H), z = frnd(0.3, 3);
            const ty = ay / H;
            // Data value under the cursor before the zoom (log interpolation).
            const anchorLogY = Math.log(yMax) - ty * (Math.log(yMax) - Math.log(yMin));
            const anchorY = Math.exp(anchorLogY);
            const v = _applyZoomLog(start, 400, ay, 0, 0, W, H, z, z, false, true);
            const newLogY = Math.log(v.yMax) - ty * (Math.log(v.yMax) - Math.log(v.yMin));
            const newY = Math.exp(newLogY);
            check(near(newY, anchorY, 1e-6),
                () => `T0.log-zoom-anchor: anchor moved ${anchorY} -> ${newY} seed=${SEED}`);
            check(v.yMin > 0 && Number.isFinite(v.yMax) && v.yMax > v.yMin,
                () => `T0.log-zoom-positive: log zoom produced [${v.yMin},${v.yMax}] seed=${SEED}`);
        }
    }

    // --- Law 12: the decade law. Dragging d px on an n-decade axis multiplies --
    // both bounds by 10^(n*d/plotH). This pins the MAGNITUDE the linear-math bug
    // got wrong (the roadmap's "125.875 vs 2.371").
    {
        const H = 400;
        const start = { xMin: 0, xMax: 1000, yMin: 1, yMax: 1000 }; // 3 decades
        const n = Math.log10(start.yMax / start.yMin);
        for (const d of [1, 50, 150, 399, -50, -200]) {
            const v = _applyPanLog(start, 0, d, 800, H, false, true);
            const mult = Math.pow(10, n * d / H);
            check(near(v.yMin, start.yMin * mult, 1e-6) && near(v.yMax, start.yMax * mult, 1e-6),
                () => `T0.decade-law: drag ${d}px expected x${mult}, got yMin ${v.yMin} (want ${start.yMin * mult}) seed=${SEED}`);
        }
    }
}
