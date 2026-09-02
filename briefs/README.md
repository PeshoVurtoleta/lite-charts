# lite-charts -- next-session briefs

Local working scratch. **Not shipped** -- `briefs/` is absent from
package.json `files[]`, so nothing here reaches npm. Each brief is a
self-contained plan for one future `cd LiteCharts && claude` session.

Current shipped state: **v1.12.0** (legend virtualization via caller-injected
`virtualize` adapter; market-hours session shading v1.11.0; weekend shading
v1.10.0, on the annotation layer from v1.7.0; horizontal-bar pan/zoom/grid
v1.8.0 + brush v1.9.0; x-axis log scale + mixed-sign log floor from v1.6.x).
The forward plan in `../ROADMAP.md` points here.

## The set, in recommended order

| # | Brief | Kind | Size | Why this order |
| --- | --- | --- | --- | --- |
| ~~1~~ | ~~`v1.6.1-mixedsign-log-floor.md`~~ | **SHIPPED v1.6.1** | XS | Closed the one known gap in v1.6.0. Kept for reference. |
| ~~2~~ | ~~`annotation-layer.md`~~ | **SHIPPED v1.7.0** | M | Data-pinned line/range/point/text marks; zero per-frame alloc, fail-closed, exportSVG + theme aware. Range primitive now unblocks #4. Kept for reference. |
| ~~3~~ | ~~`horizontal-bar-interactions.md`~~ | **SHIPPED v1.8.0** | M-L | pan/zoom/value-grid on horizontal bars; VALUE axis only, band pinned. brush + log-value still fail-closed (deferred). Kept for reference. |
| ~~4~~ | ~~`time-series-variants.md`~~ | **SHIPPED v1.10.0** (weekend shading) | M | `createTimeLineChart` + weekend shading, riding the v1.7.0 annotation range primitive. Market-hours deferred to v1.10.x. Kept for reference. |
| 6 | `lite-charts-gl-companion.md` | design, SEPARATE PACKAGE | XL | Own package; re-verify lite-gl 1.4.0 `PointHiSink` before planning. |
| ~~new~~ | ~~horizontal-brush~~ | **SHIPPED v1.9.0** | S-M | Brush on a horizontal bar: value-range + band-set payload `{valueMin,valueMax,bandMin,bandMax,bands,ids}`, distinct from the vertical `{xMin,xMax,yMin,yMax,ids}`. Kept for reference. |
| ~~7~~ | ~~`market-hours.md`~~ | **SHIPPED v1.11.0** | S-M | Caller-supplied session calendar, complement-of-open-union band generation over the v1.10.0 shading machinery (`_weekendBands` byte-identical). Overnight sessions still OUT (throw; v1.11.x candidate). Kept for reference. |
| ~~5~~ | ~~`legend-virtualization.md`~~ | **SHIPPED v1.12.0** | S | Caller-supplied `virtualize` fn per the `spatialIndex` precedent (NO lite-virtual import), vertical-only, ONE shared visibility effect + ONE delegated click listener (the planner overturned the brief's bounded-pool-effects option -- a rebind inside a scroll callback cannot re-run an effect). Horizontal virtualization still throws (candidate). Kept for reference. |
| ~~8~~ | ~~`demo-refresh.md`~~ | **DONE 2026-09-02** (demo-only, no release) | M | Demo v1.6.0 -> v1.12.0: annotations, time-series weekend+sessions shading, hbar pan/zoom/brush wired live, 200-series virtualized legend against REAL lite-virtual via a scope-bridge adapter. Found + fixed a README doc bug: the shipped adapter snippet called `mountList(host, opts)` but lite-virtual 1.1.0's real signature is `(host, scope, opts)` with viewport/render keys -- README now ships the working ~25-line bridge (rides the next release). Kept for reference. |

PLANNED ORDER (2026-09-02, user-confirmed): ~~#7 market-hours -> v1.11.0~~
SHIPPED; ~~#5 legend-virtualization -> v1.12.0~~ SHIPPED. Both feed the
upcoming back-office build (time-series KPI panel + many-series dashboards).
Remaining: item 8 (demo refresh, demo-only session), item 6 (lite-charts-gl,
a different package entirely) and the v1.12.x candidates in ../ROADMAP.md.
Also queued outside this repo: lite-delaunay 1.1.0+ (findNearest/dispose so
it can satisfy the charts SpatialIndex contract -- 1.0.0 is triangulate-only;
full roadmap now lives in ../../LiteDelaunay/ROADMAP.md).

## Ground rules every brief inherits

- Pipeline: planner -> coder -> reviewer -> qa. Reviewer REJECTED goes back to
  coder, not forward.
- Gate before "done": `npm test` + `node --expose-gc test/torture.mjs` -> `ok`.
  No gate output is a FAIL.
- Zero-alloc draw path, ASCII-only source, single-file, fail-closed on
  unverified state, esbuild tree-shake isolation for any kernel/feature split.

## Also in this repo (older scratch, superseded)

- `../PLAN_v1.6.0_xlog.md` -- the x-log plan that became v1.6.0. Done; kept for
  reference.
- `../ROADMAP_REVISED.md` -- the v1.4.x audit that produced the LC-01..LC-06
  findings (log x pan/zoom bugs) and the lite-gl-1.4.0 correction reused in
  brief #6. Historical.
