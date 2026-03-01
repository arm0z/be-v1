# Step 4: Update DevHub for transition-based data

## Goal

Migrate the DevHub (dev logging, GraphView, StateInspector) from consuming pre-aggregated `Edge[]` to consuming raw `Transition[]`. After this step, `tsc` and `vite build` must pass cleanly with zero errors.

## Prerequisites

Steps 1–3 complete. The aggregator's `emitState()` now logs `transitions: Transition[]` instead of `edges: Edge[]` and `urls: Record<string, string>`.

## Files to modify

1. `src/event/dev.ts` — update `DevStateSnapshot` type
2. `src/dev/panels/GraphView.tsx` — rebuild to consume transitions instead of graph events
3. `src/dev/panels/StateInspector.tsx` — update snapshot rendering

## File 1: `src/event/dev.ts`

### Current `DevStateSnapshot` type

```typescript
export type DevCaptureSummary = { type: string; timestamp: number };

export type DevStateSnapshot = {
    activeSource: string | null;
    openBundle: {
        source: string;
        startedAt: number;
        captureCount: number;
        captures: DevCaptureSummary[];
    } | null;
    sealedBundles: {
        source: string;
        startedAt: number;
        endedAt: number | null;
        captureCount: number;
        text: string | null;
        captures: DevCaptureSummary[];
    }[];
    edges: { from: string; to: string; weight: number }[];
    urls: Record<string, string>;
};
```

### Change

Replace the `edges` and `urls` fields with `transitions`. Preserve captures arrays:

```typescript
export type DevStateSnapshot = {
    activeSource: string | null;
    openBundle: {
        source: string;
        startedAt: number;
        captureCount: number;
        captures: DevCaptureSummary[];
    } | null;
    sealedBundles: {
        source: string;
        startedAt: number;
        endedAt: number | null;
        captureCount: number;
        text: string | null;
        captures: DevCaptureSummary[];
    }[];
    transitions: { from: string; to: string; ts: number; dwellMs: number }[];
};
```

## File 2: `src/dev/panels/GraphView.tsx`

### Current behavior

GraphView currently rebuilds its graph state by listening to individual dev events:
- `entry.channel === "graph"` with `entry.event === "edge.created"` or `"edge.incremented"`
- `entry.channel === "graph"` with `entry.event === "url.updated"`

These events were emitted by `graph.ts` on each `recordEdge()` and `recordUrl()` call. Since `graph.ts` is no longer used, these events no longer fire.

### New behavior

GraphView should rebuild its graph from the `transitions` array in the latest `state.snapshot` dev entry. On each snapshot update:

1. Read `snapshot.transitions` (the full transition log)
2. Aggregate transitions into edges: for each transition `{ from, to }`, increment `edgeMap["from\0to"]`
3. Extract unique nodes from transition `from` and `to` fields
4. Update the node/edge state used for rendering

### Implementation approach

The key change is to **replace the incremental event-based graph building** with **full rebuild from snapshot transitions**. This is simpler and more correct — no risk of the dev UI state diverging from the aggregator state.

Find the code that processes `entry.channel === "graph"` events and replace it. The graph should be rebuilt whenever a new `state.snapshot` entry arrives.

**Edge aggregation logic** (replaces the old event handler):

```typescript
function aggregateEdges(transitions: { from: string; to: string; ts: number; dwellMs: number }[]): Map<string, { from: string; to: string; weight: number }> {
    const edges = new Map<string, { from: string; to: string; weight: number }>();
    for (const t of transitions) {
        const key = `${t.from}\0${t.to}`;
        const existing = edges.get(key);
        if (existing) {
            existing.weight++;
        } else {
            edges.set(key, { from: t.from, to: t.to, weight: 1 });
        }
    }
    return edges;
}
```

**Node extraction:**
```typescript
function extractNodes(transitions: { from: string; to: string }[]): Set<string> {
    const nodes = new Set<string>();
    for (const t of transitions) {
        nodes.add(t.from);
        nodes.add(t.to);
    }
    return nodes;
}
```

### URL tracking

The old graph tracked `urls` via `recordUrl()`. This data is no longer available through the graph. If the GraphView uses URLs for node labels or tooltips, there are two options:

1. **Remove URL display** — simplest, the GraphView can show source IDs only
2. **Extract URLs from snapshot** — if the snapshot needs URLs, they can be added back to the DevStateSnapshot later

For now, **remove URL references** from GraphView. The source ID (e.g. `root@42`) is sufficient for debugging.

### What to look for in the existing code

- `urlsRef` — remove or repurpose
- `entry.channel === "graph"` checks — remove entirely
- `entry.event === "edge.created"` / `"edge.incremented"` / `"url.updated"` — remove
- Any place that reads `entry.data.from`, `entry.data.to`, `entry.data.weight` from graph events — replace with snapshot-based rebuild

### Important: preserve the force-directed layout

The force-directed simulation (charge repulsion, spring attraction, damping) is independent of how edges are sourced. Do NOT change the physics/rendering code. Only change how the edge/node data is populated.

## File 3: `src/dev/panels/StateInspector.tsx`

### Current behavior

StateInspector reads `snapshot.edges` to display edges in the "Grouped" view. It also reads `snapshot.urls`.

### Change

Replace `snapshot.edges` references with `snapshot.transitions`. The display should show transitions instead of pre-aggregated edges.

Find where `snapshot.edges` is rendered (likely a `.map()` producing table rows or list items) and replace with `snapshot.transitions`. Each transition has `{ from, to, ts, dwellMs }` instead of `{ from, to, weight }`.

Display format suggestion:
```
from → to  (dwell: Xms, at: HH:MM:SS)
```

Replace any `snapshot.urls` references — remove them or replace with a note that URLs are no longer tracked at this level.

## Verification

This is the critical step — after this, the full build must pass:

```bash
npx tsc --noEmit   # zero errors
npx vite build     # clean build
```

Also verify manually:
1. Load the extension in Chrome
2. Open the DevHub page
3. Switch between tabs — verify transitions appear in the StateInspector
4. Verify the GraphView renders nodes and edges (rebuilt from transitions)

## Documentation update

After completing this step, update `.architecture/packer.md`:

In the **"Removing `createGraph()`"** section (near the end of the Implementation specification), change the text to:

```markdown
### Removing `createGraph()`

`createGraph()` and `graph.ts` are deleted (step 8). The bundler records only into the transition log. `getEdges`/`drainEdges` are removed from the `Aggregator` interface.

The DevHub graph view (`GraphView.tsx`) rebuilds edges on-the-fly from `snapshot.transitions` in each state snapshot. It aggregates transitions into weighted edges for the force-directed layout. Since the snapshot uses the non-destructive `getTransitions()`, the DevHub does not interfere with the packer's `drainTransitions()` at flush time. **Implemented in step 4.**
```
