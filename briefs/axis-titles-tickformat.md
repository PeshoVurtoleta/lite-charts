# Brief #20: axis titles + tick-format callback -- v1.23.0 candidate

Queue item 3 (user-confirmed order, ROADMAP.md "Queue"). Two small cuts on the
axis kernel. Secondary y-axis stays OUT (a separate, bigger candidate, per the
queue note). Chart chrome (title/subtitle/caption) is queue item 4, NOT this
brief -- axis titles only.

## Current state (audited 2026-09-21, v1.22.0, Charts.js 12310 lines)

- **Tick formatting has ONE choke point**: `formatTickValue(v, axisFormat,
  timeUnit)` at Charts.js:1640 -- `'time'` goes through `formatTime` into the
  shared `_charBuf`, everything else through `formatNumber` with
  `_decimalsFor(v)` heuristic decimals. Called ONLY from the axis rebuild at
  :1806. The axis rebuild is a COLD path (comment at :1659: fires on resize /
  domain change, not per paint) -- label strings already allocate there by
  design.
- `opts.format` is derived internally at the two `buildAxis` call sites:
  `resolvedXType === 'time' ? 'time' : 'number'` (:7657) and `'number'`
  (:7672). Band axes (:4183) format category indices via their own path. There
  is NO user-facing formatting hook anywhere.
- **No axis titles exist.** `DEFAULT_MARGIN = { top:16, right:24, bottom:32,
  left:56 }` (:2297); tick labels sit at plot edge +8px (:1811/:1817). The
  errorBars clip comment at :2500 already says "axis or title margin" --
  aspirational; there is no title.
- lite-scene text nodes take `rotation` as a common prop (LiteScene llms.txt:30)
  -- a rotated y-title is a node property, no canvas save/rotate in charts code.
- SVG export walks scene nodes; `case 'text'` at :3955. Verify it honors
  `rotation` (emit a `transform="rotate(...)"` if it does not already).
- Horizontal bar swaps axes via the :4204 gate. Titles are SCREEN-edge
  concepts: `xTitle` is the bottom edge, `yTitle` is the left edge, regardless
  of which scale ended up there. Document this.

## UPDATE (2026-09-21, session grounding): Cut 0 discovered -- axis-kernel
## theme reactivity is BROKEN, and this brief's Cut B depends on the fix

Probe (scratchpad axis-theme-probe.mjs, H-RT4 mirror on createLineChart):
after `refreshTheme()` with a changed `--var`, tick labels AND tick lines
repaint with the STALE mount-time color. Root cause: buildAxis/buildBarAxis/
buildGrid consume colors via lite-scene node bindings (`fill: opts.labelColor`)
whose accessors `() => axisStyleRefs.labelColor.value` read a PLAIN ref -- the
binding effect tracks no signal, runs once at attach, caches `n._fill`, and
never re-fires; `markDirty` repaints the cache. Draw-fn consumers (crosshair
:8644, tooltip :8768, series colorRef, grid-kernel labels :12162) read
`.value` at draw time and are FINE. The existing refreshTheme tests
(test :1609-2067) assert only no-throw + redraw-fires, never a color value --
which is how this survived. The v1.22.0 "all four kernels theme-refresh" claim
is false for the axis kernel's scene-node chrome (spine, ticks, labels, band
labels, gridlines).

