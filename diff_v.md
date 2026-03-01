# Differences: `tab-nav.md` (be-v1) vs `off_browser.md` (browser-extension)

`tab-nav.md` documents **be-v1** (this repo). `off_browser.md` documents the **browser-extension** (a separate, newer codebase). This file compares the two systems across every significant axis.

---

## 1. Architecture & File Layout

| Aspect                  | be-v1 (`tab-nav.md`)                                                                                                                                 | browser-extension (`off_browser.md`)                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service worker entry    | `src/background/main.ts` — single file wires all Chrome listeners and DevHub                                                                         | `src/background/service-worker.ts` — orchestrator that calls `startAggregator()`, then individual collectors (`startTabCollector`, `startWindowCollector`, etc.)                    |
| Transition recording    | **Bundler owns it.** `bundler.transition()` calls `graph.recordEdge()` inline. Graph is a dumb store.                                                | **TransitionTracker is a separate class** (`transition-tracker.ts`) with its own self-loop guard, dwell time, persistence, and broadcasting. Decoupled from any bundler equivalent. |
| Graph storage           | `graph.ts` — in-memory `Map<string, Edge>` with `drainEdges()` that clears state. No persistence.                                                    | `TransitionTracker` stores transitions in an array + `chrome.storage.session` for persistence across service worker restarts.                                                       |
| Content script pipeline | `tap → adapter → normalizer → relay` — composable middleware pattern. Multiple adapters (outlook, file, html catch-all).                             | Not detailed in `off_browser.md` but has `event-buffer.ts` for batched flushing (1s buffer) and `visibility.ts`.                                                                    |
| Event routing           | All Chrome listeners in one file (`main.ts`). Events go directly to `aggregator.ingest()` or `aggregator.ingestSignal()`.                            | Collectors are separate modules. Events pass through a ready gate and aggregator with context resolution before reaching the transition tracker.                                    |
| Dev tools               | Full dev page with hash-routed tabs (Graph, Logs, State). Force-directed graph canvas visualization. State inspector with JSON tree/formatted views. | DevTools graph inspector connected via broadcast ports. Less detail in the doc about visualization.                                                                                 |

---

## 2. Source Identity

| Aspect               | be-v1                                                                 | browser-extension                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format               | `"<context>@<tabId>"` (e.g., `"root@12345"`)                          | `"root@<tabId>"` for tabs, `"frame:<tabId>:<frameKey>"` for sub-tab views                                                                                     |
| Sub-tab sources      | **None.** One source per tab, always.                                 | **FrameManager** creates virtual sub-tab sources for SPAs (e.g., different Outlook emails within one tab get distinct sources like `frame:42:inbox-msg-123`). |
| Off-browser sentinel | `"off_browser"` (underscore)                                          | `"off-browser"` (hyphen)                                                                                                                                      |
| Unknown sentinel     | `"unknown"` — used as tabId fallback AND as source sentinel `UNKNOWN` | `"none"` (`NO_TAB`) for invalid tab IDs. No conflation with source identity.                                                                                  |
| Tab ID format        | String (just `String(chromeTabId)`)                                   | String via `toTabId()` helper that maps undefined/negative to `"none"`                                                                                        |

---

## 3. Tab Activation Handling

| Aspect                    | be-v1                                                                                                                                                                          | browser-extension                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Previous tab deactivation | **Not emitted.** `onTabActivated()` calls `bundler.transition()` which seals the old bundle, but no explicit `attention.active: false` event is emitted for the previous tab.  | **Always emitted synchronously** as Phase 1 of the handler. Explicit `attention.active: false` for the previous tab is emitted before anything else. Three guards: prev exists, not self-switch, in focused window.    |
| Transition recording      | `bundler.transition(source)` → `graph.recordEdge(from, to)` — only if source is already known via `tabSources`. If tab hasn't sent a capture yet, only `seal()` runs, no edge. | `transitionTracker.recordSwitch(source, ts)` — called with frame-resolved source. Has sync path (tabStates has data) and async fallback (`chrome.tabs.get()`). Always records a transition if lastActiveTabId differs. |
| Self-loop prevention      | Implicit: `bundler.transition()` checks `from && from !== to`. If `from === to`, no edge but bundle is sealed and reopened.                                                    | Explicit: `this.lastActiveTabId !== newTabId` guard in `recordSwitch()`. Updates metadata but skips transition creation.                                                                                               |
| When source is unknown    | `bundler.seal()` only — no transition, no edge. Edge is deferred until first capture arrives from that tab.                                                                    | Async fallback to `chrome.tabs.get()`. Transition is still recorded (possibly with empty URL/title). The timestamp captured at the top is passed through for accuracy.                                                 |
| Spurious activation guard | `if (offBrowserTimer !== null) return` — suppresses `onTabActivated` that fires as part of focus-loss sequence.                                                                | Three guards on deactivation (prev exists, not self-switch, in focused window). The off-browser timer is only in `onFocusChanged`, not checked in `onActivated`.                                                       |

