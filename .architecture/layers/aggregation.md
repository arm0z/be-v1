# Aggregation Layer

```text
┌─ Service Worker ────────────────────────────────────────────────────────┐
│                                                                         │
│  Captures arrive via chrome.runtime.onConnect port                      │
│                          │                                              │
│                          ▼                                              │
│  ┌─ Aggregator ────────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │   activeSource: "root@42"                                           ││
│  │   openBundle:   { source, startedAt, captures: [...] }              ││
│  │   sealed:       Bundle[]                                            ││
│  │                                                                     ││
│  │   on Capture ──▶ append to openBundle                               ││
│  │   on focus shift ──▶ seal openBundle, translate(), record edge,     ││
│  │                      open new                                       ││
│  │                                                                     ││
│  └──────────────────────────┬──────────────────────────────────────────┘│
│                             │                                           │
│                             ▼                                           │
│  ┌─ Navigation Graph ──────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │   Nodes: sources (including "off_browser")                              ││
│  │   Edges: directed, weighted by transition count                     ││
│  │                                                                     ││
│  │   root@42 ──3──▶ root@17 ──1──▶ unknown ──2──▶ root@42              ││
│  │       │                            ▲                                ││
│  │       └──────────────1─────────────┘                                ││
│  │                                                                     ││
│  └──────────────────────────┬──────────────────────────────────────────┘│
│                             │                                           │
│                             ▼                                           │
│  ┌─ Packer ────────────────────────────────────────────────────────────┐│
│  │                                                                     ││
│  │   on sync trigger:                                                  ││
│  │     1. partition graph into Groups (community detection)            ││
│  │     2. assign each sealed Bundle to its source's Group              ││
│  │     3. collect Groups + Bundles into Packet                         ││
│  │     4. send Packet to server                                        ││
│  │                                                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Aggregation Glossary

| Term                | What it is                                                                                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **StampedCapture**  | A Capture with `tabId` and `source` stamped on by the service worker. The content script doesn't know its tab ID — the service worker reads it from `sender.tab.id` and computes `source` as `context@tabId`.                                                                                       |
| **Bundle**          | A collection of StampedCaptures from a single source during a single continuous focus span. Opened when a source gains focus, sealed when focus shifts away. On seal, `translate()` renders captures into `text`.                                                                                   |
| **Translate**       | A pure function `(bundle: Bundle) => string` that renders a single Bundle into a human/LLM-readable text stream. Runs on seal. Each Bundle stores the result in its `text` field. See [translate docs](../translate.md).                                                                            |
| **Edge**            | A directed, weighted connection between two sources in the navigation graph. Weight increments each time the user transitions from one source to another.                                                                                                                                           |
| **`"off_browser"`** | The off-browser source. A regular node in the graph with `source: "off_browser"`. Has no Bundle (nothing to capture), but edges connect to and from it so the graph knows when the user left and returned. The transition to `off_browser` happens immediately when `setActiveTab(null)` is called. |
| **Group**           | A cluster of related sources discovered by partitioning the navigation graph (community detection). Sources that the user frequently navigates between end up in the same Group.                                                                                                                    |
| **Packet**          | The delivery unit. Contains Groups, each with its associated Bundles, plus the navigation graph edges. Sent to the server on sync. See [packer docs](../packer.md).                                                                                                                                |

## Aggregation Overview

The Aggregation Layer lives in the service worker. It has two responsibilities:

**1. Bundling** — receives Captures from the [Event Layer](./event.md) and groups them into Bundles by source and focus span.

- A **Bundle** is open for exactly one source at a time — the one the user is currently focused on.
- When focus shifts (tab switch, browser blur, window change), the current Bundle is **sealed**, `translate()` renders its captures into the `text` field, and a new Bundle is opened for the newly focused source.
- When the user leaves the browser entirely, the current Bundle is sealed and the active source becomes `"off_browser"` immediately. No Bundle is opened for it — there's nothing to capture. When the user returns, a new Bundle opens for the source they return to. The same treatment applies when switching to a window with no tracked tab (e.g. DevTools, extension popup, `chrome://` pages).

**2. Translation** — on seal, `translate(bundle)` converts the Bundle's captures into a single plain-text stream stored in `bundle.text`. This is the LLM-readable representation of the user's activity during that focus span.

**3. Navigation graph** — alongside bundling, every focus shift records a directed edge in a weighted graph.

- Nodes are sources (including `"off_browser"`).
- Each transition `A → B` increments the weight of edge `(A, B)`.
- On sync, the graph is partitioned into **Groups** using community detection. Sources the user frequently navigates between cluster together.
- Each sealed Bundle is assigned to its source's Group.
- The result is a **Packet**: a list of Groups, each containing its Bundles, plus the graph edges.

Component deep dives: [bundler](../bundler.md) · [translate](../translate.md) · [packer](../packer.md)

## Aggregation Types

