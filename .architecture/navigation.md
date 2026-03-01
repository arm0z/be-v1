# Navigation: Active Tab Tracking

## How it works

Active tab tracking is driven entirely by **content script visibility messages**. There is no Chrome `tabs.onActivated` or `windows.onFocusChanged` logic in the aggregator.

### Content script (`src/event/visibility.ts`)

Each content script (injected in the top frame of every page) reports its visibility to the service worker via three browser signals:

| Signal             | Fires when                                 | Why it's needed                                                              |
| ------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `visibilitychange` | Tab is shown/hidden (tab switch, minimize) | Primary signal for tab-level visibility                                      |
| `window.focus`     | Browser window gains OS-level focus        | Catches multi-window switches where both tabs remain "visible" on screen     |
| `window.blur`      | Browser window loses OS-level focus        | Detects alt-tab and window-to-window switches that `visibilitychange` misses |

Plus two bootstrap signals:

- **Initial send** on content script load (registers the tab immediately)
- **`pageshow`** with `e.persisted` (re-registers after bfcache restore)

All signals pass through a **deduplication gate** (`lastState`) that only sends when the visibility actually changes.

The message sent to the service worker:

```bash
{ type: "page:visibility", visible: boolean, url: string, title: string }
```

### Why all three signals are required

`visibilitychange` alone is NOT sufficient:

1. **Multi-window switching**: If two Chrome windows are both visible on screen (e.g., different monitors or side-by-side), switching between them does NOT fire `visibilitychange` because both tabs remain rendered. Only `focus`/`blur` catches this.

2. **Alt-tab on some platforms**: When alt-tabbing away from Chrome while the window remains partially visible, `visibilitychange` may not fire. `blur` is the reliable fallback.

3. **Initial state**: When the content script first loads, neither `visibilitychange` nor `focus`/`blur` has fired. The initial `send()` call bootstraps the state.

### Service worker (`src/background/main.ts`)

The `page:visibility` message handler calls two things:

1. `aggregator.onVisibilityChanged(tabId, visible)` — drives navigation
2. `aggregator.ingestSignal(...)` — records as bundle content

Other Chrome API listeners (`tabs.onActivated`, `windows.onFocusChanged`) exist in `main.ts` for dev logging and signal ingestion only. They do NOT drive navigation.

### Aggregator (`src/aggregation/index.ts`)

The aggregator maintains one piece of state: `visibleTabId: string | null`.

**`onVisibilityChanged(tabId, visible)`**:

- `visible: true` — Cancel any off-browser timer. Set `visibleTabId`. Resolve source (`tabSources.get(tabId) ?? root@{tabId}`). If source differs from bundler's active source, call `bundler.transition(source)`.
- `visible: false` — Only acts if `tabId === visibleTabId`. Clears `visibleTabId`, starts the off-browser settle timer.

**Off-browser settle timer** (`OFF_BROWSER_SETTLE_MS = 1000ms`):
When a tab reports hidden, the timer starts. If another tab reports visible within the window, the timer is cancelled and navigation goes directly to the new tab. If the timer fires, `bundler.transition(OFF_BROWSER)` runs.

This handles the natural gap during tab switches: old tab fires `blur`/hidden before the new tab fires `focus`/visible.

### Bundler dwell mechanism (`src/aggregation/bundler.ts`)

The bundler has its own edge-recording delay: `DWELL_MS = 1000ms`. When a transition happens (e.g., A -> B), the edge A -> B is held as "pending" for 1 second. If B transitions to C within that window:

- If B dwelled < 1000ms: the edge collapses (A -> B -> C becomes A -> C)
- If B dwelled >= 1000ms: A -> B is committed, new pending edge B -> C

This prevents brief intermediate nodes (like `off_browser` during a slow tab switch) from appearing in the graph.

## Data flow

```text
Content Script (per tab)
  |
  | page:visibility { visible, url, title }
  |
  v
Service Worker (main.ts)
  |
  | aggregator.onVisibilityChanged(tabId, visible)
  |
  v
Aggregator (index.ts)
  |
  | visibleTabId tracking + off-browser settle timer
  |
  v
Bundler (bundler.ts)
  |
  | transition(source) -> seal old bundle, open new, pending edge with dwell
  |
  v
Graph (graph.ts)
  |
  | edges committed after dwell threshold
```

## Edge cases

| Scenario                         | What happens                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab switch (same window)         | Old tab: `visibilitychange` hidden. New tab: `visibilitychange` visible. Direct transition, no off_browser.                                                                                 |
| Window switch (both visible)     | Old window: `blur`. New window: `focus`. Direct transition via focus/blur signals.                                                                                                          |
| Alt-tab away from Chrome         | Active tab: `blur` + `visibilitychange` hidden. Off-browser timer starts.                                                                                                                   |
| Alt-tab back within 1000ms       | Active tab: `focus` + `visibilitychange` visible. Timer cancelled, no off_browser transition.                                                                                               |
| Alt-tab back after 1000ms        | Timer fired, off_browser committed. Then tab visible, transition to tab. Dwell may collapse off_browser if total time < 1000ms.                                                             |
| New tab created (drag URL)       | Old tab hidden. New tab content script loads (takes ~1s). Off-browser timer may fire. Dwell mechanism collapses off_browser if new tab arrives within 1000ms of the off_browser transition. |
| Tab closed while visible         | `tab.closed` signal clears visibleTabId, starts off-browser timer. Next tab's content script fires visible.                                                                                 |
| Chrome internal page (chrome://) | No content script. Treated as off_browser (no visibility message arrives).                                                                                                                  |
| Iframe click                     | Top frame `blur` fires, sends `visible: false`. Off-browser timer starts. If user stays in iframe > 1000ms, off_browser commits. Trade-off accepted for simplicity.                         |
