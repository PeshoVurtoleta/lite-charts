# Brief: demo refresh -- v1.6.0 -> v1.12.0

One session. Not shipped (demo/ is absent from package.json `files[]`), so no
/release, no version bump, no npm gate change. Charts.js, Charts.d.ts, and
test/ are UNTOUCHED -- if a demo need exposes a library bug, that is a
separate brief, not a drive-by fix.

## Current state (audited 2026-09-02)

`demo/index.html` (3172 lines) is pinned at **v1.6.0**: title, brand-version
badge, and the RELEASE eyebrow all say v1.6.0. Sections end at "X-axis log
scale -- v1.6.0" + pan/zoom + brush + SVG export. Six shipped releases have
no demo coverage:

| Missing | Feature |
| --- | --- |
| v1.7.0 | annotations (line/range/point/text, data-pinned, theme-aware) |
| v1.8.0 | horizontal-bar pan/zoom + value grid |
| v1.9.0 | horizontal-bar brush (value-range x band-set payload) |
| v1.10.0 | createTimeLineChart + weekend shading |
| v1.11.0 | market-hours session shading (sessions/sessionFill) |
| v1.12.0 | legend virtualization (caller-injected adapter) |

Known anchors in the current file:
- index.html:101 -- a CSS comment literally says "a 100+ series legend that
  hasn't been virtualized yet". That legend-overflow guard is the natural
  place to point at the new virtualization section.
- index.html:935 -- the horizontal-bar card still says pan/zoom/brush are
  fail-closed/deferred ("the v1.5.0 cut is a static ranking"). Now false;
  rewrite the copy AND wire the interactions.
- importmap (index.html:799-805): lite-signal@1.1.5, lite-scene@1.0.0,
  lite-axis@1.0.1 from jsdelivr; lite-charts from ../Charts.js.
- One module script imports 9 factories (index.html:1633-1643); registry
  bumped to 32k nodes -- re-check headroom after adding ~6 charts (each
  chart ~45-60 nodes; 32k is still plenty, but say so in a comment).

## Tasks, in order

1. **Branding pass.** title/badge/eyebrow -> v1.12.0. Keep the page ASCII-only
   (`->`, `x`, "degrees"; grep before done).
2. **Importmap.** Add `"@zakkster/lite-virtual"` (jsdelivr, ^1.1.0 -- confirm
   the published main filename from its package.json before pinning) and
   optionally `"@zakkster/lite-delaunay"` if the bubble spatial-index card is
   upgraded to actually inject it. Verify existing pins still satisfy
   package.json peerDependencies (signal ^1.1.0 -- 1.1.5 pin is fine).
3. **Annotations section (v1.7.0).** Line chart with a threshold rule
   (type:'line', axis:'y'), a shaded range, and a labeled point; a button
   toggling the annotation accessor to show reactivity; note off-scale
   clipping under pan.
4. **Horizontal-bar interactions (v1.8.0 + v1.9.0).** Upgrade the existing
   v1.5.0 horizontal card: pan:true, zoom:true, brush:true. Show the DISTINCT
   brush payload `{valueMin, valueMax, bandMin, bandMax, bands, ids}` in a
   status line (mirror the existing vertical brush-status pattern at
   index.html:1453-1455). Rewrite the stale fail-closed copy.
5. **Time-series section (v1.10.0 + v1.11.0).** Import createTimeLineChart
   (NOT currently imported). Two charts sharing one generated multi-week
   epoch-ms dataset: (a) default weekend shading; (b) market-hours
   `sessions: [{openMinutes: 810, closeMinutes: 1200}]` (13:30-20:00 UTC =
   NYSE 09:30-16:00 ET) showing the Fri-close -> Mon-open single contiguous
   band. Copy states the UTC-only contract.
6. **Legend virtualization section (v1.12.0).** 200-series line chart,
   `legend: { position: 'right', virtualize: mountListAdapter, height: 320 }`
   using the README "Virtualizing a tall legend" adapter (README:481)
   verbatim against real lite-virtual from the importmap -- this doubles as a
   live integration test of the adapter snippet. Status line showing live DOM
   row count (querySelectorAll length) vs series count to make O(window)
   visible. Update the index.html:101 comment to point here.
7. **Sweep.** Theme toggle exercises every new chart (refreshTheme); registry
   headroom comment updated; kill any other stale version copy
   (`grep -n "v1\.[0-9]" demo/index.html` and read every hit).

## Gate (demo-specific; the library gate is untouched)

- `node demo/serve.js` -> page loads with ZERO console errors/warnings in
  both themes (verify via browser preview, not by eye-balling code).
- Every interactive claim in the copy is exercised once: legend clicks, pan,
  zoom, both brushes, annotation toggle, virtual legend scroll + click on a
  recycled row, SVG export button.
- `npm test` still 444/444 (proves Charts.js untouched).
- ASCII grep on demo/index.html; grep for stray tool-call tags.

## Out of scope

- Any Charts.js/d.ts/test change (separate brief if a bug surfaces).
- Demo bundling/minification; serve.js changes (it already serves the root).
- lite-charts-gl teasers.
