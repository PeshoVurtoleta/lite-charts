# Brief: demo refresh -- session 2 of 2 -- catch-up panels (v1.13 / v1.15 / v1.18 / v1.20)

**Demo-only. Not shipped** (demo/ is absent from package.json `files[]`): no
/release, no version bump. Charts.js, Charts.d.ts, and test/ are UNTOUCHED --
a library bug found here is a separate brief, not a drive-by fix.

Session **2 of 2**. Depends on session 1 (`demo-refresh-1.md`) only for the
branding pass (title/badge already at v1.21.0); this session adds the four
older-cut panels that the v1.19.0/v1.21.0 branding implies but the demo never
showed. Independent of session 1's relief/candle/error-bar work. Each panel
reuses an existing dataset or section where possible.

## Current state (audited 2026-09-17)

After session 1: demo branded v1.21.0, importmap carries lite-depth@2.0.0,
`createCandlestickChart` imported, relief + candle + error-bar panels present.
Still missing (this session):

| Missing | Feature |
| --- | --- |
| v1.13.0 | overnight sessions + holiday calendar (shading.holidays) |
| v1.15.0 | horizontal (top/bottom) legend virtualization; early-close half-days |
| v1.18.0 | cluster outlines (scatter outlines: convex hull / alpha shape) |
| v1.20.0 | brush v2 (brushModifier + idsBySeries + horizontal-bar band multi-select) |

Anchors:
- importmap: index.html:830-838 -- bump `@zakkster/lite-delaunay` **1.3.0 ->
  1.4.0** (cluster outlines' `createClusterIndex`; 1.4.0 is a superset, the
  field/relief panels' `createFieldIndex` is unaffected). Confirm the 1.4.0
  main filename before pinning.
- two-cluster dataset already exists (index.html:2646-2655, `cluster:'A'|'B'`)
  and feeds the Voronoi panel -- the outlines panel REUSES it verbatim.
- legend section (index.html:3507+) uses position:'right' -- the horizontal
  variant is an added sibling, not a rewrite.
- brush section (index.html:3206+) and its status line -- the brush-v2
  extension point.
- time-series section (index.html:3434+) -- the overnight/holiday/early-close
  extension point.
- ASCII-only page. Grep before done.

## Tasks

### T1 -- cluster outlines (v1.18.0)
- Bump delaunay to 1.4.0 in the importmap; import `createClusterIndex`.
- New scatter panel reusing the two-cluster dataset (2646-2655):
  `outlines: { index: createClusterIndex(N), groupKey: 'cluster' }` for convex
  hulls, and a second instance with `alpha: <px>` for the concave alpha shape.
- Copy: injected geometry (charts imports nothing), one boundary per group,
  alpha shapes split / carve holes (multi-loop), > 64 groups is a layer fault.

### T2 -- brush v2 (v1.20.0)
- Extend the brush section: set `brushModifier: 'alt'` on one chart (copy notes
  the configurable modifier -- unknown value throws at construction). Add a
  status line reading `idsBySeries` (per-series commit-time snapshot) beside the
  primary visibility-blind `ids`.
- On the horizontal-bar chart: demonstrate modifier+click band multi-select
  (non-contiguous bands) and show the `{ bands }` payload; note bandMin/bandMax
  are the hull and the overlay draws one rect per contiguous run.

### T3 -- overnight sessions + holidays + early close (v1.13.0 / v1.15.0)
- Extend the time-series section: one chart with an OVERNIGHT session
  (`closeMinutes < openMinutes`, e.g. CME Globex 17:00 -> 16:00 in UTC), one
  with `shading.holidays: [Date.UTC(...)]` (copy warns: UTC day-start epoch-ms;
  `null` is not epoch 0; `new Date(y,m,d)` is LOCAL midnight -- use Date.UTC),
  and one early-close entry `{ ts, closeMinutes }`.
- Copy states the UTC-only, pre-convert-to-UTC contract; overnight `days` names
  the weekday the session OPENS.

### T4 -- horizontal legend virtualization (v1.15.0)
- A sibling of the existing legend panel with `legend: { position: 'top',
  virtualize: <mountList adapter>, width, itemWidth }`. Keys are
  orientation-EXCLUSIVE: top/bottom REQUIRE width + itemWidth; supplying
  height/itemHeight THROWS. Reuse the existing legend adapter.
- Status line: live DOM row count (querySelectorAll length) vs series count to
  make O(window) visible horizontally. Copy: focus does not survive scroll-out
  (pooled rows).

### T5 -- sweep
- Theme toggle exercises every new panel (refreshTheme).
- `grep -n "v1\.[0-9]" demo/index.html` and read every hit; kill any stale copy
  (any "deferred / fail-closed / not yet" wording now false).
- ASCII grep; grep for stray tool-call tags.

## Gate (this session; the library gate is untouched)
- `node demo/serve.js` -> page loads with ZERO console errors/warnings in BOTH
  themes (verify in the browser preview).
- Each new interactive claim exercised once: cluster hull vs alpha, brush
  modifier + idsBySeries status + horizontal band multi-select, overnight /
  holiday / early-close shading, horizontal virtual-legend scroll + click on a
  recycled row.
- `npm test` still passes at its current count (proves Charts.js untouched).
- ASCII grep; stray-tag grep.

## Out of scope
- Session-1 panels (relief / candle / error bars) -- see `demo-refresh-1.md`.
- Any Charts.js/d.ts/test change.
- Demo bundling/minification; serve.js changes.
