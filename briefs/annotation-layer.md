# Planner-LOCKED plan -- annotation layer (CODER-READY)

Status: PLANNER-LOCKED. Local scratch, not shipped. Grounded against current
Charts.js (v1.6.1) AND `node_modules/@zakkster/lite-scene/Scene.js` +
`test/torture/harness.mjs`. **Build before `time-series-variants.md`** --
weekend / market-hours shading is the first consumer of the `range` primitive.

Pipeline: coder -> reviewer -> qa. Reviewer REJECTED goes back to coder, not
forward. Gate: `npm test` + `node --expose-gc test/torture.mjs` -> `ok`. No gate
output is a FAIL. Target minor: **v1.7.0**.

The four design decisions are LOCKED below with line cites -- the coder does not
re-open them. Tasks are ordered for top-to-bottom implementation.

---

## Goal

Arbitrary lines, ranges, points, and text labels pinned to DATA coordinates on
the **axis kernel only** (line / area / bar / bubble / scatter). Reactive,
theme-aware, zero per-frame allocation, present in `exportSVG`, runtime-isolated
when unused. OUT of scope v1: polar/radar/heatmap; annotations + pan/zoom on a
horizontal bar (that combo is fail-closed at construction, 4143-4158).

## Data model

`annotations: Annotation[] | (() => Annotation[])` in axis-chart config.

```ts
type Annotation =
  | { type: 'line';  axis: 'x' | 'y'; value: number; color?: string; dash?: number[]; width?: number; label?: string }
  | { type: 'range'; axis: 'x' | 'y'; from: number; to: number; fill?: string; label?: string }
  | { type: 'point'; x: number; y: number; color?: string; radius?: number; label?: string }
  | { type: 'text';  x: number; y: number; text: string; color?: string; anchor?: 'start'|'middle'|'end' };
```

`axis` names the DATA axis; `swapAxes` (D4) selects screen orientation.
`color`/`fill` accept a literal or a `--css-var` token (`resolveColor` 59-69).

---

## Decisions (LOCKED, with line cites)

### D1 -- fill/marker SVG export: ALL required ops supported
Shim `_SVGRenderingContext2D` (Charts.js:2506). `save`/`restore` 2538/2554
(clip state incl. `_clipPathId` 2551/2568). `fillRect` 2778 -> emits `<rect>`
on the axis-aligned branch 2779-2788 (annotation CTM is identity/translate, so
the allocating rotated branch 2789-2800 never fires). `rect` 2631 + `fill` 2760
-> `<path fill=...>`. `arc` 2644, full-circle branch 2654-2661. `globalAlpha`
2529 -> `opacity` via `_commonAttrs` 2744. `setLineDash` 2873 ->
`stroke-dasharray` in `stroke()` 2756 and `strokeRect()` 2811 (**NOT** in
`fill()` 2760-2767 -- dash on a filled shape is silently dropped). `fillText`
2825/2827-2844. `clip` 2877-2882 -> `<clipPath>` in defs + `clip-path` on later
elements.

Locked construction:
- range fill = `ctx.fillStyle = resolved; ctx.fillRect(x, y, w, h)`.
- point marker = `ctx.beginPath(); ctx.arc(px, py, r, 0, _TWO_PI); ctx.fill()`
  reusing `_TWO_PI` (1925).
- dashed rule = `ctx.setLineDash(dashArr); moveTo/lineTo; ctx.stroke();
  ctx.setLineDash(_EMPTY_DASH)` (1924), mirroring `_strokeGuideV` 1931-1940.

**Mandatory caveat:** `clip()` 2878 does NOT clear `_pathChunks`. The
`makeLineDrawFn` idiom `save/beginPath/rect/clip` (888-891) leaves the clip rect
in the chunk buffer, so the annotation `_draw` MUST call `beginPath()` AGAIN
before the first marker `arc`, or the clip rect fills as a giant colored block
in the SVG only. Also `_textAnchor` 2856-2862 handles `'right'|'end'|'center'` --
`'middle'` falls through to `'start'` (2861); emit `'center'`, never `'middle'`.

### D2 -- color resolution: two-step split confirmed
`resolveColor` 59-69 calls `getComputedStyle` 62-64 (allocates, slow) -- stays
off the project step. Mount resolve block 4509-4523; `refreshTheme` 5583-5608
ends with `scene.markDirty()` 5607. Lock: `const annThemeVersion =
_own(signal(0))` beside `scaleVersion` (4190) / `plotBoundsSignal` (4194) via
`_own` (4075). Resolve step = `effect(() => { annThemeVersion();
const list = annotationsAcc(); ... })` -- a signal-valued `annotations` config
AND a theme bump both re-fire it. Re-trigger insertion: inside `refreshTheme`
after `tooltipBorderRef.value = ...` (5599), before the legend block (5601), as
`annThemeVersion.update((v) => (v + 1) | 0);` (5607 markDirty covers repaint).
The project step (`scaleVersion()` + `plotBoundsSignal()`) NEVER calls
`resolveColor` -- reads only the pre-resolved stable string array (polar pattern
6310 / 6399-6400, radar twin 7195 / 7264-7266).

