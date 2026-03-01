# Strategy Diff: browser-extension (off_browser.md) vs be-v1 (tab-nav.md)

Side-by-side comparison of how each system handles tab transitions, off-browser detection, and graph construction.

---

## 1. Who Owns the Transition Graph?

|                              | browser-extension                                                                                                              | be-v1                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**                    | `TransitionTracker` — standalone class                                                                                         | `bundler` + `graph` — two coupled closures                                                                                                          |
| **Where edges are recorded** | `transitionTracker.recordSwitch()` called directly from `onActivated`, `onFocusChanged`, and frame handlers                    | `graph.recordEdge()` called from inside `bundler.transition()`                                                                                      |
| **Coupling**                 | Transition recording is decoupled from event accumulation. TransitionTracker doesn't know about bundles, captures, or signals. | Tightly coupled — the bundler seals bundles AND records edges in the same `transition()` call. Edge recording is a side effect of bundle lifecycle. |
| **Self-loop guard**          | `this.lastActiveTabId !== newTabId` inside `recordSwitch()` — the tracker owns its own guard                                   | `from && from !== to` inside `bundler.transition()` — the bundler owns the guard                                                                    |
| **Dwell time**               | `dwellMs = ts - this.lastActivateTs` — explicit, stored per edge                                                               | Not tracked. Edges only have `weight` (increment count).                                                                                            |

**Impact:** In browser-extension, `recordSwitch()` is called at exactly the right moments from exactly the right callers. In be-v1, edge recording is an indirect consequence of bundle operations — any place that calls `bundler.transition()` implicitly records an edge, and the only places that record edges are through `bundler.transition()`. This means be-v1 cannot record an edge without also sealing/opening bundles, and cannot seal/open bundles without potentially recording an edge.

---

## 2. Deactivation of the Previous Tab

|                            | browser-extension                                                                                                                                              | be-v1                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **On tab switch**          | Emits `attention.active: false` for the previous tab **synchronously, before anything else**. Three guards: prev exists, prev !== new, window is focused.      | No deactivation signal. Calls `bundler.transition(source)` which seals the old bundle. No event is emitted for the old tab. |
| **On window focus change** | Emits `attention.active: false` for the previous window's tab **synchronously, before anything else**. Always fires, even when focus goes to `WINDOW_ID_NONE`. | No deactivation signal. Calls `bundler.seal()` (immediate) then starts 200ms timer for `bundler.transition(OFF_BROWSER)`.   |
| **On frame change**        | Emits `attention.active: false` for the old frame nodeId, THEN updates frame state, THEN emits `attention.active: true` for the new nodeId.                    | No frame concept.                                                                                                           |

**Impact:** browser-extension guarantees a strict event ordering: `active:false(old)` always precedes `active:true(new)` in the event stream. be-v1 has no such guarantee — there is no explicit deactivation event. The bundler's `seal()` is the closest equivalent, but it doesn't emit anything observable downstream; it just closes the bundle internally.

---

## 3. Two Signals vs One

|                   | browser-extension                                                                                                                                    | be-v1                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`visible`**     | Content script Page Visibility API. Multiple tabs can be visible across monitors. Does NOT change on OS focus loss (only on tab switch or minimize). | Content script Page Visibility API (`src/event/visibility.ts`). Ingested as `attention.visible` signal into the open bundle.                                                                                      |
| **`active`**      | Background-computed. Exactly one tab at a time. Requires OS focus + selected tab in focused window.                                                  | No equivalent. The bundler's `activeSource` is the closest analog, but it's a source string, not a boolean per-tab flag.                                                                                          |
| **Independence**  | Tracked as two separate booleans per tab in `TabState`. A tab can be visible but not active (e.g., foreground tab in unfocused window).              | Conflated. `attention.visible` from the content script and `onTabActivated`/`onWindowFocusChanged` from the background both feed into the same bundler, but there's no per-tab state tracking their independence. |
| **Per-tab state** | `tabStates: Map<number, TabState>` — stores `{ url, title, visible, active }` for every known tab.                                                   | No per-tab state map. `tabSources: Map<tabId, source>` only maps tabId to source string.                                                                                                                          |

**Impact:** browser-extension can answer "is tab X active?" and "is tab X visible?" independently at any moment. be-v1 can only answer "what is the current `activeSource`?" — it doesn't know about individual tabs' visibility or activity states.

---

## 4. Transition Recording Callsites

### browser-extension — `transitionTracker.recordSwitch()` is called from:

| Callsite                                               | Trigger                                  | Records edge?                                            |
| ------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------- |
| `onActivated` handler                                  | Tab switch (sync path or async fallback) | Yes — `prevTab → newTab`                                 |
| `onFocusChanged` handler (WINDOW_ID_NONE, after 200ms) | Alt-tab away                             | Yes — `lastTab → off-browser`                            |
| `onFocusChanged` handler (real window)                 | Focus returns or window switch           | Yes — `off-browser → newTab` (or `prevTab → newTab`)     |
| Frame change handler (`FRAME_CHANGED` message)         | Virtual sub-tab navigation               | Yes — `oldFrame → newFrame`                              |
| Aggregator virtual context change                      | SPA within-tab navigation                | Yes — `contextA → contextB` (with transient suppression) |

### be-v1 — `graph.recordEdge()` is called from:

| Callsite                                                               | Trigger                                           | Records edge?                      |
| ---------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| `bundler.transition()` (called by `bundler.ingest()`)                  | First capture from a new source, or source change | Yes — `activeSource → newSource`   |
| `bundler.transition()` (called by `aggregator.onTabActivated()`)       | Tab switch with known source                      | Yes — `activeSource → source`      |
| `bundler.transition()` (called by `aggregator.onWindowFocusChanged()`) | Focus returns to window with known source         | Yes — `activeSource → source`      |
| `bundler.transition()` (called by 200ms timer)                         | Off-browser settle                                | Yes — `activeSource → OFF_BROWSER` |

**Key difference:** browser-extension calls `recordSwitch` at 5 distinct points, each representing a real user action. be-v1 funnels everything through `bundler.transition()`, which means edge recording is always coupled with bundle seal/open operations.

---

## 5. Off-Browser Timer Mechanics

