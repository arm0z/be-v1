# Development Layer

```text
┌─ Content Scripts ────────────┐     ┌─ Service Worker ──────────────────┐
│                              │     │                                   │
│  Tap / Adapter / Normalizer  │     │  Aggregator / Graph / Sync        │
│       │                      │     │       │                           │
│       ▼                      │     │       ▼                           │
│  dev.log(channel, data) ─────┼────▶│  DevHub                           │
│                              │     │    │                              │
└──────────────────────────────┘     │    ├─ filter (channel on/off)     │
                                     │    ├─ ring buffer (last N logs)   │
                                     │    ├─ live state snapshot         │
                                     │    │    openBundle                │
                                     │    │    sealed[]                  │
                                     │    │    edges (graph)             │
                                     │    │    activeSource              │
                                     │    │                              │
                                     │    └─ broadcast to connected      │
                                     │       dev page via port           │
                                     │                                   │
                                     └────────────┬──────────────────────┘
                                                  │
                                                  ▼
                                     ┌─ dev.html ───────────────────────┐
                                     │                                  │
                                     │  connects via chrome.runtime     │
                                     │  .connect({ name: "dev" })       │
                                     │                                  │
                                     │  ┌─ Log stream ───────────────┐  │
                                     │  │  filterable by channel     │  │
                                     │  └────────────────────────────┘  │
                                     │  ┌─ Graph view ───────────────┐  │
                                     │  │  nodes, edges, weights     │  │
                                     │  │  updates live              │  │
                                     │  └────────────────────────────┘  │
                                     │  ┌─ State inspector ──────────┐  │
                                     │  │  active source, bundles,   │  │
                                     │  │  sealed count, checkpoint  │  │
                                     │  └────────────────────────────┘  │
                                     │  ┌─ Filter toggles ───────────┐  │
                                     │  │  per-channel on/off        │  │
                                     │  └────────────────────────────┘  │
                                     │                                  │
                                     └──────────────────────────────────┘

In production: dev.log is a no-op, tree-shaken out. DevHub never runs. Zero cost.
```

## Development Overview

Every layer calls `dev.log(channel, data)` to emit structured log entries. In production this is a no-op. In dev mode (`import.meta.env.DEV`), logs flow to a central **DevHub** in the service worker which filters, buffers, and broadcasts them to a **dev page** (`dev.html`).

The dev page is a regular extension page (`chrome-extension://<id>/dev.html`) that connects to the service worker via `chrome.runtime.connect`. It receives a live stream of filtered logs plus full state snapshots (graph, bundles, active source). No devtools API needed — just open the page in a tab.

## Development Types

```typescript
type DevChannel =
  | "tap"            // raw DOM events from the Tap
  | "adapter"        // Adapter injections/filters
  | "normalizer"     // Normalizer batching decisions
  | "relay"          // Captures sent to service worker
  | "aggregator"     // bundle open/seal/transition
  | "graph"          // edge added/updated
  | "sync"           // packet sent/failed/retried
  | "persistence"    // checkpoint written/restored
  ;

type DevEntry = {
  channel: DevChannel;
  event?: string;        // e.g. "click", "keydown", "viewport.snapshot", "seal", "transition"
  timestamp: number;
  source?: string;       // which source produced this, if applicable
  message: string;
  data?: unknown;
};

/** Two-level filter: channel on/off, then per-event on/off within a channel. */
type DevFilter = {
  channels: Record<DevChannel, boolean>;
  events: Record<string, boolean>;  // e.g. { "click": true, "scroll": false, "keydown": true }
};

type DevSnapshot = {
  activeSource: string | null;
  openBundle: { source: string; captureCount: number } | null;
  sealedCount: number;
  edges: Edge[];
  filter: DevFilter;
};

/** Messages from DevHub → dev page. */
type DevMessage =
  | { type: "entry"; entry: DevEntry }
  | { type: "snapshot"; snapshot: DevSnapshot }
  | { type: "filter"; filter: DevFilter }
  ;

/** Messages from dev page → DevHub. */
type DevCommand =
  | { type: "setChannelFilter"; channels: Partial<Record<DevChannel, boolean>> }
  | { type: "setEventFilter"; events: Partial<Record<string, boolean>> }
  | { type: "requestSnapshot" }
  ;
```

