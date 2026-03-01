# How the Browser Extension Handles Transitions

Deep dive into how `../browser-extension` tracks tab transitions and off-browser detection. This documents the exact mechanisms, race condition handling, and event flows.

---

## Architecture

The system spans two execution contexts:

1. **Content scripts** (per-tab, in-page): `visibility.ts`, `event-buffer.ts` — report page-level signals upward via `chrome.runtime.sendMessage`.
2. **Background service worker**: `capture.ts`, `transition-tracker.ts`, `aggregator.ts`, `frame.ts` — maintain the authoritative state model, emit events, and build the transition graph.

---

## 1. Two Independent Signals: `visible` vs `active`

**File:** `src/lib/capture.ts`

```typescript
interface TabState {
    url: string;
    title: string;
    visible: boolean;   // Signal 1: page rendered on screen
    active: boolean;     // Signal 2: selected tab in OS-focused window
}

const tabStates = new Map<number, TabState>();
```

### Signal 1: `visible` (content script, per-tab rendering state)

**File:** `src/content/visibility.ts`

- Uses the **Page Visibility API** (`document.visibilityState`).
- `"visible"` means the tab is the foreground tab in a non-minimized window, **even if that window does not have OS-level focus**.
- Multiple tabs can be `visible: true` simultaneously across monitors.
- Deduplication via `lastVisibilityState` — only sends when state actually changes.
- Handles **bfcache restoration** via `pageshow` with `e.persisted`, resetting dedup state to force a re-send.
- Reports initial state on content script load.

```typescript
let lastVisibilityState: boolean | null = null;

function sendVisibilityUpdate(isVisible: boolean) {
    if (lastVisibilityState === isVisible) return;  // dedup
    lastVisibilityState = isVisible;
    chrome.runtime.sendMessage({
        type: "PAGE_VISIBILITY_CHANGED",
        visible: isVisible,
        url: window.location.href,
        title: document.title,
    }).catch(() => {});
}

document.addEventListener("visibilitychange", () => {
    sendVisibilityUpdate(document.visibilityState === "visible");
});

window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
        lastVisibilityState = null;  // force re-send after bfcache
        sendVisibilityUpdate(document.visibilityState === "visible");
    }
});
```

### Signal 2: `active` (background, OS-focused window's selected tab)

Computed from two pieces of state — strictly **singular** (at most one tab in the entire browser):

```typescript
let focusedWindowId: number | null = null;
const activeTabPerWindow = new Map<number, number>();  // windowId -> chromeTabId

function updateActiveFlags() {
    const activeTabId =
        focusedWindowId !== null
            ? (activeTabPerWindow.get(focusedWindowId) ?? null)
            : null;

    for (const [tabId, state] of tabStates.entries()) {
        state.active = tabId === activeTabId;
    }
}
```

Requires both: (a) the window being OS-focused AND (b) the tab being the selected tab in that window.

---

## 2. `onActivated` — Always Deactivates Previous Tab Synchronously

**File:** `src/lib/capture.ts`

This is the most critical design property. When Chrome fires `tabs.onActivated`, the handler **always** emits `attention.active: false` for the previous tab **before** doing anything else, in the same synchronous microtask.

```typescript
chrome.tabs.onActivated.addListener(({ tabId: chromeTabId, windowId }) => {
    const ts = Date.now();
    const tabId = toTabId(chromeTabId);
    const nodeId = frameManager.resolveSource(tabId);

    // === PHASE 1: Deactivate previous tab (SYNCHRONOUS) ===
    const prevActiveChromeId = activeTabPerWindow.get(windowId);
    if (
        prevActiveChromeId !== undefined &&
        prevActiveChromeId !== chromeTabId &&    // not a self-switch
        windowId === focusedWindowId              // only in the focused window
    ) {
        const prevTabId = toTabId(prevActiveChromeId);
        const prevState = tabStates.get(prevActiveChromeId);
        emit({
            ts,
            tabId: prevTabId,
            windowId,
            context: "root",
            source: `root@${prevTabId}`,
            type: "attention.active",
            payload: {
                active: false,
                url: prevState?.url ?? "",
                title: prevState?.title ?? "",
            },
        });
    }

    activeTabPerWindow.set(windowId, chromeTabId);
    updateActiveFlags();

    // === PHASE 2: Activate new tab (sync or async) ===
    const newState = tabStates.get(chromeTabId);
    if (newState?.url) {
        // Sync path — tabStates already has this tab
        transitionTracker.recordSwitch(sourceNode(tabId, nodeId), ts, {
            url: newState.url, title: newState.title, ...
        });
        emit({ /* attention.active: true for new tab */ });
    } else {
        // Async fallback — tabStates doesn't have this tab yet
        chrome.tabs.get(chromeTabId).then((tab) => {
            transitionTracker.recordSwitch(sourceNode(tabId, nodeId), ts, { ... });
            emit({ /* attention.active: true */ });
        }).catch(() => {
            transitionTracker.recordSwitch(sourceNode(tabId, nodeId), ts);
            emit({ /* attention.active: true, url/title empty */ });
        });
    }
});
```

