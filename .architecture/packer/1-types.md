# Step 1: Add new types to `types.ts`

## Goal

Add all new type definitions needed by the packer system. This is the foundation — every subsequent step imports from this file.

## File to modify

`src/aggregation/types.ts`

## Current contents (before this step)

```typescript
import type { Capture, Signal } from "../event/types.ts";

export const UNKNOWN = "unknown" as const;
export const OFF_BROWSER = "off_browser" as const;

export type StampedCapture = Capture & { tabId: string; source: string };
export type StampedSignal = Signal & { tabId: string; source: string };
export type BundleEntry = StampedCapture | StampedSignal;

export type Bundle = {
    source: string;
    startedAt: number;
    endedAt: number | null;
    captures: BundleEntry[];
    text: string | null;
};

export type Edge = {
    from: string;
    to: string;
    weight: number;
};

export type Aggregator = {
    ingest(capture: Capture, tabId: string): void;
    ingestSignal(signal: Signal, tabId: string): void;
    onTabActivated(tabId: string, windowId: number): void;
    onWindowFocusChanged(windowId: number): void;
    getSealed(): Bundle[];
    getEdges(): Edge[];
    drainSealed(): Bundle[];
    drainEdges(): Edge[];
};
```

## Changes

### 1. Add `Transition` type

Add immediately after the `Edge` type:

```typescript
/** Raw transition record. Logged by the bundler on every source change. */
export type Transition = {
    from: string;
    to: string;
    ts: number;
    dwellMs: number;
};
```

### 2. Add `DirectedGraph` type

```typescript
export type DirectedGraph = {
    nodes: Set<string>;
    /** Key: "from\0to", value: aggregated weight (transition count). */
    edges: Map<string, number>;
    inDegree: Map<string, number>;
    outDegree: Map<string, number>;
    totalWeight: number;
};
```

### 3. Add `LouvainResult` type

```typescript
export type LouvainResult = {
    /** source (or chunk ID) → community ID */
    communities: Map<string, string>;
    modularity: number;
};
```

### 4. Add `ChunkInfo` and `PreprocessResult` types

```typescript
export type ChunkInfo = {
    originalSource: string;
    chunkIndex: number;
    windowStartMs: number;
    /** Dynamic window size computed for this hub. */
    chunkWindowMs: number;
};

export type PreprocessResult = {
    transitions: Transition[];
    excludedSources: Set<string>;
    sentinelCount: number;
    /** hub chunk ID → chunk metadata */
    chunkMap: Map<string, ChunkInfo>;
    hubSources: Set<string>;
};
```

### 5. Add `GroupMeta`, `Group`, `Packet` types

```typescript
export type GroupMeta = {
    sources: string[];
    tabs: string[];
    timeRange: { start: number; end: number };
};

export type Group = {
    id: string;
    bundles: Bundle[];
    text: string;
    meta: GroupMeta;
};

export type Packet = {
    id: string;
    groups: Group[];
    edges: Edge[];
    createdAt: number;
};
```

### 6. Update `Aggregator` interface

Replace the existing `Aggregator` type with:

```typescript
export type Aggregator = {
    ingest(capture: Capture, tabId: string): void;
    ingestSignal(signal: Signal, tabId: string): void;
    onTabActivated(tabId: string, windowId: number): void;
    onWindowFocusChanged(windowId: number): void;

    getSealed(): Bundle[];
    drainSealed(): Bundle[];

    /** Non-destructive read of the raw transition log. */
    getTransitions(): Transition[];
    /** Destructive read — returns all transitions and clears the log. */
    drainTransitions(): Transition[];

    /** Seal the current open bundle (if any). Used by the packer before draining. */
    seal(): void;
};
```

**Key changes to `Aggregator`:**
- REMOVED: `getEdges(): Edge[]`
- REMOVED: `drainEdges(): Edge[]`
- ADDED: `getTransitions(): Transition[]`
- ADDED: `drainTransitions(): Transition[]`
- ADDED: `seal(): void`

## Expected final file

After this step, `types.ts` should contain (in order):
1. Imports from `../event/types.ts`
2. `UNKNOWN` and `OFF_BROWSER` constants
3. `StampedCapture`, `StampedSignal`, `BundleEntry`
4. `Bundle`
5. `Edge`
6. `Transition`
7. `DirectedGraph`
8. `LouvainResult`
9. `ChunkInfo`, `PreprocessResult`
10. `GroupMeta`, `Group`, `Packet`
11. `Aggregator`

## What will break

After this step, `tsc --noEmit` will report errors because:
- `src/aggregation/index.ts` still references `getEdges` and `drainEdges` on the Aggregator return type
- `src/aggregation/index.ts` does not yet expose `getTransitions`, `drainTransitions`, or `seal`

These are expected and will be fixed in steps 2 and 3. To verify this step in isolation, temporarily check that the types file itself has no syntax errors by examining the tsc output — the errors should all be in `index.ts`, not in `types.ts`.

## Verification

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: errors only in `index.ts` (referencing removed `getEdges`/`drainEdges` and missing `getTransitions`/`drainTransitions`/`seal`). No errors originating from `types.ts` itself.

## Documentation update

After completing this step, update `.architecture/packer.md`:

In the **File map** table, change the `types.ts` row from:
```
| [`src/aggregation/types.ts`](../src/aggregation/types.ts) | `Bundle`, `Transition`, `Edge`, `Group`, `GroupMeta`, `Packet`, `DirectedGraph`, `LouvainResult` definitions |
```
to:
```
| [`src/aggregation/types.ts`](../src/aggregation/types.ts) | All type definitions. **Implemented.** Contains `Bundle`, `Edge`, `Transition`, `DirectedGraph`, `LouvainResult`, `ChunkInfo`, `PreprocessResult`, `GroupMeta`, `Group`, `Packet`, `Aggregator` |
```
