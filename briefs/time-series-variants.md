# Brief -- time-series specialized variants

Status: DESIGN BRIEF. Local scratch, not shipped. Design-horizon, not
shovel-ready -- run the planner to firm up scope before coding.

## Goal

`createTimeLineChart` (and siblings) as thin presets over the axis kernel,
giving finance/ops dashboards batteries-included time handling instead of
hand-configured `xScale:{type:'time'}` + manual tick/format wiring.

## What already exists (reuse, don't rebuild)

- Time x-scale is shipped: `xScaleType: 'time'`, `timeTicks` + `thinLabels`
  in the X axis effect. A time-series variant is a CONFIG PRESET + a few new
  overlays, not a new kernel.
- The renderer-object pattern (LINE_RENDERER etc.) is how a variant plugs in:
  a new factory that composes the line renderer with time-aware defaults.

## Candidate feature set (planner to cut)

1. **Built-in date tick generation** -- smart tier selection (year/quarter/
   month/day/hour) from the visible span; already partly in `timeTicks`, so
   this is mostly sensible presets + label formats.
2. **Weekday/weekend shading** -- background bands behind weekend spans.
   Overlaps heavily with the **annotation-layer** brief (a weekend band IS a
   pinned data-coordinate range). Strong reason to build the annotation layer
   FIRST and express weekend/market-hours shading on top of it, rather than
   bespoke code here.
3. **Market-hours awareness** -- shade/skip non-trading hours; optional
   session boundaries. Finance-specific; keep it opt-in and data-driven
   (caller supplies session calendar; the chart doesn't hardcode exchanges).

## Dependency ordering

Build **annotation-layer** first. Weekend shading and market-hours bands are
its most natural first consumers; doing time-series first would duplicate the
pinned-range machinery. Note this in the roadmap sequencing.

## Open questions

- Timezone handling: chart stays TZ-agnostic (operates on epoch ms; caller
  formats)? Almost certainly yes -- no `Intl`/TZ database in a zero-dep micro-lib.
- Is this a new factory per variant, or one `createTimeLineChart` with a
  `session`/`shading` config? Prefer the latter (fewer bundles, same kernel).
- Bundle-isolation: the shading/session code must tree-shake out of the plain
  line bundle (verify with esbuild, as every kernel split is verified).

## Assertions (sketch -- qa to make falsifiable after planner)

- Weekend shading renders bands only over Sat/Sun spans of the visible domain,
  reactive to pan/zoom (re-derived on scale change).
- Market-hours config with a supplied session calendar shades/clips correctly;
  with no calendar, no session behavior (opt-in, zero cost).
- Plain `createLineChart` bundle contains none of the shading/session symbols.

## Gate

Standard: `npm test`, `node --expose-gc test/torture.mjs` -> `ok`, ASCII-only,
0 B/frame draw path, esbuild tree-shake isolation verified.
```
