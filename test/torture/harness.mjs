/**
 * @zakkster/lite-charts -- torture harness.
 *
 * Shared PRNG, thunk-only assertions, the lite-gc-profiler gate wrapper, an
 * event-capable headless canvas, a controllable ResizeObserver, and the
 * lite-signal observer-count instruments. Every tier imports from here so the
 * discipline lives in one place:
 *
 *   - `check()` builds its message ONLY on failure -- a template literal per hot
 *     iteration is an allocation and would fail the T6 gate. Pass a thunk.
 *   - The PRNG is a seeded xorshift32. On any failure a tier prints the seed and
 *     op index so the exact case replays with `TORTURE_SEED=... npm run torture`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run sequentially,
 *     never nested. `runOpsGate` opens and closes a single window per call and
 *     gates it at `maxArrayBuffersGrowth:0` with `stabilize:'deep'` -- the rule
 *     that sees typed-array pool growth (which lives OUTSIDE the V8 heap and is
 *     invisible to a `heapUsed` delta).
 *   - The recording mock context grows an unbounded `calls` array; hot loops set
 *     `ctx.recordingEnabled = false` (see `quietCanvas`) so recording never
 *     pollutes a zero-alloc measurement.
 *
 * SCOPE LIMIT (inherited from the bench's disclaimer, stated here too): these
 * gates measure the LIBRARY's allocations -- scale kernels, decimation, pointer
 * math, the signal graph. They do NOT measure the host Canvas2D renderer; the
 * mock context records calls and allocates nothing a real GPU driver would.
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies only. Charts.js has
 * zero runtime dependencies beyond its declared peers.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createRegistry, setDefaultRegistry, stats } from '@zakkster/lite-signal';
import { createMockContext } from '../harness.js';

// The suite stands up every chart variant back-to-back and soaks 4096
// create/destroy cycles. Each chart allocates ~12-20 reactive nodes; the
// default registry caps at 1024. Bump to 128k so a tier that legitimately holds
// many live charts does not hit the cap -- and so a LEAK shows as a climbing
// `activeNodes` delta (T7) rather than a premature CapacityError.
setDefaultRegistry(createRegistry({ maxNodes: 1 << 17 }));

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Deliberately-broken control mode: injects a retained allocation into T6. */
export const BREAK = process.env.CHARTS_TORTURE_BREAK === '1';

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps stabilize:'deep'. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * `stabilize:'deep'` makes the `maxArrayBuffersGrowth` rule resolvable.
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary, bytesPerOp: res.bytesPerOp };
}

/** One-line diagnostic for a rejected alloc window. */
export function allocFailMsg(tag, report, summary) {
    const g = summary.gc || {};
    return tag + ' alloc gate rejected -- verdict=' + report.verdict +
        ' source=' + summary.source +
        ' major=' + (g.major != null ? g.major : '?') +
        ' maxMs=' + (g.maxMs != null ? g.maxMs.toFixed(3) : '?');
}

// ---------------------------------------------------------------------------
// Event-capable headless canvas
// ---------------------------------------------------------------------------
//
// Charts.js attaches pan/zoom/brush via `canvas.addEventListener` and crosshair
// via `mousemove`/`mouseleave`; the recording mock in ../harness.js has no
// event surface, which is why the unit suite drives the pan/zoom MATH directly.
// The torture tiers need the real event PATH (pointer storm, resize storm), so
// this canvas adds exactly the surface the handlers touch and nothing more:
//
//   fields read off events : button, clientX, clientY, deltaY, pointerId,
//                            shiftKey, preventDefault()
//   canvas methods called  : addEventListener, removeEventListener,
//                            getBoundingClientRect, setPointerCapture,
//                            releasePointerCapture, style, parentElement,
//                            toDataURL, width, height, getContext
//
// The canvas is a real CANVAS (has tagName) so mount() takes the direct path.
// Its `parentElement` is a DIV-shaped container with mutable clientWidth/
// clientHeight, so `_wireAutoSize` (which observes the container) has something
// to read for the resize storm.

