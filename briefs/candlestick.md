# Brief -- candlestick / OHLC chart (v1.19.0 candidate)

Status: DRAFT 2026-09-05, written per the Branch B decision (delaunay
thread archived; brief #14 cluster outlines is v1.18.0 and fully
unblocked -- THIS brief is the release after). Top candidate absorbed
from the 2026-09-05 external review: the financial substrate already
shipped (time-first defaults, session/holiday shading, log yScale,
pan/zoom, annotations) makes OHLC the highest-leverage missing type.
No cut before a planner pass over this brief.

## Goal

`createCandlestickChart(config)`: the TENTH chart type, the tenth
axis-kernel renderer -- one candle per row (wick h..l, body o..c,
up/down coloring), time x-axis, price y-axis, riding every kernel
service that already ships: pan/zoom, crosshair + tooltip, legend-free
single series, annotations, `yScale:{type:'log'}`, exportSVG, theme
refresh. 0 B/frame draw. A bundle importing only `createLineChart`
must not gain a byte (the tree-shake law, Charts.js:3592-3601).

## Why this type and not another renderer knob

OHLC cannot be faked with bars or ranges: a candle is FOUR values per
x with paint semantics (body direction = sign(c - o), wick = h..l
extent) and its own hit/tooltip shape. The review's other financial
asks (volume pane, dual axis, multi-pane) are LAYOUT features -- out of
scope here, deferred with named triggers; the candle renderer is the
substrate they would attach to.

## Grounding (verified against v1.17.0 code, 2026-09-05)

- Renderer pattern: every axis type is a hook object handed to
  `createBaseAxisChart` -- LINE_RENDERER (Charts.js:3667),
  BAR_RENDERER (:3848), SCATTER_RENDERER (:5391); factories are
  one-liners (:9815, :9884). Hooks: buildXAccessor, forceXType,
  createXScale, initOpts, extractData, postExtract?, yDefaults,
  updateXScale, projectToPixels, enableXGrid, buildXAxis, buildYAxis?,
  makeDrawFn, hitTest, drawPerSeriesMarkers, lookupRow,
  formatTooltipHeader. CANDLE_RENDERER is a new sibling; no spread
  from an existing renderer (spreading pins the donor's closure --
  the :3600 lesson).
- Time-first precedent: `createTimeLineChart` (:9837) wraps the base
  factory with forced x type 'time' + the shading engine. Candles are
  time-first BY CONSTRUCTION -- the factory forces it, no plain-x
  variant.
- Shading: `_normalizeSessionSpec` (:9455) + `_sessionBands` are COLD
  and engine-complete (sessions, overnight, holidays, early close) but
  their error strings and docs name createTimeLineChart. Reuse is the
  intent (candles want market-hours shading MORE than lines do); the
  wiring must keep time-line byte-identical.
- Log price axis: `yScale:{type:'log'}` already works on any
  axis-kernel chart (llms.txt:1324) -- candles inherit it if o/h/l/c
  project per-value through the y scale (no shortcuts through a
  precomputed body height).
- Hit-test: `_bisectHitTest`/`_bisectLookupRow` (LINE_RENDERER) is the
  continuous-x precedent -- nearest candle by x, whole-candle
  highlight; `formatTooltipHeader` hook carries the timestamp header,
  and the tooltip body needs an OHLC row shape (planner: probably via
  the same hook family bars used for their header divergence).

## Config surface (planner falsifies; leanings recorded)

```js
createCandlestickChart({
  canvas, data,                       // rows: { ts, o, h, l, c }
  keys?: { ts?, o?, h?, l?, c? },     // default 'ts','o','h','l','c'
  up?, down?,                         // body fills (both-theme-safe hex defaults)
  wick?,                              // wick/border stroke; default = body color per candle
  bodyRatio?,                         // body width as fraction of slot, default 0.7, clamp (0,1]
  yScale?, xScale?: { domain? },      // type forced 'time'; log yScale allowed
  shading?,                           // the createTimeLineChart engine, reused
  annotations?, tooltip?, ...         // kernel services, untouched
})
```

Single series only (one OHLC stream per chart) -- comparison overlays
are a later minor with a named trigger, not a v1 maybe.

## Design decisions the planner OWNS (candidates, falsify freely)

