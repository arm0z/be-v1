# Step 2: Rewrite bundler.ts — transition log

## Goal

Replace `graph.recordEdge()` calls with an internal transition log that records `Transition` records with timestamps and dwell times. The bundler no longer takes a `graph` parameter.

## Prerequisite

Step 1 complete — `Transition` type exists in `types.ts`.

## File to modify

`src/aggregation/bundler.ts`

## Current contents (before this step)

```typescript
import type { StampedCapture, StampedSignal, Bundle } from "./types.ts";
import { UNKNOWN, OFF_BROWSER } from "./types.ts";
import { translate } from "./translate.ts";
import { dev } from "../event/dev.ts";
import type { createGraph } from "./graph.ts";

const DWELL_MS = 1000;

export function createBundler(graph: ReturnType<typeof createGraph>) {
    let activeSource: string | null = null;
    let graphCursor: string | null = null;
    let openBundle: Bundle | null = null;
    const sealed: Bundle[] = [];
    let pendingEdge: { from: string; to: string; arrivedAt: number } | null = null;
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;

    function openNew(source: string): void {
        openBundle = {
            source,
            startedAt: Date.now(),
            endedAt: null,
            captures: [],
            text: null,
        };
        dev.log("aggregator", "bundle.opened", `bundle opened for ${source}`, { source });
    }

    function seal(): void {
        if (!openBundle) return;
        openBundle.endedAt = Date.now();
        openBundle.text = translate(openBundle);
        sealed.push(openBundle);
        dev.log("aggregator", "bundle.sealed", `bundle sealed for ${openBundle.source} (${openBundle.captures.length} captures)`, {
            source: openBundle.source,
            captures: openBundle.captures.length,
            text: openBundle.text,
        });
        openBundle = null;
    }

    function commitPending(): void {
        if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
        if (pendingEdge) {
            dev.log("navigation", "dwell.auto_commit", `dwell timer fired — committing ${pendingEdge.from} → ${pendingEdge.to}`, {
                from: pendingEdge.from,
                to: pendingEdge.to,
            });
            graph.recordEdge(pendingEdge.from, pendingEdge.to);
            pendingEdge = null;
        }
    }

    function transition(to: string): void {
        seal();
        if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
        const now = Date.now();

        dev.log("navigation", "transition.start", `${graphCursor ?? "∅"} → ${to}`, {
            from: graphCursor,
            to,
            hasPending: !!pendingEdge,
            pendingFrom: pendingEdge?.from,
            pendingTo: pendingEdge?.to,
        });

        if (pendingEdge) {
            const elapsed = now - pendingEdge.arrivedAt;
            if (elapsed >= DWELL_MS) {
                dev.log("navigation", "dwell.met", `${pendingEdge.from} → ${pendingEdge.to} held ${elapsed}ms (≥${DWELL_MS}ms) — committing edge`, {
                    from: pendingEdge.from,
                    to: pendingEdge.to,
                    elapsed,
                    threshold: DWELL_MS,
                });
                graph.recordEdge(pendingEdge.from, pendingEdge.to);
                if (pendingEdge.to !== to) {
                    pendingEdge = { from: pendingEdge.to, to, arrivedAt: now };
                    dev.log("navigation", "pending.new", `new pending edge: ${pendingEdge.from} → ${to}`, {
                        from: pendingEdge.from,
                        to,
                    });
                } else {
                    pendingEdge = null;
                }
            } else {
                if (pendingEdge.from !== to) {
                    dev.log("navigation", "dwell.collapse", `${pendingEdge.to} held only ${elapsed}ms (<${DWELL_MS}ms) — collapsing: ${pendingEdge.from} → ${pendingEdge.to} → ${to} becomes ${pendingEdge.from} → ${to}`, {
                        collapsed: pendingEdge.to,
                        from: pendingEdge.from,
                        to,
                        elapsed,
                        threshold: DWELL_MS,
                    });
                    pendingEdge = { from: pendingEdge.from, to, arrivedAt: now };
                } else {
                    dev.log("navigation", "dwell.cancel", `${pendingEdge.to} held only ${elapsed}ms — returned to origin ${to}, cancelling edge`, {
                        from: pendingEdge.from,
                        intermediate: pendingEdge.to,
                        returnedTo: to,
                        elapsed,
                        threshold: DWELL_MS,
                    });
                    pendingEdge = null;
                }
            }
        } else {
            const from = graphCursor;
            if (from && from !== to) {
                pendingEdge = { from, to, arrivedAt: now };
                dev.log("navigation", "pending.new", `first pending edge: ${from} → ${to}`, {
                    from,
                    to,
                });
            }
        }

        if (pendingEdge) {
            dwellTimer = setTimeout(commitPending, DWELL_MS);
            dev.log("navigation", "dwell.timer_start", `auto-commit timer set for ${DWELL_MS}ms on ${pendingEdge.from} → ${pendingEdge.to}`, {
                from: pendingEdge.from,
                to: pendingEdge.to,
                ms: DWELL_MS,
            });
        }

        dev.log("aggregator", "transition", `${graphCursor ?? "∅"} → ${to}`, { from: graphCursor, to });
        graphCursor = to;
        activeSource = to;
        if (to !== UNKNOWN && to !== OFF_BROWSER) {
            openNew(to);
        }
    }

    function moveCursor(to: string): void {
        graphCursor = to;
    }

    function getGraphCursor(): string | null {
        return graphCursor;
    }

    function ingest(stamped: StampedCapture): void {
        if (activeSource === null || stamped.source !== activeSource) {
            transition(stamped.source);
        } else if (!openBundle) {
            openNew(stamped.source);
        }
        openBundle!.captures.push(stamped);
    }

    function ingestSignal(stamped: StampedSignal): void {
        if (!openBundle) {
            if (activeSource && activeSource !== UNKNOWN && activeSource !== OFF_BROWSER) {
                openNew(activeSource);
            } else {
                return;
            }
        }
        openBundle!.captures.push(stamped);
    }

    function getActiveSource(): string | null {
        return activeSource;
    }

    function getOpenBundle(): { source: string; startedAt: number; captureCount: number; captures: { type: string; timestamp: number }[] } | null {
        if (!openBundle) return null;
        return {
            source: openBundle.source,
            startedAt: openBundle.startedAt,
            captureCount: openBundle.captures.length,
            captures: openBundle.captures.map((c) => ({ type: c.type, timestamp: c.timestamp })),
        };
    }

    function getSealed(): Bundle[] {
        return [...sealed];
    }

    function drainSealed(): Bundle[] {
        const result = [...sealed];
        sealed.length = 0;
        return result;
    }

    return { ingest, ingestSignal, getActiveSource, getGraphCursor, getOpenBundle, seal, transition, moveCursor, getSealed, drainSealed, commitPending };
}
```

