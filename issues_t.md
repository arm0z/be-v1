# Issues: Why Off-Browser Transitions Break in be-v1

Every issue traced against the actual source code (`src/aggregation/index.ts`, `bundler.ts`, `graph.ts`, `src/background/main.ts`). Each includes the exact line-level code path, a concrete scenario that triggers it, and the resulting graph corruption.

---

## Issue 1: `activeSource` not updated when switching to a tab with unknown source

**Severity:** Critical — produces edges from the wrong source node.

### Code path

`index.ts` — `onTabActivated()`:

```typescript
function onTabActivated(tabId: string, windowId: number): void {
    activeTabPerWindow.set(windowId, tabId);
    if (offBrowserTimer !== null) return;

    const source = tabSources.get(tabId);
    if (source) {
        bundler.transition(source);       // updates activeSource
    } else {
        bundler.seal();                   // does NOT update activeSource
    }
    emitState();
}
```

When `tabSources` has no entry (content script hasn't connected), the `seal()` path closes the bundle but leaves `activeSource` pointing at the **previous tab**.

### Scenario

```
1. User on Tab A. activeSource = "root@A", openBundle for A.
2. User clicks Tab B (new tab, no content script yet).
   → onTabActivated("B", W)
   → tabSources.get("B") → undefined
   → bundler.seal()    — closes A's bundle
   → activeSource STAYS "root@A"

3. User Alt-Tabs away. Timer fires after 200ms:
   → bundler.transition(OFF_BROWSER)
   → graph.recordEdge("root@A", "off_browser")  ← WRONG
   (User left from Tab B, not Tab A)

4. User returns. Tab B sends first capture:
   → bundler.ingest → transition("root@B")
   → graph.recordEdge("off_browser", "root@B")  ← correct
```

**Graph result:** `root@A → off_browser → root@B`. Should be `root@A → root@B` (direct tab switch) or at worst `? → off_browser → root@B`.

### Why this is unfixable without restructuring

The aggregator has no operation for "update activeSource without recording an edge." `bundler.transition(UNKNOWN)` would record a `root@A → unknown` edge, which is wrong too. The system needs a way to null out the graph cursor without creating an edge.

---

## Issue 2: `activeSource` serves as both bundler state and graph cursor

**Severity:** Critical (architectural) — root cause of Issues 1, 4, and 6.

### The problem

`activeSource` in `bundler.ts` is one variable doing two jobs:

| Role | What it means | When they diverge |
|---|---|---|
| **Bundle target** | "What source am I accumulating captures for" | After `seal()`, there's no accumulation but `activeSource` is unchanged |
| **Graph cursor** | "What node was the user last at, for `from` in the next edge" | After switching to an unknown tab, the cursor should be indeterminate |

### Where they diverge

```
After seal() in startOffBrowserTimer():
  Bundle state:  openBundle = null (not accumulating)
  Graph cursor:  activeSource = "root@A" (still the old tab)
  Reality:       User is leaving the browser

After seal() in onTabActivated(unknown tab):
  Bundle state:  openBundle = null (not accumulating)
  Graph cursor:  activeSource = "root@A" (still the old tab)
  Reality:       User is looking at Tab B
```

Any subsequent `transition()` call uses `activeSource` as `from`. If the intermediate state wasn't tracked, the `from` is wrong.

### In browser-extension

Two separate owners:
- `TransitionTracker.lastActiveTabId` — the graph cursor
- Session accumulator — the bundle target
- These are updated independently by different callers

---

## Issue 3: `bundler.transition()` is the only way to record an edge

**Severity:** Critical (architectural) — forces four operations to be atomic.

### The coupling

`bundler.ts` — `transition()`:

```typescript
function transition(to: string): void {
    seal();                              // 1. close bundle
    const from = activeSource;
    if (from && from !== to) {
        graph.recordEdge(from, to);      // 2. record edge
    }
    activeSource = to;                   // 3. update cursor
    if (to !== UNKNOWN && to !== OFF_BROWSER) {
        openNew(to);                     // 4. open bundle
    }
}
```

You cannot:
- Record an edge without sealing the current bundle
- Update `activeSource` without potentially recording an edge
- Seal a bundle without the caller also getting edge-recording as a side effect

### Consequences

- Issue 1 exists because there's no way to update `activeSource` without creating an edge
- Issue 5 exists because `onFocusChanged` and `onTabActivated` both call `transition()`, double-sealing
- The aggregator can't "fix" `activeSource` retroactively when a tab's source becomes known
- The only escape hatch is `seal()`, which stops accumulation but doesn't touch the graph

### In browser-extension

`transitionTracker.recordSwitch()` only records transitions. It doesn't seal bundles, open bundles, or interact with event accumulation at all.

---

## Issue 4: Eager `seal()` in `startOffBrowserTimer()` creates a signal-drop window

**Severity:** High — signals silently lost during 200ms settle period.

### Code path

`index.ts` — `startOffBrowserTimer()`:

```typescript
function startOffBrowserTimer(): void {
    cancelOffBrowser();
    bundler.seal();                    // immediate: openBundle = null
    offBrowserTimer = setTimeout(() => {
        offBrowserTimer = null;
        bundler.transition(OFF_BROWSER); // deferred: 200ms later
        emitState();
    }, OFF_BROWSER_SETTLE_MS);
}
```

`bundler.ts` — `ingestSignal()`:

```typescript
function ingestSignal(stamped: StampedSignal): void {
    if (!openBundle) return;           // drops signal silently
    openBundle.captures.push(stamped);
}
```

### The 200ms gap

```
t=0ms:    seal() → openBundle = null, activeSource = "root@A"
t=0-200:  ALL signals dropped (openBundle is null):
            - attention.active (async callback from onActivated)
            - nav.completed (background tab finished loading)
            - attention.visible (content script page visibility)
t=200ms:  transition(OFF_BROWSER) → activeSource = "off_browser", no bundle
t=200+:   ALL signals dropped (OFF_BROWSER has no bundle)
```

### What about captures during the gap?

`bundler.ingest()` takes a different path:

```typescript
function ingest(stamped: StampedCapture): void {
    if (activeSource === null || stamped.source !== activeSource) {
        transition(stamped.source);    // would create a transition
    } else if (!openBundle) {
        openNew(stamped.source);       // silently reopens
    }
    openBundle!.captures.push(stamped);
}
```

A capture from the same source during the gap silently reopens a bundle — no edge, no transition, just a bundle that shouldn't exist. A capture from a different source triggers a full transition, creating edges while the off-browser timer is still pending (see Issue 7).

### In browser-extension

No eager seal. `attention.active: false` is emitted as an event (not a bundle operation). The transition is deferred. Event accumulation continues independently.

---

## Issue 5: Double transition when `onFocusChanged` and `onTabActivated` both fire on focus return

**Severity:** Medium — creates empty sealed bundles, disrupts bundle continuity.

### The race

When the user returns to Chrome, both events fire within ~1-2ms:

```
1. onFocusChanged(windowId):
   → cancelOffBrowser()
   → bundler.transition("root@A")
     → seal()  ← no-op (OFF_BROWSER has no bundle)
     → recordEdge("off_browser", "root@A")  ← correct
     → openNew("root@A")  ← bundle opened

2. onTabActivated("A", windowId) fires ~1ms later:
   → offBrowserTimer === null (cleared in step 1)
   → bundler.transition("root@A")
     → seal()  ← SEALS the bundle from step 1 (0 captures, ~1ms duration)
     → from === to → no edge  ← self-loop guard works
     → openNew("root@A")  ← new bundle opened
```

**Result:** `sealed[]` gets a 0-capture, ~1ms bundle. The actual user-facing bundle is the second one. Every focus-return generates this ghost bundle.

---

## Issue 6: `attention.visible: false` on focus loss is black-holed

**Severity:** Medium — visibility signal lost + unbounded memory growth.

### Code path

`main.ts`:

```typescript
chrome.windows.onFocusChanged.addListener((windowId) => {
    aggregator.onWindowFocusChanged(windowId);
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        aggregator.ingestSignal(
            { type: "attention.visible", ..., payload: { visible: false } },
            "unknown",                    // hardcoded tabId
        );
    }
```

Inside `aggregator.ingestSignal()`:
1. `tabSources.get("unknown")` → undefined
2. Queued in `pendingSignals.get("unknown")`
3. Never flushed (no capture ever arrives from tabId `"unknown"`)
4. `tab.closed` cleanup never fires for `"unknown"`

**Same problem for downloads:**

```typescript
aggregator.ingestSignal(
    { type: "media.download", ... },
    "unknown",
);
```

### Memory leak

Every Alt-Tab away adds one entry to `pendingSignals["unknown"]`. Every download state change adds another. Over a long session, this grows without bound.

---

## Issue 7: In-flight captures during settle create phantom edges

**Severity:** High — corrupts graph with edges that don't represent user actions.

### Code path

Content scripts don't know the browser is losing focus. Debounced events (scroll flush at 150ms, keystroke batch at 1s, selection at 300ms) may already be in the message queue when `startOffBrowserTimer()` fires.

```
1. User on Tab A, Alt-Tabs away.
   → startOffBrowserTimer(): seal(), start 200ms timer
   → activeSource = "root@A", openBundle = null

2. Within 200ms, Tab B's scroll normalizer flushes (was queued):
   → aggregator.ingest(capture, "B")
   → source = "root@B"
   → bundler.ingest(stamped):
     → stamped.source "root@B" !== activeSource "root@A"
     → transition("root@B")
       → seal()  ← no-op
       → graph.recordEdge("root@A", "root@B")  ← PHANTOM EDGE
       → activeSource = "root@B"
       → openNew("root@B")  ← phantom bundle

3. 200ms timer fires:
   → bundler.transition(OFF_BROWSER)
   → seal()  ← seals phantom bundle
   → graph.recordEdge("root@B", "off_browser")  ← PHANTOM EDGE
```

**Result:** Graph shows `A → B → off_browser` instead of `A → off_browser`. Two phantom edges from a single stale capture.

### Why the `onTabActivated` guard doesn't help

The guard at `index.ts:146` only blocks `onTabActivated`. It does NOT block `aggregator.ingest()`, which is the capture-from-content-script path. There is no off-browser awareness in the capture ingestion pipeline.

---

## Issue 8: DevTools window creates spurious off-browser nodes

**Severity:** High — common developer action pollutes graph.

### Code path

`index.ts` — `onWindowFocusChanged()`:

```typescript
} else {
    cancelOffBrowser();
    const tabId = activeTabPerWindow.get(windowId);
    const source = tabId ? tabSources.get(tabId) : undefined;
    if (source) {
        bundler.transition(source);
    } else {
        startOffBrowserTimer();        // ← DevTools hits this
    }
}
```

DevTools windows don't have normal tabs. `activeTabPerWindow.get(devToolsWindowId)` returns undefined. The system starts the off-browser timer.

### Scenario

```
1. User on Tab A, opens undocked DevTools.
   → onFocusChanged(devToolsWindowId)
   → tabId = undefined, source = undefined
   → startOffBrowserTimer(): seal(), start 200ms timer

2. After 200ms: transition(OFF_BROWSER)
   → graph.recordEdge("root@A", "off_browser")  ← WRONG

3. User clicks back on content window:
   → onFocusChanged(contentWindowId)
   → transition("root@A")
   → graph.recordEdge("off_browser", "root@A")  ← WRONG
```

**Result:** `A → off_browser → A` every time the user opens DevTools for >200ms. This accumulates rapidly during development.

### In browser-extension

`focusedWindowId` is set to the DevTools window ID (not null). Only `WINDOW_ID_NONE` triggers off-browser. DevTools focus is neutral — no edges created.

---

## Issue 9: `onTabActivated` guard blocks legitimate tab switches during any off-browser timer

**Severity:** Medium — converts real tab switches into off-browser round-trips.

### Code path

The guard:

```typescript
function onTabActivated(tabId: string, windowId: number): void {
    activeTabPerWindow.set(windowId, tabId);
    if (offBrowserTimer !== null) return;  // blocks ALL activations
    // ...
}
```

This fires for ANY pending off-browser timer, not just the one caused by `onFocusChanged(WINDOW_ID_NONE)`. Off-browser timers are also started by DevTools focus (Issue 8) and window focus to sourceless tabs.

### Scenario

```
1. User clicks on DevTools window → startOffBrowserTimer()
2. Within 200ms, user Ctrl+Tab to switch to Tab B:
   → onTabActivated("B", W)
   → activeTabPerWindow.set(W, "B")  ← updated
   → offBrowserTimer !== null → RETURN  ← blocked

3. 200ms timer fires:
   → transition(OFF_BROWSER)
   → recordEdge("root@A", "off_browser")

4. Tab B sends capture:
   → bundler.ingest → transition("root@B")
   → recordEdge("off_browser", "root@B")
```

**Result:** `A → off_browser → B` instead of `A → B`. A real tab switch is recorded as an off-browser round-trip.

---

## Issue 10: Window-to-window switch when target tab has no source → spurious off-browser

**Severity:** Medium — common scenario produces wrong graph.

### Code path

Switching between Chrome windows fires `onFocusChanged(WINDOW_ID_NONE)` then `onFocusChanged(newWindowId)`. If the target window's active tab has no source:

```
1. User on Tab A (Window 1), clicks on Window 2 (Tab B = new tab page).
2. onFocusChanged(WINDOW_ID_NONE):
   → startOffBrowserTimer(): seal(), start timer

3. onFocusChanged(window2Id) — within 200ms:
   → cancelOffBrowser()  ← cancels first timer ✓
   → tabId = activeTabPerWindow.get(window2Id) → "B"
   → source = tabSources.get("B") → undefined  (chrome://newtab)
   → startOffBrowserTimer()  ← NEW timer started

4. After 200ms:
   → transition(OFF_BROWSER)
   → recordEdge("root@A", "off_browser")  ← WRONG

5. Eventually Tab B sends capture (if user navigates):
   → transition("root@B")
   → recordEdge("off_browser", "root@B")  ← WRONG
```

**Result:** `A → off_browser → B` instead of `A → B`. The user switched windows within Chrome but gets an off-browser round-trip because the target tab hadn't connected yet.

**How often:** Very common. New tabs, settings pages, extension pages, any chrome:// page.

---

## Issue 11: `activeTabPerWindow` update runs before the off-browser guard — stale on return

**Severity:** Medium — can cause wrong edges on focus return.

### Code path

```typescript
function onTabActivated(tabId: string, windowId: number): void {
    activeTabPerWindow.set(windowId, tabId);  // ← ALWAYS runs
    if (offBrowserTimer !== null) return;       // ← guard AFTER update
    // ...
}
```

If Chrome fires a spurious `onTabActivated` for a different tab during focus loss, `activeTabPerWindow` is corrupted while the guard prevents any corrective transition.

### Scenario

```
1. Tab A active in Window 1. User Alt-Tabs away.
   → startOffBrowserTimer()

2. Chrome fires spurious onTabActivated("C", 1):
   → activeTabPerWindow.set(1, "C")  ← CORRUPTED (was "A")
   → guard triggers → return

3. Timer fires: transition(OFF_BROWSER)
   → recordEdge("root@A", "off_browser")

4. User returns: onFocusChanged(1)
   → tabId = activeTabPerWindow.get(1) → "C"  ← WRONG
   → source = tabSources.get("C") → "root@C"
   → transition("root@C")
   → recordEdge("off_browser", "root@C")  ← WRONG (user is on Tab A)

5. Tab A sends capture:
   → source "root@A" !== activeSource "root@C"
   → transition("root@A")
   → recordEdge("root@C", "root@A")  ← SPURIOUS EDGE
```

**Result:** Three wrong edges from one spurious Chrome event.

---

## Issue 12: No `activeTabPerWindow` cleanup on tab/window close

**Severity:** Low-Medium — stale entries cause wrong source lookups.

### Code path

`activeTabPerWindow` is only written in `onTabActivated()`. No cleanup on:
- `tabs.onRemoved` — the tab entry remains
- `windows.onRemoved` — the window entry remains

### Scenario

```
1. Window W has Tab A active: activeTabPerWindow = {W: "A"}
2. Tab A closed: tabs.onRemoved fires
   → tabSources.delete("A")
   → activeTabPerWindow STILL has {W: "A"}

3. If onWindowFocusChanged(W) fires before Chrome sends onTabActivated for the replacement tab:
   → tabId = activeTabPerWindow.get(W) → "A"
   → source = tabSources.get("A") → undefined (deleted)
   → startOffBrowserTimer()  ← spurious
```

The window between close and Chrome's replacement activation is typically tiny (~1-2ms), but the race is real.

---

## Issue 13: Empty bundles pollute sealed list

**Severity:** Low — data quality issue.

### Code path

`bundler.ts` — `seal()`:

```typescript
function seal(): void {
    if (!openBundle) return;
    openBundle.endedAt = Date.now();
    openBundle.text = translate(openBundle);  // → returns "" for 0 captures
    sealed.push(openBundle);                  // ← no captures.length check
    openBundle = null;
}
```

**Triggers:**
- Issue 5: double transition creates 0-capture, ~1ms bundles
- Rapid tab switching: `openNew(A)` then immediate `transition(B)` seals A with 0 captures
- Off-browser settle on a just-opened bundle

**Result:** `sealed[]` accumulates `{ source: "root@X", captures: [], text: "" }` entries. `drainSealed()` passes these to downstream consumers that must filter them.

---

## Issue 14: No dwell time on edges — temporal information lost

**Severity:** Low-Medium — graph lacks data needed for downstream analysis.

### The gap

`types.ts`:

```typescript
export type Edge = {
    from: string;
    to: string;
    weight: number;    // no timestamp, no dwell time
};
```

**What's lost:**
- How long the user spent on a tab before switching (dwell time)
- How long off-browser periods lasted
- When during the session transitions happened
- Whether an edge with weight 5 was 5 rapid switches or 5 transitions over 2 hours

**In browser-extension:** `TabTransition` has `{ from, to, ts, dwellMs }`. The `dwellMs` enables downstream filtering of transient accesses (< 500ms) and time-chunking of hub nodes.

---

## Issue 15: Single off-browser node becomes a star-pattern hub

**Severity:** Medium — degrades graph quality for visualization and analysis.

All off-browser transitions go through one `"off_browser"` node. Over a session, it connects to nearly every visited tab:

```
     tab_A ←── off_browser ──→ tab_D
     tab_B ←─/      │      \─→ tab_E
     tab_C ←/       │       \→ tab_F
```

**Impact:**
- Force-directed layout collapses all nodes toward the hub
- Community detection groups everything with off-browser
- Real tab-to-tab transitions are visually obscured

**In browser-extension:** Off-browser is time-chunked into 5-minute windows (`hub:off-browser:0`, `hub:off-browser:1`) during preprocessing, breaking the star into temporal clusters with 2x edge weight boost.

---

## Issue 16: Startup seeding races with Chrome event listeners

**Severity:** Low — can cause missing transitions on service worker restart.

### Code path

`main.ts`:

```typescript
chrome.windows.getAll({ populate: false }, (windows) => {
    for (const w of windows) {
        chrome.tabs.query({ active: true, windowId: w.id }, (tabs) => {
            aggregator.onTabActivated(String(tabs[0].id), w.id!);
        });
    }
});
```

Fully async (nested callbacks). Chrome API listeners are registered synchronously. If `tabs.onActivated` or `windows.onFocusChanged` fires before seeding completes:

- `activeTabPerWindow` may be empty → `onWindowFocusChanged()` can't find active tab → `startOffBrowserTimer()`
- `tabSources` is empty → every `onTabActivated` takes seal-only path (Issue 1)

**In browser-extension:** Ready gate buffers all events until `startAggregator()` resolves. No events processed until fully initialized.

---

## Root Cause Dependency Graph

```
Issue 2 (activeSource = double duty)
  ├→ Issue 1 (seal-only doesn't update graph cursor)
  ├→ Issue 4 (eager seal creates signal-drop window)
  └→ Issue 11 (stale activeTabPerWindow not reflected in graph cursor)

Issue 3 (transition = only way to record edge)
  ├→ Issue 5 (double transition: both handlers call transition())
  ├→ Issue 7 (in-flight captures create edges through transition())
  └→ Issue 1 (can't update cursor without edge)

Issue 8 (DevTools = off-browser)
  └→ Issue 9 (onTabActivated guard blocks real switches during DevTools timer)

Issue 6 (attention.visible black-holed)
  └→ memory leak in pendingSignals["unknown"]

Independent:
  Issue 10 (window switch to sourceless tab)
  Issue 12 (no activeTabPerWindow cleanup)
  Issue 13 (empty bundles)
  Issue 14 (no dwell time)
  Issue 15 (single off-browser hub)
  Issue 16 (startup race)
```

## Summary

The fundamental issue is **coupling**: graph state (`activeSource`, edge recording) and bundle state (open/sealed, capture accumulation) share a single variable and a single operation. Every fix for one subsystem creates a side effect in the other. The browser-extension solved this by separating concerns: `TransitionTracker` owns graph state, session accumulator owns event accumulation, and they communicate through a narrow interface (`recordSwitch` called at well-defined points).