export function createEventCanvas(width, height) {
    let _w = width || 800;
    let _h = height || 400;
    let _ctx = null;
    const listeners = new Map(); // type -> Set<fn>

    const container = {
        tagName: 'DIV',
        clientWidth: _w,
        clientHeight: _h,
        // resolveColor walks parentElement; a null grandparent ends the walk.
        parentElement: null,
        style: {},
    };

    const canvas = {
        tagName: 'CANVAS',
        parentElement: container,
        style: {},
        get width() { return _w; },
        set width(v) { _w = v | 0; },
        get height() { return _h; },
        set height(v) { _h = v | 0; },
        getContext(type) {
            if (type !== '2d') return null;
            if (!_ctx) _ctx = createMockContext();
            return _ctx;
        },
        getBoundingClientRect() {
            return { left: 0, top: 0, right: _w, bottom: _h, width: _w, height: _h, x: 0, y: 0 };
        },
        setPointerCapture() {},
        releasePointerCapture() {},
        hasPointerCapture() { return false; },
        toDataURL() { return 'data:image/png;base64,'; },
        addEventListener(type, fn) {
            let set = listeners.get(type);
            if (!set) { set = new Set(); listeners.set(type, set); }
            set.add(fn);
        },
        removeEventListener(type, fn) {
            const set = listeners.get(type);
            if (set) set.delete(fn);
        },
        /** Total live listeners across all types -- a listener-leak witness. */
        _listenerCount() {
            let n = 0;
            for (const set of listeners.values()) n += set.size;
            return n;
        },
        /** Dispatch a synthetic event to every listener of its type. */
        _fire(ev) {
            const set = listeners.get(ev.type);
            if (!set) return;
            for (const fn of set) fn(ev);
        },
        _container: container,
    };
    return canvas;
}

// ---------------------------------------------------------------------------
// centerLabel DOM host (v1.5.0)
// ---------------------------------------------------------------------------
//
// The bare event-canvas above has no DOM parent to host the donut centerLabel
// overlay. This installs a minimal `document` whose elements support the
// interposition the polar kernel performs (insertBefore + reparent), plus a
// canvas-in-container factory. `canvasInContainer` keeps `canvasCreated=false`
// (the chart mounts onto an existing canvas), so unmount leaves the canvas in
// its container -- exactly what the A6 restore assertion checks.

export function installCenterLabelDOM() {
    const mkStyle = () => {
        const p = new Map();
        return { setProperty(k, v) { p.set(k, v); }, getPropertyValue(k) { return p.get(k) || ''; } };
    };
    const mkEl = (tag) => ({
        tagName: (tag || 'div').toUpperCase(),
        childNodes: [], parentNode: null, parentElement: null,
        style: mkStyle(), className: '', textContent: '',
        appendChild(c) {
            if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
            this.childNodes.push(c); c.parentNode = this; c.parentElement = this; return c;
        },
        insertBefore(c, ref) {
            if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
            const i = this.childNodes.indexOf(ref);
            if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
            c.parentNode = this; c.parentElement = this; return c;
        },
        removeChild(c) {
            const i = this.childNodes.indexOf(c);
            if (i >= 0) this.childNodes.splice(i, 1);
            c.parentNode = null; c.parentElement = null; return c;
        },
        querySelectorAll() { return []; },
    });
    const mkCanvas = (w, h) => {
        const c = mkEl('canvas');
        let _w = w || 320, _h = h || 240, _ctx = null;
        const L = new Map();
        Object.defineProperty(c, 'width', { get() { return _w; }, set(v) { _w = v | 0; } });
        Object.defineProperty(c, 'height', { get() { return _h; }, set(v) { _h = v | 0; } });
        c.getContext = (t) => { if (t !== '2d') return null; if (!_ctx) _ctx = createMockContext(); return _ctx; };
        c.getBoundingClientRect = () => ({ left: 0, top: 0, width: _w, height: _h, x: 0, y: 0, right: _w, bottom: _h });
        c.addEventListener = (ty, fn) => { let s = L.get(ty); if (!s) { s = new Set(); L.set(ty, s); } s.add(fn); };
        c.removeEventListener = (ty, fn) => { const s = L.get(ty); if (s) s.delete(fn); };
        c._listenerCount = () => { let n = 0; for (const s of L.values()) n += s.size; return n; };
        c.toDataURL = () => 'data:,';
        return c;
    };
    const prev = globalThis.document;
    globalThis.document = { createElement: (t) => t === 'canvas' ? mkCanvas() : mkEl(t) };
    return {
        mkEl,
        canvasInContainer(w, h) {
            const container = mkEl('div');
            const canvas = mkCanvas(w, h);
            container.appendChild(canvas);
            return { container, canvas };
        },
        uninstall() { globalThis.document = prev; },
    };
}

