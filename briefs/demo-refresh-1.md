# Brief: demo refresh -- session 1 of 2 -- foundation + 3D relief + candlestick + error bars

**Demo-only. Not shipped** (demo/ is absent from package.json `files[]`): no
/release, no version bump, no npm gate change. Charts.js, Charts.d.ts, and test/
are UNTOUCHED -- if a demo need exposes a library bug, that is a separate brief,
not a drive-by fix.

Session **1 of 2**. This session lays the shared foundation (branding +
importmap) and adds the three marquee panels: the **3D relief map** (the
headline), candlestick, and error bars. Session 2 (`demo-refresh-2.md`) adds the
older-cut catch-up panels (cluster outlines, brush v2, overnight/holidays +
early close, horizontal legend). The two are independent after this session's T0
foundation lands; each owns its own importmap delta.

## Current state (audited 2026-09-17)

`demo/index.html` (3781 lines) is BRANDED v1.19.0 (title:6, brand-version:851,
RELEASE eyebrow:867) but the branding is aspirational -- **candlestick was never
actually added**: the factory import block (index.html:1875-1886) lists only the
nine older factories; `createCandlestickChart` is absent and there is no candle
panel. Present panels include line, bar, horizontal bar (interactive), stacked,
donut center label, bubble + spatial index, scatter, Voronoi cells (v1.14.0),
field raster + contours (v1.16.0/v1.17.0), heatmap x2, log x2, pan/zoom, brush,
annotations (v1.7.0), time-series + weekend/session shading (v1.10/v1.11), legend
virtualization (v1.12.0, position:'right').

