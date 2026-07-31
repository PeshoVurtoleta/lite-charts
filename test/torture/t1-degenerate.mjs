/**
 * T1 -- degenerate data, every case with a PINNED answer.
 *
 * The roadmap's rule: "renders nothing silently" is a valid pinned answer; a
 * TypeError from deep inside decimation is not. So every nasty input below runs
 * the full construct -> mount -> redraw -> exportSVG -> destroy pipeline and the
 * tier asserts it neither throws an uncontrolled error NOR leaks the signal
 * graph. A handful of cases also pin a SPECIFIC scale value.
 *
 * Three of those specific pins encode the shipped FAIL-OPEN behaviour the
 * roadmap flags (LC-04 and its linear cousins): a log axis fed non-positive data
 * clamps to 1e-10 instead of throwing; +/-Infinity data yields an infinite
 * domain; 1e300-scale data yields a NaN domain. These pins are RED-on-purpose
 * documentation: when a later patch makes construction fail-closed (throw), the
 * pin flips loudly instead of the wrong-domain render slipping through. They are
 * pinned to CURRENT behaviour so `npm run torture` is green on 1.4.0.
 */

import {
    createLineChart, createAreaChart, createBarChart, createScatterChart,
    createBubbleChart, createPieChart, createDonutChart, createRadarChart,
    createHeatmap,
} from '../../Charts.js';
import { createEventCanvas, graphSnapshot, graphDelta, check } from './harness.mjs';

const SYNC = { schedule: (fn) => fn() };
const INF = Infinity;

/**
 * Run the full lifecycle for one degenerate case and assert it is handled and
 * leak-free. `expect` runs white-box assertions on the live chart before it is
 * destroyed. A thrown lite-charts Error is only acceptable if `mayThrow` says so.
 */
function pin(label, make, expect, mayThrow) {
    const before = graphSnapshot();
    let chart = null;
    try {
        chart = make();
        chart.mount(createEventCanvas(640, 360));
        chart.redraw();
        const svg = chart.exportSVG();
        check(typeof svg === 'string' && svg.length > 0,
            () => `T1.${label}: exportSVG returned empty`);
        if (expect) expect(chart);
    } catch (err) {
        if (mayThrow && /lite-charts:/.test(String(err && err.message))) {
            // A DECIDED fail-closed throw. Acceptable pinned answer.
            if (chart && typeof chart.destroy === 'function') { try { chart.destroy(); } catch { /* already down */ } }
            const d0 = graphDelta(before);
            check(d0.nodes === 0 && d0.links === 0,
                () => `T1.${label}: a rejected chart leaked the graph (${d0.nodes}n/${d0.links}l)`);
            return;
        }
        check(false, () => `T1.${label}: uncontrolled throw -- ${err && err.stack || err}`);
    }
    chart.destroy();
    const d = graphDelta(before);
    check(d.nodes === 0 && d.links === 0,
        () => `T1.${label}: destroy() leaked ${d.nodes} nodes / ${d.links} links`);
}

