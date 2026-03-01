# Architecture

```text
┌─ Content Script (per tab) ───────────────────────────────────────────────┐
│                                                                          │
│   ┌─────┐    ┌─────────┐    ┌────────────┐    ┌───────┐                  │
│   │ Tap │───▶│ Adapter │───▶│ Normalizer │───▶│ Relay │──────────────────┼──┐
│   └─────┘    └─────────┘    └────────────┘    └───────┘                  │  │
│    DOM events   filter/inject   batch/dedup      port                    │  │
│                                                                          │  │
└──────────────────────────────────────────────────────────────────────────┘  │
                                                                              │
  ┌─ Service Worker ──────────────────────────────────────────────────────────┤
  │                                                                           │
  │   Captures ◀──────────────────────────────────────────────────────────────┘
  │       │
  │       ▼
  │   ┌─ Aggregator ──────────────────────────────────────────────────────┐
  │   │  Bundle by source + focus span │ Translate │ Navigation graph     │
  │   └───────────────────────────────────────────────────────────────────┘
  │       │
  │       ▼
  │   ┌─ Packer ──────────────────────────────────────────────────────────┐
  │   │  Partition graph → Groups → Packet                                │
  │   └───────────────────────────────────────────────────────────────────┘
  │       │
  │       ▼
  │   ┌─ Syncing ─────────────────────────────────────────────────────────┐
  │   │  POST Packet → server │ RetryQueue on failure                     │
  │   └───────────────────────────────────────────────────────────────────┘
  │       │
  │       ▼
  │   ┌─ Checkpointing ──────────────────────────────────────────────────┐
  │   │  chrome.storage.local │ recover on restart                        │
  │   └───────────────────────────────────────────────────────────────────┘
  │
  │   ┌─ DevHub (dev only) ──────────────────────────────────────────────┐
  │   │  dev.log → filter → ring buffer → broadcast to dev.html           │
  │   └───────────────────────────────────────────────────────────────────┘
  │
  └───────────────────────────────────────────────────────────────────────────
```

## Data Flow

Content Script → Service Worker → Server

1. **Content script** — a Tap hooks DOM events, Adapters inject/filter domain-specific captures, a Normalizer batches and deduplicates, a Relay sends Captures to the service worker over a persistent port.
2. **Service worker** — the Aggregator groups Captures into Bundles by source and focus span, translates each into text, and records a navigation graph. The Packer partitions the graph into Groups and assembles a Packet.
3. **Server** — the Syncing Layer POSTs the Packet. Failed deliveries go to a RetryQueue with exponential backoff.
4. **Persistence** — Checkpointing writes aggregator state to `chrome.storage.local` so nothing is lost if the service worker is killed or the browser crashes.

## Layers

### [Event Layer](./layers/event.md)

Captures user activity in each tab. A composable pipeline — `Tap → Adapter(s) → Normalizer → Relay` — hooks DOM events, injects domain-specific content (HTML snapshots, file reads, Outlook filtering), normalizes high-frequency events (keystroke batching, scroll debouncing), and forwards everything to the service worker. Routes are matched by URL; SPA navigation is observed without rebuilding the pipeline.

Adapters: [html](./adapters/html.md) · [file](./adapters/file.md) · [outlook](./adapters/outlook.md) · [**How to add an adapter**](./adapters/README.md)

### [Aggregation Layer](./layers/aggregation.md)

Groups Captures into Bundles by source and focus span. On seal, `translate()` renders each Bundle into LLM-readable text. A weighted navigation graph tracks transitions between sources. On sync, the graph is partitioned into Groups (community detection) and assembled into a Packet.

Components: [bundler](./bundler.md) · [translate](./translate.md) · [packer](./packer.md)

### [Syncing Layer](./layers/syncing.md)

Delivers Packets to the server. Two alarm-based triggers: periodic (every 2 hours) and off-browser idle (10 minutes after leaving). Failed POSTs go to a RetryQueue persisted in `chrome.storage.local` with exponential backoff.

### [Checkpointing](./layers/checkpointing.md)

Writes aggregator state to `chrome.storage.local` every 50 sealed bundles and on `onSuspend`. On restart, recovers in-flight data — seals stale bundles, flushes, and syncs. Drains the RetryQueue before resuming normal operation.

### [Development Layer](./layers/development.md)

Structured `dev.log(channel, event, message, data)` across all layers — no-op in production (tree-shaken out). In dev mode, a DevHub in the service worker filters by channel/event, stores in a 10k-entry ring buffer, and broadcasts to a dev page via port. The dev page shows live logs, graph visualization, and state inspection.

## Cross-cutting References

| Document                                         | Scope                                                      |
| ------------------------------------------------ | ---------------------------------------------------------- |
| [navigation.md](./navigation.md)                 | Full visibility data flow, tab state tracking, focus logic |
| [browser-active-tab.md](./browser-active-tab.md) | Active tab detection across windows and monitors           |