```typescript
/**
 * The service worker stamps tabId and source onto each Capture
 * when it receives it. The content script doesn't know its own tabId —
 * it comes from port.sender.tab.id in chrome.runtime.onConnect.
 */
type StampedCapture = Capture & {
  tabId: string;         // e.g. "42"
  source: string;        // computed: `${context}@${tabId}`, e.g. "root@42"
};

type Bundle = {
  source: string;        // e.g. "root@42", "dashboard@42"
  startedAt: number;
  endedAt: number | null; // null while open, set on seal
  captures: StampedCapture[];
  text: string | null;   // null while open, set by translate() on seal
};

/**
 * Translates a sealed Bundle into a human/LLM-readable text stream.
 * Pure function, runs once per seal. The output is a plain text rendering
 * of the captures in chronological order — timestamps, click targets,
 * typed text, navigation events, page content.
 */
type Translate = (bundle: Bundle) => string;

const OFF_BROWSER = "off_browser";

type Edge = {
  from: string;          // source id, e.g. "root@42", "off_browser"
  to: string;            // source id, e.g. "root@17", "off_browser"
  weight: number;        // number of transitions
};

type Group = {
  id: string;
  bundles: Bundle[];
  text: string;
  meta: GroupMeta;       // computed when the group is assembled
};

/** Computed from the group's bundles. */
type GroupMeta = {
  sources: string[];     // unique source ids in this group
  tabs: string[];        // unique tabIds across all bundles
  timeRange: {
    start: number;       // earliest bundle startedAt
    end: number;         // latest bundle endedAt
  };
};

type Packet = {
  id: string;
  groups: Group[];
  edges: Edge[];
  createdAt: number;
};
```

## Example: Translate output

Given a Bundle with click, typing, and snapshot captures, `translate()` produces something like:

```text
[10:32:05] navigated to https://github.com/org/repo/pulls
[10:32:08] clicked "Files changed" tab
[10:32:12] scrolled
[10:32:15] typed "looks good, one nit on line 42"
[10:32:20] clicked "Submit review"
[10:33:05] snapshot: PR #138 — review submitted, 3 files changed
```

The exact format is up to the translate implementation. The point is: raw captures in, readable text out.

## Example: Service Worker Aggregator

```typescript
let openBundle: Bundle | null = null;
let activeSource: string | null = null;
const sealed: Bundle[] = [];
const edges: Map<string, Edge> = new Map(); // key: "from -> to"

// ── Receive Captures from the Event Layer ───────────────────
// Content scripts connect via chrome.runtime.connect (persistent port).
// Each port message is a Capture from the content script pipeline.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "capture") return;
  const tabId = String(port.sender?.tab?.id ?? "unknown");

  port.onMessage.addListener((capture: Capture) => {
    const source = `${capture.context}@${tabId}`;
    const stamped: StampedCapture = { ...capture, tabId, source };

    if (!openBundle || openBundle.source !== source) {
      transition(source);
    }

    openBundle!.captures.push(stamped);
  });
});

// ── Focus shifts ────────────────────────────────────────────

// Both Chrome API listeners and content script visibility messages update
// a shared tabStates Map. When the active tab changes, aggregator.setActiveTab()
// is called, which translates into bundler.transition() if the source differs.

chrome.tabs.onActivated.addListener(() => updateActiveTabFromApi());

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // User left browser — mark all tabs not visible, transition to off_browser
    for (const [id, state] of tabStates.entries()) {
      if (state.visible) tabStates.set(id, { ...state, visible: false });
    }
    aggregator.setActiveTab(null);  // → bundler.transition(OFF_BROWSER)
  } else {
    updateActiveTabFromApi();
  }
});

// Content script visibility (Page Visibility API)
// Received via chrome.runtime.onMessage (separate from the capture port)
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "page:visibility") {
    const tabId = sender.tab?.id;
    if (msg.visible) {
      aggregator.setActiveTab(tabId, msg.url);  // drives navigation transitions
    } else {
      // tabStates updated; if no visible tab remains → setActiveTab(null)
    }
    // Also ingested as attention.visible signal into the active bundle
    aggregator.ingestSignal({ type: "attention.visible", visible: msg.visible, ... }, tabId);
  }
});

// ── Core: transition between sources ────────────────────────

function transition(to: string): void {
  const from = activeSource;
  seal();

  // record edge (skip self-loops from focus flicker)
  if (from !== null && from !== to) {
    const key = `${from}→${to}`;
    const existing = edges.get(key);
    if (existing) {
      existing.weight++;
    } else {
      edges.set(key, { from, to, weight: 1 });
    }
  }

  activeSource = to;

  // don't open a bundle for off_browser — nothing to capture
  if (to !== OFF_BROWSER) {
    openBundle = { source: to, startedAt: Date.now(), endedAt: null, captures: [], text: null };
  }
}

function seal(): void {
  if (!openBundle) return;
  openBundle.endedAt = Date.now();
  openBundle.text = translate(openBundle);
  sealed.push(openBundle);
  openBundle = null;
}

// ── Sync: partition graph, build packet ─────────────────────

function flush(): Packet {
  seal();

  const allEdges = [...edges.values()];
  const groups = partitionIntoGroups(allEdges, sealed);

  const packet: Packet = {
    groups,
    edges: allEdges,
    createdAt: Date.now(),
  };

  // reset for next session
  sealed.length = 0;
  edges.clear();

  return packet;
}

/** Community detection over the navigation graph. Implementation TBD. */
function partitionIntoGroups(edges: Edge[], bundles: Bundle[]): Group[] {
  // e.g. directed Louvain, label propagation, etc.
  // assigns each source to a group, then maps bundles to their source's group
  throw new Error("not implemented");
}
```

The service worker doesn't know or care which pipeline produced the Captures. The [Event Layer](./event.md) handles *what* gets captured; the Aggregation Layer handles *how it's grouped and related*.