Anchors this session uses:
- factory import block: index.html:1875-1886 (add `createCandlestickChart`).
- importmap: index.html:830-838 -- lite-signal@1.1.5, lite-scene@1.0.0,
  lite-axis@1.0.1, lite-virtual@1.1.0, lite-delaunay@1.3.0, lite-charts from
  ../Charts.js. (delaunay stays 1.3.0 this session -- the field index the relief
  reuses is 1.3.0; the 1.4.0 bump belongs to session 2's cluster outlines.)
- field-raster panel (index.html:2738+) already calls delaunay's
  `createFieldIndex` and samples a grid -- the relief panel REUSES that grid and
  that import.
- ASCII-only page (`->`, `x`, "degrees"; U+00D7/U+00B5 excepted). Grep before done.

## Tasks

### T0 -- foundation (do first)
- **Branding**: title / brand-version / RELEASE eyebrow -> **v1.21.0**. (v1.21.0
  is the headline version this session's error-bars panel demonstrates; the
  older-cut panels session 2 adds were already implied by the prior v1.19.0
  branding, so branding forward now is correct.)
- **Importmap**: add `@zakkster/lite-depth` -> **2.0.0** (confirm the published
  main filename from its package.json -- `Depth.js` -- before pinning the
  jsdelivr URL). Do NOT touch delaunay (session 2 owns that). Verify every
  existing pin still satisfies package.json peerDependencies.
- **Imports**: add `createCandlestickChart` to the factory block (1875-1886);
  add the lite-depth imports (`createStage`, `geometry`, `material` /
  `materialFromRamp`) at the consumer, mirroring how `mountList` /
  `createFieldIndex` are imported (injection at the consumer, not the library).
- **Registry headroom**: this session adds ~3 panels (~45-60 nodes each, plus
  the relief stage's own node arena which is SEPARATE from the chart registry).
  Re-check and update the headroom comment.

### T1 -- 3D relief map (the headline; composition, not a charts feature)
A new panel reading the field-raster grid as a HEIGHTFIELD and projecting it in
pseudo-3D via lite-depth. Charts computes, lite-depth renders; composed on
published seams, zero Charts.js change.

- **Data**: reuse the field panel's scattered dataset + its scalar `z`. Get the
  grid the same way the field panel does: `createFieldIndex(N)` from delaunay,
  then `sampleField(zs, gridW, gridH, bx0, by0, bx1, by1, outGrid)` into a
  `Float64Array(gridW*gridH)`. Default grid **32 x 24** (~1.4k faces) -- lite-depth
  is a Canvas2D software rasterizer; 64 x 48 (~5.9k tris) is its comfort ceiling.
  Note the trade-off in copy. NaN cells (outside the hull) are HOLES.
- **Stage**: `createStage(ctx, { width, height, dpr })` on a dedicated canvas.
  **DPR is the emphasis and it is a clean pass-through**: pass the SAME dpr the
  charts use (`config.dpr ?? devicePixelRatio`); lite-depth owns the
  backing-buffer scale internally exactly as charts do. A crisp high-DPR relief
  is one shared number, no new coordination code. State this in the copy.
- **Mesh (banded relief -- the honest ramp mapping)**: lite-depth flat-shades
  each face by normal-dot-light with ONE material per node, so height CANNOT be a
  per-vertex color on a single mesh. Quantize height into K bands (K ~ 6; reuse
  the field panel's contour `levels` for thematic continuity -- the relief is the
  contour idea in 3D) and build ONE sub-mesh per band, each a node with
  `materialFromRamp(sameRamp)` colored at that band's value. Cells outside a band
  (or NaN) are holes in that band's mesh. Result: a stepped ramp-colored relief
  whose form reads from 3D projection + shading and whose color reads from the
  SAME ramp the 2D raster uses.
  - Build each band mesh with `geometry.custom(verts, faces)` -- a ~20-line
    inline heightfield->quads builder (x from column, z from row, y from height;
    one quad `[a, a+1, a+cols+1, a+cols]` per cell; skip any quad with a
    NaN/out-of-band corner). This runs against published lite-depth@2.0.0.
  - **Parallel dependency**: a companion brief `../LiteDepth/briefs/heightfield.md`
    proposes `geometry.heightfield(z, cols, rows, opts)`. It is being executed in
    a separate lite-depth session. IF it has shipped + published by the time this
    runs, replace the inline builder with `geometry.heightfield` and bump the
    lite-depth pin. If not, the inline builder ships -- **this session is NOT
    blocked on it.**
- **Camera / light**: an isometric-ish camera (`updateCamera` after mutating);
  a directional `stage.light` so the relief self-shades. Optional:
  `setShadowMaterial` + `setCastShadow` for a ground shadow under the terrain on
  the y=0 plane the heightfield sits on.
- **Animate**: run `stage.frame(dt)` under the demo's existing rAF; a slider or
  drag to orbit the camera. Keep the frame callback **0 B/frame** (lite-depth's
  own guarantee -- do not allocate in it).
- **Hover (optional, nice)**: `stage.attachPointer` + `stage.nearest` /
  `stage.pick` (needs `dirtyRect=true` or a bound index) to read which band/cell
  is under the cursor for a z-value readout.
- **Theme**: on theme toggle, rebuild the band materials from the re-resolved
  ramp (the stage does not re-resolve CSS vars itself).
- **Copy**: frame it as suite composition -- "the same field a 2D raster ramps
  and contours structure, now extruded as relief." Name the shape decision: a 3D
  view has no invertible 2D scale, so pan/zoom/crosshair/annotations do NOT
  transfer; this is a projection of the field, not an interactive chart.

### T2 -- candlestick (v1.19.0)
- `createCandlestickChart({ data: [{ts,o,h,l,c}, ...], up?, down?, wick?,
  bodyRatio?, shading? })`. Generate a synthetic multi-week OHLC stream on
  epoch-ms timestamps; enable `shading` (weekends via the shared engine) so the
  panel doubles as a session-shading showcase for candles. Tooltip shows O/H/L/C
  rows. Copy: candles sit at TRUE time (gaps show as gaps); a single OHLC stream
  per chart (a series array throws).

### T3 -- error bars / confidence bands (v1.21.0)
- One line (or area) chart with `errorBars: { lo, hi, band: 'both' }` (whiskers +
  ribbon) and a second series using symmetric `{ value }`. A button toggling
  `band` false / true / 'both' to show the three modes. Copy: per-point
  uncertainty, 0 B/frame overlay on the annotation split, fail-closed null/NaN
  self-skip (never anchors at 0).

## Gate (this session; the library gate is untouched)
- `node demo/serve.js` -> page loads with ZERO console errors/warnings in BOTH
  themes (verify in the browser preview, not by eyeballing code).
- Each new interactive claim is exercised once: relief camera orbit + (if wired)
  hover readout, candle tooltip, error-bar band toggle, SVG export on any chart
  that has it, theme toggle across the new panels.
- The relief panel frames at 0 B/frame (do not allocate in the frame callback;
  verify with a short heap-settle check if in doubt).
- `npm test` still passes at its current count (proves Charts.js untouched).
- ASCII grep on demo/index.html; grep for stray tool-call tags.

## Out of scope
- The session-2 panels: cluster outlines (v1.18.0), brush v2 (v1.20.0),
  overnight/holidays + early close (v1.13.0/v1.15.0), horizontal legend
  (v1.15.0). See `demo-refresh-2.md`.
- Any Charts.js/d.ts/test change. If productizing the relief later wants a
  documented read-only field-grid accessor (`{ grid, gridW, gridH, vMin, vMax }`,
  today internal), that is a SEPARATE charts brief -- the demo recomputes the
  grid via delaunay directly, so it needs nothing from Charts.js.
- Demo bundling/minification; serve.js changes.
- A packaged charts<->depth adapter (lite-charts-depth / a lite-headless
  recipe) -- the named trigger is a consumer wanting the relief outside a demo.
