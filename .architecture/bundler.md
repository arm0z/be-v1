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
                        │        ▼           │ ┌────────┐ │    │
                        │   bundler.ingest ─▶│ │ open   │ │    │
                        │                    │ │ bundle │ │    │
                        │   bundler.seal ───▶│ └───┬────┘ │    │
                        │                    │     │      │    │
                        │   bundler          │  translate │    │
                        │    .transition ───▶│     │      │    │
                        │                    │     ▼      │    │
                        │                    │ sealed[]   │    │
                        │                    │            │    │
                        │                    │ transitions│    │
                        │                    │   [] ──────┼─── │─── dwell gate
                        │                    └────────────┘    │
                        └──────────────────────────────────────┘
                                               │
                                               ▼
                                    Packer → Sync
```

The bundler doesn't know about Chrome APIs or raw `Capture` objects. It only receives pre-stamped `StampedCapture` / `StampedSignal` values and commands (`seal`, `transition`) from the aggregator facade (`index.ts`), which translates visibility events into bundler operations.

## State

The bundler is a closure created by `createBundler()`. All state is local variables:

| Variable        | Type               | Initial | Purpose                                                                                                 |
| --------------- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| `activeSource`  | `string \| null`   | `null`  | The source currently being bundled (e.g. `root@42`). `null` before the first capture arrives.           |
| `openBundle`    | `Bundle \| null`   | `null`  | The bundle currently accumulating captures. `null` after a `seal()` until the next capture reopens one. |
| `sealed`        | `Bundle[]`         | `[]`    | Completed bundles waiting to be consumed by the packer/sync layer.                                      |
| `transitions`   | `Transition[]`     | `[]`    | Raw transition log — each source change appends a `{ from, to, ts, dwellMs }` record.                  |
| `pendingEdge`   | `Transition\|null` | `null`  | Edge held by the dwell gate, not yet committed to `transitions[]`.                                      |
| `dwellTimer`    | timeout \| null    | `null`  | Timer that commits `pendingEdge` after `DWELL_MS`.                                                      |

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
     openBundle = null
     fire sealCb() if registered
```

Sealing without opening a new bundle is intentional. The next `ingest` call will trigger a `transition` which opens a fresh bundle.

### `transition(to: string)`

Full source change: seal current bundle, record the navigation transition (via the dwell gate), and open a new bundle for the target source.

```bash
transition(to)
  │
  ├─ seal()                          ← close current bundle
  │
  ├─ activeSource exists?
  │     YES → compute dwellMs from last sealed bundle
  │           → dwell gate (see below)
  │     NO  → skip (first transition, no "from")
  │
  ├─ dev.log("aggregator", "transition", ...)
  │
  ├─ activeSource = to
  │
  └─ to !== UNKNOWN && to !== OFF_BROWSER?
        YES → openNew(to)            ← start fresh bundle
        NO  → (no bundle while off-browser)
```

When transitioning to `OFF_BROWSER`, no new bundle is opened — there's nothing to capture while the user is outside the browser.

### `getTransitions()` / `drainTransitions()`

Read access for the transition log:

- `getTransitions()` — returns a shallow copy of `transitions[]` plus the `pendingEdge` if one exists (non-destructive).
- `drainTransitions()` — commits any pending edge, returns a shallow copy, and clears the array (consume-once for the packer).

### `getSealed()` / `drainSealed()`

Read access for sealed bundles:

- `getSealed()` — returns a shallow copy of `sealed[]` (non-destructive).
- `drainSealed()` — returns a shallow copy and clears the array (consume-once for the packer).

### `snapshot()` / `restore(cp)`

Checkpoint support for crash recovery:

- `snapshot()` — commits any pending edge, then returns a deep-enough copy of all state (`activeSource`, `openBundle`, `sealed[]`, `transitions[]`, `savedAt`).
- `restore(cp)` — replays checkpoint state: pushes sealed bundles and transitions back into the arrays. If the checkpoint had an `openBundle`, it is sealed immediately (using the last capture timestamp as `endedAt`) rather than reopened — the next `ingest` will naturally open a fresh bundle.

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

## Dwell gate

The bundler holds each transition edge as "pending" for `DWELL_MS` (1,000 ms) before committing it to `transitions[]`. If the target source transitions away within that window, the edge collapses — preventing brief intermediate nodes (like `off_browser` during a quick alt-tab) from appearing in the graph.

