# Brief -- lite-charts-gl 1.0.0: the render-core decision (#15)

Status: WRITTEN 2026-09-05, same day 0.1.0 went live on npm (rescue brief
#11 executed, published, card synced). This is the decision gate the GL
repo's ROADMAP.md deferred BY DESIGN (rescue D5): it puts the lite-gl 2.0.0
API and the 0.1.0 internals side by side, on the record, and carries the
execution plan for BOTH outcomes. Cross-package (charts-gl x lite-gl), so it
lives here per the #10 precedent. EXECUTES IN THE LiteChartsGl REPO, and
only after the user fills the DECISION block below. No code moves before
that.

## The question (ROADMAP.md, verbatim intent)

At 1.0.0 planning, decide ONE of:

1. Rewrite the render core on @zakkster/lite-gl 2.x sinks.
2. Formally retire the companion brief (`lite-charts-gl-companion.md`,
   ledger #6) and declare the standalone shader layer the design.

"Do not drift into option 2 by default."

## Grounding A -- what the 0.1.0 core actually is (source read 2026-09-05)

- **Camera:** upload-once + `uniform vec4 uDomain` (ChartsGL.js:52) --
  data-space world coords live in the VBO, projection runs on the GPU. A pan
  is a uniform write, zero re-upload. The alpha already has the "camera on
  GPU" shape; what it lacks is precision (next bullet).
- **World coords are float32 end to end** (`createStreamingBuffer` cpuData is
  Float32Array, ChartsGL.js:164). float32 ULP at epoch-ms magnitude
  (~1.78e12) is 131,072 ms: about 2.2 MINUTES of timestamps collapse onto one
  representable value (math per lite-gl llms.txt, v1.4.0 section). A
  time-series x-axis in epoch-ms -- the sibling's bread-and-butter domain --
  quantizes TODAY at any point count. Latent, not yet reported: the demos use
  synthetic 0..N ranges, so nobody has hit it.
- **Scatter:** instanced 4-vertex TRIANGLE_STRIP quads; blend unconditionally
  ON (ChartsGL.js:1241); `discard` in every fragment shape branch (4 sites in
  the file) -- hidden-surface removal dead on tile-based GPUs. Fill cost is
  (size x dpr)^2 fragments per point.
- **The measured wall** (demo scene 05, Apple-silicon MacBook, dpr 2,
  observed 2026-09-05; not yet bench-tabled): 1M points at 2 px drop well
  under 50 fps and pin the GPU into thermal throttle; 1 px costs a quarter of
  the fill and recovers most of it.
- **Hover:** `_defaultHitTest` (ChartsGL.js:2081) is a full O(N) CPU scan per
  processed pointer event -- 1M distance evaluations per hover tick at the
  top count. Injectable via `opts.hitTest` (a real seam; keep it).
- **Context loss:** ZERO handling (`webglcontextlost` / `isContextLost`: 0
  hits in ChartsGL.js). A GPU reset leaves a long-running dashboard
  permanently blank. Fail-open, against suite law.
- **Memory:** 2 floats/point interleaved -- 8 MB CPU + 8 MB GPU at 1M.
- **The user's reference point** ("1M particles re-rendering, no fps drop")
  is the suite's own lite-gl path: lite-soa-particle-engine ships a
  zero-alloc `packTo()` handoff into lite-gl LAYOUT.POINT (catalog card). The
  fast path 0.1.0 is being compared against IS option 1's stack.

## Grounding B -- what lite-gl 2.0.0 actually ships (LiteGL llms.txt +
package.json read 2026-09-05; npm-view-verified 2.0.0)

- **Four WebGL2 sinks, one contract:** createPointSink / createQuadSink /
  createLineSink / createPointHiSink -- upload (dirty window) / draw / resize
  / setScissor / setClearColor / setCounters / pick / onContextRestored /
  isContextLost / dispose, plus a frozen `caps` descriptor (maxInstances
  0xFFFFFF, pickMode "sync"). Per-context refcounted program cache.
- **POINT_HI** (stride 10: xHi, yHi, xLo, yLo, size, r, g, b, a, _pad): WORLD
  coordinates double-emulated (hi/lo split, Sterbenz cancellation in the
  shader), uploaded ONCE; `setCamera(x, y, sx, sy, px, py)` is six plain
  numbers -- zero CPU, zero upload per pan. Guarantee: worst-case sub-pixel
  error ~1e-4 px across a 2000 px viewport at any zoom, any magnitude.
  Packing helpers are exported: writePointHi, hiOf/loOf, f32Ulp,
  needsHiPrecision (`needsHiPrecision(Date.now(), 1000) === true`).
- **pick(x, y, count?):** offscreen 24-bit ID pass + one-pixel readback, ZERO
  allocation (their 1.4.1 gate: 0 B/op over 100k picks), scissor-aware,
  last-drawn-wins, -1 miss. Cost discipline stated by them: one extra draw
  PER CALL -- call it on a throttled pointermove, never in the frame loop.
  The CPU does no hit testing, so hover works at 1M instances.
- **Context loss is SINK-OWNED:** no-op while lost, program/VBO/VAO rebuilt
  on restore, `onContextRestored` re-upload hook.
- **The limit that shapes the mapping:** POINT / QUAD / LINE layouts hold
  SCREEN PIXELS -- every camera change re-projects on the CPU and re-uploads
  (their own measure: ~5 ms + 31 MB per frame at 1M on a pan). Only POINT_HI
  carries the GPU camera. There is NO LINE_HI and NO QUAD_HI.
- LINE sink: instanced thick butt-capped segments (screen px; capacity =
  segments). QUAD sink: sized/rotated quads -- bars, markers, heatmap cells.
- **WebGPU backend** (subpath ./webgpu): same contract, BYTE-IDENTICAL field
  layouts, deferred pick (PICK_PENDING). A future door, not 1.0.0 work.
- **Gated like everything in the suite:** its own torture tiers (1M frames at
  0 B/op, a zero-tolerance dirty-range gate, context-loss + program-refcount
  tiers), Playwright real-GPU smoke in CI, and .d.ts SHIPS (GL.d.ts in
  files[]).
- **Peers:** lite-signal >=1.5.0-alpha (charts-gl already peers >=1.5.0 --
  compatible) AND lite-raf ^1.0.0. charts-gl would not use lite-raf (raw
  sinks + its own rAF scheduling never touch it), but the peer rides into
  consumer installs regardless.

## The mapping, if option 1 (adoption depth A: sinks only)

Keep charts-gl's own ring semantics, signals, rAF scheduling, axes, and
interactions. Swap the GLSL floor out from under them:

    scatter core        -> createPointHiSink. appendPoints packs via
                           writePointHi (world coords, f64 split -- the
                           timestamp hole closes); `chart.view` drives
                           setCamera; opaque fast path when alpha == 1
                           (blend off, no discard -> HSR comes back).
    hover               -> opt-in `hitTest: 'gpu'` on the existing seam,
                           sink.pick on the throttled path only. The O(N)
                           scan stays available; semantics differ
                           (nearest-within-threshold vs topmost-pixel) --
                           disclosed, and a bench picks the 1.0.0 default.
    heatmap             -> createQuadSink; per-cell rgba written CPU-side
                           from the palette table + dirty-window flush.
                           LIVE setValues() lands here (ROADMAP v0.2 item
                           4). Cell counts are small, so QUAD's screen-space
                           re-projection is trivially cheap.
    line                -> KEEP the current hairline LINE_STRIP mini-core at
                           1.0.0. No LINE_HI exists; screen-space thick
                           segments would re-open the ~5 ms + 31 MB pan cost
                           at exactly the point counts this package exists
                           for. Thick lines stay ROADMAP, keyed on a future
                           lite-gl LINE_HI.
    compile/program/
    streaming exports   -> internal to the retained line core, or deleted.
                           The 19-export surface is reconciled at T8 (0.x ->
                           1.0.0 may break; CHANGELOG Breaking section).
    context loss        -> sink-owned recovery arrives for scatter + heatmap
                           free of charge; the line core copies the pattern
                           or documents the remaining gap.

Depth B (adopting createField/reactiveField wholesale) is NOT proposed: it
would replace working, gated ring machinery for no measured gain. Revisit
only if depth A leaves demonstrable seams.

## Cost ledger, option 1 (disclosed up front)

- **Memory x5 on scatter.** POINT_HI is 10 floats/point vs 2 today: 40 MB
  CPU + 40 MB GPU at 1M (vs 8 + 8). The price of per-point size/color and
  the precision guarantee. Goes in the README table; 16 MB at capacity 400k
  is the honest "fits everywhere" line.
- **Two real peers instead of one:** lite-gl >=2.0.0 <3, plus lite-raf
  ^1.0.0 as unused baggage via lite-gl. Upstream ask (same author, zero
  politics): mark lite-raf optional in lite-gl's peerDependenciesMeta.
- **pointShape parity is unresolved.** POINT_HI renders flat squares;
  circle/diamond need a gl_PointCoord mask (discard or alpha) -- a lite-gl
  feature ask, or a documented square-only 1.0.0. Mitigating fact: at the
  1-2 px sizes where 1M is viable, shape is literally invisible (a 2 px
  circle IS a square). T1 measures, T2 decides.
- **Release-cadence coupling** -- softened: same suite, same author, same
  law, and the caps seam is lite-gl's explicit compatibility contract.
- **Migration risk against 118 tests + 4 torture tiers** -- mitigated by
  design: the T0 laws and T6/T7 gates are API-level and survive a core swap
  unchanged. They are the safety net they were built to be.

## Physics stays physics (no core rewrite changes this)

Fill cost is (size x dpr)^2 fragments per point on ANY primitive. 1M
alpha-blended 4 px circles saturate fill-rate whoever owns the shaders. What
POINTS + opaque actually buys: 1 vertex instead of 4 + instance fetch per
point, blend off, discard gone -- early-Z / hidden-surface removal live
again. The defensible headline is "1M points at 60 fps at small opaque
sizes, pan/zoom on the GPU" -- which is exactly the particle configuration
the user measured 0.1.0 against. Large blended shapes remain a documented
curve in either option.

## Option 2, steel-manned

**2a** -- retire the companion brief, freeze the standalone layer as the
design. Zero new peers, zero migration risk, the module stays fully
self-contained. But the three defects 0.1.0 measured or carries latently
(fill wall, f32 epoch-ms collapse, no context-loss recovery) remain OURS,
and each fix re-implements something lite-gl has already built AND
torture-gated (POINTS path, hi/lo camera, sink-owned restore).
**2b** -- retire the brief AND hand-roll a gl.POINTS fast path in-module:
the honest variant. It fixes the fill wall, but precision, picking, and
restore still get re-implemented over time, and the suite already treats
lite-gl's layouts as its GPU lingua franca (lite-soa-particle-engine
packTo). Option 2 is coherent only if 1.0.0 positioning DROPS the 1M
headline and the epoch-ms time-series claim -- a smaller package than the
one the companion brief chartered.

