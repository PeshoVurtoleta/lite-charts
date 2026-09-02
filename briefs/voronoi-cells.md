# Brief -- Voronoi cell layer: fat hover + tessellation (v1.14.0)

Status: GROUNDED against v1.13.0 source (2026-09-02). THIS IS THE TRIGGER
BRIEF for lite-delaunay v1.2.0 (the dormancy contract in briefs/README.md):
section "The consumer contract" below is what the delaunay session builds
against. Sequencing: delaunay v1.2.0 ships FIRST, then the charts session
runs this brief against the published package.

## Goal

Two features, one arc:

1. **Fat hover** -- on a sparse scatter, hovering anywhere snaps to the
   nearest point instead of requiring pixel-perfect aim inside the
   `hitTolerance` disc. HONEST GROUNDING: this needs NOTHING from delaunay
   v1.2.0 -- the Voronoi cell is the *conceptual* hit region, but the query
   "which cell contains the cursor" IS nearest-neighbor, and
   `_scatterHitTest` already runs `findNearest(k = 1)` on the injected index
   (Charts.js:4450-4452). Fat hover is a charts-side tolerance-policy change.
2. **Cell tessellation** -- the classic station-map/coverage view: every
   scatter point owns a colored polygon (its Voronoi cell), plus a
   hover-cell highlight. THIS is what needs delaunay v1.2.0
   (`createCellIndex` below).

## Grounding (verified, line-cited)

- `_scatterHitTest` (Charts.js:4433-4482): indexed path `findNearest(qx, qy,
  1, toleranceSq, ...)`; linear fallback tracks nearest within tolerance.
  `hitToleranceSq` comes from config at `_initScatterOpts`
  (Charts.js:4365-4371, default markerSize + 4).
- Index invalidation: `_extractScatterData` (Charts.js:4390-4394) disposes
  the spatial index "on every data / scale change" (comment :4388) -- the
  cell index rides the IDENTICAL lifecycle, so pan/zoom re-projection can
  never serve stale cells. Planner re-verifies the extract effect actually
  tracks scaleVersion before locking this.
- Drawing precedent: the annotation layer's `pathNode({ draw })`
  (Charts.js:2049) -- a single scene node whose draw callback walks a list
  with moveTo/lineTo/fill, clipped to plot bounds, with proven SVG-export
  parity via `_drawNodeToSVG` (:3453). The cell layer is the same shape.
- Injection precedent: `config.spatialIndex` (Charts.js:3860-3891 contract
  comment; :4378 wiring) -- lite-charts NEVER imports the implementation.
- lite-delaunay ROADMAP v1.2.0 (LiteDelaunay/ROADMAP.md:82-100) promises
  `circumcenters` + `voronoiCell`; this brief REPLACES that sketch with a
  consumer-shaped contract (below) -- the roadmap itself says "the API is
  shaped by a real consumer, never speculatively".

## Design decisions

- **D1 -- fat hover is a tolerance policy, not a geometry feature.**
  `hitTolerance: 'nearest'` (scatter only). At hit-test time it resolves to
  a FINITE cap: the plot-bounds diagonal squared (`pb.w*pb.w + pb.h*pb.h`),
  re-read per query -- NOT `Infinity` (an infinite maxDistSq is an
  untested/unspecified input to the injected index's grid walk; a finite
  diagonal cap is semantically identical inside the plot and always
  terminates). Any other string throws at construction. Number values keep
  today's behavior byte-identically. Works on BOTH the indexed and linear
  paths. Bubble is OUT (containment semantics are the feature there).
- **D2 -- the cell layer is injected, never imported.** `cells: { index:
  createCellIndex(N), ... }` on `createScatterChart`, mirroring
  `spatialIndex`: optional peerDep only, zero references in Charts.js,
  tree-shake confinement asserted like TS20.
- **D3 -- cells are PIXEL-space, rebuilt with the projection.** Voronoi is
  not affine-invariant under anisotropic scaling (x and y scales differ), so
  data-space cells would be WRONG as hover regions. Charts hands the same
  projected `pxs/pys` it hands `spatialIndex`, and disposes/rebuilds through
  the same extract-time lifecycle (:4390-4394). Cold path: rebuild MAY
  allocate nothing beyond the facade (pooling below); per-frame draw walks
  prebuilt geometry at 0 B.
- **D4 -- rendering.** One `pathNode({ draw })` per chart (not per cell),
  inserted UNDER the marker layer, inside the existing plot clip. The draw
  walks visible cells: moveTo/lineTo/closePath, fill from a per-point color
  accessor (`cells.colorKey`, raw accessor -- no `+v` coercion, the bubble
  colorKey precedent Charts.js:3925-3928) or series fill; optional
  `cells.stroke`/`strokeWidth` for boundaries. SVG export parity required
  (the annotation layer proved the shim supports this).
- **D5 -- hover highlight is free.** The crosshair already carries
  `snapIdx`; the same draw callback strokes/tints the one cell whose index
  equals `crosshairData.snapIdx` (read via the existing rendererCtx ref --
  no new reactive surface, the crosshair version already schedules the
  redraw).
- **D6 -- scope.** Primary series only (a multi-series tessellation is
  ill-posed -- whose cell owns the pixel?). Scatter only. Degenerate input
  (all-collinear/coincident -> the index returns 0-vertex cells) draws
  markers with NO cells -- fail closed, never a wrong polygon.

## The consumer contract (what lite-delaunay v1.2.0 must ship)

Mirroring `createSpatialIndex` exactly -- pooled factory-factory, SoA input,
NaN compaction, original indices, generation-stamped facades:

```ts
createCellIndex: (maxPoints: number) => CellIndexFactory;
type CellIndexFactory = (pxs, pys, n) => CellIndex;   // Float32Array, NaN legal

interface CellIndex {
  // Write cell i's polygon, CLIPPED to the axis-aligned bbox and therefore
  // ALWAYS closed and finite (hull cells included -- clip, don't flag).
  // outXY is caller-owned interleaved [x0,y0,x1,y1,...]; returns the vertex
  // count written (0 .. outXY.length/2). Zero allocation per call.
  //   0 => no cell: i was a NaN point, input was degenerate
  //        (collinear/coincident), or the cell has no bbox intersection.
  // THROWS (never truncates, never overflows) if the clipped cell needs
  // more vertices than outXY can hold.
  cell(i, bx0, by0, bx1, by1, outXY): number;
  dispose(): void;
}

// Sizing rule the library DOCUMENTS and charts relies on (corrected by the
// delaunay session, verified empirically across their assertion sweeps):
// a bbox-clipped Voronoi cell has at most (degree + 4) vertices for an
// INTERIOR site and (degree + 5) for a HULL site (the unbounded cell
// contributes degree+1 boundary features against the box's 4). A
// caller-owned buffer of 2 * 64 floats covers every non-adversarial cloud,
// and the throw is the loud escape.
```

Contract requirements, all fail-closed -- STATUS 2026-09-02: delaunay
v1.2.0 is BUILT and gated against this section (97/97 tests, 29 new
CellIndex assertions incl. whole-tessellation area tiling at ~1e-16
relative error, a 5000-query nearest-site containment sweep, torture
cell-phase major GC = 0; `triangulate()`/`createSpatialIndex`
byte-identical). Release-pending their /release + publish. Semantics they
LOCKED where this brief left the choice open -- the charts planner treats
these as the contract now:
- `cell(i)` for a NaN-site `i` returns 0 (absent cell); an OUT-OF-RANGE `i`
  THROWS, as does a non-finite or non-strictly-ordered bbox (caller bugs
  fail loud; absent cells return 0).
- Duplicate sites: exactly ONE of the set owns the cell; the rest return 0.
- Build compacts finite points only; NEVER a garbage polygon.
- Near-degenerate circumcenters (d ~ 0) fail closed to the triangle
  centroid, per the existing ROADMAP note -- no Infinity vertices ever.
- bbox clipping is INSIDE the library (zero-alloc Sutherland-Hodgman on
  fixed scratch): d3-delaunay's `voronoi(bounds)` precedent -- every cell a
  consumer receives is finite and closed, or absent. Charts passes plot
  bounds as the bbox.
- Pooling/facade/generation semantics identical to createSpatialIndex
  (stale or disposed handle THROWS; one factory, many concurrent handles;
  0 B/query after build; ~48 B facade per build is the accepted cost).
- Gate: brute-force half-plane containment sweep (a random query point's
  containing cell must be its nearest site's cell), clip-correctness vs an
  unclipped reference, degenerate matrix, torture 0-major-GC over rebuild
  storms. `triangulate()` and `createSpatialIndex` byte-identical.

## Config surface (the charts cut)

```js
createScatterChart({
  data,
  hitTolerance: 'nearest',                  // D1 -- fat hover, index optional
  spatialIndex: createSpatialIndex(N),      // existing, unchanged
  cells: {                                  // D2 -- all-or-nothing opt-in
    index: createCellIndex(N),              // REQUIRED in cells{}: the factory
    colorKey?: 'zone',                      // raw per-point color accessor
    fillOpacity?: 0.35,
    stroke?: '--border', strokeWidth?: 1,
  },
});
```

Fail-closed doors: `cells` present without a function `index` throws;
`hitTolerance` string other than `'nearest'` throws; both at construction
with nothing attached.

## Scope fences (explicit OUT)

- Weighted/power diagrams, Lloyd relaxation -- OUT.
- Data-space Voronoi (anisotropy makes it wrong for hover) -- OUT.
- Multi-series tessellation, bubble cells -- OUT (D6).
- Cell labels/centroids-as-anchors -- OUT, annotation layer covers it.
- A standalone createVoronoiChart factory -- OUT for this cut; `cells` on
  scatter delivers the capability without a tenth bundle.

## Tasks (sketch -- planner to pin AFTER delaunay v1.2.0 is published)

- T1: `hitTolerance: 'nearest'` -- validator + per-query diagonal cap in
  `_scatterHitTest` (both paths). Charts-side only; can land even before
  delaunay v1.2.0 if the sessions end up reordered.
- T2: `_normalizeCellsSpec` (construction validator) + opts threading.
- T3: cell draw layer -- one pathNode under markers, cold geometry refresh
  hooked into `_extractScatterData`'s lifecycle, hover-cell highlight off
  `crosshairData.snapIdx`.
- T4: SVG export parity for the cell layer.
- T5: Charts.d.ts + docs.
- T6: tests -- fat-hover far-cursor snap (indexed AND linear paths agree),
  cell-layer geometry against a hand-computed 5-point fixture, degenerate
  fallback (markers, no cells), validation matrix, tree-shake confinement,
  retention, SVG parity. Reversion targets per house rule.
- T7: torture A20 -- pan/zoom storm with cells active: rebuild per scale
  change, 0 major GC, 0 new signal-graph nodes, draw 0 B/frame.

## Gate

npm test (453 + new) + torture ok. ASCII clean. Optional peer bump
`@zakkster/lite-delaunay` -> `^1.2.0` rides this release (also picks up the
queued `^1.1.0` tighten). Demo panel (tessellated scatter + fat hover) is a
follow-up demo session.
