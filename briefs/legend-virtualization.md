# Brief -- legend virtualization

Status: DESIGN BRIEF. Local scratch, not shipped. Smallest-reach of the
polish items; useful only for 100+ series dashboards.

## Goal

Render only the visible legend rows for charts with many series (real-time
monitoring with 100-1000 series), via `@zakkster/lite-virtual`, instead of one
DOM node per series.

## What exists

- The legend is DOM-rendered today (`chart.legend` is an `HTMLElement`,
  click-to-toggle visibility, auto-wraps the canvas in a flex container or
  appends into `legend.container`). At 100+ series that's 100+ DOM rows +
  listeners built up front.

## Shape (proposal)

- Add `@zakkster/lite-virtual` as an **optional** peer dep (mirror the
  `lite-delaunay` pattern: `peerDependenciesMeta.optional`, tree-shaken out
  when unused). Zero-runtime-dep law holds -- it's a peer, not a dependency.
- Opt-in via `legend: { virtualize: true }` (or auto above a series-count
  threshold, e.g. 50 -- planner to decide; explicit opt-in is safer for a
  micro-lib). Below the threshold / unset, the v1.x eager legend is unchanged.
- lite-virtual windows the row list into a bounded DOM pool; only visible rows
  exist. Click-to-toggle still writes the same `seriesVisibility` signals.

## Open questions

- Does the legend need a fixed height/scroll container to virtualize? Yes --
  virtualization needs a scroll viewport. That changes legend layout for the
  virtualized case; keep it behind the opt-in so default charts are unaffected.
- Left/right vs top/bottom legend positions: vertical (left/right) virtualizes
  naturally (scroll y); horizontal (top/bottom) needs horizontal windowing or
  a wrap-and-scroll. Scope to vertical first; document horizontal as later.
- Keyboard/focus + a11y of a windowed legend (rows enter/leave the DOM):
  ensure toggling stays reachable; lite-virtual's pool churn must not drop
  focus silently.

## Watch-outs

- **Isolation.** Charts that don't opt in must not pull lite-virtual (esbuild
  verify), and must not require it installed.
- **Signal wiring.** Row recycling must rebind click handlers to the correct
  series index as rows scroll -- classic virtualization foot-gun. Bind by
  data-index lookup, not closure capture at build time.

## Assertions (sketch)

- 200-series chart with `legend:{virtualize:true}` mounts with a bounded DOM
  row count (<< 200); scrolling reveals later series.
- Clicking a virtualized row toggles the correct series' visibility signal.
- Chart without the opt-in is byte-identical to today and pulls no
  lite-virtual symbols (tree-shake).
- Uninstalling lite-virtual leaves non-virtualized charts working.

## Gate

Standard: `npm test`, torture `ok`, ASCII-only, tree-shake + optional-peer
isolation verified.
```
