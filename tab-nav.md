# Tab Navigation & Transition Graph — Detailed Internals

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Source Identity Model](#source-identity-model)
3. [Chrome API Event Listeners](#chrome-api-event-listeners)
4. [Aggregator: The Central Coordinator](#aggregator-the-central-coordinator)
5. [Bundler: Session Segmentation via Transitions](#bundler-session-segmentation-via-transitions)
6. [Graph: Edge Recording](#graph-edge-recording)
7. [Off-Browser Transition Mechanism](#off-browser-transition-mechanism)
8. [Tab Activation Flow (Step by Step)](#tab-activation-flow-step-by-step)
9. [Window Focus Change Flow (Step by Step)](#window-focus-change-flow-step-by-step)
10. [Content Script Pipeline & SPA Navigation](#content-script-pipeline--spa-navigation)
11. [Signal vs Capture Ingestion](#signal-vs-capture-ingestion)
12. [Dev Tools Visualization](#dev-tools-visualization)
13. [Race Conditions & Edge Cases](#race-conditions--edge-cases)
14. [Constants & Timing](#constants--timing)
15. [Data Flow Diagrams](#data-flow-diagrams)

---

## Architecture Overview

The system is a Chrome extension that tracks user activity across browser tabs and builds a **directed weighted graph** of tab-to-tab transitions. It has three layers:

```
┌──────────────────────────────────┐
│  Content Scripts (per tab)       │  Event Layer
│  tap → adapter → normalizer → relay  │
└──────────────┬───────────────────┘
               │ chrome.runtime.connect("capture")
               ▼
┌──────────────────────────────────┐
│  Service Worker (background)     │  Aggregation Layer
│  aggregator → bundler + graph    │
└──────────────┬───────────────────┘
               │ chrome.runtime.connect("dev")
               ▼
┌──────────────────────────────────┐
│  Dev Tools Page                  │  Visualization Layer
│  GraphView / StateInspector      │
└──────────────────────────────────┘
```

**Key files:**

| File                                | Role                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/background/main.ts`            | Service worker entry. Wires Chrome API listeners to aggregator.                                    |
| `src/aggregation/index.ts`          | `createAggregator()` — central coordinator for tab tracking, off-browser handling, signal routing. |
| `src/aggregation/bundler.ts`        | `createBundler()` — manages open/sealed bundles and transition edges.                              |
| `src/aggregation/graph.ts`          | `createGraph()` — stores directed weighted edges and per-source URLs.                              |
| `src/aggregation/types.ts`          | Shared types: `Bundle`, `Edge`, `UNKNOWN`, `OFF_BROWSER` constants.                                |
| `src/aggregation/translate.ts`      | Converts bundle captures into human-readable text summaries.                                       |
| `src/content/main.ts`               | Content script entry. Route matching, SPA observation.                                             |
| `src/event/tap.ts`                  | Base DOM listener layer (keystrokes, clicks, scroll, forms, clipboard).                            |
| `src/event/relay.ts`                | Terminal pipeline stage. Sends captures to service worker via port.                                |
| `src/event/normalizer.ts`           | Batching/debouncing middleware (keystrokes, scroll, selection, form focus).                        |
| `src/event/spa-observer.ts`         | Monkey-patches `history.pushState`/`replaceState` for SPA detection.                               |
| `src/event/visibility.ts`           | Page Visibility API tracking per content script.                                                   |
| `src/event/registry.ts`             | Route registry — URL pattern matching to pipeline builders.                                        |
| `src/dev/App.tsx`                   | Dev tools shell with hash-routed tabs (Graph, Logs, State).                                        |
| `src/dev/panels/GraphView.tsx`      | Force-directed graph canvas visualization.                                                         |
| `src/dev/panels/StateInspector.tsx` | Real-time state inspector (bundles, edges, active source).                                         |
| `src/dev/useDevPort.ts`             | React hook connecting dev page to service worker DevHub.                                           |

---

## Source Identity Model

Every tab is identified by a **source string** with the format:

```
"<context>@<tabId>"
```

- **context**: Where in the page the capture originated (default `"root"` for main frame).
- **tabId**: Chrome's numeric tab ID, stringified.

Example: `"root@12345"`.

Two special sentinel values exist (defined in `src/aggregation/types.ts:3-4`):

| Constant      | Value           | Meaning                                                                     |
| ------------- | --------------- | --------------------------------------------------------------------------- |
| `UNKNOWN`     | `"unknown"`     | No content script has connected for this tab yet; source can't be resolved. |
| `OFF_BROWSER` | `"off_browser"` | The browser has lost OS-level focus (user switched to another app).         |

**Source resolution** happens in the aggregator (`src/aggregation/index.ts:67-79`). When a capture arrives, the aggregator constructs the source from `capture.context` + `tabId` and stores it in `tabSources: Map<tabId, source>`. This map is the **only** way the system knows which source a tab maps to — a tab has no source until its first capture arrives.

---

## Chrome API Event Listeners

All Chrome API listeners are registered in `src/background/main.ts`. They fall into three layers:

### Layer 1: Session Structure (lines 43-114)

| Chrome Event                     | What fires it            | Handler                                                        |
| -------------------------------- | ------------------------ | -------------------------------------------------------------- |
| `chrome.windows.onCreated`       | New window opens         | Dev log only (no aggregator call)                              |
| `chrome.windows.onRemoved`       | Window closes            | Dev log only                                                   |
| `chrome.windows.onBoundsChanged` | Window resized/moved     | Dev log only                                                   |
| `chrome.tabs.onCreated`          | New tab created          | `aggregator.ingestSignal({ type: "tab.created", ... }, tabId)` |
| `chrome.tabs.onRemoved`          | Tab closed               | `aggregator.ingestSignal({ type: "tab.closed", ... }, tabId)`  |
| `chrome.tabs.onMoved`            | Tab reordered in strip   | Dev log only                                                   |
| `chrome.tabs.onDetached`         | Tab pulled out of window | Dev log only                                                   |
| `chrome.tabs.onAttached`         | Tab dropped into window  | Dev log only                                                   |

**Note:** `onMoved`, `onDetached`, `onAttached` are logged but do NOT flow into the aggregator. They don't affect the transition graph.

### Layer 2: Navigation (lines 118-169)

| Chrome Event                                 | What fires it                                             | Handler                                                              |
| -------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| `chrome.webNavigation.onCompleted`           | Full page load finishes (top frame only, `frameId === 0`) | `aggregator.ingestSignal({ type: "nav.completed", ... }, tabId)`     |
| `chrome.webNavigation.onHistoryStateUpdated` | History API push/replace (top frame only)                 | `aggregator.ingestSignal({ type: "nav.spa", ... }, tabId)`           |
| `chrome.tabs.onUpdated` (title change)       | Page title changes                                        | `aggregator.ingestSignal({ type: "nav.title_changed", ... }, tabId)` |
| `chrome.tabs.onUpdated` (audible change)     | Tab starts/stops playing audio                            | `aggregator.ingestSignal({ type: "media.audio", ... }, tabId)`       |

**Important:** `onCompleted` and `onHistoryStateUpdated` both call `chrome.tabs.get(details.tabId, ...)` asynchronously to fetch the tab's title. This means the signal is ingested *after* the async callback, not synchronously with the navigation event.

### Layer 3: Attention (lines 173-235)

| Chrome Event                                 | What fires it                                     | Handler                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome.tabs.onActivated`                    | User switches to a different tab                  | **Two things happen:** (1) `aggregator.onTabActivated(tabId, windowId)` — synchronous, triggers transition. (2) `chrome.tabs.get(tabId, ...)` → `aggregator.ingestSignal({ type: "attention.active" })` — async, adds signal to bundle. |
| `chrome.windows.onFocusChanged`              | Window gains/loses OS focus                       | **Two things happen:** (1) `aggregator.onWindowFocusChanged(windowId)` — synchronous, handles off-browser. (2) `aggregator.ingestSignal({ type: "attention.visible" })` — adds visibility signal.                                       |
| `chrome.idle.onStateChanged`                 | System goes idle/active/locked                    | Dev log only (no aggregator call).                                                                                                                                                                                                      |
| `chrome.runtime.onMessage` (page:visibility) | Content script reports Page Visibility API change | `aggregator.ingestSignal({ type: "attention.visible" }, tabId)`                                                                                                                                                                         |

**Critical ordering issue in `onActivated` (main.ts:173-186):** The `aggregator.onTabActivated()` call happens synchronously and triggers a transition in the bundler *before* the async `chrome.tabs.get()` callback fires. So the transition edge is recorded first, then the `attention.active` signal is added to the *new* bundle (the one opened by the transition). This is by design — the transition must happen immediately, but the signal metadata (URL, title) requires an async lookup.

**Critical ordering issue in `onFocusChanged` (main.ts:188-214):** Same pattern. `aggregator.onWindowFocusChanged()` runs synchronously and may start the off-browser timer or transition back. The `attention.visible` signal is then ingested separately. When focus is lost (`WINDOW_ID_NONE`), the signal is sent with tabId `"unknown"` because there's no specific tab to attribute it to. When focus is gained, it does `chrome.tabs.query({ active: true, windowId })` to find which tab is active in the newly focused window.

### Other Listeners

| Chrome Event                                | Handler                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome.downloads.onChanged`                | `aggregator.ingestSignal({ type: "media.download" }, "unknown")` — always uses tabId `"unknown"` since downloads aren't tied to a specific tab. |
| `chrome.runtime.onConnect` (name="capture") | Receives captures from content scripts via persistent port. Extracts `tabId` from `port.sender.tab.id`.                                         |
| `chrome.runtime.onConnect` (name="dev")     | Dev tools connection. Replays buffered logs, streams new entries.                                                                               |

### Service Worker Startup Seeding (main.ts:9-18)

On startup, the service worker queries all existing windows and their active tabs to seed `activeTabPerWindow`:

```typescript
chrome.windows.getAll({ populate: false }, (windows) => {
    for (const w of windows) {
        chrome.tabs.query({ active: true, windowId: w.id }, (tabs) => {
            aggregator.onTabActivated(String(tabs[0].id), w.id);
        });
    }
});
```

This ensures `activeTabPerWindow` is populated even if the service worker restarts mid-session. However, this will call `bundler.transition()` for each window's active tab during startup, which may create spurious edges if `activeSource` is null at that point (it won't — `transition()` checks `from && from !== to` before recording).

---

## Aggregator: The Central Coordinator

**File:** `src/aggregation/index.ts`

The aggregator (`createAggregator()`) manages:

### Internal State

| State                | Type                             | Purpose                                                              |
| -------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `graph`              | `ReturnType<createGraph>`        | Directed weighted edge store + URL mapping                           |
| `bundler`            | `ReturnType<createBundler>`      | Bundle lifecycle (open, seal, transition)                            |
| `tabSources`         | `Map<string, string>`            | Maps `tabId → source` (e.g., `"12345" → "root@12345"`)               |
| `pendingSignals`     | `Map<string, {signal, tabId}[]>` | Signals that arrived before any capture for that tab (no source yet) |
| `activeTabPerWindow` | `Map<number, string>`            | Maps `windowId → tabId` for the currently active tab in each window  |
| `offBrowserTimer`    | `setTimeout handle \| null`      | 200ms debounce timer for off-browser transition                      |

### `ingest(capture, tabId)` (line 67)

Called when a capture arrives from a content script.

1. Constructs source: `"${capture.context}@${tabId}"`.
2. Stores `tabSources.set(tabId, source)` — **this is the first time the system learns about this tab's source**.
3. Stamps the capture with `tabId` and `source`.
4. Calls `bundler.ingest(stamped)` — this may trigger a transition if the source differs from `activeSource`.
5. Calls `flushPending(tabId, source)` — replays any queued signals that arrived before the first capture.
6. Calls `emitState()` — broadcasts state snapshot to dev tools.

### `ingestSignal(signal, tabId)` (line 81)

Called for service-worker-originated events (tab created, navigation, attention, etc.).

1. Looks up `source = tabSources.get(tabId)`.
2. **If no source exists** (no capture has arrived from this tab yet):
   - Queues the signal in `pendingSignals`.
   - Special case: if it's a `tab.closed` signal, clears the pending queue (tab is gone, no point keeping signals).
   - Returns early — signal is NOT forwarded to bundler.
3. **If source exists:**
   - Stamps the signal and calls `bundler.ingestSignal(stamped)`.
   - If the signal carries a URL (checked via `signalPageUrl()`), calls `graph.recordUrl(source, url)`.
   - If `tab.closed`, cleans up `tabSources` and `pendingSignals` for that tab.
4. Calls `emitState()`.

**`signalPageUrl()` (line 9)** extracts URL from these signal types:
- `nav.completed` → `payload.url`
- `nav.spa` → `payload.url`
- `nav.title_changed` → `payload.url`
- `tab.created` → `payload.url`
- `attention.active` → `payload.url`
- `attention.visible` → `payload.url`

### `onTabActivated(tabId, windowId)` (line 137)

Called synchronously when `chrome.tabs.onActivated` fires.

1. Updates `activeTabPerWindow.set(windowId, tabId)` — always, even if suppressed below.
2. **Guard:** If `offBrowserTimer !== null`, returns early. This prevents a spurious tab activation from cancelling the off-browser timer. Chrome sometimes fires `onTabActivated` as part of the same event sequence when the browser is losing focus.
3. Looks up `source = tabSources.get(tabId)`.
4. **If source exists:** calls `bundler.transition(source)` — seals current bundle, records edge, opens new bundle.
5. **If no source:** calls `bundler.seal()` only — seals the current bundle but does NOT transition to UNKNOWN. The tab hasn't connected yet, so we just wait.
6. Calls `emitState()`.

### `onWindowFocusChanged(windowId)` (line 157)

Called synchronously when `chrome.windows.onFocusChanged` fires.

**Case 1: `windowId === chrome.windows.WINDOW_ID_NONE`** (browser lost OS focus)
- Calls `startOffBrowserTimer()` (see [Off-Browser section](#off-browser-transition-mechanism)).

**Case 2: `windowId` is a real window** (browser gained focus / switched windows)
- Calls `cancelOffBrowser()` — cancels the 200ms timer if it's running.
- Looks up the active tab for this window: `tabId = activeTabPerWindow.get(windowId)`.
- Looks up source: `source = tabSources.get(tabId)`.
- **If source exists:** calls `bundler.transition(source)` — transitions from wherever we were (possibly off_browser) back to this tab.
- **If no source** (e.g., focused a DevTools window, extension popup, or chrome:// page):
  - Calls `startOffBrowserTimer()` — treats it the same as losing focus, because we can't track activity in non-content-script windows.

Always calls `emitState()`.

---

## Bundler: Session Segmentation via Transitions

**File:** `src/aggregation/bundler.ts`

The bundler manages the lifecycle of **bundles** (contiguous periods of activity within a single source) and delegates edge recording to the graph.

### Internal State

| State          | Type             | Purpose                                          |
| -------------- | ---------------- | ------------------------------------------------ |
| `activeSource` | `string \| null` | Currently active source. `null` on startup.      |
| `openBundle`   | `Bundle \| null` | The bundle currently accumulating captures.      |
| `sealed`       | `Bundle[]`       | Array of completed bundles. Grows until drained. |

### `transition(to)` (line 36)

The core function that drives the graph. Called whenever the active source changes.

```
1. seal()                          — close current bundle
2. from = activeSource             — remember where we were
3. if (from && from !== to)        — only record if both exist and differ
4.     graph.recordEdge(from, to)  — add/increment edge in the graph
5. activeSource = to               — update active source
6. if (to !== UNKNOWN && to !== OFF_BROWSER)
7.     openNew(to)                 — start a new bundle (but NOT for UNKNOWN/OFF_BROWSER)
```

**Key behaviors:**
- Self-transitions (`from === to`) are silently ignored — no edge recorded, but the bundle is still sealed and reopened.
- Transitions from `null` (startup) don't record an edge because `from` is falsy.
- Transitions TO `UNKNOWN` or `OFF_BROWSER` do NOT open a new bundle — we don't accumulate captures in these states.
- Transitions FROM `UNKNOWN` or `OFF_BROWSER` DO record an edge (they're valid sources in the graph).

### `ingest(stamped)` (line 49)

Called when a capture arrives from a content script (via `aggregator.ingest()`).

1. **If `activeSource` is null OR `stamped.source !== activeSource`:** calls `transition(stamped.source)` — this handles initial connection and source changes.
2. **Else if no open bundle** (shouldn't normally happen, but defensive): opens a new bundle.
3. Pushes the stamped capture into `openBundle.captures`.

### `ingestSignal(stamped)` (line 58)

Called for service-worker signals.

1. **If no open bundle:** silently drops the signal. This happens when we're in `OFF_BROWSER` or `UNKNOWN` state.
2. Otherwise, pushes the signal into `openBundle.captures`.

**This means signals are dropped during off-browser periods.** If a `nav.completed` signal arrives while the user is off-browser, it vanishes.

### `seal()` (line 23)

Closes the current bundle:
1. Sets `endedAt = Date.now()`.
2. Generates human-readable text via `translate(openBundle)`.
3. Pushes to `sealed` array.
4. Sets `openBundle = null`.

### Bundle Structure (types.ts:10-16)

```typescript
type Bundle = {
    source: string;           // "context@tabId"
    startedAt: number;        // Date.now() when opened
    endedAt: number | null;   // Date.now() when sealed (null while open)
    captures: BundleEntry[];  // Array of stamped captures and signals
    text: string | null;      // Human-readable summary (null while open)
};
```

---

## Graph: Edge Recording

**File:** `src/aggregation/graph.ts`

### Internal State

| State   | Type                  | Purpose                                                                 |
| ------- | --------------------- | ----------------------------------------------------------------------- |
| `edges` | `Map<string, Edge>`   | Key: `"from\0to"` (null byte separator). Value: `{ from, to, weight }`. |
| `urls`  | `Map<string, string>` | Maps `source → url`. Updated on navigation events.                      |

### `recordEdge(from, to)` (line 12)

1. Computes key: `"${from}\0${to}"`.
2. If edge exists: increments `weight`.
3. If new: creates edge with `weight: 1`.
4. Emits dev log.

The graph is **directed** — `A→B` and `B→A` are separate edges with independent weights.

### `recordUrl(source, url)` (line 44)

1. If the URL hasn't changed for this source, returns early (dedup).
2. Otherwise, updates the map and emits dev log.

This is called from the aggregator whenever a signal carries a URL (see `signalPageUrl()`).

### `drainEdges()` (line 38)

Returns all edges and **clears the map**. Used for syncing to external storage. This is destructive — once drained, the in-memory graph is empty.

---

## Off-Browser Transition Mechanism

**File:** `src/aggregation/index.ts`, lines 120-135

This handles the case where the user switches away from the browser entirely (e.g., to a terminal, IDE, etc.).

### Timing

| Constant                | Value | Purpose                                               |
| ----------------------- | ----- | ----------------------------------------------------- |
| `OFF_BROWSER_SETTLE_MS` | `200` | Debounce delay before committing to off-browser state |

### `startOffBrowserTimer()` (line 127)

```typescript
function startOffBrowserTimer(): void {
    cancelOffBrowser();           // cancel any existing timer
    bundler.seal();               // immediately seal current bundle (stop accumulating)
    offBrowserTimer = setTimeout(() => {
        offBrowserTimer = null;
        bundler.transition(OFF_BROWSER);  // after 200ms, commit to off_browser
        emitState();
    }, OFF_BROWSER_SETTLE_MS);
}
```

**Two-phase approach:**
1. **Immediate:** `bundler.seal()` — stops accumulating captures in the current bundle right away.
2. **Deferred (200ms):** `bundler.transition(OFF_BROWSER)` — records the edge and updates `activeSource`.

The 200ms settle time exists because Chrome fires rapid focus events when switching between browser windows. Without it, switching from Window A to Window B would briefly lose focus (creating a spurious `off_browser` node).

### `cancelOffBrowser()` (line 120)

Simply clears the timer. Called when focus returns to a browser window within 200ms.

### Edge Case: seal() is called but transition is cancelled

If the timer is cancelled after `seal()` but before `transition()`:
- The current bundle IS sealed (activity stops being recorded).
- But no `off_browser` edge is created.
- When focus returns, `onWindowFocusChanged()` or `onTabActivated()` will call `bundler.transition(source)`, which will record an edge from `activeSource` (still the previous tab) to the new source.
- **The sealed bundle's `endedAt` reflects the moment focus was lost, not when it returned.** There's a gap in capture recording during the settle period. This gap is at most 200ms.

### Edge Case: onTabActivated fires during off-browser timer

Chrome sometimes fires `onTabActivated` as part of the focus-loss event sequence. The guard in `onTabActivated()` (line 146) handles this:

```typescript
if (offBrowserTimer !== null) return;
```

This prevents the spurious activation from:
1. Cancelling the off-browser timer.
2. Creating a wrong transition edge.
3. Opening a new bundle that would immediately be orphaned.

However, `activeTabPerWindow` IS still updated (line 138), so when focus eventually returns, the system knows which tab was last active in each window.

---

## Tab Activation Flow (Step by Step)

### Scenario: User is on Tab A, clicks Tab B

```
1. Chrome fires: tabs.onActivated({ tabId: B, windowId: W })

2. main.ts:173 handler runs:
   a. aggregator.onTabActivated("B", W)        ← synchronous
   b. chrome.tabs.get(B, callback)              ← async, queued

3. Inside aggregator.onTabActivated("B", W):
   a. activeTabPerWindow.set(W, "B")
   b. offBrowserTimer is null → continue
   c. source = tabSources.get("B")
   d. IF source exists (e.g., "root@B"):
      → bundler.transition("root@B")
        → seal()  [closes Tab A's bundle]
        → graph.recordEdge("root@A", "root@B")  [weight++]
        → activeSource = "root@B"
        → openNew("root@B")  [starts Tab B's bundle]
   e. IF source is undefined (no capture from Tab B yet):
      → bundler.seal()  [closes Tab A's bundle, no edge recorded]
      → activeSource stays as "root@A"
   f. emitState()

4. Later: chrome.tabs.get callback fires:
   a. aggregator.ingestSignal({ type: "attention.active", url, title }, "B")
   b. Inside ingestSignal:
      → IF source exists: stamped signal pushed into openBundle.captures
      → IF no source: signal queued in pendingSignals

5. If Tab B eventually sends its first capture:
   a. aggregator.ingest(capture, "B")
   b. source = "root@B", tabSources.set("B", "root@B")
   c. bundler.ingest(stamped) → sees source !== activeSource
      → transition("root@B") → records edge from activeSource
   d. flushPending("B", "root@B") → replays queued signals
```

### Scenario: User is on Tab A, opens a new tab (Tab C)

```
1. Chrome fires: tabs.onCreated(tab)
   → aggregator.ingestSignal({ type: "tab.created" }, "C")
   → No source for C yet → queued in pendingSignals

2. Chrome fires: tabs.onActivated({ tabId: C, windowId: W })
   → aggregator.onTabActivated("C", W)
   → No source for C → bundler.seal() only, no transition

3. Content script loads in Tab C, connects port, sends first capture
   → aggregator.ingest(capture, "C")
   → source = "root@C"
   → bundler.ingest → transition("root@C")
     → edge: "root@A" → "root@C"
   → flushPending("C") → tab.created signal replayed into bundle
```

---

## Window Focus Change Flow (Step by Step)

### Scenario: User Alt-Tabs to another app

```
1. Chrome fires: windows.onFocusChanged(WINDOW_ID_NONE)

2. main.ts:188 handler runs:
   a. aggregator.onWindowFocusChanged(WINDOW_ID_NONE)     ← synchronous
   b. aggregator.ingestSignal({ type: "attention.visible",
      visible: false }, "unknown")                         ← sync (no async lookup)

3. Inside aggregator.onWindowFocusChanged(WINDOW_ID_NONE):
   a. startOffBrowserTimer()
      → cancelOffBrowser() [clear any existing timer]
      → bundler.seal()     [immediately close current bundle]
      → setTimeout(200ms):
          → bundler.transition("off_browser")
            → graph.recordEdge("root@A", "off_browser")
            → activeSource = "off_browser"
            → NO new bundle opened (off_browser is filtered)
          → emitState()
   b. emitState()

4. The "attention.visible" signal with tabId "unknown":
   → tabSources has no entry for "unknown"
   → queued in pendingSignals["unknown"]
   → will never be flushed (no capture ever arrives for "unknown")
```

### Scenario: User Alt-Tabs back within 200ms

```
1. Chrome fires: windows.onFocusChanged(W)  [W is a real window]

2. aggregator.onWindowFocusChanged(W):
   a. cancelOffBrowser()  [clears the 200ms timer — no off_browser edge created]
   b. tabId = activeTabPerWindow.get(W)  → "A"
   c. source = tabSources.get("A")  → "root@A"
   d. bundler.transition("root@A")
      → seal() [nothing to seal, already sealed by startOffBrowserTimer]
      → activeSource is still "root@A" (timer was cancelled before transition)
      → from === to → NO edge recorded
      → openNew("root@A")  [reopens bundle for Tab A]

Result: No off_browser node in the graph. Brief gap in capture recording
(between seal() and openNew(), ~200ms max).
```

### Scenario: User Alt-Tabs back after 200ms

```
1. The 200ms timer has already fired:
   → bundler.transition("off_browser") was called
   → edge: "root@A" → "off_browser" recorded
   → activeSource = "off_browser"

2. Chrome fires: windows.onFocusChanged(W)

3. aggregator.onWindowFocusChanged(W):
   a. cancelOffBrowser() [timer already null, no-op]
   b. tabId = activeTabPerWindow.get(W) → "A"
   c. source = tabSources.get("A") → "root@A"
   d. bundler.transition("root@A")
      → seal() [nothing to seal, off_browser doesn't open a bundle]
      → graph.recordEdge("off_browser", "root@A")
      → activeSource = "root@A"
      → openNew("root@A")

Result: Two edges created: "root@A" → "off_browser" and "off_browser" → "root@A".
The off_browser node appears in the graph.
```

### Scenario: Focus returns to a window with no source (e.g., DevTools)

```
1. Chrome fires: windows.onFocusChanged(W_devtools)

2. aggregator.onWindowFocusChanged(W_devtools):
   a. cancelOffBrowser()
   b. tabId = activeTabPerWindow.get(W_devtools) → maybe "D"
   c. source = tabSources.get("D") → undefined (DevTools has no content script)
   d. startOffBrowserTimer()
      → Same behavior as losing focus entirely

Result: DevTools windows are treated as "off browser" because they don't run
content scripts and have no source mapping.
```

---

## Content Script Pipeline & SPA Navigation

### Pipeline Architecture

Each content script builds a pipeline when its route matches:

```
tap() → adapter() → normalizer() → relay()
```

**`tap(context="root")`** (`src/event/tap.ts`): Attaches DOM listeners for:
- Keystrokes (keydown, composition)
- Mouse (click, auxclick, dblclick, contextmenu)
- Scroll
- Selection & clipboard (selectionchange, copy, paste)
- Forms (focusin, change, submit)

Uses `AbortController` for clean teardown.

**Adapters** (site-specific middleware):
- `outlookAdapter` — for Outlook URLs
- `fileAdapter` — for `file://` URLs
- `htmlAdapter` — catch-all for generic web pages

**`normalizer()`** (`src/event/normalizer.ts`): Composition of four sub-normalizers:
- `keystrokeNormalizer`: Batches printable keys into `input.keystroke_batch` after 1s idle.
- `scrollNormalizer`: Debounces scroll events, emits after 150ms idle.
- `selectionNormalizer`: Debounces selections, emits after 300ms idle, drops empty.
- `formFocusNormalizer`: Deduplicates re-focus on same form within 2s.

**`relay()`** (`src/event/relay.ts`): Terminal stage. Opens `chrome.runtime.connect({ name: "capture" })` and sends each capture as `{ type: "capture", payload: capture }`.

### Route Matching

**File:** `src/event/registry.ts`

```typescript
const registry: Route[] = [
    { match: /outlook\.(com|live\.com)/, build: () => relay(normalizer(outlookAdapter(tap()))) },
    { match: url.startsWith("file://"),  build: () => relay(normalizer(fileAdapter(tap()))) },
    { match: () => true,                 build: () => relay(normalizer(htmlAdapter(tap()))) },  // catch-all
];
```

First match wins. The catch-all ensures every page gets a pipeline.

### SPA Navigation Detection

**File:** `src/event/spa-observer.ts`

Only active for known SPA hosts:

```typescript
const SPA_PATTERNS = [
    /outlook\.(com|live\.com)/,
    /mail\.google\.com/,
    /github\.com/,
];
```

Monkey-patches `history.pushState` and `history.replaceState`, listens for `popstate`.

When a SPA navigation is detected:
1. `onNavigate(newUrl)` fires.
2. Content script (`src/content/main.ts:21-28`) checks if the new URL matches a different route.
3. If different route: tears down old pipeline, builds new one.
4. If same route: no pipeline change (SPA navigation within same route is tracked via `nav.spa` signals from the service worker's `webNavigation.onHistoryStateUpdated`).

**Note:** The SPA observer in the content script and `chrome.webNavigation.onHistoryStateUpdated` in the service worker are **redundant for URL tracking** — both detect History API changes. The content script observer handles pipeline switching; the service worker one handles URL recording in the graph.

### Visibility Tracking

**File:** `src/event/visibility.ts`

Runs in **every** content script (line 11 of `content/main.ts: setupVisibility()` is called before route matching).

Uses the Page Visibility API (`document.visibilitychange`) to detect when a tab becomes visible/hidden. Deduplicates by tracking `lastState`. Also handles `pageshow` for bfcache restoration.

Sends visibility changes via `chrome.runtime.sendMessage({ type: "page:visibility", visible, url, title })`, which is received by the service worker's `onMessage` listener (main.ts:222-235) and forwarded to `aggregator.ingestSignal()`.

---

## Signal vs Capture Ingestion

Understanding the difference is critical to understanding the graph:

|                             | Captures                                                        | Signals                                                   |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| **Origin**                  | Content script (DOM events)                                     | Service worker (Chrome API events)                        |
| **Transport**               | Port-based (`chrome.runtime.connect("capture")`)                | Direct call within service worker                         |
| **Trigger transitions?**    | YES — `bundler.ingest()` calls `transition()` if source changes | NO — `bundler.ingestSignal()` only appends to open bundle |
| **Dropped when no bundle?** | Never — `ingest()` opens a bundle if needed                     | YES — silently dropped if `openBundle` is null            |
| **Affect graph edges?**     | Indirectly (via transitions)                                    | Only `graph.recordUrl()` for URL updates                  |
| **Source resolution**       | Source computed from `capture.context + tabId`                  | Source looked up from `tabSources` map                    |

**This asymmetry means:** The graph is built ONLY from capture-driven transitions and explicit `onTabActivated`/`onWindowFocusChanged` calls. Signals like `nav.completed` or `tab.created` don't create edges — they just annotate bundles and update URLs.

---

## Dev Tools Visualization

### Dev Page Routing

**File:** `src/dev/App.tsx`

Hash-based tab routing (`#graph`, `#logs`, `#state`):

```typescript
const tabs = [
    { id: "graph", label: "Graph", icon: GitGraph },
    { id: "logs",  label: "Logs",  icon: ScrollText },
    { id: "state", label: "State", icon: Box },
];
```

Default tab is `"graph"`. The `useHashTab()` hook reads `window.location.hash` and listens for `hashchange`.

### Dev Port Connection

**File:** `src/dev/useDevPort.ts`

- Connects via `chrome.runtime.connect({ name: "dev" })`.
- Receives `DevEntry` objects and maintains an array (capped at 500 entries).
- Auto-reconnects after 1s if the service worker restarts.
- Supports channel/event filtering via bidirectional messages.

### Graph Visualization

**File:** `src/dev/panels/GraphView.tsx`

**Data extraction (processEntries):**
- Scans `entries` for `channel === "graph"` events.
- `edge.created` → creates nodes (positioned near neighbor or random) + edge.
- `edge.incremented` → updates edge weight.
- `url.updated` → updates URL map for node tooltips.

**Force-directed layout (tick):**
- **Charge repulsion:** Every node pair repels with force `CHARGE_K / dist^2` (Coulomb's law). `CHARGE_K = 800`.
- **Spring attraction:** Connected nodes attract with `SPRING_K * (dist - REST_LENGTH)`. `SPRING_K = 0.02`, `REST_LENGTH = 120`.
- **Center gravity:** Weak pull toward origin. `CENTER_K = 0.005`.
- **Damping:** Velocity multiplied by `0.85` each tick.
- **Sleep:** Simulation stops when total energy < `0.05`. Wakes when new data arrives.

**Canvas rendering (draw):**
- Dot grid background.
- Edges: line width = `1 + log2(weight)`. Weight label at midpoint.
- Nodes: 8px radius circles. Blue fill, dashed border for `UNKNOWN` nodes.
- Source label below each node. Origin sub-label from URL if available.
- Hover: highlight ring + tooltip with degree, inbound/outbound edges, weights, timestamps.

**Interaction:**
- Pan: click + drag on empty space.
- Node drag: click + drag on node (pins it, wakes simulation).
- Zoom: mouse wheel (0.1x–10x range).
- Fit to view: button computes bounding box and adjusts zoom/pan.
- Fullscreen: native fullscreen API.

**Graph has Raw/Grouped toggle** (lines 763-786) but "Grouped" mode has no rendering — only the tab exists.

### State Inspector

**File:** `src/dev/panels/StateInspector.tsx`

Reads the latest `state.snapshot` entry from the dev log stream. Has two views:

- **Raw:** Shows full JSON tree or formatted view with:
  - Active Source (with URL)
  - Open Bundle (source, duration, capture list)
  - Sealed Bundles (source, span, duration, capture count, text summary, copy-to-clipboard)
  - Edges (from → to with weight)

- **Grouped:** "Not implemented yet."

---

## Race Conditions & Edge Cases

### 1. Tab activated before content script connects

- `onTabActivated("B", W)` runs but `tabSources.get("B")` returns undefined.
- `bundler.seal()` is called (closes current bundle) but no transition happens.
- `activeSource` remains unchanged.
- When Tab B's content script sends its first capture:
  - `aggregator.ingest()` constructs `source = "root@B"`.
  - `bundler.ingest()` detects `source !== activeSource` → calls `transition("root@B")`.
  - Edge is recorded from whatever `activeSource` was.

**Consequence:** The transition edge is delayed until the first capture. The user might have been looking at Tab B for seconds before the edge appears in the graph.

### 2. Rapid window switching (< 200ms)

- Focus lost → `startOffBrowserTimer()` → `seal()` + 200ms timer.
- Focus gained within 200ms → `cancelOffBrowser()` + `transition(source)`.
- No `off_browser` node created. Clean transition between sources.
- However: the bundle was sealed on focus loss. There's a brief gap where captures are lost (between `seal()` and the new `openNew()` in `transition()`).

### 3. Multiple windows — switching between two browser windows

- Window A has focus → `onFocusChanged(WINDOW_ID_NONE)` → `startOffBrowserTimer()`.
- Window B gains focus → `onFocusChanged(B)` → `cancelOffBrowser()` + `transition(source_in_B)`.
- If < 200ms: clean transition from source_in_A to source_in_B. No off_browser.
- If > 200ms: edge source_in_A → off_browser, then off_browser → source_in_B.

### 4. Spurious onTabActivated during focus loss

Chrome sometimes fires `tabs.onActivated` as part of the focus-loss sequence. The guard `if (offBrowserTimer !== null) return` in `onTabActivated()` prevents this from:
- Creating a wrong transition edge.
- Cancelling the off-browser timer.

`activeTabPerWindow` is still updated so the correct tab is known when focus returns.

### 5. Signals for tabs that never sent a capture

Signals (like `tab.created`) are queued in `pendingSignals`. If the tab never loads a content script (e.g., `chrome://` pages, PDFs without the extension, etc.):
- Signals accumulate in `pendingSignals` indefinitely.
- `tab.closed` cleans up: `pendingSignals.delete(tabId)`.
- But if `tab.closed` never fires (e.g., the tab is still open), signals leak.

### 6. Downloads and unknown tabId

Downloads use tabId `"unknown"`. Since `tabSources` never has an entry for `"unknown"`, download signals are always queued in `pendingSignals["unknown"]` and never flushed. They are effectively black-holed.

### 7. The attention.visible signal on focus loss uses tabId "unknown"

When `onFocusChanged(WINDOW_ID_NONE)` fires, the `attention.visible` signal is sent with tabId `"unknown"` (main.ts:197). Same as downloads — queued and never flushed.

### 8. drainEdges() and drainSealed() are destructive

Both methods return data AND clear internal state. If called mid-session:
- `drainEdges()`: All edges are gone from memory. Future transitions start fresh with weight 1.
- `drainSealed()`: All sealed bundles are gone. Only the current open bundle survives.

These are used for syncing to external storage but could cause data loss if called at the wrong time.

---

## Constants & Timing

| Constant                | Value  | Location                    | Purpose                                            |
| ----------------------- | ------ | --------------------------- | -------------------------------------------------- |
| `OFF_BROWSER_SETTLE_MS` | 200ms  | aggregation/index.ts:33     | Debounce before committing off-browser transition  |
| `KEYSTROKE_FLUSH_MS`    | 1000ms | event/normalizer.ts:7       | Batch keystrokes after 1s of no typing             |
| `SCROLL_IDLE_MS`        | 150ms  | event/normalizer.ts:85      | Emit scroll after 150ms of no scrolling            |
| `SELECTION_IDLE_MS`     | 300ms  | event/normalizer.ts:128     | Emit selection after 300ms of no selection changes |
| `FORM_FOCUS_DEDUP_MS`   | 2000ms | event/normalizer.ts:181     | Deduplicate re-focus on same form within 2s        |
| `MAX_ENTRIES` (dev)     | 500    | dev/useDevPort.ts:14        | Max dev log entries kept in React state            |
| `LOG_BUFFER_SIZE` (sw)  | 10000  | background/main.ts:261      | Max dev log entries buffered in service worker     |
| `RECONNECT_MS`          | 1000ms | dev/useDevPort.ts:15        | Delay before reconnecting dev port                 |
| `CHARGE_K`              | 800    | dev/panels/GraphView.tsx:20 | Coulomb repulsion constant                         |
| `SPRING_K`              | 0.02   | dev/panels/GraphView.tsx:21 | Spring attraction constant                         |
| `REST_LENGTH`           | 120    | dev/panels/GraphView.tsx:22 | Ideal edge length in pixels                        |
| `CENTER_K`              | 0.005  | dev/panels/GraphView.tsx:23 | Center gravity constant                            |
| `DAMPING`               | 0.85   | dev/panels/GraphView.tsx:24 | Velocity damping per tick                          |
| `ENERGY_THRESHOLD`      | 0.05   | dev/panels/GraphView.tsx:26 | Total energy below which simulation sleeps         |

---

## Data Flow Diagrams

### Complete Flow: User clicks a link that opens a new tab

```
User clicks link on Tab A
    │
    ▼
[Content Script - Tab A]
    tap() emits input.click capture
    │
    ▼
    normalizer() passes through (click isn't batched/debounced)
    │
    ▼
    relay() sends via port: { type: "capture", payload: capture }
    │
    ▼
[Service Worker]
    chrome.runtime.onConnect listener receives it
    aggregator.ingest(capture, "A")
    → source = "root@A"
    → bundler.ingest(stamped) → already active source, just appends
    → emitState()

    Meanwhile, Chrome fires tabs.onCreated for Tab B
    → aggregator.ingestSignal({ type: "tab.created" }, "B")
    → no source for "B" yet → queued in pendingSignals

    Chrome fires tabs.onActivated for Tab B
    → aggregator.onTabActivated("B", W)
    → no source for "B" → bundler.seal() (seals Tab A's bundle)
    → emitState()

    Chrome fires webNavigation.onCompleted for Tab B
    → aggregator.ingestSignal({ type: "nav.completed", url }, "B")
    → no source for "B" → queued in pendingSignals

[Content Script - Tab B loads, connects port, sends first capture]
    → aggregator.ingest(capture, "B")
    → source = "root@B", tabSources.set("B", "root@B")
    → bundler.ingest(stamped)
      → source !== activeSource
      → transition("root@B")
        → seal() [nothing to seal, already sealed]
        → graph.recordEdge("root@A", "root@B")
        → activeSource = "root@B"
        → openNew("root@B")
    → flushPending("B", "root@B")
      → tab.created signal added to bundle
      → nav.completed signal added to bundle
      → graph.recordUrl("root@B", url)
    → emitState()
```

### Graph state after a typical session

```
Nodes:  root@101, root@102, root@103, off_browser

Edges:
  root@101 → root@102  (weight: 3)   User switched tabs 3 times
  root@102 → root@101  (weight: 2)   User switched back twice
  root@102 → root@103  (weight: 1)   Opened new tab from 102
  root@101 → off_browser (weight: 2) Left browser twice while on tab 101
  off_browser → root@101 (weight: 1) Came back to tab 101 once
  off_browser → root@102 (weight: 1) Came back to tab 102 once
```
