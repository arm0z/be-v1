# Packer

The Packer is the final stage of the Aggregation Layer. It consumes sealed Bundles and raw Transitions from the Bundler, preprocesses transitions to remove noise, builds a directed graph, runs Louvain community detection to partition sources into Groups, and assembles Packets for delivery to the Syncing Layer.

## Where it sits

```text
Service Worker
──────────────
  ┌─ Aggregation Layer ────────────────────────────────────────────┐
  │                                                                │
  │   ┌──────────────────┐                                         │
  │   │     Bundler      │                                         │
  │   │                  │                                         │
  │   │  sealed[]        ├────┐                                    │
  │   │  transitions[]   ├────┤                                    │
  │   └──────────────────┘    │                                    │
  │                           ▼                                    │
  │             ┌───────────────────────────────┐                  │
  │             │           Packer              │                  │
  │             │                               │                  │
  │             │  1. seal + drain bundles      │                  │
  │             │  2. drain transitions         │                  │
  │             │  3. preprocess transitions    │                  │
  │             │  4. build directed graph      │                  │
  │             │  5. Louvain → communities     │                  │
  │             │  6. assign bundles → Groups   │                  │
  │             │  7. compute GroupMeta         │                  │
  │             │  8. assemble Packet           │                  │
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

The Packer has no knowledge of Chrome APIs, Captures, or the DOM. It only operates on sealed Bundles (which already have `text` populated by `translate()`) and raw Transitions (timestamped focus-shift records logged by the Bundler). The directed graph and edge weights are built internally by the Packer at flush time.

## Types

```typescript
/** Raw transition record. Logged by the bundler on every source change. */
type Transition = {
  from: string;          // source left (e.g. "root@42")
  to: string;            // source entered (e.g. "root@17")
  ts: number;            // Date.now() at the moment of the switch
  dwellMs: number;       // how long the user was on 'from'
};

type Group = {
  id: string;            // unique identifier for the group
  bundles: Bundle[];     // sealed bundles assigned to this group
  text: string;          // joined bundle.text values, sorted by startedAt
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
  edges: Edge[];         // aggregated navigation graph (built from transitions at flush time)
  createdAt: number;     // Date.now() at assembly time
};
```

## Operations

### `flush(): Packet | null`

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
  ├─ transitions = drainTransitions()
  │     consumes all raw transition records
  │
  ├─ bundles is empty?
  │     YES → return null (nothing to send)
  │
  ├─ groups = partitionIntoGroups(transitions, bundles)
  │     preprocess → build graph → Louvain → assign bundles
  │
  ├─ for each group:
  │     compute GroupMeta
  │     join bundle.text values → group.text
  │
  └─ return Packet { id, groups, edges, createdAt }
```

Both `drainSealed()` and `drainTransitions()` are destructive reads — they return the data and clear the internal arrays. This means each Packet contains exactly the Bundles and Transitions accumulated since the last flush. No data is shared between Packets.

The Packet's `edges` field contains the aggregated `Edge[]` built from transitions during graph construction — this is for the server's benefit (compact representation of the navigation graph).

### `partitionIntoGroups(transitions, bundles): Group[]`

The full pipeline: pre-process the raw transition log, build a weighted directed graph, run directed Louvain, assign bundles to communities.

```bash
partitionIntoGroups(transitions, bundles)
  │
  ├─ { filtered, excludedSources, chunkMap, hubSources }
  │       = preprocess(transitions)
  │     off-browser splitting → transient removal → hub chunking
  │
  ├─ graph = buildDirectedGraph(filtered)
  │     aggregates transitions into weighted edges + in/out degree
  │
  ├─ communities = directedLouvain(graph)
  │     Map<source, communityId>
  │
  ├─ assign each bundle to a community:
  │     community-grouped | hub-chunked | singleton
  │
  ├─ create Group for each community
  │     │
  │     ├─ collect bundles assigned to this community
  │     ├─ compute GroupMeta from those bundles
  │     └─ join bundle.text values → group.text
  │
  └─ return Group[]
```

Sources that appear in bundles but have no transitions (isolated sources — e.g. a tab the user opened but never switched away from before flush) become singleton groups.

---

## Graph Partitioning Algorithm

