# Brief -- time-series market-hours shading (v1.11.0)

Status: GROUNDED BRIEF (2026-09-02, against shipped v1.10.0 code). The slice
deferred from v1.10.0 (`time-series-variants.md`). Shovel-ready modulo the
planner pinning exact line numbers at build time.

## Goal

`createTimeLineChart` learns a caller-supplied session calendar: shade the
NON-trading time so trading windows stand out. Data-driven -- the chart never
hardcodes an exchange, a timezone, or a holiday table. Rides the exact
machinery v1.10.0 shipped.

## What v1.10.0 already gives us (verified, reuse -- don't rebuild)

- `_weekendBands(xMinRaw, xMaxRaw, fill)` -- cold UTC week walker emitting
  `{type:'range', axis:'x', from, to, fill}` rows. Stays BYTE-IDENTICAL.
- `_shadingAnnotationsAcc(shading, annotations, dataAccs, xAccessor)` -- the
  accessor that scans the DATA extent (raw accessor, per-row `== null` gate
  BEFORE coercion -- the v1.10.0 ultrareview fix; SoA `{xs,ys}` scanned like
  AoS) and concats generated bands with user annotations. The extent scan is
  reused as-is; only the band-generation call becomes a selection.
- The annotation layer's cold-resolve / hot-project split: bands are generated
  cold (data-tracked, never scaleVersion) and re-clipped per frame at 0 B by
  the existing project effect. NO new hot-path code, same as v1.10.0.
- `createTimeLineChart` construction-time `shading` validation (throw on junk,
  `false` === absent).

## Config surface (the cut)

Extend `shading`'s object form; the v1.10.0 forms stay byte-compatible:

```js
shading: true | 'weekends' | {
  fill?: string,          // weekend fill (v1.10.0, unchanged)
  sessions?: [{           // NEW: market sessions; presence switches generator
    openMinutes: number,  // minutes from UTC midnight, integer 0..1439
    closeMinutes: number, // integer 1..1440, MUST be > openMinutes (v1.11.0)
    days?: number[],      // UTC weekday ints 0-6 the session runs; default [1,2,3,4,5]
  }],
  sessionFill?: string,   // fill for non-trading bands; default = fill default
}
```

Semantics -- **complement of the open-interval union**: walk UTC days over the
data extent, build open intervals `[dayStart+open, dayStart+close]` for each
session on its days, merge/union them, emit one range band per GAP inside
`[xMin, xMax]`. Consequences (all falsifiable):

- Fri close -> Mon open is ONE contiguous band (weekend + closed hours merge;
  no double-painted overlap, fewer annotation rows).
- A day in no session's `days` is fully inside a band (weekends subsumed --
  when `sessions` is present the weekend walker is NOT invoked; `weekends`
  behavior without `sessions` is untouched v1.10.0).
- Multiple sessions per day (lunch-break markets) are free: the union handles
  `[{open:09*60,close:11.5*60},{open:12.5*60,close:15*60}]` naturally.

## Scope fences (explicit OUT)

- **Overnight sessions (close < open, e.g. Globex).** Throw at construction in
  v1.11.0 (`closeMinutes must be > openMinutes`); the complement algorithm can
  express them later via midnight-split open intervals -- documented follow-up,
  not silently wrong now.
- **Skipping / compressing non-trading time.** That is a broken/discontinuous
  time SCALE, not an annotation -- a different, much larger feature. Never in
  this cut.
- **Holiday calendars.** Caller can already overlay extra `annotations` ranges;
  a `holidays: [epochDay]` convenience is a candidate for later, not now.
- **Session boundary rule-lines.** Candidate only; range bands ship first.

## Carried in from the 2026-09-02 edge sweep (v1.10.0 audited clean; 1 finding)

- T0 **Explicit conflicting `xScale.type` must throw.** Today
  `createTimeLineChart({ xScale: { type: 'log' } })` silently forces 'time'
  (verified empirically). Documented, but it is the one spot that grates
  against fail-closed: an explicit conflicting request should throw at
  construction (`type` absent or 'time' stays fine). Tighten Charts.d.ts to
  `xScale?: Omit<XScaleConfig, 'type'> & { type?: 'time' }` alongside.
  Behavior change -> rides this minor, with a test.
