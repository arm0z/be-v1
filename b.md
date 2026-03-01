# Why This Log Produces Zero Graph Nodes

## The Log

```
[aggregator] 20:33:35 state.snapshot – state
[tap] 20:33:35 attention.visible – browser gained focus
[aggregator] 20:33:35 attention.visible – root@607215432
[aggregator] 20:33:35 state.snapshot – state
[aggregator] 20:33:38 state.snapshot – state
[tap] 20:33:38 attention.visible – browser lost focus
[aggregator] 20:33:38 attention.visible – pending
[tap] 20:33:38 attention.visible – page became visible
[tap] 20:33:38 attention.visible – page became visible
[aggregator] 20:33:38 attention.visible – root@607215433
[aggregator] 20:33:38 state.snapshot – state
[tap] 20:33:38 attention.visible – page became hidden
[tap] 20:33:38 attention.visible – page became hidden
[aggregator] 20:33:38 attention.visible – root@607215432
[aggregator] 20:33:38 state.snapshot – state
[tap] 20:33:38 attention.active – tab activated
[aggregator] 20:33:38 attention.active – root@607215433
[aggregator] 20:33:38 state.snapshot – state
[aggregator] 20:33:39 state.snapshot – state
[aggregator] 20:33:41 state.snapshot – state
[tap] 20:33:41 attention.visible – browser gained focus
[aggregator] 20:33:41 attention.visible – pending
[aggregator] 20:33:41 state.snapshot – state
```

## What the user did

1. **20:33:35** — Browser window gained OS focus. Tab 607215432 was already active.
2. **20:33:38** — User Alt-Tabbed away. Chrome fired `onFocusChanged(WINDOW_ID_NONE)`. Simultaneously, the user's tab switch from 607215432 → 607215433 fired visibility changes and `onTabActivated`.
3. **20:33:41** — User returned to the browser.

The expected graph result: an edge `root@607215432 → root@607215433` (a tab switch). Actual result: **zero edges, zero nodes.**

---

## Why: three independent failures compound

### Failure 1 — Every event in this log is a signal, not a capture

The log contains only two event types reaching the aggregator:
- `attention.visible` (page visibility / window focus)
- `attention.active` (tab activation metadata)

Both are **signals**. They flow through `aggregator.ingestSignal()` → `bundler.ingestSignal()`:

```typescript
// bundler.ts
function ingestSignal(stamped: StampedSignal): void {
    if (!openBundle) return;           // dropped silently
    openBundle.captures.push(stamped); // appended passively
}
```

Signals are passive observers. They get appended to an open bundle or silently dropped. They **never** call `bundler.transition()`. They **never** call `graph.recordEdge()`. No matter how many `attention.visible` or `attention.active` signals arrive, the graph is untouched.

Graph edges can only be created by:
| Caller | When |
|---|---|
| `bundler.ingest()` | A DOM capture arrives from a content script and `stamped.source !== activeSource` |
| `aggregator.onTabActivated()` | `chrome.tabs.onActivated` fires AND `tabSources` has the tab AND the off-browser timer is not running |
| `aggregator.onWindowFocusChanged()` | `chrome.windows.onFocusChanged` fires with a real window AND the active tab has a known source |
| Off-browser timer callback | 200ms after `startOffBrowserTimer()`, calls `bundler.transition(OFF_BROWSER)` |

This log has zero DOM captures (no clicks, keystrokes, scrolls). So `bundler.ingest()` never fires. That leaves only `onTabActivated`, `onWindowFocusChanged`, and the off-browser timer.

### Failure 2 — `onTabActivated` is blocked by the off-browser timer guard

At 20:33:38, two Chrome events fire within the same millisecond:

1. `chrome.windows.onFocusChanged(WINDOW_ID_NONE)` — browser lost OS focus
2. `chrome.tabs.onActivated({ tabId: 607215433 })` — tab switch happened

Chrome processes `onFocusChanged` first. This calls `startOffBrowserTimer()`:

```typescript
function startOffBrowserTimer(): void {
    cancelOffBrowser();
    bundler.seal();              // seals bundle for root@607215432
    offBrowserTimer = setTimeout(() => {
        offBrowserTimer = null;
        bundler.transition(OFF_BROWSER);
        emitState();
    }, 200);                     // fires at ~20:33:38.200
}
```

Then `onTabActivated` runs:

```typescript
function onTabActivated(tabId: string, windowId: number): void {
    activeTabPerWindow.set(windowId, tabId);  // "607215433" stored
    if (offBrowserTimer !== null) return;      // ← BLOCKED. Timer is running.
    // ... transition code never reached ...
}
```

The guard `offBrowserTimer !== null` returns early. The tab switch from 607215432 → 607215433 is **silently discarded**. No `bundler.transition("root@607215433")` is called. No edge `root@607215432 → root@607215433` is recorded.

This is **Issue 9** from the issues analysis: the off-browser timer guard blocks legitimate tab switches that happen during any pending off-browser timer.

### Failure 3 — The off-browser timer fires into a dead state, and focus return also fails

The 200ms timer fires at ~20:33:38.200:

```typescript
bundler.transition(OFF_BROWSER);
// → seal()           — noop, already sealed
// → from = activeSource = "root@607215432"
// → from !== OFF_BROWSER → graph.recordEdge("root@607215432", "off_browser")
// → activeSource = OFF_BROWSER
// → to === OFF_BROWSER → no new bundle
```

This **does** create one edge: `root@607215432 → off_browser`. But it represents the wrong thing — the user switched tabs, not left the browser. The `state.snapshot` at 20:33:39 is likely emitted by this timer callback.

At 20:33:41, the browser regains focus. `onWindowFocusChanged(windowId)` runs:

```typescript
cancelOffBrowser();  // noop — timer already fired
const tabId = activeTabPerWindow.get(windowId);  // → "607215433"
const source = tabSources.get("607215433");       // → "root@607215433"
if (source) {
    bundler.transition(source);
    // → from = "off_browser", to = "root@607215433"
    // → graph.recordEdge("off_browser", "root@607215433")
}
```

This creates a second edge: `off_browser → root@607215433`.

**So the off-browser timer and focus return do create edges**, but only `off_browser` round-trip edges. The direct tab-to-tab edge `root@607215432 → root@607215433` is never created.

### Why the `[aggregator] attention.visible – pending` entries confirm the problem

Both "pending" entries (at 20:33:38 and 20:33:41) come from the `onFocusChanged` handler in `main.ts`:

```typescript
if (windowId === chrome.windows.WINDOW_ID_NONE) {
    aggregator.ingestSignal(
        { type: "attention.visible", payload: { visible: false } },
        "unknown",  // hardcoded tabId
    );
}
```

Inside `ingestSignal()`:
1. `tabSources.get("unknown")` → `undefined`
2. Signal queued in `pendingSignals.get("unknown")` → **forever** (no capture will ever arrive from tabId "unknown")
3. This is **Issue 6**: `attention.visible` on focus loss is black-holed, and the queue grows without bound.

The "pending" at 20:33:41 is less clear — it could be from a content script message where the tab doesn't have a source yet, or from another `WINDOW_ID_NONE` event. Either way, the signal is lost.

---

## Summary: the event flow and what each event does to the graph

| Time | Event | Graph impact |
|---|---|---|
| 20:33:35 | `attention.visible` signal (focus gain) for root@607215432 | **None.** Signal path, no `transition()`. |
| 20:33:38 | `onFocusChanged(NONE)` → `startOffBrowserTimer()` | **None yet.** `seal()` closes the bundle. 200ms timer starts. |
| 20:33:38 | `attention.visible` signal (focus loss) with tabId "unknown" | **None.** Queued in `pendingSignals["unknown"]` forever (Issue 6). |
| 20:33:38 | `onTabActivated(607215433)` | **None.** Blocked by `offBrowserTimer !== null` guard (Issue 9). |
| 20:33:38 | `attention.visible` signals (page visible/hidden) for both tabs | **None.** Signal path only. |
| 20:33:38 | `attention.active` signal for root@607215433 | **None.** Signal path. Appended to open bundle or dropped. |
| ~20:33:38.2 | Off-browser timer fires → `transition(OFF_BROWSER)` | Edge: `root@607215432 → off_browser`. **Wrong topology** — user switched tabs, not left browser. |
| 20:33:41 | `onFocusChanged(windowId)` → `transition("root@607215433")` | Edge: `off_browser → root@607215433`. **Wrong topology** — returning to a tab the user was already on. |
| 20:33:41 | `attention.visible` signal (focus gain) | **None.** Signal queued as "pending" or appended to bundle. |

**Net result:** The graph shows `root@607215432 → off_browser → root@607215433` instead of the direct `root@607215432 → root@607215433`. The tab-to-tab transition edge is never created. The only nodes that appear are spurious off-browser intermediaries.

If the user is checking for direct tab-to-tab edges (which is what "tab-nav" graph nodes means), the count is **zero**.

---

## Root causes (from issues analysis)

| Issue | Role in this failure |
|---|---|
| **Issue 9** (off-browser timer guard blocks legitimate tab switches) | Primary cause. The `onTabActivated` guard fires for ANY pending timer, not just legitimate off-browser timers. |
| **Issue 2** (activeSource = double duty as bundle state + graph cursor) | After `seal()` in `startOffBrowserTimer()`, `activeSource` still points at `root@607215432`, so the off-browser timer records the wrong `from` node. |
| **Issue 6** (attention.visible black-holed for "unknown" tabId) | The focus-loss visibility signal is lost. Minor in this scenario but contributes to state blindness. |
| **Issue 4** (eager seal creates signal-drop window) | Between `seal()` at 20:33:38.0 and the timer at 20:33:38.2, all signals are dropped because `openBundle` is null. |

## What the browser-extension does differently

In the browser-extension codebase, this exact scenario works correctly because:

1. **Tab deactivation/activation are explicit events**, not side effects of `bundler.transition()`. The `TransitionTracker` records `root@607215432 → root@607215433` directly.
2. **The off-browser timer only starts on `WINDOW_ID_NONE`**, and `onActivated` is not gated by it. Tab switches proceed normally regardless of focus state.
3. **Visibility events are real events in the unified pipeline**, not silently-droppable signals. They flow through the same `emit()` → `routeEvent()` path as everything else.
