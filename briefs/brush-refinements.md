# Brief #17 -- Brush v2 (v1.20.0 candidate)

Status: EXECUTED 2026-09-08 (greenlit 2026-09-06; queue position 1 of 7).
Full pipeline ran: planner -> coder (3 rounds) -> reviewer (REJECTED the
cancel/leave click-branch fail-open; fixed via onBrushAbort) -> qa=me.
ALL THREE cuts + the mandatory fix landed in one v1.20.0 candidate (no
v1.21.0 split). 543/543 tests (29 new + the HB2 re-pin), torture ok with
the new A26 gate, 4 measured reversion proofs. Two execution deltas vs
this brief: (1) the moved-latch -- commits are gated on crossing the 3px
threshold, else sub-threshold jitter replaces the selection before the
toggle (found in review); (2) aborted gestures (pointercancel/leave) skip
the click branch entirely. Awaiting /release.

Three cuts on the brush surface plus one mandatory fix. Cuts 1 + 2 + the
fix alone are a releasable v1.20.0; cut 3 is the biggest and the planner
may split it to v1.21.0 if the diff bloats. Size: M overall (S / S-M / M).

## Grounding (2026-09-06, Charts.js @ v1.19.0, 11,615 lines)

All line cites verified against the shipped file. The planner re-grounds
anyway (the v1.7.0 lesson: releases shift lines).

- **Modifier is hardcoded.** Two gate sites read `ev.shiftKey` literally:
  the pan handler yields to brush at :7472 (`if (brushEnabled &&
  ev.shiftKey) return;`) and `onBrushDown` requires it at :7629
  (`if (!ev.shiftKey) return; // bare drag = pan; shift = brush`).
  No config key exists.
- **ids are primary-only.** `_commitBrush` reads `seriesStates[0]` in both
  branches (:7677-7685 horizontal, :7691-7698 vertical); the comment at
  :7645-7648 documents multi-series filtering as the caller's job.
  `_computeBrushIds(xs, ys, n, xMin, xMax, yMin, yMax)` is a pure
  module-level helper (:2647), exported via `_testHelpers` (:10658).
- **Band selection is contiguous.** The horizontal commit walks
  `for (let b = bandMin; b <= bandMax; b++) bands.push(cats[b])`
  (:7665-7675); the facade re-derives a contiguous span when the caller
  omits `bands` (:6790-6799); the overlay draws ONE rect spanning
  `leftEdge(bandMin) .. leftEdge(bandMax) + bandWidth` (:7380-7388).
  Non-contiguous band sets are inexpressible.
- **FAIL-OPEN FOUND during grounding (fix is IN scope regardless of which
  cuts land):** the VERTICAL `brushFacade.set` branch coerces
  `xMin: +v.xMin` etc. with NO `== null` gate and NO `Number.isFinite`
  check (:6810-6816) -- `setBrush({xMin: null, xMax: 5, yMin: 0,
  yMax: 10})` silently becomes bound 0 ("null is not zero" violated; see
  memory [[null-coercion-failopen]]). The HORIZONTAL branch was fixed for
  exactly this in v1.9.0 (HB3, :6778-6788 gates `== null -> NaN` first);
  the vertical branch never was. The overlay's `isFinite` guard (:7395)
  only hides NaN, not a silent 0.
- **Visibility:** `seriesVisibility` is one signal per series; event
  handlers must read via `.peek()`/untrack (the house idiom -- no
  subscription from a gesture path).
- **Payload pins:** existing tests deepEqual exact brush payload shapes
  (HB1-HB7, brush tests in the v1.4.x block). Additive keys will re-pin
  some of them; that is expected churn, list it in the plan.

## Cut 1 -- configurable brush modifier (S)

`config.brushModifier: 'shift' | 'alt' | 'ctrl' | 'meta'`, default
`'shift'` (shipped behavior unchanged). Resolve ONCE at setup (cold) to a
predicate `ev => ev.<key>Key`; both gate sites (:7472, :7629) call the
predicate. Junk value THROWS at construction, pre-signal, zero node delta.

- `'none'` is OUT for v1: with `pan: true` a bare drag already pans, so a
  modifier-less brush is ambiguous. Named trigger: a consumer with
  `pan: false` who wants drag-to-brush.
- Docs note, not code: on macOS `alt` is Option; `ctrl`+drag risks the
  context-menu gesture. Document, do not special-case.

## Cut 2 -- brush IDs across all visible series (S-M)

Design decision is payload compatibility. Options for the planner:

- (a) RECOMMENDED: `ids` stays primary-only (no consumer breaks); ADD
  `idsBySeries: (number[] | null)[]` -- one entry per configured series,
  `null` for a hidden series (visibility read untracked at commit time)
  and for an empty series. Computed on the GESTURE commit path only; the
  programmatic `setBrush` keeps taking caller `ids` verbatim (:6806,
  :6815 -- the existing asymmetry is documented behavior, do not "fix"
  it into a recompute, callers would be surprised).
