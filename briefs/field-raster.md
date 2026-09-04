# Brief -- field-raster layer: injected scattered-field interpolation (v1.16.0)

Status: EXECUTED 2026-09-05 (release-pending as v1.16.0). Two as-executed
notes: (1) the brief's "+y-up bridge flips rows" was WRONG for a pixel-space
consumer -- by0 = plotTop is the smaller pixel y, so the contract's "row 0 =
by0" already lands row 0 on the TOP row; NO flip (planner correction, proven
by the FR2 orientation fixture and its reversion). (2) The reviewer REJECTED
the first coder pass on coverage grounds only (zero code defects found); qa
supplied the FR1-FR9 suite + torture A22 + five reversion proofs, discharging
the rejection. Historical text below is the as-written brief. This is THE CONSUMER
BRIEF the delaunay dormancy protocol anticipated: it targets the LOCKED AND
SHIPPED lite-delaunay 1.3.0 `createFieldIndex` surface (published + verified
2026-09-03; contract recorded verbatim in `briefs/README.md`). Their side is
dormant; nothing is needed from them -- consume the published package.

## Goal

`field: { index, ... }` on `createScatterChart`: rasterize the primary
series' per-point scalar values into a smooth interpolated background layer
(a continuous "heatmap under the dots"), drawn UNDER cells/markers inside
the plot clip, at 0 B/frame. The injection ladder's third rung:
`spatialIndex` (hit-test) -> `cells: { index }` (Voronoi) -> `field: { index }`
(barycentric interpolation). Charts.js imports NO implementation -- the
factory arrives via config, `@zakkster/lite-delaunay` stays an optional peer
(bump the range to `^1.3.0`; devDep to 1.3.0 so tests/torture run against
the real package, exactly like `createCellIndex` in v1.14.0).

## The locked producer surface (shipped, do not re-negotiate)

`createFieldIndex(maxPoints)` -> factory `(pxs, pys, n)` -> handle:
`locate(qx,qy) -> t|-1`; `barycentric(t,qx,qy,outW3) -> bool`;
`triangleVertices(t,outI3)` (3 ORIGINAL site indices); `triangleCount()`;
`interpolate(zs,qx,qy) -> number`;
`sampleField(zs, gridW, gridH, bx0, by0, bx1, by1, outGrid) -> finite count`;
`dispose()`. Pooling/facade/SoA-NaN identical to the other two factories.
Grid contract: outGrid Float32Array|Float64Array, len >= gridW*gridH,
row-major `row*gridW + col`, col 0 = bx0 = xMin, **row 0 = by0 = yMin
(+y-UP, mathematical)** -- the charts bridge flips rows; CELL-CENTER
sampling; NaN = outside-hull/degenerate/non-finite, never 0. zs are
per-call, ORIGINAL-indexed, Float32Array|Float64Array|number[], len >= n
or throw.

## Measured perf grounding (their bench, shipped 1.3.0 -- see briefs/README)

sampleField 64x64 ~0.55 ms/grid at 100k pts (sub-ms everywhere smaller);
warm REBUILD 33.3 ms at 100k / 2.6 ms at 10k / 0.19 ms at 1k; random-access
interpolate collapses to 0.11 Mq/s at 100k (O(sqrt T) walk). Consequences,
non-negotiable: (1) the layer NEVER calls `interpolate` point-by-point on
any hot path -- `sampleField`'s serpentine batch is the only sampler;
(2) index build + sampleField are COLD (data/scale change only), riding the
same postProject lifecycle the cells layer proved in v1.14.0; (3) the
per-frame draw walks a prebuilt image/rect representation at 0 B.

## Design decisions the planner OWNS (candidates, falsify freely)

- D1 Build space: the factory build signature is `(pxs, pys, n)` -- build
  over PROJECTED PIXELS (same postProject seam as cells; anisotropy-correct
  by construction), sample bbox = the plot rect in pixels, so grid cells map
  1:1 to pixel rects with only the +y-up row flip. Alternative (data-space
  build) must justify itself against pan/zoom staleness.
- D2 Value source: `field.value` (key/accessor, buildAccessor semantics) over
  the primary series rows -> one packed zs Float32Array refreshed at extract
  (AoS) / zero-copy or packed (SoA row). NaN z = missing point (their SoA-NaN
  semantics propagate it into NaN cells).
- D3 Raster representation + paint: candidate A -- per-cell fillRect walk of
  a prebuilt color string array (grid-kernel precedent, zero new deps);
  candidate B -- putImageData/ImageData (one alloc per rebuild, cold; faster
  paint but exportSVG parity is harder). Planner decides; exportSVG must emit
  SOMETHING honest (per-cell rects, or a documented omission is REJECTED --
  the annotation/cells precedent says parity).
- D4 Color mapping: reuse the heatmap ramp vocabulary -- `colors: [low, high]`
  linear interp + optional `colorFn(v, vMin, vMax)`; vMin/vMax from the
  FINITE cells of the sampled grid (not the raw zs -- panned-out points must
  not pin the ramp). NaN cells paint NOTHING (transparent), never a color.
- D5 Grid sizing: `gridW/gridH` config with sane defaults (e.g. 64x48 or
  plot-proportional), hard caps (their bench says 64x64 is ~0.55 ms at
  100k pts -- a 512x512 grid is 64x that; cap and document). Scratch outGrid
  pooled at first build, grow-only, disposed on cleanup.
- D6 Scope fences: primary series only (cells precedent D6); scatter only;
  bubble OUT; log axes -- planner decides fail-closed behavior (log-space
  pixels are still pixels; if it just works, prove it, else throw).

## Fail-closed doors (construction, before any owned signal -- v1.14/15 precedent)

Bad `field` spec (non-object, missing/non-function `index`, missing `value`,
bad gridW/gridH: `== null` gated, non-integer, out of caps), unknown keys
policy per house style. Runtime: factory/build faults ride the EXACT cells
fault protocol -- first-build fault surfaces at mount via the unwind door;
later faults skip the field layer for that pass (markers still draw), never
mid-paint, `ctx.fieldError` recorded. `sampleField` return (finite count) is
not trusted blindly -- 0 finite cells = draw nothing.

## Gate (all mandatory)

- Boundary suite vs the REAL published 1.3.0 (import createFieldIndex in
  tests + torture): an independent test-side oracle (direct barycentric
  evaluation on a known triangulation -- e.g. a planar field z = ax+by+c must
  reproduce EXACTLY inside the hull, the same exactness their 5000/5000 gate
  proves) + NaN-outside-hull confinement + the +y-up row flip proven by an
  asymmetric fixture (a field hotter at top must paint hotter at top).
- Zero-node construction throws; retention (50x mount/destroy,
  builds === disposes); source-scan confinement (0 delaunay imports).
- Torture A22: data+view storm -> exactly one build+sample per scale/data
  change (never per frame); redraw within budget of a no-field control;
  0 new graph nodes. Reversion proofs for every load-bearing mechanism.
- Docs: CHANGELOG/llms.txt/README/ROADMAP/Charts.d.ts; peer bump ^1.3.0
  noted under Changed. ASCII only.

## Out of scope

Contours/isolines (future brief; the locked surface already composes via
triangleCount/triangleVertices/barycentric); natural-neighbor (their fence);
heatmap-kernel integration (categorical axes -- wrong home, recorded 2026-09-03);
any delaunay-side change (1.4.0 has NO trigger; do not create one casually).
