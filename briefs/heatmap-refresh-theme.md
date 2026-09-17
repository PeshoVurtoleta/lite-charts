# Brief #19 -- Heatmap refreshTheme (v1.22.0 candidate)

Status: EXECUTED 2026-09-17 (greenlit same day; user-reported library gap,
same-session cut). Full pipeline ran: planner (turn-limited at 12; plan
re-emitted by orchestrator from this brief's grounding) -> coder (all
tasks landed first pass) -> reviewer (APPROVED, all seven judgment calls
verified, zero findings) -> qa=me. 558/558 tests (6 new, H-RT1..H-RT6),
torture gate ok, 1 reversion proof (neutered refreshTheme body -> H-RT2/
3/4/5 fail, RT1/RT6 legitimately survive). Bonus find during grounding:
Charts.d.ts already declared refreshTheme on the shared `Chart` interface,
so this closes a types-vs-implementation mismatch, not just a parity gap.
Remount-after-unmount now re-resolves original tokens (was: double-
resolved concrete values) -- in CHANGELOG Fixed. Awaiting /release
(v1.22.0 target; may bundle with queue item 3 axis titles).

One cut: give the grid kernel (`createBaseGridChart`, sole consumer
`createHeatmap`) the `refreshTheme()` method every other chart type already
has. Size: S.

## The gap

Every other kernel exposes `refreshTheme` to re-resolve CSS-var color
tokens after a light/dark theme switch:

- axis kernel (line/area/bar/bubble/scatter/candlestick): `const
  refreshTheme = () =>` at Charts.js ~:8801, on the chart object at ~:8848.
- polar kernel (pie/donut): inline `refreshTheme: () =>` at ~:10053.
- radar kernel: ~:10921.

The grid kernel's chart object (~:11985) has NO such key. A heatmap
configured with `--token` colors is frozen at mount-time resolution; only
a full destroy/re-create tracks a theme change. Surfaced by the demo's
theme toggle loop `for (const c of ALL_CHARTS) c.refreshTheme()` throwing
on heatmap entries (demo since hardened with a typeof guard; the library
gap is this brief).

## Grounding (2026-09-17, Charts.js @ v1.21.0, worktree clean)

All cites verified this session. The planner re-grounds anyway.

- **Six theme-affected specs, resolved IN PLACE at mount** (:12061-12067):
  `opts.colorLow`, `opts.colorHigh`, `opts.labelColor`,
  `opts.highlightStroke`, `opts.rowColumnHighlightFill`,
  `opts.valueLabelColor` are each overwritten via
  `opts.X = resolveColor(opts.X, container)`. The original spec strings
  (the `--var` tokens) are DESTROYED at mount. Any refreshTheme must
  capture the pre-resolution specs first -- this is the one structural
  delta vs the other kernels, which kept spec-vs-ref separation
  (axis kernel comment :7007 "Store raw specs + resolved refs").
- **Cell colors are PRECOMPUTED at extract time** into
  `state.cellColors` / `state.cellLabelColors` by
  `renderer.computeColors(state, opts)` (`_computeGridColors`, :11684).
  Re-resolving `colorLow`/`colorHigh`/`valueLabelColor` alone changes
  nothing on screen: refreshTheme must re-run
  `renderer.computeColors(state, opts)` after the re-resolve, then
  `scene.markDirty()`. This is a COLD path (theme switch); its transient
  allocs (bin color strings) are the same class as the annotation layer's
  cold resolve step -- allowed, per-frame path untouched.
- **`valueLabelColor: 'auto'` sentinel** (:11901): `resolveColor('auto',
  container)` passes non-`--` strings through unchanged, so 'auto'
  survives resolution and `_computeGridColors` still sees
  `opts.valueLabelColor === 'auto'` for the per-cell contrast path.
  Re-resolve from the captured spec keeps this invariant. Verify with a
  boundary assertion, not by assumption.
- **`colorFn` path**: user function, opaque, nothing to re-resolve --
  but computeColors re-runs it; harmless and correct (a theme-aware
  colorFn closure actually benefits).
- **Draw-time reads**: `opts.labelColor`/`labelFont` (axis-labels node
  :12127), `opts.highlightStroke`/`rowColumnHighlightFill` (hover node
  :12156-12176) are read from `opts` per draw -- in-place re-resolve is
  sufficient for those, no refs needed.
- **Chart object shape**: `mount`/`unmount`/`destroy`/`exportSVG` are
  assigned after definition (:12273-12276); `refreshTheme` follows the
  same pattern. Guard `if (!mounted) return;` mirrors :8802 (safe no-op
  before mount / after unmount -- and `container` is null then).
- **resolveColor** (:59): `--`-prefixed -> getComputedStyle(container)
  lookup, '#888' fallback closed; anything else passes through.
- **Test precedent**: A5 (:7479, charts.test.js) swaps
  `globalThis.getComputedStyle` in a try/finally to simulate the theme
  change, counts calls to pin resolution OFF the redraw path.
- **Docs surface**: Charts.d.ts heatmap interface (three existing
  `refreshTheme(): void;` decls at :558/:1050/:1182 belong to the other
  kernels); llms.txt heatmap method list; README heatmap API table +
  the theme section (:897 already says "every chart" -- becomes true).

## The cut

1. After `const opts = renderer.initOpts(config)` (:11966), capture the
   six theme spec ORIGINALS (plain object or six consts -- planner's
   call; cold, construction-time, one-time).
2. mount() resolves from the captured specs into `opts` (byte-identical
   behavior first mount; remount after unmount now re-resolves original
   tokens instead of double-resolving -- strictly better, note in
   CHANGELOG).
3. `const refreshTheme = () => { if (!mounted) return; <re-resolve all
   six from specs into opts>; renderer.computeColors(state, opts);
   if (scene) scene.markDirty(); }` -- assigned onto `chart` beside
   mount/unmount. NO new signals, NO effect, NO per-frame delta.
4. Docs: Charts.d.ts grid/heatmap interface + llms.txt + README heatmap
   API table + CHANGELOG entry.

## Assertions (qa = me, boundary suite)

- H-RT1: `refreshTheme()` before mount and after unmount: safe no-op.
- H-RT2: mounted heatmap with `colors: ['--lo', '--hi']` under a swapped
  `getComputedStyle`: after theme flip + `refreshTheme()`,
  `state.cellColors` strings CHANGE to the new ramp (assert on
  `_internal.state.cellColors` content, not on a draw side effect).
- H-RT3: `redraw()` alone does NOT re-resolve (getComputedStyle call
  count pinned, D2 discipline; per A5).
- H-RT4: `labelColor: '--tok'` re-resolves and the redraw paints labels
  with the new value (fillStyle recorded by mock ctx).
- H-RT5: `valueLabelColor` default 'auto' survives refreshTheme (per-cell
  contrast labels still computed; explicit `--tok` label color also
  re-resolves).
- H-RT6: refreshTheme causes a repaint (ctx.calls after markDirty under
  sync schedule).
- Gates: full suite (552 -> +new) green; `npm run torture` ok (no new
  tier needed -- refreshTheme is cold; T6 retained-growth gates must stay
  green untouched).

## Out of scope

- No new torture tier (cold path; reviewer source-audits the diff for
  hot-path deltas instead -- T6 sees only RETAINED growth).
- No legend (grid kernel has none), no annotation/error-bar hooks (axis
  kernel only).
- exportSVG picks up re-resolved colors for free (draws from the same
  opts/state) -- assert only if cheap.