### D3 -- dash NOT on `lineNode`; width IS
lite-scene `PROPS_OF.line = [...TRANSFORM_PROPS, "dx","dy","stroke",
"strokeWidth"]` (Scene.js:137) -- no `dash`; `makeNode` (Scene.js:102-126)
carries no dash field. `strokeWidth` honored by the live renderer
(Scene.js:314) and the SVG `'line'` case (Charts.js:2956). Decision: solid rules
of any width use the pooled `lineNode`; **any annotation with a non-empty
`dash` routes through `annFillPath`** with `setLineDash` (exports via 2756). At
project time, one branch sets `visible:false` on the pooled lineNode and pushes
the segment into the path buffer instead.

### D4 -- `axis` selects the scale; `swapAxes` selects the screen orientation
`swapAxes = renderer.axesSwapped ? renderer.axesSwapped(chartOpts) : false`
(4164); bar defines `(o)=>o.horizontal` (3266). Under swap the band `xScale` is
bound to the Y pixel range (4721-4722) and value `yScale` to X (4750);
unswapped `yScale` maps to Y (4752). So scale selection is unconditional --
`axis:'y' -> yScale.map(value)`, `axis:'x' -> xScale.map(value)` -- and only the
pixel interpretation flips: for an `axis:'y'` rule
`swapAxes ? screenX = p : screenY = p`, inverse for `axis:'x'`. Interactive
combos stay fail-closed at 4143-4158 (log-y 4144-4147, pan/zoom/brush 4148-4151,
grid 4152-4157); only the static horizontal bar case is wired.

---

## Tasks (final, ordered)

1. **Charts.js ~4269** (after crosshair/tooltip config 4261-4268) -- add
   `const annotationsAcc = config.annotations != null ? asAccessor(config.annotations) : null;`
   (`asAccessor` 43-44). Done: `config.annotations == null` leaves
   `annotationsAcc === null`, nothing else changes.
2. **Charts.js ~4195** (after `plotBoundsSignal` 4194) -- add
   `const annThemeVersion = annotationsAcc ? _own(signal(0)) : null;` (`_own`
   4075). Done: `_ownedSignals.length` unchanged for a no-annotation chart.
3. **Charts.js ~1904** (new top-level fn between `buildGrid` close 1903 and
   `DEFAULT_MARGIN` 1909) -- `buildAnnotations(parent, opts)` skeleton mirroring
   `buildAxis` 1655-1802: `const annGroup = parent.add(group({}))` (cf. 1668), a
   `lineNode` pool, a `textNode` pool, one
   `annFillPath = annGroup.add(pathNode({draw}))`, `return { annGroup, dispose }`
   (cf. 1801). Done: compiles, returns a disposer.
4. **buildAnnotations pool growth** -- `ensureLinePool(n)`/`ensureTextPool(n)` in
   the `while (pool.length < n)` doubling shape of 1688-1704 / 1826-1833,
   creating `lineNode({stroke, strokeWidth:1})` and
   `textNode({font, fill, align, baseline})`. Done: 2 -> 40 reuses all existing
   nodes.
5. **buildAnnotations typed buffers** -- `Float64Array` coord buffers + an
   `Int32Array` kind/flag buffer at construction, sized `ANN_BUF_SIZE = 64` in
   the `TICK_BUF_SIZE` style (1653, 1664-1666); grow-on-resolve only, NEVER in
   the project step. Done: project step touches no `new`.
6. **buildAnnotations resolve/structure step** -- `effect(() => {
   opts.themeVersion(); const list = opts.annotationsAcc(); ... })`: validate,
   size the pools, re-resolve colors in place into a stable array
   (`arr.length = n; for(...) arr[i] = resolveColor(...)`, exactly 6310 /
   6399-6400). Done: `getComputedStyle` called only here.
7. **buildAnnotations fail-closed validation** (inside task 6) -- skip any entry
   whose `type` is not one of the four, whose `value`/`from`/`to`/`x`/`y` is
   `null`/`undefined`/non-finite (`Number.isFinite`, NEVER truthiness), whose
   `text` is not a string, or whose `axis` is not `'x'|'y'`. Mark it dead in the
   flag buffer; never coerce `null` to `0`. Done: `{type:'line',axis:'y',
   value:null}` renders nothing and throws nothing.