```bash
transition(to)  [from = activeSource, dwellMs = sealed bundle duration]
  │
  ├─ pendingEdge exists AND dwellMs < DWELL_MS?
  │     │
  │     ├─ pendingEdge.from === to?
  │     │     → self-loop after collapse (e.g. A → off_browser → A)
  │     │     → drop pendingEdge entirely
  │     │
  │     └─ else
  │           → collapse: pendingEdge becomes { from: pendingEdge.from, to }
  │           → restart DWELL_MS timer
  │
  └─ else (no pending, or dwellMs >= DWELL_MS)
        → commitPending() (push old pending to transitions[])
        → pendingEdge = { from, to, ts, dwellMs }
        → start DWELL_MS timer
```

When the timer fires without interruption, the pending edge is committed. Multiple consecutive collapses chain: A→B→C→D where B and C both dwell < 1 s collapses to A→D.

| Constant   | Value | Purpose                                                     |
| ---------- | ----- | ----------------------------------------------------------- |
| `DWELL_MS` | 1,000 | Pending edge window — collapses brief intermediates         |

### Examples

**Quick alt-tab (< 1 s away):**
```
A → off_browser (pending: A→off_browser)
off_browser → A within 1s (dwell < DWELL_MS → collapse)
  pendingEdge.from (A) === to (A) → self-loop → drop
Result: no transition recorded
```

**Slow alt-tab (> 1 s away):**
```
A → off_browser (pending: A→off_browser)
  ... 1s passes, timer fires → commit A→off_browser
off_browser → A (pending: off_browser→A)
  ... 1s passes, timer fires → commit off_browser→A
Result: two transitions recorded
```

**Rapid tab switching A→B→C (B < 1 s):**
```
A → B (pending: A→B)
B → C within 1s (dwell < DWELL_MS → collapse A→B into A→C)
  pending: A→C
  ... 1s passes → commit A→C
Result: one transition A→C
```

## Transition log

On every `transition(to)` where `activeSource` is non-null, the bundler records a `Transition { from, to, ts, dwellMs }` through the dwell gate. This means:

- The first-ever transition (from `null`) records no transition — there's no previous source.
- Transitions where the intermediate source dwelled < `DWELL_MS` are collapsed by the dwell gate.
- Self-loops produced by collapse are dropped entirely.
- The aggregator calls `transition(OFF_BROWSER)` when the user leaves the browser (after a 1,000 ms settle delay). `off_browser` transitions appear in the log unless collapsed.

The transition log is consumed by the Packer at flush time. The Packer pre-processes transitions (sentinel splitting, transient removal, hub chunking), builds a `DirectedGraph`, and runs Louvain community detection.

## Triggers from the aggregator

Navigation is driven entirely by **content script visibility messages** (`page:visibility`), not Chrome `tabs.onActivated` or `windows.onFocusChanged` APIs. See [navigation.md](./navigation.md) for the full data flow.

The aggregator facade (`index.ts`) translates visibility events and capture arrivals into bundler operations:

| Event / action                         | Aggregator method                          | Bundler call                                                                    |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Capture arrives on port                | `aggregator.ingest(capture, tabId)`        | `bundler.ingest(stamped)` — stamps with `context@tabId`, may trigger transition |
| `page:visibility` visible              | `aggregator.onVisibilityChanged(tabId, true)` | `bundler.transition(source)` if source differs from active                   |
| `page:visibility` hidden               | `aggregator.onVisibilityChanged(tabId, false)` | Starts off-browser settle timer (1,000 ms)                                 |
| Off-browser timer fires                | (internal)                                 | `bundler.transition(OFF_BROWSER)`                                               |
| Signal (nav, tab, media)               | `aggregator.ingestSignal(signal, tabId)`   | `bundler.ingestSignal(stamped)` — passive, no transition                        |
| `tab.closed` signal                    | `aggregator.ingestSignal(...)`             | Signal ingested + `visibleTabId` cleared if matching + off-browser timer starts |
| Packer flush                           | `aggregator.seal()`                        | `bundler.seal()` — close current bundle before drain                            |

Chrome API listeners (`tabs.onActivated`, `windows.onFocusChanged`) exist in `main.ts` for dev logging and signal ingestion only — they do NOT drive navigation.

## Dev logs

All dev logs use the `"aggregator"` channel:

| Event            | When                                                 | Data                                                    |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `bundle.opened`  | `openNew()` is called                                | `{ source }`                                            |
| `bundle.sealed`  | `seal()` completes                                   | `{ source, captures: number, text: string }`            |
| `transition`     | `transition()` is called                             | `{ from: string \| null, to: string }`                  |
| `edge.pending`   | New pending edge created                             | `{ from, to, dwellMs }`                                 |
| `edge.committed` | Pending edge committed (timer or new long-dwell)     | `{ from, to, dwellMs }`                                 |
| `edge.collapsed` | Intermediate collapsed via dwell gate                | `{ original: {from,to}, collapsed: {from,to}, intermediateDwellMs }` |

