/**
 * @zakkster/lite-charts -- log-domain fuzzer runner (the C0 regression net).
 *
 *     node --expose-gc test/torture-logfuzz.mjs        (npm run torture:logfuzz)
 *
 * *** RED ON 1.4.0 BY DESIGN. *** Per the roadmap this must FAIL on 1.4.0 and
 * PASS on 1.4.1: it is the executable acceptance test for finding C0 (LC-01..
 * LC-04). It is deliberately kept OUT of `npm run torture` -- that gate prints
 * "ok" and cannot host a tier that is supposed to be red until the fix lands.
 *
 *   exit 0 : the log y-domain stayed positive & finite over every gesture
 *            -> C0's log-aware pan/zoom branch has landed. Green.
 *   exit 1 : a gesture drove the domain non-positive / non-finite (LC-01..04)
 *            -> expected on 1.4.0. Prints the seed + gesture for replay.
 */

import { fuzz } from './torture/t-logfuzz.mjs';
import { SEED } from './torture/harness.mjs';

const res = fuzz(10000);

if (res.ok) {
    process.stdout.write(
        'logfuzz: ok -- ' + res.iterations + ' gestures, log domain stayed positive & finite ' +
        '(seed=' + SEED + '). C0 has landed.\n');
    process.exit(0);
}

process.stderr.write(
    'logfuzz: FAIL (expected on 1.4.0) -- gesture ' + res.iteration + ' produced an invalid log domain.\n' +
    '  gesture: ' + res.gesture + '\n' +
    '  view:    yMin=' + res.view.yMin + ' yMax=' + res.view.yMax + '\n' +
    '  This is finding C0 / LC-01..LC-04: pan/zoom use linear math on a log axis.\n' +
    '  replay:  TORTURE_SEED=' + res.seed + ' node --expose-gc test/torture-logfuzz.mjs\n');
process.exit(1);