---

## 4. Off-Browser Mechanism

| Aspect                     | be-v1                                                                                                                                                                                                                                                  | browser-extension                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settle timer               | 200ms (`OFF_BROWSER_SETTLE_MS`)                                                                                                                                                                                                                        | 200ms (`OFF_BROWSER_SETTLE_MS`)                                                                                                                                                            |
| Two-phase approach         | **Yes.** Phase 1: `bundler.seal()` (immediate). Phase 2: `bundler.transition(OFF_BROWSER)` (after 200ms).                                                                                                                                              | **No immediate seal.** Phase 1: deactivate previous tab's `active` flag (immediate). Phase 2: `recordSwitch(OFF_BROWSER)` after 200ms. No separate seal step.                              |
| Deactivation on focus loss | **Not emitted.** Bundle is sealed but no `attention.active: false` event. The `attention.visible: false` signal is sent with tabId `"unknown"` and gets queued/dropped.                                                                                | **Always emitted synchronously.** `attention.active: false` for the previously focused window's tab is emitted before setting `focusedWindowId = null`.                                    |
| Timer cancellation         | `cancelOffBrowser()` clears timer. Then `bundler.transition(source)` resumes.                                                                                                                                                                          | `clearTimeout(offBrowserTimer)` in the `focusedWindowId !== null` branch of `onFocusChanged`.                                                                                              |
| Capture gap during settle  | **Yes.** Between `seal()` and the new `openNew()` (up to 200ms), captures arriving for the previous source have no open bundle and are dropped by `ingestSignal`. Captures from content scripts can still trigger `ingest()` which opens a new bundle. | **No capture gap.** Events continue to be emitted normally. Only the transition edge recording is deferred, not event emission.                                                            |
| Off-browser in graph       | Single `"off_browser"` node. All off-browser transitions merge into one node.                                                                                                                                                                          | Single `"off-browser"` node in the live graph, but **time-chunked during preprocessing** into `hub:off-browser:0`, `hub:off-browser:1`, etc. (5-minute windows) with 2x edge weight boost. |

---

## 5. Window Focus Change Handling

| Aspect                    | be-v1                                                                                                                                                | browser-extension                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DevTools window focus     | Treated as losing focus — calls `startOffBrowserTimer()`. DevTools windows have no `tabSources` entry, so they fall through to the off-browser path. | **Explicitly handled.** `activeTabPerWindow.get(devToolsWindowId)` returns undefined. No activation event emitted, no transition recorded. But `focusedWindowId` is set to the DevTools window ID, so it does NOT trigger the off-browser timer (only `WINDOW_ID_NONE` does). |
| Window-to-window switch   | Two Chrome events: `NONE` then `newWindow`. If < 200ms: timer cancelled, clean transition. If > 200ms: two edges through off_browser.                | Same 200ms logic. Clean `tabA → tabB` if within 200ms, `tabA → off-browser → tabB` if not.                                                                                                                                                                                    |
| Previous tab deactivation | **Not emitted** on window focus change. Bundle is sealed or off-browser timer starts, but no explicit deactivation event.                            | **Always emitted synchronously.** `attention.active: false` for the previous window's active tab is the first thing that happens.                                                                                                                                             |

---

## 6. Signal vs Capture Model

| Aspect               | be-v1                                                                                                                                                                                                             | browser-extension                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two event types      | **Captures** (content script DOM events, via port) and **Signals** (service worker Chrome API events). Fundamentally different ingestion paths.                                                                   | **Unified `SessionEvent` type.** All events go through the same `emit()` → `routeEvent()` pipeline. No capture/signal distinction.                                                                                 |
| Transition triggers  | Captures trigger transitions (via `bundler.ingest()` detecting source change). Signals never trigger transitions. `onTabActivated`/`onWindowFocusChanged` also trigger transitions directly.                      | `onActivated`, `onFocusChanged`, and frame changes trigger transitions via `transitionTracker.recordSwitch()`. Content script captures don't directly trigger transitions — only tab/window/frame activation does. |
| Dropped events       | Signals are silently dropped when `openBundle` is null (during off-browser or unknown states). Downloads and focus-loss visibility signals use tabId `"unknown"` and are black-holed in `pendingSignals` forever. | **Ready gate** buffers events during startup. Once ready, all events are routed. No signal dropping by design.                                                                                                     |
| Pending signal queue | `pendingSignals: Map<tabId, signals[]>` — signals queued until first capture from that tab establishes a source. Flushed on first capture. Cleaned up on `tab.closed`.                                            | No equivalent. Events are emitted immediately with whatever state is available. Async fallback for missing metadata.                                                                                               |