## Example: dev.log — [`src/event/dev.ts`](../../src/event/dev.ts)

```typescript
// ── dev.ts (imported everywhere) ────────────────────────────

function createDevLog() {
  if (!import.meta.env.DEV) {
    // no-op in production — tree-shaken out
    return (_channel: DevChannel, _event: string, _message: string, _data?: unknown) => {};
  }

  return (channel: DevChannel, event: string, message: string, data?: unknown) => {
    const entry: DevEntry = {
      channel,
      event,
      timestamp: Date.now(),
      message,
      data,
    };

    // content script → service worker
    chrome.runtime.sendMessage({ type: "dev:log", entry });
  };
}

export const dev = { log: createDevLog() };
```

Usage in a Tap:

```typescript
function tap(context = "root"): Tap {
  return (sink) => {
    document.addEventListener("click", (e) => {
      const cap: Capture = {
        type: "input.click",
        timestamp: Date.now(),
        context,
        payload: { x: e.clientX, y: e.clientY, button: e.button, target: clickTarget(e.target) },
      };
      dev.log("tap", "input.click", "click event", cap);
      sink(cap);
    }, capture);
    // ... 14 listeners total
  };
}
```

Usage in the Aggregator:

```typescript
function transition(to: string): void {
  const from = activeSource;
  dev.log("aggregator", "transition", `${from} → ${to}`);
  seal();
  // ...
  dev.log("graph", "edge", `${from} → ${to}`, { weight: edge.weight });
}
```

## Example: DevHub (service worker)

```typescript
// ── Only runs in dev mode ───────────────────────────────────

if (import.meta.env.DEV) {
  const LOG_BUFFER_SIZE = 10_000;
  const logs: DevEntry[] = [];
  const ports: Set<chrome.runtime.Port> = new Set();

  let filter: DevFilter = {
    channels: {
      tap: true,
      adapter: true,
      normalizer: true,
      relay: true,
      aggregator: true,
      graph: true,
      sync: true,
      persistence: true,
    },
    events: {},           // empty = all events allowed; set "scroll": false to suppress
  };

  // receive logs from content scripts
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "dev:log") return;
    receive(msg.entry);
  });

  // service worker calls this directly
  function devLog(channel: DevChannel, event: string, message: string, data?: unknown): void {
    receive({ channel, event, timestamp: Date.now(), message, data });
  }

  function receive(entry: DevEntry): void {
    // two-level filter: channel first, then event
    if (!filter.channels[entry.channel]) return;
    if (entry.event && filter.events[entry.event] === false) return;

    logs.push(entry);
    if (logs.length > LOG_BUFFER_SIZE) logs.shift();

    for (const port of ports) {
      port.postMessage({ type: "entry", entry } satisfies DevMessage);
    }
  }

  // dev page connects
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "dev") return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));

    // send current state
    port.postMessage({ type: "snapshot", snapshot: buildSnapshot() } satisfies DevMessage);
    port.postMessage({ type: "filter", filter } satisfies DevMessage);

    // receive commands from dev page
    port.onMessage.addListener((msg: DevCommand) => {
      if (msg.type === "setChannelFilter") {
        filter.channels = { ...filter.channels, ...msg.channels };
        broadcast({ type: "filter", filter });
      }
      if (msg.type === "setEventFilter") {
        filter.events = { ...filter.events, ...msg.events };
        broadcast({ type: "filter", filter });
      }
      if (msg.type === "requestSnapshot") {
        port.postMessage({ type: "snapshot", snapshot: buildSnapshot() } satisfies DevMessage);
      }
    });

    function broadcast(msg: DevMessage): void {
      for (const p of ports) p.postMessage(msg);
    }
  });

  function buildSnapshot(): DevSnapshot {
    return {
      activeSource,
      openBundle: openBundle
        ? { source: openBundle.source, captureCount: openBundle.captures.length }
        : null,
      sealedCount: sealed.length,
      edges: [...edges.values()],
      filter,
    };
  }
}
```
