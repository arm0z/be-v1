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
| `openBundle`   | `Bundle \| null` | `null`  | The bundle currently accumulating captures. `null` after a `seal()` until the next capture reopens one.              |
| `sealed`       | `Bundle[]`       | `[]`    | Completed bundles waiting to be consumed by the packer/sync layer.                                                   |

## Operations

### `ingest(stamped: StampedCapture)`

The primary entry point. Called by the aggregator for every capture arriving from the event layer.

```bash
ingest(stamped)
  │
  ├─ stamped.source !== activeSource?
  │     YES → transition(stamped.source)
  │     NO  ─┬─ openBundle is null?
  │          │     YES → openNew(stamped.source)   ← reopen after seal
  │          │     NO  → (continue)
  │
  └─ push stamped into openBundle.captures
```

If `activeSource` is `null` (first capture ever) or differs from the incoming capture's source, `ingest` triggers a `transition` before pushing. If the source matches but `openBundle` is null (e.g. after a `seal()` from a window blur/restore cycle where `activeSource` didn't change), it reopens a bundle without recording an edge.

### `seal()`

Closes the current open bundle without starting a new one. Called by the aggregator on all window focus changes (`chrome.windows.onFocusChanged`) and on tab activations where the tab's source is not yet known.

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
  ├─ activeSource exists AND activeSource !== to?
  │     YES → graph.recordEdge(from, to)
  │     NO  → skip (first transition, no "from", or self-loop from focus flicker)
  │
  ├─ dev.log("aggregator", "transition", ...)
  │
  ├─ activeSource = to
  │
  └─ to !== UNKNOWN && to !== OFF_BROWSER?
        YES → openNew(to)            ← start fresh bundle
        NO  → (no bundle while off-browser)
```

When transitioning to `OFF_BROWSER`, no new bundle is opened — there's nothing to capture while the user is outside the browser. Self-loop transitions (`from === to`) are skipped for edge recording but still reopen the bundle — this prevents noisy self-edges from focus flicker (e.g. briefly losing focus and returning to the same tab).

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
- Repeated transitions between the same pair increment the edge weight.
- Self-loop transitions (`from === to`) do not record an edge — this avoids noisy self-edges from focus flicker.
- The aggregator calls `transition(OFF_BROWSER)` when the user leaves the browser (after a 200 ms settle delay). `off_browser` edges appear in the graph.

The graph is a separate concern — the bundler just calls `recordEdge` and doesn't read from it.

## Triggers from the aggregator

The aggregator facade (`index.ts`) translates Chrome events and capture arrivals into bundler operations:

| Chrome event / action                                     | Aggregator method                           | Bundler call                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture arrives on port                                   | `aggregator.ingest(capture, tabId)`         | `bundler.ingest(stamped)` — stamps with `context@tabId`, may trigger `transition`                                                                 |
| `chrome.tabs.onActivated` (source known, no timer)        | `aggregator.onTabActivated(tabId)`          | `bundler.transition(source)` — seal + edge + open bundle for new tab                                                                              |
| `chrome.tabs.onActivated` (source unknown, no timer)      | `aggregator.onTabActivated(tabId)`          | `bundler.seal()` — close current bundle, signals buffer until first capture establishes source                                                     |
| `chrome.tabs.onActivated` (off-browser timer active)      | `aggregator.onTabActivated(tabId)`          | *skipped* — spurious Chrome event during focus loss, only `activeTabPerWindow` is updated                                                         |
| `chrome.windows.onFocusChanged(WINDOW_ID_NONE)`           | `aggregator.onWindowFocusChanged(windowId)` | `bundler.seal()` + start 200 ms timer → `bundler.transition(OFF_BROWSER)` if timer fires                                                         |
| `chrome.windows.onFocusChanged` (window, source known)    | `aggregator.onWindowFocusChanged(windowId)` | cancel timer + `bundler.transition(source)` — seal + edge + open bundle                                                                           |
| `chrome.windows.onFocusChanged` (window, source unknown)  | `aggregator.onWindowFocusChanged(windowId)` | cancel timer + start 200 ms off-browser timer (DevTools, extension popup, chrome:// page) — if captures arrive before timer fires, ingest handles it |
| Content script `page:visibility` (hidden/visible)         | `aggregator.ingestSignal(...)`              | Ingested as `attention.visible` signal into the open bundle (no transition triggered)                                                              |

## Dev logs

All dev logs use the `"aggregator"` channel:

| Event           | When                     | Data                                         |
| --------------- | ------------------------ | -------------------------------------------- |
| `bundle.opened` | `openNew()` is called    | `{ source }`                                 |
| `bundle.sealed` | `seal()` completes       | `{ source, captures: number, text: string }` |
| `transition`    | `transition()` is called | `{ from: string \| null, to: string }`       |

These are visible in the DevHub panel under the `AGGREGATOR` event group in [`src/dev/panels/FilterToggles.tsx`](../src/dev/panels/FilterToggles.tsx).

## Example scenario

User browses tab 42 (GitHub), switches to tab 7 (Gmail), then alt-tabs away and back:

```bash
1. Capture arrives: { context: "root", ... } from tab 42
   → ingest: activeSource=null, transition("root@42")
     → seal(): no-op (no open bundle)
     → no edge (first transition)
     → openNew("root@42")
   → push capture into open bundle
   → tabSources: { 42 → "root@42" }