Based on "Graph-Structure-Based Grouping of Web Browser Tabs into Tasks" (Hisatomi & Tajima, UIST Adjunct '25, DOI: 10.1145/3746058.3758439). Adapted for Hourglass's data model.

**Core idea:** The aggregator records every focus shift as a raw `Transition`. The packer pre-processes these transitions (removing noise, splitting hubs), builds a weighted directed graph, and runs Directed Louvain to find clusters. Sources that are frequently switched between form communities — these communities are the task groups.

**Why this fits:**

- **No training data** — unsupervised, no manual annotation.
- **The signal already exists** — the Bundler's `transition()` fires on every source change. We just need to store the raw records instead of pre-aggregating them.

### Aggregator transition log

> **Implemented.** The old `createGraph()` pre-aggregation has been replaced with a raw transition log. Each call to `bundler.transition(to)` in [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts) appends a `Transition { from, to, ts, dwellMs }` record. The Packer builds the `DirectedGraph` from raw transitions after preprocessing at flush time. Per-transition timing enables:
>
> - **Transient detection** — filtering transitions where dwell < 500ms ([`preprocess.ts`](../src/aggregation/preprocess.ts) `removeTransients()`)
> - **Hub temporal chunking** — splitting hub sources into dynamic time windows ([`preprocess.ts`](../src/aggregation/preprocess.ts) `chunkHubs()`)
> - **Chain scanning** — detecting rapid Ctrl+Tab sequences from consecutive transition timing ([`preprocess.ts`](../src/aggregation/preprocess.ts) `removeTransients()`)
>
> The old `graph.ts` module has been deleted. `getEdges`/`drainEdges` are removed from the `Aggregator` interface, replaced by `getTransitions()`/`drainTransitions()`/`seal()`.

### Input data

```typescript
type Transition = {
  from: string;       // source left (e.g. "root@42")
  to: string;         // source entered (e.g. "root@17")
  ts: number;         // Date.now() at the moment of the switch
  dwellMs: number;    // how long the user was on 'from' (endedAt - startedAt of the sealed bundle)
};
```

The algorithm takes two inputs, both drained from the aggregator:

- **`transitions: Transition[]`** from `drainTransitions()` — raw transition log. Each record is one focus shift with timing. This is what the preprocessing pipeline filters and what the graph is built from.
- **`bundles: Bundle[]`** from `drainSealed()` — the actual content to be grouped. Bundle `source` determines which community it belongs to. Bundle `startedAt` is used for hub chunk assignment.

### Pre-processing

Before building the graph, noise is removed from the transition log. The pipeline runs these filters in sequence:

#### 1. Off-browser sentinel splitting

The `"off_browser"` source represents the user being outside the browser. Unlike a regular source, there are no bundles for `off_browser` — nothing is captured while the browser is blurred. But off-browser time is often **task-related**: a lawyer alt-tabbing to Word for 3 minutes to draft notes is still working on the same task as the Westlaw tab they left.

Simply stripping all `off_browser` transitions (as in Hisatomi & Tajima 2025) loses this task continuity signal. Instead, each off-browser stint is treated as a **dwell-gated ephemeral node** — kept, dropped, or passed through depending on how long the user was away.

Each transition pair `A → off_browser` + `off_browser → B` represents one off-browser stint. The `dwellMs` on the `A → off_browser` transition tells us how long the user was on source A, and the `dwellMs` on the `off_browser → B` transition (or equivalently the gap between the two transition timestamps) tells us how long the user was off-browser.

```bash
for each consecutive pair (A → off_browser at ts₁) + (off_browser → B at ts₂):
  offBrowserMs = ts₂ - ts₁

  if offBrowserMs < SENTINEL_PASSTHROUGH_MS (2s):
    → pass-through: remove both transitions, inject direct edge A → B
      (accidental focus loss, notification popup, window manager flicker)

  else if offBrowserMs < SENTINEL_BREAK_MS (10 min):
    → keep as ephemeral node: replace "off_browser" with "off_browser:<n>"
      where n is a monotonically increasing index per stint
      (task-related off-browser work — Word, terminal, Slack, etc.)

  else:
    → break boundary: remove both transitions entirely
      (lunch break, meeting, long distraction — not task-related)
```

Each ephemeral `off_browser:<n>` node has exactly 2 edges: one inbound (from A) and one outbound (to B). It acts as temporal glue — Louvain will naturally cluster it with whichever community A and B belong to. If A and B are in the same community, the off_browser node reinforces that link. If they're in different communities, the off_browser node becomes a bridge with minimal modularity impact (degree 2, low weight).

**Why this works:**

- Each off-browser stint is discrete — unlike a regular hub, it never accumulates high degree. Even 20 off-browser stints produce 20 separate nodes, each with degree 2.
- Short stints (< 2s) are noise — browser focus flicker, notification popups. Pass-through preserves the `A → B` relationship without polluting the graph with trivial nodes.
- Long stints (> 10 min) are breaks — lunch, meetings, end of day. Severing the link prevents unrelated before/after tasks from merging.
- Medium stints (2s – 10 min) are the sweet spot — the user was doing something task-related off-browser. The ephemeral node preserves the temporal adjacency for Louvain.

**Example:**

```bash
transitions:
  { from: root@42, to: off_browser, ts: 10:12, dwellMs: 4m }   ← user leaves browser
  { from: off_browser, to: root@42, ts: 10:15, dwellMs: 3m }   ← returns 3 min later

offBrowserMs = 10:15 - 10:12 = 3 min → keep as off_browser:0

rewritten:
  { from: root@42, to: off_browser:0, ts: 10:12, dwellMs: 4m }
  { from: off_browser:0, to: root@42, ts: 10:15, dwellMs: 3m }

Louvain: off_browser:0 has edges only to root@42 (both directions)
  → clusters with root@42's community. Task continuity preserved.
```

```bash
transitions:
  { from: root@42, to: off_browser, ts: 10:12, dwellMs: 4m }   ← user leaves browser
  { from: off_browser, to: root@5,  ts: 12:30, dwellMs: 138m } ← returns 2+ hours later

offBrowserMs = 12:30 - 10:12 = 138 min → break boundary, remove both

The morning session and afternoon session are disconnected in the graph.
```

#### 2. Transient source removal

Sources the user passed through without engaging — rapid tab scanning (Ctrl+Tab). Two detection methods:

**Dwell-based:** A source is transient if **all** transitions FROM it have `dwellMs` < `TRANSIENT_DWELL_MS` (500ms).

**Chain scanning:** A transition is transient if `dwellMs` < `TRANSIENT_CHAIN_MS` (1000ms) AND both the preceding and following transitions in the log also have `dwellMs` < 1000ms. This catches rapid Ctrl+Tab sequences even when individual dwell times are above 500ms.

```bash
for each source:
  outgoing = transitions where transition.from === source
  if every outgoing has dwellMs < TRANSIENT_DWELL_MS:
    mark source as transient

additionally, scan for chains:
  for i in 1..len(transitions)-1:
    if transitions[i-1].dwellMs < TRANSIENT_CHAIN_MS
       && transitions[i].dwellMs < TRANSIENT_CHAIN_MS
       && transitions[i+1].dwellMs < TRANSIENT_CHAIN_MS:
      mark transitions[i].from as transient

filter: transition.from ∉ transient && transition.to ∉ transient
```

#### 3. Hub detection

A source is a hub if its unique neighbor count (in + out, computed from the transition list) exceeds `HUB_THRESHOLD_PERCENT` (10%) of total unique sources, when total unique sources >= `HUB_MIN_SOURCES` (15).

```bash
for each source:
  neighbors = unique sources connected by any transition (either direction)
  if len(neighbors) > len(allSources) * HUB_THRESHOLD_PERCENT
     && len(allSources) >= HUB_MIN_SOURCES:
    mark source as hub
```

Hubs are common in tabs like email, Slack, or a dashboard — they connect to many other sources but at different times they belong to different tasks.

#### 4. Hub temporal chunking

Instead of excluding hubs entirely (which loses information), hubs are split into time-windowed virtual sources. Each window becomes a separate node in the graph. The window size is **dynamic** — computed per hub from its session span and connection count.

##### Dynamic chunk window calculation

A fixed window (e.g. 5 minutes) fails at the extremes: it's too coarse for a short bursty session and creates too many near-empty chunks for a long sparse one. Instead, the window is sized so each chunk contains roughly `TARGET_PER_CHUNK` transitions:

```text
sessionMs     = max(t.ts) - min(t.ts)   for all transitions involving this hub
connectionCount = number of transitions involving this hub

idealChunks   = max(1, floor(connectionCount / TARGET_PER_CHUNK))
rawWindowMs   = sessionMs / idealChunks

chunkWindowMs = clamp(rawWindowMs, MIN_CHUNK_MS, MAX_CHUNK_MS)
```

| Symbol             | Value   | Rationale                                                              |
| ------------------ | ------- | ---------------------------------------------------------------------- |
| `TARGET_PER_CHUNK` | 4       | ~4 transitions → at most 4 unique neighbors per chunk, well below 10%  |
| `MIN_CHUNK_MS`     | 60 000  | Floor of 1 minute — sub-minute splits add noise without aiding Louvain |
| `MAX_CHUNK_MS`     | 900 000 | Ceiling of 15 minutes — beyond this, temporal context is too diluted   |

**Worked examples:**

| Hub profile                             | sessionMs | connections | idealChunks | rawWindow | clamped              |
| --------------------------------------- | --------- | ----------- | ----------- | --------- | -------------------- |
| Outlook, 20 min, heavy switching        | 20 min    | 40          | 10          | 2 min     | **2 min**            |
| Slack, 2 hr, moderate                   | 120 min   | 24          | 6           | 20 min    | **15 min** (clamped) |
| Dashboard, 5 min, burst of tab switches | 5 min     | 60          | 15          | 20 sec    | **1 min** (clamped)  |
| Email, 3 hr, sparse check-ins           | 180 min   | 8           | 2           | 90 min    | **15 min** (clamped) |

The intuition: chunk window ∝ session duration / connections. Dense hubs get fine-grained slicing; sparse hubs get coarse slicing. The clamps prevent degenerate extremes.

##### Chunk assignment

Since transitions carry timestamps, chunking is straightforward — each transition involving a hub is assigned to a chunk based on `transition.ts`:

```bash
for each hub source:
  hubTransitions = transitions involving this source
  baseTs = min(t.ts for t in hubTransitions)
  chunkWindowMs = computeChunkWindow(hubTransitions)

  for each transition involving hub:
    chunkIndex = floor((transition.ts - baseTs) / chunkWindowMs)
    chunkId = "hub:<source>:<chunkIndex>"
    replace hub source with chunkId in this transition

chunkMap: Map<chunkId, { originalSource, chunkIndex, windowStartMs, chunkWindowMs }>
```

Each chunk inherits only the transitions within its time window. A hub with low per-chunk degree passes below the hub threshold and enters Louvain as a regular node. Louvain assigns different chunks to different communities.

**Example:**

```bash
Before (hub removal):
  root@42 (Outlook) has transitions to 8 of 20 sources → detected as hub
  Without hub handling: Outlook excluded entirely

After (dynamic hub chunking):
  sessionMs = 10 min, connectionCount = 16
  idealChunks = floor(16 / 4) = 4, rawWindow = 2.5 min → chunkWindowMs = 2.5 min

  hub:root@42:0 (9:00–9:02:30) — transitions to root@17, root@5
  hub:root@42:1 (9:02:30–9:05) — transitions to root@8, root@12
  hub:root@42:2 (9:05–9:07:30) — transitions to root@3
  hub:root@42:3 (9:07:30–9:10) — transitions to root@9, root@14

  Louvain clusters:
    Community 0: [root@17, root@5, hub:root@42:0]       ← Smith case
    Community 1: [root@8, root@12, hub:root@42:1]       ← Jones case
```

#### PreprocessResult

```typescript
type PreprocessResult = {
  transitions: Transition[];        // filtered + rewritten transition list
  excludedSources: Set<string>;    // transient sources removed
  sentinelCount: number;           // number of off_browser:<n> ephemeral nodes created
  chunkMap: Map<string, {          // hub chunk ID → original source mapping
    originalSource: string;
    chunkIndex: number;
    windowStartMs: number;
    chunkWindowMs: number;         // dynamic window size used for this hub
  }>;
  hubSources: Set<string>;         // original source IDs that were chunked
};
```

### Graph construction

`buildDirectedGraph()` aggregates the pre-processed transitions into the weighted directed graph Louvain needs:

```typescript
type DirectedGraph = {
  nodes: Set<string>;                // source IDs (or chunk IDs for hubs)
  edges: Map<string, number>;        // "from\0to" → weight (transition count)
  inDegree: Map<string, number>;     // sum of incoming edge weights per node
  outDegree: Map<string, number>;    // sum of outgoing edge weights per node
  totalWeight: number;               // sum of all edge weights
};
```

Each transition from source A to source B increments `edges["A\0B"]` by 1. Multiple transitions between the same pair are aggregated into a single weighted edge. In-degree and out-degree are precomputed for the modularity formula. This is where the aggregation happens — after preprocessing has had full access to per-transition timing.

### Directed Louvain

Implements the full two-phase Directed Louvain algorithm (Dugue & Perez 2022).

#### Directed modularity

$$
Q = \frac{1}{m} \sum_{ij} \left[ A_{ij} - \gamma \cdot \frac{k_i^{\text{out}} \cdot k_j^{\text{in}}}{m} \right] \delta(c_i, c_j)
$$

Where:

- $m$ = total edge weight
- $A_{ij}$ = weight of edge $i \to j$
- $k_i^{\text{out}}$ = out-degree of node $i$ (sum of outgoing edge weights)
- $k_j^{\text{in}}$ = in-degree of node $j$ (sum of incoming edge weights)
- $\gamma$ = resolution parameter (default 1.0)
- $\delta(c_i, c_j)$ = 1 if nodes $i$ and $j$ are in the same community

#### Phase 1 — Local greedy moves

Each node evaluates moving to each neighbor's community. The move that produces the largest positive modularity gain is applied. Repeats until no node improves (max `MAX_LOCAL_ITERATIONS` = 100 per phase).

The modularity delta for moving node $i$ from its current community $c_i$ to a target community $c$ (Dugue & Perez 2022):

$$
\Delta Q = \Delta Q_{\text{insert}}(i \to c) - \Delta Q_{\text{remove}}(i \text{ from } c_i)
$$

$$
\Delta Q_{\text{insert}}(i \to c) = \frac{w(i \to c) + w(c \to i)}{m} - \gamma \cdot \frac{k_i^{\text{out}} \cdot \Sigma_{\text{in}}(c) + k_i^{\text{in}} \cdot \Sigma_{\text{out}}(c)}{m^2}
$$

$$
\Delta Q_{\text{remove}}(i \text{ from } c_i) = \frac{w(i \to c_i \setminus i) + w(c_i \setminus i \to i)}{m} - \gamma \cdot \frac{k_i^{\text{out}} \cdot (\Sigma_{\text{in}}(c_i) - k_i^{\text{in}}) + k_i^{\text{in}} \cdot (\Sigma_{\text{out}}(c_i) - k_i^{\text{out}})}{m^2}
$$

Where:

- $w(i \to c)$ = total weight of edges from $i$ to nodes in community $c$
- $w(c \to i)$ = total weight of edges from nodes in community $c$ to $i$
- $\Sigma_{\text{in}}(c)$ = sum of in-degrees of all nodes in community $c$
- $\Sigma_{\text{out}}(c)$ = sum of out-degrees of all nodes in community $c$
- $c_i \setminus i$ = community $c_i$ excluding node $i$

#### Phase 2 — Coarsen

Communities become super-nodes. Edges between communities are aggregated (weights summed). Self-loops represent intra-community edges. Repeat from Phase 1 on the coarsened graph. Stops when no further modularity improvement (max `MAX_PASSES` = 10).

#### Edge cases

- 0 nodes: return empty map
- 1–2 nodes with edges: all in one community
- 1–2 nodes without edges: each in its own community
- Disconnected subgraphs: Louvain naturally separates them (no cross-community edges to incentivize merging)

#### Complexity

$O(n \log n)$ per pass, typically 2–5 passes. For 30 sources and 200 transitions: microseconds.

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
  │         chunkWindowMs = chunkMap window size for this hub
  │         chunkIndex = floor((startedAt - baseTs) / chunkWindowMs)
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

| Constant                  | Value      | Purpose                                                             |
| ------------------------- | ---------- | ------------------------------------------------------------------- |
| `SENTINEL_PASSTHROUGH_MS` | 2s         | Off-browser stints shorter than this become pass-through edges      |
| `SENTINEL_BREAK_MS`       | 10 min     | Off-browser stints longer than this are severed (break boundary)    |
| `TRANSIENT_DWELL_MS`      | 500ms      | Transitions with dwell shorter than this mark a source as transient |
| `TRANSIENT_CHAIN_MS`      | 1s         | Chain scanning threshold — 3+ consecutive transitions below this    |
| `HUB_THRESHOLD_PERCENT`   | 0.1 (10%)  | Neighbor ratio to flag a source as hub                              |
| `HUB_MIN_SOURCES`         | 15         | Minimum source count before hub detection activates                 |
| `TARGET_PER_CHUNK`        | 4          | Target transitions per chunk — drives dynamic window sizing         |
| `MIN_CHUNK_MS`            | 1 minute   | Floor for chunk window (sub-minute splits add noise)                |
| `MAX_CHUNK_MS`            | 15 minutes | Ceiling for chunk window (beyond this, context is too diluted)      |
| `DEFAULT_RESOLUTION`      | 1.0        | Louvain resolution $\gamma$. <1 = larger communities, >1 = smaller  |
| `MIN_IMPROVEMENT`         | 1e-6       | Minimum modularity gain to accept a move                            |
| `MAX_PASSES`              | 10         | Maximum coarsening passes                                           |
| `MAX_LOCAL_ITERATIONS`    | 100        | Maximum Phase 1 iterations per pass                                 |

### Full example

Lawyer works on Smith v. Jones. 5 sources, 10 sealed bundles, with off-browser stints:

```bash
sealed bundles (in order):
  B0: root@42 (Westlaw)     10:00–10:05   ← legal research
  B1: root@17 (case.pdf)    10:05–10:08   ← cross-reference
  —  (off-browser 3 min — drafting notes in Word)
  B2: root@42 (Westlaw)     10:11–10:15   ← back to research
  B3: root@5  (Outlook)     10:15–10:17   ← check email re: Smith
  B4: root@42 (Westlaw)     10:17–10:21   ← more research
  —  (off-browser 0.5s — notification popup)
  B5: root@42 (Westlaw)     10:21–10:23   ← continued research (same tab)
  B6: root@5  (Outlook)     10:23–10:25   ← different email (Jones billing)
  B7: root@9  (billing.app) 10:25–10:30   ← Jones billing task
  —  (off-browser 45 min — lunch break)
  B8: root@12 (Word)        11:15–11:21   ← draft memo for Smith
  B9: root@17 (case.pdf)    11:21–11:24   ← final cross-reference

transitions from drainTransitions():
   0: { from: root@42, to: root@17, ts: 10:05, dwellMs: 5m }
   1: { from: root@17, to: off_browser, ts: 10:08, dwellMs: 3m }    ← leaves browser
   2: { from: off_browser, to: root@42, ts: 10:11, dwellMs: 3m }    ← returns after 3 min
   3: { from: root@42, to: root@5,  ts: 10:15, dwellMs: 4m }
   4: { from: root@5,  to: root@42, ts: 10:17, dwellMs: 2m }
   5: { from: root@42, to: off_browser, ts: 10:21, dwellMs: 4m }    ← notification popup
   6: { from: off_browser, to: root@42, ts: 10:21, dwellMs: 0.5s }  ← returns after 0.5s
   7: { from: root@42, to: root@5,  ts: 10:23, dwellMs: 2m }
   8: { from: root@5,  to: root@9,  ts: 10:25, dwellMs: 2m }
   9: { from: root@9,  to: off_browser, ts: 10:30, dwellMs: 5m }    ← leaves for lunch
  10: { from: off_browser, to: root@12, ts: 11:15, dwellMs: 45m }   ← returns after 45 min
  11: { from: root@12, to: root@17, ts: 11:21, dwellMs: 6m }

preprocess(transitions):
  step 1 — off-browser sentinel splitting:
    transitions 1+2: offBrowserMs = 10:11 - 10:08 = 3 min
      → 3 min > 2s, < 10 min → keep as off_browser:0
      rewrite: root@17 → off_browser:0, off_browser:0 → root@42

    transitions 5+6: offBrowserMs = 10:21 - 10:21 = 0.5s
      → 0.5s < 2s → pass-through
      remove both, inject: root@42 → root@42 (self-loop, dropped)

    transitions 9+10: offBrowserMs = 11:15 - 10:30 = 45 min
      → 45 min > 10 min → break boundary
      remove both entirely

  after step 1:
     0: root@42  → root@17     3: root@42 → root@5
     1: root@17  → off_browser:0   4: root@5  → root@42
     2: off_browser:0 → root@42    7: root@42 → root@5
                                8: root@5  → root@9
                               11: root@12 → root@17

  step 2 — no transient sources
  step 3 — hub detection: only 6 nodes (incl off_browser:0), below HUB_MIN_SOURCES
  step 4 — (no hubs)

buildDirectedGraph(transitions):
  aggregates into weighted edges:
    root@42 → root@17: 1,  root@17 → off_browser:0: 1,
    off_browser:0 → root@42: 1, root@42 → root@5: 2,
    root@5 → root@42: 1,   root@5 → root@9: 1,
    root@12 → root@17: 1
  nodes: {root@42, root@17, off_browser:0, root@5, root@9, root@12}
  totalWeight: 8

directedLouvain:
  off_browser:0 has edges only to root@17 (in) and root@42 (out)
    → clusters with root@42/root@17 (they're already connected)
  root@12 → root@17 edge → joins the same cluster
  root@5 + root@9 cluster (bidirectional through root@5 → root@9 → ?)

  Result:
    Community A: {root@42, root@17, off_browser:0, root@12}  ← research + off-browser + memo
    Community B: {root@5, root@9}                        ← email + billing

  Note: root@9 and root@12 are disconnected (the lunch break severed the link).
  root@12 joins Community A via its edge to root@17.

assignBundles:
  B0 (root@42) → A    B6 (root@5) → B
  B1 (root@17) → A    B7 (root@9) → B
  B2 (root@42) → A    B8 (root@12) → A  ← same task, different session
  B3 (root@5)  → B    B9 (root@17) → A
  B4 (root@42) → A
  B5 (root@42) → A

Group A: Smith research — Westlaw, case PDF, Word memo
  The 3-minute off-browser stint (drafting in Word) is invisible in the bundles
  but preserved the graph link between root@17 and root@42.
  The 45-minute lunch break severed root@9 from root@12, but root@12
  still clusters with A via its edge to root@17.
  meta: { sources: [root@42, root@17, root@12], tabs: [42, 17, 12],
          timeRange: { start: 10:00, end: 11:24 } }

Group B: Email + billing
  meta: { sources: [root@5, root@9], tabs: [5, 9],
          timeRange: { start: 10:15, end: 10:30 } }
```

Now with hub chunking (imagine 20+ sources so hub detection activates):

```bash
transitions involving root@5 (Outlook):
  { from: root@42, to: root@5,  ts: 10:12, dwellMs: 4m }
  { from: root@5,  to: root@42, ts: 10:14, dwellMs: 2m }
  { from: root@42, to: root@5,  ts: 10:18, dwellMs: 4m }
  { from: root@5,  to: root@9,  ts: 10:20, dwellMs: 2m }
  { from: root@9,  to: root@5,  ts: 10:25, dwellMs: 5m }
  { from: root@5,  to: root@12, ts: 10:26, dwellMs: 1m }
  (+ transitions to 15 other sources)

hub detection: root@5 has neighbors to 4 of 20 sources = 20% → hub

dynamic chunk window for root@5:
  sessionMs       = 10:26 - 10:12 = 14 min = 840 000 ms
  connectionCount = 6 (shown above) + 15 (other) = 21
  idealChunks     = floor(21 / 4) = 5
  rawWindowMs     = 840 000 / 5 = 168 000 ms ≈ 2.8 min
  chunkWindowMs   = clamp(168 000, 60 000, 900 000) = 168 000 ms (2.8 min)

hub chunking (2.8-min windows, baseTs = 10:12):
  transitions rewritten by ts:
    ts 10:12 → chunk 0 (10:12–10:14:48): root@42  → hub:root@5:0
    ts 10:14 → chunk 0                 : hub:root@5:0 → root@42
    ts 10:18 → chunk 2 (10:17:36–10:20:24): root@42  → hub:root@5:2
    ts 10:20 → chunk 2                 : hub:root@5:2 → root@9
    ts 10:25 → chunk 4 (10:23:12–10:26:00): root@9   → hub:root@5:4
    ts 10:26 → chunk 4                 : hub:root@5:4 → root@12

buildDirectedGraph → Louvain clusters:
  Community A: {root@42, root@17, hub:root@5:0, root@12}  ← Smith + email chunk 0
  Community B: {hub:root@5:2, hub:root@5:4, root@9}       ← Jones billing + email chunks

Bundle assignment:
  B3 (root@5, startedAt 10:12) → chunk 0 → Community A  ← Smith email
  B5 (root@5, startedAt 10:18) → chunk 2 → Community B  ← Jones email
  B7 (root@5, startedAt 10:25) → chunk 4 → Community B  ← Jones email
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

Each bundle already has `.text` populated by `translate()` at seal time. The group's `text` is simply the bundle texts joined in chronological order (sorted by `startedAt`), separated by newlines. No re-translation or additional formatting is needed at the group level.

## Flush triggers

The Packer doesn't decide when to flush — something upstream calls `flush()`. Possible triggers:

| Trigger          | Source                     | When                                            |
| ---------------- | -------------------------- | ----------------------------------------------- |
| Periodic         | `chrome.alarms` (2h)       | Every 2 hours regardless of activity            |
| Off-browser idle | `chrome.alarms` (10m)      | 10 minutes after the user leaves the browser    |
| Recovery         | Checkpoint recovery        | On service worker restart with stale checkpoint |
| Shutdown         | `chrome.runtime.onSuspend` | Best-effort before service worker dies          |

The trigger mechanism is outside the Packer's scope. All the Packer knows is: `flush()` was called, drain everything, build a Packet.

## Interaction with the Bundler

The Packer reads from the Bundler via two methods on the `Aggregator` interface:

- `drainSealed()` — returns all sealed Bundles and clears the Bundler's sealed array.
- `getSealed()` — non-destructive read (used by DevHub for inspection, not by the Packer).

Before draining, the caller should `seal()` the current open Bundle (if any) to avoid losing in-flight captures. The `flush()` function handles this.

## Interaction with the Transition Log

The Packer reads from the transition log via:

- `drainTransitions()` — returns all raw `Transition` records and clears the log.
- `getTransitions()` — non-destructive read (used by DevHub for inspection).

Each `Transition { from, to, ts, dwellMs }` is a single focus shift with full timing. The Packer uses transitions for:

1. **Pre-processing** — filtering noise (off-browser, transient, hub chunking) requires per-transition timing.
2. **Graph construction** — transitions are aggregated into weighted directed edges for Louvain.
3. **Packet payload** — the aggregated edges are included in the Packet so the server has the navigation graph.

## Interaction with the Syncing Layer

The Packer produces a Packet. The caller passes it to `sync(packet)`:

```bash
const packet = flush();
if (packet) await sync(packet);
```

The Packer has no knowledge of HTTP, auth tokens, retry queues, or the server. It builds the Packet; the Syncing Layer delivers it.

## Interaction with Checkpointing

Checkpointing writes the Aggregator's state (open bundle, sealed bundles, transitions, active source) to `chrome.storage.local` every 50 sealed bundles. On recovery:

1. The checkpoint is restored into the Bundler and transition log.
2. Any stale open Bundle is sealed (with `endedAt` set to the timestamp of its last capture).
3. `flush()` is called to pack everything into a Packet and sync it.

The Packer itself is stateless — it reads, transforms, and returns. There's nothing to checkpoint about the Packer between service worker restarts.

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
  transitions: [
    { from: root@42, to: root@17, ts: 10:33:00, dwellMs: 30s },
    { from: root@17, to: root@42, ts: 10:33:20, dwellMs: 15s },
    { from: root@42, to: root@5,  ts: 10:34:05, dwellMs: 40s },
    { from: root@5,  to: off_browser, ts: 10:35:00, dwellMs: 55s },
  ]

flush():
  1. drain sealed → 4 bundles
  2. drain transitions → 4 transitions

  3. partition:
     preprocess: strip off_browser transition → 3 transitions remain
     buildDirectedGraph: root@42↔root@17 (weight 1 each), root@42→root@5 (weight 1)
     Louvain clusters root@42 and root@17 together. root@5 is separate.
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
          edges: [root@42→root@17: 1, root@17→root@42: 1, root@42→root@5: 1],
          createdAt: 10:35:01
        }
```

## Implementation specification

Concrete interfaces, function signatures, and module boundaries. Each subsection corresponds to a file in the file map. Types are defined once in `types.ts` and imported everywhere else.

### `src/aggregation/types.ts` — type additions

These types are added alongside the existing `Bundle`, `Edge`, `StampedCapture`, etc. The existing `Aggregator` interface is extended with transition log methods.

```typescript
// ── Transition log ─────────────────────────────────────────

/** Raw transition record. Logged by the bundler on every source change. */
export type Transition = {
    from: string;
    to: string;
    ts: number;
    dwellMs: number;
};

// ── Directed graph (built by packer at flush time) ─────────

export type DirectedGraph = {
    nodes: Set<string>;
    /** Key: "from\0to", value: aggregated weight (transition count). */
    edges: Map<string, number>;
    inDegree: Map<string, number>;
    outDegree: Map<string, number>;
    totalWeight: number;
};

// ── Louvain ────────────────────────────────────────────────

export type LouvainResult = {
    /** source (or chunk ID) → community ID */
    communities: Map<string, string>;
    modularity: number;
};

// ── Preprocessing ──────────────────────────────────────────

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

// ── Groups & Packets ───────────────────────────────────────

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

// ── Aggregator interface (extended) ────────────────────────

export type Aggregator = {
    ingest(capture: Capture, tabId: string): void;
    ingestSignal(signal: Signal, tabId: string): void;
    onVisibilityChanged(tabId: string, visible: boolean): void;

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

### `src/aggregation/bundler.ts` — transition log

The bundler currently calls `graph.recordEdge(from, to)` on every transition and has complex dwell logic (`graphCursor`, `pendingEdge`, `dwellTimer`, `commitPending()`, `moveCursor()`). Replace all of that with a simple internal transition log. The bundler no longer takes a `graph` parameter. Dwell-based transient filtering moves to `preprocess.ts`.

```typescript
import type { Transition, StampedCapture, StampedSignal, Bundle } from "./types.ts";

export function createBundler() {
    let activeSource: string | null = null;
    let openBundle: Bundle | null = null;
    const sealed: Bundle[] = [];
    const transitions: Transition[] = [];

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

    // ... openNew, seal, ingest, ingestSignal unchanged ...

    function getTransitions(): Transition[] {
        return [...transitions];
    }

    function drainTransitions(): Transition[] {
        const result = [...transitions];
        transitions.length = 0;
        return result;
    }

    return {
        ingest, ingestSignal,
        getActiveSource, getOpenBundle,
        seal, transition,
        getSealed, drainSealed,
        getTransitions, drainTransitions,
    };
}
```

**Key change:** `dwellMs` is computed from the sealed bundle's `endedAt - startedAt`. We capture `from` before calling `seal()`, then read the last sealed bundle after `seal()` completes. All dwell machinery (`graphCursor`, `pendingEdge`, `dwellTimer`, `DWELL_MS`, `commitPending()`, `moveCursor()`) is removed — transient filtering is handled by `preprocess.ts`.

### `src/aggregation/index.ts` — aggregator facade

The aggregator facade adds `getTransitions`, `drainTransitions`, and `seal` to its return object, delegating to the bundler. No new logic — just wiring.

```typescript
export function createAggregator(): Aggregator {
    const bundler = createBundler();
    // ... existing ingest, ingestSignal, onVisibilityChanged ...

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
}
```

### `src/aggregation/preprocess.ts`

The preprocessing pipeline. Single entry point, internal helpers for each stage.

```typescript
import type { Transition, PreprocessResult, ChunkInfo } from "./types.ts";
import { OFF_BROWSER } from "./types.ts";

// ── Constants (defaults) ────────────────────────────────────

const SENTINEL_PASSTHROUGH_MS = 2_000;
const SENTINEL_BREAK_MS = 600_000;       // 10 minutes
const TRANSIENT_DWELL_MS = 500;
const TRANSIENT_CHAIN_MS = 1_000;
const HUB_THRESHOLD_PERCENT = 0.1;
const HUB_MIN_SOURCES = 15;
const TARGET_PER_CHUNK = 4;
const MIN_CHUNK_MS = 60_000;             // 1 minute
const MAX_CHUNK_MS = 900_000;            // 15 minutes

// ── Options ─────────────────────────────────────────────────

/**
 * All preprocessing constants are overridable via PreprocessOptions.
 * This is used by the DevHub grouped view (GraphView.tsx) for
 * real-time parameter tuning. Production callers omit options
 * to use the defaults above.
 */
export type PreprocessOptions = {
    sentinelPassthroughMs?: number;
    sentinelBreakMs?: number;
    transientDwellMs?: number;
    transientChainMs?: number;
    hubThresholdPercent?: number;
    hubMinSources?: number;
    targetPerChunk?: number;
    minChunkMs?: number;
    maxChunkMs?: number;
};

/**
 * Internal resolved options — all fields required.
 * Built by resolveOptions() which merges caller overrides with defaults.
 */
type ResolvedOptions = Required<PreprocessOptions>;

function resolveOptions(opts?: PreprocessOptions): ResolvedOptions;

// ── Public API ─────────────────────────────────────────────

/**
 * Full preprocessing pipeline: sentinel splitting → transient removal
 * → hub detection → hub temporal chunking.
 *
 * Returns the rewritten transition list and metadata needed for
 * bundle assignment after Louvain.
 *
 * @param raw       Raw transitions from drainTransitions().
 * @param options   Optional overrides for all preprocessing constants.
 *                  Omit for production defaults. Used by DevHub for tuning.
 */
export function preprocess(
    raw: Transition[],
    opts?: PreprocessOptions,
): PreprocessResult;

// ── Internal helpers ───────────────────────────────────────
// All helpers accept ResolvedOptions so constants flow from the caller.

/**
 * Step 1: Rewrite off_browser transitions.
 * - < sentinelPassthroughMs → collapse to direct A→B edge
 * - < sentinelBreakMs → replace with ephemeral off_browser:<n>
 * - ≥ sentinelBreakMs → remove both (break boundary)
 *
 * Returns { transitions, sentinelCount }.
 */
function splitSentinels(
    transitions: Transition[],
    opts: ResolvedOptions,
): { transitions: Transition[]; sentinelCount: number };

/**
 * Step 2: Identify and remove transient sources.
 * A source is transient if:
 *   (a) all outgoing transitions have dwellMs < transientDwellMs, OR
 *   (b) it appears in a chain of 3+ consecutive transitions all < transientChainMs
 *
 * Returns { transitions, excludedSources }.
 */
function removeTransients(
    transitions: Transition[],
    opts: ResolvedOptions,
): { transitions: Transition[]; excludedSources: Set<string> };

/**
 * Step 3: Detect hub sources.
 * A source is a hub if its unique neighbor count exceeds
 * hubThresholdPercent of all unique sources (when total ≥ hubMinSources).
 */
function detectHubs(
    transitions: Transition[],
    opts: ResolvedOptions,
): Set<string>;

/**
 * Step 4: Split each hub into temporal chunks with a dynamic window.
 * Rewrites transitions, replacing hub source IDs with chunk IDs.
 *
 * Returns { transitions, chunkMap }.
 */
function chunkHubs(
    transitions: Transition[],
    hubSources: Set<string>,
    opts: ResolvedOptions,
): { transitions: Transition[]; chunkMap: Map<string, ChunkInfo> };

/**
 * Compute the dynamic chunk window for a single hub.
 *
 *   idealChunks   = max(1, floor(connectionCount / targetPerChunk))
 *   rawWindowMs   = sessionMs / idealChunks
 *   chunkWindowMs = clamp(rawWindowMs, minChunkMs, maxChunkMs)
 */
function computeChunkWindow(
    hubTransitions: Transition[],
    opts: ResolvedOptions,
): number;
```

### `src/aggregation/directed-louvain.ts`

Graph construction and community detection. Two exported functions.

```typescript
import type { Transition, DirectedGraph, LouvainResult } from "./types.ts";

// ── Constants ──────────────────────────────────────────────

const DEFAULT_RESOLUTION = 1.0;
const MIN_IMPROVEMENT = 1e-6;
const MAX_PASSES = 10;
const MAX_LOCAL_ITERATIONS = 100;

// ── Public API ─────────────────────────────────────────────

/**
 * Aggregate preprocessed transitions into a weighted directed graph.
 *
 * Each transition A→B increments edges["A\0B"] by 1.
 * In-degree and out-degree are precomputed for the modularity formula.
 */
export function buildDirectedGraph(transitions: Transition[]): DirectedGraph;

/**
 * Two-phase Directed Louvain (Dugue & Perez 2022).
 *
 * Phase 1: Local greedy moves — each node evaluates moving to each
 *          neighbor's community; best positive ΔQ move is applied.
 *          Repeats until convergence (max MAX_LOCAL_ITERATIONS).
 *
 * Phase 2: Coarsen — communities become super-nodes, edges are
 *          aggregated. Repeat Phase 1 on the coarsened graph.
 *          Stops when no further improvement (max MAX_PASSES).
 *
 * @param resolution  Louvain γ parameter. Default 1.0.
 *                    <1 = larger communities, >1 = smaller.
 */
export function directedLouvain(
    graph: DirectedGraph,
    resolution?: number,
): LouvainResult;

// ── Internal types (not exported) ──────────────────────────

/**
 * Mutable community state maintained during Phase 1 iteration.
 * One entry per community. Updated in O(1) when a node moves.
 */
type CommunityState = {
    sigmaIn: number;     // Σ_in(c)  — sum of in-degrees
    sigmaOut: number;    // Σ_out(c) — sum of out-degrees
    internalWeight: number; // sum of edge weights within the community
};

/**
 * Per-node bookkeeping for fast ΔQ computation.
 */
type NodeState = {
    community: string;   // current community assignment
    kIn: number;         // node's total in-degree
    kOut: number;        // node's total out-degree
    selfLoop: number;    // weight of self-loop (if any)
};
```

### `src/aggregation/packer.ts`

The packer itself. Stateless — reads from the aggregator, transforms, returns a Packet.

```typescript
import type {
    Aggregator, Bundle, DirectedGraph, Edge,
    Group, GroupMeta, LouvainResult, Packet,
    PreprocessResult, Transition,
} from "./types.ts";
import { buildDirectedGraph, directedLouvain } from "./directed-louvain.ts";
import { dev } from "../event/dev.ts";
import { preprocess } from "./preprocess.ts";

// ── Public API ─────────────────────────────────────────────

/**
 * Create a packer bound to an aggregator instance.
 * The packer is stateless — it drains the aggregator on each flush.
 */
export function createPacker(aggregator: Aggregator): {
    /**
     * Drain all sealed bundles and transitions from the aggregator,
     * partition into groups, and assemble a Packet.
     *
     * Returns null if there are no bundles to pack.
     */
    flush(): Packet | null;
};

// ── Internal helpers (not exported) ────────────────────────

/**
 * Full partition pipeline:
 *   preprocess → buildDirectedGraph → directedLouvain → assignBundles
 *
 * Returns assembled Group[] ready for the Packet.
 */
function partitionIntoGroups(
    transitions: Transition[],
    bundles: Bundle[],
): { groups: Group[]; edges: Edge[] };

/**
 * Assign each bundle to a Louvain community.
 *
 * Three paths:
 *   1. source ∈ excludedSources → singleton group
 *   2. source ∈ hubSources → look up chunk by bundle.startedAt → community
 *   3. source in louvain.communities → that community's group
 *   4. else → singleton group (isolated, no transitions)
 *
 * Returns Map<groupKey, Bundle[]> where groupKey is either
 * a community ID or "singleton:<source>".
 */
function assignBundles(
    louvain: LouvainResult,
    bundles: Bundle[],
    preprocessResult: PreprocessResult,
): Map<string, Bundle[]>;

/**
 * Compute GroupMeta from a set of bundles.
 */
function computeMeta(bundles: Bundle[]): GroupMeta;

/**
 * Build compact Edge[] for the Packet payload from a DirectedGraph.
 * Converts the Map<"from\0to", weight> into Edge[].
 */
function graphToEdges(graph: DirectedGraph): Edge[];
```

### `flush()` implementation outline

```typescript
function flush(): Packet | null {
    // 1. Seal any in-flight bundle
    aggregator.seal();

    // 2. Drain
    const bundles = aggregator.drainSealed();
    const transitions = aggregator.drainTransitions();

    if (bundles.length === 0) return null;

    // 3. Partition
    const { groups, edges } = partitionIntoGroups(transitions, bundles);

    // 4. Assemble
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

### `createGraph()` removal

`createGraph()` and `graph.ts` have been deleted. The bundler no longer takes a `graph` parameter — it records raw transitions into an internal `transitions: Transition[]` array. `getEdges`/`drainEdges` are removed from the `Aggregator` interface, replaced by `getTransitions()`/`drainTransitions()`/`seal()`.

The DevHub graph view ([`src/dev/panels/GraphView.tsx`](../src/dev/panels/GraphView.tsx)) builds edges on-the-fly from the transition log via `buildDirectedGraph()` and runs `directedLouvain()` for its grouped community visualization. It uses `preprocess()` with `PreprocessOptions` for real-time parameter tuning. Since `getTransitions()` is a non-destructive read, the DevHub can poll it on every state update without interfering with the packer's `drainTransitions()` at flush time.

## File map

| File                                                                            | Role                                                                                                                                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/aggregation/packer.ts`](../src/aggregation/packer.ts)                     | `createPacker(aggregator)` — `flush()`, `partitionIntoGroups()`, `assignBundles()`, `makeGroup()`, `computeMeta()`, `graphToEdges()`            |
| [`src/aggregation/preprocess.ts`](../src/aggregation/preprocess.ts)             | `preprocess()` — off-browser splitting, transient detection, hub detection + chunking. Accepts optional `PreprocessOptions` for DevHub tuning   |
| [`src/aggregation/directed-louvain.ts`](../src/aggregation/directed-louvain.ts) | `buildDirectedGraph()` + `directedLouvain()` — graph construction and two-phase directed Louvain community detection                            |
| [`src/aggregation/index.ts`](../src/aggregation/index.ts)                       | `createAggregator()` — facade; exposes transition log via `getTransitions`/`drainTransitions`/`seal`                                            |
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts)                   | `createBundler()` — produces sealed Bundles and logs `Transition` records on each source change ([docs](./bundler.md))                          |
| ~~`src/aggregation/graph.ts`~~                                                  | **Deleted.** Replaced by the transition log in the bundler; edges are built by `buildDirectedGraph()` in `directed-louvain.ts` at flush time    |
| [`src/aggregation/translate.ts`](../src/aggregation/translate.ts)               | `translate(bundle)` — called at seal time by the bundler; packer uses the pre-computed `bundle.text` directly                                   |
| [`src/aggregation/types.ts`](../src/aggregation/types.ts)                       | `Bundle`, `Transition`, `Edge`, `Group`, `GroupMeta`, `Packet`, `DirectedGraph`, `LouvainResult`, `ChunkInfo`, `PreprocessResult`, `Aggregator` |
| [`src/background/main.ts`](../src/background/main.ts)                           | Wires packer with `chrome.alarms` flush trigger (every 5 min) and manual `dev:flush` handler                                                    |