These are visible in the DevHub panel under the `AGGREGATOR` event group in [`src/dev/panels/FilterToggles.tsx`](../src/dev/panels/FilterToggles.tsx).

## Example scenario

User browses tab 42 (GitHub), switches to tab 7 (Gmail), then alt-tabs away briefly and back:

```bash
1. Capture arrives: { context: "root", ... } from tab 42
   → ingest: activeSource=null, transition("root@42")
     → seal(): no-op (no open bundle)
     → no transition (first, no "from")
     → openNew("root@42")
   → push capture into open bundle
   → tabSources: { 42 → "root@42" }

2. More captures from tab 42…
   → ingest: source matches, just push

3. User clicks tab 7
   → tab 42 content script: page:visibility { visible: false }
   → aggregator.onVisibilityChanged("42", false)
     → visibleTabId cleared, off-browser timer starts (1000ms)
   → tab 7 content script: page:visibility { visible: true }
   → aggregator.onVisibilityChanged("7", true)
     → off-browser timer cancelled (< 1000ms)
     → source = resolveSource("7") = "root@7"
     → bundler.transition("root@7")
       → seal() root@42 bundle
       → pendingEdge = { from: "root@42", to: "root@7", dwellMs: ... }
       → dwell timer starts (1000ms)
       → openNew("root@7")

4. Capture arrives from tab 7
   → ingest: activeSource="root@7" matches, push
   → flushPending("7", "root@7"): replay buffered signals

5. User alt-tabs away briefly (< 1s total)
   → tab 7 content script: page:visibility { visible: false }
   → aggregator: visibleTabId cleared, off-browser timer starts
   → dwell timer fires: commit root@42 → root@7 transition
   → off-browser timer fires (1000ms): bundler.transition(OFF_BROWSER)
     → seal() root@7 bundle
     → pendingEdge = { from: "root@7", to: "off_browser", dwellMs: ... }
     → no bundle opened (off_browser)

6. User returns quickly (< 1s since off_browser transition)
   → tab 7 content script: page:visibility { visible: true }
   → aggregator.onVisibilityChanged("7", true)
     → bundler.transition("root@7")
       → seal(): no-op (no open bundle)
       → off_browser dwell < DWELL_MS → collapse
         → pendingEdge.from ("root@7") === to ("root@7") → self-loop → drop
       → openNew("root@7")

State: sealed has 2 bundles, transitions has 1 edge (root@42 → root@7).
The brief off_browser detour was collapsed away by the dwell gate.
```

## Aggregator source tracking

The aggregator (`index.ts`) maintains two maps to ensure signals are attributed to the correct source (buffering early signals until a tab's first capture establishes its identity):

| Map              | Type                             | Purpose                                                                         |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `tabSources`     | `Map<string, string>`            | `tabId → source` — populated when a capture arrives from a tab's content script |
| `pendingSignals` | `Map<string, {signal, tabId}[]>` | Buffers signals for tabs whose source isn't known yet                           |

### Why signals need buffering

Signals (attention, navigation, tab lifecycle) arrive from Chrome APIs **before** the first capture from a tab's content script. Without buffering, these early signals would be attributed to `unknown` because `tabSources` has no entry for that tab yet.

Instead of stamping them with `unknown`, the aggregator buffers them per-tabId. When the first capture arrives for that tab (in `ingest()`), it:

1. Sets `tabSources.set(tabId, source)` — establishing the tab's identity
2. Calls `flushPending(tabId, source)` — replays buffered signals with the now-known source into the open bundle

This means transition edges only connect real sources (`context@tabId`) and `off_browser`. The `UNKNOWN` sentinel still exists in the type system but is not used for transition recording.

### Cleanup

- `tab.closed` signal: deletes the tab from both `tabSources` and `pendingSignals`, clears `visibleTabId` if matching, and starts the off-browser timer.
- If a tab closes before any capture arrives, its buffered signals are discarded.

## File map

| File                                                              | Role                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`src/aggregation/bundler.ts`](../src/aggregation/bundler.ts)     | `createBundler()` — the state machine documented here                                                     |
| [`src/aggregation/index.ts`](../src/aggregation/index.ts)         | `createAggregator()` — facade that creates the bundler and routes events                                  |
| [`src/aggregation/translate.ts`](../src/aggregation/translate.ts) | `translate(bundle)` — called by `seal()` to produce `bundle.text` ([docs](./translate.md))                |
| [`src/aggregation/types.ts`](../src/aggregation/types.ts)         | `StampedCapture`, `StampedSignal`, `Bundle`, `Transition`, `UNKNOWN`, `OFF_BROWSER`, `Aggregator` interface |
| [`src/background/main.ts`](../src/background/main.ts)             | Service worker — creates the aggregator at module scope, wires it into capture port + visibility listeners |
