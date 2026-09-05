# PLAN -- contour/isoline layer (v1.17.0), planner-locked 2026-09-05

Provenance: planner agent locked C1-C6 + tasks + assertions (2026-09-05, lean
re-run after the first run burned its cap on grounding); the planner agent is
READ-ONLY, so this file is the orchestrator's re-emission of that plan.
Door-message wording, pool field names, and count-form arithmetic below are
orchestrator gap-fills inside the planner's framework, marked [GF].

## Locked decisions

- **C1 = exact TIN sweep** (not marching squares over fieldGrid). Lines are
  foreground geometry: the TIN isoline is EXACT for the piecewise-linear
  interpolant (the planar qa oracle is exact, not approximate),
  resolution-independent under zoom, and needs only triangleCount() +
  triangleVertices() + edge-lerp over pxs/pys/zs already on state. Marching
  squares would bind line quality to the 64x48 raster and multiply NaN-cell
  edge cases for zero API savings.
- **C2 config**: nested `field.contours` (contours without `field` are
  unrepresentable -- no new top-level key). Shape:
  `{ levels: count | number[], color?, width?, dash? }`. Count form resolves
  COLD in the refresh to k levels STRICTLY INSIDE (fieldVMin, fieldVMax):
  [GF] `v_i = vMin + (i+1) * span / (k+1)`. Array form: finite numbers,
  sorted ascending into a Float64Array at normalize, exact duplicates
  dropped [GF]; out-of-range levels legally produce 0 segments at runtime
  (pan changes the range -- never a runtime throw). Cap 32 levels.
- **C3 storage + paint**: segments pooled per-state, grouped by level
  (contiguous per-level runs): `contourXY` Float32Array (x0,y0,x1,y1 per
  segment, grow-by-double), `contourCounts` Int32Array(32) [GF],
  `contourLevelCount`, `contourSegTotal`, `contourTriIdx` Int32Array(3)
  scratch. Draw fn = per-level beginPath/moveTo/lineTo/stroke walk; ONE
  color/width/dash for all levels (per-level styling out of scope). Dash via
  module-level frozen `_CONTOUR_NO_DASH = []` + the spec's frozen dash array
  -- setLineDash(spec.dash || _CONTOUR_NO_DASH), reset to _CONTOUR_NO_DASH
  after (getLineDash() ALLOCATES -- never call it on the hot path).
  exportSVG parity is FREE through the draw-fn shim (annotation-layer
  precedent proved moveTo/lineTo/stroke serialize); assert, don't build.
- **C4 = THIRD independent fault domain**, `_scatterRefreshContours` called
  from `_scatterPostProject` AFTER `_scatterRefreshField`, own try/catch +
  `ctx.contourError` (OR-ed into the mount door at :6026). It REUSES
  `primary.fieldIndex` and therefore GATES on the field pass: if
  `ctx.fieldError != null` OR `primary.fieldIndex` is null OR
  `(primary.fieldFiniteCount|0) === 0`, it SKIPS (contourSegTotal = 0,
  return) -- it never REBUILDS the handle (rebuilding would resurrect a
  handle the field pass deliberately disposed on fault, splitting truth).
  A contour-pass fault zeroes contourSegTotal + sets ctx.contourError and
  disposes NOTHING (the handle belongs to the field domain).
- **C5**: hoist vMin/vMax to state as `fieldVMin`/`fieldVMax` in
  `_scatterRefreshField` (set NaN on fault and on finite<=0 -- NaN is the
  fail-closed "no range" sentinel; count-form level resolve checks
  `span > 0` before emitting any level).
- **C6 fences**: primary series only; scatter only; `contours` requires the
  `field` parent by construction (it lives inside it); triangleCount 0
  (degenerate cloud) -> 0 segments, no error; a chart with `field` but no
  `contours` adds NO node and stays byte-identical on its draw path.
- **Tie rule** (the TIN analog of marching-squares ambiguity): vertex side =
  strict `z > v`. A vertex with z exactly v is "not above": every triangle
  yields exactly 0 or 2 edge crossings, no special cases; two vertices at
  exactly v with the third above yields the honest degenerate segment along
  that edge. Edge lerp `t = (v - za) / (zb - za)` is safe because crossing
  edges have za, zb on strict opposite sides (zb - za never 0).

## Doors ([GF] wording; all inside `_normalizeContoursSpec`, invoked from
`_normalizeFieldSpec` when `field.contours != null`, so every throw fires at
construction before the first `_own(signal())`, same guarantee as fieldSpec)

1. non-object -> "lite-charts: field.contours must be an object"
2. `levels == null` -> "lite-charts: field.contours.levels is required (a count or an array of values)"
3. number form: `!Number.isInteger(l) || l < 1 || l > 32` -> "lite-charts: field.contours.levels count must be an integer in [1, 32]"
4. neither number nor array -> door 3's message class: "lite-charts: field.contours.levels must be a count or an array of numbers"
5. array form: empty -> "lite-charts: field.contours.levels array must not be empty"; length > 32 -> "... at most 32 levels"
6. array entries: `e == null || typeof e !== 'number' || !Number.isFinite(e)` -> "lite-charts: field.contours.levels entries must be finite numbers" (`== null` gated BEFORE any coercion)
7. style fallbacks (NOT throws -- FR3 ramp-fallback precedent): color
   non-string -> default '#1e293b'; width `w = +width`, `!(w > 0)` -> 1,
   clamp <= 16; dash not an array of positive finite numbers -> null
   (solid); a valid dash is COPIED and FROZEN at normalize.

