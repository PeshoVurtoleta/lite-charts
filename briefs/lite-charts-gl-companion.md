# Brief -- @zakkster/lite-charts-gl companion package

Status: DESIGN BRIEF. Local scratch, not shipped. This is a SEPARATE package,
not a change to lite-charts. lite-charts proper stays canvas-only and
node-testable end-to-end.

## Goal

GPU sibling for the point-count-bottlenecked chart types. Target: 1M scatter
points at 60fps with pan/zoom driving re-projection.

## Correction vs the old ROADMAP (important -- verify before planning)

`ROADMAP_REVISED.md` flags that the GL track was planned against a lite-gl
that no longer exists:
- Old plan: v0.1 on the screen-space instanced-quad path -- lite-gl's own docs
  measure that at **~5 ms and 31 MB/frame at 1M points on a pan**. Aspirational,
  not achievable, for a 60fps pan.
- Reality: **lite-gl is at 1.4.0** and shipped **`PointHiSink`** -- world
  coordinates uploaded ONCE, camera on the GPU; a pan is `setCamera()` with
  ZERO per-frame upload. This makes the 1M@60fps headline actually reachable.

**Action:** re-verify lite-gl's current version + `PointHiSink` surface from
its published README before designing; do not plan against the pre-1.4 path.
The chart's `view` signal shape was chosen to map onto lite-gl's camera --
confirm that mapping is still 1:1 against 1.4.0.

## Initial scope

- **`createScatterChartGL`** -- biggest win. Scatter is point-limited in
  Canvas2D (one `beginPath+arc+fill` per point); lite-gl's POINT pipeline maps
  1:1. Hit-test STAYS on CPU (the spatial-index foundation from lite-charts
  v1.2.0-alpha.0) -- `gl.readPixels` is a frame killer.
- **`createBubbleChartGL`** -- same pipeline; per-point radius is a free
  attribute in the POINT layout.
- **`createDensityChart`** -- a new type for the 100k-1M range where scatter
  loses to overdraw. Aggregates into hex-bin / grid-cell counts, renders cells
  via lite-gl (still alloc-free; cell count bounded).

## Reused from lite-charts (do not fork)

Axis tick builder (canvas overlay -- GL is overkill for tick text), the scale
builders (`makeLinearScale`, `makeBandScale`, `makeLogScale`), the config
shape, and the lifecycle API (mount/unmount/destroy/exportSVG). Import or
factor these into a shared low-level module; don't copy-paste.

## Why a separate package, not a `renderer:` switch

lite-gl is browser-only (WebGL2). A switch inside lite-charts would double the
test surface for every chart (mock WebGL2 contexts, browser-only paths) and
break the "node-testable end-to-end" property. Split at the package boundary:
lite-charts-gl owns the WebGL2 testing pattern (mock-context unit tests + real
GPU in Playwright) that lite-gl already established.

## Open questions

- How much of lite-charts' kernel is extractable into a shared core without a
  circular dep? Scales + config + lifecycle are the candidates.
- exportSVG on a GL chart: render a canvas snapshot, or re-run the scale math
  through the SVG shim on the CPU? (The latter keeps vector output.)
- Bench harness: port the 100k line bench; add a 1M scatter pan bench that
  proves `setCamera()` zero-upload path.

## Gate (for the new package)

Its own suite: node:test mock-WebGL2 unit tests + Playwright real-GPU; the
1M@60fps pan bench as the headline integration test. lite-* laws still apply
(zero runtime deps, ASCII source, single-file per entry, fail-closed).
```
