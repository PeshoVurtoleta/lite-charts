# Brief -- cluster outlines on scatter (v1.18.0) x lite-delaunay 1.4.0

Status: CONTRACT DRAFT 2026-09-05 (greenlit by user, same day the 1.4.0
wake question arrived from the lite-delaunay thread). This brief carries
the CONSUMER CONTRACT lite-delaunay 1.4.0 is built against -- the exact
protocol that produced their 1.2.0 (`voronoi-cells.md`) and 1.3.0
(`field-raster.md`). Sequencing: (1) relay the "Consumer contract" section
to the lite-delaunay session; (2) they ship 1.4.0; (3) a charts session
executes THIS brief against the PUBLISHED package. The charts side is
BLOCKED until 1.4.0 is on npm -- do not build against a local checkout.

UPDATE 2026-09-05: lite-delaunay 1.4.0 is PUBLISHED and npm-view-verified
(latest=1.4.0). The publish block is cleared. Execution still WAITS on
their relay ping-back with the four deliverables in "Asks relayed WITH
the contract" below -- the SIZING BOUND above all (pool pre-allocation
cannot be written without it). Do not substitute a guessed bound.

## Goal

`outlines` on `createScatterChart`: one boundary outline per point group
(convex hull, or a concave alpha-shape hull that actually hugs the
cluster), stroked + optionally translucently filled, drawn inside the
plot clip, computed COLD on the postProject refresh, 0 B/frame draw.
The fourth rung of the injection ladder: spatialIndex -> cells -> field
-> outlines. A scatter without an `outlines` key stays byte-identical.

## Why alphaShape is the trigger (and convexHull alone is not)

A convex hull is ~30 lines of caller-side monotone chain -- if 1.4.0 were
only `convexHull`, charts would honestly not need lite-delaunay for it.
An alpha shape is DERIVED FROM the Delaunay triangulation (keep triangles
with circumradius <= alpha; the boundary is the edges owned by exactly
one kept triangle) -- mesh-internal knowledge only their package has.
`convexHull` rides along as the alpha -> infinity degenerate, essentially
free on their side and worth having as the cheap default. Recorded so the
delaunay ledger's dormancy history stays honest.

## Consumer contract (what charts will call -- 1.4.0 builds against THIS)

Factory shape mirrors CellIndexFactory/FieldIndexFactory (Charts.d.ts
:1355/:1391); whether the methods land on a new factory's handle or on
an existing facade is THEIR planner's call, but charts will consume it
as an injected factory: `(pxs, pys, n) -> handle`, pixel-space Float32
coords, built fresh per refresh per group.

- `convexHull(outIndices) -> count`
  CCW hull vertices as ORIGINAL site indices (the triangleVertices
  precedent -- duplicate/degenerate compaction must not leak internal
  ids), written into the caller-owned Int32Array. count <= n. Collinear
  or n < 3 -> returns 0 (not an error). Zero allocation.
- `alphaShape(alpha, outIndices, outLoopEnds) -> loopCount`
  alpha is a RADIUS in input (pixel) units; keep triangles with
  circumradius <= alpha. Boundary loops written CONCATENATED into
  outIndices (ORIGINAL indices, CCW per loop, loop closure implicit
  last -> first); `outLoopEnds[i]` = EXCLUSIVE end offset of loop i in
  outIndices. Returns the loop count; 0 legal (alpha too small for any
  triangle, or n < 3). Zero allocation; caller owns both buffers.
  MULTIPLE disjoint loops are the semantic point -- a flat array with a
  single count cannot express them; this two-buffer convention is the
  contract's load-bearing decision.
- THEY must document a hard sizing bound for both out-buffers as a
  function of n (charts pre-allocates pooled grow-by-double buffers and
  needs a worst case; note a vertex may legally appear on more than one
  loop at a pinch point, so the bound exceeds n -- state the tight one).
- Doors on their side (charts states what it will pass, they fail
  closed on the rest): alpha must be a finite number > 0 -- NaN, +/-0,
  negative, Infinity, null all throw (`== null` gated before any `+`;
  Infinity is NOT a hull alias -- charts calls convexHull explicitly,
  no silent degeneracy).
- `dispose()` per the pool contract; handle methods may live on the
  facade prototype (their 1.3.0 layout -- charts probes with `typeof`
  at first refresh, not at construction).

