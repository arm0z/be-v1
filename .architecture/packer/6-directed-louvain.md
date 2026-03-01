# Step 6: Create `directed-louvain.ts`

## Goal

Create `src/aggregation/directed-louvain.ts` — graph construction from transitions and the two-phase Directed Louvain community detection algorithm.

## Prerequisites

Steps 1–4 complete. `Transition`, `DirectedGraph`, and `LouvainResult` types exist in `types.ts`.

## File to create

`src/aggregation/directed-louvain.ts`

## Specification reference

`.architecture/packer.md` sections:
- "Graph construction" — `buildDirectedGraph()` specification
- "Directed Louvain" — full algorithm with math
- "Implementation specification → `src/aggregation/directed-louvain.ts`" — function signatures

## Imports

```typescript
import type { Transition, DirectedGraph, LouvainResult } from "./types.ts";
```

## Constants

```typescript
const DEFAULT_RESOLUTION = 1.0;
const MIN_IMPROVEMENT = 1e-6;
const MAX_PASSES = 10;
const MAX_LOCAL_ITERATIONS = 100;
```

## Exported function 1: `buildDirectedGraph`

```typescript
export function buildDirectedGraph(transitions: Transition[]): DirectedGraph
```

### Algorithm

1. Initialize: `nodes = new Set()`, `edges = new Map()`, `inDegree = new Map()`, `outDegree = new Map()`, `totalWeight = 0`
2. For each transition `{ from, to }`:
   - Add `from` and `to` to `nodes`
   - Key = `from + "\0" + to`
   - Increment `edges.get(key)` (or set to 1)
   - Increment `outDegree.get(from)` by 1 (or set to 1)
   - Increment `inDegree.get(to)` by 1 (or set to 1)
   - Increment `totalWeight` by 1
3. Ensure every node has an entry in both `inDegree` and `outDegree` (default 0)
4. Return `{ nodes, edges, inDegree, outDegree, totalWeight }`

### Edge cases
- Empty transitions: return `{ nodes: Set(), edges: Map(), inDegree: Map(), outDegree: Map(), totalWeight: 0 }`
- Self-loops (`from === to`): treat as a normal edge. It increments both inDegree and outDegree of the same node.

## Exported function 2: `directedLouvain`

```typescript
export function directedLouvain(graph: DirectedGraph, resolution?: number): LouvainResult
```

### Edge cases (handle BEFORE running the algorithm)

- **0 nodes:** return `{ communities: new Map(), modularity: 0 }`
- **1 node:** return `{ communities: Map([[node, node]]), modularity: 0 }`
- **All nodes disconnected (totalWeight === 0):** return each node in its own community, modularity 0

### Internal types

```typescript
type CommunityState = {
    sigmaIn: number;       // Σ_in(c) — sum of in-degrees of all nodes in community
    sigmaOut: number;      // Σ_out(c) — sum of out-degrees of all nodes in community
    internalWeight: number; // sum of edge weights where both endpoints are in this community
};

type NodeState = {
    community: string;     // current community assignment
    kIn: number;           // node's total in-degree
    kOut: number;          // node's total out-degree
    selfLoop: number;      // weight of self-loop edge (node → node), 0 if none
};
```

### Initialization

1. Set `γ = resolution ?? DEFAULT_RESOLUTION`
2. Each node starts in its own community (community ID = node ID)
3. Initialize `NodeState` for each node:
   - `community = nodeId`
   - `kIn = graph.inDegree.get(nodeId) ?? 0`
   - `kOut = graph.outDegree.get(nodeId) ?? 0`
   - `selfLoop = graph.edges.get(nodeId + "\0" + nodeId) ?? 0`
4. Initialize `CommunityState` for each community:
   - `sigmaIn = kIn` (initially just the one node)
   - `sigmaOut = kOut`
   - `internalWeight = selfLoop`

### Phase 1: Local greedy moves

Repeat up to `MAX_LOCAL_ITERATIONS` times:

```
improved = false
for each node i (iterate in arbitrary but fixed order):
    currentCommunity = nodeState[i].community
    bestDeltaQ = 0
    bestCommunity = currentCommunity

    // Find all neighbor communities
    neighborCommunities = set of communities of nodes connected to i by any edge

    for each candidate community c in neighborCommunities:
        if c === currentCommunity: skip

        // Compute ΔQ for moving i from currentCommunity to c
        deltaQ = computeDeltaQ(i, currentCommunity, c)

        if deltaQ > bestDeltaQ:
            bestDeltaQ = deltaQ
            bestCommunity = c

    if bestCommunity !== currentCommunity:
        // Move node i to bestCommunity
        removeNodeFromCommunity(i, currentCommunity)
        addNodeToCommunity(i, bestCommunity)
        nodeState[i].community = bestCommunity
        improved = true

if not improved: break
```

### ΔQ computation

For moving node `i` from community `c_old` to community `c_new`:

```
ΔQ = ΔQ_insert(i → c_new) - ΔQ_remove(i from c_old)
```