## Recommendation (advisory -- the decision is the user's, below)

**Option 1, depth A.** Every defect 0.1.0 measured or carries is already
solved and gated in lite-gl 2.0.0; rebuilding them standalone is the suite's
own anti-pattern -- the composition law exists for exactly this case, and
lite-gl's llms.txt names charts as its intended consumer. Falsifiable: T1's
A/B numbers can overturn it, and T2 is a real checkpoint with a written
bail-out to 2b.

## DECISION (filled by the user, on the record)

    DECISION:    ____            (1 / 2a / 2b)
    DATE:        ____
    RECORDED BY: ____
    NOTE:        ____

## Tasks -- option 1 lane (T1 gates everything after it)

- **T1 SPIKE** (timeboxed; branch `spike/point-hi`; throwaway allowed):
  scatter on createPointHiSink behind the UNCHANGED public API; demo scene
  05 grows an A/B core toggle. Capture fps / frame-time / p95 at 100k and 1M
  x 1/2/4 px x blend on/off, plus a pan-storm run, with lite-gpu-profiler
  1.2.1 GPU-time numbers where the extension is available. Also measures a
  gl_PointCoord circle-mask variant (the shape question) and demonstrates
  the epoch-ms fix (`needsHiPrecision(Date.now(), 1000) === true`; jitter
  visible on the old core, gone on POINT_HI). Numbers land IN THIS FILE
  under a T1 RESULTS heading with the capture fingerprint (browser, chip,
  dpr). No invented figures.