## Changes

### 1. Remove graph import and parameter

Remove these lines:
```typescript
import type { createGraph } from "./graph.ts";
```

Add `Transition` to the existing type import:
```typescript
import type { StampedCapture, StampedSignal, Bundle, Transition } from "./types.ts";
```

Change the function signature from:
```typescript
export function createBundler(graph: ReturnType<typeof createGraph>) {
```
to:
```typescript
export function createBundler() {
```

### 2. Remove all dwell machinery

Delete these variables and functions entirely:
- `const DWELL_MS = 1000;` (top-level constant)
- `let graphCursor: string | null = null;`
- `let pendingEdge: { from: string; to: string; arrivedAt: number } | null = null;`
- `let dwellTimer: ReturnType<typeof setTimeout> | null = null;`
- `commitPending()` function
- `moveCursor()` function
- `getGraphCursor()` function

### 3. Add transition log array

After `const sealed: Bundle[] = [];`, add:
```typescript
const transitions: Transition[] = [];
```

### 4. Rewrite `transition()` function

Replace the entire `transition()` function (which contains the complex dwell/collapse/cancel logic) with:

```typescript
function transition(to: string): void {
    const from = activeSource;
    seal();
    if (from) {
        // dwellMs comes from the bundle that was just sealed.
        // seal() sets openBundle.endedAt before pushing to sealed[],
        // so the last sealed bundle has the timing we need.
        const lastSealed = sealed[sealed.length - 1];
        const dwellMs = lastSealed
            ? lastSealed.endedAt! - lastSealed.startedAt
            : 0;
        transitions.push({ from, to, ts: Date.now(), dwellMs });
    }
    dev.log("aggregator", "transition", `${from ?? "∅"} → ${to}`, { from, to });
    activeSource = to;
    if (to !== UNKNOWN && to !== OFF_BROWSER) {
        openNew(to);
    }
}
```

**Critical detail:** `dwellMs` is computed from the sealed bundle's `endedAt - startedAt`. We capture `from` before calling `seal()`, then read the last sealed bundle after `seal()` completes. For `off_browser` and `unknown` transitions where no bundle was open, `dwellMs` is 0.

### 5. Add `getTransitions` and `drainTransitions`

Add these two functions before the `return` statement:

```typescript
function getTransitions(): Transition[] {
    return [...transitions];
}

function drainTransitions(): Transition[] {
    const result = [...transitions];
    transitions.length = 0;
    return result;
}
```

### 6. Update the return object