### Three guards on deactivation

1. `prevActiveChromeId !== undefined` — a tab must have been previously active in this window.
2. `prevActiveChromeId !== chromeTabId` — not a self-switch (same tab re-activated).
3. `windowId === focusedWindowId` — only emit deactivation for the focused window (avoids phantom deactivation from background windows).

### Async fallback

The timestamp `ts` is captured at the top and passed through. Even if `chrome.tabs.get()` resolves later, the recorded timestamp is accurate. This handles the race where `onActivated` fires before the content script has sent `PAGE_VISIBILITY_CHANGED`.

---

## 3. `onFocusChanged` and the 200ms Settle Timer

**File:** `src/lib/capture.ts`

```typescript
const OFF_BROWSER_SETTLE_MS = 200;
let offBrowserTimer: ReturnType<typeof setTimeout> | null = null;

chrome.windows.onFocusChanged.addListener((windowId) => {
    const ts = Date.now();

    // === PHASE 1: Always deactivate previous window's tab (SYNCHRONOUS) ===
    if (focusedWindowId !== null) {
        const prevChromeTabId = activeTabPerWindow.get(focusedWindowId);
        if (prevChromeTabId !== undefined) {
            const prevTabId = toTabId(prevChromeTabId);
            const prevState = tabStates.get(prevChromeTabId);
            emit({
                ts,
                tabId: prevTabId,
                windowId: focusedWindowId,
                type: "attention.active",
                payload: { active: false, url: prevState?.url ?? "", ... },
            });
        }
    }

    focusedWindowId = windowId === chrome.windows.WINDOW_ID_NONE ? null : windowId;
    updateActiveFlags();

    // === PHASE 2: Handle the new focus target ===
    if (focusedWindowId === null) {
        // User left the browser — defer off-browser transition
        offBrowserTimer = setTimeout(() => {
            offBrowserTimer = null;
            transitionTracker.recordSwitch(OFF_BROWSER, ts, {
                title: "Off Browser",
            });
        }, OFF_BROWSER_SETTLE_MS);
    }

    if (focusedWindowId !== null) {
        // Cancel pending off-browser — focus returned to the browser
        if (offBrowserTimer !== null) {
            clearTimeout(offBrowserTimer);
            offBrowserTimer = null;
        }
        // Activate new window's tab, record transition...
    }
});
```

### Why 200ms?

When switching between Chrome windows (window A → window B), Chrome fires two events in rapid succession:

1. `onFocusChanged(WINDOW_ID_NONE)` — focus leaving window A
2. `onFocusChanged(windowB)` — focus arriving at window B

Without the settle timer, event 1 would record an `OFF_BROWSER` node, creating a spurious `tabA → off-browser → tabB` chain. The 200ms delay means if `WINDOW_ID_NONE` is followed by a real window within 200ms, the off-browser transition is cancelled and never recorded. The graph shows a clean `tabA → tabB` instead.

### Deactivation is always immediate

Phase 1 always runs synchronously, regardless of whether focus went to another window or left the browser. The off-browser timer only affects whether a transition edge to `OFF_BROWSER` is recorded — the deactivation of the previous tab is never deferred.

---

## 4. `TransitionTracker.recordSwitch()` — Self-Loop Guards, Dwell Time, Persistence

**File:** `src/lib/transition-tracker.ts`