- **T2 CHECKPOINT:** numbers in front of the user. Proceed / adjust / bail
  to 2b -- recorded in the DECISION NOTE.
- **T3 scatter migration:** POINT_HI packing in appendPoints and the
  reactive data path; ring semantics preserved (decide: keep or version the
  `chart._xy` introspection seam the hit-test uses); `chart.view` ->
  setCamera; opaque fast path when alpha == 1; setPointSize becomes a cold
  O(N) size-lane rewrite (per-instance size -- also the door to the
  companion brief's bubble chart); capacity honors caps.maxInstances (fail
  closed).
- **T4 hover:** `hitTest: 'gpu'` via sink.pick on the throttled path;
  document the semantics change; bench vs the O(N) scan at 100k/1M decides
  the 1.0.0 default.
- **T5 heatmap:** createQuadSink + live `setValues()` with dirty-window
  flush (ROADMAP v0.2 item 4 lands); palette lookup stays a CPU-side table.
- **T6 line:** explicitly NOT migrated (see mapping). The retained mini-core
  is trimmed to line-only (dead scatter/heatmap GLSL deleted); its
  context-loss gap is closed by copying the sink pattern or documented.
- **T7 gates:** peers become lite-signal >=1.5.0 + lite-gl >=2.0.0 <3 (plus
  the lite-raf upstream ask). Torture runs COMPOSED -- lite-gl sinks driven
  against test/mock-gl.mjs, extending the mock to the sink call surface
  where needed (pick's framebuffer path included; lite-gl's own
  GLBackend_test mock is the reference). T6 alloc gates re-prove 0 B on
  append / draw / pointer storms through the sink path; T7 soak ledger
  learns sink dispose + program refcount; T9 grows a control that corrupts
  the hi/lo split and must fail a new t0 precision law.