Change from:
```typescript
return { ingest, ingestSignal, getActiveSource, getGraphCursor, getOpenBundle, seal, transition, moveCursor, getSealed, drainSealed, commitPending };
```
to:
```typescript
return { ingest, ingestSignal, getActiveSource, getOpenBundle, seal, transition, getSealed, drainSealed, getTransitions, drainTransitions };
```

Removed: `getGraphCursor`, `moveCursor`, `commitPending`
Added: `getTransitions`, `drainTransitions`

## Expected final file

The complete file after this step:

```typescript
import type { StampedCapture, StampedSignal, Bundle, Transition } from "./types.ts";
import { UNKNOWN, OFF_BROWSER } from "./types.ts";
import { translate } from "./translate.ts";
import { dev } from "../event/dev.ts";

export function createBundler() {
    let activeSource: string | null = null;
    let openBundle: Bundle | null = null;
    const sealed: Bundle[] = [];
    const transitions: Transition[] = [];

    function openNew(source: string): void {
        openBundle = {
            source,
            startedAt: Date.now(),
            endedAt: null,
            captures: [],
            text: null,
        };
        dev.log("aggregator", "bundle.opened", `bundle opened for ${source}`, { source });
    }

    function seal(): void {
        if (!openBundle) return;
        openBundle.endedAt = Date.now();
        openBundle.text = translate(openBundle);
        sealed.push(openBundle);
        dev.log("aggregator", "bundle.sealed", `bundle sealed for ${openBundle.source} (${openBundle.captures.length} captures)`, {
            source: openBundle.source,
            captures: openBundle.captures.length,
            text: openBundle.text,
        });
        openBundle = null;
    }

    function transition(to: string): void {
        const from = activeSource;
        seal();
        if (from) {
            const lastSealed = sealed[sealed.length - 1];
            const dwellMs = lastSealed
                ? lastSealed.endedAt! - lastSealed.startedAt
                : 0;
            transitions.push({ from, to, ts: Date.now(), dwellMs });
        }
        dev.log("aggregator", "transition", `${from ?? "∅"} → ${to}`, { from, to });
        activeSource = to;
        if (to !== UNKNOWN && to !== OFF_BROWSER) {
            openNew(to);
        }
    }

    function ingest(stamped: StampedCapture): void {
        if (activeSource === null || stamped.source !== activeSource) {
            transition(stamped.source);
        } else if (!openBundle) {
            openNew(stamped.source);
        }
        openBundle!.captures.push(stamped);
    }

    function ingestSignal(stamped: StampedSignal): void {
        if (!openBundle) {
            if (activeSource && activeSource !== UNKNOWN && activeSource !== OFF_BROWSER) {
                openNew(activeSource);
            } else {
                return;
            }
        }
        openBundle!.captures.push(stamped);
    }

    function getActiveSource(): string | null {
        return activeSource;
    }

    function getOpenBundle(): { source: string; startedAt: number; captureCount: number; captures: { type: string; timestamp: number }[] } | null {
        if (!openBundle) return null;
        return {
            source: openBundle.source,
            startedAt: openBundle.startedAt,
            captureCount: openBundle.captures.length,
            captures: openBundle.captures.map((c) => ({ type: c.type, timestamp: c.timestamp })),
        };
    }

    function getSealed(): Bundle[] {
        return [...sealed];
    }

    function drainSealed(): Bundle[] {
        const result = [...sealed];
        sealed.length = 0;
        return result;
    }

    function getTransitions(): Transition[] {
        return [...transitions];
    }

    function drainTransitions(): Transition[] {
        const result = [...transitions];
        transitions.length = 0;
        return result;
    }

    return { ingest, ingestSignal, getActiveSource, getOpenBundle, seal, transition, getSealed, drainSealed, getTransitions, drainTransitions };
}
```

## What will break

`src/aggregation/index.ts` still calls `createBundler(graph)` with a `graph` argument and references `createGraph`. Additionally, `index.ts` calls `bundler.commitPending()` in its `drainEdges` wrapper — this function no longer exists. Both are fixed in step 3.

## Verification

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: errors only in `index.ts` (passing extra arg to `createBundler`, missing `getTransitions`/`drainTransitions`/`seal` on return object, referencing deleted `getEdges`/`drainEdges`). No errors in `bundler.ts` itself.

## Documentation update

After completing this step, update `.architecture/packer.md`:

In the **File map** table, change the `bundler.ts` row to:
```
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts) | `createBundler()` — **Implemented.** Produces sealed Bundles, logs `Transition` records with `dwellMs` on each source change. Exposes `getTransitions()`/`drainTransitions()`. No longer depends on `graph.ts`. |
```