---

## 7. SPA / In-Tab Navigation

| Aspect                         | be-v1                                                                                                                                                                                        | browser-extension                                                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPA detection (content script) | Monkey-patches `history.pushState`/`replaceState`, listens for `popstate`. Only for known SPA hosts (Outlook, Gmail, GitHub). Used for pipeline switching (teardown old adapter, build new). | Not detailed in `off_browser.md`. Frame changes handled via `FRAME_CHANGED` messages.                                                                                                                                                   |
| SPA detection (service worker) | `chrome.webNavigation.onHistoryStateUpdated` → `nav.spa` signal → updates `graph.recordUrl()`. Redundant with content script SPA observer.                                                   | Not mentioned separately. URL updates likely handled through tab metadata updates.                                                                                                                                                      |
| Sub-tab transitions            | **Not supported.** One source per Chrome tab, always. SPA navigation within a tab doesn't create new graph nodes.                                                                            | **FrameManager** creates virtual sources like `frame:42:inbox-msg-123`. Frame changes create real transitions in the graph (deactivate old frame, activate new frame).                                                                  |
| Transient context suppression  | **Not present.** No mechanism to prevent star patterns from SPA navigation through intermediate URLs.                                                                                        | **Explicit suppression.** `isTransientContext` check prevents `"root"` or `"outlook"` contexts from creating transitions. `lastSourcePerTab` is not updated for transient contexts, so the graph jumps directly from `emailA → emailB`. |

---

## 8. Persistence & Recovery

| Aspect                 | be-v1                                                                                                                                                                                          | browser-extension                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transition persistence | **None.** All state is in-memory. `drainEdges()` and `drainSealed()` are destructive — data is gone after drain. Service worker restart = complete state loss.                                 | `chrome.storage.session` with 2s debounce. On service worker restart, `restore()` recovers full transition graph, tab metadata, and last active state.            |
| Startup seeding        | Queries `chrome.windows.getAll()` and `chrome.tabs.query()` to seed `activeTabPerWindow`. But no transition history recovery.                                                                  | Full restore from `chrome.storage.session` + `startAggregator()` is async with ready gate to buffer events during restore.                                        |
| Ready gate             | **None.** Chrome listeners are registered synchronously on script load. If a listener fires before `createAggregator()` returns, it works because the aggregator is created synchronously too. | **Explicit ready gate.** `pendingEvents[]` buffers all events until `startAggregator()` resolves. Prevents events from being dropped during async initialization. |

---

## 9. Graph Preprocessing & Session Management

| Aspect              | be-v1                                                                                                              | browser-extension                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph preprocessing | **None in the documented code.** Raw edges with weights. No hub detection, no transient removal, no time-chunking. | **Full preprocessing pipeline:** transient access removal (< 500ms dwell), chain detection (< 1s sequences), hub detection (> 10% connectivity with > 15 tabs), off-browser time-chunking (5-min windows).        |
| Browser sessions    | **Not present.** No session boundaries. Bundles accumulate indefinitely until drained.                             | **Explicit session lifecycle.** 10-min idle timeout, 2-hour max duration, system idle/lock detection. Session end triggers grouping pipeline (preprocess → graph → Louvain community detection) → POST to server. |
| Dwell time          | **Not tracked.** Bundles have `startedAt`/`endedAt` but no explicit dwell time on transitions.                     | **Explicit `dwellMs` on every transition edge.** `ts - this.lastActivateTs` = time spent on previous tab before switching.                                                                                        |
| Edge weights        | Increment by 1 for each transition. No preprocessing.                                                              | Raw count, but off-browser edges get 2x weight boost during preprocessing.                                                                                                                                        |

---

## 10. Event Types Comparison

