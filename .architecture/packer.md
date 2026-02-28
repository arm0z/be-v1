# Packer

The Packer is the final stage of the Aggregation Layer. It consumes sealed Bundles and navigation graph edges from the Bundler and Graph, partitions sources into Groups, and assembles Packets for delivery to the Syncing Layer.

## Where it sits

```text
Service Worker
──────────────
  ┌─ Aggregation Layer ────────────────────────────────────────────┐
  │                                                                │
  │   ┌──────────┐         ┌──────────┐                            │
  │   │ Bundler  │         │  Graph   │                            │
  │   │          │         │          │                            │
  │   │ sealed[] ├────┐    │ edges[]  ├────┐                       │
  │   └──────────┘    │    └──────────┘    │                       │
  │                   │                    │                       │
  │                   ▼                    ▼                       │
  │             ┌───────────────────────────────┐                  │
  │             │           Packer              │                  │
  │             │                               │                  │
  │             │  1. drain sealed bundles      │                  │
  │             │  2. drain edges               │                  │
  │             │  3. partition → Groups        │                  │
  │             │  4. assign bundles → Groups   │                  │
  │             │  5. compute GroupMeta         │                  │
  │             │  6. translate group text      │                  │
  │             │  7. assemble Packet           │                  │
  │             │                               │                  │
  │             └──────────────┬────────────────┘                  │
  │                            │                                   │
  └────────────────────────────┼───────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Syncing Layer     │
                    │   sync(packet)      │
                    └─────────────────────┘
```

The Packer has no knowledge of Chrome APIs, Captures, or the DOM. It only operates on sealed Bundles (which already have `text` populated by `translate()`) and Edges (directed, weighted connections between sources).

## Types

```typescript
type Group = {
  id: string;            // unique identifier for the group
  bundles: Bundle[];     // sealed bundles assigned to this group
  text: string;          // combined narrative from translate(bundles)
  meta: GroupMeta;       // computed summary of the group's contents
};

type GroupMeta = {
  sources: string[];     // unique source ids in this group (e.g. ["root@42", "root@17"])
  tabs: string[];        // unique tabIds across all bundles (e.g. ["42", "17"])
  timeRange: {
    start: number;       // earliest bundle.startedAt
    end: number;         // latest bundle.endedAt
  };
};

type Packet = {
  id: string;            // UUID, generated at assembly time
  groups: Group[];       // the groups and their bundles
  edges: Edge[];         // the full navigation graph for this flush window
  createdAt: number;     // Date.now() at assembly time
};
```

## Operations

### `flush(): Packet`

The single entry point. Called by whoever decides it's time to sync — a timer, an event count threshold, a manual trigger, or the persistence layer during recovery.

```bash
flush()
  │
  ├─ seal current bundle (if any)
  │     via aggregator — ensures no in-flight data is lost
  │
  ├─ bundles = drainSealed()
  │     consumes all sealed bundles from the Bundler
  │
  ├─ edges = drainEdges()
  │     consumes all edges from the Graph
  │
  ├─ bundles is empty?
  │     YES → return null (nothing to send)
  │
  ├─ groups = partitionIntoGroups(edges, bundles)
  │     community detection over the navigation graph
  │     assigns each source to a group
  │     maps bundles to their source's group
  │
  ├─ for each group:
  │     compute GroupMeta
  │     translate bundles into group.text
  │
  └─ return Packet { id, groups, edges, createdAt }
```

Both `drainSealed()` and `drainEdges()` are destructive reads — they return the data and clear the internal arrays. This means each Packet contains exactly the Bundles and Edges accumulated since the last flush. No data is shared between Packets.

### `partitionIntoGroups(edges, bundles): Group[]`

The full pipeline: reconstruct transitions, pre-process, build graph, run directed Louvain, assign bundles to communities.