```typescript
recordSwitch(
    newTabId: string,
    ts: number,
    tabInfo?: { url?: string; title?: string; parentTabId?: string; ... },
) {
    // Always update metadata for the new tab
    if (!this.tabMeta.has(newTabId)) {
        this.tabMeta.set(newTabId, {
            tabId: newTabId,
            domain: tabInfo?.url ? domainFromUrl(tabInfo.url) : undefined,
            url: tabInfo?.url,
            title: tabInfo?.title,
            firstSeenTs: ts,
            ...
        });
    } else {
        const meta = this.tabMeta.get(newTabId)!;
        if (tabInfo?.url) {
            meta.url = tabInfo.url;
            meta.domain = domainFromUrl(tabInfo.url);
        }
        if (tabInfo?.title) meta.title = tabInfo.title;
    }

    // Record the transition — with self-loop guard
    if (
        this.lastActiveTabId !== null &&
        this.lastActiveTabId !== newTabId &&    // SELF-LOOP GUARD
        this.lastActivateTs !== null
    ) {
        const dwellMs = ts - this.lastActivateTs;
        const transition: TabTransition = {
            from: this.lastActiveTabId,
            to: newTabId,
            ts,
            dwellMs,
        };

        this.transitions.push(transition);
        this.broadcastTransition(transition);
        this.debouncePersist();
    }

    this.lastActiveTabId = newTabId;
    this.lastActivateTs = ts;
}
```

### Self-loop guard

`this.lastActiveTabId !== newTabId` — calling `recordSwitch("tab-5")` twice in a row updates metadata but does NOT create a transition edge. Prevents self-edges in the graph.

### Dwell time

`dwellMs = ts - this.lastActivateTs` — the time spent on the **previous** tab before switching. Attached to the transition (the edge), not to a node.

### Metadata handling

- First encounter: creates `TabNodeMeta` with `firstSeenTs`.
- Subsequent: updates `url`, `title`, etc. **Never changes `firstSeenTs`.**

### Persistence

Uses `chrome.storage.session` with a 2-second debounce to survive service worker restarts:

```typescript
private debouncePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), PERSIST_DEBOUNCE_MS);
}

private persist() {
    chrome.storage.session.set({
        [STORAGE_KEY_TRANSITIONS]: this.transitions,
        [STORAGE_KEY_TAB_META]: metaMapToRecord(this.tabMeta),
    });
}
```

On service worker restart, `restore()` reads from `chrome.storage.session` to recover the full transition graph.

### Broadcasting

Every new transition is immediately broadcast to connected DevTools graph inspector ports via `broadcastTransition()`.

### `clear()` method

Resets transitions, tabMeta, `lastActiveTabId`, and `lastActivateTs` to null. After clear, the next `recordSwitch` will NOT produce a transition (since `lastActiveTabId === null`).

---

## 5. FrameManager — Virtual Sub-Tab Sources

**File:** `src/lib/frame.ts`

In SPAs like Outlook Web, a single Chrome tab can contain multiple logical "views" (emails, threads). The FrameManager creates deterministic virtual sub-tab identifiers.

```typescript
export class FrameManager {
    private frameMap = new Map<string, FrameEntry>();    // "tabId:frameKey" -> entry
    private activeFrame = new Map<string, string>();      // tabId -> frameKey

    setActiveFrame(tabId: string, frameKey: string, label?: string): string {
        const mapKey = `${tabId}:${frameKey}`;
        let entry = this.frameMap.get(mapKey);
        if (!entry) {
            const source = `frame:${tabId}:${frameKey}`;
            entry = { tabId, frameKey, frameLabel: label, source };
            this.frameMap.set(mapKey, entry);
        }
        this.activeFrame.set(tabId, frameKey);
        return entry.source;
    }

    resolveSource(tabId: string): string {
        const frameKey = this.activeFrame.get(tabId);
        if (frameKey === undefined) return tabId;  // passthrough
        const entry = this.frameMap.get(`${tabId}:${frameKey}`);
        return entry ? entry.source : tabId;
    }

    static isFrameSource(s: string): boolean {
        return s.startsWith("frame:");
    }
}
```

**Source pattern:** `frame:<tabId>:<frameKey>` — deterministic, debuggable, serialization-safe.

### Frame transitions in `capture.ts`

When a content script sends a `FRAME_CHANGED` message:

1. Emits `attention.active: false` for the OLD nodeId (deactivation with old frame identity).
2. Calls `frameManager.setActiveFrame()` or `clearActiveFrame()`.
3. Records a transition via `transitionTracker.recordSwitch()` to the new frame nodeId.
4. Emits `attention.active: true` for the NEW nodeId.

The deactivation is always emitted BEFORE the frame state is updated, so the event stream correctly reflects the old state.

### Lifecycle

- `clearActiveFrame(tabId)` — removes active frame but keeps allocations in `frameMap` for reuse.
- `clearTab(tabId)` — removes everything (called on `tabs.onRemoved`).
- `clear()` — removes all state (called on browser session end).