## Asks relayed WITH the contract (their deliverables back, via user relay)

1. The out-buffer SIZING BOUND (contract item above) -- charts cannot
   pre-allocate pools without it.
2. HOLE LOOPS: state whether alphaShape emits interior (hole) loops,
   and if so the orientation convention (suggest: outer CCW, holes CW
   -- the SVG even-odd-friendly convention). Charts v1 draws all loops
   as ordinary loops either way; the statement just prevents a contract
   round-trip later.
3. DUPLICATE-COORDINATE points on a hull: which ORIGINAL index is
   emitted when coincident points share a hull vertex -- any one, but
   deterministically which (document, don't promise cleverness).
4. BENCH numbers per the 1.3.0 precedent (medians, steady-state, heap
   deltas ~0): convexHull + alphaShape at n = 1k/10k/100k, AND
   build+hull cost at small n (n = 8..256) -- charts calls per GROUP on
   freshly built subset handles every refresh, so BUILD cost at small n
   dominates the real workload, not query throughput at 100k. Tiny-n
   correctness (n = 3, 4, collinear, all-duplicate) is a boundary their
   gate should own.

Protocol reminders for their side: 1.4.0 is ADDITIVE on the shipped
facade (charts probes `typeof` at first refresh -- no construction-time
probe needed); triangleCount/triangleVertices/sampleField are consumed
by shipped charts releases and must not change shape; locate/barycentric
stay unconsumed but stay put (semver). Ping back through the user with:
published version, sizing bound, hole-loop statement, bench numbers.

## Grounding (verified against v1.17.0 code, 2026-09-05)

- `_scatterPostProject` (Charts.js:5303-5306) runs cells -> field ->
  contours as independent fault domains; error slots OR-ed into the
  mount door at :6304. Outlines slot in as a FOURTH pass + `outlineError`
  slot, same idiom (own try/catch, disposes only its own handles, a
  fault in any sibling layer never suppresses it -- :5121 comment block
  documents the pattern).
- Groups: scatter has no group concept today; `cells.colorKey` (:4730)
  is the per-row-key precedent, including cold CSS-var resolution. The
  outlines layer adds `groupKey`: rows partition by that key's value,
  and charts packs per-group pxs/pys subset arrays (pooled, grow-only)
  before calling the factory ONCE PER GROUP per refresh -- the factory
  contract takes (pxs, pys, n), so per-group handles, not a filtered
  global mesh. Handles disposed + rebuilt on every data/scale change
  (pixel space is not affine-stable across anisotropic zoom -- the
  cells lesson).
- Draw: one scene node, above the cells node, below markers (an outline
  frames the cluster the cells tile). Pooled segment walk: per group,
  optional fill first (moveTo/lineTo/closePath/fill per loop), then one
  beginPath/stroke over its loops -- the contour-layer idiom (:5254+),
  save/restore, `setLineDash` reset via a module-frozen empty, NO
  getLineDash (it allocates). exportSVG parity free via the draw-fn shim.
- Perf: their hull/alpha sweep is O(T) over ~2n triangles per group --
  strictly cheaper than the field resample charts already runs per
  refresh at the same cadence. A24 measures the charts-side cost anyway.

## Design decisions the planner OWNS (candidates, falsify freely)

- C1 Config surface: top-level `outlines: { index, groupKey, alpha?,
  stroke?, strokeWidth?, fill?, fillOpacity?, dash? }` (independent of
  cells/field -- unlike contours, outlines have no field parent; a
  scatter may have outlines and nothing else injected). `alpha` absent
  -> convexHull path; `alpha: number` -> alphaShape. Per-group style?
  Lean NO for v1: one style for all groups (contours precedent: one
  color per layer); per-group tinting can ride groupKey + the colorKey
  resolver in a later minor if wanted.
- C2 Alpha units: pixel-space alpha is screen-truthful but re-fragments
  under zoom-out (points crowd, more triangles pass; zoom-in spreads
  points and loops fragment/vanish -- HONEST behavior, document it) vs
  `alpha: 'auto'` deriving k x median-Delaunay-edge-length per group per
  refresh (self-tuning, needs edge lengths charts can compute from
  triangleVertices... on the OTHER handle -- messy, probably out).
  Lean: literal pixel alpha only, fragmentation documented as the ramp
  outlier rule's sibling; 'auto' deferred with a named trigger.
- C3 Group partition mechanics: key values compared how? Lean
  SameValueZero on the raw row value, insertion-ordered groups, pooled
  per-group index lists rebuilt cold at extract (data change), pixel
  subsets repacked at postProject (scale change). Missing/null groupKey
  value on a row -> row belongs to NO group (drawn as marker only, no
  throw at runtime -- panning-safe), but a groupKey that is not a
  string/absent at CONSTRUCTION throws.
- C4 Degenerate groups: n < 3 or collinear -> no outline for that group,
  no error, other groups unaffected (per-group isolation inside the one
  fault domain -- a THROW from the handle is still the layer-level fault).
- C5 Cap: max distinct groups (lean 64) -- construction-time throw
  above it? Runtime data can grow groups; lean: cap enforced at refresh,
  over-cap = layer-level fault (fail closed, recorded in outlineError),
  because silently dropping groups lies.

## Fail-closed doors (construction, before any owned signal)

`outlines` non-object; `index` missing/non-function; `groupKey`
missing/non-string; `alpha` present but not a finite number > 0
(`== null` gated before any `+`; null is not zero; Infinity refused --
omit alpha for the hull); junk styles fall back per house style
(stroke default a both-theme-safe hex -- RAW strokeStyle, no CSS-var
resolution, the contour lesson; width 1 clamp (0,16]; fillOpacity
clamp [0,1], default 0 = no fill; dash frozen copy). Runtime: handle
missing convexHull/alphaShape is a first-refresh fault (prototype
probe), not a construction door.

## Gate (all mandatory)

- Boundary suite vs the REAL published 1.4.0: convex-hull oracle = an
  independent monotone-chain in the test file (exact index set + CCW
  order, modulo rotation); alpha-shape oracle = independent circumradius
  filter over triangleCount/triangleVertices (every emitted boundary
  edge is a Delaunay edge owned by exactly ONE kept triangle; every
  kept-triangle boundary edge is emitted); large-alpha alphaShape ==
  convexHull vertex set (single loop); shrinking alpha strictly
  non-increasing kept-triangle count and eventually 0 loops (honest
  zero); multi-loop fixture (two sub-blobs in one group bridged by a
  long edge -- alpha between the blob scale and the bridge yields
  EXACTLY 2 loops, outLoopEnds consistent); groupKey partition matrix
  (missing-key rows excluded, per-group degenerate isolation per C4);
  doors matrix at zero node delta; fourth-fault-domain matrix (outline
  fault leaves cells/field/contours intact AND vice versa; mount door
  OR includes outlineError -- give the gate a purpose-built observable
  BEFORE claiming reversion-proof, the CT7 lesson); pan/zoom rebuild
  (pixel-space repack per scale change, alpha fragmentation under zoom
  asserted as documented behavior, not fought); SVG parity (one path
  per loop, `Z`-closed, defs-stripped searches); 50x retention (per-
  group handles + pools; builds === disposes); source scan (0 delaunay
  imports; locate/barycentric STILL 0 call sites).
- Torture A24: gesture storm with 2 groups x 1000 pts + branch-parity
  no-outlines control; one rebuild per scale/data change, never per
  frame; redraw <= 16 B/op and within 2 B/op of control; 0 new graph
  nodes; warm-up + op counts per the A21/A23 granularity lesson
  (tighten ops, never thresholds).
- Reversion proofs for every load-bearing mechanism.
- Docs: CHANGELOG/llms.txt/README/ROADMAP/Charts.d.ts (+
  `ClusterIndexFactory` type). ASCII only. Peer bump `^1.4.0` (still
  OPTIONAL). Delaunay consumption notice updated: convexHull+alphaShape
  join the consumed set; locate/barycentric status restated honestly.

## Out of scope

Outline LABELS; per-group styles (C1, deferred with trigger); alpha
'auto' (C2, deferred with trigger); holes (their alphaShape may emit
interior loops -- if their contract includes hole loops, charts v1
draws them as ordinary loops; even-odd fill niceties deferred); hulls
on bubble (primary scatter series only, the D6 fence); smoothing;
hit-testing on outlines; ANY delaunay-side change beyond the contract
above -- scope creep on 1.4.0 is their planner's to refuse.
