# Off-Browser Transitions & Broken Graph — be-v1

Confirmed via code comparison and cross-referenced with `tab-nav.md` (be-v1 internals) and `off_browser.md` (browser-extension internals).

---

## Why the graph is fundamentally broken

### Transitions silently dropped when source is unknown

**Files:** `src/aggregation/index.ts:137-155`, `src/aggregation/index.ts:157-180`

`onTabActivated` and `onWindowFocusChanged` only create graph edges when `tabSources` already has an entry for the tab. `tabSources` is only populated when `ingest()` receives a capture from the content script — but `chrome.tabs.onActivated` fires *before* the content script sends anything. Any tab that hasn't sent a capture (new tabs, unvisited tabs, chrome:// pages) has its transition silently dropped via `bundler.seal()` instead of `bundler.transition()`.

This is the root cause. Graph edges are created as a side effect of `bundler.transition()`, which is part of the capture/bundle state machine. The graph can only reflect transitions between tabs that have actively sent content-script captures. Every other transition is invisible.

**browser-extension fix:** `capture.ts` maintains its own `tabStates` map populated directly from Chrome API events, and a standalone `TransitionTracker` that records all tab switches independently of the bundler. Falls back to async `chrome.tabs.get()`. Even on failure, still records the switch with empty metadata. Transitions are **never** dropped.

---

## Why off-browser transitions aren't recorded properly

### 1. Off-browser → tab return drops the edge when source is unknown

**File:** `src/aggregation/index.ts:157-180`

When the user alt-tabs back to Chrome, `onWindowFocusChanged` fires with a real `windowId`. The handler cancels the off-browser timer, then tries to transition back:

```typescript
cancelOffBrowser();
const tabId = activeTabPerWindow.get(windowId);
const source = tabId ? tabSources.get(tabId) : undefined;
if (source) {
    bundler.transition(source);    // edge: OFF_BROWSER → source
} else {
    startOffBrowserTimer();        // ← BUG: treats return as ANOTHER off-browser
}
```

If the returning window's active tab hasn't sent a content-script capture, `tabSources` has no entry, so instead of recording `OFF_BROWSER → tab`, it starts *another* off-browser timer. The return transition is lost entirely, and the user appears to stay off-browser indefinitely.

**browser-extension fix:** `capture.ts:430-513` always records the return transition via `transitionTracker.recordSwitch()`. It resolves the tab via `tabStates` or falls back to `chrome.tabs.get()`. The transition from off-browser back to the tab is always captured.

### 2. DevTools windows create spurious off-browser nodes

**File:** `src/aggregation/index.ts:157-180`

When the user opens DevTools as a separate window, `onWindowFocusChanged` fires for the DevTools window. Since DevTools has no normal tabs, `activeTabPerWindow.get(windowId)` returns undefined. be-v1 falls through to `startOffBrowserTimer()` — creating a spurious `OFF_BROWSER` node even though the user is still in Chrome.

**browser-extension fix:** `capture.ts` sets `focusedWindowId` to the DevTools window ID (not `null`). Since it's a real window, the off-browser timer never starts. The handler detects that the window has no tab in `activeTabPerWindow` and simply doesn't record a transition.

### 3. The 200ms settle timer works, but edges around it are lost

**File:** `src/aggregation/index.ts:127-135`

The settle timer itself is correctly implemented — it debounces `WINDOW_ID_NONE` to avoid spurious off-browser nodes during window-to-window switches. But the edges *around* off-browser transitions are broken because of the `tabSources` dependency (issue 1 above). Even when the timer correctly fires and creates an `OFF_BROWSER` transition, the subsequent return transition is likely to be dropped because the returning tab's source isn't in `tabSources`.

**browser-extension fix:** The settle timer in `capture.ts:421-426` calls `transitionTracker.recordSwitch(OFF_BROWSER, ts)` which always succeeds. The return path in `capture.ts:430-513` also always succeeds via fallbacks.

---

## Summary

| Issue                                       | be-v1 behavior                                           | browser-extension solution                         |
| ------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Tab transitions dropped                     | `seal()` when `tabSources` has no entry                  | Always record via `TransitionTracker` + fallbacks  |
| Off-browser → tab return lost               | Falls into another `startOffBrowserTimer()` call         | Always records return via `tabStates`/`tabs.get()` |
| DevTools windows create spurious off-browser | No-tab window treated same as leaving browser            | Detect no-tab window, skip off-browser timer       |
| Edges around off-browser lost               | Settle timer works but surrounding transitions are dropped | All transitions recorded regardless of source state |
