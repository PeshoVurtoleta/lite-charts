# lite-charts -- next-session briefs

Local working scratch. **Not shipped** -- `briefs/` is absent from
package.json `files[]`, so nothing here reaches npm. Each brief is a
self-contained plan for one future `cd LiteCharts && claude` session.

Current shipped state: **v1.17.0** (contour/isoline layer on the scatter
field raster -- `field.contours: { levels, color?, width?, dash? }`, exact
TIN sweep via triangleCount/triangleVertices + edge lerp, locate/barycentric
unconsumed, third independent fault domain with field-domain skip gate;
brief #13, published + npm-view-verified 2026-09-05; demo "weather map"
field+contour panel added same day, demo-only). Prior: v1.16.0 (injected
field-raster layer on scatter --
`field: { index, value, ... }` consuming published lite-delaunay 1.3.0
`createFieldIndex`; ONE sampleField per cold postProject refresh, NO row flip,
independent cells/field fault domains; brief #12, published + verified
2026-09-05); v1.15.0 (horizontal legend virtualization --
top/bottom + virtualize with orientation-exclusive width/itemWidth keys;
early-close holiday entries { ts, closeMinutes } clamping the session sweep;
no brief -- executed straight from the ROADMAP candidates queue);
v1.14.0 (fat hover + injected Voronoi cell layer
on scatter, vs published lite-delaunay 1.2.0; postProject renderer seam;
construction throws before any signal alloc); v1.13.0 (overnight
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
| 6 | `lite-charts-gl-companion.md` | design, SEPARATE PACKAGE -- superseded in sequencing by #11 | XL | Own package. The 2026-07 alpha was built WITHOUT lite-gl (hand-rolled GLSL), contra this brief; #11 gates + publishes that alpha as 0.1.0 first, and THIS brief's on-lite-gl architecture (lite-gl is now 2.0.0 with the needed sinks) becomes the 1.0.0 decision gate recorded in the GL repo's ROADMAP. Decision brief #15 (`charts-gl-1.0.0-core.md`, 2026-09-05) now carries that gate; this brief's fate (execute-via-#15 or formal retirement) is decided there. |
| ~~new~~ | ~~horizontal-brush~~ | **SHIPPED v1.9.0** | S-M | Brush on a horizontal bar: value-range + band-set payload `{valueMin,valueMax,bandMin,bandMax,bands,ids}`, distinct from the vertical `{xMin,xMax,yMin,yMax,ids}`. Kept for reference. |
| ~~7~~ | ~~`market-hours.md`~~ | **SHIPPED v1.11.0** | S-M | Caller-supplied session calendar, complement-of-open-union band generation over the v1.10.0 shading machinery (`_weekendBands` byte-identical). Overnight sessions still OUT (throw; v1.11.x candidate). Kept for reference. |
| ~~5~~ | ~~`legend-virtualization.md`~~ | **SHIPPED v1.12.0** | S | Caller-supplied `virtualize` fn per the `spatialIndex` precedent (NO lite-virtual import), vertical-only, ONE shared visibility effect + ONE delegated click listener (the planner overturned the brief's bounded-pool-effects option -- a rebind inside a scroll callback cannot re-run an effect). Horizontal virtualization still throws (candidate). Kept for reference. |
| ~~11~~ | ~~`charts-gl-rescue.md`~~ | **EXECUTED -- 0.1.0 SHIPPED 2026-09-05** (published + npm-view-verified, card synced) | S-M | Gate the July orphan and publish: git init, reprove the 117 mock-GL tests, build the missing torture tiers (T0/T6/T7/T9 -- the one real engineering task; zero-GC claim currently UNPROVEN), fix the version lies (llms.txt "v1.0.0", stale sibling note, no VERSION const), blueprint README + missing ROADMAP.md + ASCII scrub. No feature work; the lite-gl-migration question is explicitly deferred to 1.0.0. Written 2026-09-03; amended 2026-09-05 with the user's demo verdict ("bad and outdated") -- demo refresh now IN scope as T7 (pinned importmap, real version tag, a 100k+ stress scene w/ measured fps; grounding in the brief). Confirmed as the NEXT session. AS-EXECUTED: 118 tests, tiers T0/T6/T7/T9 + BREAK control, ONE real leak found + fixed (unmount never disposed the 4 handle signals -- lite-signal reclaims only on explicit dispose), truth pass incl. dangling `types` refs removed, demo scene 05 measured the instanced-quad fill wall (1M @ 2px sub-50fps at dpr 2) -- the grounding that feeds #15. |
| 15 | `charts-gl-1.0.0-core.md` | decision, lite-charts-gl 1.0.0 -- EXECUTES IN LiteChartsGl AFTER the user records its DECISION block | M-L | The D5 gate #11 deferred, now decidable: lite-gl 2.0.0's real surface read side by side with the 0.1.0 internals (2026-09-05). Grounded on three defects 0.1.0 measured or carries latently -- the 1M fill wall (observed), float32 epoch-ms collapse (ULP 131,072 ms; latent, demos use synthetic ranges), zero context-loss handling -- ALL pre-solved + torture-gated in lite-gl (POINT_HI camera, sink-owned restore, zero-alloc pick). Mapping: scatter -> createPointHiSink, heatmap -> createQuadSink (live setValues lands), line STAYS hairline (no LINE_HI exists). Costs disclosed: x5 scatter memory, lite-raf peer baggage, pointShape parity. Recommendation option 1 at sinks-only depth, falsifiable by a T1 spike A/B with a written 2b bail-out; both lanes carry full tasks + gates. |
| 12 | `field-raster.md` | feature, v1.16.0 -- **SHIPPED 2026-09-05, live on npm (verified)** | M | THE field consumer brief the dormancy protocol anticipated: `field: { index }` on scatter, third rung of the injection ladder, consuming the published lite-delaunay 1.3.0 `createFieldIndex` (locked contract + perf grounding recorded above). sampleField-only batching (never hot interpolate), postProject cold lifecycle per the cells precedent; as-executed: NO row flip (by0 = plotTop already lands row 0 on top -- orientation proven by fixture + reversion), independent cells/field fault domains, reviewer's coverage-only REJECTED discharged by qa (FR1-9 + A22 + 5 reversions). Peer bump ^1.3.0. |
| 14 | `cluster-outlines.md` | feature, v1.18.0 -- CONTRACT DRAFT 2026-09-05, BLOCKED on lite-delaunay 1.4.0 shipping | M | Fourth injection rung: per-group convex-hull / alpha-shape outlines on scatter (`outlines: { index, groupKey, alpha? }`). THIS brief carries the consumer contract 1.4.0 is built against (the 1.2.0/1.3.0 protocol): `convexHull(outIndices)->count` + `alphaShape(alpha, outIndices, outLoopEnds)->loopCount`, ORIGINAL indices, CCW, multi-loop via exclusive end-offsets, zero-alloc, documented sizing bound, alpha finite >0 in pixel units. alphaShape is the wake trigger -- convexHull alone is caller-computable. Relay the contract section to the lite-delaunay session; execute charts-side only against the PUBLISHED 1.4.0. |
| 13 | `contour-isolines.md` | feature, v1.17.0 -- SHIPPED 2026-09-05 (npm-view-verified) | M | The v1.16.0 out-of-scope follow-on: iso-value lines over the field raster, computed cold on the same postProject refresh. KEY grounding: exact TIN isolines need ONLY triangleCount+triangleVertices (+ caller edge-lerp over pxs/pys/zs) -- locate/barycentric stay unconsumed; NO delaunay change, does NOT trigger their 1.4.0. Planner owns: TIN sweep vs marching-squares-over-fieldGrid; nested field.contours config; fault-domain placement (C4). Oracle: planar field -> segments exactly on the mapped line. |
| 10 | `voronoi-cells.md` | feature, v1.14.0 -- EXECUTED 2026-09-03 (SHIPPED, live on npm) | M | Fat hover (`hitTolerance: 'nearest'` -- charts-side ONLY, rides the existing findNearest k=1) + injected Voronoi cell tessellation layer on scatter (`cells: { index }` per the spatialIndex precedent). Carried THE CONSUMER CONTRACT for delaunay's `createCellIndex`; delaunay 1.2.0 published 2026-09-03, charts built + gated against it (463/463, A20, 5 reversion proofs). One as-executed deviation recorded in the brief: postProject seam, not extract-time. |
| ~~9~~ | ~~`overnight-holidays.md`~~ | **SHIPPED v1.13.0** | S-M | Overnight sessions (midnight-split normalization -- the sweep survived byte-structurally unchanged, planner falsified the brief's synth site into _normalizeSessionSpec) + holiday calendar (UTC-day-skip, gap fusion). qa added the Saturday-wrap rotate fixture the planner fixtures missed; four reversions proven. 453 tests + A19. Kept for reference. |
| ~~8~~ | ~~`demo-refresh.md`~~ | **DONE 2026-09-02** (demo-only, no release) | M | Demo v1.6.0 -> v1.12.0: annotations, time-series weekend+sessions shading, hbar pan/zoom/brush wired live, 200-series virtualized legend against REAL lite-virtual via a scope-bridge adapter. Found + fixed a README doc bug: the shipped adapter snippet called `mountList(host, opts)` but lite-virtual 1.1.0's real signature is `(host, scope, opts)` with viewport/render keys -- README now ships the working ~25-line bridge (rides the next release). Kept for reference. |

PLANNED ORDER (2026-09-02, user-confirmed): ~~#7 market-hours -> v1.11.0~~
SHIPPED; ~~#5 legend-virtualization -> v1.12.0~~ SHIPPED. Both feed the
upcoming back-office build (time-series KPI panel + many-series dashboards).
Remaining: #15 (the charts-gl 1.0.0 render-core decision -- awaiting the
user's DECISION record; item 6's fate is decided there), #14 (blocked on
delaunay 1.4.0), and the
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
UPDATE 2026-09-03 (later same day): the user greenlit delaunay 1.3.0
DIRECTLY in the delaunay session (their ROADMAP mesh-interpolation lane:
locate + barycentric weights + sampleField rasterizing scattered fields),
bypassing the brief trigger. Charts supplied grounding input read-only:
corrected their premise (createHeatmap consumes long-form AoS rows with
string categories, NOT a grid array -- no verbatim outGrid feed exists),
recommended outGrid = caller-allocated Float32Array, row-major, +y-up,
cell-center sampling, NaN = missing (flows through our NaN->missing
extract), reserved config key `field` (next rung after spatialIndex /
cells), and asked locate to expose the three site indices zero-alloc for
a future contour/TIN walker. Charts-side consumption still arrives via a
future consumer-contract brief here (candidate: field-raster layer over
the grid kernel, or a new field chart).
CONTRACT LOCKED same day (their planner, incorporating all charts input):
`createFieldIndex(maxPoints) -> (pxs, pys, n) -> { locate(qx,qy) -> t|-1;
barycentric(t, qx, qy, outW3) -> bool; triangleVertices(t, outI3)` (writes
the 3 ORIGINAL site indices)`; triangleCount(); interpolate(zs, qx, qy) ->
number; sampleField(zs, gridW, gridH, bx0, by0, bx1, by1, outGrid) ->
finite-cell count; dispose() }` -- pooling/facade/SoA-NaN identical to
createSpatialIndex/createCellIndex. Grid contract: outGrid Float32Array or
Float64Array, length >= gridW*gridH, row-major row*gridW+col, col 0 = bx0
= xMin, row 0 = by0 = yMin (+y-up mathematical; the charts bridge flips
rows and derives presentMask in one cold pass), cell-center sampling, NaN
for outside-hull/degenerate/non-finite (never 0). zs per-call,
ORIGINAL-indexed, Float32Array | Float64Array | number[], length >= n or
throw. Contour/TIN walkers compose zero-alloc via triangleCount +
triangleVertices + barycentric (no 1.4.0 surface change needed).
BUILT + GATED same day, exactly to the locked contract (their report:
127/0 tests incl. 30 FieldIndex cases -- planar exactness 5000/5000,
locate-vs-brute 15000/0, grid-orientation proof row 0 = yMin, NaN-z
confinement, outGrid-aliases-zs adversarial case; torture 200k walks +
256 rasterizations major=0). Their docs label `field: { index }` as
reserved-not-consumed. PUBLISHED + VERIFIED live 2026-09-03 (npm view:
1.3.0 = latest). Dormancy RE-ARMED for delaunay 1.4.0 (notice sent same
day): no charts trigger exists; candidates, none committed -- needs
surfaced while executing the future field-raster consumer brief here
(likely none), a charts-gl mesh/field layer (1.0-lane, post brief #11),
or their own ROADMAP lanes with charts grounding input. Also same day:
lite-charts v1.15.0 released (horizontal legend virt + early-close
calendar; 473/473 + A21; no delaunay surface involved).
CONSUMPTION NOTICE -- DELIVERED 2026-09-05 via user relay to the live
lite-delaunay thread (block kept for the record, updated to as-shipped):
charts v1.16.0 consumed createFieldIndex end-to-end (field: { index } on
scatter; sampleField-only, never interpolate; NaN honored). charts v1.17.0
(SHIPPED, npm-verified 2026-09-05) added contours consuming
triangleCount() + triangleVertices(t, outI3) (ORIGINAL site indices
honored, exactly as their live probe promised) + caller-side edge lerp;
locate/barycentric remain UNCONSUMED -- exact TIN isolines never needed
point location, only the triangle sweep. Zero contract deviations in
either release. ONE doc note for them: the "+y-up bridge flips rows"
clause from contract time is unnecessary -- "row 0 = by0" is
orientation-agnostic and the pixel-space consumer passes by0 = plotTop,
no flip; if their docs cite a charts-side row flip, drop the clause.
1.4.0 dormancy: the contour brief consumed the shipped 1.3.0 surface
AS-IS and triggered nothing, as predicted. The live 1.4.0 question
(convexHull/alphaShape for a charts cluster-overlay brief) is answered
in the session log of 2026-09-05: alphaShape is the real trigger,
convexHull alone is not; charts would write brief #14 carrying the
consumer contract per the 1.2.0/1.3.0 protocol.
PERF GROUNDING for the future field-raster/contour brief (their
bench/bench.js on shipped 1.3.0, Node 22, Apple-Silicon-class, 1000x1000
domain; medians, steady-state, heap deltas ~0): sampleField 64x64 ~0.55
ms/grid at 100k pts (7.5 Mcells/s; 29.4 at 10k, 67.2 at 1k, serpentine
coherence holds); interpolate coherent-drift 10.8 Mq/s at 100k (23.2 at
10k, 32.7 at 1k); interpolate RANDOM jumps 0.11 Mq/s at 100k -- the
O(sqrt T) walk cost, so the brief MUST batch queries coherently; warm
field rebuild 33.3 ms at 100k / 2.6 ms at 10k / 0.19 ms at 1k (first
build pays the arena, per the pool contract). Implication: a per-frame
64x64 raster refresh is affordable at <=10k points; at 100k the rebuild
(33 ms) dictates a cold data-change-only refresh, sampleField itself
stays sub-ms. Cell sanity: avg 6.0 verts/cell on random clouds, matching
Voronoi theory. Their side dormant; ledgers agreed on all four points
(1.3.0 shipped end-to-end + carded, field brief-driven, 1.4.0 no
trigger, NN behind their fence).
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
