# Bundler

The bundler is the state machine at the core of the aggregation layer. It groups incoming `StampedCapture` events into `Bundle` objects based on **user focus** — one bundle per continuous focus session on a single source. When focus shifts (tab switch, window blur, or a capture arriving from a different source), the bundler seals the current bundle and opens a new one.

## Where it sits

```text
Service Worker
──────────────
                        ┌──────────────────────────────────────┐
  Capture port ────────▶│           createAggregator()         │
                        │                                      │
  chrome.tabs           │   stamp capture    ┌────────────┐    │
    .onActivated ──────▶│   (context@tabId)  │  Bundler   │    │
                        │        │           │            │    │
  chrome.windows        │        ▼           │ ┌────────┐ │    │
    .onFocusChanged ───▶│   bundler.ingest ─▶│ │ open   │ │    │
                        │                    │ │ bundle │ │    │
                        │   bundler.seal ───▶│ └───┬────┘ │    │
                        │                    │     │      │    │
                        │   bundler          │  translate │    │
                        │    .transition ───▶│     │      │    │
                        │                    │     ▼      │    │
                        │                    │ sealed[]   │    │
                        │                    └─────┬──────┘    │
                        │                          │           │
                        │                    ┌─────▼──────┐    │
                        │                    │   Graph    │    │
                        │                    │ (edges)    │    │
                        │                    └────────────┘    │
                        └──────────────────────────────────────┘
                                               │
                                               ▼
                                    Packer → Sync (future)
```

The bundler doesn't know about Chrome APIs or raw `Capture` objects. It only receives pre-stamped `StampedCapture` values and commands (`seal`, `transition`) from the aggregator facade (`index.ts`), which translates Chrome events into bundler operations.

## State

The bundler is a closure created by `createBundler(graph)`. All state is local variables:

| Variable       | Type             | Initial | Purpose                                                                                                              |
| -------------- | ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `activeSource` | `string \| null` | `null`  | The source currently being bundled (e.g. `root@42`). `null` before the first capture arrives.                        |
| `openBundle`   | `Bundle \| null` | `null`  | The bundle currently accumulating captures. `null` when no source is active (e.g. after transitioning to `UNKNOWN`). |
| `sealed`       | `Bundle[]`       | `[]`    | Completed bundles waiting to be consumed by the packer/sync layer.                                                   |

## Operations

### `ingest(stamped: StampedCapture)`

The primary entry point. Called by the aggregator for every capture arriving from the event layer.

```bash
ingest(stamped)
  │
  ├─ stamped.source !== activeSource?
  │     YES → transition(stamped.source)
  │     NO  → (continue)
  │
  └─ push stamped into openBundle.captures
```

If `activeSource` is `null` (first capture ever) or differs from the incoming capture's source, `ingest` triggers a `transition` before pushing. This is **lazy source resolution** — we don't proactively detect source changes via Chrome APIs; instead, the next capture's source drives the transition.

### `seal()`

Closes the current open bundle without starting a new one. Called by the aggregator on tab activation events (`chrome.tabs.onActivated`) and window refocus (`chrome.windows.onFocusChanged` with a real window ID).

```bash
seal()
  │
  ├─ no openBundle? → no-op (safe to call repeatedly)
  │
  └─ set endedAt = Date.now()
     call translate(openBundle)  → writes bundle.text
     push to sealed[]
     openBundle = null
```

Sealing without opening a new bundle is intentional. The next `ingest` call will trigger a `transition` which opens a fresh bundle. This avoids the need for async `chrome.tabs.get()` calls — we don't need to know the new source at seal time.

### `transition(to: string)`

Full source change: seal current bundle, record the navigation edge, and open a new bundle for the target source.

```bash
transition(to)
  │
  ├─ seal()                          ← close current bundle
  │
  ├─ activeSource exists?
  │     YES → graph.recordEdge(from, to)
  │     NO  → skip (first transition, no "from")
  │
  ├─ dev.log("aggregator", "transition", ...)
  │
  ├─ activeSource = to
  │
  └─ to !== UNKNOWN?
        YES → openNew(to)            ← start fresh bundle
        NO  → (no bundle while blurred)
```

When transitioning to `UNKNOWN` (browser lost focus), no new bundle is opened. Captures can't arrive while the browser is blurred, so there's nothing to accumulate. When focus returns, the next capture or `seal()` from `onTabActivated` resumes the cycle.

### `getSealed()` / `drainSealed()`

Read access for downstream consumers:

- `getSealed()` — returns a shallow copy of `sealed[]` (non-destructive).
- `drainSealed()` — returns a shallow copy and clears the array (consume-once for sync).

## Bundle lifecycle