- **T8 surface reconciliation at 1.0.0:** which of the 19 exports survive;
  CHANGELOG Breaking section; .d.ts written ONCE against the settled
  surface (ROADMAP v0.2 item 7 lands; GL.d.ts is the precedent); README +
  llms.txt truth pass; real-GPU CI ported from lite-gl's smoke.spec.mjs
  pattern; the 1M pan bench as the headline integration test -- the
  companion brief's gate, finally executed.
- **T9** /release 1.0.0; USER publishes + commits + /sync-card
  lite-charts-gl; ledger row #6 updated to SUPERSEDED-EXECUTED via this
  brief.

## Tasks -- option 2 lane

- **R1:** companion brief marked RETIRED (status line + ledger row #6,
  pointing here). GL-repo ROADMAP.md rewritten to OWN the wall: a POINTS
  fast path + opaque mode task, a context-loss recovery task, and f32
  precision either fixed in-module (hi/lo split) or documented NOT-FOR
  epoch-scale axes.
- **R2:** .d.ts against the frozen 19-export surface.
- **R3:** /release 1.0.0 as the consolidation release; sync-card.

## Scope fences (both lanes)

- Multi-series, incremental LTTB, thick lines: v0.2+ lanes regardless of the
  core choice.
- No WebGPU backend work at 1.0.0 -- the byte-identical door is noted, not
  opened. No lite-charts changes. The demo adapts to the module, never the
  reverse. No code lands before the DECISION block is filled.

## Gate (both lanes)

`npm test` green (118+), `npm run torture` prints exactly `ok`,
`CHARTS_GL_TORTURE_BREAK=1` run exits non-zero, ASCII clean, `npm pack
--dry-run` clean. Option 1 additionally: the T1 RESULTS table filled with
fingerprinted measurements, the 1M pan bench green in real-GPU CI before the
1.0.0 tag, and the x5 memory change + shape resolution + hover-semantics
default all stated in the CHANGELOG.