export function run() {
    // === axis charts: the numeric-degenerate matrix =========================
    const axisFactories = [
        ['line', createLineChart],
        ['area', createAreaChart],
        ['scatter', createScatterChart],
    ];
    const numericCases = {
        empty: [],
        single: [{ x: 5, y: 5 }],
        identical: Array.from({ length: 10 }, () => ({ x: 1, y: 1 })),
        nan: [{ x: 0, y: 0 }, { x: 1, y: NaN }, { x: 2, y: 2 }],
        tiny: [{ x: 0, y: 1e-300 }, { x: 1, y: 2e-300 }],
        unsorted: [{ x: 5, y: 1 }, { x: 1, y: 2 }, { x: 3, y: 3 }],
        dupx: [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }],
        allNeg: [{ x: 0, y: -5 }, { x: 1, y: -50 }, { x: 2, y: -1 }],
    };
    for (const [tname, factory] of axisFactories) {
        for (const [cname, data] of Object.entries(numericCases)) {
            pin(`${tname}/${cname}`, () => factory({ data, x: 'x', y: 'y', ...SYNC }), (chart) => {
                // Finite data must yield a finite domain. (allNeg/tiny/single etc.)
                check(Number.isFinite(chart.yScale.dMin) && Number.isFinite(chart.yScale.dMax),
                    () => `T1.${tname}/${cname}: finite data gave non-finite yScale [${chart.yScale.dMin},${chart.yScale.dMax}]`);
            });
        }

        // Documented FAIL-OPEN pins (LC-04 family). Pinned to CURRENT behaviour.
        pin(`${tname}/pos-infinity`, () => factory({ data: [{ x: 0, y: 0 }, { x: 1, y: INF }, { x: 2, y: 2 }], x: 'x', y: 'y', ...SYNC }), (chart) => {
            check(chart.yScale.dMax === INF,
                () => `T1.${tname}/pos-infinity: expected fail-open Infinity domain, got ${chart.yScale.dMax} -- LC-04 fixed?`);
        });
        pin(`${tname}/neg-infinity`, () => factory({ data: [{ x: 0, y: -INF }, { x: 1, y: 0 }], x: 'x', y: 'y', ...SYNC }), (chart) => {
            check(chart.yScale.dMin === -INF,
                () => `T1.${tname}/neg-infinity: expected fail-open -Infinity domain, got ${chart.yScale.dMin}`);
        });
        pin(`${tname}/huge`, () => factory({ data: [{ x: 0, y: 1e300 }, { x: 1, y: 2e300 }], x: 'x', y: 'y', ...SYNC }), (chart) => {
            check(Number.isNaN(chart.yScale.dMin) || !Number.isFinite(chart.yScale.dMax),
                () => `T1.${tname}/huge: expected fail-open NaN/Inf domain, got [${chart.yScale.dMin},${chart.yScale.dMax}]`);
        });
    }

    // === log axis: LC-04 is now fail-closed =================================
    // A log axis fed all-negative data has NO positive extent to plot, so C0
    // makes it THROW at mount (naming the domain) instead of the old silent
    // clamp to 1e-10. Pinned as a decided fail-closed throw.
    pin('line/log-all-negative', () =>
        createLineChart({ data: [{ x: 1, y: -5 }, { x: 2, y: -10 }], x: 'x', y: 'y', yScale: { type: 'log' }, ...SYNC }),
        null, /* mayThrow */ true);
    // Mixed sign on a log axis: the positive extent IS plottable, so it renders
    // (the negatives are outside a log domain, drawn as breaks -- like map(v<=0)).
    pin('line/log-mixed-sign', () =>
        createLineChart({ data: [{ x: 1, y: -5 }, { x: 2, y: 10 }, { x: 3, y: 1000 }], x: 'x', y: 'y', yScale: { type: 'log' }, ...SYNC }), (chart) => {
        check(chart.yScale.dMin > 0 && Number.isFinite(chart.yScale.dMax),
            () => `T1.log-mixed-sign: expected a positive finite domain, got [${chart.yScale.dMin},${chart.yScale.dMax}]`);
    });
    // x-log is fail-closed until C1 (LC-05): construction throws.
    pin('line/x-log-unsupported', () =>
        createLineChart({ data: [{ x: 1, y: 1 }, { x: 2, y: 2 }], x: 'x', y: 'y', xScale: { type: 'log' }, ...SYNC }),
        null, /* mayThrow */ true);
    // A log axis with valid positive data must round-trip a finite positive domain.
    pin('line/log-positive', () =>
        createLineChart({ data: [{ x: 1, y: 1 }, { x: 2, y: 1000 }], x: 'x', y: 'y', yScale: { type: 'log' }, ...SYNC }), (chart) => {
        check(chart.yScale.dMin > 0 && Number.isFinite(chart.yScale.dMax),
            () => `T1.log-positive: expected finite positive domain, got [${chart.yScale.dMin},${chart.yScale.dMax}]`);
    });

    // === bubble: numeric + a size dimension =================================
    pin('bubble/empty', () => createBubbleChart({ data: [], x: 'x', y: 'y', size: 'value', ...SYNC }), null);
    pin('bubble/nan-size', () => createBubbleChart({
        data: [{ x: 0, y: 0, value: NaN }, { x: 1, y: 1, value: 5 }], x: 'x', y: 'y', size: 'value', ...SYNC,
    }), null);
    pin('bubble/zero-size', () => createBubbleChart({
        data: [{ x: 0, y: 0, value: 0 }, { x: 1, y: 1, value: 0 }], x: 'x', y: 'y', size: 'value', ...SYNC,
    }), null);

    // === bar: categorical x =================================================
    pin('bar/empty', () => createBarChart({ data: [], ...SYNC }), null);
    pin('bar/single', () => createBarChart({ data: [{ x: 'A', y: 10 }], ...SYNC }), null);
    pin('bar/dup-category', () => createBarChart({
        data: [{ x: 'A', y: 1 }, { x: 'A', y: 2 }, { x: 'A', y: 3 }], ...SYNC,
    }), null);
    pin('bar/nan-y', () => createBarChart({ data: [{ x: 'A', y: NaN }, { x: 'B', y: 3 }], ...SYNC }), null);

    // === pie / donut: value slices ==========================================
    for (const [pname, pf] of [['pie', createPieChart], ['donut', createDonutChart]]) {
        pin(`${pname}/empty`, () => pf({ data: [], ...SYNC }), null);
        pin(`${pname}/single`, () => pf({ data: [{ label: 'A', value: 100 }], ...SYNC }), null);
        pin(`${pname}/zero-total`, () => pf({ data: [{ value: 0 }, { value: 0 }], ...SYNC }), null);
        pin(`${pname}/negative`, () => pf({ data: [{ value: -5 }, { value: 10 }], ...SYNC }), null);
        pin(`${pname}/nan`, () => pf({ data: [{ value: NaN }, { value: 10 }], ...SYNC }), null);
    }

    // === radar: >= 3 axes, values per axis ==================================
    pin('radar/min-axes', () => createRadarChart({
        axes: ['A', 'B', 'C'], series: [{ name: 'S', values: [1, 2, 3] }], domain: [0, 3], ...SYNC,
    }), null);
    pin('radar/nan-values', () => createRadarChart({
        axes: ['A', 'B', 'C'], series: [{ name: 'S', values: [NaN, 2, 3] }], domain: [0, 3], ...SYNC,
    }), null);
    // Too few axes is a DECIDED fail-closed throw (see the unit suite).
    pin('radar/too-few-axes', () => createRadarChart({
        axes: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }], ...SYNC,
    }), null, /* mayThrow */ true);

    // === heatmap: categorical grid ==========================================
    pin('heatmap/empty', () => createHeatmap({ data: [], width: 400, height: 300, ...SYNC }), null);
    pin('heatmap/single', () => createHeatmap({ data: [{ x: 'Mon', y: 'AM', value: 1 }], width: 400, height: 300, ...SYNC }), null);
    pin('heatmap/dup-cell', () => createHeatmap({
        data: [{ x: 'Mon', y: 'AM', value: 1 }, { x: 'Mon', y: 'AM', value: 9 }], width: 400, height: 300, ...SYNC,
    }), null);
    pin('heatmap/nan-value', () => createHeatmap({
        data: [{ x: 'Mon', y: 'AM', value: NaN }, { x: 'Tue', y: 'PM', value: 5 }], width: 400, height: 300, ...SYNC,
    }), null);
}
