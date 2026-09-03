# Brief -- lite-charts-gl rescue: gate the orphan, publish 0.1.0

Status: WRITTEN 2026-09-03 from the condition report (this session, read-only
audit of ~/Work/Portfolio/LiteLibrariesSuite/LiteChartsGl). EXECUTES IN THE
LiteChartsGl REPO, not here -- this ledger row exists because the suite's
cross-package briefs live with lite-charts (the #10 precedent). Run it as a
LiteChartsGl session: `cd ../LiteChartsGl && claude`.

## Goal

`@zakkster/lite-charts-gl@0.1.0` on npm, eligible under suite law. The
package is NOT a skeleton -- 2466-line ChartsGL.js, 18 exports (line/scatter/
heatmap GL renderers, axes, pan/zoom/brush/hover interactions, ring-buffer
streaming, zero-alloc LTTB decimation), 117 mock-GL node:test tests, a full
demo -- but it has never been eligible to publish: no git history, no torture
harness (the zero-GC claim is UNPROVEN -- zero references to lite-leak or
lite-gc-profiler anywhere), and version lies in its own docs. This brief is
release mechanics plus ONE real engineering task (the torture tiers).

## Grounding (from the 2026-09-03 condition report)

- Single burst 2026-07-06/07, untouched since (mtimes; there is no git).
- `npm test` dies TODAY at import: no node_modules, no lockfile,
  `@zakkster/lite-signal` unresolvable. "117 tests pass" is
  stale-by-environment until reproven.
- Version lies: llms.txt line 1 claims `(v1.0.0)` against package.json
  `0.1.0-alpha.1`; ChartsGL.js line ~9 says "sibling to @zakkster/lite-charts
  (v1.4.0)" -- nine minors stale. No exported `VERSION` const.
- README: 13 non-ASCII chars (em dash, x-sign, arrow, (c)); CHANGELOG: 4.
  Off the LiteSepforge blueprint: no TOC, no Benchmarks (no bench/ exists),
  no "What this is not"; forward-references a ROADMAP.md that does not exist.
- package.json: zero deps, one peer (`@zakkster/lite-signal >=1.0.0` -- fine,
  local is 1.5.x), `sideEffects:false`, files[] whitelist sane. The catalog
  card says `peers: []`, contradicting package.json.
- Architectural note (NOT this brief's problem): the original companion brief
  specified building on lite-gl's PointHiSink; the alpha hand-rolls its own
  GLSL/scales/ticks instead, and lite-gl has since shipped 2.0.0 with exactly
  those sinks. The shader layer is entirely internal to the module, so
  publishing 0.1.0 forecloses nothing.

## Design decisions

- **D1 -- gate first, judge second.** No feature work, no refactors, no
  lite-gl migration in this cut. The alpha's four self-declared caveats (no
  .d.ts, STATIC_DRAW heatmap, O(N)-per-append LTTB fold, single series) ship
  AS caveats, stated plainly in README and CHANGELOG.
- **D2 -- the torture harness is the one real build.** Model on
  LiteCharts/test/torture (tiered runner + harness.mjs), scoped to four
  tiers: T0 metamorphic laws (domain fold, LTTB invariants, pan/zoom math),
  T6 zero-alloc gates (appendPoints ring path, decimateLTTB into caller
  buffers, the pointer path's persistent Float64Array claim) via
  lite-gc-profiler, T7 mount/unmount + attach/detach soak via lite-leak, T9
  negative controls (an injected retained alloc must FAIL each gate --
  no gate ships unproven, the CHARTS_TORTURE_BREAK pattern). Mock-GL only;
  real-GPU validation stays deferred (D5).
- **D3 -- truth before polish.** Every version string in the repo must be
  real: llms.txt header to the actual version, the ChartsGL.js sibling note
  to lite-charts' CURRENT major.minor at execution time (read it, don't
  hardcode), and a `VERSION` const exported and string-compared to
  package.json in the test suite (the /release step-4 gate needs it).
- **D4 -- blueprint README, honest numbers only.** Sepforge spine: TOC, Why
  this exists, What you get, API reference, Composability, Zero-GC design
  notes (the new torture numbers -- measured, not aspirational), Benchmarks
  (demo-measured fps counts are acceptable if labeled as such; NO invented
  figures), Testing, What this is not (SSR, real-GPU CI, multi-series,
  live heatmap -- the caveats), Ecosystem, License. ASCII scrub throughout
  (U+00D7/U+00B5 excepted). Write the missing ROADMAP.md: v0.2 candidates
  (multi-series, DYNAMIC_DRAW heatmap, incremental LTTB) + the 1.0.0
  decision gate (D5).
- **D5 -- the lite-gl question is DEFERRED, explicitly.** ROADMAP.md records
  the fork in the road for 1.0.0: rewrite the render core on
  createPointHiSink/createQuadSink/createLineSink (GPU camera, ID-buffer
  picking, the 1M@60fps headline becomes defensible) OR formally retire the
  companion brief and declare the standalone shader layer the design. Not
  decided here; user decides at 1.0.0 planning.

## Tasks

- T1: `git init`, initial commit of the tree AS-IS (the archaeological
  baseline -- gates and fixes land as visible diffs on top).
- T2: devDeps + install (`--legacy-peer-deps` per suite convention;
  lite-signal, lite-leak, lite-gc-profiler, matching LiteCharts' pins);
  prove the 117 tests green or fix what rot broke.
- T3: torture harness per D2. Every gate output must be a non-FAIL; T9
  controls must demonstrably bite.
- T4: truth pass per D3 (llms.txt header, sibling note, VERSION const +
  sync test, catalog-card peers note queued for /sync-card).
- T5: README to blueprint + ROADMAP.md + ASCII scrub per D4; CHANGELOG
  entry for 0.1.0 (facts + measured numbers from T3).
- T6: `/release 0.1.0` (the GL repo gets the same skill), then USER
  publishes + commits + `/sync-card lite-charts-gl` (fixes the `peers: []`
  card lie).

## Scope fences (explicit OUT)

- lite-gl migration, multi-series, live heatmap values, incremental LTTB,
  .d.ts, Playwright/real-GPU CI, the 1M pan bench -- ALL out (D1/D5;
  .d.ts and the bench are 1.0.0-lane work).
- No API changes of any kind: 0.1.0 is the alpha surface, gated.

## Gate

npm test green (117 + the new VERSION-sync + any T3-adjacent unit tests),
torture runner all tiers non-FAIL with T9 controls proven, ASCII clean,
`npm pack --dry-run` excludes demo/test, includes llms.txt + CHANGELOG.
