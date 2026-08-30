# Brief -- horizontal-bar brush

Status: DESIGN BRIEF, grounded. Local scratch, not shipped. The one cut
deliberately DEFERRED from v1.8.0 (horizontal-bar interactions). Run the planner
to lock the payload shape and the band-hit-test before coding. Line numbers below
are v1.8.0-era and WILL have shifted -- the planner re-grounds them (this is a
standing hazard: the annotation layer moved everything ~340 lines in v1.7.0).

## Goal

`createBarChart({ orientation: 'horizontal', brush: true })` selects a
value-range x band-set rectangle and emits it through `chart.brush`, instead of
throwing at construction. Finishes the horizontal interaction story: v1.8.0
shipped pan/zoom/value-grid on horizontal bars but left brush fail-closed.

## Current fail-closed state (what we are lifting)

Charts.js ~4510, in the horizontal config guard block that runs BEFORE any signal
alloc:

    if (config.brush) {
        throw new Error('lite-charts: horizontal orientation with brush ' +
            'is not supported (planned)');
    }

The sibling throw for a horizontal + log-value axis in the same block STAYS
(out of scope; a log value axis under brush is a separate closed cut). Only the
brush arm is being replaced with a real path.

## What already exists (reuse, do NOT rebuild)

Vertical brush (v1.4.0-alpha.3) is the template. Its machinery, all live:

- **Pure helpers** (~2597-2628, exported via `_testHelpers`):
  - `_normalizeBrushRect(px0,py0,px1,py1)` -> `{pxMin,pxMax,pyMin,pyMax}`
    (orientation-agnostic; pure pixel min/max -- reuse as-is).
  - `_brushPxToData(rect, xScale, yScale)` -> `{xMin,xMax,yMin,yMax}` via
    `xScale.invert`/`yScale.invert`, with the y-pixel flip baked in. This is the
    piece that assumes standard axis roles -- horizontal needs a swap-aware
    variant (see Design decisions).
  - `_computeBrushIds(xs,ys,n,xMin,xMax,yMin,yMax)` scans a continuous
    point cloud. Bars are NOT a point cloud -- they are (band index, value)
    pairs -- so this helper does not apply directly (see Design decisions).
- **Facade** `brushFacade` (~4795): `brush()` reads, `.peek`, `.set(v)`,
  `.clear()`; validates the object shape; `setBrush`/`clearBrush` aliases.
  Backed by `brushSig = _own(signal(null))`.
- **Overlay** `drawBrushOverlay` (~5318): a `pathNode` that reads
  `brushFacade.peek()` untracked and strokes/fills the PIXEL rect. It works off
  pixel bounds, not data bounds -- so if the gesture keeps a pixel rect it is
  orientation-agnostic and likely reused unchanged. Dirty bridge at ~5348
  (`brushSig()` -> markDirty). Confirm the overlay reads pixels, not
  `xScale.map(b.xMin)`, before assuming zero change.
- **Gesture** (~5555-5641): `shift+drag` routes to brush (bare drag = pan). The
  pan handler already yields on `brushEnabled && ev.shiftKey` (~5405) -- that gate
  is orientation-agnostic. `onBrushDown/Move/Up`, `_commitBrush`, click-to-clear
  threshold 3px, pointer-capture cleanup, disposer registration -- all reusable
  scaffolding; only `_commitBrush`'s data-mapping + id computation change.
- **Band scale** (`makeBandScale`, ~319-347): `invert(px)` is the band-hit-test
  primitive -- floor-division pixel -> band index, clamped to [0, n-1],
  fail-closed (`n===0` -> -1, `step<=0` -> 0). Under horizontal orientation
  `xBandScale` is bound to the Y pixel range and `yScale` (value) to X
  (`makeHBarDrawFn`, ~1419). So: screen-Y -> band index via `xBandScale.invert`;
  screen-X -> value via `yScale.invert`.

## Design decisions (planner to LOCK)

1. **Payload shape.** The vertical shape is `{xMin,xMax,yMin,yMax,ids}`. A
   horizontal bar selection is a VALUE range x a BAND set -- reusing xMin/xMax as
   band-pixel bounds would be a silent semantic reinterpretation (a documented
   trap). Favored: a distinct, self-describing shape, e.g.
   `{ valueMin, valueMax, bands, ids }` where `bands` is the selected category
   keys (or indices). Planner picks exact field names and whether `bands` holds
   keys, indices, or both. Decide how `brushFacade.set` validation branches by
   orientation (it currently hard-asserts the `{xMin,xMax,yMin,yMax}` shape).
2. **What is an `id`?** A vertical brush returns primary-series point indices.
   A bar is addressed by (seriesIdx, bandIdx); grouped/stacked means one
   value x band cell can contain multiple series' bars. Options: flat bar indices
   over series 0; `{series, band}` pairs; or band indices only (defer per-series).
   Planner cut -- keep it the minimal useful hook, matching the vertical
   "primary series, caller filters" precedent.
3. **Value-range x band-set hit test.** From the pixel rect: value bounds =
   `yScale.invert` at pxMin/pxMax (value axis on X under swap); band set = every
   band index whose row overlaps [pyMin, pyMax], derived from `xBandScale`
   (invert at both ends, then the inclusive index span between). A new
   swap-aware mapping helper, OR a `swapAxes ?` branch in `_commitBrush`, mirroring
   the v1.8.0 gesture-boundary remap architecture (keep `_brushPxToData`
   byte-identical if a branch at the call site is cleaner -- that parity was the
   whole v1.8.0 thesis).
4. **Overlay.** Confirm `drawBrushOverlay` is pixel-based and needs no change.
   If it re-derives pixels from data bounds via `xScale.map`, it needs a
   swap-aware branch too.
5. **Fail-closed boundaries that STAY.** horizontal + log value axis still
   throws. A non-finite value bound draws/emits nothing (`Number.isFinite`, never
   `Number(null)===0`). Empty band set (drag entirely in outer padding) -> a
   clear (null), matching click-to-clear semantics.

## Scope

IN: value-range x band-set brush on horizontal bars, emitted through the existing
`chart.brush` facade + overlay; the deferred v1.8.0 throw replaced. OUT (stay
closed / unchanged): horizontal + log-value brush; VERTICAL bar brush semantics
(untouched -- regression guard required); polar/radar/heatmap brush.

## Assertions (sketch -- qa to make falsifiable after planner)

- A shift+drag on a horizontal bar chart emits a selection whose value bounds
  equal `yScale.invert` of the drag's X extent (to 1e-6) and whose band set is
  exactly the categories whose rows the drag's Y extent covers.
- A drag covering the full plot selects ALL bands and the full value domain.
- A sub-threshold shift-click clears the brush (emits null).
- Vertical bar (and line/scatter) brush output is BYTE-unchanged -- the swap
  branch is inert off the horizontal path (proven by measured reversion +
  an unchanged vertical-brush test).
- horizontal + log-value axis still throws at construction.
- Mount -> brush -> destroy leaves zero retained scene nodes (retention gate).

## Gate

Standard: `npm test` + `node --expose-gc test/torture.mjs` -> `ok`, ASCII-only,
0 B/frame draw path (brush commit is sub-Hz, allocation there is in the noise band
per the existing `_computeBrushIds` precedent -- but the overlay draw stays 0 B),
fail-closed on every unverified bound. Reviewer REJECTED goes back to coder.
