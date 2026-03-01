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

export function createBundler(graph: ReturnType<typeof createGraph>) {
    let activeSource: string | null = null;
    let openBundle: Bundle | null = null;
    const sealed: Bundle[] = [];

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
        seal();
        const from = activeSource;
        if (from) {
            graph.recordEdge(from, to);
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
        if (!openBundle) return;
        openBundle.captures.push(stamped);
    }

    function getActiveSource(): string | null {
        return activeSource;
    }

    function getOpenBundle(): { source: string; startedAt: number; captureCount: number } | null {
        if (!openBundle) return null;
        return { source: openBundle.source, startedAt: openBundle.startedAt, captureCount: openBundle.captures.length };
    }

    function getSealed(): Bundle[] {
        return [...sealed];
    }

    function drainSealed(): Bundle[] {
        const result = [...sealed];
        sealed.length = 0;
        return result;
    }

    return { ingest, ingestSignal, getActiveSource, getOpenBundle, seal, transition, getSealed, drainSealed };
}
```

## Changes

### 1. Remove graph import and parameter

Remove this line:
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

### 2. Add transition log array

After `const sealed: Bundle[] = [];`, add:
```typescript
const transitions: Transition[] = [];
```

### 3. Rewrite `transition()` function

Replace the entire `transition()` function with:

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

### 4. Add `getTransitions` and `drainTransitions`

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

### 5. Update the return object

Change from:
```typescript
return { ingest, ingestSignal, getActiveSource, getOpenBundle, seal, transition, getSealed, drainSealed };
```
to:
```typescript
return { ingest, ingestSignal, getActiveSource, getOpenBundle, seal, transition, getSealed, drainSealed, getTransitions, drainTransitions };
```

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
        if (!openBundle) return;
        openBundle.captures.push(stamped);
    }

    function getActiveSource(): string | null {
        return activeSource;
    }

    function getOpenBundle(): { source: string; startedAt: number; captureCount: number } | null {
        if (!openBundle) return null;
        return { source: openBundle.source, startedAt: openBundle.startedAt, captureCount: openBundle.captures.length };
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

`src/aggregation/index.ts` still calls `createBundler(graph)` with a `graph` argument and references `createGraph`. This is fixed in step 3.

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
