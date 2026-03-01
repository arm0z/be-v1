# Step 8: Integration — wire packer into main.ts, delete graph.ts, final cleanup

## Goal

1. Create the packer instance in `main.ts` and wire up a flush trigger
2. Delete `graph.ts` (now fully orphaned)
3. Final verification: clean build, no dead imports, no references to deleted code

## Prerequisites

Steps 1–7 complete. All modules exist and compile individually.

## File changes

### 1. `src/background/main.ts` — create packer and wire flush

#### Add import

Add near the top of the file, after the existing aggregator import:

```typescript
import { createPacker } from "../aggregation/packer.ts";
```

#### Create packer instance

After the line that creates the aggregator:

```typescript
const aggregator = createAggregator();
```

Add:

```typescript
const packer = createPacker(aggregator);
```

#### Add flush trigger

The packer's `flush()` should be called periodically. Add a `chrome.alarms` based trigger. Place this after the aggregator seeding code (the `chrome.windows.getAll` block):

```typescript
// ── Packer flush trigger ────────────────────────────────────
chrome.alarms.create("packer-flush", { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "packer-flush") return;
    const packet = packer.flush();
    if (packet) {
        dev.log("sync", "packet.ready", `packet ${packet.id} ready (${packet.groups.length} groups)`, {
            packetId: packet.id,
            groups: packet.groups.length,
            edges: packet.edges.length,
        });
        // TODO: pass packet to syncing layer once implemented
        // await sync(packet);
    }
});
```

**Note:** The actual syncing layer (`sync(packet)`) doesn't exist yet. For now, the flush produces the packet and logs it. The TODO comment marks where the sync call will go.

#### Optional: add manual flush via dev message

For testing during development, add a way to trigger flush from the DevHub:

```typescript
// Manual flush via dev message (dev mode only)
if (import.meta.env.DEV) {
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "dev:flush") {
            const packet = packer.flush();
            dev.log("sync", "packet.manual-flush", packet ? `packet ${packet.id}` : "nothing to flush", {
                packet: packet ?? null,
            });
        }
    });
}
```

### 2. Delete `src/aggregation/graph.ts`

Delete the file entirely. It is no longer imported by anything.

**Before deleting, verify it's truly orphaned:**

```bash
grep -r "from.*[./]graph" src/
grep -r "graph\.ts" src/
```

Both should return zero results (after steps 2–4 removed all references).

### 3. Verify no dead references remain

Search for any remaining references to the old graph API:

```bash
grep -r "getEdges\|drainEdges\|recordEdge\|recordUrl\|createGraph" src/
```

Should return zero results.

Search for any remaining references to the old DevStateSnapshot fields:

```bash
grep -r "snapshot\.edges\|snapshot\.urls" src/
```

Should return zero results (fixed in step 4).

### 4. Add `"sync"` to dev channel type

If `src/event/dev.ts` defines a `DevChannel` union type for valid channel names, add `"sync"` to it so the packer's dev logs compile:

```typescript
export type DevChannel = "tap" | "adapter" | "normalizer" | "relay" | "aggregator" | "graph" | "sync" | "persistence";
```

**Note:** The `"graph"` channel can be kept or removed. If `GraphView.tsx` no longer listens for `channel === "graph"` events (it shouldn't after step 4), it can be removed. But keeping it is harmless.

### 5. Update `Aggregator` type exports check

Verify that the `Aggregator` type in `types.ts` matches what `createAggregator()` actually returns. The return object should have exactly these methods:
- `ingest`
- `ingestSignal`
- `onTabActivated`
- `onWindowFocusChanged`
- `getSealed`
- `drainSealed`
- `getTransitions`
- `drainTransitions`
- `seal`

No `getEdges`, no `drainEdges`.

## Verification

### Type check and build

```bash
npx tsc --noEmit   # zero errors
npx vite build     # clean build
```

### Dead code check

```bash
# Verify graph.ts is deleted
ls src/aggregation/graph.ts 2>&1  # should say "No such file"

# Verify no imports of deleted file
grep -r "graph\.ts" src/  # zero results

# Verify no references to old API
grep -r "getEdges\|drainEdges\|recordEdge\|recordUrl\|createGraph" src/  # zero results
```

### Functional test

1. Load the extension in Chrome
2. Browse a few tabs, switch between them
3. Open DevHub — verify:
   - StateInspector shows transitions (not edges)
   - GraphView renders a force-directed graph from transitions
   - No console errors
4. Wait 5 minutes (or trigger manual flush in dev mode) — verify:
   - `pack.flushed` event appears in DevHub logs
   - Packet contains groups, edges, and metadata
5. Switch between browser windows — verify:
   - Off-browser debounce still works (from the earlier implementation)
   - Transitions are recorded with correct timing

## Documentation update

After completing this step, update `.architecture/packer.md`:

### Update the File map table

Replace the entire file map with the final state:

```markdown
## File map

| File | Role |
|------|------|
| [`src/aggregation/packer.ts`](../src/aggregation/packer.ts) | `createPacker(aggregator)` — `flush()`, `partitionIntoGroups()`, bundle assignment. **Implemented.** |
| [`src/aggregation/preprocess.ts`](../src/aggregation/preprocess.ts) | `preprocess()` — off-browser splitting, transient removal, hub detection, dynamic temporal chunking. **Implemented.** |
| [`src/aggregation/directed-louvain.ts`](../src/aggregation/directed-louvain.ts) | `buildDirectedGraph()` + `directedLouvain()` — graph construction and two-phase Directed Louvain. **Implemented.** |
| [`src/aggregation/index.ts`](../src/aggregation/index.ts) | `createAggregator()` — facade exposing transition log via `getTransitions`/`drainTransitions`/`seal`. **Implemented.** |
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts) | `createBundler()` — produces sealed Bundles, logs `Transition` records on each source change. **Implemented.** |
| [`src/aggregation/translate.ts`](../src/aggregation/translate.ts) | `translate(bundle)` — called at seal time by the bundler. Unchanged. |
| [`src/aggregation/types.ts`](../src/aggregation/types.ts) | All type definitions: `Bundle`, `Edge`, `Transition`, `DirectedGraph`, `LouvainResult`, `ChunkInfo`, `PreprocessResult`, `GroupMeta`, `Group`, `Packet`, `Aggregator`. **Implemented.** |
| [`src/background/main.ts`](../src/background/main.ts) | Creates aggregator + packer, registers Chrome listeners, 5-minute flush alarm. **Implemented.** |
```

### Remove the "Aggregator assumption" section

The section starting with `> **The aggregator must be rewritten.**` is no longer an assumption — it's done. Remove or replace it with:

```markdown
### Data flow

The aggregator logs raw `Transition` records on every source change. The packer drains these at flush time, preprocesses them, builds a directed graph, and runs Louvain for community detection. This replaces the old `createGraph()` approach that pre-aggregated transitions into `Edge { from, to, weight }`.
```

### Mark the Implementation specification section

Add a note at the top of the "Implementation specification" section:

```markdown
> **Status: Fully implemented.** All interfaces, functions, and modules described below exist in the codebase. This section serves as a reference for the implemented API.
```
