# Brief -- contour/isoline layer on the scatter field raster (v1.17.0)

Status: EXECUTED 2026-09-05 (release-pending as v1.17.0). Full pipeline:
planner locked C1 TIN-sweep / C4 third-fault-domain-with-skip-gate / strict
z > v tie rule (plan re-emitted to contour-isolines-plan.md -- the planner
agent is read-only); coder shipped T1-T9 clean; reviewer APPROVED with zero
blockers (one cleanup-symmetry nit, fixed); qa = orchestrator (agent pattern):
CT1-CT8 (482->490), torture A23, five reversion proofs. As-executed notes:
(1) qa's CT2 first failed on ITS OWN expected set -- with the 1e6 outlier the
contours live in the mesh fan where the planar formula does not hold, and any
view touching the hull edge legitimately samples fan-inflated values; the fix
asserts fan LOCATION (outlier visible) and a strictly-interior zoom (levels
re-derive) -- the code was honest both times. (2) The field-domain skip gate
needed a purpose-built observable (off-hull pan -> 0 finite cells -> contour
pass must vanish though the mesh still exists); added to CT7, proven
load-bearing by reversion. Historical text below is the as-written brief.
NO delaunay-side change: consumes the shipped 1.3.0 surface AS-IS
(triangleCount/triangleVertices only; locate/barycentric stay unconsumed)
and does NOT trigger their 1.4.0 (their dormancy stays unbroken).

## Goal

`field.contours` on `createScatterChart`: iso-value lines drawn over the
v1.16.0 field raster (above the fill, below cells/markers, inside the plot
clip), computed COLD on the same postProject refresh, 0 B/frame draw. The
"weather map" completion: the raster gives the ramp, contours give the
structure. A scatter with `field` but no `contours` key stays byte-identical.

## Grounding (verified against v1.16.0 code, 2026-09-05)

- `_scatterRefreshField` (Charts.js:4942) already holds everything a contour
  pass needs when it finishes: `primary.fieldIndex` (the LIVE handle -- built
  lazily at :4983, disposed only on data change :4651 / cleanup :5110 /
  fault :5024), `primary.fieldGrid` (pooled Float32Array, row-major gw x gh
  of sampled values, NaN = unpainted), `primary.zs` (packed per-point
  values), `pxs/pys` (projected pixels), `vMin/vMax` (currently locals --
  would need hoisting to state if contours derive levels from them),
  `plotBoundsBox` and the NO-flip bbox (:4981).
- **The exact-isoline surface is cheaper than assumed**: on a piecewise-
  linear TIN, the iso-line for level v crosses a triangle iff v lies between
  its vertex z's; the crossing segment's endpoints are linear interpolations
  ALONG EDGES. That needs `triangleCount()` + `triangleVertices(t, outI3)`
  (3 ORIGINAL site indices -- verified live: returns e.g. [2,0,3]) plus
  caller-side lerp over pxs/pys/zs. `locate`/`barycentric` are NOT required
  for isolines at all (they stay unconsumed; honest scope note for the
  eventual delaunay ledger update).
- Perf grounding (their 1.3.0 bench, in briefs/README): T ~ 2n triangles.
  A full-mesh sweep is O(T x L) with zero allocs into pooled buffers --
  cold-only, riding the same refresh cadence sampleField already proved
  affordable (0.55 ms/grid at 100k pts). Charts-side cost still needs its
  own torture measurement (A23).
- Draw order today: field node BEFORE cells node BEFORE markers (:6107+).
- Fault protocol precedent: cells and field have independent try/catch +
  ctx error slots. Contours share the field's INPUTS (spec.index, zs);
  planner owns whether they share the field's fault domain or get a third.

## Design decisions the planner OWNS (candidates, falsify freely)

- C1 Geometry source: (a) **exact TIN sweep** -- walk all triangles via
  triangleVertices, lerp crossings on edges in pixel space; EXACT for the
  piecewise-linear interpolant (a planar field's isoline is exactly straight
  -- the qa oracle), resolution-independent, crisp at any zoom; or (b)
  **marching squares over primary.fieldGrid** -- zero extra index calls,
  trivially consistent with the painted raster, but resolution-bound
  (64x48 staircase) and NaN-cell edge cases multiply. The brief leans (a):
  the raster is a background wash, lines are foreground geometry and deserve
  exactness; but (b)'s consistency-with-fill argument deserves a real look.
