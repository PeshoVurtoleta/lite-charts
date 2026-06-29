/**
 * @zakkster/lite-charts -- v1.2.0 zero-GC audit regression tests (node:test).
 *
 * The four 1.2.0 fixes are allocation optimisations that MUST preserve output
 * exactly. These guard their observable behaviour through the public API:
 *
 *   Fix 1  heatmap quantile pooled Float32Array  -> correct binning across pool reuse
 *   Fix 2  _parseRGBLike manual comma scan        -> auto value-label contrast resolves
 *   Fix 3  charBufToString fromCharCode.apply      -> axis labels are real strings
 *   Fix 4  SVG export _pathChunks array join       -> large exportSVG: valid path, no throw
 *
 * Run with:  node --expose-gc --test test/gc-audit-fixes.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '@zakkster/lite-signal';
import { createLineChart, createHeatmap } from '../Charts.js';
import { createMockCanvas, countCalls, callsOf } from './harness.js';

const sync = (fn) => fn();

// A dense n x n grid (every cell present), values 0 .. n*n-1.
const fullGrid = (n) => {
    const d = [];
    for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) d.push({ x: 'c' + x, y: 'r' + y, value: x * n + y });
    }
    return d;
};

describe('v1.2.0 zero-GC audit fixes (regression)', () => {

    // Fix 1 -- quantile binning pools a Float32Array on grid state and sorts a
    // subarray(0, nPresent) view in place. The pool grows monotonically and is
    // reused; a shrink must not let the stale tail corrupt the result.
    it('Fix 1: quantile heatmap reuses its pooled buffer correctly across grow then shrink', () => {
        const data = signal(fullGrid(8));
        const canvas = createMockCanvas(400, 400);
        const c = createHeatmap({ data, colorScale: 'quantile', width: 400, height: 400, schedule: sync });
        c.mount(canvas);
        const ctx = canvas.getContext('2d');

        ctx.calls.length = 0; c.redraw();
        assert.equal(countCalls(ctx, 'fillRect'), 64, '8x8 quantile paints 64 cells');

        data.set(fullGrid(12));               // grows the pooled Float32Array to 144
        ctx.calls.length = 0; c.redraw();
        assert.equal(countCalls(ctx, 'fillRect'), 144, '12x12 grows the pool, paints 144 cells');

        data.set(fullGrid(5));                // reuses the grown pool; stale tail [25..143] ignored
        ctx.calls.length = 0; c.redraw();
        assert.equal(countCalls(ctx, 'fillRect'), 25, '5x5 reuses the larger pool with no stale-tail corruption');

        c.unmount();
    });

    // Fix 2 -- auto value-label colour parses the colorFn's rgb() output with a
    // manual indexOf comma scan instead of split(','). Contrast still resolves
    // for every cell, with no per-cell array allocation and no throw.
    it('Fix 2: auto value-label colour resolves from an rgb() colorFn', () => {
        const canvas = createMockCanvas(300, 300);
        const c = createHeatmap({
            data: fullGrid(4), width: 300, height: 300, schedule: sync,
            showValues: true, valueLabelColor: 'auto',
            colorFn: (t) => 'rgb(' + Math.round(t * 255) + ', ' + Math.round(t * 255) + ', ' + Math.round(t * 255) + ')',
        });
        c.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0;
        assert.doesNotThrow(() => c.redraw(), 'auto label + rgb() colorFn must not throw');
        // 16 cells each get a contrast-resolved value label (plus axis category
        // labels). >= 16 fillText proves _parseRGBLike ran per cell to pick contrast.
        assert.ok(countCalls(ctx, 'fillText') >= 16, 'a contrast-resolved label is drawn per cell (parser ran per cell)');
        c.unmount();
    });

    // Fix 3 -- charBufToString collapses the formatted byte buffer in a single
    // String.fromCharCode.apply(null, buf.subarray(0, n)) call. Axis tick labels
    // must come out as correct, readable strings.
    it('Fix 3: numeric axis tick labels build as correct strings', () => {
        const canvas = createMockCanvas(600, 300);
        const c = createLineChart({
            data: [{ x: 0, y: 0 }, { x: 25, y: 10 }, { x: 50, y: 20 }, { x: 75, y: 30 }, { x: 100, y: 40 }],
            x: 'x', y: 'y', width: 600, height: 300, schedule: sync,
        });
        c.mount(canvas);
        const ctx = canvas.getContext('2d');
        ctx.calls.length = 0; c.redraw();
        const labels = callsOf(ctx, 'fillText').map((call) => call[1][0]);
        assert.ok(labels.length > 0, 'axis emits tick label text');
        assert.ok(
            labels.some((s) => typeof s === 'string' && /[0-9]/.test(s)),
            'a tick label is a real string containing digits (charBufToString produced it)',
        );
        c.unmount();
    });

    // Fix 4 -- SVG export accumulates path commands into an array joined once
    // (_pathD) instead of `_currentPath += chunk` (a rope string that flattens
    // to a multi-second freeze / RangeError near 100k points). A large export
    // must produce a valid path and never throw.
    it('Fix 4: exportSVG on a large line chart yields a valid path and does not throw', () => {
        const N = 60000;
        const data = new Array(N);
        for (let i = 0; i < N; i++) data[i] = { x: i, y: Math.sin(i * 0.001) * 100 };
        const c = createLineChart({ data, x: 'x', y: 'y', width: 800, height: 400, schedule: sync });
        c.mount(createMockCanvas(800, 400));

        let svg;
        assert.doesNotThrow(() => { svg = c.exportSVG(); },
            'large exportSVG must not throw (rope string replaced by array join)');
        assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'valid SVG envelope');
        const m = svg.match(/<path[^>]*\bd="([^"]+)"/);
        assert.ok(m, 'a <path> with a d attribute is emitted');
        assert.match(m[1], /^M[-0-9.]/, 'path d begins with an M command + number');
        assert.ok(m[1].includes('L'), 'path d contains L line commands');

        c.destroy();
    });
});