---

## 6. Context Resolution and Transient Context Suppression

**File:** `src/lib/events/aggregator.ts`

### Context resolution

Three-tier priority:

```typescript
function resolveContext(event: SessionEvent): string {
    // 1. Content-script context (non-"root") — authoritative
    if (event.context !== "root") {
        tabContexts.set(event.tabId, event.context);
        return event.context;
    }

    // 2. URL-inferred context
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload?.url === "string") {
        const urlCtx = inferContextFromUrl(payload.url);
        if (urlCtx) {
            tabContexts.set(event.tabId, urlCtx);
            return urlCtx;
        }
    }

    // 3. Last known context for the tab
    return tabContexts.get(event.tabId) ?? "root";
}
```

### Transient context suppression (the star-pattern fix)

When navigating from email A to email B in Outlook, the URL briefly passes through `/mail/inbox` (context = `"outlook"`). Without suppression, this creates a star pattern: `emailA → outlook → emailB`.

```typescript
const isTransientContext = context === "root" || context === "outlook";
const prevSource = lastSourcePerTab.get(resolvedTabId);

if (prevSource !== undefined && prevSource !== source && transitionTrackerRef) {
    if (!isTransientContext) {
        // Record virtual transition (e.g., email A -> email B)
        transitionTrackerRef.recordSwitch(source, event.ts, { ... });
    }
    // else: SKIPPED — transient contexts don't create transitions
}

// Don't update lastSourcePerTab for transient contexts
if (!isTransientContext) {
    lastSourcePerTab.set(resolvedTabId, source);
}
```

The intermediate `"outlook"` context is never recorded in `lastSourcePerTab`, so the transition goes directly `emailA → emailB`.

---

## 7. Complete Event Flows

### Flow A: Tab Switch (Tab A → Tab B, same window)

```
1. User clicks on Tab B
2. Chrome fires tabs.onActivated({ tabId: B, windowId: W })
3. capture.ts handler:
   a. ts = Date.now()
   b. Resolve frame nodeId for tab B via frameManager.resolveSource()
   c. prevActiveChromeId = activeTabPerWindow.get(W)  →  finds tab A
   d. Guard passes (A !== B, W === focusedWindowId)
   e. EMIT attention.active: false for tab A   ← synchronous, same ts
   f. activeTabPerWindow.set(W, B)
   g. updateActiveFlags()
   h. transitionTracker.recordSwitch(nodeId, ts, { url, title })
   i. EMIT attention.active: true for tab B
4. Content script in Tab B fires visibilitychange → visible: true
5. Content script in Tab A fires visibilitychange → visible: false
```

Net event stream: `[active:false(A), active:true(B), visible:true(B), visible:false(A)]`

Active events are synchronous and paired. Visible events arrive asynchronously from content scripts.

### Flow B: Alt-Tab Away from Chrome

```
1. User presses Alt-Tab to a non-Chrome window
2. Chrome fires windows.onFocusChanged(WINDOW_ID_NONE)
3. capture.ts handler:
   a. ts = Date.now()
   b. EMIT attention.active: false for previously active tab  ← synchronous
   c. focusedWindowId = null
   d. updateActiveFlags()  →  all tabs now active: false
   e. Start 200ms settle timer:
      offBrowserTimer = setTimeout(() => {
          offBrowserTimer = null;
          transitionTracker.recordSwitch(OFF_BROWSER, ts);
      }, 200);
4. After 200ms (no focus return):
   → recordSwitch(OFF_BROWSER, ts) fires
   → Creates transition: lastTab → off-browser (with dwell time)
```

**Note:** The `visible` signal does NOT change here. Tabs remain `visible: true` if their window is not minimized — the Page Visibility API reports rendering state, not OS focus.

### Flow C: Alt-Tab Back to Chrome

```
1. User Alt-Tabs back to Chrome
2. Chrome fires windows.onFocusChanged(windowId)
3. capture.ts handler:
   a. Previous focusedWindowId is null — no deactivation emit
   b. focusedWindowId = windowId
   c. updateActiveFlags()
   d. Cancel settle timer if it hasn't fired:
      if (offBrowserTimer !== null) {
          clearTimeout(offBrowserTimer);
          offBrowserTimer = null;
      }
   e. Look up active tab: activeTabPerWindow.get(windowId)
   f. transitionTracker.recordSwitch(source, ts)
      → Creates: off-browser → tabB (or direct tabA → tabB if timer was cancelled)
   g. EMIT attention.active: true for the active tab
```