- (b) REJECTED unless the planner overturns: union `ids` across series --
  loses series attribution AND silently changes meaning for primary-only
  consumers.

The horizontal (swapAxes) branch works byte-identical: `state.xs` holds
the band index and `state.ys` the value for every series, so the same
`_computeBrushIds` loop applies per series. Allocation: per-commit arrays
match the existing `ids` behavior -- the commit is a cold gesture path,
not the frame path; keep it that way and say so in the torture case.

Snapshot semantics: the payload is a commit-time snapshot. Toggling a
series' visibility AFTER a brush does NOT recompute `idsBySeries`
(documented; recompute-on-visibility would need the brush effect to track
visibility signals -- rejected, scope creep into reactive machinery).

## Cut 3 -- horizontal-bar band multi-select (M)

Non-contiguous band sets on the horizontal-bar brush.

- Gesture: modifier+CLICK on a bar TOGGLES its band in/out of the current
  selection; modifier+DRAG keeps selecting a contiguous range (replacing
  the selection, as today). The click-to-clear threshold (:7725) already
  distinguishes click from drag -- the toggle rides that branch instead
  of unconditional `brushSig.set(null)`. Clicking outside every band (or
  toggling the last band off) clears -- empty selection is null, never
  `{bands: []}`.
- Payload: `bands` (already an array) may now be non-contiguous;
  `bandMin`/`bandMax` become the HULL (documented -- envelope consumers
  keep working). `ids` filtering switches from a range test to set
  membership over band indices: a grow-only pooled scratch (Uint8Array
  flags indexed by band) -- no Set allocation in the commit, mirror the
  `_candleDtScratch` module-scratch idiom.
- Overlay: one rect per contiguous RUN of selected bands. Runs are baked
  COLD at commit into pooled flat geometry; `drawBrushOverlay` walks them
  at 0 B/frame (the candle two-pass precedent). A single contiguous
  selection must draw byte-identically to today's one-rect path.
- `setBrush`: a caller-supplied `bands` array is already accepted
  verbatim (:6791-6792) -- now VALIDATE it fail-closed: every entry must
  be an existing category key (throw on unknown, `== null` gated), and
  `bandMin`/`bandMax` are re-derived as the hull rather than trusted.
- OUT: multi-select on the VERTICAL brush (a free data-space rect has no
  band semantics -- refusal on the ledger, not a gap); persistence of a
  selection across a data swap beyond category-key identity.

## Mandatory fix -- vertical setBrush null gate

Mirror the horizontal branch: `v.xMin == null ? NaN : +v.xMin` for all
four bounds, then `Number.isFinite` or THROW the existing vertical shape
error (:6771). Reversion-provable: revert the gate and a null bound draws
a rect anchored at 0.

## Assertion seeds (qa = me; agent produces zero tests, plan for that)

- Modifier matrix: each of the four keys gates brush AND leaves bare-drag
  pan working; wrong-modifier drag pans, never brushes. Junk modifier
  throws with zero signal-graph node delta (destroy-first if mounted).
- Null-gate fix: `setBrush({xMin: null, ...})` throws on vertical charts;
  reversion -> silent 0-anchored payload -> red.
- idsBySeries: exact per-series equality vs a brute-force scan, including
  a hidden series' `null` slot and an empty series; horizontal payload
  gains the same key; primary `ids` byte-identical to v1.19.0.
- Multi-select: toggle in / toggle out / toggle-last-clears; ids set
  membership vs brute force on a non-contiguous selection; hull
  `bandMin`/`bandMax`; unknown key in `setBrush({bands})` throws.
- Overlay: op-log parser counts one rect per run (1 run == today's
  byte-identical single rect); SVG parity.
- Torture: gesture storm B/op within 2 B/op of a v1.19.0-shape control;
  commit-path allocation documented as cold (NOT asserted to 0 -- ids
  arrays are per-commit by existing design).
- Reversion discipline: every new guard proven load-bearing by measured
  reversion (TS22/V4/CS4 lesson -- watch for tests that stay green when
  the guard dies).

## Risks

1. Doc churn: brush payloads are described in README (3+ sites),
   llms.txt, Charts.d.ts, and the catalog card -- budget a full pass.
2. Multi-select overlay 0 B/frame only holds if runs bake at commit;
   a per-frame run derivation is the trap.
3. Existing deepEqual payload pins go red on additive keys -- re-pin
   deliberately, never loosen to subset matching.
4. Cut 3's gesture design is the likeliest planner overturn (e.g.
   toggle-click vs additive-drag); the payload/pooling constraints above
   survive any gesture choice.