- Sweep results worth keeping (all CLOSED, no action): pre-1970 extents walk
  correctly; Sat-midnight boundary fences hold both ends; fractional/string
  epochs fine; Infinity/junk bounds emit nothing; the 50-year extent is 2609
  bands generated in 0.14 ms and drawn as typed-array SLOTS on one path node
  (+0.10 ms/frame, no alloc -- NOT a cliff); data-signal change regenerates
  bands (2->4->0 verified live); exportSVG emits band fills; junk `fill`
  resolves to the '#888' fail-safe; a THROWING user data accessor propagates
  out of the resolve effect -- identical exposure to every other user-supplied
  accessor in the library, accepted as consistent.
- **Docs (this cycle's pass): the lite-time now-line recipe.** Proven working
  today with zero chart changes -- the annotations accessor is reactive, so
  `annotations: () => [{ type:'line', axis:'x', value: minuteClock() }]` with
  lite-time's `clock(60000)` gives a self-advancing now-line (resolve re-runs
  per beat, cold path; recommend clock resolution >= 60s since a beat re-runs
  the whole shading accessor, including the extent scan). Pairs with
  `countdown`/`onElapsed` for open/close UI in the back office.

## Tasks (sketch -- planner to pin line numbers)

- T1 `_sessionBands(xMinRaw, xMaxRaw, spec, fill)` -- NEW cold generator,
  sibling of `_weekendBands` (same fail-closed prologue: `== null` gates before
  any unary `+`, non-finite/inverted extent -> no bands). Complement-of-union
  walk as above. Cold path: MAY allocate.
- T2 `_normalizeSessionSpec(shading)` -- construction-time validator called
  once from `createTimeLineChart`: integer-gate openMinutes/closeMinutes
  (`== null` first -- null is not zero, NOT `+x` then isFinite), range checks,
  `open < close`, `days` ints 0..6 non-empty, sessions array non-empty.
  Invalid -> THROW (config error, not data); shape mirrors the v1.10.0
  shading-kind throw.
- T3 Generator selection at the `_shadingAnnotationsAcc` build site (or a
  thin sibling accessor): `spec.sessions ? _sessionBands : _weekendBands`.
  Extent scan and user-annotation concat BYTE-IDENTICAL.
- T4 `Charts.d.ts`: extend `TimeShadingConfig` (sessions, sessionFill).
- T5 Tests + torture A17 (0-B redraw storm with active session bands,
  differential vs weekend-only, mirroring A16).

## Assertions (sketch -- qa to make falsifiable)

- Mon-Fri 09:30-16:00 (570/960) over Mon-00:00 -> Mon-00:00 x 2 weeks: the
  exact expected band list -- one band per overnight gap, ONE band Fri 16:00 ->
  Mon 09:30 spanning each weekend, boundary epochs exact (Date.UTC arithmetic,
  same style as v1.10.0's TS1).
- `sessions` absent -> `_sessionBands` never called; weekend path byte-identical
  (source-confinement proxy extends TS11: exactly one `_sessionBands(`
  immediate-paren call-site).
- Lunch-break market (2 sessions/day) -> midday gap band present.
- Construction throws: `openMinutes: null` (null is not zero -- must NOT become
  midnight), `close <= open`, `days: []`, `days: [7]`, non-integer minutes.
- Per-row null-x guard still holds under sessions (TS14 pattern reused).
- A17 torture: maxMajor:0 / arrayBuffers 0 / <=16 B/op, delta <=2 B/op vs the
  weekend-only control.
- 50x mount/destroy retention with sessions active.

## Gate

Standard: `npm test`, `node --expose-gc test/torture.mjs` -> `ok`, ASCII-only,
0 B/frame draw path, tree-shake source confinement (generators reachable only
through `createTimeLineChart`).