**Two sub-cases:**
- **Return within 200ms:** Timer cancelled. No `OFF_BROWSER` node ever appears. Graph shows `tabA → tabB` directly.
- **Return after 200ms:** `OFF_BROWSER` transition already fired. Return creates `off-browser → tabB`.

### Flow D: Window Switch (Chrome Window A → Chrome Window B)

```
1. Chrome fires windows.onFocusChanged(WINDOW_ID_NONE)   ← losing focus from A
   → Emit active:false for A's tab. Start 200ms timer.
2. Chrome fires windows.onFocusChanged(windowB)           ← within 200ms
   → Cancel timer. No off-browser node.
   → Emit active:true for B's tab.
   → recordSwitch: direct tabA → tabB
```

Clean `tabA → tabB` transition, no spurious off-browser intermediate.

### Flow E: DevTools Window Opening

```
1. Chrome fires windows.onFocusChanged(devToolsWindowId)
2. Handler deactivates the previously focused window's tab
3. activeTabPerWindow.get(devToolsWindowId) returns undefined
   (DevTools windows don't have normal tabs)
4. No activation event emitted, no transition recorded
5. Settle timer does NOT fire — focusedWindowId !== null
   (it's the DevTools window ID, not WINDOW_ID_NONE)
```

If DevTools is docked (not separate window), no `onFocusChanged` fires at all.

---

## 8. Off-Browser Preprocessing

**File:** `src/lib/grouping/preprocess.ts`

At session finalization time, the off-browser node gets special treatment:

### Time-chunking

A single `off-browser` node would be a massive hub connected to nearly every tab. By chunking into 5-minute windows (`hub:off-browser:0`, `hub:off-browser:1`, etc.), temporal locality is preserved.

```typescript
const OFF_BROWSER_WEIGHT = 2;

export function preprocess(transitions, tabMeta, options) {
    const offBrowserSplit = splitHubsByTime(
        transitions, new Set([OFF_BROWSER]), CHUNK_WINDOW_MS, baseTs,
    );
    // Boost off-browser chunk edge weights
    let result = offBrowserSplit.transitions.map((t) => {
        if (t.from.startsWith("hub:off-browser:") || t.to.startsWith("hub:off-browser:")) {
            return { ...t, weight: (t.weight ?? 1) * OFF_BROWSER_WEIGHT };
        }
        return t;
    });
}
```

### Transient access removal

```typescript
const TRANSIENT_DWELL_MS = 500;    // tabs with dwell < 500ms are transient
const TRANSIENT_CHAIN_MS = 1000;   // chain detection threshold
```

Tabs visited for under 500ms are removed from the graph. Chain detection finds sequences of rapid switches (all < 1s) and removes the intermediaries.

### Hub detection

```typescript
const HUB_THRESHOLD_PERCENT = 0.1;
const HUB_MIN_TABS = 15;
```

Tabs connected to >10% of all unique tabs (when >15 tabs exist) are considered hubs and removed from the community detection input.

---

## 9. Ready Gate

**File:** `src/lib/events/aggregator.ts`

```typescript
let ready = false;
let pendingEvents: SessionEvent[] = [];

export function emit(event: SessionEvent): void {
    if (!ready) {
        pendingEvents.push(event);
        return;
    }
    routeEvent(event);
}
```

During startup, `startAggregator()` is async (restores session, initializes browser session manager). Events that arrive during this window are buffered and drained once `ready = true`. Prevents events from being dropped during service worker startup.

---

## 10. Browser Session Lifecycle

**File:** `src/lib/grouping/browser-session.ts`

```typescript
const BROWSER_IDLE_TIMEOUT_MS = 10 * 60 * 1000;   // 10 minutes
const MAX_BROWSER_SESSION_MS = 2 * 60 * 60 * 1000; // 2 hours
```

A browser session ends on:
- **10 minutes of global idle** (no events at all)
- **2 hours maximum duration**
- **System idle/lock** (via `attention.idle` events)
- **DevTools force-end** (via `TransitionTracker.onForceEndSession` callback)

On session end: all tab sessions finalized → grouping pipeline runs (preprocess → graph → Louvain) → results POSTed to server → transition tracker and frame manager cleared → new session starts.

---

## 11. Service Worker Bootstrap Order

**File:** `src/background/service-worker.ts`