Normalized spec: `{ levelCount | null, levelValues: Float64Array | null,
color, width, dash: frozen number[] | null }` stored as `fieldSpec.contours`
(null when absent).

## Tasks (planner T1-T9)

- T1 `_normalizeContoursSpec` + wiring into `_normalizeFieldSpec` return.
- T2 `_scatterRefreshField`: hoist `fieldVMin`/`fieldVMax` to state; NaN on
  fault and on finite<=0 paths.
- T3 `_scatterRefreshContours` skeleton: spec gate, field-domain gate
  (SKIP not rebuild, per C4), own try/catch -> `ctx.contourError`.
- T4 level resolve: array form = normalized Float64Array as-is; count form =
  k levels strictly inside (fieldVMin, fieldVMax), span>0 guard.
- T5 TIN sweep: for each level, walk t in [0, triangleCount);
  `triangleVertices(t, contourTriIdx)` ONCE per triangle per level pass;
  strict `z > v` sides; edge-lerp endpoints into `contourXY`
  (grow-by-double before append); per-level counts.
- T6 `makeScatterContourDrawFn` + module-level `_CONTOUR_NO_DASH`: gate on
  `(state.contourSegTotal|0) === 0`, plot clip idiom, save/restore
  strokeStyle + lineWidth, dash set/reset, per-level stroke walk. ZERO
  allocation, ZERO `[]` literals in the body.
- T7 `_scatterPostProject`: third call after field. Scene wiring: contour
  pathNode added between the field node and the cells node, gated
  `chartOpts.fieldSpec && chartOpts.fieldSpec.contours`.
- T8 mount door ORs `rendererCtx.contourError` (:6026 chain); cleanup
  (:5110 region) nulls `contourXY`/`contourTriIdx`; `rendererCtx` gains
  `contourError: null` at its literal.
- T9 `Charts.d.ts`: `FieldContoursSpec` + `contours?` on the field config
  type. Torture A23 (see below).

## Assertions (planner A1-A5 -> qa suite CT1..CTn)

- A1 planar oracle: z = 2x+3y+1 on the diamond fixture; every emitted
  segment endpoint satisfies the pixel-mapped line equation
  `|a'x + b'y - c'| <= 1e-6` in normalized units (endpoints are lerps of
  float32-stored pxs/pys/zs -- the oracle recomputes from the SAME stored
  values, so the bound is float64-lerp roundoff, not float32 storage; qa
  states the tolerance argument in the test comment).
- A2 hull confinement: 0 endpoints outside [pxMin-0.5, pxMax+0.5] x
  [pyMin-0.5, pyMax+0.5].
- A3 torture A23: maxMajor === 0, redraw <= 16 B/op AND within 2 B/op of a
  BRANCH-PARITY control (field WITHOUT contours, identical workload -- the
  A21 lesson); refresh-count invariant (contour sweep entered exactly once
  per scale/data write, never per redraw); 8-write warm-up before
  graphSnapshot, relative accounting (A19/A22 precedent); 0 new graph nodes.
- A4 retention: 50x create/mount/write/destroy -> tracker.size() === 0.
- A5 source scan: 0 delaunay imports; `.locate(` 0 call sites;
  `.barycentric(` 0 call sites (they stay UNCONSUMED -- honest scope);
  0 array literals in the contour draw-fn body region.
- Plus [GF, from the brief's gate]: doors matrix at zero node delta;
  cross-fault per C4 (field fault -> contours skip WITHOUT contourError;
  foreign handle lacking triangleVertices -> contourError at refresh,
  raster survives, markers draw; contour fault never disposes fieldIndex);
  count-form levels move under pan/zoom (panned-out outlier rule); explicit
  out-of-range levels -> 0 segments no throw; level == vertex z tie fixture;
  SVG parity (stroke path per level present after defs strip; node order
  field rects < contour paths < cell paths); no-contours byte-identity.

## Risks

- Level exactly at a vertex z: settled by the strict tie rule (above).
- Zero-span field (all z equal): count form emits no levels (span>0 guard);
  array form: no vertex is strictly above any v != z, and v == z puts all
  vertices "not above" -> 0 crossings. Both honest.
- fieldVMin/fieldVMax staleness: they are written by the field pass in the
  SAME postProject invocation before the contour pass reads them -- ordering
  is structural (T7), pinned by the cross-fault tests.
- Dash restore: the layer resets to _CONTOUR_NO_DASH rather than
  save/restore via getLineDash() (which allocates). No other layer relies
  on ambient dash state (annotations set their own); qa pins with a
  calls-order check.
