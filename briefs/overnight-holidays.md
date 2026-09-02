# Brief -- overnight sessions + holiday calendar (v1.12.x)

Status: GROUNDED against v1.12.0 source (2026-09-02). Line numbers cite the
shipped Charts.js; the planner re-pins them if anything lands in between.

## Goal

Close out the time-series shading arc. Two additive features riding the
v1.11.0 session machinery, one session, one release:

1. **Overnight sessions.** `closeMinutes < openMinutes` (e.g. Globex ES:
   open 22:00 UTC, close 21:00 UTC next day) currently throws at
   Charts.js:8513-8515. Support it.
2. **Holiday calendar.** Caller supplies closed dates; each becomes a
   fully-shaded UTC day that MERGES with adjacent gap bands (the day before
   a holiday's close runs into the day after's open as ONE band).

A chart that uses neither is byte-unchanged on the draw path and
band-for-band identical in output (A1).

## What v1.11.0 already gives us (verified, reuse -- don't rebuild)

- `_normalizeSessionSpec` (Charts.js:8484-8539): construction-time
  validator, `== null` gates BEFORE any unary `+`, sessions normalized to
  `{ open, close, dayMask }` and SORTED ascending by open. The overnight
  throw to remove is :8513-8515. `close === open` zero-width throw
  (:8516-8518) STAYS -- a 24h session is spelled `{open: 0, close: 1440}`.
- `_sessionBands` (Charts.js:8548-8577): COLD single-cursor complement
  sweep. Its own comment (:8561-8563) says overnight "would require a real
  sort/merge at generation time" -- D1 below shows it does NOT. The sweep's
  load-bearing invariant: intervals are visited in ascending START order
  (outer day loop ascending x inner open-sorted loop) and every interval
  ends within its own day (`close <= 1440`), so one forward cursor emits
  the complement. Both halves of a split overnight session satisfy this.
- `_shadingAnnotationsAcc` (Charts.js:8620-8675): DATA-tracked extent scan
  (never scaleVersion -- the critical v1.10.0 grounding finding), SoA + AoS
  + per-row `== null` raw-accessor gates. UNTOUCHED by this brief except
  the spec it forwards.
- `_weekendBands` (Charts.js:8586-8604): BYTE-IDENTICAL after this brief
  (A2). Note for A6: it does NOT clip band edges to [xMin, xMax] (leading
  `to <= xMin` skip only), while `_sessionBands` DOES clip -- any
  equivalence assertion between the two paths must compare CLIPPED bands,
  not raw lists.

## Design decisions (locked unless the planner falsifies one)

- **D1 -- overnight = normalize-time midnight split; the sweep loop shape
  is unchanged.** An overnight `{open, close}` with `close < open` on
  dayMask M becomes TWO half-sessions in the normalized list:
  `{ open, close: 1440, dayMask: M }` (evening half) and
  `{ open: 0, close, dayMask: rotate(M) }` (morning half, next UTC day),
  where `rotate(M) = ((M << 1) | (M >> 6)) & 127` shifts each weekday bit
  d -> (d+1) % 7. Every half has `close <= 1440`, so the sweep invariant
  holds with ZERO changes to the cursor logic. The midnight seam merges
  automatically: the evening half closes at next-day 00:00 exactly, the
  morning half (open 0, sorted FIRST within its day) opens at 00:00, so
  `o > cursor` is false -- no zero-width band, no shaded sliver inside an
  open session (A3). Halves are paired by construction (rotate), so a
  morning half never fires without its evening half the day before.
  `days` semantics, documented: the UTC weekday the session OPENS.
  Validity domain: `close < open` is legal iff `open <= 1439` and
  `close >= 1` -- both already enforced by the existing range checks
  (:8507-8512), so ONLY the `close < open` throw is replaced by the split.
- **D2 -- holiday = whole-UTC-day closure, implemented as a day-skip in
  the sweep.** `holidays: number[]` (epoch ms, each truncated to its UTC
  day start; a Set built at normalize time -- cold path, MAY allocate per
  :8541-8542). In `_sessionBands`' day loop: holiday day -> contributes NO
  open intervals (both overnight halves included) -> the complement cursor
  swallows the whole day and fuses it with the neighboring gaps into ONE
  band. This is the only change `_sessionBands` needs (one param, one
  `continue`), so v1.11.0 byte-identity of the sweep does NOT survive --
  the replacement assertion is behavioral: no-holiday/no-overnight specs
  produce deepEqual band lists vs v1.12.0 (A1).
- **D3 -- holidays without sessions ride the SAME sweep.** When
  `shading.holidays` is present but `sessions` is absent, synthesize
  `sessions: [{ open: 0, close: 1440, days: [1,2,3,4,5] }]` (full-day
  Mon-Fri; complement = weekends + holidays). The synthesized spec carries
  `fill: null` so gap bands fall back to `shading.fill` /
  `DEFAULT_WEEKEND_FILL` -- weekend visual semantics preserved. The
  weekend walker is then never invoked for holiday configs (subsumption,
  same rule as v1.11.0 sessions).
- **D4 -- one fill for all gap bands; NO per-holiday fill.** A distinct
  `holidayFill` would break D2's merge (adjacent bands with different
  fills cannot fuse into one range). Trade documented in README; a caller
  who wants visually distinct holidays uses a user annotation on top.

## Config surface (the cut)

```
shading: {
  fill?: string,          // unchanged
  sessions?: [{ openMinutes, closeMinutes, days? }],  // close < open now LEGAL (overnight)
  sessionFill?: string,   // unchanged
  holidays?: number[],    // NEW -- epoch ms, truncated to UTC day start
}
```

