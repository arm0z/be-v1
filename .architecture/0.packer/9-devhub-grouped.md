# Step 9: DevHub grouped graph view with tunable parameters

## Goal

Add a fully client-side grouped graph view to the DevHub. When the user switches to the "Grouped" tab in GraphView:

1. The current transitions from the snapshot are run through `preprocess → buildDirectedGraph → directedLouvain` **in the DevHub itself** (not the service worker)
2. Nodes are colored by community assignment
3. The side panel shows tunable algorithm parameters (resolution γ, hub threshold, etc.)
4. Changing any parameter immediately recomputes and re-renders the grouped graph
5. The side panel shows stats: modularity score, community count, per-community breakdown

The "Raw" tab continues to show the plain aggregated edge graph as before.

## Prerequisites

Steps 1–8 complete. `preprocess`, `buildDirectedGraph`, and `directedLouvain` exist as importable modules.

## Design principles

- **All computation happens in the DevHub** — no new dev events, no service worker round-trips
- **The DevHub imports the aggregation modules directly** — `preprocess.ts`, `directed-louvain.ts` are pure functions with no Chrome API dependencies, so they can run in any JS context
- **Recomputation is triggered by**: (a) new snapshot arriving with updated transitions, or (b) user changing a parameter in the side panel
- **The force-directed layout is shared** — both Raw and Grouped tabs use the same physics engine, but Grouped colors nodes by community and draws community hulls

## Files to modify

1. `src/dev/panels/GraphView.tsx` — main changes: grouped mode, side panel content, parameter state
2. No other files need modification. The aggregation modules are imported directly.

## Current state of GraphView.tsx

Key existing infrastructure to build on:

- **Line 77:** `const [activeTab, setActiveTab] = useState<"raw" | "grouped">("raw");` — already exists
- **Lines 763–786:** Raw/Grouped tab toggle UI — already exists
- **Line 78:** `const [panelOpen, setPanelOpen] = useState(false);` — already exists
- **Lines 816–818:** Empty side panel div — `<div className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-background" />` — needs content
- **Lines 55–57:** `nodesRef`, `edgesRef`, `urlsRef` — refs that hold graph state
- **Line 58:** `processedRef` — tracks how many entries have been processed

## Architecture

```
GraphView
├── Raw mode:  snapshot.transitions → aggregateEdges() → force layout → render (existing)
├── Grouped mode: snapshot.transitions → preprocess() → buildDirectedGraph() → directedLouvain()
│                                        → force layout with community colors → render
└── Side panel: parameter controls + stats (visible in both modes, content varies)
```

## Detailed changes

### 1. Add imports for aggregation modules

At the top of `GraphView.tsx`:

```typescript
import { preprocess } from "@/aggregation/preprocess";
import { buildDirectedGraph, directedLouvain } from "@/aggregation/directed-louvain";
import type { Transition, PreprocessResult, LouvainResult, DirectedGraph } from "@/aggregation/types";
```

### 2. Add parameter state

Add these state variables inside the `GraphView` component:

```typescript
// Tunable algorithm parameters (side panel controls)
const [resolution, setResolution] = useState(1.0);
const [hubThreshold, setHubThreshold] = useState(0.1);
const [hubMinSources, setHubMinSources] = useState(15);
const [sentinelPassthroughMs, setSentinelPassthroughMs] = useState(2000);
const [sentinelBreakMs, setSentinelBreakMs] = useState(600000);
const [transientDwellMs, setTransientDwellMs] = useState(500);
const [targetPerChunk, setTargetPerChunk] = useState(4);
```

**Note:** The preprocess module currently uses hardcoded constants. To make these tunable from the DevHub, we need to either:

**(Option A — recommended):** Add an optional `options` parameter to `preprocess()`:

```typescript
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

export function preprocess(raw: Transition[], options?: PreprocessOptions): PreprocessResult;
```

Each constant falls back to its default if not provided in options. This keeps the packer's production call simple (`preprocess(transitions)`) while allowing the DevHub to override values.

**This means step 5 (preprocess.ts) should have been written to accept options. If it wasn't, modify `preprocess.ts` in this step to add the optional parameter.** The change is backward-compatible — existing callers pass no options and get default behavior.

Similarly, `directedLouvain` already accepts an optional `resolution` parameter, so that's covered.

### 3. Add grouped graph computation

Add a `useMemo` that recomputes the grouped result whenever transitions or parameters change:

```typescript
// Extract transitions from the latest snapshot
const latestTransitions = useMemo(() => {
    // Find the last state.snapshot entry
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.event === "state.snapshot" && entry.data) {
            const snapshot = entry.data as { transitions?: Transition[] };
            return snapshot.transitions ?? [];
        }
    }
    return [];
}, [entries]);

// Compute grouped graph when in grouped mode
const groupedResult = useMemo(() => {
    if (activeTab !== "grouped" || latestTransitions.length === 0) return null;

    const pr = preprocess(latestTransitions, {
        sentinelPassthroughMs,
        sentinelBreakMs,
        transientDwellMs,
        hubThresholdPercent: hubThreshold,
        hubMinSources,
        targetPerChunk,
    });

    const graph = buildDirectedGraph(pr.transitions);
    const louvain = directedLouvain(graph, resolution);

    return { pr, graph, louvain };
}, [
    activeTab, latestTransitions,
    resolution, hubThreshold, hubMinSources,
    sentinelPassthroughMs, sentinelBreakMs,
    transientDwellMs, targetPerChunk,
]);
```

### 4. Community color assignment

Generate a stable color for each community:

```typescript
const COMMUNITY_COLORS = [
    "hsl(210, 80%, 60%)",   // blue
    "hsl(150, 70%, 50%)",   // green
    "hsl(30, 90%, 60%)",    // orange
    "hsl(280, 70%, 60%)",   // purple
    "hsl(0, 80%, 60%)",     // red
    "hsl(60, 80%, 50%)",    // yellow
    "hsl(180, 70%, 50%)",   // teal
    "hsl(330, 70%, 60%)",   // pink
];

function getCommunityColor(communityId: string, communityIds: string[]): string {
    const index = communityIds.indexOf(communityId);
    return COMMUNITY_COLORS[index % COMMUNITY_COLORS.length];
}
```

### 5. Modify the `draw()` function

The draw function needs to know whether we're in raw or grouped mode:

- **Raw mode:** nodes are all the same color (existing behavior)
- **Grouped mode:** nodes are colored by community. Additionally, draw translucent convex hulls around each community's nodes.

The key change in the node rendering section:

```typescript
// In the draw function, when rendering nodes:
if (activeTab === "grouped" && groupedResult) {
    const communityId = groupedResult.louvain.communities.get(node.id);
    const uniqueCommunities = [...new Set(groupedResult.louvain.communities.values())];
    const color = communityId
        ? getCommunityColor(communityId, uniqueCommunities)
        : "rgba(120,120,120,0.4)";  // unclustered nodes are gray
    ctx.fillStyle = color;
} else {
    // existing raw mode coloring
    ctx.fillStyle = isUnknown
        ? "rgba(120,120,120,0.4)"
        : isHovered
            ? "hsl(210, 90%, 68%)"
            : "hsl(210, 80%, 60%)";
}
```

**Community hulls** — draw before nodes/edges:

```typescript
if (activeTab === "grouped" && groupedResult) {
    const uniqueCommunities = [...new Set(groupedResult.louvain.communities.values())];

    for (const communityId of uniqueCommunities) {
        // Collect all nodes in this community
        const communityNodes: Node[] = [];
        for (const [nodeId, cId] of groupedResult.louvain.communities) {
            if (cId === communityId) {
                const node = nodesRef.current.get(nodeId);
                if (node) communityNodes.push(node);
            }
        }

        if (communityNodes.length < 2) continue;

        // Draw a translucent convex hull around the community
        const hull = convexHull(communityNodes.map(n => [n.x, n.y]));
        if (hull.length < 3) continue;

        const color = getCommunityColor(communityId, uniqueCommunities);
        ctx.beginPath();
        // Expand hull outward by padding for visual separation
        const padding = 20;
        const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
        const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;

        const expanded = hull.map(([x, y]) => {
            const dx = x - cx;
            const dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            return [x + (dx / dist) * padding, y + (dy / dist) * padding] as [number, number];
        });

        ctx.moveTo(expanded[0][0], expanded[0][1]);
        for (let i = 1; i < expanded.length; i++) {
            ctx.lineTo(expanded[i][0], expanded[i][1]);
        }
        ctx.closePath();
        // Parse the HSL color and set low alpha for the hull fill
        ctx.fillStyle = color.replace(")", ", 0.08)").replace("hsl(", "hsla(");
        ctx.fill();
        ctx.strokeStyle = color.replace(")", ", 0.3)").replace("hsl(", "hsla(");
        ctx.lineWidth = 1;
        ctx.stroke();
    }
}
```

**Convex hull helper** — add as a module-level utility:

```typescript
function convexHull(points: [number, number][]): [number, number][] {
    if (points.length < 3) return points;
    const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    function cross(o: [number, number], a: [number, number], b: [number, number]): number {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }

    const lower: [number, number][] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop();
        }
        lower.push(p);
    }

    const upper: [number, number][] = [];
    for (const p of sorted.reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop();
        }
        upper.push(p);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
}
```

### 6. Modify data sourcing for grouped mode

In grouped mode, the edges and nodes for the force layout come from the **preprocessed** graph, not the raw transitions:

```typescript
// When activeTab === "grouped" and groupedResult is available:
// - Nodes come from groupedResult.graph.nodes
// - Edges come from groupedResult.graph.edges (Map<"from\0to", weight>)
// The force layout operates on these instead of the raw aggregated edges
```

The `processEntries` callback (or a new parallel function) should populate `nodesRef` and `edgesRef` differently depending on the active tab. When the tab switches, clear and rebuild the node/edge maps.

**Approach:** Add a `useEffect` that reacts to `activeTab` and `groupedResult` changes:

```typescript
useEffect(() => {
    if (activeTab === "grouped" && groupedResult) {
        const nodes = nodesRef.current;
        const edges = edgesRef.current;
        // Preserve existing node positions where possible
        const oldPositions = new Map<string, { x: number; y: number }>();
        for (const [id, node] of nodes) {
            oldPositions.set(id, { x: node.x, y: node.y });
        }

        nodes.clear();
        edges.clear();

        // Populate from grouped graph
        for (const nodeId of groupedResult.graph.nodes) {
            const old = oldPositions.get(nodeId);
            nodes.set(nodeId, {
                id: nodeId,
                x: old?.x ?? (Math.random() - 0.5) * 200,
                y: old?.y ?? (Math.random() - 0.5) * 200,
                vx: 0, vy: 0,
                firstSeen: 0, lastSeen: 0,
            });
        }

        for (const [key, weight] of groupedResult.graph.edges) {
            const sep = key.indexOf("\0");
            const from = key.slice(0, sep);
            const to = key.slice(sep + 1);
            edges.set(`${from}->${to}`, { from, to, weight });
        }

        awakeRef.current = true;
    }
    // When switching back to raw, the processEntries callback will repopulate from entries
}, [activeTab, groupedResult]);
```

### 7. Side panel content

The side panel should display different content based on the active tab.

#### Side panel structure

```tsx
{panelOpen && (
    <div className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-background">
        <div className="border-b border-border px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {activeTab === "grouped" ? "Algorithm Parameters" : "Graph Info"}
            </h3>
        </div>
        <div className="dev-scrollbar flex-1 overflow-y-auto p-3 space-y-4">
            {activeTab === "grouped" ? <GroupedPanel /> : <RawPanel />}
        </div>
    </div>
)}
```

#### `RawPanel` — basic stats for raw mode

```tsx
function RawPanel() {
    const nodeCount = nodesRef.current.size;
    const edgeCount = edgesRef.current.size;
    const transitionCount = latestTransitions.length;

    return (
        <div className="space-y-3 text-xs">
            <div>
                <div className="text-muted-foreground">Transitions</div>
                <div className="text-lg tabular-nums">{transitionCount}</div>
            </div>
            <div>
                <div className="text-muted-foreground">Nodes</div>
                <div className="text-lg tabular-nums">{nodeCount}</div>
            </div>
            <div>
                <div className="text-muted-foreground">Edges</div>
                <div className="text-lg tabular-nums">{edgeCount}</div>
            </div>
        </div>
    );
}
```

#### `GroupedPanel` — tunable parameters + stats

Use shadcn Slider and Input components for parameter controls. Each control should show the parameter name, current value, and a slider or input for adjustment.

```tsx
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
```