| Event                       | be-v1                                                  | browser-extension                                                     |
| --------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| Tab created                 | Signal → queued if no source                           | Event → emitted immediately                                           |
| Tab closed                  | Signal → cleans up tabSources/pendingSignals           | Event → cleans up frame/tab state                                     |
| Tab moved/detached/attached | Dev log only, no aggregator involvement                | Not detailed                                                          |
| Navigation completed        | Signal → `graph.recordUrl()` if source known           | Event → metadata update                                               |
| SPA navigation              | Signal → `graph.recordUrl()` if source known           | Frame change → full transition                                        |
| Tab activated               | Synchronous `onTabActivated()` + async signal          | Synchronous Phase 1 (deactivate) + Phase 2 (activate, possibly async) |
| Window focus changed        | Synchronous `onWindowFocusChanged()` + async signal    | Synchronous Phase 1 (deactivate) + Phase 2 (timer or activate)        |
| Page visibility             | Content script → `chrome.runtime.sendMessage` → signal | Content script → `chrome.runtime.sendMessage` → event                 |
| Downloads                   | Signal with tabId `"unknown"` — black-holed            | Not detailed                                                          |
| Media/audio                 | Signal from `tabs.onUpdated`                           | Not detailed                                                          |
| System idle                 | Dev log only                                           | `attention.idle` event → can trigger session end                      |
| Window resize               | Dev log only                                           | Debounced (500ms) event                                               |

---

## 11. Race Conditions — Coverage Comparison

| Race Condition                                | be-v1                                                                             | browser-extension                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Tab activated before content script connects  | Defers edge until first capture. Gap in tracking.                                 | Async fallback to `chrome.tabs.get()`. Transition recorded immediately (possibly with empty metadata). |
| Window-to-window switch (rapid NONE → window) | 200ms timer ✓                                                                     | 200ms timer ✓                                                                                          |
| Events during startup                         | No protection. Listeners registered synchronously but state may be incomplete.    | Ready gate with pending queue ✓                                                                        |
| Service worker restart                        | Complete state loss. Only `activeTabPerWindow` is re-seeded from current windows. | Full recovery from `chrome.storage.session` ✓                                                          |
| SPA intermediate URLs                         | Not handled. Star patterns can form.                                              | Transient context suppression ✓                                                                        |
| bfcache restoration                           | Handled via `pageshow` listener in `visibility.ts` ✓                              | Handled via `pageshow` listener ✓                                                                      |
| Spurious onTabActivated during focus loss     | `if (offBrowserTimer !== null) return` guard ✓                                    | Three guards on deactivation (existence, self-switch, focused window) ✓                                |
| DevTools window focus                         | Treated as off-browser (starts 200ms timer). Creates spurious off-browser edges.  | Detected as no-tab window. No transition, no off-browser timer. ✓                                      |
| Downloads with unknown tabId                  | Black-holed in pendingSignals forever. Memory leak.                               | Not mentioned, likely handled differently.                                                             |
| Content script flush failure                  | Not mentioned. Port disconnect tears down pipeline.                               | Re-prepend to buffer with max cap ✓                                                                    |

---

## 12. Constants Comparison

| Constant                        | be-v1         | browser-extension         |
| ------------------------------- | ------------- | ------------------------- |
| Off-browser settle              | 200ms         | 200ms                     |
| Keystroke batch idle            | 1000ms        | —                         |
| Scroll debounce                 | 150ms         | —                         |
| Selection debounce              | 300ms         | —                         |
| Form focus dedup                | 2000ms        | —                         |
| Event buffer flush              | —             | 1000ms                    |
| Persist debounce                | —             | 2000ms                    |
| Aggregator flush                | —             | 5000ms                    |
| Browser idle timeout            | —             | 600000ms (10min)          |
| Max browser session             | —             | 7200000ms (2h)            |
| System idle detection           | —             | 60s                       |
| Window bounds debounce          | —             | 500ms                     |
| Transient dwell threshold       | —             | 500ms                     |
| Transient chain threshold       | —             | 1000ms                    |
| Hub threshold                   | —             | 10% of tabs (min 15 tabs) |
| Off-browser edge weight         | 1 (no boost)  | 2x boost                  |
| Off-browser chunk window        | —             | 5 minutes                 |
| Dev log buffer (service worker) | 10000 entries | —                         |
| Dev log buffer (React)          | 500 entries   | —                         |

---

## Summary

**be-v1** is a simpler, more tightly coupled system focused on real-time capture and visualization. It lacks persistence, preprocessing, sub-tab tracking, and session lifecycle management. Its main strengths are the composable content-script pipeline and the force-directed graph visualization.

**browser-extension** is a more mature system with proper separation of concerns (TransitionTracker, FrameManager, Aggregator as distinct modules), persistence across service worker restarts, explicit deactivation events, sub-tab frame tracking, transient context suppression, graph preprocessing (hub/transient removal, time-chunking), and full session lifecycle management with server sync.

The 200ms off-browser settle timer is the one mechanism that is essentially identical between both systems, though they differ in the details (be-v1 seals the bundle immediately; browser-extension deactivates the tab immediately).
