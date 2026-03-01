# Source Attribution: The Problem and The Fix

## The two event streams

The service worker receives events from two completely different sources:

```
Content Script (per tab)                     Chrome APIs
─────────────────────────                    ──────────────
DOM events happen                            Tab/window state changes
  → tap captures them                          → chrome.tabs.onActivated
  → relay sends via port                       → chrome.windows.onFocusChanged
  → arrives as Capture                         → chrome.webNavigation.onCompleted
                                               → arrives as Signal
         │                                              │
         ▼                                              ▼
  aggregator.ingest(capture, tabId)       aggregator.ingestSignal(signal, tabId)
```

**The critical difference**: Captures carry their own `context` field (set by the
content script's adapter), so the aggregator can compute the source immediately:
`source = context@tabId`. Signals carry no context — they're just Chrome API events
that say "tab 42 was activated" or "navigation completed on tab 7".

## The original bug: single global slot

The original code used `bundler.getActiveSource()` — a single global variable — to
determine which source a signal belongs to:

```
ingestSignal(signal, tabId):
    source = bundler.getActiveSource() ?? UNKNOWN     ← WRONG
```

This meant every signal was attributed to whichever source last produced a capture,
regardless of which tab the signal actually came from.

### Example: switching between GitHub (tab 42) and Gmail (tab 7)

```
TIME    EVENT                    activeSource    RESULT
─────   ──────────────────────   ────────────    ─────────────────────────────
10:01   capture from tab 42      root@42         ✓ stamped root@42 (correct)
10:02   capture from tab 42      root@42         ✓ stamped root@42 (correct)
10:03   user clicks tab 7        root@42         (onTabActivated → seal)
10:03   attention.active tab 7   root@42         ✗ stamped root@42 (WRONG!)
10:03   nav.completed tab 7      root@42         ✗ stamped root@42 (WRONG!)
10:04   capture from tab 7       root@7          ✓ transition, now correct
```

Signals from tab 7 got stamped with tab 42's source. URLs from Gmail's
`attention.active` signal got recorded on GitHub's graph node.

## Fix #1: tabId → source map

Instead of one global slot, we maintain a map:

```
tabSources: Map<tabId, source>
────────────────────────────────
  "42" → "root@42"     (set when first capture from tab 42 arrived)
  "7"  → "root@7"      (set when first capture from tab 7 arrived)
```

`ingestSignal` looks up the source by the signal's own tabId:

```
ingestSignal(signal, tabId):
    source = tabSources.get(tabId)          ← lookup by THIS signal's tab
```

## The next problem: timing gap

Signals arrive BEFORE captures. Here's the actual event sequence when you switch
to a tab:

```
                Chrome API (sync)              Content Script (async)
                ─────────────────              ──────────────────────
    t=0ms       onTabActivated(tabId=7)
    t=1ms       chrome.tabs.get(7) callback
                  → attention.active signal
    t=2ms       webNavigation.onCompleted
                  → nav.completed signal
                                                t=50-500ms  user does something
                                                            → first capture arrives
                                                              from tab 7's content script
                          ◄── GAP ──►
```

During the gap, `tabSources.get("7")` returns `undefined` because no capture has
arrived yet from tab 7. If we fall back to UNKNOWN, we create edges like:

```
BEFORE (with UNKNOWN fallback):

    root@42 ──→ unknown ──→ root@7

    The graph shows everything routing through an "unknown" hub node.
    Multi-tab usage collapses into: A → unknown → B → unknown → C
```

## Fix #2: buffer pending signals

Instead of stamping signals with UNKNOWN when the source isn't known yet, we
buffer them:

```
pendingSignals: Map<tabId, Signal[]>
─────────────────────────────────────
  "7" → [ attention.active, nav.completed ]     ← buffered, not stamped yet
```

When the first capture arrives from tab 7, `ingest()` does:

```
1. tabSources.set("7", "root@7")           ← establish source identity
2. bundler.ingest(stamped)                  ← opens bundle, may create edge
3. flushPending("7", "root@7")              ← replay buffered signals into bundle
     → stamp each with "root@7"
     → push into open bundle
     → record URLs
```

## Fix #3: no UNKNOWN transitions

The old code created UNKNOWN edges in two places:

```
BEFORE:
    onTabActivated():
        bundler.transition(UNKNOWN)           ← edge: lastSource → unknown

    onWindowFocusChanged(WINDOW_ID_NONE):
        bundler.transition(UNKNOWN)           ← edge: lastSource → unknown
```

Now:

```
AFTER:
    onTabActivated(tabId):
        source = tabSources.get(tabId)
        if source exists:
            bundler.transition(source)        ← edge: lastSource → realSource
        else:
            bundler.seal()                    ← no edge, just close bundle

    onWindowFocusChanged(any):
        bundler.seal()                        ← no edge, just close bundle
```

Edges are only created between real sources. The edge from old tab to new tab is
created either immediately (if the new tab's source is known) or deferred until
the first capture arrives.

## Full walkthrough: the fixed flow

User is on GitHub (tab 42), switches to Gmail (tab 7), types, then alt-tabs away
and back:

```
STATE:  tabSources = { "42": "root@42", "7": "root@7" }  (both visited before)
        activeSource = "root@42"
        openBundle = Bundle{ source: "root@42", captures: [...] }

─── Step 1: User clicks tab 7 ────────────────────────────────────────

  main.ts:  chrome.tabs.onActivated fires
              → aggregator.onTabActivated("7")

  index.ts: tabSources.get("7") → "root@7" (known!)
              → bundler.transition("root@7")

  bundler:  seal()  → Bundle{root@42} sealed, pushed to sealed[]
            graph.recordEdge("root@42", "root@7")     ✓ correct edge!
            activeSource = "root@7"
            openNew("root@7")

  GRAPH:    root@42 ──→ root@7

─── Step 2: attention.active signal arrives (async) ───────────────────

  main.ts:  chrome.tabs.get(7) callback fires
              → aggregator.ingestSignal(attention.active, "7")

  index.ts: tabSources.get("7") → "root@7" (known)
              → stamp with "root@7"
              → bundler.ingestSignal → pushed into open bundle
              → graph.recordUrl("root@7", "https://mail.google.com")

─── Step 3: User types in Gmail ───────────────────────────────────────

  content:  keystroke capture arrives on port
              → aggregator.ingest(capture, "7")

  index.ts: source = "root@7", tabSources.set("7", "root@7")
              → bundler.ingest: source matches activeSource, push to bundle

─── Step 4: User alt-tabs away from Chrome ────────────────────────────

  main.ts:  chrome.windows.onFocusChanged(WINDOW_ID_NONE)
              → aggregator.onWindowFocusChanged(-1)

  index.ts: bundler.seal()
              → Bundle{root@7} sealed
              → openBundle = null
              → activeSource stays "root@7" (NOT reset to unknown)

  GRAPH:    root@42 ──→ root@7          (unchanged, no unknown edge)

─── Step 5: User returns to Chrome ────────────────────────────────────

  main.ts:  chrome.windows.onFocusChanged(realWindowId)
              → aggregator.onWindowFocusChanged(windowId)

  index.ts: bundler.seal() → no-op (already sealed)

─── Step 6: Capture arrives from tab 7 (user clicks something) ────────

  index.ts: bundler.ingest: activeSource="root@7" matches
              → but openBundle is null (was sealed in step 4)
              → openNew("root@7")  ← reopen without edge (same source)
              → push capture

  GRAPH:    root@42 ──→ root@7          (still just one clean edge)
```

## First-visit scenario (source not yet known)

User switches to a brand new tab 99 that hasn't sent any captures yet:

```
STATE:  tabSources = { "42": "root@42" }    (tab 99 not in map)
        activeSource = "root@42"

─── Step 1: onTabActivated("99") ──────────────────────────────────────

  index.ts: tabSources.get("99") → undefined
              → bundler.seal()                    (no edge, just seal)
              → activeSource stays "root@42"

─── Step 2: attention.active for tab 99 ───────────────────────────────

  index.ts: tabSources.get("99") → undefined
              → BUFFER: pendingSignals.set("99", [attention.active])

─── Step 3: nav.completed for tab 99 ──────────────────────────────────

  index.ts: tabSources.get("99") → undefined
              → BUFFER: pendingSignals["99"].push(nav.completed)

  pendingSignals = { "99": [attention.active, nav.completed] }

─── Step 4: First capture from tab 99's content script ────────────────

  index.ts: source = "root@99"
            tabSources.set("99", "root@99")
            bundler.ingest(stamped):
              → activeSource="root@42" ≠ "root@99"
              → transition("root@99")
                → seal(): no-op
                → graph.recordEdge("root@42", "root@99")    ✓ direct edge!
                → openNew("root@99")
              → push capture

            flushPending("99", "root@99"):
              → stamp attention.active with "root@99", push to bundle
              → stamp nav.completed with "root@99", push to bundle
              → record URLs from both signals

  GRAPH:    root@42 ──→ root@99         (direct edge, no unknown)

  pendingSignals = {}                   (flushed)
```

## Before vs After

```
BEFORE — switching between 3 tabs:

    root@42 ──→ unknown ──→ root@7 ──→ unknown ──→ root@99
        │                     │                       │
        └────→ unknown ◄──────┘                       │
                  │                                   │
                  └──────────→ unknown ◄──────────────┘

    "unknown" becomes a hub. Every tab connects through it.
    Graph is useless for understanding browsing patterns.


AFTER — same browsing session:

    root@42 ──→ root@7 ──→ root@99
        │                    ▲
        └────────────────────┘

    Direct edges between actual sources.
    Graph accurately represents tab switching patterns.
```