2. More captures from tab 42…
   → ingest: source matches, just push

3. chrome.tabs.onActivated (user switches to tab 7)
   → aggregator.onTabActivated("7")
   → tabSources has no entry for 7 yet → seal() only (no edge)
   → attention.active signal arrives for tab 7 → source unknown → buffered

4. Capture arrives from tab 7
   → ingest: tabSources.set("7", "root@7")
   → activeSource="root@42" ≠ "root@7" → transition("root@7")
     → seal(): no-op (already sealed)
     → graph.recordEdge("root@42", "root@7")
     → openNew("root@7")
   → push capture
   → flushPending("7"): replay buffered attention.active into open bundle

5. chrome.windows.onFocusChanged(WINDOW_ID_NONE) — user alt-tabs away
   → aggregator.onWindowFocusChanged(-1)
   → seal(): translate + push to sealed[], openBundle=null
   → start 200ms off-browser timer

6. (If Chrome fires spurious onTabActivated during focus loss)
   → aggregator.onTabActivated(): offBrowserTimer active → skip transition
   → only activeTabPerWindow updated

7. Timer fires after 200ms
   → bundler.transition(OFF_BROWSER): activeSource = "off_browser", no bundle opened
   → graph.recordEdge("root@7", "off_browser")

8. chrome.windows.onFocusChanged(realWindowId) — user returns
   → aggregator.onWindowFocusChanged(windowId)
   → cancel off-browser timer (already fired, no-op)
   → bundler.transition("root@7"): graph.recordEdge("off_browser", "root@7")
   → openNew("root@7")

9. Capture arrives from tab 7 (user clicks something)
   → ingest: activeSource="root@7" matches, openBundle exists
   → push capture

State: sealed has 2 bundles, graph has 3 edges (root@42 → root@7, root@7 → off_browser, off_browser → root@7)
```

## Aggregator source tracking

The aggregator (`index.ts`) maintains two maps to ensure signals are attributed to the correct source (buffering early signals until a tab's first capture establishes its identity):

| Map              | Type                                           | Purpose                                                                                      |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `tabSources`     | `Map<string, string>`                          | `tabId → source` — populated when a capture arrives from a tab's content script               |
| `pendingSignals` | `Map<string, {signal, tabId}[]>`               | Buffers signals for tabs whose source isn't known yet                                         |

### Why signals need buffering

Signals (attention, navigation, tab lifecycle) arrive from Chrome APIs **before** the first capture from a tab's content script. Without buffering, these early signals would be attributed to `unknown` because `tabSources` has no entry for that tab yet.

Instead of stamping them with `unknown`, the aggregator buffers them per-tabId. When the first capture arrives for that tab (in `ingest()`), it:

1. Sets `tabSources.set(tabId, source)` — establishing the tab's identity
2. Calls `flushPending(tabId, source)` — replays buffered signals with the now-known source into the open bundle and records any URLs they carry

This means graph edges only connect real sources (`context@tabId`) and `off_browser`. The `UNKNOWN` sentinel still exists in the type system but is not used for graph edges.

### Cleanup

- `tab.closed` signal: deletes the tab from both `tabSources` and `pendingSignals`
- If a tab closes before any capture arrives, its buffered signals are discarded

## File map

| File                                                              | Role                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts)     | `createBundler(graph)` — the state machine documented here                                                |
| [`src/aggregation/index.ts`](../src/aggregation/index.ts)         | `createAggregator()` — facade that creates the bundler + graph and routes events                          |
| [`src/aggregation/translate.ts`](../src/aggregation/translate.ts) | `translate(bundle)` — called by `seal()` to produce `bundle.text` ([docs](./translate.md))                |
| [`src/aggregation/graph.ts`](../src/aggregation/graph.ts)         | `createGraph()` — edge tracker called by `transition()`                                                   |
| [`src/aggregation/types.ts`](../src/aggregation/types.ts)         | `StampedCapture`, `Bundle`, `Edge`, `UNKNOWN`, `OFF_BROWSER`, `Aggregator` interface                      |
| [`src/background/main.ts`](../src/background/main.ts)             | Service worker — creates the aggregator at module scope, wires it into capture port + attention listeners |
