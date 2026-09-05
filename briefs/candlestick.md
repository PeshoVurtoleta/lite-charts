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
