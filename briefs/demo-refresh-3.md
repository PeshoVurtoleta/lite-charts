# Brief: demo refresh -- session 3 -- v1.23.0 showcase + token repair

**Demo-only. Not shipped** (demo/ is absent from package.json `files[]`): no
/release, no version bump, no npm gate change. Charts.js, Charts.d.ts, and
test/ are UNTOUCHED -- a library bug found here is a separate brief, not a
drive-by fix.

## Current state (audited 2026-09-21)

`demo/index.html` (4394 lines) is branded **v1.21.0** (title :6,
brand-version :855, RELEASE eyebrow :871) and imports lite-charts from
`../Charts.js` -- so the page ALREADY RUNS v1.23.0 code. Two releases are
invisible to it:

- **v1.22.0** heatmap refreshTheme: the theme toggle exercises it already
  (the guarded ALL_CHARTS loop; the heatmaps recolor since 1.22.0). Only
  copy is missing.
- **v1.23.0** axis titles + tick-format: NO panel uses `xTitle`/`yTitle`/
  `xTickFormat`/`yTickFormat`. And the theme toggle now GENUINELY recolors
  every axis chart's spine/ticks/labels/gridlines -- before 1.23.0 they
  silently stayed in mount-time colors (nobody ever noticed in this very
  demo, which is the story worth telling in copy).
- **Broken tokens, wider than thought**: `--c-emerald` / `--c-rose` are NOT
  defined in :root, but are used at :2608, :2648, :2650, :2928, :3336,
  :3383 (charts render fallback grey/black) -- and the COPY at :1425/:3377
  documents `'--c-emerald'` as a working example. Fix by DEFINING the two
  tokens (light + dark values), not by swapping usages.

## Tasks

### T1 -- token repair (do first; recolors six existing charts)
Add to the :root token block (grep `--c-primary` to find it) and its dark
override: `--c-emerald` (#10b981 light / #34d399 dark) and `--c-rose`
(#f43f5e light / #fb7185 dark). Verify every consumer chart now renders
color (brush source/follower, donut, scatter tone, stacked Q2, cells
palette) and both themes resolve.

### T2 -- branding
title :6, brand-version :855, RELEASE eyebrow :871 -> **v1.23.0**.

### T3 -- axis titles + tick-format showcase (the headline)
Touch TWO existing panels, no new panel:
- **Error-bars panel** (:3230+, the v1.21.0 line chart): add
  `yTitle: 'Latency (ms)'` + `yTickFormat: (v) => v + ' ms'`, and
  `xTitle: 'Build #'`. Copy: titles bump the DEFAULT margin only (this
  panel sets no margin -- say so); callbacks run on the cold axis rebuild,
  never per frame.
- **One time-series panel** (tsWeekendChart :3985 or tsSessionsChart
  :4006): add `xTickFormat` formatting raw epoch ms into short UTC dates
  (`(ms) => new Date(ms).toISOString().slice(5, 10)` idiom -- demo-side
  Date use is fine, the LIBRARY stays Intl-free). Copy: the callback
  receives RAW epoch ms; the demo owns the locale.
- Eyebrow/copy for both: `// axis titles + tick-format -- v1.23.0`.

### T4 -- theme-fix + v1.22.0 copy
One short copy block near the theme toggle (grep `refreshTheme` in the
demo): as of v1.23.0 the axis chrome (spine/ticks/labels/gridlines/titles)
genuinely recolors on toggle -- earlier versions repainted stale mount
colors; heatmaps recolor since v1.22.0. Keep the `typeof c.refreshTheme`
guard (the relief shim rides the same loop).

### T5 -- sweep
Any remaining "v1.21.0" copy that means "current" (NOT
version-of-introduction labels like the error-bars eyebrow); ASCII grep;
stray tool-call tag grep.

## Gate
- `node demo/serve.js` (launch.json name "demo") -> fresh tab, ZERO console
  errors/warnings in BOTH themes.
- Exercise once: y-title visible + margin intact on the error-bars panel
  (band toggle still works -- it destroy+recreates, titles must survive),
  formatted date ticks on the time-series panel, theme toggle recolors axis
  chrome + the six token-repaired charts.
- `npm test` count unchanged (proves Charts.js untouched).

## AS-EXECUTED (2026-09-21) -- all five tasks landed, verified live

demo/index.html only (+39/-9); 572/572 unchanged (Charts.js untouched). All
verified in the browser preview, both themes, ZERO console output at every
step:

- T1: `--c-emerald` #34d399/#059669 + `--c-rose` #f43f5e/#be123c added to
  both token blocks. Verified live on the pie/donut ('Direct' emerald,
  'Referral' rose -- previously fallback grey).
- T2: three branding anchors -> v1.23.0.
- T3: error-bars factory gained `xTitle: 'Build #'`, `yTitle: 'Latency
  (ms)'`, `yTickFormat` ms units (in the FACTORY, so the band-mode
  destroy+rebuild keeps them -- verified: ribbon-only rebuild retains
  titles + units); tsWeekendChart gained the epoch-ms -> MM-DD
  `xTickFormat` (verified: 09-03/09-10/09-17 vs the neighbor's built-in
  format); panel copy + caption added.
- T4: theme comments updated (axis chrome genuinely recolors as of
  v1.23.0; the :2166 guard comment was STALE -- heatmaps expose
  refreshTheme since v1.22.0 -- reworded to "kept for safety"). Verified
  live: light-theme flip re-resolves tick labels, both titles, and
  gridlines to dark-on-light (the Cut 0 fix visibly working), flip back
  clean.
- T5: remaining v1.21.0 hits are version-of-introduction labels (error-bars
  eyebrow/comments) -- kept; ASCII + stray-tag greps clean.

Observation, NOT fixed (out of scope): tsWeekendChart passes
`spineColor: '--surface-line'` -- `spineColor` is not a lite-charts config
key and `--surface-line` is not a defined token; the line is a silent
no-op. Cosmetic dead config, candidate for a future demo sweep.

## Out of scope
- Any Charts.js/d.ts/test change. New panels. Relief panel changes.
- Library successor (separate session): queue item 4 chart chrome
  (title/subtitle/caption) -- needs brief #21 before its cut. Note:
  `xTitle`/`yTitle` shipped in v1.23.0 raise the bar -- #21 is CHART-level
  chrome in the reactive margin system, a different surface.
