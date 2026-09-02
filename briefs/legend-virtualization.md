# Brief -- legend virtualization (v1.12.0)

Status: GROUNDED BRIEF (re-grounded 2026-09-02 against v1.10.0 code +
lite-virtual@1.1.0). Smallest-reach of the polish items; useful for 100+
series dashboards (real-time monitoring).

## Goal

Bounded-DOM legend for charts with many series: only visible rows exist,
scrolling reveals the rest, click-to-toggle still drives the same
`seriesVisibility` signals.

## Grounded facts (verified 2026-09-02)

- `buildLegendDOM` (Charts.js:2665-2730 at v1.10.0) is EAGER: one `<button>`
  per series with swatch + label, a closure-captured `idx` click listener, and
  **one `effect` per row** (aria-pressed + opacity follow
  `seriesVisibility[idx]`). 500 series = 500 buttons + 500 listeners + 500
  reactive effects, all up front.
- Legend config (Charts.js:~4607) already has an object form:
  `legend: false | 'top'|'bottom'|'left'|'right' | { position?, container? }`
  -- `virtualize` slots into the existing object, no new config door.
- **THE injection pattern is settled by precedent, not open:** Charts.js never
  imports its optional peer. `lite-delaunay` arrives as a caller-supplied
  factory (`config.spatialIndex`) against a documented contract
  (`SpatialIndexFactory`, Charts.js:3674-3690); the package.json optional-peer
  entry is advisory. The legend does the SAME: a documented
  `LegendVirtualizer` contract, caller passes an adapter over lite-virtual.
  Consequences: zero-dep law holds trivially, tree-shake isolation is
  automatic (there is no import to shake), uninstalled lite-virtual can't
  break anyone, and the earlier open question "how do we import it" vanishes.
- lite-virtual@1.1.0 (stable) fits: `mountList(host, scope, { count,
  itemHeight, viewport, overscan?, render })` -- legend rows are uniform
  height, so the fixed-size axis (cheapest) is correct; `mountKeyedList`
  unnecessary (rows are index-addressed, stateless besides signals).

## Shape (the cut)

```js
legend: {
  position?: 'left' | 'right',   // v1.12.0: vertical only (scroll-y)
  height?: number,                // viewport px; required to virtualize
  virtualize?: (host, opts) => ({ dispose }),   // the injection point
}
```

- `virtualize` receives a `LegendVirtualizer` opts contract owned by
  Charts.js: `{ count, itemHeight, renderRow(rowEl, idx), height }` (exact
  fields planner-final). The README ships a ~6-line adapter over
  lite-virtual's `mountList`. No import of lite-virtual anywhere in Charts.js.
- No `virtualize` (or a non-function) -> the v1.x eager legend, byte-identical.
  Explicit opt-in only; NO automatic series-count threshold (fail closed on
  unverified capability -- we cannot know lite-virtual is installed).
- Horizontal (top/bottom) positions + `virtualize` -> THROW at construction
  (documented as later work), never a silently broken layout.

## The foot-guns (from v1.x row code, now with line evidence)

- **Effect-per-row does not survive pooling.** Today's per-row `effect`
  (Charts.js:2719-2724) assumes a row is born once. Pooled rows are REBOUND:
  the design is one effect per POOLED NODE (bounded, perView + 2*overscan)
  whose subscription target re-reads a `rowIdx` holder set by `renderRow` --
  or fully imperative renderRow + re-render on visibility change via one
  shared effect. Planner picks; either keeps effect count bounded and
  rebind-safe. NEVER a closure-captured idx in a pooled listener.
- **Listener identity:** one delegated click listener on the legend host
  (dataset-index lookup) replaces per-row listeners entirely -- simpler than
  rebinding, and the disposers list shrinks to O(1).
- **A11y:** rows leave the DOM when scrolled out; keep `role`/`aria-pressed`
  applied in `renderRow`, and document that focus does not survive scroll-out
  (acceptable; matches every windowed list).
- **Swatch color:** eager rows read `seriesRefs[idx].colorRef.value` once at
  build (2701); `renderRow` must re-read per bind or recycled rows show stale
  colors.

## Assertions (sketch)

- 200-series chart + virtualize adapter: mounted row-element count is bounded
  (<< 200, = perView + overscan window); scrolling reveals later series
  (scroll host, assert row content updates).
- Clicking a recycled row toggles the CORRECT `seriesVisibility[idx]` (the
  classic off-by-recycle bug -- scroll first, then click, assert the signal
  index).
- Toggling a series off then scrolling it out and back preserves the dimmed
  state (renderRow re-reads the signal).
- No `virtualize` -> eager path byte-identical (source-confinement: the
  virtualized branch reachable only behind the opt-in; grep-style proxy as
  TS11).
- Horizontal + virtualize throws at construction.
- 50x mount/destroy with the adapter -> zero retained nodes/effects
  (bounded-pool effects all disposed).
- Torture: scroll-storm on the virtualized legend allocates only at
  lite-virtual's boundary-crossing rate; chart draw path stays 0 B (legend is
  DOM, but the gate proves no chart-side per-frame coupling).

## Gate

Standard: `npm test`, torture `ok`, ASCII-only, eager-path byte-identity,
injection isolation (no lite-virtual import anywhere in Charts.js -- grep).
package.json gains `@zakkster/lite-virtual` under `peerDependenciesMeta`
optional, mirroring lite-delaunay (advisory only).