- C2 Config surface: nested `field.contours` (shares index/value/zs/refresh
  -- contours without a `field` parent are ill-posed here) with
  `{ levels: int count 1..cap | number[] of explicit values, color?,
  width?, dash? }`. Count form spreads levels evenly INSIDE (vMin, vMax)
  (finite-cell extrema, exclusive -- a level AT the extremum degenerates to
  a point/edge). Explicit values outside the data range yield no segments
  (not an error -- panning changes vMin/vMax, levels must not throw at
  runtime). Cap and defaults are planner's (suggest cap 32, default color =
  a dark neutral or ramp-derived, width 1, no dash).
- C3 Storage + paint: pooled grow-only Float32Array of segments
  (x0,y0,x1,y1 per crossing) + per-level counts, precomputed cold in the
  refresh; the frame draw walks moveTo/lineTo under one stroke per level
  (the fillRect-walk idiom). NO Path2D per frame; NO per-frame alloc.
  exportSVG emits honest geometry (one path per level, segment moves --
  parity precedent from cells/field; a documented omission is REJECTED).
- C4 Refresh placement + fault domain: extend `_scatterRefreshField` (one
  fault domain -- a contour fault kills the raster too) vs a sibling
  `_scatterRefreshContours` reusing `primary.fieldIndex` (third independent
  domain per the split precedent, but it must then tolerate the field pass
  having disposed the handle on fault -- rebuild-or-skip door). Planner
  decides; the v1.16.0 split exists precisely because independent domains
  proved cheap.
- C5 Level derivation timing: count-form levels depend on vMin/vMax, which
  the field pass computes finite-only. Hoist to state (fieldVMin/fieldVMax)
  or recompute; either way the count form MUST track pan/zoom (panned-out
  outlier rule applies to levels exactly as it does to the ramp).
- C6 Scope fences: primary series only; scatter only; requires `field`
  parent (contours alone throw at construction); degenerate clouds (<3
  points / collinear -> triangleCount 0) draw no contours, no error.

## Fail-closed doors (construction, before any owned signal)

`contours` non-object; `levels` missing, count non-integer / <1 / >cap,
array empty / non-finite entries / non-numbers; junk color/width/dash per
house style (`== null` gated before any `+`; null is not zero). Runtime:
handle faults ride the chosen fault-domain protocol (C4); a handle missing
triangleVertices/triangleCount (foreign factory) is a runtime fault, not a
construction door (methods live on the facade prototype -- not probeable
cheaply at normalize time; verify what IS probeable, door the rest at first
refresh).

## Gate (all mandatory)

- Boundary suite vs the REAL published 1.3.0: the planar oracle again --
  z = ax+by+c is its own linear interpolant, so every emitted segment
  endpoint must satisfy the mapped pixel-space line equation |a'x+b'y-c'|
  within tight tolerance (EXACT for C1a); level-monotonicity (segments for
  v1 < v2 separated by the gradient direction); NaN/hull confinement (no
  segment endpoint outside the hull's pixel bbox + epsilon); count-form
  levels track pan/zoom (outlier rule); explicit out-of-range levels = 0
  segments, no throw; doors matrix at zero node delta; cross-fault per C4;
  SVG parity (paths per level, defs-stripped before searching -- the VC6
  lesson); 50x retention (segment pools + handle); source-scan confinement
  (still 0 delaunay imports; `.locate(`/`.barycentric(` 0 call sites --
  they remain unconsumed).
- Torture A23: view storm -> contour regen exactly once per scale/data
  change, never per frame; redraw <= 16 B/op within 2 B/op of a
  no-contours control (branch-parity control per the A21 lesson; 8-write
  warm-up before graphSnapshot per A19/A22).
- Reversion proofs for every load-bearing mechanism.
- Docs: CHANGELOG/llms.txt/README/ROADMAP/Charts.d.ts. ASCII only.

## Out of scope

Contour LABELS (text placement is its own problem); filled isobands (the
raster already fills); smoothing/splines (the TIN's piecewise-linear truth
is the product); hover/hit-testing on contour lines; consuming
locate/barycentric (nothing here needs them -- record that honestly);
heatmap-kernel contours (categorical axes, wrong home, 2026-09-03);
ANY delaunay-side change (1.4.0 still has NO trigger).
