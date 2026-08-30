# Brief -- horizontal-bar interactions (pan / zoom / brush + value grid)

Status: PLAN ONLY. Local scratch, not shipped. Grounded against current
Charts.js. Bigger than the v1.6.1 floor -- treat as its own minor. Pipeline:
planner (deepen the axis-mapping table below) -> coder -> reviewer -> qa.

## What's blocked today

`createBarChart({ orientation: 'horizontal' })` fail-closes at construction on
the whole interaction set. The guards, all in one block at
**Charts.js:4143-4158**:

| Combination | Throw site | Message |
| --- | --- | --- |
| horizontal + `yScale:{type:'log'}` | 4144-4146 | "...log yScale is not supported" |
| horizontal + `pan`/`zoom`/`brush`   | 4148-4150 | "...pan/zoom/brush is not supported" |
| horizontal + value grid             | 4152-4156 | "...a grid is not supported" |

These were deliberate v1.5.0 fail-closed stubs ("planned for v1.5.x"). The
draw + scale machinery for swapped axes already exists (`swapAxes`); what's
missing is the interaction math under the swap.

## Why it's not trivial

Under `swapAxes` the roles flip:
- **Value axis = X** (continuous). Scale bound to the X pixel range at
  **Charts.js:4733-4738** (`updateLinearScale(yScale, yLo, yHi, plot.x,
  plot.x+plot.w)` -- note the *value* scale is `yScale` even though it draws
  on X).
- **Band axis = Y** (categorical). `makeBandScale`, one cell per category,
  category 0 at top.

But the pan/zoom gesture layer is written in the STANDARD frame. It operates
on a `view` object `{ xMin, xMax, yMin, yMax }` in DATA space and clamps
against `_dataDomain` (`_applyPan`/`_applyZoom`/`_clampToBounds` around
**Charts.js:5000-5095**), assuming X=first continuous axis, Y=second. Those
helpers, and `_dataDomain`'s axis assignment (written 4662-4667), do not know
about the swap.

Two viable shapes -- the planner must pick one and write it down before coding:

1. **Map at the gesture boundary.** Keep the view/helpers in the standard
   frame; translate pointer dx/dy and the `_dataDomain` axis assignment
   through the swap at the listener edge (pointer X drives the value axis,
   pointer Y snaps bands). Smallest change to the interaction core; the swap
   stays a bar-only concern.
2. **Make the helpers swap-aware.** Thread a `swapAxes` flag into
   `_applyPan`/`_applyZoom`/`_clampToBounds` like `xLog`/`yLog` already are.
   More uniform but touches the shared interaction path that line/area/scatter
   also use -- higher blast radius, more regression surface.

Recommendation: **(1)**. The value axis is the only continuously
pan/zoom-able one on a bar chart (panning a categorical band axis is
scroll-a-list, a different UX); constraining the gesture to the value axis and
mapping it in at the edge keeps the shared core untouched and matches how the
band axis already special-cases hit-test.

## Scope decision (planner to confirm)

- **In:** value-axis pan + zoom on horizontal bars; value grid under swap.
- **Probably in:** brush over the value range (returns value-range + category
  `ids`). Band-axis brushing = multi-select of categories; decide if that's
  this cut or deferred.
- **Out (keep failing closed):** horizontal + log value axis is a SEPARATE
  brief-worthy combo (log + swap pixel mapping); leave the 4144-4146 throw for
  now unless the planner folds it in.
- Confirm the same for **vertical** bars: today a band x-axis bar chart also
  isn't documented as pannable. If the edge-mapping generalizes, vertical
  band-axis value pan could come along; scope it explicitly rather than by
  accident.

## Tasks (coder)

1. Remove/relax the 4148-4150 pan/zoom/brush throw for the supported subset;
   keep throwing on the combos still out of scope (name them precisely).
2. At the gesture listener edge, route pointer axes through `swapAxes` so the
   value axis (X pixels) drives the value-domain view and the band axis (Y
   pixels) snaps to categories.
3. Fix `_dataDomain`'s value/band axis assignment under swap so
   `_clampToBounds` clamps the value axis, not a phantom Y.
4. Value grid under swap: relax the 4152-4156 throw; derive grid lines from
   the value scale on its swapped (X) pixel range.
5. Keep the vertical path byte-identical (parity gate, same discipline as the
   v1.5.0 draw-path swap).

## Assertions (qa -- falsifiable)

- A1: horizontal bar + `pan:true` -- a horizontal drag pans the VALUE axis;
  `chart.view.peek()` value bounds shift, category order unchanged.
- A2: horizontal bar + `zoom:true` -- wheel zooms the value axis around the
  cursor's value; band positions unaffected.
- A3: value grid renders on a horizontal bar (was a throw); lines are
  perpendicular to the value (X) axis.
- A4: still-unsupported combos (e.g. horizontal + log value axis, if deferred)
  still throw at construction, naming the combo, before any signal alloc.
- A5: VERTICAL bar pan/zoom/grid behavior is byte-identical to pre-change
  (parity), and the vertical draw path is unchanged.
- A6: brush on a horizontal bar (if in scope) returns a value-range selection
  with correct category `ids`; else brush still throws.

## Gate

`npm test` (add ~8-12 tests), `node --expose-gc test/torture.mjs` -> `ok`,
ASCII-only, zero new per-frame alloc (interaction listeners are gesture-rate,
but the draw path must stay 0 B).
```
