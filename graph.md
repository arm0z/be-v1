# Graph Generation System — Full Documentation

This document captures the complete graph generation system as it exists before refactoring. The graph tracks **user attention flow** between browser tab sources — every time the user switches from one tab/context to another, a directed, weighted edge is recorded.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Data Flow](#data-flow)
3. [Core Types](#core-types)
4. [Graph Store (`src/aggregation/graph.ts`)](#graph-store)
5. [Bundler State Machine (`src/aggregation/bundler.ts`)](#bundler-state-machine)
6. [Aggregator Orchestrator (`src/aggregation/index.ts`)](#aggregator-orchestrator)
7. [Service Worker Entry (`src/background/main.ts`)](#service-worker-entry)
8. [Edge Lifecycle — Detailed Walkthrough](#edge-lifecycle)
9. [Dwell-Time Heuristic](#dwell-time-heuristic)
10. [Key Design Decisions](#key-design-decisions)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome Extension — Service Worker (src/background/main.ts)    │
│                                                                 │
│  chrome.tabs.onActivated ──┐                                   │
│  chrome.windows.onFocus ───┤                                   │
│  chrome.runtime.onConnect ─┤    ┌──────────────────────────┐   │
│  (capture port)            ├───►│  Aggregator              │   │
│                             │    │  ┌────────────────────┐  │   │
│                             │    │  │  Bundler            │  │   │
│                             │    │  │  (state machine)    │  │   │
│                             │    │  │  - transition()     │──┼──►│ graph.recordEdge()
│                             │    │  │  - pendingEdge      │  │   │
│                             │    │  │  - dwellTimer       │  │   │
│                             │    │  └────────────────────┘  │   │
│                             │    │                          │   │
│                             │    │  ┌────────────────────┐  │   │
│                             │    │  │  Graph Store        │  │   │
│                             │    │  │  (in-memory maps)   │  │   │
│                             │    │  │  - edges            │  │   │
│                             │    │  │  - urls             │  │   │
│                             │    │  └────────────────────┘  │   │
│                             │    └──────────────────────────┘   │
│                                                                 │
│  Outputs: getEdges(), drainEdges(), dev.log("graph", ...)      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

Step-by-step, from browser event to recorded edge:

1. **Browser event** — User switches tabs (`chrome.tabs.onActivated`) or changes window focus (`chrome.windows.onFocusChanged`), or a capture arrives from a content script via a `"capture"` port.

2. **Aggregator** (`src/aggregation/index.ts`) — Determines the `source` identifier for the tab (`"{context}@{tabId}"` for captures, `"root@{tabId}"` for tab switches without a prior context). Calls `bundler.transition(source)`.

3. **Bundler** (`src/aggregation/bundler.ts`) — The state machine. Maintains a `graphCursor` (current position), a `pendingEdge` (transition awaiting dwell confirmation), and a `dwellTimer`. When `transition(to)` is called:
   - Seals the current open bundle.
   - Evaluates the pending edge: commit it (dwell >= 500ms), collapse it (too brief), or cancel it (returned to origin).
   - Creates a new pending edge from the current cursor to the new destination.
   - Starts a dwell timer to auto-commit after 500ms.

4. **Graph Store** (`src/aggregation/graph.ts`) — When `recordEdge(from, to)` is called, it either creates a new edge with weight 1, or increments the weight of an existing edge.

5. **Output** — Edges are available via `getEdges()` (read) or `drainEdges()` (read + clear, used by sync). The aggregator's `drainEdges()` calls `bundler.commitPending()` first to flush any pending edge.

---

## Core Types

**File: `src/aggregation/types.ts`**

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
    onWindowRemoved(windowId: number): void;
    getSealed(): Bundle[];
    getEdges(): Edge[];
    drainSealed(): Bundle[];
    drainEdges(): Edge[];
};
```

---

## Graph Store

**File: `src/aggregation/graph.ts`**

The graph is an in-memory directed weighted graph. Edges are keyed by `"${from}\0${to}"` (null byte separator). URLs are tracked per-source for display purposes.

```typescript
import type { Edge } from "./types.ts";
import { dev } from "../event/dev.ts";

export function createGraph() {
    const edges = new Map<string, Edge>();
    const urls = new Map<string, string>();

    function key(from: string, to: string): string {
        return `${from}\0${to}`;
    }

    function recordEdge(from: string, to: string): void {
        const k = key(from, to);
        const existing = edges.get(k);
        if (existing) {
            existing.weight++;
            dev.log(
                "graph",
                "edge.incremented",
                `${from} → ${to} (${existing.weight})`,
                { from, to, weight: existing.weight },
            );
        } else {
            const edge: Edge = { from, to, weight: 1 };
            edges.set(k, edge);
            dev.log("graph", "edge.created", `${from} → ${to}`, {
                from,
                to,
                weight: 1,
            });
        }
    }

    function getEdges(): Edge[] {
        return [...edges.values()];
    }

    function drainEdges(): Edge[] {
        const result = [...edges.values()];
        edges.clear();
        return result;
    }

    function recordUrl(source: string, url: string): void {
        const prev = urls.get(source);
        if (prev === url) return;
        urls.set(source, url);
        dev.log("graph", "url.updated", `${source} → ${url}`, {
            source,
            url,
        });
    }

    function getUrls(): Record<string, string> {
        return Object.fromEntries(urls);
    }

    return { recordEdge, getEdges, drainEdges, recordUrl, getUrls };
}
```

### Key behaviors

- **Edge creation**: First transition from A → B creates `{ from: "A", to: "B", weight: 1 }`. Emits `"edge.created"`.
- **Weight increment**: Subsequent A → B transitions increment `weight++`. Emits `"edge.incremented"`.
- **Directionality**: A → B and B → A are separate edges (different keys).
- **URL tracking**: `recordUrl()` maps source IDs to page URLs, used for display labels. Only emits when URL changes for a source.
- **drainEdges()**: Returns all edges then clears the map. Used by the aggregator's `drainEdges()` method (which also commits any pending edge first).
- **No persistence**: Everything is lost when the service worker restarts.

---

## Bundler State Machine

**File: `src/aggregation/bundler.ts`**

The bundler is the core state machine that decides **when** to record edges. It implements a **dwell-time heuristic** to filter out fleeting tab switches.

```typescript
import type { StampedCapture, StampedSignal, Bundle } from "./types.ts";
import { UNKNOWN, OFF_BROWSER } from "./types.ts";
import { translate } from "./translate.ts";
import { dev } from "../event/dev.ts";
import type { createGraph } from "./graph.ts";

const DWELL_MS = 500;

export function createBundler(graph: ReturnType<typeof createGraph>) {
    let activeSource: string | null = null;
    let graphCursor: string | null = null;
    let openBundle: Bundle | null = null;
    const sealed: Bundle[] = [];
    let pendingEdge: { from: string; to: string; arrivedAt: number } | null = null;
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;

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

    function commitPending(): void {
        if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
        if (pendingEdge) {
            graph.recordEdge(pendingEdge.from, pendingEdge.to);
            pendingEdge = null;
        }
    }

    function transition(to: string): void {
        seal();
        if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
        const now = Date.now();

        if (pendingEdge) {
            const elapsed = now - pendingEdge.arrivedAt;
            if (elapsed >= DWELL_MS) {
                // Destination was held long enough — commit
                graph.recordEdge(pendingEdge.from, pendingEdge.to);
                if (pendingEdge.to !== to) {
                    pendingEdge = { from: pendingEdge.to, to, arrivedAt: now };
                } else {
                    pendingEdge = null;
                }
            } else {
                // Too brief — collapse the intermediate node
                // A → X(brief) → B  becomes  A → B
                if (pendingEdge.from !== to) {
                    pendingEdge = { from: pendingEdge.from, to, arrivedAt: now };
                } else {
                    // Returned to origin — cancel entirely
                    pendingEdge = null;
                }
            }
        } else {
            const from = graphCursor;
            if (from && from !== to) {
                pendingEdge = { from, to, arrivedAt: now };
            }
        }

        // Auto-commit after dwell threshold if user stays
        if (pendingEdge) {
            dwellTimer = setTimeout(commitPending, DWELL_MS);
        }

        dev.log("aggregator", "transition", `${graphCursor ?? "∅"} → ${to}`, { from: graphCursor, to });
        graphCursor = to;
        activeSource = to;
        if (to !== UNKNOWN && to !== OFF_BROWSER) {
            openNew(to);
        }
    }

    function moveCursor(to: string): void {
        graphCursor = to;
    }

    function getGraphCursor(): string | null {
        return graphCursor;
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
        if (!openBundle) {
            if (activeSource && activeSource !== UNKNOWN && activeSource !== OFF_BROWSER) {
                openNew(activeSource);
            } else {
                return;
            }
        }
        openBundle.captures.push(stamped);
    }

    function getActiveSource(): string | null {
        return activeSource;
    }

    function getOpenBundle(): { source: string; startedAt: number; captureCount: number; captures: { type: string; timestamp: number }[] } | null {
        if (!openBundle) return null;
        return {
            source: openBundle.source,
            startedAt: openBundle.startedAt,
            captureCount: openBundle.captures.length,
            captures: openBundle.captures.map((c) => ({ type: c.type, timestamp: c.timestamp })),
        };
    }

    function getSealed(): Bundle[] {
        return [...sealed];
    }

    function drainSealed(): Bundle[] {
        const result = [...sealed];
        sealed.length = 0;
        return result;
    }

    return { ingest, ingestSignal, getActiveSource, getGraphCursor, getOpenBundle, seal, transition, moveCursor, getSealed, drainSealed, commitPending };
}
```

### Internal State

| Variable | Type | Purpose |
|---|---|---|
| `activeSource` | `string \| null` | Current source for bundle routing |
| `graphCursor` | `string \| null` | Current position in the graph (last committed or pending target) |
| `openBundle` | `Bundle \| null` | Currently accumulating bundle |
| `sealed` | `Bundle[]` | Completed bundles awaiting drain |
| `pendingEdge` | `{ from, to, arrivedAt } \| null` | Edge awaiting dwell confirmation |
| `dwellTimer` | `timeout \| null` | Auto-commit timer |

### Methods

| Method | Purpose |
|---|---|
| `transition(to)` | Core edge logic — evaluates pending edge, creates new pending, manages dwell timer |
| `commitPending()` | Force-commits any pending edge immediately |
| `ingest(stamped)` | Accepts a capture; triggers `transition()` if source changed |
| `ingestSignal(stamped)` | Accepts a signal; appends to open bundle (no transition) |
| `seal()` | Closes the open bundle, translates its content to text |
| `drainSealed()` | Returns and clears sealed bundles |

---

## Aggregator Orchestrator

**File: `src/aggregation/index.ts`**

The aggregator is the public API. It creates both the graph and bundler, manages tab-to-source mappings, handles Chrome window/tab lifecycle events, and exposes `getEdges()` / `drainEdges()`.

```typescript
import type { Capture, Signal } from "../event/types.ts";
import { OFF_BROWSER } from "./types.ts";

import type { Aggregator } from "./types.ts";
import { createBundler } from "./bundler.ts";
import { createGraph } from "./graph.ts";
import { dev } from "../event/dev.ts";

function signalPageUrl(signal: Signal): string | undefined {
    switch (signal.type) {
        case "nav.completed":
        case "nav.spa":
        case "nav.title_changed":
        case "tab.created":
        case "attention.active":
        case "attention.visible":
            return signal.payload.url || undefined;
        default:
            return undefined;
    }
}

export function createAggregator(): Aggregator {
    const graph = createGraph();
    const bundler = createBundler(graph);
    const tabSources = new Map<string, string>();
    const pendingSignals = new Map<
        string,
        { signal: Signal; tabId: string }[]
    >();
    const activeTabPerWindow = new Map<number, string>();
    let offBrowserTimer: ReturnType<typeof setTimeout> | null = null;
    const OFF_BROWSER_SETTLE_MS = 200;

    function emitState() {
        dev.log("aggregator", "state.snapshot", "state", {
            activeSource: bundler.getActiveSource(),
            openBundle: bundler.getOpenBundle(),
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
            edges: graph.getEdges(),
            urls: graph.getUrls(),
        });
    }

    function flushPending(tabId: string, source: string): void {
        const pending = pendingSignals.get(tabId);
        if (!pending) return;
        pendingSignals.delete(tabId);
        for (const p of pending) {
            const stamped = { ...p.signal, tabId: p.tabId, source };
            bundler.ingestSignal(stamped);
            const url = signalPageUrl(p.signal);
            if (url) graph.recordUrl(source, url);
        }
    }

    function ingest(capture: Capture, tabId: string): void {
        const source = `${capture.context}@${tabId}`;
        tabSources.set(tabId, source);
        dev.log("aggregator", capture.type, source, {
            tabId,
            source,
            payload: capture.payload,
        });
        const stamped = { ...capture, tabId, source };
        bundler.ingest(stamped);
        flushPending(tabId, source);
        emitState();
    }

    function ingestSignal(signal: Signal, tabId: string): void {
        if (tabId === "unknown") {
            const currentSource = bundler.getActiveSource();
            if (currentSource) {
                const stamped = { ...signal, tabId, source: currentSource };
                bundler.ingestSignal(stamped);
                emitState();
            }
            return;
        }

        const source = tabSources.get(tabId);

        if (!source) {
            let pending = pendingSignals.get(tabId);
            if (!pending) {
                pending = [];
                pendingSignals.set(tabId, pending);
            }
            pending.push({ signal, tabId });
            dev.log("aggregator", signal.type, "pending", {
                tabId,
                payload: signal.payload,
            });

            if (signal.type === "tab.closed") {
                pendingSignals.delete(tabId);
            }
            return;
        }

        dev.log("aggregator", signal.type, source, {
            tabId,
            source,
            payload: signal.payload,
        });
        const stamped = { ...signal, tabId, source };
        bundler.ingestSignal(stamped);

        const url = signalPageUrl(signal);
        if (url) graph.recordUrl(source, url);

        if (signal.type === "tab.closed") {
            tabSources.delete(tabId);
            pendingSignals.delete(tabId);
            for (const [windowId, activeTabId] of activeTabPerWindow.entries()) {
                if (activeTabId === tabId) {
                    activeTabPerWindow.delete(windowId);
                }
            }
        }
        emitState();
    }

    function cancelOffBrowser(): void {
        if (offBrowserTimer !== null) {
            clearTimeout(offBrowserTimer);
            offBrowserTimer = null;
        }
    }

    function startOffBrowserTimer(): void {
        cancelOffBrowser();
        bundler.seal();
        offBrowserTimer = setTimeout(() => {
            offBrowserTimer = null;
            bundler.transition(OFF_BROWSER);
            emitState();
        }, OFF_BROWSER_SETTLE_MS);
    }

    function onTabActivated(tabId: string, windowId: number): void {
        const prevTabId = activeTabPerWindow.get(windowId);
        activeTabPerWindow.set(windowId, tabId);

        if (offBrowserTimer !== null) {
            if (prevTabId === tabId) return;
            cancelOffBrowser();
        }

        let source = tabSources.get(tabId);
        if (!source) {
            source = `root@${tabId}`;
            tabSources.set(tabId, source);
        }
        bundler.transition(source);
        emitState();
    }

    function onWindowFocusChanged(windowId: number): void {
        if (windowId === chrome.windows.WINDOW_ID_NONE) {
            startOffBrowserTimer();
        } else {
            cancelOffBrowser();
            const tabId = activeTabPerWindow.get(windowId);
            if (tabId) {
                let source = tabSources.get(tabId);
                if (!source) {
                    source = `root@${tabId}`;
                    tabSources.set(tabId, source);
                }
                bundler.transition(source);
            }
        }
        emitState();
    }

    function onWindowRemoved(windowId: number): void {
        activeTabPerWindow.delete(windowId);
    }

    return {
        ingest,
        ingestSignal,
        onTabActivated,
        onWindowFocusChanged,
        onWindowRemoved,
        getSealed: bundler.getSealed,
        getEdges: graph.getEdges,
        drainSealed: bundler.drainSealed,
        drainEdges: () => { bundler.commitPending(); return graph.drainEdges(); },
    };
}
```

### Key details

- **Source identifiers**: `"{context}@{tabId}"` for captures (e.g. `"root@123"`), or `"root@{tabId}"` as a fallback when a tab is activated before any capture arrives.
- **URL recording**: Extracted from signals with type `nav.completed`, `nav.spa`, `nav.title_changed`, `tab.created`, `attention.active`, `attention.visible` via `signalPageUrl()`.
- **Off-browser handling**: When `chrome.windows.onFocusChanged` fires with `WINDOW_ID_NONE`, the aggregator seals the current bundle immediately but **defers** the off-browser transition by 200ms (`OFF_BROWSER_SETTLE_MS`). This prevents a spurious `off_browser` node when focus briefly leaves Chrome (e.g. switching between Chrome windows on Linux or when DevTools is a separate window).
- **`drainEdges()`**: Calls `bundler.commitPending()` first to flush any pending edge, then `graph.drainEdges()` to return and clear all edges.
- **State snapshots**: `emitState()` logs the full aggregator state (active source, open bundle, sealed bundles, all edges, all URLs) to the `"aggregator"` dev channel on every mutation.

---

## Service Worker Entry

**File: `src/background/main.ts`** (relevant graph excerpts)

The service worker instantiates the aggregator and wires it to Chrome extension events:

```typescript
import { createAggregator } from "../aggregation/index.ts";

const aggregator = createAggregator();

// Seed activeTabPerWindow for windows that already exist
chrome.windows.getAll({ populate: false }, (windows) => {
    for (const w of windows) {
        if (w.id === undefined) continue;
        chrome.tabs.query({ active: true, windowId: w.id }, (tabs) => {
            if (tabs[0]?.id !== undefined) {
                aggregator.onTabActivated(String(tabs[0].id), w.id!);
            }
        });
    }
});

// Receive Captures from content scripts via port
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "capture") return;
    const tabId = String(port.sender?.tab?.id ?? "unknown");
    port.onMessage.addListener((message) => {
        if (message.type !== "capture") return;
        const capture = message.payload;
        if (!capture?.type) return;
        aggregator.ingest(capture, tabId);
    });
});

// Tab activation → graph transition
chrome.tabs.onActivated.addListener((activeInfo) => {
    aggregator.onTabActivated(String(activeInfo.tabId), activeInfo.windowId);
    // Also ingests attention.active signal with URL
});

// Window focus → graph transition (or off-browser)
chrome.windows.onFocusChanged.addListener((windowId) => {
    aggregator.onWindowFocusChanged(windowId);
    // Also ingests attention.visible signal
});

// Window removed → cleanup
chrome.windows.onRemoved.addListener((windowId) => {
    aggregator.onWindowRemoved(windowId);
});

// Navigation signals → URL recording
chrome.webNavigation.onCompleted.addListener((details) => {
    // → aggregator.ingestSignal({ type: "nav.completed", ... })
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    // → aggregator.ingestSignal({ type: "nav.spa", ... })
});

// Tab signals → URL recording
chrome.tabs.onCreated.addListener((tab) => {
    // → aggregator.ingestSignal({ type: "tab.created", ... })
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    // → aggregator.ingestSignal({ type: "tab.closed", ... })
});
```

---

## Edge Lifecycle

Detailed walkthrough of a single edge being created:

### 1. User switches from Tab A to Tab B

```
chrome.tabs.onActivated({ tabId: 456, windowId: 1 })
```

### 2. Service worker calls aggregator

```typescript
// src/background/main.ts
aggregator.onTabActivated("456", 1);
```

### 3. Aggregator resolves source and transitions

```typescript
// src/aggregation/index.ts — onTabActivated()
let source = tabSources.get("456");  // e.g. "root@456"
if (!source) {
    source = "root@456";
    tabSources.set("456", source);
}
bundler.transition(source);
```

### 4. Bundler evaluates the transition

```typescript
// src/aggregation/bundler.ts — transition("root@456")

// graphCursor was "root@123" (Tab A)
// No pendingEdge exists, so:
pendingEdge = { from: "root@123", to: "root@456", arrivedAt: now };

// Start dwell timer
dwellTimer = setTimeout(commitPending, 500);

// Update cursor
graphCursor = "root@456";
```

### 5a. User stays on Tab B for 500ms+ (edge committed via timer)

```typescript
// commitPending() fires after 500ms
graph.recordEdge("root@123", "root@456");
pendingEdge = null;
```

### 5b. OR user switches to Tab C before 500ms

```typescript
// transition("root@789") fires, pendingEdge exists
// elapsed < DWELL_MS → collapse intermediate
// A → B(brief) → C  becomes  A → C
pendingEdge = { from: "root@123", to: "root@789", arrivedAt: now };
```

### 5c. OR user switches back to Tab A before 500ms

```typescript
// transition("root@123") fires, pendingEdge exists
// elapsed < DWELL_MS, and pendingEdge.from === to
// Returned to origin — cancel entirely
pendingEdge = null;
```

### 6. Graph records the edge

```typescript
// src/aggregation/graph.ts — recordEdge("root@123", "root@456")
const k = "root@123\0root@456";
// First time: creates { from: "root@123", to: "root@456", weight: 1 }
// Subsequent: increments weight
```

---

## Dwell-Time Heuristic

The dwell-time system prevents noisy graph data from fleeting tab switches. Key parameters:

| Parameter | Value | Purpose |
|---|---|---|
| `DWELL_MS` | 500ms | Minimum time user must stay on a tab for the edge to count |
| `OFF_BROWSER_SETTLE_MS` | 200ms | Grace period before recording an off-browser transition |

### State machine cases

```
Case 1: Normal transition (dwell met)
  A ──(500ms+)──> B ──(switch)──> C
  Result: Edge A→B committed, new pending B→C

Case 2: Brief intermediate (dwell NOT met)
  A ──(<500ms)──> B ──(switch)──> C
  Result: Pending collapsed to A→C (B skipped)

Case 3: Return to origin (dwell NOT met)
  A ──(<500ms)──> B ──(switch)──> A
  Result: Pending cancelled (no edge)

Case 4: Auto-commit (user stays)
  A ──(transition)──> B ──(stays 500ms)──>
  Result: Timer fires commitPending(), edge A→B committed

Case 5: drainEdges() force-commits
  Any pending edge is committed before edges are returned/cleared
```

---

## Key Design Decisions

1. **Graph is fully in-memory** — No persistence. Lost on service worker restart. This was intentional for the dev/prototype phase.

2. **Bundler owns transition logic, graph is a dumb store** — The bundler decides *when* to record edges (dwell heuristic). The graph just stores and retrieves them.

3. **Source identifiers combine context and tabId** — `"{context}@{tabId}"` creates unique nodes per content-script context per tab. A tab navigating to a new page within the same context keeps the same source.

4. **Edges are directed and independently weighted** — A→B and B→A are tracked separately. Weight indicates frequency of that specific transition.

5. **drainEdges() exists for sync** — The aggregator exposes `drainEdges()` (get + clear) for a sync system to batch-send edges upstream. It calls `commitPending()` first to ensure no edge is lost.

---

## File Index

| File | Role | Lines |
|---|---|---|
| `src/aggregation/types.ts` | Edge, Bundle, Aggregator types | 34 |
| `src/aggregation/graph.ts` | In-memory edge/URL store | 59 |
| `src/aggregation/bundler.ts` | State machine, dwell heuristic, bundle management | 147 |
| `src/aggregation/index.ts` | Aggregator orchestrator, tab/window management | 218 |
| `src/aggregation/translate.ts` | Bundle → text translation (used by seal()) | 125 |
| `src/background/main.ts` | Service worker entry, Chrome listener wiring | 379 |
