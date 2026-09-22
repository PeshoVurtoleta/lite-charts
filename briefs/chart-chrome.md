# Brief #21: chart chrome -- title / subtitle / caption -- v1.24.0 candidate

Queue item 4 (user-confirmed order). Chart-LEVEL chrome on the axis kernel:
`title` (headline above the plot), `subtitle` (under it), `caption` (small
attribution line at the bottom). Rides the v1.23.0 axis-title machinery
(conditional default-margin bumps, axisThemeVersion recolor, pooled scene
text nodes) -- this is the same idiom one level up, NOT a new system.

## Grounding (audited 2026-09-22, v1.23.0, Charts.js ~12430 lines)

- `title`/`subtitle`/`caption` are FREE config keys (zero occurrences in
  Charts.js and Charts.d.ts).
- Const block: DEFAULT_MARGIN :2322, TITLE_MARGIN 18 / TITLE_PAD 4
  :2326-2327, DEFAULT_FONT '11px sans-serif' :2331.
- Margin resolution :6878-6884 (per-side `m && m.side != null` against a
  null fallback -- the v1.23.0 shape; top takes no bump yet).
- v1.23.0 doors end just before the margin block; chrome doors join them
  (hoisted above the first `_own(signal())`, the v1.15.0 discipline).
- Title nodes block in mount :7779-7800 (xTitle y accessor at :7787 uses
  `marginBottom - TITLE_PAD` -- the caption changes that offset, see
  layout); axisThemeVersion + plotBoundsSignal accessor idiom therein.
- Fonts: derive from config.font by regex (the :3845 _parseFont idiom):
  title = bold, size+4; subtitle = size+1; caption = size-1. No px match
  -> fall back to the base font unchanged (cosmetic, fail-safe).

## Config + layout (decisions)

- `title?: string`, `subtitle?: string`, `caption?: string` -- non-empty
  strings or absent; `''`/non-strings THROW at construction pre-signal.
  **subtitle without title THROWS** (subordinate by definition; relaxing
  later is non-breaking, the reverse is not). Axis-kernel charts only;
  other kernels ignore unknown keys exactly as they ignore xTitle (named
  refusal, per-kernel chrome is a future cut with its own trigger).
- Top stack, centered on the CANVAS (not the plot):
  title baseline 'top' at y = TITLE_PAD, then subtitle below at
  y = TITLE_PAD + CHROME_TITLE_LINE. x = (marginLeft + pb.w + marginRight)/2.
- Bottom: caption right-aligned at the PLOT right edge (attribution
  convention), baseline 'bottom', y = bottom edge - TITLE_PAD -- the
  bottom-most line. When a caption exists, the v1.23.0 xTitle moves UP by
  CAPTION_MARGIN (precomputed construction const, one-line change to the
  :7787 accessor).
- Margin defaults (explicit per-side margin stays ABSOLUTE, no stacking):
  top: 16 + (title ? CHROME_TITLE_MARGIN 24 : 0) + (subtitle ?
  CHROME_SUB_MARGIN 16 : 0); bottom: 32 + (xTitle ? TITLE_MARGIN 18 : 0)
  + (caption ? CAPTION_MARGIN 14 : 0).
- Colors: all three ride `(axisThemeVersion(), axisStyleRefs.labelColor
  .value)` -- hierarchy comes from size/weight, not color (per-element
  color/font objects are OUT with a named trigger).
- SVG export: free (axis-aligned text). destroy: scene teardown owns the
  nodes (v1.23.0 precedent).

## Gate

- ~10-12 boundary tests (render, top/bottom stacking offsets, margin bumps
  independent + stacked + absolute-override both ways, subtitle-sans-title
  throw, junk throws zero-node, theme recolor incl. chrome, exportSVG
  contains all three, xTitle shift when caption present, destroy clean);
  3 reversion proofs; torture A29 (chrome redraw parity <= 2 B/op vs a
  chrome-less control + theme-storm reuse; two-pass warming per the A28
  lesson). qa = lead; agents write zero tests.
- No version bump until /release 1.24.0. DEMO showcase lands in the same
  session AFTER the library gate (demo-only edit, brand -> v1.24.0).

## AS-EXECUTED (2026-09-22) -- all cuts landed first pass, 583/583 + torture A29 + 3 reversion proofs, reviewer APPROVED

Pipeline: lead grounded + planned, coder landed all seven tasks in ONE round
with zero deviations, reviewer APPROVED 6/6 judgment calls zero blockers
(confirmed the shared chromeCenterX double-binding sound, all 8 margin
combos byte-identical to v1.23.0, doors pre-signal, top/bottom stack
arithmetic collision-free), qa = lead. Tests AXC1-AXC11 (572 -> 583):
derived fonts (bold 15px title from the 11px base), stacking, margin bumps
independent/stacked/absolute both sides, subtitle-sans-title throw, junk
throws zero-node, theme recolor, SVG all three, caption-pushes-xTitle (and
the no-caption xTitle offset pinned byte-identical to v1.23.0 at
height - 4), no-px-font fail-safe fallback, destroy clean. Reversion
proofs: neutered chrome block -> render/SVG tests red; removed top bump ->
exactly AXC4 red; fixed _xTitleOffset -> exactly AXC9 red. Torture A29
(chrome redraw parity within 2 B/op of a chrome-less control; two-pass
theme storm <= 8 B/op steady, zero graph growth) green; BREAK control
fails as required.

DEMO (same session, per user instruction): candlestick panel wears full
chrome (title 'ACME (synthetic) -- daily', subtitle, bottom-right caption),
branding -> v1.24.0 (3 anchors), copy paragraph added; verified live both
themes (caption recolor observed light-side; title/subtitle share the same
fill binding + AXC7 pins it), ZERO console output. Release pending:
`/release 1.24.0` -> user publishes -> `/sync-card`.

## Out of scope

Chrome on pie/donut/radar/heatmap (per-kernel margin blocks; future cut).
Per-element {text,color,font} objects. Legend interaction with the top
stack. Secondary y-axis. Rich text / wrapping (single-line strings; a long
title clips -- documented).