```typescript
startAggregator({ transitionTracker, frameManager }).then(() => {
    startNavigationCollector();
    startTabCollector();
    startWindowCollector();
    startIdleCollector();
    startMediaCollector();
    startCapture();
    startStatusWatcher();
});
```

Aggregator initialized first (async, includes session restore). Collectors register Chrome API listeners only after it resolves. The ready gate ensures any early events are safely buffered.

---

## 12. Identity Constants

**File:** `src/lib/chrome-ids.ts`

```typescript
export const NO_TAB = "none";
export const OFF_BROWSER = "off-browser";

export function toTabId(chromeId: number | undefined): string {
    if (chromeId === undefined || chromeId < 0) return NO_TAB;
    return String(chromeId);
}
```

All internal tracking uses string tab IDs. `OFF_BROWSER` is the sentinel in the transition graph.

---

## Race Conditions Handled

| Race Condition                                           | Mechanism                                           | Location                |
| -------------------------------------------------------- | --------------------------------------------------- | ----------------------- |
| `onActivated` before content script sends visibility     | Async fallback to `chrome.tabs.get()`               | `capture.ts`            |
| Window-to-window switch firing `NONE` then `newWindow`   | 200ms settle timer with `clearTimeout`              | `capture.ts`            |
| Events arriving before aggregator initialized            | Ready gate with pending queue                       | `aggregator.ts`         |
| Service worker restart losing transition state           | `chrome.storage.session` persistence + restore      | `transition-tracker.ts` |
| Browser session expired during SW sleep                  | Elapsed-time check on restore                       | `browser-session.ts`    |
| SPA URL passing through intermediate pages               | Transient context suppression                       | `aggregator.ts`         |
| bfcache restoring page without re-running content script | `pageshow` listener with forced re-send             | `visibility.ts`         |
| Content script flush failure                             | Re-prepend to buffer with max cap                   | `event-buffer.ts`       |
| DevTools window having no tabs                           | `activeTabPerWindow.get()` returns undefined, no-op | `capture.ts`            |

## Timers

| Timer                  | Duration         | Purpose                                              | Location                |
| ---------------------- | ---------------- | ---------------------------------------------------- | ----------------------- |
| Off-browser settle     | 200ms            | Suppress spurious off-browser during window switches | `capture.ts`            |
| Persist debounce       | 2000ms           | Batch writes to `chrome.storage.session`             | `transition-tracker.ts` |
| Event buffer flush     | 1000ms           | Batch content script events to service worker        | `event-buffer.ts`       |
| Aggregator flush       | 5000ms           | Periodic flush of accumulator and session checks     | `aggregator.ts`         |
| Browser idle timeout   | 600000ms (10min) | End browser session after prolonged inactivity       | `browser-session.ts`    |
| Max browser session    | 7200000ms (2h)   | Force end browser session at max duration            | `browser-session.ts`    |
| System idle detection  | 60s              | Chrome's built-in idle detection threshold           | `collectors/idle.ts`    |
| Window bounds debounce | 500ms            | Avoid flood of resize events during drag             | `collectors/windows.ts` |

---

## Key Differences from be-v1

1. **Synchronous deactivation** — `onActivated` and `onFocusChanged` always emit `attention.active: false` for the previous tab BEFORE any other work. be-v1's bundler only seals the bundle.

2. **TransitionTracker is a separate class** — transition recording is decoupled from the bundler. Has its own self-loop guard, dwell time calculation, and persistence layer.

3. **Two independent boolean signals per tab** — `visible` (content script, rendering state) and `active` (background, OS focus). be-v1 conflates these.

4. **No graph edges from the bundler** — the bundler equivalent in browser-extension doesn't call `recordEdge`. The TransitionTracker owns all transition recording, called directly from `onActivated`/`onFocusChanged`/frame handlers.

5. **Frame-level virtual transitions** — FrameManager creates sub-tab sources for SPAs. be-v1 has no equivalent.

6. **Context resolution with transient suppression** — prevents star patterns from SPA navigation through intermediate URLs. be-v1 has no equivalent.

7. **Session persistence** — `chrome.storage.session` survives service worker restarts. be-v1 has no persistence.

8. **Ready gate** — events buffered during async startup. be-v1 relies on synchronous initialization.

9. **Off-browser always time-chunked in preprocessing** — split into 5-minute windows with 2x edge weight boost. be-v1's packer handles off-browser differently.

10. **DevTools window handling** — detects that DevTools windows have no tabs and avoids creating spurious transitions. be-v1's `onWindowFocusChanged` treats unknown sources the same as off-browser.