```bash
partitionIntoGroups(edges, bundles)
  │
  ├─ transitions = reconstructTransitions(bundles)
  │     derives timestamped transitions from bundle order
  │
  ├─ { filtered, excludedSources, chunkMap } = preprocess(transitions)
  │     unknown removal → transient removal → hub chunking
  │
  ├─ graph = buildDirectedGraph(filtered)
  │     nodes + weighted edges + in/out degree
  │
  ├─ communities = directedLouvain(graph)
  │     Map<source, communityId>
  │
  ├─ assign each bundle to a community:
  │     community-grouped | hub-chunked | singleton
  │
  ├─ create Group for each community
  │     │
  │     ├─ filter bundles where bundle.source ∈ community
  │     ├─ compute GroupMeta from those bundles
  │     └─ translate(bundles) → group.text
  │
  └─ return Group[]
```

Sources that appear in bundles but have no edges (isolated sources — e.g. a tab the user opened but never switched away from before flush) become singleton groups.

---

## Graph Partitioning Algorithm

Based on "Graph-Structure-Based Grouping of Web Browser Tabs into Tasks" (Hisatomi & Tajima, UIST Adjunct '25, DOI: 10.1145/3746058.3758439). Adapted for Hourglass's data model.

**Core idea:** Build a directed weighted graph where nodes are sources and edges are transitions (focus shifts). Apply the Directed Louvain community detection algorithm to find clusters. Sources that are frequently switched between form communities — these communities are the task groups.

**Why this fits:**

- **Privacy-preserving** — grouping uses only the navigation graph structure (which sources transition to which). No page content, URLs, or titles are needed for the grouping itself.
- **No training data** — unsupervised, no manual annotation.
- **We already capture the signal** — the Bundler records every focus shift, and the Graph stores every source-to-source transition.

### Transition reconstruction

The `Edge { from, to, weight }` type stores aggregated weights but no timestamps. The ordered `sealed[]` array gives us the full transition sequence with timing:

```bash
sealed = [
  Bundle("root@42", 10:32:00–10:32:30),
  Bundle("root@17", 10:32:31–10:33:15),
  Bundle("root@42", 10:33:16–10:34:00),
  Bundle("root@5",  10:34:05–10:35:00),
]

reconstructTransitions(bundles):
  → { from: "root@42", to: "root@17", ts: 10:32:31, dwellMs: 30000 }
  → { from: "root@17", to: "root@42", ts: 10:33:16, dwellMs: 44000 }
  → { from: "root@42", to: "root@5",  ts: 10:34:05, dwellMs: 44000 }
```

Each consecutive pair of bundles `[i]` and `[i+1]` implies a transition:
- `from` = `bundles[i].source`
- `to` = `bundles[i+1].source`
- `ts` = `bundles[i+1].startedAt` (when the new source gained focus)
- `dwellMs` = `bundles[i].endedAt - bundles[i].startedAt` (how long the user was on the "from" source)

This reconstruction means the pre-processing pipeline has access to per-transition timestamps and dwell times without changing the Graph data model.

```typescript
type Transition = {
  from: string;
  to: string;
  ts: number;       // timestamp of the switch
  dwellMs: number;  // how long the user was on the 'from' source
};
```

### Pre-processing

Before building the graph for Louvain, noise is removed. The pipeline runs these filters in sequence:

#### 1. Unknown sentinel removal

Transitions involving `"unknown"` are stripped. The `unknown` source represents the user being outside the browser — it connects to many sources but represents no task. Without removal, `unknown` would act as a hub distorting neighbor counts and community detection.

```bash
filter: transition.from !== UNKNOWN && transition.to !== UNKNOWN
```

#### 2. Transient source removal

Sources the user passed through without engaging — rapid tab scanning (Ctrl+Tab). A source is transient if **all** its bundles have duration < `TRANSIENT_DWELL_MS` (500ms).

```bash
for each source:
  sourceBundles = bundles where bundle.source === source
  if every bundle has (endedAt - startedAt) < TRANSIENT_DWELL_MS:
    mark source as transient

filter: transition.from ∉ transient && transition.to ∉ transient
```

Additionally, chain scanning detection: a transition is transient if dwellMs < `TRANSIENT_CHAIN_MS` (1000ms) AND both the preceding and following transitions also have dwellMs < 1000ms.

#### 3. Hub detection

A source is a hub if its unique neighbor count (in + out) exceeds `HUB_THRESHOLD_PERCENT` (10%) of total unique sources, when total unique sources >= `HUB_MIN_SOURCES` (15).

```bash
for each source:
  neighbors = unique sources connected by any transition (either direction)
  if len(neighbors) > len(allSources) * HUB_THRESHOLD_PERCENT
     && len(allSources) >= HUB_MIN_SOURCES:
    mark source as hub
```

Hubs are common in tabs like email, Slack, or a dashboard — they connect to many other sources but at different times they belong to different tasks.

#### 4. Hub temporal chunking

Instead of excluding hubs entirely (which loses information), hubs are split into time-windowed virtual sources. Each 5-minute window (`CHUNK_WINDOW_MS`) becomes a separate node in the graph. Louvain assigns different chunks to different communities.

```bash
for each hub source:
  baseTs = earliest transition.ts involving this source
  for each transition involving hub:
    chunkIndex = floor((transition.ts - baseTs) / CHUNK_WINDOW_MS)
    chunkId = "hub:<source>:<chunkIndex>"
    replace hub source with chunkId in this transition

chunkMap: Map<chunkId, { originalSource, chunkIndex, windowStartMs }>
```

Each chunk inherits only the edges within its time window. A hub with low per-chunk degree passes below the hub threshold and enters Louvain as a regular node.

**Example:**

```
Before (hub removal):
  root@42 (Outlook) has edges to 8 of 20 sources → detected as hub
  Without hub handling: Outlook excluded entirely

After (hub chunking, 5-min windows):
  hub:root@42:0 (9:00–9:05) — edges to root@17, root@5
  hub:root@42:1 (9:05–9:10) — edges to root@8, root@12

  Louvain clusters:
    Community 0: [root@17, root@5, hub:root@42:0]       ← Smith case
    Community 1: [root@8, root@12, hub:root@42:1]       ← Jones case
```

#### PreprocessResult

```typescript
type PreprocessResult = {
  transitions: Transition[];
  excludedSources: Set<string>;    // transient sources removed
  chunkMap: Map<string, {          // hub chunk ID → original source mapping
    originalSource: string;
    chunkIndex: number;
    windowStartMs: number;
  }>;
  hubSources: Set<string>;         // original source IDs that were chunked
};
```

### Graph construction

`buildDirectedGraph()` converts filtered transitions into a weighted directed graph:

```typescript
type DirectedGraph = {
  nodes: Set<string>;                // source IDs (or chunk IDs for hubs)
  edges: Map<string, number>;        // "from\0to" → weight (transition count)
  inDegree: Map<string, number>;     // sum of incoming edge weights
  outDegree: Map<string, number>;    // sum of outgoing edge weights
  totalWeight: number;               // sum of all edge weights
};
```

Each surviving transition from source A to source B increments `edges["A\0B"]` by 1. In-degree and out-degree are precomputed for the modularity formula.

### Directed Louvain

Implements the full two-phase Directed Louvain algorithm (Dugue & Perez 2022).

#### Directed modularity

```
Q = (1/m) * Σ_ij [ A_ij - γ * (k_i^out * k_j^in) / m ] * δ(c_i, c_j)
```

Where:
- `m` = total edge weight
- `A_ij` = weight of edge i → j
- `k_i^out` = out-degree of node i (sum of outgoing edge weights)
- `k_j^in` = in-degree of node j (sum of incoming edge weights)
- `γ` = resolution parameter (default 1.0)
- `δ(c_i, c_j)` = 1 if nodes i and j are in the same community

#### Phase 1 — Local greedy moves

Each node evaluates moving to each neighbor's community. The move that produces the largest positive modularity gain is applied. Repeats until no node improves (max `MAX_LOCAL_ITERATIONS` = 100 per phase).

The modularity delta for moving node `i` from its current community `c_i` to a target community `c` (Dugue & Perez 2022):

```
ΔQ = ΔQ_insert(i → c) - ΔQ_remove(i from c_i)

ΔQ_insert(i → c) = [w(i→c) + w(c→i)] / m
                  - γ * [k_i^out * Σ_in(c) + k_i^in * Σ_out(c)] / m²

ΔQ_remove(i from c_i) = [w(i→c_i\i) + w(c_i\i→i)] / m
                       - γ * [k_i^out * (Σ_in(c_i) - k_i^in)
                            + k_i^in * (Σ_out(c_i) - k_i^out)] / m²
```

Where:
- `w(i→c)` = total weight of edges from i to nodes in community c
- `w(c→i)` = total weight of edges from nodes in community c to i
- `Σ_in(c)` = sum of in-degrees of all nodes in community c
- `Σ_out(c)` = sum of out-degrees of all nodes in community c
- `c_i\i` = community c_i excluding node i

#### Phase 2 — Coarsen

Communities become super-nodes. Edges between communities are aggregated (weights summed). Self-loops represent intra-community edges. Repeat from Phase 1 on the coarsened graph. Stops when no further modularity improvement (max `MAX_PASSES` = 10).

#### Edge cases

- 0 nodes: return empty map
- 1–2 nodes with edges: all in one community
- 1–2 nodes without edges: each in its own community
- Disconnected subgraphs: Louvain naturally separates them (no cross-community edges to incentivize merging)

#### Complexity

O(n log n) per pass, typically 2–5 passes. For 30 sources and 200 transitions: microseconds.

#### LouvainResult

```typescript
type LouvainResult = {
  communities: Map<string, string>;  // source → communityId
  modularity: number;                // final Q score
};
```

### Bundle assignment

Each sealed Bundle is assigned to a community via one of three paths:

```bash
assignBundles(louvain, bundles, chunkMap, hubSources, excludedSources)
  │
  for each bundle:
  │
  ├─ source ∈ excludedSources (transient)?
  │     → singleton group (key: "singleton:<source>")
  │
  ├─ source ∈ hubSources (was chunked)?
  │     → find chunk for bundle.startedAt:
  │         chunkIndex = floor((startedAt - baseTs) / CHUNK_WINDOW_MS)
  │         chunkId = "hub:<source>:<chunkIndex>"
  │         community = louvain.communities.get(chunkId)
  │     → if community found: assign to that community's group
  │     → else: singleton group
  │
  ├─ louvain.communities.has(source)?
  │     → assign to that community's group
  │
  └─ else (isolated, no edges):
        → singleton group (key: "singleton:<source>")
```

A single hub source can contribute bundles to **multiple** Groups. The bundle's `startedAt` determines which chunk (and therefore which community) it belongs to.

### Constants

| Constant                | Value     | Purpose                                                     |
| ----------------------- | --------- | ----------------------------------------------------------- |
| `TRANSIENT_DWELL_MS`    | 500ms     | Bundles shorter than this mark a source as transient        |
| `TRANSIENT_CHAIN_MS`    | 1000ms    | Chain scanning detection threshold                          |
| `HUB_THRESHOLD_PERCENT` | 0.1 (10%) | Neighbor ratio to flag a source as hub                      |
| `HUB_MIN_SOURCES`       | 15        | Minimum source count before hub detection activates         |
| `CHUNK_WINDOW_MS`       | 5 minutes | Time window for splitting hub sources                       |
| `DEFAULT_RESOLUTION`    | 1.0       | Louvain resolution γ. <1 = larger communities, >1 = smaller |
| `MIN_IMPROVEMENT`       | 1e-6      | Minimum modularity gain to accept a move                    |
| `MAX_PASSES`            | 10        | Maximum coarsening passes                                   |
| `MAX_LOCAL_ITERATIONS`  | 100       | Maximum Phase 1 iterations per pass                         |

### Full example

Lawyer works on Smith v. Jones. 6 sources, 10 sealed bundles, email is a hub:

```bash
sealed bundles (in order):
  B0: root@42 (Westlaw)     10:00–10:05   ← legal research
  B1: root@17 (case.pdf)    10:05–10:08   ← cross-reference
  B2: root@42 (Westlaw)     10:08–10:12   ← back to research
  B3: root@5  (Outlook)     10:12–10:14   ← check email re: Smith
  B4: root@42 (Westlaw)     10:14–10:18   ← more research
  B5: root@5  (Outlook)     10:18–10:20   ← different email (Jones billing)
  B6: root@9  (billing.app) 10:20–10:25   ← Jones billing task
  B7: root@5  (Outlook)     10:25–10:26   ← quick email check
  B8: root@12 (Word)        10:26–10:32   ← draft memo for Smith
  B9: root@17 (case.pdf)    10:32–10:35   ← final cross-reference

reconstructTransitions:
  root@42 → root@17  at 10:05 (dwell 5m)
  root@17 → root@42  at 10:08 (dwell 3m)
  root@42 → root@5   at 10:12 (dwell 4m)
  root@5  → root@42  at 10:14 (dwell 2m)
  root@42 → root@5   at 10:18 (dwell 4m)
  root@5  → root@9   at 10:20 (dwell 2m)
  root@9  → root@5   at 10:25 (dwell 5m)
  root@5  → root@12  at 10:26 (dwell 1m)
  root@12 → root@17  at 10:32 (dwell 6m)

preprocess:
  1. no unknown transitions — nothing to strip
  2. no transient sources — all bundles > 500ms
  3. hub detection: root@5 has neighbors {root@42, root@9, root@12}
     3 of 5 sources = 60% — but only 5 sources total, below HUB_MIN_SOURCES (15)
     → no hubs detected (too few sources for hub logic to activate)
  4. (no hubs to chunk)

buildDirectedGraph:
  nodes: {root@42, root@17, root@5, root@9, root@12}
  edges:
    root@42 → root@17: 1
    root@17 → root@42: 1
    root@42 → root@5:  2
    root@5  → root@42: 1
    root@5  → root@9:  1
    root@9  → root@5:  1
    root@5  → root@12: 1
    root@12 → root@17: 1

directedLouvain:
  Phase 1 moves: root@42 + root@17 cluster (bidirectional weight 2),
                 root@5 + root@9 cluster (bidirectional weight 2),
                 root@12 joins root@42/root@17 (edge to root@17)
  Result:
    Community A: {root@42, root@17, root@12}  ← research + memo + PDF
    Community B: {root@5, root@9}             ← email + billing

assignBundles:
  B0 (root@42) → A    B5 (root@5) → B
  B1 (root@17) → A    B6 (root@9) → B
  B2 (root@42) → A    B7 (root@5) → B
  B3 (root@5)  → B    B8 (root@12) → A
  B4 (root@42) → A    B9 (root@17) → A

Group A: Smith research — Westlaw, case PDF, Word memo
  meta: { sources: [root@42, root@17, root@12], tabs: [42, 17, 12],
          timeRange: { start: 10:00, end: 10:35 } }

Group B: Email + billing
  meta: { sources: [root@5, root@9], tabs: [5, 9],
          timeRange: { start: 10:12, end: 10:26 } }
```

Now with hub chunking (imagine 20+ sources so hub detection activates):

```bash
hub detection: root@5 (Outlook) has neighbors to 4 of 20 sources = 20% → hub

hub chunking (5-min windows, baseTs = 10:12):
  B3 at 10:12 → chunk 0  (10:12–10:17)  → hub:root@5:0
  B5 at 10:18 → chunk 1  (10:17–10:22)  → hub:root@5:1
  B7 at 10:25 → chunk 1  (10:22–10:27)  → hub:root@5:1

transitions rewritten:
  root@42 → hub:root@5:0  at 10:12
  hub:root@5:0 → root@42  at 10:14
  root@42 → hub:root@5:1  at 10:18
  hub:root@5:1 → root@9   at 10:20
  root@9  → hub:root@5:1  at 10:25
  hub:root@5:1 → root@12  at 10:26

Louvain clusters:
  Community A: {root@42, root@17, hub:root@5:0, root@12}  ← Smith + email chunk 0
  Community B: {hub:root@5:1, root@9}                     ← Jones billing + email chunk 1

Bundle assignment:
  B3 (root@5, startedAt 10:12) → chunk 0 → Community A  ← Smith email
  B5 (root@5, startedAt 10:18) → chunk 1 → Community B  ← Jones email
  B7 (root@5, startedAt 10:25) → chunk 1 → Community B  ← Jones email
```

The same Outlook tab contributes bundles to two different task groups based on temporal context.

### GroupMeta computation

GroupMeta is derived mechanically from a group's bundles:

```bash
computeMeta(bundles)
  │
  ├─ sources = unique bundle.source values
  │     e.g. ["root@42", "root@17", "dashboard@42"]
  │
  ├─ tabs = unique bundle.tabId values (extracted from source or bundle)
  │     e.g. ["42", "17"]
  │
  └─ timeRange = {
       start: min(bundle.startedAt for all bundles),
       end:   max(bundle.endedAt   for all bundles)
     }
```

### Group text assembly

Each group's `text` is produced by calling `translate()` on the group's bundles in chronological order. Individual bundle texts are already computed at seal time, but the group-level `translate()` call produces a combined narrative across bundles — potentially with source transition markers:

```text
── root@42 (github.com/org/repo/pulls) ──
[10:32:05] navigated to "Pull requests" (https://github.com/org/repo/pulls)
[10:32:08] clicked "Files changed" tab
[10:32:12] scrolled to 45%
[10:32:15] typed "looks good, one nit on line 42"
[10:32:20] clicked "Submit review"

── root@17 (github.com/org/repo/issues/138) ──
[10:33:01] navigated to "Issue #138" (https://github.com/org/repo/issues/138)
[10:33:05] scrolled to 80%
[10:33:10] typed "fixed in #139"
[10:33:12] clicked "Comment"
```

The exact format is an implementation detail of `translate()`.

## Flush triggers

The Packer doesn't decide when to flush — something upstream calls `flush()`. Possible triggers:

| Trigger     | Source                          | When                                            |
| ----------- | ------------------------------- | ----------------------------------------------- |
| Timer       | `chrome.alarms`                 | Every N minutes of active use                   |
| Event count | Aggregator                      | After N sealed bundles accumulate               |
| Manual      | User action (e.g. popup button) | On demand                                       |
| Recovery    | Persistence layer               | On service worker restart with stale checkpoint |
| Shutdown    | `chrome.runtime.onSuspend`      | Best-effort before service worker dies          |

The trigger mechanism is outside the Packer's scope. All the Packer knows is: `flush()` was called, drain everything, build a Packet.

## Interaction with the Bundler

The Packer reads from the Bundler via two methods on the `Aggregator` interface:

- `drainSealed()` — returns all sealed Bundles and clears the Bundler's sealed array.
- `getSealed()` — non-destructive read (used by DevHub for inspection, not by the Packer).

Before draining, the caller should `seal()` the current open Bundle (if any) to avoid losing in-flight captures. The `flush()` function handles this.

## Interaction with the Graph

The Packer reads from the Graph via:

- `drainEdges()` — returns all Edges and clears the Graph's edge map.
- `getEdges()` — non-destructive read (used by DevHub for inspection).

Edges represent source-to-source transitions. Each edge has `from`, `to`, and `weight`. The Packer uses edges for two purposes:

1. **Community detection** — the partitioning algorithm uses edge weights to cluster related sources.
2. **Packet payload** — the raw edges are included in the Packet so the server has the full navigation graph.

## Interaction with the Syncing Layer

The Packer produces a Packet. The caller passes it to `sync(packet)`:

```bash
const packet = flush();
if (packet) await sync(packet);
```

The Packer has no knowledge of HTTP, auth tokens, retry queues, or the server. It builds the Packet; the Syncing Layer delivers it.

## Interaction with the Persistence Layer

The Persistence Layer checkpoints the Aggregator's state (open bundle, sealed bundles, edges, active source) to `chrome.storage.local`. On recovery:

1. The checkpoint is restored into the Bundler and Graph.
2. Any stale open Bundle is sealed (with `endedAt` set to the checkpoint's `savedAt` timestamp).
3. `flush()` is called to pack everything into a Packet and sync it.

The Packer itself is stateless — it reads, transforms, and returns. There's nothing to persist about the Packer between service worker restarts.

## Dev logs

The Packer uses the `"aggregator"` dev channel (same as the Bundler):

| Event          | When                | Data                                                                   |
| -------------- | ------------------- | ---------------------------------------------------------------------- |
| `pack.flushed` | `flush()` completes | `{ groups: number, bundles: number, edges: number, packetId: string }` |

These are visible in the DevHub panel under the `AGGREGATOR` event group.

## Example scenario

User browses GitHub PRs in tab 42, switches to a GitHub issue in tab 17, then checks Gmail in tab 5, then alt-tabs away. Flush is triggered by a timer.

```bash
State at flush time:
  sealed: [
    Bundle("root@42", 10:32:00–10:32:30, 5 captures),
    Bundle("root@17", 10:33:00–10:33:15, 4 captures),
    Bundle("root@42", 10:33:20–10:34:00, 2 captures),   ← returned to tab 42
    Bundle("root@5",  10:34:05–10:35:00, 3 captures),
  ]
  edges: [
    root@42 → root@17  (weight: 1),
    root@17 → root@42  (weight: 1),
    root@42 → root@5   (weight: 1),
    root@5  → unknown   (weight: 1),
  ]

flush():
  1. drain sealed → 4 bundles
  2. drain edges  → 4 edges

  3. partition:
     Community detection clusters root@42 and root@17 together
     (they navigate between each other). root@5 is separate.
     → Group A: [root@42, root@17]
     → Group B: [root@5]

  4. assign bundles:
     → Group A bundles: [Bundle(root@42, ...), Bundle(root@17, ...), Bundle(root@42, ...)]
     → Group B bundles: [Bundle(root@5, ...)]

  5. compute meta:
     → Group A meta: { sources: ["root@42", "root@17"], tabs: ["42", "17"],
                        timeRange: { start: 10:32:00, end: 10:34:00 } }
     → Group B meta: { sources: ["root@5"], tabs: ["5"],
                        timeRange: { start: 10:34:05, end: 10:35:00 } }

  6. translate:
     → Group A text: combined narrative of all 3 bundles (PR review + issue)
     → Group B text: narrative of Gmail bundle

  7. assemble:
     → Packet {
          id: "a1b2c3d4...",
          groups: [Group A, Group B],
          edges: [all 4 edges],
          createdAt: 10:35:01
        }
```

## File map

| File                                                              | Role                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/aggregation/packer.ts`                                       | `createPacker(aggregator)` — `flush()`, `partitionIntoGroups()`, bundle assignment (not yet created)         |
| `src/aggregation/preprocess.ts`                                   | `preprocess()` — unknown removal, transient detection, hub detection + chunking (not yet created)            |
| `src/aggregation/directed-louvain.ts`                             | `directedLouvain()` — two-phase directed Louvain community detection (not yet created)                       |
| [`src/aggregation/index.ts`](../src/aggregation/index.ts)         | `createAggregator()` — facade that creates the bundler + graph; the packer will consume from it              |
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts)     | `createBundler(graph)` — produces sealed Bundles consumed by the packer ([docs](./bundler.md))               |
| [`src/aggregation/graph.ts`](../src/aggregation/graph.ts)         | `createGraph()` — produces Edges consumed by the packer                                                      |
| [`src/aggregation/translate.ts`](../src/aggregation/translate.ts) | `translate(bundle)` — called at seal time (by bundler) and at group assembly time (by packer)                |
| [`src/aggregation/types.ts`](../src/aggregation/types.ts)         | `Bundle`, `Edge`, `Group`, `GroupMeta`, `Packet`, `Transition`, `DirectedGraph`, `LouvainResult` definitions |