```tsx
function GroupedPanel() {
    return (
        <div className="space-y-4 text-xs">
            {/* ── Stats ── */}
            {groupedResult && (
                <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Results
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <span className="text-muted-foreground">Modularity</span>
                        <span className="text-right tabular-nums">
                            {groupedResult.louvain.modularity.toFixed(4)}
                        </span>
                        <span className="text-muted-foreground">Communities</span>
                        <span className="text-right tabular-nums">
                            {new Set(groupedResult.louvain.communities.values()).size}
                        </span>
                        <span className="text-muted-foreground">Nodes</span>
                        <span className="text-right tabular-nums">
                            {groupedResult.graph.nodes.size}
                        </span>
                        <span className="text-muted-foreground">Edges</span>
                        <span className="text-right tabular-nums">
                            {groupedResult.graph.edges.size}
                        </span>
                        <span className="text-muted-foreground">Hubs detected</span>
                        <span className="text-right tabular-nums">
                            {groupedResult.pr.hubSources.size}
                        </span>
                        <span className="text-muted-foreground">Sentinels</span>
                        <span className="text-right tabular-nums">
                            {groupedResult.pr.sentinelCount}
                        </span>
                        <span className="text-muted-foreground">Excluded (transient)</span>
                        <span className="text-right tabular-nums">
                            {groupedResult.pr.excludedSources.size}
                        </span>
                    </div>
                </div>
            )}

            <Separator />

            {/* ── Louvain ── */}
            <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Louvain
                </div>
                <div>
                    <Label className="text-xs">Resolution (γ): {resolution.toFixed(2)}</Label>
                    <Slider
                        min={0.1} max={3.0} step={0.05}
                        value={[resolution]}
                        onValueChange={([v]) => setResolution(v)}
                    />
                    <div className="flex justify-between text-muted-foreground">
                        <span>0.1 (larger)</span>
                        <span>3.0 (smaller)</span>
                    </div>
                </div>
            </div>

            <Separator />

            {/* ── Off-browser ── */}
            <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Off-browser sentinel
                </div>
                <div>
                    <Label className="text-xs">Pass-through: {(sentinelPassthroughMs / 1000).toFixed(1)}s</Label>
                    <Slider
                        min={500} max={10000} step={500}
                        value={[sentinelPassthroughMs]}
                        onValueChange={([v]) => setSentinelPassthroughMs(v)}
                    />
                </div>
                <div>
                    <Label className="text-xs">Break boundary: {(sentinelBreakMs / 60000).toFixed(0)} min</Label>
                    <Slider
                        min={60000} max={1800000} step={60000}
                        value={[sentinelBreakMs]}
                        onValueChange={([v]) => setSentinelBreakMs(v)}
                    />
                </div>
            </div>

            <Separator />

            {/* ── Transient ── */}
            <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Transient detection
                </div>
                <div>
                    <Label className="text-xs">Dwell threshold: {transientDwellMs}ms</Label>
                    <Slider
                        min={100} max={2000} step={100}
                        value={[transientDwellMs]}
                        onValueChange={([v]) => setTransientDwellMs(v)}
                    />
                </div>
            </div>

            <Separator />

            {/* ── Hub detection ── */}
            <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Hub detection
                </div>
                <div>
                    <Label className="text-xs">Threshold: {(hubThreshold * 100).toFixed(0)}%</Label>
                    <Slider
                        min={0.05} max={0.5} step={0.01}
                        value={[hubThreshold]}
                        onValueChange={([v]) => setHubThreshold(v)}
                    />
                </div>
                <div>
                    <Label className="text-xs">Min sources: {hubMinSources}</Label>
                    <Slider
                        min={3} max={30} step={1}
                        value={[hubMinSources]}
                        onValueChange={([v]) => setHubMinSources(v)}
                    />
                </div>
                <div>
                    <Label className="text-xs">Target per chunk: {targetPerChunk}</Label>
                    <Slider
                        min={2} max={10} step={1}
                        value={[targetPerChunk]}
                        onValueChange={([v]) => setTargetPerChunk(v)}
                    />
                </div>
            </div>

            <Separator />

            {/* ── Per-community breakdown ── */}
            {groupedResult && (
                <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Communities
                    </div>
                    {(() => {
                        // Group nodes by community
                        const communities = new Map<string, string[]>();
                        for (const [nodeId, communityId] of groupedResult.louvain.communities) {
                            let members = communities.get(communityId);
                            if (!members) {
                                members = [];
                                communities.set(communityId, members);
                            }
                            members.push(nodeId);
                        }
                        const uniqueCommunities = [...communities.keys()];

                        return [...communities.entries()].map(([communityId, members]) => (
                            <div key={communityId} className="rounded border border-border/50 p-2">
                                <div className="flex items-center gap-2">
                                    <div
                                        className="h-2.5 w-2.5 rounded-full"
                                        style={{ backgroundColor: getCommunityColor(communityId, uniqueCommunities) }}
                                    />
                                    <span className="font-medium">{members.length} nodes</span>
                                </div>
                                <div className="mt-1 space-y-px">
                                    {members.map(id => (
                                        <div key={id} className="truncate text-muted-foreground">{id}</div>
                                    ))}
                                </div>
                            </div>
                        ));
                    })()}
                </div>
            )}
        </div>
    );
}
```

### 8. Modify `preprocess.ts` to accept options