8. **buildAnnotations project step** -- `effect(() => { opts.scaleVersion();
   opts.plotBoundsSignal(); ... })` (1706-1708 pattern), mapping via
   `opts.xScale.map`/`opts.yScale.map`, applying the D4 swap, the plot-rect
   bounds test (`plotBoundsBox` 4566-4569), writing pooled node underscore
   fields DIRECTLY (Risk 1), hiding unused entries (1896-1898), `opts.markDirty()`
   once at the end. Done: 0 B/op under `runOpsGate`.
9. **buildAnnotations `annFillPath._draw`** -- `ctx.save(); ctx.beginPath();
   ctx.rect(plotL,plotT,plotR-plotL,plotB-plotT); ctx.clip();` (888-891), then
   **`ctx.beginPath()` AGAIN** (D1 caveat), then range `fillRect`s, dashed rules
   via `setLineDash`/`stroke`/`setLineDash(_EMPTY_DASH)`, marker `arc`s,
   `ctx.restore()`. Done: D1 ops all appear in `exportSVG`.
10. **buildAnnotations labels** -- drive the `textNode` pool with `text`, `fill`,
    `align` mapped `start->'left'`, `middle->'center'`, `end->'right'` (NEVER
    `'middle'`, D1 / 2856-2862), `baseline` per type. Done: `anchor:'middle'`
    emits `text-anchor="middle"` in SVG.
11. **Charts.js 4860-4861** (between series-loop close 4860 and the Effect-3
    dirty bridge 4864) -- `if (annotationsAcc) { const ann =
    buildAnnotations(scene.root, {...}); disposers.push(ann.dispose); }`, passing
    `xScale, yScale, plotBoundsBox, plotBoundsSignal, scaleVersion,
    annotationsAcc, themeVersion: annThemeVersion, swapAxes, container,
    font: () => axisStyleRefs.font.value, markDirty: () => scene.markDirty()`.
    Done: group lands above series, below crosshair (4876).
12. **Charts.js 5599-5600** -- insert
    `if (annThemeVersion) annThemeVersion.update((v) => (v + 1) | 0);` in
    `refreshTheme` before the legend block (5601); 5607 markDirty already fires.
13. **Charts.js 5652-5658** -- extend `_internal` with `annotations: annHandle`
    (`let annHandle = null`, assigned in task 11) so white-box tests read pool
    lengths/visibility without a live reference when disabled.
14. **Charts.d.ts** -- add the `Annotation` union + `annotations?: Annotation[] |
    (() => Annotation[])` on the axis-chart config. Done: `tsc --noEmit` passes.
15. **test/charts.test.js** -- add A1-A8 + A10 below.
16. **test/torture/t6-alloc.mjs** -- add a 4th gated loop: a mounted line chart
    with 8 annotations under a pan-drag (A9).
17. **Docs** -- README annotation section + `New in v1.7.0` block + changelog
    row; `llms.txt` version block; `CHANGELOG.md` `[1.7.0]`; ROADMAP
    current-version bump. ASCII-only (`->`, `<=`, `x`).

---

## Assertions (final, mapped)

- **A1 -> T8,T11.** 800x400 line chart, `annotations:[{type:'line',axis:'y',
  value:100}]`. From `chart._internal.annotations`: `Math.abs(node._y -
  yScale.map(100)) <= 0.5`, `node._dx === plotBoundsBox.w`, `node._dy === 0`.
- **A2 -> T8.** Same + `pan:true`. `setView` so 100 leaves the domain ->
  `node._visible === false` (the boolean, not falsy 0); restore ->
  `node._visible === true` and `_y` within 0.5 of the new `yScale.map(100)`.
- **A3 -> T6,T8.** `from = signal(2)`, `{type:'range',axis:'x',from,to:5}`.
  Emitted `<rect>` `x` within 0.5 of `xScale.map(2)`; `from.set(3)` -> within 0.5
  of `xScale.map(3)` and `linePool.length` unchanged (no re-mount).
- **A4 -> T9,T10.** One chart, all four types. `exportSVG()` contains exactly 1
  `<rect` range fill, >=1 `<path` with `stroke-dasharray="4,4"`, >=1 `A` arc
  from the marker, the label inside `<text`. AND **no** `<rect` whose w ==
  `plotBoundsBox.w` and h == `plotBoundsBox.h` in an annotation color (the D1
  missing-`beginPath` regression).
- **A5 -> T6,T12.** Container stub whose `getComputedStyle` returns `#ff0000`
  for `--ann`. Mount `{color:'--ann'}` -> resolved `=== '#ff0000'`. Flip stub to
  `#00ff00`, `refreshTheme()` -> resolved `=== '#00ff00'`, and `resolveColor`
  NOT called during an intervening `redraw()` (spy delta `=== 0`).