Fail-closed doors (all at construction, nothing attached):
`holidays: []` throws (non-empty, mirrors `sessions` :8489-8491);
non-integer / non-finite / `null` entries throw (`== null` gate BEFORE
`Number.isInteger` -- null is not epoch 0); `holidays` present on the
non-object shading forms (`true` / `'weekends'`) is unreachable by
construction (only the object form carries it). `close === open` still
throws. Everything else unchanged.

## Worked arithmetic (anchor for the falsifiable assertions)

Globex-style ES: `{ openMinutes: 1320, closeMinutes: 1260, days: [0,1,2,3,4] }`
(opens Sun-Thu 22:00 UTC, closes next day 21:00). Extent = one full UTC week
[Mon 00:00, next Mon 00:00). After the D1 split:
evening half {1320, 1440, Sun-Thu}, morning half {0, 1260, Mon-Fri}.
Expected complement: EXACTLY 5 bands -- four 1h maintenance gaps
(Mon-Thu 21:00-22:00) and one 49h weekend gap (Fri 21:00 -> Sun 22:00).
Cursor trace: Mon morning half opens AT xMin (no band), closes 21:00; band
to Mon 22:00; same Tue-Thu; Fri morning half closes 21:00; Sat contributes
nothing; Sun evening half opens 22:00 -> band [Fri 21:00, Sun 22:00];
cursor lands exactly on xMax -> no tail band.

Same spec + holiday on Wednesday: Wed's day-skip removes Wed's morning
half AND Wed's evening half (both belong to Wed), but Tue's EVENING half
still runs [Tue 22:00, Wed 00:00) -- it belongs to Tue. Expected: still 5
bands -- [Mon 21, Mon 22], [Tue 21, Tue 22], the holiday band
[Wed 00:00, Thu 00:00] (Thu's morning half opens exactly at Thu 00:00, so
the holiday day emits as one clean day-band), [Thu 21, Thu 22],
[Fri 21:00, Sun 22:00]. NOTE the D2 approximation this exposes: a real
exchange usually also skips the PRIOR evening's open before a holiday --
that is early-close territory, explicitly OUT; document it in README next
to D4.

Fusion is best shown on the NYSE-style spec (no overnight):
`{ openMinutes: 810, closeMinutes: 1200 }` + holiday Wednesday over one
week -> the Tue-close-to-Thu-open stretch is ONE band
[Tue 20:00, Thu 13:30] (nothing opens in between, so the cursor never
breaks it).

The planner recomputes ALL three traces against the real loop before
locking A4/A5's numbers -- the brief's arithmetic is a target, not gospel
(the v1.11.0 planner's lunch-break slip is the precedent).

## Scope fences (explicit OUT)

- Early-close / half days (a per-date minutes override) -- OUT, candidate.
- Local-time / DST-aware sessions -- OUT forever at this layer; the suite
  is epoch-ms/UTC only, caller converts.
- Per-holiday fills or labels -- OUT (D4); user annotations cover it.
- Recurring holiday RULES ("third Monday of January") -- OUT, caller
  expands to dates.
- Time-axis compression (hiding closed periods) -- OUT, that is a scale
  feature, tracked separately in ROADMAP.

## Tasks (sketch -- planner to pin)

- T1: `_normalizeSessionSpec` -- replace the :8513-8515 throw with the D1
  split + rotate; add holiday validation + UTC-day-truncated Set; thread
  the Set through the returned spec.
- T2: `_sessionBands` -- holiday day-skip (`continue` before the session
  loop when the day is in the Set); signature gains the spec's holiday Set
  (or reads it off `spec`).
- T3: D3 synthesized full-day spec when holidays present without sessions
  (site: `createTimeLineChart` config assembly, Charts.js:8795-8796).
- T4: Charts.d.ts -- `SessionSpec.closeMinutes` doc (overnight legal),
  `TimeShadingConfig.holidays`.
- T5: docs -- README market-hours section (overnight + holidays, D4 trade,
  `days` = opening weekday), CHANGELOG (Changed: overnight no longer
  throws), llms.txt, ROADMAP.
- T6: torture A19 -- band-regeneration storm with overnight + holidays:
  0 new signal-graph nodes, bands regenerate on data change only, alloc
  ceiling matching A17's shape.

## Assertions (sketch -- qa to make falsifiable, prove by reversion)

- A1: no-overnight/no-holiday specs -> band lists deepEqual v1.12.0 output
  (behavioral identity; the sweep itself is edited so byte-identity is
  gone -- this replaces it).
- A2: `_weekendBands` byte-identical (SHA or source-region pin).
- A3: single overnight session, consecutive active days -> NO band
  touching the midnight seam inside the open span (the D1 auto-merge);
  reversion target: break the rotate() and A3 must go red.
- A4: the Globex week trace above -- exact from/to deepEqual, not counts
  (the v1.11.0 TS22 lesson: counts survive bound-corrupting reversions).
- A5: holiday fusion -- exact fused band bounds; reversion target: drop
  the day-skip and A5 must go red while A1 stays green.
- A6: holidays-without-sessions == weekend walker + holiday, compared on
  CLIPPED bands (see the clipping asymmetry note above).
- A7: fail-closed matrix -- `holidays: []`, `[null]`, `[NaN]`, `[1.5]`
  all throw at construction; `+null` never reaches a Date.
- A8: overnight validity edges -- `{open: 0, close: 1440}` (24h) legal via
  the normal path, `{open: 1439, close: 1}` legal overnight,
  `close === open` still throws.

## Gate

npm test (444 + new) + `node --expose-gc test/torture.mjs` -> ok. ASCII
clean. Demo untouched (a demo panel is a separate demo-session candidate).
No /release in this session unless the user invokes it.