```bash
          ingest (new source)                    seal / transition
                │                                       │
                ▼                                       ▼
┌──────────────────────────┐          ┌──────────────────────────┐
│       openNew(source)    │          │         seal()           │
│                          │          │                          │
│  source    = "root@42"   │  ─────▶  │  endedAt  = Date.now()   │
│  startedAt = Date.now()  │ captures │  text     = translate()  │
│  endedAt   = null        │ pushed   │  → push to sealed[]      │
│  captures  = []          │  here    │  openBundle = null       │
│  text      = null        │          │                          │
└──────────────────────────┘          └──────────────────────────┘
```

A bundle's `text` is `null` while open and populated exactly once at seal time by `translate()`. Empty bundles (zero captures) are valid — they occur during rapid tab switches and produce `text: ""`.

## Interaction with the graph

The bundler receives a `graph` instance at creation time. On every `transition(to)` where `activeSource` is non-null, it calls `graph.recordEdge(from, to)`. This means:

- The first-ever transition (from `null`) records no edge — there's no previous source.
- Transitions to and from `UNKNOWN` are recorded — they represent focus blur/restore patterns.
- Repeated transitions between the same pair increment the edge weight.

The graph is a separate concern — the bundler just calls `recordEdge` and doesn't read from it.

## Triggers from the aggregator

The aggregator facade (`index.ts`) translates Chrome events and capture arrivals into bundler operations:

| Chrome event / action                              | Aggregator method                           | Bundler call                                                                      |
| -------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| Capture arrives on port                            | `aggregator.ingest(capture, tabId)`         | `bundler.ingest(stamped)` — stamps with `context@tabId`, may trigger `transition` |
| `chrome.tabs.onActivated`                          | `aggregator.onTabActivated()`               | `bundler.seal()` — close current bundle, next capture opens new one               |
| `chrome.windows.onFocusChanged` (real window)      | `aggregator.onWindowFocusChanged(windowId)` | `bundler.seal()` — same as tab switch                                             |
| `chrome.windows.onFocusChanged` (`WINDOW_ID_NONE`) | `aggregator.onWindowFocusChanged(windowId)` | `bundler.transition(UNKNOWN)` — seal + enter blurred state                        |

## Dev logs

All dev logs use the `"aggregator"` channel:

| Event           | When                     | Data                                         |
| --------------- | ------------------------ | -------------------------------------------- |
| `bundle.opened` | `openNew()` is called    | `{ source }`                                 |
| `bundle.sealed` | `seal()` completes       | `{ source, captures: number, text: string }` |
| `transition`    | `transition()` is called | `{ from: string \| null, to: string }`       |

These are visible in the DevHub panel under the `AGGREGATOR` event group in [`src/dev/panels/FilterToggles.tsx`](../src/dev/panels/FilterToggles.tsx).

## Example scenario

User browses tab 42 (GitHub), switches to tab 7 (Gmail), then alt-tabs away from Chrome:

```bash
1. Capture arrives: { context: "root", ... } from tab 42
   → ingest: activeSource=null, transition("root@42")
     → seal(): no-op (no open bundle)
     → no edge (first transition)
     → openNew("root@42")
   → push capture into open bundle

2. More captures from tab 42…
   → ingest: source matches, just push

3. chrome.tabs.onActivated (user switches to tab 7)
   → aggregator.onTabActivated()
   → seal(): translate + push to sealed[], openBundle=null

4. Capture arrives from tab 7
   → ingest: activeSource="root@42", transition("root@7")
     → seal(): no-op (already sealed)
     → graph.recordEdge("root@42", "root@7")
     → openNew("root@7")
   → push capture

5. chrome.windows.onFocusChanged(WINDOW_ID_NONE)
   → aggregator.onWindowFocusChanged(-1)
   → transition(UNKNOWN)
     → seal(): translate + push to sealed[]
     → graph.recordEdge("root@7", "unknown")
     → no openNew (UNKNOWN → no bundle while blurred)

State: sealed has 2 bundles, graph has 2 edges, no open bundle
```

## File map

| File                                                              | Role                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts)     | `createBundler(graph)` — the state machine documented here                                                |
| [`src/aggregation/index.ts`](../src/aggregation/index.ts)         | `createAggregator()` — facade that creates the bundler + graph and routes events                          |
| [`src/aggregation/translate.ts`](../src/aggregation/translate.ts) | `translate(bundle)` — called by `seal()` to produce `bundle.text` ([docs](./translate.md))                |
| [`src/aggregation/graph.ts`](../src/aggregation/graph.ts)         | `createGraph()` — edge tracker called by `transition()`                                                   |
| [`src/aggregation/types.ts`](../src/aggregation/types.ts)         | `StampedCapture`, `Bundle`, `Edge`, `UNKNOWN`, `Aggregator` interface                                     |
| [`src/background/main.ts`](../src/background/main.ts)             | Service worker — creates the aggregator at module scope, wires it into capture port + attention listeners |
