# lite-charts -- next-session briefs

Local working scratch. **Not shipped** -- `briefs/` is absent from
package.json `files[]`, so nothing here reaches npm. Each brief is a
self-contained plan for one future `cd LiteCharts && claude` session.

Current shipped state: **v1.10.0** (`createTimeLineChart` + weekend shading, on
the annotation layer from v1.7.0; horizontal-bar pan/zoom/grid v1.8.0 + brush
v1.9.0; x-axis log scale + mixed-sign log floor from v1.6.x).
The forward plan in `../ROADMAP.md` points here.

## The set, in recommended order

| # | Brief | Kind | Size | Why this order |
| --- | --- | --- | --- | --- |
| ~~1~~ | ~~`v1.6.1-mixedsign-log-floor.md`~~ | **SHIPPED v1.6.1** | XS | Closed the one known gap in v1.6.0. Kept for reference. |
| ~~2~~ | ~~`annotation-layer.md`~~ | **SHIPPED v1.7.0** | M | Data-pinned line/range/point/text marks; zero per-frame alloc, fail-closed, exportSVG + theme aware. Range primitive now unblocks #4. Kept for reference. |
| ~~3~~ | ~~`horizontal-bar-interactions.md`~~ | **SHIPPED v1.8.0** | M-L | pan/zoom/value-grid on horizontal bars; VALUE axis only, band pinned. brush + log-value still fail-closed (deferred). Kept for reference. |
| ~~4~~ | ~~`time-series-variants.md`~~ | **SHIPPED v1.10.0** (weekend shading) | M | `createTimeLineChart` + weekend shading, riding the v1.7.0 annotation range primitive. Market-hours deferred to v1.10.x. Kept for reference. |
| 5 | `legend-virtualization.md` | design | S | Narrow reach (100+ series dashboards); optional lite-virtual peer. |
| 6 | `lite-charts-gl-companion.md` | design, SEPARATE PACKAGE | XL | Own package; re-verify lite-gl 1.4.0 `PointHiSink` before planning. |
| ~~new~~ | ~~horizontal-brush~~ | **SHIPPED v1.9.0** | S-M | Brush on a horizontal bar: value-range + band-set payload `{valueMin,valueMax,bandMin,bandMax,bands,ids}`, distinct from the vertical `{xMin,xMax,yMin,yMax,ids}`. Kept for reference. |
| new | time-series market-hours | carved from #4 | S-M | The slice deferred from v1.10.0: a data-driven session calendar (shade/skip non-trading hours), riding the same annotation `range` primitive as the weekend bands. Target v1.10.x. |

Recommended next: **#5 legend-virtualization** (narrow reach, optional lite-virtual
peer) or **time-series market-hours** (v1.10.x, finishes the finance story from
v1.10.0) -- pick by appetite. Item 6 is a different package entirely.

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