If not already done, update `preprocess()` in `src/aggregation/preprocess.ts`:

```typescript
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

export function preprocess(raw: Transition[], options?: PreprocessOptions): PreprocessResult {
    const opts = {
        sentinelPassthroughMs: options?.sentinelPassthroughMs ?? SENTINEL_PASSTHROUGH_MS,
        sentinelBreakMs: options?.sentinelBreakMs ?? SENTINEL_BREAK_MS,
        transientDwellMs: options?.transientDwellMs ?? TRANSIENT_DWELL_MS,
        transientChainMs: options?.transientChainMs ?? TRANSIENT_CHAIN_MS,
        hubThresholdPercent: options?.hubThresholdPercent ?? HUB_THRESHOLD_PERCENT,
        hubMinSources: options?.hubMinSources ?? HUB_MIN_SOURCES,
        targetPerChunk: options?.targetPerChunk ?? TARGET_PER_CHUNK,
        minChunkMs: options?.minChunkMs ?? MIN_CHUNK_MS,
        maxChunkMs: options?.maxChunkMs ?? MAX_CHUNK_MS,
    };

    // Pass opts through to each stage instead of using module-level constants
    // ...
}
```

**Also export `PreprocessOptions` from `types.ts`** so the DevHub can import it:

```typescript
export type { PreprocessOptions } from "./preprocess.ts";
```

Or just have GraphView import it directly from `preprocess.ts`.

## What this looks like

```
┌──────────────────────────────────────────┬─────────────────────────┐
│  [Raw] [Grouped]                    ⊞ ⊟ ▫│  Algorithm Parameters   │
│                                          │                         │
│      ┌───────────────────┐               │  Results                │
│      │  ● A    ● B       │  Community 0  │  Modularity    0.4231   │
│      │     ● C           │  (blue hull)  │  Communities   3        │
│      └───────────────────┘               │  Nodes         12       │
│                                          │  Hubs          1        │
│         ● D                              │                         │
│                                          │  ─────────────────────  │
│      ┌──────────┐                        │  Louvain                │
│      │  ● E     │  Community 1           │  Resolution (γ): 1.00   │
│      │     ● F  │  (green hull)          │  ═══════════○═══════    │
│      └──────────┘                        │  0.1            3.0     │
│                                          │                         │
│                                          │  ─────────────────────  │
│                                          │  Communities            │
│                                          │  ● 3 nodes: A, B, C    │
│                                          │  ● 2 nodes: E, F       │
│                                          │  ● 1 node:  D          │
└──────────────────────────────────────────┴─────────────────────────┘
```

## Verification

```bash
npx tsc --noEmit   # zero errors
npx vite build     # clean build
```

Manual testing:
1. Load extension, browse several tabs
2. Open DevHub → Graph tab
3. Verify "Raw" tab shows plain graph (existing behavior)
4. Switch to "Grouped" tab → nodes should be colored by community, hulls visible
5. Open side panel → verify stats appear (modularity, community count)
6. Adjust resolution slider → graph recolors immediately (lower γ → fewer larger communities, higher → more smaller)
7. Adjust hub threshold → see how hub detection changes
8. Verify no console errors, no lag on parameter changes

## Documentation update

After completing this step, update `.architecture/packer.md`:

Add a new section after "Dev logs":

```markdown
## DevHub integration

The DevHub's Graph panel has two modes:

- **Raw** — force-directed layout of aggregated transitions. Each transition pair becomes a weighted edge. No preprocessing.
- **Grouped** — runs the full packer pipeline (`preprocess → buildDirectedGraph → directedLouvain`) client-side in the DevHub. Nodes are colored by community, with translucent convex hulls around each community. The side panel exposes all algorithm parameters as sliders for real-time tuning.

All computation happens in the DevHub itself. The aggregation modules (`preprocess.ts`, `directed-louvain.ts`) are pure functions with no Chrome API dependencies and are imported directly by `GraphView.tsx`. The DevHub reads transitions from the latest state snapshot (`getTransitions()` — non-destructive) and recomputes on every snapshot update or parameter change.

**Tunable parameters (side panel):**
- Resolution γ (Louvain)
- Off-browser pass-through / break thresholds
- Transient dwell threshold
- Hub detection threshold, min sources, target per chunk
```

Also update the **File map** to note the DevHub integration:

```
| [`src/dev/panels/GraphView.tsx`](../src/dev/panels/GraphView.tsx) | Graph visualization. Raw mode (aggregated edges) + Grouped mode (client-side preprocess → Louvain with tunable parameters). **Implemented.** |
```
