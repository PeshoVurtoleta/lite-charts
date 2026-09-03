# lite-charts -- next-session briefs

Local working scratch. **Not shipped** -- `briefs/` is absent from
package.json `files[]`, so nothing here reaches npm. Each brief is a
self-contained plan for one future `cd LiteCharts && claude` session.

Current shipped state: **v1.14.0** (fat hover + injected Voronoi cell layer
on scatter, vs published lite-delaunay 1.2.0; postProject renderer seam;
construction throws before any signal alloc). Prior: v1.13.0 (overnight
sessions via midnight-split
normalization + holiday calendar via UTC-day-skip, riding the v1.11.0
session machinery; legend virtualization via caller-injected
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
| 6 | `lite-charts-gl-companion.md` | design, SEPARATE PACKAGE -- superseded in sequencing by #11 | XL | Own package. The 2026-07 alpha was built WITHOUT lite-gl (hand-rolled GLSL), contra this brief; #11 gates + publishes that alpha as 0.1.0 first, and THIS brief's on-lite-gl architecture (lite-gl is now 2.0.0 with the needed sinks) becomes the 1.0.0 decision gate recorded in the GL repo's ROADMAP. |
| ~~new~~ | ~~horizontal-brush~~ | **SHIPPED v1.9.0** | S-M | Brush on a horizontal bar: value-range + band-set payload `{valueMin,valueMax,bandMin,bandMax,bands,ids}`, distinct from the vertical `{xMin,xMax,yMin,yMax,ids}`. Kept for reference. |
| ~~7~~ | ~~`market-hours.md`~~ | **SHIPPED v1.11.0** | S-M | Caller-supplied session calendar, complement-of-open-union band generation over the v1.10.0 shading machinery (`_weekendBands` byte-identical). Overnight sessions still OUT (throw; v1.11.x candidate). Kept for reference. |
| ~~5~~ | ~~`legend-virtualization.md`~~ | **SHIPPED v1.12.0** | S | Caller-supplied `virtualize` fn per the `spatialIndex` precedent (NO lite-virtual import), vertical-only, ONE shared visibility effect + ONE delegated click listener (the planner overturned the brief's bounded-pool-effects option -- a rebind inside a scroll callback cannot re-run an effect). Horizontal virtualization still throws (candidate). Kept for reference. |
| 11 | `charts-gl-rescue.md` | rescue, lite-charts-gl 0.1.0 -- EXECUTES IN LiteChartsGl | S-M | Gate the July orphan and publish: git init, reprove the 117 mock-GL tests, build the missing torture tiers (T0/T6/T7/T9 -- the one real engineering task; zero-GC claim currently UNPROVEN), fix the version lies (llms.txt "v1.0.0", stale sibling note, no VERSION const), blueprint README + missing ROADMAP.md + ASCII scrub. No feature work; the lite-gl-migration question is explicitly deferred to 1.0.0. Written 2026-09-03. |
| 10 | `voronoi-cells.md` | feature, v1.14.0 -- EXECUTED 2026-09-03 (release-pending) | M | Fat hover (`hitTolerance: 'nearest'` -- charts-side ONLY, rides the existing findNearest k=1) + injected Voronoi cell tessellation layer on scatter (`cells: { index }` per the spatialIndex precedent). Carried THE CONSUMER CONTRACT for delaunay's `createCellIndex`; delaunay 1.2.0 published 2026-09-03, charts built + gated against it (463/463, A20, 5 reversion proofs). One as-executed deviation recorded in the brief: postProject seam, not extract-time. |
| ~~9~~ | ~~`overnight-holidays.md`~~ | **SHIPPED v1.13.0** | S-M | Overnight sessions (midnight-split normalization -- the sweep survived byte-structurally unchanged, planner falsified the brief's synth site into _normalizeSessionSpec) + holiday calendar (UTC-day-skip, gap fusion). qa added the Saturday-wrap rotate fixture the planner fixtures missed; four reversions proven. 453 tests + A19. Kept for reference. |
| ~~8~~ | ~~`demo-refresh.md`~~ | **DONE 2026-09-02** (demo-only, no release) | M | Demo v1.6.0 -> v1.12.0: annotations, time-series weekend+sessions shading, hbar pan/zoom/brush wired live, 200-series virtualized legend against REAL lite-virtual via a scope-bridge adapter. Found + fixed a README doc bug: the shipped adapter snippet called `mountList(host, opts)` but lite-virtual 1.1.0's real signature is `(host, scope, opts)` with viewport/render keys -- README now ships the working ~25-line bridge (rides the next release). Kept for reference. |

PLANNED ORDER (2026-09-02, user-confirmed): ~~#7 market-hours -> v1.11.0~~
SHIPPED; ~~#5 legend-virtualization -> v1.12.0~~ SHIPPED. Both feed the
upcoming back-office build (time-series KPI panel + many-series dashboards).
Remaining: item 6 (lite-charts-gl, a different package entirely) and the
v1.13.x candidates in ../ROADMAP.md (horizontal legend virt -- charts-side
only, lite-virtual already does horizontal:true; early-close calendar
entries).
The lite-delaunay dormancy contract CLOSED THE LOOP 2026-09-03: brief #10
carried the consumer contract, delaunay v1.2.0 shipped `createCellIndex`
against it (published, verified), and charts consumed the real package
end-to-end (tests + torture import it) in v1.14.0. Dormancy RE-ARMED for
delaunay 1.3.0 (notice sent to their session 2026-09-03): no trigger exists;
candidate future triggers, none committed -- TIN/contour rendering (their
half-edge mesh), natural-neighbor heatmap interpolation, a mesh-edges layer,
or a charts-gl mesh/Voronoi layer (1.0-lane there, after brief #11). A new
consumer-contract brief here triggers 1.3.0, exactly as #10 did for 1.2.0.
lite-delaunay 1.1.0 SHIPPED 2026-09-02 (user session; createSpatialIndex,
uniform-grid impl) and conformance-verified against the charts contract
(true-kNN exact; indexed hit-test identical to linear scan at realistic
density). Demo + README now wire the REAL `spatialIndex:
createSpatialIndex(2000)` (the inline linear-scan reference impl is retired;
one pooled factory serves dense-bubble AND scatter, lifecycle proven live:
lazy build -> cached queries -> dispose+rebuild on data change -> dispose on
unmount). Riding the NEXT lite-charts release: the new README
"Spatial-index hit-testing" section, the fixed lite-virtual adapter snippet,
and (candidate) tightening the optional lite-delaunay peer to ^1.1.0.

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