**ΔQ_insert(i → c):**
```
w_i_to_c   = sum of edge weights from i to nodes in c
w_c_to_i   = sum of edge weights from nodes in c to i
sigma_in_c = communityState[c].sigmaIn
sigma_out_c = communityState[c].sigmaOut
m = graph.totalWeight

ΔQ_insert = (w_i_to_c + w_c_to_i) / m
          - γ * (kOut_i * sigma_in_c + kIn_i * sigma_out_c) / (m * m)
```

**ΔQ_remove(i from c_old):**
```
w_i_to_cold   = sum of edge weights from i to nodes in c_old (EXCLUDING self-loop)
w_cold_to_i   = sum of edge weights from nodes in c_old to i (EXCLUDING self-loop)
sigma_in_cold  = communityState[c_old].sigmaIn
sigma_out_cold = communityState[c_old].sigmaOut

ΔQ_remove = (w_i_to_cold + w_cold_to_i) / m
          - γ * (kOut_i * (sigma_in_cold - kIn_i) + kIn_i * (sigma_out_cold - kOut_i)) / (m * m)
```

**Computing `w_i_to_c` and `w_c_to_i`:** Iterate over all edges involving node `i`. For each edge `i → j`, if `nodeState[j].community === c`, add the edge weight to `w_i_to_c`. For each edge `j → i`, if `nodeState[j].community === c`, add to `w_c_to_i`.

**Helper:** Build an adjacency list at initialization for fast neighbor iteration:
```typescript
// outEdges[node] = Map<targetNode, weight>
// inEdges[node] = Map<sourceNode, weight>
```

### Phase 2: Coarsen

After Phase 1 converges:

1. Build a mapping from old community IDs to new super-node IDs (renumber communities 0, 1, 2, ...)
2. Create a new graph where:
   - Each super-node = one community from Phase 1
   - Edge weight between super-nodes = sum of all edge weights between their member nodes
   - Self-loop weight = internalWeight of the community
3. Run Phase 1 again on the coarsened graph
4. Map the final community assignments back to the original node IDs

### Outer loop

```
pass = 0
currentGraph = graph
nodeToOriginal = identity mapping

while pass < MAX_PASSES:
    result = phase1(currentGraph)
    if modularity improvement < MIN_IMPROVEMENT: break
    { coarsenedGraph, mapping } = coarsen(currentGraph, result)
    update nodeToOriginal through mapping
    currentGraph = coarsenedGraph
    pass++

return { communities: nodeToOriginal, modularity: computeModularity() }
```

### Final modularity computation

After all passes, compute the final modularity score:

```
Q = (1/m) * Σ_over_all_edges(A_ij - γ * kOut_i * kIn_j / m) * δ(c_i, c_j)
```

This is computed by summing over all edges where both endpoints are in the same community.

### Performance notes

- For the expected input size (10–50 nodes, 50–500 edges), this runs in microseconds
- No need for randomization or parallelism
- The adjacency list lookup is the hot path — use Map for O(1) access

## Complete file structure

```typescript
import type { Transition, DirectedGraph, LouvainResult } from "./types.ts";

const DEFAULT_RESOLUTION = 1.0;
const MIN_IMPROVEMENT = 1e-6;
const MAX_PASSES = 10;
const MAX_LOCAL_ITERATIONS = 100;

export function buildDirectedGraph(transitions: Transition[]): DirectedGraph {
    // ... as described above
}

export function directedLouvain(graph: DirectedGraph, resolution?: number): LouvainResult {
    // ... as described above
}

// --- internal types and helpers (not exported) ---

type CommunityState = { ... };
type NodeState = { ... };

function phase1(...): ... { ... }
function coarsen(...): ... { ... }
function computeModularity(...): number { ... }
```

## Test cases to verify mentally

### Two connected nodes
```
A → B (weight 1), B → A (weight 1)
```
Result: both in the same community.

### Two disconnected pairs
```
A → B (weight 1), B → A (weight 1)
C → D (weight 1), D → C (weight 1)
```
Result: {A, B} in one community, {C, D} in another.

### Star graph (hub)
```
A → B, A → C, A → D, A → E
```
With resolution 1.0, depends on return edges. If no return edges, A might be isolated or grouped with the strongest connection.

### Single node
```
nodes: {A}, no edges
```
Result: `{ communities: Map([["A", "A"]]), modularity: 0 }`

### Empty graph
Result: `{ communities: Map(), modularity: 0 }`

## Verification

```bash
npx tsc --noEmit   # zero errors
npx vite build     # clean build
```

The file should compile cleanly. It's a pure function — no side effects, no Chrome API dependencies.

## Documentation update

After completing this step, update `.architecture/packer.md`:

In the **File map** table, change the `directed-louvain.ts` row to:
```
| `src/aggregation/directed-louvain.ts` | `buildDirectedGraph()` + `directedLouvain()` — **Implemented.** Graph construction from transitions and two-phase Directed Louvain (Dugue & Perez 2022). |
```