/** Silence the recording context so a hot loop's `calls` array cannot grow. */
export function quietCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.recordingEnabled = false;
    ctx.calls.length = 0;
    return canvas;
}

// A reusable event object mutated in place -- the hot pointer loop must not
// allocate a fresh event per move. Handlers only read a few fields.
const _sharedEvent = {
    type: 'pointermove',
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    deltaY: 0,
    shiftKey: false,
    preventDefault() {},
};

/**
 * Fire a synthetic event WITHOUT allocating: mutate the shared record, dispatch.
 * Only for hot loops where zero-alloc is being measured.
 */
export function fireShared(canvas, type, x, y, opts) {
    const e = _sharedEvent;
    e.type = type;
    e.clientX = x;
    e.clientY = y;
    e.button = opts && opts.button != null ? opts.button : 0;
    e.pointerId = opts && opts.pointerId != null ? opts.pointerId : 1;
    e.deltaY = opts && opts.deltaY != null ? opts.deltaY : 0;
    e.shiftKey = !!(opts && opts.shiftKey);
    canvas._fire(e);
}

/** Allocating event factory -- fine for correctness tiers, not for T6. */
export function makeEvent(type, x, y, opts) {
    return {
        type,
        button: 0,
        pointerId: 1,
        clientX: x,
        clientY: y,
        deltaY: 0,
        shiftKey: false,
        preventDefault() {},
        ...opts,
    };
}

// ---------------------------------------------------------------------------
// Controllable ResizeObserver
// ---------------------------------------------------------------------------
//
// `_wireAutoSize` bails when `typeof ResizeObserver === 'undefined'`. Install
// this shim to activate the resize path; without requestAnimationFrame the wire
// falls back to a SYNCHRONOUS readSize on each callback, so a fired resize takes
// effect deterministically before the next line runs.

export function installResizeObserver() {
    const instances = [];
    class MockResizeObserver {
        constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; instances.push(this); }
        observe(t) { this.targets.push(t); }
        unobserve(t) { const i = this.targets.indexOf(t); if (i >= 0) this.targets.splice(i, 1); }
        disconnect() { this.disconnected = true; this.targets.length = 0; }
    }
    const prev = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver;
    return {
        instances,
        /** Fire every live (undisconnected) observer's callback once. */
        fire() {
            for (let i = 0; i < instances.length; i++) {
                const ro = instances[i];
                if (!ro.disconnected) ro.cb([], ro);
            }
        },
        /** How many observers are still connected -- a wiring-leak witness. */
        liveCount() {
            let n = 0;
            for (let i = 0; i < instances.length; i++) if (!instances[i].disconnected) n++;
            return n;
        },
        uninstall() { globalThis.ResizeObserver = prev; },
    };
}

// ---------------------------------------------------------------------------
// Signal-graph instruments (the named leak gate)
// ---------------------------------------------------------------------------
//
// lite-signal's `stats()` exposes `activeNodes` (live signals + computeds +
// effects) and `activeLinks` (live subscription edges). A chart that fully
// detaches on destroy() returns BOTH to their pre-create values. This is the
// executable form of "destroy() detaches from the signal graph" -- a named
// count, not a heap curve.

export function graphSnapshot() {
    const s = stats();
    return { nodes: s.activeNodes, links: s.activeLinks };
}

export function graphDelta(before) {
    const now = graphSnapshot();
    return { nodes: now.nodes - before.nodes, links: now.links - before.links };
}
