# Bundler

The bundler is the state machine at the core of the aggregation layer. It groups incoming `StampedCapture` events into `Bundle` objects based on **user focus** — one bundle per continuous focus session on a single source. When focus shifts (a capture arriving from a different source, or the aggregator calling `transition()`), the bundler seals the current bundle and opens a new one.

## Where it sits

```text
Service Worker
──────────────
                        ┌──────────────────────────────────────┐
  Capture port ────────▶│           createAggregator()         │
                        │                                      │
  page:visibility      │   stamp capture    ┌────────────┐    │
    (content script) ──▶│   (context@tabId)  │  Bundler   │    │
                        │        │           │            │    │
  tabs.onActivated ────▶│        ▼           │ ┌────────┐ │    │
  windows.onFocus  ────▶│   bundler.ingest ─▶│ │ open   │ │    │
                        │                    │ │ bundle │ │    │
                        │   bundler.seal ───▶│ └───┬────┘ │    │
                        │                    │     │      │    │
                        │   bundler          │  translate │    │
                        │    .transition ───▶│     │      │    │
                        │                    │     ▼      │    │
                        │                    │ sealed[]   │    │
                        │                    │            │    │
                        │                    │ transitions│    │
                        │                    │   []       │    │
                        │                    └────────────┘    │
                        └──────────────────────────────────────┘
                                               │
                                               ▼
                                    Packer → Sync
```

The bundler doesn't know about Chrome APIs or raw `Capture` objects. It only receives pre-stamped `StampedCapture` / `StampedSignal` values and commands (`seal`, `transition`) from the aggregator facade (`index.ts`), which translates visibility events into bundler operations.

## State

The bundler is a closure created by `createBundler()`. All state is local variables:

| Variable       | Type             | Initial | Purpose                                                                                                 |
| -------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `activeSource` | `string \| null` | `null`  | The source currently being bundled (e.g. `root@42`). `null` before the first capture arrives.           |
| `openBundle`   | `Bundle \| null` | `null`  | The bundle currently accumulating captures. `null` after a `seal()` until the next capture reopens one. |
| `sealed`       | `Bundle[]`       | `[]`    | Completed bundles waiting to be consumed by the packer/sync layer.                                      |
| `transitions`  | `Transition[]`   | `[]`    | Raw transition log — each source change appends a `{ from, to, ts, dwellMs }` record.                   |

## Operations

### `ingest(stamped: StampedCapture)`

The primary entry point. Called by the aggregator for every capture arriving from the event layer.

```bash
ingest(stamped)
  │
  ├─ activeSource is null OR stamped.source !== activeSource?
  │     YES → transition(stamped.source)
  │     NO  ─┬─ openBundle is null?
  │          │     YES → openNew(stamped.source)   ← reopen after seal
  │          │     NO  → (continue)
  │
  └─ push stamped into openBundle.captures
```

If `activeSource` is `null` (first capture ever) or differs from the incoming capture's source, `ingest` triggers a `transition` before pushing. If the source matches but `openBundle` is null (e.g. after a `seal()` from a visibility-hidden event where `activeSource` didn't change), it reopens a bundle without recording a transition.

### `ingestSignal(stamped: StampedSignal)`

Entry point for service-worker-originated signals (navigation, tab lifecycle, attention, media). Unlike `ingest`, signals never trigger transitions — they are passively added to the current bundle.

```bash
ingestSignal(stamped)
  │
  ├─ openBundle exists? → push stamped into captures
  │
  ├─ no openBundle, but activeSource is a real source?
  │     → openNew(activeSource), then push
  │
  └─ no openBundle, activeSource is null/UNKNOWN/OFF_BROWSER?
        → drop (signal has nowhere to go)
```

### `seal()`

Closes the current open bundle without starting a new one.

```bash
seal()
  │
  ├─ no openBundle? → no-op (safe to call repeatedly)
  │
  └─ set endedAt = Date.now()
     call translate(openBundle)  → writes bundle.text
     push to sealed[]
     dev.log("aggregator", "bundle.sealed", ...)
     openBundle = null
     fire sealCb() if registered
```

Sealing without opening a new bundle is intentional. The next `ingest` call will trigger a `transition` which opens a fresh bundle.

### `transition(to: string)`

Full source change: seal current bundle, record the navigation transition, and open a new bundle for the target source.

```bash
transition(to)
  │
  ├─ seal()                          ← close current bundle
  │
  ├─ from exists AND from !== to?
  │     YES → compute dwellMs from last sealed bundle
  │           → push { from, to, ts, dwellMs } to transitions[]
  │           → dev.log("aggregator", "edge.committed", ...)
  │     NO  → skip (first transition or self-loop)
  │
  ├─ activeSource = to
  │
  └─ to !== UNKNOWN && to !== OFF_BROWSER?
        YES → openNew(to)            ← start fresh bundle
        NO  → (no bundle while off-browser)
```

The `from !== to` guard prevents recording self-transitions. When transitioning to `OFF_BROWSER`, no new bundle is opened — there's nothing to capture while the user is outside the browser.

### `getActiveSource()` / `getOpenBundle()`

