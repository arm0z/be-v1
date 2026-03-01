# Step 3: Rewrite aggregator facade — remove graph, wire transition log

## Goal

Update `index.ts` to:
1. Stop importing/creating `createGraph()`
2. Call `createBundler()` with no arguments
3. Remove `graph.getEdges()` and `graph.getUrls()` from `emitState()`
4. Remove `graph.recordUrl()` calls from signal handlers
5. Expose `getTransitions`, `drainTransitions`, and `seal` on the returned `Aggregator`
6. Update `emitState()` to log transitions instead of edges

## Prerequisites

Steps 1 and 2 complete — `Transition` type exists, bundler exports `getTransitions`/`drainTransitions`.

## File to modify

`src/aggregation/index.ts`

## Current contents (before this step)

Read the file before modifying. Key things to change:

1. **Line 5:** `import { createGraph } from "./graph.ts";` — DELETE this line
2. **Line 24:** `const graph = createGraph();` — DELETE this line
3. **Line 25:** `const bundler = createBundler(graph);` — change to `const bundler = createBundler();`
4. **Lines in `emitState()`:** Currently logs `edges: graph.getEdges()` and `urls: graph.getUrls()` — replace with `transitions: bundler.getTransitions()`
5. **Lines in `flushPending()`:** Currently calls `graph.recordUrl(source, url)` — DELETE these calls
6. **Lines in `ingestSignal()`:** Currently calls `graph.recordUrl(source, url)` — DELETE these calls
7. **Return object:** Remove `getEdges`/`drainEdges`, add `getTransitions`/`drainTransitions`/`seal`

## Detailed changes

### 1. Fix imports

Remove:
```typescript
import { createGraph } from "./graph.ts";
```

No new imports needed — `Transition` is only used through the bundler's return type.

### 2. Remove graph creation, fix bundler call

Remove:
```typescript
const graph = createGraph();
const bundler = createBundler(graph);
```

Replace with:
```typescript
const bundler = createBundler();
```

### 3. Update `emitState()`

The current `emitState()` logs `edges` and `urls` from the graph. Replace those with `transitions` from the bundler.

Change the data object in `emitState()` from:
```typescript
edges: graph.getEdges(),
urls: graph.getUrls(),
```
to:
```typescript
transitions: bundler.getTransitions(),
```

### 4. Remove `graph.recordUrl()` calls

In `flushPending()`, remove:
```typescript
const url = signalPageUrl(p.signal);
if (url) graph.recordUrl(source, url);
```

In `ingestSignal()`, remove:
```typescript
const url = signalPageUrl(signal);
if (url) graph.recordUrl(source, url);
```

Also remove the `signalPageUrl()` helper function at the top of the file — it is no longer used anywhere.

### 5. Update the return object

Change from:
```typescript
return {
    ingest,
    ingestSignal,
    onVisibilityChanged,
    getSealed: bundler.getSealed,
    getEdges: graph.getEdges,
    drainSealed: bundler.drainSealed,
    drainEdges: () => {
        bundler.commitPending();
        return graph.drainEdges();
    },
};
```

to:
```typescript
return {
    ingest,
    ingestSignal,
    onVisibilityChanged,
    getSealed: bundler.getSealed,
    drainSealed: bundler.drainSealed,
    getTransitions: bundler.getTransitions,
    drainTransitions: bundler.drainTransitions,
    seal: bundler.seal,
};
```

**Note:** The current `drainEdges` wrapper calls `bundler.commitPending()` before `graph.drainEdges()`. When removing both, this implicit dependency is gone — the new transition log has no pending state to commit.

## What the `emitState()` data shape becomes

Before (actual current code):
```typescript
{
    activeSource: bundler.getActiveSource(),
    openBundle: bundler.getOpenBundle(),   // includes captures: { type, timestamp }[]
    sealedBundles: bundler.getSealed().map((b) => ({
        source: b.source,
        startedAt: b.startedAt,
        endedAt: b.endedAt,
        captureCount: b.captures.length,
        text: b.text,
        captures: b.captures.map((c) => ({
            type: c.type,
            timestamp: c.timestamp,
        })),
    })),
    edges: graph.getEdges(),     // Edge[]
    urls: graph.getUrls(),       // Record<string, string>
}
```

After (replace `edges`/`urls` with `transitions`, preserve captures):
```typescript
{
    activeSource: bundler.getActiveSource(),
    openBundle: bundler.getOpenBundle(),   // includes captures: { type, timestamp }[]
    sealedBundles: bundler.getSealed().map((b) => ({
        source: b.source,
        startedAt: b.startedAt,
        endedAt: b.endedAt,
        captureCount: b.captures.length,
        text: b.text,
        captures: b.captures.map((c) => ({
            type: c.type,
            timestamp: c.timestamp,
        })),
    })),
    transitions: bundler.getTransitions(),  // Transition[]
}
```

This changes the `DevStateSnapshot` shape, which is addressed in step 4 (DevHub).

## What will break

After this step:
- `src/event/dev.ts` — `DevStateSnapshot` type still expects `edges` and `urls` fields. The `emitState()` call will have a type mismatch. Fixed in step 4.
- `src/dev/panels/GraphView.tsx` — Listens for `channel === "graph"` events that `graph.ts` used to emit. Those events no longer fire. Fixed in step 4.
- `src/dev/panels/StateInspector.tsx` — Reads `snapshot.edges`. Fixed in step 4.

**Note:** `graph.ts` is NOT deleted yet — it still exists as a file but nothing imports it. It will be deleted in step 8.

## Verification

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: errors in `dev.ts` (DevStateSnapshot shape mismatch) and dev panel components. No errors in `index.ts`, `bundler.ts`, or `types.ts`.

Verify `graph.ts` is no longer imported:
```bash
grep -r "from.*graph" src/aggregation/
```

Should return zero results from `index.ts` and `bundler.ts`. The file `graph.ts` itself still exists but is orphaned.

## Documentation update

After completing this step, update `.architecture/packer.md`:

In the **File map** table, change the `index.ts` row to:
```
| [`src/aggregation/index.ts`](../src/aggregation/index.ts) | `createAggregator()` — **Implemented.** Facade exposing `getTransitions`/`drainTransitions`/`seal`. No longer depends on `graph.ts`. |
```