- **A6 -> T7,T8.** `yScale:{type:'log'}`, positive data. `value:-5` ->
  `_visible === false`; `value:0` -> `false`; `value:10` -> `true` and `_y`
  within 0.5 of `yScale.map(10)`. `value:null` -> `false` and no throw.
- **A7 -> T1,T2,T11 (REVISED -- brief's esbuild claim is unachievable, Risk 2).**
  (a) Runtime isolation: no-annotation chart has `_internal.annotations ===
  null`, `scene.root.children.length` equal to the identical pre-change chart,
  `_ownedSignals.length` unchanged. (b) Source-region confinement proxy (style
  of existing A5 test:3387-3389, A15 test:4109): tokens `buildAnnotations` and
  `annThemeVersion` occur ONLY in the annotation region + their three gated call
  sites (4195, 4861, 5600) -- elsewhere `=== 0`.
- **A8 -> T8 (D4).** Static `createBarChart({horizontal:true})`, no pan/zoom/grid/
  log. `{type:'line',axis:'y',value:50}` -> `node._x` within 0.5 of
  `yScale.map(50)`, `node._y === plotBoundsBox.y`, `node._dx === 0`, `node._dy
  === plotBoundsBox.h` (a vertical screen line driven by the data-Y scale).
- **A9 -> T5,T8,T16 (GC budget).** `runOpsGate` (harness.mjs:91-98), 20000
  pointermove-pan ops, 8 annotations, `warmup:1000`, `RULES = {maxMajor:0,
  maxPauseMs:4, maxArrayBuffersGrowth:0}` (harness.mjs:56), `stabilize:'deep'`.
  `report.ok === true`, `bytesPerOp === 0`. Pin the annotation `Float64Array`
  `buffer.byteLength`: before `=== 512` (64 slots), after `=== 512`.
- **A10 -> T4,T6 (retention).** Mount 40 annotations, shrink the signal to 2,
  200x. Each cycle: `linePool.length <= 40` (never past high-water) and entries
  `2..39` have `_visible === false`. After `unmount(); destroy()`:
  `scene.root.children.length === 0` and, under `--expose-gc`, a `WeakRef` to
  `annGroup` clears after 3 forced GCs.

---

## Risks (coder must honor)

1. **Hidden allocation in the project step (highest).** `node.set({...})` (the
   `buildAxis` pattern 1752, 1758-1764, 1779-1784) allocates an object literal
   per call. buildAxis gets away with it because it is off the per-frame path
   (comment 1650-1651), but the annotation project step subscribes to
   `scaleVersion`, bumped by the domain effect at 4763 **every pan/zoom frame**.
   `.set({...})` there FAILS A9. Write underscore fields directly (`n._x = px;
   n._y = py; n._visible = true;` -- legal: `applyProps` writes `node['_'+k]`
   Scene.js:152, fields pre-created monomorphic in `makeNode` Scene.js:108-118),
   then `markDirty()` once.
2. **The brief's original A7 is false.** A runtime-gated feature inside
   `createBaseAxisChart` is statically reachable from `createLineChart`, so
   esbuild cannot drop `buildAnnotations` -- exactly like `buildGrid` (4794) and
   the brush overlay (4917), which ship unconditionally. No bundler in-repo
   either; existing gates (test:3383-3389, 4108-4109) are source-region proxies.
   A7 restated as runtime isolation + confinement proxy. Do NOT promise a size
   delta in the README.
3. **Fail-open on `null`.** `resolveColor` (59-69) returns `'#888'` for a
   non-string, and `Number(null) === 0` -- a `{value:null}` annotation would
   silently draw a rule at data-zero if the coder uses `+ann.value` or
   `|| 0`. Task 7 is the guard, A6 the test. Use `Number.isFinite(v)`, never
   truthiness.
4. **Retention on shrink.** Pooled nodes are hidden, never removed (1896-1898) --
   correct for the hot path, but the high-water mark is permanent; `dispose`
   MUST detach `annGroup` from `scene.root` so `scene.dispose()` (5278-5281)
   releases the subtree. A10 checks it.
5. **`clip()` leaves the path buffer dirty** (2877-2882) -- the most likely
   silent SVG-only regression. Guarded by A4's negative clause.
6. **ASCII hazard** in labels/anchors and docs: emit `'center'` not `'middle'`
   to the node (2856-2862); keep README/CHANGELOG to `->`, `<=`, `x`.

---

## Gate

`npm test` green (A1-A10), `node --expose-gc test/torture.mjs` -> `ok` (new
0-B/frame annotation case, A9), ASCII-only source, runtime isolation +
confinement proxy (A7), `exportSVG` parity (A4). Docs per task 17.