|                                                 | browser-extension                                                                         | be-v1                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Timer start**                                 | Only on `onFocusChanged(WINDOW_ID_NONE)`                                                  | On `onFocusChanged(WINDOW_ID_NONE)` AND on `onFocusChanged(realWindow)` when no source is found (DevTools, chrome:// pages) |
| **What happens immediately**                    | Emit `active:false` for previous tab. Set `focusedWindowId = null`. Update all tab flags. | `bundler.seal()` — close the current bundle immediately.                                                                    |
| **What the timer does**                         | `transitionTracker.recordSwitch(OFF_BROWSER, ts)` — records a single transition           | `bundler.transition(OFF_BROWSER)` — seals (no-op, already sealed), records edge, sets activeSource                          |
| **Timer cancel**                                | `clearTimeout` when `focusedWindowId !== null` (any real window gains focus)              | `clearTimeout` when a real window gains focus with known source                                                             |
| **Spurious `onTabActivated` during focus loss** | Not explicitly guarded — but deactivation already emitted, so the event ordering is safe  | Guarded: `if (offBrowserTimer !== null) return` — skips the handler entirely except for `activeTabPerWindow` update         |

### The seal-before-timer problem in be-v1

be-v1 calls `bundler.seal()` **immediately** in `startOffBrowserTimer()`, before the 200ms timer. This creates a gap:

```
t=0ms:   seal() closes bundle, openBundle = null
t=0-200: captures that arrive are pushed into... nothing?
         bundler.ingest() would trigger transition() because
         source !== activeSource (if it's a new source) or
         openNew() (if same source but no open bundle)
t=200ms: transition(OFF_BROWSER) fires
```

browser-extension does NOT seal immediately. It emits `active:false` (which is just an event, not a bundle operation) and defers the transition recording to the timer. The per-tab event accumulation (session accumulator) continues independently.

---

## 6. DevTools Window Handling

|                    | browser-extension                                                                                                                                                                                                             | be-v1                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Detection**      | `activeTabPerWindow.get(devToolsWindowId)` returns `undefined` (DevTools windows don't have normal tabs). No activation event emitted, no transition recorded. `focusedWindowId` is set to the DevTools window ID (not null). | `tabSources.get(tabId)` returns undefined. Falls through to `startOffBrowserTimer()` — treated identically to losing focus entirely. |
| **Timer behavior** | Timer does NOT start. `focusedWindowId !== null`, so the off-browser path is not entered.                                                                                                                                     | Timer DOES start. DevTools focus = 200ms of "limbo" before `OFF_BROWSER` transition.                                                 |
| **Graph impact**   | No off-browser node when DevTools is focused.                                                                                                                                                                                 | Off-browser node may appear just from opening DevTools.                                                                              |

**Impact:** In browser-extension, focusing DevTools is a neutral event — no graph edges created. In be-v1, focusing DevTools creates the same graph signature as alt-tabbing away from Chrome.

---

## 7. Source Identity and Resolution

|                          | browser-extension                                                                                                                                            | be-v1                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tab identity**         | `toTabId(chromeId)` → string. `TabState` map stores url/title/visible/active.                                                                                | `String(tabId)`. `tabSources` map stores only `tabId → source` string.                                                                      |
| **Source format**        | Same: `"root@<tabId>"` for regular tabs. Plus `"frame:<tabId>:<frameKey>"` for virtual sub-tabs.                                                             | Same: `"<context>@<tabId>"`. No frame concept.                                                                                              |
| **When source is known** | `tabStates` populated by content script `PAGE_VISIBILITY_CHANGED` messages AND `chrome.tabs.get()` async fallback in `onActivated`.                          | `tabSources` populated only when first capture arrives from content script.                                                                 |
| **Unknown tab handling** | Async fallback: `chrome.tabs.get(chromeTabId)` in `onActivated` when `tabStates` doesn't have the tab. Transition is still recorded (with minimal metadata). | Signal buffering: signals queued in `pendingSignals` until first capture. No transition until capture arrives.                              |
| **Graph node creation**  | A transition is recorded the moment the user switches to a tab, even if no content script has connected. The tab's metadata may be sparse.                   | A transition is delayed until the first capture arrives from the content script. The user could be on a tab for seconds with no graph edge. |

**Impact:** browser-extension creates transition edges eagerly (immediately on tab switch). be-v1 creates them lazily (only when the content script delivers a capture). This means be-v1's graph has temporal gaps that browser-extension's does not.

---

## 8. Persistence and Service Worker Restarts

|                            | browser-extension                                                                | be-v1                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transition persistence** | `chrome.storage.session` with 2s debounce. Full graph survives SW restart.       | None. All state lost on SW restart.                                                                                                                     |
| **Tab state persistence**  | `tabStates` rebuilt from `chrome.tabs.query()` on startup.                       | `activeTabPerWindow` seeded from `chrome.windows.getAll()` + `chrome.tabs.query()` on startup. `tabSources` is empty — requires captures to repopulate. |
| **Ready gate**             | `emit()` buffers events in `pendingEvents[]` until `startAggregator()` resolves. | No ready gate. `createAggregator()` is synchronous. Chrome listeners registered immediately.                                                            |

---

## 9. Event Accumulation Model

|                                 | browser-extension                                                                                              | be-v1                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Accumulator**                 | Session accumulator — pushes events into per-tab session streams. Independent of transition tracking.          | Bundler — accumulates captures into bundles. Bundles are opened/sealed by transition operations. |
| **Relationship to transitions** | Decoupled. Events flow into the accumulator regardless of transitions. TransitionTracker operates in parallel. | Coupled. Transitions trigger bundle operations (seal → open). Edge recording is a side effect.   |
| **Signal drops**                | Events are never dropped (accumulator always has a session open).                                              | Signals dropped when `openBundle === null` (during OFF_BROWSER, after seal before transition).   |

---

## 10. Preprocessing / Downstream

|                                   | browser-extension                                                                                                                                 | be-v1                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Off-browser in graph**          | Time-chunked into 5-min windows (`hub:off-browser:0`, `hub:off-browser:1`, etc.) with 2x edge weight boost.                                       | Packer handles off-browser with ephemeral node splitting (`off_browser:<n>`), but no time-chunking or weight boosting. |
| **Transient access removal**      | Tabs with dwell < 500ms removed. Chain detection for rapid switches (all < 1s).                                                                   | No equivalent. All transitions kept regardless of dwell time.                                                          |
| **Hub detection**                 | Nodes connected to >10% of unique tabs (when >15 tabs) removed from community detection.                                                          | Hub detection in packer uses degree-based heuristics, different thresholds.                                            |
| **Transient context suppression** | SPA navigation through intermediate URLs (e.g., Outlook inbox) doesn't create transitions. `lastSourcePerTab` not updated for transient contexts. | No equivalent. All context changes create transitions.                                                                 |

---

## Summary: Root Causes of be-v1's Broken Transitions

1. **No synchronous deactivation.** browser-extension always emits `active:false` for the previous tab before any other work. be-v1 just seals the bundle — there's no explicit "this tab is no longer active" event.

2. **Edge recording coupled to bundle operations.** be-v1 can't record a transition edge without also sealing and opening bundles. browser-extension records edges independently via `TransitionTracker`.

3. **Eager seal creates signal-drop windows.** be-v1's `startOffBrowserTimer()` seals the bundle immediately, creating a period where `openBundle === null` and incoming signals are silently dropped.

4. **Lazy source resolution.** be-v1 doesn't know a tab's source until its first capture arrives. browser-extension has an async fallback (`chrome.tabs.get()`) that records transitions immediately even for unknown tabs.

5. **DevTools treated as off-browser.** be-v1 starts the off-browser timer when focusing DevTools. browser-extension recognizes that DevTools windows are neutral (no transition, no timer).

6. **No per-tab state tracking.** be-v1 has no `TabState` map. It can't independently track visible vs active, and can't reason about individual tabs' states.

7. **No dwell time.** be-v1's edges only have weight (count). browser-extension records `dwellMs` per transition, enabling downstream filtering of transient accesses.

8. **No persistence.** be-v1 loses all graph state on service worker restart. browser-extension persists to `chrome.storage.session`.