Read access for internal state:

- `getActiveSource()` — returns the current `activeSource` value. Used by the aggregator facade to check whether a transition is needed.
- `getOpenBundle()` — returns a summarized view of the current open bundle: `{ source, startedAt, captureCount, captures: [{type, timestamp}] }` or `null`. Used by the aggregator's `emitState()` for dev logging.

### `getTransitions()` / `drainTransitions()`

Read access for the transition log:

- `getTransitions()` — returns a shallow copy of `transitions[]` (non-destructive).
- `drainTransitions()` — returns a shallow copy and clears the array (consume-once for the packer).

### `getSealed()` / `drainSealed()`

Read access for sealed bundles:

- `getSealed()` — returns a shallow copy of `sealed[]` (non-destructive).
- `drainSealed()` — returns a shallow copy and clears the array (consume-once for the packer).

### `snapshot()` / `restore(cp)`

Checkpoint support for crash recovery:

- `snapshot()` — returns a deep-enough copy of all state (`activeSource`, `openBundle`, `sealed[]`, `transitions[]`, `savedAt`).
- `restore(cp)` — replays checkpoint state: pushes sealed bundles and transitions back into the arrays. If the checkpoint had an `openBundle`, it is sealed immediately (using the last capture timestamp as `endedAt`, then calling `translate()`) rather than reopened — the next `ingest` will naturally open a fresh bundle.

### `onSeal(cb)`

Registers a callback that fires after every `seal()`. Used by the checkpointer to count sealed bundles and trigger periodic saves.

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

## Transition log

On every `transition(to)` where `activeSource` is non-null and differs from `to`, the bundler records a `Transition { from, to, ts, dwellMs }` directly into `transitions[]`. This means:

- The first-ever transition (from `null`) records no transition — there's no previous source.
- Self-transitions (`from === to`) are skipped — no edge is recorded.

The transition log is consumed by the Packer at flush time. The Packer pre-processes transitions (sentinel splitting, transient removal, hub chunking), builds a `DirectedGraph`, and runs Louvain community detection.

## Triggers from the aggregator

Navigation is driven by a **dual-layer** architecture in `main.ts`: both **content script visibility messages** (`page:visibility`) and **Chrome API listeners** (`tabs.onActivated`, `windows.onFocusChanged`) update a shared `tabStates` Map. When the active tab changes, `main.ts` calls `aggregator.setActiveTab(tabId | null)`, which translates into bundler operations.

The aggregator facade (`index.ts`) translates `setActiveTab` calls and capture arrivals into bundler operations:

| Event / action                        | Service worker / Aggregator method       | Bundler call                                                                    |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| Capture arrives on port               | `aggregator.ingest(capture, tabId)`      | `bundler.ingest(stamped)` — stamps with `context@tabId`, may trigger transition |
| Tab becomes visible (any layer)       | `aggregator.setActiveTab(tabId, url)`    | `bundler.transition(source)` if source differs from active                      |
| All tabs hidden / user leaves browser | `aggregator.setActiveTab(null)`          | `bundler.transition(OFF_BROWSER)` immediately                                   |
| Signal (nav, tab, media)              | `aggregator.ingestSignal(signal, tabId)` | `bundler.ingestSignal(stamped)` — passive, no transition                        |
| `tab.closed` signal                   | `aggregator.ingestSignal(...)`           | Signal ingested + `tabSources`/`pendingSignals` cleaned up for that tab         |
| Packer flush                          | `aggregator.seal()`                      | `bundler.seal()` — close current bundle before drain                            |

## Dev logs

The bundler uses the `"aggregator"` channel for bundle and transition events. The aggregator facade also uses the `"navigation"` channel for tab visibility changes.

| Event            | Channel      | When                                         | Data                                         |
| ---------------- | ------------ | -------------------------------------------- | -------------------------------------------- |
| `bundle.opened`  | `aggregator` | `openNew()` is called                        | `{ source }`                                 |
| `bundle.sealed`  | `aggregator` | `seal()` completes                           | `{ source, captures: number, text: string }` |
| `edge.committed` | `aggregator` | `transition()` records a transition          | `{ from, to, dwellMs }`                      |
| `state.snapshot` | `aggregator` | After every ingest/ingestSignal/setActiveTab | Full aggregator state (see emitState below)  |
| `off_browser`    | `navigation` | `setActiveTab(null)` triggers OFF_BROWSER    | (message only)                               |
| `tab.visible`    | `navigation` | `setActiveTab(tabId)` triggers source change | `{ tabId, source, url }`                     |

These are visible in the DevHub panel under the `AGGREGATOR` event group in [`src/dev/panels/FilterToggles.tsx`](../src/dev/panels/FilterToggles.tsx).

## Example scenario

User browses tab 42 (GitHub), switches to tab 7 (Gmail), then alt-tabs away briefly and back:

```bash
1. Capture arrives: { context: "root", ... } from tab 42
   → ingest: activeSource=null, transition("root@42")
     → seal(): no-op (no open bundle)
     → no transition record (first, no "from")
     → openNew("root@42")
   → push capture into open bundle
   → tabSources: { 42 → "root@42" }

2. More captures from tab 42…
   → ingest: source matches, just push

3. User clicks tab 7
   → main.ts Layer 2: tabs.onActivated → updateActiveTabFromApi()
     → tabStates updated, onActiveTabChanged()
   → tab 42 content script: page:visibility { visible: false }
     → tabStates updated, onActiveTabChanged() (deduped by previousActiveTabId)
   → tab 7 content script: page:visibility { visible: true }
     → tabStates updated, onActiveTabChanged()
   → aggregator.setActiveTab("7", url)
     → source = resolveSource("7") = "root@7"
     → bundler.transition("root@7")
       → seal() root@42 bundle
       → transitions.push({ from: "root@42", to: "root@7", ... })
       → openNew("root@7")

4. Capture arrives from tab 7
   → ingest: activeSource="root@7" matches, push
   → flushPending("7", "root@7"): replay buffered signals

5. User alt-tabs away (window loses focus)
   → main.ts: windows.onFocusChanged(WINDOW_ID_NONE)
     → all tabStates marked not visible
     → onActiveTabChanged() → aggregator.setActiveTab(null)
       → bundler.transition(OFF_BROWSER)
         → seal() root@7 bundle
         → transitions.push({ from: "root@7", to: "off_browser", ... })
         → no bundle opened (off_browser)
   → main.ts: sync-idle alarm created (10 min)

6. User returns quickly
   → main.ts: windows.onFocusChanged(windowId) → updateActiveTabFromApi()
     → tabStates updated, onActiveTabChanged()
   → aggregator.setActiveTab("7", url)
     → bundler.transition("root@7")
       → seal(): no-op (no open bundle)
       → transitions.push({ from: "off_browser", to: "root@7", ... })
       → openNew("root@7")
   → sync-idle alarm cancelled

State: sealed has 2 bundles, transitions has 3 edges
(root@42 → root@7, root@7 → off_browser, off_browser → root@7).
```

## Aggregator source tracking

The aggregator (`index.ts`) maintains three maps:

| Map              | Type                             | Purpose                                                                         |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `tabSources`     | `Map<string, string>`            | `tabId → source` — populated when a capture arrives from a tab's content script |
| `pendingSignals` | `Map<string, {signal, tabId}[]>` | Buffers signals for tabs whose source isn't known yet                           |
| `sourceUrls`     | `Map<string, string>`            | `source → URL` — populated from `html.content` captures and navigation signals  |

### Why signals need buffering

Signals (attention, navigation, tab lifecycle) arrive from Chrome APIs **before** the first capture from a tab's content script. Without buffering, these early signals would be attributed to `unknown` because `tabSources` has no entry for that tab yet.

Instead of stamping them with `unknown`, the aggregator buffers them per-tabId. When the first capture arrives for that tab (in `ingest()`), it:

1. Sets `tabSources.set(tabId, source)` — establishing the tab's identity
2. Calls `flushPending(tabId, source)` — replays buffered signals with the now-known source into the open bundle

This means transition edges only connect real sources (`context@tabId`) and `off_browser`. The `UNKNOWN` sentinel still exists in the type system but is not used for transition recording.

### Special case: `tabId === "unknown"`

Signals with `tabId === "unknown"` (e.g. downloads, which have no associated tab) bypass the pending-signal buffer. They are attributed to the current active source directly via `bundler.getActiveSource()`. If there is no active source, they are dropped.

### `emitState()`

After every `ingest`, `ingestSignal`, and `setActiveTab` call, the aggregator emits a `"state.snapshot"` dev log containing the full aggregator state: `activeSource`, `openBundle` (summarized), `sealedBundles`, `transitions`, and `sourceUrls`. This powers the StateInspector panel in the DevHub.

### `sourceUrls` tracking

The `sourceUrls` map is populated from two places:

- `html.content` captures (the page's URL from the capture payload)
- Navigation signals (`nav.completed`, `nav.spa`, `nav.title_changed`)
- `setActiveTab()` calls (the optional `url` parameter)

### Cleanup

- `tab.closed` signal: deletes the tab from both `tabSources` and `pendingSignals`.
- If a tab closes before any capture arrives, its buffered signals are discarded (pushed then immediately deleted).

## File map

| File                                                              | Role                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts)     | `createBundler()` — the state machine documented here                                                                          |
| [`src/aggregation/index.ts`](../src/aggregation/index.ts)         | `createAggregator()` — facade that creates the bundler, routes events, tracks sources/URLs                                     |
| [`src/aggregation/translate.ts`](../src/aggregation/translate.ts) | `translate(bundle)` — called by `seal()` to produce `bundle.text` ([docs](./translate.md))                                     |
| [`src/aggregation/types.ts`](../src/aggregation/types.ts)         | `StampedCapture`, `StampedSignal`, `BundleEntry`, `Bundle`, `Transition`, `UNKNOWN`, `OFF_BROWSER`, `Aggregator`, `Checkpoint` |
| [`src/background/main.ts`](../src/background/main.ts)             | Service worker — creates the aggregator, manages `tabStates` (dual-layer), wires into capture port + API listeners             |
