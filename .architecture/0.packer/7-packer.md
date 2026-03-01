# Step 7: Create `packer.ts`

## Goal

Create `src/aggregation/packer.ts` — the packer module that ties together preprocessing, graph construction, Louvain, bundle assignment, and Packet assembly.

## Prerequisites

Steps 1–6 complete. All types exist, `preprocess()` and `buildDirectedGraph()`/`directedLouvain()` are implemented.

## File to create

`src/aggregation/packer.ts`

## Specification reference

`.architecture/packer.md` sections:
- "Operations → `flush(): Packet`" — the entry point flow
- "Operations → `partitionIntoGroups`" — the partition pipeline
- "Bundle assignment" — the 4-path assignment logic
- "GroupMeta computation" — mechanical derivation from bundles
- "Group text assembly" — join bundle.text values
- "Implementation specification → `src/aggregation/packer.ts`" — function signatures

## Imports

```typescript
import type {
    Aggregator, Bundle, Edge, Transition,
    Group, GroupMeta, Packet, PreprocessResult,
    LouvainResult, ChunkInfo,
} from "./types.ts";
import { preprocess } from "./preprocess.ts";
import { buildDirectedGraph, directedLouvain } from "./directed-louvain.ts";
import { dev } from "../event/dev.ts";
```

## Exported function: `createPacker`

```typescript
export function createPacker(aggregator: Aggregator): { flush(): Packet | null }
```

The packer is stateless — it reads from the aggregator on each flush call.

### `flush()` implementation

```typescript
function flush(): Packet | null {
    // 1. Seal any in-flight bundle so no data is lost
    aggregator.seal();

    // 2. Drain all accumulated data (destructive reads)
    const bundles = aggregator.drainSealed();
    const transitions = aggregator.drainTransitions();

    // 3. Nothing to pack
    if (bundles.length === 0) return null;

    // 4. Partition bundles into groups
    const { groups, edges } = partitionIntoGroups(transitions, bundles);

    // 5. Assemble the Packet
    const packet: Packet = {
        id: crypto.randomUUID(),
        groups,
        edges,
        createdAt: Date.now(),
    };

    dev.log("aggregator", "pack.flushed", `packet ${packet.id}`, {
        groups: groups.length,
        bundles: bundles.length,
        edges: edges.length,
        packetId: packet.id,
    });

    return packet;
}
```

## Internal function: `partitionIntoGroups`

```typescript
function partitionIntoGroups(
    transitions: Transition[],
    bundles: Bundle[],
): { groups: Group[]; edges: Edge[] }
```

### Implementation

```typescript
function partitionIntoGroups(
    transitions: Transition[],
    bundles: Bundle[],
): { groups: Group[]; edges: Edge[] } {
    // If no transitions, every bundle is a singleton group
    if (transitions.length === 0) {
        const groups = bundles.map(b => makeGroup(crypto.randomUUID(), [b]));
        return { groups, edges: [] };
    }

    // 1. Preprocess transitions
    const preprocessResult = preprocess(transitions);

    // 2. Build directed graph from preprocessed transitions
    const graph = buildDirectedGraph(preprocessResult.transitions);

    // 3. Run Louvain community detection
    const louvain = directedLouvain(graph);

    // 4. Assign bundles to communities
    const bundleGroups = assignBundles(louvain, bundles, preprocessResult);

    // 5. Build Group objects
    const groups: Group[] = [];
    for (const [groupKey, groupBundles] of bundleGroups) {
        groups.push(makeGroup(groupKey, groupBundles));
    }

    // 6. Extract edges for the Packet payload
    const edges = graphToEdges(graph);

    return { groups, edges };
}
```

## Internal function: `assignBundles`

```typescript
function assignBundles(
    louvain: LouvainResult,
    bundles: Bundle[],
    pr: PreprocessResult,
): Map<string, Bundle[]>
```

### Implementation

For each bundle, determine which group it belongs to:

```typescript
function assignBundles(
    louvain: LouvainResult,
    bundles: Bundle[],
    pr: PreprocessResult,
): Map<string, Bundle[]> {
    const groups = new Map<string, Bundle[]>();

    // Pre-compute: for each hub source, find its baseTs and chunkWindowMs
    // by scanning the chunkMap entries
    const hubMeta = new Map<string, { baseTs: number; chunkWindowMs: number }>();
    for (const [chunkId, info] of pr.chunkMap) {
        if (!hubMeta.has(info.originalSource)) {
            hubMeta.set(info.originalSource, {
                baseTs: info.windowStartMs,  // chunk 0's windowStartMs IS the baseTs
                chunkWindowMs: info.chunkWindowMs,
            });
        } else {
            // Update baseTs to the minimum windowStartMs
            const existing = hubMeta.get(info.originalSource)!;
            if (info.windowStartMs < existing.baseTs) {
                existing.baseTs = info.windowStartMs;
            }
        }
    }

    for (const bundle of bundles) {
        let groupKey: string;

        if (pr.excludedSources.has(bundle.source)) {
            // Path 1: Transient source → singleton
            groupKey = `singleton:${bundle.source}`;

        } else if (pr.hubSources.has(bundle.source)) {
            // Path 2: Hub source → find chunk by startedAt
            const meta = hubMeta.get(bundle.source);
            if (meta && bundle.startedAt !== null) {
                const chunkIndex = Math.floor(
                    (bundle.startedAt - meta.baseTs) / meta.chunkWindowMs
                );
                const chunkId = `hub:${bundle.source}:${chunkIndex}`;
                const community = louvain.communities.get(chunkId);
                groupKey = community ?? `singleton:${bundle.source}`;
            } else {
                groupKey = `singleton:${bundle.source}`;
            }

        } else if (louvain.communities.has(bundle.source)) {
            // Path 3: Normal source with a community
            groupKey = louvain.communities.get(bundle.source)!;

        } else {
            // Path 4: Isolated source (no transitions)
            groupKey = `singleton:${bundle.source}`;
        }

        let group = groups.get(groupKey);
        if (!group) {
            group = [];
            groups.set(groupKey, group);
        }
        group.push(bundle);
    }

    return groups;
}
```

## Internal function: `makeGroup`

Helper that constructs a `Group` from a key and bundle array:

```typescript
function makeGroup(id: string, bundles: Bundle[]): Group {
    // Sort bundles chronologically
    const sorted = [...bundles].sort((a, b) => a.startedAt - b.startedAt);

    return {
        id,
        bundles: sorted,
        text: sorted
            .map(b => b.text ?? "")
            .filter(t => t.length > 0)
            .join("\n"),
        meta: computeMeta(sorted),
    };
}
```

## Internal function: `computeMeta`

```typescript
function computeMeta(bundles: Bundle[]): GroupMeta {
    const sources = [...new Set(bundles.map(b => b.source))];
    const tabs = [...new Set(bundles.map(b => {
        // Extract tabId from source string "context@tabId"
        const atIndex = b.source.lastIndexOf("@");
        return atIndex !== -1 ? b.source.slice(atIndex + 1) : b.source;
    }))];

    const starts = bundles.map(b => b.startedAt);
    const ends = bundles
        .map(b => b.endedAt)
        .filter((e): e is number => e !== null);

    return {
        sources,
        tabs,
        timeRange: {
            start: Math.min(...starts),
            end: ends.length > 0 ? Math.max(...ends) : Math.max(...starts),
        },
    };
}
```

## Internal function: `graphToEdges`

```typescript
function graphToEdges(graph: import("./types.ts").DirectedGraph): Edge[] {
    const edges: Edge[] = [];
    for (const [key, weight] of graph.edges) {
        const sepIndex = key.indexOf("\0");
        const from = key.slice(0, sepIndex);
        const to = key.slice(sepIndex + 1);
        edges.push({ from, to, weight });
    }
    return edges;
}
```

**Note:** Use the `DirectedGraph` type from the import. The function parameter type can use the inline import or you can add `DirectedGraph` to the existing import at the top of the file.

## Complete file structure

```typescript
import type { ... } from "./types.ts";
import { preprocess } from "./preprocess.ts";
import { buildDirectedGraph, directedLouvain } from "./directed-louvain.ts";
import { dev } from "../event/dev.ts";

export function createPacker(aggregator: Aggregator): { flush(): Packet | null } {

    function flush(): Packet | null {
        // ... as above
    }

    return { flush };
}

// --- internal helpers (not exported) ---

function partitionIntoGroups(...) { ... }
function assignBundles(...) { ... }
function makeGroup(...) { ... }
function computeMeta(...) { ... }
function graphToEdges(...) { ... }
```

Note: the internal helpers are module-level functions, not inside `createPacker`. They don't need access to the aggregator closure — they operate on the data passed to them.

## Edge cases

- **0 bundles:** `flush()` returns `null`
- **Bundles but 0 transitions:** Every bundle becomes a singleton group. `edges` is empty.
- **1 bundle, 0 transitions:** Single singleton group.
- **All bundles from same source, many transitions:** All bundles in one group (Louvain puts the source in one community).
- **Hub source with bundles that don't match any chunk:** Falls through to singleton. This shouldn't happen in practice but handles it gracefully.

## Verification

```bash
npx tsc --noEmit   # zero errors
npx vite build     # clean build
```

The file compiles cleanly. It imports from `preprocess.ts` and `directed-louvain.ts` which were created in steps 5 and 6.

## Documentation update

After completing this step, update `.architecture/packer.md`:

In the **File map** table, change the `packer.ts` row to:
```
| `src/aggregation/packer.ts` | `createPacker(aggregator)` — **Implemented.** `flush()` drains aggregator, runs preprocess → buildDirectedGraph → directedLouvain → assignBundles → assemble Packet. |
```