- C1 X placement: TIME-CONTINUOUS (candles sit at their true ts;
  weekend/holiday gaps show as gaps) vs INDEX-COMPACT (band-like
  slots, gaps collapsed -- what trading UIs do). Lean: time-continuous
  for v1 -- it is what the kernel already does (bisect hit, time axis,
  shading bands align with REAL time; index-compact would break the
  shading engine's whole premise), and gaps-as-gaps is the honest
  default. Index-compact deferred with a named trigger; document the
  divergence from trading-UI convention loudly.
- C2 Candle slot width: derived per refresh from the MEDIAN adjacent
  ts delta projected to pixels (median, not min -- one missing bar
  must not halve every body), times bodyRatio; clamp [1px, 64px];
  wick always 1px centered. Computed cold at postProject, not per
  frame.
- C3 Doji / flat candles: o == c draws a 1px horizontal body tick
  (not zero-height nothing); h == l == o == c draws a single tick.
  Honest degenerate rendering, asserted in the gate.
- C4 OHLC row validation: extract-time (data change, cold) throw on
  any of o/h/l/c being null/undefined/NaN/non-finite (`== null` gated
  before any `+`; null is not zero) AND on h < max(o,c) or
  l > min(o,c) -- an impossible candle is corrupt data, fail closed,
  no per-row skip (skipping lies about the series). ts must be
  finite and STRICTLY increasing (the bisect + slot-width math both
  assume it; equal timestamps refused).
- C5 Up/down/wick styling: RAW canvas styles, no CSS-var resolution
  for v1 (the contour lesson) vs the colorKey cold-resolution
  precedent. Lean: raw hex defaults (up a green-safe, down a red-safe
  pair readable on both themes), CSS-var resolution deferred.
- C6 Shading reuse mechanics: parameterize the engine's error-message
  prefix (or accept the createTimeLineChart wording verbatim) --
  whichever keeps time-line BYTE-IDENTICAL and adds zero risk;
  reviewer owns proving no shipped path changed.
- C7 Volume: OUT for v1 (needs a sub-pane or an overlay scale --
  layout work). The brief for it rides on this renderer landing
  first. Named trigger: a consumer asking for volume-at-price or a
  volume pane.

## Fail-closed doors (construction, before any owned signal)

`data` non-array/empty; `keys` present but any key non-string; row
validation per C4 at extract; `up`/`down`/`wick` junk falls back to
defaults per house style; `bodyRatio` non-finite or outside (0,1]
throws (`== null` gated first); `xScale.type` present and not 'time'
throws (the createTimeLineChart precedent, llms.txt:237); log yScale
with any price <= 0 fails per the existing log-domain door. shading
junk throws per the shipped engine's doors, unchanged.

## Gate (all mandatory)

- Boundary suite: doors matrix at zero node delta; C4 corrupt-candle
  matrix (h < body, l > body, null/NaN each field, equal ts,
  descending ts); doji/flat rendering per C3 (canvas pixel probes --
  getImageData, never pane screenshots); slot-width behavior with a
  missing bar (median law per C2); log yScale projects o/h/l/c
  independently (a candle spanning a decade renders with the correct
  log-space body/wick proportions -- oracle: manual log projection in
  the test); shading bands under candles byte-identical to the same
  spec on createTimeLineChart; pan/zoom keeps candle slot width
  recomputed per scale change, never per frame; tooltip shows
  O/H/L/C values for the bisected candle; SVG parity (bodies as
  rects/paths, wicks as lines, defs-stripped searches).
- Tree-shake proof: build `import { createLineChart }` and grep the
  bundle for CANDLE_RENDERER/candle helper names -- zero hits (the
  :7373 verification recipe).
- Torture: gesture storm at 1k and 10k candles + branch-parity
  no-candlestick control; redraw <= 16 B/op; 0 new graph nodes; 50x
  create/dispose retention; warm-up + op counts per the A21/A23
  granularity lesson.
- Reversion proofs for every load-bearing mechanism (median slot
  width, C4 doors, log per-value projection at minimum).
- Docs: CHANGELOG/llms.txt/README/ROADMAP/Charts.d.ts
  (CandlestickConfig type). ASCII only. README gains the tenth type
  in the kernel table.

## Out of scope

Volume pane/overlay (C7, deferred with trigger); index-compact x
(C1, deferred with trigger); comparison overlays / multi-series OHLC;
hollow-candle and OHLC-bar (tick) visual variants; heikin-ashi or any
derived-candle math (compute upstream); dual/secondary y-axis;
multi-pane layout; drawing tools; ANY change to shipped renderers
beyond the C6 shading wiring -- scope creep on the kernel is the
reviewer's to refuse.

---

## AS-EXECUTED (2026-09-06, shipped as v1.19.0)

Pipeline: planner (2 attempts -- first died at its turn limit on grounding;
re-run with a pre-grounded map) -> coder (hit the 40-turn limit after
T1-T13; I finished T15 + fixes) -> reviewer APPROVED zero blockers (R1-R8
all PASS; second attempt, with the diff pre-extracted to one file) -> qa
mine (CS1-CS10, 503 -> 514; five reversion proofs R1-R5). Gate: 514/514,
torture ok incl. A25, ASCII clean.

Planner rulings vs the brief (all held):
- C1 time-continuous CONFIRMED; index-compact deferred, trigger named in
  ROADMAP.
- C4 AMENDED: extract runs under an effect, so corrupt rows set
  ctx.candleError + n=0 (never throw mid-effect); the mount door surfaces
  it (the v1.14/16/18 error-slot precedent). Post-mount corruption sheds;
  healthy re-swap recovers (candleError cleared per extract).
- C6 settled as reuse BY REFERENCE, zero engine edits -- time-line
  byte-identity is proof by construction; the engine's error strings keep
  the createTimeLineChart wording (documented in llms.txt). TS11/TS20
  source pins re-pinned 1 -> 2 call sites.
- Tooltip body: no hook existed; added optional renderer.tooltipRows
  guarded like postExtract/postProject -- the nine shipped renderers keep
  their single-row path byte-identical (CS8 asserts the parity).

DEFECTS CAUGHT AFTER THE CODER (both mine to find, both load-bearing):
1. FLOAT32 TIMESTAMP COLLAPSE -- the kernel projects pxs from Float32
   state.xs; 2026 epoch-ms rounds to ~131s there, so minute bars (the
   PRIMARY candlestick case) collapsed onto each other (three candles
   drew as two at one x). Fix: extract keeps RAW doubles in state.tss,
   computes medianDt + x-domain bounds from them, and _candlePostProject
   re-projects pxs from tss (cold). Crosshair snap still bisects Float32
   xs -- house-wide behavior, documented. Reversion R5 (drop the
   re-projection) reddens CS3+CS5. The coder's original medianDt also
   read Float32 xs deltas -- fixed pre-review.
2. SIGNAL DATA REFUSED AT THE DOOR -- _candleInitOpts demanded
   Array.isArray(config.data), rejecting accessor/signal data (a
   first-class kernel service). Door now admits functions; extract
   validates every yield (CS2b).

QA LESSONS:
- The min-vs-median discriminator is an INSERTED off-schedule bar (min
  halves, median holds), not a MISSING bar (min == median there). CS4's
  first fixture proved nothing against sc[0]; reversion testing caught my
  own test again (the TS22/V4 class, third instance).
- Rejected-mount node-delta checks must destroy() first: construction
  owns signals until destroy; the C0-unwind claim is about the mount's
  OWN allocations.
- Shading parity across factories is sub-pixel, not string-identical:
  the candle x-domain keeps raw doubles while line domains derive from
  Float32 xs -- the bands legally differ by ~0.005px (candle side more
  accurate), and SVG clip ids are a global counter.
- Reviewer/planner agents die on open-ended reading: pre-extract the
  diff to one file / pre-ground the map, and they finish inside their
  turn budgets.

Reversion ledger (each restored byte-for-byte, sha dbd9665e...):
R1 median -> sc[0]: CS4 red (2). R2 log per-value -> wick-interpolated
body: CS5 red. R3 null-gate dropped: CS2 red (l:null coerces to a
"valid" 0). R4 mount-door term dropped: CS2 red. R5 pxs re-projection
dropped: CS3+CS5 red (4).

Coverage: CS1 doors (12-case matrix, zero node delta); CS2 corrupt-mount
matrix (11 cases + destroy-after); CS2b corrupt-swap shed/recover; CS3
doji/flat op-log; CS4 median (missing bar + inserted half-spacing bar);
CS5 manual-log oracle at 0.5px; CS6 shading parity vs time-line at
0.02px; CS7 slot doubles on half-domain, stable across plain redraws;
CS8 O/H/L/C rows + hook-absent line parity; CS9 SVG body/wick counts by
fill; CS10 source pins (one def, one consumer, one guarded hook call).
Torture A25: 208-write storm 0 nodes; 1k redraw within 2 B/op of the
time-line branch-parity control; 10k <= 16 B/op; 50x create/destroy
zero retention. Canary-proven to execute.