**Cut 0 (ships in this v1.23.0 cut, prerequisite for Cut B's theme door)**:
one `axisThemeVersion` signal per chart (the annThemeVersion :6941 /
ebThemeVersion :6949 precedent), TRACKED inside the color getters at the four
call-site groups (grid `color` :7633, x-axis :7654-7655, y-axis :7669-7670,
titles), bumped in refreshTheme() after :8814. buildAxis/buildGrid/
buildBarAxis bodies untouched -- they already bind whatever accessor they get.
Polar/radar kernels: out of scope here; audit them for the same staleness in a
follow-up (they have their own refreshTheme at :10053/:10921).

## Cut A -- tick-format callback

- Config: **`xTickFormat?: (v: number) => string`** and **`yTickFormat?`**,
  flat keys mirroring the `xScale`/`yScale` pairing. Applies to the axis-kernel
  charts only (line/area/bar/hbar/scatter/bubble/stacked/candlestick/
  time-series). Polar/radar/grid kernels: out of scope (radar has no tick
  axes; heatmap labels are category strings, not formatted ticks).
- Wiring: thread the callback into `buildAxis` opts; at :1806 use it INSTEAD of
  `formatTickValue` when present. The callback also overrides `'time'`
  formatting (the user asked for the format; document that a time axis passes
  raw epoch ms to the callback).
- Band (category) axes: callback receives the category LABEL's index? NO --
  fail closed: band axes IGNORE tickFormat this cut; document it. (Formatting
  a category string is renaming data, not formatting an axis.) If the planner
  disagrees, the alternative is receiving the category string -- record the
  decision either way.
- **Fail closed**: non-function config value throws at construction naming the
  key. A callback return that is not a string throws at axis-rebuild time
  naming the axis and the offending tick value (cold path -- the throw is
  affordable; silent String() coercion is fail-open).
- Allocation: callback strings allocate on the cold rebuild exactly as
  `charBufToString` already does. The callback must NOT be reachable from any
  per-frame draw -- it lives only at :1806. The default path (no callback)
  stays BYTE-IDENTICAL: diff `formatTickValue` and the :1806 site, hash-parity
  style.

## Cut B -- axis titles

- Config: **`xTitle?: string`**, **`yTitle?: string`** (axis-kernel charts
  only, same scope as Cut A).
- Render: one pooled lite-scene text node per configured title, created at
  construction, repositioned by the existing plot-bounds effect (NOT a new
  effect if the axis effect can own it). xTitle centered under the x tick
  labels; yTitle centered vertically at the left edge with `rotation`
  -Math.PI/2 (reads bottom-to-top, the convention).
- **Margin**: when a title is configured AND the user did not set that side's
  margin, the resolved default for that side gains `TITLE_MARGIN` (a named
  const, ~18-20px -- font size + gap; pick from the actual label font). A
  user-supplied `margin.bottom`/`margin.left` is ABSOLUTE and wins -- no
  stacking on top of an explicit number (null-gate per side: `m.bottom != null`
  already isolates each side at :6808-6811).
- Theme: title color = the resolved axis label color; must re-resolve on
  `refreshTheme()` like every other themed node (all four kernels have theme
  parity as of v1.22.0 -- do not regress that story; only the axis kernel gains
  titles).
- SVG export: title text must appear in `exportSVG()` output, rotated y-title
  included (this is the likely gap -- check :3955 for rotation handling before
  claiming it).
- `destroy()`: title nodes die with the scene like every pooled node -- no new
  disposal path expected; assert anyway.

## Assertions (qa = me; agents produce ZERO tests)

- xTickFormat/yTickFormat: called for every KEPT tick (thinning still applies
  first); label text equals the returned string exactly; default output
  unchanged when absent (existing 558 tests are the parity proof).
- Construction throw on non-function; rebuild throw on non-string return, both
  named. Time axis passes epoch ms. Band axis ignores it (or per recorded
  decision).
- Titles: node exists only when configured; xTitle centered on plot width;
  yTitle rotated and centered on plot height; margin auto-bump only when that
  side is un-set (explicit margin wins, asserted both ways); theme toggle
  recolors; exportSVG contains both title strings; destroy clean.
- Torture: A28 tier -- axis rebuild storm (1k domain changes) with a callback
  installed, gate on retained growth as usual; 0 B/frame on paint unchanged.
- Reversion proofs: (1) remove the :1806 callback branch -> format tests fail;
  (2) remove the margin bump -> title overlap test fails; (3) remove the
  non-string throw -> fail-closed test fails.

## Gate

- 558 -> ~572+ tests green; `node --expose-gc test/torture.mjs` no FAIL.
- ASCII grep; grep for stray tool-call tags; Charts.d.ts updated in the same
  cut; llms.txt + CHANGELOG at /release time only.
- No version bump until `/release 1.23.0` is invoked (user publishes).

## AS-EXECUTED (2026-09-21) -- all four cuts landed, 572/572 + torture A28 + 3 reversion proofs, reviewer APPROVED

Pipeline: lead grounded + planned (planner lesson standing), coder landed all
tasks in two rounds, reviewer APPROVED zero blockers across 8 judgment calls
(one turn-limit resume), qa = lead. Deviations from the spec above, all
lead-caught in qa:

1. **The non-string throw moved to the C0 idiom** (the spec's direct throw in
   `_applyTickFormat` violated the file's own :7458 no-throw-in-effect law --
   leaked effect node on failed mount, mid-gesture throw on later rebuilds).
   As landed: buildAxis records `_fmtError` (non-string return OR a throwing
   callback, try/catch), hides the label, and exposes `get formatError()`;
   mount() re-throws AFTER the axis disposers register, with a full disposer
   unwind + scene.dispose (the scene holds the axis binding effects by then --
   the pre-scene :7675 unwind does not cover them). Later re-runs are
   fail-safe: labels hide, no throw (AXT7).
2. **Doors hoisted above the first `_own(signal(...))`** -- the spec placed
   them after widthAutoSig/heightAutoSig, leaking 2 owned signals on a
   rejected construction (AXT4 caught it; the v1.15.0 legend-hoist precedent).
3. **`const m = config.margin || DEFAULT_MARGIN` was a dead-branch trap** (a
   SPEC bug): with no config.margin, `m.bottom != null` was always true and
   the title bump unreachable. Landed as `config.margin || null` +
   `m && m.side != null` per side -- byte-identical resolution for every
   existing config.
4. **Cut 0 confirmed end-to-end**: probe + AXT11 prove refreshTheme now
   recolors spine/ticks/labels/gridlines/titles on the axis kernel; R3
   reversion (bump commented out) turns exactly AXT11 red. The polar/radar
   kernels were NOT audited for the same staleness -- follow-up candidate.
5. **Torture A28 measurement note**: first-pass rebuild/theme storms carry
   process-warming noise (18-33 B/op converging to 0.0-0.2 at steady state,
   features and base alike), so A28 gates pass 1 at a 128 B/op gross-leak
   ceiling and the steady-state pass 2 at the tight floor (8 B/op), plus
   zero signal-graph growth. BREAK control verified failing.

Tests: 558 -> 572 (AXT1-AXT14); reversion proofs R1 (neutered format branch ->
format tests red), R2 (no margin bump -> AXT10 red), R3 (no theme bump ->
AXT11 red), each restored from a scratchpad copy. Release pending:
`/release 1.23.0` -> user publishes -> `/sync-card`.

## Out of scope

- Secondary y-axis. Chart title/subtitle/caption (queue item 4). Polar/radar/
  grid tick formatting. Tick COUNT/placement control (lite-axis owns that).
  Demo panel (a demo-refresh follow-up shows both cuts later; demo is
  demo-only, separate session).
