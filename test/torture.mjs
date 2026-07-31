/**
 * @zakkster/lite-charts -- torture gate.
 *
 * The DONE-WHEN of the stress work is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Charts-specific tiers (generic ones are not worth the bytes). They share the
 * harness's PRNG, thunk assertions, event-capable canvas, and lite-gc-profiler
 * gate, and run STRICTLY SEQUENTIALLY -- lite-gc-profiler is one-measurement-at-
 * a-time, so tiers are never nested or concurrent:
 *
 *     T0   metamorphic laws        scales, decimation, pan/zoom, clamp, log math
 *     T1   degenerate data         the pinned-answer matrix, per chart type
 *     T3   decimation adversarial  min/max bucketing vs a naive oracle
 *     T5   differential oracle     mutated chart == rebuilt-from-scratch
 *     T6   zero-alloc gate         the pointer/scale/decimation hot path
 *     T7   mount/unmount soak      destroy() detaches; observer count -> 0
 *     T8   export bound + resize   exportSVG size bound; ResizeObserver storm
 *     T-LOG log-domain fuzzer      seeded log pan/zoom stays positive & finite
 *     T9   controls                every gate must be provably able to fail
 *
 * T-LOG (the C0 regression net) was RED on 1.4.0 -- the log-axis handler used
 * linear pan/zoom math (LC-01..LC-04) -- and is GREEN as of 1.4.1's log-aware
 * branch, so it now belongs in this gate. It is also runnable standalone via
 * `npm run torture:logfuzz` for the historical before/after check.
 *
 * Whole-suite control: `CHARTS_TORTURE_BREAK=1 node --expose-gc test/torture.mjs`
 * injects retained allocations into the T6 hot loop, so the alloc gate must
 * reject and the process must exit non-zero. A gate that cannot fail is
 * decorative.
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies only.
 *
 * @license MIT
 */

import { SEED, BREAK } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t1 } from './torture/t1-degenerate.mjs';
import { run as t3 } from './torture/t3-decimation.mjs';
import { run as t5 } from './torture/t5-oracle.mjs';
import { run as t6 } from './torture/t6-alloc.mjs';
import { run as t7 } from './torture/t7-soak.mjs';
import { run as t8 } from './torture/t8-export.mjs';
import { run as tLog } from './torture/t-logfuzz.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T1 degenerate', t1],
    ['T3 decimation', t3],
    ['T5 oracle', t5],
    ['T6 alloc', t6],
    ['T7 soak', t7],
    ['T8 export', t8],
    ['T-LOG logfuzz', tLog],
    ['T9 controls', t9],
];

function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    for (const [name, run] of TIERS) {
        try {
            run();
        } catch (err) {
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means T6's control did not trip -- a fault.
    if (BREAK) {
        process.stderr.write('torture: FAIL -- CHARTS_TORTURE_BREAK set but the gate still passed\n');
        process.exit(1);
    }

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
